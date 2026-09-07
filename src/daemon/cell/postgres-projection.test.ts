import { assert, assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { ServerMetadata } from '../../lib/db/server-metadata.ts'

/**
 * Metadata as it exists in the `server.metadata` jsonb column, which can carry
 * keys `ServerMetadata` does not model — a daemon is free to report facts the
 * control plane has no field for. The projection must round-trip those
 * untouched rather than dropping them, so the fixtures below carry some.
 */
type StoredServerMetadata = ServerMetadata & Record<string, unknown>
import type { ServerGeo } from '../../lib/geo/server-geo.ts'
import {
  buildDefaultDaemonStatus,
  mapServerDaemonStatusFromColumns,
  parseServerDaemonState,
  type ServerDaemonState,
  type ServerDaemonStatus,
} from '../authn/daemon-state.ts'
import {
  buildProjectionsFromDaemonRows,
  daemonBuildChanged,
  identityFromSnapshot,
  INBOUND_PROJECTION_COALESCE_MS,
  inboundHeartbeatProjectionDue,
  listConnectedServerIdsFromProjection,
  listEnrolledDaemonServerIds,
  listRecentlyOfflineServersForSweep,
  loadServerRowsForFleetPresence,
  mergeDaemonBuildPreserving,
  projectServerDaemon,
  readProjectionsForServers,
  RECENT_OFFLINE_SWEEP_MS,
  rotateSweepBatch,
  steadyStateInboundSkipsDbRead,
} from './postgres-projection.ts'
import { onDaemonDisconnected } from './control-plane-monitor.ts'
import type { ServerStatusEvent } from '../metrics/types-v5.ts'
import { resetServerStatusEventSinkForTests } from '../metrics/status-events.ts'

const serverId = 'srv-projection-test'

/** Canonical 64-char lowercase hex HMAC shape used by real daemons. */
const TEST_MACHINE_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const STALE_MACHINE_KEY = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
/** Raw `/etc/machine-id` shape — must never be persisted as machineKey. */
const RAW_MACHINE_ID = '0123456789abcdef0123456789abcdef'

/**
 * Mock row shape mirrors `getServerDaemonStateByServerId`'s select — `daemon`
 * jsonb (`{ key, projection? }`, never `status`) plus stored fleet-status columns
 * (`connected`, `status_changed_at` only; `daemonStatus` is derived at read time).
 */
type MockRow = {
  daemon: ServerDaemonState
  metadata: StoredServerMetadata | null
  hostname: string | null
  machineKey: string | null
  connected: boolean
  statusChangedAt: string | null
}

function buildMockRow(
  daemon: ServerDaemonState,
  statusOverrides: Partial<Pick<ServerDaemonStatus, 'connected' | 'statusChangedAt'>> = {},
  metadata: StoredServerMetadata | null = null,
  identity: { hostname?: string | null; machineKey?: string | null } = {}
): MockRow {
  const status = { ...buildDefaultDaemonStatus(), ...statusOverrides }
  return {
    daemon,
    metadata,
    hostname: identity.hostname ?? null,
    machineKey: identity.machineKey ?? null,
    connected: status.connected,
    statusChangedAt: status.statusChangedAt,
  }
}

/** Unwrap drizzle `sql\`… || ${json}::jsonb\`` patches used for atomic metadata merges. */
function unwrapMetadataPatch(value: unknown): ServerMetadata | null | undefined {
  if (value === null || value === undefined) return value
  if (typeof value === 'object' && value !== null && 'queryChunks' in value) {
    const chunks = (value as { queryChunks: unknown[] }).queryChunks
    for (const chunk of chunks) {
      if (typeof chunk === 'string') {
        try {
          return JSON.parse(chunk) as ServerMetadata
        } catch {
          // keep scanning
        }
      }
    }
    return undefined
  }
  if (typeof value === 'object') return value as ServerMetadata
  return undefined
}

function applyPatchToRow(row: MockRow, patch: Record<string, unknown>) {
  if ('daemon' in patch) {
    row.daemon = patch.daemon as ServerDaemonState
  }
  if ('metadata' in patch) {
    const incoming = unwrapMetadataPatch(patch.metadata)
    row.metadata =
      incoming === null || incoming === undefined
        ? (incoming ?? null)
        : { ...(row.metadata ?? {}), ...incoming }
  }
  if ('hostname' in patch) row.hostname = patch.hostname as string | null
  if ('machineKey' in patch) row.machineKey = patch.machineKey as string | null
  if ('isConnected' in patch) row.connected = patch.isConnected as boolean
  if ('statusChangedAt' in patch) {
    row.statusChangedAt = patch.statusChangedAt as string | null
  }
}

function mockProjectionUpdateChain(row: MockRow, updateCalls: Array<Record<string, unknown>>) {
  return {
    set: (patch: Record<string, unknown>) => {
      const recorded = { ...patch }
      const unwrapped = unwrapMetadataPatch(patch.metadata)
      if (unwrapped !== undefined) {
        recorded.metadata = unwrapped
      }
      updateCalls.push(recorded)
      applyPatchToRow(row, patch)
      return {
        where: () => Promise.resolve(undefined),
      }
    },
  }
}

function createMockDb(
  initialDaemon: ServerDaemonState,
  statusOverrides: Partial<Pick<ServerDaemonStatus, 'connected' | 'statusChangedAt'>> = {},
  initialMetadata: StoredServerMetadata | null = null,
  identity: { hostname?: string | null; machineKey?: string | null } = {}
): {
  db: Db
  updateCalls: Array<Record<string, unknown>>
  getStatus: () => ServerDaemonStatus
  getDaemon: () => ServerDaemonState
  getMetadata: () => StoredServerMetadata | null
  getIdentity: () => { hostname: string | null; machineKey: string | null }
} {
  const updateCalls: Array<Record<string, unknown>> = []
  const row = buildMockRow(initialDaemon, statusOverrides, initialMetadata, identity)

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([row]),
        }),
      }),
    }),
    update: () => mockProjectionUpdateChain(row, updateCalls),
  } as unknown as Db

  return {
    db,
    updateCalls,
    getStatus: () => mapServerDaemonStatusFromColumns(row),
    getDaemon: () => row.daemon,
    getMetadata: () => row.metadata,
    getIdentity: () => ({ hostname: row.hostname, machineKey: row.machineKey }),
  }
}

