/**
 * Which provider price a tier bills at, resolved at mutation time.
 *
 * A tier row names a product; the product's default price is what every
 * write names (`items[n][price]`, a schedule phase, a Checkout line item).
 * That lookup is one provider call, made only from the mutation routes and
 * the webhook task — never on ingest or page load — and it refreshes the
 * row's cached display price as a side effect so the billing page shows
 * what the Dashboard says.
 *
 * Workers-bundleable: nothing at module load.
 */

import type { Db } from '../../db.ts'
import { logWarn } from '../../logger.ts'
import {
  getTiersByIds,
  type PurchasableTierRefusal,
  resolvePurchasableTier,
  type TierRow,
  updateTierById,
} from '../db/tier-records.ts'
import {
  type BillingGateway,
  needsAccountTaxDefaults,
  NO_TAX_DEFAULTS,
  type ProviderProduct,
} from './gateway.ts'
import { deferredIntentTargets, type PendingChangeLedger } from './pending-changes.ts'

export type TierPriceRefusal = PurchasableTierRefusal | 'product_unsellable'

export type ResolveTierPriceResult =
  | { ok: true; tier: TierRow; product: ProviderProduct; providerPriceId: string }
  | { ok: false; reason: TierPriceRefusal; failures?: readonly string[] }

/** Refresh the row's display price from the product; best-effort, never throws. */
export async function cacheTierPrice(db: Db, tierId: string, product: ProviderProduct): Promise<void> {
  const price = product.defaultPrice
  if (price?.unitAmount == null) return
  try {
    await updateTierById(db, tierId, { priceCents: price.unitAmount, currency: price.currency })
  } catch (err) {
    logWarn('billing-tier-prices', `tier ${tierId}: price cache refresh failed: ${String(err)}`)
  }
}

/**
 * The price id a purchasable tier bills at right now. Refuses a tier
 * whose product no longer verifies — an archived price or a missing tax
 * behaviour would otherwise surface as a Stripe `400` mid-mutation.
 */
export async function resolveTierPrice(
  db: Db,
  gateway: BillingGateway,
  tierId: string,
): Promise<ResolveTierPriceResult> {
  const purchasable = await resolvePurchasableTier(db, tierId)
  if (!purchasable.ok) return purchasable
  const product = await gateway.getProduct(purchasable.tier.providerProductId)
  const taxDefaults = needsAccountTaxDefaults(product) ? await gateway.getTaxDefaults() : NO_TAX_DEFAULTS
  const verification = gateway.verifyProduct(product, taxDefaults)
  if (!verification.ok || !product.defaultPrice) {
    return { ok: false, reason: 'product_unsellable', failures: verification.failures }
  }
  await cacheTierPrice(db, tierId, product)
  return { ok: true, tier: purchasable.tier, product, providerPriceId: product.defaultPrice.id }
}

/**
 * Price ids for every tier the ledger's deferred intents move *to*, on
 * top of the seats' own prices — the schedule's future phase needs a
 * price for a tier that has no item yet.
 */
export async function priceMapWithIntentTargets(
  db: Db,
  gateway: BillingGateway,
  priceByTier: ReadonlyMap<string, string>,
  ledger: PendingChangeLedger,
): Promise<Map<string, string>> {
  const out = new Map(priceByTier)
  const missing = deferredIntentTargets(ledger).filter((tierId) => !out.has(tierId))
  if (missing.length === 0) return out
  const rows = await getTiersByIds(db, missing)
  for (const [tierId, row] of rows) {
    if (!row.providerProductId) continue
    const product = await gateway.getProduct(row.providerProductId)
    if (product.defaultPrice) out.set(tierId, product.defaultPrice.id)
  }
  return out
}
