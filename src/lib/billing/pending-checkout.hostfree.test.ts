/**
 * Host-free coverage for the pending Checkout record: parse discipline,
 * the 24 h expiry, and the match rule a retry of the same first purchase
 * relies on.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { setting } from "../db/schema.ts";
import { createMemoryDb } from "../../test-fixtures/memory-db.ts";
import {
  billingPendingCheckoutKey,
  clearPendingCheckout,
  newPendingCheckoutRecord,
  parsePendingCheckoutRecord,
  PENDING_CHECKOUT_RECORD_VERSION,
  PENDING_CHECKOUT_TTL_MS,
  pendingCheckoutMatches,
  readPendingCheckout,
  writePendingCheckout,
} from "./pending-checkout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORG = "33333333-3333-4333-8333-333333333333";
const S3 = "33333333-3333-4333-8333-333333333331";
const NOW_MS = Date.parse("2026-09-07T12:00:00.000Z");

function sample(
  overrides: Partial<Parameters<typeof newPendingCheckoutRecord>[0]> = {},
) {
  return newPendingCheckoutRecord({
    sessionId: "cs_1",
    url: "https://checkout.stripe.com/c/pay/cs_1",
    tierId: S3,
    quantity: 2,
    idempotencyKey: `checkout:${ORG}:${S3}:2`,
    nowMs: NOW_MS,
    ...overrides,
  });
}

test("newPendingCheckoutRecord pins the session, expires with the Stripe Checkout window, and refuses a bad quantity", () => {
  const record = sample();
  assertEquals(record.version, PENDING_CHECKOUT_RECORD_VERSION);
  assertEquals(record.sessionId, "cs_1");
  assertEquals(record.url, "https://checkout.stripe.com/c/pay/cs_1");
  assertEquals(record.tierId, S3);
  assertEquals(record.quantity, 2);
  assertEquals(record.idempotencyKey, `checkout:${ORG}:${S3}:2`);
  assertEquals(record.createdAt, new Date(NOW_MS).toISOString());
  assertEquals(
    record.expiresAt,
    new Date(NOW_MS + PENDING_CHECKOUT_TTL_MS).toISOString(),
  );
  assertThrows(() => sample({ quantity: 0 }), TypeError);
  assertThrows(() => sample({ sessionId: "" }), TypeError);
  assertThrows(() => sample({ idempotencyKey: "" }), TypeError);
});

test("parsePendingCheckoutRecord accepts only a complete versioned record", () => {
  const record = sample();
  assertEquals(parsePendingCheckoutRecord(record), record);
  assertEquals(parsePendingCheckoutRecord(null), null);
  assertEquals(parsePendingCheckoutRecord({ ...record, version: 99 }), null);
  assertEquals(parsePendingCheckoutRecord({ ...record, quantity: 0 }), null);
  assertEquals(parsePendingCheckoutRecord({ ...record, sessionId: "" }), null);
});

test("pendingCheckoutMatches is the same tier and quantity; a different request must not reuse the URL", () => {
  const record = sample();
  assertEquals(
    pendingCheckoutMatches(record, { tierId: S3, quantity: 2 }),
    true,
  );
  assertEquals(
    pendingCheckoutMatches(record, { tierId: S3, quantity: 1 }),
    false,
  );
  assertEquals(
    pendingCheckoutMatches(record, { tierId: "other", quantity: 2 }),
    false,
  );
});

test("read/write/clear: an unexpired row is returned, an expired row is dropped, and clear is idempotent", async () => {
  const db = createMemoryDb([[setting, []]]);
  const record = sample();
  assertEquals(await readPendingCheckout(db, ORG, NOW_MS), null);

  await writePendingCheckout(db, ORG, record, NOW_MS);
  assertEquals(await readPendingCheckout(db, ORG, NOW_MS), record);
  assertEquals(db.rows(setting)[0]?.key, billingPendingCheckoutKey(ORG));

  assertEquals(
    await readPendingCheckout(db, ORG, NOW_MS + PENDING_CHECKOUT_TTL_MS),
    null,
  );
  assertEquals(db.rows(setting).length, 0);

  await writePendingCheckout(db, ORG, record, NOW_MS);
  await clearPendingCheckout(db, ORG);
  assertEquals(await readPendingCheckout(db, ORG, NOW_MS), null);
  await clearPendingCheckout(db, ORG);
});
