/**
 * Host-free coverage for TurboFabric route authz short-circuits (no Postgres).
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import { fabric, ip, network, relay, server } from "../../lib/db/schema.ts";
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
} from "../authn/authn-hostfree-doubles.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../authn/crypto.ts";
import { deriveSecretsConfig } from "../authn/secrets.ts";
import { parseTestSecretsConfig } from "../../test-fixtures/secrets.ts";
import { registerOrganizationFabricRoutes } from "./fabric-routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const orgId = "11111111-1111-4111-8111-111111111111";
const serverId = "22222222-2222-4222-8222-222222222222";
const WG_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const gatewayDatacenterId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const gatewayNetworkId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const gatewayIpId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const FABRIC_PATHS = [
  ["GET", `/organizations/${orgId}/fabric`],
  ["PUT", `/organizations/${orgId}/fabric`],
  ["PATCH", `/organizations/${orgId}/fabric/relays/${serverId}`],
  ["POST", `/organizations/${orgId}/fabric/apply`],
] as const;

async function buildSessionApp(opts: {
  manageAllowed: boolean;
  /** Seed an organization row so manage-gated handlers reach fabric lookups. */
  seedOrg?: boolean;
  /** Stub dispatch infra for PUT enable/disable paths past authz. */
  withDispatch?: boolean;
}): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const token = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `fabric-authz-${crypto.randomUUID()}@example.com`,
    role: "user",
  });
  if (opts.seedOrg) {
    state.organizations.push({ id: orgId, name: "Fabric Org" });
  }
  const authDb = createMockAuthDb(state);
  const db = Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: opts.manageAllowed }]),
  }) as unknown as Db;
  const signed = await buildSignedCookie(token, secrets);
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`;

  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    if (opts.withDispatch) {
      c.set("daemonCellRegistry", { cells: new Map() } as never);
      c.set("commandQueue", { enqueue: () => Promise.resolve() });
    }
    return next();
  });
  registerOrganizationFabricRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return { app, cookie };
}

test("TurboFabric routes return 401 without a session cookie", async () => {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", {} as Db);
    return next();
  });
  registerOrganizationFabricRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });

  for (const [method, path] of FABRIC_PATHS) {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify({ enabled: true }),
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertEquals(await res.json(), { ok: false, error: "Unauthorized" });
  }
});

test("TurboFabric routes return 403 when organization:manage is denied", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false });
  for (const [method, path] of FABRIC_PATHS) {
    const res = await app.request(path, {
      method,
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
      },
      body: method === "GET" ? undefined : JSON.stringify({ enabled: true }),
    });
    assertEquals(res.status, 403, `${method} ${path}`);
    assertEquals(await res.json(), { error: "Forbidden" });
  }
});

test("PUT /fabric returns 400 for invalid body when manage is allowed", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: "yes" }),
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("PATCH /fabric/relays/:serverId returns 400 for invalid body when manage is allowed", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(
    `/organizations/${orgId}/fabric/relays/${serverId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ role: "router" }),
    },
  );
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid role" });
});

test("POST /fabric/apply returns 409 when TurboFabric is not enabled", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    seedOrg: true,
  });
  const res = await app.request(`/organizations/${orgId}/fabric/apply`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "TurboFabric is not enabled" });
});

