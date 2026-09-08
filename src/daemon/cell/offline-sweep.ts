/**
 * Offline sweep — a single Cron Trigger (see `wrangler.jsonc` `triggers.crons`)
 * that closes the "hard poweroff never shows offline" gap: a daemon that
 * disappears without a clean WebSocket close (power loss, network partition,
 * kernel panic) leaves no `webSocketClose`/`webSocketError` event, so nothing
 * ever tells Postgres the server went away (see AGENTS.md → Daemon Cell →
 * "Presence model" disconnect-first trade-off).
 *
 * Design ("Option B"):
 *   1. One cheap Postgres read for servers Postgres currently believes are
 *      connected (`listConnectedServersForSweep`), plus recently-offline rows
 *      for self-heal (`listRecentlyOfflineServersForSweep`).
 *   2. Fan out a *read-only* liveness RPC to each candidate's Durable
 *      Object (`DaemonCell.checkLiveness`). It only inspects the free,
 *      runtime-tracked WebSocket auto-response timestamp — the same value
 *      the daemon's idle ping (`DAEMON_CELL_PING`) keeps warm — and never
 *      touches SQLite. A healthy server costs one Workers subrequest and
 *      nothing else.
 *   3. Stale connected servers get a Postgres write (reusing
 *      `onDaemonDisconnected`) and a notification. Live+warm servers that
 *      Postgres still marks offline get re-projected online (self-heal):
 *      AE-active candidates via Postgres-only `onDaemonConnectedFromEvidence`
 *      (no DO wake) only when the AE latest sample is newer than the offline
 *      transition; otherwise probed candidates via `onDaemonConnected` after
 *      `checkLiveness` already woke the cell.
 *
 * Cost model (AE short-circuit): **one fleet-wide Analytics Engine SQL read
 * per tick replaces N per-minute DO wakes**. Connected servers present in
 * the recent-host-sample set are provably alive — skip `checkLiveness`
 * entirely (zero subrequests). Suspects (absent from AE) keep the existing
 * check → demote path. AE-active recently-offline self-heal is also wake-free
 * (Postgres-only projection). When AE config is missing or the query throws,
 * fall back to today's check-all behavior so offline detection is never lost.
 *
 * This intentionally does NOT reintroduce a per-DO recurring alarm — every
 * `setAlarm()` reschedule is a billed SQLite row write (see do.ts "Alarm /
 * hibernation" + AGENTS.md Daemon Cell billing model). Centralizing the
 * "when to check" clock into one Cron Trigger avoids that cost entirely and
 * scales with the number of *connected* servers, not the number of ticks.
 *
 * Detection latency: up to one cron interval (60s, Cloudflare's finest cron
 * granularity) plus `OFFLINE_SWEEP_STALE_MS` grace — worst case is close to
 * but a good deal cheaper than re-arming a DO alarm per server. Overlap is
 * serialized by a Postgres `setting` CAS lease (`OFFLINE_SWEEP_LOCK`); each
 * tick is also bounded by `OFFLINE_SWEEP_TICK_BUDGET_MS`. Servers skipped
 * when that deadline is reached — or when they sit past `MAX_SWEEP_FANOUT` —
 * are picked up next tick by `rotateSweepBatch`. Do not "fix" truncation by
 * raising `MAX_SWEEP_FANOUT`. The tick budget is a hard deadline: awaited
 * phases race remaining time, and `OFFLINE_SWEEP_LOCK.expiresAt` covers the
 * enforced live runtime so a still-running holder cannot be stolen.
 */
import {
  type Db,
  DB_OP_TIMEOUT_MS,
  endDbConnection,
  raceWithTimeout,
  runWithDbTimeout,
} from '../../db.ts'
import { resolveWorkersDb } from '../../workers-bindings.ts'
import { runManagedIngressOrphanSweep } from '../../client/managed/ingress-desired.ts'
import { runSystemReconcileSweep } from '../../client/system/reconcile.ts'
import { runLeafRenewalSweepTick } from '../../client/tls/leaf-renewal-sweep.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../client/authn/secrets.ts'
import { createWorkersCommandQueue } from '../../lib/commands/workers-queue.ts'
import {
  COMMAND_DISPATCH_SWEEP_LIMIT,
  sweepExpiredCommandDispatch,
} from '../../lib/db/command-records.ts'
import { releaseStuckManagedApplying, sweepStaleCommands } from '../../lib/commands/stale-sweep.ts'
import {
  sweepExpiredWebhookDeliveries,
  WEBHOOK_DELIVERY_SWEEP_LIMIT,
} from '../../lib/db/webhook-delivery-records.ts'
import {
  type AnalyticsEngineDatasetLike,
  resolveServerMetricsStore,
} from '../metrics/store-selection-workers.ts'
import { setServerStatusEventSink } from '../metrics/status-events.ts'
import {
  parseExecutionLogRetentionDays,
  type R2BucketLike,
  resolveExecutionLogStore,
} from '../../lib/execution-logs/store-selection.ts'
import {
  EXECUTION_LOG_SWEEP_LIMIT,
  type ExecutionLogStore,
} from '../../lib/execution-logs/types.ts'
import { createDurableObjectDaemonCellRegistry } from './do-registry.ts'
import {
  onDaemonConnected,
  onDaemonConnectedFromEvidence,
  onDaemonDisconnected,
} from './control-plane-monitor.ts'
import {
  type ConnectedServerForSweep,
  listConnectedServersForSweep,
  listRecentlyOfflineServersForSweep,
  type RecentlyOfflineServerForSweep,
  rotateSweepBatch,
} from './postgres-projection.ts'
import type { DaemonCell, DaemonCellLiveness, DaemonCellRegistry } from './contracts.ts'
import { resolveCloudflareAnalyticsSqlConfig } from '../metrics/store-selection-workers.ts'
import {
  AE_LIVENESS_QUERY_TIMEOUT_MS,
  AE_LIVENESS_WINDOW_SECONDS,
  queryRecentlyActiveServerIds,
} from '../metrics/backends/cloudflare/sql-api.ts'
import { endOfflineSweep, tryBeginOfflineSweep } from './offline-sweep-lease.ts'
import { resolveWorkersEmailQueue } from '../../lib/email/mailgun/workers-queue.ts'
import { sweepTierNotices } from '../../lib/tiers/tier-notice-sweep.ts'
import { resolveBillingConfig } from '../../lib/billing/config.ts'
import { createStripeClient } from '../../lib/billing/client.ts'
import { runGraceClock, shouldRunGraceClock } from '../../lib/billing/grace-clock.ts'
import { runReconcile, shouldRunReconcile } from '../../lib/billing/reconcile.ts'
import { projectSubscriptionById } from '../../webhook/billing/stripe-projection.ts'

