/**
 * The Stripe subscription mutation surface — the only module that changes
 * a subscription's items, and (with `schedules.ts`) the only one that
 * writes a subscription at all.
 *
 * Each function takes a `StripeClient` and returns a typed result. **None
 * of them writes Postgres**: the webhook projection is what moves
 * entitlement, by reading the *committed* items back from Stripe.
 *
 * ## The one-raise-path rule
 *
 * Every entitlement-raising mutation goes out with
 * `payment_behavior=pending_if_incomplete`. If the immediate proration
 * invoice cannot be paid, Stripe parks the change under
 * `subscription.pending_update` and leaves `subscription.items` alone. The
 * projection reads `items`, so an unpaid change never raises entitlement —
 * no second gate is needed, and nothing here has to know whether a card
 * worked.
 *
 * ## Item arithmetic lives in one place
 *
 * `buildItemMutation` is the only function that produces an `items[]`
 * array. It always emits `quantity` beside `items[n][id]` — sending `price`
 * or `id` alone makes Stripe reset the quantity to **1**, silently, with a
 * `200` — and it passes `deleted: true` only when a tier reaches zero.
 *
 * ## Footguns that return `200`
 *
 *   - the raw anchor-timestamp parameter (the one *without* the `_config`
 *     suffix) on an existing subscription resets the anchor — the 1st-of-month invariant
 *     is gone and nothing complains.
 *   - `proration_behavior` set to the disabling value waives a credit the
 *     customer was owed, and likewise answers `200`.
 *
 * Both are forbidden under `src/lib/billing/` by a source-scan test.
 * Decreases never go through this file at all: a seat removal is a
 * schedule phase (`schedules.ts`), which is how "decreases generate no
 * proration" is achieved without the forbidden parameter.
 *
 * Workers-bundleable: nothing at module load.
 */

import type { StripeClient, StripeFormParams } from './client.ts'
import { STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY } from './customer-subject.ts'

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

/** One projected `seat` row, as the mutation surface sees it. */
export type SeatLine = Readonly<{
  providerItemId: string
  providerPriceId: string
  tierId: string
  quantity: number
}>

export type TierDelta = Readonly<{ tierId: string; delta: number }>

/**
 * One entry of a subscription update's `items[]`. `quantity` is never
 * optional beside `id`: see the module comment.
 */
export type ItemMutation =
  | Readonly<{ id: string; quantity: number }>
  | Readonly<{ id: string; deleted: true }>
  | Readonly<{ price: string; quantity: number }>

/**
 * Apply per-tier deltas to the current seat lines and produce the items
 * array. Every current item is re-emitted with its (possibly unchanged)
 * quantity so the array is complete; a tier that reaches zero is deleted;
 * a tier with no item yet is created via `price`. A delta that would take
 * a tier below zero throws — the caller's arithmetic is wrong, and Stripe
 * would answer `400` anyway.
 */
export function buildItemMutation(
  current: readonly SeatLine[],
  deltas: readonly TierDelta[],
  priceByTier: ReadonlyMap<string, string>,
): ItemMutation[] {
  const deltaByTier = new Map<string, number>()
  for (const { tierId, delta } of deltas) {
    if (!Number.isInteger(delta)) throw new TypeError(`delta for tier ${tierId} is not an integer`)
    deltaByTier.set(tierId, (deltaByTier.get(tierId) ?? 0) + delta)
  }

  const out: ItemMutation[] = []
  const seen = new Set<string>()
  for (const line of current) {
    seen.add(line.tierId)
    const next = line.quantity + (deltaByTier.get(line.tierId) ?? 0)
    if (next < 0) {
      throw new RangeError(`tier ${line.tierId} would go to ${next} seats`)
    }
    if (next === 0) out.push({ id: line.providerItemId, deleted: true })
    else out.push({ id: line.providerItemId, quantity: next })
  }
  for (const [tierId, delta] of deltaByTier) {
    if (seen.has(tierId) || delta === 0) continue
    if (delta < 0) throw new RangeError(`tier ${tierId} has no seats to remove`)
    const price = priceByTier.get(tierId)
    if (!price) throw new TypeError(`tier ${tierId} has no provider price`)
    out.push({ price, quantity: delta })
  }
  return out
}

/** The `items[]` form parameter for one mutation list. */
export function itemsFormParam(items: readonly ItemMutation[]): StripeFormParams[] {
  return items.map((item) => {
    if ('deleted' in item) return { id: item.id, deleted: true }
    if ('id' in item) return { id: item.id, quantity: item.quantity }
    return { price: item.price, quantity: item.quantity }
  })
}

export type CreateCustomerInput = Readonly<{
  organizationId: string
  email?: string | null
  name?: string | null
  /** Reuse across retries; the route derives it from the organization id. */
  idempotencyKey: string
}>

/**
 * C2/C14 — the customer names its organization in `metadata` under exactly
 * the key `customer-subject.ts` reads, so the first webhook can resolve its
 * subject. The caller upserts `payer` from the returned id immediately.
 */