/** Simulates a stale metadata read while the live column holds fresher hello facts. */
function createStaleReadMockDb(
  initialDaemon: ServerDaemonState,
  liveMetadata: StoredServerMetadata,
  staleMetadata: StoredServerMetadata,
  statusOverrides: Partial<Pick<ServerDaemonStatus, 'connected' | 'statusChangedAt'>> = {},
  identity: { hostname?: string | null; machineKey?: string | null } = {}
): {
  db: Db
  updateCalls: Array<Record<string, unknown>>
  getMetadata: () => StoredServerMetadata | null
  getIdentity: () => { hostname: string | null; machineKey: string | null }
} {
  const updateCalls: Array<Record<string, unknown>> = []
  const row = buildMockRow(initialDaemon, statusOverrides, liveMetadata, identity)

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ ...row, metadata: staleMetadata }]),
        }),
      }),
    }),
    update: () => mockProjectionUpdateChain(row, updateCalls),
  } as unknown as Db

  return {
    db,
    updateCalls,
    getMetadata: () => row.metadata,
    getIdentity: () => ({ hostname: row.hostname, machineKey: row.machineKey }),
  }
}

const baseKey = {
  id: 'key-1',
  algorithm: 'Ed25519' as const,
  publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
  fingerprint: 'fp-1',
  createdAt: '2020-01-01T00:00:00.000Z',
}

const testDaemonBuild = {
  commit: 'abc123',
  buildId: 'build-1',
  channel: 'trunk',
}

const testGeo: ServerGeo = {
  country: 'US',
  city: 'San Francisco',
  capturedAt: '2020-01-01T00:00:00.000Z',
}

const testGeoUpdated: ServerGeo = {
  country: 'NL',
  city: 'Amsterdam',
  capturedAt: '2020-06-01T00:00:00.000Z',
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('projectServerDaemon online persists metadata.geo when remoteAddress is new', async () => {
  const { db, updateCalls } = createMockDb({ key: baseKey })

  await projectServerDaemon(db, serverId, {
    kind: 'online',
    identity: {
      hostname: 'host-1',
      machineKey: TEST_MACHINE_KEY,
      remoteAddress: '203.0.113.10',
      geo: testGeo,
    },
    connectedAt: '2020-01-01T00:00:00.000Z',
  })

  assertEquals(updateCalls.length, 1)
  assertEquals(updateCalls[0]?.hostname, 'host-1')
  assertEquals(updateCalls[0]?.machineKey, TEST_MACHINE_KEY)
  assertEquals(updateCalls[0]?.metadata, { geo: testGeo })
})

test('projectServerDaemon repeated online backfills metadata.geo when same IP and geo was missing', async () => {
  const connectedAt = '2020-01-01T00:00:00.000Z'
  const cloudflareGeo: ServerGeo = {
    country: 'US',
    city: 'San Francisco',
    region: 'California',
    asn: 13335,
    asOrganization: 'Cloudflare, Inc.',
    datacenter: 'SFO',
    capturedAt: '2020-06-01T00:00:00.000Z',
  }
  const { db, updateCalls } = createMockDb(
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
      statusChangedAt: connectedAt,
    },
    null,
    { hostname: 'host-1', machineKey: TEST_MACHINE_KEY }
  )

  const wrote = await projectServerDaemon(db, serverId, {
    kind: 'online',
    identity: {
      hostname: 'host-1',
      machineKey: TEST_MACHINE_KEY,
      remoteAddress: '203.0.113.10',
      geo: cloudflareGeo,
    },
    connectedAt: '2020-06-01T00:00:00.000Z',
  })

  assertEquals(wrote, true)
  assertEquals(updateCalls.length, 1)
  assertEquals(updateCalls[0]?.metadata, { geo: cloudflareGeo })
})

test('projectServerDaemon repeated online skips write when only geo changed with same IP', async () => {
  const connectedAt = '2020-01-01T00:00:00.000Z'
  const { db, updateCalls } = createMockDb(
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
      statusChangedAt: connectedAt,
    },
    { geo: testGeo },
    { hostname: 'host-1', machineKey: TEST_MACHINE_KEY }
  )

  const wrote = await projectServerDaemon(db, serverId, {
    kind: 'online',
    identity: {
      hostname: 'host-1',
      machineKey: TEST_MACHINE_KEY,
      remoteAddress: '203.0.113.10',
      geo: testGeoUpdated,
    },
    connectedAt: '2020-06-01T00:00:00.000Z',
  })

  assertEquals(wrote, false)
  assertEquals(updateCalls.length, 0)
})

