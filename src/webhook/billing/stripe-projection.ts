/**
 * What the deferred Stripe task does: refetch, then project.
 *
 * **Never trust the payload.** Delivery is at-least-once and unordered, so a
 * `customer.subscription.updated` from an hour ago can land after the
 * `deleted` that followed it. The event is read only for the object **id**
 * and its type; the object itself is fetched from Stripe so the projection
 * is written from current state, not from a stale snapshot.
 *
 * The events handled:
 *
 *   `customer.subscription.created` / `.updated` / `.deleted`
 *   `customer.subscription.pending_update_applied` / `.pending_update_expired`
 *   `checkout.session.completed`
 *   `invoice.paid` / `invoice.payment_failed`
 *
 * — every one of which ends in the same place: refetch the subscription,
 * upsert `payer` → `subscription` → `seat` in one transaction, then sync
 * entitlements. Two catalogue events — `product.updated`, `price.updated`
 * — refresh a tier's cached display price instead. Unknown types are a
 * logged no-op; the gate has already answered 200.
 *
 * **Entitlement is raised only by committed items.** The refetch reads
 * `subscription.items`; a change Stripe could not charge for lives under
 * `subscription.pending_update` and is deliberately ignored, so the C6
 * gate is this refetch rather than a second code path. The only thing
 * read off `pending_update` is *whether it exists*, which holds the
 * deferred-schedule rebuild until the parked change resolves.
 *
 * Items map to tiers by **product**: an item names a price, the price
 * names its product, and `tier.provider_product_id` names the tier.
 */

import type { Db } from '../../db.ts'
import { revokeDaemonKey } from '../../daemon/authn/server-identity-db.ts'
import { logInfo, logWarn } from '../../logger.ts'
import { StripeApiError } from '../../lib/billing/errors.ts'
import type { StripeClient } from '../../lib/billing/client.ts'
import {
  completeStripeProjection,
  listPendingStripeProjections,
  STRIPE_PROJECTION_RETRY_LIMIT,
} from '../../lib/db/webhook-delivery-records.ts'
import { resolvePayerSubject } from '../../lib/billing/customer-subject.ts'
import type { BillingQuantityLock } from '../../lib/billing/quantity-lock.ts'
import {
  type EntitlementSyncOutcome,
  syncEntitlementsForOrganization,
} from '../../lib/billing/entitlements.ts'
import {
  type ProviderSubscriptionItem,
  replaceSubscriptionItems,
  upsertPayer,
  upsertSubscriptionFromProvider,
} from '../../lib/db/billing-records.ts'
import { mapProviderProductsToTierIds } from '../../lib/db/tier-records.ts'
import { resolveBillingGateway } from '../../lib/billing/gateway.ts'
import { cacheTierPrice } from '../../lib/billing/tier-prices.ts'

export const STRIPE_PROJECTION_LOG_SCOPE = 'billing-webhook'

/** Event types this phase projects. Everything else is `event_not_handled`. */
export const PROJECTED_STRIPE_EVENT_TYPES = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired',
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'product.updated',
  'price.updated',
] as const

/** The only thing read from an event payload. */
export type StripeEventRef = Readonly<{
  id: string
  type: string
  /** `data.object.id` */
  objectId: string | null
  /** `data.object.object` — `subscription`, `checkout.session`, `invoice`, … */
  objectType: string | null
}>

export type StripeProjectionOutcome =
  | {
    action: 'projected'
    subscriptionId: string
    skippedItems: string[]
    /** `null` when the payer names a user, not an organization. */
    entitlements: EntitlementSyncOutcome | null
  }
  | { action: 'catalogue_refreshed'; tierIds: string[] }
  | { action: 'skipped'; reason: string }

type StripeObject = Record<string, unknown>

function isObject(value: unknown): value is StripeObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Stripe fields that are an id when unexpanded and an object when expanded. */
function idOrObjectId(value: unknown): string | null {
  if (typeof value === 'string') return str(value)
  if (isObject(value)) return str(value.id)
  return null
}

function unixToIso(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null
}

