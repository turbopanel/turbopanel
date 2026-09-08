/**
 * Billing gate for license invalidation.
 *
 * Self-hosted (`billingConfig` absent): always allows, and writes nothing.
 *
 * Hosted: revoking a key does not shrink the subscription immediately —
 * seat removal is a deferred change (`src/lib/billing/schedules.ts`), so
 * the seat is given back at the period boundary with no proration. This
 * gate records the `release-seat` intent for the license's tier and
 * rebuilds the schedule's future phase from every outstanding deferred
 * intent, under the organization's quantity lease. A held lease answers
 * `409 billing_mutation_in_progress`; a license with no tier (minted
 * before billing was on) releases nothing and is allowed through.
 *
 * Runs **after** the attachment check and **before** the revoke, so a
 * `409 license_has_attached_server` never leaves an intent behind.
 */

import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { logWarn } from '../../logger.ts'
import { createStripeClient, type StripeClient } from '../../lib/billing/client.ts'
import type { BillingConfig } from '../../lib/billing/config.ts'
import { priceMapWithIntentTargets, seatLinesFromState } from '../../lib/billing/entitlements.ts'
import {
  deferredDeltasByTier,
  intentForLicense,
  newDeferredIntent,
  readPendingChanges,
  withIntent,
  writePendingChanges,
} from '../../lib/billing/pending-changes.ts'
import { endQuantityMutation, tryBeginQuantityMutation } from '../../lib/billing/quantity-lock.ts'
import { syncDeferredSchedule } from '../../lib/billing/schedules.ts'
import { isEndedStatus, listSeatsForOrganization } from '../../lib/db/billing-records.ts'

export type LicenseRuntime = 'deno' | 'workers'

export const BILLING_MUTATION_IN_PROGRESS_ERROR = 'billing_mutation_in_progress'

export type LicenseInvalidationGateInput = Readonly<{
  db: Db
  runtime: LicenseRuntime
  organizationId: string
  licenseId: string
  /** The license's tier, from `inspectLicenseAttachment`; `null` releases nothing. */
  tierId: string | null
  billingConfig: BillingConfig | undefined
  /** Test seam. */
  createClient?: (config: BillingConfig) => StripeClient
  nowMs?: number
}>

/**
 * `null` allows the revoke to proceed; a `Response` refuses it. Both
 * runtimes share this: the Workers path may call Stripe here because a
 * revoke is neither ingest nor page load.
 */
export async function assertLicenseInvalidationAllowed(
  c: Context<AppEnv>,
  input: LicenseInvalidationGateInput,
): Promise<Response | null> {
  if (!input.billingConfig) return null
  if (!input.tierId) return null

  const nowMs = input.nowMs ?? Date.now()
  const lock = await tryBeginQuantityMutation(input.db, input.organizationId, nowMs)
  if (!lock) return c.json({ error: BILLING_MUTATION_IN_PROGRESS_ERROR }, 409)
  try {
    const state = await listSeatsForOrganization(input.db, input.organizationId)
    // Nothing on the provider side counts this seat: nothing to give back.
    if (!state.subscription || isEndedStatus(state.subscription.status)) return null
    const providerSubscriptionId = state.subscription.providerSubscriptionId

    let { ledger } = await readPendingChanges(input.db, input.organizationId, providerSubscriptionId, nowMs)
    const existing = intentForLicense(ledger, input.licenseId)
    if (existing?.kind === 'release-seat') return null
    if (existing) ledger = { ...ledger, intents: ledger.intents.filter((i) => i.id !== existing.id) }
    const intent = newDeferredIntent('release-seat', {
      licenseId: input.licenseId,
      fromTierId: input.tierId,
      toTierId: null,
      nowMs,
    })
    ledger = withIntent(ledger, intent)
    // Written before the Stripe call: a retry after a transport failure
    // finds the intent (and its idempotency key) already recorded.
    await writePendingChanges(input.db, input.organizationId, ledger, nowMs)

    const client = (input.createClient ?? createStripeClient)(input.billingConfig)
    const { lines, priceByTier } = seatLinesFromState(state)
    try {
      await syncDeferredSchedule(client, {
        providerSubscriptionId,
        scheduleId: state.subscription.scheduleId,
        current: lines,
        deltasByTier: deferredDeltasByTier(ledger),
        priceByTier: await priceMapWithIntentTargets(input.db, priceByTier, ledger),
        idempotencyKey: intent.idempotencyKey,
      })
    } catch (err) {
      // The intent stays: the entitlement sync rebuilds the schedule on the
      // next projection, and the revoke itself is still correct locally.
      logWarn('license-lifecycle', `release-seat schedule for license ${input.licenseId} failed: ${String(err)}`)
    }
    return null
  } finally {
    await endQuantityMutation(input.db, lock).catch(() => {})
  }
}
