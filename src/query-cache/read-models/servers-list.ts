import type { Context } from 'hono'
import { eq, inArray } from 'drizzle-orm'
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

export type ServersListRow = {
  id: string
  name: string | null
  organizationId: string
  licenseId: string | null
  /** Declared `server.machine_class`; null until pinned or inferred physical. */
  machineClass: string | null
  options: typeof server.$inferSelect.options
  createdAt: string
}

export type ServersListDisplayPayload = {
  rows: ServersListRow[]
  presence: ServerFleetPresence[]
  colocatedIds: string[]
}

/**
 * Approved cached read model: servers tab list display/projection data.
 *
 * **Cached connection (`readDb` / `HYPERDRIVE_CACHED` / Redis):** only statement #1
 * — the list-rows `SELECT` — runs here via `loadCachedListRows`. Do not move
 * presence, colocated, or authorization queries onto `readDb`.
 *
 * **Primary connection (`db` / `HYPERDRIVE`):** statement #2 — one shared
 * `loadServerRowsForFleetPresence` SELECT — feeds both `resolveFleetPresence` and
 * org-scoped `resolveColocatedServerIdSet` via preloaded rows/projections
 * (`resolveServersListEnrichment` / `buildProjectionsFromDaemonRows`).
 *
 * SQL executed (read-only SELECT only; no transactions, mutations, or stable/
 * volatile PostgreSQL functions such as `now()`, `random()`, `nextval()`,
 * `clock_timestamp()`):
 *   1. `SELECT server.id, name, organization_id, license.id, machine_class,
 *      options, created_at FROM server LEFT JOIN license ON
 *      license.server_id = server.id WHERE server.id IN (:visibleIds)
 *      ORDER BY created_at`
 *   2. `SELECT id, daemon, metadata, hostname, machine_key, connected,
 *      status_changed_at FROM server WHERE id IN (:serverIds)`
 *      (shared preload for presence + org-scoped colocated enrichment)
 *
 * Cached SELECT (#1) reads no auth/session/secret columns — only the listed
 * display/projection fields — and contains none of the stable/volatile
 * functions above. `options` is passed through {@link redactServerOptions}
 * before it is returned (and therefore before it is cached), so a secret-bearing
 * key left on the jsonb by an older control plane never reaches Redis.
 */
async function loadCachedListRows(
  readDb: Db,
  visibleIds: string[],
): Promise<ServersListRow[]> {
  if (visibleIds.length === 0) {
    return []
  }

  const rows = await readDb
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
    .where(inArray(server.id, visibleIds))
    .orderBy(server.createdAt)

  // Redact before returning, so the cache stores the redacted rows: what goes
  // into Redis is what goes to the client, and neither ever holds a
  // secret-bearing `options` key (see `REDACTED_SERVER_OPTION_KEYS`).
  return (rows as ServersListRow[]).map((row) => ({
    ...row,
    options: redactServerOptions(row.options),
  }))
}

async function resolveServersListEnrichment(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverIds: string[],
): Promise<Pick<ServersListDisplayPayload, 'presence' | 'colocatedIds'>> {
  const rows = await loadServerRowsForFleetPresence(db, serverIds)
  const preloaded = {
    rows,
    projections: buildProjectionsFromDaemonRows(rows),
  }

  const [presenceMap, colocatedIds] = await Promise.all([
    resolveFleetPresence(db, registry, serverIds, { preloaded }),
    resolveColocatedServerIdSet(db, registry, serverIds, {
      orgScoped: true,
      preloaded,
    }),
  ])

  return {
    presence: [...presenceMap.values()],
    colocatedIds: [...colocatedIds],
  }
}

export async function cachedServersListReadModel(
  c: Context,
  opts: {
    userId: string
    organizationId: string
    visibleIds: string[]
  },
): Promise<ServersListDisplayPayload> {
  const db = getDb(c)
  if (!db) {
    throw new Error('Database unavailable')
  }

  const { organizationId, visibleIds } = opts
  // Canonical order for both the cache key and the cached IN (...) query.
  const sortedVisibleIds = [...visibleIds].sort((a, b) => a.localeCompare(b))
  const visibleIdsKey = sortedVisibleIds.join(',')
  const registry = getDaemonCellRegistry(c)
  const cache = getQueryCache(c)

  const rows = await runApprovedCachedReadModel(
    cache,
    db,
    'servers-list',
    [organizationId, visibleIdsKey],
    (readDb) => loadCachedListRows(readDb, sortedVisibleIds),
  )

  if (rows.length === 0) {
    return { rows: [], presence: [], colocatedIds: [] }
  }

  const serverIds = rows.map((row) => row.id)
  const enrichment = await resolveServersListEnrichment(db, registry, serverIds)

  return {
    rows,
    ...enrichment,
  }
}