/** Pull the object ref out of a parsed event; `null` fields when absent. */
export function stripeEventRef(
  event: { id: string; type: string },
  payload: Record<string, unknown>,
): StripeEventRef {
  const data = isObject(payload.data) ? payload.data : null
  const object = data && isObject(data.object) ? data.object : null
  return {
    id: event.id,
    type: event.type,
    objectId: object ? str(object.id) : null,
    objectType: object ? str(object.object) : null,
  }
}

type SubscriptionItemsPage = { data?: unknown; has_more?: unknown }

async function loadSubscriptionItems(
  client: StripeClient,
  subscriptionId: string,
  embedded: SubscriptionItemsPage | undefined,
): Promise<StripeObject[]> {
  // The embedded `items` list carries the first page only; a subscription
  // with more lines than that is walked through the list endpoint.
  if (embedded && Array.isArray(embedded.data) && embedded.has_more !== true) {
    return embedded.data.filter(isObject)
  }
  const all = await client.listAll<StripeObject>('/v1/subscription_items', {
    subscription: subscriptionId,
  })
  return all.filter(isObject)
}

/**
 * A subscription item embeds its Price object, whose `product` is the
 * product id — so the product→tier map needs no extra call. An item whose
 * price came back as a bare id (never, on a refetch) is dropped and logged.
 */
function providerItems(items: readonly StripeObject[]): ProviderSubscriptionItem[] {
  const out: ProviderSubscriptionItem[] = []
  for (const item of items) {
    const providerItemId = str(item.id)
    const price = isObject(item.price) ? item.price : null
    const providerPriceId = price ? str(price.id) : idOrObjectId(item.price)
    const providerProductId = price ? idOrObjectId(price.product) : null
    const quantity = typeof item.quantity === 'number' ? item.quantity : 1
    if (!providerItemId || !providerPriceId) continue
    if (!providerProductId) {
      logWarn(STRIPE_PROJECTION_LOG_SCOPE, `subscription item ${providerItemId} carries no product; skipped`)
      continue
    }
    out.push({ providerItemId, providerPriceId, providerProductId, quantity })
  }
  return out
}

/**
 * `current_period_end` lives on the subscription before the `basil` API
 * line and on each item from it onward; take whichever is present, and the
 * latest across items when it is per-item.
 */
function currentPeriodEnd(sub: StripeObject, items: readonly StripeObject[]): string | null {
  const own = unixToIso(sub.current_period_end)
  if (own) return own
  let latest: number | null = null
  for (const item of items) {
    const end = item.current_period_end
    if (typeof end === 'number' && Number.isFinite(end) && (latest === null || end > latest)) {
      latest = end
    }
  }
  return latest === null ? null : unixToIso(latest)
}

function firstTaxId(customer: StripeObject): string | null {
  const taxIds = customer.tax_ids
  if (!isObject(taxIds) || !Array.isArray(taxIds.data)) return null
  const first = taxIds.data.find(isObject)
  return first ? str(first.value) : null
}

export type StripeProjectionDeps = Readonly<{
  db: Db
  client: StripeClient
  now?: string
}>

export type ProjectSubscriptionOpts = Readonly<{
  /**
   * A quantity lease the caller already holds (a mutation route reprojecting
   * before it releases). Without one the sync takes its own, retrying briefly
   * — a route or the license gate may hold it for a Stripe round trip.
   */
  lock?: BillingQuantityLock
}>

/**
 * The seam every handled event ends in: refetch one subscription (with its
 * customer and the customer's tax ids expanded), write the three rows, then
 * sync entitlements for the organization it names.
 */
