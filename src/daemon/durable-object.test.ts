/// <reference types="@cloudflare/vitest-pool-workers/types" />
/// <reference path="./vitest-env.d.ts" />
/// <reference path="../../worker-configuration.d.ts" />
import { env, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSecretsFromEnv } from '../client/authn/secrets.ts'
import { deriveDaemonJwtKeyring } from './authn/daemon-jwt-keyring.ts'
import type { Db } from '../db.ts'
import type { ServerGeo } from '../lib/geo/server-geo.ts'
import { issueDaemonJwt } from './authn/daemon-jwt.ts'
import {
  buildDefaultDaemonStatus,
  mapServerDaemonStatusFromColumns,
  type ServerDaemonState,
  type ServerDaemonStatus,
} from './authn/daemon-state.ts'
import {
  CELL_SCHEMA_VERSION,
  DaemonCellObject,
  setDaemonCellProjectionDbFactoryForTests,
  setDaemonJwtKeyringFactoryForTests,
  setForceAlarmErrorForTests,
  setForceAutoResponseAgeMsForTests,
  setForceOutboxSendErrorForTests,
} from './cell/do.ts'
import { createDurableObjectDaemonCellRegistry } from './cell/do-registry.ts'
import { TERMINAL_UPDATE_RETENTION_MS } from '../lib/update/constants.ts'
import {
  DAEMON_CELL_PING,
  DAEMON_CELL_PONG,
  DAEMON_OFFLINE_SWEEP_MS,
  generateDeliveryId,
  generateRequestId,
} from './cell/protocol.ts'
import { PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN } from './metrics/capability-plan.ts'

const INBOUND_PROJECTION_COALESCE_MS = 60_000

// `hostname` here models a jsonb key the control plane does not model —
// `hostname` is a dedicated `server` column and `buildMetadataPatch` never
// reads or writes it. The projection must carry such a key through untouched
// rather than reflecting it back into a `metadata` patch.
const DEFAULT_PROJECTION_TEST_METADATA: Record<string, unknown> = {
  hostname: 'host-1',
}

const CELL_HEADER = 'X-Turbopanel-Cell-Server-Id'
const CELL_GEO_HEADER = 'X-Turbopanel-Cell-Geo'

function decodeJwtJti(token: string): string {
  const [, encodedPayload] = token.split('.')
  const padded = encodedPayload + '='.repeat((4 - (encodedPayload.length % 4)) % 4)
  const base64 = padded.replaceAll('-', '+').replaceAll('_', '/')
  const payload = JSON.parse(atob(base64)) as { jti: string }
  return payload.jti
}

async function issueTestDaemonJwt(serverId: string, keyId: string): Promise<string> {
  const secrets = await deriveDaemonJwtKeyring(
    parseSecretsFromEnv(
      {
        TURBOPANEL_SECRET: env.TURBOPANEL_SECRET,
        TURBOPANEL_SECRETS: env.TURBOPANEL_SECRETS,
      },
      'workers'
    )
  )
  const issued = await issueDaemonJwt({ sub: serverId, kid: keyId }, secrets)
  return issued.token
}

function cellRpc(
  stub: DurableObjectStub,
  serverId: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set(CELL_HEADER, serverId)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return stub.fetch(`https://do.internal${path}`, { ...init, headers })
}

async function openDaemonWebSocket(
  stub: DurableObjectStub,
  serverId: string,
  keyId = crypto.randomUUID(),
  options: { geo?: ServerGeo; remoteAddress?: string } = {}
): Promise<{ ws: WebSocket; token: string; tokenId: string; keyId: string }> {
  const token = await issueTestDaemonJwt(serverId, keyId)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Upgrade: 'websocket',
  }
  if (options.geo) {
    headers[CELL_GEO_HEADER] = JSON.stringify(options.geo)
  }
  if (options.remoteAddress) {
    headers['X-Real-IP'] = options.remoteAddress
  }
  const response = await stub.fetch('https://do.internal/ws/daemon/v1', {
    headers,
  })
  expect(response.status).toBe(101)
  const ws = response.webSocket
  if (!ws) throw new Error('missing websocket')
  ws.accept()
  return { ws, token, tokenId: decodeJwtJti(token), keyId }
}

function waitForWebSocketMessage(ws: WebSocket, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for websocket message'))
    }, timeoutMs)
    ws.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer)
        resolve(String(event.data))
      },
      { once: true }
    )
  })
}

async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
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

/**
 * Mock DB matching the `getServerDaemonStateByServerId` column select —
 * fleet status/identity live on dedicated `server` columns, never on the
 * sparse `daemon` jsonb (`{ key, projection? }`).
 */
function createProjectionRecordingDb(
  statusOverrides: Partial<ServerDaemonStatus> = {},
  initialMetadata?: Record<string, unknown>,
  capabilityPlanRows: unknown[] = []
): {
  db: Db
  updateCalls: Array<Record<string, unknown>>
  getSelectCallCount: () => number
  getEndCallCount: () => number
  getStatus: () => ServerDaemonStatus
  setDaemonStatus: (patch: Partial<ServerDaemonStatus>) => void
} {
  const updateCalls: Array<Record<string, unknown>> = []
  let selectCalls = 0
  let endCalls = 0
  let metadata = { ...(initialMetadata ?? DEFAULT_PROJECTION_TEST_METADATA) }
  let daemon: ServerDaemonState = {
    key: {
      id: 'key-1',
      algorithm: 'Ed25519',
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
      fingerprint: 'fp-1',
      createdAt: '2020-01-01T00:00:00.000Z',
    },
    projection: { hostname: 'host-1' },
  }
  let hostname: string | null = null
  let machineKey: string | null = null
  const columns = { ...buildDefaultDaemonStatus(), ...statusOverrides }

  const selectLimit = () => {
    selectCalls += 1
    return Promise.resolve([
      {
        daemon,
        metadata,
        hostname,
        machineKey,
        connected: columns.connected,
        statusChangedAt: columns.statusChangedAt,
      },
    ])
  }

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: selectLimit,
          orderBy: () => ({
            limit: () => Promise.resolve(capabilityPlanRows),
          }),
        }),
        // Presence-ack cache warm (server ⋈ organization) — do not count
        // toward getSelectCallCount(); that tracks daemon-status reads.
        innerJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ options: {} }]),
          }),
        }),
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
        if (patch.daemon !== undefined) {
          daemon = patch.daemon as ServerDaemonState
        }
        if ('hostname' in patch) hostname = patch.hostname as string | null
        if ('machineKey' in patch) {
          machineKey = patch.machineKey as string | null
        }
        if ('isConnected' in patch) {
          columns.connected = patch.isConnected as boolean
        }
        if ('statusChangedAt' in patch) {
          columns.statusChangedAt = patch.statusChangedAt as string | null
        }
        if (unwrapped !== undefined) {
          metadata = unwrapped === null ? {} : { ...metadata, ...unwrapped }
        }
        return {
          where: () => Promise.resolve(undefined),
        }
      },
    }),
    $client: {
      end: () => {
        endCalls += 1
        return Promise.resolve()
      },
    },
  } as unknown as Db

  return {
    db,
    updateCalls,
    getSelectCallCount: () => selectCalls,
    getEndCallCount: () => endCalls,
    getStatus: () => mapServerDaemonStatusFromColumns(columns),
    setDaemonStatus: (patch: Partial<ServerDaemonStatus>) => {
      Object.assign(columns, patch)
    },
  }
}

/** In-memory Postgres double — no Hyperdrive sockets (avoids flaky teardown). */
function createNoopProjectionDb(): Db {
  return createProjectionRecordingDb().db
}

function useNoopProjectionDb(): void {
  setDaemonCellProjectionDbFactoryForTests(createNoopProjectionDb)
}

beforeEach(() => {
  useNoopProjectionDb()
  setDaemonJwtKeyringFactoryForTests(null)
  setForceOutboxSendErrorForTests(null)
  setForceAlarmErrorForTests(null)
  setForceAutoResponseAgeMsForTests(null)
})

afterEach(async () => {
  setDaemonJwtKeyringFactoryForTests(null)
  setForceOutboxSendErrorForTests(null)
  setForceAlarmErrorForTests(null)
  setForceAutoResponseAgeMsForTests(null)
  // Attach/disconnect projections run in ctx.waitUntil — give them a tick to
  // finish on the noop client before the next test reuses the DO isolate.
  await new Promise((resolve) => setTimeout(resolve, 50))
})

/**
 * Fleet status lives on dedicated Drizzle columns in the UPDATE `.set()` patch
 * (`isConnected`, `statusChangedAt`) — never on `patch.daemon` jsonb. Map
 * `isConnected` onto `ServerDaemonStatus.connected` so callers can assert the
 * domain status shape.
 */
function statusFromPatch(
  patch: Record<string, unknown> | undefined
): Partial<ServerDaemonStatus> | undefined {
  if (!patch) return undefined
  const hasConnected = 'isConnected' in patch
  const hasStatusChangedAt = 'statusChangedAt' in patch
  if (!hasConnected && !hasStatusChangedAt) return undefined
  const result: Partial<ServerDaemonStatus> = {}
  if (hasConnected) {
    result.connected = patch.isConnected as boolean
  }
  if (hasStatusChangedAt) {
    result.statusChangedAt = patch.statusChangedAt as ServerDaemonStatus['statusChangedAt']
  }
  return result
}

