/**
 * Host-free coverage for organization route create/PATCH/capacity error arms
 * (no Postgres).
 */

import { assertEquals, assertThrows } from "@std/assert";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import type { Db } from "../../db.ts";
import { fabric, network, organization, relay } from "../../lib/db/schema.ts";
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
import { registerOrganizationRoutes } from "./routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const orgId = "11111111-1111-4111-8111-111111111111";

const ORG_PATHS = [
  ["GET", "/organizations"],
  ["POST", "/organizations"],
  ["GET", `/organizations/${orgId}`],
  ["PATCH", `/organizations/${orgId}`],
  ["GET", `/organizations/${orgId}/default-timezone`],
  ["PUT", `/organizations/${orgId}/default-timezone`],
  ["GET", `/organizations/${orgId}/temperature-unit`],
  ["PUT", `/organizations/${orgId}/temperature-unit`],
  ["GET", `/organizations/${orgId}/host-defaults`],
  ["PUT", `/organizations/${orgId}/host-defaults`],
  ["GET", `/organizations/${orgId}/default-environment`],
  ["PUT", `/organizations/${orgId}/default-environment`],
  ["GET", `/organizations/${orgId}/server-capacity`],
  ["PUT", `/organizations/${orgId}/server-capacity`],
  ["GET", `/organizations/${orgId}/managed-defaults`],
  ["PUT", `/organizations/${orgId}/managed-defaults`],
  ["GET", `/organizations/${orgId}/principal-defaults`],
  ["PUT", `/organizations/${orgId}/principal-defaults`],
  ["GET", `/organizations/${orgId}/docker-networking`],
  ["PUT", `/organizations/${orgId}/docker-networking`],
  ["GET", "/timezones"],
] as const;

async function buildApp(db: Db | undefined): Promise<Hono<AppEnv>> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    if (db) c.set("db", db);
    return next();
  });
  registerOrganizationRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return app;
}

type SessionAppOpts = {
  manageAllowed: boolean;
  ownAllowed?: boolean;
  seedOrg?: boolean;
  orgOptions?: unknown;
  executeQueue?: unknown[][];
  afterSession?: "drop-db" | "swallow-session";
  /**
   * Org CIDR registry doubles for the collision authority: CIDR-bearing
   * `network` rows and the fabric row (no gateway relays).
   */
  registry?: {
    networks?: Array<{
      id: string;
      kind: string;
      cidr: string;
      datacenterId?: string | null;
    }>;
    fabric?: { id: string; cidr: string; options?: unknown };
  };
  /** Records every `db.update(...)` call so a refused PUT can prove it wrote nothing. */
  updates?: unknown[];
};

function registryRows<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), {
    where: () =>
      Object.assign(Promise.resolve(rows), {
        limit: () => Promise.resolve(rows),
      }),
  });
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

async function buildSessionApp(
  opts: SessionAppOpts,
): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const token = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `org-authz-${crypto.randomUUID()}@example.com`,
    role: "superadmin",
  });
  seedMockUser(state, {
    id: userId,
    email: `org-authz-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: "superadmin",
  });
  if (opts.seedOrg !== false) {
    state.organizations.push({ id: orgId, name: "Org Routes" });
  }

  const executeQueue = [...(opts.executeQueue ?? [])];
  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);
  const origUpdate = (
    authDb as unknown as { update: (table: unknown) => unknown }
  ).update.bind(authDb);

  const db = Object.assign(authDb, {
    update: (table: unknown) => {
      opts.updates?.push(table);
      return origUpdate(table);
    },
    execute: () => {
      if (executeQueue.length > 0) {
        return Promise.resolve(executeQueue.shift() ?? []);
      }
      // Default: manage checks first, then own when capacity PUT needs it.
      if (opts.ownAllowed === false) {
        return Promise.resolve([{ allowed: false }]);
      }
      return Promise.resolve([{ allowed: opts.manageAllowed }]);
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === organization && opts.seedOrg !== false) {
          const row = {
            id: orgId,
            name: "Org Routes",
            createdAt: "2020-01-01T00:00:00.000Z",
            options: opts.orgOptions ?? null,
          };
          const rows = [row];
          return Object.assign(Promise.resolve(rows), {
            where: () => ({
              limit: () => Promise.resolve(rows),
              orderBy: () => Promise.resolve(rows),
            }),
            orderBy: () => Promise.resolve(rows),
          });
        }
        if (table === organization && opts.seedOrg === false) {
          return Object.assign(Promise.resolve([]), {
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
            orderBy: () => Promise.resolve([]),
          });
        }
        if (opts.registry && table === network) {
          return registryRows(
            (opts.registry.networks ?? []).map((row) => ({
              id: row.id,
              kind: row.kind,
              cidr: row.cidr,
              datacenterId: row.datacenterId ?? null,
            })),
          );
        }
        if (opts.registry && table === fabric) {
          const row = opts.registry.fabric;
          return registryRows(
            row
              ? [{ id: row.id, cidr: row.cidr, options: row.options ?? null }]
              : [],
          );
        }
        if (opts.registry && table === relay) {
          return registryRows([]);
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
  registerOrganizationRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return { app, cookie };
}

test("organization routes return 401 without a session cookie", async () => {
  const app = await buildApp({} as Db);
  for (const [method, path] of ORG_PATHS) {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify({}),
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertEquals(await res.json(), { ok: false, error: "Unauthorized" });
  }
});

test("POST /organizations returns 400 for a control-character name", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/organizations", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "bad\nname" }),
  });
  assertEquals(res.status, 400);
});

test("GET /organizations lists orgs for a platform admin session", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/organizations", {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { organizations: Array<{ id: string }> };
  assertEquals(body.organizations.length, 1);
  assertEquals(body.organizations[0]?.id, orgId);
});

test("GET /organizations/:id returns 404 when the org row is missing", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    seedOrg: false,
  });
  const res = await app.request(`/organizations/${orgId}`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("PATCH /organizations/:id returns 403 when manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    executeQueue: [[{ allowed: false }]],
  });
  const res = await app.request(`/organizations/${orgId}`, {
    method: "PATCH",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Renamed" }),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "Forbidden" });
});

test("PATCH /organizations/:id returns 400 when name is missing", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}`, {
    method: "PATCH",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 400);
});

