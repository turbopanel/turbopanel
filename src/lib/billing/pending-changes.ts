/**
 * The pending-change ledger — which license a billing change is *for*.
 *
 * A Stripe pending update or schedule phase carries no TurboPanel identity:
 * it says "one fewer S3, one more S5", never "server X's seat". So every
 * entitlement-changing mutation first records an **intent** here, keyed to
 * the exact `license.id` it moves, and the projection consumes the intent
 * when the committed items show the change landed.
 *
 * One `setting` row per organization (`BILLING_PENDING_CHANGES:<orgId>`),
 * the same storage shape as the quantity lease — no migration. Every
 * read/write happens **inside the `tryBeginQuantityMutation` lease**, so
 * the row needs no compare-and-set of its own.
 *
 * Two intent lifetimes:
 *
 *   `upgrade`                 24 h — one hour past Stripe's 23 h
 *                             pending-update expiry. Consumed by the
 *                             projection when the target tier's committed
 *                             quantity has room; pruned on read once expired.
 *   `downgrade` / `release-seat`  until the period boundary. These are what
 *                             tell `applySeatEntitlements` which specific
 *                             license drops when the schedule phase lands.
 *
 * The `idempotencyKey` is minted **once, when the intent is written**, and
 * passed to `client.post` on every retry of that mutation — the "a caller
 * that retries must pass the same key" rule from `AGENTS.md`, made concrete.
 *
 * Workers-bundleable: nothing at module load.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { setting } from '../db/schema.ts'

export const BILLING_PENDING_CHANGES_KEY_PREFIX = 'BILLING_PENDING_CHANGES:'

/** Stripe expires a pending update after 23 h; one hour of margin. */
export const UPGRADE_INTENT_TTL_MS = 24 * 60 * 60 * 1000

export const PENDING_CHANGES_LEDGER_VERSION = 1

export type PendingIntentKind = 'upgrade' | 'downgrade' | 'release-seat'

export type PendingIntent = Readonly<{
  id: string
  kind: PendingIntentKind
  /** `null` only on a `release-seat` that removes a seat no license holds. */
  licenseId: string | null
  fromTierId: string
  /** `null` for `release-seat`. */
  toTierId: string | null
  /** Minted once; reused on every retry of the same Stripe mutation. */
  idempotencyKey: string
  createdAt: string
  /** `null` for deferred intents (they live until the boundary). */
  expiresAt: string | null
}>

export type PendingChangeLedger = Readonly<{
  version: typeof PENDING_CHANGES_LEDGER_VERSION
  /** Guards against a stale ledger surviving a re-subscribe. */
  providerSubscriptionId: string
  intents: readonly PendingIntent[]
}>

export function billingPendingChangesKey(organizationId: string): string {
  return `${BILLING_PENDING_CHANGES_KEY_PREFIX}${organizationId}`
}

export function emptyLedger(providerSubscriptionId: string): PendingChangeLedger {
  return { version: PENDING_CHANGES_LEDGER_VERSION, providerSubscriptionId, intents: [] }
}

function isIntentKind(value: unknown): value is PendingIntentKind {
  return value === 'upgrade' || value === 'downgrade' || value === 'release-seat'
}

function parseIntent(value: unknown): PendingIntent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (
    typeof r.id !== 'string' || !isIntentKind(r.kind) ||
    typeof r.fromTierId !== 'string' || typeof r.idempotencyKey !== 'string' ||
    typeof r.createdAt !== 'string'
  ) {
    return null
  }
  const licenseId = typeof r.licenseId === 'string' ? r.licenseId : null
  if (r.kind !== 'release-seat' && !licenseId) return null
  const toTierId = typeof r.toTierId === 'string' ? r.toTierId : null
  if (r.kind !== 'release-seat' && !toTierId) return null
  return {
    id: r.id,
    kind: r.kind,
    licenseId,
    fromTierId: r.fromTierId,
    toTierId: r.kind === 'release-seat' ? null : toTierId,
    idempotencyKey: r.idempotencyKey,
    createdAt: r.createdAt,
    expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : null,
  }
}

/** `null` when the stored value is not a ledger this code understands. */
export function parseLedger(value: unknown): PendingChangeLedger | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (r.version !== PENDING_CHANGES_LEDGER_VERSION) return null
  if (typeof r.providerSubscriptionId !== 'string' || !Array.isArray(r.intents)) return null
  const intents: PendingIntent[] = []
  for (const raw of r.intents) {
    const intent = parseIntent(raw)
    if (intent) intents.push(intent)
  }
  return { version: PENDING_CHANGES_LEDGER_VERSION, providerSubscriptionId: r.providerSubscriptionId, intents }
}

function intentExpired(intent: PendingIntent, nowMs: number): boolean {
  if (intent.expiresAt === null) return false
  const at = Date.parse(intent.expiresAt)
  return !Number.isFinite(at) || at <= nowMs
}

/** Drop expired (upgrade) intents. Deferred intents never expire here. */
export function pruneExpiredIntents(
  ledger: PendingChangeLedger,
  nowMs: number,
): { ledger: PendingChangeLedger; pruned: PendingIntent[] } {
  const pruned = ledger.intents.filter((intent) => intentExpired(intent, nowMs))
  if (pruned.length === 0) return { ledger, pruned }
  return {
    ledger: { ...ledger, intents: ledger.intents.filter((intent) => !intentExpired(intent, nowMs)) },
    pruned,
  }
}

