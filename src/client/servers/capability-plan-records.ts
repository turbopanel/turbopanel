/**
 * Append-only history of resolved v5 metrics-capability-plan generations
 * (`capabilityPlanGeneration` table, see `../../lib/db/schema.ts`) — one row
 * per `(server, generation)`, written lazily whenever a resolved plan is
 * needed — `POST /api/daemon/v1/metrics` (`../../daemon/api-routes.ts`)
 * calls this on every ingest — rather than pushed by a trigger.
 *
 * Unlike `server-topology-records.ts` (which records every daemon-reported
 * generation verbatim), this table only grows on genuine change:
 * {@link recordCapabilityPlanGenerationIfChanged} hashes the resolved plan
 * (`computeMetricsCapabilityPlanHash`) and compares it against the latest
 * recorded hash for the server — an unchanged plan is a no-op, a changed (or
 * first-ever) plan inserts a new row with `generation = previous + 1` (or `0`).
 */
import { desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { capabilityPlanGeneration } from '../../lib/db/schema.ts'
import {
  computeMetricsCapabilityPlanHash,
  type MetricsCapabilityPlanV5,
} from '../../daemon/metrics/capability-plan.ts'

export type CapabilityPlanGenerationRecord = {
  generation: number
  planHash: string
  plan: unknown
  appliedAt: string
}

function serializeRow(
  row: typeof capabilityPlanGeneration.$inferSelect
): CapabilityPlanGenerationRecord {
  return {
    generation: row.generation,
    planHash: row.planHash,
    plan: row.plan,
    appliedAt: row.appliedAt,
  }
}

/** Highest-`generation` row recorded for a server, or `undefined` if none has been recorded yet. */
export async function getLatestCapabilityPlanGeneration(
  db: Db,
  serverId: string
): Promise<CapabilityPlanGenerationRecord | undefined> {
  const rows = await db
    .select()
    .from(capabilityPlanGeneration)
    .where(eq(capabilityPlanGeneration.serverId, serverId))
    .orderBy(desc(capabilityPlanGeneration.generation))
    .limit(1)
  const row = rows[0]
  return row ? serializeRow(row) : undefined
}

/**
 * Resolve the current plan's hash against the latest recorded generation for
 * `serverId`; insert a new generation row only when it differs (or none has
 * ever been recorded). Returns the (possibly unchanged) current generation
 * number.
 *
 * Runs inside a transaction that locks the server's row `FOR UPDATE` first,
 * serializing concurrent resolutions for the same server (mirrors the
 * project-lock pattern in `system/hierarchy.ts`'s `ensureServerEnvironment`).
 * Without this, two callers racing with different resolved plans could both
 * read the same "latest" row, compute the same next `generation`, and have
 * one insert win the `(serverId, generation)` unique constraint while the
 * other silently no-ops via `onConflictDoNothing` — yet both would return
 * that generation number, so the loser's plan would never be the one a
 * later reader of that generation actually sees. The lock means only one
 * transaction can be resolving a given server's next generation at a time,
 * and after inserting we re-read the persisted row to confirm it actually
 * carries our `planHash` before returning the generation, rather than
 * trusting `onConflictDoNothing` alone.
 */
export async function recordCapabilityPlanGenerationIfChanged(
  db: Db,
  serverId: string,
  resolvedPlan: MetricsCapabilityPlanV5
): Promise<number> {
  const planHash = await computeMetricsCapabilityPlanHash(resolvedPlan)

  return await db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT id FROM server WHERE id = ${serverId}::uuid FOR UPDATE
    `)

    const latest = await getLatestCapabilityPlanGeneration(tx, serverId)
    if (latest?.planHash === planHash) {
      return latest.generation
    }

    const generation = latest ? latest.generation + 1 : 0
    const appliedAt = new Date().toISOString()
    await tx
      .insert(capabilityPlanGeneration)
      .values({
        serverId,
        generation,
        planHash,
        plan: resolvedPlan,
        appliedAt,
      })
      .onConflictDoNothing({
        target: [capabilityPlanGeneration.serverId, capabilityPlanGeneration.generation],
      })

    const persisted = await getLatestCapabilityPlanGeneration(tx, serverId)
    if (persisted?.generation !== generation || persisted.planHash !== planHash) {
      throw new Error(
        `capability plan generation ${String(generation)} for server ${serverId} ` +
          'was not persisted with the expected plan hash; conflicting writer under lock'
      )
    }

    return generation
  })
}
