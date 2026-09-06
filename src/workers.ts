import { Hono } from 'hono'
import type { DaemonJwtKeyring } from './daemon/authn/daemon-jwt-keyring.ts'
import { deriveDaemonJwtKeyring } from './daemon/authn/daemon-jwt-keyring.ts'
import {
  type DerivedSecretsConfig,
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsFromEnv,
  type SecretsConfig,
} from './client/authn/secrets.ts'
import { type AppEnv, createApp } from './app.ts'
import { createDurableObjectDaemonCellRegistry } from './daemon/cell/do-registry.ts'
import { runOfflineSweep } from './daemon/cell/offline-sweep.ts'
import { registerAdminRoutes } from './admin/routes.ts'
import { registerDaemonApiRoutes } from './daemon/api-routes.ts'
import { registerWebhookRoutes } from './webhook/routes.ts'
import { registerWorkersDaemonWebSocket } from './daemon/workers-ws.ts'
import { resolveWorkersEmailQueue } from './lib/email/mailgun/workers-queue.ts'
import type { EmailQueue } from './lib/email/types.ts'
import { normalizeSignupEnvOverride } from './client/authn/install-state.ts'
import {
  assertPasswordHasherAvailable,
  configureArgon2idWorkFactor,
} from './client/authn/password.ts'
import { createWorkersCommandQueue } from './lib/commands/workers-queue.ts'
import { createNoopCommandQueue } from './lib/commands/noop-command-queue.ts'
import type { CommandQueue } from './lib/commands/queue.ts'
import { isTransientError, processCommandEnvelope } from './lib/commands/consumer.ts'
import { parseCommandEnvelope } from './lib/commands/envelope.ts'
import {
  type AnalyticsEngineDatasetLike,
  resolveCloudflareAnalyticsSqlConfig,
  resolveServerMetricsStoreV4,
} from './daemon/metrics/store-selection-workers.ts'
import { setServerStatusEventSink } from './daemon/metrics/status-events.ts'
import type { ServerMetricsStoreV4 } from './daemon/metrics/types-v4.ts'
import {
  parseExecutionLogRetentionDays,
  type R2BucketLike,
  resolveExecutionLogStore,
} from './lib/execution-logs/store-selection.ts'
import { setExecutionLogSealSink } from './lib/execution-logs/seal-on-terminal.ts'
import type { ExecutionLogStore } from './lib/execution-logs/types.ts'
import {
  closeWorkersRequestDb,
  openWorkersRequestDb,
  resolveWorkersClientAuthRateLimiter,
  resolveWorkersDaemonRateLimiters,
  resolveWorkersDb,
  resolveWorkersGithubWebhookRateLimiter,
  resolveWorkersGitlabWebhookRateLimiter,
  warnIfCachedHyperdriveMissing,
  warnIfClientAuthRateLimiterMissing,
  warnIfClientAuthStrictRateLimiterMissing,
  warnIfDaemonRateLimitersMissing,
  warnIfGithubWebhookRateLimiterMissing,
  warnIfGitlabWebhookRateLimiterMissing,
} from './workers-bindings.ts'
import { type createWorkersDb, type Db, endDbConnection } from './db.ts'
import type { AuthRateLimiter } from './client/authn/auth-rate-limit.ts'
import { OTP_VERIFIER_SECRET_PURPOSE } from './client/authn/email-otp.ts'

export { DaemonCellObject } from './daemon/cell/do.ts'

let initPromise: Promise<void> | null = null
let cachedApp: ReturnType<typeof createApp> | null = null
let cachedSessionSecrets: Awaited<ReturnType<typeof deriveSecretsConfig>> | null = null
let cachedOtpVerifierSecrets: DerivedSecretsConfig | null = null
let cachedDaemonJwtKeyring: DaemonJwtKeyring | null = null
let cachedChallengeSigningSecrets: DerivedSecretsConfig | null = null
let cachedDataEncryptionSecrets: DerivedSecretsConfig | null = null
let cachedSecretsConfig: SecretsConfig | null = null
let cachedCommandQueue: CommandQueue | null = null
let cachedServerMetricsStoreV4: ServerMetricsStoreV4 | null = null
let cachedExecutionLogStore: ExecutionLogStore | null = null
let cachedAuthRateLimiter: AuthRateLimiter | null = null
let cachedDaemonCellRegistryFactory:
  | ((
      env: CloudflareBindings,
      db?: ReturnType<typeof createWorkersDb>
    ) => ReturnType<typeof createDurableObjectDaemonCellRegistry>)
  | null = null

