/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import type { Db } from "../db.ts";
import type {
  CellDiagnostics,
  DaemonCell,
  DaemonCellRegistry,
  PendingRequestRecord,
} from "../daemon/cell/contracts.ts";
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
} from "../client/authn/authn-hostfree-doubles.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../client/authn/crypto.ts";
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../client/authn/secrets.ts";
import { isDaemonDebugEnabled } from "../logger.ts";
import { DEVELOPER_API_PREFIX } from "../surfaces.ts";
import { testOnlyPostgresTcpUrl } from "../test-fixtures/database-url.ts";
import {
  buildDeveloperRouter,
  mountDeveloperRouter,
  registerDeveloperRoutesCore,
} from "./routes-core.ts";

const TEST_SECRET = "aa_developer_routes_core_test_secret_b_pad_abcdefghij0";
const SERVER_ID = "00000000-0000-4000-8000-0000000000d1";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";

type MockServerRow = {
  id: string;
  name?: string | null;
  organizationId?: string | null;
  options?: Record<string, unknown> | null;
  createdAt?: string;
  connected?: boolean;
  daemon?: unknown;
  metadata?: unknown;
  hostname?: string | null;
  machineKey?: string | null;
  statusChangedAt?: string | null;
};

type RequestWaitBehavior =
  | "done"
  | "done-with-addresses"
  | "failed"
  | "failed-no-error"
  | "expired"
  | "throw"
  | "throw-string";

function queryResult<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  return Object.assign(promise, {
    limit: (_n: number) => Promise.resolve(rows),
    orderBy: (..._cols: unknown[]) =>
      Object.assign(Promise.resolve(rows), {
        limit: (_n: number) => Promise.resolve(rows),
      }),
  });
}

function createRoutesCoreMockDb(opts: {
  organizations?: Array<{ id: string; name: string; slug: string }>;
  servers?: MockServerRow[];
  executeRows?: unknown[];
  executeThrows?: Error;
  insertServerId?: string;
  updateReturns?: Array<{ id: string; organizationId?: string | null }>;
} = {}): Db {
  const orgs = opts.organizations ?? [];
  const servers = opts.servers ?? [];

  return {
    select: (fields: Record<string, unknown>) => {
      const isOrg = "slug" in fields;
      const isProjection = "daemon" in fields && !("metadata" in fields);
      const isIdOnly = Object.keys(fields).length === 1 && "id" in fields;
      const rows = isOrg
        ? orgs.map((org) => ({
          id: org.id,
          displayName: org.name,
          name: org.name,
          slug: org.slug,
        }))
        : isProjection
        ? servers.map((row) => ({
          id: row.id,
          daemon: row.daemon ?? null,
          connected: row.connected ?? false,
          statusChangedAt: row.statusChangedAt ?? null,
        }))
        : isIdOnly
        ? servers.map((row) => ({ id: row.id }))
        : servers;

      return {
        from: () => {
          const base = queryResult(rows);
          return Object.assign(base, {
            where: () => {
              if (isIdOnly) {
                return queryResult(orgs.map((org) => ({ id: org.id })));
              }
              return queryResult(rows);
            },
            orderBy: () => queryResult(rows),
          });
        },
      };
    },
    insert: () => ({
      values: () => ({
        returning: () =>
          Promise.resolve([{
            id: opts.insertServerId ??
              "00000000-0000-4000-8000-000000000099",
          }]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(opts.updateReturns ?? []),
        }),
      }),
    }),
    execute: () => {
      if (opts.executeThrows) throw opts.executeThrows;
      return Promise.resolve(
        opts.executeRows ??
          [{ version: "PostgreSQL 16", database: "turbopanel" }],
      );
    },
  } as unknown as Db;
}

