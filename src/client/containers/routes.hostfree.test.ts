/**
 * Host-free coverage for container route authz short-circuits (no Postgres).
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import type { DaemonCellRegistry } from "../../daemon/cell/contracts.ts";
import { container, server } from "../../lib/db/schema.ts";
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from "../authn/authn-hostfree-doubles.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../authn/crypto.ts";
import { deriveSecretsConfig } from "../authn/secrets.ts";
import { parseTestSecretsConfig } from "../../test-fixtures/secrets.ts";
import { ORG_ID_HEADER } from "../org-context.ts";
import { registerContainerRoutes } from "./routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const containerId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const serverId = "33333333-3333-4333-8333-333333333333";
const serviceId = "44444444-4444-4444-8444-444444444444";
const otherOrgId = "55555555-5555-4555-8555-555555555555";

const CONTAINER_PATHS = [
  ["GET", "/containers"],
  ["POST", "/containers"],
  ["GET", `/containers/${containerId}`],
  ["PATCH", `/containers/${containerId}`],
  ["DELETE", `/containers/${containerId}`],
  ["GET", `/containers/${containerId}/logs`],
] as const;

const CONTAINER_ROW = {
  id: containerId,
  serviceId,
  environmentId: "66666666-6666-4666-8666-666666666666",
  serverId,
  containerId: "aabbccddeeff",
  containerName: "web-1",
  status: "running",
  role: "service",
  composeServiceName: "web",
  ordinal: 1,
  metadata: null,
  options: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function thenableRows<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  return Object.assign(promise, {
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    orderBy: () => Promise.resolve(rows),
  });
}

function presenceRow(connected: boolean) {
  return {
    id: serverId,
    daemon: null,
    metadata: null,
    hostname: "host-1",
    machineKey: null,
    osId: null,
    osFamily: null,
    osVersion: null,
    osCodename: null,
    osPrettyName: null,
    osArchitecture: null,
    timezone: null,
    isTimeSyncEnabled: null,
    ntpServers: null,
    ntpLastSyncedAt: null,
    connected,
    statusChangedAt: "2024-01-01T00:00:00.000Z",
    organizationId,
  };
}

function dropDbAfterSession(db: Db) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    let dropDb = false;
    const origGet = c.get.bind(c);
    const origSet = c.set.bind(c);
    (c as unknown as { get: (key: string) => unknown }).get = (key: string) => {
      if (key === "db" && dropDb) return undefined;
      return origGet(key as never);
    };
    (c as unknown as { set: (key: string, value: unknown) => void }).set = (
      key: string,
      value: unknown,
    ) => {
      if (key === "session") dropDb = true;
      origSet(key as never, value as never);
    };
    origSet("db" as never, db as never);
    await next();
  };
}

function swallowSession(db: Db) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const origSet = c.set.bind(c);
    origSet("db" as never, db as never);
    (c as unknown as { set: (key: string, value: unknown) => void }).set = (
      key: string,
      value: unknown,
    ) => {
      if (key === "session") return;
      origSet(key as never, value as never);
    };
    await next();
  };
}

type SessionAppOpts = {
  manageAllowed: boolean;
  withContainerRow?: boolean;
  missingDockerId?: boolean;
  entityOrgId?: string | null;
  listOnly?: boolean;
  listVisibleIds?: string[];
  serverInOrg?: boolean;
  serverPresence?: "offline" | "online";
  systemOwned?: boolean;
  hierarchyDeleteHasChildren?: boolean;
  afterSession?: "drop-db" | "swallow-session";
};

async function buildSessionApp(opts: SessionAppOpts): Promise<{
  app: Hono<AppEnv>;
  cookie: string;
  cellRequests: { count: number };
}> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const token = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `container-logs-${crypto.randomUUID()}@example.com`,
    role: "superadmin",
  });
  seedMockUser(state, {
    id: userId,
    email: `container-logs-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: "superadmin",
  });
  state.organizations.push({ id: organizationId, name: "Container Org" });

  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);

  const row = opts.missingDockerId
    ? { ...CONTAINER_ROW, containerId: null }
    : CONTAINER_ROW;

  const origTransaction = (
    authDb as unknown as {
      transaction: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown>;
    }
  ).transaction.bind(authDb);

  const db = Object.assign(authDb, {
    execute: () => {
      if (opts.listOnly) {
        return Promise.resolve(
          (opts.listVisibleIds ?? []).map((itemId) => ({ item_id: itemId })),
        );
      }
      if (opts.entityOrgId === null) return Promise.resolve([]);
      return Promise.resolve([{
        allowed: opts.manageAllowed,
        organization_id: opts.entityOrgId ?? organizationId,
        kind: opts.systemOwned ? "turbopanel" : "user",
      }]);
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (opts.withContainerRow && table === container) {
          return {
            innerJoin: () => ({
              where: () => ({
                limit: () => Promise.resolve([row]),
                orderBy: () => Promise.resolve([row]),
              }),
            }),
            where: () => ({
              limit: () => Promise.resolve([row]),
              orderBy: () => Promise.resolve([row]),
            }),
          };
        }
        if (table === server) {
          if (opts.serverPresence) {
            return {
              where: () =>
                thenableRows([
                  presenceRow(opts.serverPresence === "online"),
                ]),
            };
          }
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(
                  opts.serverInOrg ? [{ organizationId }] : [],
                ),
            }),
          };
        }
        return origSelect(fields).from(table);
      },
    }),
    transaction: async (fn: (tx: Db) => Promise<unknown>) => {
      if (opts.hierarchyDeleteHasChildren) {
        const error = new Error("fk") as Error & { code: string };
        error.code = "23503";
        throw error;
      }
      return origTransaction(fn);
    },
  }) as unknown as Db;

  const cellRequests = { count: 0 };
  const registry = {
    getCell: () => ({
      createRequestAndWait: () => {
        cellRequests.count += 1;
        return Promise.resolve({
          status: "done",
          result: { logs: "line-1\nline-2" },
        });
      },
    }),
  } as unknown as DaemonCellRegistry;

  const signed = await buildSignedCookie(token, secrets);
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
  const app = new Hono<AppEnv>();
  if (opts.afterSession === "drop-db") {
    app.use("*", dropDbAfterSession(db));
  } else if (opts.afterSession === "swallow-session") {
    app.use("*", swallowSession(db));
  } else {
    app.use("*", (c, next) => {
      c.set("db", db);
      c.set("daemonCellRegistry", registry);
      return next();
    });
  }
  registerContainerRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return { app, cookie, cellRequests };
}

function sessionHeaders(
  cookie: string,
  contentType = false,
): Record<string, string> {
  const headers: Record<string, string> = {
    Cookie: cookie,
    [ORG_ID_HEADER]: organizationId,
  };
  if (contentType) headers["content-type"] = "application/json";
  return headers;
}

function mutationBody(method: string): string | undefined {
  if (method === "GET" || method === "DELETE") return undefined;
  return JSON.stringify({
    serviceId,
    serverId,
    containerId: "aabbccddeeff",
    containerName: "web-1",
    status: "running",
    composeServiceName: "web",
  });
}

test("GET /containers/:id/logs returns 403 without server read and does not enqueue", async () => {
  const { app, cookie, cellRequests } = await buildSessionApp({
    manageAllowed: false,
    withContainerRow: true,
  });
  const res = await app.request(`/containers/${containerId}/logs`, {
    method: "GET",
    headers: sessionHeaders(cookie),
  });

  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "Forbidden" });
  assertEquals(cellRequests.count, 0);
});

test("container routes return 401 without a session cookie", async () => {
  const { app } = await buildSessionApp({ manageAllowed: true });
  for (const [method, path] of CONTAINER_PATHS) {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: mutationBody(method),
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertEquals(await res.json(), { ok: false, error: "Unauthorized" });
  }
});

test("registerContainerRoutes requires session secrets", () => {
  const app = new Hono<AppEnv>();
  let threw = false;
  try {
    registerContainerRoutes(app, {
      runtime: "deno",
      signupEnvOverride: undefined,
    });
  } catch (error) {
    threw = true;
    assertEquals(error instanceof TypeError, true);
  }
  assertEquals(threw, true);
});

test("container routes return 503 after session when db is dropped", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    afterSession: "drop-db",
  });
  for (const [method, path] of CONTAINER_PATHS) {
    const res = await app.request(path, {
      method,
      headers: sessionHeaders(cookie, true),
      body: mutationBody(method),
    });
    assertEquals(res.status, 503, `${method} ${path}`);
    assertEquals(await res.json(), { error: "Database unavailable" });
  }
});

test("container routes return 401 after session is swallowed", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    afterSession: "swallow-session",
  });
  for (const [method, path] of CONTAINER_PATHS) {
    const res = await app.request(path, {
      method,
      headers: sessionHeaders(cookie, true),
      body: mutationBody(method),
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertEquals(await res.json(), { error: "Unauthorized" });
  }
});

test("GET /containers returns an empty list when nothing is visible", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    listOnly: true,
  });
  const res = await app.request("/containers", {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { containers: [] });
});

test("GET /containers/:id returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/containers/${containerId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /containers/:id returns 404 when the row is missing", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/containers/${containerId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /containers/:id returns the serialized container", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withContainerRow: true,
  });
  const res = await app.request(`/containers/${containerId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { container: { id: string } };
  assertEquals(body.container.id, containerId);
});

test("GET /containers/:id/logs returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/containers/${containerId}/logs`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /containers/:id/logs returns 404 when the row is missing", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/containers/${containerId}/logs`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /containers/:id/logs returns 409 when containerId is missing", async () => {
  const { app, cookie, cellRequests } = await buildSessionApp({
    manageAllowed: true,
    withContainerRow: true,
    missingDockerId: true,
  });
  const res = await app.request(`/containers/${containerId}/logs`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "container_id_unavailable" });
  assertEquals(cellRequests.count, 0);
});

test("POST /containers returns 400 when required fields are missing", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/containers", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 400);
});

test("POST /containers returns 404 when the service is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request("/containers", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: mutationBody("POST"),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("PATCH /containers/:id returns 403 when organization:manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request(`/containers/${containerId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ status: "exited" }),
  });
  assertEquals(res.status, 403);
});

test("PATCH /containers/:id returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/containers/${containerId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ status: "exited" }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("PATCH /containers/:id returns 200 for a status update", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/containers/${containerId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ status: "exited" }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("DELETE /containers/:id returns 403 when organization:manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request(`/containers/${containerId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 403);
});

test("DELETE /containers/:id returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/containers/${containerId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /containers returns serialized rows filtered by query params", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withContainerRow: true,
    listOnly: true,
    listVisibleIds: [containerId],
  });
  const res = await app.request(
    `/containers?serviceId=${serviceId}&serverId=${serverId}&status=running&environmentId=${CONTAINER_ROW.environmentId}&projectId=${CONTAINER_ROW.environmentId}`,
    { headers: sessionHeaders(cookie) },
  );
  assertEquals(res.status, 200);
  const body = await res.json() as { containers: Array<{ id: string }> };
  assertEquals(body.containers.length, 1);
  assertEquals(body.containers[0]?.id, containerId);
});

test("GET /containers/:id returns 403 when read is denied", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    withContainerRow: true,
  });
  const res = await app.request(`/containers/${containerId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "Forbidden" });
});

test("GET /containers/:id returns 404 when the entity org lookup misses", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: null,
  });
  const res = await app.request(`/containers/${containerId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("POST /containers returns 404 when the server is not in the org", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/containers", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: mutationBody("POST"),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("POST /containers returns 403 when create is denied", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    serverInOrg: true,
  });
  const res = await app.request("/containers", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: mutationBody("POST"),
  });
  assertEquals(res.status, 403);
});

test("POST /containers returns 403 when the service is system-owned", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    serverInOrg: true,
    systemOwned: true,
  });
  const res = await app.request("/containers", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: mutationBody("POST"),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "system_resource_immutable" });
});

test("POST /containers returns 200 for a valid create", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    serverInOrg: true,
  });
  const res = await app.request("/containers", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: mutationBody("POST"),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { ok: boolean; id: string };
  assertEquals(body.ok, true);
  assertEquals(typeof body.id, "string");
});

test("PATCH /containers/:id returns 400 for invalid fields", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/containers/${containerId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: 1 }),
  });
  assertEquals(res.status, 400);
});

test("PATCH /containers/:id returns 403 when the container is system-owned", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    systemOwned: true,
  });
  const res = await app.request(`/containers/${containerId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ status: "exited" }),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "system_resource_immutable" });
});

test("DELETE /containers/:id returns 403 when the container is system-owned", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    systemOwned: true,
  });
  const res = await app.request(`/containers/${containerId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "system_resource_immutable" });
});

test("DELETE /containers/:id returns 200 when the row can be removed", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/containers/${containerId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("DELETE /containers/:id returns 409 when child resources still exist", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    hierarchyDeleteHasChildren: true,
  });
  const res = await app.request(`/containers/${containerId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 409);
  const body = await res.json() as { error: string };
  assertEquals(typeof body.error, "string");
});

test("GET /containers/:id/logs returns 409 when the host is offline", async () => {
  const { app, cookie, cellRequests } = await buildSessionApp({
    manageAllowed: true,
    withContainerRow: true,
    serverPresence: "offline",
  });
  const res = await app.request(`/containers/${containerId}/logs`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "server_offline" });
  assertEquals(cellRequests.count, 0);
});

test("GET /containers/:id/logs returns the live tail when the host is online", async () => {
  const { app, cookie, cellRequests } = await buildSessionApp({
    manageAllowed: true,
    withContainerRow: true,
    serverPresence: "online",
  });
  const res = await app.request(`/containers/${containerId}/logs`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { logs: "line-1\nline-2" });
  assertEquals(cellRequests.count, 1);
});