export async function createCustomerForOrganization(
  client: StripeClient,
  input: CreateCustomerInput,
): Promise<{ providerCustomerId: string }> {
  const customer = await client.post<StripeObject>(
    '/v1/customers',
    {
      metadata: { [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: input.organizationId },
      ...(input.email ? { email: input.email } : {}),
      ...(input.name ? { name: input.name } : {}),
    },
    { idempotencyKey: input.idempotencyKey },
  )
  const id = str(customer.id)
  if (!id) throw new Error('stripe customer create returned no id')
  return { providerCustomerId: id }
}

/**
 * C2 — the anchor and billing-mode invariant, spelled once.
 *
 * `billing_cycle_anchor_config` (never the raw timestamp parameter) pins
 * the cycle to the 1st at 00:00:00 UTC; `hour`/`minute`/`second` are
 * explicit because the defaults are "the time of day the subscription was
 * created". Flexible billing mode is what makes mid-cycle quantity changes
 * prorate per item.
 */
export const SUBSCRIPTION_ANCHOR_PARAMS: StripeFormParams = {
  billing_mode: { type: 'flexible' },
  billing_cycle_anchor_config: { day_of_month: 1, hour: 0, minute: 0, second: 0 },
}

export type CreateSubscriptionInput = Readonly<{
  providerCustomerId: string
  lines: readonly { price: string; quantity: number }[]
  idempotencyKey: string
}>

/**
 * C2 — `POST /v1/subscriptions`. `proration_behavior` is deliberately
 * **omitted** so the default (`create_prorations`) issues the partial first
 * month up to the anchor.
 */
export async function createSubscription(
  client: StripeClient,
  input: CreateSubscriptionInput,
): Promise<{ providerSubscriptionId: string; status: string }> {
  const sub = await client.post<StripeObject>(
    '/v1/subscriptions',
    {
      customer: input.providerCustomerId,
      items: input.lines.map((line) => ({ price: line.price, quantity: line.quantity })),
      ...SUBSCRIPTION_ANCHOR_PARAMS,
      collection_method: 'charge_automatically',
      automatic_tax: { enabled: true },
      payment_behavior: 'default_incomplete',
    },
    { idempotencyKey: input.idempotencyKey },
  )
  const id = str(sub.id)
  if (!id) throw new Error('stripe subscription create returned no id')
  return { providerSubscriptionId: id, status: str(sub.status) ?? 'unknown' }
}

export type PreviewLine = Readonly<{
  description: string | null
  amount: number
  proration: boolean
}>

export type SubscriptionChangePreview = Readonly<{
  /** Unix seconds — the caller pins the apply to this exact value. */
  prorationDate: number
  currency: string | null
  subtotal: number | null
  tax: number | null
  total: number | null
  amountDue: number | null
  lines: PreviewLine[]
}>

export type PreviewSubscriptionChangeInput = Readonly<{
  providerSubscriptionId: string
  items: readonly ItemMutation[]
  /** Unix seconds; minted from `nowMs` when absent. */
  prorationDate?: number
  nowMs?: number
}>

/**
 * C5 — `POST /v1/invoices/create_preview` with a **pinned**
 * `subscription_details[proration_date]`. The same timestamp goes on the
 * apply call, so the quote the operator saw is the invoice they get.
 */
export async function previewSubscriptionChange(
  client: StripeClient,
  input: PreviewSubscriptionChangeInput,
): Promise<SubscriptionChangePreview> {
  const prorationDate = input.prorationDate ?? Math.floor((input.nowMs ?? Date.now()) / 1000)
  const invoice = await client.post<StripeObject>('/v1/invoices/create_preview', {
    subscription: input.providerSubscriptionId,
    subscription_details: {
      items: itemsFormParam(input.items),
      proration_date: prorationDate,
      proration_behavior: 'always_invoice',
    },
  })
  const linesPage = isObject(invoice.lines) ? invoice.lines : null
  const rawLines = linesPage && Array.isArray(linesPage.data) ? linesPage.data.filter(isObject) : []
  return {
    prorationDate,
    currency: str(invoice.currency),
    subtotal: num(invoice.subtotal),
    tax: num(invoice.tax) ?? totalTax(invoice),
    total: num(invoice.total),
    amountDue: num(invoice.amount_due),
    lines: rawLines.map((line) => ({
      description: str(line.description),
      amount: num(line.amount) ?? 0,
      proration: line.proration === true ||
        (isObject(line.parent) && isObject(line.parent.subscription_item_details) &&
          line.parent.subscription_item_details.proration === true),
    })),
  }
}

/** `basil` moved invoice tax under `total_taxes[]`; sum it when present. */
function totalTax(invoice: StripeObject): number | null {
  if (!Array.isArray(invoice.total_taxes)) return null
  let sum = 0
  for (const entry of invoice.total_taxes) {
    if (isObject(entry)) sum += num(entry.amount) ?? 0
  }
  return sum
}

export type ApplySubscriptionItemsInput = Readonly<{
  providerSubscriptionId: string
  items: readonly ItemMutation[]
  /** The preview's `prorationDate`, verbatim. */
  prorationDate: number
  idempotencyKey: string
}>

export type ApplySubscriptionItemsResult = Readonly<{
  status: string
  /** Stripe parked the change under `pending_update`; items are unchanged. */
  pending: boolean
}>

/**
 * C3/C6 — `POST /v1/subscriptions/:id` with the preview's `proration_date`
 * at **top level**, `always_invoice` so the proration bills now, and
 * `pending_if_incomplete` so a failed charge parks the change instead of
 * raising entitlement.
 */
export async function applySubscriptionItems(
  client: StripeClient,
  input: ApplySubscriptionItemsInput,
): Promise<ApplySubscriptionItemsResult> {
  const sub = await client.post<StripeObject>(
    `/v1/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`,
    {
      items: itemsFormParam(input.items),
      proration_date: input.prorationDate,
      proration_behavior: 'always_invoice',
      payment_behavior: 'pending_if_incomplete',
    },
    { idempotencyKey: input.idempotencyKey },
  )
  return {
    status: str(sub.status) ?? 'unknown',
    pending: isObject(sub.pending_update),
  }
}

export type ChangeItemPriceInput = Readonly<{
  providerSubscriptionId: string
  providerItemId: string
  /** The successor price. */
  providerPriceId: string
  /** The item's current quantity — **required**, or Stripe resets it to 1. */
  quantity: number
  prorationDate: number
  idempotencyKey: string
}>

/**
 * C4 — price versioning: move one item to its successor price at the same
 * quantity. Fires when the catalogue re-prices a tier, never on a tier
 * move (that is an item swap through `buildItemMutation`).
 */
export async function changeItemPrice(
  client: StripeClient,
  input: ChangeItemPriceInput,
): Promise<ApplySubscriptionItemsResult> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new RangeError('changeItemPrice needs the item quantity')
  }
  const sub = await client.post<StripeObject>(
    `/v1/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`,
    {
      items: [{ id: input.providerItemId, price: input.providerPriceId, quantity: input.quantity }],
      proration_date: input.prorationDate,
      proration_behavior: 'always_invoice',
      payment_behavior: 'pending_if_incomplete',
    },
    { idempotencyKey: input.idempotencyKey },
  )
  return { status: str(sub.status) ?? 'unknown', pending: isObject(sub.pending_update) }
}