describe('DaemonCellObject diagnostics', () => {
  it('exposes in-memory counters via /rpc/diagnostics', async () => {
    const serverId = 'test-srv-diagnostics'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        at: new Date().toISOString(),
      })
    )

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId: generateDeliveryId(),
          requestId: generateRequestId(),
          at: new Date().toISOString(),
          commandId: 'diag-cmd',
          commandType: 'ping',
          payload: {},
        },
      }),
    })

    const diagResponse = await cellRpc(stub, serverId, '/rpc/diagnostics', {
      method: 'GET',
    })
    expect(diagResponse.status).toBe(200)
    const diag = (await diagResponse.json()) as {
      backend: string
      usesHibernationWebSocket: boolean
      wsAccepted: number
      heartbeatCount: number
      commandDispatchCount: number
      fetchByRoute: Record<string, number>
      storageReads: number
      storageWrites: number
      storageByCallSite: Record<string, { reads: number; writes: number }>
    }

    expect(diag.usesHibernationWebSocket).toBe(true)
    expect(diag.backend).toBe('durable-object')
    expect(diag.wsAccepted).toBeGreaterThanOrEqual(1)
    expect(diag.heartbeatCount).toBeGreaterThanOrEqual(1)
    expect(diag.commandDispatchCount).toBeGreaterThanOrEqual(1)
    expect(Object.keys(diag.fetchByRoute).length).toBeGreaterThan(0)
    expect(typeof diag.storageReads).toBe('number')
    expect(typeof diag.storageWrites).toBe('number')
    expect(typeof diag.storageByCallSite).toBe('object')

    ws.close(1000, 'test done')
  })

  it('populates storage counters when TURBOPANEL_DAEMON_DEBUG is enabled', async () => {
    const prev = env.TURBOPANEL_DAEMON_DEBUG
    env.TURBOPANEL_DAEMON_DEBUG = '1'
    try {
      const serverId = 'test-srv-diagnostics-debug'
      const stub = env.DAEMON_CELL.getByName(serverId)
      const { ws } = await openDaemonWebSocket(stub, serverId)

      ws.send(
        JSON.stringify({
          type: 'heartbeat',
          at: new Date().toISOString(),
        })
      )

      await cellRpc(stub, serverId, '/rpc/enqueue', {
        method: 'POST',
        body: JSON.stringify({
          outbound: {
            kind: 'command-dispatch',
            deliveryId: generateDeliveryId(),
            requestId: generateRequestId(),
            at: new Date().toISOString(),
            commandId: 'diag-debug-cmd',
            commandType: 'ping',
            payload: {},
          },
        }),
      })

      const diagResponse = await cellRpc(stub, serverId, '/rpc/diagnostics', {
        method: 'GET',
      })
      const diag = (await diagResponse.json()) as {
        storageReads: number
        storageWrites: number
        storageByCallSite: Record<string, { reads: number; writes: number }>
      }

      expect(diag.storageReads).toBeGreaterThan(0)
      expect(diag.storageWrites).toBeGreaterThan(0)
      expect(Object.keys(diag.storageByCallSite).length).toBeGreaterThan(0)

      ws.close(1000, 'test done')
    } finally {
      env.TURBOPANEL_DAEMON_DEBUG = prev
    }
  })

  it('enqueue RPC returns quickly without blocking in the DO', async () => {
    const serverId = 'test-srv-enqueue-fast'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()

    const start = Date.now()
    const enqueueResponse = await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId: generateDeliveryId(),
          requestId,
          at: new Date().toISOString(),
          commandId: 'fast-cmd',
          commandType: 'ping',
          payload: {},
        },
      }),
    })
    const elapsed = Date.now() - start

    expect(enqueueResponse.status).toBe(200)
    const body = (await enqueueResponse.json()) as { status: string }
    expect(body.status).toBe('queued')
    expect(elapsed).toBeLessThan(2000)
  })

  it('idle cell has no alarm; coalesced heartbeat skips DB', async () => {
    const serverId = 'test-srv-diag-idle-alarm'
    const { db, updateCalls, getEndCallCount } = createProjectionRecordingDb({
      connected: false,
    })

    setDaemonCellProjectionDbFactoryForTests(() => db)

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0)
    })

    const updatesAfterConnect = updateCalls.length
    const endAfterConnect = getEndCallCount()

    await runInDurableObject(stub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm()
      expect(alarm).toBeNull()
    })

    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        at: new Date(Date.now() + 1000).toISOString(),
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(updateCalls).toHaveLength(updatesAfterConnect)
    expect(getEndCallCount()).toBe(endAfterConnect)

    ws.close(1000, 'test done')
  }, 10_000)

  it('idle connected cell does not schedule recurring sweep alarm', async () => {
    const serverId = 'test-srv-no-coalesce-alarm-loop'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await runInDurableObject(stub, async (instance: DaemonCellObject, state) => {
      await instance.alarm()

      const alarm = await state.storage.getAlarm()
      expect(alarm).toBeNull()
    })

    ws.close(1000, 'test done')
  }, 10_000)

  it('idle connected cell does not re-arm sweep alarm across repeated alarm() calls', async () => {
    const serverId = 'test-srv-idle-no-sweep-rearm'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await runInDurableObject(stub, async (instance: DaemonCellObject, state) => {
      await instance.alarm()
      expect(await state.storage.getAlarm()).toBeNull()
      await instance.alarm()
      expect(await state.storage.getAlarm()).toBeNull()
      await instance.alarm()
      expect(await state.storage.getAlarm()).toBeNull()
    })

    ws.close(1000, 'test done')
  }, 10_000)

  it('setAlarm skips write when alarm target is unchanged', async () => {
    const prev = env.TURBOPANEL_DAEMON_DEBUG
    env.TURBOPANEL_DAEMON_DEBUG = '1'
    try {
      const serverId = 'test-srv-alarm-noop-reschedule'
      const stub = env.DAEMON_CELL.getByName(serverId)
      const { ws } = await openDaemonWebSocket(stub, serverId)

      const diagBeforeResp = await cellRpc(stub, serverId, '/rpc/diagnostics', {
        method: 'GET',
      })
      const diagBefore = (await diagBeforeResp.json()) as {
        storageByCallSite: Record<string, { writes: number }>
      }
      const writesBefore = diagBefore.storageByCallSite['schedule-alarm']?.writes ?? 0

      await runInDurableObject(stub, async (instance: DaemonCellObject) => {
        await instance.alarm()
        await instance.alarm()
      })

      const diagAfterResp = await cellRpc(stub, serverId, '/rpc/diagnostics', {
        method: 'GET',
      })
      const diagAfter = (await diagAfterResp.json()) as {
        storageByCallSite: Record<string, { writes: number }>
      }
      const writesAfter = diagAfter.storageByCallSite['schedule-alarm']?.writes ?? 0

      expect(writesAfter - writesBefore).toBeLessThanOrEqual(1)

      ws.close(1000, 'test done')
    } finally {
      env.TURBOPANEL_DAEMON_DEBUG = prev
    }
  }, 10_000)

  it('steady-state heartbeat performs zero cell-table writes', async () => {
    const prev = env.TURBOPANEL_DAEMON_DEBUG
    env.TURBOPANEL_DAEMON_DEBUG = '1'
    try {
      const serverId = 'test-srv-zero-steady-state-writes'
      const stub = env.DAEMON_CELL.getByName(serverId)
      const { ws } = await openDaemonWebSocket(stub, serverId)

      const diagBeforeResp = await cellRpc(stub, serverId, '/rpc/diagnostics', {
        method: 'GET',
      })
      const diagBefore = (await diagBeforeResp.json()) as {
        storageByCallSite: Record<string, { writes: number }>
      }

      ws.send(
        JSON.stringify({
          type: 'heartbeat',
          at: new Date().toISOString(),
        })
      )
      await new Promise((resolve) => setTimeout(resolve, 300))

      const diagAfterResp = await cellRpc(stub, serverId, '/rpc/diagnostics', {
        method: 'GET',
      })
      const diagAfter = (await diagAfterResp.json()) as {
        storageByCallSite: Record<string, { writes: number }>
      }

      const recordInboundWrites =
        (diagAfter.storageByCallSite['record-inbound']?.writes ?? 0) -
        (diagBefore.storageByCallSite['record-inbound']?.writes ?? 0)
      expect(recordInboundWrites).toBe(0)

      const livenessWrites =
        (diagAfter.storageByCallSite['ws-message-liveness']?.writes ?? 0) -
        (diagBefore.storageByCallSite['ws-message-liveness']?.writes ?? 0)
      expect(livenessWrites).toBe(0)

      ws.close(1000, 'test done')
    } finally {
      env.TURBOPANEL_DAEMON_DEBUG = prev
    }
  }, 10_000)

  it('liveness wake is SQLite-free after construct', async () => {
    const prev = env.TURBOPANEL_DAEMON_DEBUG
    env.TURBOPANEL_DAEMON_DEBUG = '1'
    try {
      const serverId = 'test-srv-liveness-sqlite-free'
      const stub = env.DAEMON_CELL.getByName(serverId)
      const { ws } = await openDaemonWebSocket(stub, serverId)

      const diagBeforeResp = await cellRpc(stub, serverId, '/rpc/diagnostics', {
        method: 'GET',
      })
      const diagBefore = (await diagBeforeResp.json()) as {
        storageReads: number
        storageWrites: number
        storageByCallSite: Record<string, { reads: number; writes: number }>
      }

      const livenessResp = await cellRpc(stub, serverId, '/rpc/liveness', {
        method: 'GET',
      })
      expect(livenessResp.status).toBe(200)

      const diagAfterResp = await cellRpc(stub, serverId, '/rpc/diagnostics', {
        method: 'GET',
      })
      const diagAfter = (await diagAfterResp.json()) as {
        storageReads: number
        storageWrites: number
        storageByCallSite: Record<string, { reads: number; writes: number }>
      }

      expect(diagAfter.storageReads - diagBefore.storageReads).toBe(0)
      expect(diagAfter.storageWrites - diagBefore.storageWrites).toBe(0)

      for (const site of ['constructor', 'ensure-schema', 'snapshot'] as const) {
        // JSON.parse rehydrates a normal Object — use hasOwn so "constructor"
        // is not Object.prototype.constructor.
        const before = Object.hasOwn(diagBefore.storageByCallSite, site)
          ? diagBefore.storageByCallSite[site]
          : { reads: 0, writes: 0 }
        const after = Object.hasOwn(diagAfter.storageByCallSite, site)
          ? diagAfter.storageByCallSite[site]
          : { reads: 0, writes: 0 }
        expect(after.reads - before.reads).toBe(0)
        expect(after.writes - before.writes).toBe(0)
      }

      ws.close(1000, 'test done')
    } finally {
      env.TURBOPANEL_DAEMON_DEBUG = prev
    }
  }, 10_000)

  it('schema is version-stamped and cold wake does not grow ensure-schema writes', async () => {
    const prev = env.TURBOPANEL_DAEMON_DEBUG
    env.TURBOPANEL_DAEMON_DEBUG = '1'
    try {
      const serverId = 'test-srv-schema-version-stamp'
      const stub = env.DAEMON_CELL.getByName(serverId)
      const { ws } = await openDaemonWebSocket(stub, serverId)

      await runInDurableObject(stub, (_instance, state) => {
        const row = [
          ...state.storage.sql.exec('SELECT version FROM _cell_schema WHERE id = 1'),
        ][0] as { version?: number } | undefined
        expect(Number(row?.version ?? 0)).toBe(CELL_SCHEMA_VERSION)
      })

      // Cold wake against already-stamped SQLite: reconstruct a new DO instance
      // on the same storage. A storage RPC (`/rpc/snapshot`) must SELECT the
      // version only — no CREATE / INSERT under the ensure-schema call site.
      // Diagnostics alone must not touch schema (in-memory counters only).
      const ensureCold = await runInDurableObject(stub, async (_instance, state) => {
        const cold = new DaemonCellObject(state, env)
        const snapshotResp = await cold.fetch(
          new Request('https://do.internal/rpc/snapshot', {
            method: 'GET',
            headers: { [CELL_HEADER]: serverId },
          })
        )
        expect(snapshotResp.status).toBe(200)
        const response = await cold.fetch(
          new Request('https://do.internal/rpc/diagnostics', {
            method: 'GET',
            headers: { [CELL_HEADER]: serverId },
          })
        )
        const diag = (await response.json()) as {
          storageByCallSite: Record<string, { reads: number; writes: number }>
        }
        return (
          diag.storageByCallSite['ensure-schema'] ?? {
            reads: 0,
            writes: 0,
          }
        )
      })

      expect(ensureCold.writes).toBe(0)
      expect(ensureCold.reads).toBeGreaterThanOrEqual(1)

      // Live DO still has `#schemaReady` — liveness must not grow counters.
      const diagBeforeResp = await cellRpc(stub, serverId, '/rpc/diagnostics', {
        method: 'GET',
      })
      const diagBefore = (await diagBeforeResp.json()) as {
        storageByCallSite: Record<string, { reads: number; writes: number }>
      }
      const ensureBefore = diagBefore.storageByCallSite['ensure-schema'] ?? {
        reads: 0,
        writes: 0,
      }

      const livenessResp = await cellRpc(stub, serverId, '/rpc/liveness', {
        method: 'GET',
      })
      expect(livenessResp.status).toBe(200)

      const diagAfterResp = await cellRpc(stub, serverId, '/rpc/diagnostics', {
        method: 'GET',
      })
      const diagAfter = (await diagAfterResp.json()) as {
        storageByCallSite: Record<string, { reads: number; writes: number }>
      }
      const ensureAfter = diagAfter.storageByCallSite['ensure-schema'] ?? {
        reads: 0,
        writes: 0,
      }

      expect(ensureAfter.reads - ensureBefore.reads).toBe(0)
      expect(ensureAfter.writes - ensureBefore.writes).toBe(0)

      ws.close(1000, 'test done')
    } finally {
      env.TURBOPANEL_DAEMON_DEBUG = prev
    }
  }, 10_000)

  it('socket-less liveness uses header and touches no cell row', async () => {
    const prev = env.TURBOPANEL_DAEMON_DEBUG
    env.TURBOPANEL_DAEMON_DEBUG = '1'
    try {
      const serverId = 'test-srv-liveness-socketless-no-cell'
      const stub = env.DAEMON_CELL.getByName(serverId)

      // Stamp schema without leaving a live socket (attach then close).
      const { ws } = await openDaemonWebSocket(stub, serverId)
      ws.close(1000, 'seed done')
      await waitFor(async () => {
        await runInDurableObject(stub, (_instance, state) => {
          expect([
            ...state.storage.sql.exec('SELECT version FROM _cell_schema WHERE id = 1'),
          ]).toHaveLength(1)
        })
      })

      // Cold reconstruct with no restored socket: constructor must not SELECT
      // from `cell`. Liveness resolves serverId from the header only.
      const coldCounts = await runInDurableObject(stub, async (_instance, state) => {
        const cold = new DaemonCellObject(state, env)
        const response = await cold.fetch(
          new Request('https://do.internal/rpc/liveness', {
            method: 'GET',
            headers: { [CELL_HEADER]: serverId },
          })
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          connected: boolean
          lastPingAtMs: number | null
        }
        expect(body.connected).toBe(false)
        expect(body.lastPingAtMs).toBeNull()

        const diagResp = await cold.fetch(
          new Request('https://do.internal/rpc/diagnostics', {
            method: 'GET',
            headers: { [CELL_HEADER]: serverId },
          })
        )
        const diag = (await diagResp.json()) as {
          storageByCallSite: Record<string, { reads: number; writes: number }>
        }
        const site = (name: string) =>
          Object.hasOwn(diag.storageByCallSite, name)
            ? diag.storageByCallSite[name]
            : { reads: 0, writes: 0 }
        return {
          constructorSite: site('constructor'),
          resolve: site('resolve-server-id'),
          ensure: site('ensure-schema'),
        }
      })

      expect(coldCounts.constructorSite.reads).toBe(0)
      expect(coldCounts.constructorSite.writes).toBe(0)
      expect(coldCounts.resolve.reads).toBe(0)
      expect(coldCounts.resolve.writes).toBe(0)
      expect(coldCounts.ensure.writes).toBe(0)
    } finally {
      env.TURBOPANEL_DAEMON_DEBUG = prev
    }
  }, 10_000)
})

