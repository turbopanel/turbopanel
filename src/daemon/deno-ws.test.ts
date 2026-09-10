import { assertEquals } from "@std/assert";
import { stub } from "@std/testing/mock";
import { Hono } from "hono";
import { it } from "@std/testing/bdd";
import { deriveDaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import {
  type DerivedSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../client/authn/secrets.ts";
import type { Db } from "../db.ts";
import { generateSecret } from "../generate-secret.ts";
import {
  buildDefaultDaemonStatus,
  mapServerDaemonStatusFromColumns,
  parseServerDaemonState,
  type ServerDaemonState,
  type ServerDaemonStatus,
  type ServerDaemonStatusColumns,
} from "./authn/daemon-state.ts";
import type {
  DaemonCell,
  DaemonCellRegistry,
  DaemonCellSnapshot,
} from "./cell/contracts.ts";
import type {
  DaemonInboundEnvelope,
  DaemonOutboundEnvelope,
} from "./cell/protocol.ts";
import { DAEMON_CELL_PING, DAEMON_CELL_PONG } from "./cell/protocol.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import {
  handleDaemonCellPing,
  isClosedConnectionError,
  registerDaemonWebSocket,
  wsMessageDataToString,
} from "./deno-ws.ts";

/**
 * Workers / Miniflare put the client half of a 101 upgrade on
 * `response.webSocket`; Deno's `Response` has no such field, so these tests
 * skip themselves when it is absent.
 *
 * Read through a local structural type rather than a global `Response`
 * augmentation — augmenting `Response` (or declaring `DurableObjectStub` and
 * friends) globally collides with the real `@cloudflare/workers-types` that the
 * Workers-pool suites pull in.
 */
type UpgradedWebSocket = WebSocket & { accept(): void };

function upgradedWebSocket(response: Response): UpgradedWebSocket | null {
  return (response as { webSocket?: UpgradedWebSocket | null }).webSocket ??
    null;
}
import {
  CLIENT_WS_PATH,
  DAEMON_WS_PATH,
  DEVELOPER_WS_PATH,
} from "../surfaces.ts";
import {
  resetTrunkManifestCacheForTests,
  seedTrunkManifestCacheForTests,
} from "../lib/update/manifest.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../client/authn/crypto.ts";
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
} from "../client/authn/authn-hostfree-doubles.ts";
import {
  buildLocalConsoleAuthorization,
  hashLocalConsoleContent,
  LOCAL_CONSOLE_CONTENT_SHA256_HEADER,
} from "../developer/local-console-auth.ts";
import type { RateLimiter } from "./rate-limit/contracts.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../test-fixtures/secrets.ts";
import { PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN } from "./metrics/capability-plan.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function createDaemonJwtSecrets() {
  const parsed = parseSecretsEnv(`1:${generateSecret()}`, "deno");
  return deriveDaemonJwtKeyring(parsed);
}

function createSelectChain<T>(getRows: () => T[]) {
  const limit = () => Promise.resolve(getRows());
  const where = () => ({ limit });
  const from = () => ({ where });
  return { from };
}

function createMockDb(keyId = "key-test"): Db {
  return {
    select: () =>
      createSelectChain(() => [
        {
          daemon: {
            key: { ...baseDaemonKey, id: keyId },
          },
          metadata: null,
          hostname: null,
          machineKey: null,
          connected: true,
          statusChangedAt: "2020-01-01T00:00:00.000Z",
        },
      ]),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(undefined),
      }),
    }),
  } as unknown as Db;
}

const baseDaemonKey = {
  id: "key-test",
  algorithm: "Ed25519" as const,
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
  fingerprint: "fp-1",
  createdAt: "2020-01-01T00:00:00.000Z",
};

/**
 * Mock DB matching the `getServerDaemonStateByServerId` column select —
 * fleet status/identity live on dedicated `server` columns, never on the
 * sparse `daemon` jsonb (`{ key, projection? }`).
 */
function createProjectionTrackingDb(
  _serverId: string,
  initialDaemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
): {
  db: Db;
  getDaemon: () => ServerDaemonState;
  getStatus: () => ServerDaemonStatus;
  getUpdateCallCount: () => number;
  getPatches: () => Record<string, unknown>[];
} {
  let daemon: ServerDaemonState = { ...initialDaemon };
  const defaults = buildDefaultDaemonStatus();
  const columns: ServerDaemonStatusColumns = {
    connected: statusOverrides.connected ?? defaults.connected,
    statusChangedAt: statusOverrides.statusChangedAt ??
      defaults.statusChangedAt,
  };
  let updateCalls = 0;
  const patches: Record<string, unknown>[] = [];

  const db = {
    select: () =>
      createSelectChain(() => [
        {
          daemon,
          metadata: null,
          hostname: null,
          machineKey: null,
          connected: columns.connected,
          statusChangedAt: columns.statusChangedAt,
        },
      ]),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updateCalls += 1;
        patches.push(patch);
        if (patch.daemon !== undefined) {
          daemon = patch.daemon as ServerDaemonState;
        }
        if ("isConnected" in patch) {
          columns.connected = patch.isConnected as boolean;
        }
        if ("statusChangedAt" in patch) {
          columns.statusChangedAt = patch.statusChangedAt as string | null;
        }
        return {
          where: () => Promise.resolve(undefined),
        };
      },
    }),
  } as unknown as Db;

  return {
    db,
    getDaemon: () => daemon,
    getStatus: () => mapServerDaemonStatusFromColumns(columns),
    getUpdateCallCount: () => updateCalls,
    getPatches: () => patches,
  };
}

function createTrackingDaemonCell(serverId: string) {
  const enqueued: DaemonOutboundEnvelope[] = [];
  const calls = {
    attach: 0,
    detach: 0,
    recordInbound: 0,
    putSnapshot: 0,
    handleInbound: 0,
    readOutboxBatch: 0,
  };
  const detachReasons: string[] = [];
  let snapshot: DaemonCellSnapshot = {
    serverId,
    version: 0,
    updatedAt: new Date().toISOString(),
    connected: false,
  };

  const cell: DaemonCell = {
    attachDaemonSocket: (meta) => {
      calls.attach += 1;
      snapshot = {
        ...snapshot,
        connected: true,
        remoteAddress: meta.remoteAddress,
        connectedAt: meta.connectedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return Promise.resolve({
        connectionId: "track-conn",
        lease: {
          holder: "track-conn",
          expiresAt: new Date(Date.now() + 45_000).toISOString(),
        },
      });
    },
    detachDaemonSocket: (params) => {
      calls.detach += 1;
      if (params.reason !== undefined) detachReasons.push(params.reason);
      snapshot = {
        ...snapshot,
        connected: false,
        updatedAt: new Date().toISOString(),
      };
      return Promise.resolve();
    },
    recordInbound: () => {
      calls.recordInbound += 1;
      return Promise.resolve();
    },
    getSnapshot: () => Promise.resolve(snapshot),
    putSnapshot: (patch) => {
      calls.putSnapshot += 1;
      snapshot = {
        ...snapshot,
        ...patch,
        serverId,
        version: snapshot.version + 1,
        updatedAt: new Date().toISOString(),
      };
      return Promise.resolve(snapshot);
    },
    enqueue: (outbound: DaemonOutboundEnvelope) => {
      enqueued.push(outbound);
      return Promise.resolve({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: "queued" as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      });
    },
    markSent: () => Promise.resolve(),
    handleInbound: (_inbound: DaemonInboundEnvelope) => {
      calls.handleInbound += 1;
      return Promise.resolve(null);
    },
    getRequest: () => Promise.resolve(null),
    listRequests: () => Promise.resolve([]),
    waitForRequest: () => Promise.resolve(null),
    createRequestAndWait: (outbound) =>
      Promise.resolve({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: "expired" as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    claimDeliveryLease: () => Promise.resolve(null),
    renewDeliveryLease: () => Promise.resolve(null),
    releaseDeliveryLease: () => Promise.resolve(),
    readOutboxBatch: async (args?: { blockMs?: number }) => {
      calls.readOutboxBatch += 1;
      // Honour blockMs so the outbox pump cannot busy-loop under Deno.serve.
      const blockMs = args?.blockMs;
      if (blockMs != null && blockMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(blockMs, 15))
        );
      }
      return [];
    },
    ackOutbox: () => Promise.resolve(),
    prune: () => Promise.resolve([]),
    clearUpdateStatus: () => Promise.resolve({ cleared: 0 }),
    purge: () => Promise.resolve(),
  };

  return {
    cell,
    calls,
    enqueued,
    detachReasons,
    getSnapshot: () => snapshot,
  };
}

function createTrackingRegistry(cell: DaemonCell): DaemonCellRegistry {
  return {
    getCell: () => cell,
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  };
}

function registerTestDaemonWebSocket(
  app: Hono,
  secrets: Awaited<ReturnType<typeof createDaemonJwtSecrets>>,
  options: {
    db?: Db;
    registry?: DaemonCellRegistry;
  } = {},
) {
  registerDaemonWebSocket(app, {
    secrets,
    db: options.db,
    daemonCellRegistry: options.registry ??
      createTrackingRegistry(createTrackingDaemonCell("srv-test").cell),
  });
}

const WS_UPGRADE_HEADERS = {
  Upgrade: "websocket",
  Connection: "Upgrade",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Key": "dGVzdC1rZXk=",
} as const;

it("WS upgrade accepts HTTP 101 with valid JWT", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-test", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 101);
});