test("PATCH /fabric/relays/:serverId returns 409 when TurboFabric is not enabled", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    seedOrg: true,
  });
  const res = await app.request(
    `/organizations/${orgId}/fabric/relays/${serverId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ role: "member" }),
    },
  );
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "TurboFabric is not enabled" });
});

test("PUT /fabric enabled:false returns settings when TurboFabric is already off", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    seedOrg: true,
    withDispatch: true,
  });
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: false }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { enabled: false, relays: [] });
});

/** Candidate host CIDRs from `pickDefaultFabricHostCidr` — all occupied → route 409. */
const EXHAUSTED_HOST_CIDRS = [
  "10.250.0.0/16",
  "10.251.0.0/16",
  "10.252.0.0/16",
  "10.253.0.0/16",
] as const;

function thenableRows<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  return Object.assign(promise, {
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    orderBy: () => Promise.resolve(rows),
  });
}

async function buildFabricEnableApp(opts: {
  /** Overlay select doubles so occupiedCidrs exhausts the host pool. */
  exhaustHostCidrs?: boolean;
  /**
   * Mutable fabric insert + empty server/relay selects so enable succeeds with
   * zero org servers (no ensureFabricRelays inserts / reconcile enqueues).
   */
  enableEmptyOrg?: boolean;
  /** Persist a real org server so enable inserts a relay row. */
  enableWithServers?: boolean;
  /** Org server ids to report (default: one, `serverId`). */
  serverIds?: readonly string[];
}): Promise<{
  app: Hono<AppEnv>;
  cookie: string;
  fabrics: Array<{ id: string; organizationId: string; cidr: string; options: unknown }>;
  relays: Array<Record<string, unknown>>;
}> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const token = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `fabric-enable-${crypto.randomUUID()}@example.com`,
    role: "user",
  });
  state.organizations.push({ id: orgId, name: "Fabric Org" });
  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);
  const origInsert = (
    authDb as unknown as {
      insert: (table: unknown) => unknown;
    }
  ).insert.bind(authDb);
  const origUpdate = (
    authDb as unknown as {
      update: (table: unknown) => unknown;
    }
  ).update.bind(authDb);

  const persistFabric = opts.enableEmptyOrg || opts.enableWithServers;
  const fabrics: Array<{
    id: string;
    organizationId: string;
    cidr: string;
    options: unknown;
  }> = [];
  const relays: Array<Record<string, unknown>> = [];

  const db = Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: true }]),
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (opts.exhaustHostCidrs && table === network) {
          return {
            where: () =>
              thenableRows(EXHAUSTED_HOST_CIDRS.map((cidr) => ({ cidr }))),
          };
        }
        if (opts.exhaustHostCidrs && table === fabric) {
          return { where: () => thenableRows([]) };
        }
        if (persistFabric && table === fabric) {
          return {
            where: () =>
              thenableRows(
                fabrics.map((row) => ({
                  id: row.id,
                  organizationId: row.organizationId,
                  cidr: row.cidr,
                  options: row.options,
                })),
              ),
          };
        }
        if (persistFabric && table === relay) {
          return { where: () => thenableRows(relays) };
        }
        if (opts.enableWithServers && table === server) {
          return {
            where: () =>
              thenableRows((opts.serverIds ?? [serverId]).map((id) => ({ id }))),
          };
        }
        if (
          persistFabric &&
          (table === network || table === server || table === ip)
        ) {
          return { where: () => thenableRows([]) };
        }
        return origSelect(fields).from(table);
      },
    }),
    insert: (table: unknown) => {
      if (persistFabric && table === fabric) {
        return {
          values: (row: Record<string, unknown>) => {
            const record = {
              id: crypto.randomUUID(),
              organizationId: String(row.organizationId),
              cidr: String(row.cidr),
              options: row.options ?? null,
            };
            fabrics.push(record);
            return {
              returning: () => Promise.resolve([record]),
            };
          },
        };
      }
      if (opts.enableWithServers && table === relay) {
        return {
          values: (row: Record<string, unknown>) => {
            const record = {
              id: crypto.randomUUID(),
              fabricId: String(row.fabricId),
              serverId: String(row.serverId),
              address: String(row.address),
              role: "member",
              keepalive: 25,
              endpointAddress: null,
              publicKey: null,
              prefix: String(row.prefix),
              advertisedCidrs: [] as string[],
              metadata: {},
              options: null,
            };
            relays.push(record);
            return {
              returning: () => Promise.resolve([record]),
            };
          },
        };
      }
      return origInsert(table);
    },
    update: (table: unknown) => {
      if (persistFabric && table === fabric) {
        return {
          set: (patch: Record<string, unknown>) => ({
            where: () => ({
              returning: () => {
                for (const row of fabrics) {
                  if ("options" in patch) row.options = patch.options;
                }
                return Promise.resolve(
                  fabrics.map((row) => ({
                    id: row.id,
                    organizationId: row.organizationId,
                    cidr: row.cidr,
                    options: row.options,
                  })),
                );
              },
            }),
          }),
        };
      }
      return origUpdate(table);
    },
    // Snapshot + restore the in-memory fabric/relay stores so a throw inside
    // `enableOrganizationFabric` rolls back exactly as Postgres would.
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      const fabricSnapshot = fabrics.map((row) => ({ ...row }));
      const relaySnapshot = relays.map((row) => ({ ...row }));
      try {
        return await fn(db);
      } catch (err) {
        fabrics.splice(0, fabrics.length, ...fabricSnapshot);
        relays.splice(0, relays.length, ...relaySnapshot);
        throw err;
      }
    },
  }) as unknown as Db;

  const signed = await buildSignedCookie(token, secrets);
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("daemonCellRegistry", { cells: new Map() } as never);
    c.set("commandQueue", { enqueue: () => Promise.resolve() });
    return next();
  });
  registerOrganizationFabricRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return { app, cookie, fabrics, relays };
}

test("PUT /fabric enabled:true returns 409 when host CIDR pool is exhausted", async () => {
  const { app, cookie } = await buildFabricEnableApp({
    exhaustHostCidrs: true,
  });
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: true }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "fabric_cidr_unavailable" });
});

test("PUT /fabric enabled:true returns settings for an org with no servers", async () => {
  const { app, cookie } = await buildFabricEnableApp({ enableEmptyOrg: true });
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: true }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    enabled: boolean;
    fabric: { id: string; cidr: string; mtu: number };
    relays: unknown[];
  };
  assertEquals(body.enabled, true);
  assertEquals(body.fabric.cidr, "10.250.0.0/16");
  assertEquals(body.fabric.mtu, 1420);
  assertEquals(typeof body.fabric.id, "string");
  assertEquals(body.relays, []);
});

const secondServerId = "33333333-3333-4333-8333-333333333333";

test("PUT /fabric enabled:true carves every relay prefix from a custom containerPool", async () => {
  const { app, cookie, fabrics, relays } = await buildFabricEnableApp({
    enableWithServers: true,
    serverIds: [serverId, secondServerId],
  });
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: true, containerPool: "10.64.0.0/15" }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    enabled: boolean;
    fabric: { containerPool: string };
    relays: Array<{ serverId: string; prefix: string }>;
  };
  assertEquals(body.enabled, true);
  assertEquals(body.fabric.containerPool, "10.64.0.0/15");
  assertEquals(fabrics.length, 1);
  assertEquals(
    relays.map((row) => row.prefix).sort(),
    ["10.64.0.0/16", "10.65.0.0/16"],
  );
});

test("PUT /fabric enabled:true returns 409 for a containerPool too small for the org's servers and leaves no fabric row", async () => {
  // Two servers need two relay /16s; a /16 pool fits exactly one, and the
  // refused enable must not persist the fabric row it started with.
  const { app, cookie, fabrics, relays } = await buildFabricEnableApp({
    enableWithServers: true,
    serverIds: [serverId, secondServerId],
  });
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: true, containerPool: "10.64.0.0/16" }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "fabric_prefix_pool_exhausted" });
  assertEquals(fabrics, []);
  assertEquals(relays, []);

  const get = await app.request(`/organizations/${orgId}/fabric`, {
    headers: { Cookie: cookie },
  });
  assertEquals(await get.json(), { enabled: false, relays: [] });
});

test("PUT /fabric enabled:true refuses a containerPool the auto-picked host range lands in without enabling", async () => {
  const { app, cookie, fabrics } = await buildFabricEnableApp({
    enableWithServers: true,
  });
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: true, containerPool: "10.250.0.0/16" }),
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "cidr_overlaps_fabric",
    cidr: "10.250.0.0/16",
    conflictingCidr: "10.250.0.0/16",
  });
  assertEquals(fabrics, []);
});

test("GET /fabric returns 404 when the organization row is missing", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("GET /fabric returns disabled settings when TurboFabric is off", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    seedOrg: true,
  });
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { enabled: false, relays: [] });
});

test("POST /fabric/apply returns 503 when command dispatch is unavailable", async () => {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const token = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `fabric-apply-${crypto.randomUUID()}@example.com`,
    role: "user",
  });
  state.organizations.push({ id: orgId, name: "Fabric Org" });
  const fabricId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);
  const db = Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: true }]),
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === fabric) {
          return {
            where: () =>
              thenableRows([{
                id: fabricId,
                organizationId: orgId,
                cidr: "10.250.0.0/16",
                options: null,
              }]),
          };
        }
        return origSelect(fields).from(table);
      },
    }),
  }) as unknown as Db;
  const signed = await buildSignedCookie(token, secrets);
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerOrganizationFabricRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });

  const res = await app.request(`/organizations/${orgId}/fabric/apply`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 503);
});

test("PUT /fabric returns 503 when command dispatch is unavailable", async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    seedOrg: true,
  });
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: true }),
  });
  assertEquals(res.status, 503);
});

test("GET /fabric returns settings when TurboFabric is enabled with no relays", async () => {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const token = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `fabric-get-${crypto.randomUUID()}@example.com`,
    role: "user",
  });
  state.organizations.push({ id: orgId, name: "Fabric Org" });
  const fabricId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);
  const db = Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: true }]),
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === fabric) {
          return {
            where: () =>
              thenableRows([{
                id: fabricId,
                organizationId: orgId,
                cidr: "10.250.0.0/16",
                options: null,
              }]),
          };
        }
        if (table === relay) {
          return { where: () => thenableRows([]) };
        }
        return origSelect(fields).from(table);
      },
    }),
  }) as unknown as Db;
  const signed = await buildSignedCookie(token, secrets);
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerOrganizationFabricRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });

  const res = await app.request(`/organizations/${orgId}/fabric`, {
    headers: { Cookie: cookie },
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    enabled: boolean;
    fabric: { id: string; cidr: string };
    relays: unknown[];
  };
  assertEquals(body.enabled, true);
  assertEquals(body.fabric.id, fabricId);
  assertEquals(body.fabric.cidr, "10.250.0.0/16");
  assertEquals(body.relays, []);
});

test("PATCH /fabric/relays/:serverId returns 404 when the relay is missing", async () => {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const token = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `fabric-relay-${crypto.randomUUID()}@example.com`,
    role: "user",
  });
  state.organizations.push({ id: orgId, name: "Fabric Org" });
  const fabricId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);
  const db = Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: true }]),
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === fabric) {
          return {
            where: () =>
              thenableRows([{
                id: fabricId,
                organizationId: orgId,
                cidr: "10.250.0.0/16",
                options: null,
              }]),
          };
        }
        if (table === relay) {
          return { where: () => thenableRows([]) };
        }
        return origSelect(fields).from(table);
      },
    }),
  }) as unknown as Db;
  const signed = await buildSignedCookie(token, secrets);
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerOrganizationFabricRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });

  const res = await app.request(
    `/organizations/${orgId}/fabric/relays/${serverId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ role: "member" }),
    },
  );
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