test("PATCH /organizations/:id returns 400 for an empty name", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}`, {
    method: "PATCH",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "" }),
  });
  assertEquals(res.status, 400);
});

test("PUT /host-defaults returns 400 for an invalid sshPort", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/host-defaults`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sshPort: 0 }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid sshPort" });
});

test("PUT /default-timezone returns 400 for an invalid timezone", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/default-timezone`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ defaultServerTimezone: "Not/AZone" }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid defaultServerTimezone" });
});

test("PUT /temperature-unit returns 400 for an invalid unit", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/temperature-unit`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ temperatureUnit: "kelvin" }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid temperatureUnit" });
});

test("GET /temperature-unit defaults to celsius when unset", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/temperature-unit`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { temperatureUnit: "celsius" });
});

test("PUT /default-environment returns 400 when the field is missing", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/default-environment`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 400);
});

test("GET /server-capacity returns 403 when manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    executeQueue: [[{ allowed: false }]],
  });
  const res = await app.request(`/organizations/${orgId}/server-capacity`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "Forbidden" });
});

test("PUT /server-capacity returns 403 when the caller is not an owner", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    ownAllowed: false,
    executeQueue: [[{ allowed: false }]],
  });
  const res = await app.request(`/organizations/${orgId}/server-capacity`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ maxServers: 3 }),
  });
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { ok: false, error: "Forbidden" });
});

test("PUT /server-capacity returns 400 for a non-integer maxServers", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    ownAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/server-capacity`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ maxServers: 1.5 }),
  });
  assertEquals(res.status, 400);
});

test("GET /timezones returns the timezone catalog for a signed-in session", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/timezones", {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { timezones: string[] };
  assertEquals(Array.isArray(body.timezones), true);
  assertEquals(body.timezones.length > 0, true);
});

test("registerOrganizationRoutes refuses to mount without session secrets", () => {
  assertThrows(
    () =>
      registerOrganizationRoutes(new Hono<AppEnv>(), {
        runtime: "deno",
        signupEnvOverride: undefined,
      } as AuthRouteOpts),
    TypeError,
    "session secrets are required for organization routes",
  );
});

test("organization routes return 503 when the db is dropped after session", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    afterSession: "drop-db",
  });
  const managedPaths = ORG_PATHS.filter(([method, path]) =>
    method === "GET" && path !== "/timezones"
  );
  for (const [method, path] of managedPaths) {
    const res = await app.request(path, {
      method,
      headers: { Cookie: cookie },
    });
    assertEquals(res.status, 503, `${method} ${path}`);
    assertEquals(await res.json(), { error: "Database unavailable" });
  }
});

test("GET /organizations returns 401 when the session is swallowed after auth", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    afterSession: "swallow-session",
  });
  const res = await app.request("/organizations", {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { error: "Unauthorized" });
});

test("GET /organizations/:id returns the organization record", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/organizations/${orgId}`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    organization: { id: string; name: string };
  };
  assertEquals(body.organization.id, orgId);
  assertEquals(body.organization.name, "Org Routes");
});

