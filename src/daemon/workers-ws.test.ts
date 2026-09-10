/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { deriveDaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import { parseSecretsEnv } from "../client/authn/secrets.ts";
import type { Db } from "../db.ts";
import type { AppEnv } from "../app.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import {
  buildWorkersDaemonCellForwardHeaders,
  registerWorkersDaemonWebSocket,
} from "./workers-ws.ts";
import { DAEMON_WS_PATH } from "../surfaces.ts";

const CELL_SERVER_ID_HEADER = "X-Turbopanel-Cell-Server-Id";
const CELL_GEO_HEADER = "X-Turbopanel-Cell-Geo";
const REAL_IP_HEADER = "X-Real-IP";

const TEST_SECRET = "aa_workers_ws_forward_test_secret_value_b_pad_abcdefghij0";

async function createTestSecrets() {
  return await deriveDaemonJwtKeyring(
    parseSecretsEnv(`1:${TEST_SECRET}`, "workers"),
  );
}

const mockLimit = () => Promise.resolve([]);
const mockWhere = () => ({ limit: mockLimit });
const mockFrom = () => ({ where: mockWhere });
const mockSelect = () => ({ from: mockFrom });

function createMockDb(): Db {
  return {
    select: mockSelect,
  } as unknown as Db;
}

async function issueTestToken(serverId: string): Promise<string> {
  const secrets = await createTestSecrets();
  const issued = await issueDaemonJwt(
    { sub: serverId, kid: crypto.randomUUID() },
    secrets,
  );
  return issued.token;
}

function createForwardCaptureEnv(): {
  env: CloudflareBindings;
  getForwardedRequest: () => Request | undefined;
  getByNameArg: () => string | undefined;
  getByNameOptions: () => { locationHint?: string } | undefined;
} {
  let forwardedRequest: Request | undefined;
  let byNameArg: string | undefined;
  let byNameOptions: { locationHint?: string } | undefined;

  const env = {
    DAEMON_CELL: {
      getByName: (name: string, options?: { locationHint?: string }) => {
        byNameArg = name;
        byNameOptions = options;
        return {
          fetch: (request: Request) => {
            forwardedRequest = request;
            return new Response("forwarded", { status: 200 });
          },
        };
      },
    },
  } as unknown as CloudflareBindings;

  return {
    env,
    getForwardedRequest: () => forwardedRequest,
    getByNameArg: () => byNameArg,
    getByNameOptions: () => byNameOptions,
  };
}

function createLocationHintDb(locationHint: string): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              { options: { cellLocationHint: locationHint }, metadata: null },
            ]),
        }),
      }),
    }),
  } as unknown as Db;
}

function createWorkersWsAppWithDb(
  secrets: Awaited<ReturnType<typeof createTestSecrets>>,
  db: Db,
) {
  const app = new Hono<{ Variables: AppEnv["Variables"]; Bindings: CloudflareBindings }>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  registerWorkersDaemonWebSocket(app as unknown as Hono, { secrets });
  return app;
}

function createWorkersWsApp(secrets: Awaited<ReturnType<typeof createTestSecrets>>) {
  const app = new Hono<{ Variables: AppEnv["Variables"]; Bindings: CloudflareBindings }>();
  app.use("*", async (c, next) => {
    c.set("db", createMockDb());
    await next();
  });
  registerWorkersDaemonWebSocket(app as unknown as Hono, { secrets });
  return app;
}

function createWorkersWsAppWithLimiter(
  secrets: Awaited<ReturnType<typeof createTestSecrets>>,
  connectLimiter: { limit: (args: { key: string }) => Promise<{ success: boolean }> },
) {
  const app = new Hono<{ Variables: AppEnv["Variables"]; Bindings: CloudflareBindings }>();
  app.use("*", async (c, next) => {
    c.set("db", createMockDb());
    await next();
  });
  registerWorkersDaemonWebSocket(app as unknown as Hono, { secrets, connectLimiter });
  return app;
}

describe("buildWorkersDaemonCellForwardHeaders", () => {
  it("applies trusted Cloudflare geo and CF-Connecting-IP instead of client values", () => {
    const serverId = "test-srv-ws-forward-trusted";
    const forgedGeo = JSON.stringify({
      country: "ZZ",
      city: "Forged City",
    });
    const trustedIp = "203.0.113.44";

    const headers = buildWorkersDaemonCellForwardHeaders(
      new Headers({
        [CELL_GEO_HEADER]: forgedGeo,
        [REAL_IP_HEADER]: "198.51.100.1",
        [CELL_SERVER_ID_HEADER]: "attacker-server",
      }),
      {
        serverId,
        cf: {
          country: "US",
          city: "Austin",
          region: "Texas",
          colo: "DFW",
        },
        cfConnectingIp: trustedIp,
      },
    );

    expect(headers.get(CELL_SERVER_ID_HEADER)).toBe(serverId);
    const forwardedGeo = headers.get(CELL_GEO_HEADER);
    expect(forwardedGeo).not.toBeNull();
    expect(forwardedGeo).not.toBe(forgedGeo);
    expect(JSON.parse(forwardedGeo!)).toMatchObject({
      country: "US",
      city: "Austin",
      region: "Texas",
      datacenter: "DFW",
    });
    expect(headers.get(REAL_IP_HEADER)).toBe(trustedIp);
  });
});