const fabricId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const relayId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const RELAY_ROW = {
  id: relayId,
  fabricId,
  serverId,
  address: "10.250.0.2",
  role: "member",
  keepalive: 25,
  endpointAddress: null,
  publicKey: null,
  prefix: "10.250.0.2/32",
  advertisedCidrs: [] as string[],
  metadata: {},
  options: null,
};

const FABRIC_ROW = {
  id: fabricId,
  organizationId: orgId,
  cidr: "10.250.0.0/16",
  options: null,
};

async function buildEnabledFabricApp(opts: {
  withRelay?: boolean;
  removeFabricOnDelete?: boolean;
  gatewayReady?: boolean;
}): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const token = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `fabric-success-${crypto.randomUUID()}@example.com`,
    role: "user",
  });
  state.organizations.push({ id: orgId, name: "Fabric Org" });
  const authDb = createMockAuthDb(state);
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown };
    }
  ).select.bind(authDb);
  const origUpdate = (
    authDb as unknown as {
      update: (table: unknown) => unknown;
    }
  ).update.bind(authDb);
  const origDelete = (
    authDb as unknown as {
      delete: (table: unknown) => unknown;
    }
  ).delete.bind(authDb);

  let fabricPresent = true;
  const relays = opts.withRelay ? [{ ...RELAY_ROW }] : [];

  const db = Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: true }]),
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === fabric) {
          return {
            where: () => thenableRows(fabricPresent ? [{ ...FABRIC_ROW }] : []),
          };
        }
        if (table === relay) {
          return { where: () => thenableRows(relays) };
        }
        if (opts.gatewayReady && table === ip) {
          return {
            where: () =>
              thenableRows([{
                ipId: gatewayIpId,
                id: gatewayIpId,
                serverId,
                datacenterId: gatewayDatacenterId,
                networkId: gatewayNetworkId,
                address: "10.0.0.10",
              }]),
          };
        }
        if (opts.gatewayReady && table === network) {
          return {
            where: () =>
              thenableRows([{
                id: gatewayNetworkId,
                datacenterId: gatewayDatacenterId,
                cidr: "10.0.0.0/24",
                name: "lan",
                kind: "datacenter",
              }]),
          };
        }
        if (table === server || table === network || table === ip) {
          return { where: () => thenableRows([]) };
        }
        return origSelect(fields).from(table);
      },
    }),
    update: (table: unknown) => {
      if (table === relay) {
        return {
          set: (patch: Record<string, unknown>) => {
            for (const row of relays) Object.assign(row, patch);
            return {
              where: () => ({
                returning: () =>
                  Promise.resolve(relays.map((row) => ({ ...row }))),
              }),
            };
          },
        };
      }
      return origUpdate(table);
    },
    delete: (table: unknown) => {
      if (opts.removeFabricOnDelete && table === fabric) {
        return {
          where: () => {
            fabricPresent = false;
            return Promise.resolve(undefined);
          },
        };
      }
      return origDelete(table);
    },
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db),
  }) as unknown as Db;

  const signed = await buildSignedCookie(token, secrets);
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("daemonCellRegistry", { cells: new Map() } as never);
    c.set("commandQueue", { enqueue: () => Promise.resolve() });
    return next();
  });
  registerOrganizationFabricRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return { app, cookie };
}