/** @internal Clears per-isolate Worker caches so entry tests can re-init. */
export function resetWorkerAppCachesForTests(): void {
  initPromise = null
  cachedApp = null
  cachedSessionSecrets = null
  cachedOtpVerifierSecrets = null
  cachedDaemonJwtKeyring = null
  cachedChallengeSigningSecrets = null
  cachedDataEncryptionSecrets = null
  cachedSecretsConfig = null
  cachedCommandQueue = null
  cachedServerMetricsStoreV4 = null
  cachedExecutionLogStore = null
  cachedAuthRateLimiter = null
  cachedDaemonCellRegistryFactory = null
  lazyEmailQueueResolveCallsForTests = 0
}

/**
 * @internal Test seam: count of `resolveWorkersEmailQueue()` calls made by
 * {@link createLazyWorkersEmailQueue}. ESM imports cannot be monkeypatched
 * from a test, so the lazy resolver's own call count is the seam — a
 * rate-limited or non-email-sending request must leave this at 0.
 */
let lazyEmailQueueResolveCallsForTests = 0

export function resetLazyEmailQueueResolveCallsForTests(): void {
  lazyEmailQueueResolveCallsForTests = 0
}

export function getLazyEmailQueueResolveCallsForTests(): number {
  return lazyEmailQueueResolveCallsForTests
}

/**
 * Wrap {@link resolveWorkersEmailQueue} in an `EmailQueue` that only resolves
 * (and memoizes) the real queue when a caller actually enqueues a job.
 *
 * Resolving eagerly on every request means every webhook delivery, health
 * check, and auth probe pays a DB read plus an AES-GCM decrypt of the
 * Mailgun/SMTP secret before the route (or the auth rate limiter) ever sees
 * the request — see `src/workers.ts` module docs and the `fetch` handler.
 * Deferring to first `enqueue()` means that cost is paid only by the routes
 * that actually send email, and only after those routes' own rate limiting.
 */
function createLazyWorkersEmailQueue(
  db: Db | undefined,
  platformEnv: Record<string, string | undefined>,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined
): EmailQueue {
  let resolved: Promise<EmailQueue> | null = null
  const resolve = (): Promise<EmailQueue> => {
    resolved ??= (() => {
      lazyEmailQueueResolveCallsForTests += 1
      return resolveWorkersEmailQueue(db, platformEnv, dataEncryptionSecrets)
    })()
    return resolved
  }
  return {
    async enqueue(job) {
      const queue = await resolve()
      await queue.enqueue(job)
    },
    async close() {
      if (!resolved) return
      const queue = await resolved
      await queue.close?.()
    },
  }
}