test('projectServerDaemon repeated online refreshes geo when remoteAddress changes', async () => {
  const connectedAt = '2020-01-01T00:00:00.000Z'
  const { db, updateCalls } = createMockDb(
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
      statusChangedAt: connectedAt,
    },
    { geo: testGeo },
    { hostname: 'host-1', machineKey: TEST_MACHINE_KEY }
  )

  const wrote = await projectServerDaemon(db, serverId, {
    kind: 'online',
    identity: {
      hostname: 'host-1',
      machineKey: TEST_MACHINE_KEY,
      remoteAddress: '198.51.100.20',
      geo: testGeoUpdated,
    },
    connectedAt: '2020-06-01T00:00:00.000Z',
  })

  assertEquals(wrote, true)
  assertEquals(updateCalls.length, 1)
  assertEquals(updateCalls[0]?.metadata, { geo: testGeoUpdated })
})

test('projectServerDaemon identity trigger backfills metadata.geo when geo was missing', async () => {
  const { db, updateCalls } = createMockDb(
    {
      key: baseKey,
      projection: {
        hostname: 'host-1',
        machineKey: TEST_MACHINE_KEY,
        remoteAddress: '203.0.113.10',
        daemonBuild: testDaemonBuild,
      },
    },
    {},
    null,
    { hostname: 'host-1', machineKey: TEST_MACHINE_KEY }
  )

  const wrote = await projectServerDaemon(db, serverId, {
    kind: 'identity',
    identity: {
      remoteAddress: '203.0.113.10',
      geo: testGeo,
    },
  })

  assertEquals(wrote, true)
  assertEquals(updateCalls.length, 1)
  assertEquals(updateCalls[0]?.metadata, { geo: testGeo })
})

test('projectServerDaemon identity trigger skips metadata.geo when stored geo exists and IP unchanged', async () => {
  const { db, updateCalls } = createMockDb(
    {
      key: baseKey,
      projection: {
        hostname: 'host-1',
        machineKey: TEST_MACHINE_KEY,
        remoteAddress: '203.0.113.10',
        daemonBuild: testDaemonBuild,
      },
    },
    {},
    { geo: testGeo },
    { hostname: 'host-1', machineKey: TEST_MACHINE_KEY }
  )

  const wrote = await projectServerDaemon(db, serverId, {
    kind: 'identity',
    identity: {
      remoteAddress: '203.0.113.10',
      geo: testGeoUpdated,
    },
  })

  assertEquals(wrote, false)
  assertEquals(updateCalls.length, 0)
})

test('stale identity projection does not clobber fresh timeSync, ips, os, or geo', async () => {
  const freshTimeSync = {
    timezone: 'UTC',
    ntpEnabled: true,
    ntpSynced: true,
    ntpServers: ['time.cloudflare.com'],
    capturedAt: '2026-01-02T00:00:00.000Z',
  }
  const staleTimeSync = {
    timezone: 'America/Chicago',
    ntpEnabled: false,
    ntpServers: ['203.0.113.1'],
    capturedAt: '2020-01-01T00:00:00.000Z',
  }
  const freshIps = [
    { address: '10.0.0.2', version: 4 as const, scope: 'private' as const },
    { address: '203.0.113.50', version: 4 as const, scope: 'public' as const },
  ]
  const staleIps = [{ address: '10.0.0.1', version: 4 as const, scope: 'private' as const }]
  const freshOs = {
    id: 'debian',
    versionId: '13',
    prettyName: 'Debian GNU/Linux 13 (trixie)',
  }
  const staleOs = {
    id: 'debian',
    versionId: '12',
    prettyName: 'Debian GNU/Linux 12 (bookworm)',
  }
  const liveMetadata: StoredServerMetadata = {
    geo: testGeoUpdated,
    os: freshOs,
    timeSync: freshTimeSync,
    ips: freshIps,
  }
  const staleMetadata: StoredServerMetadata = {
    geo: testGeo,
    os: staleOs,
    timeSync: staleTimeSync,
    ips: staleIps,
  }

  const { db, updateCalls, getMetadata, getIdentity } = createStaleReadMockDb(
    {
      key: baseKey,
      projection: {
        hostname: 'stale-host',
        machineKey: STALE_MACHINE_KEY,
        remoteAddress: '203.0.113.10',
      },
    },
    liveMetadata,
    staleMetadata,
    {},
    { hostname: 'stale-host', machineKey: STALE_MACHINE_KEY }
  )

  await projectServerDaemon(db, serverId, {
    kind: 'identity',
    identity: { hostname: 'projected-host' },
  })

  assertEquals(updateCalls.length, 1)
  // Hostname is a dedicated column patch now — never part of the metadata delta.
  assertEquals(updateCalls[0]?.hostname, 'projected-host')
  assertEquals(updateCalls[0]?.metadata, undefined)

  assertEquals(getIdentity().hostname, 'projected-host')
  const metadata = getMetadata()
  assertEquals(metadata?.timeSync, freshTimeSync)
  assertEquals(metadata?.ips, freshIps)
  assertEquals(metadata?.os, freshOs)
  assertEquals(metadata?.geo, testGeoUpdated)
})

test('identity projection does not write ips (resources.ips is owned by touchServerMetadata)', async () => {
  const priorIps = [
    { address: '10.0.0.1', version: 4 as const, scope: 'private' as const },
    { address: '203.0.113.10', version: 4 as const, scope: 'public' as const },
  ]
  const { db, updateCalls } = createMockDb({ key: baseKey }, {}, { resources: { ips: priorIps } })

  await projectServerDaemon(db, serverId, {
    kind: 'identity',
    identity: { remoteAddress: '203.0.113.10' },
  })

  assertEquals(updateCalls.length, 1)
  assertEquals(updateCalls[0]?.metadata, undefined)
})

