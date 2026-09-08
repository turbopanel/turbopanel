/**
 * A dependency-free Stripe REST client.
 *
 * No `stripe` npm package: it drags in a Node HTTP stack and module-load
 * crypto that the Workers bundle rejects (error 10021 — `src/workers.ts`
 * imports this tree on boot), and the handful of calls this instance makes
 * are plain HTTPS with three headers. Everything here is Web API only
 * (`fetch`, `crypto.randomUUID`, `URLSearchParams`, `AbortSignal`), and
 * nothing runs at module load.
 *
 * Three rules every request follows:
 *
 *  - `Authorization: Bearer <secret key>`, `Stripe-Version: <pinned>` and
 *    `Content-Type: application/x-www-form-urlencoded` on every call. The
 *    version pin is what keeps response shapes stable across account
 *    dashboard changes — see `config.ts`.
 *  - **Every mutating call carries an `Idempotency-Key`.** Not optional: the
 *    key is minted inside `post` / `del` when the caller does not supply one,
 *    so it cannot be forgotten. A caller that *retries* a mutation must pass
 *    the same key it used the first time, or Stripe will happily create a
 *    second subscription.
 *  - A non-2xx body is mapped to `StripeApiError` (`errors.ts`) and never
 *    surfaces raw.
 *
 * `listAll` walks `has_more` / `starting_after` with a hard page cap, so a
 * runaway list (or a Stripe bug that never clears `has_more`) fails loudly
 * instead of looping.
 */

import { encodeStripeForm, type StripeFormValue } from './form-encode.ts'
import type { BillingConfig } from './config.ts'
import {
  StripeApiError,
  stripeErrorFromResponse,
  stripeTransportError,
} from './errors.ts'

export const STRIPE_API_BASE_URL = 'https://api.stripe.com'
/** Per-request ceiling. Stripe's own p99 is well under this. */
export const STRIPE_REQUEST_TIMEOUT_MS = 20_000
/** `listAll` page size — Stripe's maximum. */
export const STRIPE_LIST_PAGE_SIZE = 100
/** `listAll` refuses to walk more pages than this (10 000 objects). */
export const STRIPE_LIST_MAX_PAGES = 100

export type StripeFormParams = { [key: string]: StripeFormValue }

export type StripeList<T> = {
  object: 'list'
  data: T[]
  has_more: boolean
}

export type StripeMutationOpts = Readonly<{
  /** Reuse across retries of the *same* logical mutation. Minted when absent. */
  idempotencyKey?: string
}>

export type StripeFetch = (input: string, init: RequestInit) => Promise<Response>

export type StripeClient = {
  get<T = Record<string, unknown>>(path: string, query?: StripeFormParams): Promise<T>
  post<T = Record<string, unknown>>(
    path: string,
    body?: StripeFormParams,
    opts?: StripeMutationOpts,
  ): Promise<T>
  del<T = Record<string, unknown>>(path: string, opts?: StripeMutationOpts): Promise<T>
  listAll<T = Record<string, unknown>>(
    path: string,
    query?: StripeFormParams,
    opts?: { maxPages?: number },
  ): Promise<T[]>
}

export type StripeClientOpts = Readonly<{
  /** Injected in tests; defaults to the global `fetch`, resolved per call. */
  fetch?: StripeFetch
  baseUrl?: string
  timeoutMs?: number
}>

function stripePath(path: string): string {
  if (!path.startsWith('/')) throw new TypeError('stripe path must start with "/"')
  return path
}

function idOf(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) return null
  const id = (item as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

export function createStripeClient(
  config: BillingConfig,
  opts: StripeClientOpts = {},
): StripeClient {
  const baseUrl = (opts.baseUrl ?? STRIPE_API_BASE_URL).replace(/\/$/, '')
  const timeoutMs = opts.timeoutMs ?? STRIPE_REQUEST_TIMEOUT_MS

  async function request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: StripeFormParams | undefined,
    idempotencyKey: string | null,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.secretKey}`,
      'Stripe-Version': config.apiVersion,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

    const encoded = encodeStripeForm(params)
    let url = `${baseUrl}${stripePath(path)}`
    let body: string | undefined
    if (method === 'GET' || method === 'DELETE') {
      if (encoded.length > 0) url += `?${encoded}`
    } else {
      body = encoded
    }

    // Resolved per call, never captured at module load (Workers 10021), and
    // `AbortSignal.timeout` likewise minted here.
    const doFetch: StripeFetch = opts.fetch ?? ((input, init) => fetch(input, init))
    let response: Response
    try {
      response = await doFetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw stripeTransportError(err)
    }

    const requestId = response.headers.get('request-id')
    let parsed: unknown = null
    try {
      const text = await response.text()
      parsed = text.length > 0 ? JSON.parse(text) : null
    } catch (err) {
      if (response.ok) throw stripeTransportError(err)
      // A non-JSON error body (a gateway page) still classifies by status.
    }
    if (!response.ok) throw stripeErrorFromResponse(response.status, parsed, requestId)
    return parsed as T
  }

  return {
    get: (path, query) => request('GET', path, query, null),
    post: (path, body, mutation) =>
      request('POST', path, body, mutation?.idempotencyKey ?? crypto.randomUUID()),
    del: (path, mutation) =>
      request('DELETE', path, undefined, mutation?.idempotencyKey ?? crypto.randomUUID()),

    async listAll<T>(
      path: string,
      query: StripeFormParams = {},
      listOpts: { maxPages?: number } = {},
    ): Promise<T[]> {
      const maxPages = listOpts.maxPages ?? STRIPE_LIST_MAX_PAGES
      const out: T[] = []
      let startingAfter: string | null = null
      for (let page = 0; page < maxPages; page += 1) {
        const pageQuery: StripeFormParams = {
          ...query,
          limit: STRIPE_LIST_PAGE_SIZE,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        }
        const result = await request<StripeList<T>>('GET', path, pageQuery, null)
        const data = Array.isArray(result?.data) ? result.data : []
        out.push(...data)
        if (!result?.has_more) return out
        const last = idOf(data.at(-1))
        // `has_more` with no cursor to continue from can only loop; refuse.
        if (!last) break
        startingAfter = last
      }
      throw new StripeApiError({
        status: 0,
        type: 'unknown',
        message: `stripe list ${path} exceeded ${maxPages} pages`,
      })
    },
  }
}
