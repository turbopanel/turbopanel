/**
 * Stripe's error envelope, typed.
 *
 * Every non-2xx Stripe response carries
 * `{ error: { type, code, message, param, doc_url, request_log_url } }`. It is
 * mapped here onto one `StripeApiError` so callers decide *what to do* from
 * typed fields instead of re-parsing a body — and so a raw Stripe body never
 * reaches a client response (it can name a card, a customer, an amount).
 *
 * Classification is the part callers lean on. It keys primarily on HTTP
 * status and error `code`, not `type`: Stripe's `type` enum has dropped
 * dedicated rate-limit and authentication types over time, folding them into
 * `invalid_request_error` with a distinguishing `code`, so a type-only
 * classifier silently misfires on those the moment Stripe reshapes the body.
 *
 *   transient   429, 409, any 5xx, `api_error`, `rate_limit_error`,
 *               `transport_error`, and codes `rate_limit`, `lock_timeout`,
 *               `idempotency_key_in_use` — the same request may succeed later
 *   permanent   everything else — retrying the same request cannot succeed
 *
 * The next phase's mutation paths retry on transient only.
 */

export type StripeErrorType =
  | 'api_error'
  | 'card_error'
  | 'idempotency_error'
  | 'invalid_request_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'transport_error'
  | 'unknown'

export type StripeErrorClass = 'permanent' | 'transient'

type StripeErrorEnvelope = {
  type?: string
  code?: string
  message?: string
  param?: string
  doc_url?: string
}

const KNOWN_TYPES: ReadonlySet<string> = new Set<StripeErrorType>([
  'api_error',
  'card_error',
  'idempotency_error',
  'invalid_request_error',
  'authentication_error',
  'rate_limit_error',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'rate_limit',
  'lock_timeout',
  'idempotency_key_in_use',
])

export function classifyStripeError(
  status: number,
  type: StripeErrorType,
  code: string | null,
): StripeErrorClass {
  if (type === 'rate_limit_error' || type === 'api_error' || type === 'transport_error') {
    return 'transient'
  }
  if (status === 429 || status === 409 || status >= 500) return 'transient'
  if (code !== null && TRANSIENT_CODES.has(code)) return 'transient'
  return 'permanent'
}

export class StripeApiError extends Error {
  override readonly name = 'StripeApiError'
  readonly status: number
  readonly type: StripeErrorType
  readonly code: string | null
  readonly param: string | null
  readonly docUrl: string | null
  readonly requestId: string | null
  readonly classification: StripeErrorClass

  constructor(init: {
    status: number
    type: StripeErrorType
    message: string
    code?: string | null
    param?: string | null
    docUrl?: string | null
    requestId?: string | null
  }) {
    super(init.message)
    this.status = init.status
    this.type = init.type
    this.code = init.code ?? null
    this.param = init.param ?? null
    this.docUrl = init.docUrl ?? null
    this.requestId = init.requestId ?? null
    this.classification = classifyStripeError(init.status, init.type, this.code)
  }

  /** The same request may succeed later. */
  get isTransient(): boolean {
    return this.classification === 'transient'
  }
}

/**
 * Build the error for one non-2xx response. `body` is whatever the response
 * parsed to (or `null` when it was not JSON) — never the raw text, which is
 * not retained anywhere.
 */
export function stripeErrorFromResponse(
  status: number,
  body: unknown,
  requestId: string | null,
): StripeApiError {
  const envelope: StripeErrorEnvelope = isObject(body) && isObject(body.error)
    ? (body.error as StripeErrorEnvelope)
    : {}
  const rawType = typeof envelope.type === 'string' ? envelope.type : ''
  const type: StripeErrorType = KNOWN_TYPES.has(rawType)
    ? (rawType as StripeErrorType)
    : 'unknown'
  return new StripeApiError({
    status,
    type,
    message: typeof envelope.message === 'string' && envelope.message.length > 0
      ? envelope.message
      : `stripe responded ${status}`,
    code: typeof envelope.code === 'string' ? envelope.code : null,
    param: typeof envelope.param === 'string' ? envelope.param : null,
    docUrl: typeof envelope.doc_url === 'string' ? envelope.doc_url : null,
    requestId,
  })
}

/** A `fetch` that threw, or a body that could not be read. Always transient. */
export function stripeTransportError(cause: unknown): StripeApiError {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new StripeApiError({
    status: 0,
    type: 'transport_error',
    message: `stripe request failed: ${message}`,
  })
}
