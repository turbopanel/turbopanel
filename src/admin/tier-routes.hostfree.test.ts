/**
 * The money boundary on the tier routes: billing off refuses before any
 * provider call, a product that does not verify never becomes a row, a
 * duplicate label is a 409 rather than a silent overwrite, and the cached
 * display price follows the provider's default price on every verify.
 *
 * The body parsers and serializers are proven in
 * `tier-routes-helpers.hostfree.test.ts`; what is proven here is that the
 * route actually consults them, actually asks the provider first, and
 * actually declines to write. The real `resolveBillingGateway` runs over
 * the recording Stripe double, so the paths and query Stripe would see
 * are pinned too.
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
} from "../client/authn/authn-hostfree-doubles.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../client/authn/crypto.ts";
import { deriveSecretsConfig } from "../client/authn/secrets.ts";
import type { BillingConfig } from "../lib/billing/config.ts";
import { StripeApiError } from "../lib/billing/errors.ts";
import { server, subscriptionItem, tier } from "../lib/db/schema.ts";
import type { TierRow } from "../lib/db/tier-records.ts";
import { createMemoryDb } from "../test-fixtures/memory-db.ts";
import { parseTestSecretsConfig } from "../test-fixtures/secrets.ts";
import {
  createStripeClientDouble,
  formOf,
  type StripeCall,
} from "../test-fixtures/stripe-client.ts";
import { registerAdminTierRoutes } from "./tier-routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const S3_ID = "33333333-3333-4333-8333-333333333333";
const SX_ID = "88888888-8888-4888-8888-888888888888";
const ORG = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const NOW = "2026-09-08T00:00:00.000Z";

const BILLING: BillingConfig = {
  secretKey: "sk_test_x",
  webhookSigningSecret: "whsec_x",
  apiVersion: "2025-08-27.basil",
};

function tierRow(overrides: Partial<TierRow> = {}): TierRow {
  return {
    id: S3_ID,
    createdAt: NOW,
    updatedAt: NOW,
    label: "S3",
    rank: 3,
    provider: "stripe",
    providerProductId: "prod_s3",
    priceCents: 1000,
    currency: "usd",
    isCustom: false,
    isActive: true,
    ...overrides,
  };
}

function customRow(): TierRow {
  return tierRow({
    id: SX_ID,
    label: "SX",
    rank: 8,
    providerProductId: null,
    priceCents: null,
    currency: null,
    isCustom: true,
  });
}

/** A Stripe Price that satisfies every check. */
function conformingPrice(overrides: Record<string, unknown> = {}) {
  return {
    id: "price_s3",
    object: "price",
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: 1000,
    recurring: { interval: "month", interval_count: 1 },
    billing_scheme: "per_unit",
    tax_behavior: "exclusive",
    livemode: false,
    ...overrides,
  };
}

/** A Stripe Product with its default price expanded. */
function product(
  overrides: Record<string, unknown> = {},
  price: Record<string, unknown> = {},
) {
  return {
    id: "prod_s3",
    object: "product",
    active: true,
    name: "S3",
    livemode: false,
    metadata: { turbopanel_tier: "S3" },
    default_price: conformingPrice(price),
    ...overrides,
  };
}

/** Answer a product by the id in the path; a list answers `products`. */
/**
 * @param accountTaxBehavior what `GET /v1/tax/settings` reports as the
 * account default. `null` is an account that names none, which is the
 * strict case every existing expectation was written against.
 */
function catalogue(
  products: Record<string, unknown>[],
  accountTaxBehavior: string | null = null,
) {
  return (call: StripeCall) => {
    if (call.path === "/v1/tax/settings") {
      return {
        object: "tax.settings",
        status: "active",
        defaults: { tax_behavior: accountTaxBehavior },
      };
    }
    if (call.path === "/v1/products") {
      return { object: "list", data: products, has_more: false };
    }
    const id = call.path.slice("/v1/products/".length);
    const found = products.find((entry) => entry.id === id);
    if (!found) {
      throw new StripeApiError({
        status: 404,
        type: "invalid_request_error",
        message: `No such product: ${id}`,
        code: "resource_missing",
      });
    }
    return found;
  };
}