test("POST /fabric/apply returns results when TurboFabric is enabled", async () => {
  const { app, cookie } = await buildEnabledFabricApp({});
  const res = await app.request(`/organizations/${orgId}/fabric/apply`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    ok: boolean;
    fabricId: string;
    interfaceName: string;
    results: unknown[];
  };
  assertEquals(body.ok, true);
  assertEquals(body.fabricId, fabricId);
  assertEquals(body.interfaceName, "tp0");
  assertEquals(body.results, []);
});

test("PUT /fabric enabled:false disables an existing mesh", async () => {
  const { app, cookie } = await buildEnabledFabricApp({
    removeFabricOnDelete: true,
  });
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: false }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { enabled: false, relays: [] });
});

test("PATCH /fabric/relays/:serverId returns 400 for an invalid keepalive", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(
    `/organizations/${orgId}/fabric/relays/${serverId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ keepalive: 0 }),
    },
  );
  assertEquals(res.status, 400);
});

test("PATCH /fabric/relays/:serverId returns 404 when the organization row is missing", async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true });
  const res = await app.request(
    `/organizations/${orgId}/fabric/relays/${serverId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ role: "member" }),
    },
  );
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});

test("PATCH /fabric/relays/:serverId updates an existing member relay", async () => {
  const { app, cookie } = await buildEnabledFabricApp({ withRelay: true });
  const res = await app.request(
    `/organizations/${orgId}/fabric/relays/${serverId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ role: "member", keepalive: 15 }),
    },
  );
  assertEquals(res.status, 200);
  const body = await res.json() as {
    ok: boolean;
    relay: { serverId: string; role: string; keepalive: number };
  };
  assertEquals(body.ok, true);
  assertEquals(body.relay.serverId, serverId);
  assertEquals(body.relay.role, "member");
  assertEquals(body.relay.keepalive, 15);
});

test("PATCH /fabric/relays/:serverId returns 422 when a gateway has no datacenter pin", async () => {
  const { app, cookie } = await buildEnabledFabricApp({ withRelay: true });
  const res = await app.request(
    `/organizations/${orgId}/fabric/relays/${serverId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ role: "gateway" }),
    },
  );
  assertEquals(res.status, 422);
  assertEquals(await res.json(), { error: "gateway_datacenter_required" });
});

