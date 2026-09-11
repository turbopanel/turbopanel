import { assertEquals, assertExists } from "@std/assert";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import { getDatabaseUrl } from "../../db-url.ts";
import { createDenoDb } from "../../db.ts";
import { it } from "@std/testing/bdd";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../authn/crypto.ts";
import { createSession } from "../authn/session-store.ts";
import { deriveSecretsConfig } from "../authn/secrets.ts";
import {
  grant,
  organization,
  server,
  setting,
  user,
} from "../../lib/db/schema.ts";
import type {
  DaemonCell,
  DaemonCellRegistry,
  PendingRequestRecord,
} from "../../daemon/cell/contracts.ts";
import type { DaemonOutboundEnvelope } from "../../daemon/cell/protocol.ts";
import {
  SERVER_METRICS_LIVE_MAX_MINUTES_KEY,
  setServerMetricsLiveMaxMinutes,
} from "../../lib/settings/server-metrics-settings.ts";
import type {
  EntitySeriesQuery,
  EntitySeriesResult,
  FleetHostSnapshotQuery,
  FleetHostSnapshotResult,
  HostSeriesQuery,
  HostSeriesResult,
  HostSummaryQuery,
  HostSummaryResult,
  ServerMetricsStore,
  StatusHistoryQuery,
  StatusHistoryResult,
} from "../../daemon/metrics/types.ts";
import { FLEET_HOST_METRICS } from "./metrics-routes-helpers.ts";
import { registerServerMetricsRoutes } from "./metrics-routes.ts";
import {
  createMetricsChartCache,
  METRICS_LIVE_SESSION_CACHE_PREFIX,
  resetDenoMetricsChartCacheForTests,
} from "../../daemon/metrics/query/cache.ts";
import { MAX_METRICS_POINTS } from "../../daemon/metrics/query/resolution.ts";
import { recordTopologyGeneration } from "./server-topology-records.ts";
import {
  cacheLiveSample,
  isServerLiveSessionActive,
  markServerLiveSessionActive,
} from "../../daemon/metrics/query/live-session.ts";
import { METRICS_SCHEMA_VERSION } from "../../daemon/metrics/contract.ts";
import type { AuthenticatedMetricsSample } from "../../daemon/metrics/types.ts";

import { parseTestSecretsConfig } from "../../test-fixtures/secrets.ts";

const dbUrl = getDatabaseUrl();

type MetricsRouteJsonBody = {
  ok?: boolean;
  error?: string;
  backend?: string;
  metrics?: string[];
  points?: Array<{
    values: Record<string, number | null>;
    derived?: Record<string, number | null>;
    sampleCount?: number;
  }>;
  from?: string;
  available?: boolean;
  resolutionSeconds?: number;
  sampleCount?: number;
  latestAt?: string;
  serverId?: string;
  initialConnected?: boolean;
  uptimeSeconds?: number;
  downtimeSeconds?: number;
  unknownSeconds?: number;
  uptimePercent?: number;
  truncated?: boolean;
  events?: Array<{ reason?: string }>;
  cpuLimits?: {
    tdpWatts: number | null;
    tjMaxCelsius: number | null;
    source: string;
  };
  temperatureUnit?: string;
};

/** `/servers/:id/metrics/series` v5 bundled response — see `buildSeriesRouteResponse`. */
type SeriesRouteJsonBody = {
  ok?: boolean;
  error?: string;
  serverId?: string;
  from?: string;
  to?: string;
  backend?: string;
  available?: boolean;
  resolutionSeconds?: number | null;
  host?: {
    metrics: string[];
    sampleCount: number;
    gapCount: number;
    points: Array<{
      at: string;
      values: Record<string, number | null>;
      derived?: Record<string, number | null>;
      sampleCount: number;
      topologyGeneration?: number | null;
    }>;
    topologyGenerationBreaks: number[];
    topologyGenerations?: number[];
  } | null;
  entities?: Array<{
    family: string;
    metrics: string[];
    available: boolean;
    entities: Array<{
      entityId: string;
      points: unknown[];
      sampleCount: number;
      gapCount: number;
    }>;
  }>;
  inventory?: unknown;
  topologyGeneration?: number | null;
  cpuLimits?: {
    tdpWatts: number | null;
    tjMaxCelsius: number | null;
    source: string;
  };
  temperatureUnit?: string;
};

async function readMetricsJson(res: Response): Promise<MetricsRouteJsonBody> {
  return (await res.json()) as MetricsRouteJsonBody;
}

async function readSeriesJson(res: Response): Promise<SeriesRouteJsonBody> {
  return (await res.json()) as SeriesRouteJsonBody;
}

const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2026-01-01T01:00:00.000Z";

/**
 * Fake `ServerMetricsStore` for `/series`/`/summary`/`/connection`/`/latest`
 * tests. A query method is present on the returned object only when its
 * handler is provided, mirroring `ServerMetricsStore`'s optional-on-interface
 * methods (a route must treat a genuinely absent method as "unavailable", not
 * call through to a no-op).
 */
function createFakeMetricsStore(
  handlers: {
    queryHostSeries?: (input: HostSeriesQuery) => Promise<HostSeriesResult>;
    queryHostSummary?: (input: HostSummaryQuery) => Promise<HostSummaryResult>;
    queryEntitySeries?: (
      input: EntitySeriesQuery,
    ) => Promise<EntitySeriesResult>;
    queryFleetHostSnapshot?: (
      input: FleetHostSnapshotQuery,
    ) => Promise<FleetHostSnapshotResult>;
    queryStatusHistory?: (
      input: StatusHistoryQuery,
    ) => Promise<StatusHistoryResult>;
  } = {},
): ServerMetricsStore & {
  seriesCalls: HostSeriesQuery[];
  summaryCalls: HostSummaryQuery[];
  entityCalls: EntitySeriesQuery[];
  fleetCalls: FleetHostSnapshotQuery[];
  connectionCalls: StatusHistoryQuery[];
} {
  const seriesCalls: HostSeriesQuery[] = [];
  const summaryCalls: HostSummaryQuery[] = [];
  const entityCalls: EntitySeriesQuery[] = [];
  const fleetCalls: FleetHostSnapshotQuery[] = [];
  const connectionCalls: StatusHistoryQuery[] = [];

  return {
    seriesCalls,
    summaryCalls,
    entityCalls,
    fleetCalls,
    connectionCalls,
    writeSample: () => {},
    writeStatusEvent: () => {},
    ...(handlers.queryHostSeries
      ? {
        queryHostSeries: (input: HostSeriesQuery) => {
          seriesCalls.push(input);
          return handlers.queryHostSeries!(input);
        },
      }
      : {}),
    ...(handlers.queryHostSummary
      ? {
        queryHostSummary: (input: HostSummaryQuery) => {
          summaryCalls.push(input);
          return handlers.queryHostSummary!(input);
        },
      }
      : {}),
    ...(handlers.queryEntitySeries
      ? {
        queryEntitySeries: (input: EntitySeriesQuery) => {
          entityCalls.push(input);
          return handlers.queryEntitySeries!(input);
        },
      }
      : {}),
    ...(handlers.queryFleetHostSnapshot
      ? {
        queryFleetHostSnapshot: (input: FleetHostSnapshotQuery) => {
          fleetCalls.push(input);
          return handlers.queryFleetHostSnapshot!(input);
        },
      }
      : {}),
    ...(handlers.queryStatusHistory
      ? {
        queryStatusHistory: (input: StatusHistoryQuery) => {
          connectionCalls.push(input);
          return handlers.queryStatusHistory!(input);
        },
      }
      : {}),
  };
}

async function createMetricsRoutesTestApp(
  db: ReturnType<typeof createDenoDb>,
  runtime: "workers" | "deno" = "deno",
  registry?: DaemonCellRegistry,
  metricsStore?: ServerMetricsStore,
) {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    if (metricsStore) {
      c.set("serverMetricsStore", metricsStore);
    }
    if (registry) {
      c.set("daemonCellRegistry", registry);
    }
    return next();
  });
  registerServerMetricsRoutes(app, {
    secrets,
    runtime,
    signupEnvOverride: undefined,
  });
  return { app, secrets };
}

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {});
  const signed = await buildSignedCookie(token, secrets);
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
}

async function withMetricsFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>;
    app: Hono<AppEnv>;
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>;
    userId: string;
    organizationId: string;
    serverId: string;
    cookie: string;
  }) => Promise<void>,
  registry?: DaemonCellRegistry,
  metricsStore?: ServerMetricsStore,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping metrics route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  resetDenoMetricsChartCacheForTests();
  const db = createDenoDb();
  const { app, secrets } = await createMetricsRoutesTestApp(
    db,
    "deno",
    registry,
    metricsStore,
  );

  const email = `metrics-route-test-${crypto.randomUUID()}@example.com`;
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: "Metrics Route Test Org" })
    .returning({ id: organization.id });
  const organizationId = insertedOrg!.id;

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: "user" })
    .returning({ id: user.id });
  const userId = insertedUser!.id;

  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });

  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: "Metrics Test Server",
    })
    .returning({ id: server.id });
  const serverId = insertedServer!.id;

  const cookie = await sessionCookie(db, secrets, userId);

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      serverId,
      cookie,
    });
  } finally {
    await db.delete(server).where(eq(server.id, serverId));
    await db.delete(grant).where(
      and(eq(grant.actorId, userId), eq(grant.entityId, organizationId)),
    );
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
}

