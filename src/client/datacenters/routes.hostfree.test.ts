/**
 * Host-free coverage for datacenter route authz short-circuits (no Postgres).
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import {
  datacenter,
  fabric,
  ip,
  network,
  relay,
  server,
} from "../../lib/db/schema.ts";
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
import { registerDatacenterRoutes } from "./routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const id = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const serverId = "33333333-3333-4333-8333-333333333333";
const networkId = "44444444-4444-4444-8444-444444444444";
const otherOrgId = "55555555-5555-4555-8555-555555555555";
const otherDatacenterId = "66666666-6666-4666-8666-666666666666";
const MEMBER_ADDRESS = "10.0.0.10";
const MEMBER_CIDR = "10.0.0.0/24";
const SERVER_MEMBER_META = {
  ips: [{
    address: MEMBER_ADDRESS,
    version: 4,
    scope: "private",
    cidr: MEMBER_CIDR,
  }],
};

const DATACENTER_PATHS = [
  ["GET", "/datacenters"],
  ["POST", "/datacenters"],
  ["GET", "/datacenters/name-suggestions"],
  ["GET", `/datacenters/${id}`],
  ["PATCH", `/datacenters/${id}`],
  ["DELETE", `/datacenters/${id}`],
  ["POST", `/datacenters/${id}/members`],
  ["DELETE", `/datacenters/${id}/members/${serverId}`],
  ["POST", `/datacenters/${id}/subnets`],
  ["PATCH", `/datacenters/${id}/subnets/${networkId}`],
  ["DELETE", `/datacenters/${id}/subnets/${networkId}`],
] as const;

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

async function buildApp(): Promise<Hono<AppEnv>> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", {} as Db);
    return next();
  });
  registerDatacenterRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return app;
}

const DC_ROW = {
  id,
  name: "Site",
  description: null,
  organizationId,
  metadata: {},
  options: {},
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
};

function thenableRows<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  return Object.assign(promise, {
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    orderBy: () => Promise.resolve(rows),
    groupBy: () => Promise.resolve(rows),
    returning: () => Promise.resolve(rows),
  });
}

type SessionAppOpts = {
  manageAllowed: boolean;
  entityOrgId?: string | null;
  listOnly?: boolean;
  manageThenList?: boolean;
  listVisibleIds?: string[];
  withDatacenterRow?: boolean;
  siteNetworkPresent?: boolean;
  subnetHasMembers?: boolean;
  datacenterHasMembers?: boolean;
  datacenterHasForeignNetworks?: boolean;
  deleteMemberFound?: boolean;
  overlappingCidrs?: boolean;
  visibleMemberServers?: boolean;
  orgOverlapFromOtherSite?: boolean;
  memberAddressInUse?: boolean;
  /** Stored `datacenter.options` jsonb for the seeded row (default `{}`). */
  datacenterOptions?: Record<string, unknown> | null;
  /**
   * Raw rows the collision authority (`src/lib/net/cidr-collisions.ts`) sees
   * for the given table — every `select().from(<table>)` returns them
   * verbatim, conditions ignored. Overrides the scenario flags above.
   */
  networkRows?: Record<string, unknown>[];
  fabricRows?: Record<string, unknown>[];
  relayRows?: Record<string, unknown>[];
  ipRows?: Record<string, unknown>[];
  afterSession?: "drop-db" | "swallow-session";
};

