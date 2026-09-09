#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net=api.stripe.com
/**
 * C16 — the live-Stripe lifecycle harness, on test clocks.
 *
 *   TURBOPANEL_STRIPE_SECRET_KEY=sk_test_… TURBOPANEL_DATABASE_URL=… \
 *     deno task billing:test-clocks                      # every scenario
 *     deno task billing:test-clocks deferred-downgrade   # one, by name
 *
 * Or, as `deno test`, one test per scenario:
 *
 *     deno test -A scripts/billing-test-clock-harness.test.ts
 *
 * Six scenarios, one lifecycle case each:
 *
 *   partial-first-month     signup mid-month: day-1 anchor, prorated first invoice
 *   mid-cycle-upgrade       S3 → S5 parked as a pending update; entitlement rises
 *                           only once the proration invoice is paid and Stripe applies it
 *   deferred-downgrade      S5 → S3 parked on a schedule; lands at the boundary, no credit
 *   quantity-up-down        +2 seats now (invoiced), −1 seat at the boundary, one scenario
 *   upgrade-while-past-due  a failed renewal makes every raise `409 subscription_past_due`
 *                           before any Stripe write; recovery lifts the block
 *   dunning-retry-window    the failed renewal stays `past_due` through Smart Retries'
 *                           window with entitlement intact; the grace clock cancels at expiry
 *
 * Every seat or tier change goes through the **exported mutation path the
 * console uses** — `changeSeats`, `upgradeTier`, `downgradeTier` in
 * `src/client/billing/mutations.ts`, the bodies of the `/billing/*` routes
 * — so what is proved is the real contract: the same gates, the same
 * ledger writes, the same `mutateSubscription` call, the same reprojection
 * under the same lease. Nothing here writes `server.assigned_tier_id`,
 * `license.revoked_at` or a ledger row directly; the only direct writes
 * are setup — minting a license, inserting the server it binds to and
 * latching `license.server_id` — which are the operator's mint and the
 * daemon's enroll, neither of which has a route the harness can reach
 * without a session.
 *
 * Assertions are on what production reads — the `payer` / `subscription`
 * / `seat` rows, the ledger and the derived `server.assigned_tier_id`
 * after `projectSubscriptionById` (the seam the webhook task ends in,
 * which recomputes the assignment) — never on Stripe's object state. A
 * license carries no tier: the tier a scenario "moves" is the one its
 * licensed server is assigned from the purchased quantities. The one thing
 * not done is delivering a signed webhook: the projection is called where
 * the deferred task would call it, which is the same code and the same
 * rows.
 *
 * **One time base.** The scenario's clock is its wall clock: every
 * projection `now`, every intent timestamp, every `prorationDate` and the
 * grace clock's `nowMs` read the test clock's frozen time, so a latch
 * written at a simulated boundary and a sweep run at a simulated expiry
 * agree. Mixing in `Date.now()` would make the grace assertions vacuous.
 *
 * Needs a sandbox whose catalogue a superadmin has entered under Admin →
 * Tiers (exactly one active `S3` and one `S5`, each naming a product whose
 * default price verifies against Stripe) and **no Billing Automations**
 * configured — see the runbook in `src/lib/billing/AGENTS.md`. The harness
 * itself only ever *reads* tier rows; it has never written them and must
 * not start (the mutations it drives refresh a row's cached display price
 * from the product, as production does). Every scenario gets a fresh
 * test clock and a fresh throw-away organization; both, and the
 * organization's servers, ledger and lease rows, are removed in a
 * `finally`. The grace clock is never run as the batch:
 * `runGraceClockForSubscription` sees this scenario's subscription and
 * nothing else in the database.
 *
 * The traps the shared helpers absorb so no scenario has to know them:
 *
 *  - `advanceAndSettle` advances to the target and then one more simulated
 *    hour, because Stripe finalizes the draft invoice a billing boundary
 *    creates roughly an hour after the boundary.
 *  - `fetchInvoicesForSubscription` always filters by subscription id; an
 *    unfiltered invoice list on a busy sandbox is slow and misleading.
 *  - `pause` advances the clock a few simulated minutes between mutations,
 *    which keeps consecutive writes clear of Stripe's per-frozen-time rate
 *    limit on test clocks.
 *  - Customers are created **on the clock** (`test_clock` at create time);
 *    a clock cannot be attached afterwards.
 *  - Cards are test **tokens** (`tok_visa`, `tok_chargeCustomerFail`),
 *    never raw numbers. The failing card attaches fine and fails every
 *    charge — that is the dunning card.
 *  - A test clock advances at most a couple of billing intervals per call;
 *    the retry window is walked in fortnights.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createDenoDb, type Db, endDbConnection } from "../src/db.ts";
import { createLicense } from "../src/client/authn/license.ts";
import {
  changeSeats,
  downgradeTier,
  upgradeTier,
} from "../src/client/billing/mutations.ts";
import { SUBSCRIPTION_PAST_DUE_ERROR } from "../src/client/billing/routes-helpers.ts";
import { createStripeClient, type StripeClient } from "../src/lib/billing/client.ts";
import { resolveBillingConfig, STRIPE_SECRET_KEY_ENV } from "../src/lib/billing/config.ts";
import { STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY } from "../src/lib/billing/customer-subject.ts";
import { resolveBillingGateway } from "../src/lib/billing/gateway.ts";
import { runGraceClockForSubscription } from "../src/lib/billing/grace-clock.ts";
import { billingPendingChangesKey, readPendingChanges } from "../src/lib/billing/pending-changes.ts";
import { billingQuantityLockKey } from "../src/lib/billing/quantity-lock.ts";
import { createSubscription } from "../src/lib/billing/subscriptions.ts";
import {
  advanceTestClock,
  createTestClock,
  deleteTestClock,
  getTestClock,
  type TestClock,
} from "../src/lib/billing/test-clock.ts";
import {
  BILLING_GRACE_WINDOW_MS,
  isDelinquentStatus,
  listSeatsForOrganization,
  type OrganizationBillingState,
  seatQuantitiesByTier,
} from "../src/lib/db/billing-records.ts";
import { license, organization, server, setting } from "../src/lib/db/schema.ts";
import { listActiveTiers, type TierRow } from "../src/lib/db/tier-records.ts";
import { ladderEntry } from "../src/lib/tiers/ladder.ts";
import { projectSubscriptionById } from "../src/webhook/billing/stripe-projection.ts";

type StripeObject = Record<string, unknown>;

/** Simulated start: mid-month, so the first invoice is a visible proration to the day-1 anchor. */
export const HARNESS_FROZEN_START_UNIX = Math.floor(Date.UTC(2031, 0, 15, 12, 0, 0) / 1000);
/** The day-1 00:00 UTC anchor after the start — what `current_period_end` must read. */
export const HARNESS_FIRST_PERIOD_END_UNIX = Math.floor(Date.UTC(2031, 1, 1, 0, 0, 0) / 1000);
export const HARNESS_SECOND_PERIOD_END_UNIX = Math.floor(Date.UTC(2031, 2, 1, 0, 0, 0) / 1000);