test("GET /default-timezone returns 404 when the org row is missing", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    seedOrg: false,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/default-timezone`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /default-timezone returns the stored timezone options", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
    orgOptions: { defaultServerTimezone: "America/New_York" },
  });
  const res = await app.request(`/organizations/${orgId}/default-timezone`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { defaultServerTimezone: string | null };
  assertEquals(body.defaultServerTimezone, "America/New_York");
});

test("PUT /default-timezone writes a valid timezone", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/default-timezone`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ defaultServerTimezone: "America/New_York" }),
  });
  assertEquals(res.status, 200);
});

test("GET /host-defaults returns the parsed host defaults", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
    orgOptions: { sshPort: 2222 },
  });
  const res = await app.request(`/organizations/${orgId}/host-defaults`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { sshPort: number | null };
  assertEquals(body.sshPort, 2222);
});

test("PUT /host-defaults writes a valid sshPort", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/host-defaults`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sshPort: 22 }),
  });
  assertEquals(res.status, 200);
});

test("PUT /temperature-unit writes a valid unit", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/temperature-unit`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ temperatureUnit: "fahrenheit" }),
  });
  assertEquals(res.status, 200);
});

test("GET /default-environment returns the stored name", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
    orgOptions: { defaultEnvironmentName: "production" },
  });
  const res = await app.request(`/organizations/${orgId}/default-environment`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { defaultEnvironmentName: string | null };
  assertEquals(body.defaultEnvironmentName, "production");
});

test("PUT /default-environment writes a valid name", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/default-environment`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ defaultEnvironmentName: "staging" }),
  });
  assertEquals(res.status, 200);
});

test("GET /server-capacity returns unlimited seats when maxServers is unset", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/server-capacity`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { maxServers: number | null };
  assertEquals(body.maxServers, null);
});

test("PUT /server-capacity writes a numeric cap", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    ownAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/server-capacity`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ maxServers: 3 }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { ok: boolean; maxServers: number | null };
  assertEquals(body.ok, true);
});

test("GET /managed-defaults returns the organization defaults", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/managed-defaults`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
});

test("PUT /managed-defaults writes a valid sslMode", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/managed-defaults`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sslMode: "require" }),
  });
  assertEquals(res.status, 200);
});

test("GET /principal-defaults returns the effective username policy", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/principal-defaults`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    randomizedUsernames: boolean | null;
    effectiveRandomizedUsernames: boolean;
  };
  assertEquals(body.effectiveRandomizedUsernames, true);
});

test("PUT /principal-defaults writes a boolean override", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/principal-defaults`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ randomizedUsernames: false }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    ok: boolean;
    randomizedUsernames: boolean;
    effectiveRandomizedUsernames: boolean;
  };
  assertEquals(body.ok, true);
  assertEquals(body.randomizedUsernames, false);
  assertEquals(body.effectiveRandomizedUsernames, false);
});

test("PUT /principal-defaults returns 400 when randomizedUsernames is not a boolean", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/principal-defaults`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ randomizedUsernames: "yes" }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("GET /docker-networking returns empty pools and a null bip when unconfigured", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const res = await app.request(`/organizations/${orgId}/docker-networking`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { addressPools: [], defaultBridgeCidr: null });
});

test("GET /docker-networking echoes the stored organization.options.docker", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
    orgOptions: {
      docker: {
        addressPools: [{ base: "10.200.0.0/16", size: 24 }],
        defaultBridgeCidr: "172.17.0.1/16",
      },
    },
  });
  const res = await app.request(`/organizations/${orgId}/docker-networking`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    addressPools: [{ base: "10.200.0.0/16", size: 24 }],
    defaultBridgeCidr: "172.17.0.1/16",
  });
});

test("PUT /docker-networking rejects malformed bodies with 400 before touching the registry", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  });
  const put = (body: unknown) =>
    app.request(`/organizations/${orgId}/docker-networking`, {
      method: "PUT",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  for (
    const [body, error] of [
      [{}, "Invalid request"],
      [{ addressPools: "10.0.0.0/8" }, "Invalid addressPools"],
      [{ addressPools: [{ base: "nope", size: 24 }] }, "Invalid addressPools base (entry 0)"],
      [
        { addressPools: [{ base: "10.0.0.0/8", size: 4 }] },
        "Invalid addressPools size (integer between the base prefix and /30) (entry 0)",
      ],
      [
        { addressPools: [{ base: "10.0.0.0/8", size: 24 }, { base: "10.1.0.0/16", size: 24 }] },
        "addressPools entries overlap each other (entry 1)",
      ],
      [
        { defaultBridgeCidr: "172.17.0.0/16" },
        "Invalid defaultBridgeCidr (host address with prefix, e.g. 172.17.0.1/16)",
      ],
    ] as const
  ) {
    const res = await put(body);
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(await res.json(), { error });
  }
});

