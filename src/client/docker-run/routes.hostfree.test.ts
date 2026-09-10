/**
 * Host-free coverage for POST /docker-run/import (no Postgres).
 *
 * The importer is pure compute after the session/org/create gates; the
 * success and 422 paths run the real lexer rather than a stub.
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import type { Db } from "../../db.ts";
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
import { ORG_ID_HEADER } from "../org-context.ts";
import { registerDockerRunRoutes } from "./routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROJECT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SESSION_TOKEN = "session-token";

type RouteDbOpts = {
  role?: "superadmin" | "user";
  allowed?: boolean;
  executeQueue?: Array<Record<string, unknown>[]>;
};

function jsonOf(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) {
    throw new TypeError("expected a JSON object");
  }
  return body as Record<string, unknown>;
}

function createRouteDb(opts: RouteDbOpts = {}): Db {
  const state = createEmptyMockAuthState();
  seedMockSession(state, SESSION_TOKEN, {
    sessionId: "sess-1",
    userId: USER_ID,
    email: "ops@example.com",
    role: opts.role ?? "superadmin",
  });
  seedMockUser(state, {
    id: USER_ID,
    email: "ops@example.com",
    isDisabled: false,
    isEmailVerified: true,
    role: opts.role ?? "superadmin",
  });
  state.organizations.push({ id: ORG_ID, name: "Import Org" });

  const executeQueue = [...(opts.executeQueue ?? [])];
  return Object.assign(createMockAuthDb(state), {
    execute: () => {
      if (executeQueue.length > 0) {
        return Promise.resolve(executeQueue.shift() ?? []);
      }
      return Promise.resolve([{
        allowed: opts.allowed ?? true,
        organization_id: ORG_ID,
      }]);
    },
  }) as unknown as Db;
}

async function secrets() {
  return await deriveSecretsConfig(
    parseTestSecretsConfig("deno"),
    "session-signing",
  );
}

async function signedCookie(
  derived: Awaited<ReturnType<typeof deriveSecretsConfig>>,
): Promise<string> {
  return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    SESSION_TOKEN,
    derived,
  )}`;
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

function swallowSession(db: Db) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const origSet = c.set.bind(c);
    origSet("db" as never, db as never);
    origSet("runtime" as never, "deno" as never);
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

async function buildApp(
  db: Db | undefined,
  middleware?: (c: Context<AppEnv>, next: () => Promise<void>) => Promise<void>,
): Promise<{
  app: Hono<AppEnv>;
  cookie: string;
}> {
  const derived = await secrets();
  const app = new Hono<AppEnv>();
  if (middleware) {
    app.use("*", middleware);
  } else {
    app.use("*", (c, next) => {
      if (db) c.set("db", db);
      c.set("runtime", "deno");
      return next();
    });
  }
  registerDockerRunRoutes(app, {
    secrets: derived,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return { app, cookie: await signedCookie(derived) };
}

function authHeaders(
  cookie: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: ORG_ID,
    "content-type": "application/json",
    ...extra,
  };
}

function importRequest(
  app: Hono<AppEnv>,
  headers: Record<string, string>,
  body: string | Record<string, unknown>,
): Promise<Response> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return Promise.resolve(app.request("/docker-run/import", {
    method: "POST",
    headers,
    body: payload,
  }));
}

test("registerDockerRunRoutes requires session secrets", () => {
  const router = new Hono<AppEnv>();
  let thrown = false;
  try {
    registerDockerRunRoutes(router, {} as AuthRouteOpts);
  } catch (err) {
    thrown = err instanceof TypeError &&
      err.message === "session secrets are required for docker-run routes";
  }
  assertEquals(thrown, true);
});

test("registerDockerRunRoutes mounts the import path when secrets are present", async () => {
  const router = new Hono<AppEnv>();
  registerDockerRunRoutes(router, {
    secrets: await secrets(),
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  const paths = router.routes.map((route) => route.path);
  assertEquals(paths.includes("/docker-run/import"), true);
});

test("POST /docker-run/import returns 401 without a session cookie", async () => {
  const { app } = await buildApp(createRouteDb());
  const res = await importRequest(app, { "content-type": "application/json" }, {
    serviceName: "web",
    argv: "docker run nginx",
  });
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { ok: false, error: "Unauthorized" });
});

test("POST /docker-run/import returns 503 when the db is dropped after session", async () => {
  const db = createRouteDb();
  const { app, cookie } = await buildApp(db, dropDbAfterSession(db));
  const res = await importRequest(app, authHeaders(cookie), {
    serviceName: "web",
    argv: "docker run nginx",
  });
  assertEquals(res.status, 503);
  assertEquals(await res.json(), { error: "Database unavailable" });
});

test("POST /docker-run/import returns 401 when the session is swallowed after auth", async () => {
  const db = createRouteDb();
  const { app, cookie } = await buildApp(db, swallowSession(db));
  const res = await importRequest(app, authHeaders(cookie), {
    serviceName: "web",
    argv: "docker run nginx",
  });
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { error: "Unauthorized" });
});

test("POST /docker-run/import requires an organization id", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await importRequest(app, {
    Cookie: cookie,
    "content-type": "application/json",
  }, {
    serviceName: "web",
    argv: "docker run nginx",
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "organizationId required" });
});

test("POST /docker-run/import forbids a user without org access", async () => {
  const { app, cookie } = await buildApp(createRouteDb({
    role: "user",
    allowed: false,
  }));
  const res = await importRequest(app, authHeaders(cookie), {
    serviceName: "web",
    argv: "docker run nginx",
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "Forbidden" });
});

test("POST /docker-run/import rejects malformed JSON", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await importRequest(app, authHeaders(cookie), "{");
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /docker-run/import rejects a body that is not an object", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await importRequest(app, authHeaders(cookie), "[]");
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /docker-run/import rejects a malformed importer body", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await importRequest(app, authHeaders(cookie), {
    serviceName: "has space",
    argv: "docker run nginx",
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /docker-run/import answers 404 when the project is in another org", async () => {
  const { app, cookie } = await buildApp(createRouteDb({
    executeQueue: [[{ organization_id: OTHER_ORG_ID }]],
  }));
  const res = await importRequest(app, authHeaders(cookie), {
    serviceName: "web",
    argv: "docker run nginx",
    projectId: PROJECT_ID,
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("POST /docker-run/import answers 403 when create on the project is denied", async () => {
  const { app, cookie } = await buildApp(createRouteDb({
    executeQueue: [[{ organization_id: ORG_ID }], [{ allowed: false }]],
  }));
  const res = await importRequest(app, authHeaders(cookie), {
    serviceName: "web",
    argv: "docker run nginx",
    projectId: PROJECT_ID,
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "Forbidden" });
});

test("POST /docker-run/import answers 422 when a blocking diagnostic is present", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await importRequest(app, authHeaders(cookie), {
    serviceName: "web",
    argv: "docker run --rm nginx:alpine",
  });
  assertEquals(res.status, 422);
  const body = jsonOf(await res.json());
  assertEquals(body.error, "docker_run_unsupported");
  const diagnostics = body.diagnostics;
  if (!Array.isArray(diagnostics)) {
    throw new TypeError("expected diagnostics[]");
  }
  assertEquals(
    diagnostics.some((row) =>
      typeof row === "object" && row !== null &&
      (row as { blocking?: boolean }).blocking === true
    ),
    true,
  );
});

test("POST /docker-run/import returns a compose fragment for a valid paste", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await importRequest(app, authHeaders(cookie), {
    serviceName: "web",
    argv: "docker run nginx:alpine",
  });
  assertEquals(res.status, 200);
  const body = jsonOf(await res.json());
  assertEquals(body.ok, true);
  assertEquals(body.image, "nginx:alpine");
  assertEquals(Array.isArray(body.diagnostics), true);
  assertEquals(Array.isArray(body.riskFlags), true);
  assertEquals(Array.isArray(body.composeIssues), true);
  const compose = body.compose;
  if (typeof compose !== "object" || compose === null) {
    throw new TypeError("expected compose");
  }
});

test("POST /docker-run/import accepts argv as a token array and a project id", async () => {
  const { app, cookie } = await buildApp(createRouteDb({
    executeQueue: [[{ organization_id: ORG_ID }], [{ allowed: true }]],
  }));
  const res = await importRequest(app, authHeaders(cookie), {
    serviceName: "api",
    argv: ["docker", "run", "nginx:alpine"],
    projectId: PROJECT_ID,
  });
  assertEquals(res.status, 200);
  const body = jsonOf(await res.json());
  assertEquals(body.ok, true);
  assertEquals(body.image, "nginx:alpine");
});