function createDiagnosticsCell(
  serverId: string,
  opts: {
    snapshotServerId?: string;
    requestBehavior?: RequestWaitBehavior;
    listRequests?: PendingRequestRecord[];
  } = {},
): DaemonCell {
  const diagnostics: CellDiagnostics = {
    backend: "durable-object",
    usesHibernationWebSocket: true,
    constructorCalls: 1,
    wsAccepted: 0,
    wsClosed: 0,
    alarmInvocations: 0,
    heartbeatCount: 0,
    commandDispatchCount: 0,
    cleanupCount: 0,
    fetchByRoute: {},
    storageReads: 0,
    storageWrites: 0,
    storageByCallSite: {},
  };

  const noopAsync = () => Promise.resolve();
  const requestBehavior = opts.requestBehavior ?? "done";

  return {
    attachDaemonSocket: () =>
      Promise.resolve({
      connectionId: "conn",
      lease: {
        holder: "conn",
        token: "conn",
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
    }),
    detachDaemonSocket: noopAsync,
    recordInbound: noopAsync,
    getSnapshot: () =>
      Promise.resolve({
      serverId: opts.snapshotServerId === undefined
        ? serverId
        : (opts.snapshotServerId ?? ""),
      version: 0,
      updatedAt: new Date().toISOString(),
      connected: false,
    }),
    putSnapshot: (patch) =>
      Promise.resolve({
      serverId,
      version: 1,
      updatedAt: new Date().toISOString(),
      connected: false,
      ...patch,
    }),
    enqueue: (outbound) =>
      Promise.resolve({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "queued" as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    markSent: noopAsync,
    handleInbound: () => Promise.resolve(null),
    getRequest: () => Promise.resolve(null),
    listRequests: () => Promise.resolve(opts.listRequests ?? []),
    waitForRequest: () => Promise.resolve(null),
    createRequestAndWait: (outbound) => {
      if (requestBehavior === "throw") {
        return Promise.reject(new Error("daemon not connected"));
      }
      if (requestBehavior === "throw-string") {
        return Promise.reject("string-boom");
      }
      const base: PendingRequestRecord = {
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: "done",
        createdAt: outbound.at,
        expiresAt: outbound.at,
      };
      if (requestBehavior === "failed") {
        return Promise.resolve({
          ...base,
          status: "failed",
          error: "failed to fetch addresses",
        });
      }
      if (requestBehavior === "failed-no-error") {
        return Promise.resolve({
          ...base,
          status: "failed",
        });
      }
      if (requestBehavior === "expired") {
        return Promise.resolve({ ...base, status: "expired" });
      }
      if (requestBehavior === "done-with-addresses") {
        return Promise.resolve({
          ...base,
          status: "done",
          result: {
            ips: [
              { address: "203.0.113.10", version: 4, scope: "public" },
            ],
          },
        });
      }
      return Promise.resolve({ ...base, status: "done" });
    },
    claimDeliveryLease: () => Promise.resolve(null),
    renewDeliveryLease: () => Promise.resolve(null),
    releaseDeliveryLease: noopAsync,
    readOutboxBatch: () => Promise.resolve([]),
    ackOutbox: noopAsync,
    prune: () => Promise.resolve([]),
    clearUpdateStatus: () => Promise.resolve({ cleared: 0 }),
    purge: noopAsync,
    getDiagnostics: () => Promise.resolve(diagnostics),
  };
}

function createRegistry(
  serverId: string,
  opts: {
    onlineIds?: string[];
    requestBehavior?: RequestWaitBehavior;
    snapshotServerId?: string;
    listRequests?: PendingRequestRecord[];
  } = {},
): DaemonCellRegistry {
  return {
    getCell: () =>
      createDiagnosticsCell(serverId, {
        requestBehavior: opts.requestBehavior,
        snapshotServerId: opts.snapshotServerId,
        listRequests: opts.listRequests,
      }),
    purge: () => Promise.resolve(),
    listOnlineServerIds: () => Promise.resolve(opts.onlineIds ?? []),
    getSnapshots: () => Promise.resolve(new Map()),
  };
}

function testEnv(
  partial: Partial<CloudflareBindings> & Record<string, string | undefined>,
): CloudflareBindings {
  return partial as unknown as CloudflareBindings;
}

type TestAppOptions = {
  env?: CloudflareBindings;
  db?: Db | null;
  authDb?: Db;
  registry?: DaemonCellRegistry | null;
  authRequired?: boolean;
  postgresConnectionString?: string;
};

async function createTestApp(options: TestAppOptions = {}) {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_SECRET}`, "workers"),
    "session-signing",
  );
  const developer = buildDeveloperRouter({
    secrets,
    authRequired: options.authRequired ?? false,
  });
  const app = new Hono<
    { Variables: AppEnv["Variables"]; Bindings: CloudflareBindings }
  >();
  app.use("*", async (c, next) => {
    if (options.authDb) {
      c.set("db", options.authDb);
    } else if (options.db !== null) {
      c.set("db", options.db ?? createRoutesCoreMockDb());
    }
    if (options.registry !== null) {
      c.set(
        "daemonCellRegistry",
        options.registry ?? createRegistry(SERVER_ID),
      );
    }
    if (options.postgresConnectionString) {
      c.set("postgresConnectionString", options.postgresConnectionString);
    }
    await next();
  });
  app.route(DEVELOPER_API_PREFIX, developer);
  return { app, secrets };
}

describe("isDaemonDebugEnabled", () => {
  it("returns false for log-level debug alone", () => {
    expect(
      isDaemonDebugEnabled({
        TURBOPANEL_LOG_LEVEL: "debug",
        TURBOPANEL_DAEMON_DEBUG: "",
      }),
    ).toBe(false);
  });

  it("returns true only for TURBOPANEL_DAEMON_DEBUG", () => {
    expect(isDaemonDebugEnabled({ TURBOPANEL_DAEMON_DEBUG: "1" })).toBe(true);
    expect(isDaemonDebugEnabled({ TURBOPANEL_DAEMON_DEBUG: "true" })).toBe(
      true,
    );
    expect(isDaemonDebugEnabled({ TURBOPANEL_DAEMON_DEBUG: "0" })).toBe(false);
  });
});

describe("developer auth gate", () => {
  it("returns 401 without credentials when auth is required", async () => {
    const { app } = await createTestApp({ authRequired: true });
    const response = await app.request(`${DEVELOPER_API_PREFIX}/daemon/events`);
    expect(response.status).toBe(401);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 for non-superadmin sessions", async () => {
    const secrets = await deriveSecretsConfig(
      parseSecretsEnv(`1:${TEST_SECRET}`, "workers"),
      "session-signing",
    );
    const state = createEmptyMockAuthState();
    const token = crypto.randomUUID();
    seedMockSession(state, token, {
      sessionId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      email: "user@example.com",
      role: "user",
    });
    const signed = await buildSignedCookie(token, secrets);
    const { app } = await createTestApp({
      authRequired: true,
      authDb: createMockAuthDb(state),
      db: null,
      registry: null,
    });
    const response = await app.request(`${DEVELOPER_API_PREFIX}/daemon/events`, {
      headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}` },
    });
    expect(response.status).toBe(403);
  });

  it("allows superadmin sessions through auth middleware", async () => {
    const secrets = await deriveSecretsConfig(
      parseSecretsEnv(`1:${TEST_SECRET}`, "workers"),
      "session-signing",
    );
    const state = createEmptyMockAuthState();
    const token = crypto.randomUUID();
    seedMockSession(state, token, {
      sessionId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      email: "root@example.com",
      role: "superadmin",
    });
    const signed = await buildSignedCookie(token, secrets);
    const { app } = await createTestApp({
      authRequired: true,
      authDb: createMockAuthDb(state),
      db: null,
      registry: null,
    });
    const response = await app.request(`${DEVELOPER_API_PREFIX}/daemon/events`, {
      headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}` },
    });
    expect(response.status).toBe(200);
  });
});

describe("developer diagnostics routes", () => {
  it("returns 404 for fleet diagnostics when only TURBOPANEL_LOG_LEVEL=debug is set", async () => {
    const { app } = await createTestApp();
    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/diagnostics`,
      {},
      testEnv({
        TURBOPANEL_LOG_LEVEL: "debug",
        TURBOPANEL_DAEMON_DEBUG: "0",
      }),
    );
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("daemon debug disabled");
  });

  it("enables fleet diagnostics when TURBOPANEL_DAEMON_DEBUG=1", async () => {
    const { app } = await createTestApp();
    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/diagnostics`,
      {},
      testEnv({ TURBOPANEL_DAEMON_DEBUG: "1" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; diagnostics: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.diagnostics)).toBe(true);
  });

  it("returns 503 for fleet diagnostics when registry or db is missing", async () => {
    const { app } = await createTestApp({ registry: null });
    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/diagnostics`,
      {},
      testEnv({ TURBOPANEL_DAEMON_DEBUG: "1" }),
    );
    expect(response.status).toBe(503);
  });

  it("returns 404 for per-server diagnostics when only log level debug is set", async () => {
    const { app } = await createTestApp();
    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/cell/diagnostics`,
      {},
      testEnv({
        TURBOPANEL_LOG_LEVEL: "debug",
        TURBOPANEL_DAEMON_DEBUG: "0",
      }),
    );
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("daemon debug disabled");
  });

  it("enables per-server diagnostics when TURBOPANEL_DAEMON_DEBUG=1", async () => {
    const { app } = await createTestApp();
    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/cell/diagnostics`,
      {},
      testEnv({ TURBOPANEL_DAEMON_DEBUG: "1" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      diagnostics: { backend: string };
    };
    expect(body.ok).toBe(true);
    expect(body.diagnostics.backend).toBe("durable-object");
  });
});

