/**
 * A recording `StripeClient` double for host-free billing tests.
 *
 * Every call is appended to `calls` (method, path, decoded form body,
 * idempotency key); responses come from `respond`, which sees the same
 * record and returns the object Stripe would. A missing route throws so a
 * test cannot silently pass over a call it never expected.
 */

import type { StripeClient, StripeFormParams } from '../lib/billing/client.ts'
import { encodeStripeForm } from '../lib/billing/form-encode.ts'

export type StripeCall = {
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  /** `encodeStripeForm(body)` split into `[key, value]` pairs, in order. */
  form: [string, string][]
  idempotencyKey: string | null
}

export type StripeResponder = (call: StripeCall) => unknown

export type StripeClientDouble = StripeClient & { calls: StripeCall[] }

export function formOf(call: StripeCall, key: string): string | undefined {
  return call.form.find(([k]) => k === key)?.[1]
}

export function formKeys(call: StripeCall): string[] {
  return call.form.map(([k]) => k)
}

export function createStripeClientDouble(respond: StripeResponder): StripeClientDouble {
  const calls: StripeCall[] = []
  const record = (
    method: StripeCall['method'],
    path: string,
    body: StripeFormParams | undefined,
    idempotencyKey: string | null,
  ): StripeCall => {
    const encoded = encodeStripeForm(body)
    const form = [...new URLSearchParams(encoded).entries()] as [string, string][]
    const call: StripeCall = { method, path, form, idempotencyKey }
    calls.push(call)
    return call
  }
  return {
    calls,
    get: <T>(path: string, query?: StripeFormParams) =>
      Promise.resolve(respond(record('GET', path, query, null)) as T),
    post: <T>(path: string, body?: StripeFormParams, opts?: { idempotencyKey?: string }) =>
      Promise.resolve(respond(record('POST', path, body, opts?.idempotencyKey ?? null)) as T),
    del: <T>(path: string, opts?: { idempotencyKey?: string }) =>
      Promise.resolve(respond(record('DELETE', path, undefined, opts?.idempotencyKey ?? null)) as T),
    listAll: <T>(path: string, query?: StripeFormParams) => {
      const result = respond(record('GET', path, query, null)) as { data?: T[] } | T[]
      return Promise.resolve(Array.isArray(result) ? result : result.data ?? [])
    },
  }
}