const HOUR_S = 3600;
const MINUTE_S = 60;
const DAY_S = 24 * HOUR_S;
/** Simulated minutes between consecutive mutations on one clock. */
const PAUSE_MINUTES = 5;
/** The step the dunning scenario walks the retry window in. */
export const RETRY_WINDOW_STEP_S = 14 * DAY_S;
/** Real-time polling for Stripe to apply a paid pending update. */
const PENDING_APPLY_POLL_ATTEMPTS = 10;
const PENDING_APPLY_POLL_MS = 2_000;

export type HarnessLog = (line: string) => void;

/**
 * A tier row plus the price id its product's default price resolved to
 * when the harness opened — what `subscribe` names in `lines[n].price`,
 * the same id `resolveTierPrice` hands the mutations.
 */
export type HarnessTier = TierRow & { providerProductId: string; providerPriceId: string };

export type Harness = Readonly<{
  db: Db;
  client: StripeClient;
  /** The active S3 and S5 rows whose products verified against Stripe, by label. */
  tiers: ReadonlyMap<string, HarnessTier>;
  log: HarnessLog;
}>;

/** What one scenario runs inside: its own clock and its own organization. */
export type ScenarioContext = Harness & Readonly<{
  name: string;
  clock: TestClock;
  organizationId: string;
  /** The clock's last known frozen time (Unix seconds) — the scenario's wall clock. */
  time: { frozen: number };
}>;

export type Scenario = Readonly<{
  name: string;
  /** The lifecycle step it proves, in the numbering of `src/lib/billing/AGENTS.md`. */
  covers: string;
  run: (ctx: ScenarioContext) => Promise<void>;
}>;

export class HarnessAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessAssertionError";
  }
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HarnessAssertionError(message);
}

