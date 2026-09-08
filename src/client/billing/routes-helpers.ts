/**
 * Pure helpers and shared guards for the billing client surface.
 *
 * Everything here is either a body parser, a serializer, or a guard that
 * reads already-loaded state. No Stripe call, no Postgres write.
 */

import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { StripeApiError } from '../../lib/billing/errors.ts'
import {
  outstandingReleasesByTier,
  type PendingChangeLedger,
  readPendingChanges,
} from '../../lib/billing/pending-changes.ts'
import {
  isDelinquentStatus,
  isEndedStatus,
  listSeatsForOrganization,
  type OrganizationBillingState,
  seatQuantitiesByTier,
} from '../../lib/db/billing-records.ts'
import { countActiveLicensesByTier, type TierLicenseCount, type TierRow } from '../../lib/db/tier-records.ts'

export const BILLING_NOT_CONFIGURED_ERROR = 'billing_not_configured'
export const BILLING_MUTATION_IN_PROGRESS_ERROR = 'billing_mutation_in_progress'
export const SUBSCRIPTION_PAST_DUE_ERROR = 'subscription_past_due'
export const SUBSCRIPTION_EXISTS_ERROR = 'subscription_exists'
export const NO_SUBSCRIPTION_ERROR = 'no_subscription'
export const NO_FREE_SEAT_ERROR = 'no_free_seat'
export const SEATS_IN_USE_ERROR = 'seats_in_use'
export const TIER_NOT_PURCHASABLE_ERROR = 'tier_not_purchasable'
export const TIER_REQUIRED_ERROR = 'tier_required'
export const NOT_AN_UPGRADE_ERROR = 'not_an_upgrade'
export const NOT_A_DOWNGRADE_ERROR = 'not_a_downgrade'
export const LICENSE_HAS_PENDING_CHANGE_ERROR = 'license_has_pending_change'
export const STRIPE_ERROR = 'stripe_error'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Rejection sentinel for {@link readUuidField}.
 *
 * A symbol rather than the string `'invalid'`: that token is itself a
 * `string`, so `string | 'invalid'` collapses and cannot be told apart from
 * a body that actually sent it.
 */
export const PARSE_UUID_INVALID: unique symbol = Symbol('parse_uuid_invalid')

