/**
 * Reading and writing the self-hosted grant (`self-hosted-grant.ts` holds
 * what it is and why).
 *
 * **Growing is a self-hosted act; shrinking is not.** {@link syncSelfHostedGrant}
 * takes `allowGrow`, which is true only on the self-hosted runtime. On
 * Workers the grant may fall to the new target — a revoked license gives
 * its granted unit back — but never rise, so an instance that was
 * self-hosted yesterday keeps every server it had connected and still has
 * to buy through the provider for the next one. That asymmetry is the
 * whole hosted gate.
 *
 * Workers-bundleable: nothing at module load.
 */

import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { license, server, setting } from '../db/schema.ts'
import { countActiveLicenses, getTierByLabel, insertTier } from '../db/tier-records.ts'
import {
  listSeatsForOrganization,
  type OrganizationBillingState,
  seatQuantitiesByTier,
} from '../db/billing-records.ts'
import { CUSTOM_TIER_LABEL } from './ladder.ts'
import {
  parseSelfHostedGrant,
  SELF_HOSTED_GRANT_VERSION,
  type SelfHostedGrant,
  selfHostedGrantKey,
} from './self-hosted-grant.ts'

export async function readSelfHostedGrant(
  db: Db,
  organizationId: string,
): Promise<SelfHostedGrant | null> {
  const [row] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, selfHostedGrantKey(organizationId)))
    .limit(1)
  return row ? parseSelfHostedGrant(row.value) : null
}

/** Upsert the grant row. A quantity of zero deletes it. */
export async function writeSelfHostedGrant(
  db: Db,
  organizationId: string,
  grant: SelfHostedGrant,
  nowMs = Date.now(),
): Promise<void> {
  const key = selfHostedGrantKey(organizationId)
  if (grant.quantity <= 0) {
    await db.delete(setting).where(eq(setting.key, key))
    return
  }
  const now = new Date(nowMs).toISOString()
  const value = { ...grant }
  await db
    .insert(setting)
    .values({ key, value, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: now } })
}

/**
 * The `SX` catalogue row, created on first use.
 *
 * Nothing seeds the tier catalogue — a superadmin binds each priced label
 * to a provider product by hand — but `SX` is the one row that needs no
 * product (it is never purchasable) and `server.assigned_tier_id` is a
 * foreign key, so the grant has to be able to point somewhere. Everything
 * written here comes from the in-code ladder.
 */
export async function ensureCustomTierRow(db: Db): Promise<string> {
  const existing = await getTierByLabel(db, CUSTOM_TIER_LABEL)
  if (existing) return existing.id
  try {
    const row = await insertTier(db, {
      label: CUSTOM_TIER_LABEL,
      providerProductId: null,
      priceCents: null,
      currency: null,
    })
    return row.id
  } catch {
    // `uniq_tier_label` — a concurrent caller won the race; read its row.
    const row = await getTierByLabel(db, CUSTOM_TIER_LABEL)
    if (!row) throw new Error(`${CUSTOM_TIER_LABEL} tier row could not be created`)
    return row.id
  }
}

/** Committed quantity across every projected provider seat; an ended subscription reads zero. */
export function providerPurchasedTotal(state: OrganizationBillingState): number {
  let total = 0
  for (const quantity of seatQuantitiesByTier(state).values()) total += quantity
  return total
}

export type SyncSelfHostedGrantOpts = Readonly<{
  /**
   * True on the self-hosted runtime only. When false the grant may fall to
   * the new target but never rise — the hosted mint gate is what hands out
   * the next license.
   */
  allowGrow: boolean
  /** Already-loaded billing state, to skip the read. */
  state?: OrganizationBillingState
  nowMs?: number
}>

/**
 * Bring the grant in line with what the organization actually holds.
 *
 * The target is every active license the provider does not already cover:
 * `activeLicenses − providerPurchased`, floored at zero. On self-hosted
 * that is simply the license count, so each minted key is covered the
 * moment it exists and the assignment places its server on `SX`. On
 * Workers the target is the same number, but only a *reduction* is
 * applied — see the module comment.
 *
 * Idempotent: no write when the stored quantity already matches.
 */
export async function syncSelfHostedGrant(
  db: Db,
  organizationId: string,
  opts: SyncSelfHostedGrantOpts,
): Promise<SelfHostedGrant | null> {
  // The hosted fast path, and the reason this is cheap enough to sit on the
  // daemon session route: an organization that holds no grant and may not
  // grow one has nothing to compute. That is every hosted organization that
  // was never self-hosted — one indexed `setting` read and out.
  const current = opts.state ? opts.state.grant : await readSelfHostedGrant(db, organizationId)
  if (!current && !opts.allowGrow) return null

  const [licenses, state] = await Promise.all([
    countActiveLicenses(db, organizationId),
    opts.state ? Promise.resolve(opts.state) : listSeatsForOrganization(db, organizationId),
  ])
  const target = Math.max(0, licenses.active - providerPurchasedTotal(state))
  const quantity = opts.allowGrow ? target : Math.min(current?.quantity ?? 0, target)

  if (quantity <= 0) {
    if (!current) return null
    await writeSelfHostedGrant(db, organizationId, { ...current, quantity: 0 }, opts.nowMs)
    return null
  }
  if (current?.quantity === quantity) return current

  const tierId = current?.tierId ?? await ensureCustomTierRow(db)
  const next: SelfHostedGrant = { version: SELF_HOSTED_GRANT_VERSION, tierId, quantity }
  await writeSelfHostedGrant(db, organizationId, next, opts.nowMs)
  return next
}

/**
 * Bring one organization's grant in line, resolved from a server row.
 *
 * `allowGrow` follows the deployment: on the hosted runtime this can only
 * hand a granted unit back after a license was revoked, never hand one out.
 * A server that belongs to no organization has nothing to entitle.
 */
export async function syncSelfHostedGrantForServer(
  db: Db,
  serverId: string,
  deployment: 'hosted' | 'self-hosted',
): Promise<void> {
  const [row] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (!row?.organizationId) return
  await syncSelfHostedGrant(db, row.organizationId, {
    allowGrow: deployment === 'self-hosted',
  })
}

/**
 * Grant coverage for a license about to bind, resolved from the license
 * row. Called on the self-hosted enroll path *before* the tier gate, so a
 * key minted while the instance was self-hosted is covered by the time the
 * gate reads the assignment.
 */
export async function syncSelfHostedGrantForLicense(
  db: Db,
  licenseId: string,
): Promise<void> {
  const [row] = await db
    .select({ organizationId: license.organizationId })
    .from(license)
    .where(and(eq(license.id, licenseId), isNull(license.revokedAt)))
    .limit(1)
  if (!row?.organizationId) return
  await syncSelfHostedGrant(db, row.organizationId, { allowGrow: true })
}