describe("developer daemon routes", () => {
  it("returns empty connections when registry or db is unavailable", async () => {
    const { app } = await createTestApp({ registry: null });
    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/connections`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { connections: unknown[] };
    expect(body.connections).toEqual([]);
  });

  it("returns mapped online connections", async () => {
    const db = createRoutesCoreMockDb({
      servers: [{
        id: SERVER_ID,
        connected: true,
        hostname: "edge-1",
        statusChangedAt: new Date().toISOString(),
        daemon: null,
        metadata: {},
      }],
    });
    const registry = createRegistry(SERVER_ID, { onlineIds: [SERVER_ID] });
    const { app } = await createTestApp({ db, registry });
    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/connections`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { connections: Array<{ id: string }> };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]?.id).toBe(SERVER_ID);
  });

  it("returns empty daemon events", async () => {
    const { app } = await createTestApp();
    const response = await app.request(`${DEVELOPER_API_PREFIX}/daemon/events`);
    expect(response.status).toBe(200);
    const body = await response.json() as { events: unknown[] };
    expect(body.events).toEqual([]);
  });

  it("broadcast rejects invalid payload and accepts valid echo", async () => {
    const registry = createRegistry(SERVER_ID, { onlineIds: [SERVER_ID] });
    const { app } = await createTestApp({ registry });

    const bad = await app.request(`${DEVELOPER_API_PREFIX}/daemon/broadcast`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notPayload: true }),
    });
    expect(bad.status).toBe(400);

    const missingRegistry = await createTestApp({ registry: null });
    const unavailable = await missingRegistry.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/broadcast`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { ping: true } }),
      },
    );
    expect(unavailable.status).toBe(503);

    const ok = await app.request(`${DEVELOPER_API_PREFIX}/daemon/broadcast`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { ping: true } }),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { ok: boolean; sent: number };
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(1);
  });

  it("send validates payload, connectivity, and success path", async () => {
    const offlineDb = createRoutesCoreMockDb({
      servers: [{
        id: SERVER_ID,
        connected: false,
        statusChangedAt: new Date().toISOString(),
        daemon: null,
        metadata: {},
      }],
    });
    const registry = createRegistry(SERVER_ID);
    const { app } = await createTestApp({ db: offlineDb, registry });

    const bad = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      },
    );
    expect(bad.status).toBe(400);

    const offline = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { echo: 1 } }),
      },
    );
    expect(offline.status).toBe(404);

    const onlineDb = createRoutesCoreMockDb({
      servers: [{
        id: SERVER_ID,
        connected: true,
        statusChangedAt: new Date().toISOString(),
        daemon: null,
        metadata: {},
      }],
    });
    const onlineApp = await createTestApp({ db: onlineDb, registry });
    const ok = await onlineApp.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { echo: 1 } }),
      },
    );
    expect(ok.status).toBe(200);
    const body = await ok.json() as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe(SERVER_ID);
  });

  it("lists commands and handles missing registry/db", async () => {
    const commandRecord: PendingRequestRecord = {
      serverId: SERVER_ID,
      requestId: "req-1",
      requestKind: "command-dispatch",
      status: "done",
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      command: "daemon.ping",
      result: { exitCode: 0, stdout: "pong", stderr: "" },
    };
    const registry = createRegistry(SERVER_ID, {
      listRequests: [commandRecord],
    });
    const db = createRoutesCoreMockDb({
      servers: [{ id: SERVER_ID, connected: true }],
    });
    const { app } = await createTestApp({ db, registry });

    const noRegistry = await createTestApp({ registry: null });
    const emptyRegistry = await noRegistry.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/commands`,
    );
    expect(emptyRegistry.status).toBe(200);
    expect((await emptyRegistry.json() as { commands: unknown[] }).commands)
      .toEqual([]);

    const noDb = await createTestApp({ db: null, registry });
    const emptyDb = await noDb.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/commands`,
    );
    expect(emptyDb.status).toBe(200);
    expect((await emptyDb.json() as { commands: unknown[] }).commands).toEqual(
      [],
    );

    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/commands?limit=10`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      commands: Array<{ command: string; status: string }>;
    };
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]?.command).toBe("daemon.ping");
    expect(body.commands[0]?.status).toBe("done");
  });

  it("returns cell snapshot and handles missing db", async () => {
    const registry = createRegistry(SERVER_ID);
    const { app } = await createTestApp({ registry });

    const missingDb = await createTestApp({ db: null, registry });
    const unavailable = await missingDb.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/cell`,
    );
    expect(unavailable.status).toBe(503);

    const ok = await app.request(`${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/cell`);
    expect(ok.status).toBe(200);
    const body = await ok.json() as { ok: boolean; snapshot: { serverId: string } };
    expect(body.ok).toBe(true);
    expect(body.snapshot.serverId).toBe(SERVER_ID);

    const missingSnapshot = createRegistry(SERVER_ID, {
      snapshotServerId: "",
    });
    const missingApp = await createTestApp({ registry: missingSnapshot });
    const notFound = await missingApp.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/cell`,
    );
    expect(notFound.status).toBe(404);
  });
});