export type CancelSubscriptionInput = Readonly<{
  providerSubscriptionId: string
  /** ISO timestamp of the grace expiry that triggered this cancel. */
  graceExpiresAt: string
}>

/** The idempotency key `cancelSubscription` uses: one per `(subscription, expiry)`. */
export function cancelIdempotencyKey(input: CancelSubscriptionInput): string {
  return `cancel:${input.providerSubscriptionId}:${input.graceExpiresAt}`
}

/**
 * C13 — `DELETE /v1/subscriptions/:id`. Leftover credit is forfeited: no
 * refund call exists anywhere.
 *
 * An idempotency key on `DELETE` is not honoured by Stripe, so replay
 * safety cannot rest on the key the way every `POST` mutation in this file
 * gets it for free. Instead this checks status first: a subscription
 * already `canceled` is skipped without a second `DELETE`, so a retried
 * maintenance tick (same `(subscriptionId, graceExpiresAt)`, per
 * {@link cancelIdempotencyKey}) cannot double-cancel — the check makes the
 * call idempotent, not the header.
 */
export async function cancelSubscription(
  client: StripeClient,
  input: CancelSubscriptionInput,
): Promise<{ status: string }> {
  const path = `/v1/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`
  const current = await client.get<StripeObject>(path)
  const currentStatus = str(current.status) ?? 'unknown'
  if (currentStatus === 'canceled') return { status: currentStatus }
  const sub = await client.del<StripeObject>(path, { idempotencyKey: cancelIdempotencyKey(input) })
  return { status: str(sub.status) ?? 'canceled' }
}

/**
 * Read the committed seat lines off a refetched subscription, mapping each
 * price back to a tier. Lines whose price maps to no tier are dropped —
 * the same rule as the projection.
 */
export function seatLinesFromSubscription(
  sub: StripeObject,
  tierByPrice: ReadonlyMap<string, string>,
): SeatLine[] {
  const page = isObject(sub.items) ? sub.items : null
  const data = page && Array.isArray(page.data) ? page.data.filter(isObject) : []
  const out: SeatLine[] = []
  for (const item of data) {
    const providerItemId = str(item.id)
    const providerPriceId = isObject(item.price) ? str(item.price.id) : str(item.price)
    if (!providerItemId || !providerPriceId) continue
    const tierId = tierByPrice.get(providerPriceId)
    if (!tierId) continue
    out.push({ providerItemId, providerPriceId, tierId, quantity: num(item.quantity) ?? 1 })
  }
  return out
}
