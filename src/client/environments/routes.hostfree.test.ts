/**
 * Host-free coverage for environment route authz short-circuits (no Postgres).
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import {
  environment,
  managed,
  project,
  repository,
  server,
} from "../../lib/db/schema.ts";
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
import { registerEnvironmentRoutes } from "./routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const environmentId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const otherOrgId = "44444444-4444-4444-8444-444444444444";
const serverId = "55555555-5555-4555-8555-555555555555";

const ENVIRONMENT_PATHS = [
  ["GET", "/environments"],
  ["POST", "/environments"],
  ["GET", `/environments/${environmentId}`],
  ["PATCH", `/environments/${environmentId}`],
  ["DELETE", `/environments/${environmentId}`],
] as const;

const ENV_ROW = {
  id: environmentId,
  name: "Staging",
  description: null,
  projectId,
  serverId: null,
  metadata: {},
  options: {},
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
};

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

async function buildApp(db: Db | undefined): Promise<Hono<AppEnv>> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    if (db) c.set("db", db);
    return next();
  });
  registerEnvironmentRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return app;
}

type SessionAppOpts = {
  manageAllowed: boolean;
  /** Seed an environment entity row so GET/:id reaches assertCanReadOr403. */
  withEnvironmentRow?: boolean;
  withManagedRow?: boolean;
  serverInOrg?: boolean;
  /** `null` makes resolveEntityOrganizationId miss. */
  entityOrgId?: string | null;
  /** GET /environments only hits listVisible — do not treat that as an org lookup. */
  listOnly?: boolean;
  listVisibleIds?: string[];
  systemOwned?: boolean;
  hierarchyDeleteHasChildren?: boolean;
  afterSession?: "drop-db" | "swallow-session";
};

