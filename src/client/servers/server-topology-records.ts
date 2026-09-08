/**
 * Append-only history of daemon-reported topology generations
 * (`topologyGeneration` table, see `../../lib/db/schema.ts`) — one row per
 * `(server, generation)`, meant to be written when the daemon's
 * fire-and-forget `topology-report` cell message lands (see
 * `../../daemon/cell/protocol.ts`) and never mutated in place afterward.
 *
 * Keeping every generation (not just the latest) is what lets a later phase
 * answer "what did this server's topology look like at generation N" for
 * historical-metrics query reconstruction — segmenting charts by the
 * topology layout that was active when a sample was recorded, the same way
 * `hardwareProfileGeneration` segments by sensor/NIC layout today.
 *
 * No pruning/retention logic yet: this table grows without bound as servers
 * report new generations. NEXT STEP: add a bounded retention sweep (mirroring
 * `sweepExpiredWebhookDeliveries` / `sweepExpiredCommandDispatch`) once real
 * growth and the "how far back do we ever query" answer are understood.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { topologyGeneration } from '../../lib/db/schema.ts'
import type { TopologyLayoutPaths } from './topology-types.ts'

export type TopologyGenerationRecord = {
  generation: number
  bootGeneration: number
  snapshot: unknown
  appliedAt: string
}

/** Parameters for {@link recordTopologyGeneration} — the daemon's own report, verbatim. */
export type TopologyGenerationReport = {
  generation: number
  bootGeneration: number
  /** The daemon-reported topology object, stored as-is — never a wrapper around it. */
  snapshot: unknown
  /** The daemon's own report timestamp (`topology-report.at`) — never a control-plane receipt time. */
  appliedAt: string
}

function serializeRow(row: typeof topologyGeneration.$inferSelect): TopologyGenerationRecord {
  return {
    generation: row.generation,
    bootGeneration: row.bootGeneration,
    snapshot: row.snapshot,
    appliedAt: row.appliedAt,
  }
}

/**
 * Record one topology generation. Safe against the daemon resending an
 * unchanged generation on reconnect — `(server_id, generation)` is unique
 * (`uniq_generation_server_generation`), so a repeat insert for a
 * generation already recorded is a silent no-op rather than a duplicate row
 * or a thrown constraint error.
 */
export async function recordTopologyGeneration(
  db: Db,
  serverId: string,
  report: TopologyGenerationReport
): Promise<void> {
  await db
    .insert(topologyGeneration)
    .values({
      serverId,
      generation: report.generation,
      bootGeneration: report.bootGeneration,
      snapshot: report.snapshot,
      appliedAt: report.appliedAt,
    })
    .onConflictDoNothing({
      target: [topologyGeneration.serverId, topologyGeneration.generation],
    })
}

/** Highest-`generation` row recorded for a server, or `undefined` if none has been reported yet. */
export async function getLatestTopologyGeneration(
  db: Db,
  serverId: string
): Promise<TopologyGenerationRecord | undefined> {
  const rows = await db
    .select()
    .from(topologyGeneration)
    .where(eq(topologyGeneration.serverId, serverId))
    .orderBy(desc(topologyGeneration.generation))
    .limit(1)
  const row = rows[0]
  return row ? serializeRow(row) : undefined
}

/**
 * Highest-`generation` row recorded for each of `serverIds`, in one query —
 * the batched analogue of {@link getLatestTopologyGeneration} for routes that
 * must stay O(1) in the number of servers (e.g. `/servers/metrics/latest`'s
 * fleet snapshot — see `AGENTS.md`'s fleet-read invariant). A server with no
 * recorded generation is simply absent from the returned map rather than
 * mapped to `undefined`, so callers can use `.has()` /  `.get()` directly.
 */
