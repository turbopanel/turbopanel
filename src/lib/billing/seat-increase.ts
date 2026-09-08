/**
 * The seat-increase record — the idempotency key of an in-flight immediate
 * seat raise, persisted **before** Stripe is called.
 *
 * `POST /billing/seats` with a positive delta is the one entitlement-raising
 * mutation that names no license, so it has no `PendingIntent` in the ledger
 * (`pending-changes.ts`) to carry its key. Minting a fresh key per attempt
 * would make a retry a second purchase: Stripe accepts the update, the
 * reprojection (`syncAfterMutation`) fails on a transient error, the console
 * retries, and a new key buys the seats again. So the key, together with the
 * exact parameters Stripe saw, is written here first and reused on every
 * retry of the same logical request until the reprojection has landed.
 *
 * One `setting` row per organization (`BILLING_SEAT_INCREASE:<orgId>`), the
 * same storage shape as the quantity lease and the ledger — no migration.
 * Read and written only **inside the `tryBeginQuantityMutation` lease**, so
 * the row needs no compare-and-set of its own. Stripe honours an idempotency
 * key for 24 h, which is the record's lifetime too: after that a retry is a
 * new request, and the record is pruned on read.
 *
 * A retry must replay the **same** request: Stripe rejects a reused key whose
 * parameters differ (`idempotency_error`). The record therefore pins the
 * `items` array and the `prorationDate` Stripe saw, alongside the tier and
 * delta, and `changeSeats` sends the stored values rather than rebuilding
 * them — the seat rows can move between attempts (a webhook projecting the
 * very update the first attempt made), and items rebuilt from them would
 * not match the key.
 *
 * Workers-bundleable: nothing at module load.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { setting } from '../db/schema.ts'
import type { ItemMutation } from './subscriptions.ts'

export const BILLING_SEAT_INCREASE_KEY_PREFIX = 'BILLING_SEAT_INCREASE:'

/** Stripe replays a request under the same key for 24 h. */
export const SEAT_INCREASE_TTL_MS = 24 * 60 * 60 * 1000

export const SEAT_INCREASE_RECORD_VERSION = 1

export type SeatIncreaseRecord = Readonly<{
  version: typeof SEAT_INCREASE_RECORD_VERSION
  /** Guards against a record surviving a re-subscribe. */
  providerSubscriptionId: string
  tierId: string
  /** Always positive: decreases are ledger intents, never this record. */
  delta: number
  /** The `items[]` Stripe saw; replayed verbatim on retry, never rebuilt. */
  items: readonly ItemMutation[]
  /** The proration timestamp Stripe saw; replayed verbatim on retry. */
  prorationDate: number
  /** Minted once; reused on every retry until the reprojection lands. */
  idempotencyKey: string
  createdAt: string
  expiresAt: string
}>

export function billingSeatIncreaseKey(organizationId: string): string {
  return `${BILLING_SEAT_INCREASE_KEY_PREFIX}${organizationId}`
}

export type NewSeatIncreaseInput = Readonly<{
  providerSubscriptionId: string
  tierId: string
  delta: number
  items: readonly ItemMutation[]
  prorationDate: number
  nowMs?: number
}>

export function newSeatIncreaseRecord(input: NewSeatIncreaseInput): SeatIncreaseRecord {
  if (!Number.isInteger(input.delta) || input.delta <= 0) {
    throw new TypeError('a seat-increase record needs a positive integer delta')
  }
  const nowMs = input.nowMs ?? Date.now()
  return {
    version: SEAT_INCREASE_RECORD_VERSION,
    providerSubscriptionId: input.providerSubscriptionId,
    tierId: input.tierId,
    delta: input.delta,
    items: input.items.map((item) => ({ ...item })),
    prorationDate: input.prorationDate,
    idempotencyKey: crypto.randomUUID(),
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + SEAT_INCREASE_TTL_MS).toISOString(),
  }
}

function isQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** One stored `items[]` entry, in exactly the three shapes `buildItemMutation` emits. */
function parseItemMutation(value: unknown): ItemMutation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (typeof r.id === 'string' && r.id.length > 0) {
    if (r.deleted === true) return { id: r.id, deleted: true }
    if (isQuantity(r.quantity)) return { id: r.id, quantity: r.quantity }
    return null
  }
  if (typeof r.price === 'string' && r.price.length > 0 && isQuantity(r.quantity)) {
    return { price: r.price, quantity: r.quantity }
  }
  return null
}

/** `null` when the stored value is not a record this code understands. */
export function parseSeatIncreaseRecord(value: unknown): SeatIncreaseRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (r.version !== SEAT_INCREASE_RECORD_VERSION) return null
  if (
    typeof r.providerSubscriptionId !== 'string' || typeof r.tierId !== 'string' ||
    typeof r.delta !== 'number' || !Number.isInteger(r.delta) || r.delta <= 0 ||
    typeof r.prorationDate !== 'number' || !Number.isFinite(r.prorationDate) ||
    typeof r.idempotencyKey !== 'string' || r.idempotencyKey.length === 0 ||
    typeof r.createdAt !== 'string' || typeof r.expiresAt !== 'string' ||
    !Array.isArray(r.items) || r.items.length === 0
  ) {
    return null
  }
  const items: ItemMutation[] = []
  for (const raw of r.items) {
    const item = parseItemMutation(raw)
    // One unreadable entry invalidates the record: a partial replay would
    // not match the key, and a fresh request is the safe outcome.
    if (!item) return null
    items.push(item)
  }
  return {
    version: SEAT_INCREASE_RECORD_VERSION,
    providerSubscriptionId: r.providerSubscriptionId,
    tierId: r.tierId,
    delta: r.delta,
    items,
    prorationDate: r.prorationDate,
    idempotencyKey: r.idempotencyKey,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  }
}

function recordExpired(record: SeatIncreaseRecord, nowMs: number): boolean {
  const at = Date.parse(record.expiresAt)
  return !Number.isFinite(at) || at <= nowMs
}

/**
 * True when `record` is the same logical request as the one being made — the
 * only case a retry may reuse its key. `items` and `prorationDate` are
 * deliberately not compared: the record's own values are what get replayed.
 */
export function seatIncreaseMatches(
  record: SeatIncreaseRecord,
  request: Readonly<{ tierId: string; delta: number }>,
): boolean {
  return record.tierId === request.tierId && record.delta === request.delta
}

/**
 * Read the organization's in-flight seat increase. A missing row, an
 * unparseable value, a row naming a different subscription, or an expired
 * record all read as `null` — and an expired or foreign record is cleared so
 * it cannot be matched by a later request.
 */
export async function readSeatIncrease(
  db: Db,
  organizationId: string,
  providerSubscriptionId: string,
  nowMs = Date.now(),
): Promise<SeatIncreaseRecord | null> {
  const [row] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, billingSeatIncreaseKey(organizationId)))
    .limit(1)
  if (!row) return null
  const stored = parseSeatIncreaseRecord(row.value)
  if (stored?.providerSubscriptionId !== providerSubscriptionId || recordExpired(stored, nowMs)) {
    await clearSeatIncrease(db, organizationId)
    return null
  }
  return stored
}

/** Upsert the record row — always before the Stripe call it protects. */
export async function writeSeatIncrease(
  db: Db,
  organizationId: string,
  record: SeatIncreaseRecord,
  nowMs = Date.now(),
): Promise<void> {
  const key = billingSeatIncreaseKey(organizationId)
  const now = new Date(nowMs).toISOString()
  const value = { ...record, items: record.items.map((item) => ({ ...item })) }
  await db
    .insert(setting)
    .values({ key, value, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: now } })
}

/** Drop the record: the reprojection landed, or Stripe refused permanently. */
export async function clearSeatIncrease(db: Db, organizationId: string): Promise<void> {
  await db.delete(setting).where(eq(setting.key, billingSeatIncreaseKey(organizationId)))
}
