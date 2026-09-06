import type { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listVisible } from '../authz/index.ts'
import { assertCanManageOr403, assertCanReadOr403, getOrgId } from '../shared.ts'
import { getDaemonCellRegistry, getDb, getServerMetricsStoreV4 } from '../../db.ts'
import {
  type DaemonOutboundEnvelope,
  generateDeliveryId,
  generateRequestId,
} from '../../daemon/cell/protocol.ts'
import { cellTrace } from '../../logger.ts'
import { organization, server } from '../../lib/db/schema.ts'
import {
  mergeServerHardwareProfile,
  parseServerHardwareProfile,
  parseServerHostResources,
  type ServerHardwareProfile,
  type ServerHardwareProfileUpdate,
} from '../../lib/db/server-metadata.ts'
import { parseOrganizationOptions } from '../../lib/organization-options.ts'
import { getServerMetricsLiveMaxMinutes } from '../../lib/settings/server-metrics-settings.ts'
import { loadServerStatusRecords } from './update-status.ts'
import {
  createMetricsChartCache,
  metricsChartCacheKey,
  resolveChartCacheTtlSeconds,
} from '../../daemon/metrics/query/cache.ts'
import {
  canonicalizeMetricsRange,
  parseMaxPoints,
  selectResolutionSeconds,
  validateMetricsRange,
} from '../../daemon/metrics/query/resolution.ts'
import {
  type HostSummaryChartResponse,
  toHostSeriesChartResponseV4,
} from '../../daemon/metrics/query/series-response-v4.ts'
import {
  METRICS_LIVE_INTERVAL_SECONDS,
  type MetricsLiveLeaseStartResponse,
  type StatusHistoryResult,
} from '../../daemon/metrics/types-v4.ts'
import {
  buildConnectionHistoryPayload,
  buildCpuLimitsEnvelope,
  buildFleetLatestPayloadV4,
  buildHostSummaryPayload,
  buildMetricEventsPayload,
  buildSeriesRouteResponseV4,
  buildTopologyContextV4,
  type ConnectionHistoryChartResponse,
  connectionHistoryHasCacheableData,
  type CpuLimitsEnvelope,
  fabricNetworkSelectionErrorV4,
  findInvalidTopologyIdField,
  FLEET_HOST_METRICS_V4,
  fleetHostCapacitiesFromSnapshotV4,
  hardwareProfileUpdateNeedsTopologyValidation,
  metricEventsHasCacheableData,
  type MetricEventsResponse,
  metricsBackendUnavailableResponse,
  metricsQueryErrorMessage,
  parseHardwareProfileBody,
  parseIsoTimestampQuery,
  parseOptionalResolution,
  parseSeriesMetricSelectorsV4,
  querySeriesResultsV4,
  resolveStoreBackendKindV4,
  seriesCacheMetricsListV4,
  type TopologyIdValidationSnapshot,
} from './metrics-routes-helpers.ts'
import {
  getLatestTopologyGeneration,
  getLatestTopologyGenerations,
} from './server-topology-records.ts'

/** Fixed lookback for the org servers overview usage strip/bars (~1 sample/min). */
export const FLEET_USAGE_LOOKBACK_MS = 10 * 60_000

/** Correlated round-trip budget for live lease start/stop (cheap daemon work). */
const METRICS_LIVE_TIMEOUT_MS = 5_000