export async function getLatestTopologyGenerations(
  db: Db,
  serverIds: readonly string[]
): Promise<Map<string, TopologyGenerationRecord>> {
  if (serverIds.length === 0) return new Map()
  const idList = sql.join(
    serverIds.map((id) => sql`${id}::uuid`),
    sql`, `
  )
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (server_id) server_id, generation, boot_generation, snapshot, applied_at
    FROM generation
    WHERE server_id IN (${idList})
    ORDER BY server_id, generation DESC
  `)) as unknown as Array<{
    server_id: string
    generation: number
    boot_generation: number
    snapshot: unknown
    applied_at: string
  }>

  const out = new Map<string, TopologyGenerationRecord>()
  for (const row of rows) {
    out.set(row.server_id, {
      generation: row.generation,
      bootGeneration: row.boot_generation,
      snapshot: row.snapshot,
      appliedAt: row.applied_at,
    })
  }
  return out
}

/**
 * Stamp `server.metadata.topologyResyncRequestedAt` — the durable signal
 * that `POST /api/daemon/v1/metrics` emits (see `api-routes.ts`) when a
 * sample's `metadata.topologyGeneration` has never been recorded via
 * {@link recordTopologyGeneration}. Ingest must never wake the Durable
 * Object to ask the daemon for a fresh `topology-report` directly, so this
 * marker is the hand-off point: a later phase's sweep reads it from a safe,
 * non-DO context and pushes the actual re-sync request to the connected
 * daemon cell.
 *
 * `jsonb_set` only the one key — a full metadata read-modify-write here
 * could stomp a concurrent write to an unrelated `metadata` field from
 * another request.
 */
export async function markTopologyResyncRequested(db: Db, serverId: string): Promise<void> {
  await db.execute(sql`
    UPDATE server
    SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{topologyResyncRequestedAt}',
      ${JSON.stringify(new Date().toISOString())}::jsonb
    )
    WHERE id = ${serverId}::uuid
  `)
}

/** The specific historical generation row for a server, or `undefined` if it was never recorded. */
export async function getTopologyGeneration(
  db: Db,
  serverId: string,
  generation: number
): Promise<TopologyGenerationRecord | undefined> {
  const rows = await db
    .select()
    .from(topologyGeneration)
    .where(
      and(eq(topologyGeneration.serverId, serverId), eq(topologyGeneration.generation, generation))
    )
    .limit(1)
  const row = rows[0]
  return row ? serializeRow(row) : undefined
}

/**
 * Several historical generations at once, keyed by generation number.
 *
 * This is the "what did this server's topology look like at generation N"
 * lookup this table exists for (see the module doc comment). A metrics range
 * can span a RAM upgrade or a volume resize, and capacity totals are the
 * denominator of every derived percentage — resolving them from the *latest*
 * generation would silently restate history against today's hardware.
 *
 * Generations absent from the table are simply missing from the map; callers
 * fall back to the latest context rather than failing the query, since a
 * server that reported metrics before its first `topology-report` landed has
 * samples with no recorded generation at all.
 */
export async function getTopologyGenerations(
  db: Db,
  serverId: string,
  generations: readonly number[]
): Promise<Map<number, TopologyGenerationRecord>> {
  const wanted = [...new Set(generations.filter((g) => Number.isInteger(g) && g >= 0))]
  if (wanted.length === 0) return new Map()
  const rows = await db
    .select()
    .from(topologyGeneration)
    .where(
      and(eq(topologyGeneration.serverId, serverId), inArray(topologyGeneration.generation, wanted))
    )
  return new Map(rows.map((row) => [row.generation, serializeRow(row)]))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * The host layout paths a v6 daemon reports on its topology snapshot
 * (`snapshot.paths`), or `null` for a snapshot recorded by an older daemon
 * or a malformed one. Read-only facts: the daemon takes them from its own
 * environment (`TURBOPANEL_BACKUP_DIR`), so nothing on the control plane
 * can set them.
 */
export function layoutPathsFromSnapshot(snapshot: unknown): TopologyLayoutPaths | null {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return null
  const paths = (snapshot as Record<string, unknown>).paths
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) return null
  const { backup, logs } = paths as Record<string, unknown>
  if (!nonEmptyString(backup) || !nonEmptyString(logs)) return null
  return { backup, logs }
}

/**
 * Latest reported layout paths per server, for the server DTOs. One
 * `DISTINCT ON` query over the generation table; servers with no topology
 * yet (or a pre-v6 daemon) are simply absent from the map.
 */
export async function loadServerLayoutPaths(
  db: Db,
  serverIds: readonly string[]
): Promise<Map<string, TopologyLayoutPaths>> {
  const out = new Map<string, TopologyLayoutPaths>()
  const latest = await getLatestTopologyGenerations(db, serverIds)
  for (const [serverId, record] of latest) {
    const paths = layoutPathsFromSnapshot(record.snapshot)
    if (paths) out.set(serverId, paths)
  }
  return out
}
