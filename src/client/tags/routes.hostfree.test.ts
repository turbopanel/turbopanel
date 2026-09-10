/**
 * Host-free coverage for tag route registration and behaviour (no Postgres).
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import { marker, tag } from "../../lib/db/schema.ts";
import { CLIENT_API_PREFIX } from "../../surfaces.ts";
import { parseTestSecretsConfig } from "../../test-fixtures/secrets.ts";
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
import { SYSTEM_RESOURCE_IMMUTABLE_ERROR } from "../authz/http.ts";
import { TAG_NAME_IN_USE_ERROR } from "../display-name-uniqueness.ts";
import { ORG_ID_HEADER } from "../org-context.ts";
import { registerClientRoutes } from "../routes.ts";
import { registerBillingRoutes } from "../billing/routes.ts";
import { registerTagRoutes } from "./routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const tagId = "11111111-1111-4111-8111-111111111111";
const createdTagId = "33333333-3333-4333-8333-333333333333";
const orgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherOrgId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const markerId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return {
    limit: () => promise,
    orderBy: () => thenableRows(rows),
    returning: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

function tagRecord(
  opts?: { id?: string; organizationId?: string; name?: string },
) {
  return {
    id: opts?.id ?? tagId,
    organizationId: opts?.organizationId ?? orgId,
    name: opts?.name ?? "prod",
    description: "live",
    color: "#3dd68c",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
}

function serializedTag(row = tagRecord()) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    description: row.description,
    color: row.color,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type TagSessionOpts = {
  executeQueue?: unknown[][];
  tagSelectQueue?: unknown[][];
  tagRows?: unknown[];
  markerRows?: unknown[];
  insertError?: unknown;
  createdId?: string;
};

async function buildApp(db: Db | undefined): Promise<{
  app: Hono<AppEnv>;
  cookie: string;
}> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    if (db) c.set("db", db);
    c.set("runtime", "deno");
    return next();
  });
  registerTagRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    "session-token",
    secrets,
  )}`;
  return { app, cookie };
}

function sessionRow() {
  return {
    sessionId: "sess-1",
    userId,
    email: "ops@example.com",
    role: "superadmin",
    isDisabled: false,
  };
}

function tagHttpDb(): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ role: "superadmin" }]),
        }),
        innerJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve([sessionRow()]),
          }),
        }),
      }),
    }),
    execute: () => Promise.resolve([{ allowed: true }]),
  } as unknown as Db;
}

function nextQueuedRows(
  queue: unknown[][] | undefined,
  fallback: unknown[],
): unknown[] {
  if (queue && queue.length > 0) {
    return queue.shift() ?? [];
  }
  return fallback;
}

function createTagRouteDb(opts: TagSessionOpts = {}): Db {
  const state = createEmptyMockAuthState();
  seedMockSession(state, "session-token", {
    sessionId: "sess-1",
    userId,
    email: "ops@example.com",
    role: "superadmin",
  });
  seedMockUser(state, {
    id: userId,
    email: "ops@example.com",
    isDisabled: false,
    isEmailVerified: true,
    role: "superadmin",
  });
  state.organizations.push({ id: orgId, name: "Tag Org" });

  const executeQueue = [...(opts.executeQueue ?? [])];
  const tagSelectQueue = opts.tagSelectQueue
    ? [...opts.tagSelectQueue]
    : undefined;
  const tagRows = opts.tagRows ?? [];
  const markerRows = opts.markerRows ?? [];
  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);
  const origInsert = (
    authDb as unknown as {
      insert: (
        table: unknown,
      ) => { values: (row: Record<string, unknown>) => unknown };
    }
  ).insert.bind(authDb);

  return Object.assign(authDb, {
    execute: () => {
      if (executeQueue.length > 0) {
        return Promise.resolve(executeQueue.shift() ?? []);
      }
      return Promise.resolve([{ allowed: true }]);
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === tag) {
          const rows = nextQueuedRows(tagSelectQueue, tagRows);
          return {
            where: () => thenableRows(rows),
            innerJoin: () => ({
              where: () => thenableRows(rows),
            }),
          };
        }
        if (table === marker) {
          return {
            where: () => thenableRows(markerRows),
            innerJoin: () => ({
              where: () =>
                thenableRows(tagRows.length > 0 ? tagRows : [tagRecord()]),
            }),
          };
        }
        return origSelect(fields).from(table);
      },
    }),
    insert: (table: unknown) => {
      if (table === tag || table === marker) {
        return {
          values: (_values: Record<string, unknown>) => {
            if (opts.insertError) throw opts.insertError;
            return {
              returning: () =>
                thenableRows([{ id: opts.createdId ?? createdTagId }]),
              onConflictDoNothing: () => Promise.resolve(),
            };
          },
        };
      }
      return origInsert(table);
    },
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
    delete: () => ({
      where: () => thenableRows([]),
    }),
  }) as unknown as Db;
}

async function buildSessionApp(opts: TagSessionOpts = {}): Promise<{
  app: Hono<AppEnv>;
  cookie: string;
}> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const db = createTagRouteDb(opts);
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("runtime", "deno");
    return next();
  });
  registerTagRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    "session-token",
    secrets,
  )}`;
  return { app, cookie };
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
    origSet("runtime" as never, "deno" as never);
    await next();
  };
}

function authHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: orgId,
    "content-type": "application/json",
  };
}

test("tag routes return 401 without a session cookie", async () => {
  const { app } = await buildApp({} as Db);
  const paths = [
    ["GET", "/tags"],
    ["GET", `/tags/${tagId}`],
    ["POST", "/tags"],
    ["PATCH", `/tags/${tagId}`],
    ["DELETE", `/tags/${tagId}`],
    ["GET", "/markers"],
    ["PUT", "/markers"],
  ] as const;

  for (const [method, path] of paths) {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "DELETE"
        ? undefined
        : JSON.stringify({}),
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertEquals(await res.json(), { ok: false, error: "Unauthorized" });
  }
});

test("GET /tags returns 401 when db is missing", async () => {
  const { app } = await buildApp(undefined);
  const res = await app.request("/tags");
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { ok: false, error: "Unauthorized" });
});

test("malformed tag and marker ids are rejected before UUID queries", async () => {
  const { app, cookie } = await buildApp(tagHttpDb());
  const headers = authHeaders(cookie);

  const tagPath = await app.request("/tags/not-a-uuid", { headers });
  assertEquals(tagPath.status, 404);
  assertEquals(await tagPath.json(), { error: "Not found" });

  const markersQuery = await app.request("/markers?tagId=not-a-uuid", {
    headers,
  });
  assertEquals(markersQuery.status, 400);
  assertEquals(await markersQuery.json(), { error: "Invalid request" });

  const markersPut = await app.request("/markers", {
    method: "PUT",
    headers,
    body: JSON.stringify({ projectId: "not-a-uuid", tagIds: [tagId] }),
  });
  assertEquals(markersPut.status, 400);
  assertEquals(await markersPut.json(), { error: "Invalid request" });
});

test("GET /tags lists organization tags after authentication", async () => {
  const { app, cookie } = await buildSessionApp({
    tagRows: [
      tagRecord({ id: "2", name: "zeta" }),
      tagRecord({ id: "1", name: "alpha" }),
    ],
  });
  const res = await app.request("/tags", { headers: authHeaders(cookie) });
  assertEquals(res.status, 200);
  const body = await res.json() as { tags: Array<{ name: string }> };
  assertEquals(body.tags.map((row) => row.name), ["alpha", "zeta"]);
});

test("GET /tags/:id returns the serialized tag", async () => {
  const row = tagRecord();
  const { app, cookie } = await buildSessionApp({ tagRows: [row] });
  const res = await app.request(`/tags/${tagId}`, {
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { tag: serializedTag(row) });
});

test("POST /tags creates a tag", async () => {
  const { app, cookie } = await buildSessionApp({
    tagSelectQueue: [[]],
    createdId: createdTagId,
  });
  const res = await app.request("/tags", {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify({
      name: "  prod  ",
      description: "live",
      color: "#3dd68c",
    }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, id: createdTagId });
});

test("PATCH /tags/:id updates a tag", async () => {
  const { app, cookie } = await buildSessionApp({
    tagSelectQueue: [[tagRecord()], []],
  });
  const res = await app.request(`/tags/${tagId}`, {
    method: "PATCH",
    headers: authHeaders(cookie),
    body: JSON.stringify({ name: "staging" }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("DELETE /tags/:id deletes a tag", async () => {
  const { app, cookie } = await buildSessionApp({ tagRows: [tagRecord()] });
  const res = await app.request(`/tags/${tagId}`, {
    method: "DELETE",
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("GET /markers lists markers for a tag", async () => {
  const { app, cookie } = await buildSessionApp({
    tagRows: [tagRecord()],
    markerRows: [{
      id: markerId,
      tagId,
      createdAt: "2020-01-01T00:00:00.000Z",
      projectId,
      serverId: null,
      workspaceId: null,
      environmentId: null,
      serviceId: null,
      datacenterId: null,
      storageId: null,
    }],
  });
  const res = await app.request(`/markers?tagId=${tagId}`, {
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    markers: [{
      id: markerId,
      tagId,
      createdAt: "2020-01-01T00:00:00.000Z",
      projectId,
    }],
  });
});

test("PUT /markers replaces tags on a parent entity", async () => {
  const { app, cookie } = await buildSessionApp({
    executeQueue: [
      [{ organization_id: orgId }],
      [{ allowed: true }],
      [{ kind: "user" }],
    ],
    tagSelectQueue: [[{ id: tagId }]],
    tagRows: [tagRecord()],
  });
  const res = await app.request("/markers", {
    method: "PUT",
    headers: authHeaders(cookie),
    body: JSON.stringify({ projectId, tagIds: [tagId] }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    ok: boolean;
    tags: Array<{ id: string; name: string }>;
  };
  assertEquals(body.ok, true);
  assertEquals(body.tags[0]?.id, tagId);
  assertEquals(body.tags[0]?.name, "prod");
});

test("POST /tags returns 409 when the display name is taken", async () => {
  const { app, cookie } = await buildSessionApp({
    tagSelectQueue: [[{ id: tagId }]],
  });
  const res = await app.request("/tags", {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify({ name: "prod" }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: TAG_NAME_IN_USE_ERROR });
});

test("GET /tags/:id returns 404 when the tag belongs to another org", async () => {
  const { app, cookie } = await buildSessionApp({
    tagRows: [tagRecord({ organizationId: otherOrgId })],
  });
  const res = await app.request(`/tags/${tagId}`, {
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("PUT /markers returns 404 when the parent is in another organization", async () => {
  const { app, cookie } = await buildSessionApp({
    executeQueue: [[{ organization_id: otherOrgId }]],
  });
  const res = await app.request("/markers", {
    method: "PUT",
    headers: authHeaders(cookie),
    body: JSON.stringify({ projectId, tagIds: [tagId] }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("PUT /markers returns 403 when the parent is system-owned", async () => {
  const { app, cookie } = await buildSessionApp({
    executeQueue: [
      [{ organization_id: orgId }],
      [{ allowed: true }],
      [{ kind: "turbopanel" }],
    ],
  });
  const res = await app.request("/markers", {
    method: "PUT",
    headers: authHeaders(cookie),
    body: JSON.stringify({ projectId, tagIds: [tagId] }),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: SYSTEM_RESOURCE_IMMUTABLE_ERROR });
});

test("GET /tags returns 503 when db is missing after authentication", async () => {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const db = createTagRouteDb();
  const app = new Hono<AppEnv>();
  app.use("*", dropDbAfterSession(db));
  registerTagRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    "session-token",
    secrets,
  )}`;
  const res = await app.request("/tags", { headers: authHeaders(cookie) });
  assertEquals(res.status, 503);
  assertEquals(await res.json(), { error: "Database unavailable" });
});

test("registerClientRoutes mounts tags and tasks under the client API prefix", async () => {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("runtime", "deno");
    return next();
  });
  registerClientRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });

  const tags = await app.request(`${CLIENT_API_PREFIX}/tags`);
  assertEquals(tags.status, 401);
  assertEquals(await tags.json(), { ok: false, error: "Unauthorized" });

  const tasks = await app.request(`${CLIENT_API_PREFIX}/tasks`);
  assertEquals(tasks.status, 401);
  assertEquals(await tasks.json(), { ok: false, error: "Unauthorized" });
});

test("registerClientRoutes mounts /billing on Workers only: self-hosted has no billing", async () => {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const build = (
    runtime: "deno" | "workers",
    registerBilling?: typeof registerBillingRoutes,
  ) => {
    const app = new Hono<AppEnv>();
    app.use("*", (c, next) => {
      c.set("runtime", runtime);
      return next();
    });
    registerClientRoutes(app, {
      secrets,
      runtime,
      signupEnvOverride: undefined,
      ...(registerBilling ? { registerBilling } : {}),
    });
    return app;
  };

  const deno = await build("deno").request(`${CLIENT_API_PREFIX}/billing/catalog`);
  assertEquals(deno.status, 404);

  const workersBare = await build("workers").request(
    `${CLIENT_API_PREFIX}/billing/catalog`,
  );
  assertEquals(workersBare.status, 404);

  const workers = await build("workers", registerBillingRoutes).request(
    `${CLIENT_API_PREFIX}/billing/catalog`,
  );
  assertEquals(workers.status, 401);
});