it("GET /servers/:id/metrics/series returns 401 without session", async () => {
  await withMetricsFixtures(async ({ app, serverId }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}`,
    );
    assertEquals(res.status, 401);
  });
});

it("GET /servers/:id/metrics/capabilities returns 401 without session", async () => {
  await withMetricsFixtures(async ({ app, serverId }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/capabilities`,
    );
    assertEquals(res.status, 401);
  });
});

it("GET /servers/:id/metrics/capabilities returns 409 when the daemon is offline", async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: "done" }));
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/capabilities`,
      { headers: { cookie } },
    );
    assertEquals(res.status, 409);
    const body = (await res.json()) as { error?: string };
    assertEquals(body.error, "server_offline");
    assertEquals(registry.sent.length, 0);
  }, registry);
});

it("GET /servers/:id/metrics/capabilities returns the daemon payload on a connected host", async () => {
  const capabilities = {
    sensors: { cpuTemperature: [] },
    storageMounts: {
      system: null,
      hosting: { probedPath: "/srv/users", result: null },
      docker: { probedPath: null, result: null, reason: "docker_absent" },
      candidates: [],
    },
    networkInterfaces: [{ name: "eth0", classification: "uplink" }],
    process: { probedPath: "/proc" },
  };
  const registry = createFakeDaemonRegistry((outbound) => {
    if (outbound.kind === "metrics-capabilities-request") {
      return { status: "done", result: { capabilities } };
    }
    return { status: "done" };
  });
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId);
    const res = await app.request(
      `/servers/${serverId}/metrics/capabilities`,
      { headers: { cookie } },
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      ok?: boolean;
      capabilities?: unknown;
    };
    assertEquals(body.ok, true);
    assertEquals(body.capabilities, capabilities);
    assertEquals(registry.sent.length, 1);
    assertEquals(registry.sent[0]?.kind, "metrics-capabilities-request");
  }, registry);
});

it("GET /servers/:id/metrics/series returns 403 without read access", async () => {
  if (!dbUrl) return;

  resetDenoMetricsChartCacheForTests();
  const db = createDenoDb();
  const { app, secrets } = await createMetricsRoutesTestApp(db);

  const email = `metrics-deny-${crypto.randomUUID()}@example.com`;
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: "Metrics Deny Org" })
    .returning({ id: organization.id });
  const organizationId = insertedOrg!.id;

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: "user" })
    .returning({ id: user.id });
  const userId = insertedUser!.id;

  const [insertedServer] = await db
    .insert(server)
    .values({ organizationId, name: "Denied Server" })
    .returning({ id: server.id });
  const serverId = insertedServer!.id;

  const cookie = await sessionCookie(db, secrets, userId);

  try {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}`,
      {
        headers: { Cookie: cookie },
      },
    );
    assertEquals(res.status, 403);
  } finally {
    await db.delete(server).where(eq(server.id, serverId));
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
});

it("GET /servers/:id/metrics/series rejects unknown metrics", async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=notReal`,
      { headers: { Cookie: cookie } },
    );
    assertEquals(res.status, 400);
    const body = await readMetricsJson(res);
    assertEquals(body.ok, false);
  });
});

it("GET /servers/:id/metrics/series rejects invalid range", async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${TO}&to=${FROM}`,
      {
        headers: { Cookie: cookie },
      },
    );
    assertEquals(res.status, 400);
  });
});

it("GET /servers/:id/metrics/series issues one fan-in queryHostSeries call", async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        metrics: input.metrics,
        points: [
          {
            at: FROM,
            values: {
              "host.cpu.busyPercent": 25,
              "host.memory.usedBytes": 2_000,
            },
            sampleCount: 1,
            expectedSampleCount: 5,
          },
        ],
        resolutionSeconds: input.resolutionSeconds ?? 60,
        gapCount: 0,
        sampleCount: 1,
      }),
  });

  await withMetricsFixtures(
    async ({ app, serverId, cookie }) => {
      const url =
        `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=host.cpu.busyPercent,host.memory.usedBytes`;
      const res = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(res.status, 200);
      const body = await readSeriesJson(res);
      assertEquals(body.ok, true);
      assertEquals(body.host!.metrics, [
        "host.cpu.busyPercent",
        "host.memory.usedBytes",
      ]);
      assertEquals(body.host!.points.length, 1);
      const values = body.host!.points[0]!.values;
      assertEquals(values["host.cpu.busyPercent"], 25);
      assertEquals(values["host.memory.usedBytes"], 2_000);
      // Derived presentation values are server-computed. v5's
      // host.cpu.busyPercent is already the "used" semantic (no v3
      // idle-inversion); memoryUsedPercent needs the topology-reported
      // memoryTotalBytes, which no generation was recorded here, so it's null.
      const derived = body.host!.points[0]!.derived!;
      assertEquals(derived.cpuUsagePercent, 25);
      assertEquals(derived.memoryUsedPercent, null);
      assertEquals(body.host!.points[0]!.sampleCount, 1);
      assertEquals(fakeStore.seriesCalls.length, 1);
      assertEquals(fakeStore.seriesCalls[0]!.metrics, [
        "host.cpu.busyPercent",
        "host.memory.usedBytes",
      ]);
      assertEquals(fakeStore.seriesCalls[0]!.resolutionSeconds, 60);

      const cached = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(cached.status, 200);
      assertEquals(fakeStore.seriesCalls.length, 1);
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/series attaches cpuLimits, temperatureUnit, and topology-generation breaks", async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        metrics: input.metrics,
        points: [
          {
            at: FROM,
            values: { "host.cpu.busyPercent": 10 },
            sampleCount: 1,
            topologyGeneration: 1,
          },
          {
            at: TO,
            values: { "host.cpu.busyPercent": 20 },
            sampleCount: 1,
            topologyGeneration: 2,
          },
        ],
        resolutionSeconds: input.resolutionSeconds ?? 60,
        gapCount: 0,
        sampleCount: 2,
        topologyGenerations: [1, 2],
      }),
  });

  await withMetricsFixtures(
    async ({ db, app, serverId, organizationId, cookie }) => {
      await db
        .update(server)
        .set({
          metadata: sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
            JSON.stringify({
              hardwareProfile: { cpuModel: "AMD EPYC 7763" },
            })
          }::jsonb`,
        })
        .where(eq(server.id, serverId));
      await db
        .update(organization)
        .set({
          options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
            JSON.stringify({
              temperatureUnit: "fahrenheit",
            })
          }::jsonb`,
        })
        .where(eq(organization.id, organizationId));

      const url =
        `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=host.cpu.busyPercent`;
      const res = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(res.status, 200);
      const body = await readSeriesJson(res);
      assertEquals(body.cpuLimits, {
        tdpWatts: 280,
        tjMaxCelsius: 95,
        source: "catalog-exact",
      });
      assertEquals(body.temperatureUnit, "fahrenheit");
      assertEquals(body.host!.topologyGenerationBreaks, [1]);
      assertEquals(body.host!.topologyGenerations, [1, 2]);
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/series does not serve a stale cache entry across a topology-generation bump", async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        metrics: input.metrics,
        points: [
          {
            at: FROM,
            values: { "host.cpu.busyPercent": 90 },
            sampleCount: 1,
          },
        ],
        resolutionSeconds: input.resolutionSeconds ?? 60,
        gapCount: 0,
        sampleCount: 1,
      }),
  });

  await withMetricsFixtures(
    async ({ db, app, serverId, cookie }) => {
      const url =
        `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=host.cpu.busyPercent`;

      const first = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(first.status, 200);
      assertEquals(fakeStore.seriesCalls.length, 1);

      // Same request again — served from cache, no new store call.
      const cached = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(cached.status, 200);
      assertEquals(fakeStore.seriesCalls.length, 1);

      // Record a new topology generation directly (a sensor/NIC
      // reassignment) — not via the PUT route, which needs a connected
      // daemon for identity validation; this is purely about cache scoping.
      await recordTopologyGeneration(db, serverId, {
        generation: 1,
        bootGeneration: 1,
        snapshot: {
          networks: [],
          filesystems: [],
          blockDevices: [],
          gpus: [],
          hardwareSignals: [],
          cpu: {
            sockets: 1,
            coresPerSocket: 1,
            threadsPerSocket: 1,
            model: null,
          },
          numaNodes: [],
          memoryTotalBytes: null,
          swapTotalBytes: null,
        },
        appliedAt: new Date().toISOString(),
      });

      // Identical (server, range, metrics) request — must not hit the
      // pre-bump cache entry.
      const afterBump = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(afterBump.status, 200);
      assertEquals(fakeStore.seriesCalls.length, 2);
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/series resolves cpuLimits from the daemon-reported CPU model when hardwareProfile.cpuModel is unset", async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        metrics: input.metrics,
        points: [
          {
            at: FROM,
            values: { "host.cpu.busyPercent": 90 },
            sampleCount: 1,
          },
        ],
        resolutionSeconds: input.resolutionSeconds ?? 60,
        gapCount: 0,
        sampleCount: 1,
      }),
  });

  await withMetricsFixtures(
    async ({ db, app, serverId, cookie }) => {
      // No hardwareProfile.cpuModel set — only the raw daemon-reported
      // resources.cpus[0].name (real cpuinfo string, trademark markers and
      // trailing clock text included).
      await db
        .update(server)
        .set({
          metadata: sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
            JSON.stringify({
              resources: {
                cpus: [{ name: "Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz" }],
              },
            })
          }::jsonb`,
        })
        .where(eq(server.id, serverId));

      const url =
        `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=host.cpu.busyPercent`;
      const res = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(res.status, 200);
      const body = await readSeriesJson(res);
      assertEquals(body.cpuLimits, {
        tdpWatts: 205,
        tjMaxCelsius: 105,
        source: "catalog-exact",
      });
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/metrics/latest requests only the v5 fleet host metric set", async () => {
  const fakeStore = createFakeMetricsStore({
    queryFleetHostSnapshot: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        metrics: [...input.metrics],
        servers: input.serverIds.map((serverId) => ({
          serverId,
          latestAt: TO,
          values: {
            "host.cpu.busyPercent": 40,
            "host.cpu.userPercent": 25,
            "host.cpu.systemPercent": 10,
            "host.cpu.iowaitPercent": 5,
            "host.memory.usedBytes": 12_000,
            "host.memory.swapUsedBytes": 250,
          },
          sampleCount: 3,
        })),
      }),
  });

  await withMetricsFixtures(
    async ({ db, app, organizationId, serverId, cookie }) => {
      // Topology capacity join: memoryUsedPercent/swapUsedPercent need the
      // recorded totals — the fleet route batches this in one query
      // regardless of visible-server count (see AGENTS.md's O(1) invariant).
      await recordTopologyGeneration(db, serverId, {
        generation: 1,
        bootGeneration: 1,
        snapshot: {
          networks: [],
          filesystems: [],
          blockDevices: [],
          gpus: [],
          hardwareSignals: [],
          cpu: {
            sockets: 1,
            coresPerSocket: 1,
            threadsPerSocket: 1,
            model: null,
          },
          numaNodes: [],
          memoryTotalBytes: 16_000,
          swapTotalBytes: 1_000,
        },
        appliedAt: new Date().toISOString(),
      });

      const res = await app.request(
        `/servers/metrics/latest?organizationId=${organizationId}`,
        {
          headers: { Cookie: cookie },
        },
      );
      assertEquals(res.status, 200);
      const body = (await res.json()) as {
        ok?: boolean;
        available?: boolean;
        backend?: string;
        metrics?: string[];
        servers?: Array<{
          serverId: string;
          values: Record<string, number | null>;
          derived: Record<string, number | null>;
        }>;
      };
      assertEquals(body.ok, true);
      assertEquals(body.available, true);
      assertEquals(body.backend, "duckdb");
      // The fleet path requests the fixed v5 host metric set only — no
      // stored derived metrics, no per-server request.
      assertEquals(body.metrics, [...FLEET_HOST_METRICS]);
      assertEquals(fakeStore.fleetCalls.length, 1);
      assertEquals(fakeStore.fleetCalls[0]!.metrics, [...FLEET_HOST_METRICS]);
      assertEquals(fakeStore.fleetCalls[0]!.serverIds, [serverId]);

      const row = body.servers!.find((entry) => entry.serverId === serverId);
      assertExists(row);
      // Derived presentation values are server-computed, not reimplemented by
      // the UI: v5's host.cpu.busyPercent is already the "used" semantic;
      // used % for memory/swap comes from the topology-reported totals.
      assertEquals(row!.derived.cpuUsagePercent, 40);
      assertEquals(row!.derived.memoryUsedPercent, 75);
      assertEquals(row!.derived.swapUsedPercent, 25);
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/series returns available:false for disabled store", async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}`,
      {
        headers: { Cookie: cookie },
      },
    );
    assertEquals(res.status, 200);
    const body = await readSeriesJson(res);
    assertEquals(body.available, false);
    assertEquals(body.backend, "disabled");
    assertEquals(body.host!.points, []);
  });
});

