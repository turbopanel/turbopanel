import type { Context, Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import {
  COLOCATED_SERVER_DISPLAY_NAME,
  colocatedLicenseRevokeError,
  isProtectedColocatedLicenseId,
  resolveProtectedColocatedLicenseIds,
} from "../authn/install-state.ts";
import {
  createLicense,
  inspectLicenseAttachment,
  invalidateLicense,
  listLicenses,
  listServersBoundToLicenses,
} from "../authn/license.ts";
import {
  assertLicenseInvalidationAllowed,
  BILLING_MUTATION_IN_PROGRESS_ERROR,
} from "../authn/license-lifecycle.ts";
import {
  type BillingQuantityLock,
  endQuantityMutation,
  tryBeginQuantityMutation,
} from "../../lib/billing/quantity-lock.ts";
import { resolvePurchasableTier } from "../../lib/db/tier-records.ts";
import {
  loadBillingOrgView,
  summarizeTierSeats,
} from "../billing/routes-helpers.ts";
import { loadServerStatusRecords } from "../servers/update-status.ts";
import { createSessionMiddleware } from "../authn/middleware.ts";
import { assertOrgOwnerOr403 } from "../authz/index.ts";
import { compatLogInfo } from "../../log-compat.ts";
import { type Db, getDaemonCellRegistry, getDb } from "../../db.ts";
import type { DaemonCellRegistry } from "../../daemon/cell/contracts.ts";
import { isDeveloperSurfaceEnabled } from "../../dev-mode.ts";
import { buildLicenseInstallCommand } from "../../lib/daemon-install-command.ts";
import { installOriginNeedsInsecureTls } from "../../lib/install-tls.ts";
import {
  parseInstallBaseUrl,
  resolvePublicBaseUrl,
} from "../../lib/resolve-public-base-url.ts";
import {
  canReserveServerSeat,
  loadOrgServerCapacity,
  SERVER_CAPACITY_EXCEEDED_ERROR,
} from "../../lib/server-capacity.ts";
import { getOrgId } from "../shared.ts";
import {
  installBaseUrlValidationError,
  isInvalidInstallBaseUrl,
  isReservedColocatedLicenseName,
  noFreeSeatRefusal,
  parseLicenseCreateFields,
  reservedColocatedLicenseNameError,
  serializeLicenseListEntry,
  serverCapacityExceededBody,
  TIER_NOT_PURCHASABLE_ERROR,
  TIER_REQUIRED_ERROR,
} from "./routes-helpers.ts";

// License create/list/revoke are owner-only. Use the exact owner-only guard so
// an organization manager cannot mint or revoke registration keys.
function assertBillingOrOrgMember(
  c: Context<AppEnv>,
  organizationId: string,
): Promise<Response | null> {
  return assertOrgOwnerOr403(c, "organization", organizationId);
}

async function purgeInvalidatedDaemonCells(
  registry: DaemonCellRegistry | undefined,
  serverIds: string[],
): Promise<void> {
  if (!registry) return;
  for (const serverId of serverIds) {
    try {
      await registry.getCell(serverId).purge();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `Failed to purge daemon cell after license invalidate for server ${serverId}: ${message}`,
      );
    }
  }
}

type LicenseOwnerContext = Readonly<{ db: Db; organizationId: string }>;

async function requireLicenseOwnerContext(
  c: Context<AppEnv>,
): Promise<LicenseOwnerContext | Response> {
  const db = getDb(c);
  if (!db) return c.json({ error: "Database unavailable" }, 503);

  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const orgResult = await getOrgId(c, session.userId);
  if (orgResult instanceof Response) return orgResult;

  const denied = await assertBillingOrOrgMember(c, orgResult);
  if (denied) return denied;

  return { db, organizationId: orgResult };
}

type LicenseMintPrep =
  | { ok: true; mintTierId: string | null; lease: BillingQuantityLock | null }
  | { ok: false; response: Response };