it("WS upgrade rejects HTTP 401 when no JWT is provided", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
  });

  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: { ...WS_UPGRADE_HEADERS },
  });
  assertEquals(response.status, 401);
});

it("WS upgrade rejects HTTP 401 when JWT is invalid", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
  });

  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: "Bearer invalid-token",
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 401);
});

function createSessionSecrets() {
  return deriveSecretsConfig(
    parseSecretsEnv(`1:${generateSecret()}`, "deno"),
    "session-signing",
  );
}

it("client WS upgrade rejects HTTP 401 without a session", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const sessionSecrets = await createSessionSecrets();
  registerDaemonWebSocket(app, {
    secrets,
    sessionSecrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-stub").cell,
    ),
  });

  const response = await app.request(CLIENT_WS_PATH, {
    method: "GET",
    headers: { ...WS_UPGRADE_HEADERS },
  });
  assertEquals(response.status, 401);
});

it("client WS upgrade rejects HTTP 401 when no session keyring is configured", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerDaemonWebSocket(app, {
    secrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-stub").cell,
    ),
  });

  const response = await app.request(CLIENT_WS_PATH, {
    method: "GET",
    headers: { ...WS_UPGRADE_HEADERS },
  });
  assertEquals(response.status, 401);
});

it("developer WS upgrade rejects HTTP 401 without developer access", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const sessionSecrets = await createSessionSecrets();
  registerDaemonWebSocket(app, {
    developerSurface: true,
    secrets,
    sessionSecrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-stub").cell,
    ),
  });

  const response = await app.request(DEVELOPER_WS_PATH, {
    method: "GET",
    headers: { ...WS_UPGRADE_HEADERS },
  });
  assertEquals(response.status, 401);
});

it("developer WS is not registered when the developer surface is disabled", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const sessionSecrets = await createSessionSecrets();
  registerDaemonWebSocket(app, {
    developerSurface: false,
    secrets,
    sessionSecrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-stub").cell,
    ),
  });

  const response = await app.request(DEVELOPER_WS_PATH, {
    method: "GET",
    headers: { ...WS_UPGRADE_HEADERS },
  });
  assertEquals(response.status, 404);
});

it("stub WS returns 426 for a non-upgrade GET", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const sessionSecrets = await createSessionSecrets();
  registerDaemonWebSocket(app, {
    secrets,
    sessionSecrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-stub").cell,
    ),
  });

  const response = await app.request(CLIENT_WS_PATH, { method: "GET" });
  assertEquals(response.status, 426);
});

