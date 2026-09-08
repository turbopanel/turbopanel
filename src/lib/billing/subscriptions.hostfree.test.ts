/**
 * The mutation surface: item arithmetic always carries `quantity` beside
 * `items[n][id]`, preview and apply pin the same `proration_date`, the
 * anchor invariant is spelled once, and the two `200`-returning footguns
 * appear nowhere under `src/lib/billing/`.
 */

import { assertEquals, assertThrows } from '@std/assert'
import { createStripeClientDouble, formKeys, formOf } from '../../test-fixtures/stripe-client.ts'
import {
  applySubscriptionItems,
  buildItemMutation,
  cancelIdempotencyKey,
  cancelSubscription,
  changeItemPrice,
  createCustomerForOrganization,
  createSubscription,
  previewSubscriptionChange,
  seatLinesFromSubscription,
  type SeatLine,
} from './subscriptions.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const S3 = '33333333-3333-4333-8333-333333333333'
const S5 = '55555555-5555-4555-8555-555555555555'
const S7 = '77777777-7777-4777-8777-777777777777'
const PRICES = new Map([[S3, 'price_s3'], [S5, 'price_s5'], [S7, 'price_s7']])
const CURRENT: SeatLine[] = [
  { providerItemId: 'si_3', providerPriceId: 'price_s3', tierId: S3, quantity: 4 },
  { providerItemId: 'si_5', providerPriceId: 'price_s5', tierId: S5, quantity: 1 },
]

test('buildItemMutation re-emits every item with a quantity, deletes at zero, creates via price', () => {
  const items = buildItemMutation(CURRENT, [{ tierId: S3, delta: -1 }, { tierId: S5, delta: -1 }, { tierId: S7, delta: 1 }], PRICES)
  assertEquals(items, [
    { id: 'si_3', quantity: 3 },
    { id: 'si_5', deleted: true },
    { price: 'price_s7', quantity: 1 },
  ])
  // Unchanged items still carry their quantity: `id` alone would reset it to 1.
  assertEquals(buildItemMutation(CURRENT, [{ tierId: S3, delta: 2 }], PRICES), [
    { id: 'si_3', quantity: 6 },
    { id: 'si_5', quantity: 1 },
  ])
  for (const item of buildItemMutation(CURRENT, [{ tierId: S3, delta: 2 }], PRICES)) {
    if ('id' in item && !('deleted' in item)) assertEquals(typeof item.quantity, 'number')
  }
})

test('buildItemMutation refuses to go below zero or to create a tier with no price', () => {
  assertThrows(() => buildItemMutation(CURRENT, [{ tierId: S5, delta: -2 }], PRICES), RangeError)
  assertThrows(() => buildItemMutation(CURRENT, [{ tierId: S7, delta: -1 }], PRICES), RangeError)
  assertThrows(() => buildItemMutation(CURRENT, [{ tierId: 'unknown', delta: 1 }], PRICES), TypeError)
})

