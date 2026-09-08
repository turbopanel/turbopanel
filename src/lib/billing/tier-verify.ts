/**
 * Read-only verification of the Stripe Price behind a `tier` row.
 *
 * Nothing writes the catalogue any more: a superadmin creates the Product
 * and Price in the Stripe Dashboard by hand and types the `tier` row in.
 * That makes the price id the one field nothing can check for them, and a
 * wrong id is **not** loud downstream — the projection logs and skips
 * subscription items whose price maps to no tier, so a typo silently loses
 * entitlement instead of failing. This module is the gate that closes that
 * hole: one `GET /v1/prices/:id?expand[]=product`, run before the row is
 * written and refused on any failure.
 *
 * Every check here is code-dependent — something downstream assumes it:
 *
 *   `active`, `product.active`     an archived price cannot be bought into,
 *                                  and the purchasable-tier gate assumes live
 *   recurring / month / count 1    schedule phases and the anchor config
 *                                  assume a monthly cycle
 *   `billing_scheme` per_unit      seats are `quantity` on a licensed price;
 *                                  tiered or volume pricing breaks both the
 *                                  proration maths and the seat arithmetic
 *   `currency`, `unit_amount`      the UI shows `price_cents` and the harness
 *                                  compares invoice totals to it
 *   `tax_behavior` not unspecified every subscription and Checkout goes out
 *                                  with automatic tax on, which fails against
 *                                  an unspecified price without an account
 *                                  default
 *
 * `livemode`, `product.name`, `nickname`, `lookup_key` and `metadata` are
 * returned for the operator to eyeball — nothing reads them. In particular
 * the lookup key stopped being an idempotency handle when the seed died; it
 * is now decoration on the Dashboard side.
 *
 * Workers-bundleable: nothing at module load.
 */

import type { StripeClient } from './client.ts'
import { CATALOGUE_CURRENCY } from './catalogue.ts'

type StripeObject = Record<string, unknown>

function isObject(value: unknown): value is StripeObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Stripe's Price object with its Product expanded, as much as is read or echoed. */
export type StripePriceSummary = Readonly<{
  id: string
  active: boolean
  /** `recurring` or `one_time`. */
  type: string | null
  currency: string
  unitAmount: number | null
  interval: string | null
  intervalCount: number | null
  /** `per_unit` or `tiered`. */
  billingScheme: string | null
  /** `inclusive`, `exclusive` or `unspecified`. */
  taxBehavior: string | null
  /** True on a live-mode price. Reported, never checked — see the module note. */
  livemode: boolean
  lookupKey: string | null
  nickname: string | null
  metadata: Readonly<Record<string, string>>
  productId: string | null
  productName: string | null
  /** Null when the product came back unexpanded (a bare id string). */
  productActive: boolean | null
}>

function readMetadata(raw: unknown): Record<string, string> {
  if (!isObject(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * Normalise one Stripe Price. `product` is read only when it came back
 * expanded; a bare id string leaves `productActive` null, which
 * {@link priceVerificationFailures} reports rather than silently passing.
 */
export function summarizePrice(raw: StripeObject): StripePriceSummary {
  const id = str(raw.id)
  if (!id) throw new TypeError('stripe price without an id')
  const recurring = isObject(raw.recurring) ? raw.recurring : null
  const product = isObject(raw.product) ? raw.product : null
  return {
    id,
    active: raw.active === true,
    type: str(raw.type),
    currency: str(raw.currency) ?? '',
    unitAmount: num(raw.unit_amount),
    interval: recurring ? str(recurring.interval) : null,
    intervalCount: recurring ? num(recurring.interval_count) : null,
    billingScheme: str(raw.billing_scheme),
    taxBehavior: str(raw.tax_behavior),
    livemode: raw.livemode === true,
    lookupKey: str(raw.lookup_key),
    nickname: str(raw.nickname),
    metadata: readMetadata(raw.metadata),
    productId: product ? str(product.id) : str(raw.product),
    productName: product ? str(product.name) : null,
    productActive: product ? product.active === true : null,
  }
}

/**
 * Every reason this Price cannot back a tier row, in operator-readable
 * form. Empty means the row is safe to write.
 *
 * `expectedPriceCents` is the `price_cents` the operator typed; `null`
 * skips the amount comparison only — a custom row carries no price id at
 * all, so in practice this is always a number when it matters.
 *
 * Pure: no Stripe call, no clock. The route and the harness both run it.
 */
export function priceVerificationFailures(
  price: StripePriceSummary,
  expectedPriceCents: number | null,
): string[] {
  const out: string[] = []
  if (!price.active) out.push('price is archived (active=false)')
  if (price.productActive === false) out.push('product is archived (product.active=false)')
  if (price.productActive === null) out.push('product did not come back expanded; cannot confirm it is active')
  if (price.type !== null && price.type !== 'recurring') out.push(`type ${price.type} ≠ recurring`)
  if (price.interval !== 'month') out.push(`recurring.interval ${price.interval} ≠ month`)
  if (price.intervalCount !== 1) out.push(`recurring.interval_count ${price.intervalCount} ≠ 1`)
  if (price.billingScheme !== 'per_unit') out.push(`billing_scheme ${price.billingScheme} ≠ per_unit`)
  if (price.currency !== CATALOGUE_CURRENCY) out.push(`currency ${price.currency} ≠ ${CATALOGUE_CURRENCY}`)
  if (expectedPriceCents !== null && price.unitAmount !== expectedPriceCents) {
    out.push(`unit_amount ${price.unitAmount} ≠ price_cents ${expectedPriceCents}`)
  }
  if (price.taxBehavior === null || price.taxBehavior === 'unspecified') {
    out.push('tax_behavior is unspecified; set it to inclusive or exclusive on the price')
  }
  return out
}

export type TierPriceVerification = Readonly<{
  /** No failures — the row may be written. */
  ok: boolean
  price: StripePriceSummary
  failures: readonly string[]
}>

/**
 * Fetch one Price with its Product and run every check. The Stripe call is
 * a plain `GET`: this never writes, so it is safe to run from a "Verify"
 * button as often as anyone likes.
 *
 * A price id that does not exist raises `StripeApiError` (404) from the
 * client rather than returning failures — the caller maps that to its own
 * refusal, because "no such price" is a different message from "this price
 * is the wrong shape".
 */
export async function verifyTierPrice(
  client: StripeClient,
  input: Readonly<{ providerPriceId: string; expectedPriceCents: number | null }>,
): Promise<TierPriceVerification> {
  const raw = await client.get<StripeObject>(
    `/v1/prices/${encodeURIComponent(input.providerPriceId)}`,
    { expand: ['product'] },
  )
  const price = summarizePrice(raw)
  const failures = priceVerificationFailures(price, input.expectedPriceCents)
  return { ok: failures.length === 0, price, failures }
}