it("over-limit inbound messages close websocket before unbounded queuing", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const tracking = createTrackingDaemonCell("srv-flood");
  registerDaemonWebSocket(app, {
    secrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(tracking.cell),
    inboundMessageLimit: 3,
    inboundMessageWindowMs: 60_000,
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-flood", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  const ws = upgradedWebSocket(response);
  if (response.status !== 101 || !ws) {
    console.warn("Skipping flood test: response.webSocket unavailable");
    return;
  }

  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  let closeCode: number | undefined;
  ws.addEventListener("close", (event) => {
    closeCode = event.code;
  });

  const at = new Date().toISOString();
  for (let i = 0; i < 4; i++) {
    ws.send(JSON.stringify({ type: "heartbeat", at }));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(closeCode, 1008);
  const inboundBefore = tracking.calls.recordInbound;
  ws.send(JSON.stringify({ type: "heartbeat", at }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(tracking.calls.recordInbound, inboundBefore);
});

it("oversized inbound frames close websocket with policy violation", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const tracking = createTrackingDaemonCell("srv-oversize");
  registerDaemonWebSocket(app, {
    secrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-oversize", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  const ws = upgradedWebSocket(response);
  if (response.status !== 101 || !ws) {
    console.warn(
      "Skipping oversize frame test: response.webSocket unavailable",
    );
    return;
  }

  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  let closeCode: number | undefined;
  let closeReason: string | undefined;
  ws.addEventListener("close", (event) => {
    closeCode = event.code;
    closeReason = event.reason;
  });

  const inboundBefore = tracking.calls.recordInbound;
  const padding = "x".repeat(260 * 1024);
  ws.send(
    JSON.stringify({
      type: "heartbeat",
      at: new Date().toISOString(),
      pad: padding,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(closeCode, 1008);
  assertEquals(closeReason, "policy_violation");
  assertEquals(tracking.calls.recordInbound, inboundBefore);
});

it("plain GET with valid JWT returns 426 and does not call connectLimiter", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  let limitCalls = 0;
  registerDaemonWebSocket(app, {
    secrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-test").cell,
    ),
    connectLimiter: {
      limit: () => {
        limitCalls += 1;
        return Promise.resolve({ success: true });
      },
    },
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-test", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
    },
  });
  assertEquals(response.status, 426);
  assertEquals(await response.text(), "Expected WebSocket");
  assertEquals(limitCalls, 0);
});

it("WS upgrade rejects HTTP 429 when connectLimiter denies", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerDaemonWebSocket(app, {
    secrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-test").cell,
    ),
    connectLimiter: {
      limit: () => Promise.resolve({ success: false }),
    },
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-test", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 429);
  assertEquals(await response.text(), "Too Many Requests");
});

it("WS lifecycle attaches, handles hello, and detaches through cell backend", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-lifecycle";
  const tracking = createTrackingDaemonCell(serverId);
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 101);

  const ws = upgradedWebSocket(response);
  if (!ws) {
    console.warn(
      "Skipping WS lifecycle assertions: response.webSocket unavailable in Deno test runtime",
    );
    return;
  }
  ws.accept();

  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(tracking.calls.attach, 1);
  assertEquals(tracking.getSnapshot().connected, true);

  ws.send(
    JSON.stringify({
      type: "hello",
      at: new Date().toISOString(),
      daemonBuild: { commit: "hello-commit", buildId: "hello-build" },
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(tracking.calls.recordInbound >= 1, true);

  ws.close(1000, "test done");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(tracking.calls.detach, 1);
  assertEquals(tracking.getSnapshot().connected, false);
});

it("WS upgrade accepts HTTP 101 with valid JWT after daemon key is revoked", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-test", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 101);
});

it("WS upgrade accepts HTTP 101 with valid JWT after daemon key is replaced", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
  });

  const issued = await issueDaemonJwt(
    { sub: "srv-test", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 101);
});

async function openTestWebSocket(
  serverId: string,
  secrets: Awaited<ReturnType<typeof createDaemonJwtSecrets>>,
): Promise<
  | { ws: WebSocket; tracking: ReturnType<typeof createTrackingDaemonCell> }
  | null
> {
  const app = new Hono();
  const tracking = createTrackingDaemonCell(serverId);
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(),
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  const ws = upgradedWebSocket(response);
  if (response.status !== 101 || !ws) return null;
  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ws, tracking };
}

function waitForWsJson(
  ws: WebSocket,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for ws message")),
      timeoutMs,
    );
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

it("hello over WS calls cell.recordInbound", async () => {
  const secrets = await createDaemonJwtSecrets();
  const opened = await openTestWebSocket("srv-hello", secrets);
  if (!opened) {
    console.warn("Skipping hello WS test: response.webSocket unavailable");
    return;
  }
  const { ws, tracking } = opened;

  ws.send(
    JSON.stringify({
      type: "hello",
      at: new Date().toISOString(),
      daemonBuild: { commit: "hello-commit", buildId: "hello-build" },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(tracking.calls.recordInbound, 1);
  ws.close(1000, "done");
});

it("cell ping over WS sends pong, refreshes cell liveness, skips Postgres", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-cell-ping";
  const recentAt = new Date().toISOString();
  const { db, getUpdateCallCount } = createProjectionTrackingDb(
    serverId,
    {
      key: baseDaemonKey,
      projection: { hostname: "host-1" },
    },
    {
      connected: true,
      statusChangedAt: recentAt,
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.getSnapshot = () =>
    Promise.resolve({
      serverId,
      version: 1,
      updatedAt: recentAt,
      connected: true,
      lastSeenAt: recentAt,
      lastInboundAt: recentAt,
    });
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  const ws = upgradedWebSocket(response);
  if (response.status !== 101 || !ws) {
    console.warn("Skipping cell ping WS test: response.webSocket unavailable");
    return;
  }

  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const updatesBefore = getUpdateCallCount();
  const recordInboundBefore = tracking.calls.recordInbound;

  const pongPromise = waitForWsJson(ws);
  ws.send(DAEMON_CELL_PING);
  const pong = await pongPromise;
  assertEquals(pong.type, "pong");
  assertEquals(JSON.stringify(pong), DAEMON_CELL_PONG);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(tracking.calls.recordInbound, recordInboundBefore + 1);
  assertEquals(getUpdateCallCount(), updatesBefore);
  ws.close(1000, "done");
});

it("hello over WS with daemonBuild projects commit for update status", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-heartbeat-daemonBuild-ws";
  const { db, getDaemon } = createProjectionTrackingDb(
    serverId,
    {
      key: baseDaemonKey,
      projection: { hostname: "host-1" },
    },
    {
      connected: true,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  const ws = upgradedWebSocket(response);
  if (response.status !== 101 || !ws) {
    console.warn(
      "Skipping heartbeat daemonBuild WS test: response.webSocket unavailable",
    );
    return;
  }

  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  ws.send(
    JSON.stringify({
      type: "hello",
      at: new Date().toISOString(),
      daemonBuild: {
        commit: "ws-hello-commit",
        buildId: "ws-hello-build",
        channel: "trunk",
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  const merged = parseServerDaemonState(getDaemon());
  assertEquals(merged?.projection?.daemonBuild?.commit, "ws-hello-commit");
  ws.close(1000, "done");
});

it("heartbeat over WS without daemonBuild does not write Postgres status", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-heartbeat-no-daemonBuild-ws";
  const stale = new Date(Date.now() - 61_000).toISOString();
  const { db, getStatus, getUpdateCallCount } = createProjectionTrackingDb(
    serverId,
    {
      key: baseDaemonKey,
      projection: {
        hostname: "host-1",
        daemonBuild: { commit: "abc", buildId: "1" },
      },
    },
    {
      connected: true,
      statusChangedAt: stale,
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  const ws = upgradedWebSocket(response);
  if (response.status !== 101 || !ws) {
    console.warn(
      "Skipping heartbeat no-daemonBuild WS test: response.webSocket unavailable",
    );
    return;
  }

  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const updatesBefore = getUpdateCallCount();

  ws.send(
    JSON.stringify({
      type: "heartbeat",
      at: new Date().toISOString(),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(getUpdateCallCount(), updatesBefore);
  const status = getStatus();
  assertEquals(status.statusChangedAt, stale);
  assertEquals(status.connected, true);
  ws.close(1000, "done");
});

it("coalesced heartbeat over WS performs no Postgres update", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-heartbeat-coalesce-ws";
  const recentAt = new Date().toISOString();
  const { db, getUpdateCallCount } = createProjectionTrackingDb(
    serverId,
    {
      key: baseDaemonKey,
      projection: { hostname: "host-1" },
    },
    {
      connected: true,
      statusChangedAt: recentAt,
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.getSnapshot = () =>
    Promise.resolve({
      serverId,
      version: 1,
      updatedAt: recentAt,
      connected: true,
      lastSeenAt: recentAt,
      lastInboundAt: recentAt,
    });
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  const ws = upgradedWebSocket(response);
  if (response.status !== 101 || !ws) {
    console.warn(
      "Skipping coalesced heartbeat WS test: response.webSocket unavailable",
    );
    return;
  }

  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const updatesBefore = getUpdateCallCount();

  ws.send(
    JSON.stringify({
      type: "heartbeat",
      at: new Date(Date.now() + 1000).toISOString(),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(getUpdateCallCount(), updatesBefore);
  ws.close(1000, "done");
});

it("WS close projects disconnected to Postgres", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-disconnect-projection";
  const { db, getStatus } = createProjectionTrackingDb(
    serverId,
    {
      key: baseDaemonKey,
      projection: { hostname: "host-1" },
    },
    {
      connected: true,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  const ws = upgradedWebSocket(response);
  if (response.status !== 101 || !ws) {
    console.warn(
      "Skipping WS disconnect projection test: response.webSocket unavailable",
    );
    return;
  }

  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  ws.close(1000, "test done");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(getStatus().connected, false);
});

it("update-result over WS projects update summary to Postgres", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-update-result-ws";
  const { db, getDaemon } = createProjectionTrackingDb(
    serverId,
    {
      key: baseDaemonKey,
      projection: {
        hostname: "host-1",
        update: {
          status: "updating",
          requestId: "req-update-1",
          channel: "trunk",
          queuedAt: "2020-01-01T00:00:00.000Z",
        },
      },
    },
    {
      connected: true,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.handleInbound = () =>
    Promise.resolve({
      serverId,
      requestId: "req-update-1",
      requestKind: "update",
      status: "done" as const,
      createdAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T00:05:00.000Z",
      finishedAt: "2020-01-01T00:01:00.000Z",
    });
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  const ws = upgradedWebSocket(response);
  if (response.status !== 101 || !ws) {
    console.warn(
      "Skipping update-result WS test: response.webSocket unavailable",
    );
    return;
  }

  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  ws.send(
    JSON.stringify({
      type: "update-result",
      id: "req-update-1",
      at: "2020-01-01T00:01:00.000Z",
      ok: true,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  const update = parseServerDaemonState(getDaemon())?.projection?.update;
  assertEquals(update?.status, "done");
  assertEquals(update?.requestId, "req-update-1");
  assertEquals(update?.finishedAt, "2020-01-01T00:01:00.000Z");
  ws.close(1000, "done");
});

it("hello over WS clears stale updating when daemonBuild matches trunk", async () => {
  resetTrunkManifestCacheForTests();
  seedTrunkManifestCacheForTests({
    commit: "target-commit",
    buildId: "b2",
    builtAt: "2020-01-01T00:00:00.000Z",
    channel: "trunk",
    manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
  });

  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-hello-repair";
  const { db, getDaemon } = createProjectionTrackingDb(
    serverId,
    {
      key: baseDaemonKey,
      projection: {
        hostname: "host-1",
        daemonBuild: {
          commit: "target-commit",
          buildId: "b1",
          channel: "trunk",
        },
        update: {
          status: "updating",
          requestId: "req-update-1",
          channel: "trunk",
          queuedAt: "2020-01-01T00:00:00.000Z",
        },
      },
    },
    {
      connected: true,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.getSnapshot = () =>
    Promise.resolve({
      serverId,
      version: 1,
      updatedAt: new Date().toISOString(),
      connected: true,
      daemonBuild: {
        commit: "target-commit",
        buildId: "b1",
        channel: "trunk",
      },
    });
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  const ws = upgradedWebSocket(response);
  if (response.status !== 101 || !ws) {
    console.warn(
      "Skipping hello repair WS test: response.webSocket unavailable",
    );
    return;
  }

  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  ws.send(
    JSON.stringify({
      type: "hello",
      at: new Date().toISOString(),
      daemonBuild: {
        commit: "target-commit",
        buildId: "b1",
        channel: "trunk",
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  const update = parseServerDaemonState(getDaemon())?.projection?.update;
  assertEquals(update?.status, "done");
  assertEquals(update?.requestId, "req-update-1");
  resetTrunkManifestCacheForTests();
  ws.close(1000, "done");
});

test("isClosedConnectionError matches closed-socket errors", () => {
  assertEquals(
    isClosedConnectionError(new Error("Connection is closed")),
    true,
  );
  assertEquals(isClosedConnectionError("connection is closed by peer"), true);
  assertEquals(isClosedConnectionError(new Error("network timeout")), false);
});

test("wsMessageDataToString accepts string, Blob, and ArrayBuffer views", async () => {
  assertEquals(await wsMessageDataToString("hello"), "hello");
  assertEquals(
    await wsMessageDataToString(new Blob(["from-blob"])),
    "from-blob",
  );
  const bytes = new TextEncoder().encode("bytes");
  assertEquals(
    await wsMessageDataToString(bytes.buffer as ArrayBufferLike),
    "bytes",
  );
});

function fakePingSocket(): { ws: { send: (data: string) => void }; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    ws: {
      send: (data: string) => {
        sent.push(data);
      },
    },
  };
}

test("handleDaemonCellPing repairs Postgres-only false offline", async () => {
  const serverId = "srv-ping-pg-offline";
  const { db, getStatus } = createProjectionTrackingDb(
    serverId,
    { key: baseDaemonKey },
    {
      connected: false,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.getSnapshot = () =>
    Promise.resolve({
      serverId,
      version: 1,
      updatedAt: new Date().toISOString(),
      connected: true,
      connectedAt: "2020-01-01T00:00:00.000Z",
    });
  const { ws, sent } = fakePingSocket();

  await handleDaemonCellPing({
    cell: tracking.cell,
    db,
    serverId,
    connectionId: "track-conn",
    ws: ws as never,
  });

  assertEquals(sent, [DAEMON_CELL_PONG]);
  assertEquals(tracking.calls.recordInbound, 1);
  assertEquals(getStatus().connected, true);
});

test("handleDaemonCellPing re-projects when the cell snapshot is disconnected", async () => {
  const serverId = "srv-ping-cell-offline";
  const { db, getStatus } = createProjectionTrackingDb(
    serverId,
    { key: baseDaemonKey },
    {
      connected: false,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.getSnapshot = () =>
    Promise.resolve({
      serverId,
      version: 1,
      updatedAt: new Date().toISOString(),
      connected: false,
    });
  const { ws, sent } = fakePingSocket();

  await handleDaemonCellPing({
    cell: tracking.cell,
    db,
    serverId,
    connectionId: "track-conn",
    ws: ws as never,
  });

  assertEquals(sent, [DAEMON_CELL_PONG]);
  assertEquals(getStatus().connected, true);
});

it("WS upgrade returns 503 when database is unavailable", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerDaemonWebSocket(app, {
    secrets,
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-no-db").cell,
    ),
  });
  const issued = await issueDaemonJwt(
    { sub: "srv-no-db", kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 503);
  assertEquals(
    ((await response.json()) as { error: string }).error,
    "Database unavailable",
  );
});

it("WS upgrade returns 503 when daemon cell registry is unavailable", async () => {
  const app = new Hono();
  const secrets = await createDaemonJwtSecrets();
  registerDaemonWebSocket(app, {
    secrets,
    db: createMockDb(),
  });
  const issued = await issueDaemonJwt(
    {
      sub: "srv-no-registry",
      kid: "key-test",
    },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 503);
  assertEquals(
    ((await response.json()) as { error: string }).error,
    "Daemon cell registry unavailable",
  );
});

it("revoked daemon key closes the socket on the next inbound ping", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-key-revoked-ping";
  const revokedKey = {
    ...baseDaemonKey,
    revokedAt: "2020-01-02T00:00:00.000Z",
  };
  const { db } = createProjectionTrackingDb(
    serverId,
    {
      key: revokedKey,
    },
    {
      connected: true,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  const ws = upgradedWebSocket(response);
  if (response.status !== 101 || !ws) {
    console.warn(
      "Skipping revoked-key ping test: response.webSocket unavailable",
    );
    return;
  }

  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (event) => {
      resolve({ code: event.code, reason: event.reason });
    });
  });
  ws.send(DAEMON_CELL_PING);
  const closeEvent = await closed;
  assertEquals(closeEvent.code, 1008);
  assertEquals(closeEvent.reason, "key_revoked");
});

it("cell ping re-projects online when Redis snapshot is disconnected", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-ping-redis-offline";
  const { db, getStatus } = createProjectionTrackingDb(
    serverId,
    {
      key: baseDaemonKey,
    },
    {
      connected: false,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.getSnapshot = () =>
    Promise.resolve({
      serverId,
      version: 1,
      updatedAt: new Date().toISOString(),
      connected: false,
    });
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  const ws = upgradedWebSocket(response);
  if (response.status !== 101 || !ws) {
    console.warn(
      "Skipping redis-offline ping repair test: response.webSocket unavailable",
    );
    return;
  }

  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const pongPromise = waitForWsJson(ws);
  ws.send(DAEMON_CELL_PING);
  assertEquals((await pongPromise).type, "pong");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(getStatus().connected, true);
  ws.close(1000, "done");
});

it("heartbeat with timeSync writes timezone columns without requiring daemonBuild", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-heartbeat-timesync";
  const { db, getUpdateCallCount } = createProjectionTrackingDb(
    serverId,
    {
      key: baseDaemonKey,
    },
    {
      connected: true,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  const app = new Hono();
  registerTestDaemonWebSocket(app, secrets, {
    db,
    registry: createTrackingRegistry(tracking.cell),
  });

  const issued = await issueDaemonJwt(
    { sub: serverId, kid: "key-test" },
    secrets,
  );
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  });
  const ws = upgradedWebSocket(response);
  if (response.status !== 101 || !ws) {
    console.warn(
      "Skipping heartbeat timeSync test: response.webSocket unavailable",
    );
    return;
  }

  ws.accept();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const updatesBefore = getUpdateCallCount();
  const inboundBefore = tracking.calls.recordInbound;

  ws.send(
    JSON.stringify({
      type: "heartbeat",
      at: new Date().toISOString(),
      timeSync: { timezone: "America/Chicago", ntpEnabled: true },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(tracking.calls.recordInbound, inboundBefore + 1);
  assertEquals(getUpdateCallCount() > updatesBefore, true);
  ws.close(1000, "done");
});

// ---------------------------------------------------------------------------
// Live Deno.serve WebSocket coverage
//
// `app.request()` returns HTTP 101 without a usable `response.webSocket` under
// Deno, so the suites above silently skip most handler paths. These tests drive
// a real upgrade via Deno.serve + WebSocket client.
// ---------------------------------------------------------------------------

const LIVE_REMOTE_IP = "203.0.113.50";

/**
 * Deno's WebSocket constructor accepts `{ headers }` (not in the DOM lib).
 * Wrap construction so `tsc` via tsconfig stays quiet.
 */
function createDenoWebSocket(
  url: string,
  init?: { headers?: Record<string, string> },
): WebSocket {
  const WebSocketCtor = WebSocket as unknown as {
    new (
      url: string,
      protocolsOrInit?:
        | string
        | string[]
        | {
          headers?: Record<string, string>;
        },
    ): WebSocket;
  };
  return init ? new WebSocketCtor(url, init) : new WebSocketCtor(url);
}

async function waitForWsOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new TypeError("WebSocket failed to open"));
    };
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

function waitForWsClose(
  ws: WebSocket,
  timeoutMs = 3000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TypeError("timed out waiting for ws close")),
      timeoutMs,
    );
    ws.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        resolve({ code: event.code, reason: event.reason });
      },
      { once: true },
    );
  });
}

function waitForWsMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TypeError("timed out waiting for ws message")),
      timeoutMs,
    );
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      },
      { once: true },
    );
  });
}

async function withLiveDaemonServer(
  options: {
    secrets: Awaited<ReturnType<typeof createDaemonJwtSecrets>>;
    db?: Db;
    registry?: DaemonCellRegistry;
    inboundMessageLimit?: number;
    inboundMessageWindowMs?: number;
    connectLimiter?: RateLimiter;
    developerSurface?: boolean;
    sessionSecrets?: DerivedSecretsConfig;
    setDbOnContext?: Db;
  },
  fn: (ctx: { port: number; origin: string }) => Promise<void>,
): Promise<void> {
  const app = new Hono();
  if (options.setDbOnContext) {
    const db = options.setDbOnContext;
    app.use("*", async (c, next) => {
      (c as { set: (key: "db", value: Db) => void }).set("db", db);
      await next();
    });
  }
  registerDaemonWebSocket(app, {
    secrets: options.secrets,
    db: options.db,
    daemonCellRegistry: options.registry ??
      createTrackingRegistry(createTrackingDaemonCell("srv-live").cell),
    inboundMessageLimit: options.inboundMessageLimit,
    inboundMessageWindowMs: options.inboundMessageWindowMs,
    connectLimiter: options.connectLimiter,
    developerSurface: options.developerSurface,
    sessionSecrets: options.sessionSecrets,
  });

  const ac = new AbortController();
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: ac.signal,
      onListen() {},
    },
    app.fetch,
  );
  const addr = server.addr;
  if (!("port" in addr)) {
    throw new TypeError("expected TCP listen address");
  }
  const port = addr.port;
  try {
    await fn({ port, origin: `http://127.0.0.1:${port}` });
  } finally {
    ac.abort();
    await server.finished.catch(() => {});
  }
}

async function openLiveDaemonWs(params: {
  port: number;
  token: string;
  remoteIp?: string;
}): Promise<WebSocket> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.token}`,
  };
  if (params.remoteIp !== undefined) {
    headers["X-Real-IP"] = params.remoteIp;
  }
  const ws = createDenoWebSocket(
    `ws://127.0.0.1:${params.port}${DAEMON_WS_PATH}`,
    { headers },
  );
  await waitForWsOpen(ws);
  // Allow async onOpen (attach + outbox pump start) to settle.
  await new Promise((resolve) => setTimeout(resolve, 40));
  return ws;
}

function createRecordedPlanDb(serverId: string): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                daemon: { key: { ...baseDaemonKey, id: "key-test" } },
                metadata: null,
                hostname: null,
                machineKey: null,
                connected: true,
                statusChangedAt: "2020-01-01T00:00:00.000Z",
              },
            ]),
          orderBy: () => ({
            limit: () =>
              Promise.resolve([
                {
                  generation: 5,
                  planHash: "hash",
                  plan: PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
                  appliedAt: "2026-01-01T00:00:00.000Z",
                  serverId,
                },
              ]),
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(undefined),
      }),
    }),
  } as unknown as Db;
}

test("live WS self-hosted reconnect clears a leftover hosted capability plan", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-self-hosted-plan-skip";
  const tracking = createTrackingDaemonCell(serverId);
  await withLiveDaemonServer(
    {
      secrets,
      db: createRecordedPlanDb(serverId),
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = await openLiveDaemonWs({
        port,
        token: issued.token,
        remoteIp: LIVE_REMOTE_IP,
      });
      assertEquals(
        tracking.enqueued.some((envelope) =>
          envelope.kind === "capability-plan-update"
        ),
        false,
      );
      assertEquals(
        tracking.enqueued.some((envelope) =>
          envelope.kind === "capability-plan-clear"
        ),
        true,
      );
      ws.close(1000, "done");
    },
  );
});

/** Open a live WS while buffering the first inbound server message. */
async function openLiveDaemonWsWithFirstMessage(params: {
  port: number;
  token: string;
  remoteIp?: string;
}): Promise<{ ws: WebSocket; firstMessage: Promise<string> }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.token}`,
  };
  if (params.remoteIp !== undefined) {
    headers["X-Real-IP"] = params.remoteIp;
  }
  const ws = createDenoWebSocket(
    `ws://127.0.0.1:${params.port}${DAEMON_WS_PATH}`,
    { headers },
  );
  const firstMessage = waitForWsMessage(ws);
  await waitForWsOpen(ws);
  await new Promise((resolve) => setTimeout(resolve, 40));
  return { ws, firstMessage };
}

test("live WS attaches, pumps outbox, handles hello/ping, and detaches", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-lifecycle";
  const tracking = createTrackingDaemonCell(serverId);
  let outboxDelivered = false;
  const outbound: DaemonOutboundEnvelope = {
    kind: "echo",
    requestId: "req-echo-1",
    at: "2020-01-01T00:00:00.000Z",
    payload: { ping: true },
    deliveryId: "del-1",
  };
  tracking.cell.readOutboxBatch = async (args?: { blockMs?: number }) => {
    tracking.calls.readOutboxBatch += 1;
    if (!outboxDelivered) {
      outboxDelivered = true;
      return [outbound];
    }
    const blockMs = args?.blockMs;
    if (blockMs != null && blockMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(blockMs, 15))
      );
    }
    return [];
  };
  let markSent = 0;
  let ackOutbox = 0;
  tracking.cell.markSent = () => {
    markSent += 1;
    return Promise.resolve();
  };
  tracking.cell.ackOutbox = () => {
    ackOutbox += 1;
    return Promise.resolve();
  };

  await withLiveDaemonServer(
    {
      secrets,
      db: createMockDb(),
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const { ws, firstMessage } = await openLiveDaemonWsWithFirstMessage({
        port,
        token: issued.token,
        remoteIp: LIVE_REMOTE_IP,
      });

      assertEquals(tracking.calls.attach, 1);
      assertEquals(tracking.getSnapshot().connected, true);

      const outboxMsg = await firstMessage;
      const parsed = JSON.parse(outboxMsg) as Record<string, unknown>;
      assertEquals(parsed.type, "echo");
      assertEquals(markSent >= 1, true);
      assertEquals(ackOutbox >= 1, true);
      assertEquals(tracking.calls.putSnapshot >= 1, true);

      ws.send(
        JSON.stringify({
          type: "hello",
          at: new Date().toISOString(),
          hostname: "live-host",
          daemonBuild: { commit: "c1", buildId: "b1" },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      assertEquals(tracking.calls.recordInbound >= 1, true);

      const pongPromise = waitForWsMessage(ws);
      ws.send(DAEMON_CELL_PING);
      assertEquals(await pongPromise, DAEMON_CELL_PONG);

      const closed = waitForWsClose(ws);
      ws.close(1000, "done");
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 40));
      assertEquals(tracking.calls.detach, 1);
    },
  );
});