export async function projectSubscriptionById(
  deps: StripeProjectionDeps,
  providerSubscriptionId: string,
  opts: ProjectSubscriptionOpts = {},
): Promise<StripeProjectionOutcome> {
  const sub = await deps.client.get<StripeObject>(
    `/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
    { expand: ['customer', 'customer.tax_ids'] },
  )
  const customer = isObject(sub.customer) ? sub.customer : null
  if (!customer || customer.deleted === true) {
    return { action: 'skipped', reason: 'customer_deleted' }
  }
  const providerCustomerId = str(customer.id)
  if (!providerCustomerId) return { action: 'skipped', reason: 'customer_missing' }

  const subject = resolvePayerSubject(customer.metadata)
  if (!subject) {
    logWarn(
      STRIPE_PROJECTION_LOG_SCOPE,
      `customer ${providerCustomerId} names no TurboPanel subject in metadata; subscription ${providerSubscriptionId} not projected`,
    )
    return { action: 'skipped', reason: 'customer_subject_missing' }
  }

  const status = str(sub.status)
  if (!status) return { action: 'skipped', reason: 'status_missing' }

  const items = await loadSubscriptionItems(
    deps.client,
    providerSubscriptionId,
    isObject(sub.items) ? (sub.items as SubscriptionItemsPage) : undefined,
  )
  const now = deps.now ?? new Date().toISOString()

  // The three rows land atomically. `replaceSubscriptionItems` is
  // delete-then-insert (the unique-constraint workaround it documents), so
  // without a transaction a failure between the delete and the last insert
  // would publish a subscription with fewer seats than the provider counts
  // — and every entitlement read (license minting, tier placement, the
  // per-sample metrics truncation) would act on it. Entitlement sync stays
  // outside: it takes the quantity lease and may call Stripe.
  const { subscriptionId, replaced } = await deps.db.transaction(async (tx) => {
    const { id: payerId } = await upsertPayer(tx, {
      provider: 'stripe',
      providerCustomerId,
      subject,
      taxId: firstTaxId(customer),
      now,
    })
    const { id: subscriptionId } = await upsertSubscriptionFromProvider(tx, {
      payerId,
      providerSubscriptionId,
      status,
      currentPeriodEnd: currentPeriodEnd(sub, items),
      scheduleId: idOrObjectId(sub.schedule),
      now,
    })
    const replaced = await replaceSubscriptionItems(
      tx,
      subscriptionId,
      providerItems(items),
      { now, logScope: STRIPE_PROJECTION_LOG_SCOPE, provider: 'stripe' },
    )
    return { subscriptionId, replaced }
  })

  // Committed items are in; now the assignment follows them. A
  // `pending_update` is read for its presence only — never its contents.
  let entitlements: EntitlementSyncOutcome | null = null
  if (subject.organizationId) {
    entitlements = await syncEntitlementsForOrganization(
      {
        db: deps.db,
        client: deps.client,
        logScope: STRIPE_PROJECTION_LOG_SCOPE,
        nowMs: Date.parse(now),
        onRevokeBound: (serverId) => revokeDaemonKey(deps.db, serverId),
      },
      {
        organizationId: subject.organizationId,
        providerSubscriptionId,
        pendingUpdate: isObject(sub.pending_update),
        lock: opts.lock,
      },
    )
  }
  return { action: 'projected', subscriptionId, skippedItems: replaced.skipped, entitlements }
}

async function subscriptionIdFromCheckoutSession(
  client: StripeClient,
  sessionId: string,
): Promise<string | null> {
  const session = await client.get<StripeObject>(
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
  )
  return idOrObjectId(session.subscription)
}

async function subscriptionIdFromInvoice(
  client: StripeClient,
  invoiceId: string,
): Promise<string | null> {
  const invoice = await client.get<StripeObject>(`/v1/invoices/${encodeURIComponent(invoiceId)}`)
  // Pre-`basil`: `invoice.subscription`. From `basil`:
  // `invoice.parent.subscription_details.subscription`.
  const direct = idOrObjectId(invoice.subscription)
  if (direct) return direct
  const parent = isObject(invoice.parent) ? invoice.parent : null
  const details = parent && isObject(parent.subscription_details) ? parent.subscription_details : null
  return details ? idOrObjectId(details.subscription) : null
}

/**
 * A product or price changed on the Dashboard: refresh the cached display
 * price of the tier that names the product. The price on a `price.*` event
 * is read for its product only; the product is then refetched with its
 * default price, so a retired price never overwrites the cache.
 */
async function refreshTierCatalogue(
  deps: StripeProjectionDeps,
  event: StripeEventRef,
): Promise<StripeProjectionOutcome> {
  let productId: string | null = event.objectId
  if (event.type === 'price.updated' && productId) {
    const price = await deps.client.get<StripeObject>(`/v1/prices/${encodeURIComponent(productId)}`)
    productId = idOrObjectId(price.product)
  }
  if (!productId) return { action: 'skipped', reason: 'product_missing' }
  const tierByProduct = await mapProviderProductsToTierIds(deps.db, 'stripe', [productId])
  const tierId = tierByProduct.get(productId)
  if (!tierId) return { action: 'skipped', reason: 'product_not_a_tier' }
  const product = await resolveBillingGateway(deps.client).getProduct(productId)
  await cacheTierPrice(deps.db, tierId, product)
  return { action: 'catalogue_refreshed', tierIds: [tierId] }
}

/** Dispatch one event to its projection. Idempotent; safe to run twice. */
export async function projectStripeEvent(
  deps: StripeProjectionDeps,
  event: StripeEventRef,
): Promise<StripeProjectionOutcome> {
  if (!event.objectId) return { action: 'skipped', reason: 'object_id_missing' }

  let subscriptionId: string | null
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.pending_update_applied':
    case 'customer.subscription.pending_update_expired':
      // On expiry the items never changed; reprojecting is what lets the
      // deferred schedule be rebuilt now that `pending_update` is gone.
      subscriptionId = event.objectId
      break
    case 'product.updated':
    case 'price.updated':
      return await refreshTierCatalogue(deps, event)
    case 'checkout.session.completed':
      subscriptionId = await subscriptionIdFromCheckoutSession(deps.client, event.objectId)
      break
    case 'invoice.paid':
    case 'invoice.payment_failed':
      // The subscription's own status already reflects the payment outcome;
      // projecting it is what moves `past_due_since`.
      subscriptionId = await subscriptionIdFromInvoice(deps.client, event.objectId)
      break
    default:
      logInfo(STRIPE_PROJECTION_LOG_SCOPE, `event ${event.id} (${event.type}) not handled`)
      return { action: 'skipped', reason: 'event_not_handled' }
  }
  if (!subscriptionId) return { action: 'skipped', reason: 'no_subscription' }
  return await projectSubscriptionById(deps, subscriptionId)
}

export type StripeProjectionSettle = 'completed' | 'pending'

/**
 * Run one event's projection and mark the delivery settled, or leave it
 * pending when Stripe (or the write) failed in a retryable way.
 */
export async function projectAndSettleStripeEvent(
  deps: StripeProjectionDeps,
  event: StripeEventRef,
): Promise<StripeProjectionSettle> {
  try {
    const outcome = await projectStripeEvent(deps, event)
    await completeStripeProjection(
      deps.db,
      event.id,
      deps.now ?? new Date().toISOString(),
    )
    logInfo(
      STRIPE_PROJECTION_LOG_SCOPE,
      `event ${event.id} (${event.type}): ${outcome.action}`,
      JSON.stringify(outcome),
    )
    return 'completed'
  } catch (err) {
    if (err instanceof StripeApiError && !err.isTransient) {
      await completeStripeProjection(
        deps.db,
        event.id,
        deps.now ?? new Date().toISOString(),
      )
      logWarn(
        STRIPE_PROJECTION_LOG_SCOPE,
        `event ${event.id} (${event.type}) permanent Stripe error; settled without projection: ${err.message}`,
      )
      return 'completed'
    }
    logWarn(
      STRIPE_PROJECTION_LOG_SCOPE,
      `event ${event.id} (${event.type}) projection failed; leaving pending: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return 'pending'
  }
}

export type PendingStripeProjectionReport = Readonly<{
  attempted: number
  completed: number
}>

/**
 * Bounded retry of unsettled Stripe webhook projections. Used by the
 * maintenance sweep — not by reconcile, which never refetches Stripe.
 */
export async function runPendingStripeProjections(
  deps: StripeProjectionDeps,
  opts: { limit?: number } = {},
): Promise<PendingStripeProjectionReport> {
  const pending = await listPendingStripeProjections(deps.db, {
    limit: opts.limit ?? STRIPE_PROJECTION_RETRY_LIMIT,
  })
  let completed = 0
  for (const event of pending) {
    const settled = await projectAndSettleStripeEvent(deps, event)
    if (settled === 'completed') completed += 1
  }
  return { attempted: pending.length, completed }
}
