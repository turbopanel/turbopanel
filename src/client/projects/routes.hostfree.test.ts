/**
 * Host-free coverage for project route authz short-circuits (no Postgres).
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import {
  container,
  environment,
  managed,
  project,
  repository,
  server,
  service,
  workspace,
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
import { registerProjectRoutes } from "./routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const projectId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const otherOrgId = "44444444-4444-4444-8444-444444444444";
const moveWorkspaceId = "55555555-5555-4555-8555-555555555555";
const repositoryId = "66666666-6666-4666-8666-666666666666";
const defaultServerId = "77777777-7777-4777-8777-777777777777";
const serviceId = "88888888-8888-4888-8888-888888888888";
const envId = "99999999-9999-4999-8999-999999999999";

const PROJECT_PATHS = [
  ["GET", "/project-catalog"],
  ["GET", "/projects"],
  ["POST", "/projects"],
  ["GET", `/projects/${projectId}`],
  ["PATCH", `/projects/${projectId}`],
  ["DELETE", `/projects/${projectId}`],
  ["POST", `/projects/${projectId}/configure`],
] as const;

const PROJECT_ROW = {
  id: projectId,
  name: "App",
  description: null,
  workspaceId,
  repositoryId: null,
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

type SessionAppOpts = {
  manageAllowed: boolean;
  withProjectRow?: boolean;
  entityOrgId?: string | null;
  listOnly?: boolean;
  listVisibleIds?: string[];
  missingWorkspace?: boolean;
  systemOwnedWorkspace?: boolean;
  nameTaken?: boolean;
  withManagedRuntime?: boolean;
  moveWorkspace?: boolean;
  withRepository?: boolean;
  serverInOrg?: boolean;
  withRunningService?: boolean;
  afterSession?: "drop-db" | "swallow-session";
};

function thenableRows<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  return Object.assign(promise, {
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    orderBy: () => Promise.resolve(rows),
  });
}

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
    email: `project-authz-${crypto.randomUUID()}@example.com`,
    role: "superadmin",
  });
  seedMockUser(state, {
    id: userId,
    email: `project-authz-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: "superadmin",
  });
  state.organizations.push({ id: organizationId, name: "Project Org" });

  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);

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
        kind: "user",
      }]);
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === project) {
          const rows = opts.withProjectRow || opts.nameTaken
            ? [PROJECT_ROW]
            : [];
          return {
            where: () => ({
              limit: () => Promise.resolve(rows),
              orderBy: () => Promise.resolve(rows),
            }),
            orderBy: () => Promise.resolve(rows),
            innerJoin: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve(opts.nameTaken ? [PROJECT_ROW] : []),
              }),
            }),
          };
        }
        if (table === workspace) {
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(
                  opts.missingWorkspace ? [] : [{
                    id: opts.moveWorkspace ? moveWorkspaceId : workspaceId,
                    kind: opts.systemOwnedWorkspace ? "turbopanel" : "user",
                  }],
                ),
            }),
          };
        }
        if (table === repository) {
          return {
            where: () =>
              thenableRows(
                opts.withRepository ? [{ id: repositoryId }] : [],
              ),
          };
        }
        if (table === environment) {
          const rows = opts.withManagedRuntime || opts.withRunningService
            ? [{
              id: envId,
              projectId,
              serverId: null,
              name: "Production",
              description: null,
            }]
            : [];
          return { where: () => thenableRows(rows) };
        }
        if (table === managed) {
          const rows = opts.withManagedRuntime
            ? [{ id: crypto.randomUUID() }]
            : [];
          return { where: () => thenableRows(rows) };
        }
        if (table === service) {
          return {
            where: () =>
              thenableRows(
                opts.withRunningService ? [{ id: serviceId }] : [],
              ),
          };
        }
        if (table === container) {
          return {
            where: () =>
              thenableRows(
                opts.withRunningService
                  ? [{
                    id: crypto.randomUUID(),
                    status: "running",
                    role: "service",
                  }]
                  : [],
              ),
          };
        }
        if (table === server) {
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(
                  opts.serverInOrg
                    ? [{ id: defaultServerId, organizationId }]
                    : [],
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
  registerProjectRoutes(app, {
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

function mutationBody(method: string, path: string): string | undefined {
  if (method === "GET" || method === "DELETE") return undefined;
  if (path.endsWith("/configure")) {
    return JSON.stringify({ type: "empty" });
  }
  return JSON.stringify({
    workspaceId,
    name: "App",
    type: "empty",
  });
}

test("registerProjectRoutes requires session secrets", () => {
  const app = new Hono<AppEnv>();
  let threw = false;
  try {
    registerProjectRoutes(app, {
      runtime: "deno",
      signupEnvOverride: undefined,
    });
  } catch (error) {
    threw = true;
    assertEquals(error instanceof TypeError, true);
  }
  assertEquals(threw, true);
});

test("project routes return 401 without a session cookie", async () => {
  const { app } = await buildSessionApp({ manageAllowed: true });
  for (const [method, path] of PROJECT_PATHS) {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: mutationBody(method, path),
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertEquals(await res.json(), { ok: false, error: "Unauthorized" });
  }
});

test("project routes return 503 after session when db is dropped", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    afterSession: "drop-db",
  });
  for (const [method, path] of PROJECT_PATHS) {
    if (path === "/project-catalog") continue;
    const res = await app.request(path, {
      method,
      headers: sessionHeaders(cookie, true),
      body: mutationBody(method, path),
    });
    assertEquals(res.status, 503, `${method} ${path}`);
    assertEquals(await res.json(), { error: "Database unavailable" });
  }
});

test("project routes return 401 after session is swallowed", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    afterSession: "swallow-session",
  });
  for (const [method, path] of PROJECT_PATHS) {
    const res = await app.request(path, {
      method,
      headers: sessionHeaders(cookie, true),
      body: mutationBody(method, path),
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertEquals(await res.json(), { error: "Unauthorized" });
  }
});

test("GET /project-catalog returns the catalog for a signed-in session", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/project-catalog", {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { catalog: unknown[] };
  assertEquals(Array.isArray(body.catalog), true);
});

test("GET /projects returns an empty list when nothing is visible", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    listOnly: true,
  });
  const res = await app.request("/projects", {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { projects: [] });
});

test("GET /projects/:id returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/projects/${projectId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /projects/:id returns 404 when the row is missing", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/projects/${projectId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /projects/:id returns the project row", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withProjectRow: true,
  });
  const res = await app.request(`/projects/${projectId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { project: { id: string } };
  assertEquals(body.project.id, projectId);
});

test("POST /projects returns 400 for an invalid type", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/projects", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ workspaceId, name: "App", type: "not-a-type" }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /projects/:id/configure returns 404 when the project is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/projects/${projectId}/configure`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ type: "empty" }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("PATCH /projects/:id returns 403 when organization:manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request(`/projects/${projectId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "Renamed" }),
  });
  assertEquals(res.status, 403);
});

test("PATCH /projects/:id returns 404 when the project is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/projects/${projectId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "Renamed" }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("DELETE /projects/:id returns 404 when the project is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/projects/${projectId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /projects returns serialized rows filtered by workspaceId", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withProjectRow: true,
    listOnly: true,
    listVisibleIds: [projectId],
  });
  const res = await app.request(`/projects?workspaceId=${workspaceId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { projects: Array<{ id: string }> };
  assertEquals(body.projects.length, 1);
  assertEquals(body.projects[0]?.id, projectId);
});

test("GET /projects/:id returns 403 when read is denied", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    withProjectRow: true,
  });
  const res = await app.request(`/projects/${projectId}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "Forbidden" });
});

test("POST /projects returns 400 when workspaceId is missing", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/projects", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "App", type: "empty" }),
  });
  assertEquals(res.status, 400);
});

test("POST /projects returns 404 when the workspace is missing", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    missingWorkspace: true,
  });
  const res = await app.request("/projects", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ workspaceId, name: "App", type: "empty" }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("POST /projects returns 403 when create is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request("/projects", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ workspaceId, name: "App", type: "empty" }),
  });
  assertEquals(res.status, 403);
});

test("POST /projects returns 403 when the workspace is system-owned", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    systemOwnedWorkspace: true,
  });
  const res = await app.request("/projects", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ workspaceId, name: "App", type: "empty" }),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "system_resource_immutable" });
});

test("POST /projects returns 400 when a template is missing its code", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/projects", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ workspaceId, name: "App", type: "template" }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /projects returns 400 for an unknown catalog code", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/projects", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      workspaceId,
      name: "App",
      type: "template",
      code: "not-a-catalog-code",
    }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Unknown catalog code" });
});

test("POST /projects returns 409 when the display name is taken", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    nameTaken: true,
  });
  const res = await app.request("/projects", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ workspaceId, name: "App", type: "empty" }),
  });
  assertEquals(res.status, 409);
  const body = await res.json() as { error: string };
  assertEquals(typeof body.error, "string");
});

test("POST /projects returns 200 for an empty project", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/projects", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ workspaceId, name: "App", type: "empty" }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { ok: boolean; id: string };
  assertEquals(body.ok, true);
  assertEquals(typeof body.id, "string");
});

test("POST /projects/:id/configure returns 403 when manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request(`/projects/${projectId}/configure`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ type: "docker-compose" }),
  });
  assertEquals(res.status, 403);
});

test("POST /projects/:id/configure returns 400 for an invalid type", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/projects/${projectId}/configure`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ type: "empty" }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("PATCH /projects/:id returns 400 for a non-string name", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/projects/${projectId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: 1 }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("PATCH /projects/:id returns 409 when the display name is taken", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    nameTaken: true,
  });
  const res = await app.request(`/projects/${projectId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "Taken" }),
  });
  assertEquals(res.status, 409);
  const body = await res.json() as { error: string };
  assertEquals(typeof body.error, "string");
});

test("PATCH /projects/:id returns 200 for a name-only update", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/projects/${projectId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "Renamed" }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("DELETE /projects/:id returns 403 when manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request(`/projects/${projectId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 403);
});

test("DELETE /projects/:id returns 409 when a managed engine is present", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withManagedRuntime: true,
  });
  const res = await app.request(`/projects/${projectId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 409);
  const body = await res.json() as { error: string };
  assertEquals(typeof body.error, "string");
});

test("DELETE /projects/:id returns 200 when the cascade is empty", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/projects/${projectId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("POST /projects returns 200 for a docker-compose project", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/projects", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      workspaceId,
      name: "Compose",
      type: "docker-compose",
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { ok: boolean; id: string };
  assertEquals(body.ok, true);
  assertEquals(typeof body.id, "string");
});

test("POST /projects/:id/configure returns 200 for docker-compose", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withProjectRow: true,
  });
  const res = await app.request(`/projects/${projectId}/configure`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ type: "docker-compose" }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { ok: boolean; alreadyConfigured: boolean };
  assertEquals(body.ok, true);
  assertEquals(body.alreadyConfigured, false);
});

test("PATCH /projects/:id returns 200 when moving to another workspace", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    moveWorkspace: true,
  });
  const res = await app.request(`/projects/${projectId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ workspaceId: moveWorkspaceId }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("PATCH /projects/:id returns 200 when rebinding a repository", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withRepository: true,
  });
  const res = await app.request(`/projects/${projectId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ repositoryId }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("PATCH /projects/:id returns 200 when setting defaultServerId", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    serverInOrg: true,
  });
  const res = await app.request(`/projects/${projectId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ options: { defaultServerId } }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("DELETE /projects/:id returns 409 when a service container is running", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withRunningService: true,
  });
  const res = await app.request(`/projects/${projectId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "project_has_running_services" });
});
