import { assert, assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { ServerGeo } from '../../lib/geo/server-geo.ts'
import type { ServerMetadata } from '../../lib/db/server-metadata.ts'
import {
  buildDefaultDaemonStatus,
  mapServerDaemonStatusFromColumns,
  parseServerDaemonState,
  type ServerDaemonState,
  type ServerDaemonStatus,
} from '../authn/daemon-state.ts'
import type { DaemonCellRegistry } from './contracts.ts'
import { DAEMON_OFFLINE_SWEEP_MS } from './protocol.ts'
import {
  onDaemonConnected,
  onDaemonConnectedFromEvidence,
  onDaemonDisconnected,
  onDaemonHeartbeat,
  onDaemonInbound,
  onDaemonUpdateExpired,
  onDaemonUpdateQueued,
  onDaemonUpdateReset,
  onDaemonUpdateResult,
} from './control-plane-monitor.ts'
import { resolveFleetPresence } from './fleet-presence.ts'
import {
  resetTrunkManifestCacheForTests,
  seedTrunkManifestCacheForTests,
} from '../../lib/update/manifest.ts'
import type { ServerStatusEvent } from '../metrics/types.ts'
import {
  resetServerStatusEventSinkForTests,
  setServerStatusEventSink,
} from '../metrics/status-events.ts'

const serverId = 'srv-heartbeat-daemonBuild'

/** Canonical 64-char lowercase hex HMAC shape used by real daemons. */
const TEST_MACHINE_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const testGeo: ServerGeo = {
  country: 'US',
  city: 'San Francisco',
  capturedAt: '2020-01-01T00:00:00.000Z',
}

const baseKey = {
  id: 'key-1',
  algorithm: 'Ed25519' as const,
  publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
  fingerprint: 'fp-1',
  createdAt: '2020-01-01T00:00:00.000Z',
}

/**
 * Mock row shape mirrors `getServerDaemonStateByServerId`'s select — `daemon`
 * jsonb (`{ key, projection? }`, never `status`) plus stored liveness columns
 * (`connected`, `statusChangedAt` only) and identity columns.
 */
type MockRow = {
  id: string
  daemon: ServerDaemonState
  metadata: ServerMetadata | null
  hostname: string | null
  machineKey: string | null
  connected: boolean
  statusChangedAt: string | null
}

function buildMockRow(
  daemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
  identity: { hostname?: string | null; machineKey?: string | null } = {
    hostname: 'host-1',
  },
  metadata: ServerMetadata | null = null
): MockRow {
  const status = { ...buildDefaultDaemonStatus(), ...statusOverrides }
  return {
    id: serverId,
    daemon,
    metadata,
    hostname: identity.hostname ?? null,
    machineKey: identity.machineKey ?? null,
    connected: status.connected,
    statusChangedAt: status.statusChangedAt,
  }
}

/** Unwrap drizzle `sql\`… || ${json}::jsonb\`` metadata patches. */
function unwrapMetadataSqlPatch(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null || value === undefined) return value
  if (typeof value === 'object' && value !== null && 'queryChunks' in value) {
    for (const chunk of (value as { queryChunks: unknown[] }).queryChunks) {
      if (typeof chunk === 'string') {
        try {
          return JSON.parse(chunk) as Record<string, unknown>
        } catch {
          // keep scanning
        }
      }
    }
    return undefined
  }
  if (typeof value === 'object') return value as Record<string, unknown>
  return undefined
}

/** Apply an `.update(server).set(patch)` call onto the mock row in place. */
function applyPatchToRow(row: MockRow, patch: Record<string, unknown>): void {
  if (patch.daemon !== undefined) {
    row.daemon = patch.daemon as ServerDaemonState
  }
  if ('hostname' in patch) row.hostname = patch.hostname as string | null
  if ('machineKey' in patch) row.machineKey = patch.machineKey as string | null
  if ('isConnected' in patch) row.connected = patch.isConnected as boolean
  if ('statusChangedAt' in patch) {
    row.statusChangedAt = patch.statusChangedAt as string | null
  }
  const unwrapped = unwrapMetadataSqlPatch(patch.metadata)
  if (unwrapped !== undefined) {
    row.metadata = unwrapped === null ? null : ({ ...row.metadata, ...unwrapped } as ServerMetadata)
  }
}