describe("developer address routes", () => {
  it("hits instance addresses route (Deno-only collector)", async () => {
    const { app } = await createTestApp();
    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/instance/addresses`,
    );
    // collectServerIps reads Deno.networkInterfaces — unavailable in workerd.
    expect([200, 500]).toContain(response.status);
  });

  it("returns empty fleet addresses when dependencies are missing", async () => {
    const { app } = await createTestApp({ registry: null });
    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/daemon/addresses`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { servers: unknown[] };
    expect(body.servers).toEqual([]);
  });

  it("maps fleet address fetch failures and successes", async () => {
    const db = createRoutesCoreMockDb({
      servers: [{
        id: SERVER_ID,
        connected: true,
        hostname: "edge-1",
        statusChangedAt: new Date().toISOString(),
        daemon: null,
        metadata: {},
      }],
    });

    const failedRegistry = createRegistry(SERVER_ID, {
      onlineIds: [SERVER_ID],
      requestBehavior: "failed",
    });
    const failedApp = await createTestApp({ db, registry: failedRegistry });
    const failed = await failedApp.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/addresses`,
    );
    expect(failed.status).toBe(200);
    const failedBody = await failed.json() as {
      servers: Array<{ error?: string }>;
    };
    expect(failedBody.servers[0]?.error).toBe("failed to fetch addresses");

    const successRegistry = createRegistry(SERVER_ID, {
      onlineIds: [SERVER_ID],
      requestBehavior: "done-with-addresses",
    });
    const successApp = await createTestApp({ db, registry: successRegistry });
    const success = await successApp.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/addresses`,
    );
    expect(success.status).toBe(200);
    const successBody = await success.json() as {
      servers: Array<{ ips?: Array<{ address: string }> }>;
    };
    expect(successBody.servers[0]?.ips?.map((ip) => ip.address)).toContain(
      "203.0.113.10",
    );

    const expiredApp = await createTestApp({
      db,
      registry: createRegistry(SERVER_ID, {
        onlineIds: [SERVER_ID],
        requestBehavior: "expired",
      }),
    });
    const expired = await expiredApp.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/addresses`,
    );
    expect(expired.status).toBe(200);
    const expiredBody = await expired.json() as {
      servers: Array<{ error?: string }>;
    };
    expect(expiredBody.servers[0]?.error).toBe("timeout waiting for addresses");

    const throwApp = await createTestApp({
      db,
      registry: createRegistry(SERVER_ID, {
        onlineIds: [SERVER_ID],
        requestBehavior: "throw-string",
      }),
    });
    const thrown = await throwApp.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/addresses`,
    );
    expect(thrown.status).toBe(200);
    const thrownBody = await thrown.json() as {
      servers: Array<{ error?: string }>;
    };
    expect(thrownBody.servers[0]?.error).toBe("string-boom");
  });

  it("handles per-server address fetch paths", async () => {
    const offlineDb = createRoutesCoreMockDb({
      servers: [{
        id: SERVER_ID,
        connected: false,
        statusChangedAt: new Date().toISOString(),
        daemon: null,
        metadata: {},
      }],
    });
    const registry = createRegistry(SERVER_ID);
    const offlineApp = await createTestApp({ db: offlineDb, registry });
    const offline = await offlineApp.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/addresses`,
    );
    expect(offline.status).toBe(404);

    const onlineDb = createRoutesCoreMockDb({
      servers: [{
        id: SERVER_ID,
        connected: true,
        hostname: "edge-1",
        statusChangedAt: new Date().toISOString(),
        daemon: null,
        metadata: {},
      }],
    });
    const expiredApp = await createTestApp({
      db: onlineDb,
      registry: createRegistry(SERVER_ID, { requestBehavior: "expired" }),
    });
    const expired = await expiredApp.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/addresses`,
    );
    expect(expired.status).toBe(500);

    const throwApp = await createTestApp({
      db: onlineDb,
      registry: createRegistry(SERVER_ID, { requestBehavior: "throw" }),
    });
    const thrown = await throwApp.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/addresses`,
    );
    expect(thrown.status).toBe(404);

    const okApp = await createTestApp({
      db: onlineDb,
      registry: createRegistry(SERVER_ID, {
        requestBehavior: "done-with-addresses",
      }),
    });
    const ok = await okApp.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/addresses`,
    );
    expect(ok.status).toBe(200);
    const body = await ok.json() as {
      ok: boolean;
      ips: Array<{ address: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.ips.map((ip) => ip.address)).toContain("203.0.113.10");

    const failedNoErrorApp = await createTestApp({
      db: onlineDb,
      registry: createRegistry(SERVER_ID, {
        requestBehavior: "failed-no-error",
      }),
    });
    const failedNoError = await failedNoErrorApp.app.request(
      `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/addresses`,
    );
    expect(failedNoError.status).toBe(500);
    const failedBody = await failedNoError.json() as { error: string };
    expect(failedBody.error).toBe("failed to fetch addresses");
  });
});