describe('DaemonCellObject', () => {
  it('projects connect to Postgres after websocket attach', async () => {
    const serverId = 'test-srv-proj-connect'
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: false,
    })
    setDaemonCellProjectionDbFactoryForTests(() => db)

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      const connectedPatch = updateCalls.find((patch) => statusFromPatch(patch)?.connected === true)
      expect(connectedPatch).toBeDefined()
      const status = statusFromPatch(connectedPatch)
      expect(typeof status?.statusChangedAt).toEqual(expect.any(String))
    })

    ws.close(1000, 'test done')
  })

  it('replays the latest recorded capability plan to a hosted daemon on reconnect', async () => {
    const serverId = 'test-srv-capability-plan-replay'
    const { db } = createProjectionRecordingDb({ connected: false }, undefined, [
      {
        generation: 4,
        planHash: 'hash',
        plan: PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
        appliedAt: '2026-01-01T00:00:00.000Z',
        serverId,
      },
    ])
    setDaemonCellProjectionDbFactoryForTests(() => db)

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)
    const raw = await waitForWebSocketMessage(ws)
    const msg = JSON.parse(raw) as {
      type: string
      generation?: number
      plan?: typeof PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN
    }
    expect(msg.type).toBe('capability-plan-update')
    expect(msg.generation).toBe(4)
    expect(msg.plan).toEqual(PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN)

    ws.close(1000, 'test done')
  })

  it('projects connect geo header into metadata.geo', async () => {
    const serverId = 'test-srv-proj-connect-geo'
    const geo: ServerGeo = {
      country: 'US',
      city: 'San Francisco',
      capturedAt: '2020-01-01T00:00:00.000Z',
    }
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: false,
    })
    setDaemonCellProjectionDbFactoryForTests(() => db)

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId, crypto.randomUUID(), {
      geo,
      remoteAddress: '203.0.113.10',
    })

    await waitFor(() => {
      const connectedPatch = updateCalls.find((patch) => statusFromPatch(patch)?.connected === true)
      expect(connectedPatch).toBeDefined()
      // hostname lives on a dedicated `server` column now — `buildMetadataPatch`
      // never writes it into the `metadata` jsonb delta.
      expect(connectedPatch?.metadata).toEqual({ geo })
    })

    ws.close(1000, 'test done')
  })

  it('projects disconnect to Postgres after websocket close', async () => {
    const serverId = 'test-srv-proj-disconnect'
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: false,
    })
    setDaemonCellProjectionDbFactoryForTests(() => db)

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      expect(updateCalls.some((patch) => statusFromPatch(patch)?.connected === true)).toBe(true)
    })

    ws.close(1000, 'test done')

    await waitFor(() => {
      const disconnectedPatch = updateCalls.find(
        (patch) => statusFromPatch(patch)?.connected === false
      )
      expect(disconnectedPatch).toBeDefined()
      expect(statusFromPatch(disconnectedPatch)?.connected).toBe(false)
      expect(typeof statusFromPatch(disconnectedPatch)?.statusChangedAt).toEqual(expect.any(String))
    })
  }, 10_000)

  it('projects daemonBuild change on heartbeat when commit changes', async () => {
    const serverId = 'test-srv-proj-heartbeat-daemonBuild'
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
    const { db, updateCalls, setDaemonStatus } = createProjectionRecordingDb({
      connected: true,
      statusChangedAt: new Date().toISOString(),
    })
    setDaemonCellProjectionDbFactoryForTests(() => db)

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0)
    })

    const countBeforeHeartbeat = updateCalls.length

    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        at: new Date().toISOString(),
        daemonBuild: priorDaemonBuild,
      })
    )

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(countBeforeHeartbeat)
    })

    setDaemonStatus({
      connected: true,
      statusChangedAt: new Date().toISOString(),
    })

    const countAfterFirstHeartbeat = updateCalls.length

    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        at: new Date(Date.now() + INBOUND_PROJECTION_COALESCE_MS + 1000).toISOString(),
        daemonBuild: priorDaemonBuild,
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(updateCalls).toHaveLength(countAfterFirstHeartbeat)

    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        at: new Date(Date.now() + INBOUND_PROJECTION_COALESCE_MS + 2000).toISOString(),
        daemonBuild: nextDaemonBuild,
      })
    )

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(countAfterFirstHeartbeat)
    })

    ws.close(1000, 'test done')
  }, 10_000)

  it('steady-state heartbeat performs no DB write or connection open', async () => {
    const serverId = 'test-srv-proj-heartbeat-idle'
    const { db, updateCalls, getSelectCallCount, getEndCallCount, setDaemonStatus } =
      createProjectionRecordingDb({
        connected: false,
      })

    let factoryCalls = 0
    setDaemonCellProjectionDbFactoryForTests(() => {
      factoryCalls += 1
      return db
    })

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0)
    })

    const factoryAfterConnect = factoryCalls
    const updatesAfterConnect = updateCalls.length
    const endAfterConnect = getEndCallCount()
    const selectsAfterConnect = getSelectCallCount()
    const recentAt = new Date().toISOString()

    setDaemonStatus({
      connected: true,
      statusChangedAt: recentAt,
    })

    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        at: new Date(Date.now() + 1000).toISOString(),
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(factoryCalls).toBe(factoryAfterConnect)
    expect(updateCalls).toHaveLength(updatesAfterConnect)
    expect(getSelectCallCount()).toBe(selectsAfterConnect)
    expect(getEndCallCount()).toBe(endAfterConnect)

    ws.close(1000, 'test done')
  }, 10_000)

  it('closes projection postgres client after each write', async () => {
    const serverId = 'test-srv-proj-db-dispose'
    const { db, updateCalls, getEndCallCount } = createProjectionRecordingDb({
      connected: false,
    })
    setDaemonCellProjectionDbFactoryForTests(() => db)

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0)
      expect(getEndCallCount()).toBeGreaterThan(0)
    })

    ws.close(1000, 'test done')
  })

  it('steady-state heartbeat skips DB open', async () => {
    const serverId = 'test-srv-heartbeat-skip-db-open'
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: false,
    })

    let factoryCalls = 0
    setDaemonCellProjectionDbFactoryForTests(() => {
      factoryCalls += 1
      return db
    })

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0)
    })

    const factoryAfterConnect = factoryCalls

    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        at: new Date(Date.now() + 1000).toISOString(),
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(factoryCalls).toBe(factoryAfterConnect)

    ws.close(1000, 'test done')
  }, 10_000)

  it('heartbeat-only after coalesce window skips projection DB open', async () => {
    const serverId = 'test-srv-heartbeat-after-coalesce-skip-db'
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: false,
    })

    let factoryCalls = 0
    setDaemonCellProjectionDbFactoryForTests(() => {
      factoryCalls += 1
      return db
    })

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0)
    })

    const factoryAfterConnect = factoryCalls
    const updatesAfterConnect = updateCalls.length

    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        at: new Date(Date.now() + INBOUND_PROJECTION_COALESCE_MS + 1000).toISOString(),
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(factoryCalls).toBe(factoryAfterConnect)
    expect(updateCalls).toHaveLength(updatesAfterConnect)

    ws.close(1000, 'test done')
  }, 10_000)

  it('alarm stale-sweep with no demotions skips DB', async () => {
    const serverId = 'test-srv-alarm-no-demotions-skip-db'
    const recentAt = new Date().toISOString()
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: true,
      statusChangedAt: recentAt,
    })

    let factoryCalls = 0
    setDaemonCellProjectionDbFactoryForTests(() => {
      factoryCalls += 1
      return db
    })

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0)
    })

    const factoryAfterConnect = factoryCalls

    await runInDurableObject(stub, async (instance: DaemonCellObject) => {
      await instance.alarm()
    })

    expect(factoryCalls).toBe(factoryAfterConnect)

    ws.close(1000, 'test done')
  }, 10_000)

  it('alarm update-expiry opens and closes DB', async () => {
    const serverId = 'test-srv-alarm-update-expiry-db-lifecycle'
    const { db, getEndCallCount } = createProjectionRecordingDb({
      connected: true,
      statusChangedAt: new Date().toISOString(),
    })

    let factoryCalls = 0
    setDaemonCellProjectionDbFactoryForTests(() => {
      factoryCalls += 1
      return db
    })

    const stub = env.DAEMON_CELL.getByName(serverId)

    // No live socket — we own the alarm clock (avoids racing the scheduled alarm).
    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'update',
          deliveryId: generateDeliveryId(),
          requestId: generateRequestId(),
          at: new Date().toISOString(),
          channel: 'trunk',
        },
        opts: { ttlSeconds: 1 },
      }),
    })

    const factoryBeforeAlarm = factoryCalls
    const endBeforeAlarm = getEndCallCount()

    await new Promise((resolve) => setTimeout(resolve, 1100))

    await runInDurableObject(stub, async (instance: DaemonCellObject) => {
      await instance.alarm()
    })

    await waitFor(() => {
      // Auto-alarm may already have run during the wait; either path must open DB.
      expect(factoryCalls).toBeGreaterThanOrEqual(factoryBeforeAlarm + 1)
      expect(getEndCallCount()).toBeGreaterThanOrEqual(endBeforeAlarm + 1)
    })
  }, 10_000)

  it('accepts hibernation-safe WebSocket attach with valid JWT', async () => {
    const serverId = 'test-srv-1'
    const keyId = crypto.randomUUID()
    const stub = env.DAEMON_CELL.getByName(serverId)

    const { ws } = await openDaemonWebSocket(stub, serverId, keyId)

    const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'GET',
    })
    const snapshot = (await snapshotResponse.json()) as {
      connected: boolean
    }
    expect(snapshot.connected).toBe(true)

    ws.close(1000, 'test done')
  })

  it('rejects WS upgrade with 401 when Authorization is missing', async () => {
    const serverId = 'test-srv-ws-auth-missing'
    const stub = env.DAEMON_CELL.getByName(serverId)

    const response = await stub.fetch('https://do.internal/ws/daemon/v1', {
      headers: { Upgrade: 'websocket' },
    })
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Unauthorized')
    expect(response.webSocket).toBeNull()
  })

  it('rejects WS upgrade with 401 when the daemon JWT is invalid', async () => {
    const serverId = 'test-srv-ws-auth-invalid'
    const stub = env.DAEMON_CELL.getByName(serverId)

    const response = await stub.fetch('https://do.internal/ws/daemon/v1', {
      headers: {
        Upgrade: 'websocket',
        Authorization: 'Bearer not-a-valid-jwt',
      },
    })
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Unauthorized')
    expect(response.webSocket).toBeNull()
  })

  it('rejects WS upgrade with 401 when Bearer token is empty', async () => {
    const serverId = 'test-srv-ws-auth-empty-bearer'
    const stub = env.DAEMON_CELL.getByName(serverId)

    const response = await stub.fetch('https://do.internal/ws/daemon/v1', {
      headers: {
        Upgrade: 'websocket',
        Authorization: 'Bearer ',
      },
    })
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Unauthorized')
  })

  it('rejects WS upgrade with 503 when JWT keyring derivation fails', async () => {
    const serverId = 'test-srv-ws-auth-keyring-fail'
    const stub = env.DAEMON_CELL.getByName(serverId)
    setDaemonJwtKeyringFactoryForTests(() => Promise.reject(new Error('forced keyring failure')))

    const response = await stub.fetch('https://do.internal/ws/daemon/v1', {
      headers: {
        Upgrade: 'websocket',
        Authorization: 'Bearer unused-token',
      },
    })
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('Service Unavailable')
    expect(response.webSocket).toBeNull()
  })

  it('webSocketError cleans up like close and marks the cell disconnected', async () => {
    const serverId = 'test-srv-ws-error-cleanup'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const diagBefore = await readDiagnostics(stub, serverId)
    const wsClosedBefore = diagBefore.wsClosed
    const cleanupBefore = diagBefore.cleanupCount

    await runInDurableObject(stub, async (instance: DaemonCellObject, state) => {
      const sockets = state.getWebSockets()
      expect(sockets.length).toBeGreaterThan(0)
      const serverSocket = sockets[0]!
      await instance.webSocketError(serverSocket, new Error('simulated ws error'))
      // Platform drops the hibernated socket after webSocketError; emulate that
      // so `#hasLiveSocket` no longer keeps snapshot.connected true.
      try {
        serverSocket.close(1011, 'error')
      } catch {
        // already closing
      }
    })

    await waitFor(async () => {
      const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
        method: 'GET',
      })
      const snapshot = (await snapshotResponse.json()) as {
        connected: boolean
      }
      expect(snapshot.connected).toBe(false)
    })

    const diagAfter = await readDiagnostics(stub, serverId)
    expect(diagAfter.wsClosed).toBeGreaterThan(wsClosedBefore)
    expect(diagAfter.cleanupCount).toBeGreaterThan(cleanupBefore)

    ws.close(1000, 'test done')
  }, 10_000)

  it('webSocketError is a no-op when the socket has no attachment', async () => {
    const serverId = 'test-srv-ws-error-no-attachment'
    const stub = env.DAEMON_CELL.getByName(serverId)

    await runInDurableObject(stub, async (instance: DaemonCellObject) => {
      const pair = new WebSocketPair()
      const orphan = Object.values(pair)[1]!
      // Accepted without serializeAttachment — cleanup must early-return.
      await instance.webSocketError(orphan, new Error('orphan'))
    })

    const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'GET',
    })
    const snapshot = (await snapshotResponse.json()) as { connected: boolean }
    expect(snapshot.connected).toBe(false)
  })

  it('evicts an existing websocket when a second attach succeeds for the same server', async () => {
    const serverId = 'test-srv-dual'
    const stub = env.DAEMON_CELL.getByName(serverId)

    const first = await openDaemonWebSocket(stub, serverId)
    const second = await openDaemonWebSocket(stub, serverId)

    const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'GET',
    })
    const snapshot = (await snapshotResponse.json()) as {
      connected: boolean
    }
    expect(snapshot.connected).toBe(true)

    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const at = new Date().toISOString()
    let firstReceived = false
    first.ws.addEventListener('message', () => {
      firstReceived = true
    })
    const secondMessagePromise = waitForWebSocketMessage(second.ws)

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at,
          commandId: 'cmd-evict',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })

    const raw = await secondMessagePromise
    const msg = JSON.parse(raw) as { type: string; commandType?: string }
    expect(msg.type).toBe('command-dispatch')
    expect(msg.commandType).toBe('daemon.ping')
    expect(firstReceived).toBe(false)

    await waitFor(() => {
      expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(first.ws.readyState)
    })

    second.ws.close(1000, 'test done')
  }, 15_000)

  it('persists outbox requests across RPC calls and stub re-fetch', async () => {
    const serverId = 'test-srv-2'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const at = new Date().toISOString()

    const enqueueResponse = await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at,
          commandId: 'cmd-persist',
          commandType: 'daemon.ping',
          payload: {},
        },
        opts: { ttlSeconds: 300 },
      }),
    })
    expect(enqueueResponse.status).toBe(200)

    const queuedResponse = await cellRpc(stub, serverId, `/rpc/request?requestId=${requestId}`, {
      method: 'GET',
    })
    const queuedBody = (await queuedResponse.json()) as {
      record: { status: string }
    }
    expect(queuedBody.record.status).toBe('queued')

    const ackAt = new Date().toISOString()
    const ackResponse = await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'command-ack',
          requestId,
          at: ackAt,
          daemonReceivedAt: ackAt,
        },
      }),
    })
    expect(ackResponse.status).toBe(200)

    const outcomeResponse = await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'command-outcome',
          requestId,
          at: ackAt,
          ok: true,
          result: { pong: true },
          daemonReceivedAt: ackAt,
          daemonRespondedAt: ackAt,
        },
      }),
    })
    const inboundBody = (await outcomeResponse.json()) as {
      record: { status: string; result?: { pong: boolean } }
    }
    expect(inboundBody.record.status).toBe('done')
    expect(inboundBody.record.result?.pong).toBe(true)

    const refetchedStub = env.DAEMON_CELL.getByName(serverId)
    const persistedResponse = await cellRpc(
      refetchedStub,
      serverId,
      `/rpc/request?requestId=${requestId}`,
      { method: 'GET' }
    )
    const persistedBody = (await persistedResponse.json()) as {
      record: { status: string; result?: { pong: boolean } } | null
    }
    expect(persistedBody.record?.status).toBe('done')
    expect(persistedBody.record?.result?.pong).toBe(true)
  })

  it('alarm expires old request rows', async () => {
    const serverId = 'test-srv-2-alarm'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId: generateDeliveryId(),
          requestId,
          at: new Date().toISOString(),
          commandId: 'cmd-short-lived',
          commandType: 'daemon.ping',
          payload: {},
        },
        opts: { ttlSeconds: 1 },
      }),
    })

    await new Promise((resolve) => setTimeout(resolve, 1100))

    await runInDurableObject(stub, async (instance: DaemonCellObject) => {
      await instance.alarm()
    })

    const response = await cellRpc(stub, serverId, `/rpc/request?requestId=${requestId}`, {
      method: 'GET',
    })
    const body = (await response.json()) as { record: unknown }
    expect(body.record).toBeNull()
  })

  it('terminal request completed near original TTL stays readable until retention cleanup', async () => {
    const serverId = 'test-srv-terminal-retention-near-ttl'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const at = new Date().toISOString()

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at,
          commandId: 'cmd-near-ttl',
          commandType: 'daemon.ping',
          payload: {},
        },
        opts: { ttlSeconds: 1 },
      }),
    })

    const outcomeAt = new Date().toISOString()
    const inboundResponse = await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'command-outcome',
          requestId,
          at: outcomeAt,
          ok: true,
          result: { pong: true },
          daemonReceivedAt: outcomeAt,
          daemonRespondedAt: outcomeAt,
        },
      }),
    })
    expect(inboundResponse.status).toBe(200)

    // Original TTL elapsed — generic expires_at cleanup must not drop the row.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await runInDurableObject(stub, async (instance: DaemonCellObject) => {
      await instance.alarm()
    })

    const stillPresent = await cellRpc(stub, serverId, `/rpc/request?requestId=${requestId}`, {
      method: 'GET',
    })
    const presentBody = (await stillPresent.json()) as {
      record: { status: string; result?: { pong?: boolean } } | null
    }
    expect(presentBody.record).not.toBeNull()
    expect(presentBody.record?.status).toBe('done')
    expect(presentBody.record?.result?.pong).toBe(true)

    // Backdate finished_at past retention so the finished_at prune can reap it.
    const staleFinishedAt = new Date(
      Date.now() - TERMINAL_UPDATE_RETENTION_MS - 1_000
    ).toISOString()
    await runInDurableObject(stub, async (instance: DaemonCellObject, state) => {
      state.storage.sql.exec(
        `UPDATE request SET finished_at = ? WHERE request_id = ?`,
        staleFinishedAt,
        requestId
      )
      await instance.alarm()
    })

    const afterRetention = await cellRpc(stub, serverId, `/rpc/request?requestId=${requestId}`, {
      method: 'GET',
    })
    const afterBody = (await afterRetention.json()) as { record: unknown }
    expect(afterBody.record).toBeNull()
  })

  it('getByName accepts location hints', () => {
    const stubWithHint = env.DAEMON_CELL.getByName('test-srv-3', {
      locationHint: 'wnam',
    })
    expect(stubWithHint).toBeDefined()
  })

  it('hello message updates lastSeenAt on the snapshot (runtime projection marker)', async () => {
    const serverId = 'test-srv-hello'
    const { db, updateCalls, getStatus } = createProjectionRecordingDb({
      connected: false,
    })
    setDaemonCellProjectionDbFactoryForTests(() => db)

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0)
    })

    const connectedStatusChangedAt = getStatus().statusChangedAt

    ws.send(
      JSON.stringify({
        type: 'hello',
        at: new Date().toISOString(),
        daemonBuild: { commit: 'abc', buildId: '1' },
      })
    )

    await waitFor(async () => {
      expect(getStatus().statusChangedAt).toBe(connectedStatusChangedAt)
      const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
        method: 'GET',
      })
      const snapshot = (await snapshotResponse.json()) as {
        lastSeenAt?: string
        daemonBuild?: { commit: string; buildId: string }
      }
      expect(snapshot.lastSeenAt).toBeTruthy()
      expect(snapshot.daemonBuild?.commit).toBe('abc')
      expect(snapshot.daemonBuild?.buildId).toBe('1')
    })

    ws.close(1000, 'test done')
  })

  it('heartbeat without daemonBuild does not update Postgres status or snapshot lastSeenAt', async () => {
    const serverId = 'test-srv-heartbeat-no-daemonBuild'
    const { db, updateCalls, getStatus } = createProjectionRecordingDb({
      connected: false,
    })
    setDaemonCellProjectionDbFactoryForTests(() => db)

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0)
      expect(getStatus().statusChangedAt).toBeTruthy()
    })
    const connectedStatusChangedAt = getStatus().statusChangedAt!

    await new Promise((resolve) => setTimeout(resolve, 25))

    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        at: new Date().toISOString(),
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 300))

    const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'GET',
    })
    const snapshot = (await snapshotResponse.json()) as {
      lastSeenAt?: string
    }
    expect(getStatus().statusChangedAt).toBe(connectedStatusChangedAt)
    expect(snapshot.lastSeenAt).toBeUndefined()

    ws.close(1000, 'test done')
  })

  it('topology-report writes the daemon-reported snapshot and its own timestamp verbatim', async () => {
    const serverId = 'test-srv-topology'
    const base = createProjectionRecordingDb()
    const inserted: Array<Record<string, unknown>> = []
    const db = {
      ...base.db,
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v)
          return { onConflictDoNothing: () => Promise.resolve(undefined) }
        },
      }),
    } as unknown as Db
    setDaemonCellProjectionDbFactoryForTests(() => db)

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const daemonSnapshot = {
      generation: 3,
      bootGeneration: 1,
      networks: [{ deviceId: 'mac:aa:bb:cc:dd:ee:ff', kind: 'uplink' }],
    }
    const reportedAt = '2026-01-01T00:05:00.000Z'
    ws.send(
      JSON.stringify({
        type: 'topology-report',
        generation: 3,
        bootGeneration: 1,
        snapshot: daemonSnapshot,
        at: reportedAt,
      })
    )

    await waitFor(() => {
      expect(inserted.length).toBeGreaterThan(0)
    })

    // Stored directly — never re-wrapped as `{ generation, bootGeneration, snapshot }`.
    expect(inserted[0]?.snapshot).toEqual(daemonSnapshot)
    // The daemon's own report time, not a control-plane receipt timestamp.
    expect(inserted[0]?.appliedAt).toBe(reportedAt)
    expect(inserted[0]?.generation).toBe(3)
    expect(inserted[0]?.bootGeneration).toBe(1)
    expect(inserted[0]?.serverId).toBe(serverId)

    ws.close(1000, 'test done')
  })

  it('purge-cell clears storage and resets snapshot', async () => {
    const serverId = 'test-srv-purge'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)
    ws.close(1000, 'test done')

    const purgeResponse = await cellRpc(stub, serverId, '/rpc/purge-cell', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(purgeResponse.status).toBe(200)
    const purgeBody = (await purgeResponse.json()) as { ok: boolean }
    expect(purgeBody.ok).toBe(true)

    const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'GET',
    })
    const snapshot = (await snapshotResponse.json()) as {
      connected: boolean
    }
    expect(snapshot.connected).toBe(false)
  })

  it('websocket close marks snapshot disconnected immediately', async () => {
    const serverId = 'test-srv-ws-disconnect'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    ws.close(1000, 'test done')
    await waitFor(async () => {
      const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
        method: 'GET',
      })
      const snapshot = (await snapshotResponse.json()) as {
        connected: boolean
      }
      expect(snapshot.connected).toBe(false)
    })
  })

  it('websocket close marks Postgres offline and snapshot disconnected', async () => {
    const serverId = 'test-srv-ws-last-seen'
    const { db, updateCalls, getStatus } = createProjectionRecordingDb({
      connected: false,
    })
    setDaemonCellProjectionDbFactoryForTests(() => db)

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0)
      expect(getStatus().connected).toBe(true)
      expect(getStatus().statusChangedAt).toBeTruthy()
    })
    const connectedStatusChangedAt = getStatus().statusChangedAt!

    await new Promise((resolve) => setTimeout(resolve, 25))

    ws.close(1000, 'test done')
    await waitFor(async () => {
      expect(getStatus().connected).toBe(false)
      expect(getStatus().statusChangedAt).toBeTruthy()
      expect(Date.parse(getStatus().statusChangedAt!) >= Date.parse(connectedStatusChangedAt)).toBe(
        true
      )

      const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
        method: 'GET',
      })
      const snapshot = (await snapshotResponse.json()) as {
        connected: boolean
        lastSeenAt?: string
      }
      expect(snapshot.connected).toBe(false)
    })
  })

  it('idle websocket attach schedules no alarm', async () => {
    const serverId = 'test-srv-idle-alarm'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const { alarm, updatedAt } = await runInDurableObject(stub, async (_instance, state) => {
      const scheduled = await state.storage.getAlarm()
      const cursor = state.storage.sql.exec(
        'SELECT updated_at FROM cell WHERE server_id = ?',
        serverId
      )
      let seenAt: string | null = null
      for (const row of cursor) {
        seenAt = String(row.updated_at ?? '')
      }
      return { alarm: scheduled, updatedAt: seenAt }
    })
    expect(alarm).toBeNull()
    expect(updatedAt).toBeTruthy()

    ws.close(1000, 'test done')
  })

  it('enqueue without websocket does not schedule an outbox pump alarm', async () => {
    const serverId = 'test-srv-outbox-no-alarm'
    const stub = env.DAEMON_CELL.getByName(serverId)

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId: generateDeliveryId(),
          requestId: generateRequestId(),
          at: new Date().toISOString(),
          commandId: 'cmd-queued',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })

    const alarm = await runInDurableObject(
      stub,
      async (_instance, state) => await state.storage.getAlarm()
    )
    // Enqueue without a socket schedules request expiry cleanup, not an outbox pump.
    expect(alarm).not.toBeNull()
    expect(alarm!).toBeGreaterThan(Date.now() + 60_000)
  })

  it('outbox drain retains terminal-retention cleanup alarm', async () => {
    const serverId = 'test-srv-outbox-drain-alarm'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const at = new Date().toISOString()
    const messagePromise = waitForWebSocketMessage(ws)

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at,
          commandId: 'cmd-drain',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })

    await messagePromise

    wsSendCommandOutcome(ws, requestId)

    await waitFor(async () => {
      const alarm = await runInDurableObject(
        stub,
        async (_instance, state) => await state.storage.getAlarm()
      )
      expect(alarm).not.toBeNull()
    })

    ws.close(1000, 'test done')
  })

  it('stale websocket close does not mark a newer attach offline', async () => {
    const serverId = 'test-srv-stale-close'
    const stub = env.DAEMON_CELL.getByName(serverId)

    const first = await openDaemonWebSocket(stub, serverId)
    const second = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(first.ws.readyState)
    })

    const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'GET',
    })
    const snapshot = (await snapshotResponse.json()) as {
      connected: boolean
    }
    expect(snapshot.connected).toBe(true)

    second.ws.close(1000, 'test done')
  }, 15_000)

  it('requeues and redelivers outbox commands after socket closes during delivery', async () => {
    const serverId = 'test-srv-outbox-reconnect'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const at = new Date().toISOString()

    const first = await openDaemonWebSocket(stub, serverId)
    let firstReceived = false
    first.ws.addEventListener('message', () => {
      firstReceived = true
    })

    const enqueueResponse = cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at,
          commandId: 'cmd-retry',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })
    first.ws.close(4000, 'simulate delivery failure')
    await enqueueResponse

    await runInDurableObject(stub, async (instance: DaemonCellObject, state) => {
      const cursor = state.storage.sql.exec(
        'SELECT delivery_status FROM request WHERE delivery_id = ?',
        deliveryId
      )
      let deliveryStatus = 'missing'
      for (const row of cursor) {
        deliveryStatus = String(row.delivery_status ?? '')
      }
      if (deliveryStatus === 'missing') {
        throw new Error('expected request row to exist before reconnect')
      }
      if (deliveryStatus === 'inflight') {
        state.storage.sql.exec(
          `UPDATE request SET sent_at = ? WHERE delivery_id = ?`,
          new Date(Date.now() - 60_000).toISOString(),
          deliveryId
        )
        await instance.alarm()
      }
    })

    const second = await openDaemonWebSocket(stub, serverId)
    const raw = await waitForWebSocketMessage(second.ws)
    const msg = JSON.parse(raw) as {
      type: string
      commandType?: string
      id?: string
    }
    expect(msg.type).toBe('command-dispatch')
    expect(msg.commandType).toBe('daemon.ping')
    expect(msg.id).toBe(requestId)
    expect(firstReceived).toBe(false)

    wsSendCommandOutcome(second.ws, requestId)

    await waitFor(async () => {
      await runInDurableObject(stub, (_instance, state) => {
        const deliveryCursor = state.storage.sql.exec(
          'SELECT delivery_status FROM request WHERE delivery_id = ?',
          deliveryId
        )
        const [deliveryRow] = [...deliveryCursor]
        if (!deliveryRow) {
          throw new Error('expected acked request row to be retained')
        }
        expect(String(deliveryRow.delivery_status ?? '')).toBe('acked')
        const requestCursor = state.storage.sql.exec(
          'SELECT status FROM request WHERE request_id = ?',
          requestId
        )
        const [requestRow] = [...requestCursor]
        if (!requestRow) {
          throw new Error('expected terminal request row to exist')
        }
        expect(String(requestRow.status ?? '')).toBe('done')
      })
    })

    second.ws.close(1000, 'test done')
  }, 15_000)

  it('snapshot read does not recreate cell for a missing server', async () => {
    const serverId = 'test-srv-readonly-missing'
    const stub = env.DAEMON_CELL.getByName(serverId)

    const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'GET',
    })
    const snapshot = (await snapshotResponse.json()) as { connected: boolean }
    expect(snapshot.connected).toBe(false)

    await runInDurableObject(stub, (_instance, state) => {
      const cursor = state.storage.sql.exec('SELECT server_id FROM cell')
      if ([...cursor].length > 0) {
        throw new Error('expected snapshot read to not create cell')
      }
    })
  })

  it('snapshot read after purge does not recreate cell', async () => {
    const serverId = 'test-srv-readonly-purge'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)
    ws.close(1000, 'test done')

    const purgeResponse = await cellRpc(stub, serverId, '/rpc/purge-cell', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(purgeResponse.status).toBe(200)

    const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'GET',
    })
    const snapshot = (await snapshotResponse.json()) as { connected: boolean }
    expect(snapshot.connected).toBe(false)

    await runInDurableObject(stub, (_instance, state) => {
      const cursor = state.storage.sql.exec('SELECT server_id FROM cell')
      if ([...cursor].length > 0) {
        throw new Error('expected snapshot read to not recreate cell')
      }
    })
  })

  it('alarm does not demote live socket with warm auto-response', async () => {
    const serverId = 'test-srv-alarm-stale'
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: true,
      statusChangedAt: new Date().toISOString(),
    })
    setDaemonCellProjectionDbFactoryForTests(() => db)

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    ws.send(DAEMON_CELL_PING)
    await waitForWebSocketMessage(ws, 2000)

    await runInDurableObject(stub, async (instance: DaemonCellObject) => {
      await instance.alarm()
    })

    const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'GET',
    })
    const snapshot = (await snapshotResponse.json()) as { connected: boolean }
    expect(snapshot.connected).toBe(true)

    const offlinePatch = updateCalls.find((patch) => statusFromPatch(patch)?.connected === false)
    expect(offlinePatch).toBeUndefined()

    ws.close(1000, 'test done')
  })

  it('heartbeat restores runtime connected after alarm stale demotion', async () => {
    const serverId = 'test-srv-alarm-stale-snapshot'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await runInDurableObject(stub, async (instance: DaemonCellObject) => {
      await instance.alarm()
    })

    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        at: new Date().toISOString(),
      })
    )

    await waitFor(async () => {
      const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
        method: 'GET',
      })
      const snapshot = (await snapshotResponse.json()) as {
        connected: boolean
      }
      expect(snapshot.connected).toBe(true)
    })

    ws.close(1000, 'test done')
  })

  it('hello after stale sweep restores runtime connected flag', async () => {
    const serverId = 'test-srv-alarm-stale-recover'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await runInDurableObject(stub, async (instance: DaemonCellObject) => {
      await instance.alarm()
    })

    ws.send(
      JSON.stringify({
        type: 'hello',
        at: new Date().toISOString(),
        daemonBuild: { commit: 'recovered', buildId: '1' },
      })
    )

    await waitFor(async () => {
      const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
        method: 'GET',
      })
      const snapshot = (await snapshotResponse.json()) as {
        connected: boolean
      }
      expect(snapshot.connected).toBe(true)
    })

    ws.close(1000, 'test done')
  })
})

