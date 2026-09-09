/**
 * Tier catalogue reads and writes.
 *
 * A `tier` row is a ladder label bound to a payment-provider product
 * (`src/lib/tiers/ladder.ts` holds everything the label entitles). The
 * catalogue endpoint, the purchasable-tier gate on every mutation, the
 * projection's product→tier map, the assignment and the superadmin admin
 * routes all come through here so they agree on what "active",
 * "purchasable" and "referenced" mean.
 *
 * Rows are chosen from the provider's product list through
 * `/api/admin/v1/tiers` and verified before they are written; nothing
 * seeds them. {@link insertTier} and {@link updateTierById} are the only
 * writers outside migrations. `rank` is copied from the ladder on insert
 * and never taken from a request.
 *
 * Workers-bundleable: nothing at module load.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { BillingProviderId } from '../billing/gateway.ts'
import { type LadderEntry, ladderEntry } from '../tiers/ladder.ts'
import { license, server, subscriptionItem, tier } from './schema.ts'

export type TierRow = typeof tier.$inferSelect

export type PurchasableTierRefusal = 'not_found' | 'inactive' | 'uncatalogued'

export type ResolvePurchasableTierResult =
  | { ok: true; tier: TierRow & { providerProductId: string } }
  | { ok: false; reason: PurchasableTierRefusal }

/** Every row, active and inactive, in ladder order. */
export async function listAllTiers(db: Db): Promise<TierRow[]> {
  return await db.select().from(tier).orderBy(asc(tier.rank))
}

/** Active offerings in ladder order. */
export async function listActiveTiers(db: Db): Promise<TierRow[]> {
  return await db
    .select()
    .from(tier)
    .where(eq(tier.isActive, true))
    .orderBy(asc(tier.rank))
}

export async function getTierById(db: Db, tierId: string): Promise<TierRow | null> {
  const [row] = await db.select().from(tier).where(eq(tier.id, tierId)).limit(1)
  return row ?? null
}

export async function getTierByLabel(db: Db, label: string): Promise<TierRow | null> {
  const [row] = await db.select().from(tier).where(eq(tier.label, label)).limit(1)
  return row ?? null
}

/** The ladder entry a row is keyed to; `null` only for a row whose label left the ladder. */
export function ladderEntryForTier(row: Pick<TierRow, 'label'>): LadderEntry | null {
  return ladderEntry(row.label) ?? null
}

export type InsertTierInput = Readonly<{
  label: string
  provider?: BillingProviderId
  /** Null on a custom / SX row. */
  providerProductId: string | null
  /** Display cache of the product's default price. */
  priceCents: number | null
  currency: string | null
  isActive?: boolean
  now?: string
}>

/**
 * Add one tier row. `rank` and `isCustom` come from the ladder — a label
 * the ladder does not know is refused here, before anything is written.
 * A **plain insert**: `uniq_tier_label` raises on a second row for the
 * same label, and the route turns that into a `409`.
 */
export async function insertTier(db: Db, input: InsertTierInput): Promise<TierRow> {
  const entry = ladderEntry(input.label)
  if (!entry) throw new RangeError(`tier label ${input.label} is not on the ladder`)
  const now = input.now ?? new Date().toISOString()
  const [row] = await db
    .insert(tier)
    .values({
      label: entry.label,
      rank: entry.rank,
      provider: input.provider ?? 'stripe',
      providerProductId: input.providerProductId,
      priceCents: input.priceCents,
      currency: input.currency,
      isCustom: entry.isCustom,
      isActive: input.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new Error('insertTier returned no row')
  return row
}

/**
 * The columns a superadmin (or the price webhook) may change on an
 * existing row. `label`, `rank` and `is_custom` are identity: a re-label
 * is a new row. `undefined` leaves a column alone; `null` clears it.
 */
export type UpdateTierPatch = Readonly<{
  providerProductId?: string | null
  priceCents?: number | null
  currency?: string | null
  isActive?: boolean
}>

/** Returns `null` when no such row exists, so the caller answers `404` without a second read. */
export async function updateTierById(
  db: Db,
  tierId: string,
  patch: UpdateTierPatch,
  now?: string,
): Promise<TierRow | null> {
  const set: Record<string, unknown> = { updatedAt: now ?? new Date().toISOString() }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) set[key] = value
  }
  const [row] = await db.update(tier).set(set).where(eq(tier.id, tierId)).returning()
  return row ?? null
}

