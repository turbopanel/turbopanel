/**
 * Per-organization quantity-mutation lease.
 *
 * Stripe has no compare-and-swap, and a subscription update **replaces the
 * whole `items` array**. Two concurrent mutations for one organization — a
 * license mint and a seat downgrade landing together — would each read the
 * current items, each compute a new array, and the second write would
 * silently undo the first. So every quantity mutation for an organization
 * runs under one lease, held for the Stripe round trip plus the projection
 * write.
 *
 * Postgres advisory locks are **unsupported on the Workers/Hyperdrive path**
 * (they are session-scoped, and Hyperdrive pools sessions), so this is a
 * direct port of the `setting`-row lease in `src/admin/reencrypt-secrets.ts`:
 *
 *   - acquire is `INSERT … ON CONFLICT DO NOTHING`; when that loses, the row
 *     is read and stolen only if it is **expired and** a compare-and-set on
 *     the exact previous value still matches;
 *   - release is owner-scoped (`value->>'owner' = $owner`), so a lease that
 *     was stolen after its TTL is never released by its former holder.
 *
 * Rows are transient by design: created on mutation, deleted on release.
 * A crashed holder leaves one behind until the TTL passes, and the next
 * caller steals it.
 *
 * Nothing calls this yet — the mutation paths land in the next phase.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { setting } from '../db/schema.ts'

/** `setting.key` prefix; the organization id follows the colon. */
export const BILLING_QUANTITY_LOCK_KEY_PREFIX = 'BILLING_QUANTITY_LOCK:'

/**
 * Sized for one Stripe round trip (`STRIPE_REQUEST_TIMEOUT_MS`, 20 s) plus
 * the projection write, with headroom for a slow Hyperdrive connect.
 */
export const BILLING_QUANTITY_LEASE_MS = 60_000

export type BillingQuantityLock = Readonly<{
  organizationId: string
  owner: string
}>

type LockValue = {
  owner: string
  expiresAt: string
}

export function billingQuantityLockKey(organizationId: string): string {
  return `${BILLING_QUANTITY_LOCK_KEY_PREFIX}${organizationId}`
}

function isLockValue(value: unknown): value is LockValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.owner === 'string' && typeof record.expiresAt === 'string'
}

function lockIsExpired(lock: LockValue, nowMs: number): boolean {
  const expires = Date.parse(lock.expiresAt)
  if (!Number.isFinite(expires)) return true
  return expires <= nowMs
}

function nextLockValue(owner: string, nowMs: number): LockValue {
  return { owner, expiresAt: new Date(nowMs + BILLING_QUANTITY_LEASE_MS).toISOString() }
}

/**
 * Acquire the lease for one organization. `null` when another owner holds an
 * unexpired one. Callers that receive a lock **must** call
 * {@link endQuantityMutation} in `finally`.
 */
export async function tryBeginQuantityMutation(
  db: Db,
  organizationId: string,
  nowMs = Date.now(),
): Promise<BillingQuantityLock | null> {
  const key = billingQuantityLockKey(organizationId)
  const owner = crypto.randomUUID()
  const lockValue = nextLockValue(owner, nowMs)

  const inserted = await db
    .insert(setting)
    .values({ key, value: lockValue })
    .onConflictDoNothing({ target: setting.key })
    .returning({ key: setting.key })
  if (inserted.length > 0) return { organizationId, owner }

  const [existing] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, key))
    .limit(1)
  if (!existing || !isLockValue(existing.value) || !lockIsExpired(existing.value, nowMs)) {
    return null
  }

  // Steal only if nobody else did first: CAS on the exact previous value.
  const stolen = await db
    .update(setting)
    .set({ value: lockValue, updatedAt: new Date(nowMs).toISOString() })
    .where(and(eq(setting.key, key), eq(setting.value, existing.value)))
    .returning({ key: setting.key })
  return stolen.length > 0 ? { organizationId, owner } : null
}

/** Owner-scoped release: a stolen lease is never released by its former holder. */
export async function endQuantityMutation(
  db: Db,
  lock: BillingQuantityLock,
): Promise<void> {
  await db
    .delete(setting)
    .where(
      and(
        eq(setting.key, billingQuantityLockKey(lock.organizationId)),
        sql`${setting.value}->>'owner' = ${lock.owner}`,
      ),
    )
}

/** Test-only: drop one organization's lease row when `db` is provided. */
export async function resetBillingQuantityLockForTests(
  db: Db | undefined,
  organizationId: string,
): Promise<void> {
  if (!db) return
  await db.delete(setting).where(eq(setting.key, billingQuantityLockKey(organizationId)))
}
