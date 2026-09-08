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
 * Rows carry no payload and no secret — see the `webhookDelivery` comment in
 * `./schema.ts`.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { webhookDelivery } from './schema.ts'

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
 * Bounded delete of delivery rows past {@link WEBHOOK_DELIVERY_RETENTION_MS}.
 * Returns the number of rows removed (tracing only).
 *
 * Same shape as `sweepExpiredCommandDispatch`: pick the oldest expired ids in a
 * subquery, delete those, so one tick can never scan the whole table.
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
        order by created_at
        limit ${limit}
      )`,
    )
    .returning({ id: webhookDelivery.id })

  return deleted.length
}
