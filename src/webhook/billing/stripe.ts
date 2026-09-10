/**
 * Stripe events — the third `WebhookGate` kind, at `/webhook/stripe`.
 *
 * The ordering, the delivery ledger and the retry contract live in
 * `../gate.ts`; signature verification, per-peer rate limiting,
 * raw-bytes-before-parse and the replay claim all come from there rather
 * than from a parallel handler. What is Stripe-specific:
 *
 *  - **No tenant in the URL.** One instance holds one Stripe account and one
 *    signing secret, so `resolve` returns a single holder carrying the
 *    instance's `BillingConfig` (or none). There is no `:ref` path. The
 *    customer is named in the payload, and only read after a refetch.
 *  - **Delivery id and event name live in the body.** Stripe puts `id`
 *    (`evt_…`) and `type` in the JSON, not in headers; this is the
 *    documented raw-bytes escape hatch.
 *  - **Not configured is `503`.** No secret key (billing off) or no signing
 *    secret answers `stripe_webhook_not_configured` — the gap is on this
 *    side, and it is never an unauthenticated accept.
 *
 * ## Acknowledge immediately, work asynchronously
 *
 * A slow `invoice.created` handler delays finalising **every**
 * automatic-collection invoice on the account for up to 72 hours, so
 * `dispatch` must not do its work inline. It durably stores the event ref
 * on the claimed delivery row, then schedules the projection
 * (`runAfterResponse`) and returns `accepted`. The 2xx is only returned
 * after that handoff succeeds; a failed handoff releases the claim and
 * answers retryable `5xx`.
 *
 * The deferred task **opens its own DB client and closes it in `finally`**.
 * `src/workers.ts` ends the per-request client in its own `waitUntil`; a
 * second `waitUntil` still using `c.get('db')` races that close and dies
 * with `write CONNECTION_ENDED` (the hard rule in `AGENTS.md`). Deno's
 * client is process-lived, so there the task uses it and closes nothing.
 *
 * If the after-response task crashes, the delivery stays claimed with
 * `projectedAt` unset. Recovery is the maintenance sweep calling
 * `runPendingStripeProjections` — not `reconcile.ts`, which only compares
 * Postgres and never refetches Stripe.
 */

import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { createWorkersDb, endDbConnection, getDb, type Db } from '../../db.ts'
import { logWarn } from '../../logger.ts'
import { STRIPE_WEBHOOK_PATH } from '../../surfaces.ts'
import { stripeWebhookRateLimitKey } from '../../daemon/rate-limit/keys.ts'
import type { BillingConfig } from '../../lib/billing/config.ts'
import { createStripeClient, type StripeClient } from '../../lib/billing/client.ts'
import {
  STRIPE_SIGNATURE_HEADER,
  verifyStripeSignature,
} from '../../lib/billing/webhook-signature.ts'
import { type AfterResponseScheduler, runAfterResponse } from '../../lib/http/after-response.ts'
import { enqueueStripeProjection } from '../../lib/db/webhook-delivery-records.ts'
import {
  accepted,
  type DeliveryOutcome,
  type GateContext,
  registerWebhookGate,
  retryable,
  type WebhookGate,
  type WebhookGateOpts,
} from '../gate.ts'
import {
  projectAndSettleStripeEvent,
  STRIPE_PROJECTION_LOG_SCOPE,
  stripeEventRef,
} from './stripe-projection.ts'

/**
 * Hard ceiling on an accepted event body — same order as the git kinds. A
 * Stripe event is a few KB; the gate's streaming reader is the authoritative
 * limit and this is what it enforces.
 */
export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024

/** `503` body when billing is off or the signing secret is missing. */
export const STRIPE_WEBHOOK_NOT_CONFIGURED = 'stripe_webhook_not_configured'

/** The one holder: this instance's billing config, or none. */
export type StripeWebhookHolder = Readonly<{ config: BillingConfig | null }>

export type StripeWebhookRouteOpts = WebhookGateOpts & {
  /** Test seam: capture the deferred task instead of running it. */
  schedule?: AfterResponseScheduler
  /** Test seam: a client over an injected `fetch`. */
  createClient?: (config: BillingConfig) => StripeClient
}