async function buildSessionApp(opts: SessionAppOpts): Promise<{
  app: Hono<AppEnv>;
  cookie: string;
}> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const token = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `env-authz-${crypto.randomUUID()}@example.com`,
    role: "superadmin",
  });
  seedMockUser(state, {
    id: userId,
    email: `env-authz-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: "superadmin",
  });
  state.organizations.push({ id: organizationId, name: "Env Org" });

  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);

  const origTransaction = (
    authDb as unknown as {
      transaction: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown>;
    }
  ).transaction.bind(authDb);

  const db = Object.assign(authDb, {
    execute: () => {
      if (opts.listOnly) {
        return Promise.resolve(
          (opts.listVisibleIds ?? []).map((id) => ({ item_id: id })),
        );
      }
      if (opts.entityOrgId === null) return Promise.resolve([]);
      return Promise.resolve([{
        allowed: opts.manageAllowed,
        organization_id: opts.entityOrgId ?? organizationId,
        kind: opts.systemOwned ? "turbopanel" : "user",
      }]);
    },
    transaction: async (fn: (tx: Db) => Promise<unknown>) => {
      if (opts.hierarchyDeleteHasChildren) {
        const error = new Error("fk") as Error & { code: string };
        error.code = "23503";
        throw error;
      }
      return origTransaction(fn);
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (opts.withEnvironmentRow && table === environment) {
          return {
            where: () => ({
              limit: () => Promise.resolve([ENV_ROW]),
              orderBy: () => Promise.resolve([ENV_ROW]),
            }),
            orderBy: () => Promise.resolve([ENV_ROW]),
            innerJoin: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([{
                    projectId,
                    repositoryId: null,
                  }]),
              }),
            }),
          };
        }
        if (table === managed) {
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(
                  opts.withManagedRow ? [{ id: crypto.randomUUID() }] : [],
                ),
            }),
          };
        }
        if (table === repository) {
          return { where: () => Promise.resolve([]) };
        }
        if (table === project) {
          return {
            where: () => ({
              limit: () => Promise.resolve([{ repositoryId: null }]),
            }),
          };
        }
        if (table === server) {
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(
                  opts.serverInOrg ? [{ id: serverId }] : [],
                ),
            }),
          };
        }
        return origSelect(fields).from(table);
      },
    }),
  }) as unknown as Db;

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
      return next();
    });
  }
  registerEnvironmentRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return { app, cookie };
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

test("registerEnvironmentRoutes requires session secrets", () => {
  const app = new Hono<AppEnv>();
  let threw = false;
  try {
    registerEnvironmentRoutes(app, {
      runtime: "deno",
      signupEnvOverride: undefined,
    });
  } catch (error) {
    threw = true;
    assertEquals(error instanceof TypeError, true);
  }
  assertEquals(threw, true);
});

test("environment routes return 401 without a session cookie", async () => {
  const app = await buildApp({} as Db);
  for (const [method, path] of ENVIRONMENT_PATHS) {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "DELETE"
        ? undefined
        : JSON.stringify({ projectId: environmentId, name: "Staging" }),
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertEquals(await res.json(), { ok: false, error: "Unauthorized" });
  }
});

test("GET /environments returns 401 when db is missing", async () => {
  const app = await buildApp(undefined);
  const res = await app.request("/environments");
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { ok: false, error: "Unauthorized" });
});

test("PATCH /environments/:id returns 403 when organization:manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "Renamed" }),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { ok: false, error: "Forbidden" });
});

test("DELETE /environments/:id returns 403 when organization:manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { ok: false, error: "Forbidden" });
});

test("GET /environments/:id returns 403 when read/manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    withEnvironmentRow: true,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "GET",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "Forbidden" });
});

test("POST /environments returns 403 when create/manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request("/environments", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ projectId, name: "Staging" }),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "Forbidden" });
});

test("environment routes return 503 after session when db is dropped", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    afterSession: "drop-db",
  });
  for (const [method, path] of ENVIRONMENT_PATHS) {
    const res = await app.request(path, {
      method,
      headers: sessionHeaders(cookie, true),
      body: method === "GET" || method === "DELETE"
        ? undefined
        : JSON.stringify({ projectId, name: "Staging" }),
    });
    assertEquals(res.status, 503, `${method} ${path}`);
    assertEquals(await res.json(), { error: "Database unavailable" });
  }
});

test("environment routes return 401 after session is swallowed", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    afterSession: "swallow-session",
  });
  for (const [method, path] of ENVIRONMENT_PATHS) {
    const res = await app.request(path, {
      method,
      headers: sessionHeaders(cookie, true),
      body: method === "GET" || method === "DELETE"
        ? undefined
        : JSON.stringify({ projectId, name: "Staging" }),
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertEquals(await res.json(), { error: "Unauthorized" });
  }
});

test("GET /environments returns 400 without an organization header", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/environments", {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "organizationId required" });
});

test("GET /environments returns an empty list when nothing is visible", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    listOnly: true,
  });
  const res = await app.request("/environments", {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { environments: [] });
});

test("GET /environments returns serialized rows filtered by projectId", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withEnvironmentRow: true,
    listOnly: true,
    listVisibleIds: [environmentId],
  });
  const res = await app.request(
    `/environments?projectId=${projectId}`,
    { headers: sessionHeaders(cookie) },
  );
  assertEquals(res.status, 200);
  const body = await res.json() as { environments: Array<{ id: string }> };
  assertEquals(body.environments.length, 1);
  assertEquals(body.environments[0]?.id, environmentId);
});

test("GET /environments/:id returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /environments/:id returns 404 when the entity org lookup misses", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: null,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /environments/:id returns 404 when the row is missing", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/environments/${environmentId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /environments/:id returns the serialized environment", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withEnvironmentRow: true,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    environment: { id: string; name: string };
  };
  assertEquals(body.environment.id, environmentId);
  assertEquals(body.environment.name, "Staging");
});

test("POST /environments returns 400 when projectId is missing", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/environments", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "Staging" }),
  });
  assertEquals(res.status, 400);
});

test("POST /environments returns 400 for a non-string name", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/environments", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ projectId, name: 1 }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /environments returns 400 for invalid options jsonb", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/environments", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ projectId, name: "Staging", options: [] }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /environments returns 404 when the project is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request("/environments", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ projectId, name: "Staging" }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("POST /environments returns 404 when the project lookup misses", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: null,
  });
  const res = await app.request("/environments", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ projectId, name: "Staging" }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("POST /environments returns 400 for an invalid serverId shape", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/environments", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      projectId,
      name: "Staging",
      serverId: "not-a-uuid",
    }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /environments returns 404 when serverId is not in the org", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/environments", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      projectId,
      name: "Staging",
      serverId,
    }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("PATCH /environments/:id returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "Renamed" }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("PATCH /environments/:id returns 400 for a non-string name", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: 1 }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("PATCH /environments/:id returns 400 for invalid metadata", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ metadata: [] }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("PATCH /environments/:id returns 400 for invalid options", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withEnvironmentRow: true,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ options: [] }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("PATCH /environments/:id returns 400 for an invalid serverId shape", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ serverId: "not-a-uuid" }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("PATCH /environments/:id returns 404 when serverId is not in the org", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ serverId }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("PATCH /environments/:id returns 200 for a name-only update", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withEnvironmentRow: true,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "Renamed" }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("PATCH /environments/:id clears serverId when the body sends null", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withEnvironmentRow: true,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ serverId: null }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("DELETE /environments/:id returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("DELETE /environments/:id returns 409 when a managed engine is present", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withManagedRow: true,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 409);
  const body = await res.json() as { error: string };
  assertEquals(typeof body.error, "string");
});

test("GET /environments returns serialized rows without a project filter", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withEnvironmentRow: true,
    listOnly: true,
    listVisibleIds: [environmentId],
  });
  const res = await app.request("/environments", {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { environments: Array<{ id: string }> };
  assertEquals(body.environments.length, 1);
  assertEquals(body.environments[0]?.id, environmentId);
});

test("POST /environments returns 400 for invalid JSON", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/environments", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: "{not-json",
  });
  assertEquals(res.status, 400);
});

test("POST /environments returns 400 for invalid metadata jsonb", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/environments", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ projectId, name: "Staging", metadata: [] }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /environments returns 403 when the parent project is system-owned", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    systemOwned: true,
  });
  const res = await app.request("/environments", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ projectId, name: "Staging" }),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "system_resource_immutable" });
});

test("POST /environments returns 200 for a valid create", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/environments", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ projectId, name: "Staging" }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { ok: boolean; id: string };
  assertEquals(body.ok, true);
  assertEquals(typeof body.id, "string");
});

test("POST /environments returns 200 when serverId is in the org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    serverInOrg: true,
  });
  const res = await app.request("/environments", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ projectId, name: "Staging", serverId }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { ok: boolean; id: string };
  assertEquals(body.ok, true);
  assertEquals(typeof body.id, "string");
});

test("PATCH /environments/:id returns 404 when the entity org lookup misses", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: null,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "Renamed" }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("PATCH /environments/:id returns 403 when the environment is system-owned", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    systemOwned: true,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "Renamed" }),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "system_resource_immutable" });
});

test("PATCH /environments/:id returns 400 for invalid JSON", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: "{not-json",
  });
  assertEquals(res.status, 400);
});

test("PATCH /environments/:id returns 200 when serverId is in the org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withEnvironmentRow: true,
    serverInOrg: true,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ serverId }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("PATCH /environments/:id returns 200 for an options update", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withEnvironmentRow: true,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ options: { note: "overlay" } }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("DELETE /environments/:id returns 404 when the entity org lookup misses", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: null,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("DELETE /environments/:id returns 403 when the environment is system-owned", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    systemOwned: true,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "system_resource_immutable" });
});

test("DELETE /environments/:id returns 200 when teardown has nothing to reclaim", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("DELETE /environments/:id returns 409 when child resources still exist", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    hierarchyDeleteHasChildren: true,
  });
  const res = await app.request(`/environments/${environmentId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 409);
  const body = await res.json() as { error: string };
  assertEquals(typeof body.error, "string");
});