/** Grace beyond the daemon's ~60s idle-ping cadence before declaring a server stale. */
export const OFFLINE_SWEEP_STALE_MS = 90_000

/** Stay comfortably under the Workers-paid subrequest ceiling (1000/invocation). */
export const MAX_SWEEP_FANOUT = 900

/** Connected stale-check budget — remainder reserved for self-heal. */
export const CONNECTED_SWEEP_BUDGET = 700

/** Recently-offline self-heal budget — not starved by connected rows. */
export const SELF_HEAL_SWEEP_BUDGET = MAX_SWEEP_FANOUT - CONNECTED_SWEEP_BUDGET

/** Bound in-flight liveness RPCs per tick instead of bursting the whole batch at once. */
const FANOUT_CONCURRENCY = 25

/** Wall-clock budget for one cron tick, well under the 60 s cadence. */
export const OFFLINE_SWEEP_TICK_BUDGET_MS = 45_000

/**
 * Reserved slice so `demoteStale` / `healServers` always run on what was
 * already probed — a probed-but-unwritten demotion is a lost minute of
 * accuracy.
 */
export const DEMOTION_RESERVE_MS = 8_000

/** Hard deadline per `checkLiveness` DO RPC. */
export const LIVENESS_RPC_TIMEOUT_MS = 5_000

/** Execution-log R2 retention runs on this minute-modulo divisor. */
export const EXECUTION_LOG_SWEEP_MINUTE_DIVISOR = 15

/** Hosted license-tier nag — hourly on the same cron tick. */
export const TIER_NOTICE_SWEEP_MINUTE_DIVISOR = 60

export type SweepOnceStats = {
  probed: number
  stale: number
  healed: number
}

const EMPTY_SWEEP_STATS: SweepOnceStats = {
  probed: 0,
  stale: 0,
  healed: 0,
}

let lastScheduledTimeForTests: number | undefined

/** Test helper — last `scheduledTime` forwarded into {@link runOfflineSweep}. */
export function takeLastOfflineSweepScheduledTimeForTests(): number | undefined {
  const value = lastScheduledTimeForTests
  lastScheduledTimeForTests = undefined
  return value
}

/** True on every Nth UTC minute (isolate-independent, no stored state). */
export function shouldSweepExecutionLogs(scheduledTimeMs: number): boolean {
  const minute = Math.floor(scheduledTimeMs / 60_000)
  return minute % EXECUTION_LOG_SWEEP_MINUTE_DIVISOR === 0
}

export function shouldSweepTierNotices(scheduledTimeMs: number): boolean {
  const minute = Math.floor(scheduledTimeMs / 60_000)
  return minute % TIER_NOTICE_SWEEP_MINUTE_DIVISOR === 0
}

/** Format a trace field without relying on Object's default `[object Object]`. */
function formatSweepTraceValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value)
    default:
      return JSON.stringify(value)
  }
}

function sweepTrace(event: string, detail: Record<string, unknown> = {}): void {
  const parts = [`offline-sweep event=${event}`]
  for (const key of Object.keys(detail).sort((a, b) => a.localeCompare(b))) {
    const value = detail[key]
    if (value === undefined || value === null) continue
    parts.push(`${key}=${formatSweepTraceValue(value)}`)
  }
  console.info(parts.join(' '))
}

/**
 * Extension point for real delivery (email/webhook) once a target audience
 * exists — see AGENTS.md "eventually notify on server-down" note. For now
 * this only emits a greppable structured log line.
 */
function notifyServerWentOffline(serverId: string): void {
  sweepTrace('notify-offline', { serverId })
}

async function withBoundedConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  shouldStop?: () => boolean
): Promise<void> {
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      if (shouldStop?.()) return
      const index = cursor++
      if (index >= items.length) return
      await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}

type SweepCandidate = {
  id: string
  postgresConnected: boolean
  connectedAt: string | null
}

/**
 * Grace bookkeeping for connected sockets whose auto-response timestamp is
 * still null — bounded in-memory state only (never DO SQLite). Per-isolate:
 * the durable `OFFLINE_SWEEP_LOCK` lease is what stops two isolates forming
 * contradictory first-null observations in the same minute.
 */
const firstNullObservedAtMs = new Map<string, number>()

/** Test helper — clears null-grace bookkeeping between cases. */
export function resetOfflineSweepNullGraceForTests(): void {
  firstNullObservedAtMs.clear()
}