test('projectServerDaemon online sets status columns and identity columns', async () => {
  const { db, updateCalls, getStatus } = createMockDb({ key: baseKey })

  await projectServerDaemon(db, serverId, {
    kind: 'online',
    identity: { hostname: 'host-1', machineKey: TEST_MACHINE_KEY },
    connectedAt: '2020-01-01T00:00:00.000Z',
  })

  assertEquals(updateCalls.length, 1)
  const status = getStatus()
  assertEquals(status.connected, true)
  assertEquals(status.daemonStatus, 'online')
  assertEquals(status.statusChangedAt, '2020-01-01T00:00:00.000Z')
  assertEquals(updateCalls[0]?.isConnected, true)
  assertEquals(updateCalls[0]?.statusChangedAt, '2020-01-01T00:00:00.000Z')
  assertEquals(updateCalls[0]?.hostname, 'host-1')
  assertEquals(updateCalls[0]?.machineKey, TEST_MACHINE_KEY)
  assertEquals(updateCalls[0]?.metadata, undefined)
  assertEquals('daemonStatus' in updateCalls[0]!, false)
  assertEquals('lastSeenAt' in updateCalls[0]!, false)
  assertEquals('connectedAt' in updateCalls[0]!, false)
  assertEquals('disconnectedAt' in updateCalls[0]!, false)
  // status columns are written directly on the patch — never nested in daemon jsonb.
  const daemonPatch = updateCalls[0]?.daemon as Record<string, unknown> | undefined
  assertEquals(daemonPatch !== undefined && 'status' in daemonPatch, false)
})

test('projectServerDaemon ignores a raw machine-id shaped machineKey on identity columns', async () => {
  const { db, updateCalls } = createMockDb({ key: baseKey })

  await projectServerDaemon(db, serverId, {
    kind: 'online',
    identity: {
      hostname: 'host-1',
      machineKey: RAW_MACHINE_ID,
      remoteAddress: '203.0.113.10',
    },
    connectedAt: '2020-01-01T00:00:00.000Z',
  })

  assertEquals(updateCalls.length, 1)
  assertEquals(updateCalls[0]?.hostname, 'host-1')
  assertEquals(updateCalls[0]?.machineKey, undefined)
})

test('projectServerDaemon repeated online when already connected skips write', async () => {
  const connectedAt = '2020-01-01T00:00:00.000Z'
  const { db, updateCalls } = createMockDb(
    {
      key: baseKey,
      projection: { hostname: 'host-1', machineKey: TEST_MACHINE_KEY },
    },
    {
      connected: true,
      statusChangedAt: connectedAt,
    },
    null,
    { hostname: 'host-1', machineKey: TEST_MACHINE_KEY }
  )

  const wrote = await projectServerDaemon(db, serverId, {
    kind: 'online',
    identity: { hostname: 'host-1', machineKey: TEST_MACHINE_KEY },
    connectedAt: '2020-06-01T00:00:00.000Z',
  })

  assertEquals(wrote, false)
  assertEquals(updateCalls.length, 0)
})

test('projectServerDaemon offline writes connected false and statusChangedAt', async () => {
  const { db, updateCalls, getStatus } = createMockDb(
    {
      key: baseKey,
      projection: {
        hostname: 'host-1',
        daemonBuild: testDaemonBuild,
      },
    },
    {
      connected: true,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    }
  )

  await projectServerDaemon(db, serverId, { kind: 'offline' })

  assertEquals(updateCalls.length, 1)
  const status = getStatus()
  assertEquals(status.connected, false)
  assertEquals(status.daemonStatus, 'offline')
  assertEquals(typeof status.statusChangedAt, 'string')
  assertEquals(updateCalls[0]?.isConnected, false)
  assertEquals(typeof updateCalls[0]?.statusChangedAt, 'string')
  assertEquals('disconnectedAt' in updateCalls[0]!, false)
  assertEquals('lastSeenAt' in updateCalls[0]!, false)
})

test('onDaemonDisconnected projects disconnected status via columns', async () => {
  const { db, updateCalls, getStatus } = createMockDb(
    {
      key: baseKey,
      projection: { hostname: 'host-1' },
    },
    {
      connected: true,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    }
  )

  await onDaemonDisconnected(db, serverId)

  assertEquals(updateCalls.length, 1)
  const status = getStatus()
  assertEquals(status.connected, false)
  assertEquals(status.daemonStatus, 'offline')
  assertEquals(typeof status.statusChangedAt, 'string')
  assertEquals(updateCalls[0]?.isConnected, false)
  assertEquals(typeof updateCalls[0]?.statusChangedAt, 'string')
})

test('projectServerDaemon disconnected matches offline status patch', async () => {
  const { db, updateCalls, getDaemon, getStatus } = createMockDb(
    {
      key: baseKey,
      projection: { hostname: 'host-1', daemonBuild: testDaemonBuild },
    },
    {
      connected: true,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    }
  )

  await projectServerDaemon(db, serverId, { kind: 'disconnected' })

  assertEquals(updateCalls.length, 1)
  const status = getStatus()
  assertEquals(status.connected, false)
  assertEquals(status.daemonStatus, 'offline')
  assertEquals(typeof status.statusChangedAt, 'string')
  assert(updateCalls[0]?.daemon != null)
  assertEquals(getDaemon().projection?.daemonBuild, testDaemonBuild)
})