it("GET /servers/:id/metrics/series rejects oversized maxPoints", async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&maxPoints=${
        MAX_METRICS_POINTS + 1
      }`,
      { headers: { Cookie: cookie } },
    );
    assertEquals(res.status, 400);
    const body = await readMetricsJson(res);
    assertEquals(body.ok, false);
  });
});

it("GET /servers/:id/metrics/series clamps resolution=60 over maximum range", async () => {
  const from = "2026-01-01T00:00:00.000Z";
  const to = "2026-04-01T00:00:00.000Z";
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        metrics: input.metrics,
        points: [],
        resolutionSeconds: input.resolutionSeconds ?? 21600,
        gapCount: 0,
        sampleCount: 0,
      }),
  });

  await withMetricsFixtures(
    async ({ app, serverId, cookie }) => {
      const res = await app.request(
        `/servers/${serverId}/metrics/series?from=${from}&to=${to}&resolution=60`,
        { headers: { Cookie: cookie } },
      );
      assertEquals(res.status, 200);
      const body = await readSeriesJson(res);
      // 90 days / 1500 max points forces the ladder up to 21600 s buckets.
      assertEquals(body.resolutionSeconds, 21600);
      assertEquals(fakeStore.seriesCalls.length, 1);
      assertEquals(fakeStore.seriesCalls[0]!.resolutionSeconds, 21600);
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/series cache uses canonical range for exact timestamps", async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        metrics: input.metrics,
        points: [
          {
            at: input.from,
            values: { "host.cpu.busyPercent": 99 },
            sampleCount: 1,
          },
        ],
        resolutionSeconds: input.resolutionSeconds ?? 300,
        gapCount: 0,
        sampleCount: 1,
      }),
  });

  await withMetricsFixtures(
    async ({ app, serverId, cookie }) => {
      const fromA = "2026-01-01T00:00:30.000Z";
      const fromB = "2026-01-01T00:02:00.000Z";
      const urlA =
        `/servers/${serverId}/metrics/series?from=${fromA}&to=${TO}&metrics=host.cpu.busyPercent&resolution=300`;
      const urlB =
        `/servers/${serverId}/metrics/series?from=${fromB}&to=${TO}&metrics=host.cpu.busyPercent&resolution=300`;

      const first = await app.request(urlA, { headers: { Cookie: cookie } });
      assertEquals(first.status, 200);
      const bodyA = await readSeriesJson(first);
      assertEquals(bodyA.from, "2026-01-01T00:00:00.000Z");

      const second = await app.request(urlB, { headers: { Cookie: cookie } });
      assertEquals(second.status, 200);
      const bodyB = await readSeriesJson(second);
      assertEquals(bodyB.from, "2026-01-01T00:00:00.000Z");
      assertEquals(bodyB.host!.points[0]!.values["host.cpu.busyPercent"], 99);
      assertEquals(fakeStore.seriesCalls.length, 1);
      assertEquals(fakeStore.seriesCalls[0]!.from, "2026-01-01T00:00:00.000Z");
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/series maps Analytics Engine failures to 503", async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: () => Promise.reject(new Error("AE SQL unavailable")),
  });

  if (!dbUrl) return;

  resetDenoMetricsChartCacheForTests();
  const db = createDenoDb();
  const { app, secrets } = await createMetricsRoutesTestApp(
    db,
    "workers",
    undefined,
    fakeStore,
  );

  const email = `metrics-ae-fail-${crypto.randomUUID()}@example.com`;
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: "Metrics AE Fail Org" })
    .returning({ id: organization.id });
  const organizationId = insertedOrg!.id;

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: "user" })
    .returning({ id: user.id });
  const userId = insertedUser!.id;

  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });

  const [insertedServer] = await db
    .insert(server)
    .values({ organizationId, name: "AE Fail Server" })
    .returning({ id: server.id });
  const serverId = insertedServer!.id;

  const cookie = await sessionCookie(db, secrets, userId);

  try {
    const res = await app.request(
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}`,
      {
        headers: { Cookie: cookie },
      },
    );
    assertEquals(res.status, 503);
    const body = await readMetricsJson(res);
    assertEquals(body.ok, false);
    assertEquals(body.error, "metrics_backend_unavailable");
    assertEquals(body.backend, "analytics-engine");
  } finally {
    await db.delete(server).where(eq(server.id, serverId));
    await db.delete(grant).where(
      and(eq(grant.actorId, userId), eq(grant.entityId, organizationId)),
    );
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
});

