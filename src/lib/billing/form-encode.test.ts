/**
 * Stripe bracket-syntax form encoding — the pure module where most of the
 * client's correctness lives.
 */

import { assertEquals, assertThrows } from '@std/assert'
import { encodeStripeForm } from './form-encode.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function decode(encoded: string): [string, string][] {
  return [...new URLSearchParams(encoded).entries()]
}

test('scalars encode as strings, booleans as true/false', () => {
  assertEquals(
    decode(encodeStripeForm({ customer: 'cus_1', quantity: 3, proration: false, on: true })),
    [
      ['customer', 'cus_1'],
      ['quantity', '3'],
      ['proration', 'false'],
      ['on', 'true'],
    ],
  )
})

test('nested objects use bracket keys', () => {
  assertEquals(
    decode(encodeStripeForm({ billing_cycle_anchor_config: { day_of_month: 1, hour: 0 } })),
    [
      ['billing_cycle_anchor_config[day_of_month]', '1'],
      ['billing_cycle_anchor_config[hour]', '0'],
    ],
  )
})

test('arrays of objects are indexed, and so are arrays of scalars', () => {
  assertEquals(
    decode(
      encodeStripeForm({
        items: [{ id: 'si_1', quantity: 2 }, { price: 'price_2', quantity: 1 }],
        expand: ['items', 'customer.tax_ids'],
      }),
    ),
    [
      ['items[0][id]', 'si_1'],
      ['items[0][quantity]', '2'],
      ['items[1][price]', 'price_2'],
      ['items[1][quantity]', '1'],
      ['expand[0]', 'items'],
      ['expand[1]', 'customer.tax_ids'],
    ],
  )
})

test('null clears a field; undefined omits it', () => {
  // The distinction that matters: `null` is "unset trial_end", `undefined`
  // is "leave it alone". Collapsing them makes partial updates field-clears.
  assertEquals(
    decode(encodeStripeForm({ trial_end: null, cancel_at: undefined, metadata: { a: null } })),
    [
      ['trial_end', ''],
      ['metadata[a]', ''],
    ],
  )
  assertEquals(encodeStripeForm(undefined), '')
  assertEquals(encodeStripeForm({}), '')
})

test('values are percent-encoded and key order is preserved', () => {
  const encoded = encodeStripeForm({ description: 'a b&c=d', z: 1, a: 2 })
  assertEquals(encoded, 'description=a+b%26c%3Dd&z=1&a=2')
})

test('non-finite numbers are refused rather than sent as NaN', () => {
  assertThrows(() => encodeStripeForm({ quantity: Number.NaN }), TypeError)
  assertThrows(() => encodeStripeForm({ quantity: Number.POSITIVE_INFINITY }), TypeError)
})