test('projectServerDaemon heartbeat with unchanged daemonBuild writes nothing', async () => {
  const { db, updateCalls } = createMockDb(
    {
      key: baseKey,
      projection: { daemonBuild: testDaemonBuild },
    },
    {
      connected: true,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    }
  )

  const wrote = await projectServerDaemon(db, serverId, {
    kind: 'heartbeat',
    daemonBuild: testDaemonBuild,
  })

  assertEquals(wrote, false)
  assertEquals(updateCalls.length, 0)
})

test('projectServerDaemon heartbeat with changed daemonBuild updates projection only', async () => {
  const { db, updateCalls, getStatus } = createMockDb(
    {
      key: baseKey,
      projection: { daemonBuild: testDaemonBuild },
    },
    {
      connected: true,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    }
  )

  const wrote = await projectServerDaemon(db, serverId, {
    kind: 'heartbeat',
    daemonBuild: {
      commit: 'new-commit',
      buildId: 'new-build',
    },
  })

  assertEquals(wrote, true)
  assertEquals(updateCalls.length, 1)
  assertEquals('isConnected' in updateCalls[0]!, false)
  assertEquals('statusChangedAt' in updateCalls[0]!, false)
  const status = getStatus()
  assertEquals(status.connected, true)
  assertEquals(status.statusChangedAt, '2020-01-01T00:00:00.000Z')
})

test('projectServerDaemon preserves server.daemon.key on write', async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: { hostname: 'host-1' },
  })

  await projectServerDaemon(db, serverId, {
    kind: 'daemon-build',
    daemonBuild: {
      commit: 'new-commit',
      buildId: 'new-build',
    },
  })

  assert(updateCalls.length >= 1)
  const projectionUpdate = updateCalls.find((call) => call.daemon != null)
  const merged = parseServerDaemonState(projectionUpdate?.daemon)
  assertEquals(merged?.key?.id, baseKey.id)
  assertEquals(merged?.key?.fingerprint, baseKey.fingerprint)
})

test('projectServerDaemon daemonBuild trigger updates jsonb only', async () => {
  const { db, updateCalls, getStatus } = createMockDb({
    key: baseKey,
    projection: { hostname: 'host-1' },
  })

  await projectServerDaemon(db, serverId, {
    kind: 'daemon-build',
    daemonBuild: {
      commit: 'new-commit',
      buildId: 'new-build',
    },
  })

  assertEquals(updateCalls.length, 1)
  // No status columns were part of this patch — status stays at its prior value.
  assertEquals('isConnected' in updateCalls[0]!, false)
  assertEquals('statusChangedAt' in updateCalls[0]!, false)
  const status = getStatus()
  assertEquals(status.connected, false)
  assertEquals(status.statusChangedAt, null)
  assert(updateCalls[0]?.daemon != null)
})

test('projectServerDaemon identity trigger updates jsonb only', async () => {
  const { db, updateCalls, getStatus } = createMockDb({
    key: baseKey,
    projection: {
      hostname: 'old-host',
      daemonBuild: testDaemonBuild,
    },
  })

  await projectServerDaemon(db, serverId, {
    kind: 'identity',
    identity: { hostname: 'new-host' },
  })

  assert(updateCalls.length >= 1)
  const projectionUpdate = updateCalls.find((call) => call.daemon != null)
  assertEquals('isConnected' in (projectionUpdate ?? {}), false)
  const status = getStatus()
  assertEquals(status.connected, false)
  assertEquals(status.statusChangedAt, null)
  const merged = parseServerDaemonState(projectionUpdate?.daemon)
  assertEquals(merged?.projection?.hostname, 'new-host')
  assertEquals(merged?.projection?.daemonBuild, testDaemonBuild)
  assertEquals(projectionUpdate?.hostname, 'new-host')
})

test('projectServerDaemon identity trigger preserves projection.update', async () => {
  const updatingProjection = {
    status: 'updating' as const,
    requestId: 'req-1',
    channel: 'trunk',
    queuedAt: '2020-01-01T00:00:00.000Z',
  }
  const { db, getDaemon } = createMockDb({
    key: baseKey,
    projection: {
      hostname: 'old-host',
      daemonBuild: testDaemonBuild,
      update: updatingProjection,
    },
  })

  await projectServerDaemon(db, serverId, {
    kind: 'identity',
    identity: { hostname: 'new-host' },
  })

  const merged = parseServerDaemonState(getDaemon())
  assertEquals(merged?.projection?.hostname, 'new-host')
  assertEquals(merged?.projection?.daemonBuild, testDaemonBuild)
  assertEquals(merged?.projection?.update, updatingProjection)
})

test('projectServerDaemon online trigger preserves projection.update', async () => {
  const updatingProjection = {
    status: 'updating' as const,
    requestId: 'req-1',
    channel: 'trunk',
    queuedAt: '2020-01-01T00:00:00.000Z',
  }
  const { db, getDaemon } = createMockDb({
    key: baseKey,
    projection: {
      hostname: 'host-1',
      machineKey: TEST_MACHINE_KEY,
      update: updatingProjection,
    },
  })

  await projectServerDaemon(db, serverId, {
    kind: 'online',
    identity: {
      hostname: 'host-1',
      machineKey: TEST_MACHINE_KEY,
      remoteAddress: '__direct__',
    },
    connectedAt: '2020-01-01T00:00:00.000Z',
  })

  const merged = parseServerDaemonState(getDaemon())
  assertEquals(merged?.projection?.remoteAddress, '__direct__')
  assertEquals(merged?.projection?.update, updatingProjection)
})