async function authorizeServerRead(
  c: Parameters<typeof assertCanReadOr403>[0],
  serverId: string
): Promise<Response | null> {
  const denied = await assertCanReadOr403(c, 'server', serverId)
  if (denied) return denied
  if (!c.get('session')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return null
}

/**
 * Server-metadata facts a single-server metrics route needs before it can
 * even build its cache key: the operator-assigned hardware profile (whose
 * `generation` scopes the cache key — see `metricsChartCacheKey`) and the
 * organization id (for the temperature-unit lookup on a cache miss). One
 * lightweight query — never called from `/servers/metrics/latest`, where
 * doing this per fleet server would break the O(1) fleet-read invariant.
 */
async function loadServerHardwareProfile(
  db: NonNullable<ReturnType<typeof getDb>>,
  serverId: string
): Promise<{
  hardwareProfile: ServerHardwareProfile | undefined
  organizationId: string | null
}> {
  const [serverRow] = await db
    .select({
      metadata: server.metadata,
      organizationId: server.organizationId,
    })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const rawMetadata = serverRow?.metadata
  const metadata: Record<string, unknown> =
    rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {}
  const hardwareProfile = parseServerHardwareProfile(metadata.hardwareProfile)
  const resources = parseServerHostResources(metadata.resources)

  // `hardwareProfile.cpuModel` is only ever written by a host-facts
  // projection this codebase does not have yet — fall back to the raw
  // `/proc/cpuinfo` model name the daemon already reports on every
  // hello/heartbeat (`resources.cpus[0].name`) so CPU-catalog lookups
  // resolve on real hosts instead of only in tests that set cpuModel by
  // hand. Never persisted — a per-request derivation only.
  const detectedCpuModel = resources?.cpus?.[0]?.name
  const effectiveHardwareProfile =
    hardwareProfile?.cpuModel || !detectedCpuModel
      ? hardwareProfile
      : { ...hardwareProfile, cpuModel: detectedCpuModel }

  return {
    hardwareProfile: effectiveHardwareProfile,
    organizationId: serverRow?.organizationId ?? null,
  }
}

/**
 * Resolve the CPU-headroom + temperature-unit envelope for a single-server
 * route (`/series`, `/summary`) from an already-loaded hardware profile —
 * see {@link loadServerHardwareProfile}.
 */
async function loadCpuLimitsEnvelope(
  db: NonNullable<ReturnType<typeof getDb>>,
  hardwareProfile: ServerHardwareProfile | undefined,
  organizationId: string | null
): Promise<CpuLimitsEnvelope> {
  let orgOptions = null
  if (organizationId) {
    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
    orgOptions = parseOrganizationOptions(orgRow?.options)
  }

  return buildCpuLimitsEnvelope(hardwareProfile, orgOptions)
}

export function registerServerMetricsRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server metrics routes')
  }
  const secrets = opts.secrets
  const cache = createMetricsChartCache(opts.runtime)

  router.use('/servers/metrics/*', createSessionMiddleware(secrets))
  router.use('/servers/:id/metrics/*', createSessionMiddleware(secrets))

  /**
   * One fleet usage snapshot for the org servers overview.
   * Authz via listVisible — never accept client-supplied serverIds.
   *
   * Deliberately carries no per-server `cpuLimits` (unlike `/series` and
   * `/summary`) — resolving one would mean a hardware-profile lookup per
   * visible server, breaking the one-query-per-fleet-snapshot invariant
   * this route exists to preserve. A per-server headroom readout belongs on
   * the single-server routes instead.
   */
  router.get('/servers/metrics/latest', async (c) => {
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

    const storeV4 = getServerMetricsStoreV4(c)
    const backend = resolveStoreBackendKindV4(storeV4, opts.runtime)
    const toMs = Date.now()
    const fromMs = toMs - FLEET_USAGE_LOOKBACK_MS
    const fromIso = new Date(fromMs).toISOString()
    const toIso = new Date(toMs).toISOString()
    const metrics = [...FLEET_HOST_METRICS_V4]

    if (visibleIds.length === 0) {
      return c.json({
        ok: true,
        from: fromIso,
        to: toIso,
        backend,
        available: true,
        metrics,
        servers: [],
      })
    }

    const cacheKey = metricsChartCacheKey({
      serverId: `fleet:${organizationId}`,
      fromBucketMs: Math.floor(fromMs / 60_000) * 60_000,
      toBucketMs: Math.floor(toMs / 60_000) * 60_000,
      metrics,
      resolutionSeconds: 60,
      backend,
      schemaVersion: 4,
      kind: 'fleet-latest',
    })

    const cached = await cache.get<ReturnType<typeof buildFleetLatestPayloadV4>>(cacheKey)
    if (cached) return c.json(cached)

    if (!storeV4?.queryFleetHostSnapshot) {
      const payload = buildFleetLatestPayloadV4({
        from: fromIso,
        to: toIso,
        backend,
        available: false,
        metrics,
        servers: [],
        capacitiesByServer: new Map(),
      })
      return c.json(payload)
    }

    let result
    try {
      result = await storeV4.queryFleetHostSnapshot({
        serverIds: visibleIds,
        metrics,
        from: fromIso,
        to: toIso,
      })
    } catch (err) {
      const message = metricsQueryErrorMessage(err)
      console.error(`metrics queryFleetHostSnapshot failed backend=${backend}: ${message}`)
      return c.json(metricsBackendUnavailableResponse(backend), 503)
    }

    // Batched — one query for every visible server's latest topology
    // generation, never N — keeps this route O(1) in server count (see
    // AGENTS.md's fleet-read invariant).
    const topologyByServer = await getLatestTopologyGenerations(db, visibleIds)
    const capacitiesByServer = new Map(
      [...topologyByServer].map(([serverId, record]) => [
        serverId,
        fleetHostCapacitiesFromSnapshotV4(record.snapshot),
      ])
    )

    const payload = buildFleetLatestPayloadV4({
      from: fromIso,
      to: toIso,
      backend: result.kind,
      available: result.available,
      metrics: result.metrics,
      servers: result.servers,
      capacitiesByServer,
    })
    if (result.available && result.servers.some((row) => row.sampleCount > 0)) {
      await cache.set(cacheKey, payload, 45)
    }
    return c.json(payload)
  })

  router.get('/servers/:id/metrics/series', async (c) => {
    const serverId = c.req.param('id')
    const denied = await authorizeServerRead(c, serverId)
    if (denied) return denied

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const fromParsed = parseIsoTimestampQuery(c.req.query('from'), 'from')
    if (!fromParsed.ok) {
      return c.json({ ok: false, error: fromParsed.message }, 400)
    }
    const toParsed = parseIsoTimestampQuery(c.req.query('to'), 'to')
    if (!toParsed.ok) {
      return c.json({ ok: false, error: toParsed.message }, 400)
    }

    const rangeCheck = validateMetricsRange(fromParsed.ms, toParsed.ms)
    if (!rangeCheck.ok) {
      return c.json({ ok: false, error: rangeCheck.message }, 400)
    }

    const selectorsParsed = parseSeriesMetricSelectorsV4(c.req.query('metrics'))
    if (!selectorsParsed.ok) {
      return c.json({ ok: false, error: selectorsParsed.error }, 400)
    }
    const selectors = selectorsParsed.value

    const maxPointsParsed = parseMaxPoints(c.req.query('maxPoints'))
    if (!maxPointsParsed.ok) {
      return c.json({ ok: false, error: maxPointsParsed.message }, 400)
    }

    const storeV4 = getServerMetricsStoreV4(c)
    const backend = resolveStoreBackendKindV4(storeV4, opts.runtime)

    const resolutionSeconds = selectResolutionSeconds({
      fromMs: fromParsed.ms,
      toMs: toParsed.ms,
      requested: parseOptionalResolution(c.req.query('resolution')),
      maxPoints: maxPointsParsed.value,
    })

    const queryRange = canonicalizeMetricsRange(fromParsed.ms, toParsed.ms, resolutionSeconds)

    const { hardwareProfile, organizationId } = await loadServerHardwareProfile(db, serverId)
    const latestGeneration = await getLatestTopologyGeneration(db, serverId)
    const context = buildTopologyContextV4(latestGeneration, hardwareProfile)

    const fabricError = fabricNetworkSelectionErrorV4(selectors, context.inventory)
    if (fabricError) {
      return c.json({ ok: false, error: fabricError }, 400)
    }

    const cacheKey = metricsChartCacheKey({
      serverId,
      fromBucketMs: queryRange.fromMs,
      toBucketMs: queryRange.toMs,
      metrics: seriesCacheMetricsListV4(selectors),
      resolutionSeconds,
      backend,
      schemaVersion: 4,
      kind: 'series',
      topologyGeneration: context.topologyGeneration ?? undefined,
    })

    const cached = await cache.get<ReturnType<typeof buildSeriesRouteResponseV4>>(cacheKey)
    if (cached) {
      return c.json(cached)
    }

    const seriesQuery = await querySeriesResultsV4({
      store: storeV4,
      backend,
      serverId,
      selectors,
      fromIso: queryRange.fromIso,
      toIso: queryRange.toIso,
      resolutionSeconds,
      context,
    })
    if (!seriesQuery.ok) {
      return c.json(metricsBackendUnavailableResponse(backend), 503)
    }
    const { hostResult, entityResults } = seriesQuery

    const envelope = await loadCpuLimitsEnvelope(db, hardwareProfile, organizationId)
    const hostChartResponse = hostResult
      ? toHostSeriesChartResponseV4({
          serverId,
          from: queryRange.fromIso,
          to: queryRange.toIso,
          result: hostResult,
          capacities: context.capacities,
        })
      : null

    const payload = buildSeriesRouteResponseV4({
      serverId,
      from: queryRange.fromIso,
      to: queryRange.toIso,
      backend,
      resolutionSeconds,
      host: hostChartResponse,
      entities: entityResults,
      context,
      envelope,
    })

    // Do not cache empty live series — the first sample often lands seconds
    // after the first chart fetch; a 45s empty cache keeps the UI stuck on
    // "No server metrics yet" despite successful daemon POSTs.
    const totalSampleCount =
      (hostChartResponse?.sampleCount ?? 0) +
      entityResults.reduce(
        (sum, entity) => sum + entity.entities.reduce((s, e) => s + e.sampleCount, 0),
        0
      )
    if (totalSampleCount > 0) {
      const ttlSeconds = resolveChartCacheTtlSeconds({
        toMs: queryRange.toMs,
        nowMs: Date.now(),
        resolutionSeconds,
      })
      await cache.set(cacheKey, payload, ttlSeconds)
    }
    return c.json(payload)
  })

  router.get('/servers/:id/metrics/summary', async (c) => {
    const serverId = c.req.param('id')
    const denied = await authorizeServerRead(c, serverId)
    if (denied) return denied

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const fromParsed = parseIsoTimestampQuery(c.req.query('from'), 'from')
    if (!fromParsed.ok) {
      return c.json({ ok: false, error: fromParsed.message }, 400)
    }
    const toParsed = parseIsoTimestampQuery(c.req.query('to'), 'to')
    if (!toParsed.ok) {
      return c.json({ ok: false, error: toParsed.message }, 400)
    }

    const rangeCheck = validateMetricsRange(fromParsed.ms, toParsed.ms)
    if (!rangeCheck.ok) {
      return c.json({ ok: false, error: rangeCheck.message }, 400)
    }

    const storeV4 = getServerMetricsStoreV4(c)
    const backend = resolveStoreBackendKindV4(storeV4, opts.runtime)
    const summaryResolutionSeconds = 300
    const queryRange = canonicalizeMetricsRange(
      fromParsed.ms,
      toParsed.ms,
      summaryResolutionSeconds
    )

    const { hardwareProfile, organizationId } = await loadServerHardwareProfile(db, serverId)
    const latestGeneration = await getLatestTopologyGeneration(db, serverId)

    const cacheKey = metricsChartCacheKey({
      serverId,
      fromBucketMs: queryRange.fromMs,
      toBucketMs: queryRange.toMs,
      metrics: [],
      resolutionSeconds: summaryResolutionSeconds,
      backend,
      schemaVersion: 4,
      kind: 'summary',
      topologyGeneration: latestGeneration?.generation,
    })

    const cached = await cache.get<HostSummaryChartResponse & CpuLimitsEnvelope>(cacheKey)
    if (cached) {
      return c.json(cached)
    }

    let result
    try {
      result = storeV4?.queryHostSummary
        ? await storeV4.queryHostSummary({
            serverId,
            from: queryRange.fromIso,
            to: queryRange.toIso,
          })
        : {
            kind: backend,
            available: false,
            serverId,
            sampleCount: 0,
            latestAt: null,
          }
    } catch (err) {
      const message = metricsQueryErrorMessage(err)
      console.error(
        `metrics queryHostSummary failed backend=${backend} serverId=${serverId}: ${message}`
      )
      return c.json(metricsBackendUnavailableResponse(backend), 503)
    }

    const envelope = await loadCpuLimitsEnvelope(db, hardwareProfile, organizationId)
    const payload = buildHostSummaryPayload({
      serverId,
      from: queryRange.fromIso,
      to: queryRange.toIso,
      result,
      envelope,
    })

    const ttlSeconds = resolveChartCacheTtlSeconds({
      toMs: queryRange.toMs,
      nowMs: Date.now(),
      resolutionSeconds: summaryResolutionSeconds,
    })
    await cache.set(cacheKey, payload, ttlSeconds)
    return c.json(payload)
  })

  router.get('/servers/:id/metrics/connection', async (c) => {
    const serverId = c.req.param('id')
    const denied = await authorizeServerRead(c, serverId)
    if (denied) return denied

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const fromParsed = parseIsoTimestampQuery(c.req.query('from'), 'from')
    if (!fromParsed.ok) {
      return c.json({ ok: false, error: fromParsed.message }, 400)
    }
    const toParsed = parseIsoTimestampQuery(c.req.query('to'), 'to')
    if (!toParsed.ok) {
      return c.json({ ok: false, error: toParsed.message }, 400)
    }

    const rangeCheck = validateMetricsRange(fromParsed.ms, toParsed.ms)
    if (!rangeCheck.ok) {
      return c.json({ ok: false, error: rangeCheck.message }, 400)
    }

    // Status transitions are v4-only: `queryStatusHistory` is optional on
    // `ServerMetricsStoreV4` (only `DisabledServerMetricsStoreV4` omits it),
    // so an unconfigured backend falls back to an inline "disabled" result
    // below rather than reading from a v3 store.
    const storeV4 = getServerMetricsStoreV4(c)
    const backend = resolveStoreBackendKindV4(storeV4, opts.runtime)

    // Same resolution ladder as /series so cache keys round identically.
    const resolutionSeconds = selectResolutionSeconds({
      fromMs: fromParsed.ms,
      toMs: toParsed.ms,
    })
    const queryRange = canonicalizeMetricsRange(fromParsed.ms, toParsed.ms, resolutionSeconds)

    // Only the generation is needed here (no cpuLimits envelope on this
    // route).
    const latestGeneration = await getLatestTopologyGeneration(db, serverId)

    const cacheKey = metricsChartCacheKey({
      serverId,
      fromBucketMs: queryRange.fromMs,
      toBucketMs: queryRange.toMs,
      metrics: [],
      resolutionSeconds,
      backend,
      schemaVersion: 4,
      kind: 'connection',
      topologyGeneration: latestGeneration?.generation,
    })

    const cached = await cache.get<ConnectionHistoryChartResponse>(cacheKey)
    if (cached) {
      return c.json(cached)
    }

    let result: StatusHistoryResult
    try {
      result = storeV4?.queryStatusHistory
        ? await storeV4.queryStatusHistory({
            serverId,
            from: queryRange.fromIso,
            to: queryRange.toIso,
          })
        : {
            kind: backend,
            available: false,
            serverId,
            initialConnected: null,
            events: [],
            uptimeSeconds: 0,
            downtimeSeconds: 0,
            unknownSeconds: 0,
            uptimePercent: null,
            truncated: false,
          }
    } catch (err) {
      const message = metricsQueryErrorMessage(err)
      console.error(
        `metrics queryStatusHistory failed backend=${backend} serverId=${serverId}: ${message}`
      )
      return c.json(metricsBackendUnavailableResponse(backend), 503)
    }

    const payload = buildConnectionHistoryPayload({
      serverId,
      from: queryRange.fromIso,
      to: queryRange.toIso,
      result,
    })

    // Skip caching empty live ranges — same guard as series (no sampleCount;
    // treat zero known up/down + empty events as empty).
    if (connectionHistoryHasCacheableData(result)) {
      const ttlSeconds = resolveChartCacheTtlSeconds({
        toMs: queryRange.toMs,
        nowMs: Date.now(),
        resolutionSeconds,
      })
      await cache.set(cacheKey, payload, ttlSeconds)
    }
    return c.json(payload)
  })

  /**
   * v4-only: hardware-health / lifecycle events (`sample.events`) for a
   * server in a time range. No v3 equivalent — v3 has no discrete event
   * stream, only the fixed host-metrics allowlist. `available: false` (never
   * a 503) when the resolved v4 store has no `queryMetricEvents` (e.g.
   * `DisabledServerMetricsStoreV4` — no backend binding configured).
   */
  router.get('/servers/:id/metrics/events', async (c) => {
    const serverId = c.req.param('id')
    const denied = await authorizeServerRead(c, serverId)
    if (denied) return denied

    const fromParsed = parseIsoTimestampQuery(c.req.query('from'), 'from')
    if (!fromParsed.ok) {
      return c.json({ ok: false, error: fromParsed.message }, 400)
    }
    const toParsed = parseIsoTimestampQuery(c.req.query('to'), 'to')
    if (!toParsed.ok) {
      return c.json({ ok: false, error: toParsed.message }, 400)
    }

    const rangeCheck = validateMetricsRange(fromParsed.ms, toParsed.ms)
    if (!rangeCheck.ok) {
      return c.json({ ok: false, error: rangeCheck.message }, 400)
    }

    const storeV4 = getServerMetricsStoreV4(c)
    const backend = resolveStoreBackendKindV4(storeV4, opts.runtime)

    if (!storeV4?.queryMetricEvents) {
      return c.json(
        buildMetricEventsPayload({
          serverId,
          from: fromParsed.iso,
          to: toParsed.iso,
          result: {
            kind: backend,
            available: false,
            serverId,
            events: [],
            truncated: false,
          },
        })
      )
    }

    // Same resolution ladder as /connection, purely for a stable cache key —
    // metric events are point-in-time rows, never bucketed.
    const resolutionSeconds = selectResolutionSeconds({
      fromMs: fromParsed.ms,
      toMs: toParsed.ms,
    })
    const queryRange = canonicalizeMetricsRange(fromParsed.ms, toParsed.ms, resolutionSeconds)

    const cacheKey = metricsChartCacheKey({
      serverId,
      fromBucketMs: queryRange.fromMs,
      toBucketMs: queryRange.toMs,
      metrics: [],
      resolutionSeconds,
      backend,
      schemaVersion: 4,
      kind: 'events',
    })

    const cached = await cache.get<MetricEventsResponse>(cacheKey)
    if (cached) {
      return c.json(cached)
    }

    let result
    try {
      result = await storeV4.queryMetricEvents({
        serverId,
        from: queryRange.fromIso,
        to: queryRange.toIso,
      })
    } catch (err) {
      const message = metricsQueryErrorMessage(err)
      console.error(
        `metrics queryMetricEvents failed backend=${backend} serverId=${serverId}: ${message}`
      )
      return c.json(metricsBackendUnavailableResponse(backend), 503)
    }

    const payload = buildMetricEventsPayload({
      serverId,
      from: queryRange.fromIso,
      to: queryRange.toIso,
      result,
    })

    if (metricEventsHasCacheableData(result)) {
      const ttlSeconds = resolveChartCacheTtlSeconds({
        toMs: queryRange.toMs,
        nowMs: Date.now(),
        resolutionSeconds,
      })
      await cache.set(cacheKey, payload, ttlSeconds)
    }
    return c.json(payload)
  })

  /**
   * Start (or explicitly renew) a live-metrics lease. Lease enforcement lives
   * entirely on the daemon: this route only computes the expiry from the
   * admin cap and relays the correlated `metrics-live-start` round trip.
   * An optional `{ leaseId }` body renews that lease in place — the daemon's
   * LiveLeaseManager treats a known id as a renewal, so a later DELETE of the
   * same id returns cadence to baseline immediately.
   */
  router.post('/servers/:id/metrics/live', async (c) => {
    const serverId = c.req.param('id')
    const denied = await authorizeServerRead(c, serverId)
    if (denied) return denied

    const body = await c.req.json().catch(() => null)
    const requestedLeaseId =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { leaseId?: unknown }).leaseId
        : undefined
    if (
      requestedLeaseId !== undefined &&
      (typeof requestedLeaseId !== 'string' || requestedLeaseId.length === 0)
    ) {
      return c.json({ error: 'expected leaseId to be a non-empty string' }, 400)
    }

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const maxMinutes = await getServerMetricsLiveMaxMinutes(db)
    if (maxMinutes === 0) {
      return c.json({ error: 'live_metrics_disabled' }, 409)
    }

    const registry = getDaemonCellRegistry(c)
    if (!registry) {
      return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    }
    const records = await loadServerStatusRecords(db, registry, [serverId])
    if (!records[0]?.connected) {
      return c.json({ error: 'server_offline' }, 409)
    }

    // Renewals reuse the caller's id; only a first-time start mints a new one.
    const leaseId = requestedLeaseId ?? generateRequestId()
    const expiresAt = new Date(Date.now() + maxMinutes * 60_000).toISOString()
    const requestId = generateRequestId()
    const envelope: DaemonOutboundEnvelope = {
      kind: 'metrics-live-start',
      deliveryId: generateDeliveryId(),
      requestId,
      leaseId,
      intervalSeconds: METRICS_LIVE_INTERVAL_SECONDS,
      expiresAt,
      at: new Date().toISOString(),
    }
    cellTrace('request-start', {
      requestId,
      serverId,
      kind: 'metrics-live-start',
    })

    try {
      const record = await registry
        .getCell(serverId)
        .createRequestAndWait(envelope, METRICS_LIVE_TIMEOUT_MS)
      if (record.status === 'expired') {
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'metrics-live-start',
          pendingStatus: record.status,
          resultStatus: 'timeout',
        })
        return c.json({ error: 'timeout waiting for live lease start' }, 503)
      }
      if (record.status === 'failed') {
        const error = record.error ?? 'failed to start live lease'
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'metrics-live-start',
          pendingStatus: record.status,
          resultStatus: 'failed',
          error,
        })
        return c.json({ error }, 500)
      }
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'metrics-live-start',
        pendingStatus: record.status,
        resultStatus: 'done',
      })
      const payload: MetricsLiveLeaseStartResponse = {
        ok: true,
        leaseId,
        intervalSeconds: METRICS_LIVE_INTERVAL_SECONDS,
        expiresAt,
      }
      return c.json(payload)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'metrics-live-start',
        resultStatus: 'error',
        error: message,
      })
      return c.json({ error: message }, 503)
    }
  })

  /**
   * Stop a live-metrics lease. A disconnected daemon is a soft success — its
   * local expiry timer returns cadence to baseline regardless.
   */
  router.delete('/servers/:id/metrics/live', async (c) => {
    const serverId = c.req.param('id')
    const denied = await authorizeServerRead(c, serverId)
    if (denied) return denied

    const body = await c.req.json().catch(() => null)
    const leaseId =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { leaseId?: unknown }).leaseId
        : undefined
    if (typeof leaseId !== 'string' || leaseId.length === 0) {
      return c.json({ error: 'expected { leaseId: string }' }, 400)
    }

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const registry = getDaemonCellRegistry(c)
    if (!registry) {
      return c.json({ ok: true })
    }
    const records = await loadServerStatusRecords(db, registry, [serverId])
    if (!records[0]?.connected) {
      // Daemon offline: the lease died with its socket session (and would
      // expire locally anyway) — nothing to stop.
      return c.json({ ok: true })
    }

    const requestId = generateRequestId()
    const envelope: DaemonOutboundEnvelope = {
      kind: 'metrics-live-stop',
      deliveryId: generateDeliveryId(),
      requestId,
      leaseId,
      at: new Date().toISOString(),
    }
    cellTrace('request-start', {
      requestId,
      serverId,
      kind: 'metrics-live-stop',
    })

    try {
      const record = await registry
        .getCell(serverId)
        .createRequestAndWait(envelope, METRICS_LIVE_TIMEOUT_MS)
      if (record.status === 'expired') {
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'metrics-live-stop',
          pendingStatus: record.status,
          resultStatus: 'timeout',
        })
        return c.json({ error: 'timeout waiting for live lease stop' }, 503)
      }
      if (record.status === 'failed') {
        const error = record.error ?? 'failed to stop live lease'
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'metrics-live-stop',
          pendingStatus: record.status,
          resultStatus: 'failed',
          error,
        })
        return c.json({ error }, 500)
      }
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'metrics-live-stop',
        pendingStatus: record.status,
        resultStatus: 'done',
      })
      return c.json({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'metrics-live-stop',
        resultStatus: 'error',
        error: message,
      })
      return c.json({ error: message }, 503)
    }
  })

  /**
   * Persist the operator-assigned hardware profile (sensor/NIC slots,
   * hosting path, drivetemp opt-in). `server.metadata` is the source of
   * truth; the daemon-side state is a cache refreshed by the best-effort
   * push below when the daemon is connected — an offline save converges
   * automatically once the daemon comes back and pushes its own state, or
   * on the operator's next save, without an operator-triggered replay.
   *
   * Any assigned entity identity is validated against the recorded topology
   * (`validateHardwareProfileTopologyIds`) before persisting — a stale id no
   * longer present in the topology is rejected with 400.
   */
  router.put('/servers/:id/metrics/hardware-profile', async (c) => {
    const serverId = c.req.param('id')
    // Operator setting, not a read — require organization:manage.
    const denied = await assertCanManageOr403(c, 'server', serverId)
    if (denied) return denied
    if (!c.get('session')) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const body = await c.req.json().catch(() => null)
    const parsed = parseHardwareProfileBody(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.message }, 400)
    }

    const registry = getDaemonCellRegistry(c)
    if (hardwareProfileUpdateNeedsTopologyValidation(parsed.update)) {
      const topologyError = await validateHardwareProfileTopologyIds(db, serverId, parsed.update)
      if (topologyError) {
        return c.json(topologyError.body, topologyError.status)
      }
    }

    const persisted = await mergeAndPersistHardwareProfile(db, serverId, parsed.update)
    if (persisted.notFound) {
      return c.json({ error: 'Not found' }, 404)
    }

    // Best-effort push: a disconnected daemon must not block the settings
    // save. Fire-and-forget enqueue (not createRequestAndWait) — the daemon
    // replaces its cached profile when the envelope is delivered.
    const pushed = await pushHardwareProfileUpdate(registry, serverId, persisted.merged)

    return c.json({ ok: true, profile: persisted.merged ?? {}, pushed })
  })
}

