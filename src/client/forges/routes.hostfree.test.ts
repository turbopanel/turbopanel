/**
 * Host-free coverage for the client forge route wrappers (no Postgres).
 *
 * Handlers are covered in `handlers.hostfree.test.ts`. This suite drives the
 * shared session/org/manage `resolve` gate and each mounted method so the
 * router itself is no longer an uncovered shell.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import { forge, setting } from "../../lib/db/schema.ts";
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
import { registerForgeRoutes } from "./routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_TOKEN = "session-token";
const NOW = "2026-03-01T00:00:00.000Z";

function jsonOf(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) {
    throw new TypeError("expected a JSON object");
  }
  return body as Record<string, unknown>;
}

function appRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: APP_ID,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: null,
    options: null,
    organizationId: ORG_ID,
    provider: "github",
    name: "TurboPanel",
    baseUrl: "https://github.com",
    apiUrl: null,
    externalAppId: "1234",
    appSlug: "turbo",
    clientId: "Iv1.abc",
    redirectUri: null,
    webhookOrigin: null,
    isPublic: false,
    customGitUser: null,
    customGitPort: null,
    syncedAt: null,
    envelopes: {},
    webhookRef: "ref-1",
    webhookTokenHash: null,
    ...overrides,
  };
}

type RouteDbOpts = {
  allowed?: boolean;
  appRows?: Record<string, unknown>[];
  publicUrls?: string[];
};

function createRouteDb(opts: RouteDbOpts = {}): Db {
  const state = createEmptyMockAuthState();
  seedMockSession(state, SESSION_TOKEN, {
    sessionId: "sess-1",
    userId: USER_ID,
    email: "ops@example.com",
    role: "superadmin",
  });
  seedMockUser(state, {
    id: USER_ID,
    email: "ops@example.com",
    isDisabled: false,
    isEmailVerified: true,
    role: "superadmin",
  });
  state.organizations.push({ id: ORG_ID, name: "Forge Org" });

  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);

  const appRows = opts.appRows ?? [appRow()];
  return Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: opts.allowed ?? true }]),
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === setting) {
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(
                  opts.publicUrls === undefined
                    ? []
                    : [{ value: opts.publicUrls }],
                ),
            }),
          };
        }
        if (table === forge) {
          const projected = fields !== undefined;
          const visible = appRows.map((row) => ({
            id: String(row.id),
            organizationId: (row.organizationId ?? null) as string | null,
          }));
          return {
            where: () => ({
              limit: () => Promise.resolve(projected ? visible : appRows),
              orderBy: () => Promise.resolve(appRows),
            }),
            orderBy: () => Promise.resolve(appRows),
          };
        }
        return origSelect(fields).from(table);
      },
    }),
  }) as unknown as Db;
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

async function buildApp(
  db: Db | undefined,
  middleware?: (c: Context<AppEnv>, next: () => Promise<void>) => Promise<void>,
): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  if (middleware) {
    app.use("*", middleware);
  } else {
    app.use("*", (c, next) => {
      if (db) c.set("db", db);
      c.set("runtime", "deno");
      c.set("secretsConfig", secretsConfig);
      return next();
    });
  }
  registerForgeRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    SESSION_TOKEN,
    secrets,
  )}`;
  return { app, cookie };
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

function authHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: ORG_ID,
    "content-type": "application/json",
  };
}

test("registerForgeRoutes refuses to mount without session secrets", () => {
  assertThrows(
    () =>
      registerForgeRoutes(new Hono<AppEnv>(), {
        runtime: "deno",
        signupEnvOverride: undefined,
      }),
    TypeError,
    "session secrets are required for git app routes",
  );
});

test("forge routes return 401 without a session cookie", async () => {
  const { app } = await buildApp(createRouteDb());
  const paths = [
    ["GET", "/forges"],
    ["POST", "/forges"],
    ["POST", "/forges/github/manifest"],
    ["GET", "/forges/github/manifest/callback"],
    ["POST", `/forges/${APP_ID}/sync`],
    ["GET", `/forges/${APP_ID}`],
    ["PATCH", `/forges/${APP_ID}`],
    ["DELETE", `/forges/${APP_ID}`],
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

test("GET /forges returns 503 when the db is dropped after session", async () => {
  const db = createRouteDb();
  const { app, cookie } = await buildApp(db, dropDbAfterSession(db));
  const res = await app.request("/forges", { headers: authHeaders(cookie) });
  assertEquals(res.status, 503);
  assertEquals(await res.json(), { error: "Database unavailable" });
});

test("GET /forges returns 401 when the session is swallowed after auth", async () => {
  const db = createRouteDb();
  const { app, cookie } = await buildApp(db, swallowSession(db));
  const res = await app.request("/forges", { headers: authHeaders(cookie) });
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { error: "Unauthorized" });
});

test("GET /forges requires an organization id", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await app.request("/forges", {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "organizationId required" });
});

test("GET /forges returns 403 when manage is denied", async () => {
  const { app, cookie } = await buildApp(createRouteDb({ allowed: false }));
  const res = await app.request("/forges", { headers: authHeaders(cookie) });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "Forbidden" });
});

test("GET /forges lists visible apps after the manage gate", async () => {
  const { app, cookie } = await buildApp(createRouteDb({
    publicUrls: ["https://panel.example.com"],
  }));
  const res = await app.request("/forges", { headers: authHeaders(cookie) });
  assertEquals(res.status, 200);
  const body = jsonOf(await res.json());
  const apps = body.apps;
  if (!Array.isArray(apps) || apps[0] === undefined) {
    throw new TypeError("expected apps[]");
  }
  assertEquals((apps[0] as Record<string, unknown>).id, APP_ID);
});

test("POST /forges reaches create after resolve and requires encryption", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await app.request("/forges", {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify({ name: "x" }),
  });
  assertEquals(res.status, 503);
  const body = jsonOf(await res.json());
  assertEquals(body.error, "Encryption unavailable");
});

test("POST /forges/github/manifest reaches the wizard after resolve", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await app.request("/forges/github/manifest", {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify({ name: "Acme Panel" }),
  });
  assertEquals(res.status, 503);
  const body = jsonOf(await res.json());
  assertEquals(body.error, "public_url_not_configured");
});

test("GET /forges/:id returns the serialized app after resolve", async () => {
  const { app, cookie } = await buildApp(createRouteDb({
    publicUrls: ["https://panel.example.com"],
  }));
  const res = await app.request(`/forges/${APP_ID}`, {
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = jsonOf(await res.json());
  const listed = body.app;
  if (typeof listed !== "object" || listed === null) {
    throw new TypeError("expected app");
  }
  assertEquals((listed as Record<string, unknown>).id, APP_ID);
});

test("GET /forges/github/manifest/callback reaches complete after resolve", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await app.request("/forges/github/manifest/callback", {
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 302);
  assertEquals(
    res.headers.get("location"),
    `/${ORG_ID}/projects/git-sources?error=unavailable`,
  );
});

test("GET /forges/:id returns 404 for a non-uuid after resolve", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await app.request("/forges/not-a-uuid", {
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 404);
});

test("POST /forges/:id/sync returns 404 for a non-uuid after resolve", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await app.request("/forges/not-a-uuid/sync", {
    method: "POST",
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 404);
});

test("PATCH /forges/:id returns 404 for a non-uuid after resolve", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await app.request("/forges/not-a-uuid", {
    method: "PATCH",
    headers: authHeaders(cookie),
    body: JSON.stringify({ name: "Renamed" }),
  });
  assertEquals(res.status, 404);
});

test("DELETE /forges/:id returns 404 for a non-uuid after resolve", async () => {
  const { app, cookie } = await buildApp(createRouteDb());
  const res = await app.request("/forges/not-a-uuid", {
    method: "DELETE",
    headers: authHeaders(cookie),
  });
  assertEquals(res.status, 404);
});
