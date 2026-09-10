/**
 * Host-free coverage for the hosted license mint (ledger T9) and revoke.
 *
 * With billing on, a key is minted only while the organization holds fewer
 * licenses than it has purchased and not already given back — read under
 * the organization's quantity lease, which is released on every exit. A
 * license carries no tier: which purchased tier the server lands on is
 * derived when it connects, never chosen here. Self-hosted (no billing
 * config) takes no lease and runs no gate.
 *
 * Revoking never touches the provider: what was purchased stays purchased
 * until the billing page reduces it, and a bound license is refused so the
 * operator deletes the server first.
 */

import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import type { Db } from "../../db.ts";
import type {
  DaemonCell,
  DaemonCellRegistry,
} from "../../daemon/cell/contracts.ts";
import type { BillingConfig } from "../../lib/billing/config.ts";
import {
  emptyLedger,
  newDeferredIntent,
  withIntent,
  writePendingChanges,
} from "../../lib/billing/pending-changes.ts";
import {
  BILLING_QUANTITY_LEASE_MS,
  billingQuantityLockKey,
} from "../../lib/billing/quantity-lock.ts";
import {
  license,
  payer,
  server,
  setting,
  subscription,
  subscriptionItem,
  tier,
} from "../../lib/db/schema.ts";
import {
  createMemoryDb,
  type MemoryDb,
} from "../../test-fixtures/memory-db.ts";
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
import { COLOCATED_SERVER_DISPLAY_NAME } from "../authn/install-state.ts";
import { deriveSecretsConfig } from "../authn/secrets.ts";
import { ORG_ID_HEADER } from "../org-context.ts";
import { registerLicenseRoutes } from "./routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORG = "33333333-3333-4333-8333-333333333333";
const S3 = "33333333-3333-4333-8333-333333333331";
const S4 = "33333333-3333-4333-8333-333333333332";
const NOW = "2026-09-07T12:00:00.000Z";
const CONFIG: BillingConfig = {
  secretKey: "sk_test_x",
  webhookSigningSecret: null,
  apiVersion: "2025-08-27.basil",
};

const tierRow = (id: string, label: string, rank: number) => ({
  id,
  label,
  rank,
  provider: "stripe",
  providerProductId: `prod_${label}`,
  priceCents: 500 * rank,
  currency: "usd",
  isCustom: false,
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
});

type Fixture = {
  /** Purchased quantity per tier on the projected subscription; `null` for no subscription at all. */
  seats?: { tierId: string; quantity: number }[] | null;
  licenses?: {
    id: string;
    serverId?: string | null;
    revokedAt?: string | null;
    name?: string | null;
  }[];
  servers?: { id: string; name: string | null }[];
  config?: BillingConfig | null;
  role?: "superadmin" | "user";
  allowed?: boolean;
  registry?: DaemonCellRegistry;
  afterSession?: "drop-db" | "swallow-session";
};