export function checkEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    throw new HarnessAssertionError(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isObject(value: unknown): value is StripeObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unixToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** The scenario's "now": the clock's frozen time. */
export function nowMs(ctx: ScenarioContext): number {
  return ctx.time.frozen * 1000;
}

function nowIso(ctx: ScenarioContext): string {
  return unixToIso(ctx.time.frozen);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Opening and closing the harness
// ---------------------------------------------------------------------------

/**
 * Resolve the key and the database, and load the tier catalogue a
 * superadmin entered (Admin → Tiers). Throws
 * with a plain message when either is missing so `deno test` reports the
 * prerequisite rather than a stack.
 */
export async function openHarness(log: HarnessLog = console.log): Promise<Harness & { close: () => Promise<void> }> {
  const config = resolveBillingConfig(Deno.env.toObject());
  if (!config) throw new Error(`${STRIPE_SECRET_KEY_ENV} is unset; the harness needs a test-mode key`);
  if (!config.secretKey.startsWith("sk_test_")) {
    throw new Error("the harness runs only on a test-mode key (sk_test_…): test clocks do not exist on live");
  }
  const client = createStripeClient(config);
  const db = createDenoDb();

  // Nothing seeds the catalogue: the harness takes whatever a superadmin
  // entered and insists only that the two labels it drives are unambiguous
  // and each name a product. Two active S3 rows would make "upgrade S3 →
  // S5" mean two things.
  const catalogued = (await listActiveTiers(db)).filter((row) => Boolean(row.providerProductId));
  const rows = new Map<string, TierRow & { providerProductId: string }>();
  for (const label of ["S3", "S5"] as const) {
    const matches = catalogued.filter((row) => row.label === label);
    if (matches.length !== 1) {
      await endDbConnection(db);
      throw new Error(
        `expected exactly one active catalogued ${label} tier, found ${matches.length}: ` +
          "enter the catalogue under Admin → Tiers (and deactivate superseded rows)",
      );
    }
    const row = matches[0]!;
    rows.set(label, { ...row, providerProductId: row.providerProductId! });
  }

  const s3 = rows.get("S3")!;
  const s5 = rows.get("S5")!;
  if (s5.rank <= s3.rank) {
    await endDbConnection(db);
    throw new Error(
      `S5 must rank above S3 (got ${s5.rank} ≤ ${s3.rank}): the scenarios read "upgrade" and ` +
        "\"downgrade\" off rank order",
    );
  }

  // The same read-only verification the admin route runs before writing a
  // row, through the gateway seam. Rows are hand-entered now, so a product
  // that drifted (archived, no default price, re-denominated, switched to
  // tiered billing) would otherwise surface as an inscrutable mid-scenario
  // failure. The default price's id is what every subscribe line names;
  // its amount is what the invoice-total assertions compare against, so
  // the row's cached display price must agree with it.
  const gateway = resolveBillingGateway(client);
  // One tax-settings lookup for the whole catalogue — verifyProduct is
  // pure and the caller supplies the account defaults.
  const taxDefaults = await gateway.getTaxDefaults();
  const tiers = new Map<string, HarnessTier>();
  for (const row of rows.values()) {
    const product = await gateway.getProduct(row.providerProductId);
    const verified = gateway.verifyProduct(product, taxDefaults);
    const price = product.defaultPrice;
    if (!verified.ok || !price) {
      await endDbConnection(db);
      throw new Error(
        `tier ${row.label} (${row.providerProductId}) does not verify against Stripe: ` +
          `${verified.failures.join("; ")} — fix it under Admin → Tiers`,
      );
    }
    if (price.unitAmount !== row.priceCents) {
      await endDbConnection(db);
      throw new Error(
        `tier ${row.label} (${row.providerProductId}) shows ${row.priceCents} but its default price ` +
          `${price.id} bills ${price.unitAmount}: re-verify it under Admin → Tiers so invoice totals compare`,
      );
    }
    tiers.set(row.label, { ...row, providerPriceId: price.id });
  }

  return { db, client, tiers, log, close: () => endDbConnection(db) };
}

async function createScenarioOrganization(db: Db, name: string): Promise<string> {
  const slug = `harness-${name}-${crypto.randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(organization)
    .values({ name: `Billing harness: ${name}`, slug })
    .returning({ id: organization.id });
  if (!row) throw new Error("organization insert returned no row");
  return row.id;
}

/** One fresh clock per scenario, at the fixed simulated start. */
export async function createScenarioClock(client: StripeClient, name: string): Promise<TestClock> {
  return await createTestClock(client, {
    frozenTime: HARNESS_FROZEN_START_UNIX,
    name: `turbopanel-harness-${name}`,
  });
}

/**
 * Run one scenario inside a fresh clock and organization; both are removed
 * in `finally` whatever happens. Deleting the clock deletes its customers,
 * subscriptions and invoices; deleting the organization cascades through
 * `payer` → `subscription` → `seat` and `license`. The `server` rows a
 * scenario binds licenses to restrict the organization delete, so they go
 * first (which nulls `license.server_id`). The ledger and lease live in
 * `setting` rows keyed by organization, which do not cascade, so they are
 * deleted by key — a scenario that failed halfway leaves nothing.
 */
export async function runScenario(harness: Harness, scenario: Scenario): Promise<void> {
  const log = (line: string) => harness.log(`[${scenario.name}] ${line}`);
  log(`start (${scenario.covers})`);
  const clock = await createScenarioClock(harness.client, scenario.name);
  const organizationId = await createScenarioOrganization(harness.db, scenario.name);
  try {
    await scenario.run({
      ...harness,
      log,
      name: scenario.name,
      clock,
      organizationId,
      time: { frozen: clock.frozenTime },
    });
    log("ok");
  } finally {
    await harness.db
      .delete(setting)
      .where(inArray(setting.key, [billingPendingChangesKey(organizationId), billingQuantityLockKey(organizationId)]))
      .catch((err) => {
        log(`cleanup: ledger/lease delete failed: ${String(err)}`);
      });
    await harness.db.delete(server).where(eq(server.organizationId, organizationId)).catch((err) => {
      log(`cleanup: server delete failed: ${String(err)}`);
    });
    await harness.db.delete(organization).where(eq(organization.id, organizationId)).catch((err) => {
      log(`cleanup: organization delete failed: ${String(err)}`);
    });
    await deleteTestClock(harness.client, clock.id).catch((err) => {
      log(`cleanup: test clock delete failed: ${String(err)}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Shared helpers — every trap lives here, not in a scenario
// ---------------------------------------------------------------------------

/** Advance the scenario's clock to `targetUnixSeconds`, wait for `ready`, and move the scenario's "now". */
export async function advanceTo(ctx: ScenarioContext, targetUnixSeconds: number): Promise<TestClock> {
  ctx.log(`advance clock → ${unixToIso(targetUnixSeconds)}`);
  const clock = await advanceTestClock(ctx.client, { clockId: ctx.clock.id, frozenTime: targetUnixSeconds });
  ctx.time.frozen = clock.frozenTime;
  return clock;
}

/**
 * Advance to `targetUnixSeconds`, then one more simulated hour, and wait
 * for `ready` after each step. The extra hour is when Stripe finalizes and
 * pays (or fails to pay) the draft invoice a boundary creates; asserting on
 * invoices before it sees a draft.
 */
export async function advanceAndSettle(ctx: ScenarioContext, targetUnixSeconds: number): Promise<TestClock> {
  await advanceTo(ctx, targetUnixSeconds);
  const settled = await advanceTo(ctx, targetUnixSeconds + HOUR_S);
  ctx.log(`clock ready at ${unixToIso(settled.frozenTime)}`);
  return settled;
}

/** A few simulated minutes between mutations, so consecutive writes never share a frozen time. */
export async function pause(ctx: ScenarioContext, simulatedMinutes = PAUSE_MINUTES): Promise<TestClock> {
  // Re-read: the clock may have moved on Stripe's side since the last snapshot.
  const current = await getTestClock(ctx.client, ctx.clock.id);
  return await advanceTo(ctx, current.frozenTime + simulatedMinutes * MINUTE_S);
}

export type InvoiceSummary = Readonly<{
  id: string;
  status: string | null;
  total: number;
  amountPaid: number;
  created: number;
}>;

/** Invoices for one subscription only — never the unfiltered list. */
export async function fetchInvoicesForSubscription(
  client: StripeClient,
  providerSubscriptionId: string,
): Promise<InvoiceSummary[]> {
  const rows = await client.listAll<StripeObject>("/v1/invoices", {
    subscription: providerSubscriptionId,
  });
  return rows
    .map((raw) => ({
      id: str(raw.id) ?? "",
      status: str(raw.status),
      total: typeof raw.total === "number" ? raw.total : 0,
      amountPaid: typeof raw.amount_paid === "number" ? raw.amount_paid : 0,
      created: typeof raw.created === "number" ? raw.created : 0,
    }))
    .sort((a, b) => a.created - b.created);
}

/** The one `open` invoice on a subscription — the unpaid proration or renewal a scenario pays by hand. */
async function openInvoiceFor(ctx: ScenarioContext, providerSubscriptionId: string): Promise<InvoiceSummary> {
  const open = (await fetchInvoicesForSubscription(ctx.client, providerSubscriptionId)).filter((invoice) =>
    invoice.status === "open"
  );
  checkEqual(open.length, 1, `open invoices on ${providerSubscriptionId}`);
  return open[0]!;
}

/** Pay an open invoice with a named card; Stripe applies a pending update or clears `past_due` on success. */
async function payInvoice(ctx: ScenarioContext, invoiceId: string, paymentMethodId: string): Promise<void> {
  await ctx.client.post(`/v1/invoices/${encodeURIComponent(invoiceId)}/pay`, { payment_method: paymentMethodId });
  ctx.log(`invoice ${invoiceId} paid with ${paymentMethodId}`);
}

/** Wait (real time, bounded) until Stripe has applied a paid pending update. */
async function waitForPendingUpdateApplied(ctx: ScenarioContext, providerSubscriptionId: string): Promise<void> {
  for (let attempt = 0; attempt < PENDING_APPLY_POLL_ATTEMPTS; attempt += 1) {
    const sub = await ctx.client.get<StripeObject>(`/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`);
    if (!isObject(sub.pending_update)) return;
    await sleep(PENDING_APPLY_POLL_MS);
  }
  throw new HarnessAssertionError(`subscription ${providerSubscriptionId} still carries pending_update after payment`);
}

export type ClockCustomerOpts = Readonly<{
  /** `tok_chargeCustomerFail` attaches fine and then fails every charge — the dunning card. */
  failingCard?: boolean;
}>;

/**
 * A customer created **on the clock**, naming the scenario's organization
 * in metadata exactly as `checkout.ts` would, with a US address (automatic
 * tax needs a resolvable location) and a default card from a test token.
 */
export async function createClockCustomer(
  ctx: ScenarioContext,
  opts: ClockCustomerOpts = {},
): Promise<{ providerCustomerId: string; paymentMethodId: string }> {
  const customer = await ctx.client.post<StripeObject>("/v1/customers", {
    test_clock: ctx.clock.id,
    name: `TurboPanel harness ${ctx.name}`,
    email: `harness+${ctx.name}@example.invalid`,
    metadata: { [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: ctx.organizationId },
    address: { line1: "510 Townsend St", city: "San Francisco", state: "CA", postal_code: "94103", country: "US" },
  });
  const providerCustomerId = str(customer.id);
  check(providerCustomerId, "customer create returned no id");
  const paymentMethodId = await attachCard(ctx, providerCustomerId, opts.failingCard === true);
  ctx.log(`customer ${providerCustomerId} on clock ${ctx.clock.id} (${opts.failingCard ? "failing" : "good"} card)`);
  return { providerCustomerId, paymentMethodId };
}

/** Attach a test-token card and make it the default for invoices. */
export async function attachCard(
  ctx: ScenarioContext,
  providerCustomerId: string,
  failing: boolean,
): Promise<string> {
  const pm = await ctx.client.post<StripeObject>("/v1/payment_methods", {
    type: "card",
    card: { token: failing ? "tok_chargeCustomerFail" : "tok_visa" },
  });
  const paymentMethodId = str(pm.id);
  check(paymentMethodId, "payment method create returned no id");
  await ctx.client.post(`/v1/payment_methods/${encodeURIComponent(paymentMethodId)}/attach`, {
    customer: providerCustomerId,
  });
  await ctx.client.post(`/v1/customers/${encodeURIComponent(providerCustomerId)}`, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
  ctx.log(`${failing ? "failing" : "good"} card ${paymentMethodId} is now the default`);
  return paymentMethodId;
}

/**
 * C2 through the real `createSubscription`: `default_incomplete` leaves the
 * subscription `incomplete` until its first invoice is paid, which is what
 * Checkout's payment step does in production; here the invoice is paid
 * with the customer's default card.
 */
export async function subscribe(
  ctx: ScenarioContext,
  providerCustomerId: string,
  lines: readonly { label: string; quantity: number }[],
): Promise<{ providerSubscriptionId: string }> {
  const created = await createSubscription(ctx.client, {
    providerCustomerId,
    lines: lines.map((line) => ({ price: tierOf(ctx, line.label).providerPriceId, quantity: line.quantity })),
    idempotencyKey: `harness:${ctx.name}:${providerCustomerId}:subscribe`,
  });
  const sub = await ctx.client.get<StripeObject>(
    `/v1/subscriptions/${encodeURIComponent(created.providerSubscriptionId)}`,
    { expand: ["latest_invoice"] },
  );
  const invoice = isObject(sub.latest_invoice) ? sub.latest_invoice : null;
  const invoiceId = invoice ? str(invoice.id) : null;
  check(invoiceId, "new subscription carries no latest_invoice");
  if (invoice && str(invoice.status) !== "paid") {
    await ctx.client.post(`/v1/invoices/${encodeURIComponent(invoiceId)}/pay`, {});
  }
  ctx.log(`subscription ${created.providerSubscriptionId} created (${created.status}), first invoice ${invoiceId} paid`);
  return { providerSubscriptionId: created.providerSubscriptionId };
}

export function tierOf(ctx: Harness, label: string): HarnessTier {
  const row = ctx.tiers.get(label);
  if (!row) throw new Error(`tier ${label} has not been entered in Admin → Tiers`);
  return row;
}

/** The webhook task's seam, called where the task would call it, at the scenario's "now". */
export async function project(ctx: ScenarioContext, providerSubscriptionId: string): Promise<OrganizationBillingState> {
  const outcome = await projectSubscriptionById(
    { db: ctx.db, client: ctx.client, now: nowIso(ctx) },
    providerSubscriptionId,
  );
  check(outcome.action === "projected", `projection skipped: ${JSON.stringify(outcome)}`);
  return await listSeatsForOrganization(ctx.db, ctx.organizationId);
}

/** What the routes hand `mutations.ts`, with the scenario's clock as the clock. */
export function mutationDeps(ctx: ScenarioContext, client: StripeClient = ctx.client) {
  return { db: ctx.db, client, nowMs: () => nowMs(ctx) };
}

/** A client that counts writes, for proving a refusal happened before any. */
function countingClient(client: StripeClient): StripeClient & { writes: () => number } {
  let writes = 0;
  return {
    get: (path, query) => client.get(path, query),
    listAll: (path, query) => client.listAll(path, query),
    post: (path, body, opts) => {
      writes += 1;
      return client.post(path, body, opts);
    },
    del: (path, opts) => {
      writes += 1;
      return client.del(path, opts);
    },
    writes: () => writes,
  };
}

function quantity(state: OrganizationBillingState, tierId: string): number {
  return seatQuantitiesByTier(state).get(tierId) ?? 0;
}

async function ledgerIntents(ctx: ScenarioContext, providerSubscriptionId: string) {
  const { ledger } = await readPendingChanges(ctx.db, ctx.organizationId, providerSubscriptionId);
  return ledger.intents;
}

async function licenseRow(ctx: ScenarioContext, licenseId: string): Promise<{ revokedAt: string | null }> {
  const [row] = await ctx.db
    .select({ revokedAt: license.revokedAt })
    .from(license)
    .where(eq(license.id, licenseId));
  check(row, `license ${licenseId} exists`);
  return row;
}

/** Ids of the organization's licenses that are still live — zero once the subscription ended. */
async function activeLicenseIds(ctx: ScenarioContext): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: license.id })
    .from(license)
    .where(and(eq(license.organizationId, ctx.organizationId), isNull(license.revokedAt)));
  return rows.map((row) => row.id);
}

/** The derived tier a server sits on, as the reprojection last wrote it. */
async function assignedTierOf(ctx: ScenarioContext, serverId: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ assignedTierId: server.assignedTierId })
    .from(server)
    .where(eq(server.id, serverId));
  check(row, `server ${serverId} exists`);
  return row.assignedTierId;
}