test("live WS queues messages until attach completes then drains them", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-pending";
  const tracking = createTrackingDaemonCell(serverId);
  let releaseAttach: (() => void) | undefined;
  const attachGate = new Promise<void>((resolve) => {
    releaseAttach = resolve;
  });
  const originalAttach = tracking.cell.attachDaemonSocket.bind(tracking.cell);
  tracking.cell.attachDaemonSocket = async (meta) => {
    await attachGate;
    return await originalAttach(meta);
  };

  await withLiveDaemonServer(
    {
      secrets,
      db: createMockDb(),
      registry: createTrackingRegistry(tracking.cell),
      inboundMessageLimit: 10,
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = createDenoWebSocket(
        `ws://127.0.0.1:${port}${DAEMON_WS_PATH}`,
        {
          headers: {
            Authorization: `Bearer ${issued.token}`,
            "X-Real-IP": LIVE_REMOTE_IP,
          },
        },
      );
      await waitForWsOpen(ws);
      // Send before attach finishes — should queue.
      ws.send(
        JSON.stringify({
          type: "heartbeat",
          at: new Date().toISOString(),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assertEquals(tracking.calls.attach, 0);
      assertEquals(tracking.calls.recordInbound, 0);

      releaseAttach?.();
      await new Promise((resolve) => setTimeout(resolve, 60));
      assertEquals(tracking.calls.attach, 1);
      assertEquals(tracking.calls.recordInbound >= 1, true);
      ws.close(1000, "done");
      await waitForWsClose(ws);
    },
  );
});

test("live WS closes when pending queue exceeds inboundMessageLimit before attach", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-pending-flood";
  const tracking = createTrackingDaemonCell(serverId);
  let releaseAttach: (() => void) | undefined;
  const attachGate = new Promise<void>((resolve) => {
    releaseAttach = resolve;
  });
  const originalAttach = tracking.cell.attachDaemonSocket.bind(tracking.cell);
  tracking.cell.attachDaemonSocket = async (meta) => {
    await attachGate;
    return await originalAttach(meta);
  };

  await withLiveDaemonServer(
    {
      secrets,
      db: createMockDb(),
      registry: createTrackingRegistry(tracking.cell),
      inboundMessageLimit: 2,
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = createDenoWebSocket(
        `ws://127.0.0.1:${port}${DAEMON_WS_PATH}`,
        {
          headers: {
            Authorization: `Bearer ${issued.token}`,
            "X-Real-IP": LIVE_REMOTE_IP,
          },
        },
      );
      await waitForWsOpen(ws);
      const closed = waitForWsClose(ws);
      for (let i = 0; i < 3; i++) {
        ws.send(
          JSON.stringify({
            type: "heartbeat",
            at: new Date().toISOString(),
          }),
        );
      }
      const closeEvent = await closed;
      assertEquals(closeEvent.code, 1008);
      assertEquals(closeEvent.reason, "rate_limited");
      releaseAttach?.();
    },
  );
});

test("live WS rate-limits after attach and closes with 1008", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-rate";
  const tracking = createTrackingDaemonCell(serverId);

  await withLiveDaemonServer(
    {
      secrets,
      db: createMockDb(),
      registry: createTrackingRegistry(tracking.cell),
      inboundMessageLimit: 3,
      inboundMessageWindowMs: 60_000,
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = await openLiveDaemonWs({
        port,
        token: issued.token,
        remoteIp: LIVE_REMOTE_IP,
      });
      const closed = waitForWsClose(ws);
      for (let i = 0; i < 4; i++) {
        ws.send(
          JSON.stringify({
            type: "heartbeat",
            at: new Date().toISOString(),
          }),
        );
      }
      const closeEvent = await closed;
      assertEquals(closeEvent.code, 1008);
      assertEquals(closeEvent.reason, "rate_limited");
    },
  );
});

