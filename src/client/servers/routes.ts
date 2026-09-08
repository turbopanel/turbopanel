import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { isAdminRole } from '../authn/session-store.ts'
import { can, listVisible } from '../authz/index.ts'
import {
  assertCanManageOr403,
  assertCanReadOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import { getDb, getDaemonCellRegistry, type Db } from '../../db.ts'
import { parseOrganizationOptions } from '../../lib/organization-options.ts'
import { parseDatacenterOptions } from '../../lib/datacenter-options.ts'
import {
  parseServerOptions,
  redactServerOptions,
  type ServerOptions,
} from '../../lib/db/server-metadata.ts'
import { metricsDeploymentKindForRuntime } from '../../daemon/metrics/capability-plan.ts'
import { loadTierPlacementsForServers } from '../../lib/tiers/tier-enforcement.ts'
import { loadServerLayoutPaths } from './server-topology-records.ts'
import { isActiveContainerStatus } from '../../lib/db/project-delete.ts'
import { cachedServerDetailReadModel } from '../../query-cache/read-models/server-detail.ts'
import { listServerLabels } from '../../lib/db/label-records.ts'
import {
  fetchDaemonServerCell,
} from '../../daemon/cell/server-diagnostics.ts'
import { resolveFleetPresence } from '../../daemon/cell/fleet-presence.ts'
import { readProjectionsForServers } from '../../daemon/cell/postgres-projection.ts'
import {
  onDaemonUpdateQueued,
  onDaemonUpdateReset,
  onDaemonUpdateResult,
  onDaemonUpdateExpired,
  repairStaleProjectedUpdate,
} from '../../daemon/cell/control-plane-monitor.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import type { UpdateProjection } from '../../daemon/authn/daemon-state.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../../daemon/cell/protocol.ts'
import { clearServerDaemonState } from '../../daemon/authn/server-identity-db.ts'
import {
  container,
  organization,
  server,
  license,
  datacenter,
  service,
} from '../../lib/db/schema.ts'
import { resolveTrunkManifest } from '../../lib/update/manifest.ts'
import { getServerUpdatePreparer } from '../../lib/update/prepare.ts'
import { revokeLicense } from '../authn/license.ts'
import { compatLogWarn } from '../../log-compat.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'
import * as systemHierarchy from '../system/hierarchy.ts'
import { enqueueSystemReconcile } from '../system/reconcile.ts'
import type { SystemReconcileAction } from '../../lib/commands/schemas.ts'
import { assertDispatchInfrastructure } from './command-dispatch.ts'
import { deleteServerFabricMembership } from '../../lib/db/fabric-records.ts'
import { reconcileFabricMembership } from '../../lib/fabric/enqueue.ts'
import {
  colocatedServerDeleteBlockedReason,
  listServerDeleteBlockers,
  serverDeleteBlockersResponse,
} from './delete-guards.ts'
import {
  hasActiveColocatedLicenseBinding,
  resolveColocatedServerIdSet,
} from './colocated.ts'
import {
  colocatedServerUpdateBlockedReason,
  isStaleProjectedUpdating,
  loadServerStatusRecords,
  resolveServerUpdateStatus,
  type ServerUpdateCommit,
} from './update-status.ts'
import { UPDATE_REQUEST_TTL_MS } from '../../lib/update/constants.ts'
import { registerServerCommandRoutes } from './commands-routes.ts'
import { registerServerMetricsRoutes } from './metrics-routes.ts'
import { registerServerLabelRoutes } from './labels-routes.ts'
import { cachedServersListReadModel } from '../../query-cache/read-models/servers-list.ts'
import {
  UPDATE_CHANNEL,
  STATUS_CACHE_CONTROL,
  STATUS_CACHE_MAX_AGE_MS,
  buildBatchStatusCoalesceKey,
  expiredBatchStatusCoalesceKeys,
  currentCommitFromDaemonBuild,
  parseServerPatchCore,
  isHostingEnableTransition,
  isHostingDisableTransition,
  hostingHierarchyFailedBody,
  serverDeletedPayload,
  queueServerUpdateHttpStatus,
  emptyServersUpdatesPayload,
  resolveTrunkTargetFields,
  resolveBatchUpdateEligibility,
  runPreparedServerUpdate,
  updateResetErrorStatus,
  distinctNonEmptyIds,
  errorMessageFromUnknown,
  resolveServerTimezoneFields,
  resolveServerHostDefaultsFields,
  shapeServerDatacenters,
  shapeServerPresenceFields,
  shouldSkipProjectedUpdateRepair,
  repairedUpdateDoneProjection,
  repairedUpdateIdleProjection,
  type ServerPatchFields,
} from './routes-helpers.ts'
import {
  loadDatacenterDisplayNames,
  loadDatacenterMembershipsForServers,
} from '../../lib/net/datacenter-membership.ts'

const UPDATE_REQUEST_TTL_SECONDS = 300

type BatchStatusPayload = {
  servers: Awaited<ReturnType<typeof loadServerStatusRecords>>
}

type BatchStatusCoalesceEntry = {
  expiresAt: number
  promise?: Promise<BatchStatusPayload>
  result?: BatchStatusPayload
}

const batchStatusCoalesce = new Map<string, BatchStatusCoalesceEntry>()

function evictExpiredBatchStatusEntries(now = Date.now()): void {
  for (const key of expiredBatchStatusCoalesceKeys(batchStatusCoalesce, now)) {
    batchStatusCoalesce.delete(key)
  }
}

type QueuedUpdateResult = {
  ok: true
  queued: true
  status: 'updating'
  serverId: string
  requestId: string
  channel: typeof UPDATE_CHANNEL
}

type QueueUpdateFailure = {
  ok: false
  error: string
}

async function queueServerUpdate(
  registry: DaemonCellRegistry,
  db: Db,
  serverId: string,
): Promise<QueuedUpdateResult | QueueUpdateFailure> {
  const presence = await resolveFleetPresence(db, registry, [serverId])
  const live = presence.get(serverId)
  if (!live?.connected) {
    return { ok: false, error: 'Daemon not connected' }
  }
  const colocatedIds = await resolveColocatedServerIdSet(db, registry, [serverId])
  if (colocatedIds.has(serverId)) {
    return { ok: false, error: colocatedServerUpdateBlockedReason() }
  }

  const requestId = generateRequestId()
  const envelope: DaemonOutboundEnvelope = {
    kind: 'update',
    deliveryId: generateDeliveryId(),
    requestId,
    at: new Date().toISOString(),
    channel: UPDATE_CHANNEL,
  }

  const preparer = getServerUpdatePreparer()
  if (preparer) {
    // Dev-only: rebuild the local daemon overlay before releasing the
    // envelope. Mark the projection as updating now so the UI polls through
    // the build; the envelope enqueues when the (single-flight) build lands.
    await onDaemonUpdateQueued(db, serverId, requestId, UPDATE_CHANNEL, envelope.at)
    void runPreparedServerUpdate({
      prepare: preparer,
      enqueue: async () => {
        await registry.getCell(serverId).enqueue(envelope, {
          ttlSeconds: UPDATE_REQUEST_TTL_SECONDS,
        })
      },
      markQueued: (queuedAt) =>
        onDaemonUpdateQueued(db, serverId, requestId, UPDATE_CHANNEL, queuedAt),
      markFailed: (error, finishedAt) =>
        onDaemonUpdateResult(db, serverId, requestId, false, finishedAt, error),
    })
    return {
      ok: true,
      queued: true,
      status: 'updating',
      serverId,
      requestId,
      channel: UPDATE_CHANNEL,
    }
  }

  await registry.getCell(serverId).enqueue(envelope, {
    ttlSeconds: UPDATE_REQUEST_TTL_SECONDS,
  })

  await onDaemonUpdateQueued(db, serverId, requestId, UPDATE_CHANNEL, envelope.at)

  return {
    ok: true,
    queued: true,
    status: 'updating',
    serverId,
    requestId,
    channel: UPDATE_CHANNEL,
  }
}

async function repairProjectedUpdateIfStale(
  db: Db,
  serverId: string,
  projectedUpdate: UpdateProjection | null | undefined,
  current: ServerUpdateCommit | null,
  targetCommit?: string,
): Promise<UpdateProjection | null | undefined> {
  if (shouldSkipProjectedUpdateRepair(projectedUpdate)) {
    return projectedUpdate
  }

  const repaired = await repairStaleProjectedUpdate(
    db,
    serverId,
    projectedUpdate!,
    {
      currentCommit: current?.commit,
      targetCommit,
      updateTtlMs: UPDATE_REQUEST_TTL_MS,
    },
  )
  if (!repaired) return projectedUpdate

  if (targetCommit && current?.commit === targetCommit) {
    return repairedUpdateDoneProjection({
      requestId: projectedUpdate!.requestId ?? undefined,
      channel: projectedUpdate!.channel ?? undefined,
      queuedAt: projectedUpdate!.queuedAt ?? undefined,
      finishedAt: new Date().toISOString(),
    })
  }

  return repairedUpdateIdleProjection()
}

async function assertServerDeletable(
  c: Context,
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverId: string,
  organizationId: string,
): Promise<Response | null> {
  const colocatedIds = await resolveColocatedServerIdSet(
    db,
    registry,
    [serverId],
    { includeSelfHostPin: true },
  )
  if (colocatedIds.has(serverId)) {
    return c.json({ error: colocatedServerDeleteBlockedReason() }, 403)
  }

  // Fallback until the self-host environment pin exists: active reserved license.
  if (await hasActiveColocatedLicenseBinding(db, organizationId, serverId)) {
    return c.json({ error: colocatedServerDeleteBlockedReason() }, 403)
  }

  const blockers = await listServerDeleteBlockers(db, serverId, organizationId)
  if (blockers.length > 0) {
    return serverDeleteBlockersResponse(c, blockers)
  }

  return null
}

async function purgeServerDaemonCell(
  registry: DaemonCellRegistry,
  serverId: string,
): Promise<string | null> {
  try {
    await registry.getCell(serverId).purge()
    return null
  } catch (err) {
    const message = errorMessageFromUnknown(err)
    console.error(`Failed to purge daemon cell for server ${serverId}: ${message}`)
    return message
  }
}

/**
 * Soft-revokes the registration key that enrolled this server.
 * Licenses are one-shot: deleting the server retires the key on every runtime
 * so it cannot enroll a replacement host.
 */
async function revokeBoundLicenseOnServerDelete(
  db: Db,
  serverId: string,
  licenseId: string | null,
  organizationId: string,
): Promise<void> {
  if (!licenseId) return

  const invalidated = await revokeLicense(db, licenseId, organizationId)
  if (!invalidated) {
    compatLogWarn(
      'servers',
      `server ${serverId} deleted but license ${licenseId} was not invalidated (missing, wrong org, or already revoked)`,
    )
  }
}

async function loadDatacenterOptionsMap(
  db: Db,
  datacenterIds: Array<string | null | undefined>,
): Promise<Map<string, ReturnType<typeof parseDatacenterOptions>>> {
  const distinct = distinctNonEmptyIds(datacenterIds)
  if (distinct.length === 0) return new Map()

  const rows = await db
    .select({ id: datacenter.id, options: datacenter.options })
    .from(datacenter)
    .where(inArray(datacenter.id, distinct))

  const map = new Map<string, ReturnType<typeof parseDatacenterOptions>>()
  for (const row of rows) {
    map.set(row.id, parseDatacenterOptions(row.options))
  }
  return map
}

function parseServerPatchBody(
  c: Context,
  body: Record<string, unknown>,
): ServerPatchFields | Response {
  const core = parseServerPatchCore(body)
  if (!core.ok) {
    return c.json({ error: core.error }, core.status)
  }
  return core.patch
}

function buildServerUpdateFields(patch: ServerPatchFields): Record<string, unknown> {
  const update: Record<string, unknown> = { updatedAt: patch.updatedAt }
  if (patch.name !== undefined) update.name = patch.name
  if (patch.machineClass !== undefined) update.machineClass = patch.machineClass
  if (patch.options !== undefined) {
    update.options = sql`COALESCE(${server.options}, '{}'::jsonb) || ${
      JSON.stringify(patch.options)
    }::jsonb`
  }
  return update
}

/**
 * Persist a hosting-enable PATCH only when hierarchy provisioning succeeds.
 * Returns an error Response when provisioning fails so the enabled flag is
 * not left committed without inventory. Daemon enrollment keeps best-effort
 * hierarchy in `server-registry` (must not block enroll).
 */
async function applyServerPatchWithHostingEnable(
  c: Context,
  db: Db,
  params: Readonly<{
    serverId: string
    organizationId: string
    patch: ServerPatchFields
  }>,
): Promise<Response | null> {
  const update = buildServerUpdateFields(params.patch)
  try {
    await db.transaction(async (tx) => {
      await tx.update(server).set(update).where(eq(server.id, params.serverId))
      await systemHierarchy.ensureSystemHierarchy(tx, {
        organizationId: params.organizationId,
        serverId: params.serverId,
      })
    })
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    compatLogWarn(
      'servers',
      `ensureSystemHierarchy failed for server ${params.serverId}: ${message}`,
    )
    return c.json(hostingHierarchyFailedBody(), 500)
  }
}

/**
 * Persist a server PATCH. Hosting-enable commits only when hierarchy
 * provisioning succeeds; other patches (including hosting-disable) update
 * in place and leave inventory rows alone.
 */
async function applyServerPatchUpdate(
  c: Context,
  db: Db,
  params: Readonly<{
    serverId: string
    organizationId: string
    patch: ServerPatchFields
    previousOptions: ServerOptions | null
  }>,
): Promise<Response | null> {
  if (isHostingEnableTransition(params.previousOptions, params.patch)) {
    return applyServerPatchWithHostingEnable(c, db, {
      serverId: params.serverId,
      organizationId: params.organizationId,
      patch: params.patch,
    })
  }
  await db
    .update(server)
    .set(buildServerUpdateFields(params.patch))
    .where(eq(server.id, params.serverId))
  return null
}

/**
 * Best-effort `system.reconcile` after a hosting enable/disable transition.
 * Enqueues after the PATCH transaction commits — never inside it. Sweep
 * retries on failure; missing dispatch infra is a no-op.
 *
 * Enable uses `action: 'reconcile'` (self-heal). Disable uses `action: 'stop'`
 * scoped to the hosting-ingress environment so the shared proxy is torn
 * down intentionally — ordinary desired:'absent' drift stays report-only.
 */
async function enqueueHostingReconcileBestEffort(
  c: Context,
  db: Db,
  params: Readonly<{
    serverId: string
    actorId: string
    action: SystemReconcileAction
    environmentId?: string
  }>,
): Promise<void> {
  const commandQueue = assertDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return

  try {
    const enqueued = await enqueueSystemReconcile(db, commandQueue, {
      serverId: params.serverId,
      actorType: 'user',
      actorId: params.actorId,
      action: params.action,
      ...(params.environmentId ? { environmentId: params.environmentId } : {}),
    })
    if (!enqueued.ok && enqueued.reason !== 'not_provisioned') {
      compatLogWarn(
        'servers',
        `system.reconcile enqueue failed for server ${params.serverId}: ${enqueued.reason}`,
      )
    }
  } catch (err) {
    const message = errorMessageFromUnknown(err)
    compatLogWarn(
      'servers',
      `system.reconcile enqueue failed for server ${params.serverId}: ${message}`,
    )
  }
}

async function systemEnvironmentHasActiveContainers(
  db: Db,
  systemEnvironmentId: string,
): Promise<boolean> {
  const serviceRows = await db
    .select({ id: service.id })
    .from(service)
    .where(eq(service.environmentId, systemEnvironmentId))
  const serviceIds = serviceRows.map((svc) => svc.id)
  if (serviceIds.length === 0) return false

  const containerRows = await db
    .select({ status: container.status })
    .from(container)
    .where(inArray(container.serviceId, serviceIds))
  return containerRows.some((row) => isActiveContainerStatus(row.status))
}

/**
 * Blocks delete while system hosting-ingress containers are still active.
 * Operator must let hosting-disable reconciliation stop ingress first.
 */
async function assertSystemEnvironmentIdleOrBlocked(
  c: Context,
  db: Db,
  serverId: string,
): Promise<{ systemEnvironmentId: string | null } | Response> {
  const systemEnvironmentId = await systemHierarchy.findSystemEnvironmentForServer(
    db,
    serverId,
  )
  if (!systemEnvironmentId) return { systemEnvironmentId: null }

  if (await systemEnvironmentHasActiveContainers(db, systemEnvironmentId)) {
    return hierarchyDeleteHasChildrenResponse(c)
  }
  return { systemEnvironmentId }
}

function deleteServerWithSystemSubtree(
  db: Db,
  serverId: string,
  systemEnvironmentId: string | null,
): Promise<'ok' | 'has_children'> {
  return runHierarchyDelete(db, async (tx) => {
    if (systemEnvironmentId) {
      await systemHierarchy.deleteSystemEnvironmentSubtree(tx, systemEnvironmentId)
    }
    await deleteServerFabricMembership(tx, serverId)
    await tx.delete(server).where(eq(server.id, serverId))
  })
}

async function reconcileFabricAfterServerDelete(
  c: Context,
  db: Db,
  organizationId: string,
  actorId: string,
): Promise<void> {
  const commandQueue = assertDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return
  try {
    const secretsConfig = c.get('secretsConfig')
    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    await reconcileFabricMembership({
      db,
      commandQueue,
      actorType: 'user',
      actorId,
      organizationId,
      ...(secretsConfig ? { secretsConfig } : {}),
      ...(dataEncryptionSecrets ? { dataEncryptionSecrets } : {}),
    })
  } catch (err) {
    compatLogWarn(
      'servers',
      `reconcileFabricMembership after delete failed for org ${organizationId}: ${errorMessageFromUnknown(err)}`,
    )
  }
}

function serverDeletedResponse(
  c: Context,
  serverId: string,
  purgeError: string | null,
): Response {
  const payload = serverDeletedPayload(serverId, purgeError)
  if (payload.ok) {
    return c.json({ ok: true, serverId: payload.serverId })
  }
  return c.json({
    ok: false,
    serverId: payload.serverId,
    deleted: true,
    error: payload.error,
  }, payload.status)
}

export function registerServerRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server routes')
  }
  const secrets = opts.secrets

  router.use('/servers', createSessionMiddleware(secrets))
  router.use('/servers/*', createSessionMiddleware(secrets))

  router.get('/servers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ servers: [] })
    }

    let display
    try {
      display = await cachedServersListReadModel(c, {
        userId: session.userId,
        organizationId,
        visibleIds,
      })
    } catch {
      return c.json({ error: 'Database unavailable' }, 503)
    }

    const presence = new Map(display.presence.map((live) => [live.serverId, live]))
    const colocatedIds = new Set(display.colocatedIds)

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
    const orgOptions = parseOrganizationOptions(orgRow?.options)

    const serverIds = display.rows.map((row) => row.id)
    const membershipsByServer = await loadDatacenterMembershipsForServers(
      db,
      serverIds,
    )
    const membershipDcIds = [
      ...membershipsByServer.values(),
    ].flatMap((pins) => pins.map((pin) => pin.datacenterId))
    const datacenterOptionsById = await loadDatacenterOptionsMap(
      db,
      membershipDcIds,
    )
    const datacenterDisplayNamesById = await loadDatacenterDisplayNames(
      db,
      distinctNonEmptyIds(membershipDcIds),
    )
    const layoutPathsByServer = await loadServerLayoutPaths(db, serverIds)
    const placementByServer = await loadTierPlacementsForServers(db, serverIds, {
      deployment: metricsDeploymentKindForRuntime(opts.runtime),
      orgOptions,
      unwatched: 'counts',
    })

    return c.json({
      servers: display.rows.map((row) => {
        const live = presence.get(row.id)
        const memberships = membershipsByServer.get(row.id) ?? []
        const datacenters = shapeServerDatacenters(
          memberships,
          datacenterDisplayNamesById,
        )
        const primaryDcId = datacenters[0]?.id
        const dcOptions = primaryDcId
          ? datacenterOptionsById.get(primaryDcId)
          : undefined
        const timezoneFields = resolveServerTimezoneFields(
          row.options,
          orgOptions,
          dcOptions,
          live?.timeSync?.timezone,
        )
        const hostDefaultsFields = resolveServerHostDefaultsFields(
          row.options,
          orgOptions,
          dcOptions,
        )
        return {
          ...row,
          // Belt to the read model's braces: the loader strips secret-bearing
          // `options` keys before caching, and the response strips them again
          // in case a stale cache entry predates that. See
          // `REDACTED_SERVER_OPTION_KEYS`.
          options: redactServerOptions(row.options),
          datacenters,
          ...shapeServerPresenceFields(live, colocatedIds.has(row.id)),
          ...timezoneFields,
          ...hostDefaultsFields,
          licenseId: row.licenseId ?? null,
          tierPlacement: placementByServer.get(row.id) ?? null,
          layoutPaths: layoutPathsByServer.get(row.id) ?? null,
        }
      }),
    })
  })

  router.get('/servers/updates', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json(emptyServersUpdatesPayload())
    }

    const registry = getDaemonCellRegistry(c)
    const presence = await resolveFleetPresence(db, registry, visibleIds)
    const projections = await readProjectionsForServers(db, visibleIds)
    const colocatedIds = await resolveColocatedServerIdSet(db, registry, visibleIds)
    const targetManifest = await resolveTrunkManifest()
    const { target, targetStatus, targetError } = resolveTrunkTargetFields(
      targetManifest,
    )

    const servers = await Promise.all(
      visibleIds.map(async (serverId) => {
        const current = currentCommitFromDaemonBuild(presence.get(serverId)?.daemonBuild)
        const projection = projections.get(serverId)
        const repairedUpdate = await repairProjectedUpdateIfStale(
          db,
          serverId,
          projection?.update ?? null,
          current,
          targetManifest?.commit,
        )
        const resolved = await resolveServerUpdateStatus({
          serverId,
          current,
          targetManifest,
          colocatedWithInstance: colocatedIds.has(serverId),
          projectedUpdate: repairedUpdate ?? null,
        })
        return {
          serverId,
          current,
          colocatedWithInstance: colocatedIds.has(serverId),
          ...resolved,
        }
      }),
    )

    return c.json({
      ok: true,
      channel: UPDATE_CHANNEL,
      target,
      targetStatus,
      targetError,
      servers,
    })
  })

  router.post('/servers/updates', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Daemon cell registry unavailable' }, 503)

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    const targetManifest = await resolveTrunkManifest()
    const presence = await resolveFleetPresence(db, registry, visibleIds)
    const colocatedIds = await resolveColocatedServerIdSet(db, registry, visibleIds)

    const results = await Promise.all(
      visibleIds.map(async (serverId) => {
        const manageable = await can(
          db,
          session.userId,
          'organization:manage',
          'server',
          serverId,
        )
        if (!manageable) {
          return {
            serverId,
            ok: false,
            error: 'Forbidden',
          }
        }

        const current = currentCommitFromDaemonBuild(presence.get(serverId)?.daemonBuild)
        const eligibility = resolveBatchUpdateEligibility({
          connected: presence.get(serverId)?.connected ?? false,
          colocated: colocatedIds.has(serverId),
          current,
          targetCommit: targetManifest?.commit ?? null,
        })
        if (!eligibility.ok) {
          return {
            serverId,
            ok: false,
            error: eligibility.error,
          }
        }

        const queued = await queueServerUpdate(registry, db, serverId)
        if (!queued.ok) {
          return { serverId, ok: false, error: queued.error }
        }

        return {
          serverId,
          ok: true,
          queued: true,
          status: queued.status,
          requestId: queued.requestId,
          channel: queued.channel,
        }
      }),
    )

    return c.json({
      ok: results.every((result) => result.ok),
      results,
    })
  })

  router.get('/servers/status', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    evictExpiredBatchStatusEntries()
    const coalesceKey = buildBatchStatusCoalesceKey(
      session.userId,
      organizationId,
      visibleIds,
    )
    const now = Date.now()

    let entry = batchStatusCoalesce.get(coalesceKey)
    if (entry && entry.expiresAt > now) {
      if (entry.result) {
        return c.json(entry.result, 200, { 'Cache-Control': STATUS_CACHE_CONTROL })
      }
      if (entry.promise !== undefined) {
        const result = await entry.promise
        return c.json(result, 200, { 'Cache-Control': STATUS_CACHE_CONTROL })
      }
    }

    if (batchStatusCoalesce.get(coalesceKey)?.promise === undefined) {
      const registry = getDaemonCellRegistry(c)
      const promise = loadServerStatusRecords(db, registry, visibleIds)
        .then((servers) => ({ servers }))
        .then((result) => {
          const current = batchStatusCoalesce.get(coalesceKey)
          if (current) {
            current.result = result
            current.promise = undefined
            current.expiresAt = Date.now() + STATUS_CACHE_MAX_AGE_MS
          }
          return result
        })
        .catch((err) => {
          const current = batchStatusCoalesce.get(coalesceKey)
          if (current?.promise === promise) {
            batchStatusCoalesce.delete(coalesceKey)
          }
          throw err
        })

      batchStatusCoalesce.set(coalesceKey, {
        expiresAt: now + STATUS_CACHE_MAX_AGE_MS,
        promise,
      })
    }

    entry = batchStatusCoalesce.get(coalesceKey)!
    const result = entry.result ?? await entry.promise!
    return c.json(result, 200, { 'Cache-Control': STATUS_CACHE_CONTROL })
  })

  router.get('/servers/:id/status', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    const records = await loadServerStatusRecords(db, registry, [id])
    if (records.length === 0) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json(records[0], 200, { 'Cache-Control': STATUS_CACHE_CONTROL })
  })

  // DEBUG/DIAGNOSTIC ENDPOINT — hits the Durable Object directly via fetchDaemonServerCell.
  // Admin/superadmin only. Must NOT be polled by normal UI — use `/servers/status`
  // for Postgres-backed presence instead.
  router.get('/servers/:id/cell', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
    if (!isAdminRole(session.role)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    const result = await fetchDaemonServerCell(db, registry, id)
    if (!result.ok) {
      return c.json({ error: result.error }, result.status)
    }
    return c.json(result)
  })

  router.post('/servers/:id/update/reset', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Daemon cell registry unavailable' }, 503)

    try {
      const presence = await resolveFleetPresence(db, registry, [id])
      const projections = await readProjectionsForServers(db, [id])
      const colocatedIds = await resolveColocatedServerIdSet(db, registry, [id])
      const current = currentCommitFromDaemonBuild(presence.get(id)?.daemonBuild)
      const targetManifest = await resolveTrunkManifest()
      const projectedUpdate = projections.get(id)?.update
      const stale = isStaleProjectedUpdating({
        projectedUpdate,
        currentCommit: current?.commit,
        targetCommit: targetManifest?.commit,
        updateTtlMs: UPDATE_REQUEST_TTL_MS,
      })

      const { cleared } = await registry.getCell(id).clearUpdateStatus({
        allowStale: stale,
        currentCommit: current?.commit,
        targetCommit: targetManifest?.commit,
        queuedAt: projectedUpdate?.queuedAt,
        updateTtlMs: UPDATE_REQUEST_TTL_MS,
      })

      if (stale && projectedUpdate?.status === 'updating') {
        const finishedAt = new Date().toISOString()
        const requestId = projectedUpdate.requestId ?? ''
        if (
          current?.commit === targetManifest?.commit &&
          targetManifest != null
        ) {
          await onDaemonUpdateResult(db, id, requestId, true, finishedAt)
        } else {
          await onDaemonUpdateExpired(db, id, requestId, finishedAt)
        }
      } else {
        await onDaemonUpdateReset(db, id)
      }

      const resolved = await resolveServerUpdateStatus({
        serverId: id,
        current,
        targetManifest,
        colocatedWithInstance: colocatedIds.has(id),
        projectedUpdate: { status: 'idle' },
      })

      return c.json({
        ok: true,
        serverId: id,
        cleared,
        channel: UPDATE_CHANNEL,
        current,
        colocatedWithInstance: colocatedIds.has(id),
        ...resolved,
      })
    } catch (err) {
      const message = errorMessageFromUnknown(err)
      return c.json({ ok: false, error: message }, updateResetErrorStatus(message))
    }
  })

  router.get('/servers/:id/update', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    const presence = await resolveFleetPresence(db, registry, [id])
    const projections = await readProjectionsForServers(db, [id])
    const colocatedIds = await resolveColocatedServerIdSet(db, registry, [id])
    const current = currentCommitFromDaemonBuild(presence.get(id)?.daemonBuild)
    const targetManifest = await resolveTrunkManifest()
    const repairedUpdate = await repairProjectedUpdateIfStale(
      db,
      id,
      projections.get(id)?.update ?? null,
      current,
      targetManifest?.commit,
    )

    const resolved = await resolveServerUpdateStatus({
      serverId: id,
      current,
      targetManifest,
      colocatedWithInstance: colocatedIds.has(id),
      projectedUpdate: repairedUpdate ?? null,
    })

    return c.json({
      ok: true,
      serverId: id,
      channel: UPDATE_CHANNEL,
      current,
      colocatedWithInstance: colocatedIds.has(id),
      ...resolved,
    })
  })

  router.post('/servers/:id/update', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Daemon cell registry unavailable' }, 503)

    const queued = await queueServerUpdate(registry, db, id)
    if (!queued.ok) {
      return c.json(
        { ok: false, error: queued.error },
        queueServerUpdateHttpStatus(queued.error),
      )
    }

    return c.json(queued)
  })

  router.get('/servers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const [serverRow] = await db
      .select({ id: server.id })
      .from(server)
      .where(and(eq(server.id, id), eq(server.organizationId, organizationId)))
      .limit(1)
    if (!serverRow) return c.json({ error: 'Not found' }, 404)

    let display
    try {
      display = await cachedServerDetailReadModel(c, {
        organizationId,
        serverId: id,
      })
    } catch {
      return c.json({ error: 'Database unavailable' }, 503)
    }
    if (!display) return c.json({ error: 'Not found' }, 404)

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
    const orgOptions = parseOrganizationOptions(orgRow?.options)
    const membershipsByServer = await loadDatacenterMembershipsForServers(db, [
      id,
    ])
    const memberships = membershipsByServer.get(id) ?? []
    const membershipDcIds = memberships.map((pin) => pin.datacenterId)
    const datacenterOptionsById = await loadDatacenterOptionsMap(
      db,
      membershipDcIds,
    )
    const datacenterDisplayNamesById = await loadDatacenterDisplayNames(
      db,
      distinctNonEmptyIds(membershipDcIds),
    )
    const datacenters = shapeServerDatacenters(
      memberships,
      datacenterDisplayNamesById,
    )
    const primaryDcId = datacenters[0]?.id
    const dcOptions = primaryDcId
      ? datacenterOptionsById.get(primaryDcId)
      : undefined
    const labelRows = await listServerLabels(db, id)
    const live = display.presence
    const timezoneFields = resolveServerTimezoneFields(
      display.row.options,
      orgOptions,
      dcOptions,
      live?.timeSync?.timezone,
    )
    const hostDefaultsFields = resolveServerHostDefaultsFields(
      display.row.options,
      orgOptions,
      dcOptions,
    )
    const layoutPathsByServer = await loadServerLayoutPaths(db, [id])
    const placementByServer = await loadTierPlacementsForServers(db, [id], {
      deployment: metricsDeploymentKindForRuntime(opts.runtime),
      orgOptions,
      unwatched: 'ids',
    })

    return c.json({
      ok: true,
      server: {
        ...display.row,
        // See the list route: redacted again at the response boundary so a
        // cache entry written before the redaction cannot leak.
        options: redactServerOptions(display.row.options),
        datacenters,
        ...shapeServerPresenceFields(live, display.colocatedWithInstance),
        ...timezoneFields,
        ...hostDefaultsFields,
        orgDefaultTimezone: orgOptions.defaultServerTimezone ?? null,
        enforceServerTimezone: orgOptions.enforceServerTimezone ?? false,
        datacenterDefaultTimezone: dcOptions?.defaultServerTimezone ?? null,
        datacenterEnforceServerTimezone:
          dcOptions?.enforceServerTimezone ?? false,
        licenseId: display.row.licenseId ?? null,
        tierPlacement: placementByServer.get(id) ?? null,
        layoutPaths: layoutPathsByServer.get(id) ?? null,
        labels: labelRows.map((row) => ({ key: row.key, value: row.value })),
      },
    })
  })

  router.patch('/servers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')
    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const [existing] = await db
      .select({ id: server.id, options: server.options })
      .from(server)
      .where(and(eq(server.id, id), eq(server.organizationId, organizationId)))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const patch = parseServerPatchBody(c, body)
    if (patch instanceof Response) return patch

    const previousOptions = parseServerOptions(existing.options)
    const hostingEnable = isHostingEnableTransition(previousOptions, patch)
    const hostingDisable = isHostingDisableTransition(previousOptions, patch)

    const failed = await applyServerPatchUpdate(c, db, {
      serverId: id,
      organizationId,
      patch,
      previousOptions,
    })
    if (failed) return failed

    if (hostingEnable) {
      await enqueueHostingReconcileBestEffort(c, db, {
        serverId: id,
        actorId: session.userId,
        action: 'reconcile',
      })
    } else if (hostingDisable) {
      const hostingEnvironmentId = await systemHierarchy
        .findSystemEnvironmentForServer(
          db,
          id,
          systemHierarchy.SYSTEM_HOSTING_INGRESS_COMPONENT,
        )
      await enqueueHostingReconcileBestEffort(c, db, {
        serverId: id,
        actorId: session.userId,
        action: 'stop',
        ...(hostingEnvironmentId
          ? { environmentId: hostingEnvironmentId }
          : {}),
      })
    }

    return c.json({ ok: true as const })
  })

  router.delete('/servers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')
    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const [row] = await db
      .select({ id: server.id })
      .from(server)
      .where(and(eq(server.id, id), eq(server.organizationId, organizationId)))
      .limit(1)
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    // Co-located guard before the registry 503 so an unavailable registry can
    // never turn a self-host-pinned (or probe-matched) host into a deletable one.
    const registry = getDaemonCellRegistry(c)
    const blocked = await assertServerDeletable(c, db, registry, id, organizationId)
    if (blocked) return blocked

    if (!registry) {
      return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    }

    const [boundLicense] = await db
      .select({ id: license.id })
      .from(license)
      .where(eq(license.serverId, id))
      .limit(1)

    const idleOrBlocked = await assertSystemEnvironmentIdleOrBlocked(c, db, id)
    if (idleOrBlocked instanceof Response) return idleOrBlocked

    const result = await deleteServerWithSystemSubtree(
      db,
      id,
      idleOrBlocked.systemEnvironmentId,
    )
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    await reconcileFabricAfterServerDelete(c, db, organizationId, session.userId)

    await clearServerDaemonState(db, id)

    const purgeError = await purgeServerDaemonCell(registry, id)
    await revokeBoundLicenseOnServerDelete(
      db,
      id,
      boundLicense?.id ?? null,
      organizationId,
    )

    return serverDeletedResponse(c, id, purgeError)
  })

  registerServerCommandRoutes(router, opts)
  registerServerMetricsRoutes(router, opts)
  registerServerLabelRoutes(router, opts)
}
