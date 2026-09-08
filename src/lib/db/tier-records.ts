/**
 * Tier catalogue reads for billing.
 *
 * The only place the `tier` table is read *for billing*: the catalogue
 * endpoint, the purchasable-tier gate on license minting and on every
 * Stripe mutation, the reconciliation sweep and the superadmin admin
 * routes all come through here so they agree on what "active",
 * "purchasable" and "used" mean.
 *
 * Rows are entered by a superadmin through `/api/admin/v1/tiers` and
 * verified against Stripe before they are written; nothing seeds them.
 * {@link insertTier} and {@link updateTierById} are the only writers
 * outside migrations.
 *
 * Pricing-tier labels never leak into `capability-plan.ts`; the
 * entitlement-column boundary is `tier-entitlements.ts`, and this module
 * sits on the billing side of it.
 *
 * Workers-bundleable: nothing at module load.
 */

import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { license, subscriptionItem, tier } from './schema.ts'

export type TierRow = typeof tier.$inferSelect

export type PurchasableTierRefusal = 'not_found' | 'inactive' | 'uncatalogued'

export type ResolvePurchasableTierResult =
  | { ok: true; tier: TierRow & { providerPriceId: string } }
  | { ok: false; reason: PurchasableTierRefusal }

/** Active offerings in catalogue order: `(generation, rank)`. */
export async function listActiveTiers(db: Db): Promise<TierRow[]> {
  return await db
    .select()
    .from(tier)
    .where(eq(tier.isActive, true))
    .orderBy(asc(tier.generation), asc(tier.rank))
}

export async function getTierById(db: Db, tierId: string): Promise<TierRow | null> {
  const [row] = await db.select().from(tier).where(eq(tier.id, tierId)).limit(1)
  return row ?? null
}

export async function getTierByGenerationLabel(
  db: Db,
  generation: number,
  label: string,
): Promise<TierRow | null> {
  const [row] = await db
    .select()
    .from(tier)
    .where(and(eq(tier.generation, generation), eq(tier.label, label)))
    .limit(1)
  return row ?? null
}

export type InsertTierInput = Readonly<{
  generation: number
  label: string
  rank: number
  priceCents: number | null
  providerPriceId: string | null
  isCustom: boolean
  isActive: boolean
  maxCores: number
  maxMemoryBytes: number
  nicSlots: number
  driveSlots: number
  gpuSlots: number
  filesystemSlots: number
  now?: string
}>

/**
 * Add one tier row. A **plain insert**, deliberately: the seed script's
 * upsert-on-`(generation, label)` was right for a script that owned the
 * catalogue and converged it, and wrong behind a form — an operator who
 * mistypes a label that happens to match an existing row would silently
 * overwrite that row's entitlements instead of being told the label is
 * taken. The `uniq_tier_generation_label` index raises here; the route
 * turns that into a `409`.
 */