function noopRegistry(): DaemonCellRegistry {
  const noop = () => Promise.resolve();
  const cell = { purge: noop } as unknown as DaemonCell;
  return {
    getCell: () => cell,
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: noop,
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

async function buildApp(fx: Fixture = {}) {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const token = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const email = `licenses-${crypto.randomUUID()}@example.com`;
  const role = fx.role ?? "superadmin";
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email,
    role,
  });
  seedMockUser(state, {
    id: userId,
    email,
    isDisabled: false,
    isEmailVerified: true,
    role,
  });
  state.organizations.push({ id: ORG, name: "License Org" });
  // `execute` answers the authz grant probe and the self-host environment
  // pin lookup on revoke; neither row shape names an `id`, so nothing is pinned.
  const authDb = Object.assign(createMockAuthDb(state), {
    execute: () => Promise.resolve([{ allowed: fx.allowed ?? true }]),
  }) as unknown as Db;

  const seats = fx.seats === undefined
    ? [{ tierId: S3, quantity: 2 }]
    : fx.seats;
  const db = createMemoryDb([
    [setting, []],
    [
      server,
      (fx.servers ?? []).map((row) => ({
        id: row.id,
        organizationId: ORG,
        name: row.name,
        metadata: null,
        assignedTierId: null,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    ],
    [tier, [tierRow(S3, "S3", 3), tierRow(S4, "S4", 4)]],
    [
      payer,
      seats === null ? [] : [{
        id: "payer-1",
        provider: "stripe",
        providerCustomerId: "cus_1",
        organizationId: ORG,
        userId: null,
        taxId: null,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    ],
    [
      subscription,
      seats === null ? [] : [{
        id: "sub-row",
        payerId: "payer-1",
        providerSubscriptionId: "sub_1",
        status: "active",
        currentPeriodEnd: null,
        scheduleId: null,
        pastDueSince: null,
        graceExpiresAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    ],
    [
      subscriptionItem,
      (seats ?? []).map((seat, index) => ({
        id: `seat-${index}`,
        subscriptionId: "sub-row",
        tierId: seat.tierId,
        providerItemId: `si_${index}`,
        providerPriceId: `price_${index}`,
        quantity: seat.quantity,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    ],
    [
      license,
      (fx.licenses ?? []).map((row) => ({
        id: row.id,
        organizationId: ORG,
        serverId: row.serverId ?? null,
        name: row.name ?? null,
        token: "hashed",
        revokedAt: row.revokedAt ?? null,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    ],
  ], { fallback: authDb });

  const app = new Hono<AppEnv>();
  let middleware:
    | ((c: Context<AppEnv>, next: () => Promise<void>) => Promise<void>)
    | undefined;
  if (fx.afterSession === "drop-db") middleware = dropDbAfterSession(db);
  if (fx.afterSession === "swallow-session") middleware = swallowSession(db);
  if (middleware) {
    app.use("*", middleware);
  } else {
    app.use("*", (c, next) => {
      c.set("db", db);
      const config = fx.config === undefined ? CONFIG : fx.config;
      if (config) c.set("billingConfig", config);
      if (fx.registry) c.set("daemonCellRegistry", fx.registry);
      return next();
    });
  }
  registerLicenseRoutes(app, {
    secrets,
    runtime: "workers",
    signupEnvOverride: undefined,
    baseUrl: "https://panel.example.com",
  });
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    token,
    secrets,
  )}`;
  const headers = {
    Cookie: cookie,
    [ORG_ID_HEADER]: ORG,
    "content-type": "application/json",
  };
  return { app, headers, db };
}

function listLicenses(
  app: Hono<AppEnv>,
  headers: Record<string, string>,
): Promise<Response> {
  return Promise.resolve(app.request("/licenses", { headers }));
}

function mint(
  app: Hono<AppEnv>,
  headers: Record<string, string>,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request("/licenses", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

function revoke(
  app: Hono<AppEnv>,
  headers: Record<string, string>,
  id: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/licenses/${id}`, { method: "DELETE", headers }),
  );
}

function lockRow(db: MemoryDb) {
  return db.rows(setting).find((row) =>
    row.key === billingQuantityLockKey(ORG)
  ) ?? null;
}

/**
 * The license routes have no provider seam, so "never calls Stripe" is
 * proven at the transport: every outbound `fetch` during `run` is recorded
 * and none may happen.
 */
async function withFetchGuard<T>(
  run: () => Promise<T>,
): Promise<{ result: T; fetches: string[] }> {
  const fetches: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetches.push(url);
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  }) as typeof fetch;
  try {
    return { result: await run(), fetches };
  } finally {
    globalThis.fetch = original;
  }
}

const L_ACTIVE = "44444444-4444-4444-8444-444444444441";
const L_REVOKED = "44444444-4444-4444-8444-444444444442";
const L_BOUND = "44444444-4444-4444-8444-444444444443";
const SERVER = "55555555-5555-4555-8555-555555555551";

type Refusal = {
  error: string;
  purchased: number;
  releasing: number;
  held: number;
  available: number;
};

test("T9 · every purchased license held is 409 no_license_available with the counts; the lease was taken and is released", async () => {
  const { app, headers, db } = await buildApp({
    seats: [{ tierId: S3, quantity: 1 }],
    licenses: [{ id: L_ACTIVE }],
  });
  const res = await mint(app, headers);
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "no_license_available",
    purchased: 1,
    releasing: 0,
    held: 1,
    available: 0,
  });
  assertEquals(db.rows(license).length, 1);
  assertEquals(lockRow(db), null);

  // Nothing purchased at all reads as zero of everything.
  const none = await buildApp({ seats: null });
  const noSeats = await mint(none.app, none.headers);
  assertEquals(noSeats.status, 409);
  assertEquals(await noSeats.json(), {
    error: "no_license_available",
    purchased: 0,
    releasing: 0,
    held: 0,
    available: 0,
  });
  assertEquals(lockRow(none.db), null);
});

test("T9 · a bound license holds a purchased license the same as an unbound one", async () => {
  const { app, headers } = await buildApp({
    seats: [{ tierId: S3, quantity: 2 }],
    servers: [{ id: SERVER, name: "edge-1" }],
    licenses: [{ id: L_ACTIVE }, { id: L_BOUND, serverId: SERVER }],
  });
  const res = await mint(app, headers);
  assertEquals(res.status, 409);
  const body = await res.json() as Refusal;
  assertEquals(body, {
    error: "no_license_available",
    purchased: 2,
    releasing: 0,
    held: 2,
    available: 0,
  });
});

test("T9 · a purchase with room mints a key with no tier, once, and the lease is released", async () => {
  const { app, headers, db } = await buildApp({
    seats: [{ tierId: S3, quantity: 1 }, { tierId: S4, quantity: 1 }],
    licenses: [{ id: L_ACTIVE }],
  });
  const res = await mint(app, headers, { name: "edge-1" });
  assertEquals(res.status, 200);
  const body = await res.json() as {
    licenseId: string;
    licenseToken: string;
    installCommand: string;
  };
  assertExists(body.licenseId);
  assertExists(body.licenseToken);
  assertEquals(typeof body.installCommand, "string");
  const minted = db.rows(license).find((row) => row.id === body.licenseId);
  assertEquals(minted?.name, "edge-1");
  assertEquals(minted?.organizationId, ORG);
  assertEquals("tierId" in (minted ?? {}), false);
  assertEquals(lockRow(db), null);

  // Both purchased licenses are now held: the next mint is refused.
  const again = await mint(app, headers);
  assertEquals(again.status, 409);
  assertEquals(await again.json(), {
    error: "no_license_available",
    purchased: 2,
    releasing: 0,
    held: 2,
    available: 0,
  });
  assertEquals(db.rows(license).length, 2);
  assertEquals(lockRow(db), null);
});

test("T9 · a revoked license does not hold a purchased license", async () => {
  const { app, headers, db } = await buildApp({
    seats: [{ tierId: S3, quantity: 1 }],
    licenses: [{ id: L_REVOKED, revokedAt: NOW }],
  });
  const res = await mint(app, headers);
  assertEquals(res.status, 200);
  assertEquals(
    db.rows(license).filter((row) => row.revokedAt === null).length,
    1,
  );
});

test("T9 · an outstanding release-seat intent counts against availability until the boundary lands", async () => {
  const { app, headers, db } = await buildApp({
    seats: [{ tierId: S3, quantity: 2 }],
    licenses: [{ id: L_ACTIVE }],
  });
  const release = newDeferredIntent("release-seat", {
    fromTierId: S3,
    toTierId: null,
    landsAt: null,
    fromQuantity: 2,
    nowMs: Date.parse(NOW),
  });
  await writePendingChanges(
    db,
    ORG,
    withIntent(emptyLedger("sub_1"), release),
    Date.parse(NOW),
  );
  const res = await mint(app, headers);
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "no_license_available",
    purchased: 2,
    releasing: 1,
    held: 1,
    available: 0,
  });
  assertEquals(db.rows(license).length, 1);
  assertEquals(lockRow(db), null);

  // The source side of a downgrade is leaving too.
  const moved = await buildApp({
    seats: [{ tierId: S4, quantity: 1 }],
    licenses: [],
  });
  const downgrade = newDeferredIntent("downgrade", {
    fromTierId: S4,
    toTierId: S3,
    landsAt: null,
    fromQuantity: 1,
    nowMs: Date.parse(NOW),
  });
  await writePendingChanges(
    moved.db,
    ORG,
    withIntent(emptyLedger("sub_1"), downgrade),
    Date.parse(NOW),
  );
  const refused = await mint(moved.app, moved.headers);
  assertEquals(refused.status, 409);
  assertEquals(await refused.json(), {
    error: "no_license_available",
    purchased: 1,
    releasing: 1,
    held: 0,
    available: 0,
  });
});

test("T9 · while another holder has the quantity lease the mint is 409 billing_mutation_in_progress and nothing is written", async () => {
  const { app, headers, db } = await buildApp({
    seats: [{ tierId: S3, quantity: 2 }],
  });
  // The route reads the real clock, so the foreign lease must be live now.
  db.rows(setting).push({
    key: billingQuantityLockKey(ORG),
    value: {
      owner: "someone-else",
      expiresAt: new Date(Date.now() + BILLING_QUANTITY_LEASE_MS).toISOString(),
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
  const res = await mint(app, headers);
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "billing_mutation_in_progress" });
  assertEquals(db.rows(license), []);
  // The loser never releases a lease it does not own.
  assertEquals(lockRow(db)?.value, {
    owner: "someone-else",
    expiresAt: (lockRow(db)?.value as { expiresAt: string }).expiresAt,
  });
});

test("T9 · with billing off the key is minted with nothing purchased: no lease is taken and no gate runs", async () => {
  const { app, headers, db } = await buildApp({ config: null, seats: null });
  const res = await mint(app, headers, { name: "lab" });
  assertEquals(res.status, 200);
  const body = await res.json() as { licenseId: string };
  assertEquals(
    db.rows(license).find((row) => row.id === body.licenseId)?.name,
    "lab",
  );
  assertEquals(db.rows(setting), []);
});

test("DELETE /licenses/:id revokes an unbound license without touching the provider or the lease", async () => {
  const { app, headers, db } = await buildApp({
    seats: [{ tierId: S3, quantity: 2 }],
    licenses: [{ id: L_ACTIVE }],
  });
  const { result: res, fetches } = await withFetchGuard(() =>
    revoke(app, headers, L_ACTIVE)
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(fetches, []);
  // Soft-deleted, not removed; what was purchased stays purchased.
  const row = db.rows(license).find((entry) => entry.id === L_ACTIVE);
  assertEquals(typeof row?.revokedAt, "string");
  assertEquals(db.rows(subscriptionItem).map((seat) => seat.quantity), [2]);
  assertEquals(db.rows(setting), []);

  // The purchased license is free again: the next mint succeeds.
  const res2 = await mint(app, headers);
  assertEquals(res2.status, 200);
});

test("DELETE /licenses/:id refuses a bound license with 409 license_has_attached_server and calls no provider", async () => {
  const { app, headers, db } = await buildApp({
    seats: [{ tierId: S3, quantity: 1 }],
    servers: [{ id: SERVER, name: "edge-1" }],
    licenses: [{ id: L_BOUND, serverId: SERVER }],
  });
  const { result: res, fetches } = await withFetchGuard(() =>
    revoke(app, headers, L_BOUND)
  );
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "license_has_attached_server",
    server: { id: SERVER, name: "edge-1" },
  });
  assertEquals(fetches, []);
  assertEquals(
    db.rows(license).find((entry) => entry.id === L_BOUND)?.revokedAt,
    null,
  );
  assertEquals(db.rows(setting), []);
});

test("DELETE /licenses/:id answers 404 for a license the organization does not hold", async () => {
  const { app, headers } = await buildApp({
    licenses: [{ id: L_REVOKED, revokedAt: NOW }],
  });
  const gone = await revoke(app, headers, L_REVOKED);
  assertEquals(gone.status, 404);
  const unknown = await revoke(
    app,
    headers,
    "44444444-4444-4444-8444-444444444499",
  );
  assertEquals(unknown.status, 404);
});

test("registerLicenseRoutes refuses to mount without session secrets", () => {
  assertThrows(
    () =>
      registerLicenseRoutes(new Hono<AppEnv>(), {
        runtime: "workers",
        signupEnvOverride: undefined,
      } as AuthRouteOpts),
    TypeError,
    "session secrets are required for license routes",
  );
});

test("GET /licenses returns 401 without a session cookie", async () => {
  const { app } = await buildApp();
  const res = await app.request("/licenses", {
    headers: { "content-type": "application/json" },
  });
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { ok: false, error: "Unauthorized" });
});

test("GET /licenses returns 503 when the db is dropped after session", async () => {
  const { app, headers } = await buildApp({ afterSession: "drop-db" });
  const res = await listLicenses(app, headers);
  assertEquals(res.status, 503);
  assertEquals(await res.json(), { error: "Database unavailable" });
});

test("GET /licenses returns 401 when the session is swallowed after auth", async () => {
  const { app, headers } = await buildApp({ afterSession: "swallow-session" });
  const res = await listLicenses(app, headers);
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { error: "Unauthorized" });
});

test("GET /licenses requires an organization id", async () => {
  const { app, headers } = await buildApp();
  const res = await listLicenses(app, { Cookie: headers.Cookie ?? "" });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "organizationId required" });
});

