/**
 * Deferred changes via subscription schedules — the *only* deferral
 * mechanism (C7).
 *
 * A downgrade or a seat removal takes effect at the period boundary, with
 * no proration and no credit. Rather than touching `proration_behavior`,
 * that is done by parking the change in a schedule's **second phase** that
 * starts at `current_period_end`; the first phase re-states the current
 * items so Stripe changes nothing until then. When the boundary lands the
 * schedule releases (`end_behavior=release`, the default), the webhook
 * projects the new committed items, and `applySeatEntitlements` consumes
 * the matching intents from the ledger.
 *
 * When the outstanding intents give back **every** seat there is nothing
 * left to bill, and a phase must carry at least one item. Then the
 * schedule is written with the current phase alone and
 * `end_behavior=cancel`: the customer keeps what they paid for until the
 * period ends, and the subscription is cancelled there. Releasing the
 * schedule (which every immediate change does first) drops that pending
 * cancellation unless `preserve_cancel_date` is sent — it is not — so a
 * seat bought before the boundary simply resumes the subscription.
 *
 * Rules this module holds:
 *
 *   - **Every update resends every phase.** A partial phase list rewrites
 *     history. The future phase's items are recomputed from scratch each
 *     time as *current seats + all outstanding deferred intents applied*,
 *     so stacking two downgrades never needs an incremental patch.
 *   - **Release before any immediate change.** While a schedule is
 *     attached, editing `items` directly auto-splits the phase. So exactly
 *     one mutation path is live at a time: `mutateSubscription` releases
 *     the schedule, applies the upgrade, and rebuilds the schedule from
 *     the intents that survived in the ledger.
 *   - Phase items are `price` + `quantity`, never `items[n][id]` /
 *     `deleted` — a schedule phase is a description, not an edit.
 *
 * Workers-bundleable: nothing at module load.
 */

import type { StripeClient, StripeFormParams } from './client.ts'
import {
  applySubscriptionItems,
  type ApplySubscriptionItemsResult,
  type ItemMutation,
  type SeatLine,
  seatLinesFromSubscription,
} from './subscriptions.ts'

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

export type SchedulePhaseItem = Readonly<{ price: string; quantity: number }>

export type SchedulePhase = Readonly<{
  /** Unix seconds. */
  startDate: number
  /** Unix seconds; `null` on an open-ended phase. */
  endDate: number | null
  items: readonly SchedulePhaseItem[]
}>

export type SubscriptionSchedule = Readonly<{
  id: string
  providerSubscriptionId: string | null
  status: string | null
  phases: readonly SchedulePhase[]
}>

/** The id of an expandable Stripe reference: a bare id string or an expanded object. */
function refId(value: unknown): string | null {
  return isObject(value) ? str(value.id) : str(value)
}

function parsePhaseItem(raw: unknown): SchedulePhaseItem | null {
  if (!isObject(raw)) return null
  const price = refId(raw.price)
  if (!price) return null
  return { price, quantity: num(raw.quantity) ?? 1 }
}

function parsePhase(raw: unknown): SchedulePhase | null {
  if (!isObject(raw)) return null
  const startDate = num(raw.start_date)
  if (startDate === null) return null
  const items = Array.isArray(raw.items)
    ? raw.items.map(parsePhaseItem).filter((item): item is SchedulePhaseItem => item !== null)
    : []
  return { startDate, endDate: num(raw.end_date), items }
}

/** Normalise a Stripe schedule object to the fields this module uses. */
export function parseSchedule(raw: StripeObject): SubscriptionSchedule {
  const id = str(raw.id)
  if (!id) throw new Error('stripe schedule has no id')
  const phases = Array.isArray(raw.phases)
    ? raw.phases.map(parsePhase).filter((phase): phase is SchedulePhase => phase !== null)
    : []
  return { id, providerSubscriptionId: refId(raw.subscription), status: str(raw.status), phases }
}

export type EnsureScheduleInput = Readonly<{
  providerSubscriptionId: string
  /** The projected `subscription.schedule_id`, when one is attached. */
  scheduleId: string | null
  idempotencyKey: string
}>

/**
 * The schedule for a subscription: the attached one when there is one,
 * otherwise a new one from `from_subscription` (one phase — the current
 * period — that the caller extends).
 */