export type NewIntentInput = Readonly<{
  licenseId: string | null
  fromTierId: string
  toTierId: string | null
  nowMs?: number
}>

/** An `upgrade` intent: short-lived, consumed by the committed-items projection. */
export function newUpgradeIntent(input: NewIntentInput & { toTierId: string }): PendingIntent {
  const nowMs = input.nowMs ?? Date.now()
  return {
    id: crypto.randomUUID(),
    kind: 'upgrade',
    licenseId: input.licenseId,
    fromTierId: input.fromTierId,
    toTierId: input.toTierId,
    idempotencyKey: crypto.randomUUID(),
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + UPGRADE_INTENT_TTL_MS).toISOString(),
  }
}

/** A deferred intent: lives until the schedule phase lands at the boundary. */
export function newDeferredIntent(
  kind: 'downgrade' | 'release-seat',
  input: NewIntentInput,
): PendingIntent {
  const nowMs = input.nowMs ?? Date.now()
  if (kind === 'downgrade' && !input.toTierId) {
    throw new TypeError('a downgrade intent needs a target tier')
  }
  if (kind === 'downgrade' && !input.licenseId) {
    throw new TypeError('a downgrade intent names the license it moves')
  }
  return {
    id: crypto.randomUUID(),
    kind,
    licenseId: input.licenseId,
    fromTierId: input.fromTierId,
    toTierId: kind === 'release-seat' ? null : input.toTierId,
    idempotencyKey: crypto.randomUUID(),
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: null,
  }
}

export function withIntent(ledger: PendingChangeLedger, intent: PendingIntent): PendingChangeLedger {
  return { ...ledger, intents: [...ledger.intents.filter((i) => i.id !== intent.id), intent] }
}

export function withoutIntents(
  ledger: PendingChangeLedger,
  ids: Iterable<string>,
): PendingChangeLedger {
  const drop = new Set(ids)
  if (drop.size === 0) return ledger
  return { ...ledger, intents: ledger.intents.filter((i) => !drop.has(i.id)) }
}

/** An outstanding intent for one license, of any kind. */
export function intentForLicense(
  ledger: PendingChangeLedger,
  licenseId: string,
): PendingIntent | null {
  return ledger.intents.find((i) => i.licenseId !== null && i.licenseId === licenseId) ?? null
}

export function deferredIntents(ledger: PendingChangeLedger): PendingIntent[] {
  return ledger.intents.filter((i) => i.kind !== 'upgrade')
}

export function upgradeIntents(ledger: PendingChangeLedger): PendingIntent[] {
  return ledger.intents.filter((i) => i.kind === 'upgrade')
}

/**
 * Seats at each tier that are still counted by the provider but already
 * given back locally — outstanding `release-seat` intents. The free-seat
 * check subtracts these, or a revoked key's seat would be minted into again
 * before the boundary drops it.
 */
export function outstandingReleasesByTier(ledger: PendingChangeLedger): Map<string, number> {
  const out = new Map<string, number>()
  for (const intent of ledger.intents) {
    if (intent.kind !== 'release-seat') continue
    out.set(intent.fromTierId, (out.get(intent.fromTierId) ?? 0) + 1)
  }
  return out
}

/**
 * Per-tier quantity deltas the outstanding deferred intents will apply at
 * the boundary — the input to the schedule's future phase.
 */
export function deferredDeltasByTier(ledger: PendingChangeLedger): Map<string, number> {
  const out = new Map<string, number>()
  const bump = (tierId: string, delta: number) => out.set(tierId, (out.get(tierId) ?? 0) + delta)
  for (const intent of deferredIntents(ledger)) {
    bump(intent.fromTierId, -1)
    if (intent.kind === 'downgrade' && intent.toTierId) bump(intent.toTierId, 1)
  }
  return out
}

/**
 * Read the organization's ledger. A missing row, an unparseable value, or a
 * row naming a different subscription all read as empty — a re-subscribe
 * must not inherit the previous subscription's intents. Expired intents are
 * pruned and the pruned list returned so the caller can log them.
 */
export async function readPendingChanges(
  db: Db,
  organizationId: string,
  providerSubscriptionId: string,
  nowMs = Date.now(),
): Promise<{ ledger: PendingChangeLedger; pruned: PendingIntent[] }> {
  const [row] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, billingPendingChangesKey(organizationId)))
    .limit(1)
  const stored = row ? parseLedger(row.value) : null
  if (stored?.providerSubscriptionId !== providerSubscriptionId) {
    return { ledger: emptyLedger(providerSubscriptionId), pruned: [] }
  }
  const { ledger, pruned } = pruneExpiredIntents(stored, nowMs)
  if (pruned.length > 0) await writePendingChanges(db, organizationId, ledger, nowMs)
  return { ledger, pruned }
}

/** Upsert the ledger row. An empty ledger deletes the row. */
export async function writePendingChanges(
  db: Db,
  organizationId: string,
  ledger: PendingChangeLedger,
  nowMs = Date.now(),
): Promise<void> {
  const key = billingPendingChangesKey(organizationId)
  if (ledger.intents.length === 0) {
    await db.delete(setting).where(eq(setting.key, key))
    return
  }
  const now = new Date(nowMs).toISOString()
  const value = { ...ledger, intents: [...ledger.intents] }
  await db
    .insert(setting)
    .values({ key, value, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: now } })
}
