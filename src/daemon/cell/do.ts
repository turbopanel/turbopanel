/// <reference types="@cloudflare/workers-types" />
import type { DaemonJwtKeyring } from '../authn/daemon-jwt-keyring.ts'
import { deriveDaemonJwtKeyring } from '../authn/daemon-jwt-keyring.ts'
import { parseSecretsFromEnv } from '../../client/authn/secrets.ts'
import {
  createWorkersDb,
  type Db,
  DB_OP_TIMEOUT_MS,
  endDbConnection,
  raceWithTimeout,
  runWithDbTimeout,
} from '../../db.ts'
import { evaluateSocketHealth } from './socket-health.ts'
import type { ServerGeo } from '../../lib/geo/server-geo.ts'
import { parseServerGeo } from '../../lib/geo/server-geo.ts'
import {
  resourcesFromDaemonPresence,
  type ServerDockerMetadata,
  type ServerHostResources,
  type ServerOsMetadata,
  type ServerTimeSync,
} from '../../lib/db/server-metadata.ts'
import { TERMINAL_UPDATE_RETENTION_MS } from '../../lib/update/constants.ts'
import { handleManagedHaEvent } from '../../client/managed/ha-event.ts'
import { recordTopologyGeneration } from '../../client/servers/server-topology-records.ts'
import { touchServerMetadata } from '../../server-registry.ts'
import { verifyDaemonJwt } from '../authn/daemon-jwt.ts'
import { getServerDaemonStateByServerId } from '../authn/server-identity-db.ts'
import { inboundHeartbeatProjectionDue } from './postgres-projection.ts'
import { mergeSnapshotPresence } from './snapshot-merge.ts'
import {
  onDaemonConnected,
  onDaemonDisconnected,
  onDaemonInbound,
  onDaemonUpdateExpired,
  onDaemonUpdateResult,
} from './control-plane-monitor.ts'
import {
  type AnalyticsEngineDatasetLike,
  resolveServerMetricsStoreV5,
} from '../metrics/store-selection-workers.ts'
import { setServerStatusEventSink } from '../metrics/status-events.ts'
import type {
  CellDiagnostics,
  ClearUpdateStatusOptions,
  DaemonCell,
  DaemonCellLease,
  DaemonCellLiveness,
  DaemonCellSnapshot,
  PendingRequestRecord,
  PendingRequestStatus,
} from './contracts.ts'
import type {
  DaemonBuildInfo,
  DaemonInboundEnvelope,
  DaemonMessage,
  DaemonOutboundEnvelope,
  OutboxDeliveryId,
} from './protocol.ts'
import { deriveInboundOutcome } from './inbound-outcome.ts'
import {
  DAEMON_CELL_PING,
  DAEMON_CELL_PONG,
  DAEMON_OFFLINE_SWEEP_MS,
  DAEMON_WS_POLICY_VIOLATION_CLOSE,
  outboundEnvelopeToWireMessage,
  validateDaemonInboundEnvelope,
  validateDaemonInboundFrame,
  wireMessageToInboundEnvelope,
} from './protocol.ts'
import { classifyDaemonCellSqlStorageOp } from './sql-storage-classify.ts'
export { classifyDaemonCellSqlStorageOp }

/**
 * Hard client-side deadline for background work fired from the WS-upgrade /
 * enqueue paths (outbox pump) that is not gated behind `#withProjectionDb`'s
 * own `runWithDbTimeout` guard. Without a bound, a dangling/un-awaited
 * promise can keep riding Cloudflare's platform wall-time ceiling
 * (observed as `outcome: "exceededWallTime"` at ~30s, near-zero CPU) instead
 * of failing fast and leaving a trace — see the `exceededWallTime` bursts
 * this guard was added for (billing-audit follow-up, Jul 2026).
 */
const BACKGROUND_TASK_TIMEOUT_MS = 5_000

/**
 * Hard client-side deadline for daemon JWT keyring derivation on the
 * WS-upgrade path. This call is `await`ed directly — it gates the 101
 * response — so a stuck derivation must fail the upgrade fast (503) rather
 * than block it for Cloudflare's full wall-time ceiling.
 */
const JWT_KEYRING_TIMEOUT_MS = 5_000

function createInitialCellDiagnostics(): CellDiagnostics {
  return {
    backend: 'durable-object',
    usesHibernationWebSocket: true,
    constructorCalls: 0,
    wsAccepted: 0,
    wsClosed: 0,
    alarmInvocations: 0,
    heartbeatCount: 0,
    commandDispatchCount: 0,
    cleanupCount: 0,
    fetchByRoute: {},
    storageReads: 0,
    storageWrites: 0,
    // Null prototype so a callSite of "constructor" is not Object.prototype.constructor.
    storageByCallSite: Object.create(null) as Record<string, { reads: number; writes: number }>,
  }
}

/** Coerce an unknown RPC body field to a string; non-strings become "". */
function rpcString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Coerce a DO SQLite cell to string without Object's default `[object Object]`
 * / `[object ArrayBuffer]` stringification (`typescript:S6551`). TEXT columns
 * are strings; INTEGER may arrive as number; BLOB is unexpected for the text
 * fields we read and falls back.
 */
function sqlString(value: SqlStorageValue | undefined, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return `${value}`
  return fallback
}

/** Serialize a trace detail value without Object's default `[object Object]`. */
function serializeTraceValue(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return `${value}`
  }
  return JSON.stringify(value)
}

const TERMINAL_STATUSES = new Set<PendingRequestStatus>(['done', 'failed', 'expired'])

const DAEMON_SOCKET_LEASE_MS = 180_000
const OUTBOX_INFLIGHT_LEASE_MS = 30_000
const DELIVERY_LEASE_NAME = 'delivery'
const OUTBOX_PUMP_ALARM_MS = 2_000
const OUTBOX_MAX_RETRIES = 10
const OUTBOX_RETRY_MAX_MS = 300_000
const CELL_GEO_HEADER = 'X-Turbopanel-Cell-Geo'
/** Schema stamp in `_cell_schema.version` — bump when `#ensureSchema` DDL changes.
 * DO SQLite rejects `PRAGMA user_version` (`SQLITE_AUTH`); `#readSchemaVersion`
 * tries that pragma first and falls back to this table on failure. */
export const CELL_SCHEMA_VERSION = 2

type ProjectionDbFactory = () => Db | null
type DaemonJwtKeyringFactory = () => Promise<DaemonJwtKeyring>

let projectionDbFactoryForTests: ProjectionDbFactory | null = null
let daemonJwtKeyringFactoryForTests: DaemonJwtKeyringFactory | null = null
let forceOutboxSendErrorForTests: Error | null = null
let forceAlarmErrorForTests: Error | null = null
/** When set, `#collectStaleDemotions` treats auto-response age as this many ms. */
let forceAutoResponseAgeMsForTests: number | null = null

/** Test-only seam: override Postgres client used by DO→Postgres projection writes. */
export function setDaemonCellProjectionDbFactoryForTests(
  factory: ProjectionDbFactory | null
): void {
  projectionDbFactoryForTests = factory
}

/** Test-only seam: override JWT keyring derivation on the WS-upgrade path. */
export function setDaemonJwtKeyringFactoryForTests(factory: DaemonJwtKeyringFactory | null): void {
  daemonJwtKeyringFactoryForTests = factory
}

/**
 * Test-only seam: force `#pumpOutboxToDaemonSockets` send to throw so the
 * `#requeueOutbox` / poison-row path runs under real call-site attribution.
 */
export function setForceOutboxSendErrorForTests(error: Error | null): void {
  forceOutboxSendErrorForTests = error
}

/** Test-only seam: force `alarm()` into its catch / rethrow path. */
export function setForceAlarmErrorForTests(error: Error | null): void {
  forceAlarmErrorForTests = error
}

/**
 * Test-only seam: pretend the hibernation auto-response timestamp is this many
 * ms old so `#collectStaleDemotions` can run without waiting
 * `DAEMON_OFFLINE_SWEEP_MS`.
 */
export function setForceAutoResponseAgeMsForTests(ageMs: number | null): void {
  forceAutoResponseAgeMsForTests = ageMs
}

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString()
}

function safeParseMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

function readFirstSqlRow<T extends Record<string, SqlStorageValue>>(cursor: Iterable<T>): T | null {
  const iterator = cursor[Symbol.iterator]()
  const first = iterator.next()
  return first.done ? null : first.value
}

function sqlCursorHasRow(cursor: Iterable<unknown>): boolean {
  const iterator = cursor[Symbol.iterator]()
  return !iterator.next().done
}

function readSqlChanges(cursor: Iterable<Record<string, SqlStorageValue>>): number {
  const row = readFirstSqlRow(cursor)
  return row ? Number(row.c ?? 0) : 0
}

function outboxRetryDelayMs(retryCount: number): number {
  const exponent = Math.max(0, retryCount - 1)
  return Math.min(OUTBOX_PUMP_ALARM_MS * 2 ** exponent, OUTBOX_RETRY_MAX_MS)
}

function isTerminalStatus(status: PendingRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

function daemonBuildIdentityEqual(
  a: DaemonBuildInfo | undefined,
  b: DaemonBuildInfo | undefined
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.commit === b.commit &&
    a.buildId === b.buildId &&
    a.builtAt === b.builtAt &&
    a.channel === b.channel
  )
}

function snapshotFromMetaRow(
  serverId: string,
  row: Record<string, SqlStorageValue>,
  connected: boolean
): DaemonCellSnapshot {
  const remoteAddress = sqlString(row.remote_address)
  const keyLastUsedAt = sqlString(row.key_last_used_at)
  return {
    serverId,
    version: 0,
    updatedAt: sqlString(row.updated_at, nowIso()),
    remoteAddress: remoteAddress || undefined,
    connected,
    keyLastUsedAt: keyLastUsedAt || undefined,
  }
}

function parseRequestRow(
  serverId: string,
  row: Record<string, SqlStorageValue>
): PendingRequestRecord {
  const record: PendingRequestRecord = {
    serverId,
    requestId: sqlString(row.request_id),
    requestKind: sqlString(row.request_kind),
    status: sqlString(row.status, 'queued') as PendingRequestStatus,
    createdAt: sqlString(row.created_at, nowIso()),
    expiresAt: sqlString(row.expires_at, nowIso()),
  }
  const sentAt = sqlString(row.sent_at)
  if (sentAt) record.sentAt = sentAt
  const ackAt = sqlString(row.ack_at)
  if (ackAt) record.ackAt = ackAt
  const finishedAt = sqlString(row.finished_at)
  if (finishedAt) record.finishedAt = finishedAt
  const daemonReceivedAt = sqlString(row.daemon_received_at)
  if (daemonReceivedAt) record.daemonReceivedAt = daemonReceivedAt
  const daemonRespondedAt = sqlString(row.daemon_responded_at)
  if (daemonRespondedAt) record.daemonRespondedAt = daemonRespondedAt
  const error = sqlString(row.error)
  if (error) record.error = error
  const command = sqlString(row.command_text)
  if (command) record.command = command
  const resultJson = sqlString(row.result_json)
  if (resultJson) {
    try {
      record.result = JSON.parse(resultJson)
    } catch {
      record.result = resultJson
    }
  }
  return record
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status)
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  CLOUDFLARE DURABLE OBJECT — HIBERNATION COST RULES             ║
 * ║  Violating these rules causes continuous GB-sec billing.        ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  1. NO setInterval / setTimeout — use ctx.storage.setAlarm()   ║
 * ║  2. NO standard server.accept() — use ctx.acceptWebSocket()    ║
 * ║  3. NO polling loops inside handlers                            ║
 * ║  4. NO long-running awaits / pending promises in memory         ║
 * ║  5. Finish every handler quickly and return                     ║
 * ║  6. Close every outbound DB connection in a finally block       ║
 * ║  7. One stable DO id per server (getByName(serverId))           ║
 * ║  8. Workers (DO) and self-hosted (Redis) must stay in parity    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */
export class DaemonCellObject {
  readonly #ctx: DurableObjectState
  readonly #env: CloudflareBindings
  #schemaReady = false
  #daemonJwtKeyring: DaemonJwtKeyring | null = null
  #daemonJwtKeyringPromise: Promise<DaemonJwtKeyring> | null = null
  readonly #diag: CellDiagnostics = createInitialCellDiagnostics()
  readonly #debugStorage: boolean
  #serverId: string | null = null
  readonly #sweptOffline = new Set<string>()
  #runtimeConnected = false
  #lastProjectedAtMs: number | null = null
  #lastKnownDaemonBuild: DaemonBuildInfo | undefined
  #lastRemoteAddress: string | undefined
  #lastConnectedAt: string | undefined
  #scheduledAlarmMs: number | null = null
  #scheduledAlarmMsLoaded = false
  /** Per-connection inbound message counters (in-memory; no timers). */
  readonly #inboundRate = new Map<string, { windowStartMs: number; count: number }>()
  readonly #inboundLimit: number
  readonly #inboundWindowMs: number
  readonly #sql: (
    callSite: string,
    query: string,
    ...args: unknown[]
  ) => Iterable<Record<string, SqlStorageValue>>

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    this.#ctx = ctx
    this.#env = env
    this.#debugStorage = this.#isDaemonDebug()
    this.#inboundLimit = parsePositiveIntEnv(env.TURBOPANEL_DAEMON_WS_INBOUND_LIMIT, 120)
    this.#inboundWindowMs = parsePositiveIntEnv(env.TURBOPANEL_DAEMON_WS_INBOUND_WINDOW_MS, 60_000)
    const exec = ctx.storage.sql.exec.bind(ctx.storage.sql)
    // Always route through `#countStorage` — it no-ops unless debug is on.
    // Re-check live env so vitest can toggle `TURBOPANEL_DAEMON_DEBUG` after
    // construct (DO bindings share the same env object as the test harness).
    this.#sql = (callSite, query, ...args) => {
      this.#countStorage(callSite, query)
      return exec(query, ...args)
    }
    this.#diag.constructorCalls += 1
    if (this.#isDaemonDebug()) {
      console.debug('daemon cell diagnostics: constructor')
    }
    // Write-only status sink for connect/disconnect projection — pure
    // construction, zero I/O, zero SQLite, no alarm (hibernation-safe).
    setServerStatusEventSink(
      resolveServerMetricsStoreV5({
        runtime: 'workers',
        analyticsEngine: (env as { SERVER_METRICS_V5?: AnalyticsEngineDatasetLike })
          .SERVER_METRICS_V5,
      })
    )
    this.#ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(DAEMON_CELL_PING, DAEMON_CELL_PONG)
    )
    this.#initializeFromStorage()
  }

  /**
   * Sync constructor bootstrap — restore hibernation WebSocket attachments only.
   *
   * Deliberately skips `#ensureSchema()` so a cold wake that only handles
   * liveness/diagnostics never pays SQLite schema reads/writes.
   * Callers that touch cell SQLite (`fetch` upgrade/storage RPCs,
   * `webSocketMessage`, close/error cleanup, `alarm`) invoke `#ensureSchema()`
   * lazily before those paths.
   *
   * Prefer the restored hibernation WebSocket attachment for `#serverId` and
   * projection identity (`remoteAddress` / `connectedAt`) so a `checkLiveness`
   * wake or self-heal `onDaemonConnected` with a live socket pays no
   * business-row SQLite reads. Socket-less wakes (sweep probe against a cell
   * with no restored attachment) resolve the id from the request header via
   * `#resolveServerIdInMemory` (liveness) or `#resolveServerId` (snapshot/
   * alarm — SQLite fallback only when the header is absent). Trade-off: on a
   * wake with a live socket, `#lastKnownDaemonBuild` starts `undefined`; admin
   * `#getSnapshot` reads the daemon build from Postgres, and
   * `#shouldProjectInbound` will at most treat the first build-carrying
   * message after a wake as changed → one extra, correct projection. Rare
   * (heartbeats are build-gated) and never a SQLite write.
   */
  #initializeFromStorage(): void {
    for (const ws of this.#ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as {
        serverId?: string
        remoteAddress?: string
        connectedAt?: string
        connectedAtMs?: number
      } | null
      const id = attachment?.serverId?.trim()
      if (!id) continue
      this.#serverId = id
      this.#runtimeConnected = true
      this.#restoreProjectionIdentityFromAttachment(attachment)
      return
    }
  }

  /**
   * Parse hibernation-safe projection identity from a WebSocket attachment.
   * Prefer an explicit `connectedAt` ISO string; otherwise derive from
   * `connectedAtMs`. Never touches SQLite.
   */
  #projectionIdentityFromAttachment(
    attachment: {
      remoteAddress?: string
      connectedAt?: string
      connectedAtMs?: number
    } | null
  ): { remoteAddress?: string; connectedAt?: string } {
    if (!attachment) return {}
    const remoteAddress =
      typeof attachment.remoteAddress === 'string' && attachment.remoteAddress
        ? attachment.remoteAddress
        : undefined
    if (typeof attachment.connectedAt === 'string' && attachment.connectedAt) {
      return { remoteAddress, connectedAt: attachment.connectedAt }
    }
    if (typeof attachment.connectedAtMs === 'number') {
      return {
        remoteAddress,
        connectedAt: new Date(attachment.connectedAtMs).toISOString(),
      }
    }
    return { remoteAddress }
  }

  /** Restore `#lastRemoteAddress` / `#lastConnectedAt` from an attachment. */
  #restoreProjectionIdentityFromAttachment(
    attachment: {
      remoteAddress?: string
      connectedAt?: string
      connectedAtMs?: number
    } | null
  ): void {
    const identity = this.#projectionIdentityFromAttachment(attachment)
    if (identity.remoteAddress) {
      this.#lastRemoteAddress = identity.remoteAddress
    }
    if (identity.connectedAt) {
      this.#lastConnectedAt = identity.connectedAt
    }
  }

  /**
   * Projection identity from live hibernation attachments when private fields
   * were not restored (or were cleared). In-memory only — no SQLite.
   */
  #projectionIdentityFromAttachments(serverId: string): {
    remoteAddress?: string
    connectedAt?: string
  } {
    for (const ws of this.#ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as {
        serverId?: string
        remoteAddress?: string
        connectedAt?: string
        connectedAtMs?: number
      } | null
      if (attachment?.serverId !== serverId) continue
      return this.#projectionIdentityFromAttachment(attachment)
    }
    return {}
  }

  async #loadScheduledAlarmMsIfNeeded(): Promise<void> {
    if (this.#scheduledAlarmMsLoaded) return
    this.#scheduledAlarmMs = await this.#ctx.storage.getAlarm()
    this.#scheduledAlarmMsLoaded = true
  }

  #hasLiveSocket(serverId: string): boolean {
    return this.#ctx.getWebSockets().some((ws) => {
      const attachment = ws.deserializeAttachment() as {
        serverId?: string
      } | null
      return attachment?.serverId === serverId
    })
  }

  /**
   * Read-only liveness probe for the offline sweep cron (`cell/offline-sweep.ts`).
   * Only inspects in-memory WebSocket state — no SQLite reads or writes — so
   * a healthy server costs the sweep nothing beyond this one request.
   */
  #getLivenessSnapshot(serverId: string): DaemonCellLiveness {
    let connected = false
    let lastPingAtMs: number | null = null
    const allSockets = this.#ctx.getWebSockets()
    for (const ws of allSockets) {
      const attachment = ws.deserializeAttachment() as {
        serverId?: string
      } | null
      if (attachment?.serverId !== serverId) continue
      connected = true
      const autoTs = this.#ctx.getWebSocketAutoResponseTimestamp(ws)
      if (autoTs) {
        lastPingAtMs = Math.max(lastPingAtMs ?? 0, autoTs.getTime())
      }
    }
    return { connected, lastPingAtMs }
  }

  /**
   * Watchdog: force-close daemon sockets that are dead/half-open or have exceeded
   * the hard max lifetime, driven by the once-a-minute offline-sweep cron via
   * `/rpc/liveness`. In-memory only (getWebSockets + auto-response timestamp +
   * ws.close) — no SQLite, so the liveness probe stays cold-wake cheap. The
   * subsequent `webSocketClose` event runs the normal lease cleanup + Postgres
   * demotion. This bounds worst-case single-socket billing without a per-DO
   * periodic alarm (which would itself be a recurring SQLite row-write cost).
   */
  #reapUnhealthySockets(serverId: string, nowMs: number): void {
    for (const ws of this.#ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as {
        serverId?: string
        connectedAtMs?: number
      } | null
      if (attachment?.serverId !== serverId) continue

      const autoTs = this.#ctx.getWebSocketAutoResponseTimestamp(ws)
      const decision = evaluateSocketHealth({
        nowMs,
        connectedAtMs:
          typeof attachment.connectedAtMs === 'number' ? attachment.connectedAtMs : null,
        lastPingAtMs: autoTs ? autoTs.getTime() : null,
      })
      if (!decision.reap) continue

      console.info(
        `daemon-cell event=watchdog-close serverId=${serverId} reason=${decision.reason}`
      )
      try {
        ws.close(4001, `watchdog:${decision.reason}`)
      } catch {
        // Socket may already be closing.
      }
    }
  }

  #bumpFetchRoute(route: string): void {
    this.#diag.fetchByRoute[route] = (this.#diag.fetchByRoute[route] ?? 0) + 1
    if (this.#isDaemonDebug()) {
      console.debug(`daemon cell diagnostics: fetchByRoute ${route}`)
    }
  }

  #bumpDiag(
    field:
      | 'wsAccepted'
      | 'wsClosed'
      | 'alarmInvocations'
      | 'heartbeatCount'
      | 'commandDispatchCount'
      | 'cleanupCount'
  ): void {
    this.#diag[field] += 1
    if (this.#isDaemonDebug()) {
      console.debug(`daemon cell diagnostics: ${field}`)
    }
  }

  #isDaemonDebug(): boolean {
    return this.#env.TURBOPANEL_DAEMON_DEBUG === '1' || this.#env.TURBOPANEL_DAEMON_DEBUG === 'true'
  }

  /** Prefer live env so vitest can toggle `TURBOPANEL_DAEMON_DEBUG` after construct. */
  #storageDebugEnabled(): boolean {
    return this.#debugStorage || this.#isDaemonDebug()
  }

  #trace(event: string, detail: Record<string, unknown>, level: 'debug' | 'info' = 'debug'): void {
    if (!this.#isDaemonDebug()) return
    const parts: string[] = [`daemon-cell event=${event}`]
    for (const key of Object.keys(detail).sort((a, b) => a.localeCompare(b))) {
      const value = detail[key]
      if (value === undefined || value === null) continue
      parts.push(`${key}=${serializeTraceValue(value)}`)
    }
    const line = parts.join(' ')
    if (level === 'info') {
      console.info(line)
    } else {
      console.debug(line)
    }
  }

  /**
   * Fire background work via `ctx.waitUntil` with a hard timeout instead of a
   * bare un-awaited (`void ...`) call. A dangling promise inside a Durable
   * Object handler has no bound at all — if it stalls, the object rides
   * Cloudflare's platform wall-time ceiling (~30s) to `exceededWallTime`
   * with no application-level trace. This wraps it in `raceWithTimeout` and
   * `#trace`s + `console.error`s on timeout so a stuck call fails fast and
   * leaves evidence for the next billing audit.
   */
  #runBoundedBackground(
    label: string,
    serverId: string,
    work: Promise<void>,
    timeoutMs: number = BACKGROUND_TASK_TIMEOUT_MS
  ): void {
    this.#ctx.waitUntil(
      raceWithTimeout(work, timeoutMs, `${label} exceeded ${timeoutMs}ms timeout`).catch((err) => {
        console.error(
          `daemon-cell event=background-timeout label=${label} serverId=${serverId} error=${
            err instanceof Error ? err.message : String(err)
          }`
        )
      })
    )
  }

  #bumpStorageCount(callSite: string, kind: 'read' | 'write'): void {
    if (!this.#isDaemonDebug()) return
    if (kind === 'read') {
      this.#diag.storageReads += 1
    } else {
      this.#diag.storageWrites += 1
    }
    const bucket = this.#diag.storageByCallSite[callSite] ?? { reads: 0, writes: 0 }
    if (kind === 'read') {
      bucket.reads += 1
    } else {
      bucket.writes += 1
    }
    this.#diag.storageByCallSite[callSite] = bucket
    this.#trace('storage-op', { callSite, kind })
  }

  #countStorage(callSite: string, query: string): void {
    if (!this.#isDaemonDebug()) return
    const kind = classifyDaemonCellSqlStorageOp(query)
    if (kind) this.#bumpStorageCount(callSite, kind)
  }

  async #setAlarm(callSite: string, timeMs: number): Promise<void> {
    if (this.#storageDebugEnabled()) this.#bumpStorageCount(callSite, 'write')
    await this.#ctx.storage.setAlarm(timeMs)
  }

  async #deleteAlarm(callSite: string): Promise<void> {
    if (this.#storageDebugEnabled()) this.#bumpStorageCount(callSite, 'write')
    await this.#ctx.storage.deleteAlarm()
  }

  async #deleteAll(callSite: string): Promise<void> {
    if (this.#storageDebugEnabled()) this.#bumpStorageCount(callSite, 'write')
    await this.#ctx.storage.deleteAll()
  }

  async #getDaemonJwtKeyring(): Promise<DaemonJwtKeyring> {
    if (daemonJwtKeyringFactoryForTests) {
      return await daemonJwtKeyringFactoryForTests()
    }
    if (this.#daemonJwtKeyring) return this.#daemonJwtKeyring
    if (!this.#daemonJwtKeyringPromise) {
      this.#daemonJwtKeyringPromise = (async () => {
        const secretsConfig = parseSecretsFromEnv(
          {
            TURBOPANEL_SECRET: this.#env.TURBOPANEL_SECRET,
            TURBOPANEL_SECRETS: this.#env.TURBOPANEL_SECRETS,
          },
          'workers'
        )
        const keyring = await deriveDaemonJwtKeyring(secretsConfig)
        this.#daemonJwtKeyring = keyring
        return keyring
      })()
    }
    return await this.#daemonJwtKeyringPromise
  }

  /**
   * Read the schema stamp without DDL. Prefer `PRAGMA user_version` when the
   * runtime allows it; DO SQLite rejects that pragma (`SQLITE_AUTH`), so the
   * steady-state path is a single `SELECT` from `_cell_schema`. Returns `null`
   * when the stamp table/row is missing (first boot or wipe).
   */
  #readSchemaVersion(): number | null {
    try {
      const pragmaRow = readFirstSqlRow(this.#sql('ensure-schema', 'PRAGMA user_version'))
      if (pragmaRow) {
        const raw = pragmaRow.user_version ?? Object.values(pragmaRow)[0]
        const version = Number(raw ?? 0)
        if (version > 0) return version
      }
    } catch {
      // DO SQLite: SQLITE_AUTH — fall through to `_cell_schema`.
    }

    try {
      const versionRow = readFirstSqlRow(
        this.#sql('ensure-schema', 'SELECT version FROM _cell_schema WHERE id = 1')
      )
      if (!versionRow) return null
      return Number(versionRow.version ?? 0)
    } catch {
      // Missing `_cell_schema` table on a brand-new cell.
      return null
    }
  }

  #ensureSchema(): void {
    if (this.#schemaReady) return
    // Already-initialized cells: one cheap version read, no DDL probes.
    const existingVersion = this.#readSchemaVersion()
    if (existingVersion !== null && existingVersion >= CELL_SCHEMA_VERSION) {
      this.#schemaReady = true
      return
    }

    // Missing table / missing or stale stamp — create + stamp once.
    // Cell state is ephemeral/rebuildable (daemon reconnects; presence and
    // key_last_used_at are Postgres-canonical), so wipe-on-upgrade is safe.
    if (existingVersion !== null && existingVersion < CELL_SCHEMA_VERSION) {
      for (const table of ['cell', 'leases', 'outbox', 'requests', 'lease', 'request']) {
        this.#sql('ensure-schema', `DROP TABLE IF EXISTS ${table}`)
      }
    }

    this.#sql(
      'ensure-schema',
      `CREATE TABLE IF NOT EXISTS _cell_schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      )`
    )
    this.#sql(
      'ensure-schema',
      `
      CREATE TABLE IF NOT EXISTS cell (
        server_id TEXT PRIMARY KEY,
        remote_address TEXT,
        key_last_used_at TEXT,
        updated_at TEXT
      )
    `
    )
    this.#sql(
      'ensure-schema',
      `
      CREATE TABLE IF NOT EXISTS lease (
        lease_name TEXT PRIMARY KEY,
        holder TEXT,
        expires_at TEXT
      )
    `
    )
    this.#sql(
      'ensure-schema',
      `
      CREATE TABLE IF NOT EXISTS request (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT UNIQUE,
        delivery_id TEXT UNIQUE,
        request_kind TEXT,
        command_text TEXT,
        payload_json TEXT,
        status TEXT,
        delivery_status TEXT DEFAULT 'queued',
        result_json TEXT,
        error TEXT,
        created_at TEXT,
        updated_at TEXT,
        expires_at TEXT,
        sent_at TEXT,
        ack_at TEXT,
        finished_at TEXT,
        daemon_received_at TEXT,
        daemon_responded_at TEXT,
        retry_count INTEGER DEFAULT 0,
        retry_at TEXT
      )
    `
    )
    this.#sql(
      'ensure-schema',
      `INSERT INTO _cell_schema (id, version) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET version = excluded.version`,
      CELL_SCHEMA_VERSION
    )
    this.#schemaReady = true
  }

  /**
   * Resolve serverId for zero-SQLite read-only paths (`/rpc/liveness`).
   * Uses only `#serverId`, the cell header, and hibernation WebSocket
   * attachments — never `#sql` / `#resolveServerId`.
   */
  #resolveServerIdInMemory(request: Request): string | null {
    if (this.#serverId) return this.#serverId
    const header = request.headers.get('X-Turbopanel-Cell-Server-Id')?.trim()
    if (header) {
      this.#serverId = header
      return header
    }
    for (const ws of this.#ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as {
        serverId?: string
      } | null
      const id = attachment?.serverId?.trim()
      if (!id) continue
      this.#serverId = id
      return id
    }
    return null
  }

  #resolveServerId(request: Request): string | null {
    if (this.#serverId) return this.#serverId
    const header = request.headers.get('X-Turbopanel-Cell-Server-Id')?.trim()
    if (header) {
      this.#serverId = header
      return header
    }
    // Header-less callers only (alarm / debug / snapshot). Selects
    // `server_id` alone. Liveness must not call this — use
    // `#resolveServerIdInMemory` instead.
    try {
      const cursor = this.#sql('resolve-server-id', 'SELECT server_id FROM cell LIMIT 1')
      for (const row of cursor) {
        const serverId = sqlString(row.server_id)
        if (serverId) {
          this.#serverId = serverId
          return serverId
        }
      }
    } catch {
      // Schema may not exist yet on a brand-new cell.
    }
    return null
  }

  #ensureServerId(serverId: string): void {
    this.#sql(
      'ensure-server-id',
      `INSERT INTO cell (server_id, updated_at)
       VALUES (?, ?)
       ON CONFLICT(server_id) DO NOTHING`,
      serverId,
      nowIso()
    )
  }

  /**
   * Build a Postgres client for the sparse presence projection. The native
   * Workers WebSocket path terminates inside the Durable Object (hibernation),
   * so connect/disconnect/daemon-build transitions must be projected from here rather
   * than from the main worker. Returns `null` when no database binding is
   * configured (e.g. unit tests), making projection a no-op.
   */
  #newProjectionDb(): Db | null {
    if (projectionDbFactoryForTests) {
      return projectionDbFactoryForTests()
    }
    // Tight connect/statement bounds so a stalled Hyperdrive round-trip cannot
    // hold this projection open (defence-in-depth alongside runWithDbTimeout).
    const timeouts = {
      connectTimeoutSeconds: 10,
      statementTimeoutMs: DB_OP_TIMEOUT_MS,
    }
    if (this.#env.HYPERDRIVE) {
      return createWorkersDb(this.#env.HYPERDRIVE, timeouts)
    }
    const url = this.#env.TURBOPANEL_DATABASE_URL?.trim()
    if (url) {
      return createWorkersDb({ connectionString: url }, timeouts)
    }
    return null
  }

  // COST RULE: Every Hyperdrive/postgres.js client opened here MUST be closed in
  // the finally block, and the operation MUST be time-bounded. An open outbound
  // connection — or an unsettled promise awaiting one (e.g. via ctx.waitUntil on
  // attach) — prevents DO hibernation and bills the object for the entire
  // WebSocket lifetime. `runWithDbTimeout` is the hard client-side deadline that
  // guarantees this returns even if a Hyperdrive round-trip wedges; see the
  // 71-minute / 547 GB-s incident.
  async #withProjectionDb(
    label: string,
    serverId: string,
    fn: (db: Db) => Promise<void>
  ): Promise<void> {
    await this.#withProjectionDbResult(label, serverId, fn)
  }

  /** Value-returning projection DB helper (same timeout + close contract). */
  async #withProjectionDbResult<T>(
    label: string,
    serverId: string,
    fn: (db: Db) => Promise<T>
  ): Promise<T | null> {
    const db = this.#newProjectionDb()
    if (!db) return null
    try {
      return await runWithDbTimeout(db, fn)
    } catch (err) {
      console.error(
        `daemon cell ${label} projection failed (${serverId}): ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return null
    } finally {
      // Force-close even if the op timed out; endDbConnection has its own 5s cap.
      await endDbConnection(db).catch(() => {})
    }
  }

  /** Cheap in-memory snapshot for the Postgres projection path — no SQLite. */
  #buildRuntimeSnapshot(serverId: string): DaemonCellSnapshot {
    const connected = this.#runtimeConnected || this.#hasLiveSocket(serverId)
    const fromAttachment = this.#projectionIdentityFromAttachments(serverId)
    const connectedAt = this.#lastConnectedAt ?? fromAttachment.connectedAt
    const remoteAddress = this.#lastRemoteAddress ?? fromAttachment.remoteAddress
    const lastSeenAt =
      this.#lastProjectedAtMs !== null ? new Date(this.#lastProjectedAtMs).toISOString() : undefined
    return {
      serverId,
      version: 0,
      updatedAt: lastSeenAt ?? connectedAt ?? nowIso(),
      connected,
      connectedAt,
      lastInboundAt: lastSeenAt,
      lastSeenAt,
      remoteAddress,
      daemonBuild: this.#lastKnownDaemonBuild,
    }
  }

  /** Gate Postgres work using in-memory projection state before opening Hyperdrive. */
  #shouldProjectInbound(at: string, daemonBuild?: DaemonBuildInfo): boolean {
    const cellLastSeenAt =
      this.#lastProjectedAtMs !== null ? new Date(this.#lastProjectedAtMs).toISOString() : null

    return inboundHeartbeatProjectionDue({
      runtimeConnected: this.#runtimeConnected,
      cellLastSeenAt,
      inboundAt: at,
      storedDaemonBuild: this.#lastKnownDaemonBuild,
      incomingDaemonBuild: daemonBuild,
    })
  }

  /**
   * Minimal in-process `DaemonCell` facade backed by this cell's own storage so
   * the shared `control-plane-monitor` projection helpers can read/patch the
   * snapshot without an extra RPC round-trip.
   */
  #projectionCell(serverId: string): DaemonCell {
    return {
      getSnapshot: () => Promise.resolve(this.#buildRuntimeSnapshot(serverId)),
      putSnapshot: (patch: Partial<DaemonCellSnapshot>) => this.#putSnapshot(serverId, patch),
    } as unknown as DaemonCell
  }

  async #projectConnected(
    serverId: string,
    connectedAt: string,
    geo?: ServerGeo,
    keyId?: string
  ): Promise<void> {
    await this.#withProjectionDb('connect', serverId, async (db) => {
      await onDaemonConnected(
        db,
        serverId,
        this.#projectionCell(serverId),
        connectedAt,
        undefined,
        geo,
        keyId
      )
      if (this.#isDaemonDebug()) {
        console.debug(`daemon cell projection: connected (${serverId})`)
      }
    })
  }

  async #projectDisconnected(serverId: string): Promise<void> {
    await this.#withProjectionDb('disconnect', serverId, async (db) => {
      await onDaemonDisconnected(db, serverId, this.#projectionCell(serverId))
      if (this.#isDaemonDebug()) {
        console.debug(`daemon cell projection: disconnected (${serverId})`)
      }
    })
  }

  async #projectUpdateResult(
    serverId: string,
    requestId: string,
    ok: boolean,
    finishedAt: string,
    error?: string
  ): Promise<void> {
    await this.#withProjectionDb('update-result', serverId, async (db) => {
      await onDaemonUpdateResult(db, serverId, requestId, ok, finishedAt, error)
      if (this.#isDaemonDebug()) {
        console.debug(`daemon cell projection: update-result (${serverId})`)
      }
    })
  }

  async #projectUpdateExpired(
    serverId: string,
    requestId: string,
    finishedAt: string,
    error?: string
  ): Promise<void> {
    await this.#withProjectionDb('update-expired', serverId, async (db) => {
      await onDaemonUpdateExpired(db, serverId, requestId, finishedAt, error)
      if (this.#isDaemonDebug()) {
        console.debug(`daemon cell projection: update-expired (${serverId})`)
      }
    })
  }

  // COST RULE: #projectInbound for heartbeats runs only on daemon-build change,
  // timeSync / resources.ips / docker presence facts, or runtime/offline
  // repair evidence — never because INBOUND_PROJECTION_COALESCE_MS elapsed
  // alone. Hello keeps identity/geo handling. Steady-state idle traffic
  // performs no SQLite cell writes and never opens a Hyperdrive connection.
  // Every #withProjectionDb call closes the connection in its finally block —
  // no outbound socket lingers.
  async #projectInbound(
    serverId: string,
    at?: string,
    daemonBuild?: DaemonBuildInfo,
    hostIdentity?: {
      hostname?: string
      machineKey?: string
      os?: ServerOsMetadata
      resources?: ServerHostResources
      timeSync?: ServerTimeSync
      docker?: ServerDockerMetadata
    },
    geo?: ServerGeo
  ): Promise<void> {
    await this.#withProjectionDb('inbound', serverId, async (db) => {
      if (
        hostIdentity?.hostname ||
        hostIdentity?.machineKey ||
        hostIdentity?.os ||
        hostIdentity?.resources ||
        hostIdentity?.timeSync ||
        hostIdentity?.docker
      ) {
        await touchServerMetadata(db, serverId, {
          hostname: hostIdentity.hostname,
          machineKey: hostIdentity.machineKey,
          os: hostIdentity.os,
          resources: hostIdentity.resources,
          timeSync: hostIdentity.timeSync,
          docker: hostIdentity.docker,
        })
      }
      await onDaemonInbound(db, serverId, this.#projectionCell(serverId), {
        at,
        daemonBuild,
        geo,
      })
    })
    const atMs = at ? Date.parse(at) : Date.now()
    this.#lastProjectedAtMs = Number.isNaN(atMs) ? Date.now() : atMs
    if (daemonBuild) {
      this.#lastKnownDaemonBuild = daemonBuild
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      this.#ensureSchema()
      this.#bumpFetchRoute('ws-upgrade')
      return await this.#handleWebSocketUpgrade(request)
    }

    const url = new URL(request.url)
    if (!url.pathname.startsWith('/rpc/')) {
      return errorResponse('not found', 404)
    }

    try {
      return await this.#handleRpc(request, url)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return errorResponse(message, 500)
    }
  }

  #existingDaemonSocketHolder(): string | null {
    for (const ws of this.#ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as {
        connectionId?: string
      } | null
      const holder = attachment?.connectionId?.trim()
      if (holder) return holder
    }
    return null
  }

  /** True when no other live socket remains for this server (replace-safe). */
  #isSoleOrNoOtherLiveSocket(serverId: string, connectionId: string): boolean {
    return !this.#ctx.getWebSockets().some((ws) => {
      const attachment = ws.deserializeAttachment() as {
        serverId?: string
        connectionId?: string
      } | null
      return attachment?.serverId === serverId && attachment.connectionId !== connectionId
    })
  }

  #applyDaemonSocketAttach(
    serverId: string,
    connectionId: string,
    meta: {
      keyId: string
      remoteAddress?: string
      connectedAt?: string
    }
  ): DaemonCellLease {
    const connectedAt = meta.connectedAt ?? nowIso()
    const keyLastUsedAt = nowIso()
    const leaseExpiresAt = new Date(Date.now() + DAEMON_SOCKET_LEASE_MS).toISOString()

    this.#serverId = serverId
    this.#sweptOffline.delete(serverId)
    this.#runtimeConnected = true
    this.#lastRemoteAddress = meta.remoteAddress
    this.#lastConnectedAt = connectedAt

    this.#ctx.storage.transactionSync(() => {
      this.#ensureServerId(serverId)
      this.#sql(
        'attach',
        `INSERT INTO cell (
          server_id, remote_address, key_last_used_at, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          remote_address = excluded.remote_address,
          key_last_used_at = excluded.key_last_used_at,
          updated_at = excluded.updated_at`,
        serverId,
        meta.remoteAddress ?? '',
        keyLastUsedAt,
        connectedAt
      )
    })

    return {
      holder: connectionId,
      expiresAt: leaseExpiresAt,
    }
  }

  async #scheduleNearestAlarm(): Promise<void> {
    await this.#loadScheduledAlarmMsIfNeeded()
    const nowMs = Date.now()
    const candidates = this.#collectAlarmCandidates(nowMs)
    const target = candidates.length === 0 ? null : Math.min(...candidates)

    if (target === this.#scheduledAlarmMs) {
      return
    }

    if (target === null) {
      await this.#deleteAlarm('schedule-alarm')
    } else {
      await this.#setAlarm('schedule-alarm', target)
    }
    this.#scheduledAlarmMs = target
  }

  #collectAlarmCandidates(nowMs: number): number[] {
    const candidates: number[] = []
    const hasSocket = this.#ctx.getWebSockets().length > 0
    const now = nowIso(nowMs)

    const bumpPump = (candidateMs: number) => {
      if (candidateMs <= nowMs) {
        candidates.push(nowMs)
        return
      }
      candidates.push(candidateMs)
    }

    const bumpCleanup = (candidateMs: number) => {
      if (candidateMs <= nowMs) return
      candidates.push(candidateMs)
    }

    const hasDeliverableOutbox = this.#collectRequestAlarmTimes(
      now,
      hasSocket,
      bumpPump,
      bumpCleanup
    )

    if (hasSocket && hasDeliverableOutbox) {
      bumpPump(nowMs)
    }

    return candidates
  }

  /**
   * Single scan over `request` for delivery pump/inflight + correlation
   * expiry / terminal-retention alarm candidates.
   */
  #collectRequestAlarmTimes(
    now: string,
    hasSocket: boolean,
    bumpPump: (ms: number) => void,
    bumpCleanup: (ms: number) => void
  ): boolean {
    let hasDeliverableOutbox = false
    const cursor = this.#sql(
      'schedule-alarm',
      `SELECT delivery_status, status, retry_at, sent_at, expires_at, finished_at
       FROM request`
    )
    for (const row of cursor) {
      if (this.#applyOutboxRowToAlarmSchedule(row, now, hasSocket, bumpPump, bumpCleanup)) {
        hasDeliverableOutbox = true
      }

      // expires_at already scheduled via `#applyOutboxRowToAlarmSchedule`.
      const status = sqlString(row.status)
      const finishedAt = sqlString(row.finished_at) || null
      const finishedMs = safeParseMs(finishedAt)
      if (
        finishedMs !== null &&
        (status === 'acked' || status === 'done' || status === 'failed' || status === 'expired')
      ) {
        bumpCleanup(finishedMs + TERMINAL_UPDATE_RETENTION_MS)
      }
    }
    return hasDeliverableOutbox
  }

  #applyOutboxRowToAlarmSchedule(
    row: Record<string, SqlStorageValue>,
    now: string,
    hasSocket: boolean,
    bumpPump: (ms: number) => void,
    bumpCleanup: (ms: number) => void
  ): boolean {
    const deliveryStatus = sqlString(row.delivery_status)
    const retryAt = sqlString(row.retry_at) || null
    const sentAt = sqlString(row.sent_at) || null
    const expiresAt = sqlString(row.expires_at) || null

    let deliverable = false
    if (deliveryStatus === 'queued' && (!retryAt || retryAt <= now)) {
      deliverable = true
    }
    const retryMs = safeParseMs(retryAt)
    if (deliveryStatus === 'queued' && retryMs !== null && retryAt && retryAt > now && hasSocket) {
      bumpPump(retryMs)
    }
    const sentMs = safeParseMs(sentAt)
    if (deliveryStatus === 'inflight' && sentMs !== null && hasSocket) {
      bumpPump(sentMs + OUTBOX_INFLIGHT_LEASE_MS)
    }
    const expiresMs = safeParseMs(expiresAt)
    if (expiresMs !== null) {
      bumpCleanup(expiresMs)
    }
    return deliverable
  }

  #hasDeliverableOutbox(nowMs = Date.now()): boolean {
    const now = nowIso(nowMs)
    return sqlCursorHasRow(
      this.#sql(
        'schedule-alarm',
        `SELECT seq FROM request
       WHERE delivery_status = 'queued' AND (retry_at IS NULL OR retry_at <= ?)
       LIMIT 1`,
        now
      )
    )
  }

  #requeueExpiredInflightOutbox(nowMs = Date.now()): void {
    const cutoff = nowIso(nowMs - OUTBOX_INFLIGHT_LEASE_MS)
    this.#sql(
      'delivery-requeue',
      `UPDATE request SET delivery_status = 'queued', sent_at = NULL
       WHERE delivery_status = 'inflight'
         AND sent_at IS NOT NULL AND sent_at <= ?`,
      cutoff
    )
  }

  #requeueOutbox(deliveryId: string): void {
    const nowMs = Date.now()
    const cursor = this.#sql(
      'delivery-requeue',
      'SELECT retry_count FROM request WHERE delivery_id = ?',
      deliveryId
    )
    let retryCount = 0
    for (const row of cursor) {
      retryCount = Number(row.retry_count ?? 0)
    }

    const nextRetryCount = retryCount + 1
    if (nextRetryCount >= OUTBOX_MAX_RETRIES) {
      this.#sql(
        'delivery-requeue',
        `UPDATE request
         SET delivery_status = 'dead', retry_count = ?, retry_at = NULL,
             sent_at = NULL
         WHERE delivery_id = ?`,
        nextRetryCount,
        deliveryId
      )
      return
    }

    const retryAt = nowIso(nowMs + outboxRetryDelayMs(nextRetryCount))
    this.#sql(
      'delivery-requeue',
      `UPDATE request
       SET delivery_status = 'queued', retry_count = ?, retry_at = ?,
           sent_at = NULL
       WHERE delivery_id = ?`,
      nextRetryCount,
      retryAt,
      deliveryId
    )
  }

  async #scheduleOutboxRetryIfNeeded(): Promise<void> {
    if (!this.#hasDeliverableOutbox()) return
    await this.#scheduleNearestAlarm()
  }

  async #pumpOutboxToDaemonSockets(serverId: string): Promise<void> {
    const sockets = this.#ctx.getWebSockets()
    if (sockets.length === 0) return

    this.#requeueExpiredInflightOutbox()

    const batch = this.#readOutboxBatch(serverId, {
      consumer: 'do-ws',
      count: 50,
    })
    if (batch.length === 0) return

    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment() as {
        connectionId: string
        serverId: string
      } | null
      if (attachment?.serverId !== serverId) continue

      for (const envelope of batch) {
        try {
          const wireMsg = outboundEnvelopeToWireMessage(envelope)
          this.#trace('outbox-send', {
            serverId,
            conn: attachment.connectionId,
            deliveryId: envelope.deliveryId,
            requestId: envelope.requestId,
            kind: envelope.kind,
          })
          if (forceOutboxSendErrorForTests) {
            throw forceOutboxSendErrorForTests
          }
          ws.send(JSON.stringify(wireMsg))
          this.#markSent(serverId, envelope.deliveryId, attachment.connectionId)
          await this.#ackOutbox(serverId, [envelope.deliveryId])
        } catch {
          this.#requeueOutbox(envelope.deliveryId)
        }
      }
    }

    if (this.#hasDeliverableOutbox()) {
      await this.#scheduleOutboxRetryIfNeeded()
    } else {
      await this.#scheduleNearestAlarm()
    }
  }

  async #handleWebSocketUpgrade(request: Request): Promise<Response> {
    const authHeader = request.headers.get('Authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : ''
    if (!token) return new Response('Unauthorized', { status: 401 })

    let keyring: DaemonJwtKeyring
    try {
      keyring = await raceWithTimeout(
        this.#getDaemonJwtKeyring(),
        JWT_KEYRING_TIMEOUT_MS,
        `jwt keyring derivation exceeded ${JWT_KEYRING_TIMEOUT_MS}ms timeout`
      )
    } catch (err) {
      console.error(
        `daemon-cell event=jwt-keyring-timeout error=${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return new Response('Service Unavailable', { status: 503 })
    }
    const payload = await verifyDaemonJwt(token, keyring)
    if (!payload) return new Response('Unauthorized', { status: 401 })

    const serverId = payload.sub
    const keyId = payload.kid

    const connectionId = crypto.randomUUID()
    const connectedAt = nowIso()
    const remoteAddress = request.headers.get('X-Real-IP') ?? ''
    const geo = this.#parseConnectGeoHeader(request)

    const existingHolder = this.#existingDaemonSocketHolder()

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.#ctx.acceptWebSocket(server)
    this.#bumpDiag('wsAccepted')

    if (existingHolder && existingHolder !== connectionId) {
      for (const ws of this.#ctx.getWebSockets()) {
        if (ws !== server) {
          ws.close(4000, 'replaced by new connection')
        }
      }
    }

    const connectedAtMs = Date.parse(connectedAt) || Date.now()
    // Persist projection identity + cf geo on the hibernation attachment so
    // `#buildRuntimeSnapshot` / hello can backfill after a wake if the attach
    // waitUntil projection races or fails — without touching SQLite.
    server.serializeAttachment({
      connectionId,
      serverId,
      connectedAtMs,
      ...(remoteAddress ? { remoteAddress } : {}),
      ...(geo ? { geo } : {}),
    })

    this.#applyDaemonSocketAttach(serverId, connectionId, {
      keyId,
      remoteAddress,
      connectedAt,
    })

    this.#trace('attach', {
      serverId,
      conn: connectionId,
      remoteAddress,
    })

    console.info(
      `daemon-cell event=attach serverId=${serverId} conn=${connectionId} remoteAddress=${remoteAddress}`
    )

    this.#ctx.waitUntil(this.#projectConnected(serverId, connectedAt, geo ?? undefined, keyId))
    this.#runBoundedBackground('pump-outbox', serverId, this.#pumpOutboxToDaemonSockets(serverId))
    await this.#scheduleNearestAlarm()

    return new Response(null, { status: 101, webSocket: client })
  }

  #parseConnectGeoHeader(request: Request): ServerGeo | null {
    const raw = request.headers.get(CELL_GEO_HEADER)?.trim()
    if (!raw) return null
    try {
      return parseServerGeo(JSON.parse(raw))
    } catch {
      return null
    }
  }

  #recordInbound(
    serverId: string,
    _at: string,
    daemonBuild?: DaemonBuildInfo,
    connectionId?: string
  ): void {
    this.#sweptOffline.delete(serverId)
    if (this.#hasLiveSocket(serverId)) {
      this.#runtimeConnected = true
    }
    if (daemonBuild) {
      const daemonBuildChangedFlag = !daemonBuildIdentityEqual(
        daemonBuild,
        this.#lastKnownDaemonBuild
      )
      this.#lastKnownDaemonBuild = daemonBuild
      if (connectionId && this.#isDaemonDebug()) {
        this.#trace('record-inbound', {
          serverId,
          conn: connectionId,
          daemonBuildChanged: daemonBuildChangedFlag,
        })
      }
      return
    }

    if (connectionId && this.#isDaemonDebug()) {
      this.#trace('record-inbound', {
        serverId,
        conn: connectionId,
        daemonBuildChanged: false,
      })
    }
  }

  async #handlePresenceMessage(
    attachment: {
      connectionId: string
      serverId: string
      geo?: ServerGeo
    },
    parsed: {
      type: 'hello' | 'heartbeat'
      at?: string
      daemonBuild?: DaemonBuildInfo
      hostname?: string
      machineKey?: string
      os?: ServerOsMetadata
      resources?: ServerHostResources
      timeSync?: ServerTimeSync
      docker?: ServerDockerMetadata
    }
  ): Promise<void> {
    this.#bumpDiag('heartbeatCount')
    const at = parsed.at ?? nowIso()
    // Capture offline/runtime repair evidence before #recordInbound clears it.
    const needsOfflineRepair =
      !this.#runtimeConnected || this.#sweptOffline.has(attachment.serverId)
    const daemonBuildOrOfflineDue =
      this.#shouldProjectInbound(at, parsed.daemonBuild) || needsOfflineRepair
    this.#recordInbound(attachment.serverId, at, parsed.daemonBuild, attachment.connectionId)
    const presenceFacts = {
      timeSync: parsed.timeSync,
      resources: resourcesFromDaemonPresence(parsed),
      docker: parsed.docker,
    }
    const hasPresenceFacts = Boolean(
      presenceFacts.timeSync || presenceFacts.resources || presenceFacts.docker
    )
    // hostname/os stay hello-only; timeSync / resources / docker project
    // on both hello and change-detected heartbeats.
    let hostIdentity:
      | {
          hostname?: string
          machineKey?: string
          os?: ServerOsMetadata
          resources?: ServerHostResources
          timeSync?: ServerTimeSync
          docker?: ServerDockerMetadata
        }
      | undefined
    if (parsed.type === 'hello') {
      hostIdentity = {
        hostname: parsed.hostname,
        machineKey: parsed.machineKey,
        os: parsed.os,
        ...presenceFacts,
      }
    } else if (hasPresenceFacts) {
      hostIdentity = presenceFacts
    }
    const hasHostIdentity = Boolean(
      hostIdentity?.hostname ||
        hostIdentity?.machineKey ||
        hostIdentity?.os ||
        hostIdentity?.resources ||
        hostIdentity?.timeSync ||
        hostIdentity?.docker
    )
    const attachGeo = parseServerGeo(attachment.geo) ?? undefined
    // Heartbeats: daemon-build change, presence facts, or offline repair only —
    // never elapsed coalesce time alone. Hello keeps identity/geo handling
    // separate.
    const shouldProjectInbound =
      parsed.type === 'hello'
        ? daemonBuildOrOfflineDue ||
          Boolean(parsed.daemonBuild?.commit && parsed.daemonBuild?.buildId) ||
          hasHostIdentity ||
          Boolean(attachGeo)
        : daemonBuildOrOfflineDue || hasPresenceFacts
    if (shouldProjectInbound) {
      await this.#projectInbound(
        attachment.serverId,
        at,
        parsed.daemonBuild,
        hostIdentity,
        attachGeo
      )
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as {
      connectionId: string
      serverId: string
      geo?: ServerGeo
    } | null
    if (!attachment) return

    if (!this.#allowInboundMessage(attachment.connectionId, ws)) {
      return
    }

    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)

    const validated = validateDaemonInboundFrame(raw)
    if (!validated.ok) {
      this.#trace('inbound-rejected', {
        serverId: attachment.serverId,
        conn: attachment.connectionId,
        reason: validated.reason,
      })
      ws.close(DAEMON_WS_POLICY_VIOLATION_CLOSE, 'policy_violation')
      return
    }
    const parsed = validated.message

    this.#trace('inbound', {
      serverId: attachment.serverId,
      conn: attachment.connectionId,
      type: parsed.type,
    })

    try {
      this.#ensureSchema()

      if (parsed.type === 'hello' || parsed.type === 'heartbeat') {
        await this.#handlePresenceMessage(attachment, parsed)
        return
      }

      if (parsed.type === 'managed-ha-event') {
        this.#recordInbound(attachment.serverId, parsed.at, undefined, attachment.connectionId)
        await this.#withProjectionDb('managed-ha-event', attachment.serverId, async (db) => {
          await handleManagedHaEvent(
            db,
            {
              managedId: parsed.managedId,
              ...(parsed.sourceMemberId ? { sourceMemberId: parsed.sourceMemberId } : {}),
              at: parsed.at,
            },
            { reporterServerId: attachment.serverId }
          )
        })
        return
      }

      if (parsed.type === 'topology-report') {
        this.#recordInbound(attachment.serverId, parsed.at, undefined, attachment.connectionId)
        await this.#withProjectionDb('topology-report', attachment.serverId, async (db) => {
          await recordTopologyGeneration(db, attachment.serverId, {
            generation: parsed.generation,
            bootGeneration: parsed.bootGeneration,
            snapshot: parsed.snapshot,
            appliedAt: parsed.at,
          })
        })
        return
      }

      this.#recordInbound(attachment.serverId, parsed.at, undefined, attachment.connectionId)
      await this.#handleInboundMessage(attachment.serverId, parsed)
      await this.#scheduleNearestAlarm()
    } catch (err) {
      // Swallow — a bad/unexpected message must not terminate the DO instance.
      console.error(
        `daemon-cell event=ws-message-error serverId=${attachment.serverId} conn=${attachment.connectionId} type=${parsed.type}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  /**
   * In-memory per-connection flood cap. Window rollover uses `Date.now()` —
   * no timers, so hibernation eligibility is preserved. Auto-response pings
   * never reach `webSocketMessage`, so this only bounds hello/heartbeat/replies.
   */
  #allowInboundMessage(connectionId: string, ws: WebSocket): boolean {
    const now = Date.now()
    const existing = this.#inboundRate.get(connectionId)
    if (!existing || now - existing.windowStartMs >= this.#inboundWindowMs) {
      this.#inboundRate.set(connectionId, { windowStartMs: now, count: 1 })
      return true
    }
    existing.count += 1
    if (existing.count > this.#inboundLimit) {
      this.#inboundRate.delete(connectionId)
      ws.close(1008, 'rate_limited')
      return false
    }
    return true
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      this.#ensureSchema()
      await this.#cleanupWebSocket(ws, code, reason)
    } catch (err) {
      console.error(
        `daemon-cell event=ws-close-error code=${code} reason=${reason}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      this.#ensureSchema()
      await this.#cleanupWebSocket(ws, 1011, 'error')
    } catch (err) {
      console.error(
        `daemon-cell event=ws-error-cleanup-failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  async #cleanupWebSocket(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.#bumpDiag('wsClosed')
    this.#bumpDiag('cleanupCount')
    const attachment = ws.deserializeAttachment() as {
      connectionId: string
      serverId: string
    } | null
    if (!attachment) return

    this.#inboundRate.delete(attachment.connectionId)

    const isCurrentConnection = this.#isSoleOrNoOtherLiveSocket(
      attachment.serverId,
      attachment.connectionId
    )

    if (isCurrentConnection) {
      this.#runtimeConnected = false
      this.#trace('detach', {
        serverId: attachment.serverId,
        conn: attachment.connectionId,
        reason,
        code,
      })
      await this.#projectDisconnected(attachment.serverId)
      console.info(
        `daemon-cell event=detach serverId=${attachment.serverId} conn=${attachment.connectionId} code=${code} reason=${reason}`
      )
      await this.#scheduleNearestAlarm()
    }
  }

  #runAlarmCleanup(nowMs: number, now: string): Array<{ requestId: string }> {
    const expiringUpdates: Array<{ requestId: string }> = []
    const expiringCursor = this.#sql(
      'alarm',
      `SELECT request_id, request_kind, status FROM request
       WHERE expires_at <= ?
       AND request_kind = 'update'
       AND status NOT IN ('done', 'failed', 'expired', 'acked')`,
      now
    )
    for (const row of expiringCursor) {
      expiringUpdates.push({ requestId: sqlString(row.request_id) })
    }

    // Non-terminal rows only — terminal/acked-with-finished_at rows are owned by
    // the finished_at + TERMINAL_UPDATE_RETENTION_MS prune below (Redis parity).
    // Deleting by expires_at here would drop a reply that landed just before the
    // original TTL before polling consumers could read it.
    this.#sql(
      'alarm',
      `DELETE FROM request
       WHERE expires_at <= ?
       AND status NOT IN ('acked', 'done', 'failed', 'expired')`,
      now
    )
    this.#sql(
      'alarm',
      `DELETE FROM request
       WHERE status IN ('acked', 'done', 'failed', 'expired')
       AND finished_at IS NOT NULL
       AND finished_at <= ?`,
      nowIso(nowMs - TERMINAL_UPDATE_RETENTION_MS)
    )
    return expiringUpdates
  }

  /**
   * Opportunistic half-open backstop — runs only when `alarm()` fires for
   * genuine work (outbox retry, request expiry, terminal retention).
   *
   * **Disconnect-first trade-off (Workers):** connected-cell offline detection
   * is driven by `webSocketClose` / `webSocketError` → `#cleanupWebSocket`.
   * The periodic stale-sweep alarm is intentionally absent so idle cells stay
   * hibernating with zero storage writes. A truly silent half-open socket with
   * no pending work self-heals on the next reconnect (lease force-detach) or
   * command dispatch (outbox send failure → requeue → consumer timeout).
   * Redis (Deno) keeps a timer-driven sweep via `maintain()` instead.
   */
  #collectStaleDemotions(nowMs: number): string[] {
    const staleCutoffMs = nowMs - DAEMON_OFFLINE_SWEEP_MS
    const staleDemotions: string[] = []
    const liveSockets = this.#ctx.getWebSockets()
    if (liveSockets.length === 0) return staleDemotions

    for (const ws of liveSockets) {
      const attachment = ws.deserializeAttachment() as {
        serverId?: string
      } | null
      const staleServerId = attachment?.serverId ?? this.#serverId
      if (!staleServerId || this.#sweptOffline.has(staleServerId)) {
        continue
      }

      const autoTs =
        forceAutoResponseAgeMsForTests !== null
          ? new Date(Date.now() - forceAutoResponseAgeMsForTests)
          : this.#ctx.getWebSocketAutoResponseTimestamp(ws)
      if (!autoTs) continue

      if (autoTs.getTime() > staleCutoffMs) continue

      this.#sweptOffline.add(staleServerId)
      this.#runtimeConnected = false
      staleDemotions.push(staleServerId)
      console.info(`daemon-cell event=alarm-stale serverId=${staleServerId}`)
    }
    return staleDemotions
  }

  async alarm(): Promise<void> {
    this.#scheduledAlarmMs = null
    this.#bumpDiag('alarmInvocations')
    let alarmServerId = 'unknown'
    try {
      if (forceAlarmErrorForTests) {
        throw forceAlarmErrorForTests
      }
      this.#ensureSchema()
      const nowMs = Date.now()
      const now = nowIso(nowMs)
      const serverId = this.#resolveServerId(new Request('https://do.internal/'))
      if (serverId) alarmServerId = serverId

      const expiringUpdates = this.#runAlarmCleanup(nowMs, now)
      const staleDemotions = this.#collectStaleDemotions(nowMs)

      if (serverId && expiringUpdates.length > 0) {
        await this.#withProjectionDb('alarm-update-expired', serverId, async (db) => {
          for (const { requestId } of expiringUpdates) {
            await onDaemonUpdateExpired(db, serverId, requestId, now)
          }
        })
      }

      for (const staleServerId of staleDemotions) {
        await this.#projectDisconnected(staleServerId)
      }

      if (serverId) {
        this.#requeueExpiredInflightOutbox(nowMs)
        await this.#pumpOutboxToDaemonSockets(serverId)
      }

      await this.#scheduleNearestAlarm()
    } catch (err) {
      // Log then rethrow so Cloudflare's alarm retry/backoff still runs.
      console.error(
        `daemon-cell event=alarm-error serverId=${alarmServerId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      throw err
    }
  }

  async purge(): Promise<void> {
    for (const ws of this.#ctx.getWebSockets()) {
      try {
        ws.close(1000, 'cell purged')
      } catch {
        // Socket may already be closed.
      }
    }

    await this.#deleteAlarm('purge')
    await this.#deleteAll('purge')
    this.#scheduledAlarmMs = null
    this.#scheduledAlarmMsLoaded = false
    this.#schemaReady = false
    this.#runtimeConnected = false
    this.#lastRemoteAddress = undefined
    this.#lastConnectedAt = undefined
  }

  /** Read-only GET routes that don't need the shared body-parsing/switch below. */
  async #handleReadOnlyRpc(
    path: string,
    method: string,
    request: Request
  ): Promise<Response | null> {
    if (method !== 'GET') return null

    // In-memory only — never touch SQLite/schema (cold-wake safe).
    if (path === '/rpc/diagnostics') {
      return jsonResponse(this.#diag)
    }

    if (path === '/rpc/liveness') {
      // In-memory / header / attachment only — never `#resolveServerId`
      // (that helper's SQLite fallback would violate the zero-SQLite contract).
      const serverId = this.#resolveServerIdInMemory(request)
      if (!serverId) return errorResponse('server id unknown', 404)
      // Reuse the cron's liveness visit to reap dead/half-open or over-age
      // sockets (in-memory only; no SQLite) before reporting presence.
      // Offline-sweep AE short-circuit may skip this path for healthy hosts;
      // absolute max-age backstop moves daemon-side in a later phase.
      this.#reapUnhealthySockets(serverId, Date.now())
      return jsonResponse(this.#getLivenessSnapshot(serverId))
    }

    if (path === '/rpc/snapshot') {
      this.#ensureSchema()
      const serverId = this.#resolveServerId(request)
      if (!serverId) return errorResponse('server id unknown', 404)
      return jsonResponse(await this.#getSnapshot(serverId))
    }

    return null
  }

  async #handleRpc(request: Request, url: URL): Promise<Response> {
    const path = url.pathname
    const method = request.method
    this.#bumpFetchRoute(path)

    const readOnly = await this.#handleReadOnlyRpc(path, method, request)
    if (readOnly) return readOnly

    this.#ensureSchema()

    const body = method === 'GET' ? null : ((await request.json()) as Record<string, unknown>)

    switch (path) {
      case '/rpc/snapshot':
        if (method !== 'PATCH') return errorResponse('method not allowed', 405)
        return jsonResponse(
          await this.#putSnapshot(
            this.#requireServerId(request, body),
            (body?.patch ?? body) as Partial<DaemonCellSnapshot>
          )
        )

      case '/rpc/enqueue':
        return jsonResponse(
          this.#enqueue(
            this.#requireServerId(request, body),
            body?.outbound as DaemonOutboundEnvelope,
            body?.opts as { ttlSeconds?: number } | undefined
          )
        )

      case '/rpc/mark-sent':
        this.#markSent(
          this.#requireServerId(request, body),
          rpcString(body?.deliveryId),
          rpcString(body?.connectionId),
          body?.sentAt as string | undefined
        )
        return jsonResponse({ ok: true })

      case '/rpc/inbound':
        return jsonResponse({
          record: await this.#handleInbound(
            this.#requireServerId(request, body),
            body?.inbound as DaemonInboundEnvelope
          ),
        })

      case '/rpc/request':
        if (method !== 'GET') return errorResponse('method not allowed', 405)
        return jsonResponse({
          record: this.#getRequest(
            this.#resolveServerId(request),
            url.searchParams.get('requestId') ?? rpcString(body?.requestId)
          ),
        })

      case '/rpc/requests':
        if (method !== 'GET') return errorResponse('method not allowed', 405)
        return jsonResponse({
          records: this.#listRequests(
            this.#resolveServerId(request),
            Number(url.searchParams.get('limit') ?? 50),
            url.searchParams.get('requestKind') ?? undefined
          ),
        })

      case '/rpc/wait-request':
        return jsonResponse({
          record: this.#waitForRequest(
            this.#requireServerId(request, body),
            rpcString(body?.requestId),
            Number(body?.timeoutMs ?? 0)
          ),
        })

      case '/rpc/expire-request':
        return jsonResponse({
          record: await this.#expireRequest(
            this.#requireServerId(request, body),
            rpcString(body?.requestId)
          ),
        })

      case '/rpc/create-and-wait':
        return jsonResponse({
          record: await this.#createRequestAndWait(
            this.#requireServerId(request, body),
            body?.outbound as DaemonOutboundEnvelope,
            Number(body?.timeoutMs ?? 0)
          ),
        })

      case '/rpc/attach':
        return jsonResponse(
          this.#attachDaemonSocket(
            this.#requireServerId(request, body),
            body?.meta as {
              keyId: string
              remoteAddress?: string
              connectedAt?: string
            }
          )
        )

      case '/rpc/detach':
        await this.#detachDaemonSocket(
          this.#requireServerId(request, body),
          body?.params as {
            connectionId: string
            reason?: string
            closedAt?: string
          }
        )
        return jsonResponse({ ok: true })

      case '/rpc/record-inbound':
        this.#recordInbound(
          this.#requireServerId(request, body),
          String((body?.params as { at?: string })?.at ?? nowIso()),
          (body?.params as { daemonBuild?: DaemonBuildInfo })?.daemonBuild,
          (body?.params as { connectionId?: string })?.connectionId
        )
        return jsonResponse({ ok: true })

      case '/rpc/lease/claim':
        return jsonResponse({
          lease: this.#claimDeliveryLease(
            this.#requireServerId(request, body),
            rpcString(body?.holder),
            Number(body?.ttlMs ?? 0)
          ),
        })

      case '/rpc/lease/renew':
        return jsonResponse({
          lease: this.#renewDeliveryLease(
            this.#requireServerId(request, body),
            rpcString(body?.holder),
            Number(body?.ttlMs ?? 0)
          ),
        })

      case '/rpc/lease/release':
        this.#releaseDeliveryLease(this.#requireServerId(request, body), rpcString(body?.holder))
        return jsonResponse({ ok: true })

      case '/rpc/outbox/read':
        return jsonResponse({
          envelopes: this.#readOutboxBatch(
            this.#requireServerId(request, body),
            body?.params as {
              consumer: string
              count: number
              blockMs?: number
            }
          ),
        })

      case '/rpc/outbox/ack':
        await this.#ackOutbox(
          this.#requireServerId(request, body),
          (body?.deliveryIds ?? []) as OutboxDeliveryId[]
        )
        return jsonResponse({ ok: true })

      case '/rpc/clear-update-status':
        return jsonResponse(
          await this.#clearUpdateStatus(
            this.#requireServerId(request, body),
            body as ClearUpdateStatusOptions | null
          )
        )

      case '/rpc/purge-cell':
        await this.purge()
        return jsonResponse({ ok: true })

      default:
        return errorResponse('not found', 404)
    }
  }

  #requireServerId(request: Request, body: Record<string, unknown> | null): string {
    const fromBody = typeof body?.serverId === 'string' ? body.serverId.trim() : ''
    const serverId = fromBody || this.#resolveServerId(request)
    if (!serverId) throw new Error('server id unknown')
    this.#ensureServerId(serverId)
    return serverId
  }

  async #getSnapshot(serverId: string | null): Promise<DaemonCellSnapshot> {
    if (!serverId) {
      return {
        serverId: '',
        version: 0,
        updatedAt: nowIso(),
        connected: false,
      }
    }

    // Read-only: never insert `cell` here. Reading a missing or purged
    // snapshot returns a synthetic disconnected snapshot without recreating the
    // row. Row creation belongs only on mutation paths (attach, patch, enqueue,
    // and other writes that go through `#ensureServerId`).
    const row = readFirstSqlRow(
      this.#sql('snapshot', 'SELECT * FROM cell WHERE server_id = ?', serverId)
    )
    const base = row
      ? snapshotFromMetaRow(serverId, row, this.#runtimeConnected)
      : {
          serverId,
          version: 0,
          updatedAt: nowIso(),
          connected: false,
        }

    const daemonState = await this.#withProjectionDbResult('snapshot', serverId, (db) =>
      getServerDaemonStateByServerId(db, serverId)
    )
    if (daemonState) {
      const status = daemonState.status
      const projectionDaemonBuild = daemonState.projection?.daemonBuild
      let daemonBuild = this.#lastKnownDaemonBuild
      if (projectionDaemonBuild?.commit && projectionDaemonBuild.buildId) {
        daemonBuild = {
          commit: projectionDaemonBuild.commit,
          buildId: projectionDaemonBuild.buildId,
          ...(projectionDaemonBuild.builtAt ? { builtAt: projectionDaemonBuild.builtAt } : {}),
          ...(projectionDaemonBuild.channel ? { channel: projectionDaemonBuild.channel } : {}),
        }
      }
      const runtime = this.#buildRuntimeSnapshot(serverId)
      const projected: DaemonCellSnapshot = {
        ...base,
        connected: status?.connected ?? base.connected,
        connectedAt: status?.connected ? (status.statusChangedAt ?? undefined) : undefined,
        lastInboundAt: runtime.lastInboundAt,
        lastSeenAt: runtime.lastSeenAt,
        daemonBuild,
        remoteAddress: base.remoteAddress ?? daemonState.projection?.remoteAddress,
      }
      return mergeSnapshotPresence(projected, runtime)
    }

    // Fall back to in-memory presence + cell-row identity fields.
    const runtime = this.#buildRuntimeSnapshot(serverId)
    return {
      ...base,
      connected: runtime.connected,
      connectedAt: runtime.connectedAt,
      lastInboundAt: runtime.lastInboundAt,
      lastSeenAt: runtime.lastSeenAt,
      daemonBuild: runtime.daemonBuild,
      remoteAddress: base.remoteAddress ?? runtime.remoteAddress,
    }
  }

  async #putSnapshot(
    serverId: string,
    patch: Partial<DaemonCellSnapshot>
  ): Promise<DaemonCellSnapshot> {
    const updatedAt = nowIso()
    const fields: Array<string | null> = [updatedAt]
    let sql = 'UPDATE cell SET updated_at = ?'

    if (patch.keyLastUsedAt !== undefined) {
      sql += ', key_last_used_at = ?'
      fields.push(patch.keyLastUsedAt)
    }

    sql += ' WHERE server_id = ?'
    fields.push(serverId)
    this.#sql('snapshot', sql, ...fields)
    this.#trace('snapshot-put', {
      serverId,
      keys: Object.keys(patch).join(','),
    })
    return await this.#getSnapshot(serverId)
  }

  #enqueue(
    serverId: string,
    outbound: DaemonOutboundEnvelope,
    opts?: { ttlSeconds?: number }
  ): PendingRequestRecord {
    if (outbound.kind === 'command-dispatch') {
      this.#bumpDiag('commandDispatchCount')
    }
    const now = Date.now()
    const createdAt = outbound.at ?? nowIso(now)
    const ttlSeconds = opts?.ttlSeconds ?? 300
    const expiresAt = nowIso(now + ttlSeconds * 1000)
    const commandText = outbound.kind === 'command-dispatch' ? outbound.commandType : null
    const payloadJson = JSON.stringify(outbound)

    const existingRow = readFirstSqlRow(
      this.#sql('enqueue', 'SELECT * FROM request WHERE request_id = ?', outbound.requestId)
    )
    if (existingRow) {
      const existingDeliveryId = sqlString(existingRow.delivery_id)
      if (existingDeliveryId === outbound.deliveryId) {
        return parseRequestRow(serverId, existingRow)
      }

      // Re-delivery: refresh delivery fields; leave correlation status alone.
      this.#sql(
        'enqueue',
        `UPDATE request SET
           delivery_id = ?,
           payload_json = ?,
           delivery_status = 'queued',
           retry_count = 0,
           retry_at = NULL,
           sent_at = NULL,
           updated_at = ?
         WHERE request_id = ?`,
        outbound.deliveryId,
        payloadJson,
        nowIso(),
        outbound.requestId
      )
      const refreshed =
        readFirstSqlRow(
          this.#sql('enqueue', 'SELECT * FROM request WHERE request_id = ?', outbound.requestId)
        ) ?? existingRow
      this.#runBoundedBackground('pump-outbox', serverId, this.#pumpOutboxToDaemonSockets(serverId))
      void this.#scheduleOutboxRetryIfNeeded()
      this.#trace('enqueue', {
        serverId,
        requestId: outbound.requestId,
        deliveryId: outbound.deliveryId,
        kind: outbound.kind,
      })
      return parseRequestRow(serverId, refreshed)
    }

    this.#sql(
      'enqueue',
      `INSERT INTO request (
        request_id, delivery_id, request_kind, command_text, payload_json,
        status, delivery_status, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?)`,
      outbound.requestId,
      outbound.deliveryId,
      outbound.kind,
      commandText,
      payloadJson,
      createdAt,
      createdAt,
      expiresAt
    )

    const insertedRow = readFirstSqlRow(
      this.#sql('enqueue', 'SELECT * FROM request WHERE request_id = ?', outbound.requestId)
    )
    this.#runBoundedBackground('pump-outbox', serverId, this.#pumpOutboxToDaemonSockets(serverId))
    void this.#scheduleOutboxRetryIfNeeded()
    this.#trace('enqueue', {
      serverId,
      requestId: outbound.requestId,
      deliveryId: outbound.deliveryId,
      kind: outbound.kind,
    })
    if (insertedRow) {
      return parseRequestRow(serverId, insertedRow)
    }
    return {
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: 'queued',
      createdAt,
      expiresAt,
    }
  }

  #markSent(serverId: string, deliveryId: string, _connectionId: string, sentAt?: string): void {
    const at = sentAt ?? nowIso()
    this.#sql(
      'mark-sent',
      `UPDATE request SET
         delivery_status = 'sent',
         sent_at = ?,
         status = CASE WHEN status = 'queued' THEN 'sent' ELSE status END,
         updated_at = ?
       WHERE delivery_id = ?`,
      at,
      at,
      deliveryId
    )
    const row = readFirstSqlRow(
      this.#sql('mark-sent', 'SELECT request_id FROM request WHERE delivery_id = ?', deliveryId)
    )
    const requestId = row ? sqlString(row.request_id) : undefined
    this.#trace('mark-sent', { serverId, requestId, deliveryId })
  }

  async #handleInboundMessage(serverId: string, msg: DaemonMessage | null): Promise<void> {
    if (!msg) return
    const inbound = wireMessageToInboundEnvelope(msg)
    if (!inbound) return
    const envelopeOk = validateDaemonInboundEnvelope(inbound)
    if (!envelopeOk.ok) {
      this.#trace('inbound-envelope-rejected', {
        serverId,
        reason: envelopeOk.reason,
        kind: inbound.kind,
      })
      return
    }
    await this.#handleInbound(serverId, inbound)
  }

  #readRequestRow(serverId: string, requestId: string): PendingRequestRecord | null {
    const row = readFirstSqlRow(
      this.#sql('request-read', 'SELECT * FROM request WHERE request_id = ?', requestId)
    )
    return row ? parseRequestRow(serverId, row) : null
  }

  #applyLateTerminalAck(
    serverId: string,
    inbound: DaemonInboundEnvelope,
    existing: PendingRequestRecord
  ): PendingRequestRecord | null {
    if (inbound.kind !== 'command-ack' || existing.ackAt) return null
    const ackAt = inbound.at
    this.#sql(
      'handle-inbound',
      `UPDATE request SET ack_at = ?, daemon_received_at = COALESCE(?, daemon_received_at),
       updated_at = ? WHERE request_id = ?`,
      ackAt,
      inbound.daemonReceivedAt,
      nowIso(),
      inbound.requestId
    )
    this.#trace('handle-inbound', {
      serverId,
      requestId: inbound.requestId,
      kind: inbound.kind,
      statusFrom: existing.status,
      statusTo: 'late-ack',
    })
    return this.#readRequestRow(serverId, inbound.requestId)
  }

  #applyCommandAckInbound(
    serverId: string,
    inbound: Extract<DaemonInboundEnvelope, { kind: 'command-ack' }>,
    existing: PendingRequestRecord
  ): PendingRequestRecord {
    if (existing.status === 'acked') return existing
    const ackAt = inbound.at
    this.#sql(
      'handle-inbound',
      `UPDATE request SET status = 'acked', ack_at = ?, daemon_received_at = ?,
       updated_at = ? WHERE request_id = ?`,
      ackAt,
      inbound.daemonReceivedAt,
      nowIso(),
      inbound.requestId
    )
    this.#trace('handle-inbound', {
      serverId,
      requestId: inbound.requestId,
      kind: inbound.kind,
      statusFrom: existing.status,
      statusTo: 'acked',
    })
    return this.#readRequestRow(serverId, inbound.requestId) ?? existing
  }

  #deriveCommandOutcomeTimestamps(
    inbound: DaemonInboundEnvelope,
    row: Record<string, SqlStorageValue>
  ): {
    daemonReceivedAt: string | null
    daemonRespondedAt: string | null
    ackAt: string | null
  } {
    if (inbound.kind !== 'command-outcome') {
      return { daemonReceivedAt: null, daemonRespondedAt: null, ackAt: null }
    }
    return {
      daemonReceivedAt: inbound.daemonReceivedAt ?? null,
      daemonRespondedAt: inbound.daemonRespondedAt ?? null,
      ackAt: row.ack_at ? null : (inbound.daemonReceivedAt ?? inbound.at),
    }
  }

  #resolveInboundCompletion(
    inbound: DaemonInboundEnvelope,
    row: Record<string, SqlStorageValue>
  ): {
    status: PendingRequestStatus
    result?: unknown
    error?: string
    finishedAt: string
    daemonReceivedAt: string | null
    daemonRespondedAt: string | null
    ackAt: string | null
  } | null {
    const outcome = deriveInboundOutcome(inbound)
    if (!outcome) return null

    return {
      ...outcome,
      finishedAt: inbound.at,
      ...this.#deriveCommandOutcomeTimestamps(inbound, row),
    }
  }

  async #applyInboundCompletion(
    serverId: string,
    inbound: DaemonInboundEnvelope,
    existing: PendingRequestRecord,
    completion: {
      status: PendingRequestStatus
      result?: unknown
      error?: string
      finishedAt: string
      daemonReceivedAt: string | null
      daemonRespondedAt: string | null
      ackAt: string | null
    }
  ): Promise<PendingRequestRecord> {
    const { status, result, error, finishedAt, daemonReceivedAt, daemonRespondedAt, ackAt } =
      completion
    // Extend expires_at through the terminal retention window so a completion
    // near the original TTL stays queryable until finished_at retention prune
    // (matches Redis `#cleanupTerminalRequest`).
    const finishedMs = Date.parse(finishedAt)
    const retainUntil = Number.isFinite(finishedMs)
      ? nowIso(finishedMs + TERMINAL_UPDATE_RETENTION_MS)
      : nowIso(Date.now() + TERMINAL_UPDATE_RETENTION_MS)
    this.#sql(
      'handle-inbound',
      `UPDATE request SET status = ?, result_json = ?, error = ?,
       finished_at = ?, expires_at = CASE
         WHEN expires_at IS NOT NULL AND expires_at > ? THEN expires_at
         ELSE ?
       END,
       daemon_received_at = COALESCE(?, daemon_received_at),
       daemon_responded_at = ?, ack_at = COALESCE(ack_at, ?), updated_at = ?
       WHERE request_id = ?`,
      status,
      result === undefined ? null : JSON.stringify(result),
      error ?? null,
      finishedAt,
      retainUntil,
      retainUntil,
      daemonReceivedAt,
      daemonRespondedAt,
      ackAt,
      nowIso(),
      inbound.requestId
    )

    this.#trace('handle-inbound', {
      serverId,
      requestId: inbound.requestId,
      kind: inbound.kind,
      statusFrom: existing.status,
      statusTo: status,
    })

    const record = this.#readRequestRow(serverId, inbound.requestId) ?? existing
    if (isTerminalStatus(record.status)) {
      this.#reclaimTerminalOutbox(inbound.requestId)
      await this.#scheduleNearestAlarm()
    }
    if (inbound.kind === 'update-result') {
      await this.#projectUpdateResult(
        serverId,
        inbound.requestId,
        inbound.ok,
        inbound.at,
        inbound.error
      )
    }
    return record
  }

  async #handleInbound(
    serverId: string,
    inbound: DaemonInboundEnvelope
  ): Promise<PendingRequestRecord | null> {
    const row = readFirstSqlRow(
      this.#sql('handle-inbound', 'SELECT * FROM request WHERE request_id = ?', inbound.requestId)
    )
    if (!row) return null

    const existing = parseRequestRow(serverId, row)
    if (isTerminalStatus(existing.status)) {
      return this.#applyLateTerminalAck(serverId, inbound, existing) ?? existing
    }

    if (inbound.kind === 'command-ack') {
      return this.#applyCommandAckInbound(serverId, inbound, existing)
    }

    const completion = this.#resolveInboundCompletion(inbound, row)
    if (!completion) return existing

    return await this.#applyInboundCompletion(serverId, inbound, existing, completion)
  }

  #reclaimTerminalOutbox(requestId: string): void {
    this.#sql(
      'delivery-ack',
      `UPDATE request SET delivery_status = 'acked', retry_at = NULL
       WHERE request_id = ?`,
      requestId
    )
  }

  #getRequest(serverId: string | null, requestId: string): PendingRequestRecord | null {
    if (!serverId || !requestId) return null
    return this.#readRequestRow(serverId, requestId)
  }

  #listRequests(
    serverId: string | null,
    limit: number,
    requestKind?: string
  ): PendingRequestRecord[] {
    if (!serverId) return []
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50
    const cursor = requestKind
      ? this.#sql(
          'request-read',
          `SELECT * FROM request
         WHERE request_kind = ?
         ORDER BY created_at DESC LIMIT ?`,
          requestKind,
          safeLimit
        )
      : this.#sql(
          'request-read',
          `SELECT * FROM request ORDER BY created_at DESC LIMIT ?`,
          safeLimit
        )
    const records: PendingRequestRecord[] = []
    for (const row of cursor) {
      records.push(parseRequestRow(serverId, row))
    }
    return records
  }

  #waitForRequest(
    serverId: string,
    requestId: string,
    _timeoutMs: number
  ): PendingRequestRecord | null {
    return this.#getRequest(serverId, requestId)
  }

  /**
   * Fast, non-blocking expiry for caller-side wait timeouts. Marks the request
   * expired, stops delivery (retain-on-ack), and mirrors Redis parity (update
   * rows are retained for the terminal retention window; others are purged).
   */
  async #expireRequest(serverId: string, requestId: string): Promise<PendingRequestRecord> {
    const finishedAt = nowIso()
    const existing = this.#getRequest(serverId, requestId)

    if (existing && isTerminalStatus(existing.status)) {
      return existing
    }

    if (!existing) {
      return {
        serverId,
        requestId,
        requestKind: '',
        status: 'expired',
        createdAt: finishedAt,
        expiresAt: finishedAt,
        finishedAt,
      }
    }

    const requestKind = existing.requestKind
    const finishedMs = Date.parse(finishedAt)
    const retainUntil = Number.isFinite(finishedMs)
      ? nowIso(finishedMs + TERMINAL_UPDATE_RETENTION_MS)
      : nowIso(Date.now() + TERMINAL_UPDATE_RETENTION_MS)
    this.#ctx.storage.transactionSync(() => {
      if (requestKind === 'update') {
        // Retain update rows through the terminal window (Redis parity).
        this.#sql(
          'expire-request',
          `UPDATE request SET status = 'expired', finished_at = ?,
           expires_at = CASE
             WHEN expires_at IS NOT NULL AND expires_at > ? THEN expires_at
             ELSE ?
           END, updated_at = ?
           WHERE request_id = ?`,
          finishedAt,
          retainUntil,
          retainUntil,
          finishedAt,
          requestId
        )
      } else {
        this.#sql(
          'expire-request',
          `UPDATE request SET status = 'expired', finished_at = ?, updated_at = ?
           WHERE request_id = ?`,
          finishedAt,
          finishedAt,
          requestId
        )
      }
      this.#reclaimTerminalOutbox(requestId)
    })

    const expiredRecord: PendingRequestRecord = {
      ...existing,
      status: 'expired',
      finishedAt,
      expiresAt: requestKind === 'update' ? retainUntil : finishedAt,
    }

    if (requestKind === 'update') {
      await this.#projectUpdateExpired(serverId, requestId, finishedAt)
      await this.#scheduleNearestAlarm()
      return expiredRecord
    }

    this.#sql('expire-request', 'DELETE FROM request WHERE request_id = ?', requestId)
    await this.#scheduleNearestAlarm()
    return expiredRecord
  }

  async #clearUpdateStatus(
    serverId: string,
    opts?: ClearUpdateStatusOptions | null
  ): Promise<{ cleared: number }> {
    const inFlightCursor = this.#sql(
      'clear-update-status',
      `SELECT request_id, status, created_at FROM request
       WHERE request_kind = 'update'
       AND status NOT IN ('acked', 'done', 'failed', 'expired')`
    )
    let cleared = 0
    const staleRequestIds: string[] = []
    for (const row of inFlightCursor) {
      const requestId = sqlString(row.request_id)
      const createdAt = sqlString(row.created_at)
      const stale = opts?.allowStale && this.#isStaleInFlightUpdate(createdAt, opts)
      if (stale) {
        staleRequestIds.push(requestId)
        continue
      }
      throw new Error('update in progress')
    }

    const finishedAt = nowIso()
    for (const requestId of staleRequestIds) {
      this.#sql(
        'clear-update-status',
        `UPDATE request SET status = 'expired', finished_at = ?, updated_at = ?
         WHERE request_id = ?`,
        finishedAt,
        finishedAt,
        requestId
      )
      this.#reclaimTerminalOutbox(requestId)
      await this.#projectUpdateExpired(serverId, requestId, finishedAt)
      cleared++
    }

    const terminalCursor = this.#sql(
      'clear-update-status',
      `SELECT request_id FROM request
       WHERE request_kind = 'update'
       AND status IN ('acked', 'done', 'failed', 'expired')`
    )
    const requestIds: string[] = []
    for (const row of terminalCursor) {
      requestIds.push(sqlString(row.request_id))
    }

    this.#ctx.storage.transactionSync(() => {
      for (const requestId of requestIds) {
        this.#reclaimTerminalOutbox(requestId)
        this.#sql('clear-update-status', 'DELETE FROM request WHERE request_id = ?', requestId)
      }
    })

    await this.#scheduleNearestAlarm()
    return { cleared: cleared + requestIds.length }
  }

  #isStaleInFlightUpdate(createdAt: string, opts: ClearUpdateStatusOptions): boolean {
    if (opts.targetCommit && opts.currentCommit && opts.currentCommit === opts.targetCommit) {
      return true
    }

    const queuedAt = opts.queuedAt ?? createdAt
    if (queuedAt && opts.updateTtlMs) {
      const queuedMs = Date.parse(queuedAt)
      if (!Number.isNaN(queuedMs) && Date.now() - queuedMs >= opts.updateTtlMs) {
        return true
      }
    }

    return false
  }

  async #createRequestAndWait(
    serverId: string,
    outbound: DaemonOutboundEnvelope,
    timeoutMs: number
  ): Promise<PendingRequestRecord> {
    const ttlSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    const record = this.#enqueue(serverId, outbound, { ttlSeconds })
    await this.#scheduleNearestAlarm()
    return record
  }

  #attachDaemonSocket(
    serverId: string,
    meta: {
      keyId: string
      remoteAddress?: string
      connectedAt?: string
    }
  ): { connectionId: string; lease: DaemonCellLease } {
    const connectionId = crypto.randomUUID()

    const existingHolder = this.#existingDaemonSocketHolder()
    if (existingHolder && existingHolder !== connectionId) {
      throw new Error(`daemon socket lease held by another connection (${existingHolder})`)
    }

    const lease = this.#applyDaemonSocketAttach(serverId, connectionId, meta)
    return { connectionId, lease }
  }

  async #detachDaemonSocket(
    serverId: string,
    params: {
      connectionId: string
      reason?: string
      closedAt?: string
    }
  ): Promise<void> {
    const isCurrentConnection = this.#isSoleOrNoOtherLiveSocket(serverId, params.connectionId)

    if (isCurrentConnection) {
      this.#runtimeConnected = false
      this.#trace('detach', {
        serverId,
        conn: params.connectionId,
        reason: params.reason,
      })
      await this.#scheduleNearestAlarm()
    }
  }

  /** Reserved for outbox in-flight ownership; no production caller today. */
  #claimDeliveryLease(serverId: string, holder: string, ttlMs: number): DaemonCellLease | null {
    this.#ensureServerId(serverId)
    const expiresAt = new Date(Date.now() + ttlMs).toISOString()
    if (
      sqlCursorHasRow(
        this.#sql('lease', 'SELECT holder FROM lease WHERE lease_name = ?', DELIVERY_LEASE_NAME)
      )
    ) {
      this.#trace('lease-claim', { serverId, holder, ok: false })
      return null
    }

    this.#sql(
      'lease',
      `INSERT INTO lease (lease_name, holder, expires_at)
       VALUES (?, ?, ?)`,
      DELIVERY_LEASE_NAME,
      holder,
      expiresAt
    )
    this.#trace('lease-claim', { serverId, holder, ok: true })
    return { holder, expiresAt }
  }

  #renewDeliveryLease(_serverId: string, holder: string, ttlMs: number): DaemonCellLease | null {
    const renewed = this.#renewLease(DELIVERY_LEASE_NAME, holder, ttlMs)
    this.#trace('lease-renew', { serverId: _serverId, holder, ok: renewed })
    if (!renewed) return null
    return {
      holder,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    }
  }

  #renewLease(leaseName: string, holder: string, ttlMs: number): boolean {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString()
    this.#sql(
      'lease',
      `UPDATE lease SET expires_at = ?
       WHERE lease_name = ? AND holder = ?`,
      expiresAt,
      leaseName,
      holder
    )
    return readSqlChanges(this.#sql('lease', 'SELECT changes() AS c')) > 0
  }

  #releaseDeliveryLease(serverId: string, holder: string): void {
    this.#sql(
      'lease',
      'DELETE FROM lease WHERE lease_name = ? AND holder = ?',
      DELIVERY_LEASE_NAME,
      holder
    )
    const ok = readSqlChanges(this.#sql('lease', 'SELECT changes() AS c')) > 0
    this.#trace('lease-release', { serverId, holder, ok })
  }

  #readOutboxBatch(
    _serverId: string,
    params: { consumer: string; count: number; blockMs?: number }
  ): DaemonOutboundEnvelope[] {
    this.#requeueExpiredInflightOutbox()

    const now = nowIso()
    const envelopes: DaemonOutboundEnvelope[] = []
    const claimedAt = nowIso()
    this.#ctx.storage.transactionSync(() => {
      const cursor = this.#sql(
        'delivery-read',
        `SELECT seq, payload_json, delivery_id FROM request
         WHERE delivery_status = 'queued'
           AND (retry_at IS NULL OR retry_at <= ?)
         ORDER BY seq ASC LIMIT ?`,
        now,
        params.count
      )
      for (const row of cursor) {
        const payload = sqlString(row.payload_json) || null
        if (!payload) continue
        try {
          envelopes.push(JSON.parse(payload) as DaemonOutboundEnvelope)
        } catch {
          continue
        }
        this.#sql(
          'delivery-read',
          `UPDATE request SET delivery_status = 'inflight', sent_at = ?
           WHERE seq = ?`,
          claimedAt,
          row.seq
        )
      }
    })
    this.#trace('delivery-read', {
      serverId: _serverId,
      consumer: params.consumer,
      count: envelopes.length,
    })
    return envelopes
  }

  async #ackOutbox(serverId: string, deliveryIds: OutboxDeliveryId[]): Promise<void> {
    const updatedAt = nowIso()
    for (const deliveryId of deliveryIds) {
      this.#sql(
        'delivery-ack',
        `UPDATE request SET delivery_status = 'acked', updated_at = ?
         WHERE delivery_id = ?`,
        updatedAt,
        deliveryId
      )
    }
    this.#trace('delivery-ack', { serverId, count: deliveryIds.length })
    await this.#scheduleNearestAlarm()
  }
}