test('daemonBuildChanged detects optional field backfill for unchanged build', () => {
  const current = {
    daemonBuild: {
      commit: 'abc123',
      buildId: 'build-1',
    },
  }

  assertEquals(
    daemonBuildChanged(current, {
      commit: 'abc123',
      buildId: 'build-1',
      builtAt: '2020-01-02T00:00:00.000Z',
    }),
    true
  )
  assertEquals(
    daemonBuildChanged(current, {
      commit: 'abc123',
      buildId: 'build-1',
      channel: 'trunk',
    }),
    true
  )
  assertEquals(
    daemonBuildChanged(current, {
      commit: 'abc123',
      buildId: 'build-1',
    }),
    false
  )
})

test('mergeDaemonBuildPreserving backfills optional fields for unchanged build', () => {
  const current = {
    daemonBuild: {
      commit: 'abc123',
      buildId: 'build-1',
    },
  }

  assertEquals(
    mergeDaemonBuildPreserving(current, {
      commit: 'abc123',
      buildId: 'build-1',
      builtAt: '2020-01-02T00:00:00.000Z',
      channel: 'trunk',
    }),
    {
      commit: 'abc123',
      buildId: 'build-1',
      builtAt: '2020-01-02T00:00:00.000Z',
      channel: 'trunk',
    }
  )
})

test('readProjectionsForServers derives connectedAt from statusChangedAt when connected', async () => {
  const connectedDaemon: ServerDaemonState = {
    key: baseKey,
    projection: {
      hostname: 'legacy-host',
    },
  }

  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            {
              id: serverId,
              daemon: connectedDaemon,
              connected: true,
              statusChangedAt: '2020-06-01T12:00:00.000Z',
            },
          ]),
      }),
    }),
  } as unknown as Db

  const projections = await readProjectionsForServers(db, [serverId])
  const read = projections.get(serverId)
  assert(read)
  assertEquals(read.connected, true)
  assertEquals(read.connectedAt, '2020-06-01T12:00:00.000Z')
  assertEquals(read.daemonConnectedAt, '2020-06-01T12:00:00.000Z')
  assertEquals('lastSeenAt' in read, false)
  assertEquals('hostname' in read, false)
})

test('projectServerDaemon daemonBuild trigger backfills builtAt for unchanged build', async () => {
  const { db, updateCalls } = createMockDb({
    key: baseKey,
    projection: {
      daemonBuild: {
        commit: 'abc123',
        buildId: 'build-1',
      },
    },
  })

  const wrote = await projectServerDaemon(db, serverId, {
    kind: 'daemon-build',
    daemonBuild: {
      commit: 'abc123',
      buildId: 'build-1',
      builtAt: '2020-01-02T00:00:00.000Z',
      channel: 'trunk',
    },
  })

  assertEquals(wrote, true)
  assertEquals(updateCalls.length, 1)
  const merged = parseServerDaemonState(updateCalls[0]?.daemon)
  assertEquals(merged?.projection?.daemonBuild, {
    commit: 'abc123',
    buildId: 'build-1',
    builtAt: '2020-01-02T00:00:00.000Z',
    channel: 'trunk',
  })
})

test('projectServerDaemon update-expired writes projection.update as expired', async () => {
  const { db, getDaemon } = createMockDb({
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

  const wrote = await projectServerDaemon(db, serverId, {
    kind: 'update-expired',
    requestId: 'req-1',
    finishedAt: '2020-01-01T00:05:00.000Z',
  })

  assertEquals(wrote, true)
  const update = parseServerDaemonState(getDaemon())?.projection?.update
  assertEquals(update?.status, 'expired')
  assertEquals(update?.requestId, 'req-1')
  assertEquals(update?.finishedAt, '2020-01-01T00:05:00.000Z')
})

test('listConnectedServerIdsFromProjection includes rows with connected column set', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ id: serverId, connected: true }]),
      }),
    }),
  } as unknown as Db

  const ids = await listConnectedServerIdsFromProjection(db)
  assertEquals(ids, [serverId])
})

test('inboundHeartbeatProjectionDue is false for unchanged daemonBuild within coalesce window', () => {
  const recentAt = new Date().toISOString()
  const daemonBuild = {
    commit: 'abc123',
    buildId: 'build-1',
    channel: 'trunk' as const,
  }

  assertEquals(
    inboundHeartbeatProjectionDue({
      runtimeConnected: true,
      cellLastSeenAt: recentAt,
      inboundAt: new Date(Date.now() + 1000).toISOString(),
      storedDaemonBuild: daemonBuild,
      incomingDaemonBuild: daemonBuild,
    }),
    false
  )
})

test('inboundHeartbeatProjectionDue is false for heartbeat-only after coalesce window', () => {
  const staleAt = new Date(Date.now() - INBOUND_PROJECTION_COALESCE_MS - 1000).toISOString()
  const daemonBuild = {
    commit: 'abc123',
    buildId: 'build-1',
    channel: 'trunk' as const,
  }

  assertEquals(
    inboundHeartbeatProjectionDue({
      runtimeConnected: true,
      cellLastSeenAt: staleAt,
      inboundAt: new Date().toISOString(),
      storedDaemonBuild: daemonBuild,
      incomingDaemonBuild: daemonBuild,
    }),
    false
  )

  assertEquals(
    inboundHeartbeatProjectionDue({
      runtimeConnected: true,
      cellLastSeenAt: staleAt,
      inboundAt: new Date().toISOString(),
    }),
    false
  )
})