export function readUuidField(
  record: Record<string, unknown>,
  key: string,
): string | null | typeof PARSE_UUID_INVALID {
  const value = record[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return PARSE_UUID_INVALID
  const trimmed = value.trim()
  return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : PARSE_UUID_INVALID
}

export function readIntField(
  record: Record<string, unknown>,
  key: string,
): number | null | 'invalid' {
  const value = record[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'invalid'
  return value
}

/** `null` when the body is absent/blank; `'invalid'` when it is not a JSON object. */
export function parseJsonObjectBody(raw: string): Record<string, unknown> | null | 'invalid' {
  if (!raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'invalid'
    return parsed as Record<string, unknown>
  } catch {
    return 'invalid'
  }
}

/** Everything a billing page or mutation reads, in one Postgres round of reads. */
export type BillingOrgView = Readonly<{
  state: OrganizationBillingState
  counts: Map<string, TierLicenseCount>
  ledger: PendingChangeLedger
}>

export async function loadBillingOrgView(
  db: Db,
  organizationId: string,
  nowMs: number,
): Promise<BillingOrgView> {
  const state = await listSeatsForOrganization(db, organizationId)
  const counts = await countActiveLicensesByTier(db, organizationId)
  const { ledger } = state.subscription
    ? await readPendingChanges(db, organizationId, state.subscription.providerSubscriptionId, nowMs)
    : { ledger: { version: 1 as const, providerSubscriptionId: '', intents: [] } }
  return { state, counts, ledger }
}

export type TierSeatSummary = Readonly<{
  tierId: string
  label: string
  seats: number
  licensesUsed: number
  licensesBound: number
  /** Seats not held by an active license, net of outstanding releases. */
  licensesFree: number
}>

/**
 * Per-tier seats vs licenses. Free seats subtract outstanding
 * `release-seat` intents: after a revoke the provider still counts the seat
 * until the boundary, and minting into it would produce bound-license
 * drift the moment the boundary lands.
 */
export function summarizeTierSeats(view: BillingOrgView): TierSeatSummary[] {
  const seats = seatQuantitiesByTier(view.state)
  const releases = outstandingReleasesByTier(view.ledger)
  const out: TierSeatSummary[] = []
  for (const seat of view.state.seats) {
    if (out.some((entry) => entry.tierId === seat.tierId)) continue
    const count = view.counts.get(seat.tierId) ?? { active: 0, bound: 0 }
    const quantity = seats.get(seat.tierId) ?? 0
    out.push({
      tierId: seat.tierId,
      label: seat.tier.label,
      seats: quantity,
      licensesUsed: count.active,
      licensesBound: count.bound,
      licensesFree: Math.max(0, quantity - count.active - (releases.get(seat.tierId) ?? 0)),
    })
  }
  return out
}

export function freeSeatsAtTier(view: BillingOrgView, tierId: string): number {
  return summarizeTierSeats(view).find((entry) => entry.tierId === tierId)?.licensesFree ?? 0
}

export function hasLiveSubscription(view: BillingOrgView): boolean {
  return Boolean(view.state.subscription) && !isEndedStatus(view.state.subscription!.status)
}

export function serializeTier(row: TierRow) {
  return {
    id: row.id,
    label: row.label,
    generation: row.generation,
    rank: row.rank,
    priceCents: row.priceCents,
    isCustom: row.isCustom,
    entitlements: {
      maxCores: row.maxCores,
      maxMemoryBytes: row.maxMemoryBytes,
      nicSlots: row.nicSlots,
      driveSlots: row.driveSlots,
      gpuSlots: row.gpuSlots,
      filesystemSlots: row.filesystemSlots,
    },
  }
}

export function serializeSubscriptionSummary(view: BillingOrgView) {
  const sub = view.state.subscription
  return {
    payer: view.state.payer ? { taxId: view.state.payer.taxId } : null,
    subscription: sub
      ? {
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd,
        pastDueSince: sub.pastDueSince,
        graceExpiresAt: sub.graceExpiresAt,
        scheduleAttached: sub.scheduleId !== null,
      }
      : null,
    tiers: summarizeTierSeats(view),
    pendingChanges: view.ledger.intents.map((intent) => ({
      id: intent.id,
      kind: intent.kind,
      licenseId: intent.licenseId,
      fromTierId: intent.fromTierId,
      toTierId: intent.toTierId,
      createdAt: intent.createdAt,
      expiresAt: intent.expiresAt,
    })),
  }
}

/**
 * C8 — no entitlement-raising change while the subscription is delinquent.
 * A pending update expires in 23 h and Smart Retries are days apart, so it
 * could never apply; refusing up front is the honest answer.
 */
export function assertTierChangeAllowed(
  c: Context<AppEnv>,
  view: BillingOrgView,
): Response | null {
  const refusal = tierChangeRefusal(view)
  return refusal ? c.json(refusal, 409) : null
}

export type TierChangeRefusal =
  | { error: typeof NO_SUBSCRIPTION_ERROR }
  | { error: typeof SUBSCRIPTION_PAST_DUE_ERROR; graceExpiresAt: string | null }

/**
 * The C8 gate as a value: the `409` body an entitlement-raising change
 * gets, or `null` when it may go ahead. `mutations.ts` and the live harness
 * read this; the routes wrap it in a `Response` above.
 */
export function tierChangeRefusal(view: BillingOrgView): TierChangeRefusal | null {
  const sub = view.state.subscription
  if (!sub || isEndedStatus(sub.status)) return { error: NO_SUBSCRIPTION_ERROR }
  if (isDelinquentStatus(sub.status)) {
    return { error: SUBSCRIPTION_PAST_DUE_ERROR, graceExpiresAt: sub.graceExpiresAt }
  }
  return null
}

/** Map a Stripe failure to a client answer without leaking the raw body. */
export function stripeErrorResponse(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof StripeApiError) {
    return c.json(
      { error: STRIPE_ERROR, type: err.type, code: err.code, transient: err.isTransient },
      err.isTransient ? 503 : 502,
    )
  }
  throw err
}
