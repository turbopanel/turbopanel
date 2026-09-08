/**
 * Stripe test clocks — the handful of `/v1/test_helpers/test_clocks` calls
 * the live harness (`scripts/billing-test-clock-harness.ts`) needs, typed
 * over the same `StripeClient` production uses.
 *
 * Test-mode only: the endpoints answer `404` on a live key, and nothing in
 * the instance imports this module. It sits beside the transport so it
 * shares the transport's rules — no `@std/*`, nothing at module load, a
 * `StripeApiError` on any non-2xx — and so `subscriptions.hostfree.test.ts`
 * scans it like every other file here.
 *
 * Two traps this module absorbs so no scenario has to remember them:
 *
 *  - **`advance` is asynchronous.** Stripe answers `200` with the clock in
 *    status `advancing` and moves the simulated time in the background;
 *    reading invoices before the clock is `ready` sees the old state.
 *    `advanceTestClock` polls until `ready` (or throws on `internal_failure`).
 *  - **Deleting a clock deletes everything on it** — customers,
 *    subscriptions, invoices. That is the cleanup, and it is why every
 *    scenario gets its own clock.
 */

import type { StripeClient, StripeFormParams } from './client.ts'
import { StripeApiError } from './errors.ts'

export type TestClockStatus = 'ready' | 'advancing' | 'internal_failure'

export type TestClock = Readonly<{
  id: string
  /** Simulated "now", Unix seconds. */
  frozenTime: number
  status: TestClockStatus
  name: string | null
}>

export type TestClockPollOpts = Readonly<{
  /** Between status reads while `advancing`. Default 1 s. */
  pollIntervalMs?: number
  /** Give up after this long. Stripe usually settles in a few seconds; a
   * month of simulated invoices can take a minute. Default 3 min. */
  timeoutMs?: number
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>
}>

const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_TIMEOUT_MS = 3 * 60_000

type StripeObject = Record<string, unknown>

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function parseClock(raw: StripeObject): TestClock {
  const id = str(raw.id)
  const frozenTime = raw.frozen_time
  const status = str(raw.status)
  if (!id || typeof frozenTime !== 'number' || !status) {
    throw new StripeApiError({
      status: 0,
      type: 'unknown',
      message: 'stripe test clock response lacked id, frozen_time or status',
    })
  }
  if (status !== 'ready' && status !== 'advancing' && status !== 'internal_failure') {
    throw new StripeApiError({
      status: 0,
      type: 'unknown',
      message: `stripe test clock ${id} reported unknown status ${status}`,
    })
  }
  return { id, frozenTime, status, name: str(raw.name) }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type CreateTestClockInput = Readonly<{
  /** Simulated start, Unix seconds. */
  frozenTime: number
  name?: string
  /** Reuse on retry; minted otherwise (a duplicate clock is only waste, never wrong). */
  idempotencyKey?: string
}>

export async function createTestClock(
  client: StripeClient,
  input: CreateTestClockInput,
): Promise<TestClock> {
  const body: StripeFormParams = { frozen_time: Math.floor(input.frozenTime) }
  if (input.name) body.name = input.name
  const raw = await client.post<StripeObject>('/v1/test_helpers/test_clocks', body, {
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  })
  return parseClock(raw)
}

export async function getTestClock(client: StripeClient, clockId: string): Promise<TestClock> {
  const raw = await client.get<StripeObject>(
    `/v1/test_helpers/test_clocks/${encodeURIComponent(clockId)}`,
  )
  return parseClock(raw)
}

/**
 * Wait until the clock is `ready`. Throws on `internal_failure` (Stripe
 * asks for a fresh clock in that case) and on timeout.
 */
export async function waitForTestClockReady(
  client: StripeClient,
  clockId: string,
  opts: TestClockPollOpts = {},
): Promise<TestClock> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const sleep = opts.sleep ?? defaultSleep
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const clock = await getTestClock(client, clockId)
    if (clock.status === 'ready') return clock
    if (clock.status === 'internal_failure') {
      throw new StripeApiError({
        status: 0,
        type: 'unknown',
        message: `stripe test clock ${clockId} failed to advance (internal_failure); create a fresh clock`,
      })
    }
    if (Date.now() >= deadline) {
      throw new StripeApiError({
        status: 0,
        type: 'unknown',
        message: `stripe test clock ${clockId} still advancing after ${timeoutMs} ms`,
      })
    }
    await sleep(pollIntervalMs)
  }
}

export type AdvanceTestClockInput = Readonly<{
  clockId: string
  /** Target simulated time, Unix seconds. Must be after the current `frozen_time`. */
  frozenTime: number
  idempotencyKey?: string
}>

/**
 * Advance and block until the clock is `ready` again. Only then have the
 * invoices, payment attempts and webhook events the jump implies been
 * created on Stripe's side.
 */
export async function advanceTestClock(
  client: StripeClient,
  input: AdvanceTestClockInput,
  opts: TestClockPollOpts = {},
): Promise<TestClock> {
  await client.post<StripeObject>(
    `/v1/test_helpers/test_clocks/${encodeURIComponent(input.clockId)}/advance`,
    { frozen_time: Math.floor(input.frozenTime) },
    { ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) },
  )
  return await waitForTestClockReady(client, input.clockId, opts)
}

/** Delete the clock and every object created on it. */
export async function deleteTestClock(client: StripeClient, clockId: string): Promise<void> {
  await client.del<StripeObject>(`/v1/test_helpers/test_clocks/${encodeURIComponent(clockId)}`)
}
