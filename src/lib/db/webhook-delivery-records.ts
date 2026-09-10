/**
 * Replay protection for inbound provider webhooks (`delivery` table).
 *
 * Providers redeliver: GitHub retries anything that did not answer 2xx, GitLab
 * offers a resend button on every hook, Stripe retries for days and delivers
 * at-least-once, and an operator can replay a delivery by hand from any of
 * them. A redelivered `push` must not enqueue a second deploy, so the delivery
 * id is claimed **once** — the first request through wins, every later one is
 * told the work is already done.
 *
 * The claim is a single `INSERT … ON CONFLICT DO NOTHING`, so two isolates
 * racing the same delivery resolve at the unique index rather than in
 * application code (`uniq_delivery_provider_external`). No row is written until
 * the signature has been verified, so an unsigned request cannot poison the
 * ledger against a genuine redelivery of the same id.
 *
 * Rows carry no secret. Stripe rows may hold the minimal object ref used to
 * retry projection after a crash — see the `webhookDelivery` comment in
 * `./schema.ts`.
 */

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { webhookDelivery } from './schema.ts'

/**
 * Minimal Stripe event identity stored on the claimed delivery row so the
 * maintenance sweep can call `projectStripeEvent` without the original body.
 * Shape matches `StripeEventRef` in `src/webhook/billing/stripe-projection.ts`
 * without importing that module from `src/lib/db/`.
 */
export type StripeProjectionTask = {
  id: string
  type: string
  objectId: string | null
  objectType: string | null
}

/** Bounded Stripe projection retries per maintenance tick. */
export const STRIPE_PROJECTION_RETRY_LIMIT = 50

/**
 * Kinds that deliver webhooks. Matches `delivery_provider_check` in
 * `./schema.ts`; generic-SSH sources have no ingress surface and never appear.
 *
 * Its own literal union rather than an alias of `WebhookGitProviderName`: the
 * ledger stopped being git-shaped when Stripe landed, and aliasing it was
 * `src/lib/db/`'s only dependency on `src/lib/git/`. The git names must stay
 * assignable to it — `webhook-delivery-records.hostfree.test.ts` pins that.
 */
export type WebhookDeliveryProvider = 'github' | 'gitlab' | 'stripe'

/**
 * How long a claimed delivery id is remembered. Every provider gives up
 * retrying a delivery well inside this window, so anything older can no longer
 * arrive again as a retry — only as a deliberate manual replay, which should
 * run.
 */
export const WEBHOOK_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Bounded per maintenance tick — cleanup must never dominate the sweep. */
export const WEBHOOK_DELIVERY_SWEEP_LIMIT = 500

/**
 * Claim one provider delivery id.
 *
 * Returns `true` when this caller is the first to see it (proceed with the
 * side effects), `false` when it was already claimed (answer 2xx and stop).
 */
export async function claimWebhookDelivery(
  db: Db,
  params: {
    provider: WebhookDeliveryProvider
    externalDeliveryId: string
    event?: string | null
  },
): Promise<boolean> {
  const claimed = await db
    .insert(webhookDelivery)
    .values({
      provider: params.provider,
      externalDeliveryId: params.externalDeliveryId,
      event: params.event ?? null,
    })
    .onConflictDoNothing({
      target: [webhookDelivery.provider, webhookDelivery.externalDeliveryId],
    })
    .returning({ id: webhookDelivery.id })

  return claimed.length > 0
}

/**
 * Hand a claimed delivery id back.
 *
 * The claim is what makes a redelivery a no-op, and that is exactly wrong when
 * the delivery is about to be answered 5xx: the provider retries with the
 * *same* delivery id, so a claim left behind would turn the retry into a `204`
 * and the commit would be lost for good. Releasing is therefore part of
 * answering "retry me", not an alternative to it — callers that answer 2xx must
 * never release, or a genuine redelivery would enqueue a second deploy.
 */