test('inboundHeartbeatProjectionDue is true for daemonBuild change or offline repair', () => {
  const recentAt = new Date().toISOString()
  const stored = {
    commit: 'abc123',
    buildId: 'build-1',
    channel: 'trunk' as const,
  }
  const incoming = {
    commit: 'def456',
    buildId: 'build-2',
    channel: 'trunk' as const,
  }

  assertEquals(
    inboundHeartbeatProjectionDue({
      runtimeConnected: true,
      cellLastSeenAt: recentAt,
      inboundAt: new Date(Date.now() + 1000).toISOString(),
      storedDaemonBuild: stored,
      incomingDaemonBuild: incoming,
    }),
    true
  )

  assertEquals(
    inboundHeartbeatProjectionDue({
      runtimeConnected: false,
      cellLastSeenAt: recentAt,
      inboundAt: new Date().toISOString(),
      storedDaemonBuild: stored,
      incomingDaemonBuild: stored,
    }),
    true
  )
})

test('steadyStateInboundSkipsDbRead skips heartbeat-only after coalesce window', () => {
  const staleAt = new Date(Date.now() - INBOUND_PROJECTION_COALESCE_MS - 1000).toISOString()
  const daemonBuild = {
    commit: 'abc123',
    buildId: 'build-1',
    channel: 'trunk' as const,
  }
  const snapshot = {
    serverId,
    version: 0,
    updatedAt: staleAt,
    connected: true,
    lastSeenAt: staleAt,
    daemonBuild,
  }

  assertEquals(
    steadyStateInboundSkipsDbRead(snapshot, {
      at: new Date().toISOString(),
      daemonBuild,
    }),
    true
  )

  assertEquals(
    steadyStateInboundSkipsDbRead(snapshot, {
      at: new Date().toISOString(),
    }),
    true
  )
})

function offlineServerRow(
  id: string,
  statusChangedAt: string
): {
  id: string
  statusChangedAt: string
} {
  return {
    id,
    statusChangedAt,
  }
}

test('listRecentlyOfflineServersForSweep returns recent offline rows only', async () => {
  const nowMs = Date.parse('2020-06-01T12:00:00.000Z')
  const recentAt = new Date(nowMs - 60_000).toISOString()
  const staleAt = new Date(nowMs - RECENT_OFFLINE_SWEEP_MS - 60_000).toISOString()
  const rows = [
    offlineServerRow('srv-recent-1', recentAt),
    offlineServerRow('srv-recent-2', recentAt),
    offlineServerRow('srv-stale', staleAt),
    ...Array.from({ length: 20 }, (_, index) => offlineServerRow(`srv-old-${index}`, staleAt)),
  ]

  const db = {
    select: () => ({
      from: () => ({
        where: (_predicate: unknown) => ({
          orderBy: (..._order: unknown[]) =>
            Promise.resolve(
              rows
                .filter((row) => {
                  if (!row.statusChangedAt) return false
                  return Date.parse(row.statusChangedAt) >= nowMs - RECENT_OFFLINE_SWEEP_MS
                })
                .sort((a, b) => {
                  const byTime = b.statusChangedAt.localeCompare(a.statusChangedAt)
                  if (byTime !== 0) return byTime
                  return a.id.localeCompare(b.id)
                })
            ),
        }),
      }),
    }),
  } as unknown as Db

  const candidates = await listRecentlyOfflineServersForSweep(db, { nowMs })

  assertEquals(candidates.length, 2)
  assert(candidates.every((row) => row.id.startsWith('srv-recent-')))
  assertEquals(candidates[0]?.offlineAt, recentAt)
  assertEquals(candidates[0]?.connectedAt, recentAt)
  assertEquals(candidates[1]?.offlineAt, recentAt)
  assertEquals(candidates[1]?.connectedAt, recentAt)
})

test('rotateSweepBatch selects candidates beyond the first budget on later ticks', () => {
  const items = Array.from({ length: 1_000 }, (_, index) => ({
    id: `srv-${String(index).padStart(4, '0')}`,
    connectedAt: null,
  }))

  const firstTick = rotateSweepBatch(items, 900, 0)
  const laterTick = rotateSweepBatch(items, 900, 60_000)

  assertEquals(firstTick.length, 900)
  assertEquals(laterTick.length, 900)
  assertEquals(firstTick[0]?.id, 'srv-0000')
  assertEquals(laterTick[0]?.id, 'srv-0900')
  assertEquals(
    firstTick.some((candidate) => candidate.id === 'srv-0999'),
    false
  )
  assertEquals(
    laterTick.some((candidate) => candidate.id === 'srv-0999'),
    true
  )
})

function createStatusEventSink(): {
  sink: { writeStatusEvent: (event: ServerStatusEvent) => void }
  events: ServerStatusEvent[]
} {
  const events: ServerStatusEvent[] = []
  return {
    events,
    sink: {
      writeStatusEvent(event) {
        events.push(event)
      },
    },
  }
}

test('projectServerDaemon emits exactly one status event on a genuine flip', async () => {
  resetServerStatusEventSinkForTests()
  const { sink, events } = createStatusEventSink()
  const { db, updateCalls } = createMockDb(
    { key: baseKey, projection: { hostname: 'host-1' } },
    {
      connected: true,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    }
  )

  await projectServerDaemon(
    db,
    serverId,
    { kind: 'disconnected', reason: 'disconnect' },
    { metrics: sink }
  )

  assertEquals(updateCalls.length, 1)
  assertEquals(events.length, 1)
  assertEquals(events[0]?.serverId, serverId)
  assertEquals(events[0]?.connected, false)
  assertEquals(events[0]?.reason, 'disconnect')
})

