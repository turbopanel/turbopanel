/**
 * `Stripe-Signature` verification.
 *
 * The header is `t=<unix seconds>,v1=<hex>[,v1=<hex>…][,v0=…]`. The signed
 * payload is `${t}.${rawBody}` — the **raw bytes** Stripe sent, never a
 * re-serialised parse — under HMAC-SHA256 with the endpoint's `whsec_…`
 * secret, hex-encoded.
 *
 * Two things are deliberate:
 *
 *  - **Every `v1` element is tried.** While an endpoint secret is being
 *    rolled Stripe signs with both the old and the new secret and sends two
 *    `v1=` elements; accepting on *any* match is what makes a roll
 *    zero-downtime. `v0` elements are test-mode noise and ignored.
 *  - **`t` is checked against a tolerance** (default 300 s, Stripe's own).
 *    This is replay protection independent of the delivery ledger: the
 *    ledger stops the *same* event landing twice, the tolerance stops a
 *    captured request being replayed after the ledger row has been swept.
 *    Missing, unparseable, or out-of-window `t` all reject.
 *
 * Comparison goes through `timingSafeSecretEquals` (shared with the GitLab
 * gate), whose ephemeral key is minted on first use, never at module load —
 * `src/workers.ts` imports this tree on boot.
 */

import { timingSafeSecretEquals } from '../git/gitlab-webhook.ts'

/** Header Stripe signs deliveries with. */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature'
/** Stripe's documented default. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300

export type StripeSignatureHeader = {
  timestamp: number
  /** Every `v1` element, in header order. */
  signatures: string[]
}

const textEncoder = new TextEncoder()

/** Parse the header; `null` when it has no usable `t` or no `v1`. */
export function parseStripeSignatureHeader(
  header: string | null | undefined,
): StripeSignatureHeader | null {
  if (typeof header !== 'string' || header.trim().length === 0) return null
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const element of header.split(',')) {
    const eq = element.indexOf('=')
    if (eq <= 0) continue
    const key = element.slice(0, eq).trim()
    const value = element.slice(eq + 1).trim()
    if (key === 't') {
      if (!/^\d+$/.test(value)) return null
      timestamp = Number(value)
    } else if (key === 'v1' && /^[0-9a-f]+$/i.test(value)) {
      signatures.push(value.toLowerCase())
    }
  }
  if (timestamp === null || !Number.isSafeInteger(timestamp)) return null
  if (signatures.length === 0) return null
  return { timestamp, signatures }
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** HMAC-SHA256(`${timestamp}.` ‖ rawBody), hex. Exported for test fixtures. */
export async function computeStripeSignature(
  rawBody: Uint8Array,
  timestamp: number,
  secret: string,
): Promise<string> {
  const prefix = textEncoder.encode(`${timestamp}.`)
  const signed = new Uint8Array(prefix.length + rawBody.length)
  signed.set(prefix, 0)
  signed.set(rawBody, prefix.length)
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const tag = await crypto.subtle.sign('HMAC', key, signed as BufferSource)
  return toHex(new Uint8Array(tag))
}

export type VerifyStripeSignatureOpts = Readonly<{
  toleranceSeconds?: number
  /** Injected clock for tests; unix seconds. */
  nowSeconds?: number
}>

/**
 * `true` only when the header parses, `t` is inside the tolerance, and at
 * least one `v1` matches. An empty secret is a configuration failure and
 * returns `false` — never a pass.
 */
export async function verifyStripeSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string | null | undefined,
  opts: VerifyStripeSignatureOpts = {},
): Promise<boolean> {
  if (typeof secret !== 'string' || secret.length === 0) return false
  const parsed = parseStripeSignatureHeader(signatureHeader)
  if (!parsed) return false

  const tolerance = opts.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - parsed.timestamp) > tolerance) return false

  const expected = await computeStripeSignature(rawBody, parsed.timestamp, secret)
  for (const candidate of parsed.signatures) {
    if (await timingSafeSecretEquals(expected, candidate)) return true
  }
  return false
}