test("PATCH /fabric/relays/:serverId returns 200 when promoting a pinned gateway", async () => {
  const { app, cookie } = await buildEnabledFabricApp({
    withRelay: true,
    gatewayReady: true,
  });
  const res = await app.request(
    `/organizations/${orgId}/fabric/relays/${serverId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ role: "gateway" }),
    },
  );
  assertEquals(res.status, 200);
  const body = await res.json() as {
    ok: boolean;
    relay: { serverId: string; role: string };
  };
  assertEquals(body.ok, true);
  assertEquals(body.relay.serverId, serverId);
  assertEquals(body.relay.role, "gateway");
});

test("PATCH /fabric/relays/:serverId returns 200 when setting a preshared key", async () => {
  const { app, cookie } = await buildEnabledFabricApp({ withRelay: true });
  const res = await app.request(
    `/organizations/${orgId}/fabric/relays/${serverId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ presharedKey: WG_KEY }),
    },
  );
  assertEquals(res.status, 200);
  const body = await res.json() as {
    ok: boolean;
    relay: { serverId: string };
  };
  assertEquals(body.ok, true);
  assertEquals(body.relay.serverId, serverId);
});

test("PUT /fabric enabled:true inserts a relay for an org server", async () => {
  const { app, cookie } = await buildFabricEnableApp({
    enableWithServers: true,
  });
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: true }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    enabled: boolean;
    fabric: { cidr: string };
    relays: Array<{ serverId: string }>;
  };
  assertEquals(body.enabled, true);
  assertEquals(body.fabric.cidr, "10.250.0.0/16");
  assertEquals(body.relays.length, 1);
  assertEquals(body.relays[0]?.serverId, serverId);
});