async function buildSessionApp(opts: SessionAppOpts): Promise<{
  app: Hono<AppEnv>;
  cookie: string;
  /** Every `db.update(...).set(patch)` payload the routes issued, in order. */
  updates: Record<string, unknown>[];
}> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const token = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `dc-authz-${crypto.randomUUID()}@example.com`,
    role: "superadmin",
  });
  seedMockUser(state, {
    id: userId,
    email: `dc-authz-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: "superadmin",
  });
  state.organizations.push({ id: organizationId, name: "DC Org" });

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
  let executePhase = 0;
  let datacenterSelects = 0;
  const updates: Record<string, unknown>[] = [];
  const db = Object.assign(authDb, {
    execute: () => {
      if (opts.listOnly) {
        executePhase += 1;
        if (opts.manageThenList && executePhase === 1) {
          return Promise.resolve([{ allowed: opts.manageAllowed }]);
        }
        return Promise.resolve(
          (opts.listVisibleIds ?? []).map((itemId) => ({ item_id: itemId })),
        );
      }
      if (opts.entityOrgId === null) return Promise.resolve([]);
      return Promise.resolve([{
        allowed: opts.manageAllowed,
        organization_id: opts.entityOrgId ?? organizationId,
        item_id: opts.visibleMemberServers ? serverId : undefined,
      }]);
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === network && opts.networkRows) {
          return { where: () => thenableRows(opts.networkRows ?? []) };
        }
        if (table === fabric && opts.fabricRows) {
          return { where: () => thenableRows(opts.fabricRows ?? []) };
        }
        if (table === relay && opts.relayRows) {
          return { where: () => thenableRows(opts.relayRows ?? []) };
        }
        if (table === ip && opts.ipRows) {
          return { where: () => thenableRows(opts.ipRows ?? []) };
        }
        if (table === datacenter) {
          return {
            where: () => {
              datacenterSelects += 1;
              if (opts.entityOrgId === null) return thenableRows([]);
              const org = opts.entityOrgId ?? organizationId;
              const row = {
                ...DC_ROW,
                organizationId: org,
                ...(opts.datacenterOptions !== undefined
                  ? { options: opts.datacenterOptions }
                  : {}),
              };
              if (org !== organizationId) return thenableRows([row]);
              if (datacenterSelects === 1) return thenableRows([row]);
              return thenableRows(opts.withDatacenterRow ? [row] : []);
            },
          };
        }
        if (table === server) {
          return {
            where: () =>
              thenableRows(
                opts.visibleMemberServers
                  ? [{ id: serverId, metadata: SERVER_MEMBER_META }]
                  : [],
              ),
          };
        }
        if (table === network) {
          if (opts.orgOverlapFromOtherSite) {
            return {
              where: () =>
                thenableRows([{
                  id: networkId,
                  datacenterId: otherDatacenterId,
                  cidr: MEMBER_CIDR,
                  name: "other-lan",
                  kind: "datacenter",
                }]),
            };
          }
          if (opts.overlappingCidrs) {
            return {
              where: () =>
                thenableRows([{
                  id: networkId,
                  datacenterId: otherDatacenterId,
                  cidr: "10.0.0.0/24",
                  name: "other-lan",
                  kind: "datacenter",
                }]),
            };
          }
          if (opts.datacenterHasForeignNetworks) {
            return {
              where: () => thenableRows([{ id: networkId, kind: "compose" }]),
            };
          }
          return {
            where: () =>
              thenableRows(
                opts.siteNetworkPresent
                  ? [{
                    id: networkId,
                    datacenterId: id,
                    cidr: "10.0.0.0/24",
                    name: "lan",
                    kind: "datacenter",
                  }]
                  : [],
              ),
          };
        }
        if (table === ip) {
          const rows = opts.subnetHasMembers || opts.datacenterHasMembers
            ? [{
              id: "66666666-6666-4666-8666-666666666666",
              ipId: "66666666-6666-4666-8666-666666666666",
              serverId,
              datacenterId: id,
              networkId,
              address: "10.0.0.10",
              networkId2: networkId,
              memberCount: 1,
            }]
            : [];
          return { where: () => thenableRows(rows) };
        }
        return origSelect(fields).from(table);
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          updates.push(patch);
          return thenableRows([]);
        },
      }),
    }),
    delete: () => ({
      where: () =>
        thenableRows(
          opts.deleteMemberFound ? [{ id: crypto.randomUUID() }] : [],
        ),
    }),
    transaction: async (fn: (tx: Db) => Promise<unknown>) => {
      if (opts.memberAddressInUse) {
        const error = new Error(
          'duplicate key value violates unique constraint "uniq_ip_org_address"',
        ) as Error & { code: string };
        error.code = "23505";
        throw error;
      }
      return origTransaction(fn);
    },
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
  registerDatacenterRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return { app, cookie, updates };
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
  if (path.includes("/members")) {
    return JSON.stringify({
      members: [{ serverId, address: "203.0.113.10" }],
    });
  }
  if (path.includes("/subnets")) {
    return JSON.stringify({ cidr: "10.0.0.0/24" });
  }
  return JSON.stringify({ name: "dc" });
}

test("datacenter routes return 401 without a session cookie", async () => {
  const app = await buildApp();
  for (const [method, path] of DATACENTER_PATHS) {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: mutationBody(method, path),
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertEquals(await res.json(), { ok: false, error: "Unauthorized" });
  }
});

test("datacenter routes return 503 after session when db is dropped", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    afterSession: "drop-db",
  });
  for (const [method, path] of DATACENTER_PATHS) {
    const res = await app.request(path, {
      method,
      headers: sessionHeaders(cookie, true),
      body: mutationBody(method, path),
    });
    assertEquals(res.status, 503, `${method} ${path}`);
    assertEquals(await res.json(), { error: "Database unavailable" });
  }
});

test("datacenter routes return 401 after session is swallowed", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    afterSession: "swallow-session",
  });
  for (const [method, path] of DATACENTER_PATHS) {
    const res = await app.request(path, {
      method,
      headers: sessionHeaders(cookie, true),
      body: mutationBody(method, path),
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertEquals(await res.json(), { error: "Unauthorized" });
  }
});

test("GET /datacenters returns 403 when organization:manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request("/datacenters", {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 403);
});

test("GET /datacenters returns an empty list when nothing is visible", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    listOnly: true,
    manageThenList: true,
  });
  const res = await app.request("/datacenters", {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { datacenters: [] });
});

test("GET /datacenters/:id returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/datacenters/${id}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("POST /datacenters returns 400 for a non-string name", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/datacenters", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: 1 }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /datacenters returns 400 for invalid members", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/datacenters", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "dc", members: "nope" }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /datacenters returns 400 for invalid metadata", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/datacenters", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "dc", metadata: [] }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("registerDatacenterRoutes requires session secrets", () => {
  const app = new Hono<AppEnv>();
  let threw = false;
  try {
    registerDatacenterRoutes(app, {
      runtime: "deno",
      signupEnvOverride: undefined,
    });
  } catch (error) {
    threw = true;
    assertEquals(error instanceof TypeError, true);
  }
  assertEquals(threw, true);
});

test("GET /datacenters/name-suggestions returns 403 when manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request("/datacenters/name-suggestions", {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 403);
});

test("GET /datacenters/name-suggestions returns 400 for an invalid limit", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/datacenters/name-suggestions?limit=99", {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("GET /datacenters/name-suggestions returns an empty list when nothing is visible", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    listOnly: true,
    manageThenList: true,
  });
  const res = await app.request("/datacenters/name-suggestions", {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { suggestions: [] });
});

test("GET /datacenters/:id returns 403 when read is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request(`/datacenters/${id}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 403);
});

