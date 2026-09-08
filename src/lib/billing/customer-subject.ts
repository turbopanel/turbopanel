/**
 * How a provider customer names the TurboPanel subject it pays for.
 *
 * Stripe's `Customer` carries free-form `metadata`; this instance writes one
 * of two keys on every customer it creates (next phase), and the webhook
 * projection reads them back to decide which `payer` row a customer is.
 * Exactly one must be present — `payer_subject_check` enforces the same
 * rule at the table.
 *
 * Read from the **refetched** customer, never from the event payload: the
 * payload is a snapshot from delivery time, and metadata is mutable.
 */

export const STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY = 'turbopanel_organization_id'
export const STRIPE_CUSTOMER_USER_METADATA_KEY = 'turbopanel_user_id'

export type PayerSubject =
  | { organizationId: string; userId: null }
  | { organizationId: null; userId: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readUuid(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : null
}

/**
 * `null` when the customer names no subject, both, or a malformed id — all
 * of which are "log and skip" for the projection, never a guess.
 */
export function resolvePayerSubject(metadata: unknown): PayerSubject | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null
  const record = metadata as Record<string, unknown>
  const organizationId = readUuid(record, STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY)
  const userId = readUuid(record, STRIPE_CUSTOMER_USER_METADATA_KEY)
  if (organizationId && userId) return null
  if (organizationId) return { organizationId, userId: null }
  if (userId) return { organizationId: null, userId }
  return null
}
