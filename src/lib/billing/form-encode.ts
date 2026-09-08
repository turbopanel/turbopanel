/**
 * `application/x-www-form-urlencoded` with Stripe's bracket syntax.
 *
 * Stripe's REST API does not take JSON bodies. Nested structure is spelled
 * with brackets in the key:
 *
 *   nested object      `billing_cycle_anchor_config[day_of_month]=1`
 *   array of objects   `items[0][id]=si_1&items[0][quantity]=3`
 *   array of scalars   `expand[0]=items&expand[1]=customer`
 *   booleans           `true` / `false`
 *   `null`             the empty string — Stripe's "clear this field"
 *   `undefined`        omitted entirely
 *
 * The `null` / `undefined` distinction is the one that matters: a caller that
 * wants to *unset* `trial_end` sends `null`; one that wants to leave it alone
 * leaves the key out. Collapsing the two would make every partial update a
 * potential field-clear.
 *
 * Pure module — no I/O, nothing at module load.
 */

export type StripeFormScalar = string | number | boolean | null
export type StripeFormValue =
  | StripeFormScalar
  | undefined
  | StripeFormValue[]
  | { [key: string]: StripeFormValue }

function isPlainObject(value: unknown): value is { [key: string]: StripeFormValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeScalar(value: StripeFormScalar): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('stripe form values must be finite numbers')
    }
    return String(value)
  }
  return value
}

function collect(
  out: URLSearchParams,
  key: string,
  value: StripeFormValue,
): void {
  if (value === undefined) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => collect(out, `${key}[${index}]`, item))
    return
  }
  if (isPlainObject(value)) {
    for (const [child, childValue] of Object.entries(value)) {
      collect(out, `${key}[${child}]`, childValue)
    }
    return
  }
  out.append(key, encodeScalar(value))
}

/** Encode one request body (or query string). Key order is preserved. */
export function encodeStripeForm(
  params: { [key: string]: StripeFormValue } | undefined,
): string {
  const out = new URLSearchParams()
  if (!params) return ''
  for (const [key, value] of Object.entries(params)) collect(out, key, value)
  return out.toString()
}