describe('createRequestAndWait expiry parity', () => {
  it('timed-out createRequestAndWait reclaims outbox and cannot redeliver', async () => {
    const serverId = 'test-srv-expire-wait'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const registry = createDurableObjectDaemonCellRegistry(env)
    const cell = registry.getCell(serverId)

    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const outbound = {
      kind: 'command-dispatch' as const,
      deliveryId,
      requestId,
      at: new Date().toISOString(),
      commandId: 'cmd-stale',
      commandType: 'daemon.ping',
      payload: {},
    }

    const expired = await cell.createRequestAndWait(outbound, 300)
    expect(expired.status).toBe('expired')
    expect(expired.requestId).toBe(requestId)
    expect(await cell.getRequest(requestId)).toBeNull()

    await runInDurableObject(stub, (_instance, state) => {
      const cursor = state.storage.sql.exec(
        'SELECT seq FROM request WHERE request_id = ?',
        requestId
      )
      if ([...cursor].length > 0) {
        throw new Error('expected request row to be deleted after expire')
      }
    })

    const readResponse = await cellRpc(stub, serverId, '/rpc/outbox/read', {
      method: 'POST',
      body: JSON.stringify({
        params: { consumer: 'test-expire', count: 10 },
      }),
    })
    const readBody = (await readResponse.json()) as {
      envelopes: Array<{ requestId: string }>
    }
    expect(readBody.envelopes.some((entry) => entry.requestId === requestId)).toBe(false)

    const { ws } = await openDaemonWebSocket(stub, serverId)
    let received = false
    ws.addEventListener('message', () => {
      received = true
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(received).toBe(false)
    ws.close(1000, 'test done')
  }, 10_000)

  it('expire-request RPC is idempotent and returns persisted expired record', async () => {
    const serverId = 'test-srv-expire-rpc'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId: generateDeliveryId(),
          requestId,
          at: new Date().toISOString(),
          commandId: 'cmd-expire',
          commandType: 'daemon.ping',
          payload: {},
        },
        opts: { ttlSeconds: 300 },
      }),
    })

    const expireResponse = await cellRpc(stub, serverId, '/rpc/expire-request', {
      method: 'POST',
      body: JSON.stringify({ requestId }),
    })
    expect(expireResponse.status).toBe(200)
    const expireBody = (await expireResponse.json()) as {
      record: { status: string; requestId: string }
    }
    expect(expireBody.record.status).toBe('expired')
    expect(expireBody.record.requestId).toBe(requestId)

    const getResponse = await cellRpc(stub, serverId, `/rpc/request?requestId=${requestId}`, {
      method: 'GET',
    })
    const getBody = (await getResponse.json()) as { record: unknown }
    expect(getBody.record).toBeNull()

    const retryResponse = await cellRpc(stub, serverId, '/rpc/expire-request', {
      method: 'POST',
      body: JSON.stringify({ requestId }),
    })
    const retryBody = (await retryResponse.json()) as {
      record: { status: string; requestId: string }
    }
    expect(retryBody.record.status).toBe('expired')
    expect(retryBody.record.requestId).toBe(requestId)
  })
})