async function prepareLicenseMint(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  tierId: string | undefined,
): Promise<LicenseMintPrep> {
  if (!c.get("billingConfig")) {
    return { ok: true, mintTierId: null, lease: null };
  }
  if (!tierId) {
    return { ok: false, response: c.json({ error: TIER_REQUIRED_ERROR }, 400) };
  }
  const tier = await resolvePurchasableTier(db, tierId);
  if (!tier.ok) {
    return {
      ok: false,
      response: c.json({
        error: TIER_NOT_PURCHASABLE_ERROR,
        reason: tier.reason,
      }, 400),
    };
  }
  const lease = await tryBeginQuantityMutation(db, organizationId);
  if (!lease) {
    return {
      ok: false,
      response: c.json({ error: BILLING_MUTATION_IN_PROGRESS_ERROR }, 409),
    };
  }
  return { ok: true, mintTierId: tierId, lease };
}

async function rejectIfNoFreeMintSeat(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  mintTierId: string | null,
): Promise<Response | null> {
  if (!mintTierId) return null;
  const view = await loadBillingOrgView(db, organizationId, Date.now());
  const summary = summarizeTierSeats(view).find((entry) =>
    entry.tierId === mintTierId
  );
  const body = noFreeSeatRefusal({ tierId: mintTierId, summary });
  return body ? c.json(body, 409) : null;
}

async function releaseMintLease(
  db: Db,
  lease: BillingQuantityLock | null,
): Promise<void> {
  if (!lease) return;
  try {
    await endQuantityMutation(db, lease);
  } catch {
    // Best-effort: a stolen or expired lease must not change the mint response.
  }
}

