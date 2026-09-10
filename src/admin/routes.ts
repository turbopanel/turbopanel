import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import {
  createAdminAccessMiddleware,
  createRootOnlyMiddleware,
} from "../client/authn/middleware.ts";
import {
  getSignupSettingMeta,
  resolveColocatedServerId,
  setSignupEnabledSetting,
} from "../client/authn/install-state.ts";
import type { DerivedSecretsConfig } from "../client/authn/secrets.ts";
import {
  broadcastEchoToFleet,
  collectFleetCommands,
  enqueueEchoToServer,
  listFleetServerIds,
} from "../daemon/cell/fleet-diagnostics.ts";
import {
  fleetPresenceToConnection,
  isServerConnected,
  resolveFleetPresence,
  resolveOnlineFleetPresence,
} from "../daemon/cell/fleet-presence.ts";
import type { DaemonOutboundEnvelope } from "../daemon/cell/protocol.ts";
import {
  generateDeliveryId,
  generateRequestId,
} from "../daemon/cell/protocol.ts";
import { getDaemonCellRegistry, getDb } from "../db.ts";
import { getCommandQueue } from "../lib/commands/queue.ts";
import { cellTrace } from "../logger.ts";
import { emptyServerIps } from "../server-addresses.ts";
import { buildAdminScalarHtml } from "../scalar-html.ts";
import { ADMIN_API_PREFIX } from "../surfaces.ts";
import { getAdminOpenApiSpec } from "./openapi/index.ts";
import {
  getPublicUrls,
  parsePublicUrlEntries,
  setPublicUrls,
} from "./public-urls.ts";
import {
  completeGithubManifestHandler,
  createForgeHandler,
  deleteForgeHandler,
  getForgeHandler,
  listForgesHandler,
  patchForgeHandler,
  startGithubManifestHandler,
  syncForgeHandler,
} from "../client/forges/handlers.ts";
import {
  emailSettingsToApiShape,
  emailUpdatesRequireEncryption,
  resolveEmailSettings,
  updateEmailSettings,
} from "../lib/settings/email-settings.ts";
import {
  endReencryptSweep,
  reencryptAtRestSecrets,
  tryBeginReencryptSweep,
} from "./reencrypt-secrets.ts";
import {
  extractAddresses,
  parseCellPurgeBatchBody,
  parseEmailSettingsUpdates,
  parsePayloadBody,
  parseReencryptRequestBody,
  parseServerMetricsLiveSettingsBody,
  parseSignupEnabledBody,
  publicUrlsApplyWaitToResponse,
  resolvePerServerLimit,
  resolvePlatformEnv,
  resolvePublicUrlsForApply,
  waitForPublicUrlsApply,
} from "./routes-helpers.ts";
import { enqueuePlatformCaTrustReconcileBestEffort } from "./tls-trust-reconcile.ts";
import {
  getServerMetricsLiveMaxMinutes,
  isValidServerMetricsLiveMaxMinutes,
  setServerMetricsLiveMaxMinutes,
} from "../lib/settings/server-metrics-settings.ts";

const ADDRESSES_TIMEOUT_MS = 10_000;

function nowTs(): string {
  return new Date().toISOString();
}

/**
 * Admin UI surface: fleet diagnostics, public URL management, and (dev-only) shell.
 */
