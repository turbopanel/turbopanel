/**
 * The pending Checkout record — an in-flight first purchase, persisted
 * **after** Stripe returns a session and reused until it completes or expires.
 *
 * Two first-checkout requests can both see no local subscription and mint
 * two Checkout sessions (and two subscriptions) unless the route serialises
 * on the quantity lease **and** remembers the session it already created.
 * One `setting` row per organization (`BILLING_PENDING_CHECKOUT:<orgId>`),
 * the same storage shape as the quantity lease and the seat-increase
 * record — no migration. Read and written only **inside the
 * `tryBeginQuantityMutation` lease**, so the row needs no compare-and-set
 * of its own. Stripe Checkout sessions live 24 h, which is the record's
 * lifetime too: after that a retry is a new request, and the record is
 * pruned on read.
 *
 * A retry of the **same** tier and quantity reuses the stored URL. A
 * different tier or quantity while an unexpired record exists is refused
 * (`checkout_pending`) rather than opening a second session.
 *
 * Workers-bundleable: nothing at module load.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { setting } from "../db/schema.ts";

export const BILLING_PENDING_CHECKOUT_KEY_PREFIX = "BILLING_PENDING_CHECKOUT:";

/** Stripe Checkout sessions expire after 24 h. */
export const PENDING_CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;

export const PENDING_CHECKOUT_RECORD_VERSION = 1;

export type PendingCheckoutRecord = Readonly<{
  version: typeof PENDING_CHECKOUT_RECORD_VERSION;
  sessionId: string;
  url: string;
  tierId: string;
  quantity: number;
  idempotencyKey: string;
  createdAt: string;
  expiresAt: string;
}>;

export function billingPendingCheckoutKey(organizationId: string): string {
  return `${BILLING_PENDING_CHECKOUT_KEY_PREFIX}${organizationId}`;
}

export type NewPendingCheckoutInput = Readonly<{
  sessionId: string;
  url: string;
  tierId: string;
  quantity: number;
  idempotencyKey: string;
  nowMs?: number;
}>;

export function newPendingCheckoutRecord(
  input: NewPendingCheckoutInput,
): PendingCheckoutRecord {
  if (
    input.sessionId.length === 0 || input.url.length === 0 ||
    input.tierId.length === 0
  ) {
    throw new TypeError(
      "a pending-checkout record needs a session, url, and tier",
    );
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new TypeError(
      "a pending-checkout record needs a positive integer quantity",
    );
  }
  if (input.idempotencyKey.length === 0) {
    throw new TypeError(
      "a pending-checkout record needs the Checkout idempotency key",
    );
  }
  const nowMs = input.nowMs ?? Date.now();
  return {
    version: PENDING_CHECKOUT_RECORD_VERSION,
    sessionId: input.sessionId,
    url: input.url,
    tierId: input.tierId,
    quantity: input.quantity,
    idempotencyKey: input.idempotencyKey,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + PENDING_CHECKOUT_TTL_MS).toISOString(),
  };
}

/** `null` when the stored value is not a record this code understands. */
export function parsePendingCheckoutRecord(
  value: unknown,
): PendingCheckoutRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const r = value as Record<string, unknown>;
  if (r.version !== PENDING_CHECKOUT_RECORD_VERSION) return null;
  if (
    typeof r.sessionId !== "string" || r.sessionId.length === 0 ||
    typeof r.url !== "string" || r.url.length === 0 ||
    typeof r.tierId !== "string" || r.tierId.length === 0 ||
    typeof r.quantity !== "number" || !Number.isInteger(r.quantity) ||
    r.quantity < 1 ||
    typeof r.idempotencyKey !== "string" || r.idempotencyKey.length === 0 ||
    typeof r.createdAt !== "string" || typeof r.expiresAt !== "string"
  ) {
    return null;
  }
  return {
    version: PENDING_CHECKOUT_RECORD_VERSION,
    sessionId: r.sessionId,
    url: r.url,
    tierId: r.tierId,
    quantity: r.quantity,
    idempotencyKey: r.idempotencyKey,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}

function recordExpired(record: PendingCheckoutRecord, nowMs: number): boolean {
  const at = Date.parse(record.expiresAt);
  return !Number.isFinite(at) || at <= nowMs;
}

/** True when `record` is the same first-checkout request as the one being made. */
export function pendingCheckoutMatches(
  record: PendingCheckoutRecord,
  request: Readonly<{ tierId: string; quantity: number }>,
): boolean {
  return record.tierId === request.tierId &&
    record.quantity === request.quantity;
}

/**
 * Read the organization's in-flight Checkout. A missing row, an
 * unparseable value, or an expired record all read as `null` — and a
 * stale row is cleared so it cannot be matched by a later request.
 */
export async function readPendingCheckout(
  db: Db,
  organizationId: string,
  nowMs = Date.now(),
): Promise<PendingCheckoutRecord | null> {
  const [row] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, billingPendingCheckoutKey(organizationId)))
    .limit(1);
  if (!row) return null;
  const stored = parsePendingCheckoutRecord(row.value);
  if (!stored || recordExpired(stored, nowMs)) {
    await clearPendingCheckout(db, organizationId);
    return null;
  }
  return stored;
}

/** Upsert the record row — after Stripe returns the session it names. */
export async function writePendingCheckout(
  db: Db,
  organizationId: string,
  record: PendingCheckoutRecord,
  nowMs = Date.now(),
): Promise<void> {
  const key = billingPendingCheckoutKey(organizationId);
  const now = new Date(nowMs).toISOString();
  const value = { ...record };
  await db
    .insert(setting)
    .values({ key, value, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: setting.key,
      set: { value, updatedAt: now },
    });
}

/** Drop the record: Checkout completed, the subscription projected, or it expired. */
export async function clearPendingCheckout(
  db: Db,
  organizationId: string,
): Promise<void> {
  await db.delete(setting).where(
    eq(setting.key, billingPendingCheckoutKey(organizationId)),
  );
}