export function registerLicenseRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError("session secrets are required for license routes");
  }
  const secrets = opts.secrets;

  router.use("/licenses", createSessionMiddleware(secrets));
  router.use("/licenses/:id", createSessionMiddleware(secrets));

  router.get("/licenses", async (c) => {
    const ctx = await requireLicenseOwnerContext(c);
    if (ctx instanceof Response) return ctx;
    const { db, organizationId } = ctx;

    const registry = getDaemonCellRegistry(c);
    const licenses = await listLicenses(db, organizationId);
    const protectedIds = await resolveProtectedColocatedLicenseIds(
      db,
      registry,
      organizationId,
    );
    const licenseIds = licenses.map((entry) => entry.id);
    const boundServers = await listServersBoundToLicenses(
      db,
      organizationId,
      licenseIds,
    );
    const boundServerIds = [...boundServers.values()].map((entry) => entry.id);
    const statusRecords = boundServerIds.length > 0 && registry
      ? await loadServerStatusRecords(db, registry, boundServerIds)
      : [];
    const statusByServerId = new Map(
      statusRecords.map((record) => [record.serverId, record]),
    );

    return c.json({
      licenses: licenses.map(({ id, name, createdAt }) => {
        const bound = boundServers.get(id);
        const status = bound ? statusByServerId.get(bound.id) : undefined;
        return serializeLicenseListEntry({
          id,
          name,
          createdAt,
          revocable: !protectedIds.has(id),
          bound,
          status,
        });
      }),
    });
  });

  router.post("/licenses", async (c) => {
    const ctx = await requireLicenseOwnerContext(c);
    if (ctx instanceof Response) return ctx;
    const { db, organizationId } = ctx;

    const rawBody = await c.req.text().catch(() => "");
    const parsedFields = parseLicenseCreateFields(rawBody);
    if (parsedFields === "invalid") {
      return c.json({ error: "Invalid request" }, 400);
    }
    // `name` is already normalized (or omitted when blank) by the parser.
    const { name, installBaseUrl, tierId } = parsedFields;

    // Reserved for the co-located control-plane license (install / disk recovery).
    if (isReservedColocatedLicenseName(name, COLOCATED_SERVER_DISPLAY_NAME)) {
      return c.json(
        {
          error: reservedColocatedLicenseNameError(
            COLOCATED_SERVER_DISPLAY_NAME,
          ),
        },
        400,
      );
    }

    const devSurface = opts.runtime === "deno" && isDeveloperSurfaceEnabled();
    // The install base URL override is a runtime-agnostic developer convenience
    // (the UI only surfaces it in __DEV__). Parsing an HTTPS override is safe on
    // both Deno and Workers, so don't gate that behind the Deno-only devSurface —
    // that left Workers dev unable to use the override at all. A plaintext
    // `http:` override is only permitted on the developer surface; outside dev it
    // is rejected so a plaintext control-plane URL cannot leak into a managed
    // install command.
    const parsedInstallBaseUrl = parseInstallBaseUrl(installBaseUrl, {
      allowHttp: devSurface,
    });
    if (isInvalidInstallBaseUrl(installBaseUrl, parsedInstallBaseUrl)) {
      return c.json(
        {
          error: installBaseUrlValidationError(devSurface),
        },
        400,
      );
    }

    // Seat check before minting: enrolled servers + unconsumed keys count
    // against organization.options.maxServers (null/omitted = unlimited).
    const capacity = await loadOrgServerCapacity(db, organizationId);
    if (!capacity) return c.json({ error: "Not found" }, 404);
    if (!canReserveServerSeat(capacity)) {
      return c.json(
        serverCapacityExceededBody(capacity, SERVER_CAPACITY_EXCEEDED_ERROR),
        409,
      );
    }

    // Hosted: a key is minted against a free seat at a purchasable tier. The
    // seat count is read under the quantity lease so a concurrent seat
    // change cannot let two mints share one seat. Self-hosted keeps `null`.
    const mint = await prepareLicenseMint(c, db, organizationId, tierId);
    if (!mint.ok) return mint.response;
    try {
      const noSeat = await rejectIfNoFreeMintSeat(
        c,
        db,
        organizationId,
        mint.mintTierId,
      );
      if (noSeat) return noSeat;

      // The instance does not build daemon release artifacts. In self-hosted dev
      // the operator builds them via Developer → Rebuild daemon and upgrade
      // (`deno task release:dev`); Caddy serves `dist/` at `/downloads/daemon`.
      const { licenseId, licenseToken } = await createLicense(db, {
        organizationId,
        name,
        tierId: mint.mintTierId,
      });

      const instanceUrl = parsedInstallBaseUrl ??
        await resolvePublicBaseUrl(c, opts);
      // Insecure TLS follows the selected origin, not "we are in development":
      // LAN / :8443 platform-CA needs curl -k; a Cloudflare tunnel or other
      // publicly-trusted HTTPS origin must not.
      const insecureTls = installOriginNeedsInsecureTls(instanceUrl);
      // Instance-host `/run.sh` is served only by the dev overlay Caddyfile.
      // Production / self-hosted Deno installs curl the CDN and pass TURBOPANEL_HOST.
      const installCommand = buildLicenseInstallCommand({
        runtime: opts.runtime,
        instanceUrl,
        licenseId,
        licenseToken,
        insecureTls,
        useInstanceRunScript: Boolean(devSurface),
      });

      compatLogInfo(
        "auth",
        "license created; licenseToken is shown once and not stored in plaintext",
      );

      return c.json({ licenseId, licenseToken, installCommand });
    } finally {
      await releaseMintLease(db, mint.lease);
    }
  });

  router.delete("/licenses/:id", async (c) => {
    const ctx = await requireLicenseOwnerContext(c);
    if (ctx instanceof Response) return ctx;
    const { db, organizationId } = ctx;

    const id = c.req.param("id");
    const registry = getDaemonCellRegistry(c);
    if (await isProtectedColocatedLicenseId(db, id, registry, organizationId)) {
      return c.json({ error: colocatedLicenseRevokeError() }, 403);
    }

    // Detach-first refusal comes before the billing gate, so a refused
    // revoke never records a `release-seat` intent.
    const attachment = await inspectLicenseAttachment(db, id, organizationId);
    if (!attachment.ok) return c.json({ error: "Not found" }, 404);
    if (attachment.boundServer) {
      return c.json({
        error: "license_has_attached_server",
        server: attachment.boundServer,
      }, 409);
    }

    const billingDenied = await assertLicenseInvalidationAllowed(c, {
      db,
      runtime: opts.runtime,
      organizationId,
      licenseId: id,
      tierId: attachment.tierId,
      billingConfig: c.get("billingConfig"),
    });
    if (billingDenied) return billingDenied;

    const invalidated = await invalidateLicense(db, id, organizationId);
    if (!invalidated.ok) {
      if (invalidated.reason === "attached") {
        return c.json({
          error: "license_has_attached_server",
          server: invalidated.boundServer,
        }, 409);
      }
      return c.json({ error: "Not found" }, 404);
    }

    // Actively disconnect bound daemons — revoke alone leaves live sockets and
    // unexpired JWTs usable until they naturally expire.
    await purgeInvalidatedDaemonCells(registry, invalidated.serverIds);

    return c.json({ ok: true as const });
  });
}