function parseEvent(raw: Uint8Array): { id: string; type: string; payload: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const payload = parsed as Record<string, unknown>
    const id = typeof payload.id === 'string' ? payload.id.trim() : ''
    const type = typeof payload.type === 'string' ? payload.type.trim() : ''
    if (id.length === 0 || type.length === 0) return null
    return { id, type, payload }
  } catch {
    return null
  }
}

/**
 * The deferred task's own client. Workers: fresh from the connection string,
 * closed by the caller. Deno: the process client, not closed.
 */
function openTaskDb(c: Context<AppEnv>): { db: Db; close: () => Promise<void> } | null {
  if (c.get('runtime') === 'workers') {
    const connectionString = c.get('postgresConnectionString')
    if (!connectionString) return null
    const db = createWorkersDb({ connectionString })
    return { db, close: () => endDbConnection(db) }
  }
  const db = getDb(c)
  return db ? { db, close: () => Promise.resolve() } : null
}

function createStripeGate(opts: StripeWebhookRouteOpts): WebhookGate<StripeWebhookHolder> {
  const createClient = opts.createClient ?? ((config: BillingConfig) => createStripeClient(config))

  return {
    kind: 'stripe',
    logScope: STRIPE_PROJECTION_LOG_SCOPE,
    maxBodyBytes: STRIPE_WEBHOOK_MAX_BODY_BYTES,
    rateLimitKey: stripeWebhookRateLimitKey,

    // One candidate, no DB read, no tenant. A `ref` segment is never
    // registered, so none is ever accepted.
    resolve: (ctx: GateContext) =>
      Promise.resolve({
        ok: true as const,
        candidates: [{ config: ctx.c.get('billingConfig') ?? null }],
      }),

    isUnconfigured: (holder) => !holder.config?.webhookSigningSecret,
    unconfiguredError: STRIPE_WEBHOOK_NOT_CONFIGURED,

    verify: (holder, raw, ctx) =>
      verifyStripeSignature(
        raw,
        ctx.headers.get(STRIPE_SIGNATURE_HEADER),
        holder.config?.webhookSigningSecret,
      ),

    // Both live in the body — the raw-bytes escape hatch.
    deliveryId: (_ctx, raw) => Promise.resolve(parseEvent(raw)?.id ?? null),
    eventName: (_ctx, raw) => parseEvent(raw)?.type ?? null,

    async dispatch(ctx, holder, event, payload): Promise<DeliveryOutcome> {
      const config = holder.config
      if (!config) return accepted({ scheduled: false, skipped: 'unconfigured' })
      const id = typeof payload.id === 'string' ? payload.id : ''
      const ref = stripeEventRef({ id, type: event }, payload)

      try {
        await enqueueStripeProjection(ctx.db, ref)
      } catch (err) {
        logWarn(
          STRIPE_PROJECTION_LOG_SCOPE,
          `event ${ref.id} (${ref.type}) projection handoff failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        return retryable('projection_handoff_failed')
      }

      // Capture everything the task needs now; nothing reads `ctx.c` later.
      const handles = openTaskDb(ctx.c)
      if (!handles) {
        logWarn(
          STRIPE_PROJECTION_LOG_SCOPE,
          `event ${ref.id} (${ref.type}) handed off; no task database — sweep will project`,
        )
        return accepted({ scheduled: false, deferred: 'database_unavailable' })
      }
      const client = createClient(config)
      const task = async (): Promise<void> => {
        try {
          await projectAndSettleStripeEvent({ db: handles.db, client }, ref)
        } finally {
          await handles.close().catch(() => {})
        }
      }
      if (opts.schedule) opts.schedule(task)
      else runAfterResponse(ctx.c, STRIPE_PROJECTION_LOG_SCOPE, task)
      return accepted({ scheduled: true })
    },
  }
}

export function registerStripeWebhookRoutes(app: Hono<AppEnv>, opts: StripeWebhookRouteOpts): void {
  registerWebhookGate(app, [STRIPE_WEBHOOK_PATH], createStripeGate(opts), {
    runtime: opts.runtime,
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
  })
}