test("GET /datacenters/:id returns 404 when the row is missing", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/datacenters/${id}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /datacenters/:id returns the serialized datacenter", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withDatacenterRow: true,
  });
  const res = await app.request(`/datacenters/${id}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    datacenter: { id: string };
    members: unknown[];
  };
  assertEquals(body.datacenter.id, id);
  assertEquals(Array.isArray(body.members), true);
});

test("GET /datacenters/:id applies default priority and trusted when options are empty", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withDatacenterRow: true,
    datacenterOptions: null,
  });
  const res = await app.request(`/datacenters/${id}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    datacenter: { options: unknown; priority: number; trusted: boolean };
  };
  assertEquals(body.datacenter.options, null);
  assertEquals(body.datacenter.priority, 100);
  assertEquals(body.datacenter.trusted, true);
});

test("GET /datacenters/:id surfaces stored priority and trusted from options", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    withDatacenterRow: true,
    datacenterOptions: { priority: 10, trusted: false },
  });
  const res = await app.request(`/datacenters/${id}`, {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    datacenter: { priority: number; trusted: boolean };
  };
  assertEquals(body.datacenter.priority, 10);
  assertEquals(body.datacenter.trusted, false);
});

test("GET /datacenters includes effective priority and trusted per row", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    listOnly: true,
    manageThenList: true,
    listVisibleIds: [id],
    datacenterOptions: { priority: 5, trusted: false },
  });
  const res = await app.request("/datacenters", {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    datacenters: Array<
      { id: string; privateCidrs: string[]; priority: number; trusted: boolean }
    >;
  };
  assertEquals(body.datacenters.length, 1);
  assertEquals(body.datacenters[0]?.id, id);
  assertEquals(body.datacenters[0]?.privateCidrs, []);
  assertEquals(body.datacenters[0]?.priority, 5);
  assertEquals(body.datacenters[0]?.trusted, false);
});