type HardwareProfileValidationError = {
  status: 503 | 409 | 400
  body: { error: string }
}

/**
 * Confirms a stable topology-id override (`nicSlot1DeviceId` /
 * `nicSlot2DeviceId` / `hostingFilesystemId`) in `update` matches a
 * device/filesystem id in the last topology generation this server reported
 * — never a live daemon round trip, so this works whether or not the daemon
 * is currently connected.
 */
async function validateHardwareProfileTopologyIds(
  db: NonNullable<ReturnType<typeof getDb>>,
  serverId: string,
  update: ServerHardwareProfileUpdate
): Promise<HardwareProfileValidationError | null> {
  const latest = await getLatestTopologyGeneration(db, serverId)
  const invalidField = findInvalidTopologyIdField(
    update,
    latest?.snapshot as TopologyIdValidationSnapshot | undefined
  )
  if (invalidField) {
    return {
      status: 400,
      body: {
        error: `${invalidField} does not match a device/filesystem in the recorded topology`,
      },
    }
  }
  return null
}

type HardwareProfilePersistResult =
  | { notFound: true }
  | {
      notFound: false
      merged: ServerHardwareProfile | undefined
    }

async function mergeAndPersistHardwareProfile(
  db: NonNullable<ReturnType<typeof getDb>>,
  serverId: string,
  update: ServerHardwareProfileUpdate
): Promise<HardwareProfilePersistResult> {
  const rows = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (rows.length === 0) {
    return { notFound: true }
  }

  const rawMetadata = rows[0].metadata
  const metadata: Record<string, unknown> =
    rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {}
  const existing = parseServerHardwareProfile(metadata.hardwareProfile)
  const { profile: merged } = mergeServerHardwareProfile(existing, update, new Date().toISOString())
  // Patch only the hardwareProfile subtree in SQL — the daemon projects
  // resources / docker / geo onto the same column concurrently, so a full
  // read-modify-write of `metadata` could write back a stale object and
  // drop keys a heartbeat landed between our SELECT and UPDATE.
  await db
    .update(server)
    .set({
      metadata: merged
        ? sql`jsonb_set(COALESCE(${server.metadata}, '{}'::jsonb), '{hardwareProfile}', ${JSON.stringify(
            merged
          )}::jsonb)`
        : sql`COALESCE(${server.metadata}, '{}'::jsonb) - 'hardwareProfile'`,
    })
    .where(eq(server.id, serverId))

  return { notFound: false, merged }
}

async function pushHardwareProfileUpdate(
  registry: ReturnType<typeof getDaemonCellRegistry>,
  serverId: string,
  merged: ServerHardwareProfile | undefined
): Promise<boolean> {
  if (!registry) return false

  const requestId = generateRequestId()
  const envelope: DaemonOutboundEnvelope = {
    kind: 'topology-overrides-update',
    deliveryId: generateDeliveryId(),
    requestId,
    overrides: merged ?? {},
    at: new Date().toISOString(),
  }
  cellTrace('request-start', {
    requestId,
    serverId,
    kind: 'topology-overrides-update',
  })
  try {
    await registry.getCell(serverId).enqueue(envelope)
    cellTrace('request-enqueued', {
      requestId,
      serverId,
      kind: 'topology-overrides-update',
      deliveryId: envelope.deliveryId,
    })
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'topology-overrides-update',
      resultStatus: 'error',
      error: message,
    })
    return false
  }
}
