/**
 * Host-free coverage for the projection itself (ledger T6, T7): the
 * refetch-then-project seam driven directly, with the recording client
 * double answering by route and the in-memory db holding the three rows.
 *
 * T6 — every "log and skip" branch skips *before* a row is written, and a
 * refetch that rejects writes nothing. T7 — the response shapes the pinned
 * API version (`2025-08-27.basil`) sends and the older shapes still in the
 * wild both project the same rows: period end on the subscription or per
 * item, the invoice's subscription pre- and post-basil, a Checkout session
 * naming its subscription as an id or an object, the second page of items,
 * an unexpanded price. Items map to tiers by `price.product`, and the two
 * catalogue events refresh a tier's cached display price.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY,
  STRIPE_CUSTOMER_USER_METADATA_KEY,
} from "../../lib/billing/customer-subject.ts";
import { StripeApiError } from "../../lib/billing/errors.ts";
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
import {
  createStripeClientDouble,
  formOf,
  type StripeCall,
} from "../../test-fixtures/stripe-client.ts";
import {
  projectStripeEvent,
  projectSubscriptionById,
  type StripeProjectionOutcome,
} from "./stripe-projection.ts";
import {
  newPendingCheckoutRecord,
  readPendingCheckout,
  writePendingCheckout,
} from "../../lib/billing/pending-checkout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORG = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const USER = "7ba7b810-9dad-11d1-80b4-00c04fd430c9";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const SERVER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LICENSE_BOUND = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LICENSE_SPARE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = "2026-09-07T12:00:00.000Z";

/** A tier row is a ladder label bound to a provider product; entitlements come from the ladder. */
const tierRow = (id: string, label: string, rank: number) => ({
  id,
  createdAt: NOW,
  updatedAt: NOW,
  label,
  rank,
  provider: "stripe",
  providerProductId: `prod_${label}`,
  priceCents: 1000 * rank,
  currency: "usd",
  isCustom: false,
  isActive: true,
});

/** The price an item embeds on a refetch: its own id and the product it belongs to. */
const priceOf = (label: string) => ({
  id: `price_${label}`,
  product: `prod_${label}`,
});

type Obj = Record<string, unknown>;

/** An empty projection target: the catalogue and nothing projected yet. */
function emptyDb(opts: { licenses?: Obj[]; servers?: Obj[] } = {}): MemoryDb {
  return createMemoryDb([
    [setting, []],
    [payer, []],
    [subscription, []],
    [subscriptionItem, []],
    [tier, [tierRow(S1, "S1", 1), tierRow(S2, "S2", 2)]],
    [license, opts.licenses ?? []],
    [server, opts.servers ?? []],
  ]);
}

