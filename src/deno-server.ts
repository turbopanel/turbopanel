import type { Hono } from 'hono'
import { deriveDaemonJwtKeyring } from './daemon/authn/daemon-jwt-keyring.ts'
import {
  type DerivedSecretsConfig,
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsFromEnv,
  type SecretsConfig,
} from './client/authn/secrets.ts'
import { type AppEnv, createApp } from './app.ts'
import { createDenoDb, type Db, endDbConnection } from './db.ts'
import { logInfo, logWarn } from './logger.ts'
import { createRedisDaemonCellRegistry } from './daemon/cell/redis/registry.ts'
import { sweepStalePresence } from './daemon/cell/control-plane-monitor.ts'
import { createDenoMaintenanceScheduler } from './daemon/cell/deno-maintenance.ts'
import { DAEMON_CELL_MAINTAIN_MS } from './daemon/cell/protocol.ts'
import {
  COMMAND_DISPATCH_SWEEP_LIMIT,
  sweepExpiredCommandDispatch,
} from './lib/db/command-records.ts'
import { releaseStuckManagedApplying, sweepStaleCommands } from './lib/commands/stale-sweep.ts'
import {
  sweepExpiredWebhookDeliveries,
  WEBHOOK_DELIVERY_SWEEP_LIMIT,
} from './lib/db/webhook-delivery-records.ts'
import { registerWebhookRoutes } from './webhook/routes.ts'
import { runManagedIngressOrphanSweep } from './client/managed/ingress-desired.ts'
import { runSystemReconcileSweep } from './client/system/reconcile.ts'
import {
  LEAF_RENEWAL_SWEEP_INTERVAL_MS,
  runLeafRenewalSweepTick,
} from './client/tls/leaf-renewal-sweep.ts'
import {
  assertPasswordHasherAvailable,
  configureArgon2idWorkFactor,
} from './client/authn/password.ts'
import { registerAdminRoutes } from './admin/routes.ts'
import { registerInstallRoutes } from './lib/install/routes.ts'
import { registerDaemonApiRoutes } from './daemon/api-routes.ts'
import { registerDaemonWebSocket } from './daemon/deno-ws.ts'
import {
  parseMetricsRetentionDays,
  parsePositiveIntEnv,
  resolveServerMetricsStore,
} from './daemon/metrics/store-selection.ts'
import type { ServerMetricsStore } from './daemon/metrics/types.ts'
import { setServerStatusEventSink } from './daemon/metrics/status-events.ts'
import { setActiveServerMetricsStore } from './daemon/metrics/active-store.ts'
import {
  parseExecutionLogDriver,
  parseExecutionLogRetentionDays,
  resolveExecutionLogStore,
  resolveS3ExecutionLogConfig,
} from './lib/execution-logs/store-selection.ts'
import { setExecutionLogSealSink } from './lib/execution-logs/seal-on-terminal.ts'
import { EXECUTION_LOG_SWEEP_LIMIT } from './lib/execution-logs/types.ts'
import {
  createRedisRateLimiter,
  resolveClientAuthRateLimit,
  resolveClientAuthStrictRateLimit,
  resolveDaemonConnectRateLimit,
  resolveDaemonMetricsRateLimit,
  resolveDaemonRestRateLimit,
  resolveDaemonWsInboundLimits,
  resolveGithubWebhookRateLimit,
  resolveGitlabWebhookRateLimit,
} from './daemon/rate-limit/redis-rate-limiter.ts'
import { createDurableAuthRateLimiter } from './client/authn/auth-rate-limit.ts'
import { OTP_VERIFIER_SECRET_PURPOSE } from './client/authn/email-otp.ts'
import { isDeveloperSurfaceEnabled } from './dev-mode.ts'
import {
  createDenoAmqpQueue,
  DEFAULT_AMQP_URL,
  probeAmqpBrokerReachable,
} from './lib/email/smtp/deno-amqp-queue.ts'
import { resolveEmailSettings } from './lib/settings/email-settings.ts'
import { createNoopQueue } from './lib/email/noop-queue.ts'
import type { EmailQueue } from './lib/email/types.ts'
import {
  createDenoAmqpCommandQueue,
  probeCommandAmqpBrokerReachable,
} from './lib/commands/deno-amqp-queue.ts'
import { startCommandConsumer } from './lib/commands/deno-consumer.ts'
import { createNoopCommandQueue, isNoopCommandQueue } from './lib/commands/noop-command-queue.ts'
import type { CommandQueue } from './lib/commands/queue.ts'
import { createRedisQueryCache } from './query-cache/redis-query-cache.ts'
import {
  hardenInstanceSocket,
  prepareInstanceSocket,
  resolveExecutionLogDir,
  resolveInstanceSocket,
} from './server-paths.ts'