test("GET /licenses returns 403 when the caller is not an owner", async () => {
  const { app, headers } = await buildApp({ role: "user", allowed: false });
  const res = await listLicenses(app, headers);
  assertEquals(res.status, 403);
});

test("GET /licenses lists unbound keys as revocable with no bound server", async () => {
  const { app, headers } = await buildApp({
    licenses: [{ id: L_ACTIVE, name: "edge-1" }],
  });
  const res = await listLicenses(app, headers);
  assertEquals(res.status, 200);
  const body = await res.json() as {
    licenses: Array<{
      id: string;
      name: string | null;
      revocable: boolean;
      boundServer:
        | { id: string; name: string | null; connected: boolean }
        | null;
    }>;
  };
  assertEquals(body.licenses.length, 1);
  assertEquals(body.licenses[0]?.id, L_ACTIVE);
  assertEquals(body.licenses[0]?.name, "edge-1");
  assertEquals(body.licenses[0]?.revocable, true);
  assertEquals(body.licenses[0]?.boundServer, null);
});

test("GET /licenses includes the bound server when a key is attached", async () => {
  const { app, headers } = await buildApp({
    servers: [{ id: SERVER, name: "edge-1" }],
    licenses: [{ id: L_BOUND, serverId: SERVER, name: "bound" }],
  });
  const res = await listLicenses(app, headers);
  assertEquals(res.status, 200);
  const body = await res.json() as {
    licenses: Array<{
      id: string;
      boundServer:
        | { id: string; name: string | null; connected: boolean }
        | null;
    }>;
  };
  assertEquals(body.licenses[0]?.id, L_BOUND);
  assertEquals(body.licenses[0]?.boundServer, {
    id: SERVER,
    name: "edge-1",
    connected: false,
  });
});