test("PUT /fabric containerPool: 409 fabric_container_pool_in_use when a relay prefix falls outside, 200 otherwise", async () => {
  const { app, cookie } = await buildFabricEnableApp({
    enableWithServers: true,
  });
  const put = (body: Record<string, unknown>) =>
    app.request(`/organizations/${orgId}/fabric`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify(body),
    });

  // First enable allocates the relay's /16 out of the default pool.
  const enabled = await put({ enabled: true });
  assertEquals(enabled.status, 200);
  const enabledBody = await enabled.json() as {
    fabric: { containerPool: string };
    relays: Array<{ prefix: string }>;
  };
  assertEquals(enabledBody.fabric.containerPool, "10.192.0.0/12");
  assertEquals(enabledBody.relays[0]?.prefix, "10.192.0.0/16");

  // A pool that would orphan that prefix is refused — nothing renumbers.
  const orphaning = await put({ enabled: true, containerPool: "10.64.0.0/10" });
  assertEquals(orphaning.status, 409);
  assertEquals(await orphaning.json(), {
    error: "fabric_container_pool_in_use",
    containerPool: "10.64.0.0/10",
    prefix: "10.192.0.0/16",
    serverId,
  });

  // A pool overlapping the tp0 host range is a registry collision.
  const hostHit = await put({ enabled: true, containerPool: "10.250.0.0/16" });
  assertEquals(hostHit.status, 409);
  assertEquals((await hostHit.json() as { error: string }).error, "cidr_overlaps_fabric");

  // Narrowing around the allocated prefix is fine and lands in fabric.options.
  const narrowed = await put({ enabled: true, containerPool: "10.192.0.0/13" });
  assertEquals(narrowed.status, 200);
  const narrowedBody = await narrowed.json() as {
    fabric: { containerPool: string; allowRelay: boolean };
  };
  assertEquals(narrowedBody.fabric.containerPool, "10.192.0.0/13");
  assertEquals(narrowedBody.fabric.allowRelay, false);

  const badBody = await put({ enabled: true, containerPool: "10.192.0.0/20" });
  assertEquals(badBody.status, 400);
  assertEquals(await badBody.json(), { error: "Invalid containerPool" });
});