describe('command-dispatch correlation', () => {
  it('ack is non-terminal then outcome completes over RPC inbound', async () => {
    const serverId = 'test-srv-command-dispatch'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const ackAt = new Date().toISOString()
    const outcomeAt = new Date(Date.now() + 1000).toISOString()

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at: ackAt,
          commandId: 'cmd-do-1',
          commandType: 'ping',
          payload: { target: 'host' },
        },
      }),
    })

    const ackResponse = await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'command-ack',
          requestId,
          at: ackAt,
          daemonReceivedAt: ackAt,
        },
      }),
    })
    const ackBody = (await ackResponse.json()) as {
      record: {
        status: string
        ackAt?: string
        finishedAt?: string
        daemonReceivedAt?: string
      } | null
    }
    expect(ackBody.record?.status).toBe('acked')
    expect(ackBody.record?.ackAt).toBe(ackAt)
    expect(ackBody.record?.daemonReceivedAt).toBe(ackAt)
    expect(ackBody.record?.finishedAt).toBeUndefined()

    const midResponse = await cellRpc(stub, serverId, `/rpc/request?requestId=${requestId}`, {
      method: 'GET',
    })
    const midBody = (await midResponse.json()) as {
      record: { status: string; daemonReceivedAt?: string } | null
    }
    expect(midBody.record?.status).toBe('acked')
    expect(midBody.record?.daemonReceivedAt).toBe(ackAt)

    const daemonRespondedAt = new Date(Date.now() + 500).toISOString()
    const outcomeResponse = await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'command-outcome',
          requestId,
          at: outcomeAt,
          ok: true,
          result: { pong: true },
          daemonReceivedAt: ackAt,
          daemonRespondedAt,
        },
      }),
    })
    const outcomeBody = (await outcomeResponse.json()) as {
      record: {
        status: string
        result?: { pong: boolean }
        finishedAt?: string
        daemonReceivedAt?: string
        daemonRespondedAt?: string
      } | null
    }
    expect(outcomeBody.record?.status).toBe('done')
    expect(outcomeBody.record?.result).toEqual({ pong: true })
    expect(outcomeBody.record?.finishedAt).toBe(outcomeAt)
    expect(outcomeBody.record?.daemonReceivedAt).toBe(ackAt)
    expect(outcomeBody.record?.daemonRespondedAt).toBe(daemonRespondedAt)

    const waitResponse = await cellRpc(stub, serverId, '/rpc/wait-request', {
      method: 'POST',
      body: JSON.stringify({ requestId, timeoutMs: 100 }),
    })
    const waitBody = (await waitResponse.json()) as {
      record: {
        status: string
        daemonReceivedAt?: string
        daemonRespondedAt?: string
      } | null
    }
    expect(waitBody.record?.status).toBe('done')
    expect(waitBody.record?.daemonReceivedAt).toBe(ackAt)
    expect(waitBody.record?.daemonRespondedAt).toBe(daemonRespondedAt)
  })

  it('command-ack and command-outcome write requests only, not cell liveness', async () => {
    const prev = env.TURBOPANEL_DAEMON_DEBUG
    env.TURBOPANEL_DAEMON_DEBUG = '1'
    try {
      const serverId = 'test-srv-command-ack-no-cell-liveness'
      const stub = env.DAEMON_CELL.getByName(serverId)
      const { ws } = await openDaemonWebSocket(stub, serverId)

      const cellUpdatedAtBefore = await runInDurableObject(stub, (_instance, state) => {
        const cursor = state.storage.sql.exec(
          'SELECT updated_at FROM cell WHERE server_id = ?',
          serverId
        )
        for (const row of cursor) {
          return String(row.updated_at ?? '')
        }
        return ''
      })
      expect(cellUpdatedAtBefore).toBeTruthy()

      const requestId = generateRequestId()
      const deliveryId = generateDeliveryId()
      const ackAt = new Date().toISOString()

      await cellRpc(stub, serverId, '/rpc/enqueue', {
        method: 'POST',
        body: JSON.stringify({
          outbound: {
            kind: 'command-dispatch',
            deliveryId,
            requestId,
            at: ackAt,
            commandId: 'cmd-no-cell-liveness',
            commandType: 'ping',
            payload: {},
          },
        }),
      })

      const diagBeforeResp = await cellRpc(stub, serverId, '/rpc/diagnostics', {
        method: 'GET',
      })
      const diagBefore = (await diagBeforeResp.json()) as {
        storageByCallSite: Record<string, { writes: number }>
      }

      const ackResponse = await cellRpc(stub, serverId, '/rpc/inbound', {
        method: 'POST',
        body: JSON.stringify({
          inbound: {
            kind: 'command-ack',
            requestId,
            at: ackAt,
            daemonReceivedAt: ackAt,
          },
        }),
      })
      expect(ackResponse.status).toBe(200)

      const outcomeAt = new Date(Date.now() + 500).toISOString()
      const outcomeResponse = await cellRpc(stub, serverId, '/rpc/inbound', {
        method: 'POST',
        body: JSON.stringify({
          inbound: {
            kind: 'command-outcome',
            requestId,
            at: outcomeAt,
            ok: true,
            result: { pong: true },
            daemonReceivedAt: ackAt,
            daemonRespondedAt: outcomeAt,
          },
        }),
      })
      expect(outcomeResponse.status).toBe(200)

      const cellUpdatedAtAfter = await runInDurableObject(stub, (_instance, state) => {
        const cursor = state.storage.sql.exec(
          'SELECT updated_at FROM cell WHERE server_id = ?',
          serverId
        )
        for (const row of cursor) {
          return String(row.updated_at ?? '')
        }
        return ''
      })
      expect(cellUpdatedAtAfter).toBe(cellUpdatedAtBefore)

      const diagAfterResp = await cellRpc(stub, serverId, '/rpc/diagnostics', {
        method: 'GET',
      })
      const diagAfter = (await diagAfterResp.json()) as {
        storageByCallSite: Record<string, { writes: number }>
      }

      const handleInboundWrites =
        (diagAfter.storageByCallSite['handle-inbound']?.writes ?? 0) -
        (diagBefore.storageByCallSite['handle-inbound']?.writes ?? 0)
      expect(handleInboundWrites).toBe(2)

      const attachWrites =
        (diagAfter.storageByCallSite['attach']?.writes ?? 0) -
        (diagBefore.storageByCallSite['attach']?.writes ?? 0)
      const cleanupWrites =
        (diagAfter.storageByCallSite['cleanup']?.writes ?? 0) -
        (diagBefore.storageByCallSite['cleanup']?.writes ?? 0)
      const wsLivenessWrites =
        (diagAfter.storageByCallSite['ws-message-liveness']?.writes ?? 0) -
        (diagBefore.storageByCallSite['ws-message-liveness']?.writes ?? 0)
      expect(attachWrites).toBe(0)
      expect(cleanupWrites).toBe(0)
      expect(wsLivenessWrites).toBe(0)

      ws.close(1000, 'test done')
    } finally {
      env.TURBOPANEL_DAEMON_DEBUG = prev
    }
  }, 10_000)

  it('delivers command-dispatch over websocket and completes on ack then outcome', async () => {
    const serverId = 'test-srv-command-dispatch-ws'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const at = new Date().toISOString()
    const messagePromise = waitForWebSocketMessage(ws)

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at,
          commandId: 'cmd-ws-1',
          commandType: 'ping',
          payload: { n: 1 },
        },
      }),
    })

    const raw = await messagePromise
    const msg = JSON.parse(raw) as {
      type: string
      id?: string
      commandId?: string
      commandType?: string
      payload?: unknown
    }
    expect(msg.type).toBe('command-dispatch')
    expect(msg.id).toBe(requestId)
    expect(msg.commandId).toBe('cmd-ws-1')
    expect(msg.commandType).toBe('ping')
    expect(msg.payload).toEqual({ n: 1 })

    ws.send(
      JSON.stringify({
        type: 'command-ack',
        id: requestId,
        at,
        daemonReceivedAt: at,
      })
    )

    await waitFor(async () => {
      const ackResponse = await cellRpc(stub, serverId, `/rpc/request?requestId=${requestId}`, {
        method: 'GET',
      })
      const ackBody = (await ackResponse.json()) as {
        record: { status: string } | null
      }
      expect(ackBody.record?.status).toBe('acked')
    })

    const outcomeAt = new Date().toISOString()
    ws.send(
      JSON.stringify({
        type: 'command-outcome',
        id: requestId,
        at: outcomeAt,
        ok: true,
        result: { pong: true },
      })
    )

    await waitFor(async () => {
      const doneResponse = await cellRpc(stub, serverId, '/rpc/wait-request', {
        method: 'POST',
        body: JSON.stringify({ requestId, timeoutMs: 100 }),
      })
      const doneBody = (await doneResponse.json()) as {
        record: { status: string; result?: { pong: boolean } } | null
      }
      expect(doneBody.record?.status).toBe('done')
      expect(doneBody.record?.result).toEqual({ pong: true })
    })

    ws.close(1000, 'test done')
  })

  it('registers WebSocket auto-response ping/pong in the constructor', async () => {
    const serverId = 'test-srv-auto-response-constructor'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const pongPromise = waitForWebSocketMessage(ws, 2000)
    ws.send(DAEMON_CELL_PING)
    const pong = await pongPromise
    expect(pong).toBe(DAEMON_CELL_PONG)

    ws.close(1000, 'test done')
  })

  it('idle connected cell clears outbox pump alarm when outbox is drained', async () => {
    const serverId = 'test-srv-outbox-drain-clears-pump-alarm'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const at = new Date().toISOString()
    const messagePromise = waitForWebSocketMessage(ws)

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at,
          commandId: 'cmd-drain-pump',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })

    await messagePromise

    await waitFor(async () => {
      const alarm = await runInDurableObject(stub, async (_instance, state) => {
        const cursor = state.storage.sql.exec(
          `SELECT seq FROM request
             WHERE delivery_status = 'queued' AND (retry_at IS NULL OR retry_at <= ?)
             LIMIT 1`,
          new Date().toISOString()
        )
        if ([...cursor].length > 0) {
          throw new Error('expected outbox to be drained')
        }
        return await state.storage.getAlarm()
      })
      expect(alarm).not.toBeNull()
      // Request expiry / terminal-retention cleanup — not a stale-sweep re-arm.
      expect(alarm!).toBeGreaterThan(Date.now() + 10_000)
    })

    ws.close(1000, 'test done')
  })

  it('poison-row guard prevents perpetual outbox pump alarm', async () => {
    const serverId = 'test-srv-outbox-poison-guard'
    const stub = env.DAEMON_CELL.getByName(serverId)

    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const at = new Date().toISOString()

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at,
          commandId: 'cmd-poison',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })

    await runInDurableObject(stub, async (instance: DaemonCellObject, state) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        state.storage.sql.exec(
          `UPDATE request
           SET delivery_status = CASE WHEN retry_count + 1 >= 10 THEN 'dead' ELSE 'queued' END,
               retry_count = retry_count + 1,
               sent_at = NULL
           WHERE delivery_id = ?`,
          deliveryId
        )
      }

      let deliveryStatus: string | null = null
      const cursor = state.storage.sql.exec(
        'SELECT delivery_status FROM request WHERE delivery_id = ?',
        deliveryId
      )
      for (const row of cursor) {
        deliveryStatus = String(row.delivery_status ?? '')
      }
      expect(deliveryStatus).toBe('dead')

      const deliverableCursor = state.storage.sql.exec(
        `SELECT seq FROM request
         WHERE delivery_status = 'queued' AND (retry_at IS NULL OR retry_at <= ?)
         LIMIT 1`,
        new Date().toISOString()
      )
      let hasDeliverable = false
      for (const _ of deliverableCursor) {
        hasDeliverable = true
      }
      expect(hasDeliverable).toBe(false)

      await instance.alarm()
      const alarm = await state.storage.getAlarm()
      if (alarm !== null) {
        expect(alarm).toBeGreaterThan(Date.now() + 5000)
      }
    })
  })

  it('delivery-requeue poison path attributes storageByCallSite and marks dead', async () => {
    const serverId = 'test-srv-delivery-requeue-poison-attrib'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()

    // Queue without a live socket so the row stays deliverable until we force a send failure.
    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at: new Date().toISOString(),
          commandId: 'cmd-poison-attrib',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })

    // One retry short of poison so the next failed send marks the row dead.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE request
         SET delivery_status = 'queued', retry_count = 9, retry_at = NULL, sent_at = NULL
         WHERE delivery_id = ?`,
        deliveryId
      )
    })

    const diagBefore = await readDiagnostics(stub, serverId)
    const requeueWritesBefore = diagBefore.storageByCallSite['delivery-requeue']?.writes ?? 0

    setForceOutboxSendErrorForTests(new Error('forced outbox send failure'))
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(async () => {
      await runInDurableObject(stub, (_instance, state) => {
        const [row] = [
          ...state.storage.sql.exec(
            'SELECT delivery_status, retry_count FROM request WHERE delivery_id = ?',
            deliveryId
          ),
        ]
        expect(String(row?.delivery_status ?? '')).toBe('dead')
        expect(Number(row?.retry_count ?? 0)).toBe(10)
      })
    })

    const diagAfter = await readDiagnostics(stub, serverId)
    expect(
      (diagAfter.storageByCallSite['delivery-requeue']?.writes ?? 0) - requeueWritesBefore
    ).toBeGreaterThan(0)
    assertNoMisattributedStorage(diagAfter.storageByCallSite)

    setForceOutboxSendErrorForTests(null)
    ws.close(1000, 'test done')
  }, 15_000)

  it('steady-state heartbeat performs no cell-table write on auto-response path', async () => {
    const serverId = 'test-srv-auto-response-timestamp'
    const staleLastSeen = new Date(Date.now() - 120_000).toISOString()
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: true,
      statusChangedAt: staleLastSeen,
    })

    let factoryCalls = 0
    setDaemonCellProjectionDbFactoryForTests(() => {
      factoryCalls += 1
      return db
    })

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0)
    })

    ws.send(DAEMON_CELL_PING)
    await waitForWebSocketMessage(ws, 2000)

    const factoryBeforeHeartbeat = factoryCalls

    const updatedAtBefore = await runInDurableObject(stub, (_instance, state) => {
      const cursor = state.storage.sql.exec(
        'SELECT updated_at FROM cell WHERE server_id = ?',
        serverId
      )
      const [row] = [...cursor]
      return String(row?.updated_at ?? '')
    })
    expect(updatedAtBefore).toBeTruthy()

    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        at: new Date().toISOString(),
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 300))

    const updatedAtAfter = await runInDurableObject(stub, (_instance, state) => {
      const cursor = state.storage.sql.exec(
        'SELECT updated_at FROM cell WHERE server_id = ?',
        serverId
      )
      const [row] = [...cursor]
      return String(row?.updated_at ?? '')
    })
    expect(updatedAtAfter).toBe(updatedAtBefore)
    expect(factoryCalls).toBe(factoryBeforeHeartbeat)

    ws.close(1000, 'test done')
  }, 10_000)

  it('heartbeat skips projection when connect seeded in-memory debounce is fresh', async () => {
    const prev = env.TURBOPANEL_DAEMON_DEBUG
    env.TURBOPANEL_DAEMON_DEBUG = '1'
    try {
      const serverId = 'test-srv-auto-response-projection-throttle'
      const staleLastSeen = new Date(Date.now() - 120_000).toISOString()
      const { db, updateCalls } = createProjectionRecordingDb({
        connected: true,
        statusChangedAt: staleLastSeen,
      })

      let factoryCalls = 0
      setDaemonCellProjectionDbFactoryForTests(() => {
        factoryCalls += 1
        return db
      })

      const stub = env.DAEMON_CELL.getByName(serverId)
      const { ws } = await openDaemonWebSocket(stub, serverId)

      await waitFor(() => {
        expect(updateCalls.length).toBeGreaterThan(0)
      })

      ws.send(DAEMON_CELL_PING)
      await waitForWebSocketMessage(ws, 2000)

      const factoryBeforeHeartbeat = factoryCalls

      const diagBeforeResp = await cellRpc(stub, serverId, '/rpc/diagnostics', {
        method: 'GET',
      })
      const diagBefore = (await diagBeforeResp.json()) as {
        storageByCallSite: Record<string, { writes: number }>
      }

      ws.send(
        JSON.stringify({
          type: 'heartbeat',
          at: new Date().toISOString(),
        })
      )

      await new Promise((resolve) => setTimeout(resolve, 300))

      expect(factoryCalls).toBe(factoryBeforeHeartbeat)

      const diagAfterResp = await cellRpc(stub, serverId, '/rpc/diagnostics', {
        method: 'GET',
      })
      const diagAfter = (await diagAfterResp.json()) as {
        storageByCallSite: Record<string, { writes: number }>
      }

      const recordInboundWrites =
        (diagAfter.storageByCallSite['record-inbound']?.writes ?? 0) -
        (diagBefore.storageByCallSite['record-inbound']?.writes ?? 0)
      expect(recordInboundWrites).toBe(0)

      ws.close(1000, 'test done')
    } finally {
      env.TURBOPANEL_DAEMON_DEBUG = prev
    }
  }, 10_000)

  it('RPC detach clears runtime connected flag in snapshot', async () => {
    const serverId = 'test-srv-rpc-detach-connected'
    const stub = env.DAEMON_CELL.getByName(serverId)

    const attachResponse = await cellRpc(stub, serverId, '/rpc/attach', {
      method: 'POST',
      body: JSON.stringify({
        meta: {
          keyId: 'key-1',
          remoteAddress: '127.0.0.1',
          connectedAt: new Date().toISOString(),
        },
      }),
    })
    expect(attachResponse.status).toBe(200)
    const attachBody = (await attachResponse.json()) as {
      connectionId: string
    }

    const connectedSnapshot = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'GET',
    })
    const connected = (await connectedSnapshot.json()) as {
      connected: boolean
    }
    expect(connected.connected).toBe(true)

    const detachResponse = await cellRpc(stub, serverId, '/rpc/detach', {
      method: 'POST',
      body: JSON.stringify({
        params: {
          connectionId: attachBody.connectionId,
          reason: 'test detach',
        },
      }),
    })
    expect(detachResponse.status).toBe(200)

    const disconnectedSnapshot = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'GET',
    })
    const disconnected = (await disconnectedSnapshot.json()) as {
      connected: boolean
    }
    expect(disconnected.connected).toBe(false)
  })

  it('/rpc/liveness reports connected with a fresh ping timestamp (offline sweep probe)', async () => {
    const serverId = 'test-srv-rpc-liveness-connected'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const before = Date.now()
    ws.send(DAEMON_CELL_PING)
    await waitForWebSocketMessage(ws, 2000)

    const response = await cellRpc(stub, serverId, '/rpc/liveness', {
      method: 'GET',
    })
    expect(response.status).toBe(200)
    const liveness = (await response.json()) as {
      connected: boolean
      lastPingAtMs: number | null
    }
    expect(liveness.connected).toBe(true)
    expect(liveness.lastPingAtMs).not.toBeNull()
    expect(liveness.lastPingAtMs).toBeGreaterThanOrEqual(before)

    ws.close(1000, 'test done')
  })

  it('/rpc/liveness reports not connected for a server with no attached socket', async () => {
    const serverId = 'test-srv-rpc-liveness-unattached'
    const stub = env.DAEMON_CELL.getByName(serverId)

    const response = await cellRpc(stub, serverId, '/rpc/liveness', {
      method: 'GET',
    })
    expect(response.status).toBe(200)
    const liveness = (await response.json()) as {
      connected: boolean
      lastPingAtMs: number | null
    }
    expect(liveness.connected).toBe(false)
    expect(liveness.lastPingAtMs).toBeNull()
  })

  it('closes websocket when inbound messages exceed the per-connection limit', async () => {
    const serverId = 'test-srv-inbound-flood-close'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener('close', (event) => {
        resolve({ code: event.code, reason: event.reason })
      })
    })

    // Construct-time binding (vitest miniflare) defaults to 120; runtime
    // `env.TURBOPANEL_DAEMON_WS_INBOUND_LIMIT = …` does not retune an already
    // constructed DO — exceed the default cap instead.
    const at = new Date().toISOString()
    for (let i = 0; i < 121; i++) {
      ws.send(JSON.stringify({ type: 'heartbeat', at }))
    }

    const closed = await closePromise
    expect(closed.code).toBe(1008)
    expect(closed.reason).toBe('rate_limited')

    const diagResponse = await cellRpc(stub, serverId, '/rpc/diagnostics', {
      method: 'GET',
    })
    const diagBefore = (await diagResponse.json()) as {
      storageWrites: number
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'heartbeat', at }))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    const diagAfterResponse = await cellRpc(stub, serverId, '/rpc/diagnostics', {
      method: 'GET',
    })
    const diagAfter = (await diagAfterResponse.json()) as {
      storageWrites: number
    }
    expect(diagAfter.storageWrites).toBe(diagBefore.storageWrites)
  }, 15_000)

  it('returns 404 for unknown RPC routes', async () => {
    const serverId = 'test-srv-unknown-rpc'
    const stub = env.DAEMON_CELL.getByName(serverId)

    const response = await cellRpc(stub, serverId, '/rpc/unknown-route', {
      method: 'GET',
    })
    expect(response.status).toBe(404)
  })

  it('lists persisted requests and supports snapshot patch', async () => {
    const serverId = 'test-srv-list-and-patch'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const at = new Date().toISOString()

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at,
          commandId: 'cmd-list',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })

    const listResponse = await cellRpc(
      stub,
      serverId,
      '/rpc/requests?limit=5&requestKind=command-dispatch',
      { method: 'GET' }
    )
    const listBody = (await listResponse.json()) as {
      records: Array<{ requestId: string }>
    }
    expect(listBody.records.some((row) => row.requestId === requestId)).toBe(true)

    const patchResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'PATCH',
      body: JSON.stringify({
        patch: { connected: false },
      }),
    })
    expect(patchResponse.status).toBe(200)
    const patched = (await patchResponse.json()) as { connected: boolean }
    expect(patched.connected).toBe(false)
  })

  it('closes websocket on oversized inbound frames before storage work', async () => {
    const serverId = 'test-srv-inbound-oversize-frame'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener('close', (event) => {
        resolve({ code: event.code, reason: event.reason })
      })
    })

    const diagBeforeResponse = await cellRpc(stub, serverId, '/rpc/diagnostics', {
      method: 'GET',
    })
    const diagBefore = (await diagBeforeResponse.json()) as {
      storageWrites: number
    }

    const padding = 'x'.repeat(260 * 1024)
    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        at: new Date().toISOString(),
        pad: padding,
      })
    )

    const closed = await closePromise
    expect(closed.code).toBe(1008)
    expect(closed.reason).toBe('policy_violation')

    const diagAfterResponse = await cellRpc(stub, serverId, '/rpc/diagnostics', {
      method: 'GET',
    })
    const diagAfter = (await diagAfterResponse.json()) as {
      storageWrites: number
    }
    expect(diagAfter.storageWrites).toBe(diagBefore.storageWrites)
  }, 15_000)
})

type StorageByCallSite = Record<string, { reads: number; writes: number }>

function assertNoMisattributedStorage(storageByCallSite: StorageByCallSite): void {
  expect(storageByCallSite['unknown']).toBeUndefined()
  for (const [callSite, counts] of Object.entries(storageByCallSite)) {
    expect(
      counts.reads + counts.writes,
      `expected non-zero storage ops for ${callSite}`
    ).toBeGreaterThan(0)
  }
}

async function readDiagnostics(
  stub: DurableObjectStub,
  serverId: string
): Promise<{
  storageReads: number
  storageWrites: number
  storageByCallSite: StorageByCallSite
  alarmInvocations: number
  wsClosed: number
  cleanupCount: number
}> {
  const response = await cellRpc(stub, serverId, '/rpc/diagnostics', {
    method: 'GET',
  })
  expect(response.status).toBe(200)
  return (await response.json()) as {
    storageReads: number
    storageWrites: number
    storageByCallSite: StorageByCallSite
    alarmInvocations: number
    wsClosed: number
    cleanupCount: number
  }
}

describe('DaemonCellObject storageByCallSite attribution', () => {
  it('attributes SQL ops across enqueue, outbound pump, inbound, list, expire, clear-update, purge', async () => {
    const serverId = 'test-srv-storage-attrib-lifecycle'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const at = new Date().toISOString()

    // Listen before enqueue — the outbox pump may deliver synchronously.
    const wirePromise = waitForWebSocketMessage(ws, 5000)

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at,
          commandId: 'cmd-attrib',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })

    // Live socket → outbox pump should claim + mark-sent + ack delivery.
    await waitFor(async () => {
      const diag = await readDiagnostics(stub, serverId)
      expect(diag.storageByCallSite['enqueue']).toBeTruthy()
      expect(diag.storageByCallSite['attach']).toBeTruthy()
      expect(diag.storageByCallSite['delivery-read']).toBeTruthy()
      expect(diag.storageByCallSite['mark-sent']).toBeTruthy()
      expect(diag.storageByCallSite['delivery-ack']).toBeTruthy()
      assertNoMisattributedStorage(diag.storageByCallSite)
    })

    const wire = await wirePromise
    expect(wire).toContain('command-dispatch')

    const ackAt = new Date().toISOString()
    await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'command-ack',
          requestId,
          at: ackAt,
          daemonReceivedAt: ackAt,
        },
      }),
    })
    await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'command-outcome',
          requestId,
          at: new Date(Date.now() + 250).toISOString(),
          ok: true,
          result: { pong: true },
          daemonReceivedAt: ackAt,
          daemonRespondedAt: new Date(Date.now() + 250).toISOString(),
        },
      }),
    })

    const listResponse = await cellRpc(
      stub,
      serverId,
      '/rpc/requests?limit=10&requestKind=command-dispatch',
      { method: 'GET' }
    )
    expect(listResponse.status).toBe(200)

    let diag = await readDiagnostics(stub, serverId)
    expect(diag.storageByCallSite['handle-inbound']).toBeTruthy()
    expect(diag.storageByCallSite['request-read']).toBeTruthy()
    assertNoMisattributedStorage(diag.storageByCallSite)

    // Fresh update row → mark terminal → clear-update-status purges under its call site.
    const updateRequestId = generateRequestId()
    const updateDeliveryId = generateDeliveryId()
    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'update',
          deliveryId: updateDeliveryId,
          requestId: updateRequestId,
          at: new Date().toISOString(),
          channel: 'trunk',
        },
      }),
    })

    // Mark the update terminal via SQL so clearUpdateStatus can purge it.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE request SET status = 'done', finished_at = ?, updated_at = ?
         WHERE request_id = ?`,
        new Date().toISOString(),
        new Date().toISOString(),
        updateRequestId
      )
    })

    const clearResponse = await cellRpc(stub, serverId, '/rpc/clear-update-status', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(clearResponse.status).toBe(200)

    const expireRequestId = generateRequestId()
    const expireDeliveryId = generateDeliveryId()
    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId: expireDeliveryId,
          requestId: expireRequestId,
          at: new Date().toISOString(),
          commandId: 'cmd-expire-attrib',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })
    const expireResponse = await cellRpc(stub, serverId, '/rpc/expire-request', {
      method: 'POST',
      body: JSON.stringify({ requestId: expireRequestId }),
    })
    expect(expireResponse.status).toBe(200)

    diag = await readDiagnostics(stub, serverId)
    expect(diag.storageByCallSite['clear-update-status']).toBeTruthy()
    expect(diag.storageByCallSite['expire-request']).toBeTruthy()
    assertNoMisattributedStorage(diag.storageByCallSite)

    const purgeResponse = await cellRpc(stub, serverId, '/rpc/purge-cell', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(purgeResponse.status).toBe(200)

    diag = await readDiagnostics(stub, serverId)
    expect(diag.storageByCallSite['purge']).toBeTruthy()
    expect(diag.storageByCallSite['purge'].writes).toBeGreaterThan(0)
    assertNoMisattributedStorage(diag.storageByCallSite)

    ws.close(1000, 'test done')
  }, 20_000)

  it('schema upgrade wipe attributes ensure-schema DDL writes', async () => {
    const serverId = 'test-srv-schema-upgrade-attrib'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE _cell_schema SET version = 1 WHERE id = 1')
    })

    const ensureCounts = await runInDurableObject(stub, async (_instance, state) => {
      const upgraded = new DaemonCellObject(state, env)
      const snapshotResp = await upgraded.fetch(
        new Request('https://do.internal/rpc/snapshot', {
          method: 'GET',
          headers: { [CELL_HEADER]: serverId },
        })
      )
      expect(snapshotResp.status).toBe(200)
      const diagResp = await upgraded.fetch(
        new Request('https://do.internal/rpc/diagnostics', {
          method: 'GET',
          headers: { [CELL_HEADER]: serverId },
        })
      )
      const diag = (await diagResp.json()) as {
        storageByCallSite: StorageByCallSite
      }
      assertNoMisattributedStorage(diag.storageByCallSite)
      return (
        diag.storageByCallSite['ensure-schema'] ?? {
          reads: 0,
          writes: 0,
        }
      )
    })

    expect(ensureCounts.writes).toBeGreaterThan(0)
    expect(ensureCounts.reads).toBeGreaterThan(0)

    await runInDurableObject(stub, (_instance, state) => {
      const row = [
        ...state.storage.sql.exec('SELECT version FROM _cell_schema WHERE id = 1'),
      ][0] as { version?: number } | undefined
      expect(Number(row?.version ?? 0)).toBe(CELL_SCHEMA_VERSION)
    })

    ws.close(1000, 'test done')
  }, 15_000)

  it('alarm cleanup attributes alarm call-site reads and writes', async () => {
    const serverId = 'test-srv-alarm-attrib'
    const stub = env.DAEMON_CELL.getByName(serverId)

    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at: new Date().toISOString(),
          commandId: 'cmd-alarm-attrib',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })

    await runInDurableObject(stub, (_instance, state) => {
      // Force the row past expires_at so #runAlarmCleanup deletes it.
      state.storage.sql.exec(
        `UPDATE request SET expires_at = ?, status = 'queued'
         WHERE request_id = ?`,
        new Date(Date.now() - 60_000).toISOString(),
        requestId
      )
    })

    const diagBefore = await readDiagnostics(stub, serverId)
    const alarmWritesBefore = diagBefore.storageByCallSite['alarm']?.writes ?? 0
    const alarmReadsBefore = diagBefore.storageByCallSite['alarm']?.reads ?? 0

    await runInDurableObject(stub, async (instance: DaemonCellObject) => {
      await instance.alarm()
    })

    const diagAfter = await readDiagnostics(stub, serverId)
    expect((diagAfter.storageByCallSite['alarm']?.writes ?? 0) - alarmWritesBefore).toBeGreaterThan(
      0
    )
    expect((diagAfter.storageByCallSite['alarm']?.reads ?? 0) - alarmReadsBefore).toBeGreaterThan(0)
    expect(diagAfter.alarmInvocations).toBeGreaterThan(0)
    assertNoMisattributedStorage(diagAfter.storageByCallSite)
  }, 15_000)

  it('ArrayBuffer webSocketMessage heartbeats do not write cell rows', async () => {
    const serverId = 'test-srv-ws-arraybuffer-heartbeat'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const diagBefore = await readDiagnostics(stub, serverId)
    const recordInboundBefore = diagBefore.storageByCallSite['record-inbound']?.writes ?? 0

    const payload = new TextEncoder().encode(
      JSON.stringify({
        type: 'heartbeat',
        at: new Date().toISOString(),
      })
    )
    ws.send(payload)

    await new Promise((resolve) => setTimeout(resolve, 300))

    const diagAfter = await readDiagnostics(stub, serverId)
    const recordInboundAfter = diagAfter.storageByCallSite['record-inbound']?.writes ?? 0
    expect(recordInboundAfter - recordInboundBefore).toBe(0)
    assertNoMisattributedStorage(diagAfter.storageByCallSite)

    ws.close(1000, 'test done')
  }, 10_000)

  it('policy-violation close on invalid frame skips inbound storage sites', async () => {
    const serverId = 'test-srv-ws-policy-no-sql'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const diagBefore = await readDiagnostics(stub, serverId)
    const handleBefore = diagBefore.storageByCallSite['handle-inbound']?.writes ?? 0
    const recordBefore = diagBefore.storageByCallSite['record-inbound']?.writes ?? 0

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener('close', (event) => {
        resolve({ code: event.code, reason: event.reason })
      })
    })

    ws.send('{not-json')
    const closed = await closePromise
    expect(closed.code).toBe(1008)
    expect(closed.reason).toBe('policy_violation')

    // Frame rejected before #ensureSchema / inbound handlers; close cleanup may
    // still touch attach/cleanup sites, but never handle-inbound / record-inbound.
    const diagAfter = await readDiagnostics(stub, serverId)
    expect(diagAfter.storageByCallSite['handle-inbound']?.writes ?? 0).toBe(handleBefore)
    expect(diagAfter.storageByCallSite['record-inbound']?.writes ?? 0).toBe(recordBefore)
  }, 10_000)

  it('re-delivery enqueue refreshes delivery fields under enqueue call site', async () => {
    const serverId = 'test-srv-enqueue-redelivery-attrib'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()
    const firstDeliveryId = generateDeliveryId()
    const secondDeliveryId = generateDeliveryId()
    const at = new Date().toISOString()

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId: firstDeliveryId,
          requestId,
          at,
          commandId: 'cmd-redeliver',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })

    const diagBefore = await readDiagnostics(stub, serverId)
    const enqueueWritesBefore = diagBefore.storageByCallSite['enqueue']?.writes ?? 0

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId: secondDeliveryId,
          requestId,
          at,
          commandId: 'cmd-redeliver',
          commandType: 'daemon.ping',
          payload: { attempt: 2 },
        },
      }),
    })

    const diagAfter = await readDiagnostics(stub, serverId)
    expect(
      (diagAfter.storageByCallSite['enqueue']?.writes ?? 0) - enqueueWritesBefore
    ).toBeGreaterThan(0)
    assertNoMisattributedStorage(diagAfter.storageByCallSite)

    await runInDurableObject(stub, (_instance, state) => {
      const row = [
        ...state.storage.sql.exec(
          'SELECT delivery_id FROM request WHERE request_id = ?',
          requestId
        ),
      ][0] as { delivery_id?: string } | undefined
      expect(String(row?.delivery_id ?? '')).toBe(secondDeliveryId)
    })
  }, 10_000)
})

