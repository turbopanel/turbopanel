import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import { type AppEnv, createApp } from './app.ts'
import { HEALTH_PATH } from './surfaces.ts'
import type { AuthRateLimiter } from './client/authn/auth-rate-limit.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './client/authn/secrets.ts'
import { parseTestSecretsConfig, TEST_ONLY_TURBOPANEL_SECRET } from './test-fixtures/secrets.ts'
import type { Db } from './db.ts'
import { registerDaemonApiRoutes } from './daemon/api-routes.ts'
import { deriveDaemonJwtKeyring } from './daemon/authn/daemon-jwt-keyring.ts'
import { issueDaemonJwt } from './daemon/authn/daemon-jwt.ts'
import { METRICS_SCHEMA_VERSION_V5 } from './daemon/metrics/contract-v5.ts'
import type {
  AuthenticatedMetricsSampleV5,
  ServerMetricsStoreV5,
} from './daemon/metrics/types-v5.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const FAKE_DB = { tag: 'db' } as unknown as Db

async function secretsBundle() {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'workers')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const otpVerifierSecrets = await deriveSecretsConfig(secretsConfig, 'email-otp-verifier')
  return { secrets, otpVerifierSecrets }
}

test('createApp serves root text and health JSON', async () => {
  const app = createApp({ signupEnvOverride: undefined })
  const root = await app.request('https://panel.example.com/')
  assertEquals(await root.text(), 'TurboPanel')

  const health = await app.request(`https://panel.example.com${HEALTH_PATH}`)
  assertEquals(health.status, 200)
  const body = (await health.json()) as {
    ok: boolean
    license: string
    revision: { commit: string; sourceUrl: string }
  }
  assertEquals(body.ok, true)
  assertEquals(body.license, 'AGPL-3.0-only')
  assertEquals(typeof body.revision.commit, 'string')
  assertEquals(typeof body.revision.sourceUrl, 'string')
})

test('createApp injects runtime and optional dependencies into context', async () => {
  const { secrets, otpVerifierSecrets } = await secretsBundle()
  const authRateLimiter: AuthRateLimiter = {
    check: () => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
    reset: () => undefined,
  }
  const emailQueue = { enqueue: () => Promise.resolve() }
  const commandQueue = { enqueue: () => Promise.resolve() }

  const app = createApp({
    db: FAKE_DB,
    emailQueue,
    commandQueue,
    emailFrom: 'noreply@example.com',
    baseUrl: 'https://panel.example.com',
    secrets,
    otpVerifierSecrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
    authRateLimiter,
    dataEncryptionSecrets: secrets,
    secretsConfig: parseTestSecretsConfig('deno'),
  })

  app.get('/probe', (c: Context<AppEnv>) =>
    c.json({
      runtime: c.get('runtime'),
      hasDb: c.get('db') === FAKE_DB,
      emailFrom: c.get('emailFrom'),
      baseUrl: c.get('baseUrl'),
      hasEmailQueue: c.get('emailQueue') === emailQueue,
      hasCommandQueue: c.get('commandQueue') === commandQueue,
      hasAuthLimiter: c.get('authRateLimiter') === authRateLimiter,
      hasDataSecrets: c.get('dataEncryptionSecrets') === secrets,
      hasSecretsConfig: c.get('secretsConfig') !== undefined,
    })
  )

  const res = await app.request('https://panel.example.com/probe')
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    runtime: 'deno',
    hasDb: true,
    emailFrom: 'noreply@example.com',
    baseUrl: 'https://panel.example.com',
    hasEmailQueue: true,
    hasCommandQueue: true,
    hasAuthLimiter: true,
    hasDataSecrets: true,
    hasSecretsConfig: true,
  })
})

test('createApp health reports TURBOPANEL_REVISION from platformEnv', async () => {
  const commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const app = createApp({
    signupEnvOverride: undefined,
    runtime: 'deno',
    platformEnv: { TURBOPANEL_REVISION: commit },
  })
  const health = await app.request(`https://panel.example.com${HEALTH_PATH}`)
  assertEquals(health.status, 200)
  const body = (await health.json()) as {
    ok: boolean
    license: string
    revision: { commit: string; sourceUrl: string }
  }
  assertEquals(body.ok, true)
  assertEquals(body.revision.commit, commit)
  assertEquals(body.revision.sourceUrl, `https://github.com/TurboPanel/turbopanel/tree/${commit}`)
})

test('createApp wires serverMetricsStoreV5 through to POST /api/daemon/v1/metrics', async () => {
  const daemonJwtKeyring = await deriveDaemonJwtKeyring({
    versioned: [
      {
        version: 1,
        value: 'app_test_daemon_jwt_keyring_secret_value',
      },
    ],
  })
  const writes: AuthenticatedMetricsSampleV5[] = []
  const serverMetricsStoreV5: ServerMetricsStoreV5 = {
    writeSample(sample) {
      writes.push(sample)
    },
    writeStatusEvent() {
      // no-op
    },
  }

  // Real bootstrap wiring: createApp() sets `serverMetricsStoreV5` on the
  // Hono context the same way `deno-server.ts` / `workers.ts` do, then
  // `registerDaemonApiRoutes` (also mounted by both entrypoints) is layered
  // on top — no `c.set("serverMetricsStoreV5", ...)` in this test itself.
  const app = createApp({
    signupEnvOverride: undefined,
    runtime: 'deno',
    serverMetricsStoreV5,
  })
  registerDaemonApiRoutes(app, { secrets: daemonJwtKeyring })

  const serverId = 'srv-app-createapp-metrics'
  const issued = await issueDaemonJwt(
    { sub: serverId, kid: 'key-createapp-metrics' },
    daemonJwtKeyring
  )

  const response = await app.request('https://panel.example.com/api/daemon/v1/metrics', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${issued.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'metrics',
      metadata: {
        version: METRICS_SCHEMA_VERSION_V5,
        sampledAt: new Date().toISOString(),
        intervalSeconds: 60,
        sequence: 1,
        collectionMode: 'baseline',
        topologyGeneration: 0,
        bootGeneration: 0,
      },
      host: { cpu: {}, kernel: {}, memory: {}, storage: {}, network: {} },
      networks: [],
      filesystems: [],
      blockDevices: [],
      gpus: [],
      hardwareSignals: [],
      ingressSources: [],
      databaseProxies: [],
      events: [],
    }),
  })

  assertEquals(response.status, 202)
  assertEquals(writes.length, 1)
  assertEquals(writes[0]?.serverId, serverId)
})

test('createApp defaults runtime to workers when omitted', async () => {
  const app = createApp({ signupEnvOverride: undefined })
  app.get('/runtime', (c: Context<AppEnv>) => c.text(c.get('runtime') ?? 'missing'))
  const res = await app.request('https://panel.example.com/runtime')
  assertEquals(await res.text(), 'workers')
})