test('projectServerDaemon emits zero status events on repeat-offline', async () => {
  resetServerStatusEventSinkForTests()
  const { sink, events } = createStatusEventSink()
  const { db, updateCalls } = createMockDb(
    { key: baseKey },
    {
      connected: false,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    }
  )

  await projectServerDaemon(db, serverId, { kind: 'offline' }, { metrics: sink })

  assertEquals(updateCalls.length, 1)
  assertEquals(events.length, 0)
})

test('projectServerDaemon emits zero status events on heartbeat / identity / daemonBuild / update', async () => {
  resetServerStatusEventSinkForTests()
  const { sink, events } = createStatusEventSink()
  const { db } = createMockDb(
    {
      key: baseKey,
      projection: { daemonBuild: testDaemonBuild, hostname: 'host-1' },
    },
    {
      connected: true,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    },
    null,
    { hostname: 'host-1' }
  )

  await projectServerDaemon(
    db,
    serverId,
    {
      kind: 'heartbeat',
      daemonBuild: { commit: 'new', buildId: 'new-build' },
    },
    { metrics: sink }
  )
  await projectServerDaemon(
    db,
    serverId,
    {
      kind: 'identity',
      identity: { hostname: 'host-2' },
    },
    { metrics: sink }
  )
  await projectServerDaemon(
    db,
    serverId,
    {
      kind: 'daemon-build',
      daemonBuild: { commit: 'newer', buildId: 'newer-build' },
    },
    { metrics: sink }
  )
  await projectServerDaemon(
    db,
    serverId,
    {
      kind: 'update-queued',
      requestId: 'req-1',
      channel: 'trunk',
      queuedAt: '2020-01-02T00:00:00.000Z',
    },
    { metrics: sink }
  )

  assertEquals(events.length, 0)
})

test('projectServerDaemon emits status event only after a successful update', async () => {
  resetServerStatusEventSinkForTests()
  const { sink, events } = createStatusEventSink()
  const row = buildMockRow(
    { key: baseKey, projection: { hostname: 'host-1' } },
    {
      connected: true,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    }
  )
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([row]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.reject(new Error('update failed')),
      }),
    }),
  } as unknown as Db

  let threw = false
  try {
    await projectServerDaemon(db, serverId, { kind: 'disconnected' }, { metrics: sink })
  } catch {
    threw = true
  }

  assertEquals(threw, true)
  assertEquals(events.length, 0)
})

test('identityFromSnapshot extracts hostname machineKey and remoteAddress', () => {
  const identity = identityFromSnapshot({
    serverId,
    version: 1,
    updatedAt: '2020-01-01T00:00:00.000Z',
    connected: true,
    hostname: 'host-1',
    machineKey: TEST_MACHINE_KEY,
    remoteAddress: '__direct__',
  })

  assertEquals(identity.hostname, 'host-1')
  assertEquals(identity.machineKey, TEST_MACHINE_KEY)
  assertEquals(identity.remoteAddress, '__direct__')
})

test('buildProjectionsFromDaemonRows skips rows with no projection and offline status', () => {
  const projections = buildProjectionsFromDaemonRows([
    {
      id: 'srv-empty',
      daemon: { key: baseKey },
      connected: false,
      statusChangedAt: null,
    },
  ])

  assertEquals(projections.size, 0)
})

test('buildProjectionsFromDaemonRows maps connected servers with status timestamps', () => {
  const projections = buildProjectionsFromDaemonRows([
    {
      id: serverId,
      daemon: {
        key: baseKey,
        projection: {
          remoteAddress: '203.0.113.1',
          daemonBuild: { commit: 'abc', buildId: 'build-1' },
        },
      },
      connected: true,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
    },
  ])

  const read = projections.get(serverId)
  assertEquals(read?.connected, true)
  assertEquals(read?.connectedAt, '2020-01-01T00:00:00.000Z')
  assertEquals(read?.remoteAddress, '203.0.113.1')
  assertEquals(read?.daemonBuild?.commit, 'abc')
})

test('loadServerRowsForFleetPresence short-circuits an empty id set', async () => {
  const db = {
    select: () => {
      throw new Error('db must not be queried for an empty id set')
    },
  } as unknown as Db

  assertEquals(await loadServerRowsForFleetPresence(db, []), [])
})

test('loadServerRowsForFleetPresence selects the requested rows', async () => {
  const row = {
    id: serverId,
    daemon: { key: baseKey },
    metadata: null,
    hostname: 'host-1',
    machineKey: null,
    osId: null,
    osFamily: null,
    osVersion: null,
    osCodename: null,
    osPrettyName: null,
    osArchitecture: null,
    timezone: null,
    isTimeSyncEnabled: null,
    ntpServers: null,
    ntpLastSyncedAt: null,
    connected: true,
    statusChangedAt: '2020-01-01T00:00:00.000Z',
  }
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([row]),
      }),
    }),
  } as unknown as Db

  assertEquals(await loadServerRowsForFleetPresence(db, [serverId]), [row])
})

test('listEnrolledDaemonServerIds returns only servers with daemon keys', async () => {
  const db = {
    select: () => ({
      from: () =>
        Promise.resolve([
          { id: 'srv-enrolled', daemon: { key: baseKey } },
          { id: 'srv-bare', daemon: null },
        ]),
    }),
  } as unknown as Db

  const ids = await listEnrolledDaemonServerIds(db)
  assertEquals(ids, ['srv-enrolled'])
})