describe('DaemonCellObject alarm / outbox / RPC branch coverage', () => {
  it('alarm logs and rethrows when forced error is set', async () => {
    const serverId = 'test-srv-alarm-error-path'
    const stub = env.DAEMON_CELL.getByName(serverId)
    setForceAlarmErrorForTests(new Error('forced alarm failure'))

    await expect(
      runInDurableObject(stub, async (instance: DaemonCellObject) => {
        await instance.alarm()
      })
    ).rejects.toThrow('forced alarm failure')
  })

  it('alarm demotes stale sockets when auto-response age exceeds sweep window', async () => {
    const serverId = 'test-srv-alarm-stale-demote'
    const { db, updateCalls } = createProjectionRecordingDb({
      connected: true,
      statusChangedAt: new Date().toISOString(),
    })
    setDaemonCellProjectionDbFactoryForTests(() => db)

    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    setForceAutoResponseAgeMsForTests(DAEMON_OFFLINE_SWEEP_MS + 5_000)

    await runInDurableObject(stub, async (instance: DaemonCellObject) => {
      await instance.alarm()
    })

    await waitFor(() => {
      const offlinePatch = updateCalls.find((patch) => statusFromPatch(patch)?.connected === false)
      expect(offlinePatch).toBeDefined()
    })

    ws.close(1000, 'test done')
  }, 10_000)

  it('outbox send failure requeues with retry_at before poison threshold', async () => {
    const serverId = 'test-srv-outbox-retry-delay'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const deliveryId = generateDeliveryId()
    const requestId = generateRequestId()

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at: new Date().toISOString(),
          commandId: 'cmd-retry-delay',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })

    setForceOutboxSendErrorForTests(new Error('transient send failure'))
    const { ws } = await openDaemonWebSocket(stub, serverId)

    await waitFor(async () => {
      await runInDurableObject(stub, (_instance, state) => {
        const [row] = [
          ...state.storage.sql.exec(
            'SELECT delivery_status, retry_count, retry_at FROM request WHERE delivery_id = ?',
            deliveryId
          ),
        ]
        expect(String(row?.delivery_status ?? '')).toBe('queued')
        expect(Number(row?.retry_count ?? 0)).toBeGreaterThanOrEqual(1)
        expect(String(row?.retry_at ?? '')).toBeTruthy()
      })
    })

    setForceOutboxSendErrorForTests(null)
    ws.close(1000, 'test done')
  }, 15_000)

  it('/rpc/create-and-wait enqueues and returns the pending record', async () => {
    const serverId = 'test-srv-create-and-wait-rpc'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()

    const response = await cellRpc(stub, serverId, '/rpc/create-and-wait', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at: new Date().toISOString(),
          commandId: 'cmd-create-wait',
          commandType: 'daemon.ping',
          payload: {},
        },
        timeoutMs: 5_000,
      }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      record: { requestId: string; status: string }
    }
    expect(body.record.requestId).toBe(requestId)
    expect(body.record.status).toBe('queued')
  })

  it('clear-update-status expires stale in-flight updates via allowStale + ttl', async () => {
    const serverId = 'test-srv-clear-update-stale'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'update',
          deliveryId,
          requestId,
          at: new Date().toISOString(),
          channel: 'trunk',
        },
      }),
    })

    const staleQueuedAt = new Date(Date.now() - 60_000).toISOString()
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE request SET created_at = ?, updated_at = ? WHERE request_id = ?`,
        staleQueuedAt,
        staleQueuedAt,
        requestId
      )
    })

    const clearResponse = await cellRpc(stub, serverId, '/rpc/clear-update-status', {
      method: 'POST',
      body: JSON.stringify({
        allowStale: true,
        updateTtlMs: 1_000,
        queuedAt: staleQueuedAt,
      }),
    })
    expect(clearResponse.status).toBe(200)
    const clearBody = (await clearResponse.json()) as { cleared: number }
    expect(clearBody.cleared).toBeGreaterThanOrEqual(1)

    await runInDurableObject(stub, (_instance, state) => {
      const [row] = [
        ...state.storage.sql.exec('SELECT status FROM request WHERE request_id = ?', requestId),
      ]
      expect(row).toBeUndefined()
    })
  })

  it('applies late command-ack after terminal outcome and addresses-result inbound', async () => {
    const serverId = 'test-srv-late-ack-addresses'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command-dispatch',
          deliveryId,
          requestId,
          at: new Date().toISOString(),
          commandId: 'cmd-late-ack',
          commandType: 'daemon.ping',
          payload: {},
        },
      }),
    })

    const at = new Date().toISOString()
    await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'command-outcome',
          requestId,
          at,
          ok: true,
          result: { pong: true },
          daemonReceivedAt: at,
          daemonRespondedAt: at,
        },
      }),
    })

    // Mark ack_at null so late-ack path can fill it after terminal status.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE request SET ack_at = NULL WHERE request_id = ?`, requestId)
    })

    const lateAck = await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'command-ack',
          requestId,
          at: new Date().toISOString(),
          daemonReceivedAt: new Date().toISOString(),
        },
      }),
    })
    expect(lateAck.status).toBe(200)

    const addressesRequestId = generateRequestId()
    const addressesDeliveryId = generateDeliveryId()
    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'addresses-request',
          deliveryId: addressesDeliveryId,
          requestId: addressesRequestId,
          at: new Date().toISOString(),
        },
      }),
    })

    const addressesResult = await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'addresses-result',
          requestId: addressesRequestId,
          at: new Date().toISOString(),
          ips: [{ address: '203.0.113.10', version: 4, scope: 'public' }],
        },
      }),
    })
    expect(addressesResult.status).toBe(200)
    const addressesBody = (await addressesResult.json()) as {
      record: { status: string }
    }
    expect(addressesBody.record.status).toBe('done')
  })

  it('managed-logs-result marks failed when error is present', async () => {
    const serverId = 'test-srv-managed-logs-fail'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'managed-logs-request',
          deliveryId,
          requestId,
          at: new Date().toISOString(),
          managedId: crypto.randomUUID(),
          tail: 100,
        },
      }),
    })

    const response = await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'managed-logs-result',
          requestId,
          at: new Date().toISOString(),
          logs: '',
          error: 'engine unreachable',
        },
      }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { record: { status: string } }
    expect(body.record.status).toBe('failed')
  })

  it('fabric-paths-result correlates done and failed', async () => {
    const serverId = 'test-srv-fabric-paths'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const doneId = generateRequestId()
    const failId = generateRequestId()

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'fabric-paths-request',
          deliveryId: generateDeliveryId(),
          requestId: doneId,
          at: new Date().toISOString(),
          fabricId: crypto.randomUUID(),
          probeMs: 0,
          candidates: [],
        },
      }),
    })
    const doneResponse = await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'fabric-paths-result',
          requestId: doneId,
          at: new Date().toISOString(),
          paths: [
            {
              publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
              endpoint: '203.0.113.50:48172',
              health: 'healthy',
            },
          ],
        },
      }),
    })
    expect(doneResponse.status).toBe(200)
    const doneBody = (await doneResponse.json()) as {
      record: { status: string; result: { paths: unknown[] } }
    }
    expect(doneBody.record.status).toBe('done')
    expect(doneBody.record.result.paths).toHaveLength(1)

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'fabric-paths-request',
          deliveryId: generateDeliveryId(),
          requestId: failId,
          at: new Date().toISOString(),
          fabricId: crypto.randomUUID(),
          probeMs: 0,
          candidates: [],
        },
      }),
    })
    const failResponse = await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'fabric-paths-result',
          requestId: failId,
          at: new Date().toISOString(),
          paths: [],
          error: 'wg dump failed',
        },
      }),
    })
    expect(failResponse.status).toBe(200)
    const failBody = (await failResponse.json()) as {
      record: { status: string }
    }
    expect(failBody.record.status).toBe('failed')
  })
})

function wsSendCommandOutcome(ws: WebSocket, requestId: string): void {
  const at = new Date().toISOString()
  ws.send(
    JSON.stringify({
      type: 'command-ack',
      id: requestId,
      at,
      daemonReceivedAt: at,
    })
  )
  ws.send(
    JSON.stringify({
      type: 'command-outcome',
      id: requestId,
      at,
      ok: true,
      result: { pong: true },
      daemonReceivedAt: at,
      daemonRespondedAt: at,
    })
  )
}