test("GET /datacenters defaults priority and trusted when options omit them", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    listOnly: true,
    manageThenList: true,
    listVisibleIds: [id],
    datacenterOptions: { addressPreference: "ipv4" },
  });
  const res = await app.request("/datacenters", {
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    datacenters: Array<{ priority: number; trusted: boolean }>;
  };
  assertEquals(body.datacenters[0]?.priority, 100);
  assertEquals(body.datacenters[0]?.trusted, true);
});

test("POST /datacenters returns 403 when create is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request("/datacenters", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "dc" }),
  });
  assertEquals(res.status, 403);
});

test("POST /datacenters returns 400 for invalid options", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/datacenters", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "dc", options: [] }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /datacenters returns 400 for an invalid sourceServerId", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/datacenters", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "dc", sourceServerId: "not-a-uuid" }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /datacenters returns 404 when a member server is not visible", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request("/datacenters", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      name: "dc",
      members: [{ serverId, address: "203.0.113.10" }],
    }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("POST /datacenters/:id/members returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/datacenters/${id}/members`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      members: [{ serverId, address: "203.0.113.10" }],
    }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("POST /datacenters/:id/members returns 403 when manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  const res = await app.request(`/datacenters/${id}/members`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      members: [{ serverId, address: "203.0.113.10" }],
    }),
  });
  assertEquals(res.status, 403);
});

test("POST /datacenters/:id/members returns 400 for invalid members", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/datacenters/${id}/members`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ members: "nope" }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("DELETE /datacenters/:id/members/:serverId returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/datacenters/${id}/members/${serverId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("DELETE /datacenters/:id/members/:serverId returns 404 when no pin exists", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/datacenters/${id}/members/${serverId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("DELETE /datacenters/:id/members/:serverId returns 200 when a pin is removed", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    deleteMemberFound: true,
  });
  const res = await app.request(`/datacenters/${id}/members/${serverId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { ok: boolean; removed: number };
  assertEquals(body.ok, true);
  assertEquals(body.removed, 1);
});

test("POST /datacenters/:id/subnets returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/datacenters/${id}/subnets`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ cidr: "10.0.0.0/24" }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("POST /datacenters/:id/subnets returns 400 for an invalid cidr", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/datacenters/${id}/subnets`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ cidr: "not-a-cidr" }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "invalid_cidr" });
});