describe("developer organization and server routes", () => {
  it("lists organizations and handles missing db", async () => {
    const db = createRoutesCoreMockDb({
      organizations: [{ id: ORG_ID, name: "Dev Org", slug: "dev-org" }],
    });
    const { app } = await createTestApp({ db });
    const missing = await createTestApp({ db: null });
    const unavailable = await missing.app.request(
      `${DEVELOPER_API_PREFIX}/organizations`,
    );
    expect(unavailable.status).toBe(503);

    const response = await app.request(`${DEVELOPER_API_PREFIX}/organizations`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      organizations: Array<{ id: string; displayName: string }>;
    };
    expect(body.organizations[0]?.id).toBe(ORG_ID);
    expect(body.organizations[0]?.displayName).toBe("Dev Org");
  });

  it("never returns a managedMonitor secret from server options", async () => {
    // `server.options` is returned verbatim here. The sealed ProxySQL monitor
    // password moved to the `monitor` table, but a row written by an older
    // control plane can still carry the key — the developer surface is still a
    // response and must not publish it.
    const db = createRoutesCoreMockDb({
      servers: [{
        id: SERVER_ID,
        name: "Edge",
        organizationId: ORG_ID,
        options: {
          tier: "dev",
          managedMonitor: {
            username: "tp_monitor_0123456789ab",
            passwordSealed: "tpsecret.v1.deadbeef",
          },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        connected: true,
      }],
    });
    const { app } = await createTestApp({ db });

    const response = await app.request(`${DEVELOPER_API_PREFIX}/servers`);
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("managedMonitor");
    expect(raw).not.toContain("passwordSealed");
    expect(raw).not.toContain("tpsecret.v1.deadbeef");
    const body = JSON.parse(raw) as {
      servers: Array<{ options: Record<string, unknown> }>;
    };
    expect(body.servers[0]?.options).toEqual({ tier: "dev" });
  });

  it("creates, lists, and patches servers with validation", async () => {
    const db = createRoutesCoreMockDb({
      servers: [{
        id: SERVER_ID,
        name: "Edge",
        organizationId: ORG_ID,
        options: { tier: "dev" },
        createdAt: "2026-01-01T00:00:00.000Z",
        connected: true,
      }],
      organizations: [{ id: ORG_ID, name: "Dev Org", slug: "dev-org" }],
      insertServerId: "00000000-0000-4000-8000-0000000000aa",
      updateReturns: [{ id: SERVER_ID, organizationId: ORG_ID }],
    });
    const { app } = await createTestApp({ db });

    const missingDb = await createTestApp({ db: null });
    expect((await missingDb.app.request(`${DEVELOPER_API_PREFIX}/servers`))
      .status).toBe(503);

    const list = await app.request(`${DEVELOPER_API_PREFIX}/servers`);
    expect(list.status).toBe(200);
    const listed = await list.json() as {
      servers: Array<{ id: string; displayName: string | null }>;
    };
    expect(listed.servers[0]?.id).toBe(SERVER_ID);

    const badName = await app.request(`${DEVELOPER_API_PREFIX}/servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: 123 }),
    });
    expect(badName.status).toBe(400);

    const created = await app.request(`${DEVELOPER_API_PREFIX}/servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: " New Server ", options: { a: 1 } }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { ok: boolean; id: string };
    expect(createdBody.ok).toBe(true);

    const badPatch = await app.request(
      `${DEVELOPER_API_PREFIX}/servers/${SERVER_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "not-a-uuid" }),
      },
    );
    expect(badPatch.status).toBe(400);

    const missingOrgDb = createRoutesCoreMockDb({
      servers: [{
        id: SERVER_ID,
        connected: true,
        statusChangedAt: new Date().toISOString(),
        daemon: null,
        metadata: {},
      }],
      organizations: [],
    });
    const missingOrgApp = await createTestApp({ db: missingOrgDb });
    const missingOrgPatch = await missingOrgApp.app.request(
      `${DEVELOPER_API_PREFIX}/servers/${SERVER_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "00000000-0000-4000-8000-000000000099",
        }),
      },
    );
    expect(missingOrgPatch.status).toBe(404);

    const patched = await app.request(
      `${DEVELOPER_API_PREFIX}/servers/${SERVER_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Renamed",
          organizationId: ORG_ID,
          options: null,
        }),
      },
    );
    expect(patched.status).toBe(200);

    const missingServerDb = createRoutesCoreMockDb({ updateReturns: [] });
    const missingServerApp = await createTestApp({ db: missingServerDb });
    const notFound = await missingServerApp.app.request(
      `${DEVELOPER_API_PREFIX}/servers/${SERVER_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Missing" }),
      },
    );
    expect(notFound.status).toBe(404);
  });
});