function createTrackingDb(
  initialDaemon: ServerDaemonState,
  statusOverrides: Partial<ServerDaemonStatus> = {},
  identity: { hostname?: string | null; machineKey?: string | null } = {
    hostname: 'host-1',
  }
): {
  db: Db
  updateCalls: Array<Record<string, unknown>>
  getSelectCallCount: () => number
  getDaemon: () => ServerDaemonState
  getMetadata: () => ServerMetadata | null
  getStatus: () => ServerDaemonStatus
  getIdentity: () => { hostname: string | null; machineKey: string | null }
} {
  const updateCalls: Array<Record<string, unknown>> = []
  let selectCalls = 0
  const row = buildMockRow(initialDaemon, statusOverrides, identity)

  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          selectCalls += 1
          const rows = Promise.resolve([{ ...row }])
          return Object.assign(rows, { limit: () => rows })
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        const recorded = { ...patch }
        const unwrapped = unwrapMetadataSqlPatch(patch.metadata)
        if (unwrapped !== undefined) {
          recorded.metadata = unwrapped
        }
        updateCalls.push(recorded)
        applyPatchToRow(row, patch)
        return {
          where: () => Promise.resolve(undefined),
        }
      },
    }),
  } as unknown as Db

  return {
    db,
    updateCalls,
    getSelectCallCount: () => selectCalls,
    getDaemon: () => row.daemon,
    getMetadata: () => row.metadata,
    getStatus: () => mapServerDaemonStatusFromColumns(row),
    getIdentity: () => ({ hostname: row.hostname, machineKey: row.machineKey }),
  }
}

function createEmptyRegistry(): DaemonCellRegistry {
  return {
    getCell: () => {
      throw new Error('not used')
    },
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => {
      throw new Error('getSnapshots must not be called')
    },
    purge: () => Promise.resolve(),
  }
}

