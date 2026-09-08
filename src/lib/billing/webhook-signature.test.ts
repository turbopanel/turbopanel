/**
 * `Stripe-Signature` verification over raw bytes, with tolerance and
 * multi-`v1` acceptance.
 */

import { assertEquals } from '@std/assert'
import {
  computeStripeSignature,
  parseStripeSignatureHeader,
  STRIPE_SIGNATURE_TOLERANCE_SECONDS,
  verifyStripeSignature,
} from './webhook-signature.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SECRET = 'whsec_test_secret_0123456789'
const OTHER_SECRET = 'whsec_rolled_secret_9876543210'
const NOW = 1_800_000_000
const BODY = new TextEncoder().encode('{"id":"evt_1","type":"customer.subscription.updated","data":{"object":{"id":"sub_1"}}}')

async function header(body: Uint8Array, secret: string, t = NOW): Promise<string> {
  return `t=${t},v1=${await computeStripeSignature(body, t, secret)}`
}

test('a valid v1 over the raw bytes verifies', async () => {
  const h = await header(BODY, SECRET)
  assertEquals(await verifyStripeSignature(BODY, h, SECRET, { nowSeconds: NOW }), true)
})

test('any matching v1 element is accepted (secret roll sends two)', async () => {
  const oldSig = await computeStripeSignature(BODY, NOW, OTHER_SECRET)
  const newSig = await computeStripeSignature(BODY, NOW, SECRET)
  const h = `t=${NOW},v1=${oldSig},v1=${newSig},v0=deadbeef`
  assertEquals(await verifyStripeSignature(BODY, h, SECRET, { nowSeconds: NOW }), true)
  assertEquals(await verifyStripeSignature(BODY, h, OTHER_SECRET, { nowSeconds: NOW }), true)
  assertEquals(parseStripeSignatureHeader(h)?.signatures.length, 2)
})

test('a wrong secret, an empty secret, or a missing header rejects', async () => {
  const h = await header(BODY, SECRET)
  assertEquals(await verifyStripeSignature(BODY, h, OTHER_SECRET, { nowSeconds: NOW }), false)
  assertEquals(await verifyStripeSignature(BODY, h, '', { nowSeconds: NOW }), false)
  assertEquals(await verifyStripeSignature(BODY, h, null, { nowSeconds: NOW }), false)
  assertEquals(await verifyStripeSignature(BODY, null, SECRET, { nowSeconds: NOW }), false)
  assertEquals(await verifyStripeSignature(BODY, '', SECRET, { nowSeconds: NOW }), false)
})

test('missing, garbage, or non-numeric t rejects', async () => {
  const sig = await computeStripeSignature(BODY, NOW, SECRET)
  assertEquals(await verifyStripeSignature(BODY, `v1=${sig}`, SECRET, { nowSeconds: NOW }), false)
  assertEquals(await verifyStripeSignature(BODY, `t=abc,v1=${sig}`, SECRET, { nowSeconds: NOW }), false)
  assertEquals(await verifyStripeSignature(BODY, `t=,v1=${sig}`, SECRET, { nowSeconds: NOW }), false)
  assertEquals(await verifyStripeSignature(BODY, 'garbage', SECRET, { nowSeconds: NOW }), false)
  assertEquals(parseStripeSignatureHeader(`t=${NOW}`), null)
  assertEquals(parseStripeSignatureHeader(`t=${NOW},v1=not-hex`), null)
})

test('a timestamp outside the tolerance rejects, inside it verifies', async () => {
  const stale = NOW - STRIPE_SIGNATURE_TOLERANCE_SECONDS - 1
  const fresh = NOW - STRIPE_SIGNATURE_TOLERANCE_SECONDS
  assertEquals(
    await verifyStripeSignature(BODY, await header(BODY, SECRET, stale), SECRET, { nowSeconds: NOW }),
    false,
  )
  assertEquals(
    await verifyStripeSignature(BODY, await header(BODY, SECRET, fresh), SECRET, { nowSeconds: NOW }),
    true,
  )
  // Future-dated is just as wrong as stale.
  assertEquals(
    await verifyStripeSignature(BODY, await header(BODY, SECRET, NOW + 600), SECRET, { nowSeconds: NOW }),
    false,
  )
  // A caller may tighten the window.
  assertEquals(
    await verifyStripeSignature(BODY, await header(BODY, SECRET, NOW - 30), SECRET, {
      nowSeconds: NOW,
      toleranceSeconds: 10,
    }),
    false,
  )
})

test('the signature covers the exact bytes — one byte changed rejects', async () => {
  const h = await header(BODY, SECRET)
  const altered = new Uint8Array(BODY)
  altered[altered.length - 2] = 0x20
  assertEquals(await verifyStripeSignature(altered, h, SECRET, { nowSeconds: NOW }), false)
  // Re-serialised JSON (same object, different bytes) also rejects: this is
  // why the gate hands raw bytes to verify.
  const reserialised = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(BODY)), null, 2))
  assertEquals(await verifyStripeSignature(reserialised, h, SECRET, { nowSeconds: NOW }), false)
})