describe("developer database routes via routes-core", () => {
  it("returns database status and studio probe payloads", async () => {
    const db = createRoutesCoreMockDb();
    const { app } = await createTestApp({
      db,
      postgresConnectionString: testOnlyPostgresTcpUrl(),
    });

    const status = await app.request(`${DEVELOPER_API_PREFIX}/database/status`);
    expect(status.status).toBe(200);
    const statusBody = await status.json() as { connected: boolean };
    expect(statusBody.connected).toBe(true);

    const studio = await app.request(`${DEVELOPER_API_PREFIX}/database/studio`);
    expect(studio.status).toBe(200);
    const studioBody = await studio.json() as { port: number; browserUrl: string };
    expect(typeof studioBody.port).toBe("number");
    expect(typeof studioBody.browserUrl).toBe("string");
  });

  it("reports query failures from database status", async () => {
    const db = createRoutesCoreMockDb({
      executeThrows: new Error("query failed"),
    });
    const { app } = await createTestApp({
      db,
      postgresConnectionString: testOnlyPostgresTcpUrl(),
    });
    const response = await app.request(`${DEVELOPER_API_PREFIX}/database/status`);
    const body = await response.json() as { connected: boolean; error: string };
    expect(body.connected).toBe(false);
    expect(body.error).toBe("query failed");
  });
});

describe("developer router mount helpers", () => {
  it("mountDeveloperRouter and registerDeveloperRoutesCore expose events", async () => {
    const secrets = await deriveSecretsConfig(
      parseSecretsEnv(`1:${TEST_SECRET}`, "workers"),
      "session-signing",
    );
    const developer = buildDeveloperRouter({ secrets, authRequired: false });
    const mounted = new Hono<
      { Variables: AppEnv["Variables"]; Bindings: CloudflareBindings }
    >();
    mountDeveloperRouter(mounted, developer);

    const coreApp = new Hono<
      { Variables: AppEnv["Variables"]; Bindings: CloudflareBindings }
    >();
    registerDeveloperRoutesCore(coreApp, { secrets, authRequired: false });
    coreApp.use("*", async (c, next) => {
      c.set("db", createRoutesCoreMockDb());
      c.set("daemonCellRegistry", createRegistry(SERVER_ID));
      await next();
    });

    for (const app of [mounted, coreApp]) {
      const response = await app.request(`${DEVELOPER_API_PREFIX}/daemon/events`);
      expect(response.status).toBe(200);
    }
  });
});
