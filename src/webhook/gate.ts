/**
 * The webhook gate: one ordered sequence, written once.
 *
 * Every inbound webhook this instance accepts runs the same six steps in the
 * same order, and the order is not stylistic — three of the steps are security
 * properties:
 *
 *   1. **rate limit** — cheapest, and it is what protects the verification work
 *      below from being spent by an unauthenticated caller;
 *   2. **resolve** — work out *whose* secret this delivery should be checked
 *      against. Selection only; nothing here is trusted yet;
 *   3. **raw bytes** — `c.req.arrayBuffer()`, never `c.req.json()`. A signature
 *      covers the exact bytes the sender sent, and parsing then re-encoding
 *      changes key order and escapes;
 *   4. **verify** — against the resolved holder's own secret;
 *   5. **claim the delivery id** — only now. Claiming before verification would
 *      let an unauthenticated request burn the id a genuine redelivery needs;
 *   6. **parse and dispatch**.
 *
 * Until this module existed, that sequence lived twice — once in the GitHub
 * route and once in GitLab's — with nothing keeping the two in step. A third
 * kind would have been a third copy of the claim/release semantics, which are
 * the easiest part to get subtly and silently wrong.
 *
 * ## The status code is a retry instruction
 *
 * A non-2xx tells the sender "come back". No amount of retrying fixes an
 * unplaced environment or a disarmed source, so an unroutable delivery is logged
 * and answered 2xx. An instance-side fault is the opposite: the event is still
 * actionable and a redelivery is the only thing that can recover it, so those
 * answer `503` **and release the claim** — because the sender retries with the
 * same id, and a claim left behind would turn that retry into a `204` and drop
 * the event with nothing left to recover it from.
 *
 * The JSON the provider sees is deliberately empty of routing detail:
 * accepted deliveries are `{ ok: true }`; retryable faults are `{ error: 'retry' }`.
 * `DeliveryOutcome.result` is logged under {@link WebhookGate.logScope} and
 * never serialized back to GitHub, GitLab, or Stripe.
 *
 * Malformed signed JSON after a successful claim is answered **400** and the
 * claim is kept. Providers retry 5xx, not a body that will never parse;
 * releasing would only let the same bytes occupy the ledger again. Unexpected
 * exceptions after the claim are instance-side faults: the claim is released
 * (best-effort) and the sender is asked to retry with 5xx.
 *
 * ## Adding a kind
 *
 * Implement {@link WebhookGate} and register it. The gate is generic over
 * `THolder` — whatever that kind verifies against — so a kind with no tenant at
 * all (one instance-wide secret) is as expressible as a multi-tenant one:
 * `resolve` just returns a single holder carrying only the secret. `verify`
 * receives the raw bytes and may parse them itself, which is what a sender that
 * signs *fields* rather than the whole body needs, without moving the parse
 * ahead of verification.
 */

import type { Context, Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { getDb, type Db } from '../db.ts'
import { logInfo, logWarn } from '../logger.ts'
import type { RateLimiter } from '../daemon/rate-limit/contracts.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import {
  claimWebhookDelivery,
  releaseWebhookDelivery,
  type WebhookDeliveryProvider,
} from '../lib/db/webhook-delivery-records.ts'
import { resolveClientIp } from '../client/authn/http.ts'
import { readBoundedBodyBytes } from '../lib/http/bounded-body.ts'

/** GitHub honors this on 429; the webhook Redis buckets are 60s windows. */
export const WEBHOOK_RATE_LIMIT_RETRY_AFTER_SECONDS = 60

/** Case-insensitive header access, so an adapter never touches Hono directly. */
export type HeaderReader = { get(name: string): string | null }

/** What a gate step is handed. Everything it may legitimately need, and no more. */
export type GateContext = {
  c: Context<AppEnv>
  db: Db
  dataEncryptionSecrets: DerivedSecretsConfig
  headers: HeaderReader
}

/**
 * Candidates that might own this delivery, best first.
 *
 * A list rather than one row because identity can be ambiguous before
 * verification — a numeric GitHub App id, for instance, is unique per origin
 * rather than globally. The gate tries each in turn and keeps the one whose
 * secret actually verifies.
 */
export type GateResolution<THolder> =
  | { ok: true; candidates: THolder[] }
  | { ok: false; reason: string }

/**
 * What one dispatched delivery decided.
 *
 * A record rather than a bare result because there are two very different kinds
 * of "did nothing", and only one of them should bring the sender back.
 */
export type DeliveryOutcome = {
  /** Instance-side fault: answer 5xx and release the delivery claim. */
  retry: boolean
  result: unknown
}

/** Final: log it and answer 2xx. */
export function accepted(result: unknown): DeliveryOutcome {
  return { retry: false, result }
}