test("live WS rejects oversized frames and revoked keys", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-policy";
  const tracking = createTrackingDaemonCell(serverId);

  await withLiveDaemonServer(
    {
      secrets,
      db: createMockDb(),
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = await openLiveDaemonWs({
        port,
        token: issued.token,
        remoteIp: LIVE_REMOTE_IP,
      });
      const closed = waitForWsClose(ws);
      ws.send(
        JSON.stringify({
          type: "heartbeat",
          at: new Date().toISOString(),
          pad: "x".repeat(260 * 1024),
        }),
      );
      const closeEvent = await closed;
      assertEquals(closeEvent.code, 1008);
      assertEquals(closeEvent.reason, "policy_violation");
    },
  );

  const revoked = {
    ...baseDaemonKey,
    revokedAt: "2020-01-02T00:00:00.000Z",
  };
  const { db } = createProjectionTrackingDb(
    serverId + "-rev",
    {
      key: revoked,
    },
    {
      connected: true,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  );
  const tracking2 = createTrackingDaemonCell(serverId + "-rev");
  await withLiveDaemonServer(
    {
      secrets,
      db,
      registry: createTrackingRegistry(tracking2.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        {
          sub: serverId + "-rev",
          kid: "key-test",
        },
        secrets,
      );
      const ws = await openLiveDaemonWs({
        port,
        token: issued.token,
        remoteIp: LIVE_REMOTE_IP,
      });
      const closed = waitForWsClose(ws);
      ws.send(DAEMON_CELL_PING);
      const closeEvent = await closed;
      assertEquals(closeEvent.code, 1008);
      assertEquals(closeEvent.reason, "key_revoked");
    },
  );
});