test("POST /datacenters/:id/subnets returns 400 for a non-string name", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/datacenters/${id}/subnets`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ cidr: "10.0.0.0/24", name: 1 }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /datacenters/:id/subnets returns 409 when the cidr overlaps", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    overlappingCidrs: true,
  });
  const res = await app.request(`/datacenters/${id}/subnets`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ cidr: "10.0.0.0/24" }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "subnet_overlaps",
    cidr: "10.0.0.0/24",
    conflictingCidr: "10.0.0.0/24",
    networkId,
    datacenterId: otherDatacenterId,
  });
});

test("POST /datacenters/:id/subnets returns 409 cidr_overlaps_reserved for an operator-reserved range", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    networkRows: [{
      id: networkId,
      datacenterId: null,
      cidr: "10.0.0.0/16",
      name: "Corp VPN",
      kind: "reserved",
    }],
  });
  const res = await app.request(`/datacenters/${id}/subnets`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ cidr: "10.0.7.0/24" }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "cidr_overlaps_reserved",
    cidr: "10.0.7.0/24",
    conflictingCidr: "10.0.0.0/16",
    networkId,
  });
});

test("POST /datacenters/:id/subnets returns 409 cidr_overlaps_fabric inside the tp0 range", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    fabricRows: [{
      id: "77777777-7777-4777-8777-777777777777",
      cidr: "10.250.0.0/16",
      options: {},
    }],
  });
  const res = await app.request(`/datacenters/${id}/subnets`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ cidr: "10.250.4.0/24" }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "cidr_overlaps_fabric",
    cidr: "10.250.4.0/24",
    conflictingCidr: "10.250.0.0/16",
  });
});

test("POST /datacenters/:id/subnets returns 409 cidr_overlaps_fabric_pool inside the container pool", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    fabricRows: [{
      id: "77777777-7777-4777-8777-777777777777",
      cidr: "10.250.0.0/16",
      options: {},
    }],
  });
  const res = await app.request(`/datacenters/${id}/subnets`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ cidr: "10.200.0.0/24" }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "cidr_overlaps_fabric_pool",
    cidr: "10.200.0.0/24",
    conflictingCidr: "10.192.0.0/12",
  });
});

test("POST /datacenters/:id/subnets returns 409 cidr_overlaps_gateway_advertised when both datacenters have a gateway", async () => {
  const fabricId = "77777777-7777-4777-8777-777777777777";
  const gatewayHere = "88888888-8888-4888-8888-888888888888";
  const gatewayThere = "99999999-9999-4999-8999-999999999999";
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    fabricRows: [{ id: fabricId, cidr: "10.250.0.0/16", options: {} }],
    relayRows: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        serverId: gatewayHere,
        role: "gateway",
        advertisedCidrs: [],
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        serverId: gatewayThere,
        role: "gateway",
        advertisedCidrs: [],
      },
    ],
    ipRows: [
      {
        ipId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        serverId: gatewayHere,
        datacenterId: id,
        networkId: null,
        address: "10.9.0.1",
      },
      {
        ipId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        serverId: gatewayThere,
        datacenterId: otherDatacenterId,
        networkId,
        address: "10.0.0.5",
      },
    ],
    networkRows: [{
      id: networkId,
      datacenterId: otherDatacenterId,
      cidr: "10.0.0.0/24",
      name: "remote-lan",
      kind: "datacenter",
    }],
  });
  const res = await app.request(`/datacenters/${id}/subnets`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ cidr: "10.0.0.0/25" }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "cidr_overlaps_gateway_advertised",
    cidr: "10.0.0.0/25",
    conflictingCidr: "10.0.0.0/24",
    networkId,
    datacenterId: otherDatacenterId,
  });
});

test("POST /datacenters/:id/subnets returns 200 for a valid cidr", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/datacenters/${id}/subnets`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ cidr: "10.0.0.0/24", name: "lan" }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { ok: boolean; id: string };
  assertEquals(body.ok, true);
  assertEquals(typeof body.id, "string");
});