async function initWorkerApp(env: CloudflareBindings) {
  const secretsConfig = parseSecretsFromEnv(
    {
      TURBOPANEL_SECRET: env.TURBOPANEL_SECRET,
      TURBOPANEL_SECRETS: env.TURBOPANEL_SECRETS,
    },
    'workers'
  )
  configureArgon2idWorkFactor({
    memoryKib: env.TURBOPANEL_ARGON2ID_MEMORY_KIB,
    timeCost: env.TURBOPANEL_ARGON2ID_TIME_COST,
  })
  await assertPasswordHasherAvailable()
  cachedSecretsConfig = secretsConfig
  cachedSessionSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  cachedOtpVerifierSecrets = await deriveSecretsConfig(secretsConfig, OTP_VERIFIER_SECRET_PURPOSE)
  cachedDaemonJwtKeyring = await deriveDaemonJwtKeyring(secretsConfig)
  cachedChallengeSigningSecrets = await deriveSecretsConfig(
    secretsConfig,
    'daemon-challenge-signing'
  )
  cachedDataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  cachedCommandQueue = env.TURBOPANEL_COMMAND_QUEUE
    ? createWorkersCommandQueue(env.TURBOPANEL_COMMAND_QUEUE)
    : createNoopCommandQueue()
  const analyticsEngineSql = resolveCloudflareAnalyticsSqlConfig(env)
  // Real v4 backend (writes to SERVER_METRICS_V4 — the v4 envelope, per
  // field-map-v4.ts). `CloudflareAnalyticsEngineServerMetricsStoreV4`
  // implements the full `ServerMetricsStoreV4` surface (writes and reads
  // alike) directly, including the paged entity families and `sample.events`
  // — the request-resolved `slotMapping` (`buildMetricsDataPointsV4`'s
  // parameter) is threaded straight through by the ingest route's
  // `writeSample` call, with no v3 bridging in between. `resolveServerMetricsStoreV4`
  // already degrades to `DisabledServerMetricsStoreV4` when the
  // `SERVER_METRICS_V4` binding is unconfigured, so this is always the
  // correct store to use here regardless of binding state.
  cachedServerMetricsStoreV4 = resolveServerMetricsStoreV4({
    runtime: 'workers',
    analyticsEngine: (env as { SERVER_METRICS_V4?: AnalyticsEngineDatasetLike }).SERVER_METRICS_V4,
    analyticsEngineSql,
  })
  setServerStatusEventSink(cachedServerMetricsStoreV4)
  cachedExecutionLogStore = resolveExecutionLogStore({
    runtime: 'workers',
    r2: (env as { EXECUTION_LOGS?: R2BucketLike }).EXECUTION_LOGS,
  })
  // Terminal command transitions run in the queue-consumer and cron isolates
  // that never see a Hono context — register the seal sink at isolate init.
  setExecutionLogSealSink(cachedExecutionLogStore)
  // Email queue + signup force are resolved per request from current env/DB —
  // do not bake them into createApp() so dashboard/panel changes apply without
  // waiting for an isolate recycle. signupEnvOverride here is only a fallback
  // for tests that omit platformEnv.
  cachedApp = createApp({
    commandQueue: cachedCommandQueue,
    secrets: cachedSessionSecrets,
    otpVerifierSecrets: cachedOtpVerifierSecrets ?? undefined,
    runtime: 'workers',
    corsOrigins: env.TURBOPANEL_UI_CORS_ORIGINS,
    signupEnvOverride: env.TURBOPANEL_IS_SIGNUP_ENABLED,
    serverMetricsStoreV4: cachedServerMetricsStoreV4,
    executionLogStore: cachedExecutionLogStore,
    dataEncryptionSecrets: cachedDataEncryptionSecrets ?? undefined,
    secretsConfig: cachedSecretsConfig ?? undefined,
  })
  warnIfDaemonRateLimitersMissing(env)
  warnIfClientAuthRateLimiterMissing(env)
  warnIfClientAuthStrictRateLimiterMissing(env)
  warnIfGithubWebhookRateLimiterMissing(env)
  warnIfGitlabWebhookRateLimiterMissing(env)
  cachedAuthRateLimiter = resolveWorkersClientAuthRateLimiter(env)
  const rateLimiters = resolveWorkersDaemonRateLimiters(env)
  // Daemon registrars are generic over the env — the app's `AppEnv` carries
  // through without a cast (same as deno-server.ts).
  const daemonRoutes = cachedApp
  registerDaemonApiRoutes(daemonRoutes, {
    secrets: cachedDaemonJwtKeyring ?? undefined,
    challengeSigningSecrets: cachedChallengeSigningSecrets ?? undefined,
    secretsConfig: cachedSecretsConfig ?? undefined,
    restLimiter: rateLimiters.rest,
    metricsLimiter: rateLimiters.metrics,
    runtime: 'workers',
  })
  registerWorkersDaemonWebSocket(daemonRoutes, {
    secrets: cachedDaemonJwtKeyring ?? undefined,
    connectLimiter: rateLimiters.connect,
  })
  // Unversioned, session-free surface: mounted on the top-level app rather than
  // under CLIENT_API_PREFIX, and authenticating itself (see
  // `src/webhook/AGENTS.md`).
  registerWebhookRoutes(cachedApp, {
    runtime: 'workers',
    github: resolveWorkersGithubWebhookRateLimiter(env),
    gitlab: resolveWorkersGitlabWebhookRateLimiter(env),
  })
  registerAdminRoutes(cachedApp, {
    secrets: cachedSessionSecrets!,
    runtime: 'workers',
    devSurface: isWorkersDevSurface(env),
  })
  cachedDaemonCellRegistryFactory = (env, db) => createDurableObjectDaemonCellRegistry(env, db)
}

function isWorkersDevSurface(env: CloudflareBindings): boolean {
  const flag = env.TURBOPANEL_DEV_SURFACE?.trim().toLowerCase()
  return flag === '1' || flag === 'true'
}

function stringBindingEnv(env: CloudflareBindings): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value
  }
  // Plain-text dashboard vars are normally strings, but bindings may arrive as
  // numbers/booleans — keep the signup force visible on platformEnv either way.
  const signupForce = normalizeSignupEnvOverride(env.TURBOPANEL_IS_SIGNUP_ENABLED)
  if (signupForce !== undefined) {
    out.TURBOPANEL_IS_SIGNUP_ENABLED = signupForce
  }
  return out
}