async function buildApp(opts: Readonly<{
  tiers?: TierRow[];
  seats?: Record<string, unknown>[];
  servers?: Record<string, unknown>[];
  billing?: boolean;
  respond?: (call: StripeCall) => unknown;
}> = {}) {
  const secrets = await deriveSecretsConfig(
    parseTestSecretsConfig("deno"),
    "session-signing",
  );
  const token = crypto.randomUUID();
  const state = createEmptyMockAuthState();
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `root-${crypto.randomUUID()}@example.com`,
    role: "superadmin",
  });
  // Session lookups fall through to the mock auth db; tier/seat/server are ours.
  const db = createMemoryDb(
    [
      [tier, opts.tiers ?? []],
      [subscriptionItem, opts.seats ?? []],
      [server, opts.servers ?? []],
    ],
    { fallback: createMockAuthDb(state) },
  );
  const client = createStripeClientDouble(
    opts.respond ?? catalogue([product()]),
  );

  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    if (opts.billing !== false) c.set("billingConfig", BILLING);
    return next();
  });
  registerAdminTierRoutes(app, { secrets }, { createClient: () => client });

  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    token,
    secrets,
  )}`;
  return { app, cookie, db, client };
}

function get(
  app: Hono<AppEnv>,
  cookie: string,
  path: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(path, { method: "GET", headers: { cookie } }),
  );
}

function send(
  app: Hono<AppEnv>,
  cookie: string,
  method: "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

function post(app: Hono<AppEnv>, cookie: string, path: string, body?: unknown) {
  return send(app, cookie, "POST", path, body);
}

function patch(app: Hono<AppEnv>, cookie: string, path: string, body: unknown) {
  return send(app, cookie, "PATCH", path, body);
}

function jsonBody<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

type SerializedTier = {
  id: string;
  label: string;
  rank: number;
  provider: string;
  providerProductId: string | null;
  priceCents: number | null;
  currency: string | null;
  isCustom: boolean;
  isActive: boolean;
  entitlements: Record<string, number> | null;
  references: { seats: number; servers: number };
};

type CreateResponse = {
  tier: SerializedTier;
  verification: { ok: boolean; failures: string[] } | null;
};

test("every tier route answers 503 when billing is off, before touching the provider", async () => {
  const { app, cookie, client, db } = await buildApp({
    billing: false,
    tiers: [tierRow()],
  });
  const attempts: [string, () => Promise<Response>][] = [
    ["GET /tiers", () => get(app, cookie, "/tiers")],
    ["GET /tiers/products", () => get(app, cookie, "/tiers/products")],
    [
      "POST /tiers",
      () =>
        post(app, cookie, "/tiers", {
          label: "S3",
          providerProductId: "prod_s3",
        }),
    ],
    ["POST /tiers/verify", () => post(app, cookie, "/tiers/verify")],
    [
      "PATCH /tiers/:id",
      () => patch(app, cookie, `/tiers/${S3_ID}`, { isActive: false }),
    ],
    [
      "POST /tiers/:id/deactivate",
      () => post(app, cookie, `/tiers/${S3_ID}/deactivate`),
    ],
    [
      "POST /tiers/:id/verify",
      () => post(app, cookie, `/tiers/${S3_ID}/verify`),
    ],
  ];
  for (const [name, attempt] of attempts) {
    const res = await attempt();
    assertEquals(res.status, 503, name);
    assertEquals(
      (await jsonBody<{ error: string }>(res)).error,
      "billing_not_configured",
      name,
    );
  }
  // Nothing was asked of Stripe on the way to refusing, and nothing moved.
  assertEquals(client.calls.length, 0);
  assertEquals(db.rows<TierRow>(tier)[0]?.isActive, true);
});

test("GET /tiers lists every row with its references and the ladder with a tierId per mapped label", async () => {
  const { app, cookie, client } = await buildApp({
    tiers: [customRow(), tierRow()],
    seats: [{
      id: "seat-1",
      subscriptionId: "sub-row",
      tierId: S3_ID,
      providerItemId: "si_1",
      providerPriceId: "price_s3",
      quantity: 2,
      createdAt: NOW,
      updatedAt: NOW,
    }],
    servers: [
      {
        id: "srv-1",
        organizationId: ORG,
        createdAt: NOW,
        updatedAt: NOW,
        name: "a",
        metadata: null,
        assignedTierId: S3_ID,
      },
      {
        id: "srv-2",
        organizationId: ORG,
        createdAt: NOW,
        updatedAt: NOW,
        name: "b",
        metadata: null,
        assignedTierId: null,
      },
    ],
  });
  const res = await get(app, cookie, "/tiers");
  assertEquals(res.status, 200);
  const body = await jsonBody<{
    tiers: SerializedTier[];
    ladder: {
      label: string;
      rank: number;
      isCustom: boolean;
      tierId: string | null;
      entitlements: Record<string, number>;
    }[];
  }>(res);
  // Rows come back in ladder order regardless of seed order.
  assertEquals(body.tiers.map((row) => row.label), ["S3", "SX"]);
  assertEquals(body.tiers[0]?.references, { seats: 1, servers: 1 });
  assertEquals(body.tiers[1]?.references, { seats: 0, servers: 0 });
  // Entitlements are read from the ladder, not stored on the row.
  assertEquals(body.tiers[0]?.entitlements?.nicSlots, 5);
  assertEquals(body.ladder.length, 8);
  assertEquals(body.ladder.map((entry) => entry.label), [
    "S1",
    "S2",
    "S3",
    "S4",
    "S5",
    "S6",
    "S7",
    "SX",
  ]);
  assertEquals(
    body.ladder.find((entry) => entry.label === "S3")?.tierId,
    S3_ID,
  );
  assertEquals(
    body.ladder.find((entry) => entry.label === "SX")?.tierId,
    SX_ID,
  );
  assertEquals(body.ladder.filter((entry) => entry.tierId === null).length, 6);
  // A catalogue read never consults the provider.
  assertEquals(client.calls.length, 0);
});

test("GET /tiers/products lists the provider catalogue with inline verification and the tier already bound", async () => {
  const { app, cookie, client } = await buildApp({
    tiers: [tierRow()],
    respond: catalogue([
      product(),
      product({
        id: "prod_s4",
        name: "S4",
        metadata: { turbopanel_tier: "s4" },
      }, { id: "price_s4", unit_amount: 1500, tax_behavior: "unspecified" }),
      product({
        id: "prod_bare",
        name: "Bare",
        metadata: {},
        default_price: null,
      }),
    ]),
  });
  const res = await get(app, cookie, "/tiers/products");
  assertEquals(res.status, 200);
  const body = await jsonBody<{
    provider: string;
    products: {
      id: string;
      name: string;
      suggestedLabel: string | null;
      defaultPrice: { id: string; unitAmount: number | null } | null;
      verification: { ok: boolean; failures: string[] };
      tierId: string | null;
    }[];
  }>(res);
  assertEquals(body.provider, "stripe");
  assertEquals(body.products.map((entry) => entry.id), [
    "prod_s3",
    "prod_s4",
    "prod_bare",
  ]);

  const [s3, s4, bare] = body.products;
  assertEquals(s3?.verification, { ok: true, failures: [] });
  assertEquals(s3?.tierId, S3_ID);
  assertEquals(s3?.suggestedLabel, "S3");
  assertEquals(s3?.defaultPrice?.id, "price_s3");

  // Metadata is case-folded into a ladder label; the failing price is reported inline.
  assertEquals(s4?.suggestedLabel, "S4");
  assertEquals(s4?.tierId, null);
  assertEquals(s4?.verification.ok, false);
  assertEquals(
    s4?.verification.failures.some((f) => f.includes("tax_behavior")),
    true,
  );

  assertEquals(bare?.suggestedLabel, null);
  assertEquals(bare?.defaultPrice, null);
  assertEquals(bare?.verification.failures, [
    "product has no default price; set one in the Dashboard",
  ]);

  // One list call, active products only, with the default price expanded.
  // One extra call reads the account tax default, and only because prod_s4's
  // price is unspecified; a catalogue of explicit prices costs just the list.
  assertEquals(client.calls.map((call) => call.path), [
    "/v1/products",
    "/v1/tax/settings",
  ]);
  assertEquals(client.calls[0]?.method, "GET");
  assertEquals(client.calls[0]?.path, "/v1/products");
  assertEquals(formOf(client.calls[0]!, "active"), "true");
  assertEquals(formOf(client.calls[0]!, "expand[0]"), "data.default_price");
});

test("GET /tiers/products maps a provider list failure to 502 product_lookup_failed in our words", async () => {
  const { app, cookie } = await buildApp({
    respond: () => {
      throw new StripeApiError({
        status: 500,
        type: "api_error",
        message: "Stripe is having a bad day",
        code: null,
      });
    },
  });
  const res = await get(app, cookie, "/tiers/products");
  assertEquals(res.status, 502);
  const body = await jsonBody<
    { error: string; status: number; message: string }
  >(res);
  assertEquals(body.error, "product_lookup_failed");
  assertEquals(body.status, 500);
  assertEquals(
    body.message,
    "the provider could not be reached to list products",
  );
  assertEquals(JSON.stringify(body).includes("bad day"), false);
});

test("POST /tiers refuses an off-ladder label, SX with a product, and a priced label without one — before any provider call", async () => {
  const { app, cookie, client, db } = await buildApp();
  const attempts: [string, unknown][] = [
    ["off-ladder", { label: "S9", providerProductId: "prod_s3" }],
    ["missing label", { providerProductId: "prod_s3" }],
    ["SX with product", { label: "SX", providerProductId: "prod_sx" }],
    ["priced without product", { label: "S3" }],
    ["priced with blank product", { label: "S3", providerProductId: "   " }],
    ["non-string product", { label: "S3", providerProductId: 7 }],
  ];
  for (const [name, body] of attempts) {
    const res = await post(app, cookie, "/tiers", body);
    assertEquals(res.status, 400, name);
    const json = await jsonBody<{ error: string; message: string }>(res);
    assertEquals(json.error, "tier_invalid", name);
    assertEquals(typeof json.message, "string", name);
  }
  assertEquals(client.calls.length, 0);
  assertEquals(db.rows(tier).length, 0);
});

test("POST /tiers verifies the product first and writes nothing when it does not conform", async () => {
  const { app, cookie, db, client } = await buildApp({
    respond: catalogue([
      product({}, { tax_behavior: "unspecified", currency: "eur" }),
    ]),
  });
  const res = await post(app, cookie, "/tiers", {
    label: "S3",
    providerProductId: "prod_s3",
  });
  assertEquals(res.status, 400);
  const body = await jsonBody<{
    error: string;
    message: string;
    verification: { ok: boolean; failures: string[]; product: { id: string } };
  }>(res);
  assertEquals(body.error, "product_verification_failed");
  // The reasons reach the operator: `message` is the field the console renders.
  assertEquals(
    body.message.includes("no tax behaviour resolves for this price"),
    true,
  );
  assertEquals(body.message.includes("currency eur ≠ usd"), true);
  assertEquals(body.verification.ok, false);
  assertEquals(body.verification.failures.length, 2);
  assertEquals(body.verification.product.id, "prod_s3");
  // Verified before writing, and the write never happened. The unspecified
  // price is what makes the account tax default worth reading at all.
  assertEquals(client.calls.map((call) => [call.method, call.path]), [
    ["GET", "/v1/products/prod_s3"],
    ["GET", "/v1/tax/settings"],
  ]);
  assertEquals(formOf(client.calls[0]!, "expand[0]"), "default_price");
  assertEquals(db.rows(tier).length, 0);
});

test('an account tax default rescues a price left at "Use default", end to end', async () => {
  // The Stripe Dashboard shows this state as "Use default (no)", which reads
  // as configured; the API still returns tax_behavior "unspecified". Stripe
  // documents the field as only required when Tax settings carry no default,
  // so this must verify and save rather than refuse.
  const unspecified = product({}, { tax_behavior: "unspecified" });
  const { app, cookie, db, client } = await buildApp({
    respond: catalogue([unspecified], "exclusive"),
  });
  const listed = await jsonBody<
    { products: { verification: { ok: boolean; failures: string[] } }[] }
  >(
    await get(app, cookie, "/tiers/products"),
  );
  assertEquals(listed.products[0]?.verification, { ok: true, failures: [] });

  const res = await post(app, cookie, "/tiers", {
    label: "S3",
    providerProductId: "prod_s3",
  });
  assertEquals(res.status, 201);
  assertEquals(db.rows(tier).length, 1);
  assertEquals(
    client.calls.some((call) => call.path === "/v1/tax/settings"),
    true,
  );
});

test("the same price is refused when the account names no default either", async () => {
  const { app, cookie, db } = await buildApp({
    respond: catalogue([product({}, { tax_behavior: "unspecified" })], null),
  });
  const res = await post(app, cookie, "/tiers", {
    label: "S3",
    providerProductId: "prod_s3",
  });
  assertEquals(res.status, 400);
  const body = await jsonBody<{ message: string }>(res);
  assertEquals(body.message.includes("Settings → Tax"), true);
  assertEquals(db.rows(tier).length, 0);
});

test("POST /tiers refuses a product the provider does not know with our words, never the provider's", async () => {
  const { app, cookie, db } = await buildApp({ respond: catalogue([]) });
  const res = await post(app, cookie, "/tiers", {
    label: "S3",
    providerProductId: "prod_nope",
  });
  assertEquals(res.status, 400);
  const body = await jsonBody<
    { error: string; status: number; message: string }
  >(res);
  assertEquals(body.error, "product_lookup_failed");
  assertEquals(body.status, 404);
  assertEquals(
    body.message,
    "the provider has no product with that id on this key",
  );
  assertEquals(JSON.stringify(body).includes("No such product"), false);
  assertEquals(db.rows(tier).length, 0);
});

test("POST /tiers answers 409 tier_exists for a label that already has a row, before spending a provider call", async () => {
  const { app, cookie, db, client } = await buildApp({ tiers: [tierRow()] });
  const res = await post(app, cookie, "/tiers", {
    label: "s3",
    providerProductId: "prod_other",
  });
  assertEquals(res.status, 409);
  const body = await jsonBody<{ error: string; message: string }>(res);
  assertEquals(body.error, "tier_exists");
  assertEquals(body.message.includes("S3"), true);
  // Never an overwrite: the existing binding is untouched.
  assertEquals(db.rows<TierRow>(tier).length, 1);
  assertEquals(db.rows<TierRow>(tier)[0]?.providerProductId, "prod_s3");
  assertEquals(client.calls.length, 0);
});

test("POST /tiers writes a conforming product with rank and isCustom from the ladder and the price cached from the provider", async () => {
  const { app, cookie, db, client } = await buildApp({
    respond: catalogue([
      product({
        id: "prod_s4",
        name: "S4",
        metadata: { turbopanel_tier: "S4" },
      }, { id: "price_s4", unit_amount: 1500 }),
    ]),
  });
  const res = await post(app, cookie, "/tiers", {
    label: "S4",
    providerProductId: "prod_s4",
  });
  assertEquals(res.status, 201);
  const body = await jsonBody<CreateResponse>(res);
  assertEquals(body.tier.label, "S4");
  assertEquals(body.tier.rank, 4);
  assertEquals(body.tier.isCustom, false);
  assertEquals(body.tier.isActive, true);
  assertEquals(body.tier.provider, "stripe");
  assertEquals(body.tier.providerProductId, "prod_s4");
  assertEquals(body.tier.priceCents, 1500);
  assertEquals(body.tier.currency, "usd");
  assertEquals(body.tier.entitlements?.driveSlots, 8);
  assertEquals(body.tier.references, { seats: 0, servers: 0 });
  assertEquals(body.verification?.ok, true);
  assertEquals(body.verification?.failures, []);

  const [row] = db.rows<TierRow>(tier);
  assertEquals(row?.rank, 4);
  assertEquals(row?.isCustom, false);
  assertEquals(row?.priceCents, 1500);
  assertEquals(row?.currency, "usd");
  assertEquals(client.calls.map((call) => call.path), ["/v1/products/prod_s4"]);
});

test("POST /tiers refuses a product whose turbopanel_tier metadata is not the selected label", async () => {
  const { app, cookie, db } = await buildApp({
    respond: catalogue([product({ metadata: { turbopanel_tier: "S5" } })]),
  });
  const res = await post(app, cookie, "/tiers", {
    label: "S3",
    providerProductId: "prod_s3",
  });
  assertEquals(res.status, 400);
  const body = await jsonBody<{ error: string; message: string }>(res);
  assertEquals(body.error, "product_verification_failed");
  assertEquals(body.message.includes("turbopanel_tier metadata S5 ≠ S3"), true);
  assertEquals(db.rows(tier).length, 0);
});

test("POST /tiers refuses a product whose default price is not the ladder list price", async () => {
  const { app, cookie, db } = await buildApp({
    respond: catalogue([product({}, { unit_amount: 999 })]),
  });
  const res = await post(app, cookie, "/tiers", {
    label: "S3",
    providerProductId: "prod_s3",
  });
  assertEquals(res.status, 400);
  const body = await jsonBody<{ error: string; message: string }>(res);
  assertEquals(body.error, "product_verification_failed");
  assertEquals(
    body.message.includes("default price unit_amount 999 ≠ 1000"),
    true,
  );
  assertEquals(db.rows(tier).length, 0);
});

test("POST /tiers writes the SX row with no product, no price and no provider call", async () => {
  const { app, cookie, db, client } = await buildApp();
  const res = await post(app, cookie, "/tiers", { label: "SX" });
  assertEquals(res.status, 201);
  const body = await jsonBody<CreateResponse>(res);
  assertEquals(body.tier.label, "SX");
  assertEquals(body.tier.rank, 8);
  assertEquals(body.tier.isCustom, true);
  assertEquals(body.tier.providerProductId, null);
  assertEquals(body.tier.priceCents, null);
  assertEquals(body.tier.currency, null);
  assertEquals(body.verification, null);
  assertEquals(db.rows<TierRow>(tier)[0]?.isCustom, true);
  assertEquals(client.calls.length, 0);
});

test("PATCH /tiers/:id re-verifies only when the product moved, and caches the new price when it did", async () => {
  const { app, cookie, client, db } = await buildApp({
    tiers: [tierRow()],
    respond: catalogue([
      product(),
      product({ id: "prod_other", name: "S3 v2" }, {
        id: "price_other",
        unit_amount: 1000,
      }),
    ]),
  });
  // Same product, and a flag-only patch: the provider is not consulted.
  const same = await patch(app, cookie, `/tiers/${S3_ID}`, {
    providerProductId: "prod_s3",
  });
  assertEquals(same.status, 200);
  assertEquals((await jsonBody<CreateResponse>(same)).verification, null);
  const flag = await patch(app, cookie, `/tiers/${S3_ID}`, { isActive: false });
  assertEquals(flag.status, 200);
  assertEquals(db.rows<TierRow>(tier)[0]?.isActive, false);
  assertEquals(client.calls.length, 0);

  const moved = await patch(app, cookie, `/tiers/${S3_ID}`, {
    providerProductId: "prod_other",
    isActive: true,
  });
  assertEquals(moved.status, 200);
  const body = await jsonBody<CreateResponse>(moved);
  assertEquals(body.verification?.ok, true);
  assertEquals(body.tier.providerProductId, "prod_other");
  assertEquals(body.tier.priceCents, 1000);
  assertEquals(body.tier.isActive, true);
  assertEquals(client.calls.map((call) => call.path), [
    "/v1/products/prod_other",
  ]);
  const [row] = db.rows<TierRow>(tier);
  assertEquals(row?.providerProductId, "prod_other");
  assertEquals(row?.priceCents, 1000);
  assertEquals(row?.currency, "usd");
});

test("PATCH /tiers/:id refuses a product that does not verify and leaves the row alone", async () => {
  const { app, cookie, db } = await buildApp({
    tiers: [tierRow()],
    respond: catalogue([
      product({ id: "prod_bad", name: "Bad" }, {
        id: "price_bad",
        active: false,
      }),
    ]),
  });
  const res = await patch(app, cookie, `/tiers/${S3_ID}`, {
    providerProductId: "prod_bad",
    isActive: false,
  });
  assertEquals(res.status, 400);
  assertEquals(
    (await jsonBody<{ error: string }>(res)).error,
    "product_verification_failed",
  );
  // Not even the `isActive` half of the patch landed.
  const [row] = db.rows<TierRow>(tier);
  assertEquals(row?.providerProductId, "prod_s3");
  assertEquals(row?.isActive, true);
});

test("PATCH /tiers/:id refuses a product on SX, a null product on a priced row, and an unknown field", async () => {
  const { app, cookie, client, db } = await buildApp({
    tiers: [tierRow(), customRow()],
  });
  const attempts: [string, string, unknown][] = [
    ["product on SX", SX_ID, { providerProductId: "prod_sx" }],
    ["null product on priced", S3_ID, { providerProductId: null }],
    ["blank product on priced", S3_ID, { providerProductId: "" }],
    ["unknown field", S3_ID, { label: "S4" }],
  ];
  for (const [name, id, body] of attempts) {
    const res = await patch(app, cookie, `/tiers/${id}`, body);
    assertEquals(res.status, 400, name);
    assertEquals(
      (await jsonBody<{ error: string }>(res)).error,
      "tier_invalid",
      name,
    );
  }
  assertEquals(client.calls.length, 0);
  assertEquals(
    db.rows<TierRow>(tier).find((row) => row.id === S3_ID)?.providerProductId,
    "prod_s3",
  );
  assertEquals(
    db.rows<TierRow>(tier).find((row) => row.id === SX_ID)?.providerProductId,
    null,
  );

  const missing = await patch(
    app,
    cookie,
    "/tiers/99999999-9999-4999-8999-999999999999",
    { isActive: false },
  );
  assertEquals(missing.status, 404);
});

test("POST /tiers/:id/deactivate retires the row and never deletes it", async () => {
  const { app, cookie, db, client } = await buildApp({ tiers: [tierRow()] });
  const res = await post(app, cookie, `/tiers/${S3_ID}/deactivate`);
  assertEquals(res.status, 200);
  const body = await jsonBody<{ tier: SerializedTier }>(res);
  assertEquals(body.tier.isActive, false);
  assertEquals(db.rows<TierRow>(tier).length, 1);
  assertEquals(db.rows<TierRow>(tier)[0]?.isActive, false);
  assertEquals(client.calls.length, 0);

  const missing = await post(
    app,
    cookie,
    "/tiers/99999999-9999-4999-8999-999999999999/deactivate",
  );
  assertEquals(missing.status, 404);
});

test("POST /tiers/:id/verify refreshes the cached price from the provider", async () => {
  const { app, cookie, db, client } = await buildApp({
    tiers: [tierRow({ priceCents: 900, currency: "usd" })],
    respond: catalogue([product({}, { unit_amount: 1000 })]),
  });
  const res = await post(app, cookie, `/tiers/${S3_ID}/verify`);
  assertEquals(res.status, 200);
  const body = await jsonBody<
    { verification: { ok: boolean }; tier: SerializedTier }
  >(res);
  assertEquals(body.verification.ok, true);
  assertEquals(body.tier.priceCents, 1000);
  assertEquals(db.rows<TierRow>(tier)[0]?.priceCents, 1000);
  assertEquals(client.calls.map((call) => call.path), ["/v1/products/prod_s3"]);
});

test("POST /tiers/:id/verify reports a product that no longer conforms and keeps the last good price", async () => {
  const { app, cookie, db } = await buildApp({
    tiers: [tierRow()],
    respond: catalogue([product({ active: false })]),
  });
  const res = await post(app, cookie, `/tiers/${S3_ID}/verify`);
  assertEquals(res.status, 400);
  const body = await jsonBody<{ error: string; message: string }>(res);
  assertEquals(body.error, "product_verification_failed");
  assertEquals(body.message, "product is archived (active=false)");
  assertEquals(db.rows<TierRow>(tier)[0]?.priceCents, 1000);
});

test("POST /tiers/:id/verify refuses a custom row with tier_has_no_product", async () => {
  const { app, cookie, client } = await buildApp({ tiers: [customRow()] });
  const res = await post(app, cookie, `/tiers/${SX_ID}/verify`);
  assertEquals(res.status, 400);
  assertEquals(
    (await jsonBody<{ error: string }>(res)).error,
    "tier_has_no_product",
  );
  assertEquals(client.calls.length, 0);

  const missing = await post(
    app,
    cookie,
    "/tiers/99999999-9999-4999-8999-999999999999/verify",
  );
  assertEquals(missing.status, 404);
});

test("POST /tiers/verify covers every priced row, skips SX, and refreshes each cached price", async () => {
  const S4_ID = "44444444-4444-4444-8444-444444444444";
  const S5_ID = "55555555-5555-4555-8555-555555555555";
  const { app, cookie, db, client } = await buildApp({
    tiers: [
      tierRow({ priceCents: 999 }),
      tierRow({
        id: S4_ID,
        label: "S4",
        rank: 4,
        providerProductId: "prod_s4",
        priceCents: 1500,
      }),
      tierRow({
        id: S5_ID,
        label: "S5",
        rank: 5,
        providerProductId: "prod_gone",
        priceCents: 2000,
      }),
      customRow(),
    ],
    respond: catalogue([
      product(),
      product({
        id: "prod_s4",
        name: "S4",
        metadata: { turbopanel_tier: "S4" },
      }, { id: "price_s4", unit_amount: 1500, billing_scheme: "tiered" }),
    ]),
  });
  const res = await post(app, cookie, "/tiers/verify");
  assertEquals(res.status, 200);
  const body = await jsonBody<{
    results: {
      id: string;
      label: string;
      ok: boolean;
      failures: string[];
      product: { id: string } | null;
    }[];
  }>(res);
  assertEquals(body.results.map((entry) => entry.label), ["S3", "S4", "S5"]);

  const [s3, s4, s5] = body.results;
  assertEquals(s3?.ok, true);
  assertEquals(s3?.failures, []);
  assertEquals(s3?.product?.id, "prod_s3");
  assertEquals(s4?.ok, false);
  assertEquals(s4?.failures, ["billing_scheme tiered ≠ per_unit"]);
  // A lookup failure is reported in our words, with no product to show.
  assertEquals(s5?.ok, false);
  assertEquals(s5?.failures, [
    "the provider has no product with that id on this key",
  ]);
  assertEquals(s5?.product, null);

  // Only the conforming row's cache moved.
  const rows = db.rows<TierRow>(tier);
  assertEquals(rows.find((row) => row.id === S3_ID)?.priceCents, 1000);
  assertEquals(rows.find((row) => row.id === S4_ID)?.priceCents, 1500);
  assertEquals(rows.find((row) => row.id === S5_ID)?.priceCents, 2000);
  assertEquals(rows.find((row) => row.id === SX_ID)?.priceCents, null);
  assertEquals(client.calls.map((call) => call.path), [
    "/v1/products/prod_s3",
    "/v1/products/prod_s4",
    "/v1/products/prod_gone",
  ]);
});
