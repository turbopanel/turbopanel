/**
 * The REST client against an injected `fetch` double: headers on every
 * call, the idempotency-key rule, pagination termination, error mapping.
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { BillingConfig } from './config.ts'
import {
  createStripeClient,
  STRIPE_LIST_PAGE_SIZE,
  type StripeFetch,
} from './client.ts'
import { StripeApiError } from './errors.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const CONFIG: BillingConfig = {
  secretKey: 'sk_test_abc',
  webhookSigningSecret: 'whsec_abc',
  apiVersion: '2025-08-27.basil',
}

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null }

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function fetchDouble(
  respond: (call: Call, index: number) => Response | Promise<Response>,
): { fetch: StripeFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: StripeFetch = (input, init) => {
    const call: Call = {
      url: input,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body: typeof init.body === 'string' ? init.body : null,
    }
    calls.push(call)
    return Promise.resolve(respond(call, calls.length - 1))
  }
  return { fetch, calls }
}

test('every call carries Authorization, Stripe-Version and the form content type', async () => {
  const double = fetchDouble(() => jsonResponse(200, { id: 'cus_1' }))
  const client = createStripeClient(CONFIG, { fetch: double.fetch })
  await client.get('/v1/customers/cus_1', { expand: ['tax_ids'] })
  await client.post('/v1/customers', { email: 'a@b.c' })
  await client.del('/v1/customers/cus_1')
  for (const call of double.calls) {
    assertEquals(call.headers['authorization'], 'Bearer sk_test_abc')
    assertEquals(call.headers['stripe-version'], '2025-08-27.basil')
    assertEquals(call.headers['content-type'], 'application/x-www-form-urlencoded')
  }
  assertEquals(double.calls[0]?.url, 'https://api.stripe.com/v1/customers/cus_1?expand%5B0%5D=tax_ids')
  assertEquals(double.calls[0]?.body, null)
  assertEquals(double.calls[1]?.body, 'email=a%40b.c')
})

test('mutating calls always carry an Idempotency-Key; GET never does', async () => {
  const double = fetchDouble(() => jsonResponse(200, {}))
  const client = createStripeClient(CONFIG, { fetch: double.fetch })
  await client.get('/v1/subscriptions/sub_1')
  await client.post('/v1/subscriptions', { customer: 'cus_1' })
  await client.post('/v1/subscriptions', { customer: 'cus_1' }, { idempotencyKey: 'mint-42' })
  await client.del('/v1/subscriptions/sub_1')
  const [get, postMinted, postGiven, del] = double.calls
  assertEquals(get?.headers['idempotency-key'], undefined)
  // Minted inside the call: a caller cannot forget it.
  assertEquals(typeof postMinted?.headers['idempotency-key'], 'string')
  assertEquals((postMinted?.headers['idempotency-key'] ?? '').length > 20, true)
  assertEquals(postGiven?.headers['idempotency-key'], 'mint-42')
  assertEquals(typeof del?.headers['idempotency-key'], 'string')
  // Two minted keys are never the same — one per logical mutation.
  assertEquals(postMinted?.headers['idempotency-key'] === del?.headers['idempotency-key'], false)
})

test('listAll follows has_more with starting_after and stops when it clears', async () => {
  const pages = [
    { object: 'list', data: [{ id: 'si_1' }, { id: 'si_2' }], has_more: true },
    { object: 'list', data: [{ id: 'si_3' }], has_more: false },
  ]
  const double = fetchDouble((_call, index) => jsonResponse(200, pages[index]))
  const client = createStripeClient(CONFIG, { fetch: double.fetch })
  const all = await client.listAll<{ id: string }>('/v1/subscription_items', { subscription: 'sub_1' })
  assertEquals(all.map((item) => item.id), ['si_1', 'si_2', 'si_3'])
  assertEquals(double.calls.length, 2)
  const first = new URL(double.calls[0]!.url)
  assertEquals(first.searchParams.get('limit'), String(STRIPE_LIST_PAGE_SIZE))
  assertEquals(first.searchParams.get('starting_after'), null)
  assertEquals(new URL(double.calls[1]!.url).searchParams.get('starting_after'), 'si_2')
})

test('listAll refuses to walk past the page cap instead of looping', async () => {
  const double = fetchDouble(
    (_call, index) => jsonResponse(200, { object: 'list', data: [{ id: `x_${index}` }], has_more: true }),
  )
  const client = createStripeClient(CONFIG, { fetch: double.fetch })
  await assertRejects(
    () => client.listAll('/v1/subscription_items', {}, { maxPages: 3 }),
    StripeApiError,
    'exceeded 3 pages',
  )
  assertEquals(double.calls.length, 3)
})

test('non-2xx responses map to StripeApiError with classification', async () => {
  const responses: Array<[number, unknown]> = [
    [402, { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.', param: 'source' } }],
    [400, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such customer', param: 'customer', doc_url: 'https://stripe.com/docs' } }],
    // Stripe now sends rate limits as `invalid_request_error` with a
    // distinguishing `code`, not a dedicated `rate_limit_error` type.
    [429, { error: { type: 'invalid_request_error', code: 'rate_limit', message: 'Too many requests hit the API too quickly.' } }],
    [409, { error: { type: 'invalid_request_error', code: 'lock_timeout', message: 'could not acquire lock' } }],
    [500, { error: { type: 'api_error', message: 'boom' } }],
    [502, 'not json at all'],
  ]
  let index = 0
  const double = fetchDouble(() => {
    const [status, body] = responses[index++]!
    return typeof body === 'string'
      ? new Response(body, { status, headers: { 'request-id': `req_${status}` } })
      : jsonResponse(status, body, { 'request-id': `req_${status}` })
  })
  const client = createStripeClient(CONFIG, { fetch: double.fetch })

  const card = await assertRejects(() => client.post('/v1/charges'), StripeApiError)
  assertEquals([card.status, card.type, card.code, card.param, card.isTransient], [402, 'card_error', 'card_declined', 'source', false])
  assertEquals(card.requestId, 'req_402')

  const invalid = await assertRejects(() => client.get('/v1/customers/nope'), StripeApiError)
  assertEquals([invalid.type, invalid.classification, invalid.docUrl], ['invalid_request_error', 'permanent', 'https://stripe.com/docs'])

  const limited = await assertRejects(() => client.get('/v1/x'), StripeApiError)
  assertEquals([limited.status, limited.type, limited.code, limited.isTransient], [429, 'invalid_request_error', 'rate_limit', true])

  const lockTimeout = await assertRejects(() => client.get('/v1/x'), StripeApiError)
  assertEquals([lockTimeout.status, lockTimeout.code, lockTimeout.isTransient], [409, 'lock_timeout', true])

  const api = await assertRejects(() => client.get('/v1/x'), StripeApiError)
  assertEquals([api.type, api.isTransient], ['api_error', true])

  // A gateway page with no JSON still classifies as transient by status and
  // never leaks its body into the message.
  const gateway = await assertRejects(() => client.get('/v1/x'), StripeApiError)
  assertEquals([gateway.status, gateway.type, gateway.isTransient], [502, 'unknown', true])
  assertEquals(gateway.message.includes('not json'), false)
})

test('a fetch that throws is a transient transport error', async () => {
  const client = createStripeClient(CONFIG, {
    fetch: () => Promise.reject(new Error('ECONNRESET')),
  })
  const err = await assertRejects(() => client.get('/v1/x'), StripeApiError)
  assertEquals([err.type, err.isTransient, err.status], ['transport_error', true, 0])
})