export async function ensureSchedule(
  client: StripeClient,
  input: EnsureScheduleInput,
): Promise<SubscriptionSchedule> {
  if (input.scheduleId) {
    const existing = await client.get<StripeObject>(
      `/v1/subscription_schedules/${encodeURIComponent(input.scheduleId)}`,
    )
    const parsed = parseSchedule(existing)
    if (parsed.status !== 'released' && parsed.status !== 'canceled' && parsed.status !== 'completed') {
      return parsed
    }
  }
  const created = await client.post<StripeObject>(
    '/v1/subscription_schedules',
    { from_subscription: input.providerSubscriptionId },
    { idempotencyKey: `${input.idempotencyKey}:schedule` },
  )
  return parseSchedule(created)
}

/**
 * The future phase's items: current seats with every outstanding deferred
 * delta applied. Zero-quantity tiers drop out; a negative result throws —
 * the ledger and the seats disagree, which the reconciliation sweep
 * reports rather than this code guessing.
 */
export function computeDeferredItems(
  current: readonly SeatLine[],
  deltasByTier: ReadonlyMap<string, number>,
  priceByTier: ReadonlyMap<string, string>,
): SchedulePhaseItem[] {
  const quantities = new Map<string, number>()
  const prices = new Map<string, string>()
  for (const line of current) {
    quantities.set(line.tierId, (quantities.get(line.tierId) ?? 0) + line.quantity)
    prices.set(line.tierId, line.providerPriceId)
  }
  for (const [tierId, delta] of deltasByTier) {
    const next = (quantities.get(tierId) ?? 0) + delta
    if (next < 0) throw new RangeError(`deferred change takes tier ${tierId} to ${next} seats`)
    quantities.set(tierId, next)
    if (!prices.has(tierId)) {
      const price = priceByTier.get(tierId)
      if (!price) throw new TypeError(`tier ${tierId} has no provider price`)
      prices.set(tierId, price)
    }
  }
  const out: SchedulePhaseItem[] = []
  for (const [tierId, quantity] of quantities) {
    if (quantity <= 0) continue
    const price = prices.get(tierId)
    if (!price) continue
    out.push({ price, quantity })
  }
  return out
}

/** The current phase restated with its own dates — what every update must resend. */
function restateCurrentPhase(currentPhase: SchedulePhase): StripeFormParams {
  if (currentPhase.endDate === null) {
    throw new TypeError('the current phase must have an end date to append a deferred phase')
  }
  return {
    start_date: currentPhase.startDate,
    end_date: currentPhase.endDate,
    items: currentPhase.items.map((item) => ({ price: item.price, quantity: item.quantity })),
  }
}

/**
 * The complete `phases[]` parameter: the current phase restated with its
 * own dates, then one future phase for exactly one period starting where
 * the current one ends. Contiguity is required by Stripe. With no future
 * items the current phase stands alone — the caller pairs that with
 * `end_behavior=cancel`, because a phase with no items is refused.
 */
export function buildSchedulePhasesParam(
  currentPhase: SchedulePhase,
  futureItems: readonly SchedulePhaseItem[],
): StripeFormParams[] {
  const current = restateCurrentPhase(currentPhase)
  if (futureItems.length === 0) return [current]
  const future: StripeFormParams = {
    start_date: current.end_date,
    // The old count-based phase field was removed in 2025-09-30.clover, the
    // version after the pin. `duration` is accepted on the pin today and
    // survives the bump.
    duration: { interval: 'month', interval_count: 1 },
    items: futureItems.map((item) => ({ price: item.price, quantity: item.quantity })),
  }
  return [current, future]
}

export type WriteDeferredPhasesInput = Readonly<{
  schedule: SubscriptionSchedule
  futureItems: readonly SchedulePhaseItem[]
  idempotencyKey: string
}>

/**
 * `POST /v1/subscription_schedules/:id` with **every** phase. No future
 * items means every seat is given back at the boundary: the current phase
 * goes alone and the schedule cancels the subscription when it ends.
 */
export async function writeDeferredPhases(
  client: StripeClient,
  input: WriteDeferredPhasesInput,
): Promise<SubscriptionSchedule> {
  const current = input.schedule.phases[0]
  if (!current) throw new Error(`schedule ${input.schedule.id} has no current phase`)
  const updated = await client.post<StripeObject>(
    `/v1/subscription_schedules/${encodeURIComponent(input.schedule.id)}`,
    {
      phases: buildSchedulePhasesParam(current, input.futureItems),
      end_behavior: input.futureItems.length === 0 ? 'cancel' : 'release',
    },
    { idempotencyKey: `${input.idempotencyKey}:phases` },
  )
  return parseSchedule(updated)
}

