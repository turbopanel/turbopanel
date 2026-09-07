import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import {
  getDb,
  getDaemonCellRegistry,
  getQueryCache,
  type Db,
} from '../../db.ts'
import { resolveFleetPresence } from '../../daemon/cell/fleet-presence.ts'
import type { ServerFleetPresence } from '../../daemon/cell/server-status.ts'
import {
  buildProjectionsFromDaemonRows,
  loadServerRowsForFleetPresence,
} from '../../daemon/cell/postgres-projection.ts'
import { license, server } from '../../lib/db/schema.ts'
import { redactServerOptions } from '../../lib/db/server-metadata.ts'
import { resolveColocatedServerIdSet } from '../../client/servers/colocated.ts'
import { runApprovedCachedReadModel } from '../cached-query.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'

export type ServerDetailRow = {
  id: string
  name: string | null
  organizationId: string
  licenseId: string | null
  /** Declared `server.machine_class`; null until pinned or inferred physical. */
  machineClass: string | null
  options: typeof server.$inferSelect.options
  createdAt: string
}

export type ServerDetailDisplayPayload = {
  row: ServerDetailRow
  presence: ServerFleetPresence | null
  colocatedWithInstance: boolean
}

/**
 * Approved cached read model: single-server detail display/projection data.
 *
 * **Cached connection (`readDb` / `HYPERDRIVE_CACHED` / Redis):** only statement #1
 * — the detail-row `SELECT` — runs here via `loadCachedDetailRow`. Do not move
 * presence, colocated, or authorization queries onto `readDb`.
 *
 * **Primary connection (`db` / `HYPERDRIVE`):** statement #2 — one shared
 * `loadServerRowsForFleetPresence` SELECT — feeds both `resolveFleetPresence` and
 * org-scoped `resolveColocatedServerIdSet` via preloaded rows/projections.
 *
 * SQL executed (read-only SELECT only; no transactions, mutations, or stable/
 * volatile PostgreSQL functions such as `now()`, `random()`, `nextval()`,
 * `clock_timestamp()`):
 *   1. `SELECT server.id, name, organization_id, license.id, options,
 *      created_at FROM server LEFT JOIN license ON license.server_id = server.id
 *      WHERE server.id = :serverId AND server.organization_id = :organizationId`
 *   2. `SELECT id, daemon, metadata, hostname, machine_key, connected,
 *      status_changed_at FROM server WHERE id IN (:serverIds)`
 *      (shared preload for presence + org-scoped colocated enrichment)
 *
 * Cached SELECT (#1) reads no auth/session/secret columns — only the listed
 * display/projection fields — and contains none of the stable/volatile
 * functions above. Never select `daemon` / auth columns on the cached path.
 * `options` is passed through {@link redactServerOptions} before it is returned
 * (and therefore before it is cached), so a secret-bearing key left on the jsonb
 * by an older control plane never reaches Redis.
 */
async function loadCachedDetailRow(
  readDb: Db,
  organizationId: string,
  serverId: string,
): Promise<ServerDetailRow | null> {
  const [row] = await readDb
    .select({
      id: server.id,
      name: server.name,
      organizationId: server.organizationId,
      licenseId: license.id,
      machineClass: server.machineClass,
      options: server.options,
      createdAt: server.createdAt,
    })
    .from(server)
    .leftJoin(license, eq(license.serverId, server.id))
    .where(
      and(eq(server.id, serverId), eq(server.organizationId, organizationId)),
    )
    .limit(1)

  const detail = row as ServerDetailRow | undefined
  if (!detail) return null
  // Redact before returning, so the cache stores the redacted row (see
  // `REDACTED_SERVER_OPTION_KEYS`).
  return { ...detail, options: redactServerOptions(detail.options) }
}

async function resolveServerDetailEnrichment(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverId: string,
): Promise<Pick<ServerDetailDisplayPayload, 'presence' | 'colocatedWithInstance'>> {
  const rows = await loadServerRowsForFleetPresence(db, [serverId])
  const preloaded = {
    rows,
    projections: buildProjectionsFromDaemonRows(rows),
  }

  const [presenceMap, colocatedIds] = await Promise.all([
    resolveFleetPresence(db, registry, [serverId], { preloaded }),
    resolveColocatedServerIdSet(db, registry, [serverId], {
      orgScoped: true,
      preloaded,
    }),
  ])

  return {
    presence: presenceMap.get(serverId) ?? null,
    colocatedWithInstance: colocatedIds.has(serverId),
  }
}

export async function cachedServerDetailReadModel(
  c: Context,
  opts: {
    organizationId: string
    serverId: string
  },
): Promise<ServerDetailDisplayPayload | null> {
  const db = getDb(c)
  if (!db) {
    throw new Error('Database unavailable')
  }

  const { organizationId, serverId } = opts
  const registry = getDaemonCellRegistry(c)
  const cache = getQueryCache(c)

  const row = await runApprovedCachedReadModel(
    cache,
    db,
    'server-detail',
    [organizationId, serverId],
    (readDb) => loadCachedDetailRow(readDb, organizationId, serverId),
  )

  if (!row) return null

  const enrichment = await resolveServerDetailEnrichment(db, registry, serverId)

  return {
    row,
    ...enrichment,
  }
}
