/**
 * Host-free coverage for the Customer Portal (ledger T5): the configuration
 * is found by metadata before it is ever created, created with exactly the
 * four feature flags under a version-keyed idempotency key when absent,
 * and every session names it.
 *
 * On the ledger's open question — persist the configuration id in a
 * setting row instead of listing on every click — the answer here is "not
 * yet": the lookup is one bounded list call and the metadata match is what
 * survives Stripe forgetting the idempotency key after 24 h. These tests
 * pin that contract; a cached id would sit in front of it, not replace it.
 */

import { assertEquals, assertRejects } from '@std/assert'
import { createStripeClientDouble, formOf, type StripeCall } from '../../test-fixtures/stripe-client.ts'
import {
  createPortalSession,
  ensurePortalConfiguration,
  PORTAL_CONFIGURATION_LOOKUP_KEY,
  PORTAL_CONFIGURATION_LOOKUP_VALUE,
} from './portal.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const LIST = 'GET /v1/billing_portal/configurations'
const CREATE = 'POST /v1/billing_portal/configurations'
const SESSION = 'POST /v1/billing_portal/sessions'

function portalClient(configurations: Record<string, unknown>[]) {
  return createStripeClientDouble((call: StripeCall) => {
    switch (`${call.method} ${call.path}`) {
      case LIST:
        return { object: 'list', data: configurations, has_more: false }
      case CREATE:
        return { id: 'bpc_new', object: 'billing_portal.configuration' }
      case SESSION:
        return { id: 'bps_1', object: 'billing_portal.session', url: 'https://billing.stripe.com/session/bps_1' }
      default:
        throw new Error(`unexpected ${call.method} ${call.path}`)
    }
  })
}

const OURS = { id: 'bpc_ours', object: 'billing_portal.configuration', metadata: { [PORTAL_CONFIGURATION_LOOKUP_KEY]: PORTAL_CONFIGURATION_LOOKUP_VALUE } }

test('T5 · a configuration carrying our metadata is found among the active ones and nothing is created', async () => {
  const client = portalClient([
    { id: 'bpc_default', object: 'billing_portal.configuration', is_default: true, metadata: {} },
    OURS,
  ])
  assertEquals(await ensurePortalConfiguration(client), 'bpc_ours')
  assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), [LIST])
  assertEquals(formOf(client.calls[0]!, 'active'), 'true')
})

test('T5 · with no match — an empty list, or only an older version of ours — the configuration is created with exactly the four feature flags', async () => {
  for (const existing of [[], [{ ...OURS, id: 'bpc_old', metadata: { [PORTAL_CONFIGURATION_LOOKUP_KEY]: 'invoices-and-payment-methods-v0' } }]]) {
    const client = portalClient(existing)
    assertEquals(await ensurePortalConfiguration(client), 'bpc_new')
    assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), [LIST, CREATE])
    const create = client.calls[1]!
    assertEquals(create.idempotencyKey, `portal-configuration:${PORTAL_CONFIGURATION_LOOKUP_VALUE}`)
    assertEquals(create.form, [
      ['features[subscription_update][enabled]', 'false'],
      ['features[subscription_cancel][enabled]', 'false'],
      ['features[invoice_history][enabled]', 'true'],
      ['features[payment_method_update][enabled]', 'true'],
      [`metadata[${PORTAL_CONFIGURATION_LOOKUP_KEY}]`, PORTAL_CONFIGURATION_LOOKUP_VALUE],
    ])
  }
})

test('T5 · a portal session names the configuration, the customer and the return URL, and hands back the url', async () => {
  const client = portalClient([OURS])
  const out = await createPortalSession(client, { providerCustomerId: 'cus_1', returnUrl: 'https://panel.example.com/org/billing' })
  assertEquals(out, { url: 'https://billing.stripe.com/session/bps_1' })
  assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), [LIST, SESSION])
  const session = client.calls[1]!
  assertEquals(session.form, [
    ['customer', 'cus_1'],
    ['configuration', 'bpc_ours'],
    ['return_url', 'https://panel.example.com/org/billing'],
  ])
  // A session is not a mutation of anything durable: no idempotency key.
  assertEquals(session.idempotencyKey, null)
})

test('T5 · a session or configuration Stripe returns without its id or url is an error, never a silent redirect to nowhere', async () => {
  const noUrl = createStripeClientDouble((call: StripeCall) =>
    call.path === '/v1/billing_portal/sessions' ? { id: 'bps_1' } : { object: 'list', data: [OURS] }
  )
  await assertRejects(() => createPortalSession(noUrl, { providerCustomerId: 'cus_1', returnUrl: 'r' }), Error, 'no url')
  const noId = createStripeClientDouble((call: StripeCall) =>
    call.method === 'POST' ? { object: 'billing_portal.configuration' } : { object: 'list', data: [] }
  )
  await assertRejects(() => ensurePortalConfiguration(noId), Error, 'no id')
})