function createMockCell(snapshot: Record<string, unknown> = {}) {
  return {
    getSnapshot: () =>
      Promise.resolve({
        serverId,
        version: 1,
        updatedAt: new Date().toISOString(),
        connected: true,
        hostname: 'host-1',
        machineKey: TEST_MACHINE_KEY,
        ...snapshot,
      }),
  }
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('onDaemonHeartbeat projects daemonBuild.commit for update status via resolveFleetPresence', async () => {
  const { db, getDaemon } = createTrackingDb(
    { key: baseKey, projection: { hostname: 'host-1' } },
    {
      connected: true,
      statusChangedAt: new Date(Date.now() - 61_000).toISOString(),
    }
  )

  const daemonBuild = {
    commit: 'heartbeat-commit',
    buildId: 'heartbeat-build',
    channel: 'trunk' as const,
  }

  await onDaemonHeartbeat(
    db,
    serverId,
    createMockCell({ connected: true, daemonBuild }) as never,
    daemonBuild
  )

  const merged = parseServerDaemonState(getDaemon())
  assertEquals(merged?.projection?.daemonBuild?.commit, daemonBuild.commit)

  const presence = await resolveFleetPresence(db, createEmptyRegistry(), [serverId])
  const liveDaemonBuild = presence.get(serverId)?.daemonBuild
  assertEquals(liveDaemonBuild?.commit, daemonBuild.commit)
  assertEquals(liveDaemonBuild?.buildId, daemonBuild.buildId)

  const current = liveDaemonBuild?.commit
    ? {
        commit: liveDaemonBuild.commit,
        buildId: liveDaemonBuild.buildId ?? '',
        builtAt: liveDaemonBuild.builtAt ?? '',
      }
    : null
  assertEquals(current?.commit, daemonBuild.commit)
})

test('onDaemonConnected persists optional geo into metadata (hostname/machineKey stay on columns)', async () => {
  const { db, updateCalls } = createTrackingDb(
    { key: baseKey },
    {},
    {
      hostname: 'host-1',
    }
  )

  await onDaemonConnected(
    db,
    serverId,
    createMockCell({
      connectedAt: '2020-01-01T00:00:00.000Z',
      remoteAddress: '203.0.113.10',
    }) as never,
    '2020-01-01T00:00:00.000Z',
    undefined,
    testGeo
  )

  assertEquals(updateCalls.length, 1)
  // hostname/machineKey are dedicated column patches now — never in metadata.
  assertEquals(updateCalls[0]?.machineKey, TEST_MACHINE_KEY)
  assertEquals(updateCalls[0]?.metadata, { geo: testGeo })
})

test('onDaemonInbound backfills metadata.geo when already online', async () => {
  const recentAt = new Date().toISOString()
  const { db, updateCalls, getMetadata } = createTrackingDb(
    {
      key: baseKey,
      projection: {
        hostname: 'host-1',
        machineKey: TEST_MACHINE_KEY,
        remoteAddress: '203.0.113.10',
      },
    },
    {
      connected: true,
      statusChangedAt: recentAt,
    },
    { hostname: 'host-1', machineKey: TEST_MACHINE_KEY }
  )

  await onDaemonInbound(
    db,
    serverId,
    createMockCell({
      connected: true,
      connectedAt: recentAt,
      lastSeenAt: recentAt,
      remoteAddress: '203.0.113.10',
      hostname: 'host-1',
      machineKey: TEST_MACHINE_KEY,
    }) as never,
    { at: recentAt, geo: testGeo }
  )

  assertEquals(
    updateCalls.some(
      (patch) => (patch.metadata as { geo?: ServerGeo } | undefined)?.geo?.country === 'US'
    ),
    true
  )
  assertEquals(getMetadata()?.geo, testGeo)
})

test('onDaemonConnected sets status on dedicated columns', async () => {
  const { db, updateCalls } = createTrackingDb({ key: baseKey })

  await onDaemonConnected(
    db,
    serverId,
    createMockCell({ connectedAt: '2020-01-01T00:00:00.000Z' }) as never,
    '2020-01-01T00:00:00.000Z'
  )

  assertEquals(updateCalls.length, 1)
  assertEquals(updateCalls[0]?.isConnected, true)
  assertEquals(updateCalls[0]?.statusChangedAt, '2020-01-01T00:00:00.000Z')
  // status never lives in the daemon jsonb patch.
  const daemonPatch = updateCalls[0]?.daemon as Record<string, unknown> | undefined
  assertEquals(daemonPatch !== undefined && 'status' in daemonPatch, false)
})

test('onDaemonConnected repeated within 60s skips write when already online', async () => {
  const recent = new Date().toISOString()
  const { db, updateCalls } = createTrackingDb(
    {
      key: baseKey,
      projection: { hostname: 'host-1', machineKey: TEST_MACHINE_KEY },
    },
    {
      connected: true,
      statusChangedAt: recent,
    },
    { hostname: 'host-1', machineKey: TEST_MACHINE_KEY }
  )

  await onDaemonConnected(
    db,
    serverId,
    createMockCell({ connectedAt: '2020-06-01T00:00:00.000Z' }) as never,
    '2020-06-01T00:00:00.000Z'
  )

  assertEquals(updateCalls.length, 0)
})

test('onDaemonDisconnected sets offline status on columns', async () => {
  const { db, updateCalls } = createTrackingDb(
    { key: baseKey, projection: { hostname: 'host-1' } },
    {
      connected: true,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    }
  )

  await onDaemonDisconnected(db, serverId)

  assertEquals(updateCalls.length, 1)
  assertEquals(updateCalls[0]?.isConnected, false)
  assertEquals(typeof updateCalls[0]?.statusChangedAt, 'string')
})

test('onDaemonConnected self-heals Postgres offline when cell is live', async () => {
  const recentAt = new Date().toISOString()
  const { db, updateCalls } = createTrackingDb(
    { key: baseKey, projection: { hostname: 'host-1' } },
    {
      connected: false,
      statusChangedAt: recentAt,
    }
  )

  await onDaemonConnected(
    db,
    serverId,
    createMockCell({
      connected: true,
      connectedAt: recentAt,
      lastSeenAt: recentAt,
    }) as never,
    recentAt
  )

  assertEquals(updateCalls.length, 1)
  assertEquals(updateCalls[0]?.isConnected, true)
})

test('onDaemonConnectedFromEvidence marks online without a cell', async () => {
  const recentAt = new Date().toISOString()
  const connectedAt = '2020-01-01T00:00:00.000Z'
  const { db, updateCalls } = createTrackingDb(
    {
      key: baseKey,
      projection: { hostname: 'host-1', machineKey: TEST_MACHINE_KEY },
    },
    {
      connected: false,
      statusChangedAt: recentAt,
    },
    { hostname: 'host-1', machineKey: TEST_MACHINE_KEY }
  )

  await onDaemonConnectedFromEvidence(db, serverId, connectedAt)

  assertEquals(updateCalls.length, 1)
  assertEquals(updateCalls[0]?.isConnected, true)
  assertEquals(updateCalls[0]?.statusChangedAt, connectedAt)
  const daemon = parseServerDaemonState(updateCalls[0]?.daemon)
  assertEquals(daemon?.projection?.hostname, 'host-1')
  assertEquals(daemon?.projection?.machineKey, TEST_MACHINE_KEY)
})

test('onDaemonHeartbeat within 60s skips DB write when daemonBuild unchanged', async () => {
  const daemonBuild = {
    commit: 'abc123',
    buildId: 'build-1',
    channel: 'trunk' as const,
  }
  const recentAt = new Date().toISOString()
  const { db, updateCalls, getSelectCallCount } = createTrackingDb(
    {
      key: baseKey,
      projection: { daemonBuild },
    },
    {
      connected: true,
      statusChangedAt: recentAt,
    }
  )

  await onDaemonHeartbeat(
    db,
    serverId,
    createMockCell({
      connected: true,
      lastSeenAt: recentAt,
      daemonBuild,
    }) as never,
    daemonBuild,
    new Date(Date.now() + 1000).toISOString()
  )

  assertEquals(updateCalls.length, 0)
  assertEquals(getSelectCallCount(), 0)
})

test('onDaemonHeartbeat after coalesce window skips Postgres for heartbeat-only', async () => {
  const daemonBuild = {
    commit: 'abc123',
    buildId: 'build-1',
    channel: 'trunk' as const,
  }
  const staleAt = new Date(Date.now() - 61_000).toISOString()
  const { db, updateCalls, getSelectCallCount } = createTrackingDb(
    {
      key: baseKey,
      projection: { daemonBuild },
    },
    {
      connected: true,
      statusChangedAt: staleAt,
    }
  )

  await onDaemonHeartbeat(
    db,
    serverId,
    createMockCell({
      connected: true,
      lastSeenAt: staleAt,
      daemonBuild,
    }) as never,
    daemonBuild,
    new Date().toISOString()
  )

  assertEquals(updateCalls.length, 0)
  assertEquals(getSelectCallCount(), 0)

  await onDaemonHeartbeat(
    db,
    serverId,
    createMockCell({ connected: true, lastSeenAt: staleAt }) as never,
    undefined,
    new Date().toISOString()
  )

  assertEquals(updateCalls.length, 0)
  assertEquals(getSelectCallCount(), 0)
})

test('onDaemonInbound projects new daemonBuild before steady-state skip', async () => {
  const daemonBuild = {
    commit: 'abc123',
    buildId: 'build-1',
    channel: 'trunk' as const,
  }
  const recentAt = new Date().toISOString()
  const { db, updateCalls, getDaemon } = createTrackingDb(
    {
      key: baseKey,
      projection: { hostname: 'host-1' },
    },
    {
      connected: true,
      statusChangedAt: recentAt,
    }
  )

  await onDaemonInbound(
    db,
    serverId,
    createMockCell({
      connected: true,
      lastSeenAt: recentAt,
      daemonBuild,
    }) as never,
    { at: new Date(Date.now() + 1000).toISOString(), daemonBuild }
  )

  assertEquals(updateCalls.length, 1)
  assertEquals(getDaemon()?.projection?.daemonBuild?.commit, 'abc123')
})

test('onDaemonInbound repairs stale updating on steady-state hello when daemonBuild matches trunk', async () => {
  resetTrunkManifestCacheForTests()
  seedTrunkManifestCacheForTests({
    commit: 'target-commit',
    buildId: 'b2',
    builtAt: '2020-01-01T00:00:00.000Z',
    channel: 'trunk',
    manifestUrl: 'https://dl.trbp.nl/channels/trunk/manifest.json',
  })

  const daemonBuild = {
    commit: 'target-commit',
    buildId: 'build-1',
    channel: 'trunk' as const,
  }
  const recentAt = new Date().toISOString()
  const { db, updateCalls, getDaemon } = createTrackingDb(
    {
      key: baseKey,
      projection: {
        daemonBuild,
        update: {
          status: 'updating',
          requestId: 'req-1',
          channel: 'trunk',
          queuedAt: '2020-01-01T00:00:00.000Z',
        },
      },
    },
    {
      connected: true,
      statusChangedAt: recentAt,
    }
  )

  await onDaemonInbound(
    db,
    serverId,
    createMockCell({
      connected: true,
      lastSeenAt: recentAt,
      daemonBuild,
    }) as never,
    { at: new Date(Date.now() + 1000).toISOString(), daemonBuild }
  )

  const update = parseServerDaemonState(getDaemon())?.projection?.update
  assertEquals(update?.status, 'done')
  assertEquals(update?.requestId, 'req-1')
  assertEquals(updateCalls.length, 1)
})

test('onDaemonInbound within 60s skips heartbeat write when daemonBuild unchanged', async () => {
  const daemonBuild = {
    commit: 'abc123',
    buildId: 'build-1',
    channel: 'trunk' as const,
  }
  const recentAt = new Date().toISOString()
  const { db, updateCalls, getSelectCallCount } = createTrackingDb(
    {
      key: baseKey,
      projection: { daemonBuild },
    },
    {
      connected: true,
      statusChangedAt: recentAt,
    }
  )

  await onDaemonInbound(
    db,
    serverId,
    createMockCell({
      connected: true,
      lastSeenAt: recentAt,
      daemonBuild,
    }) as never,
    { at: new Date(Date.now() + 1000).toISOString(), daemonBuild }
  )

  assertEquals(updateCalls.length, 0)
  assertEquals(getSelectCallCount(), 2)
})

test('onDaemonHeartbeat projects daemonBuild change to daemon projection', async () => {
  const priorDaemonBuild = {
    commit: 'abc123',
    buildId: 'build-1',
    channel: 'trunk' as const,
  }
  const nextDaemonBuild = {
    commit: 'def456',
    buildId: 'build-2',
    channel: 'trunk' as const,
  }
  const { db, updateCalls, getDaemon } = createTrackingDb(
    {
      key: baseKey,
      projection: { daemonBuild: priorDaemonBuild },
    },
    {
      connected: true,
      statusChangedAt: new Date().toISOString(),
    }
  )

  await onDaemonHeartbeat(
    db,
    serverId,
    createMockCell({ connected: true, daemonBuild: nextDaemonBuild }) as never,
    nextDaemonBuild
  )

  assertEquals(updateCalls.length, 1)
  assertEquals(getDaemon()?.projection?.daemonBuild?.commit, 'def456')

  await onDaemonHeartbeat(
    db,
    serverId,
    createMockCell({ connected: true, daemonBuild: nextDaemonBuild }) as never,
    nextDaemonBuild
  )

  assertEquals(updateCalls.length, 1)
})

test('onDaemonInbound restores online projection after stale sweep', async () => {
  const stale = new Date(Date.now() - DAEMON_OFFLINE_SWEEP_MS - 1000).toISOString()
  const { db, updateCalls } = createTrackingDb(
    {
      key: baseKey,
      projection: {
        hostname: 'host-1',
        daemonBuild: { commit: 'abc', buildId: '1' },
      },
    },
    {
      connected: false,
      statusChangedAt: stale,
    }
  )

  const at = new Date().toISOString()
  await onDaemonInbound(
    db,
    serverId,
    createMockCell({ connected: false, lastSeenAt: stale }) as never,
    {
      at,
      daemonBuild: { commit: 'recovered', buildId: '2', channel: 'trunk' },
    }
  )

  assertEquals(updateCalls.length, 2)
  const onlinePatch = updateCalls.find((patch) => patch.isConnected === true)
  assert(onlinePatch)
  assertEquals(onlinePatch?.isConnected, true)
  assertEquals(typeof onlinePatch?.statusChangedAt, 'string')
})

test('onDaemonUpdateQueued writes projection.update as updating', async () => {
  const { db, getDaemon } = createTrackingDb({ key: baseKey })

  await onDaemonUpdateQueued(db, serverId, 'req-1', 'trunk', '2020-01-01T00:00:00.000Z')

  const update = parseServerDaemonState(getDaemon())?.projection?.update
  assertEquals(update?.status, 'updating')
  assertEquals(update?.requestId, 'req-1')
  assertEquals(update?.channel, 'trunk')
  assertEquals(update?.queuedAt, '2020-01-01T00:00:00.000Z')
})

test('onDaemonUpdateResult writes projection.update as done or failed', async () => {
  const { db, getDaemon } = createTrackingDb({
    key: baseKey,
    projection: {
      update: {
        status: 'updating',
        requestId: 'req-1',
        channel: 'trunk',
        queuedAt: '2020-01-01T00:00:00.000Z',
      },
    },
  })

  await onDaemonUpdateResult(db, serverId, 'req-1', true, '2020-01-01T00:01:00.000Z')

  let update = parseServerDaemonState(getDaemon())?.projection?.update
  assertEquals(update?.status, 'done')
  assertEquals(update?.requestId, 'req-1')
  assertEquals(update?.finishedAt, '2020-01-01T00:01:00.000Z')

  await onDaemonUpdateResult(
    db,
    serverId,
    'req-2',
    false,
    '2020-01-01T00:02:00.000Z',
    'reconcile failed'
  )

  update = parseServerDaemonState(getDaemon())?.projection?.update
  assertEquals(update?.status, 'failed')
  assertEquals(update?.requestId, 'req-2')
  assertEquals(update?.error, 'reconcile failed')
})

test('onDaemonUpdateReset clears projection.update to idle', async () => {
  const { db, getDaemon } = createTrackingDb({
    key: baseKey,
    projection: {
      update: {
        status: 'failed',
        requestId: 'req-1',
        error: 'reconcile failed',
      },
    },
  })

  await onDaemonUpdateReset(db, serverId)

  const update = parseServerDaemonState(getDaemon())?.projection?.update
  assertEquals(update?.status, 'idle')
})

test('onDaemonUpdateExpired writes projection.update as expired', async () => {
  const { db, getDaemon } = createTrackingDb({
    key: baseKey,
    projection: {
      update: {
        status: 'updating',
        requestId: 'req-1',
        channel: 'trunk',
        queuedAt: '2020-01-01T00:00:00.000Z',
      },
    },
  })

  await onDaemonUpdateExpired(db, serverId, 'req-1', '2020-01-01T00:05:00.000Z')

  const update = parseServerDaemonState(getDaemon())?.projection?.update
  assertEquals(update?.status, 'expired')
  assertEquals(update?.requestId, 'req-1')
  assertEquals(update?.finishedAt, '2020-01-01T00:05:00.000Z')
  assertEquals(update?.error, 'Update timed out waiting for daemon acknowledgement')
})

test('repairStaleProjectedUpdate marks done when daemon commit matches trunk', async () => {
  const { db, getDaemon } = createTrackingDb({
    key: baseKey,
    projection: {
      update: {
        status: 'updating',
        requestId: 'req-1',
        channel: 'trunk',
        queuedAt: '2020-01-01T00:00:00.000Z',
      },
    },
  })

  const { repairStaleProjectedUpdate } = await import('./control-plane-monitor.ts')
  const repaired = await repairStaleProjectedUpdate(
    db,
    serverId,
    {
      status: 'updating',
      requestId: 'req-1',
      channel: 'trunk',
      queuedAt: '2020-01-01T00:00:00.000Z',
    },
    {
      currentCommit: 'target-commit',
      targetCommit: 'target-commit',
    }
  )

  assertEquals(repaired, true)
  const update = parseServerDaemonState(getDaemon())?.projection?.update
  assertEquals(update?.status, 'done')
})

test('maybeRepairUpdateFromDaemonBuildHello clears updating when daemonBuild matches trunk', async () => {
  const { db, getDaemon } = createTrackingDb({
    key: baseKey,
    projection: {
      update: {
        status: 'updating',
        requestId: 'req-1',
        channel: 'trunk',
        queuedAt: '2020-01-01T00:00:00.000Z',
      },
    },
  })

  const { maybeRepairUpdateFromDaemonBuildHello } = await import('./control-plane-monitor.ts')
  await maybeRepairUpdateFromDaemonBuildHello(
    db,
    serverId,
    {
      commit: 'target-commit',
      buildId: 'b1',
      channel: 'trunk',
    },
    'target-commit'
  )

  const update = parseServerDaemonState(getDaemon())?.projection?.update
  assertEquals(update?.status, 'done')
  assertEquals(update?.requestId, 'req-1')
})

test('onDaemonDisconnected defaults reason to disconnect', async () => {
  resetServerStatusEventSinkForTests()
  const events: ServerStatusEvent[] = []
  setServerStatusEventSink({
    writeStatusEvent(event) {
      events.push(event)
    },
  })
  const { db } = createTrackingDb(
    { key: baseKey, projection: { hostname: 'host-1' } },
    {
      connected: true,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    }
  )

  await onDaemonDisconnected(db, serverId)

  assertEquals(events.length, 1)
  assertEquals(events[0]?.reason, 'disconnect')
  assertEquals(events[0]?.connected, false)
  resetServerStatusEventSinkForTests()
})

test('onDaemonDisconnected accepts sweep_stale reason', async () => {
  resetServerStatusEventSinkForTests()
  const events: ServerStatusEvent[] = []
  setServerStatusEventSink({
    writeStatusEvent(event) {
      events.push(event)
    },
  })
  const { db } = createTrackingDb(
    { key: baseKey, projection: { hostname: 'host-1' } },
    {
      connected: true,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    }
  )

  await onDaemonDisconnected(db, serverId, undefined, 'sweep_stale')

  assertEquals(events.length, 1)
  assertEquals(events[0]?.reason, 'sweep_stale')
  resetServerStatusEventSinkForTests()
})

test('onDaemonConnectedFromEvidence emits self_heal; onDaemonConnected emits connect', async () => {
  resetServerStatusEventSinkForTests()
  const events: ServerStatusEvent[] = []
  setServerStatusEventSink({
    writeStatusEvent(event) {
      events.push(event)
    },
  })

  const evidence = createTrackingDb(
    { key: baseKey, projection: { hostname: 'host-1' } },
    {
      connected: false,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    }
  )
  await onDaemonConnectedFromEvidence(evidence.db, serverId, '2020-01-01T00:00:00.000Z')
  assertEquals(events.length, 1)
  assertEquals(events[0]?.reason, 'self_heal')
  assertEquals(events[0]?.connected, true)

  events.length = 0
  const socket = createTrackingDb(
    { key: baseKey, projection: { hostname: 'host-1' } },
    {
      connected: false,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    }
  )
  await onDaemonConnected(
    socket.db,
    serverId,
    createMockCell({
      connected: true,
      connectedAt: '2020-06-01T00:00:00.000Z',
    }) as never,
    '2020-06-01T00:00:00.000Z'
  )
  assertEquals(events.length, 1)
  assertEquals(events[0]?.reason, 'connect')
  resetServerStatusEventSinkForTests()
})