test('preview and apply carry the identical proration timestamp in their respective positions', async () => {
  const client = createStripeClientDouble((call) => {
    if (call.path === '/v1/invoices/create_preview') {
      return { currency: 'usd', subtotal: 1234, total: 1300, amount_due: 1300, total_taxes: [{ amount: 66 }], lines: { data: [{ description: 'Remaining time', amount: 1234, parent: { subscription_item_details: { proration: true } } }] } }
    }
    return { id: 'sub_1', status: 'active', pending_update: null }
  })
  const items = buildItemMutation(CURRENT, [{ tierId: S3, delta: 1 }], PRICES)
  const preview = await previewSubscriptionChange(client, { providerSubscriptionId: 'sub_1', items, nowMs: 1_800_000_000_500 })
  assertEquals(preview.prorationDate, 1_800_000_000)
  assertEquals(preview.tax, 66)
  assertEquals(preview.lines[0]?.proration, true)
  const [previewCall] = client.calls
  assertEquals(formOf(previewCall!, 'subscription_details[proration_date]'), '1800000000')
  assertEquals(formOf(previewCall!, 'subscription_details[items][0][id]'), 'si_3')
  assertEquals(formOf(previewCall!, 'subscription_details[items][0][quantity]'), '5')
  assertEquals(previewCall!.idempotencyKey, null)

  const applied = await applySubscriptionItems(client, {
    providerSubscriptionId: 'sub_1',
    items,
    prorationDate: preview.prorationDate,
    idempotencyKey: 'intent-key-1',
  })
  assertEquals(applied, { status: 'active', pending: false })
  const applyCall = client.calls[1]!
  assertEquals(applyCall.path, '/v1/subscriptions/sub_1')
  assertEquals(formOf(applyCall, 'proration_date'), '1800000000')
  assertEquals(formOf(applyCall, 'proration_behavior'), 'always_invoice')
  assertEquals(formOf(applyCall, 'payment_behavior'), 'pending_if_incomplete')
  assertEquals(formOf(applyCall, 'items[0][id]'), 'si_3')
  assertEquals(formOf(applyCall, 'items[0][quantity]'), '5')
  assertEquals(applyCall.idempotencyKey, 'intent-key-1')
})

test('a parked update reports pending without touching items', async () => {
  const client = createStripeClientDouble(() => ({ id: 'sub_1', status: 'active', pending_update: { expires_at: 1 } }))
  const applied = await applySubscriptionItems(client, {
    providerSubscriptionId: 'sub_1',
    items: [{ id: 'si_3', quantity: 5 }],
    prorationDate: 1,
    idempotencyKey: 'k',
  })
  assertEquals(applied.pending, true)
})

test('changeItemPrice always sends quantity with the item id', async () => {
  const client = createStripeClientDouble(() => ({ id: 'sub_1', status: 'active' }))
  await changeItemPrice(client, {
    providerSubscriptionId: 'sub_1',
    providerItemId: 'si_3',
    providerPriceId: 'price_s3_v2',
    quantity: 4,
    prorationDate: 7,
    idempotencyKey: 'k',
  })
  const call = client.calls[0]!
  assertEquals(formOf(call, 'items[0][id]'), 'si_3')
  assertEquals(formOf(call, 'items[0][price]'), 'price_s3_v2')
  assertEquals(formOf(call, 'items[0][quantity]'), '4')
  await assertRejects(() =>
    changeItemPrice(client, {
      providerSubscriptionId: 'sub_1',
      providerItemId: 'si_3',
      providerPriceId: 'p',
      quantity: 0,
      prorationDate: 7,
      idempotencyKey: 'k',
    })
  )
})

async function assertRejects(fn: () => Promise<unknown>): Promise<void> {
  let threw = false
  try {
    await fn()
  } catch {
    threw = true
  }
  assertEquals(threw, true)
}

test('createSubscription pins the anchor config, flexible mode, and omits proration_behavior', async () => {
  const client = createStripeClientDouble(() => ({ id: 'sub_new', status: 'incomplete' }))
  await createSubscription(client, {
    providerCustomerId: 'cus_1',
    lines: [{ price: 'price_s3', quantity: 2 }],
    idempotencyKey: 'create-1',
  })
  const call = client.calls[0]!
  assertEquals(formOf(call, 'billing_mode[type]'), 'flexible')
  assertEquals(formOf(call, 'billing_cycle_anchor_config[day_of_month]'), '1')
  assertEquals(formOf(call, 'billing_cycle_anchor_config[hour]'), '0')
  assertEquals(formOf(call, 'billing_cycle_anchor_config[minute]'), '0')
  assertEquals(formOf(call, 'billing_cycle_anchor_config[second]'), '0')
  assertEquals(formOf(call, 'collection_method'), 'charge_automatically')
  assertEquals(formOf(call, 'automatic_tax[enabled]'), 'true')
  assertEquals(formKeys(call).includes('proration_behavior'), false)
  assertEquals(formKeys(call).some((k) => k === 'billing_cycle_anchor'), false)
  assertEquals(call.idempotencyKey, 'create-1')
})