/** Records or clears the first-null observation timestamp for a server. */
export function updateNullGraceBookkeeping(
  serverId: string,
  liveness: DaemonCellLiveness | null,
  nowMs: number
): void {
  if (!liveness?.connected) {
    firstNullObservedAtMs.delete(serverId)
    return
  }
  if (liveness.lastPingAtMs !== null) {
    firstNullObservedAtMs.delete(serverId)
    return
  }
  if (!firstNullObservedAtMs.has(serverId)) {
    firstNullObservedAtMs.set(serverId, nowMs)
  }
}

function pruneNullGraceBookkeeping(activeServerIds: ReadonlySet<string>): void {
  for (const serverId of firstNullObservedAtMs.keys()) {
    if (!activeServerIds.has(serverId)) {
      firstNullObservedAtMs.delete(serverId)
    }
  }
}

export function isStale(
  serverId: string,
  liveness: DaemonCellLiveness | null,
  nowMs: number,
  _connectedAt: string | null
): boolean {
  if (!liveness?.connected) return true
  if (liveness.lastPingAtMs !== null) {
    return nowMs - liveness.lastPingAtMs > OFFLINE_SWEEP_STALE_MS
  }
  const firstNullAt = firstNullObservedAtMs.get(serverId)
  if (firstNullAt === undefined) return false
  return nowMs - firstNullAt > OFFLINE_SWEEP_STALE_MS
}

function isLiveAndWarm(liveness: DaemonCellLiveness | null, nowMs: number): boolean {
  if (!liveness?.connected) return false
  if (liveness.lastPingAtMs === null) return false
  return nowMs - liveness.lastPingAtMs <= OFFLINE_SWEEP_STALE_MS
}

function mergeSweepCandidates(
  connected: ConnectedServerForSweep[],
  recentlyOffline: RecentlyOfflineServerForSweep[]
): SweepCandidate[] {
  const byId = new Map<string, SweepCandidate>()
  for (const candidate of connected) {
    byId.set(candidate.id, {
      id: candidate.id,
      postgresConnected: true,
      connectedAt: candidate.connectedAt,
    })
  }
  for (const candidate of recentlyOffline) {
    if (byId.has(candidate.id)) continue
    byId.set(candidate.id, {
      id: candidate.id,
      postgresConnected: false,
      connectedAt: candidate.connectedAt,
    })
  }
  return [...byId.values()]
}

/**
 * AE-direct self-heal is only safe when the latest host sample is strictly
 * newer than the offline transition. A sample written shortly before a clean
 * `webSocketClose` stays inside the 180s AE window and must not undo a correct
 * offline projection without `checkLiveness`.
 */
export function canDirectHealFromAeEvidence(
  offlineAt: string,
  latestSampleAtMs: number | undefined
): boolean {
  if (latestSampleAtMs === undefined) return false
  const offlineAtMs = Date.parse(offlineAt)
  if (!Number.isFinite(offlineAtMs)) return false
  return latestSampleAtMs > offlineAtMs
}

/**
 * Resolve the AE recently-active serverId → latestAtMs map for this cron tick.
 * Returns `null` when AE is unavailable or the query fails — callers must
 * fall back to check-all so offline detection is never lost.
 */