export type TierReferenceCounts = {
  /** Projected seat rows pointing at this tier. */
  seats: number
  /** Servers currently assigned this tier. */
  servers: number
}

/**
 * How many rows depend on this tier — what the admin surface shows beside
 * "retire", and what makes a product change on a referenced row a
 * deliberate act rather than a typo.
 */
export async function countTierReferences(db: Db, tierId: string): Promise<TierReferenceCounts> {
  const [seats] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(subscriptionItem)
    .where(eq(subscriptionItem.tierId, tierId))
  const [servers] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(server)
    .where(eq(server.assignedTierId, tierId))
  return {
    seats: Number(seats?.total ?? 0),
    servers: Number(servers?.total ?? 0),
  }
}

export async function getTiersByIds(db: Db, ids: readonly string[]): Promise<Map<string, TierRow>> {
  const out = new Map<string, TierRow>()
  const unique = [...new Set(ids)].filter((id) => id.length > 0)
  if (unique.length === 0) return out
  const rows = await db.select().from(tier).where(inArray(tier.id, unique))
  for (const row of rows) out.set(row.id, row)
  return out
}

/**
 * `provider_product_id` → `tier.id` for the products named, on one
 * provider. Unknown products are absent — the projection logs and skips
 * them rather than inserting a seat with no tier.
 */
export async function mapProviderProductsToTierIds(
  db: Db,
  provider: BillingProviderId,
  providerProductIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(providerProductIds)].filter((id) => id.length > 0)
  if (unique.length === 0) return out
  const rows = await db
    .select({ id: tier.id, providerProductId: tier.providerProductId })
    .from(tier)
    .where(and(eq(tier.provider, provider), inArray(tier.providerProductId, unique)))
  for (const row of rows) {
    if (row.providerProductId) out.set(row.providerProductId, row.id)
  }
  return out
}

/**
 * A tier that may be *bought*: active and catalogued on the provider.
 *
 * A retired (`is_active = false`) row may still be held by existing seats
 * and assignments, but never bought into; a row with no product is not on
 * the provider's catalogue and no mutation can name it.
 */
export async function resolvePurchasableTier(
  db: Db,
  tierId: string,
): Promise<ResolvePurchasableTierResult> {
  const row = await getTierById(db, tierId)
  if (!row) return { ok: false, reason: 'not_found' }
  if (!row.isActive) return { ok: false, reason: 'inactive' }
  const providerProductId = row.providerProductId?.trim() ?? ''
  if (providerProductId.length === 0) return { ok: false, reason: 'uncatalogued' }
  return { ok: true, tier: { ...row, providerProductId } }
}

export type LicenseCount = {
  /** Active (`revoked_at IS NULL`) licenses, bound or not. */
  active: number
  /** The subset already bound to a server (`server_id IS NOT NULL`). */
  bound: number
}

/**
 * Active license counts for one organization — the "licenses held" side
 * of the mint gate (`active < purchased`) and of the reconcile report.
 */
export async function countActiveLicenses(db: Db, organizationId: string): Promise<LicenseCount> {
  const [row] = await db
    .select({
      active: sql<number>`count(*)::int`,
      bound: sql<number>`count(${license.serverId})::int`,
    })
    .from(license)
    .where(and(eq(license.organizationId, organizationId), isNull(license.revokedAt)))
  return { active: Number(row?.active ?? 0), bound: Number(row?.bound ?? 0) }
}