const licenseRow = (id: string, serverId: string | null) => ({
  id,
  organizationId: ORG,
  serverId,
  name: null,
  token: "x",
  revokedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const serverRow = (id: string, assignedTierId: string | null = null) => ({
  id,
  organizationId: ORG,
  createdAt: NOW,
  updatedAt: NOW,
  metadata: null,
  assignedTierId,
});

/** The subscription as the refetch returns it, with the parts under test overridable. */
function stripeSubscription(
  overrides: Obj = {},
  customerOverrides: Obj = {},
): Obj {
  return {
    id: "sub_1",
    object: "subscription",
    status: "active",
    schedule: null,
    customer: {
      id: "cus_1",
      object: "customer",
      metadata: { [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: ORG },
      tax_ids: {
        object: "list",
        data: [{ value: "DE123456789" }],
        has_more: false,
      },
      ...customerOverrides,
    },
    items: {
      object: "list",
      has_more: false,
      data: [{
        id: "si_1",
        object: "subscription_item",
        quantity: 2,
        price: priceOf("S1"),
      }],
    },
    ...overrides,
  };
}

/** A product as `GET /v1/products/:id?expand[]=default_price` returns it. */
function stripeProduct(
  label: string,
  unitAmount: number,
  overrides: Obj = {},
): Obj {
  return {
    id: `prod_${label}`,
    object: "product",
    active: true,
    name: label,
    metadata: { turbopanel_tier: label },
    default_price: {
      id: `price_${label}`,
      object: "price",
      active: true,
      type: "recurring",
      currency: "usd",
      unit_amount: unitAmount,
      recurring: { interval: "month", interval_count: 1 },
      billing_scheme: "per_unit",
      tax_behavior: "exclusive",
      livemode: false,
    },
    ...overrides,
  };
}

type Route = `${StripeCall["method"]} ${string}`;

function routedClient(
  routes: Partial<Record<Route, (call: StripeCall) => unknown>>,
) {
  return createStripeClientDouble((call) => {
    const handler = routes[`${call.method} ${call.path}` as Route];
    if (!handler) {
      throw new Error(`unexpected Stripe call ${call.method} ${call.path}`);
    }
    return handler(call);
  });
}

const SUB_ROUTE: Route = "GET /v1/subscriptions/sub_1";

function rowCounts(db: MemoryDb) {
  return {
    payer: db.rows(payer).length,
    subscription: db.rows(subscription).length,
    seat: db.rows(subscriptionItem).length,
  };
}

function skipped(outcome: StripeProjectionOutcome): string {
  if (outcome.action !== "skipped") {
    throw new Error(`expected a skip, got ${JSON.stringify(outcome)}`);
  }
  return outcome.reason;
}

function projected(outcome: StripeProjectionOutcome) {
  if (outcome.action !== "projected") {
    throw new Error(`expected a projection, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function refreshed(outcome: StripeProjectionOutcome): string[] {
  if (outcome.action !== "catalogue_refreshed") {
    throw new Error(
      `expected a catalogue refresh, got ${JSON.stringify(outcome)}`,
    );
  }
  return outcome.tierIds;
}

function synced(outcome: StripeProjectionOutcome) {
  const entitlements = projected(outcome).entitlements;
  if (entitlements?.action !== "synced") {
    throw new Error(
      `expected an entitlement sync, got ${JSON.stringify(entitlements)}`,
    );
  }
  return entitlements;
}

function seatRows(db: MemoryDb) {
  return db.rows(subscriptionItem).map((
    row,
  ) => [row.providerItemId, row.tierId, row.quantity, row.providerPriceId])
    .sort();
}

// --- T6 -------------------------------------------------------------------

test("T6 · every customer/subject/status skip answers its reason and writes no row", async () => {
  const cases: [string, Obj, Obj][] = [
    ["customer_deleted", {}, { deleted: true }],
    ["customer_missing", {}, { id: undefined }],
    ["customer_subject_missing", {}, { metadata: {} }],
    ["customer_subject_missing", {}, {
      metadata: {
        [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: ORG,
        [STRIPE_CUSTOMER_USER_METADATA_KEY]: USER,
      },
    }],
    ["customer_subject_missing", {}, {
      metadata: { [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: "not-a-uuid" },
    }],
    ["customer_subject_missing", {}, { metadata: "nonsense" }],
    ["status_missing", { status: "" }, {}],
  ];
  for (const [reason, subOverrides, customerOverrides] of cases) {
    const db = emptyDb();
    const client = routedClient({
      [SUB_ROUTE]: () => stripeSubscription(subOverrides, customerOverrides),
    });
    const outcome = await projectSubscriptionById(
      { db, client, now: NOW },
      "sub_1",
    );
    assertEquals(skipped(outcome), reason);
    assertEquals(rowCounts(db), { payer: 0, subscription: 0, seat: 0 }, reason);
    assertEquals(client.calls.length, 1, reason);
  }
});

test("T6 · a subject id is accepted case-insensitively and stored lowercased", async () => {
  const db = emptyDb();
  const client = routedClient({
    [SUB_ROUTE]: () =>
      stripeSubscription({}, {
        metadata: {
          [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: ORG.toUpperCase(),
        },
      }),
  });
  projected(await projectSubscriptionById({ db, client, now: NOW }, "sub_1"));
  assertEquals(db.rows(payer)[0]?.organizationId, ORG);
});

test("T6 · a customer naming a user projects the rows but syncs no entitlements", async () => {
  const db = emptyDb();
  const client = routedClient({
    [SUB_ROUTE]: () =>
      stripeSubscription({}, {
        metadata: { [STRIPE_CUSTOMER_USER_METADATA_KEY]: USER },
      }),
  });
  const outcome = projected(
    await projectSubscriptionById({ db, client, now: NOW }, "sub_1"),
  );
  assertEquals(outcome.entitlements, null);
  assertEquals(outcome.skippedItems, []);
  const [payerRow] = db.rows(payer);
  assertEquals(payerRow?.userId, USER);
  assertEquals(payerRow?.organizationId, null);
  assertEquals(rowCounts(db), { payer: 1, subscription: 1, seat: 1 });
  // The seat carries the item's own price beside its tier.
  assertEquals(seatRows(db), [["si_1", S1, 2, "price_S1"]]);
  // No lease, no ledger: the entitlement sync never ran.
  assertEquals(db.rows(setting), []);
});

test("T6 · an organization projection syncs entitlements: the licensed server is assigned, the lease is released, nothing is landed or revoked", async () => {
  const db = emptyDb({
    licenses: [licenseRow(LICENSE_BOUND, SERVER)],
    servers: [serverRow(SERVER)],
  });
  const client = routedClient({ [SUB_ROUTE]: () => stripeSubscription() });
  const entitlements = synced(
    await projectSubscriptionById({ db, client, now: NOW }, "sub_1"),
  );
  assertEquals(entitlements.scheduleRebuilt, false);
  assertEquals(entitlements.result.landedIntentIds, []);
  assertEquals(entitlements.result.revokedLicenseIds, []);
  assertEquals(entitlements.result.disconnectedServerIds, []);
  assertEquals(entitlements.result.assignment.changed, [SERVER]);
  assertEquals(entitlements.result.assignment.uncovered, []);
  assertEquals(db.rows(server)[0]?.assignedTierId, S1);
  // The sync took its own quantity lease and released it; the ledger stayed empty.
  assertEquals(db.rows(setting), []);
  // Only the refetch: no schedule work on a ledger with nothing deferred.
  assertEquals(client.calls.map((c) => c.path), ["/v1/subscriptions/sub_1"]);
});

test("T6 · an ended subscription revokes every license the organization holds — bound ones included — and clears the assignment", async () => {
  const db = emptyDb({
    licenses: [
      licenseRow(LICENSE_BOUND, SERVER),
      licenseRow(LICENSE_SPARE, null),
    ],
    servers: [serverRow(SERVER, S1)],
  });
  const client = routedClient({
    [SUB_ROUTE]: () => stripeSubscription({ status: "canceled" }),
  });
  const entitlements = synced(
    await projectSubscriptionById({ db, client, now: NOW }, "sub_1"),
  );
  assertEquals(
    [...entitlements.result.revokedLicenseIds].sort(),
    [LICENSE_BOUND, LICENSE_SPARE].sort(),
  );
  assertEquals(entitlements.result.disconnectedServerIds, [SERVER]);
  assertEquals(entitlements.result.assignment.uncovered, []);
  assertEquals(db.rows(license).every((row) => row.revokedAt === NOW), true);
  assertEquals(db.rows(server)[0]?.assignedTierId, null);
  // The seat row still says what the provider counts; entitlement reads it as zero.
  assertEquals(db.rows(subscription)[0]?.status, "canceled");
  assertEquals(seatRows(db), [["si_1", S1, 2, "price_S1"]]);
});

test("T6 · a refetch that fails writes nothing — the rows are only ever written from a successful read", async () => {
  const db = emptyDb();
  const client = routedClient({
    [SUB_ROUTE]: () => {
      throw new StripeApiError({
        status: 404,
        type: "invalid_request_error",
        message: "No such subscription",
      });
    },
  });
  await assertRejects(
    () => projectSubscriptionById({ db, client, now: NOW }, "sub_1"),
    StripeApiError,
  );
  assertEquals(rowCounts(db), { payer: 0, subscription: 0, seat: 0 });
});

test("T6 · projectStripeEvent skips a ref with no object id or an unhandled type without calling Stripe, and an object naming no subscription after one call", async () => {
  const db = emptyDb();
  const client = routedClient({
    "GET /v1/checkout/sessions/cs_1": () => ({
      id: "cs_1",
      object: "checkout.session",
      subscription: null,
    }),
    "GET /v1/invoices/in_1": () => ({
      id: "in_1",
      object: "invoice",
      parent: { type: "subscription_details", subscription_details: {} },
    }),
  });
  const deps = { db, client, now: NOW };
  assertEquals(
    skipped(
      await projectStripeEvent(deps, {
        id: "evt",
        type: "customer.subscription.updated",
        objectId: null,
        objectType: null,
      }),
    ),
    "object_id_missing",
  );
  assertEquals(
    skipped(
      await projectStripeEvent(deps, {
        id: "evt",
        type: "charge.refunded",
        objectId: "ch_1",
        objectType: "charge",
      }),
    ),
    "event_not_handled",
  );
  assertEquals(client.calls.length, 0);
  assertEquals(
    skipped(
      await projectStripeEvent(deps, {
        id: "evt",
        type: "checkout.session.completed",
        objectId: "cs_1",
        objectType: "checkout.session",
      }),
    ),
    "no_subscription",
  );
  assertEquals(
    skipped(
      await projectStripeEvent(deps, {
        id: "evt",
        type: "invoice.paid",
        objectId: "in_1",
        objectType: "invoice",
      }),
    ),
    "no_subscription",
  );
  assertEquals(client.calls.map((c) => c.path), [
    "/v1/checkout/sessions/cs_1",
    "/v1/invoices/in_1",
  ]);
  assertEquals(rowCounts(db), { payer: 0, subscription: 0, seat: 0 });
});

test("T6 · an item naming a product no tier claims is skipped and reported; an item whose price came back unexpanded is dropped without a report", async () => {
  const db = emptyDb();
  const client = routedClient({
    [SUB_ROUTE]: () =>
      stripeSubscription({
        items: {
          object: "list",
          has_more: false,
          data: [
            {
              id: "si_1",
              object: "subscription_item",
              quantity: 2,
              price: priceOf("S1"),
            },
            {
              id: "si_unknown",
              object: "subscription_item",
              quantity: 1,
              price: { id: "price_other", product: "prod_other" },
            },
            {
              id: "si_bare",
              object: "subscription_item",
              quantity: 1,
              price: "price_S2",
            },
          ],
        },
      }),
  });
  const outcome = projected(
    await projectSubscriptionById({ db, client, now: NOW }, "sub_1"),
  );
  assertEquals(outcome.skippedItems, ["si_unknown"]);
  assertEquals(seatRows(db), [["si_1", S1, 2, "price_S1"]]);
});

test("T6 · two items on one tier are summed under the first item id; the second id lands in skippedItems", async () => {
  const db = emptyDb();
  const client = routedClient({
    [SUB_ROUTE]: () =>
      stripeSubscription({
        items: {
          object: "list",
          has_more: false,
          data: [
            {
              id: "si_1",
              object: "subscription_item",
              quantity: 2,
              price: priceOf("S1"),
            },
            {
              id: "si_1b",
              object: "subscription_item",
              quantity: 3,
              price: { id: "price_S1_legacy", product: "prod_S1" },
            },
          ],
        },
      }),
  });
  const outcome = projected(
    await projectSubscriptionById({ db, client, now: NOW }, "sub_1"),
  );
  assertEquals(outcome.skippedItems, ["si_1b"]);
  assertEquals(seatRows(db), [["si_1", S1, 5, "price_S1"]]);
});

// --- T7 -------------------------------------------------------------------

test("T7 · current_period_end: on the subscription pre-basil, the latest item from basil on, the subscription when both", async () => {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  const item = (id: string, end?: number) => ({
    id,
    object: "subscription_item",
    quantity: 1,
    price: priceOf("S1"),
    ...(end === undefined ? {} : { current_period_end: end }),
  });
  const cases: [string, Obj, string | null][] = [
    [
      "on the subscription",
      { current_period_end: 1_800_000_000 },
      iso(1_800_000_000),
    ],
    ["latest across items", {
      items: {
        object: "list",
        has_more: false,
        data: [item("si_1", 1_800_000_000), item("si_2", 1_800_500_000)],
      },
    }, iso(1_800_500_000)],
    ["subscription wins over items", {
      current_period_end: 1_700_000_000,
      items: {
        object: "list",
        has_more: false,
        data: [item("si_1", 1_800_000_000)],
      },
    }, iso(1_700_000_000)],
    ["neither", {}, null],
  ];
  for (const [label, overrides, expected] of cases) {
    const db = emptyDb();
    const client = routedClient({
      [SUB_ROUTE]: () => stripeSubscription(overrides),
    });
    projected(await projectSubscriptionById({ db, client, now: NOW }, "sub_1"));
    assertEquals(db.rows(subscription)[0]?.currentPeriodEnd, expected, label);
  }
});

test("T7 · an invoice names its subscription directly (pre-basil, id or object) or under parent.subscription_details (basil); invoice.paid is the literal", async () => {
  const shapes: [string, Obj][] = [
    ["subscription as id", { subscription: "sub_1" }],
    ["subscription as object", {
      subscription: { id: "sub_1", object: "subscription" },
    }],
    ["basil parent", {
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: "sub_1" },
      },
    }],
  ];
  for (const [label, invoice] of shapes) {
    const db = emptyDb();
    const client = routedClient({
      "GET /v1/invoices/in_1": () => ({
        id: "in_1",
        object: "invoice",
        ...invoice,
      }),
      [SUB_ROUTE]: () => stripeSubscription(),
    });
    const outcome = projected(
      await projectStripeEvent({ db, client, now: NOW }, {
        id: "evt",
        type: "invoice.paid",
        objectId: "in_1",
        objectType: "invoice",
      }),
    );
    assertEquals(outcome.subscriptionId, db.rows(subscription)[0]?.id, label);
    assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), [
      "GET /v1/invoices/in_1",
      "GET /v1/subscriptions/sub_1",
    ], label);
  }
});

test("T7 · checkout.session.completed reads the session first, then projects the subscription it names as an id or an object", async () => {
  for (
    const sessionSubscription of ["sub_1", {
      id: "sub_1",
      object: "subscription",
    }]
  ) {
    const db = emptyDb();
    await writePendingCheckout(
      db,
      ORG,
      newPendingCheckoutRecord({
        sessionId: "cs_1",
        url: "https://checkout.stripe.com/c/pay/cs_1",
        tierId: S1,
        quantity: 2,
        idempotencyKey: "checkout-key",
        nowMs: Date.parse(NOW),
      }),
      Date.parse(NOW),
    );
    const client = routedClient({
      "GET /v1/checkout/sessions/cs_1": () => ({
        id: "cs_1",
        object: "checkout.session",
        subscription: sessionSubscription,
        metadata: { [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: ORG },
      }),
      [SUB_ROUTE]: () => stripeSubscription(),
    });
    projected(
      await projectStripeEvent({ db, client, now: NOW }, {
        id: "evt",
        type: "checkout.session.completed",
        objectId: "cs_1",
        objectType: "checkout.session",
      }),
    );
    assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), [
      "GET /v1/checkout/sessions/cs_1",
      "GET /v1/subscriptions/sub_1",
    ]);
    assertEquals(db.rows(subscriptionItem).map((row) => row.quantity), [2]);
    assertEquals(await readPendingCheckout(db, ORG, Date.parse(NOW)), null);
  }
});

test("T7 · every subscription event — pending_update_expired included — is one refetch of the subscription it names", async () => {
  const types = [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.subscription.pending_update_applied",
    "customer.subscription.pending_update_expired",
  ];
  for (const type of types) {
    const db = emptyDb();
    const client = routedClient({ [SUB_ROUTE]: () => stripeSubscription() });
    const outcome = projected(
      await projectStripeEvent({ db, client, now: NOW }, {
        id: "evt",
        type,
        objectId: "sub_1",
        objectType: "subscription",
      }),
    );
    assertEquals(outcome.subscriptionId, db.rows(subscription)[0]?.id, type);
    assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), [
      "GET /v1/subscriptions/sub_1",
    ], type);
    assertEquals(seatRows(db), [["si_1", S1, 2, "price_S1"]], type);
  }
});

test("T7 · items with has_more are walked through the list endpoint, and the page — not the embedded list — is what lands", async () => {
  const db = emptyDb();
  const client = routedClient({
    [SUB_ROUTE]: () =>
      stripeSubscription({
        items: {
          object: "list",
          has_more: true,
          data: [{
            id: "si_1",
            object: "subscription_item",
            quantity: 2,
            price: priceOf("S1"),
          }],
        },
      }),
    "GET /v1/subscription_items": () => ({
      object: "list",
      data: [
        {
          id: "si_1",
          object: "subscription_item",
          quantity: 5,
          price: priceOf("S1"),
        },
        {
          id: "si_2",
          object: "subscription_item",
          quantity: 1,
          price: priceOf("S2"),
        },
      ],
    }),
  });
  projected(await projectSubscriptionById({ db, client, now: NOW }, "sub_1"));
  const list = client.calls.find((c) => c.path === "/v1/subscription_items")!;
  assertEquals(formOf(list, "subscription"), "sub_1");
  assertEquals(seatRows(db), [["si_1", S1, 5, "price_S1"], [
    "si_2",
    S2,
    1,
    "price_S2",
  ]]);
});

test("T7 · schedule id or object, a missing quantity, and the first tax id all project as documented", async () => {
  const cases: [
    string,
    Obj,
    Obj,
    { scheduleId: string | null; quantity: number; taxId: string | null },
  ][] = [
    ["schedule as id", { schedule: "sub_sched_1" }, {}, {
      scheduleId: "sub_sched_1",
      quantity: 2,
      taxId: "DE123456789",
    }],
    [
      "schedule as object",
      { schedule: { id: "sub_sched_2", object: "subscription_schedule" } },
      {},
      { scheduleId: "sub_sched_2", quantity: 2, taxId: "DE123456789" },
    ],
    [
      "quantity absent → 1",
      {
        items: {
          object: "list",
          has_more: false,
          data: [{
            id: "si_1",
            object: "subscription_item",
            price: priceOf("S1"),
          }],
        },
      },
      {},
      { scheduleId: null, quantity: 1, taxId: "DE123456789" },
    ],
    ["no tax ids", {}, { tax_ids: undefined }, {
      scheduleId: null,
      quantity: 2,
      taxId: null,
    }],
  ];
  for (const [label, overrides, customerOverrides, expected] of cases) {
    const db = emptyDb();
    const client = routedClient({
      [SUB_ROUTE]: () => stripeSubscription(overrides, customerOverrides),
    });
    projected(await projectSubscriptionById({ db, client, now: NOW }, "sub_1"));
    assertEquals(
      db.rows(subscription)[0]?.scheduleId,
      expected.scheduleId,
      label,
    );
    assertEquals(
      db.rows(subscriptionItem)[0]?.quantity,
      expected.quantity,
      label,
    );
    assertEquals(db.rows(payer)[0]?.taxId, expected.taxId, label);
  }
});

// --- Catalogue events -------------------------------------------------------

test("product.updated refetches the product with its default price and refreshes the tier that names it; an unknown product is skipped before any call", async () => {
  const db = emptyDb();
  const client = routedClient({
    "GET /v1/products/prod_S1": () => stripeProduct("S1", 1234),
  });
  const deps = { db, client, now: NOW };
  assertEquals(
    refreshed(
      await projectStripeEvent(deps, {
        id: "evt",
        type: "product.updated",
        objectId: "prod_S1",
        objectType: "product",
      }),
    ),
    [S1],
  );
  const call = client.calls[0]!;
  assertEquals(`${call.method} ${call.path}`, "GET /v1/products/prod_S1");
  assertEquals(formOf(call, "expand[0]"), "default_price");
  const s1 = db.rows(tier).find((row) => row.id === S1);
  assertEquals([s1?.priceCents, s1?.currency], [1234, "usd"]);
  assertEquals(s1?.updatedAt !== NOW, true);
  // The other tier's cache is untouched.
  assertEquals(db.rows(tier).find((row) => row.id === S2)?.priceCents, 2000);

  assertEquals(
    skipped(
      await projectStripeEvent(deps, {
        id: "evt",
        type: "product.updated",
        objectId: "prod_nope",
        objectType: "product",
      }),
    ),
    "product_not_a_tier",
  );
  assertEquals(client.calls.length, 1);
  assertEquals(rowCounts(db), { payer: 0, subscription: 0, seat: 0 });
});

test("price.updated reads the price for its product only, then refreshes from the product — a retired price never overwrites the cache", async () => {
  const db = emptyDb();
  const client = routedClient({
    // The event's price is archived at 999; the product's default price is what lands.
    "GET /v1/prices/price_S2_old": () => ({
      id: "price_S2_old",
      object: "price",
      active: false,
      unit_amount: 999,
      product: "prod_S2",
    }),
    "GET /v1/products/prod_S2": () => stripeProduct("S2", 2500),
    "GET /v1/prices/price_orphan": () => ({
      id: "price_orphan",
      object: "price",
      product: null,
    }),
    "GET /v1/prices/price_other": () => ({
      id: "price_other",
      object: "price",
      product: { id: "prod_other", object: "product" },
    }),
  });
  const deps = { db, client, now: NOW };
  assertEquals(
    refreshed(
      await projectStripeEvent(deps, {
        id: "evt",
        type: "price.updated",
        objectId: "price_S2_old",
        objectType: "price",
      }),
    ),
    [S2],
  );
  assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), [
    "GET /v1/prices/price_S2_old",
    "GET /v1/products/prod_S2",
  ]);
  assertEquals(formOf(client.calls[1]!, "expand[0]"), "default_price");
  assertEquals(db.rows(tier).find((row) => row.id === S2)?.priceCents, 2500);

  assertEquals(
    skipped(
      await projectStripeEvent(deps, {
        id: "evt",
        type: "price.updated",
        objectId: "price_orphan",
        objectType: "price",
      }),
    ),
    "product_missing",
  );
  // An expanded product on the price is read for its id like any id-or-object field.
  assertEquals(
    skipped(
      await projectStripeEvent(deps, {
        id: "evt",
        type: "price.updated",
        objectId: "price_other",
        objectType: "price",
      }),
    ),
    "product_not_a_tier",
  );
  assertEquals(client.calls.length, 4);
});

test("a product whose default price has no unit_amount leaves the cached price alone", async () => {
  const db = emptyDb();
  const client = routedClient({
    "GET /v1/products/prod_S1": () =>
      stripeProduct("S1", 0, {
        default_price: {
          id: "price_S1",
          object: "price",
          active: true,
          currency: "usd",
          unit_amount: null,
        },
      }),
  });
  assertEquals(
    refreshed(
      await projectStripeEvent({ db, client, now: NOW }, {
        id: "evt",
        type: "product.updated",
        objectId: "prod_S1",
        objectType: "product",
      }),
    ),
    [S1],
  );
  const s1 = db.rows(tier).find((row) => row.id === S1);
  assertEquals([s1?.priceCents, s1?.updatedAt], [1000, NOW]);
});