test("PUT /docker-networking refuses a defaultBridgeCidr inside a reserved range without writing", async () => {
  const updates: unknown[] = [];
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
    registry: {
      networks: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "reserved",
        cidr: "172.17.0.0/16",
      }],
    },
    updates,
  });
  const res = await app.request(`/organizations/${orgId}/docker-networking`, {
    method: "PUT",
    headers: { Cookie: cookie, "content-type": "application/json" },
    body: JSON.stringify({ defaultBridgeCidr: "172.17.0.1/16" }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "cidr_overlaps_reserved",
    cidr: "172.17.0.0/16",
    conflictingCidr: "172.17.0.0/16",
    networkId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assertEquals(updates, []);
});

test("PUT /docker-networking refuses a defaultBridgeCidr inside one of the submitted pools without writing", async () => {
  const updates: unknown[] = [];
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    registry: {},
    updates,
  });
  const put = (body: unknown) =>
    app.request(`/organizations/${orgId}/docker-networking`, {
      method: "PUT",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // Both halves are new, so the registry (which skips the stored docker
  // config) cannot catch this pair — the route compares them itself.
  const res = await put({
    addressPools: [
      { base: "10.200.0.0/16", size: 24 },
      { base: "172.26.0.0/16", size: 24 },
    ],
    defaultBridgeCidr: "172.26.4.1/24",
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "cidr_overlaps_docker_network",
    cidr: "172.26.4.0/24",
    conflictingCidr: "172.26.0.0/16",
  });
  assertEquals(updates, []);

  // A disjoint bridge stores alongside the same pools.
  const ok = await put({
    addressPools: [
      { base: "10.200.0.0/16", size: 24 },
      { base: "172.26.0.0/16", size: 24 },
    ],
    defaultBridgeCidr: "172.27.0.1/16",
  });
  assertEquals(ok.status, 200);
  assertEquals(await ok.json(), {
    ok: true,
    addressPools: [
      { base: "10.200.0.0/16", size: 24 },
      { base: "172.26.0.0/16", size: 24 },
    ],
    defaultBridgeCidr: "172.27.0.1/16",
  });
  assertEquals(updates, [organization]);
});

test("PUT /docker-networking may re-range over the stored bridge and pools it replaces", async () => {
  const updates: unknown[] = [];
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    registry: {},
    orgOptions: {
      docker: {
        addressPools: [{ base: "10.200.0.0/16", size: 24 }],
        defaultBridgeCidr: "172.26.0.1/16",
      },
    },
    updates,
  });
  // The new pool covers the old bridge network and the new bridge sits in
  // the old pool: both are being replaced, so neither is a collision.
  const res = await app.request(`/organizations/${orgId}/docker-networking`, {
    method: "PUT",
    headers: { Cookie: cookie, "content-type": "application/json" },
    body: JSON.stringify({
      addressPools: [{ base: "172.26.0.0/16", size: 24 }],
      defaultBridgeCidr: "10.200.0.1/16",
    }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    ok: true,
    addressPools: [{ base: "172.26.0.0/16", size: 24 }],
    defaultBridgeCidr: "10.200.0.1/16",
  });
  assertEquals(updates, [organization]);
});

test("PUT /docker-networking refuses a defaultBridgeCidr inside the fabric host range or container pool", async () => {
  const updates: unknown[] = [];
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    registry: {
      fabric: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        cidr: "10.250.0.0/16",
        options: { containerPool: "10.192.0.0/12" },
      },
    },
    updates,
  });
  const put = (defaultBridgeCidr: string) =>
    app.request(`/organizations/${orgId}/docker-networking`, {
      method: "PUT",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ defaultBridgeCidr }),
    });

  // The bip names a host; the aligned network is what collides.
  const host = await put("10.250.4.1/24");
  assertEquals(host.status, 409);
  assertEquals(await host.json(), {
    error: "cidr_overlaps_fabric",
    cidr: "10.250.4.0/24",
    conflictingCidr: "10.250.0.0/16",
  });

  const pool = await put("10.200.0.1/16");
  assertEquals(pool.status, 409);
  assertEquals(await pool.json(), {
    error: "cidr_overlaps_fabric_pool",
    cidr: "10.200.0.0/16",
    conflictingCidr: "10.192.0.0/12",
  });
  assertEquals(updates, []);

  // A bridge that clears the registry is stored.
  const ok = await put("172.17.0.1/16");
  assertEquals(ok.status, 200);
  assertEquals(await ok.json(), {
    ok: true,
    addressPools: [],
    defaultBridgeCidr: "172.17.0.1/16",
  });
  assertEquals(updates, [organization]);
});