/** `POST /v1/subscription_schedules/:id/release` — items stay as they are now. */
export async function releaseSchedule(
  client: StripeClient,
  input: Readonly<{ scheduleId: string; idempotencyKey: string }>,
): Promise<void> {
  await client.post(
    `/v1/subscription_schedules/${encodeURIComponent(input.scheduleId)}/release`,
    {},
    { idempotencyKey: `${input.idempotencyKey}:release` },
  )
}

export type DeferredScheduleInput = Readonly<{
  providerSubscriptionId: string
  scheduleId: string | null
  /** Seat lines as projected — the base the future phase is computed from. */
  current: readonly SeatLine[]
  /** All outstanding deferred deltas, from the ledger. */
  deltasByTier: ReadonlyMap<string, number>
  priceByTier: ReadonlyMap<string, string>
  idempotencyKey: string
}>

/**
 * Make the schedule reflect the ledger: ensure one exists, then write the
 * future phase from scratch. With no outstanding deltas the schedule is
 * released instead, so nothing is parked that the ledger does not know.
 * When the deltas empty the subscription, the write is the cancel-at-end
 * shape described on `writeDeferredPhases`.
 */
export async function syncDeferredSchedule(
  client: StripeClient,
  input: DeferredScheduleInput,
): Promise<{ scheduleId: string | null }> {
  const hasDeltas = [...input.deltasByTier.values()].some((delta) => delta !== 0)
  if (!hasDeltas) {
    if (input.scheduleId) {
      await releaseSchedule(client, { scheduleId: input.scheduleId, idempotencyKey: input.idempotencyKey })
    }
    return { scheduleId: null }
  }
  const schedule = await ensureSchedule(client, {
    providerSubscriptionId: input.providerSubscriptionId,
    scheduleId: input.scheduleId,
    idempotencyKey: input.idempotencyKey,
  })
  const futureItems = computeDeferredItems(input.current, input.deltasByTier, input.priceByTier)
  const written = await writeDeferredPhases(client, {
    schedule,
    futureItems,
    idempotencyKey: input.idempotencyKey,
  })
  return { scheduleId: written.id }
}

export type ImmediateMutationInput = Readonly<{
  kind: 'immediate'
  providerSubscriptionId: string
  scheduleId: string | null
  items: readonly ItemMutation[]
  prorationDate: number
  idempotencyKey: string
  /** Deferred deltas that must survive on a rebuilt schedule afterwards. */
  deferredDeltasByTier: ReadonlyMap<string, number>
  priceByTier: ReadonlyMap<string, string>
  tierByPrice: ReadonlyMap<string, string>
}>

export type DeferredMutationInput = DeferredScheduleInput & Readonly<{ kind: 'deferred' }>

export type MutateSubscriptionInput = ImmediateMutationInput | DeferredMutationInput

export type MutateSubscriptionResult = Readonly<{
  applied: ApplySubscriptionItemsResult | null
  scheduleId: string | null
}>

/**
 * The single entry point every mutation goes through. It checks whether a
 * schedule is attached and picks the API:
 *
 *   immediate  release the schedule (if any) → update items → rebuild the
 *              schedule from the outstanding deferred intents, unless the
 *              update was parked as pending (a schedule cannot be built
 *              over a pending update; the projection rebuilds it once the
 *              update applies or expires).
 *   deferred   ensure the schedule and rewrite its phases.
 */
export async function mutateSubscription(
  client: StripeClient,
  input: MutateSubscriptionInput,
): Promise<MutateSubscriptionResult> {
  if (input.kind === 'deferred') {
    const { scheduleId } = await syncDeferredSchedule(client, input)
    return { applied: null, scheduleId }
  }

  if (input.scheduleId) {
    await releaseSchedule(client, { scheduleId: input.scheduleId, idempotencyKey: input.idempotencyKey })
  }
  const applied = await applySubscriptionItems(client, {
    providerSubscriptionId: input.providerSubscriptionId,
    items: input.items,
    prorationDate: input.prorationDate,
    idempotencyKey: input.idempotencyKey,
  })
  const hasDeferred = [...input.deferredDeltasByTier.values()].some((delta) => delta !== 0)
  if (applied.pending || !hasDeferred) return { applied, scheduleId: null }

  const refetched = await client.get<StripeObject>(
    `/v1/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`,
  )
  const { scheduleId } = await syncDeferredSchedule(client, {
    providerSubscriptionId: input.providerSubscriptionId,
    scheduleId: null,
    current: seatLinesFromSubscription(refetched, input.tierByPrice),
    deltasByTier: input.deferredDeltasByTier,
    priceByTier: input.priceByTier,
    idempotencyKey: `${input.idempotencyKey}:rebuild`,
  })
  return { applied, scheduleId }
}