export type DenoDeveloperSurfaceContext = {
  routes: Hono<AppEnv>
  sessionSecrets: DerivedSecretsConfig
  db: Db
}

export type StartDenoServerOptions = {
  /**
   * Optional developer-surface registrar. Production `src/deno.ts` omits this
   * so developer modules stay out of the compiled graph. The development
   * entrypoint passes a registrar that imports those modules.
   */
  registerDeveloperSurface?: (ctx: DenoDeveloperSurfaceContext) => void
}

async function resolveEmailQueue(_db: Db): Promise<EmailQueue> {
  const envUrl = Deno.env.get('TURBOPANEL_AMQP_URL')
  if (envUrl?.trim() === '') {
    logInfo('email', 'TURBOPANEL_AMQP_URL is empty; using noop queue')
    return createNoopQueue()
  }
  if (envUrl !== undefined) {
    return createDenoAmqpQueue({ amqpUrl: envUrl.trim() })
  }
  if (await probeAmqpBrokerReachable(DEFAULT_AMQP_URL)) {
    return createDenoAmqpQueue({ amqpUrl: DEFAULT_AMQP_URL })
  }

  logInfo('email', 'AMQP broker unavailable; using noop queue')
  return createNoopQueue()
}

async function resolveCommandQueue(): Promise<CommandQueue> {
  const envUrl = Deno.env.get('TURBOPANEL_AMQP_URL')
  if (envUrl?.trim() === '') {
    return createNoopCommandQueue()
  }
  if (envUrl !== undefined) {
    return createDenoAmqpCommandQueue({ amqpUrl: envUrl.trim() })
  }
  if (await probeCommandAmqpBrokerReachable(DEFAULT_AMQP_URL)) {
    return createDenoAmqpCommandQueue({ amqpUrl: DEFAULT_AMQP_URL })
  }

  logInfo('command-queue', 'AMQP broker unavailable; using noop command queue')
  return createNoopCommandQueue()
}

async function startOptionalCommandConsumer(opts: {
  db: Db
  commandQueue: CommandQueue
  daemonCellRegistry: ReturnType<typeof createRedisDaemonCellRegistry>
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
}): Promise<{ close(): Promise<void> } | null> {
  if (isNoopCommandQueue(opts.commandQueue)) {
    logWarn('command-consumer', 'AMQP broker unavailable; command consumer not started')
    return null
  }
  const amqpUrl = resolveCommandAmqpUrl()
  if (!amqpUrl) return null
  try {
    return await startCommandConsumer({
      db: opts.db,
      registry: opts.daemonCellRegistry,
      amqpUrl,
      commandQueue: opts.commandQueue,
      resealDeps: {
        secretsConfig: opts.secretsConfig,
        dataEncryptionSecrets: opts.dataEncryptionSecrets,
      },
      secretsConfig: opts.secretsConfig,
      dataEncryptionSecrets: opts.dataEncryptionSecrets,
    })
  } catch (err) {
    logWarn(
      'command-consumer',
      `AMQP broker unavailable; command consumer not started: ${String(err)}`
    )
    return null
  }
}

/**
 * Arm the DuckDB store's daily Parquet-archive timer. No-ops for stores
 * without one (e.g. the disabled fallback store) so boot stays backend-neutral.
 */
function startMetricsDailyArchiveIfSupported(store: ServerMetricsStore): void {
  const candidate = store as ServerMetricsStore & {
    startDailyArchiveTimer?: () => void
  }
  candidate.startDailyArchiveTimer?.()
}