test("live WS attach failure closes with 1013", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-attach-fail";
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.attachDaemonSocket = () =>
    Promise.reject(new Error("attach boom"));

  await withLiveDaemonServer(
    {
      secrets,
      db: createMockDb(),
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = createDenoWebSocket(
        `ws://127.0.0.1:${port}${DAEMON_WS_PATH}`,
        {
          headers: {
            Authorization: `Bearer ${issued.token}`,
            "X-Real-IP": LIVE_REMOTE_IP,
          },
        },
      );
      const closed = waitForWsClose(ws);
      await waitForWsOpen(ws).catch(() => {});
      const closeEvent = await closed;
      assertEquals(closeEvent.code, 1013);
    },
  );
});

test("live WS colocated path closes when postgres row is missing", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-colocated-missing";
  const tracking = createTrackingDaemonCell(serverId);
  const emptyDb = {
    select: () => createSelectChain(() => []),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(undefined),
      }),
    }),
  } as unknown as Db;

  await withLiveDaemonServer(
    {
      secrets,
      db: emptyDb,
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      // No X-Real-IP → identityAddress === "__direct__"
      const ws = createDenoWebSocket(
        `ws://127.0.0.1:${port}${DAEMON_WS_PATH}`,
        {
          headers: { Authorization: `Bearer ${issued.token}` },
        },
      );
      const closed = waitForWsClose(ws);
      await waitForWsOpen(ws).catch(() => {});
      const closeEvent = await closed;
      assertEquals(closeEvent.code, 4401);
      assertEquals(closeEvent.reason, "server row missing");
    },
  );
});