export default {
  async fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext) {
    initPromise ??= initWorkerApp(env)
    await initPromise

    const postgresConnectionString =
      env.HYPERDRIVE?.connectionString ?? env.TURBOPANEL_DATABASE_URL?.trim() ?? undefined
    warnIfCachedHyperdriveMissing(env)
    // Fresh clients for this invocation only — close in finally via waitUntil
    // so postgres.js pools cannot stack to the 128 MB isolate limit.
    const dbHandles = openWorkersRequestDb(env)
    const { db, queryCache } = dbHandles
    try {
      const platformEnv = stringBindingEnv(env)
      // Lazy: resolving email settings decrypts the Mailgun/SMTP secret on
      // every call, so it must not run ahead of routing (or the auth rate
      // limiter) for requests that never send email — a webhook flood or an
      // unauthenticated auth probe would otherwise spend that DB read + AES-GCM
      // decrypt before any throttle sees the request. `enqueue()` resolves
      // (and memoizes) the real queue on first use, from the *current*
      // DB/platform env, so admin PUT /settings/email still takes effect
      // without restarting the Worker — same as the eager resolve this
      // replaces, just deferred to the route that actually needs it.
      const emailQueue: EmailQueue = createLazyWorkersEmailQueue(
        db,
        platformEnv,
        cachedDataEncryptionSecrets ?? undefined
      )
      const requestApp = new Hono<AppEnv>()
      requestApp.use('*', async (c, next) => {
        // Session-cookie TLS uses the URL-derived (Workers) path — a spoofed
        // X-Forwarded-Proto must never downgrade the cookie's Secure flag/name.
        c.set('runtime', 'workers')
        if (db) {
          c.set('db', db)
        }
        if (queryCache) {
          c.set('queryCache', queryCache)
        }
        c.set('emailQueue', emailQueue)
        if (cachedCommandQueue) c.set('commandQueue', cachedCommandQueue)
        if (cachedAuthRateLimiter) {
          c.set('authRateLimiter', cachedAuthRateLimiter)
        }
        c.set('platformEnv', platformEnv)
        if (postgresConnectionString) {
          c.set('postgresConnectionString', postgresConnectionString)
        }
        if (cachedDaemonCellRegistryFactory) {
          const registry = cachedDaemonCellRegistryFactory(env, db)
          c.set('daemonCellRegistry', registry)
        }
        if (cachedServerMetricsStoreV4) {
          c.set('serverMetricsStoreV4', cachedServerMetricsStoreV4)
        }
        if (cachedExecutionLogStore) {
          c.set('executionLogStore', cachedExecutionLogStore)
        }
        await next()
      })
      requestApp.route('/', cachedApp!)

      return await requestApp.fetch(request, env, ctx)
    } finally {
      ctx.waitUntil(closeWorkersRequestDb(dbHandles).catch(() => {}))
    }
  },

  async scheduled(controller: ScheduledController, env: CloudflareBindings, ctx: ExecutionContext) {
    initPromise ??= initWorkerApp(env)
    await initPromise
    const sweep = runOfflineSweep(
      env,
      cachedSecretsConfig && cachedDataEncryptionSecrets
        ? {
            secretsConfig: cachedSecretsConfig,
            dataEncryptionSecrets: cachedDataEncryptionSecrets,
          }
        : null,
      {
        // Hosted retention override, resolved at the entry point exactly like
        // deno-server.ts does for the self-hosted path.
        executionLogRetentionDays: parseExecutionLogRetentionDays(
          env.TURBOPANEL_EXECUTION_LOG_RETENTION_DAYS
        ),
        scheduledTime: controller.scheduledTime,
      }
    )
    ctx.waitUntil(sweep)
    await sweep
  },

  async queue(batch: MessageBatch<unknown>, env: CloudflareBindings) {
    initPromise ??= initWorkerApp(env)
    await initPromise

    const db = resolveWorkersDb(env)
    try {
      if (!db || !cachedDaemonCellRegistryFactory) {
        batch.retryAll()
        return
      }

      const registry = cachedDaemonCellRegistryFactory(env, db)

      try {
        for (const msg of batch.messages) {
          try {
            const envelope = parseCommandEnvelope(msg.body)
            await processCommandEnvelope(db, registry, envelope, {
              commandQueue: cachedCommandQueue ?? undefined,
              resealDeps:
                cachedSecretsConfig && cachedDataEncryptionSecrets
                  ? {
                      secretsConfig: cachedSecretsConfig,
                      dataEncryptionSecrets: cachedDataEncryptionSecrets,
                    }
                  : undefined,
              secretsConfig: cachedSecretsConfig ?? undefined,
              dataEncryptionSecrets: cachedDataEncryptionSecrets ?? undefined,
            })
            msg.ack()
          } catch (error) {
            if (isTransientError(error)) {
              msg.retry()
            } else {
              msg.ack()
            }
          }
        }
      } catch {
        batch.retryAll()
      }
    } finally {
      if (db) await endDbConnection(db).catch(() => {})
    }
  },
} satisfies ExportedHandler<CloudflareBindings>