it("GET /servers/:id/metrics/series maps backend failures to 503", async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: () =>
      Promise.reject(new Error("metrics backend unavailable")),
  });

  await withMetricsFixtures(
    async ({ app, serverId, cookie }) => {
      const res = await app.request(
        `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}`,
        {
          headers: { Cookie: cookie },
        },
      );
      assertEquals(res.status, 503);
      const body = await readMetricsJson(res);
      assertEquals(body.ok, false);
      assertEquals(body.error, "metrics_backend_unavailable");
      assertEquals(body.backend, "duckdb");
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/series fans out per-entity-family selectors and attaches the topology inventory", async () => {
  const fakeStore = createFakeMetricsStore({
    queryEntitySeries: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        family: input.family,
        metrics: input.metrics,
        resolutionSeconds: input.resolutionSeconds ?? 60,
        entities: input.entityIds.map((entityId) => ({
          entityId,
          points: [
            {
              at: FROM,
              values: { receiveBytesPerSecond: 100 },
              sampleCount: 1,
            },
          ],
          sampleCount: 1,
          gapCount: 0,
        })),
      }),
  });

  await withMetricsFixtures(
    async ({ db, app, serverId, cookie }) => {
      await recordTopologyGeneration(db, serverId, {
        generation: 1,
        bootGeneration: 1,
        snapshot: {
          // Two uplinks: eth0/eth1 claim the two normal-NIC slots, eth2 pages
          // as a standalone `network` entity — see `topology-slot-mapping.ts`.
          networks: [
            { deviceId: "eth0", kind: "uplink", name: "eth0", identity: {} },
            { deviceId: "eth1", kind: "uplink", name: "eth1", identity: {} },
            { deviceId: "eth2", kind: "uplink", name: "eth2", identity: {} },
          ],
          filesystems: [],
          blockDevices: [],
          gpus: [],
          hardwareSignals: [],
          cpu: {
            sockets: 1,
            coresPerSocket: 1,
            threadsPerSocket: 1,
            model: null,
          },
          numaNodes: [],
          memoryTotalBytes: null,
          swapTotalBytes: null,
        },
        appliedAt: new Date().toISOString(),
      });

      const url =
        `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=network:eth2.receiveBytesPerSecond`;
      const res = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(res.status, 200);
      const body = await readSeriesJson(res);
      assertEquals(body.host, null);
      assertEquals(body.entities!.length, 1);
      assertEquals(body.entities![0]!.family, "network");
      assertEquals(body.entities![0]!.entities[0]!.entityId, "eth2");
      assertExists(body.inventory);
      assertEquals(fakeStore.entityCalls.length, 1);
      assertEquals(fakeStore.entityCalls[0]!.entityIds, ["eth2"]);
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/series allows a slot-mapped NIC as a standalone network entity, forwarding slotMapping/topologyGeneration to queryEntitySeries", async () => {
  const fakeStore = createFakeMetricsStore({
    queryEntitySeries: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        family: input.family,
        metrics: input.metrics,
        resolutionSeconds: 300,
        entities: input.entityIds.map((entityId) => ({
          entityId,
          points: [],
          sampleCount: 0,
          gapCount: 0,
        })),
      }),
  });

  await withMetricsFixtures(
    async ({ db, app, serverId, cookie }) => {
      // eth0 is the sole uplink, so it resolves to NIC slot 1 — no longer
      // rejected: Cloudflare reconstructs its rx/tx from host.io, and DuckDB
      // already stored the full row (see EntitySeriesQuery's doc comment).
      await recordTopologyGeneration(db, serverId, {
        generation: 1,
        bootGeneration: 1,
        snapshot: {
          networks: [
            {
              deviceId: "eth0",
              kind: "uplink",
              name: "eth0",
              identity: {},
            },
          ],
          filesystems: [],
          blockDevices: [],
          gpus: [],
          hardwareSignals: [],
          cpu: {
            sockets: 1,
            coresPerSocket: 1,
            threadsPerSocket: 1,
            model: null,
          },
          numaNodes: [],
          memoryTotalBytes: null,
          swapTotalBytes: null,
        },
        appliedAt: new Date().toISOString(),
      });

      const url =
        `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=network:eth0.receiveBytesPerSecond`;
      const res = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(res.status, 200);
      const body = await readSeriesJson(res);
      assertEquals(body.ok, true);
      assertEquals(body.entities?.[0]?.entities?.[0]?.entityId, "eth0");
      assertEquals(fakeStore.entityCalls.length, 1);
      assertEquals(fakeStore.entityCalls[0]!.slotMapping?.normalNicSlots, [
        "eth0",
      ]);
      assertEquals(fakeStore.entityCalls[0]!.topologyGeneration, 1);
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/series still rejects a TurboFabric mesh device as a standalone network entity", async () => {
  await withMetricsFixtures(async ({ db, app, serverId, cookie }) => {
    // Two uplinks fill the normal NIC slots, so the third device is
    // classified fabric — no reconstruction path on either backend.
    await recordTopologyGeneration(db, serverId, {
      generation: 1,
      bootGeneration: 1,
      snapshot: {
        networks: [
          { deviceId: "eth0", kind: "uplink", name: "eth0", identity: {} },
          { deviceId: "eth1", kind: "uplink", name: "eth1", identity: {} },
          { deviceId: "fab0", kind: "fabric", name: "fab0", identity: {} },
        ],
        filesystems: [],
        blockDevices: [],
        gpus: [],
        hardwareSignals: [],
        cpu: {
          sockets: 1,
          coresPerSocket: 1,
          threadsPerSocket: 1,
          model: null,
        },
        numaNodes: [],
        memoryTotalBytes: null,
        swapTotalBytes: null,
      },
      appliedAt: new Date().toISOString(),
    });

    const url =
      `/servers/${serverId}/metrics/series?from=${FROM}&to=${TO}&metrics=network:fab0.receiveBytesPerSecond`;
    const res = await app.request(url, { headers: { Cookie: cookie } });
    assertEquals(res.status, 400);
    const body = await readMetricsJson(res);
    assertEquals(body.ok, false);
  });
});

it("GET /servers/:id/metrics/summary returns normalized payload", async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSummary: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        sampleCount: 12,
        latestAt: TO,
      }),
  });

  await withMetricsFixtures(
    async ({ app, serverId, cookie }) => {
      const res = await app.request(
        `/servers/${serverId}/metrics/summary?from=${FROM}&to=${TO}`,
        {
          headers: { Cookie: cookie },
        },
      );
      assertEquals(res.status, 200);
      const body = await readMetricsJson(res);
      assertExists(body.ok);
      assertEquals(body.sampleCount, 12);
      assertEquals(body.latestAt, TO);
      assertEquals(fakeStore.summaryCalls.length, 1);
      // No hardware profile / org override set — falls through to "no limit".
      assertEquals(body.cpuLimits, {
        tdpWatts: null,
        tjMaxCelsius: null,
        source: "none",
      });
      assertEquals(body.temperatureUnit, "celsius");
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/summary attaches an operator TDP/Tjmax override", async () => {
  const fakeStore = createFakeMetricsStore({
    queryHostSummary: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        sampleCount: 3,
        latestAt: TO,
      }),
  });

  await withMetricsFixtures(
    async ({ db, app, serverId, cookie }) => {
      await db
        .update(server)
        .set({
          metadata: sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
            JSON.stringify({
              hardwareProfile: {
                cpuModel: "AMD EPYC 7763",
                cpuTdpWattsOverride: 250,
              },
            })
          }::jsonb`,
        })
        .where(eq(server.id, serverId));

      const res = await app.request(
        `/servers/${serverId}/metrics/summary?from=${FROM}&to=${TO}`,
        {
          headers: { Cookie: cookie },
        },
      );
      assertEquals(res.status, 200);
      const body = await readMetricsJson(res);
      // Override wins for tdpWatts; tjMaxCelsius falls through to the catalog.
      assertEquals(body.cpuLimits, {
        tdpWatts: 250,
        tjMaxCelsius: 95,
        source: "override",
      });
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/summary returns 403 without read access", async () => {
  if (!dbUrl) return;

  resetDenoMetricsChartCacheForTests();
  const db = createDenoDb();
  const { app, secrets } = await createMetricsRoutesTestApp(db);

  const email = `metrics-summary-deny-${crypto.randomUUID()}@example.com`;
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: "Metrics Summary Deny Org" })
    .returning({ id: organization.id });
  const organizationId = insertedOrg!.id;

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: "user" })
    .returning({ id: user.id });
  const userId = insertedUser!.id;

  const [insertedServer] = await db
    .insert(server)
    .values({ organizationId, name: "Denied Summary Server" })
    .returning({ id: server.id });
  const serverId = insertedServer!.id;

  const cookie = await sessionCookie(db, secrets, userId);

  try {
    const res = await app.request(
      `/servers/${serverId}/metrics/summary?from=${FROM}&to=${TO}`,
      {
        headers: { Cookie: cookie },
      },
    );
    assertEquals(res.status, 403);
  } finally {
    await db.delete(server).where(eq(server.id, serverId));
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
});

it("GET /servers/:id/metrics/connection returns 401 without session", async () => {
  await withMetricsFixtures(async ({ app, serverId }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/connection?from=${FROM}&to=${TO}`,
    );
    assertEquals(res.status, 401);
  });
});