export async function insertTier(db: Db, input: InsertTierInput): Promise<TierRow> {
  const now = input.now ?? new Date().toISOString()
  const [row] = await db
    .insert(tier)
    .values({
      generation: input.generation,
      label: input.label,
      rank: input.rank,
      priceCents: input.priceCents,
      providerPriceId: input.providerPriceId,
      isCustom: input.isCustom,
      isActive: input.isActive,
      maxCores: input.maxCores,
      maxMemoryBytes: input.maxMemoryBytes,
      nicSlots: input.nicSlots,
      driveSlots: input.driveSlots,
      gpuSlots: input.gpuSlots,
      filesystemSlots: input.filesystemSlots,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new Error('insertTier returned no row')
  return row
}

/**
 * The columns a superadmin may change on an existing row. `generation` and
 * `label` are identity, not data: a re-label or a re-generation is a new
 * row, which is what keeps `(generation, label)` meaningful as the natural
 * key. Every field is optional; `undefined` leaves the column alone, while
 * `null` on a nullable column clears it.
 */
export type UpdateTierPatch = Readonly<{
  rank?: number
  priceCents?: number | null
  providerPriceId?: string | null
  isCustom?: boolean
  isActive?: boolean
  successorId?: string | null
  maxCores?: number
  maxMemoryBytes?: number
  nicSlots?: number
  driveSlots?: number
  gpuSlots?: number
  filesystemSlots?: number
}>

/** The subset accepted once any license or seat points at the row. */
export const REFERENCED_TIER_PATCH_COLUMNS = ['isActive', 'successorId'] as const satisfies
  readonly (keyof UpdateTierPatch)[]

/**
 * Apply a patch to one row. Returns `null` when no such row exists, so the
 * caller answers `404` without a second read. Enforcing *which* columns are
 * allowed is the route's job — it needs {@link countTierReferences} to
 * decide, and wants to answer `409` with the counts rather than silently
 * dropping fields here.
 */
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
  /** Licenses pointing at this tier, **revoked ones included**. */
  licenses: number
  /** Projected seat rows pointing at this tier. */
  seats: number
}

/**
 * How many rows depend on this tier. Revoked licenses count: the FK is
 * `on delete restrict` and a revoked row still holds the tier's
 * entitlements in its history, so changing what "S3" means underneath it
 * would rewrite the past. This is deliberately *not*
 * {@link countActiveLicensesByTier}, which excludes revoked licenses
 * because it answers a different question — how many seats are in use.
 */
export async function countTierReferences(db: Db, tierId: string): Promise<TierReferenceCounts> {
  const [licenses] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(license)
    .where(eq(license.tierId, tierId))
  const [seats] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(subscriptionItem)
    .where(eq(subscriptionItem.tierId, tierId))
  return {
    licenses: Number(licenses?.total ?? 0),
    seats: Number(seats?.total ?? 0),
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
 * A tier that may be *bought*: active and catalogued on the provider.
 *
 * A grandfathered (`is_active = false`) row may still be held by existing
 * licenses and seats, but never bought into; a row with no
 * `provider_price_id` is not on the provider's catalogue and no mutation
 * can name it.
 */
export async function resolvePurchasableTier(
  db: Db,
  tierId: string,
): Promise<ResolvePurchasableTierResult> {
  const row = await getTierById(db, tierId)
  if (!row) return { ok: false, reason: 'not_found' }
  if (!row.isActive) return { ok: false, reason: 'inactive' }
  const providerPriceId = row.providerPriceId?.trim() ?? ''
  if (providerPriceId.length === 0) return { ok: false, reason: 'uncatalogued' }
  return { ok: true, tier: { ...row, providerPriceId } }
}

export type TierLicenseCount = {
  /** Active (`revoked_at IS NULL`) licenses at this tier. */
  active: number
  /** The subset already bound to a server (`server_id IS NOT NULL`). */
  bound: number
}

/**
 * Active license counts per tier for one organization — one half of the
 * C12 invariant (`seat.quantity >= bound`) and the free-seat check on
 * minting. Both readers must come through here so they cannot disagree.
 * Licenses with no tier (self-hosted, unassigned) are not returned.
 */
export async function countActiveLicensesByTier(
  db: Db,
  organizationId: string,
): Promise<Map<string, TierLicenseCount>> {
  const rows = await db
    .select({
      tierId: license.tierId,
      active: sql<number>`count(*)::int`,
      bound: sql<number>`count(${license.serverId})::int`,
    })
    .from(license)
    .where(
      and(
        eq(license.organizationId, organizationId),
        isNull(license.revokedAt),
        isNotNull(license.tierId),
      ),
    )
    .groupBy(license.tierId)
  const out = new Map<string, TierLicenseCount>()
  for (const row of rows) {
    if (!row.tierId) continue
    out.set(row.tierId, { active: Number(row.active), bound: Number(row.bound) })
  }
  return out
}
