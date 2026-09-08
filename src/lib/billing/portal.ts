/**
 * The Customer Portal (C9): invoices and payment methods, nothing else.
 *
 * The portal configuration disables `subscription_update` and
 * `subscription_cancel`. Self-cancel would orphan every attached server,
 * and the portal's `adjustable_quantity[minimum]` is not a substitute for
 * the enroll floor — it is a static number in Stripe while the real floor
 * changes on every enroll and detach. Quantity and tier changes go through
 * this instance's own endpoints, which hold the lease and the ledger.
 *
 * The configuration is found by a `metadata` lookup rather than an
 * idempotency key alone: Stripe forgets idempotency keys after 24 h, and
 * a second configuration would silently split customers across two.
 *
 * Workers-bundleable: nothing at module load.
 */

import type { StripeClient } from './client.ts'

type StripeObject = Record<string, unknown>

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isObject(value: unknown): value is StripeObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const PORTAL_CONFIGURATION_LOOKUP_KEY = 'turbopanel_portal'
/** Bump when the feature set below changes; a new configuration is minted. */
export const PORTAL_CONFIGURATION_LOOKUP_VALUE = 'invoices-and-payment-methods-v1'

export const PORTAL_CONFIGURATION_FEATURES = {
  subscription_update: { enabled: false },
  subscription_cancel: { enabled: false },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
} as const

/** Find or create this instance's portal configuration; returns its id. */
export async function ensurePortalConfiguration(client: StripeClient): Promise<string> {
  const existing = await client.listAll<StripeObject>('/v1/billing_portal/configurations', {
    active: true,
  }, { maxPages: 5 })
  for (const configuration of existing) {
    const metadata = isObject(configuration.metadata) ? configuration.metadata : null
    if (metadata?.[PORTAL_CONFIGURATION_LOOKUP_KEY] === PORTAL_CONFIGURATION_LOOKUP_VALUE) {
      const id = str(configuration.id)
      if (id) return id
    }
  }
  const created = await client.post<StripeObject>(
    '/v1/billing_portal/configurations',
    {
      features: PORTAL_CONFIGURATION_FEATURES,
      metadata: { [PORTAL_CONFIGURATION_LOOKUP_KEY]: PORTAL_CONFIGURATION_LOOKUP_VALUE },
    },
    { idempotencyKey: `portal-configuration:${PORTAL_CONFIGURATION_LOOKUP_VALUE}` },
  )
  const id = str(created.id)
  if (!id) throw new Error('stripe portal configuration returned no id')
  return id
}

export type CreatePortalSessionInput = Readonly<{
  providerCustomerId: string
  returnUrl: string
}>

export async function createPortalSession(
  client: StripeClient,
  input: CreatePortalSessionInput,
): Promise<{ url: string }> {
  const configuration = await ensurePortalConfiguration(client)
  const session = await client.post<StripeObject>('/v1/billing_portal/sessions', {
    customer: input.providerCustomerId,
    configuration,
    return_url: input.returnUrl,
  })
  const url = str(session.url)
  if (!url) throw new Error('stripe portal session returned no url')
  return { url }
}