test('createCustomerForOrganization writes the metadata key the projection reads', async () => {
  const client = createStripeClientDouble(() => ({ id: 'cus_9' }))
  const out = await createCustomerForOrganization(client, { organizationId: 'org-1', email: 'o@example.com', idempotencyKey: 'customer:org-1' })
  assertEquals(out.providerCustomerId, 'cus_9')
  assertEquals(formOf(client.calls[0]!, 'metadata[turbopanel_organization_id]'), 'org-1')
  assertEquals(client.calls[0]!.idempotencyKey, 'customer:org-1')
})

test('cancelSubscription checks status first and DELETEs only when not already canceled, keyed on (subscription, grace expiry)', async () => {
  // Stripe's double never moves to canceled on its own here; only the DELETE flips it below.
  const client = createStripeClientDouble((call) => ({ id: 'sub_1', status: call.method === 'DELETE' ? 'canceled' : 'active' }))
  const input = { providerSubscriptionId: 'sub_1', graceExpiresAt: '2026-11-11T00:00:00.000Z' }
  await cancelSubscription(client, input)
  await cancelSubscription(client, input)
  // Every retry precedes its DELETE with a GET; the double's precheck never reports canceled, so both ticks delete.
  assertEquals(client.calls.map((c) => c.method), ['GET', 'DELETE', 'GET', 'DELETE'])
  assertEquals(client.calls[1]!.idempotencyKey, cancelIdempotencyKey(input))
  assertEquals(client.calls[3]!.idempotencyKey, client.calls[1]!.idempotencyKey)
  assertEquals(client.calls[0]!.idempotencyKey, null)
})

test('cancelSubscription skips the DELETE entirely when the precheck already sees canceled', async () => {
  const client = createStripeClientDouble(() => ({ id: 'sub_1', status: 'canceled' }))
  const input = { providerSubscriptionId: 'sub_1', graceExpiresAt: '2026-11-11T00:00:00.000Z' }
  const result = await cancelSubscription(client, input)
  assertEquals(result, { status: 'canceled' })
  assertEquals(client.calls.map((c) => c.method), ['GET'])
})

test('seatLinesFromSubscription maps prices to tiers and drops unknown prices', () => {
  const lines = seatLinesFromSubscription(
    { items: { data: [{ id: 'si_a', price: { id: 'price_s3' }, quantity: 2 }, { id: 'si_b', price: 'price_zz', quantity: 1 }] } },
    new Map([['price_s3', S3]]),
  )
  assertEquals(lines, [{ providerItemId: 'si_a', providerPriceId: 'price_s3', tierId: S3, quantity: 2 }])
})

test('the raw anchor timestamp, the proration-disabling value, and schedule `iterations` appear nowhere under src/lib/billing/', async () => {
  const dir = new URL('./', import.meta.url)
  const offenders: string[] = []
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    const source = await Deno.readTextFile(new URL(entry.name, dir))
    for (const [index, line] of source.split('\n').entries()) {
      // The `_config` form is the supported spelling; the bare timestamp form resets the anchor.
      if (/billing_cycle_anchor(?!_config)/.test(line)) offenders.push(`${entry.name}:${index + 1} raw anchor`)
      // `proration_behavior` may only ever be set to the invoicing value.
      if (/proration_behavior['"]?\s*[:=]\s*['"]none['"]/.test(line)) offenders.push(`${entry.name}:${index + 1} proration disabled`)
      // `iterations` was removed from schedule phases in 2025-09-30.clover; `duration` is the replacement.
      if (/\biterations\b/.test(line)) offenders.push(`${entry.name}:${index + 1} schedule iterations`)
    }
  }
  assertEquals(offenders, [])
})