/**
 * Setup only: the operator's mint, without the route (which needs a
 * session). A license carries no tier. The token is discarded — the
 * harness never enrolls a server through the daemon.
 */
async function mintLicense(ctx: ScenarioContext): Promise<string> {
  const { licenseId } = await createLicense(ctx.db, {
    organizationId: ctx.organizationId,
    name: `harness ${ctx.name}`,
  });
  return licenseId;
}

/**
 * Setup only: the daemon's enroll, without the daemon. A `server` row whose
 * reported hardware sits exactly at `sizedFor`'s placement ceilings, so
 * `tier-placement` requires that rank and the greedy assignment puts it on
 * the smallest purchased tier at or above it; the license is latched to it
 * as enroll would (`license.server_id`). The assignment itself is written
 * by the next projection or mutation, never here.
 */
async function bindLicenseToServer(ctx: ScenarioContext, licenseId: string, sizedFor: string): Promise<string> {
  const entry = ladderEntry(sizedFor);
  check(entry, `${sizedFor} is on the ladder`);
  const [row] = await ctx.db
    .insert(server)
    .values({
      organizationId: ctx.organizationId,
      name: `harness ${ctx.name} (${sizedFor}-sized)`,
      createdAt: nowIso(ctx),
      updatedAt: nowIso(ctx),
      metadata: {
        resources: {
          cpus: [{ cores: { total: entry.maxCores } }],
          memory: { totalBytes: entry.maxMemoryBytes },
        },
      },
    })
    .returning({ id: server.id });
  check(row, "server insert returned no row");
  await ctx.db.update(license).set({ serverId: row.id, updatedAt: nowIso(ctx) }).where(eq(license.id, licenseId));
  ctx.log(`license ${licenseId} bound to server ${row.id} sized for ${sizedFor}`);
  return row.id;
}