test("GET /licenses asks the registry for status when a bound server is listed", async () => {
  const { app, headers } = await buildApp({
    servers: [{ id: SERVER, name: "edge-1" }],
    licenses: [{ id: L_BOUND, serverId: SERVER, name: "bound" }],
    registry: noopRegistry(),
  });
  const res = await listLicenses(app, headers);
  assertEquals(res.status, 200);
  const body = await res.json() as {
    licenses: Array<{ boundServer: { connected: boolean } | null }>;
  };
  assertEquals(body.licenses[0]?.boundServer?.connected, false);
});

test("POST /licenses returns 400 for malformed JSON", async () => {
  const { app, headers } = await buildApp({ config: null, seats: null });
  const res = await app.request("/licenses", {
    method: "POST",
    headers,
    body: "{",
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid request" });
});

test("POST /licenses returns 400 for a reserved colocated name", async () => {
  const { app, headers } = await buildApp({ config: null, seats: null });
  const res = await mint(app, headers, { name: COLOCATED_SERVER_DISPLAY_NAME });
  assertEquals(res.status, 400);
  const body = await res.json() as { error: string };
  assertEquals(body.error.includes(COLOCATED_SERVER_DISPLAY_NAME), true);
});

test("POST /licenses returns 400 for a plaintext installBaseUrl outside the developer surface", async () => {
  const { app, headers } = await buildApp({ config: null, seats: null });
  const res = await mint(app, headers, {
    installBaseUrl: "http://203.0.113.10",
  });
  assertEquals(res.status, 400);
  assertEquals(await res.json(), {
    error: "installBaseUrl must be a valid https URL",
  });
});

test("POST /licenses uses a valid https installBaseUrl in the install command", async () => {
  const { app, headers } = await buildApp({ config: null, seats: null });
  const res = await mint(app, headers, {
    name: "lab",
    installBaseUrl: "https://panel.example.com",
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { installCommand: string };
  assertEquals(body.installCommand.includes("https://panel.example.com"), true);
});

test("DELETE /licenses/:id still succeeds when a cell registry is present", async () => {
  const { app, headers, db } = await buildApp({
    config: null,
    seats: null,
    licenses: [{ id: L_ACTIVE }],
    registry: noopRegistry(),
  });
  const res = await revoke(app, headers, L_ACTIVE);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(
    typeof db.rows(license).find((row) => row.id === L_ACTIVE)?.revokedAt,
    "string",
  );
});