test("PATCH /datacenters/:id/subnets/:networkId returns 404 when the site is missing", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/datacenters/${id}/subnets/${networkId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "renamed" }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("PATCH /datacenters/:id/subnets/:networkId returns 400 when cidr is sent", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    siteNetworkPresent: true,
  });
  const res = await app.request(`/datacenters/${id}/subnets/${networkId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ cidr: "10.1.0.0/24" }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("PATCH /datacenters/:id/subnets/:networkId returns 200 for a name update", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    siteNetworkPresent: true,
  });
  const res = await app.request(`/datacenters/${id}/subnets/${networkId}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "renamed" }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("DELETE /datacenters/:id/subnets/:networkId returns 404 when the site is missing", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/datacenters/${id}/subnets/${networkId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("DELETE /datacenters/:id/subnets/:networkId returns 409 when members remain", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    siteNetworkPresent: true,
    subnetHasMembers: true,
  });
  const res = await app.request(`/datacenters/${id}/subnets/${networkId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "subnet_has_members" });
});

test("DELETE /datacenters/:id/subnets/:networkId returns 200 when the subnet is empty", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    siteNetworkPresent: true,
  });
  const res = await app.request(`/datacenters/${id}/subnets/${networkId}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("PATCH /datacenters/:id returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/datacenters/${id}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "renamed" }),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("PATCH /datacenters/:id returns 400 for a non-string name", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/datacenters/${id}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: 1 }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("PATCH /datacenters/:id returns 200 for a name update", async () => {
  const { app, cookie } = await buildSessionApp({
    withDatacenterRow: true,
    manageAllowed: true,
  });
  const res = await app.request(`/datacenters/${id}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name: "renamed" }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("PATCH /datacenters/:id persists valid priority and trusted options", async () => {
  const { app, cookie, updates } = await buildSessionApp({
    withDatacenterRow: true,
    manageAllowed: true,
  });
  const res = await app.request(`/datacenters/${id}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      options: { addressPreference: "ipv4", priority: 20, trusted: false },
    }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(updates.length, 1);
  assertEquals(updates[0]?.options, {
    addressPreference: "ipv4",
    priority: 20,
    trusted: false,
  });
});

test("PATCH /datacenters/:id drops invalid priority and trusted values", async () => {
  const { app, cookie, updates } = await buildSessionApp({
    withDatacenterRow: true,
    manageAllowed: true,
  });
  const res = await app.request(`/datacenters/${id}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      options: {
        addressPreference: "ipv6",
        priority: 5000,
        trusted: "yes",
      },
    }),
  });
  assertEquals(res.status, 200);
  assertEquals(updates.length, 1);
  assertEquals(updates[0]?.options, { addressPreference: "ipv6" });
});

test("PATCH /datacenters/:id clears options when null is sent", async () => {
  const { app, cookie, updates } = await buildSessionApp({
    withDatacenterRow: true,
    manageAllowed: true,
  });
  const res = await app.request(`/datacenters/${id}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ options: null }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(updates.length, 1);
  assertEquals(updates[0]?.options, null);
  assertEquals("options" in (updates[0] ?? {}), true);
});

test("PATCH /datacenters/:id returns 400 for non-object options", async () => {
  const { app, cookie, updates } = await buildSessionApp({
    manageAllowed: true,
  });
  const res = await app.request(`/datacenters/${id}`, {
    method: "PATCH",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ options: [] }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
  assertEquals(updates.length, 0);
});

test("DELETE /datacenters/:id returns 404 when the entity is in another org", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    entityOrgId: otherOrgId,
  });
  const res = await app.request(`/datacenters/${id}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("DELETE /datacenters/:id returns 409 when members remain", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    datacenterHasMembers: true,
  });
  const res = await app.request(`/datacenters/${id}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "datacenter_has_members" });
});

test("DELETE /datacenters/:id returns 409 when non-site networks remain", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    datacenterHasForeignNetworks: true,
  });
  const res = await app.request(`/datacenters/${id}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "datacenter_has_networks" });
});

test("DELETE /datacenters/:id returns 200 when the site is empty", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/datacenters/${id}`, {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("POST /datacenters returns 200 when members are visible and CIDRs derive", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    visibleMemberServers: true,
  });
  const res = await app.request("/datacenters", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      name: "dc",
      members: [{ serverId, address: MEMBER_ADDRESS }],
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { ok: boolean; id: string };
  assertEquals(body.ok, true);
  assertEquals(typeof body.id, "string");
});