/** Mint a license and bind it to a server sized for `sizedFor`, in one setup step. */
async function mintBoundLicense(
  ctx: ScenarioContext,
  sizedFor: string,
): Promise<{ licenseId: string; serverId: string }> {
  const licenseId = await mintLicense(ctx);
  const serverId = await bindLicenseToServer(ctx, licenseId, sizedFor);
  return { licenseId, serverId };
}

/**
 * Subscribe on a good card, mint one license bound to a server sized for
 * `mintLabel`, project (which assigns the server that tier), swap in the
 * dunning card, and let the first renewal fail: the shared opening of the
 * two delinquency scenarios.
 */
async function failRenewal(
  ctx: ScenarioContext,
  mintLabel: string,
): Promise<{
  providerCustomerId: string;
  providerSubscriptionId: string;
  licenseId: string;
  serverId: string;
  state: OrganizationBillingState;
}> {
  const { providerCustomerId } = await createClockCustomer(ctx);
  const { providerSubscriptionId } = await subscribe(ctx, providerCustomerId, [{ label: mintLabel, quantity: 1 }]);
  const { licenseId, serverId } = await mintBoundLicense(ctx, mintLabel);
  await project(ctx, providerSubscriptionId);
  checkEqual(await assignedTierOf(ctx, serverId), tierOf(ctx, mintLabel).id, `server assigned ${mintLabel} on purchase`);
  await attachCard(ctx, providerCustomerId, true);
  await advanceAndSettle(ctx, HARNESS_FIRST_PERIOD_END_UNIX);
  const state = await project(ctx, providerSubscriptionId);
  checkEqual(state.subscription?.status, "past_due", "status after the failed renewal");
  check(state.subscription?.pastDueSince, "past_due_since latched");
  check(state.subscription?.graceExpiresAt, "grace_expires_at latched");
  return { providerCustomerId, providerSubscriptionId, licenseId, serverId, state };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const partialFirstMonth: Scenario = {
  name: "partial-first-month",
  covers: "C2 — signup mid-month: day-1 anchor, prorated first invoice, active projection",
  async run(ctx) {
    const s3 = tierOf(ctx, "S3");
    const { providerCustomerId } = await createClockCustomer(ctx);
    const { providerSubscriptionId } = await subscribe(ctx, providerCustomerId, [{ label: "S3", quantity: 2 }]);

    const state = await project(ctx, providerSubscriptionId);
    check(state.payer?.organizationId === ctx.organizationId, "payer row names the organization");
    checkEqual(state.subscription?.status, "active", "subscription status");
    checkEqual(state.subscription?.providerSubscriptionId, providerSubscriptionId, "subscription id");
    checkEqual(state.subscription?.pastDueSince, null, "no past-due latch on a paid first invoice");
    checkEqual(quantity(state, s3.id), 2, "S3 seats");
    checkEqual(
      state.subscription?.currentPeriodEnd,
      unixToIso(HARNESS_FIRST_PERIOD_END_UNIX),
      "current_period_end is the day-1 00:00 UTC anchor",
    );

    const invoices = await fetchInvoicesForSubscription(ctx.client, providerSubscriptionId);
    checkEqual(invoices.length, 1, "invoice count after first purchase");
    const full = (s3.priceCents ?? 0) * 2;
    check(invoices[0]!.total > 0 && invoices[0]!.total < full, `first invoice is a proration (0 < ${invoices[0]!.total} < ${full})`);
    checkEqual(invoices[0]!.status, "paid", "first invoice status");
  },
};

const midCycleUpgrade: Scenario = {
  name: "mid-cycle-upgrade",
  covers: "C4/C6 — an upgrade Stripe cannot charge is parked; entitlement rises only once it applies",
  async run(ctx) {
    const s3 = tierOf(ctx, "S3");
    const s5 = tierOf(ctx, "S5");
    const { providerCustomerId } = await createClockCustomer(ctx);
    const { providerSubscriptionId } = await subscribe(ctx, providerCustomerId, [{ label: "S3", quantity: 1 }]);
    const { licenseId, serverId } = await mintBoundLicense(ctx, "S3");
    await project(ctx, providerSubscriptionId);
    checkEqual(await assignedTierOf(ctx, serverId), s3.id, "server assigned S3 on purchase");

    // The proration invoice for the upgrade must fail: the dunning card is the default.
    await attachCard(ctx, providerCustomerId, true);
    await pause(ctx);
    const parked = await upgradeTier(mutationDeps(ctx), {
      organizationId: ctx.organizationId,
      fromTierId: s3.id,
      toTierId: s5.id,
      prorationDate: ctx.time.frozen,
    });
    check(parked.ok, `upgrade accepted: ${JSON.stringify(parked.body)}`);
    checkEqual(parked.body.pending, true, "upgrade parked under pending_update (pending_if_incomplete)");

    // The mutation reprojected under its lease; read what it wrote. An
    // upgrade is immediate, so it leaves no intent behind: its retry key
    // is the seat-increase record, dropped once the reprojection landed.
    let state = await listSeatsForOrganization(ctx.db, ctx.organizationId);
    checkEqual(state.subscription?.status, "active", "status while the update is pending");
    checkEqual(quantity(state, s3.id), 1, "S3 seats unchanged while pending");
    checkEqual(quantity(state, s5.id), 0, "no S5 seat while pending");
    checkEqual(await assignedTierOf(ctx, serverId), s3.id, "server still assigned S3 while pending");
    checkEqual((await ledgerIntents(ctx, providerSubscriptionId)).length, 0, "an upgrade writes no intent");

    // A replayed `updated` event changes nothing: pending_update is read for presence only.
    state = await project(ctx, providerSubscriptionId);
    checkEqual(quantity(state, s5.id), 0, "a reprojection while pending raises nothing");
    checkEqual(await assignedTierOf(ctx, serverId), s3.id, "assignment untouched by the reprojection");

    // Pay the parked proration with a good card: Stripe applies the pending
    // update, which is what `pending_update_applied` announces.
    const goodCard = await attachCard(ctx, providerCustomerId, false);
    const proration = await openInvoiceFor(ctx, providerSubscriptionId);
    check(proration.total > 0, "the parked proration invoice charges for the tier difference");
    await payInvoice(ctx, proration.id, goodCard);
    await waitForPendingUpdateApplied(ctx, providerSubscriptionId);

    state = await project(ctx, providerSubscriptionId);
    checkEqual(quantity(state, s3.id), 0, "S3 seats once applied");
    checkEqual(quantity(state, s5.id), 1, "S5 seats once applied");
    checkEqual(await assignedTierOf(ctx, serverId), s5.id, "server assigned S5 by the reprojection");
    checkEqual((await licenseRow(ctx, licenseId)).revokedAt, null, "license not revoked");
    checkEqual((await ledgerIntents(ctx, providerSubscriptionId)).length, 0, "ledger still empty once applied");

    const invoices = await fetchInvoicesForSubscription(ctx.client, providerSubscriptionId);
    checkEqual(invoices.length, 2, "first invoice plus the proration");
    checkEqual(invoices[1]!.status, "paid", "proration invoice paid");
  },
};

const deferredDowngrade: Scenario = {
  name: "deferred-downgrade",
  covers: "C5/C7 — a downgrade is parked on a schedule and lands at the boundary with no credit",
  async run(ctx) {
    const s3 = tierOf(ctx, "S3");
    const s5 = tierOf(ctx, "S5");
    const { providerCustomerId } = await createClockCustomer(ctx);
    const { providerSubscriptionId } = await subscribe(ctx, providerCustomerId, [{ label: "S5", quantity: 1 }]);
    // Sized for S3, not S5: the server must still fit once the downgrade
    // lands, or the coverage gate refuses it (`servers_uncovered`). Before
    // the boundary it takes the smallest purchased tier at or above its
    // rank, which is the S5 seat.
    const { licenseId, serverId } = await mintBoundLicense(ctx, "S3");
    await project(ctx, providerSubscriptionId);
    checkEqual(await assignedTierOf(ctx, serverId), s5.id, "server assigned S5 on purchase");
    await pause(ctx);

    const result = await downgradeTier(mutationDeps(ctx), {
      organizationId: ctx.organizationId,
      fromTierId: s5.id,
      toTierId: s3.id,
    });
    check(result.ok, `downgrade accepted: ${JSON.stringify(result.body)}`);
    checkEqual(result.body.deferred, true, "downgrade is deferred");
    check(result.body.scheduleId, "a schedule now carries the downgrade");

    let state = await project(ctx, providerSubscriptionId);
    checkEqual(state.subscription?.scheduleId, result.body.scheduleId, "projection records the schedule id");
    checkEqual(quantity(state, s5.id), 1, "S5 seat kept until the boundary");
    checkEqual(quantity(state, s3.id), 0, "no S3 seat before the boundary");
    checkEqual(await assignedTierOf(ctx, serverId), s5.id, "server stays on S5 until the boundary");
    const intents = await ledgerIntents(ctx, providerSubscriptionId);
    checkEqual(intents.length, 1, "downgrade intent outstanding before the boundary");
    checkEqual(intents[0]!.kind, "downgrade", "intent kind");
    checkEqual(intents[0]!.id, result.body.intentId, "intent id returned to the caller");
    checkEqual(intents[0]!.fromTierId, s5.id, "intent gives back one S5");
    checkEqual(intents[0]!.toTierId, s3.id, "intent takes one S3");
    checkEqual(intents[0]!.fromQuantity, 1, "intent records the S5 quantity it was written against");
    checkEqual(intents[0]!.landsAt, state.subscription?.currentPeriodEnd ?? null, "intent lands at the period end");

    await advanceAndSettle(ctx, HARNESS_FIRST_PERIOD_END_UNIX);
    state = await project(ctx, providerSubscriptionId);
    checkEqual(state.subscription?.status, "active", "status after the boundary");
    checkEqual(quantity(state, s5.id), 0, "S5 seat gone at the boundary");
    checkEqual(quantity(state, s3.id), 1, "S3 seat present at the boundary");
    checkEqual(await assignedTierOf(ctx, serverId), s3.id, "server assigned S3 by the reprojection at the boundary");
    checkEqual((await licenseRow(ctx, licenseId)).revokedAt, null, "license not revoked");
    checkEqual((await ledgerIntents(ctx, providerSubscriptionId)).length, 0, "downgrade intent landed");

    const invoices = await fetchInvoicesForSubscription(ctx.client, providerSubscriptionId);
    checkEqual(invoices.length, 2, "exactly the first invoice and the renewal — no proration, no credit");
    checkEqual(invoices[1]!.total, s3.priceCents ?? 0, "renewal bills the lower tier at full price");
    checkEqual(invoices[1]!.status, "paid", "renewal invoice paid");
  },
};

const quantityUpDown: Scenario = {
  name: "quantity-up-down",
  covers: "C3/C5 — seats added now and invoiced; a seat removed at the boundary with no proration",
  async run(ctx) {
    const s3 = tierOf(ctx, "S3");
    const { providerCustomerId } = await createClockCustomer(ctx);
    const { providerSubscriptionId } = await subscribe(ctx, providerCustomerId, [{ label: "S3", quantity: 1 }]);
    await project(ctx, providerSubscriptionId);
    await pause(ctx);

    // Up: immediate, prorated, invoiced now.
    const up = await changeSeats(mutationDeps(ctx), {
      organizationId: ctx.organizationId,
      tierId: s3.id,
      delta: 2,
      prorationDate: ctx.time.frozen,
    });
    check(up.ok, `raise accepted: ${JSON.stringify(up.body)}`);
    checkEqual(up.body.pending, false, "raise applied, not parked");
    checkEqual(up.body.deferred, false, "raise is immediate");
    let state = await listSeatsForOrganization(ctx.db, ctx.organizationId);
    checkEqual(quantity(state, s3.id), 3, "S3 seats after the raise");
    checkEqual(state.subscription?.status, "active", "status after the raise");
    let invoices = await fetchInvoicesForSubscription(ctx.client, providerSubscriptionId);
    checkEqual(invoices.length, 2, "a proration invoice was issued immediately (always_invoice)");
    check(invoices[1]!.total > 0, "proration invoice charges for the added seats");
    checkEqual(invoices[1]!.status, "paid", "proration invoice paid");

    // Down: deferred to the boundary, in the same scenario.
    await pause(ctx);
    const down = await changeSeats(mutationDeps(ctx), {
      organizationId: ctx.organizationId,
      tierId: s3.id,
      delta: -1,
    });
    check(down.ok, `decrease accepted: ${JSON.stringify(down.body)}`);
    checkEqual(down.body.deferred, true, "decrease is deferred");
    check(down.body.scheduleId, "a schedule now carries the decrease");
    state = await project(ctx, providerSubscriptionId);
    checkEqual(state.subscription?.scheduleId, down.body.scheduleId, "projection records the schedule id");
    checkEqual(quantity(state, s3.id), 3, "seats unchanged until the boundary");
    const intents = await ledgerIntents(ctx, providerSubscriptionId);
    checkEqual(intents.length, 1, "one release-seat intent outstanding");
    checkEqual(intents[0]!.kind, "release-seat", "intent kind");
    checkEqual(intents[0]!.fromTierId, s3.id, "intent gives back one S3");
    checkEqual(intents[0]!.toTierId, null, "a release takes nothing in exchange");
    checkEqual(intents[0]!.fromQuantity, 3, "intent records the S3 quantity it was written against");
    checkEqual(intents[0]!.landsAt, state.subscription?.currentPeriodEnd ?? null, "intent lands at the period end");

    await advanceAndSettle(ctx, HARNESS_FIRST_PERIOD_END_UNIX);
    state = await project(ctx, providerSubscriptionId);
    checkEqual(quantity(state, s3.id), 2, "seats after the boundary");
    checkEqual(state.subscription?.status, "active", "status after the boundary");
    checkEqual(
      state.subscription?.currentPeriodEnd,
      unixToIso(HARNESS_SECOND_PERIOD_END_UNIX),
      "current_period_end rolled to the next day-1 anchor",
    );
    checkEqual((await ledgerIntents(ctx, providerSubscriptionId)).length, 0, "release intent consumed at the boundary");

    invoices = await fetchInvoicesForSubscription(ctx.client, providerSubscriptionId);
    checkEqual(invoices.length, 3, "first invoice, the raise's proration, the renewal — nothing for the decrease");
    checkEqual(invoices[2]!.total, (s3.priceCents ?? 0) * 2, "renewal bills the reduced quantity at full price");
    checkEqual(invoices[2]!.status, "paid", "renewal invoice paid");
  },
};

const upgradeWhilePastDue: Scenario = {
  name: "upgrade-while-past-due",
  covers: "C8 — every entitlement-raising mutation is refused while past_due, before any Stripe write",
  async run(ctx) {
    const s3 = tierOf(ctx, "S3");
    const s5 = tierOf(ctx, "S5");
    const { providerCustomerId, providerSubscriptionId, licenseId, serverId, state: pastDue } = await failRenewal(
      ctx,
      "S3",
    );
    const invoicesBefore = await fetchInvoicesForSubscription(ctx.client, providerSubscriptionId);
    const graceExpiresAt = pastDue.subscription!.graceExpiresAt;

    const counting = countingClient(ctx.client);
    const upgrade = await upgradeTier(mutationDeps(ctx, counting), {
      organizationId: ctx.organizationId,
      fromTierId: s3.id,
      toTierId: s5.id,
      prorationDate: ctx.time.frozen,
    });
    check(!upgrade.ok, "upgrade refused while past_due");
    checkEqual(upgrade.status, 409, "upgrade refusal status");
    checkEqual(upgrade.body.error, SUBSCRIPTION_PAST_DUE_ERROR, "upgrade refusal error");
    checkEqual(upgrade.body.graceExpiresAt, graceExpiresAt, "refusal names the grace expiry");

    const raise = await changeSeats(mutationDeps(ctx, counting), {
      organizationId: ctx.organizationId,
      tierId: s3.id,
      delta: 1,
      prorationDate: ctx.time.frozen,
    });
    check(!raise.ok, "seat raise refused while past_due");
    checkEqual(raise.status, 409, "seat raise refusal status");
    checkEqual(raise.body.error, SUBSCRIPTION_PAST_DUE_ERROR, "seat raise refusal error");

    checkEqual(counting.writes(), 0, "no Stripe write behind a refusal");
    checkEqual((await ledgerIntents(ctx, providerSubscriptionId)).length, 0, "no intent recorded behind a refusal");
    const [lease] = await ctx.db.select({ key: setting.key }).from(setting).where(
      eq(setting.key, billingQuantityLockKey(ctx.organizationId)),
    );
    checkEqual(lease, undefined, "the lease was released after the refusal");
    let state = await listSeatsForOrganization(ctx.db, ctx.organizationId);
    checkEqual(quantity(state, s3.id), 1, "entitlement unchanged by the refusals");
    checkEqual(await assignedTierOf(ctx, serverId), s3.id, "assignment unchanged by the refusals");
    checkEqual((await licenseRow(ctx, licenseId)).revokedAt, null, "license live through the refusals");
    const invoicesAfter = await fetchInvoicesForSubscription(ctx.client, providerSubscriptionId);
    checkEqual(invoicesAfter.length, invoicesBefore.length, "no invoice issued behind a refusal");

    // Recovery: pay the open renewal with a good card, and the block lifts.
    const goodCard = await attachCard(ctx, providerCustomerId, false);
    const renewal = await openInvoiceFor(ctx, providerSubscriptionId);
    await payInvoice(ctx, renewal.id, goodCard);
    await pause(ctx);
    state = await project(ctx, providerSubscriptionId);
    checkEqual(state.subscription?.status, "active", "status after the renewal is paid");
    checkEqual(state.subscription?.pastDueSince, null, "past_due_since cleared on recovery");
    checkEqual(state.subscription?.graceExpiresAt, null, "grace_expires_at cleared on recovery");

    const allowed = await upgradeTier(mutationDeps(ctx), {
      organizationId: ctx.organizationId,
      fromTierId: s3.id,
      toTierId: s5.id,
      prorationDate: ctx.time.frozen,
    });
    check(allowed.ok, `upgrade accepted once active again: ${JSON.stringify(allowed.body)}`);
    checkEqual(allowed.body.pending, false, "upgrade applied on the good card");
    state = await listSeatsForOrganization(ctx.db, ctx.organizationId);
    checkEqual(quantity(state, s5.id), 1, "S5 seat after the recovered upgrade");
    checkEqual(quantity(state, s3.id), 0, "S3 seat swapped out");
    checkEqual(await assignedTierOf(ctx, serverId), s5.id, "server assigned S5 by the mutation's reprojection");
  },
};

const dunningRetryWindow: Scenario = {
  name: "dunning-retry-window",
  covers: "C13 — past_due through Smart Retries' window with entitlement intact; the grace clock cancels at expiry",
  async run(ctx) {
    const s3 = tierOf(ctx, "S3");
    const { providerSubscriptionId, licenseId, serverId, state: pastDue } = await failRenewal(ctx, "S3");
    const pastDueSince = pastDue.subscription!.pastDueSince!;
    const graceExpiresAt = pastDue.subscription!.graceExpiresAt!;
    checkEqual(Date.parse(graceExpiresAt) - Date.parse(pastDueSince), BILLING_GRACE_WINDOW_MS, "grace window length");
    checkEqual(quantity(pastDue, s3.id), 1, "entitlement survives the failed renewal");
    const graceExpiryUnix = Math.floor(Date.parse(graceExpiresAt) / 1000);

    // Walk the retry window a fortnight at a time. Smart Retries fire on the
    // clock and keep failing; the Dashboard leaves the subscription past-due
    // rather than ending it, so the latch holds and nothing is revoked.
    let steps = 0;
    for (let target = ctx.time.frozen + RETRY_WINDOW_STEP_S; target < graceExpiryUnix; target += RETRY_WINDOW_STEP_S) {
      await advanceTo(ctx, target);
      steps += 1;
      const state = await project(ctx, providerSubscriptionId);
      const status = state.subscription?.status ?? "";
      check(isDelinquentStatus(status), `still delinquent at ${unixToIso(target)} (status ${status})`);
      checkEqual(state.subscription?.pastDueSince, pastDueSince, `past_due_since holds at ${unixToIso(target)}`);
      checkEqual(state.subscription?.graceExpiresAt, graceExpiresAt, `grace_expires_at holds at ${unixToIso(target)}`);
      checkEqual(quantity(state, s3.id), 1, `entitlement intact at ${unixToIso(target)}`);
      checkEqual((await licenseRow(ctx, licenseId)).revokedAt, null, `license live at ${unixToIso(target)}`);
      checkEqual(await assignedTierOf(ctx, serverId), s3.id, `server still assigned S3 at ${unixToIso(target)}`);
    }
    check(steps >= 3, `the window was walked (${steps} steps)`);
    const invoices = await fetchInvoicesForSubscription(ctx.client, providerSubscriptionId);
    check(invoices.some((invoice) => invoice.status === "open"), "the failed renewal is still an open invoice");
    check(
      !invoices.some((invoice) => invoice.status === "paid" && invoice.created >= HARNESS_FIRST_PERIOD_END_UNIX),
      "no renewal was paid on the failing card",
    );

    // One simulated hour past expiry, the maintenance tick would run; here
    // only this subscription is in scope, never the batch.
    await advanceTo(ctx, graceExpiryUnix + HOUR_S);
    const reproject = (id: string) =>
      projectSubscriptionById({ db: ctx.db, client: ctx.client, now: nowIso(ctx) }, id);
    const early = await runGraceClockForSubscription({
      db: ctx.db,
      client: ctx.client,
      reproject,
      nowMs: Date.parse(graceExpiresAt) - 1,
      providerSubscriptionId,
    });
    checkEqual(early.scanned, 0, "one millisecond before expiry the clock does nothing");
    const result = await runGraceClockForSubscription({
      db: ctx.db,
      client: ctx.client,
      reproject,
      nowMs: nowMs(ctx),
      providerSubscriptionId,
    });
    checkEqual(result.scanned, 1, "the scoped clock saw this subscription");
    checkEqual(result.failed.length, 0, `no cancel failed (${JSON.stringify(result.failed)})`);
    check(result.canceled.includes(providerSubscriptionId), `grace clock canceled the subscription (${JSON.stringify(result)})`);

    const state = await listSeatsForOrganization(ctx.db, ctx.organizationId);
    checkEqual(state.subscription?.status, "canceled", "status after the grace clock");
    checkEqual(quantity(state, s3.id), 0, "seats read as zero once ended");
    check((await licenseRow(ctx, licenseId)).revokedAt, "license revoked by the reprojection");
    checkEqual((await activeLicenseIds(ctx)).length, 0, "every license the organization held is revoked");
    checkEqual(await assignedTierOf(ctx, serverId), null, "the server sits on nothing once ended");

    // A retried tick finds nothing: the reprojection moved the status.
    const again = await runGraceClockForSubscription({
      db: ctx.db,
      client: ctx.client,
      reproject,
      nowMs: nowMs(ctx),
      providerSubscriptionId,
    });
    checkEqual(again.scanned, 0, "a second tick is a no-op");
  },
};

export const SCENARIOS: readonly Scenario[] = [
  partialFirstMonth,
  midCycleUpgrade,
  deferredDowngrade,
  quantityUpDown,
  upgradeWhilePastDue,
  dunningRetryWindow,
];

/** The six C16 cases, by name, in run order. */
export const SCENARIO_NAMES: readonly string[] = SCENARIOS.map((scenario) => scenario.name);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(args: readonly string[]): Promise<number> {
  const wanted = args.filter((arg) => !arg.startsWith("-"));
  const selected = wanted.length === 0
    ? SCENARIOS
    : SCENARIOS.filter((scenario) => wanted.includes(scenario.name));
  if (selected.length === 0) {
    console.error(`no such scenario; known: ${SCENARIO_NAMES.join(", ")}`);
    return 2;
  }
  const harness = await openHarness();
  const failed: string[] = [];
  try {
    for (const scenario of selected) {
      try {
        await runScenario(harness, scenario);
      } catch (err) {
        failed.push(scenario.name);
        console.error(`[${scenario.name}] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await harness.close();
  }
  const failedNote = failed.length === 0 ? "" : ` (failed: ${failed.join(", ")})`;
  console.log(
    `\n${selected.length - failed.length}/${selected.length} scenarios passed${failedNote}`,
  );
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