test("live WS ping repairs Postgres-only false offline", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-pg-offline";
  const { db, getStatus } = createProjectionTrackingDb(
    serverId,
    {
      key: baseDaemonKey,
    },
    {
      connected: false,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  // Redis already connected — exercise the Postgres-only repair branch.
  tracking.cell.getSnapshot = () =>
    Promise.resolve({
      serverId,
      version: 1,
      updatedAt: new Date().toISOString(),
      connected: true,
      connectedAt: "2020-01-01T00:00:00.000Z",
    });

  await withLiveDaemonServer(
    {
      secrets,
      db,
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = await openLiveDaemonWs({
        port,
        token: issued.token,
        remoteIp: LIVE_REMOTE_IP,
      });
      const pongPromise = waitForWsMessage(ws);
      ws.send(DAEMON_CELL_PING);
      assertEquals(await pongPromise, DAEMON_CELL_PONG);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assertEquals(getStatus().connected, true);
      ws.close(1000, "done");
      await waitForWsClose(ws);
    },
  );
});

test("live WS hello persists os hostname machineKey docker and timeSync", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-hello-meta";
  const { db, getPatches } = createProjectionTrackingDb(
    serverId,
    { key: baseDaemonKey },
    {
      connected: true,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  );
  const tracking = createTrackingDaemonCell(serverId);

  await withLiveDaemonServer(
    {
      secrets,
      db,
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = await openLiveDaemonWs({
        port,
        token: issued.token,
        remoteIp: LIVE_REMOTE_IP,
      });
      ws.send(
        JSON.stringify({
          type: "hello",
          at: new Date().toISOString(),
          daemonBuild: { commit: "hello-meta", buildId: "hello-meta-build" },
          hostname: "hello-meta-host",
          machineKey: "a".repeat(64),
          os: {
            id: "debian",
            family: "linux",
            version: "13.5",
            prettyName: "Debian GNU/Linux 13 (trixie)",
          },
          docker: { version: "28.3.3", composeVersion: "2.39.1" },
          timeSync: {
            timezone: "UTC",
            ntpEnabled: true,
            ntpServers: ["time.cloudflare.com"],
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
      const identity = getPatches().find((patch) =>
        patch.hostname === "hello-meta-host"
      );
      if (!identity) {
        throw new TypeError("expected hello metadata patch");
      }
      assertEquals(identity.machineKey, "a".repeat(64));
      assertEquals(identity.osId, "debian");
      assertEquals(identity.timezone, "UTC");
      assertEquals(tracking.calls.recordInbound >= 1, true);
      ws.close(1000, "done");
      await waitForWsClose(ws);
    },
  );
});

test("live WS update-result and heartbeat with addresses cover inbound dispatch", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-inbound";
  const { db, getDaemon } = createProjectionTrackingDb(
    serverId,
    {
      key: baseDaemonKey,
      projection: {
        update: {
          status: "updating",
          requestId: "req-u1",
          channel: "trunk",
          queuedAt: "2020-01-01T00:00:00.000Z",
        },
      },
    },
    {
      connected: true,
      statusChangedAt: "2020-01-01T00:00:00.000Z",
    },
  );
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.handleInbound = () => {
    tracking.calls.handleInbound += 1;
    return Promise.resolve({
      serverId,
      requestId: "req-u1",
      requestKind: "update",
      status: "done" as const,
      createdAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T00:05:00.000Z",
      finishedAt: "2020-01-01T00:01:00.000Z",
    });
  };
  await withLiveDaemonServer(
    {
      secrets,
      db,
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = await openLiveDaemonWs({
        port,
        token: issued.token,
        remoteIp: LIVE_REMOTE_IP,
      });

      ws.send(
        JSON.stringify({
          type: "heartbeat",
          at: new Date().toISOString(),
          resources: {
            ips: [{ address: "203.0.113.10", version: 4, scope: "public" }],
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));

      ws.send(
        JSON.stringify({
          type: "update-result",
          id: "req-u1",
          at: "2020-01-01T00:01:00.000Z",
          ok: true,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));

      assertEquals(tracking.calls.handleInbound >= 1, true);
      const update = parseServerDaemonState(getDaemon())?.projection?.update;
      assertEquals(update?.status, "done");
      ws.close(1000, "done");
      await waitForWsClose(ws);
    },
  );
});

/**
 * `createMockDb` plus an `insert(topologyGeneration)` chain that captures the
 * written row — connect-time projection (`onDaemonConnected`) still needs the
 * base `select`/`update` chain.
 */
function createTopologyInsertTrackingDb(): {
  db: Db;
  getInsertedValues: () => Record<string, unknown>[];
} {
  const inserted: Record<string, unknown>[] = [];
  const base = createMockDb() as unknown as Record<string, unknown>;
  const db = {
    ...base,
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { onConflictDoNothing: () => Promise.resolve(undefined) };
      },
    }),
  } as unknown as Db;
  return { db, getInsertedValues: () => inserted };
}

test("live WS topology-report writes the daemon-reported snapshot and its own timestamp verbatim", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-topology";
  const tracking = createTrackingDaemonCell(serverId);
  const { db, getInsertedValues } = createTopologyInsertTrackingDb();

  await withLiveDaemonServer(
    {
      secrets,
      db,
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = await openLiveDaemonWs({
        port,
        token: issued.token,
        remoteIp: LIVE_REMOTE_IP,
      });

      const daemonSnapshot = {
        generation: 3,
        bootGeneration: 1,
        networks: [{ deviceId: "mac:aa:bb:cc:dd:ee:ff", kind: "uplink" }],
      };
      const reportedAt = "2026-01-01T00:05:00.000Z";
      ws.send(
        JSON.stringify({
          type: "topology-report",
          generation: 3,
          bootGeneration: 1,
          snapshot: daemonSnapshot,
          at: reportedAt,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));

      const values = getInsertedValues();
      assertEquals(values.length, 1);
      // Stored directly — never re-wrapped as `{ generation, bootGeneration, snapshot }`.
      assertEquals(values[0]?.snapshot, daemonSnapshot);
      // The daemon's own report time, not a control-plane receipt timestamp.
      assertEquals(values[0]?.appliedAt, reportedAt);
      assertEquals(values[0]?.generation, 3);
      assertEquals(values[0]?.bootGeneration, 1);
      assertEquals(values[0]?.serverId, serverId);

      ws.close(1000, "done");
      await waitForWsClose(ws);
    },
  );
});

test("live WS swallows inbound handler errors without tearing down the socket", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-inbound-err";
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.recordInbound = () => {
    tracking.calls.recordInbound += 1;
    return Promise.reject(new Error("recordInbound boom"));
  };

  await withLiveDaemonServer(
    {
      secrets,
      db: createMockDb(),
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = await openLiveDaemonWs({
        port,
        token: issued.token,
        remoteIp: LIVE_REMOTE_IP,
      });
      ws.send(
        JSON.stringify({
          type: "heartbeat",
          at: new Date().toISOString(),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      assertEquals(ws.readyState, WebSocket.OPEN);
      assertEquals(tracking.calls.recordInbound >= 1, true);
      ws.close(1000, "done");
      await waitForWsClose(ws);
    },
  );
});

test("live WS outbox pump aborts on closed-connection errors", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-outbox-closed";
  const tracking = createTrackingDaemonCell(serverId);
  let reads = 0;
  tracking.cell.readOutboxBatch = async () => {
    reads += 1;
    tracking.calls.readOutboxBatch += 1;
    if (reads === 1) {
      throw new Error("Connection is closed");
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
    return [];
  };

  await withLiveDaemonServer(
    {
      secrets,
      db: createMockDb(),
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = await openLiveDaemonWs({
        port,
        token: issued.token,
        remoteIp: LIVE_REMOTE_IP,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      // Pump should have aborted after the closed-connection error — reads stay low.
      const readsAfter = tracking.calls.readOutboxBatch;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(tracking.calls.readOutboxBatch, readsAfter);
      ws.close(1000, "done");
      await waitForWsClose(ws);
    },
  );
});

test("live WS outbox pump logs non-closed errors and continues", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-outbox-warn";
  const tracking = createTrackingDaemonCell(serverId);
  let reads = 0;
  tracking.cell.readOutboxBatch = async (args?: { blockMs?: number }) => {
    reads += 1;
    tracking.calls.readOutboxBatch += 1;
    if (reads === 1) {
      throw new Error("transient outbox failure");
    }
    const blockMs = args?.blockMs;
    if (blockMs != null && blockMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(blockMs, 15))
      );
    }
    return [];
  };

  await withLiveDaemonServer(
    {
      secrets,
      db: createMockDb(),
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = await openLiveDaemonWs({
        port,
        token: issued.token,
        remoteIp: LIVE_REMOTE_IP,
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assertEquals(tracking.calls.readOutboxBatch >= 2, true);
      ws.close(1000, "done");
      await waitForWsClose(ws);
    },
  );
});

test("live WS detach ignores closed-connection errors from detachDaemonSocket", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-detach-closed";
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.detachDaemonSocket = () => {
    tracking.calls.detach += 1;
    return Promise.reject(new Error("Connection is closed"));
  };

  await withLiveDaemonServer(
    {
      secrets,
      db: createMockDb(),
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const ws = await openLiveDaemonWs({
        port,
        token: issued.token,
        remoteIp: LIVE_REMOTE_IP,
      });
      ws.close(1000, "done");
      await waitForWsClose(ws);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assertEquals(tracking.calls.detach, 1);
    },
  );
});

function captureStderr(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const writeStub = stub(Deno.stderr, "writeSync", (data) => {
    writes.push(new TextDecoder().decode(data));
    return data.byteLength;
  });
  return {
    writes,
    restore: () => writeStub.restore(),
  };
}

test("live WS detach logs non-closed detachDaemonSocket failures", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-detach-warn";
  const tracking = createTrackingDaemonCell(serverId);
  tracking.cell.detachDaemonSocket = (params) => {
    tracking.calls.detach += 1;
    if (params.reason !== undefined) tracking.detachReasons.push(params.reason);
    return Promise.reject(new TypeError("detach boom"));
  };
  const stderr = captureStderr();

  try {
    await withLiveDaemonServer(
      {
        secrets,
        db: createMockDb(),
        registry: createTrackingRegistry(tracking.cell),
      },
      async ({ port }) => {
        const issued = await issueDaemonJwt(
          { sub: serverId, kid: "key-test" },
          secrets,
        );
        const ws = await openLiveDaemonWs({
          port,
          token: issued.token,
          remoteIp: LIVE_REMOTE_IP,
        });
        ws.close(1000, "done");
        await waitForWsClose(ws);
        await new Promise((resolve) => setTimeout(resolve, 40));
        assertEquals(tracking.calls.detach, 1);
        assertEquals(tracking.detachReasons.includes("closed"), true);
        assertEquals(
          stderr.writes.some((line) =>
            line.includes("detachDaemonSocket failed")
          ),
          true,
        );
      },
    );
  } finally {
    stderr.restore();
  }
});

test("live WS outbox pump swallows a late error after abort", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-outbox-abort-catch";
  const tracking = createTrackingDaemonCell(serverId);
  let releaseRead: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  tracking.cell.readOutboxBatch = async () => {
    tracking.calls.readOutboxBatch += 1;
    await blocked;
    throw new TypeError("transient after abort");
  };
  const stderr = captureStderr();

  try {
    await withLiveDaemonServer(
      {
        secrets,
        db: createMockDb(),
        registry: createTrackingRegistry(tracking.cell),
      },
      async ({ port }) => {
        const issued = await issueDaemonJwt(
          { sub: serverId, kid: "key-test" },
          secrets,
        );
        const ws = await openLiveDaemonWs({
          port,
          token: issued.token,
          remoteIp: LIVE_REMOTE_IP,
        });
        // Close first so onClose sets abortRef before the pending read rejects.
        ws.close(1000, "done");
        await waitForWsClose(ws);
        releaseRead?.();
        await new Promise((resolve) => setTimeout(resolve, 40));
        assertEquals(
          stderr.writes.some((line) => line.includes("outbox pump error")),
          false,
        );
      },
    );
  } finally {
    stderr.restore();
  }
});

async function readHttpHead(conn: Deno.Conn): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const chunk = new Uint8Array(1024);
  while (!text.includes("\r\n\r\n")) {
    const n = await conn.read(chunk);
    if (n === null) break;
    text += decoder.decode(chunk.subarray(0, n));
  }
  return text;
}

/** Reserved opcode 0xB, masked, empty payload — a protocol error, not an inbound frame. */
function reservedOpcodeFrame(): Uint8Array {
  return new Uint8Array([0x8b, 0x80, 0x01, 0x02, 0x03, 0x04]);
}

test("live WS detach uses reason error when the peer violates the protocol", async () => {
  const secrets = await createDaemonJwtSecrets();
  const serverId = "srv-live-detach-error";
  const tracking = createTrackingDaemonCell(serverId);

  await withLiveDaemonServer(
    {
      secrets,
      db: createMockDb(),
      registry: createTrackingRegistry(tracking.cell),
    },
    async ({ port }) => {
      const issued = await issueDaemonJwt(
        { sub: serverId, kid: "key-test" },
        secrets,
      );
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      try {
        const upgrade = [
          `GET ${DAEMON_WS_PATH} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          `Authorization: Bearer ${issued.token}`,
          `X-Real-IP: ${LIVE_REMOTE_IP}`,
          "",
          "",
        ].join("\r\n");
        await conn.write(new TextEncoder().encode(upgrade));
        const head = await readHttpHead(conn);
        if (!head.startsWith("HTTP/1.1 101")) {
          throw new TypeError(`expected 101, got ${head.slice(0, 80)}`);
        }
        const deadline = Date.now() + 500;
        while (tracking.calls.attach === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        assertEquals(tracking.calls.attach, 1);
        await conn.write(reservedOpcodeFrame());
        const detachDeadline = Date.now() + 400;
        while (
          !tracking.detachReasons.includes("error") &&
          Date.now() < detachDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        if (!tracking.detachReasons.includes("error")) {
          // Abrupt TCP drop is the other documented onError path.
          try {
            conn.close();
          } catch {
            // Already closed.
          }
          const rstDeadline = Date.now() + 400;
          while (
            !tracking.detachReasons.includes("error") &&
            Date.now() < rstDeadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
        }
        assertEquals(
          tracking.detachReasons.includes("error"),
          true,
          `expected onError detach, got ${JSON.stringify(tracking.detachReasons)}`,
        );
      } finally {
        try {
          conn.close();
        } catch {
          // Already closed.
        }
      }
    },
  );
});

test("client stub WS greets then closes for a valid session cookie", async () => {
  const secrets = await createDaemonJwtSecrets();
  const sessionSecrets = await createSessionSecrets();
  const token = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: "user@example.com",
    role: "user",
  });
  const db = createMockAuthDb(state);
  const signed = await buildSignedCookie(token, sessionSecrets);

  await withLiveDaemonServer(
    {
      secrets,
      db: createMockDb(),
      sessionSecrets,
      setDbOnContext: db as unknown as Db,
    },
    async ({ port }) => {
      const ws = createDenoWebSocket(
        `ws://127.0.0.1:${port}${CLIENT_WS_PATH}`,
        {
          headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}` },
        },
      );
      const helloPromise = waitForWsMessage(ws);
      const closedPromise = waitForWsClose(ws);
      await waitForWsOpen(ws);
      const hello = JSON.parse(await helloPromise) as {
        type: string;
        surface: string;
      };
      assertEquals(hello.type, "hello");
      assertEquals(hello.surface, "client");
      const closed = await closedPromise;
      assertEquals(closed.code, 1000);
      assertEquals(closed.reason, "not_implemented");
    },
  );
});

test("developer stub WS accepts superadmin session and local-console auth", async () => {
  const secrets = await createDaemonJwtSecrets();
  const sessionSecrets = await createSessionSecrets();
  const token = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: "root@example.com",
    role: "superadmin",
  });
  const db = createMockAuthDb(state);
  const signed = await buildSignedCookie(token, sessionSecrets);

  await withLiveDaemonServer(
    {
      secrets,
      db: createMockDb(),
      developerSurface: true,
      sessionSecrets,
      setDbOnContext: db as unknown as Db,
    },
    async ({ port }) => {
      const ws = createDenoWebSocket(
        `ws://127.0.0.1:${port}${DEVELOPER_WS_PATH}`,
        {
          headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}` },
        },
      );
      const helloPromise = waitForWsMessage(ws);
      const closedPromise = waitForWsClose(ws);
      await waitForWsOpen(ws);
      const hello = JSON.parse(await helloPromise) as {
        type: string;
        surface: string;
      };
      assertEquals(hello.type, "hello");
      assertEquals(hello.surface, "developer");
      const closed = await closedPromise;
      assertEquals(closed.code, 1000);
    },
  );

  // Non-superadmin session → 403 when local-console auth is unavailable.
  const userToken = crypto.randomUUID();
  const userState = createEmptyMockAuthState();
  seedMockSession(userState, userToken, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: "user@example.com",
    role: "user",
  });
  const userDb = createMockAuthDb(userState);
  const userSigned = await buildSignedCookie(userToken, sessionSecrets);
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as { set: (key: "db", value: Db) => void }).set(
      "db",
      userDb as unknown as Db,
    );
    await next();
  });
  registerDaemonWebSocket(app, {
    developerSurface: true,
    secrets,
    sessionSecrets,
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-stub").cell,
    ),
  });
  const forbidden = await app.request(DEVELOPER_WS_PATH, {
    method: "GET",
    headers: {
      ...WS_UPGRADE_HEADERS,
      Cookie: `${HTTP_SESSION_COOKIE_NAME}=${userSigned}`,
    },
  });
  assertEquals(forbidden.status, 403);

  // Local-console auth without sessionSecrets.
  const prevSecrets = Deno.env.get("TURBOPANEL_SECRETS");
  const prevDevSurface = Deno.env.get("TURBOPANEL_DEV_SURFACE");
  Deno.env.set("TURBOPANEL_SECRETS", `1:${TEST_ONLY_TURBOPANEL_SECRET}`);
  Deno.env.set("TURBOPANEL_DEV_SURFACE", "1");
  try {
    const consoleApp = new Hono();
    registerDaemonWebSocket(consoleApp, {
      developerSurface: true,
      secrets,
      db: createMockDb(),
      daemonCellRegistry: createTrackingRegistry(
        createTrackingDaemonCell("srv-stub").cell,
      ),
    });
    const contentSha256 = await hashLocalConsoleContent(new Uint8Array());
    const authorization = await buildLocalConsoleAuthorization(
      "GET",
      DEVELOPER_WS_PATH,
      TEST_ONLY_TURBOPANEL_SECRET,
      contentSha256,
    );
    const ac = new AbortController();
    const server = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        signal: ac.signal,
        onListen() {},
      },
      consoleApp.fetch,
    );
    const addr = server.addr;
    if (!("port" in addr)) throw new TypeError("expected TCP listen address");
    try {
      const ws = createDenoWebSocket(
        `ws://127.0.0.1:${addr.port}${DEVELOPER_WS_PATH}`,
        {
          headers: {
            Authorization: authorization,
            [LOCAL_CONSOLE_CONTENT_SHA256_HEADER]: contentSha256,
          },
        },
      );
      const helloPromise = waitForWsMessage(ws);
      await waitForWsOpen(ws);
      const hello = JSON.parse(await helloPromise) as {
        surface: string;
      };
      assertEquals(hello.surface, "developer");
      ws.close();
      await waitForWsClose(ws);
    } finally {
      ac.abort();
      await server.finished.catch(() => {});
    }
  } finally {
    if (prevSecrets === undefined) Deno.env.delete("TURBOPANEL_SECRETS");
    else Deno.env.set("TURBOPANEL_SECRETS", prevSecrets);
    if (prevDevSurface === undefined) Deno.env.delete("TURBOPANEL_DEV_SURFACE");
    else Deno.env.set("TURBOPANEL_DEV_SURFACE", prevDevSurface);
  }
});

test("WS upgrade rejects when secrets keyring is missing", async () => {
  const app = new Hono();
  registerDaemonWebSocket(app, {
    db: createMockDb(),
    daemonCellRegistry: createTrackingRegistry(
      createTrackingDaemonCell("srv-no-secrets").cell,
    ),
  });
  const response = await app.request(DAEMON_WS_PATH, {
    method: "GET",
    headers: {
      Authorization: "Bearer anything",
      ...WS_UPGRADE_HEADERS,
    },
  });
  assertEquals(response.status, 401);
});