/**
 * Flush and close the metrics store on shutdown so batched-but-unflushed
 * accepted samples are persisted before the process exits. No-ops for stores
 * without a close() (e.g. the disabled fallback store).
 */
async function closeMetricsStoreIfSupported(store: ServerMetricsStore): Promise<void> {
  const candidate = store as ServerMetricsStore & {
    close?: () => Promise<void>
  }
  try {
    await candidate.close?.()
  } catch (err) {
    logWarn('metrics', `metrics store close on shutdown failed: ${String(err)}`)
  }
}

function resolveCommandAmqpUrl(): string | null {
  const envUrl = Deno.env.get('TURBOPANEL_AMQP_URL')
  if (envUrl?.trim() === '') {
    return null
  }
  if (envUrl !== undefined) {
    return envUrl.trim()
  }
  return DEFAULT_AMQP_URL
}

/** Isolate one cleanup phase so a failure cannot abort the rest of the tick. */
async function runCleanupPhase(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    logWarn('daemon-cell', `${label} error: ${String(err)}`)
  }
}

async function sweepStaleCommandsPhase(db: Db): Promise<void> {
  const swept = await sweepStaleCommands(db)
  const released = await releaseStuckManagedApplying(db)
  if (swept > 0 || released.length > 0) {
    logWarn(
      'daemon-cell',
      `stale command sweep: timed out ${swept}, released managed ${
        released.join(',') || 'none'
      }`
    )
  }
}