export function registerAdminRoutes(app: Hono<AppEnv>, opts: {
  secrets: DerivedSecretsConfig;
  runtime: "deno" | "workers";
  devSurface: boolean;
  getEnv?: () => Record<string, string | undefined>;
  /**
   * Hosted (Workers) only. Passed from `src/workers.ts` so this registrar
   * never statically imports the Stripe tier catalogue.
   */
  registerTiers?: (admin: Hono<AppEnv>) => void;
  getOpenApiSpec?: (
    serverUrl: string,
    opts?: { devSurface?: boolean; runtime?: "deno" | "workers" },
  ) => object;
}) {
  const admin = new Hono<AppEnv>();
  admin.use("*", createAdminAccessMiddleware(opts.secrets));

  opts.registerTiers?.(admin);

  admin.get("/daemon/connections", async (c) => {
    const registry = getDaemonCellRegistry(c);
    const db = getDb(c);
    if (!registry || !db) return c.json({ connections: [] });
    const connections = (await resolveOnlineFleetPresence(db, registry))
      .map(fleetPresenceToConnection);
    return c.json({ connections });
  });

  admin.get("/daemon/events", (c) => {
    return c.json({ events: [] });
  });

  admin.post("/daemon/broadcast", async (c) => {
    const registry = getDaemonCellRegistry(c);
    if (!registry) {
      return c.json({ error: "Daemon cell registry unavailable" }, 503);
    }
    const body = await c.req.json().catch(() => null);
    const parsedPayload = parsePayloadBody(body);
    if (!parsedPayload.ok) {
      return c.json({ error: parsedPayload.error }, 400);
    }
    const ids = await registry.listOnlineServerIds();
    const sent = await broadcastEchoToFleet(
      registry,
      ids,
      parsedPayload.payload,
    );
    return c.json({ ok: true, sent });
  });

  admin.post("/daemon/:id/send", async (c) => {
    const registry = getDaemonCellRegistry(c);
    const db = getDb(c);
    if (!registry || !db) {
      return c.json({ error: "Daemon cell registry unavailable" }, 503);
    }
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsedPayload = parsePayloadBody(body);
    if (!parsedPayload.ok) {
      return c.json({ error: parsedPayload.error }, 400);
    }
    if (!await isServerConnected(db, registry, id)) {
      return c.json({ error: "daemon not connected" }, 404);
    }
    await enqueueEchoToServer(registry, id, parsedPayload.payload);
    return c.json({ ok: true, id });
  });

  admin.get("/daemon/commands", async (c) => {
    const registry = getDaemonCellRegistry(c);
    if (!registry) return c.json({ commands: [] });
    const db = getDb(c);
    if (!db) return c.json({ commands: [] });
    const perServerLimit = resolvePerServerLimit(c.req.query("limit"));
    const serverIds = await listFleetServerIds(db);
    const commands = await collectFleetCommands(
      registry,
      serverIds,
      perServerLimit,
    );
    return c.json({ commands });
  });

  admin.get("/instance/addresses", async (c) => {
    if (opts.runtime !== "deno") {
      return c.json({
        ok: false,
        error: "instance address collection is not available on this runtime",
        ips: emptyServerIps(),
      }, 422);
    }
    const { collectServerIps, readDefaultRouteInterfaces } = await import(
      "../server-addresses-deno.ts"
    );
    const ips = collectServerIps(readDefaultRouteInterfaces());
    return c.json({ ok: true, source: "instance", ips });
  });

  admin.get("/instance/public-urls", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: true, urls: [] });
    const urls = await getPublicUrls(db);
    return c.json({ ok: true, urls });
  });

  admin.put("/instance/public-urls", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || !("urls" in body)) {
      return c.json({ ok: false, error: "expected { urls: string[] }" }, 400);
    }
    if (
      !Array.isArray(body.urls) ||
      !body.urls.every((u: unknown) => typeof u === "string")
    ) {
      return c.json({ ok: false, error: "expected { urls: string[] }" }, 400);
    }

    const parsed = parsePublicUrlEntries(body.urls, {
      allowHttp: opts.devSurface,
    });
    if (!parsed.ok) {
      return c.json(parsed, 422);
    }

    await setPublicUrls(db, parsed.urls);
    return c.json({ ok: true, urls: parsed.urls, applied: false });
  });

  // Instance-wide Git provider applications: GitHub Apps and GitLab OAuth
  // applications an operator registers once for the whole instance, so any
  // organization can connect accounts through them.
  //
  // This is a **collection**, not a pair of singleton settings rows. An
  // instance may hold several apps per provider — a github.com App and a GitHub
  // Enterprise one, or separate Apps for separate customer accounts — and each
  // carries its own webhook URL so an inbound delivery can name the app that
  // signed it before any secret is consulted (`lib/git/resolve-webhook-forge.ts`).
  //
  // Sealed material (App private key, OAuth client secret, webhook secret) is
  // written as `tpsecret` and never returned; reads report presence only.
  // Organizations manage their *own* apps through the client surface
  // (`/api/client/v1/forges`) — the admin surface has no organization context
  // and deliberately sees only instance-wide rows.
  const instanceScope = { organizationId: null };

  admin.get("/forges", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
    return await listForgesHandler(c, db, instanceScope);
  });

  admin.post("/forges", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
    return await createForgeHandler(c, db, instanceScope);
  });

  admin.post("/forges/github/manifest", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
    return await startGithubManifestHandler(c, db, instanceScope);
  });

  admin.get("/forges/github/manifest/callback", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
    return await completeGithubManifestHandler(c, db, instanceScope);
  });

  admin.post("/forges/:id/sync", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
    return await syncForgeHandler(c, db, instanceScope, c.req.param("id"));
  });

  admin.get("/forges/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
    return await getForgeHandler(c, db, instanceScope, c.req.param("id"));
  });

  admin.patch("/forges/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
    return await patchForgeHandler(c, db, instanceScope, c.req.param("id"));
  });

  admin.delete("/forges/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
    return await deleteForgeHandler(c, db, instanceScope, c.req.param("id"));
  });

  admin.get("/settings/email", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    const resolved = await resolveEmailSettings(
      db,
      resolvePlatformEnv(c, opts),
      dataEncryptionSecrets,
    );
    return c.json({ settings: emailSettingsToApiShape(resolved) });
  });

  admin.put("/settings/email", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const body = await c.req.json().catch(() => null);
    const updates = parseEmailSettingsUpdates(body);
    if (!updates) {
      return c.json({ error: "expected a JSON object of setting keys" }, 400);
    }

    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    // DB-backed secret writes must be sealed at rest — require an encryption key,
    // mirroring TLS and variable secret writes.
    if (emailUpdatesRequireEncryption(updates) && !dataEncryptionSecrets) {
      return c.json(
        { error: "Encryption unavailable — no encryption key configured" },
        503,
      );
    }

    const env = resolvePlatformEnv(c, opts);
    const resolved = await updateEmailSettings(
      db,
      env,
      updates,
      dataEncryptionSecrets,
    );
    // Workers resolves the email queue per request from current DB settings
    // (see workers.ts fetch middleware) — no isolate-level queue cache to
    // invalidate after this write.
    return c.json({ settings: emailSettingsToApiShape(resolved) });
  });

  admin.get("/settings/signup", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const platformEnv = resolvePlatformEnv(c, opts);
    const meta = await getSignupSettingMeta(
      db,
      opts.runtime,
      platformEnv.TURBOPANEL_IS_SIGNUP_ENABLED,
    );
    return c.json({
      enabled: meta.enabled,
      dbValue: meta.dbValue,
      isEnvForced: meta.isEnvForced,
      envOverride: meta.envOverride,
    });
  });

  admin.put("/settings/signup", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const body = await c.req.json().catch(() => null);
    const parsedSignup = parseSignupEnabledBody(body);
    if (!parsedSignup.ok) {
      return c.json({ error: parsedSignup.error }, 400);
    }
    const enabled = parsedSignup.enabled;

    const platformEnv = resolvePlatformEnv(c, opts);
    const before = await getSignupSettingMeta(
      db,
      opts.runtime,
      platformEnv.TURBOPANEL_IS_SIGNUP_ENABLED,
    );
    if (before.isEnvForced) {
      return c.json(
        {
          error:
            "Sign-up is force-controlled by TURBOPANEL_IS_SIGNUP_ENABLED; clear that env var to use the panel toggle.",
          enabled: before.enabled,
          dbValue: before.dbValue,
          isEnvForced: true,
          envOverride: before.envOverride,
        },
        409,
      );
    }

    await setSignupEnabledSetting(db, enabled);
    const meta = await getSignupSettingMeta(
      db,
      opts.runtime,
      platformEnv.TURBOPANEL_IS_SIGNUP_ENABLED,
    );
    return c.json({
      enabled: meta.enabled,
      dbValue: meta.dbValue,
      isEnvForced: meta.isEnvForced,
      envOverride: meta.envOverride,
    });
  });

  admin.get("/settings/server-metrics-live", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const maxMinutes = await getServerMetricsLiveMaxMinutes(db);
    return c.json({ maxMinutes });
  });

  admin.put("/settings/server-metrics-live", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const body = await c.req.json().catch(() => null);
    const parsed = parseServerMetricsLiveSettingsBody(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }
    if (!isValidServerMetricsLiveMaxMinutes(parsed.maxMinutes)) {
      return c.json(
        { error: "maxMinutes must be 0 or an integer between 5 and 240" },
        400,
      );
    }

    await setServerMetricsLiveMaxMinutes(db, parsed.maxMinutes);
    const maxMinutes = await getServerMetricsLiveMaxMinutes(db);
    return c.json({ maxMinutes });
  });

  admin.post("/instance/public-urls/apply", async (c) => {
    if (opts.runtime === "workers") {
      return c.json(
        { ok: false, error: "cert apply is not applicable on this runtime" },
        422,
      );
    }

    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);

    const body = await c.req.json().catch(() => null);
    const urlsResult = await resolvePublicUrlsForApply(
      db,
      body,
      opts.devSurface,
    );
    if (!urlsResult.ok) {
      return c.json(urlsResult.body, urlsResult.status);
    }

    const registry = getDaemonCellRegistry(c);
    if (!registry) {
      return c.json(
        { ok: false, error: "Daemon cell registry unavailable" },
        503,
      );
    }

    const serverId = await resolveColocatedServerId(db, registry);
    if (!serverId) {
      return c.json(
        {
          ok: false,
          error: "no co-located daemon connected to apply public URLs",
        },
        503,
      );
    }

    const snapshots = await registry.getSnapshots([serverId]);
    if (!snapshots.get(serverId)?.connected) {
      return c.json(
        { ok: false, error: "co-located daemon disconnected" },
        503,
      );
    }

    const result = await waitForPublicUrlsApply(
      registry,
      serverId,
      urlsResult.urls,
    );
    const response = publicUrlsApplyWaitToResponse(result);
    if (response.status === 200) {
      const commandQueue = getCommandQueue(c);
      const actorId = c.get("session")?.userId;
      if (commandQueue && actorId) {
        await enqueuePlatformCaTrustReconcileBestEffort({
          db,
          commandQueue,
          actorId,
        });
      }
    }
    return c.json(response.body, response.status);
  });

  admin.get("/daemon/addresses", async (c) => {
    const registry = getDaemonCellRegistry(c);
    const db = getDb(c);
    if (!registry || !db) return c.json({ servers: [] });
    const online = await resolveOnlineFleetPresence(db, registry);
    const servers = await Promise.all(
      online.map(async (presence) => {
        const serverId = presence.serverId;
        const requestId = generateRequestId();
        cellTrace("request-start", {
          requestId,
          serverId,
          kind: "addresses-request",
        });
        const envelope: DaemonOutboundEnvelope = {
          kind: "addresses-request",
          deliveryId: generateDeliveryId(),
          requestId,
          at: nowTs(),
        };
        cellTrace("request-enqueued", {
          requestId,
          serverId,
          kind: "addresses-request",
          deliveryId: envelope.deliveryId,
        });
        try {
          const record = await registry.getCell(serverId).createRequestAndWait(
            envelope,
            ADDRESSES_TIMEOUT_MS,
          );
          if (record.status === "failed") {
            const error = record.error ?? "failed to fetch addresses";
            cellTrace("request-result", {
              requestId,
              serverId,
              kind: "addresses-request",
              pendingStatus: record.status,
              resultStatus: "failed",
              error,
            });
            return {
              daemonId: serverId,
              hostname: presence.hostname,
              error,
            };
          }
          if (record.status === "expired") {
            const error = "timeout waiting for addresses";
            cellTrace("request-result", {
              requestId,
              serverId,
              kind: "addresses-request",
              pendingStatus: record.status,
              resultStatus: "timeout",
              error,
            });
            return {
              daemonId: serverId,
              hostname: presence.hostname,
              error,
            };
          }
          const ips = extractAddresses(record);
          cellTrace("request-result", {
            requestId,
            serverId,
            kind: "addresses-request",
            pendingStatus: record.status,
            resultStatus: "done",
          });
          return {
            daemonId: serverId,
            hostname: presence.hostname,
            ips,
          };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          cellTrace("request-result", {
            requestId,
            serverId,
            kind: "addresses-request",
            resultStatus: "error",
            error,
          });
          return {
            daemonId: serverId,
            hostname: presence.hostname,
            error,
          };
        }
      }),
    );
    return c.json({ servers });
  });

  admin.get("/daemon/:id/addresses", async (c) => {
    const registry = getDaemonCellRegistry(c);
    const db = getDb(c);
    if (!registry || !db) {
      return c.json({ error: "Daemon cell registry unavailable" }, 503);
    }
    const id = c.req.param("id");
    const presence = await resolveFleetPresence(db, registry, [id]);
    const live = presence.get(id);
    if (!live?.connected) {
      return c.json({ error: "daemon not connected" }, 404);
    }
    const requestId = generateRequestId();
    cellTrace("request-start", {
      requestId,
      serverId: id,
      kind: "addresses-request",
    });
    try {
      const envelope: DaemonOutboundEnvelope = {
        kind: "addresses-request",
        deliveryId: generateDeliveryId(),
        requestId,
        at: nowTs(),
      };
      cellTrace("request-enqueued", {
        requestId,
        serverId: id,
        kind: "addresses-request",
        deliveryId: envelope.deliveryId,
      });
      const record = await registry.getCell(id).createRequestAndWait(
        envelope,
        ADDRESSES_TIMEOUT_MS,
      );
      if (record.status === "failed") {
        const error = record.error ?? "failed to fetch addresses";
        cellTrace("request-result", {
          requestId,
          serverId: id,
          kind: "addresses-request",
          pendingStatus: record.status,
          resultStatus: "failed",
          error,
        });
        return c.json({ error }, 500);
      }
      if (record.status === "expired") {
        const error = "timeout waiting for addresses";
        cellTrace("request-result", {
          requestId,
          serverId: id,
          kind: "addresses-request",
          pendingStatus: record.status,
          resultStatus: "timeout",
          error,
        });
        return c.json({ error }, 500);
      }
      const ips = extractAddresses(record);
      cellTrace("request-result", {
        requestId,
        serverId: id,
        kind: "addresses-request",
        pendingStatus: record.status,
        resultStatus: "done",
      });
      return c.json({
        ok: true,
        daemonId: id,
        hostname: live.hostname ?? null,
        ips,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cellTrace("request-result", {
        requestId,
        serverId: id,
        kind: "addresses-request",
        resultStatus: "error",
        error: message,
      });
      const status = message === "daemon not connected" ? 404 : 500;
      return c.json({ error: message }, status);
    }
  });

  admin.post(
    "/cells/purge-batch",
    createRootOnlyMiddleware(opts.secrets),
    async (c) => {
      const registry = getDaemonCellRegistry(c);
      if (!registry) {
        return c.json({
          error: "Daemon cell registry unavailable",
        }, 503);
      }

      const body = await c.req.json().catch(() => null);
      const parsedBatch = parseCellPurgeBatchBody(body);
      if (!parsedBatch.ok) {
        return c.json({ error: parsedBatch.error }, 400);
      }

      const settled = await Promise.allSettled(
        parsedBatch.serverIds.map((serverId: string) =>
          registry.purge(serverId)
        ),
      );
      const results = parsedBatch.serverIds.map(
        (serverId: string, index: number) => {
          const outcome = settled[index]!;
          if (outcome.status === "fulfilled") {
            return { serverId, ok: true as const };
          }
          const error = outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
          return { serverId, ok: false as const, error };
        },
      );

      return c.json({ ok: true, results });
    },
  );

  admin.post(
    "/cells/:serverId/purge",
    createRootOnlyMiddleware(opts.secrets),
    async (c) => {
      const registry = getDaemonCellRegistry(c);
      if (!registry) {
        return c.json({
          error: "Daemon cell registry unavailable",
        }, 503);
      }

      const serverId = c.req.param("serverId");
      if (!serverId) {
        return c.json({ error: "serverId is required" }, 400);
      }

      try {
        await registry.getCell(serverId).purge();
        return c.json({ ok: true, serverId, purged: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false, error: message }, 500);
      }
    },
  );

  admin.post(
    "/secrets/reencrypt",
    createRootOnlyMiddleware(opts.secrets),
    async (c) => {
      const db = getDb(c);
      if (!db) return c.json({ error: "Database unavailable" }, 503);

      const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
      if (!dataEncryptionSecrets) {
        return c.json(
          {
            ok: false,
            error: "Encryption unavailable — no encryption key configured",
          },
          503,
        );
      }

      const body = await c.req.json().catch(() => null);
      const parsed = parseReencryptRequestBody(body);
      if (!parsed.ok) {
        return c.json({ ok: false, error: parsed.error }, 400);
      }

      const lock = await tryBeginReencryptSweep(db);
      if (!lock) {
        return c.json(
          {
            ok: false,
            error: "reencrypt_in_progress",
            message: "Another secret re-encryption sweep is already running",
          },
          409,
        );
      }

      try {
        const result = await reencryptAtRestSecrets(db, dataEncryptionSecrets, {
          cursor: parsed.cursor,
          limit: parsed.limit,
        });
        return c.json({ ok: true, ...result });
      } finally {
        await endReencryptSweep(db, lock);
      }
    },
  );

  if (opts.devSurface) {
    admin.get("/openapi.json", (c) => {
      const origin = new URL(c.req.url).origin;
      return c.json(
        (opts.getOpenApiSpec ?? getAdminOpenApiSpec)(origin, {
          devSurface: opts.devSurface,
          runtime: opts.runtime,
        }),
      );
    });
    admin.get("/reference", (c) => {
      const origin = new URL(c.req.url).origin;
      const specUrl = `${ADMIN_API_PREFIX}/openapi.json`;
      return c.html(buildAdminScalarHtml(specUrl, origin));
    });
  }

  app.route(ADMIN_API_PREFIX, admin);
  return app;
}