/** This instance could not act; a redelivery could. */
export function retryable(reason: string): DeliveryOutcome {
  return { retry: true, result: { error: reason } }
}

export type WebhookGate<THolder> = {
  /**
   * Ledger key and log prefix.
   *
   * Must be a value `delivery_provider_check` accepts — the claim in step 5
   * writes it.
   */
  kind: WebhookDeliveryProvider
  /** Log namespace, e.g. `git-webhook`. */
  logScope: string
  /**
   * Hard ceiling on an accepted body.
   *
   * The bytes are buffered in memory *before* the caller has authenticated, so
   * this is what stops a hostile sender making the instance hold an arbitrary
   * buffer.
   */
  maxBodyBytes: number
  /** Per-peer bucket. The caller has no identity until step 4 succeeds. */
  rateLimitKey(peer: string): string
  /** Step 2. Selection only — nothing returned here is trusted. */
  resolve(ctx: GateContext, ref: string | null): Promise<GateResolution<THolder>>
  /** True when this holder has no secret configured — a gap on our side, not a rejection. */
  isUnconfigured(holder: THolder): boolean
  /** Answered when every candidate is unconfigured. */
  unconfiguredError: string
  /** Step 4. */
  verify(holder: THolder, raw: Uint8Array, ctx: GateContext): Promise<boolean>
  /** Stable id for the replay ledger. `null` rejects the delivery as malformed. */
  deliveryId(ctx: GateContext, raw: Uint8Array): Promise<string | null>
  /**
   * Ledger label. `null` rejects the delivery as malformed.
   *
   * Takes the raw bytes rather than a parsed payload so this stays *before* the
   * claim, preserving the original ordering. A kind whose event name lives in
   * the body may parse `raw` itself — the same escape hatch {@link verify} uses.
   */
  eventName(ctx: GateContext, raw: Uint8Array): string | null
  /** Step 6. */
  dispatch(
    ctx: GateContext,
    holder: THolder,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<DeliveryOutcome>
}

export type WebhookGateOpts = {
  /** Runtime, for trusted client-IP resolution. */
  runtime: 'deno' | 'workers'
  rateLimiter?: RateLimiter
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePayload(raw: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Pick the candidate whose secret actually verifies the delivery.
 *
 * Candidates with no configured secret are skipped rather than treated as a
 * pass — the difference between "not set up" and "authenticated" is the whole
 * point of the step.
 */
async function selectVerified<THolder>(
  gate: WebhookGate<THolder>,
  candidates: THolder[],
  raw: Uint8Array,
  ctx: GateContext,
): Promise<THolder | null> {
  for (const candidate of candidates) {
    if (gate.isUnconfigured(candidate)) continue
    if (await gate.verify(candidate, raw, ctx)) return candidate
  }
  return null
}

/**
 * Step 1. The cheapest check, and the one that keeps an unauthenticated caller
 * from spending the verification work below.
 */
async function withinRateLimit<THolder>(
  gate: WebhookGate<THolder>,
  opts: WebhookGateOpts,
  c: Context<AppEnv>,
): Promise<boolean> {
  if (!opts.rateLimiter) return true
  const peer = resolveClientIp(c, opts.runtime) ?? 'unknown'
  const { success } = await opts.rateLimiter.limit({
    key: gate.rateLimitKey(peer),
  })
  return success
}

/**
 * Step 3. The exact bytes the sender sent, never `c.req.json()` — a signature
 * covers the bytes, and parsing then re-encoding changes key order and escapes.
 *
 * `null` is over the ceiling. `content-length` is checked first so a body that
 * declares itself oversized is refused before any read, and — because that
 * header is the sender's claim rather than a fact — the shared streaming
 * reader (`src/lib/http/bounded-body.ts`) aborts as soon as the accumulated
 * byte count crosses `maxBodyBytes`, so a chunked-encoded upload with no (or a
 * lying) `Content-Length` is never fully buffered either.
 */
async function readRawBody(
  c: Context<AppEnv>,
  maxBodyBytes: number,
): Promise<Uint8Array | null> {
  const read = await readBoundedBodyBytes(c, maxBodyBytes)
  if (!read.ok) return null
  return read.bytes
}

async function releaseClaimBestEffort<THolder>(
  gate: WebhookGate<THolder>,
  db: Db,
  deliveryId: string,
): Promise<void> {
  try {
    await releaseWebhookDelivery(db, {
      provider: gate.kind,
      externalDeliveryId: deliveryId,
    })
  } catch (err) {
    logWarn(
      gate.logScope,
      `failed to release delivery ${deliveryId}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Step 6 after a successful claim. Malformed JSON stays claimed (400).
 * Retryable outcomes and unexpected throws release, then answer 5xx with
 * no internal result body.
 */
async function dispatchClaimedDelivery<THolder>(
  c: Context<AppEnv>,
  gate: WebhookGate<THolder>,
  ctx: GateContext,
  holder: THolder,
  deliveryId: string,
  event: string,
  raw: Uint8Array,
): Promise<Response> {
  try {
    const payload = parsePayload(raw)
    if (!payload) return c.json({ error: 'Invalid request' }, 400)

    const outcome = await gate.dispatch(ctx, holder, event, payload)
    if (outcome.retry) {
      await releaseWebhookDelivery(ctx.db, {
        provider: gate.kind,
        externalDeliveryId: deliveryId,
      })
      logWarn(
        gate.logScope,
        `delivery ${deliveryId} (${event}) could not be acted on; asking for a retry`,
        JSON.stringify(outcome.result),
      )
      return c.json({ error: 'retry' }, 503)
    }
    logInfo(
      gate.logScope,
      `delivery ${deliveryId} (${event}) accepted`,
      JSON.stringify(outcome.result),
    )
    return c.json({ ok: true as const })
  } catch (err) {
    await releaseClaimBestEffort(gate, ctx.db, deliveryId)
    logWarn(
      gate.logScope,
      `delivery ${deliveryId} (${event}) threw after claim; asking for a retry: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return c.json({ error: 'retry' }, 503)
  }
}

/**
 * Mount one gate on every path it answers.
 *
 * Flat `app.post` registrations against the absolute paths in
 * `src/surfaces.ts`, rather than a child router mounted at the prefix — two
 * gates share `/webhook`, and a child would be one more object to thread
 * through `registerWebhookRoutes` for no behaviour.
 *
 * No `.use('*')`: `/webhook` must stay out of every protected prefix
 * (`src/browser-write-protection.ts`). Session middleware would reject every
 * delivery, and the caller sends no `Origin` for the cross-origin gate to read.
 */
export function registerWebhookGate<THolder>(
  app: Hono<AppEnv>,
  paths: readonly string[],
  gate: WebhookGate<THolder>,
  opts: WebhookGateOpts,
): void {
  const handler = async (c: Context<AppEnv>) => {
    // 1. Rate limit first — it is what protects the verification work below.
    if (!(await withinRateLimit(gate, opts, c))) {
      c.header('Retry-After', String(WEBHOOK_RATE_LIMIT_RETRY_AFTER_SECONDS))
      return c.json({ error: 'Too many requests' }, 429)
    }

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const ctx: GateContext = {
      c,
      db,
      dataEncryptionSecrets,
      headers: { get: (name: string) => c.req.header(name) ?? null },
    }

    // 2. Whose delivery is this? Selection only.
    const ref = c.req.param('ref')?.trim() || null
    const resolution = await gate.resolve(ctx, ref)
    if (!resolution.ok) {
      logWarn(gate.logScope, `rejected delivery: ${resolution.reason}`)
      return c.json({ error: 'Unauthorized' }, 401)
    }
    if (resolution.candidates.every((holder) => gate.isUnconfigured(holder))) {
      // Nothing to verify against. 503, not 401: refuse rather than accept an
      // unauthenticated delivery, but say the gap is on this side.
      return c.json({ error: gate.unconfiguredError }, 503)
    }

    // 3. Raw bytes, before any parse.
    const raw = await readRawBody(c, gate.maxBodyBytes)
    if (!raw) return c.json({ error: 'Payload too large' }, 413)

    // 4. Verify against the resolved holder's own secret.
    const holder = await selectVerified(gate, resolution.candidates, raw, ctx)
    if (!holder) {
      logWarn(gate.logScope, 'rejected delivery with an invalid credential')
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const deliveryId = await gate.deliveryId(ctx, raw)
    if (!deliveryId) return c.json({ error: 'Invalid request' }, 400)

    const event = gate.eventName(ctx, raw)
    if (!event) return c.json({ error: 'Invalid request' }, 400)

    // 5. Claim the delivery. A redelivery of work already done answers 204
    //    without re-running it.
    const claimed = await claimWebhookDelivery(db, {
      provider: gate.kind,
      externalDeliveryId: deliveryId,
      event,
    })
    if (!claimed) {
      logInfo(gate.logScope, `duplicate delivery ${deliveryId} (${event}) ignored`)
      return c.body(null, 204)
    }

    // 6. Parse and act. Unexpected throws after the claim must release so
    //    the provider's retry is not answered 204.
    return await dispatchClaimedDelivery(c, gate, ctx, holder, deliveryId, event, raw)
  }

  for (const path of paths) app.post(path, handler)
}