export async function releaseWebhookDelivery(
  db: Db,
  params: { provider: WebhookDeliveryProvider; externalDeliveryId: string },
): Promise<void> {
  await db
    .delete(webhookDelivery)
    .where(
      and(
        eq(webhookDelivery.provider, params.provider),
        eq(webhookDelivery.externalDeliveryId, params.externalDeliveryId),
      ),
    )
}

/**
 * Persist the Stripe object ref on the already-claimed delivery row.
 *
 * This is the durable handoff: a 2xx to Stripe is only honest after this
 * update succeeds. Zero rows means the claim is missing — treat as failure
 * so the gate can release and ask Stripe to retry. Always clears
 * `projectedAt` so a late handoff after a mistaken settle stays retryable.
 */
export async function enqueueStripeProjection(
  db: Db,
  task: StripeProjectionTask,
): Promise<void> {
  const updated = await db
    .update(webhookDelivery)
    .set({
      event: task.type,
      objectId: task.objectId,
      objectType: task.objectType,
      projectedAt: null,
    })
    .where(
      and(
        eq(webhookDelivery.provider, 'stripe'),
        eq(webhookDelivery.externalDeliveryId, task.id),
      ),
    )
    .returning({ id: webhookDelivery.id })

  if (updated.length === 0) {
    throw new Error(`stripe projection handoff missed delivery ${task.id}`)
  }
}

/**
 * Oldest unsettled Stripe projection tasks whose object-ref handoff is
 * complete, newest last. A claimed row with no `objectId` is still mid-gate
 * and must not be settled. Bounded so one tick cannot scan the whole ledger.
 */
export async function listPendingStripeProjections(
  db: Db,
  opts: { limit?: number } = {},
): Promise<StripeProjectionTask[]> {
  const limit = Math.min(
    Math.max(Math.trunc(opts.limit ?? STRIPE_PROJECTION_RETRY_LIMIT), 1),
    2000,
  )
  const rows = await db
    .select({
      id: webhookDelivery.externalDeliveryId,
      type: webhookDelivery.event,
      objectId: webhookDelivery.objectId,
      objectType: webhookDelivery.objectType,
    })
    .from(webhookDelivery)
    .where(
      and(
        eq(webhookDelivery.provider, 'stripe'),
        isNull(webhookDelivery.projectedAt),
        isNotNull(webhookDelivery.objectId),
      ),
    )
    .orderBy(webhookDelivery.createdAt)
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    type: row.type ?? '',
    objectId: row.objectId,
    objectType: row.objectType,
  }))
}

/** Mark one Stripe delivery's projection as settled so the sweep will not retry it. */
export async function completeStripeProjection(
  db: Db,
  eventId: string,
  now: string,
): Promise<void> {
  await db
    .update(webhookDelivery)
    .set({ projectedAt: now })
    .where(
      and(
        eq(webhookDelivery.provider, 'stripe'),
        eq(webhookDelivery.externalDeliveryId, eventId),
      ),
    )
}

/**
 * Bounded delete of delivery rows past {@link WEBHOOK_DELIVERY_RETENTION_MS}.
 * Returns the number of rows removed (tracing only).
 *
 * Same shape as `sweepExpiredCommandDispatch`: pick the oldest expired ids in a
 * subquery, delete those, so one tick can never scan the whole table.
 * Unsettled Stripe projection rows are excluded — a 2xx already told Stripe
 * not to retry, so dropping them would lose entitlement with nothing left to
 * recover it from.
 */
export async function sweepExpiredWebhookDeliveries(
  db: Db,
  opts: { limit: number; now?: string; retentionMs?: number },
): Promise<number> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), 2000)
  const retentionMs = opts.retentionMs ?? WEBHOOK_DELIVERY_RETENTION_MS
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now()
  const cutoff = new Date(nowMs - retentionMs).toISOString()

  const deleted = await db
    .delete(webhookDelivery)
    .where(
      sql`${webhookDelivery.id} in (
        select id from ${webhookDelivery}
        where created_at < ${cutoff}::timestamptz
          and not (provider = 'stripe' and projected_at is null)
        order by created_at
        limit ${limit}
      )`,
    )
    .returning({ id: webhookDelivery.id })

  return deleted.length
}
