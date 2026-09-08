/**
 * The read-only price verification that gates writing a `tier` row: a
 * conforming price passes, and every shape the downstream code cannot
 * cope with is named rather than silently accepted.
 */

import { assertEquals, assertThrows } from '@std/assert'
import { createStripeClientDouble, formOf } from '../../test-fixtures/stripe-client.ts'
import {
  priceVerificationFailures,
  summarizePrice,
  verifyTierPrice,
} from './tier-verify.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** A price that satisfies every check, with its product expanded. */
function conformingPrice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'price_s3',
    active: true,
    type: 'recurring',
    currency: 'usd',
    unit_amount: 1000,
    recurring: { interval: 'month', interval_count: 1 },
    billing_scheme: 'per_unit',
    tax_behavior: 'exclusive',
    livemode: false,
    lookup_key: 'turbopanel-tier-s3-monthly',
    nickname: 'S3 monthly',
    metadata: { turbopanel_tier_label: 'S3', ignored: 'also echoed' },
    product: { id: 'prod_s3', name: 'TurboPanel S3 server seat', active: true },
    ...overrides,
  }
}

test('summarizePrice normalises the expanded product, the recurring block and metadata', () => {
  const price = summarizePrice(conformingPrice())
  assertEquals(price.id, 'price_s3')
  assertEquals([price.type, price.interval, price.intervalCount], ['recurring', 'month', 1])
  assertEquals([price.billingScheme, price.taxBehavior, price.currency], ['per_unit', 'exclusive', 'usd'])
  assertEquals([price.productId, price.productName, price.productActive], ['prod_s3', 'TurboPanel S3 server seat', true])
  assertEquals(price.metadata, { turbopanel_tier_label: 'S3', ignored: 'also echoed' })
  assertEquals([price.lookupKey, price.nickname, price.livemode], ['turbopanel-tier-s3-monthly', 'S3 monthly', false])
  // A price with no id is a programming error, not a verification failure.
  assertThrows(() => summarizePrice({ active: true }), TypeError)
})

test('an unexpanded product is reported, never quietly treated as active', () => {
  const price = summarizePrice(conformingPrice({ product: 'prod_s3' }))
  assertEquals([price.productId, price.productActive], ['prod_s3', null])
  assertEquals(priceVerificationFailures(price, 1000), [
    'product did not come back expanded; cannot confirm it is active',
  ])
})

test('a conforming price produces no failures', () => {
  assertEquals(priceVerificationFailures(summarizePrice(conformingPrice()), 1000), [])
  // A null expectation skips the amount comparison and nothing else.
  assertEquals(priceVerificationFailures(summarizePrice(conformingPrice()), null), [])
})

test('every unusable shape is named', () => {
  const cases: [Record<string, unknown>, number | null, string][] = [
    [{ active: false }, 1000, 'price is archived (active=false)'],
    [{ product: { id: 'prod_s3', name: 'x', active: false } }, 1000, 'product is archived (product.active=false)'],
    [{ type: 'one_time' }, 1000, 'type one_time ≠ recurring'],
    [{ recurring: { interval: 'year', interval_count: 1 } }, 1000, 'recurring.interval year ≠ month'],
    [{ recurring: { interval: 'month', interval_count: 3 } }, 1000, 'recurring.interval_count 3 ≠ 1'],
    [{ billing_scheme: 'tiered' }, 1000, 'billing_scheme tiered ≠ per_unit'],
    [{ currency: 'eur' }, 1000, 'currency eur ≠ usd'],
    [{ unit_amount: 999 }, 1000, 'unit_amount 999 ≠ price_cents 1000'],
    [{ tax_behavior: 'unspecified' }, 1000, 'tax_behavior is unspecified; set it to inclusive or exclusive on the price'],
    [{ tax_behavior: null }, 1000, 'tax_behavior is unspecified; set it to inclusive or exclusive on the price'],
  ]
  for (const [overrides, expected, message] of cases) {
    const failures = priceVerificationFailures(summarizePrice(conformingPrice(overrides)), expected)
    assertEquals(failures.includes(message), true, `expected "${message}" for ${JSON.stringify(overrides)}, got ${JSON.stringify(failures)}`)
  }
})

test('a price with no recurring block at all fails on interval, not on a crash', () => {
  const failures = priceVerificationFailures(summarizePrice(conformingPrice({ recurring: null, type: 'one_time' })), 1000)
  assertEquals(failures.includes('recurring.interval null ≠ month'), true)
  assertEquals(failures.includes('recurring.interval_count null ≠ 1'), true)
})

test('verifyTierPrice expands the product on one GET and reports ok with no failures', async () => {
  const client = createStripeClientDouble(() => conformingPrice())
  const result = await verifyTierPrice(client, { providerPriceId: 'price_s3', expectedPriceCents: 1000 })
  assertEquals([result.ok, result.failures], [true, []])
  assertEquals(result.price.id, 'price_s3')
  assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), ['GET /v1/prices/price_s3'])
  assertEquals(formOf(client.calls[0]!, 'expand[0]'), 'product')
  // Read-only: never an idempotency key, never a write.
  assertEquals(client.calls[0]!.idempotencyKey, null)
})

test('verifyTierPrice reports ok false with the failures for a wrong-shaped price', async () => {
  const client = createStripeClientDouble(() => conformingPrice({ unit_amount: 500, tax_behavior: 'unspecified' }))
  const result = await verifyTierPrice(client, { providerPriceId: 'price_s3', expectedPriceCents: 1000 })
  assertEquals(result.ok, false)
  assertEquals(result.failures, [
    'unit_amount 500 ≠ price_cents 1000',
    'tax_behavior is unspecified; set it to inclusive or exclusive on the price',
  ])
})
