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
import { isCustomerBillingOperational } from "../../lib/billing/config.ts";
import {
  type BillingQuantityLock,
  endQuantityMutation,
  tryBeginQuantityMutation,
} from "../../lib/billing/quantity-lock.ts";
import {
  BILLING_MUTATION_IN_PROGRESS_ERROR,
  loadBillingOrgView,
  summarizeLicenses,
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
import { syncSelfHostedGrant } from "../../lib/tiers/self-hosted-grant-records.ts";
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
  noLicenseAvailableBody,
  parseLicenseCreateFields,
  reservedColocatedLicenseNameError,
  serializeLicenseListEntry,
  serverCapacityExceededBody,
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
  | { ok: true; lease: BillingQuantityLock | null }
  | { ok: false; response: Response };

/**
 * Hosted: the mint runs under the organization's quantity lease so a
 * concurrent seat change cannot let two mints share one purchased
 * license. Self-hosted holds no lease and has no gate.
 */
async function prepareLicenseMint(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
): Promise<LicenseMintPrep> {
  if (!isCustomerBillingOperational(c.get("billingConfig"))) {
    return { ok: true, lease: null };
  }
  const lease = await tryBeginQuantityMutation(db, organizationId);
  if (!lease) {
    return {
      ok: false,
      response: c.json({ error: BILLING_MUTATION_IN_PROGRESS_ERROR }, 409),
    };
  }
  return { ok: true, lease };
}

/** Hosted: one more license must fit under what is purchased and not already leaving. */
async function rejectIfNoLicenseAvailable(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  hosted: boolean,
): Promise<Response | null> {
  if (!hosted) return null;
  // Belt and braces under the lease we already hold: a self-hosted grant is
  // part of `purchased`, so a stale-high one is a free license here and
  // nowhere else. Shrink it to what the organization still holds before
  // reading the view, whatever path last forgot to. `allowGrow: false` —
  // this is the hosted runtime, and the fast path makes it one indexed
  // `setting` read for an organization that never held a grant.
  await syncSelfHostedGrant(db, organizationId, { allowGrow: false });
  const view = await loadBillingOrgView(db, organizationId, Date.now());
  const summary = summarizeLicenses(view);
  return summary.available > 0
    ? null
    : c.json(noLicenseAvailableBody(summary), 409);
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
    const { name, installBaseUrl } = parsedFields;

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

    // Hosted: a key is minted only while the organization holds fewer
    // licenses than it has purchased. Which tier the server lands on is
    // decided when it connects, from its hardware — never here.
    const mint = await prepareLicenseMint(c, db, organizationId);
    if (!mint.ok) return mint.response;
    try {
      const unavailable = await rejectIfNoLicenseAvailable(
        c,
        db,
        organizationId,
        isCustomerBillingOperational(c.get("billingConfig")),
      );
      if (unavailable) return unavailable;

      // The instance does not build daemon release artifacts. In self-hosted dev
      // the operator builds them via Developer → Rebuild daemon and upgrade
      // (`deno task release:dev`); Caddy serves `dist/` at `/downloads/daemon`.
      const { licenseId, licenseToken } = await createLicense(db, {
        organizationId,
        name,
      });

      // Self-hosted entitles what it mints: one granted `SX` unit per active
      // license (`src/lib/tiers/self-hosted-grant.ts`), so this key is
      // covered before its daemon ever enrolls — and stays covered if the
      // control plane later moves to the hosted runtime. Hosted mints
      // against what was purchased; the gate above already ran.
      if (opts.runtime === "deno") {
        await syncSelfHostedGrant(db, organizationId, { allowGrow: true });
      }

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

    // Detach-first: a bound license is revoked by deleting its server.
    // Revoking never touches the provider — what was purchased stays
    // purchased until the billing page reduces it.
    const attachment = await inspectLicenseAttachment(db, id, organizationId);
    if (!attachment.ok) return c.json({ error: "Not found" }, 404);
    if (attachment.boundServer) {
      return c.json({
        error: "license_has_attached_server",
        server: attachment.boundServer,
      }, 409);
    }

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

    // The revoked key gave its granted unit back. Shrinking runs on **both**
    // runtimes: a grant left standing after a revoke is a license the hosted
    // mint gate would hand out for free.
    await syncSelfHostedGrant(db, organizationId, {
      allowGrow: opts.runtime === "deno",
    });

    return c.json({ ok: true as const });
  });
}