it("GET /servers/:id/metrics/connection returns 403 without read access", async () => {
  if (!dbUrl) return;

  resetDenoMetricsChartCacheForTests();
  const db = createDenoDb();
  const { app, secrets } = await createMetricsRoutesTestApp(db);

  const email = `metrics-conn-deny-${crypto.randomUUID()}@example.com`;
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: "Metrics Connection Deny Org" })
    .returning({ id: organization.id });
  const organizationId = insertedOrg!.id;

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: "user" })
    .returning({ id: user.id });
  const userId = insertedUser!.id;

  const [insertedServer] = await db
    .insert(server)
    .values({ organizationId, name: "Denied Connection Server" })
    .returning({ id: server.id });
  const serverId = insertedServer!.id;

  const cookie = await sessionCookie(db, secrets, userId);

  try {
    const res = await app.request(
      `/servers/${serverId}/metrics/connection?from=${FROM}&to=${TO}`,
      {
        headers: { Cookie: cookie },
      },
    );
    assertEquals(res.status, 403);
  } finally {
    await db.delete(server).where(eq(server.id, serverId));
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
});

it("GET /servers/:id/metrics/connection rejects invalid range", async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/connection?from=${TO}&to=${FROM}`,
      {
        headers: { Cookie: cookie },
      },
    );
    assertEquals(res.status, 400);
  });
});

it("GET /servers/:id/metrics/connection maps backend failures to 503", async () => {
  const fakeStore = createFakeMetricsStore({
    queryStatusHistory: () =>
      Promise.reject(new Error("metrics backend unavailable")),
  });

  await withMetricsFixtures(
    async ({ app, serverId, cookie }) => {
      const res = await app.request(
        `/servers/${serverId}/metrics/connection?from=${FROM}&to=${TO}`,
        {
          headers: { Cookie: cookie },
        },
      );
      assertEquals(res.status, 503);
      const body = await readMetricsJson(res);
      assertEquals(body.ok, false);
      assertEquals(body.error, "metrics_backend_unavailable");
      assertEquals(body.backend, "duckdb");
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/connection returns payload and caches on repeat", async () => {
  const fakeStore = createFakeMetricsStore({
    queryStatusHistory: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        initialConnected: false,
        events: [
          {
            at: "2026-01-01T00:15:00.000Z",
            connected: true,
            reason: "connect",
          },
        ],
        uptimeSeconds: 2700,
        downtimeSeconds: 900,
        unknownSeconds: 0,
        uptimePercent: 0.75,
        truncated: false,
      }),
  });

  await withMetricsFixtures(
    async ({ app, serverId, cookie }) => {
      const url =
        `/servers/${serverId}/metrics/connection?from=${FROM}&to=${TO}`;
      const res = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(res.status, 200);
      const body = await readMetricsJson(res);
      assertEquals(body.ok, true);
      assertEquals(body.serverId, serverId);
      assertEquals(body.available, true);
      assertEquals(body.initialConnected, false);
      assertEquals(body.uptimeSeconds, 2700);
      assertEquals(body.downtimeSeconds, 900);
      assertEquals(body.unknownSeconds, 0);
      assertEquals(body.uptimePercent, 0.75);
      assertEquals(body.truncated, false);
      assertEquals(body.events!.length, 1);
      assertEquals(body.events![0]!.reason, "connect");
      assertEquals(fakeStore.connectionCalls.length, 1);

      const cached = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(cached.status, 200);
      assertEquals(fakeStore.connectionCalls.length, 1);
    },
    undefined,
    fakeStore,
  );
});

type FakeCellResponse = {
  status: PendingRequestRecord["status"];
  result?: unknown;
  error?: string;
};

function createFakeDaemonRegistry(
  respond: (outbound: DaemonOutboundEnvelope) => FakeCellResponse,
): DaemonCellRegistry & {
  sent: DaemonOutboundEnvelope[];
  enqueued: DaemonOutboundEnvelope[];
} {
  const sent: DaemonOutboundEnvelope[] = [];
  const enqueued: DaemonOutboundEnvelope[] = [];

  const buildRecord = (
    serverId: string,
    outbound: DaemonOutboundEnvelope,
    response: FakeCellResponse,
  ): PendingRequestRecord => ({
    serverId,
    requestId: outbound.requestId,
    requestKind: outbound.kind,
    status: response.status,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    result: response.result,
    error: response.error,
  });

  const cellFor = (serverId: string): DaemonCell =>
    ({
      createRequestAndWait: (outbound: DaemonOutboundEnvelope) => {
        sent.push(outbound);
        return Promise.resolve(
          buildRecord(serverId, outbound, respond(outbound)),
        );
      },
      enqueue: (outbound: DaemonOutboundEnvelope) => {
        enqueued.push(outbound);
        return Promise.resolve(
          buildRecord(serverId, outbound, { status: "queued" }),
        );
      },
    }) as unknown as DaemonCell;

  return {
    sent,
    enqueued,
    getCell: cellFor,
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  };
}

async function markServerConnected(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
): Promise<void> {
  await db.update(server).set({ isConnected: true }).where(
    eq(server.id, serverId),
  );
}

it("POST /servers/:id/metrics/live returns 409 when live metrics are disabled", async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: "done" }));
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await setServerMetricsLiveMaxMinutes(db, 0);
    try {
      await markServerConnected(db, serverId);
      const res = await app.request(`/servers/${serverId}/metrics/live`, {
        method: "POST",
        headers: { cookie },
      });
      assertEquals(res.status, 409);
      const body = (await res.json()) as { error?: string };
      assertEquals(body.error, "live_metrics_disabled");
      assertEquals(registry.sent.length, 0);
    } finally {
      await db.delete(setting).where(
        eq(setting.key, SERVER_METRICS_LIVE_MAX_MINUTES_KEY),
      );
    }
  }, registry);
});

it("POST /servers/:id/metrics/live starts a lease on a connected daemon", async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: "done" }));
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId);
    const before = Date.now();
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "POST",
      headers: { cookie },
    });
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      ok?: boolean;
      leaseId?: string;
      intervalSeconds?: number;
      expiresAt?: string;
    };
    assertEquals(body.ok, true);
    assertEquals(typeof body.leaseId, "string");
    assertEquals(body.intervalSeconds, 10);
    // Default cap is 60 minutes.
    const expiresMs = Date.parse(body.expiresAt ?? "");
    assertEquals(expiresMs >= before + 59 * 60_000, true);
    assertEquals(expiresMs <= Date.now() + 61 * 60_000, true);

    assertEquals(registry.sent.length, 1);
    const outbound = registry.sent[0]!;
    assertEquals(outbound.kind, "metrics-live-start");
    if (outbound.kind === "metrics-live-start") {
      assertEquals(outbound.leaseId, body.leaseId);
      assertEquals(outbound.intervalSeconds, 10);
      assertEquals(outbound.expiresAt, body.expiresAt);
    }
    assertEquals(
      await isServerLiveSessionActive(
        createMetricsChartCache("deno"),
        serverId,
      ),
      true,
    );
  }, registry);
});

it("POST /servers/:id/metrics/live renews a lease in place and DELETE returns the daemon to baseline", async () => {
  // Mirror the daemon LiveLeaseManager contract: start() on a known id renews
  // in place (no extra lease), stop() of the last lease returns cadence to
  // baseline immediately.
  const activeLeases = new Set<string>();
  const registry = createFakeDaemonRegistry((outbound) => {
    if (outbound.kind === "metrics-live-start") {
      activeLeases.add(outbound.leaseId);
    }
    if (outbound.kind === "metrics-live-stop") {
      activeLeases.delete(outbound.leaseId);
    }
    return { status: "done" };
  });
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId);
    const startRes = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "POST",
      headers: { cookie },
    });
    assertEquals(startRes.status, 200);
    const started = (await startRes.json()) as {
      ok?: boolean;
      leaseId?: string;
    };
    assertEquals(started.ok, true);
    const leaseId = started.leaseId!;
    assertEquals(activeLeases.size, 1);

    // Renew: the caller-supplied id is reused and echoed back — no second
    // lease accumulates on the daemon.
    const renewRes = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ leaseId }),
    });
    assertEquals(renewRes.status, 200);
    const renewed = (await renewRes.json()) as {
      ok?: boolean;
      leaseId?: string;
    };
    assertEquals(renewed.ok, true);
    assertEquals(renewed.leaseId, leaseId);
    assertEquals(registry.sent.length, 2);
    const renewOutbound = registry.sent[1]!;
    assertEquals(renewOutbound.kind, "metrics-live-start");
    if (renewOutbound.kind === "metrics-live-start") {
      assertEquals(renewOutbound.leaseId, leaseId);
    }
    assertEquals(activeLeases.size, 1);

    // Explicit stop of that lease leaves no active lease behind — the daemon
    // returns to baseline cadence immediately, renewal or not.
    const stopRes = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ leaseId }),
    });
    assertEquals(stopRes.status, 200);
    const stopped = (await stopRes.json()) as { ok?: boolean };
    assertEquals(stopped.ok, true);
    assertEquals(activeLeases.size, 0);
    assertEquals(
      await isServerLiveSessionActive(
        createMetricsChartCache("deno"),
        serverId,
      ),
      false,
    );
  }, registry);
});

it("POST /servers/:id/metrics/live rejects an invalid leaseId", async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: "done" }));
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ leaseId: "" }),
    });
    assertEquals(res.status, 400);
    assertEquals(registry.sent.length, 0);
  }, registry);
});

it("POST /servers/:id/metrics/live returns 409 for an offline server", async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: "done" }));
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "POST",
      headers: { cookie },
    });
    assertEquals(res.status, 409);
    const body = (await res.json()) as { error?: string };
    assertEquals(body.error, "server_offline");
  }, registry);
});

it("POST /servers/:id/metrics/live maps a daemon timeout to 503", async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: "expired" }));
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId);
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "POST",
      headers: { cookie },
    });
    assertEquals(res.status, 503);
  }, registry);
});

it("DELETE /servers/:id/metrics/live requires a leaseId", async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: "done" }));
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
  }, registry);
});

it("DELETE /servers/:id/metrics/live stops a lease on a connected daemon", async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: "done" }));
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId);
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ leaseId: "lease-1" }),
    });
    assertEquals(res.status, 200);
    const body = (await res.json()) as { ok?: boolean };
    assertEquals(body.ok, true);
    assertEquals(registry.sent.length, 1);
    const outbound = registry.sent[0]!;
    assertEquals(outbound.kind, "metrics-live-stop");
    if (outbound.kind === "metrics-live-stop") {
      assertEquals(outbound.leaseId, "lease-1");
    }
  }, registry);
});

it("DELETE /servers/:id/metrics/live is a soft success when the daemon is offline", async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: "done" }));
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ leaseId: "lease-1" }),
    });
    assertEquals(res.status, 200);
    const body = (await res.json()) as { ok?: boolean };
    assertEquals(body.ok, true);
    // The daemon-side expiry timer is the safety net; nothing was sent.
    assertEquals(registry.sent.length, 0);
    assertEquals(
      await isServerLiveSessionActive(
        createMetricsChartCache("deno"),
        serverId,
      ),
      false,
    );
  }, registry);
});

it("DELETE /servers/:id/metrics/live clears a live-session marker even when the daemon is offline", async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: "done" }));
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const cache = createMetricsChartCache("deno");
    await markServerLiveSessionActive(cache, serverId, "lease-offline", 3600);
    assertEquals(await isServerLiveSessionActive(cache, serverId), true);
    const res = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ leaseId: "lease-offline" }),
    });
    assertEquals(res.status, 200);
    assertEquals(await isServerLiveSessionActive(cache, serverId), false);
    assertEquals(registry.sent.length, 0);
  }, registry);
});

it("DELETE /servers/:id/metrics/live keeps the marker until the last concurrent viewer stops", async () => {
  const registry = createFakeDaemonRegistry(() => ({ status: "done" }));
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId);
    const cache = createMetricsChartCache("deno");
    const startA = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "POST",
      headers: { cookie },
    });
    const startB = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "POST",
      headers: { cookie },
    });
    assertEquals(startA.status, 200);
    assertEquals(startB.status, 200);
    const leaseA = ((await startA.json()) as { leaseId: string }).leaseId;
    const leaseB = ((await startB.json()) as { leaseId: string }).leaseId;
    assertEquals(await isServerLiveSessionActive(cache, serverId), true);

    const stopA = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ leaseId: leaseA }),
    });
    assertEquals(stopA.status, 200);
    assertEquals(await isServerLiveSessionActive(cache, serverId), true);

    const stopB = await app.request(`/servers/${serverId}/metrics/live`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ leaseId: leaseB }),
    });
    assertEquals(stopB.status, 200);
    assertEquals(await isServerLiveSessionActive(cache, serverId), false);
  }, registry);
});

function liveBufferedSample(
  serverId: string,
  sampledAt: string,
  busyPercent: number,
): AuthenticatedMetricsSample {
  return {
    type: "metrics",
    serverId,
    receivedAt: sampledAt,
    metadata: {
      version: METRICS_SCHEMA_VERSION,
      sampledAt,
      intervalSeconds: 10,
      sequence: 1,
      topologyGeneration: 0,
      bootGeneration: 0,
    },
    host: {
      cpu: {
        busyPercent,
        userPercent: null,
        systemPercent: null,
        iowaitPercent: null,
        stealPercent: null,
        softirqPercent: null,
        pressureSomePercent: null,
        saturatedCoreCount: null,
        procsRunning: null,
        procsBlocked: null,
        processCount: null,
      },
      kernel: { fileHandlesUsedPercent: null, conntrackUsedPercent: null },
      memory: {
        usedBytes: null,
        cachedFilesBytes: null,
        swapUsedBytes: null,
        pressureSomePercent: null,
        pressureFullPercent: null,
        swapInBytesPerSecond: null,
        swapOutBytesPerSecond: null,
        majorPageFaultsPerSecond: null,
      },
      storage: {
        ioPressureSomePercent: null,
        ioPressureFullPercent: null,
        diskReadBytesPerSecond: null,
        diskWriteBytesPerSecond: null,
        diskLatencyMs: null,
        rootFilesystemAvailableBytes: null,
        rootFilesystemFreeInodes: null,
      },
      network: { tcpRetransmitPercent: null, softnetDropsPerSecond: null },
    },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
  };
}

it("GET /servers/:id/metrics/series overlays a buffered live sample on a now-tailed live range", async () => {
  const now = Date.now();
  const from = new Date(now - 5 * 60_000).toISOString();
  const to = new Date(now).toISOString();
  const storedAt = new Date(now - 20_000).toISOString();
  const liveAt = new Date(now - 2_000).toISOString();
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        metrics: input.metrics,
        points: [
          {
            at: storedAt,
            values: { "host.cpu.busyPercent": 10 },
            sampleCount: 1,
            expectedSampleCount: 1,
          },
        ],
        resolutionSeconds: input.resolutionSeconds ?? 10,
        gapCount: 0,
        sampleCount: 1,
      }),
  });
  await withMetricsFixtures(
    async ({ app, serverId, cookie }) => {
      const cache = createMetricsChartCache("deno");
      await markServerLiveSessionActive(cache, serverId, "lease-overlay", 3600);
      await cacheLiveSample(
        cache,
        liveBufferedSample(serverId, liveAt, 77),
      );
      const url = `/servers/${serverId}/metrics/series?from=${
        encodeURIComponent(from)
      }&to=${encodeURIComponent(to)}&metrics=host.cpu.busyPercent`;
      const res = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(res.status, 200);
      const body = await readSeriesJson(res);
      assertEquals(body.resolutionSeconds, 10);
      const last = body.host?.points.at(-1);
      assertEquals(last?.values["host.cpu.busyPercent"], 77);
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/series keeps overlaying after one of two viewers stops", async () => {
  const now = Date.now();
  const from = new Date(now - 5 * 60_000).toISOString();
  const to = new Date(now).toISOString();
  const storedAt = new Date(now - 20_000).toISOString();
  const liveAt = new Date(now - 2_000).toISOString();
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        metrics: input.metrics,
        points: [
          {
            at: storedAt,
            values: { "host.cpu.busyPercent": 10 },
            sampleCount: 1,
            expectedSampleCount: 1,
          },
        ],
        resolutionSeconds: input.resolutionSeconds ?? 10,
        gapCount: 0,
        sampleCount: 1,
      }),
  });
  await withMetricsFixtures(
    async ({ app, serverId, cookie }) => {
      const cache = createMetricsChartCache("deno");
      await markServerLiveSessionActive(cache, serverId, "lease-a", 3600);
      await markServerLiveSessionActive(cache, serverId, "lease-b", 3600);
      await cacheLiveSample(
        cache,
        liveBufferedSample(serverId, liveAt, 77),
      );
      const stopA = await app.request(`/servers/${serverId}/metrics/live`, {
        method: "DELETE",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ leaseId: "lease-a" }),
      });
      assertEquals(stopA.status, 200);
      assertEquals(await isServerLiveSessionActive(cache, serverId), true);
      const url = `/servers/${serverId}/metrics/series?from=${
        encodeURIComponent(from)
      }&to=${encodeURIComponent(to)}&metrics=host.cpu.busyPercent`;
      const res = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(res.status, 200);
      const body = await readSeriesJson(res);
      assertEquals(
        body.host?.points.at(-1)?.values["host.cpu.busyPercent"],
        77,
      );
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/series drops the buffered live sample as soon as live mode ends", async () => {
  const now = Date.now();
  const from = new Date(now - 5 * 60_000).toISOString();
  const to = new Date(now).toISOString();
  const storedAt = new Date(now - 20_000).toISOString();
  const liveAt = new Date(now - 2_000).toISOString();
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        metrics: input.metrics,
        points: [
          {
            at: storedAt,
            values: { "host.cpu.busyPercent": 10 },
            sampleCount: 1,
            expectedSampleCount: 1,
          },
        ],
        resolutionSeconds: input.resolutionSeconds ?? 10,
        gapCount: 0,
        sampleCount: 1,
      }),
    queryHostSummary: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        sampleCount: 1,
        latestAt: storedAt,
      }),
  });
  await withMetricsFixtures(
    async ({ app, serverId, cookie }) => {
      const cache = createMetricsChartCache("deno");
      await markServerLiveSessionActive(cache, serverId, "lease-stop", 3600);
      await cacheLiveSample(
        cache,
        liveBufferedSample(serverId, liveAt, 77),
      );
      const stop = await app.request(`/servers/${serverId}/metrics/live`, {
        method: "DELETE",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ leaseId: "lease-stop" }),
      });
      assertEquals(stop.status, 200);
      const seriesUrl = `/servers/${serverId}/metrics/series?from=${
        encodeURIComponent(from)
      }&to=${encodeURIComponent(to)}&metrics=host.cpu.busyPercent`;
      const seriesRes = await app.request(seriesUrl, {
        headers: { Cookie: cookie },
      });
      assertEquals(seriesRes.status, 200);
      const seriesBody = await readSeriesJson(seriesRes);
      assertEquals(
        seriesBody.host?.points.at(-1)?.values["host.cpu.busyPercent"],
        10,
      );

      const summaryUrl = `/servers/${serverId}/metrics/summary?from=${
        encodeURIComponent(from)
      }&to=${encodeURIComponent(to)}`;
      const summaryRes = await app.request(summaryUrl, {
        headers: { Cookie: cookie },
      });
      assertEquals(summaryRes.status, 200);
      const summaryBody = await readMetricsJson(summaryRes);
      assertEquals(summaryBody.latestAt, storedAt);
      assertEquals(summaryBody.sampleCount, 1);
    },
    undefined,
    fakeStore,
  );
});

it("GET /servers/:id/metrics/series ignores a buffered sample after the live marker expires", async () => {
  const now = Date.now();
  const from = new Date(now - 5 * 60_000).toISOString();
  const to = new Date(now).toISOString();
  const storedAt = new Date(now - 20_000).toISOString();
  const liveAt = new Date(now - 2_000).toISOString();
  const fakeStore = createFakeMetricsStore({
    queryHostSeries: (input) =>
      Promise.resolve({
        kind: "duckdb",
        available: true,
        serverId: input.serverId,
        metrics: input.metrics,
        points: [
          {
            at: storedAt,
            values: { "host.cpu.busyPercent": 10 },
            sampleCount: 1,
            expectedSampleCount: 1,
          },
        ],
        resolutionSeconds: input.resolutionSeconds ?? 10,
        gapCount: 0,
        sampleCount: 1,
      }),
  });
  await withMetricsFixtures(
    async ({ app, serverId, cookie }) => {
      const cache = createMetricsChartCache("deno");
      await markServerLiveSessionActive(cache, serverId, "lease-expired", 3600);
      await cacheLiveSample(
        cache,
        liveBufferedSample(serverId, liveAt, 77),
      );
      await cache.set(
        `${METRICS_LIVE_SESSION_CACHE_PREFIX}${serverId}`,
        { leases: [{ id: "lease-expired", expiresAtMs: Date.now() - 1 }] },
        60,
      );
      const url = `/servers/${serverId}/metrics/series?from=${
        encodeURIComponent(from)
      }&to=${encodeURIComponent(to)}&metrics=host.cpu.busyPercent`;
      const res = await app.request(url, { headers: { Cookie: cookie } });
      assertEquals(res.status, 200);
      const body = await readSeriesJson(res);
      assertEquals(
        body.host?.points.at(-1)?.values["host.cpu.busyPercent"],
        10,
      );
    },
    undefined,
    fakeStore,
  );
});

/** Registry that accepts the best-effort hardware-profile push. */
function createHardwareProfileRegistry(): DaemonCellRegistry & {
  sent: DaemonOutboundEnvelope[];
  enqueued: DaemonOutboundEnvelope[];
} {
  return createFakeDaemonRegistry(() => ({ status: "done" }));
}

it("PUT /servers/:id/metrics/hardware-profile rejects unknown fields", async () => {
  const registry = createHardwareProfileRegistry();
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ bogus: "nope" }),
      },
    );
    assertEquals(res.status, 400);
  }, registry);
});

it("PUT /servers/:id/metrics/hardware-profile validates, persists, and pushes the full profile", async () => {
  const registry = createHardwareProfileRegistry();
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId);

    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          cpuTemperature: { chip: "coretemp", label: "Package id 0" },
          cpuPower: { chip: "intel-rapl", label: "package-0" },
          gpuDevice: { chip: "amdgpu", label: "edge" },
          gpuFan: { chip: "amdgpu", label: "fan1" },
          disk1Temperature: { chip: "drivetemp", label: "sda" },
          ambient1Temperature: { chip: "nct6775", label: "ambient" },
          boardTemperature: { chip: "nct6775", label: "board" },
          cpuFan: { chip: "nct6775", label: "fan1" },
          nic1: "eth0",
          hostingPath: "/mnt/hosting",
          drivetempEnabled: true,
        }),
      },
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      ok?: boolean;
      pushed?: boolean;
      profile?: Record<string, unknown>;
    };
    assertEquals(body.ok, true);
    assertEquals(body.pushed, true);
    assertEquals(body.profile?.cpuTemperature, {
      chip: "coretemp",
      label: "Package id 0",
    });
    assertEquals(body.profile?.gpuDevice, { chip: "amdgpu", label: "edge" });
    assertEquals(body.profile?.gpuFan, { chip: "amdgpu", label: "fan1" });
    assertEquals(body.profile?.disk1Temperature, {
      chip: "drivetemp",
      label: "sda",
    });
    assertEquals(body.profile?.nic1, "eth0");
    assertEquals(body.profile?.hostingPath, "/mnt/hosting");
    assertEquals(body.profile?.drivetempEnabled, true);
    assertEquals(body.profile?.generation, 1);
    assertExists(body.profile?.generationAppliedAt);

    // Source of truth: the server row's metadata.
    const rows = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1);
    const metadata = rows[0]!.metadata as {
      hardwareProfile?: Record<string, unknown>;
    };
    assertEquals(metadata.hardwareProfile?.cpuTemperature, {
      chip: "coretemp",
      label: "Package id 0",
    });
    assertEquals(metadata.hardwareProfile?.generation, 1);

    // Best-effort fan-out to the daemon (fire-and-forget enqueue) carries the
    // full profile, including generation.
    assertEquals(registry.enqueued.length, 1);
    const outbound = registry.enqueued[0]!;
    assertEquals(outbound.kind, "topology-overrides-update");
    if (outbound.kind === "topology-overrides-update") {
      assertEquals(outbound.overrides.cpuTemperature, {
        chip: "coretemp",
        label: "Package id 0",
      });
      assertEquals(outbound.overrides.hostingPath, "/mnt/hosting");
      assertEquals(outbound.overrides.generation, 1);
    }
  }, registry);
});

it("PUT /servers/:id/metrics/hardware-profile sets and clears cpu overrides without a daemon round trip or a generation bump", async () => {
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    // No markServerConnected: cpu overrides carry no identity to validate,
    // so this must succeed against an offline daemon.
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          cpuTdpWattsOverride: 250,
          cpuTjMaxCelsiusOverride: 95,
        }),
      },
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      ok?: boolean;
      profile?: Record<string, unknown>;
    };
    assertEquals(body.ok, true);
    assertEquals(body.profile?.cpuTdpWattsOverride, 250);
    assertEquals(body.profile?.cpuTjMaxCelsiusOverride, 95);
    assertEquals(body.profile?.generation, undefined);

    const rows = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1);
    const metadata = rows[0]!.metadata as {
      hardwareProfile?: Record<string, unknown>;
    };
    assertEquals(metadata.hardwareProfile?.cpuTdpWattsOverride, 250);

    const clearRes = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cpuTdpWattsOverride: null }),
      },
    );
    assertEquals(clearRes.status, 200);
    const clearBody = (await clearRes.json()) as {
      profile?: Record<string, unknown>;
    };
    assertEquals(clearBody.profile?.cpuTdpWattsOverride, undefined);
    assertEquals(clearBody.profile?.cpuTjMaxCelsiusOverride, 95);
  });
});

it("PUT /servers/:id/metrics/hardware-profile rejects an out-of-range cpu override", async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cpuTdpWattsOverride: -5 }),
      },
    );
    assertEquals(res.status, 400);
  });
});

it("PUT /servers/:id/metrics/hardware-profile bumps generation only when an identity actually changes", async () => {
  const registry = createHardwareProfileRegistry();
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await markServerConnected(db, serverId);

    async function putProfile(payload: unknown) {
      const res = await app.request(
        `/servers/${serverId}/metrics/hardware-profile`,
        {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      assertEquals(res.status, 200);
      return (await res.json()) as { profile?: { generation?: number } };
    }

    // First assignment: generation 0 -> 1.
    const first = await putProfile({
      cpuTemperature: { chip: "coretemp", label: "Package id 0" },
    });
    assertEquals(first.profile?.generation, 1);

    // hostingPath / drivetempEnabled carry no sensor identity — no bump.
    const hostingOnly = await putProfile({
      hostingPath: "/mnt/hosting",
      drivetempEnabled: true,
    });
    assertEquals(hostingOnly.profile?.generation, 1);

    // Re-asserting the identical identity is idempotent — no bump.
    const idempotent = await putProfile({
      cpuTemperature: { chip: "coretemp", label: "Package id 0" },
    });
    assertEquals(idempotent.profile?.generation, 1);

    // A NIC binding is also identity-bearing — bumps.
    const nicChange = await putProfile({ nic1: "eth0" });
    assertEquals(nicChange.profile?.generation, 2);
  }, registry);
});

it("PUT /servers/:id/metrics/hardware-profile persists an explicit unassigned disk-temp slot distinct from unset", async () => {
  const registry = createHardwareProfileRegistry();
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    // Explicitly unassigning a slot that was never configured is itself an
    // identity change (auto-detect -> confirmed absent) and needs no
    // capability round trip since nothing is being pinned.
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ disk1Temperature: null }),
      },
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      profile?: { disk1Temperature?: unknown; generation?: number };
    };
    assertEquals(body.profile?.disk1Temperature, null);
    assertEquals(body.profile?.generation, 1);

    const rows = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1);
    const metadata = rows[0]!.metadata as {
      hardwareProfile?: { disk1Temperature?: unknown };
    };
    // `null` round-trips distinctly from the key being absent entirely.
    assertEquals("disk1Temperature" in (metadata.hardwareProfile ?? {}), true);
    assertEquals(metadata.hardwareProfile?.disk1Temperature, null);

    // Re-clearing the same slot is idempotent — no further generation bump.
    const again = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ disk1Temperature: null }),
      },
    );
    const againBody = (await again.json()) as {
      profile?: { generation?: number };
    };
    assertEquals(againBody.profile?.generation, 1);
  }, registry);
});

it("PUT /servers/:id/metrics/hardware-profile rejects a topology-id pin not present in the recorded topology, without needing the daemon online", async () => {
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    // No markServerConnected — topology-id validation never requires a live round trip.
    await recordTopologyGeneration(db, serverId, {
      generation: 0,
      bootGeneration: 0,
      snapshot: {
        networks: [
          { deviceId: "mac:aa:bb:cc:dd:ee:ff", kind: "uplink" },
          { deviceId: "mac:port", kind: "member" },
        ],
        filesystems: [{ filesystemId: "fs:dev:/dev/sda1" }],
      },
      appliedAt: new Date().toISOString(),
    });

    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ nicSlotDeviceIds: ["mac:not-recorded"] }),
      },
    );
    assertEquals(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assertEquals(body.error?.includes("nicSlotDeviceIds"), true);

    // A recorded device that is not an uplink (a bond/bridge member) is
    // rejected the same way — only physical uplinks can be monitored.
    const member = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          nicSlotDeviceIds: ["mac:aa:bb:cc:dd:ee:ff", "mac:port"],
        }),
      },
    );
    assertEquals(member.status, 400);
    const memberBody = (await member.json()) as { error?: string };
    assertEquals(memberBody.error?.includes("nicSlotDeviceIds"), true);
  });
});

it("PUT /servers/:id/metrics/hardware-profile persists a topology-id pin that matches the recorded topology, without needing the daemon online", async () => {
  await withMetricsFixtures(async ({ app, db, serverId, cookie }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 0,
      bootGeneration: 0,
      snapshot: {
        networks: [{ deviceId: "mac:aa:bb:cc:dd:ee:ff", kind: "uplink" }],
        filesystems: [{ filesystemId: "fs:dev:/dev/sda1" }],
      },
      appliedAt: new Date().toISOString(),
    });

    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          nicSlotDeviceIds: ["mac:aa:bb:cc:dd:ee:ff"],
          hostingFilesystemId: "fs:dev:/dev/sda1",
        }),
      },
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      ok?: boolean;
      profile?: Record<string, unknown>;
    };
    assertEquals(body.ok, true);
    assertEquals(body.profile?.nicSlotDeviceIds, ["mac:aa:bb:cc:dd:ee:ff"]);
    assertEquals(body.profile?.hostingFilesystemId, "fs:dev:/dev/sda1");

    const rows = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1);
    const metadata = rows[0]!.metadata as {
      hardwareProfile?: Record<string, unknown>;
    };
    assertEquals(metadata.hardwareProfile?.nicSlotDeviceIds, [
      "mac:aa:bb:cc:dd:ee:ff",
    ]);
  });
});

it("PUT /servers/:id/metrics/hardware-profile persists a sensor identity while the daemon is offline (no round trip required)", async () => {
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    // No markServerConnected — sensor identity assignment no longer needs
    // a live capability round trip, so this must succeed even offline.
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          cpuTemperature: { chip: "coretemp", label: "Package id 0" },
        }),
      },
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      ok?: boolean;
      profile?: Record<string, unknown>;
    };
    assertEquals(body.ok, true);
    assertEquals(body.profile?.cpuTemperature, {
      chip: "coretemp",
      label: "Package id 0",
    });
  });
});

it("PUT /servers/:id/metrics/hardware-profile rejects a relative hostingPath without needing the daemon online", async () => {
  const registry = createHardwareProfileRegistry();
  await withMetricsFixtures(async ({ app, serverId, cookie }) => {
    // No markServerConnected — hostingPath alone needs no capability round
    // trip, so validation failure must still surface as 400, not 409/503.
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ hostingPath: "relative/path" }),
      },
    );
    assertEquals(res.status, 400);
  }, registry);
});

it("PUT /servers/:id/metrics/hardware-profile preserves concurrent daemon-projected metadata", async () => {
  if (!dbUrl) return;

  resetDenoMetricsChartCacheForTests();
  const db = createDenoDb();

  // Simulate a daemon projection (resources / docker / geo) landing between
  // the route's SELECT and UPDATE: intercept the route's update call and merge
  // projected keys into the row first. The route must patch only the
  // hardwareProfile subtree instead of writing back its stale snapshot.
  let injectConcurrentWrite: (() => Promise<void>) | undefined;
  type UpdateBuilder = {
    set: (patch: unknown) => { where: (cond: unknown) => Promise<unknown> };
  };
  const racingDb = new Proxy(db as object, {
    get(target, prop) {
      if (prop === "update") {
        return (table: unknown): UpdateBuilder => {
          const builder = (target as { update: (t: unknown) => UpdateBuilder })
            .update(table);
          return {
            set: (patch: unknown) => ({
              where: async (cond: unknown) => {
                const inject = injectConcurrentWrite;
                injectConcurrentWrite = undefined;
                await inject?.();
                return await builder.set(patch).where(cond);
              },
            }),
          };
        };
      }
      const value = (target as Record<PropertyKey, unknown>)[prop];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as typeof db;

  const registry = createHardwareProfileRegistry();
  const { app, secrets } = await createMetricsRoutesTestApp(
    racingDb,
    "deno",
    registry,
  );

  const email = `metrics-overrides-race-${crypto.randomUUID()}@example.com`;
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: "Metrics Overrides Race Org" })
    .returning({ id: organization.id });
  const organizationId = insertedOrg!.id;

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: "user" })
    .returning({ id: user.id });
  const userId = insertedUser!.id;

  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });

  const [insertedServer] = await db
    .insert(server)
    .values({ organizationId, name: "Overrides Race Server" })
    .returning({ id: server.id });
  const serverId = insertedServer!.id;

  const cookie = await sessionCookie(db, secrets, userId);

  const projected = {
    resources: { memory: { totalBytes: 1024 } },
    docker: { version: "28.3.3" },
    geo: { city: "Amsterdam" },
  };

  try {
    injectConcurrentWrite = async () => {
      await db
        .update(server)
        .set({
          metadata: sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
            JSON.stringify(
              projected,
            )
          }::jsonb`,
        })
        .where(eq(server.id, serverId));
    };

    // hostingPath carries no sensor identity, so this exercises the
    // concurrency guard without needing a connected daemon / capability
    // round trip.
    const res = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ hostingPath: "/mnt/hosting" }),
      },
    );
    assertEquals(res.status, 200);

    const rows = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1);
    const metadata = rows[0]!.metadata as {
      resources?: { memory?: { totalBytes?: number } };
      docker?: { version?: string };
      geo?: { city?: string };
      hardwareProfile?: { hostingPath?: string };
    };
    assertEquals(metadata.resources?.memory?.totalBytes, 1024);
    assertEquals(metadata.docker?.version, "28.3.3");
    assertEquals(metadata.geo?.city, "Amsterdam");
    assertEquals(metadata.hardwareProfile?.hostingPath, "/mnt/hosting");

    // Clearing the last field drops only the hardwareProfile key.
    const clearRes = await app.request(
      `/servers/${serverId}/metrics/hardware-profile`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ hostingPath: null }),
      },
    );
    assertEquals(clearRes.status, 200);
    const clearedRows = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1);
    const clearedMetadata = clearedRows[0]!.metadata as {
      resources?: { memory?: { totalBytes?: number } };
      hardwareProfile?: Record<string, unknown>;
    };
    assertEquals(clearedMetadata.resources?.memory?.totalBytes, 1024);
    assertEquals(clearedMetadata.hardwareProfile, undefined);
  } finally {
    await db.delete(server).where(eq(server.id, serverId));
    await db.delete(grant).where(
      and(eq(grant.actorId, userId), eq(grant.entityId, organizationId)),
    );
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
});