describe("registerWorkersDaemonWebSocket forwarding", () => {
  it("strips client-supplied geo and IP headers before forwarding to the Durable Object", async () => {
    const serverId = "test-srv-ws-forward-strip";
    const secrets = await createTestSecrets();
    const app = createWorkersWsApp(secrets);
    const token = await issueTestToken(serverId);
    const { env, getForwardedRequest, getByNameArg } = createForwardCaptureEnv();

    const forgedGeo = JSON.stringify({
      country: "ZZ",
      city: "Forged City",
    });

    const request = new Request(`https://instance.test${DAEMON_WS_PATH}`, {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${token}`,
        [CELL_SERVER_ID_HEADER]: "attacker-server",
        [CELL_GEO_HEADER]: forgedGeo,
        [REAL_IP_HEADER]: "198.51.100.1",
      },
    });

    await app.fetch(request, env);

    const forwarded = getForwardedRequest();
    expect(forwarded).toBeDefined();
    expect(forwarded!.headers.get(CELL_SERVER_ID_HEADER)).toBe(serverId);
    expect(forwarded!.headers.get(CELL_GEO_HEADER)).toBeNull();
    expect(forwarded!.headers.get(REAL_IP_HEADER)).toBeNull();
    expect(getByNameArg()).toBe(serverId);
  });

  it("returns 429 and never wakes the cell when connectLimiter denies", async () => {
    const serverId = "test-srv-ws-rate-limited";
    const secrets = await createTestSecrets();
    const app = createWorkersWsAppWithLimiter(secrets, {
      limit: () => Promise.resolve({ success: false }),
    });
    const token = await issueTestToken(serverId);
    const { env, getForwardedRequest, getByNameArg } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${token}`,
        },
      }),
      env,
    );

    expect(response.status).toBe(429);
    expect(getForwardedRequest()).toBeUndefined();
    expect(getByNameArg()).toBeUndefined();
  });

  it("returns 426 when Upgrade is not websocket", async () => {
    const secrets = await createTestSecrets();
    const app = createWorkersWsApp(secrets);
    const { env } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`),
      env,
    );

    expect(response.status).toBe(426);
  });

  it("returns 401 when Authorization is missing", async () => {
    const secrets = await createTestSecrets();
    const app = createWorkersWsApp(secrets);
    const { env } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`, {
        headers: { Upgrade: "websocket" },
      }),
      env,
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 when the daemon JWT is invalid", async () => {
    const secrets = await createTestSecrets();
    const app = createWorkersWsApp(secrets);
    const { env } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`, {
        headers: {
          Upgrade: "websocket",
          Authorization: "Bearer not-a-valid-jwt",
        },
      }),
      env,
    );

    expect(response.status).toBe(401);
  });

  it("returns 503 when the request db is unavailable", async () => {
    const secrets = await createTestSecrets();
    const app = new Hono<{ Variables: AppEnv["Variables"]; Bindings: CloudflareBindings }>();
    registerWorkersDaemonWebSocket(app as unknown as Hono, { secrets });
    const token = await issueTestToken("test-srv-ws-no-db");
    const { env } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${token}`,
        },
      }),
      env,
    );

    expect(response.status).toBe(503);
  });

  it("forwards to the cell when connectLimiter allows", async () => {
    const serverId = "test-srv-ws-rate-allowed";
    const secrets = await createTestSecrets();
    const app = createWorkersWsAppWithLimiter(secrets, {
      limit: () => Promise.resolve({ success: true }),
    });
    const token = await issueTestToken(serverId);
    const { env, getForwardedRequest, getByNameArg } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${token}`,
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(getForwardedRequest()).toBeDefined();
    expect(getByNameArg()).toBe(serverId);
  });

  it("passes a cell location hint on the first getByName call", async () => {
    const serverId = "test-srv-ws-location-hint";
    const secrets = await createTestSecrets();
    const app = createWorkersWsAppWithDb(secrets, createLocationHintDb("wnam"));
    const token = await issueTestToken(serverId);
    const { env, getByNameArg, getByNameOptions } = createForwardCaptureEnv();

    const response = await app.fetch(
      new Request(`https://instance.test${DAEMON_WS_PATH}`, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${token}`,
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(getByNameArg()).toBe(serverId);
    expect(getByNameOptions()).toEqual({ locationHint: "wnam" });
  });
});
