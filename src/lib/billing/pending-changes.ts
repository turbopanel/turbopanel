/**
 * The pending-change ledger — what the organization has asked to give
 * back at the period boundary.
 *
 * A Stripe schedule phase carries no TurboPanel identity and no reason; it
 * says "one fewer S3 next period". This ledger is the local record of the
 * deferred **quantity** changes behind that phase, so the phase can be
 * rebuilt from scratch after every immediate change (`schedules.ts`
 * releases and re-creates the schedule), the billing page can show what is
 * about to happen, and the projection can tell when a change has landed.
 *
 * Intents name a tier and a quantity direction, never a license or a
 * server: which server sits on which tier is derived after the fact
 * (`src/lib/tiers/assignment.ts`), so there is nothing per-license to wait
 * for. An increase is immediate and has no intent (its retry key lives in
 * `seat-increase.ts`).
 *
 * Two kinds:
 *
 *   `release-seat`   one fewer at `fromTierId` at the boundary
 *   `downgrade`      one fewer at `fromTierId`, one more at `toTierId`
 *
 * An intent **lands** when the period it was parked behind has rolled:
 * `landsAt` is the subscription's `current_period_end` when the intent was
 * written, and the projected `current_period_end` moving past it is the
 * signal. `fromQuantity` (the tier's quantity when the intent was written)
 * is the fallback for a subscription whose period end was unknown at the
 * time. An ended subscription lands everything.
 *
 * One `setting` row per organization (`BILLING_PENDING_CHANGES:<orgId>`),
 * the same storage shape as the quantity lease — no migration. Every
 * read/write happens **inside the `tryBeginQuantityMutation` lease**.
 *
 * The `idempotencyKey` is minted **once, when the intent is written**, and
 * passed to `client.post` on every retry of that mutation.
 *
 * Workers-bundleable: nothing at module load.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { setting } from '../db/schema.ts'

export const BILLING_PENDING_CHANGES_KEY_PREFIX = 'BILLING_PENDING_CHANGES:'

export const PENDING_CHANGES_LEDGER_VERSION = 2

export type PendingIntentKind = 'downgrade' | 'release-seat'

export type PendingIntent = Readonly<{
  id: string
  kind: PendingIntentKind
  fromTierId: string
  /** `null` for `release-seat`. */
  toTierId: string | null
  /** Minted once; reused on every retry of the same Stripe mutation. */
  idempotencyKey: string
  createdAt: string
  /** The `current_period_end` the change is parked behind; `null` when it was unknown. */
  landsAt: string | null
  /** `fromTierId`'s committed quantity when the intent was written. */
  fromQuantity: number
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
  return value === 'downgrade' || value === 'release-seat'
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
  const toTierId = typeof r.toTierId === 'string' ? r.toTierId : null
  if (r.kind === 'downgrade' && !toTierId) return null
  return {
    id: r.id,
    kind: r.kind,
    fromTierId: r.fromTierId,
    toTierId: r.kind === 'release-seat' ? null : toTierId,
    idempotencyKey: r.idempotencyKey,
    createdAt: r.createdAt,
    landsAt: typeof r.landsAt === 'string' ? r.landsAt : null,
    fromQuantity: typeof r.fromQuantity === 'number' && Number.isFinite(r.fromQuantity) ? r.fromQuantity : 0,
  }
}

/**
 * `null` when the stored value is not a ledger this code understands — a
 * version-1 ledger (license-keyed intents) reads as empty, which is the
 * right answer: its deferred phase is still on the provider's schedule and
 * the next mutation rebuilds it from the seats.
 */
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

export type NewIntentInput = Readonly<{
  fromTierId: string
  toTierId: string | null
  landsAt: string | null
  fromQuantity: number
  nowMs?: number
}>

/** A deferred intent: lives until the schedule phase lands at the boundary. */
export function newDeferredIntent(kind: PendingIntentKind, input: NewIntentInput): PendingIntent {
  const nowMs = input.nowMs ?? Date.now()
  if (kind === 'downgrade' && !input.toTierId) {
    throw new TypeError('a downgrade intent needs a target tier')
  }
  return {
    id: crypto.randomUUID(),
    kind,
    fromTierId: input.fromTierId,
    toTierId: kind === 'release-seat' ? null : input.toTierId,
    idempotencyKey: crypto.randomUUID(),
    createdAt: new Date(nowMs).toISOString(),
    landsAt: input.landsAt,
    fromQuantity: input.fromQuantity,
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

/**
 * Quantity at each tier that is still counted by the provider but already
 * given back locally — outstanding `release-seat` intents plus the source
 * side of outstanding downgrades. The mint gate and the coverage gate
 * subtract these, or a seat about to leave would be handed out again.
 */
export function outstandingReleasesByTier(ledger: PendingChangeLedger): Map<string, number> {
  const out = new Map<string, number>()
  for (const intent of ledger.intents) {
    out.set(intent.fromTierId, (out.get(intent.fromTierId) ?? 0) + 1)
  }
  return out
}

/**
 * Per-tier quantity deltas the outstanding intents will apply at the
 * boundary — the input to the schedule's future phase and to the
 * future-mix coverage check.
 */
export function deferredDeltasByTier(ledger: PendingChangeLedger): Map<string, number> {
  const out = new Map<string, number>()
  const bump = (tierId: string, delta: number) => out.set(tierId, (out.get(tierId) ?? 0) + delta)
  for (const intent of ledger.intents) {
    bump(intent.fromTierId, -1)
    if (intent.kind === 'downgrade' && intent.toTierId) bump(intent.toTierId, 1)
  }
  return out
}

/** Every tier a deferred intent moves *to*, deduplicated. */
export function deferredIntentTargets(ledger: PendingChangeLedger): string[] {
  const out = new Set<string>()
  for (const intent of ledger.intents) {
    if (intent.kind === 'downgrade' && intent.toTierId) out.add(intent.toTierId)
  }
  return [...out]
}

export type LandingContext = Readonly<{
  /** The subscription reads as ended: everything has landed. */
  ended: boolean
  /** The projected `current_period_end`, after the refetch. */
  currentPeriodEnd: string | null
  /** Committed quantity at a tier, after the refetch. */
  seatsAt: (tierId: string) => number
}>

function periodRolledPast(landsAt: string | null, currentPeriodEnd: string | null): boolean {
  if (!landsAt || !currentPeriodEnd) return false
  const lands = Date.parse(landsAt)
  const now = Date.parse(currentPeriodEnd)
  return Number.isFinite(lands) && Number.isFinite(now) && now > lands
}

/** The intents whose change the committed items now show. */
export function landedIntents(ledger: PendingChangeLedger, ctx: LandingContext): PendingIntent[] {
  if (ctx.ended) return [...ledger.intents]
  return ledger.intents.filter((intent) =>
    periodRolledPast(intent.landsAt, ctx.currentPeriodEnd) ||
    ctx.seatsAt(intent.fromTierId) < intent.fromQuantity
  )
}

/**
 * Read the organization's ledger. A missing row, an unparseable value, or a
 * row naming a different subscription all read as empty — a re-subscribe
 * must not inherit the previous subscription's intents.
 */
export async function readPendingChanges(
  db: Db,
  organizationId: string,
  providerSubscriptionId: string,
): Promise<{ ledger: PendingChangeLedger }> {
  const [row] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, billingPendingChangesKey(organizationId)))
    .limit(1)
  const stored = row ? parseLedger(row.value) : null
  if (stored?.providerSubscriptionId !== providerSubscriptionId) {
    return { ledger: emptyLedger(providerSubscriptionId) }
  }
  return { ledger: stored }
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
