/**
 * Test-clock helpers against an injected `fetch`: the paths, the advance →
 * poll-until-ready contract, and the failure classification.
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { BillingConfig } from './config.ts'
import { createStripeClient, type StripeFetch } from './client.ts'
import { StripeApiError } from './errors.ts'
import {
  advanceTestClock,
  createTestClock,
  deleteTestClock,
  waitForTestClockReady,
} from './test-clock.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const CONFIG: BillingConfig = {
  secretKey: 'sk_test_abc',
  webhookSigningSecret: null,
  apiVersion: '2025-08-27.basil',
}

type Call = { url: string; method: string; body: string | null }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fetchDouble(
  respond: (call: Call, index: number) => Response,
): { fetch: StripeFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: StripeFetch = (input, init) => {
    const call: Call = {
      url: input,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? init.body : null,
    }
    calls.push(call)
    return Promise.resolve(respond(call, calls.length - 1))
  }
  return { fetch, calls }
}

const noSleep = () => Promise.resolve()

test('createTestClock posts frozen_time and name and parses the clock', async () => {
  const double = fetchDouble(() =>
    json({ id: 'clock_1', object: 'test_helpers.test_clock', frozen_time: 1_900_000_000, status: 'ready', name: 'c1' }),
  )
  const client = createStripeClient(CONFIG, { fetch: double.fetch })
  const clock = await createTestClock(client, { frozenTime: 1_900_000_000.9, name: 'c1' })
  assertEquals(clock, { id: 'clock_1', frozenTime: 1_900_000_000, status: 'ready', name: 'c1' })
  assertEquals(double.calls[0]?.url, 'https://api.stripe.com/v1/test_helpers/test_clocks')
  assertEquals(double.calls[0]?.method, 'POST')
  assertEquals(double.calls[0]?.body, 'frozen_time=1900000000&name=c1')
})

test('advanceTestClock posts the target then polls until ready', async () => {
  const double = fetchDouble((call, index) => {
    if (index === 0) {
      assertEquals(call.method, 'POST')
      assertEquals(call.url, 'https://api.stripe.com/v1/test_helpers/test_clocks/clock_1/advance')
      return json({ id: 'clock_1', frozen_time: 1, status: 'advancing' })
    }
    assertEquals(call.method, 'GET')
    return json({ id: 'clock_1', frozen_time: 2, status: index < 3 ? 'advancing' : 'ready' })
  })
  const client = createStripeClient(CONFIG, { fetch: double.fetch })
  const clock = await advanceTestClock(client, { clockId: 'clock_1', frozenTime: 2 }, { sleep: noSleep })
  assertEquals(clock.status, 'ready')
  assertEquals(clock.frozenTime, 2)
  assertEquals(double.calls.length, 4)
})

test('waitForTestClockReady throws on internal_failure and on timeout', async () => {
  const failing = fetchDouble(() => json({ id: 'clock_1', frozen_time: 1, status: 'internal_failure' }))
  await assertRejects(
    () => waitForTestClockReady(createStripeClient(CONFIG, { fetch: failing.fetch }), 'clock_1', { sleep: noSleep }),
    StripeApiError,
    'internal_failure',
  )
  const stuck = fetchDouble(() => json({ id: 'clock_1', frozen_time: 1, status: 'advancing' }))
  await assertRejects(
    () =>
      waitForTestClockReady(createStripeClient(CONFIG, { fetch: stuck.fetch }), 'clock_1', {
        sleep: noSleep,
        timeoutMs: 0,
      }),
    StripeApiError,
    'still advancing',
  )
})

test('an unknown status or a malformed clock is a StripeApiError, not a silent object', async () => {
  const odd = fetchDouble(() => json({ id: 'clock_1', frozen_time: 1, status: 'weird' }))
  await assertRejects(
    () => waitForTestClockReady(createStripeClient(CONFIG, { fetch: odd.fetch }), 'clock_1'),
    StripeApiError,
    'unknown status',
  )
  const bare = fetchDouble(() => json({ id: 'clock_1' }))
  await assertRejects(
    () => createTestClock(createStripeClient(CONFIG, { fetch: bare.fetch }), { frozenTime: 1 }),
    StripeApiError,
    'lacked',
  )
})

test('deleteTestClock issues DELETE on the clock path', async () => {
  const double = fetchDouble(() => json({ id: 'clock_1', deleted: true }))
  await deleteTestClock(createStripeClient(CONFIG, { fetch: double.fetch }), 'clock_1')
  assertEquals(double.calls[0]?.method, 'DELETE')
  assertEquals(double.calls[0]?.url, 'https://api.stripe.com/v1/test_helpers/test_clocks/clock_1')
})