export async function startDenoServer(options: StartDenoServerOptions = {}): Promise<void> {
  const developerSurface = Boolean(options.registerDeveloperSurface) && isDeveloperSurfaceEnabled()
  const db = createDenoDb()
  const emailQueue = await resolveEmailQueue(db)
  const commandQueue = await resolveCommandQueue()
  const runtimeEnv = Deno.env.toObject()
  configureArgon2idWorkFactor({
    memoryKib: Deno.env.get('TURBOPANEL_ARGON2ID_MEMORY_KIB') ?? null,
    timeCost: Deno.env.get('TURBOPANEL_ARGON2ID_TIME_COST') ?? null,
  })
  await assertPasswordHasherAvailable()
  logInfo('auth', 'Argon2id password hasher available')
  const secretsConfig = parseSecretsFromEnv(
    {
      TURBOPANEL_SECRET: Deno.env.get('TURBOPANEL_SECRET'),
      TURBOPANEL_SECRETS: Deno.env.get('TURBOPANEL_SECRETS'),
    },
    'deno'
  )
  const sessionSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const otpVerifierSecrets = await deriveSecretsConfig(secretsConfig, OTP_VERIFIER_SECRET_PURPOSE)
  const daemonJwtKeyring = await deriveDaemonJwtKeyring(secretsConfig)
  const challengeSigningSecrets = await deriveSecretsConfig(
    secretsConfig,
    'daemon-challenge-signing'
  )
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  // Derived after data-encryption secrets so DB-backed email secrets can be decrypted.
  const emailSettings = await resolveEmailSettings(db, runtimeEnv, dataEncryptionSecrets)
  const daemonCellRegistry = createRedisDaemonCellRegistry({ db })
  const queryCache = createRedisQueryCache({
    client: daemonCellRegistry.client,
    db,
  })
  // Metrics directory itself stays unconfigured here — `resolveMetricsDir()`
  // already reads TURBOPANEL_METRICS_DIR inside the DuckDB store.
  const serverMetricsStore = resolveServerMetricsStore({
    runtime: 'deno',
    duckdb: {
      retentionDays: parseMetricsRetentionDays(
        Deno.env.get('TURBOPANEL_SERVER_METRICS_RETENTION_DAYS')
      ),
      threads: parsePositiveIntEnv(Deno.env.get('TURBOPANEL_SERVER_METRICS_DUCKDB_THREADS')),
      memoryLimitMb: parsePositiveIntEnv(
        Deno.env.get('TURBOPANEL_SERVER_METRICS_DUCKDB_MEMORY_LIMIT')
      ),
    },
  })
  setServerStatusEventSink(serverMetricsStore)
  setActiveServerMetricsStore(serverMetricsStore)
  startMetricsDailyArchiveIfSupported(serverMetricsStore)
  const executionLogRetentionDays = parseExecutionLogRetentionDays(
    Deno.env.get('TURBOPANEL_EXECUTION_LOG_RETENTION_DAYS')
  )
  const executionLogStore = resolveExecutionLogStore({
    runtime: 'deno',
    deno: {
      driver: parseExecutionLogDriver(Deno.env.get('TURBOPANEL_EXECUTION_LOG_DRIVER')),
      directory: resolveExecutionLogDir(),
      s3: resolveS3ExecutionLogConfig(Deno.env.toObject()),
    },
  })
  // The AMQP command consumer transitions commands outside any Hono context —
  // register the seal sink at boot so terminal transitions compact transcripts.
  setExecutionLogSealSink(executionLogStore)
  const connectRate = resolveDaemonConnectRateLimit()
  const restRate = resolveDaemonRestRateLimit()
  const metricsRate = resolveDaemonMetricsRateLimit()
  const githubWebhookRate = resolveGithubWebhookRateLimit()
  const gitlabWebhookRate = resolveGitlabWebhookRateLimit()
  const inboundLimits = resolveDaemonWsInboundLimits()
  const daemonConnectLimiter = createRedisRateLimiter({
    client: daemonCellRegistry.client,
    limit: connectRate.limit,
    periodSeconds: connectRate.periodSeconds,
  })
  const daemonRestLimiter = createRedisRateLimiter({
    client: daemonCellRegistry.client,
    limit: restRate.limit,
    periodSeconds: restRate.periodSeconds,
  })
  const daemonMetricsLimiter = createRedisRateLimiter({
    client: daemonCellRegistry.client,
    limit: metricsRate.limit,
    periodSeconds: metricsRate.periodSeconds,
  })
  // Inbound GitHub webhooks: keyed per peer address, not per server, because the
  // caller has no identity until its HMAC has been checked (see
  // `githubWebhookRateLimitKey`). Redis eval failures fall through to a
  // process-local token bucket so a broker hiccup still throttles per peer
  // instead of making ingress unlimited (daemon connect/REST stay fail-open).
  const githubWebhookLimiter = createRedisRateLimiter({
    client: daemonCellRegistry.client,
    limit: githubWebhookRate.limit,
    periodSeconds: githubWebhookRate.periodSeconds,
    onError: 'local',
  })
  // GitLab gets its own bucket rather than sharing GitHub's: the two are
  // independent senders and one flooding must not start dropping the other's
  // deliveries.
  const gitlabWebhookLimiter = createRedisRateLimiter({
    client: daemonCellRegistry.client,
    limit: gitlabWebhookRate.limit,
    periodSeconds: gitlabWebhookRate.periodSeconds,
    onError: 'local',
  })
  // Durable, globally-shared client-auth throttle over Redis (same infrastructure
  // as the daemon limiters). Auth uses onError: 'closed' so a Redis hiccup cannot
  // fail open into unthrottled login/OTP/install; daemon limiters keep the
  // default fail-open behaviour.
  //
  // Two separate buckets, one per AUTH_RATE_LIMIT_PURPOSE_TIERS tier: sign-up /
  // send-otp / reset-password-request get their own stricter budget instead of
  // sharing the looser default one — mirrors the in-memory SHARED_POLICIES this
  // replaces for Deno (see src/client/authn/auth-rate-limit.ts).
  const clientAuthRate = resolveClientAuthRateLimit()
  const clientAuthStrictRate = resolveClientAuthStrictRateLimit()
  const authRateLimiter = createDurableAuthRateLimiter({
    default: createRedisRateLimiter({
      client: daemonCellRegistry.client,
      limit: clientAuthRate.limit,
      periodSeconds: clientAuthRate.periodSeconds,
      onError: 'closed',
    }),
    strict: createRedisRateLimiter({
      client: daemonCellRegistry.client,
      limit: clientAuthStrictRate.limit,
      periodSeconds: clientAuthStrictRate.periodSeconds,
      onError: 'closed',
    }),
  })

  const commandConsumer = await startOptionalCommandConsumer({
    db,
    commandQueue,
    daemonCellRegistry,
    secretsConfig,
    dataEncryptionSecrets,
  })

  const app = createApp({
    db,
    emailQueue,
    commandQueue,
    secrets: sessionSecrets,
    otpVerifierSecrets,
    runtime: 'deno',
    corsOrigins: Deno.env.get('TURBOPANEL_UI_CORS_ORIGINS'),
    signupEnvOverride: Deno.env.get('TURBOPANEL_IS_SIGNUP_ENABLED'),
    emailFrom: emailSettings.from,
    baseUrl: Deno.env.get('TURBOPANEL_BASE_URL') ?? undefined,
    daemonCellRegistry,
    queryCache,
    serverMetricsStore,
    executionLogStore,
    dataEncryptionSecrets,
    secretsConfig,
    // Inject before client routes mount — must not be registered after
    // registerClientRoutes (see createApp authRateLimiter middleware).
    authRateLimiter,
    // Must be registered inside createApp() *before* GET /api/health, or the
    // health handler never sees TURBOPANEL_REVISION from systemd.
    getPlatformEnv: () => Deno.env.toObject(),
  })
  // Daemon + developer registrars are generic over the env, so the app's own
  // `AppEnv` typing carries through — no cast.
  const routes = app
  registerInstallRoutes(app, {
    secrets: sessionSecrets,
    otpVerifierSecrets,
    runtime: 'deno',
    signupEnvOverride: Deno.env.get('TURBOPANEL_IS_SIGNUP_ENABLED'),
  })
  if (developerSurface) {
    options.registerDeveloperSurface?.({ routes, sessionSecrets, db })
  }
  registerDaemonApiRoutes(routes, {
    secrets: daemonJwtKeyring,
    challengeSigningSecrets,
    secretsConfig,
    restLimiter: daemonRestLimiter,
    metricsLimiter: daemonMetricsLimiter,
    runtime: 'deno',
  })
  // Unversioned, session-free surface: mounted on the top-level app next to the
  // daemon API rather than under CLIENT_API_PREFIX, and authenticating itself.
  // Git kinds only — `/webhook/stripe` is hosted-only and is not imported here.
  registerWebhookRoutes(app, {
    runtime: 'deno',
    github: githubWebhookLimiter,
    gitlab: gitlabWebhookLimiter,
  })
  registerDaemonWebSocket(routes, {
    developerSurface,
    db,
    secrets: daemonJwtKeyring,
    sessionSecrets,
    daemonCellRegistry,
    connectLimiter: daemonConnectLimiter,
    inboundMessageLimit: inboundLimits.limit,
    inboundMessageWindowMs: inboundLimits.windowMs,
    commandQueue,
  })
  registerAdminRoutes(app, {
    secrets: sessionSecrets,
    runtime: 'deno',
    devSurface: developerSurface,
  })
  const socketPath = resolveInstanceSocket()

  const abort = new AbortController()
  const runSystemReconcileSweepTick = (): void => {
    if (isNoopCommandQueue(commandQueue)) return
    void runSystemReconcileSweep(db, commandQueue).catch((err) => {
      logWarn('daemon-cell', `system reconcile sweep error: ${String(err)}`)
    })
    // Orphaned-frontend teardown rides the same tick; separate call because
    // it enqueues `managed.ingress.reconcile` (needs secrets for payload
    // sealing), which `system.reconcile` cannot express.
    void runManagedIngressOrphanSweep(db, commandQueue, {
      secretsConfig,
      dataEncryptionSecrets,
    }).catch((err) => {
      logWarn('daemon-cell', `managed ingress orphan sweep error: ${String(err)}`)
    })
  }
  // Observe pending self-host inventory on boot, not only after the first
  // 60s cell tick. Hello/DO still must not enqueue; this is the Deno timer path.
  runSystemReconcileSweepTick()
  // Deno process timer (not a Durable Object) — cost-safe. Both backends demote
  // stale presence at DAEMON_OFFLINE_SWEEP_MS; Redis uses this timer-driven
  // maintain() + sweepStalePresence loop. Workers is disconnect-first (no periodic
  // DO stale-sweep alarm) — see DaemonCellObject alarm-path comments in do.ts.
  // Liveness and cleanup use separate in-flight flags so a hung dispatch /
  // webhook / execution-log / reconcile sweep cannot suppress stale-presence.
  const maintenance = createDenoMaintenanceScheduler({
    async runLiveness() {
      try {
        await daemonCellRegistry.maintain()
      } catch (err) {
        logWarn('daemon-cell', `maintenance error: ${String(err)}`)
      }
      try {
        await sweepStalePresence(db, daemonCellRegistry)
      } catch (err) {
        logWarn('daemon-cell', `stale presence sweep error: ${String(err)}`)
      }
    },
    async runCleanup() {
      // Workers parity (offline-sweep cron): bounded cleanup of expired
      // `dispatch` failure-retention payloads on the process-long db.
      await runCleanupPhase('command dispatch sweep', () =>
        sweepExpiredCommandDispatch(db, { limit: COMMAND_DISPATCH_SWEEP_LIMIT })
      )
      // Recover commands stranded non-terminal by a mid-run restart (the
      // consumer's timeout lives only in memory), then unwedge managed rows
      // stuck at 'applying' with no live command left.
      await runCleanupPhase('stale command sweep', () => sweepStaleCommandsPhase(db))
      // Workers parity (offline-sweep cron): drop webhook delivery ids past the
      // replay-protection retention window.
      await runCleanupPhase('webhook delivery sweep', () =>
        sweepExpiredWebhookDeliveries(db, { limit: WEBHOOK_DELIVERY_SWEEP_LIMIT })
      )
      // Workers parity (offline-sweep cron): bounded removal of command
      // transcripts past retention. Object/filesystem only — no db involved.
      await runCleanupPhase('execution log sweep', () =>
        executionLogStore.sweepExpired({
          retentionDays: executionLogRetentionDays,
          limit: EXECUTION_LOG_SWEEP_LIMIT,
        })
      )
      runSystemReconcileSweepTick()
    },
  })
  const maintenanceTimer = setInterval(() => maintenance.tick(), DAEMON_CELL_MAINTAIN_MS)

  // First Deno-side scheduled surface besides cell maintain: Organization CA
  // leaf renewal. Fresh createDenoDb() per tick, always endDbConnection in
  // finally — do not reuse the process-long `db` (same discipline as Workers
  // Hyperdrive). Overlap-guarded; cadence is minutes, not the 60s cell tick.
  let leafRenewalInFlight = false
  const leafRenewalTimer = setInterval(() => {
    if (leafRenewalInFlight) return
    if (isNoopCommandQueue(commandQueue)) return
    leafRenewalInFlight = true
    void (async () => {
      const tickDb = createDenoDb()
      try {
        // Resumes from the durable LEAF_RENEWAL_SWEEP_LOCK cursor (advanced
        // per bounded batch; reset when the sweep completes or the cursor
        // is invalid).
        await runLeafRenewalSweepTick(tickDb, commandQueue, {
          secretsConfig,
          dataEncryptionSecrets,
        })
      } catch (err) {
        logWarn('tls-leaf-renewal', `sweep error: ${String(err)}`)
      } finally {
        await endDbConnection(tickDb).catch(() => {})
        leafRenewalInFlight = false
      }
    })()
  }, LEAF_RENEWAL_SWEEP_INTERVAL_MS)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    Deno.addSignalListener(signal, async () => {
      clearInterval(maintenanceTimer)
      clearInterval(leafRenewalTimer)
      await emailQueue.close?.()
      await commandQueue.close?.()
      await commandConsumer?.close()
      await daemonCellRegistry.close()
      // Persist any pending batched metrics rows before tearing the process
      // down — accepted (202) samples must survive a normal SIGINT/SIGTERM.
      await closeMetricsStoreIfSupported(serverMetricsStore)
      abort.abort()
    })
  }

  await prepareInstanceSocket(socketPath)

  await daemonCellRegistry.reclaimOrphanedSocketLeasesOnStartup()

  Deno.serve(
    {
      path: socketPath,
      signal: abort.signal,
      async onListen(addr) {
        const path = 'path' in addr ? addr.path : socketPath
        await hardenInstanceSocket(path)
        logInfo(
          'instance',
          `TurboPanel listening on ${path}; developer surface ${
            developerSurface ? 'enabled' : 'disabled'
          }`
        )
      },
    },
    app.fetch
  )
}