test("POST /datacenters returns 409 cidr_overlaps_reserved when a derived CIDR hits a reserved range", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    visibleMemberServers: true,
    networkRows: [{
      id: networkId,
      datacenterId: null,
      cidr: "10.0.0.0/8",
      name: "Corp VPN — Chicago branch",
      kind: "reserved",
    }],
  });
  const res = await app.request("/datacenters", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      name: "dc",
      members: [{ serverId, address: MEMBER_ADDRESS }],
    }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "cidr_overlaps_reserved",
    cidr: MEMBER_CIDR,
    conflictingCidr: "10.0.0.0/8",
    networkId,
  });
});

test("POST /datacenters returns 409 subnet_overlaps when a derived CIDR hits another datacenter's subnet", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    visibleMemberServers: true,
    networkRows: [{
      id: networkId,
      datacenterId: otherDatacenterId,
      cidr: "10.0.0.0/23",
      name: "other-lan",
      kind: "datacenter",
    }],
  });
  const res = await app.request("/datacenters", {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      name: "dc",
      members: [{ serverId, address: MEMBER_ADDRESS }],
    }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "subnet_overlaps",
    cidr: MEMBER_CIDR,
    conflictingCidr: "10.0.0.0/23",
    networkId,
    datacenterId: otherDatacenterId,
  });
});

test("POST /datacenters/:id/members returns 200 when the pin matches a site subnet", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    visibleMemberServers: true,
    siteNetworkPresent: true,
  });
  const res = await app.request(`/datacenters/${id}/members`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      members: [{ serverId, address: MEMBER_ADDRESS }],
    }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

test("POST /datacenters/:id/members returns 409 when a derived CIDR overlaps", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    visibleMemberServers: true,
    orgOverlapFromOtherSite: true,
  });
  const res = await app.request(`/datacenters/${id}/members`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      members: [{ serverId, address: MEMBER_ADDRESS }],
    }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "subnet_overlaps",
    cidr: MEMBER_CIDR,
    conflictingCidr: MEMBER_CIDR,
    networkId,
    datacenterId: otherDatacenterId,
  });
});

test("POST /datacenters/:id/members returns 409 cidr_overlaps_docker_network when the derived CIDR hits a docker registration", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    visibleMemberServers: true,
    networkRows: [{
      id: networkId,
      datacenterId: null,
      cidr: "10.0.0.0/16",
      name: "bridge",
      kind: "docker",
    }],
  });
  const res = await app.request(`/datacenters/${id}/members`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      members: [{ serverId, address: MEMBER_ADDRESS }],
    }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "cidr_overlaps_docker_network",
    cidr: MEMBER_CIDR,
    conflictingCidr: "10.0.0.0/16",
    networkId,
  });
});

test("POST /datacenters/:id/members returns 409 cidr_overlaps_reserved when the derived CIDR hits a reserved range", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    visibleMemberServers: true,
    networkRows: [{
      id: networkId,
      datacenterId: null,
      cidr: "10.0.0.0/8",
      name: "Corp VPN — Chicago branch",
      kind: "reserved",
    }],
  });
  const res = await app.request(`/datacenters/${id}/members`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      members: [{ serverId, address: MEMBER_ADDRESS }],
    }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "cidr_overlaps_reserved",
    cidr: MEMBER_CIDR,
    conflictingCidr: "10.0.0.0/8",
    networkId,
  });
});

test("POST /datacenters/:id/members returns 409 when the address is already in use", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    visibleMemberServers: true,
    siteNetworkPresent: true,
    memberAddressInUse: true,
  });
  const res = await app.request(`/datacenters/${id}/members`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({
      members: [{ serverId, address: MEMBER_ADDRESS }],
    }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "address_in_use" });
});