async function resolveRecentlyActiveServerIds(
  env: CloudflareBindings
): Promise<Map<string, number> | null> {
  const config = resolveCloudflareAnalyticsSqlConfig(env)
  if (!config) {
    sweepTrace('ae-unavailable')
    return null
  }
  try {
    return await queryRecentlyActiveServerIds(config, {
      sinceSeconds: AE_LIVENESS_WINDOW_SECONDS,
      signal: AbortSignal.timeout(AE_LIVENESS_QUERY_TIMEOUT_MS),
    })
  } catch (err) {
    sweepTrace('ae-query-failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export type SweepOnceDeps = {
  registry?: DaemonCellRegistry
  /** serverId → latest AE host-sample epoch ms; null = AE unavailable. */
  resolveActiveServerIds?: () => Promise<Map<string, number> | null>
  listConnected?: (db: Db) => Promise<ConnectedServerForSweep[]>
  listRecentlyOffline?: (db: Db) => Promise<RecentlyOfflineServerForSweep[]>
  onConnected?: (db: Db, serverId: string, cell: DaemonCell) => Promise<unknown>
  /** Postgres-only AE-direct self-heal — must not touch a DaemonCell. */
  onConnectedFromEvidence?: (
    db: Db,
    serverId: string,
    connectedAt?: string | null
  ) => Promise<unknown>
  onDisconnected?: (db: Db, serverId: string) => Promise<unknown>
  nowMs?: number
  /** Stop claiming new probe indices once this wall-clock instant is passed. */
  deadlineMs?: number
}

async function probeCandidates(
  batch: SweepCandidate[],
  registry: DaemonCellRegistry,
  nowMs: number,
  probeDeadlineMs: number
): Promise<{ staleIds: string[]; healIds: string[]; probed: number }> {
  const staleIds: string[] = []
  const healIds: string[] = []
  let probed = 0

  await withBoundedConcurrency(
    batch,
    FANOUT_CONCURRENCY,
    async (candidate) => {
      let liveness: DaemonCellLiveness | null = null
      try {
        probed += 1
        // Half-open reaping still runs inside `/rpc/liveness` (`#reapUnhealthySockets`)
        // for the suspects we still wake; the absolute max-age backstop moves
        // daemon-side in a later phase.
        const cell = registry.getCell(candidate.id)
        const check = cell.checkLiveness
        liveness = check
          ? await raceWithTimeout(
              check.call(cell),
              LIVENESS_RPC_TIMEOUT_MS,
              `liveness RPC exceeded ${LIVENESS_RPC_TIMEOUT_MS}ms`
            )
          : null
      } catch (err) {
        sweepTrace('liveness-check-failed', {
          serverId: candidate.id,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }

      updateNullGraceBookkeeping(candidate.id, liveness, nowMs)

      if (candidate.postgresConnected) {
        if (isStale(candidate.id, liveness, nowMs, candidate.connectedAt)) {
          staleIds.push(candidate.id)
        }
        return
      }

      if (isLiveAndWarm(liveness, nowMs)) {
        healIds.push(candidate.id)
      }
    },
    () => Date.now() >= probeDeadlineMs
  )

  return { staleIds, healIds, probed }
}

async function demoteStale(
  db: Db,
  staleIds: string[],
  onDisconnected: (db: Db, serverId: string) => Promise<unknown>,
  deadlineMs: number
): Promise<void> {
  if (staleIds.length === 0) return

  sweepTrace('stale-detected', { count: staleIds.length })

  await withBoundedConcurrency(
    staleIds,
    FANOUT_CONCURRENCY,
    async (serverId) => {
      try {
        await onDisconnected(db, serverId)
        notifyServerWentOffline(serverId)
      } catch (err) {
        sweepTrace('mark-offline-failed', {
          serverId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    () => Date.now() >= deadlineMs
  )
}

async function healServers(
  db: Db,
  healIds: string[],
  registry: DaemonCellRegistry,
  onConnected: (db: Db, serverId: string, cell: DaemonCell) => Promise<unknown>,
  deadlineMs: number
): Promise<void> {
  if (healIds.length === 0) return

  sweepTrace('self-heal-detected', { count: healIds.length })

  await withBoundedConcurrency(
    healIds,
    FANOUT_CONCURRENCY,
    async (serverId) => {
      try {
        const cell = registry.getCell(serverId)
        await onConnected(db, serverId, cell)
      } catch (err) {
        sweepTrace('self-heal-failed', {
          serverId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    () => Date.now() >= deadlineMs
  )
}

/** AE-direct self-heal: Postgres-only — never resolves a cell or getSnapshot. */
async function healServersFromEvidence(
  db: Db,
  candidates: Array<{ id: string; connectedAt: string | null }>,
  onConnectedFromEvidence: (
    db: Db,
    serverId: string,
    connectedAt?: string | null
  ) => Promise<unknown>,
  deadlineMs: number
): Promise<void> {
  if (candidates.length === 0) return

  sweepTrace('self-heal-direct', { count: candidates.length })

  await withBoundedConcurrency(
    candidates,
    FANOUT_CONCURRENCY,
    async (candidate) => {
      try {
        await onConnectedFromEvidence(db, candidate.id, candidate.connectedAt)
      } catch (err) {
        sweepTrace('self-heal-failed', {
          serverId: candidate.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    () => Date.now() >= deadlineMs
  )
}

type SweepResolvedDeps = Required<
  Pick<SweepOnceDeps, 'registry' | 'onConnected' | 'onConnectedFromEvidence' | 'onDisconnected'>
>

/** Shared tick inputs for the AE-short-circuit and fallback sweep paths. */
type SweepOnceContext = {
  db: Db
  deps: SweepResolvedDeps
  connected: ConnectedServerForSweep[]
  recentlyOffline: RecentlyOfflineServerForSweep[]
  nowMs: number
  deadlineMs: number
  probeDeadlineMs: number
}

function remainingMs(deadlineMs: number, nowMs = Date.now()): number {
  if (!Number.isFinite(deadlineMs)) return Number.POSITIVE_INFINITY
  return deadlineMs - nowMs
}

/**
 * Run one awaited phase against the tick deadline. Timed-out or already-due
 * phases log `budget-exhausted` and return false so callers skip later work.
 */
async function runBoundedPhase(
  deadlineMs: number,
  phase: string,
  work: () => Promise<void>
): Promise<boolean> {
  const left = remainingMs(deadlineMs)
  if (left <= 0) {
    sweepTrace('budget-exhausted', { phase })
    return false
  }
  try {
    if (!Number.isFinite(left)) {
      await work()
      return true
    }
    await raceWithTimeout(work(), left, `offline-sweep ${phase} exceeded remaining budget`)
    return true
  } catch (err) {
    sweepTrace('budget-exhausted', {
      phase,
      error: sweepErrorMessage(err),
    })
    return false
  }
}

/** Fallback path: today's check-all behavior (AE unavailable / query failed). */
async function sweepOnceFallback(ctx: SweepOnceContext): Promise<SweepOnceStats> {
  const { db, deps, connected, recentlyOffline, nowMs, deadlineMs, probeDeadlineMs } = ctx
  const connectedBatch = rotateSweepBatch(connected, CONNECTED_SWEEP_BUDGET, nowMs)
  const selfHealBatch = rotateSweepBatch(recentlyOffline, SELF_HEAL_SWEEP_BUDGET, nowMs)
  const candidates = mergeSweepCandidates(connectedBatch, selfHealBatch)
  if (candidates.length === 0) return { ...EMPTY_SWEEP_STATS }

  const totalCandidates = connected.length + recentlyOffline.length
  const truncated = totalCandidates > candidates.length
  if (truncated) {
    sweepTrace('truncated', {
      total: totalCandidates,
      checked: candidates.length,
      connectedTotal: connected.length,
      connectedChecked: connectedBatch.length,
      selfHealTotal: recentlyOffline.length,
      selfHealChecked: selfHealBatch.length,
    })
  }

  const { staleIds, healIds, probed } = await probeCandidates(
    candidates,
    deps.registry,
    nowMs,
    probeDeadlineMs
  )

  if (
    !(await runBoundedPhase(deadlineMs, 'demote', () =>
      demoteStale(db, staleIds, deps.onDisconnected, deadlineMs)
    ))
  ) {
    return { probed, stale: staleIds.length, healed: 0 }
  }
  pruneNullGraceBookkeeping(new Set(candidates.map((c) => c.id)))
  if (
    !(await runBoundedPhase(deadlineMs, 'heal', () =>
      healServers(db, healIds, deps.registry, deps.onConnected, deadlineMs)
    ))
  ) {
    return { probed, stale: staleIds.length, healed: 0 }
  }
  return { probed, stale: staleIds.length, healed: healIds.length }
}

/** AE-active path: skip DO wakes for hosts with a recent metrics sample. */
async function sweepOnceWithAe(
  ctx: SweepOnceContext,
  activeById: Map<string, number>
): Promise<SweepOnceStats> {
  const { db, deps, connected, recentlyOffline, nowMs, deadlineMs, probeDeadlineMs } = ctx
  const suspects = connected.filter((c) => !activeById.has(c.id))
  const suspectBatch = rotateSweepBatch(suspects, CONNECTED_SWEEP_BUDGET, nowMs)

  // Cap all self-heal work (AE-direct + probe) by SELF_HEAL_SWEEP_BUDGET
  // before partitioning — otherwise a large AE-active recently-offline set
  // bypasses the budget. AE-direct heals are Postgres-only (no DO wake);
  // probed heals still go through healServers after checkLiveness.
  const selfHealRotated = rotateSweepBatch(recentlyOffline, SELF_HEAL_SWEEP_BUDGET, nowMs)
  // Only direct-heal when AE evidence is strictly newer than the offline
  // transition — a pre-disconnect sample inside the AE window is not enough.
  const directHeal = selfHealRotated.filter((c) =>
    canDirectHealFromAeEvidence(c.offlineAt, activeById.get(c.id))
  )
  const directHealIds = new Set(directHeal.map((c) => c.id))
  const selfHealBatch = selfHealRotated.filter((c) => !directHealIds.has(c.id))

  sweepTrace('ae-liveness', {
    connected: connected.length,
    aeActive: activeById.size,
    suspectsProbed: suspectBatch.length,
    selfHealDirect: directHeal.length,
  })

  const probeBatch = mergeSweepCandidates(suspectBatch, selfHealBatch)
  const { staleIds, healIds, probed } =
    probeBatch.length > 0
      ? await probeCandidates(probeBatch, deps.registry, nowMs, probeDeadlineMs)
      : { staleIds: [] as string[], healIds: [] as string[], probed: 0 }

  if (
    !(await runBoundedPhase(deadlineMs, 'demote', () =>
      demoteStale(db, staleIds, deps.onDisconnected, deadlineMs)
    ))
  ) {
    return { probed, stale: staleIds.length, healed: 0 }
  }
  pruneNullGraceBookkeeping(new Set(probeBatch.map((c) => c.id)))

  // AE-direct heal stays separate from probed heals — must not call
  // registry.getCell() / getSnapshot().
  if (
    !(await runBoundedPhase(deadlineMs, 'heal-direct', () =>
      healServersFromEvidence(db, directHeal, deps.onConnectedFromEvidence, deadlineMs)
    ))
  ) {
    return { probed, stale: staleIds.length, healed: 0 }
  }
  if (
    !(await runBoundedPhase(deadlineMs, 'heal', () =>
      healServers(db, healIds, deps.registry, deps.onConnected, deadlineMs)
    ))
  ) {
    return {
      probed,
      stale: staleIds.length,
      healed: directHeal.length,
    }
  }
  return {
    probed,
    stale: staleIds.length,
    healed: healIds.length + directHeal.length,
  }
}

export async function sweepOnce(
  env: CloudflareBindings,
  db: Db,
  deps: SweepOnceDeps = {}
): Promise<SweepOnceStats> {
  const nowMs = deps.nowMs ?? Date.now()
  const probeDeadlineMs =
    deps.deadlineMs === undefined ? Number.POSITIVE_INFINITY : deps.deadlineMs - DEMOTION_RESERVE_MS
  const registry = deps.registry ?? createDurableObjectDaemonCellRegistry(env, db)
  const resolveActiveServerIds =
    deps.resolveActiveServerIds ?? (() => resolveRecentlyActiveServerIds(env))
  const listConnected =
    deps.listConnected ?? ((listDb: Db) => runWithDbTimeout(listDb, listConnectedServersForSweep))
  const listRecentlyOffline =
    deps.listRecentlyOffline ??
    ((listDb: Db) => runWithDbTimeout(listDb, listRecentlyOfflineServersForSweep))
  const onConnected = deps.onConnected ?? onDaemonConnected
  const onConnectedFromEvidence = deps.onConnectedFromEvidence ?? onDaemonConnectedFromEvidence
  // Default demotion path tags ungraceful power-off / partition as sweep_stale
  // so it is distinguishable from a clean webSocketClose (`disconnect`).
  const onDisconnected =
    deps.onDisconnected ??
    ((dbArg: Db, serverId: string) =>
      onDaemonDisconnected(dbArg, serverId, undefined, 'sweep_stale'))

  const resolvedDeps: SweepResolvedDeps = {
    registry,
    onConnected,
    onConnectedFromEvidence,
    onDisconnected,
  }

  const connected = await listConnected(db)
  const recentlyOffline = await listRecentlyOffline(db)
  if (connected.length === 0 && recentlyOffline.length === 0) {
    sweepTrace('no-candidates')
    return { ...EMPTY_SWEEP_STATS }
  }

  let activeById: Map<string, number> | null
  try {
    activeById = await resolveActiveServerIds()
  } catch (err) {
    sweepTrace('ae-resolve-failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    activeById = null
  }
  const ctx: SweepOnceContext = {
    db,
    deps: resolvedDeps,
    connected,
    recentlyOffline,
    nowMs,
    deadlineMs: deps.deadlineMs ?? Number.POSITIVE_INFINITY,
    probeDeadlineMs,
  }
  if (activeById === null) {
    return await sweepOnceFallback(ctx)
  }

  return await sweepOnceWithAe(ctx, activeById)
}

type CronTlsRenewal = {
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
}

function sweepErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function sweepOnceSafely(
  env: CloudflareBindings,
  db: Db,
  deps: SweepOnceDeps = {}
): Promise<SweepOnceStats> {
  try {
    return await sweepOnce(env, db, deps)
  } catch (err) {
    sweepTrace('sweep-failed', { error: sweepErrorMessage(err) })
    return { ...EMPTY_SWEEP_STATS }
  }
}

async function runLeafRenewalSweepTickSafely(
  db: Db,
  commandQueue: ReturnType<typeof createWorkersCommandQueue>,
  tlsRenewal: CronTlsRenewal
): Promise<void> {
  try {
    // Resumes from the durable LEAF_RENEWAL_SWEEP_LOCK cursor (advanced
    // per bounded batch; reset when the sweep completes or the cursor
    // is invalid).
    await runLeafRenewalSweepTick(db, commandQueue, tlsRenewal)
  } catch (err) {
    sweepTrace('leaf-renewal-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
}

/**
 * Delete `dispatch` payloads whose failure-retention window elapsed.
 * Reuses this cron's already-open db; isolated so a failure here never aborts
 * the other sweeps.
 */
export async function sweepExpiredCommandDispatchSafely(db: Db): Promise<void> {
  try {
    const deleted = await sweepExpiredCommandDispatch(db, {
      limit: COMMAND_DISPATCH_SWEEP_LIMIT,
    })
    if (deleted > 0) {
      sweepTrace('command-dispatch-swept', { deleted })
    }
  } catch (err) {
    sweepTrace('command-dispatch-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
  // Recover commands stranded non-terminal by a mid-run restart (the
  // consumer's timeout lives only in memory), then unwedge managed rows
  // stuck at 'applying' with no live command left. Same isolation: a
  // failure here never aborts the other sweeps.
  try {
    const timedOut = await sweepStaleCommands(db)
    const released = await releaseStuckManagedApplying(db)
    if (timedOut > 0 || released.length > 0) {
      sweepTrace('stale-command-swept', {
        timedOut,
        releasedManaged: released.length,
      })
    }
  } catch (err) {
    sweepTrace('stale-command-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
}

/**
 * Drop webhook delivery ids past their replay-protection retention window.
 * Rides this cron's already-open db and is isolated the same way, so a failure
 * here never aborts the other sweeps.
 */
export async function sweepExpiredWebhookDeliveriesSafely(db: Db): Promise<void> {
  try {
    const deleted = await sweepExpiredWebhookDeliveries(db, {
      limit: WEBHOOK_DELIVERY_SWEEP_LIMIT,
    })
    if (deleted > 0) {
      sweepTrace('webhook-deliveries-swept', { deleted })
    }
  } catch (err) {
    sweepTrace('webhook-delivery-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
}

/**
 * Delete command transcripts past their retention window. Rides this cron's
 * existing tick (no new timer, no new connection) and is isolated so a storage
 * failure never aborts the other sweeps.
 *
 * `retentionDays` comes from the Workers env (see `runOfflineSweep`) so hosted
 * deployments can override the 30-day default the same way the Deno path does.
 */
export async function sweepExpiredExecutionLogsSafely(
  store: ExecutionLogStore,
  retentionDays: number
): Promise<void> {
  try {
    const deleted = await store.sweepExpired({
      retentionDays,
      limit: EXECUTION_LOG_SWEEP_LIMIT,
    })
    if (deleted > 0) {
      sweepTrace('execution-logs-swept', { deleted, retentionDays })
    }
  } catch (err) {
    sweepTrace('execution-logs-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
}

async function runQueuedCronSweeps(
  db: Db,
  queue: NonNullable<CloudflareBindings['TURBOPANEL_COMMAND_QUEUE']>,
  tlsRenewal?: CronTlsRenewal | null
): Promise<void> {
  try {
    const commandQueue = createWorkersCommandQueue(queue)
    await runSystemReconcileSweep(db, commandQueue)
    if (tlsRenewal) {
      await runLeafRenewalSweepTickSafely(db, commandQueue, tlsRenewal)
      // Orphaned ProxySQL frontends: teardown needs a full
      // `managed.ingress.reconcile`, so it can only run when the cron has the
      // secrets bundle (same gate as leaf renewal). Isolated so a failure
      // never aborts the other sweeps.
      try {
        await runManagedIngressOrphanSweep(db, commandQueue, tlsRenewal)
      } catch (err) {
        sweepTrace('managed-ingress-orphan-sweep-failed', {
          error: sweepErrorMessage(err),
        })
      }
    }
  } catch (err) {
    sweepTrace('system-reconcile-sweep-failed', {
      error: sweepErrorMessage(err),
    })
  }
}

function capDbTimeout(deadlineMs: number): number {
  const left = remainingMs(deadlineMs)
  if (!Number.isFinite(left)) return DB_OP_TIMEOUT_MS
  return Math.max(1, Math.min(DB_OP_TIMEOUT_MS, left))
}

function shouldRunScheduledPhase(
  scheduledTime: number | undefined,
  shouldRun: (scheduledTimeMs: number) => boolean
): boolean {
  return scheduledTime !== undefined && shouldRun(scheduledTime)
}

function optionalPhaseNames(scheduledTime: number | undefined): string[] {
  const names = ['command-dispatch', 'webhook-deliveries']
  if (shouldRunScheduledPhase(scheduledTime, shouldSweepExecutionLogs)) {
    names.push('execution-logs')
  }
  if (shouldRunScheduledPhase(scheduledTime, shouldSweepTierNotices)) {
    names.push('tier-notices')
  }
  if (shouldRunScheduledPhase(scheduledTime, shouldRunGraceClock)) {
    names.push('billing-grace-clock')
  }
  if (shouldRunScheduledPhase(scheduledTime, shouldRunReconcile)) {
    names.push('billing-reconcile')
  }
  names.push('reconcile')
  return names
}

function markSkippedFrom(
  phasesSkipped: string[],
  phase: string,
  scheduledTime: number | undefined
): void {
  const rest = optionalPhaseNames(scheduledTime)
  const index = rest.indexOf(phase)
  phasesSkipped.push(...(index === -1 ? rest : rest.slice(index)))
}

function skipFromPhase(
  phasesSkipped: string[],
  phase: string,
  scheduledTime: number | undefined
): void {
  sweepTrace('budget-exhausted', { phase })
  markSkippedFrom(phasesSkipped, phase, scheduledTime)
}

/**
 * Run one optional cron phase against the remaining tick deadline. On timeout
 * or a missed deadline, later phases are skipped rather than started.
 */
async function runOptionalPhase(
  deadlineMs: number,
  phase: string,
  scheduledTime: number | undefined,
  phasesSkipped: string[],
  work: () => Promise<void>
): Promise<boolean> {
  const left = remainingMs(deadlineMs)
  if (left <= 0) {
    skipFromPhase(phasesSkipped, phase, scheduledTime)
    return false
  }
  try {
    if (!Number.isFinite(left)) {
      await work()
      return true
    }
    await raceWithTimeout(work(), left, `offline-sweep ${phase} exceeded remaining budget`)
    return true
  } catch (err) {
    sweepTrace('budget-exhausted', {
      phase,
      error: sweepErrorMessage(err),
    })
    markSkippedFrom(phasesSkipped, phase, scheduledTime)
    return false
  }
}

/**
 * Like {@link runOptionalPhase}, but skip (and keep going) when this tick is
 * not in the phase's schedule window.
 */
async function runScheduledOptionalPhase(
  deadlineMs: number,
  phase: string,
  scheduledTime: number | undefined,
  phasesSkipped: string[],
  shouldRun: (scheduledTimeMs: number) => boolean,
  work: () => Promise<void>
): Promise<boolean> {
  if (!shouldRunScheduledPhase(scheduledTime, shouldRun)) return true
  return runOptionalPhase(deadlineMs, phase, scheduledTime, phasesSkipped, work)
}

async function sweepExecutionLogsPhase(
  env: CloudflareBindings,
  opts: RunOfflineSweepOpts
): Promise<void> {
  await sweepExpiredExecutionLogsSafely(
    resolveExecutionLogStore({
      runtime: 'workers',
      r2: (env as { EXECUTION_LOGS?: R2BucketLike }).EXECUTION_LOGS,
    }),
    opts.executionLogRetentionDays ??
      parseExecutionLogRetentionDays(env.TURBOPANEL_EXECUTION_LOG_RETENTION_DAYS)
  )
}

async function sweepTierNoticesPhase(
  env: CloudflareBindings,
  db: Db,
  tlsRenewal: CronTlsRenewal | null | undefined,
  opts: RunOfflineSweepOpts
): Promise<void> {
  const platformEnv = env as unknown as Record<string, string | undefined>
  const emailQueue = await resolveWorkersEmailQueue(
    db,
    platformEnv,
    tlsRenewal?.dataEncryptionSecrets,
  )
  const publicUrls = platformEnv.TURBOPANEL_PUBLIC_URLS?.split(',')[0]?.trim()
  await sweepTierNotices({
    db,
    emailQueue,
    deployment: 'hosted',
    ignoreElapsedGate: true,
    nowMs: opts.nowMs,
    consoleBaseUrl: platformEnv.TURBOPANEL_BASE_URL?.trim() || publicUrls,
  })
}

async function runBillingOptionalPhases(
  env: CloudflareBindings,
  db: Db,
  opts: RunOfflineSweepOpts,
  deadlineMs: number,
  phasesSkipped: string[]
): Promise<boolean> {
  // Billing phases: skipped wholesale when the instance has no Stripe key
  // (`resolveBillingConfig` is the switch). They run in sequence through
  // the optional-phase runner, so a failure in one skips the billing
  // phases after it for that tick (they catch up on the next one). Kept
  // that way by decision on 2026-09-08; see the v6 ledger.
  const billingConfig = resolveBillingConfig(env as unknown as Record<string, string | undefined>)
  if (!billingConfig) return true

  if (
    !(await runScheduledOptionalPhase(
      deadlineMs,
      'billing-grace-clock',
      opts.scheduledTime,
      phasesSkipped,
      shouldRunGraceClock,
      async () => {
        const client = createStripeClient(billingConfig)
        await runGraceClock({
          db,
          client,
          nowMs: opts.nowMs,
          reproject: (providerSubscriptionId) =>
            projectSubscriptionById({ db, client }, providerSubscriptionId),
        })
      }
    ))
  ) {
    return false
  }

  return runScheduledOptionalPhase(
    deadlineMs,
    'billing-reconcile',
    opts.scheduledTime,
    phasesSkipped,
    shouldRunReconcile,
    async () => {
      await runReconcile({ db, nowMs: opts.nowMs })
    }
  )
}

async function runOptionalCronPhases(
  env: CloudflareBindings,
  db: Db,
  tlsRenewal: CronTlsRenewal | null | undefined,
  opts: RunOfflineSweepOpts,
  deadlineMs: number,
  phasesSkipped: string[]
): Promise<void> {
  if (
    !(await runOptionalPhase(
      deadlineMs,
      'command-dispatch',
      opts.scheduledTime,
      phasesSkipped,
      () => runWithDbTimeout(db, sweepExpiredCommandDispatchSafely, capDbTimeout(deadlineMs))
    ))
  ) {
    return
  }

  if (
    !(await runOptionalPhase(
      deadlineMs,
      'webhook-deliveries',
      opts.scheduledTime,
      phasesSkipped,
      () => runWithDbTimeout(db, sweepExpiredWebhookDeliveriesSafely, capDbTimeout(deadlineMs))
    ))
  ) {
    return
  }

  if (
    !(await runScheduledOptionalPhase(
      deadlineMs,
      'execution-logs',
      opts.scheduledTime,
      phasesSkipped,
      shouldSweepExecutionLogs,
      () => sweepExecutionLogsPhase(env, opts)
    ))
  ) {
    return
  }

  if (
    !(await runScheduledOptionalPhase(
      deadlineMs,
      'tier-notices',
      opts.scheduledTime,
      phasesSkipped,
      shouldSweepTierNotices,
      () => sweepTierNoticesPhase(env, db, tlsRenewal, opts)
    ))
  ) {
    return
  }

  if (!(await runBillingOptionalPhases(env, db, opts, deadlineMs, phasesSkipped))) {
    return
  }

  const commandQueue = env.TURBOPANEL_COMMAND_QUEUE
  if (!commandQueue) return
  await runOptionalPhase(deadlineMs, 'reconcile', opts.scheduledTime, phasesSkipped, () =>
    runQueuedCronSweeps(db, commandQueue, tlsRenewal)
  )
}

export type RunOfflineSweepOpts = {
  executionLogRetentionDays?: number
  scheduledTime?: number
  nowMs?: number
  deadlineMs?: number
  /** Test seam: skip `resolveWorkersDb`. */
  db?: Db
  /** Test seam: inject `sweepOnce` deps (registry, list, AE resolver). */
  sweepOnceDeps?: SweepOnceDeps
}

/** Cron Trigger entry point (`workers.ts` `scheduled()`). */
export async function runOfflineSweep(
  env: CloudflareBindings,
  tlsRenewal?: CronTlsRenewal | null,
  opts: RunOfflineSweepOpts = {}
): Promise<void> {
  lastScheduledTimeForTests = opts.scheduledTime

  // `workers.ts`'s `scheduled()` handler awaits `initWorkerApp` (which already
  // registers the v5 sink) before calling this function, but re-register here
  // unconditionally anyway — this function is also called directly in tests
  // and must not depend on that ordering. Always the v5 store so demotions /
  // self-heal status rows land in the same dataset the read side queries.
  setServerStatusEventSink(
    resolveServerMetricsStore({
      runtime: 'workers',
      analyticsEngine: (env as { SERVER_METRICS?: AnalyticsEngineDatasetLike })
        .SERVER_METRICS,
    })
  )

  // Fresh per-invocation Hyperdrive client (Workers cannot reuse a DB socket
  // across requests/cron invocations). Always end it — leaving postgres.js
  // pools open stacks memory until the isolate hits the 128 MB limit.
  const db = opts.db ?? resolveWorkersDb(env)
  if (!db) return

  const startedAtMs = opts.nowMs ?? Date.now()
  const deadlineMs = opts.deadlineMs ?? startedAtMs + OFFLINE_SWEEP_TICK_BUDGET_MS
  const phasesSkipped: string[] = []
  let stats: SweepOnceStats = { ...EMPTY_SWEEP_STATS }

  try {
    let lock = null
    try {
      lock = await runWithDbTimeout(
        db,
        (leaseDb) =>
          tryBeginOfflineSweep(leaseDb, startedAtMs, {
            heldUntilMs: deadlineMs + DB_OP_TIMEOUT_MS,
          }),
        capDbTimeout(deadlineMs)
      )
    } catch (err) {
      sweepTrace('lease-acquire-failed', { error: sweepErrorMessage(err) })
      return
    }
    if (!lock) {
      sweepTrace('skipped-lease-held')
      return
    }

    try {
      const ranLiveness = await runBoundedPhase(deadlineMs, 'liveness', async () => {
        stats = await sweepOnceSafely(env, db, {
          ...opts.sweepOnceDeps,
          nowMs: opts.sweepOnceDeps?.nowMs ?? startedAtMs,
          deadlineMs: opts.sweepOnceDeps?.deadlineMs ?? deadlineMs,
        })
      })
      if (!ranLiveness) {
        markSkippedFrom(phasesSkipped, 'command-dispatch', opts.scheduledTime)
      } else {
        await runOptionalCronPhases(env, db, tlsRenewal, opts, deadlineMs, phasesSkipped)
      }
    } finally {
      try {
        await runWithDbTimeout(db, (leaseDb) => endOfflineSweep(leaseDb, lock))
      } catch (err) {
        sweepTrace('lease-release-failed', { error: sweepErrorMessage(err) })
      }
    }
  } finally {
    await endDbConnection(db).catch(() => {})
    sweepTrace('tick-complete', {
      durationMs: Date.now() - startedAtMs,
      probed: stats.probed,
      stale: stats.stale,
      healed: stats.healed,
      phasesSkipped,
    })
  }
}
