/**
 * Host-free coverage for admin route short-circuits and wiring branches.
 */

import { assertEquals, assertExists } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
} from '../client/authn/authn-hostfree-doubles.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../client/authn/crypto.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
} from '../client/authn/secrets.ts'
import type { DaemonCell, DaemonCellRegistry, PendingRequestRecord } from '../daemon/cell/contracts.ts'
import { ADMIN_API_PREFIX } from '../surfaces.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import type { Db } from '../db.ts'
import { server } from '../lib/db/schema.ts'
import { registerAdminRoutes } from './routes.ts'
import { registerAdminTierRoutes } from './tier-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type WaitFn = (
  outbound: { requestId: string; at: string; kind: string },
) => Promise<PendingRequestRecord>

function jsonBody<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

function createCell(opts: Readonly<{
  wait?: WaitFn
  purgeError?: unknown
}> = {}): DaemonCell {
  const noopAsync = () => Promise.resolve()
  return {
    attachDaemonSocket: () =>
      Promise.resolve({
        connectionId: 'conn',
        lease: {
          holder: 'conn',
          token: 'conn',
          expiresAt: new Date(Date.now() + 45_000).toISOString(),
        },
      }),
    detachDaemonSocket: noopAsync,
    recordInbound: noopAsync,
    getSnapshot: () =>
      Promise.resolve({
        serverId: 'unused',
        version: 0,
        updatedAt: new Date().toISOString(),
        connected: false,
      }),
    putSnapshot: (patch) =>
      Promise.resolve({
        serverId: 'unused',
        version: 1,
        updatedAt: new Date().toISOString(),
        connected: false,
        ...patch,
      }),
    enqueue: (outbound) =>
      Promise.resolve({
        serverId: 'unused',
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'queued' as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    markSent: noopAsync,
    handleInbound: () => Promise.resolve(null),
    getRequest: () => Promise.resolve(null),
    listRequests: () => Promise.resolve([]),
    waitForRequest: () => Promise.resolve(null),
    createRequestAndWait: (outbound) => {
      if (opts.wait) return opts.wait(outbound)
      return Promise.resolve({
        serverId: 'unused',
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'done' as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
        result: {
          ips: [],
        },
      })
    },
    claimDeliveryLease: () => Promise.resolve(null),
    renewDeliveryLease: () => Promise.resolve(null),
    releaseDeliveryLease: noopAsync,
    readOutboxBatch: () => Promise.resolve([]),
    ackOutbox: noopAsync,
    prune: () => Promise.resolve([]),
    clearUpdateStatus: () => Promise.resolve({ cleared: 0 }),
    purge: () => {
      if (opts.purgeError !== undefined) {
        return Promise.reject(opts.purgeError)
      }
      return Promise.resolve()
    },
  }
}

function createRegistry(opts: Readonly<{
  onlineIds?: string[]
  snapshots?: Map<string, { connected: boolean }>
  wait?: WaitFn
  purgeError?: unknown
  purgeThrows?: unknown
}> = {}): DaemonCellRegistry {
  const cell = createCell({
    ...(opts.wait ? { wait: opts.wait } : {}),
    ...(opts.purgeError !== undefined ? { purgeError: opts.purgeError } : {}),
  })
  return {
    getCell: () => cell,
    listOnlineServerIds: () => Promise.resolve(opts.onlineIds ?? []),
    getSnapshots: (ids) => {
      const out = new Map()
      for (const id of ids) {
        const snap = opts.snapshots?.get(id)
        if (snap) {
          out.set(id, {
            serverId: id,
            version: 1,
            updatedAt: new Date().toISOString(),
            connected: snap.connected,
            lastInboundAt: new Date().toISOString(),
          })
        }
      }
      return Promise.resolve(out)
    },
    purge: async (serverId) => {
      if (opts.purgeThrows !== undefined) throw opts.purgeThrows
      await cell.purge()
      void serverId
    },
  }
}

function wrapDbWithColocatedServer(db: Db, serverId: string): Db {
  const original = db as unknown as {
    select: (...args: unknown[]) => {
      from: (table: unknown) => unknown
    }
  }
  const rows = Promise.resolve([{ id: serverId }])
  return {
    ...original,
    select: (...args: unknown[]) => {
      const chain = original.select(...args)
      return {
        from: (table: unknown) => {
          if (table === server) {
            return {
              where: () => ({
                limit: () => rows,
                then: rows.then.bind(rows),
                catch: rows.catch.bind(rows),
                finally: rows.finally.bind(rows),
              }),
            }
          }
          return chain.from(table)
        },
      }
    },
  } as unknown as Db
}

async function buildApp(opts: Readonly<{
  role?: 'admin' | 'superadmin' | 'user'
  runtime?: 'deno' | 'workers'
  registry?: DaemonCellRegistry | null
  withDb?: boolean
  withDataEncryption?: boolean
  devSurface?: boolean
  getEnv?: () => Record<string, string | undefined>
  colocatedServerId?: string
  commandQueue?: { enqueue: (envelope: unknown) => Promise<void> }
  registerTiers?: boolean
}> = {}) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = opts.withDataEncryption === false
    ? undefined
    : await deriveEncryptionSecretsConfig(secretsConfig, 'data-encryption')

  const token = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `admin-hostfree-${crypto.randomUUID()}@example.com`,
    role: opts.role ?? 'superadmin',
  })
  const rawDb = createMockAuthDb(state)
  const db = opts.colocatedServerId
    ? wrapDbWithColocatedServer(rawDb, opts.colocatedServerId)
    : rawDb
  const signed = await buildSignedCookie(token, secrets)
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (opts.withDb !== false) c.set('db', db)
    if (opts.registry !== null) {
      c.set('daemonCellRegistry', opts.registry ?? createRegistry())
    }
    if (dataEncryptionSecrets) {
      c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    }
    if (opts.commandQueue) {
      c.set('commandQueue', opts.commandQueue)
    }
    return next()
  })
  registerAdminRoutes(app, {
    secrets,
    runtime: opts.runtime ?? 'deno',
    devSurface: opts.devSurface ?? false,
    ...(opts.getEnv ? { getEnv: opts.getEnv } : {}),
    ...(opts.registerTiers
      ? {
        registerTiers: (admin: Hono<AppEnv>) =>
          registerAdminTierRoutes(admin, { secrets }),
      }
      : {}),
  })
  return { app, cookie, secrets }
}

test('admin routes return 401 without a session cookie', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  registerAdminRoutes(app, { secrets, runtime: 'deno', devSurface: false })
  const res = await app.request(`${ADMIN_API_PREFIX}/daemon/events`)
  assertEquals(res.status, 401)
})

test('admin routes return 403 for non-admin session', async () => {
  const { app, cookie } = await buildApp({ role: 'user' })
  const res = await app.request(`${ADMIN_API_PREFIX}/daemon/events`, {
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 403)
})

test('GET /daemon/connections and /daemon/events return empty payloads', async () => {
  const { app, cookie } = await buildApp()
  const connections = await app.request(`${ADMIN_API_PREFIX}/daemon/connections`, {
    headers: { Cookie: cookie },
  })
  assertEquals(connections.status, 200)
  assertEquals(await connections.json(), { connections: [] })

  const events = await app.request(`${ADMIN_API_PREFIX}/daemon/events`, {
    headers: { Cookie: cookie },
  })
  assertEquals(events.status, 200)
  assertEquals(await events.json(), { events: [] })
})

test('GET /daemon/connections returns empty when registry or db is missing', async () => {
  const noRegistry = await buildApp({ registry: null })
  const resNoReg = await noRegistry.app.request(`${ADMIN_API_PREFIX}/daemon/connections`, {
    headers: { Cookie: noRegistry.cookie },
  })
  assertEquals(resNoReg.status, 200)
  assertEquals(await resNoReg.json(), { connections: [] })

  const noDb = await buildApp({ withDb: false })
  const resNoDb = await noDb.app.request(`${ADMIN_API_PREFIX}/daemon/connections`, {
    headers: { Cookie: noDb.cookie },
  })
  assertEquals(resNoDb.status, 401)
})

test('POST /daemon/broadcast validates payload and sends when registry is present', async () => {
  const { app, cookie } = await buildApp({
    registry: createRegistry({ onlineIds: [crypto.randomUUID()] }),
  })
  const bad = await app.request(`${ADMIN_API_PREFIX}/daemon/broadcast`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assertEquals(bad.status, 400)

  const ok = await app.request(`${ADMIN_API_PREFIX}/daemon/broadcast`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ payload: { ping: true } }),
  })
  assertEquals(ok.status, 200)
  const body = await jsonBody<{ ok: boolean; sent: number }>(ok)
  assertEquals(body.ok, true)
  assertEquals(typeof body.sent, 'number')
})

test('POST /daemon/broadcast returns 503 without registry', async () => {
  const { app, cookie } = await buildApp({ registry: null })
  const res = await app.request(`${ADMIN_API_PREFIX}/daemon/broadcast`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ payload: 1 }),
  })
  assertEquals(res.status, 503)
})

test('POST /daemon/:id/send returns 503/400/404 branches', async () => {
  const missing = await buildApp({ registry: null })
  const res503 = await missing.app.request(
    `${ADMIN_API_PREFIX}/daemon/${crypto.randomUUID()}/send`,
    {
      method: 'POST',
      headers: { Cookie: missing.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 1 }),
    },
  )
  assertEquals(res503.status, 503)

  const { app, cookie } = await buildApp()
  const bad = await app.request(`${ADMIN_API_PREFIX}/daemon/${crypto.randomUUID()}/send`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: 'not-json',
  })
  assertEquals(bad.status, 400)

  const notConnected = await app.request(
    `${ADMIN_API_PREFIX}/daemon/${crypto.randomUUID()}/send`,
    {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { hi: 1 } }),
    },
  )
  assertEquals(notConnected.status, 404)
})

test('GET /daemon/commands returns empty without registry', async () => {
  const noRegistry = await buildApp({ registry: null })
  const emptyReg = await noRegistry.app.request(`${ADMIN_API_PREFIX}/daemon/commands`, {
    headers: { Cookie: noRegistry.cookie },
  })
  assertEquals(emptyReg.status, 200)
  assertEquals(await emptyReg.json(), { commands: [] })
})

test('GET /instance/addresses is Deno-only', async () => {
  const workers = await buildApp({ runtime: 'workers' })
  const blocked = await workers.app.request(`${ADMIN_API_PREFIX}/instance/addresses`, {
    headers: { Cookie: workers.cookie },
  })
  assertEquals(blocked.status, 422)
  const blockedBody = await jsonBody<{ ok: boolean }>(blocked)
  assertEquals(blockedBody.ok, false)

  const deno = await buildApp({ runtime: 'deno' })
  const ok = await deno.app.request(`${ADMIN_API_PREFIX}/instance/addresses`, {
    headers: { Cookie: deno.cookie },
  })
  assertEquals(ok.status, 200)
  const body = await jsonBody<{ ok: boolean; source: string; ips: unknown }>(ok)
  assertEquals(body.ok, true)
  assertEquals(body.source, 'instance')
  assertExists(body.ips)
})

test('GET/PUT /instance/public-urls handle missing db and validation', async () => {
  const { app, cookie } = await buildApp()
  const get = await app.request(`${ADMIN_API_PREFIX}/instance/public-urls`, {
    headers: { Cookie: cookie },
  })
  assertEquals(get.status, 200)
  assertEquals(await get.json(), { ok: true, urls: [] })

  const missingUrls = await app.request(`${ADMIN_API_PREFIX}/instance/public-urls`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assertEquals(missingUrls.status, 400)

  const badTypes = await app.request(`${ADMIN_API_PREFIX}/instance/public-urls`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ urls: [1, 2] }),
  })
  assertEquals(badTypes.status, 400)

  const saved = await app.request(`${ADMIN_API_PREFIX}/instance/public-urls`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ urls: ['https://admin.example.com'] }),
  })
  assertEquals(saved.status, 200)
})

test('GET/PUT /settings/email cover db/validation/encryption branches', async () => {
  const { app, cookie } = await buildApp()
  const get = await app.request(`${ADMIN_API_PREFIX}/settings/email`, {
    headers: { Cookie: cookie },
  })
  assertEquals(get.status, 200)
  const getBody = await jsonBody<{ settings: unknown }>(get)
  assertExists(getBody.settings)

  const bad = await app.request(`${ADMIN_API_PREFIX}/settings/email`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: 'null',
  })
  assertEquals(bad.status, 400)

  const put = await app.request(`${ADMIN_API_PREFIX}/settings/email`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ FROM: 'ops@example.com' }),
  })
  assertEquals(put.status, 200)

  const noEnc = await buildApp({ withDataEncryption: false })
  const secretWrite = await noEnc.app.request(`${ADMIN_API_PREFIX}/settings/email`, {
    method: 'PUT',
    headers: { Cookie: noEnc.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ SMTP_PASS: 's3cret' }),
  })
  assertEquals(secretWrite.status, 503)
})

test('PUT /settings/signup rejects invalid bodies', async () => {
  const { app, cookie } = await buildApp()
  const res = await app.request(`${ADMIN_API_PREFIX}/settings/signup`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: 'yes' }),
  })
  assertEquals(res.status, 400)
})

test('POST /instance/public-urls/apply covers workers and short-circuit branches', async () => {
  const workers = await buildApp({ runtime: 'workers' })
  const workersRes = await workers.app.request(
    `${ADMIN_API_PREFIX}/instance/public-urls/apply`,
    {
      method: 'POST',
      headers: { Cookie: workers.cookie, 'content-type': 'application/json' },
      body: '{}',
    },
  )
  assertEquals(workersRes.status, 422)

  const noRegistry = await buildApp({ registry: null })
  const noRegRes = await noRegistry.app.request(
    `${ADMIN_API_PREFIX}/instance/public-urls/apply`,
    {
      method: 'POST',
      headers: { Cookie: noRegistry.cookie, 'content-type': 'application/json' },
      body: '{}',
    },
  )
  assertEquals(noRegRes.status, 503)

  const { app, cookie } = await buildApp()
  const noColocated = await app.request(`${ADMIN_API_PREFIX}/instance/public-urls/apply`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: '{}',
  })
  assertEquals(noColocated.status, 503)

  const badBody = await app.request(`${ADMIN_API_PREFIX}/instance/public-urls/apply`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ urls: [1] }),
  })
  assertEquals(badBody.status, 400)
})

test('POST /instance/public-urls/apply returns 200 and fans out via commandQueue', async () => {
  const serverId = crypto.randomUUID()
  const { app, cookie } = await buildApp({
    colocatedServerId: serverId,
    registry: createRegistry({
      snapshots: new Map([[serverId, { connected: true }]]),
    }),
    commandQueue: {
      enqueue: () => Promise.resolve(),
    },
  })
  const res = await app.request(`${ADMIN_API_PREFIX}/instance/public-urls/apply`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: '{}',
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true, applied: true })
})

test('GET /daemon/addresses returns empty fleet list', async () => {
  const { app, cookie } = await buildApp()
  const res = await app.request(`${ADMIN_API_PREFIX}/daemon/addresses`, {
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { servers: [] })
})

test('GET /daemon/:id/addresses returns 503/404 without live presence', async () => {
  const noRegistry = await buildApp({ registry: null })
  const res503 = await noRegistry.app.request(
    `${ADMIN_API_PREFIX}/daemon/${crypto.randomUUID()}/addresses`,
    { headers: { Cookie: noRegistry.cookie } },
  )
  assertEquals(res503.status, 503)

  const { app, cookie } = await buildApp()
  const res404 = await app.request(
    `${ADMIN_API_PREFIX}/daemon/${crypto.randomUUID()}/addresses`,
    { headers: { Cookie: cookie } },
  )
  assertEquals(res404.status, 404)
})

test('POST /cells/purge-batch validates body and returns 503 without registry', async () => {
  const noRegistry = await buildApp({ registry: null })
  const res503 = await noRegistry.app.request(`${ADMIN_API_PREFIX}/cells/purge-batch`, {
    method: 'POST',
    headers: { Cookie: noRegistry.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ serverIds: [crypto.randomUUID()] }),
  })
  assertEquals(res503.status, 503)

  const { app, cookie } = await buildApp()
  const bad = await app.request(`${ADMIN_API_PREFIX}/cells/purge-batch`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assertEquals(bad.status, 400)
})

test('POST /cells/:serverId/purge returns 503/500 branches', async () => {
  const noRegistry = await buildApp({ registry: null })
  const res503 = await noRegistry.app.request(
    `${ADMIN_API_PREFIX}/cells/${crypto.randomUUID()}/purge`,
    { method: 'POST', headers: { Cookie: noRegistry.cookie } },
  )
  assertEquals(res503.status, 503)

  const failing = await buildApp({
    registry: createRegistry({ purgeError: new Error('boom') }),
  })
  const res500 = await failing.app.request(
    `${ADMIN_API_PREFIX}/cells/${crypto.randomUUID()}/purge`,
    { method: 'POST', headers: { Cookie: failing.cookie } },
  )
  assertEquals(res500.status, 500)
  const body = await jsonBody<{ ok: boolean; error: string }>(res500)
  assertEquals(body.ok, false)
  assertEquals(body.error, 'boom')

  const nonError = await buildApp({
    registry: createRegistry({ purgeError: 'string-boom' }),
  })
  const resStr = await nonError.app.request(
    `${ADMIN_API_PREFIX}/cells/${crypto.randomUUID()}/purge`,
    { method: 'POST', headers: { Cookie: nonError.cookie } },
  )
  assertEquals(resStr.status, 500)
})

test('devSurface OpenAPI and Scalar routes are registered', async () => {
  const { app, cookie } = await buildApp({ devSurface: true })
  const openapi = await app.request(`${ADMIN_API_PREFIX}/openapi.json`, {
    headers: { Cookie: cookie },
  })
  assertEquals(openapi.status, 200)
  const spec = await jsonBody<{ openapi: string }>(openapi)
  assertEquals(typeof spec.openapi, 'string')

  const reference = await app.request(`${ADMIN_API_PREFIX}/reference`, {
    headers: { Cookie: cookie },
  })
  assertEquals(reference.status, 200)
  const html = await reference.text()
  assertEquals(html.includes('scalar'), true)
})

test('the tier catalogue is mounted on Workers only: self-hosted has no billing', async () => {
  const deno = await buildApp({ runtime: 'deno' })
  const absent = await deno.app.request(`${ADMIN_API_PREFIX}/tiers`, {
    headers: { Cookie: deno.cookie },
  })
  assertEquals(absent.status, 404)

  // Shared registrar is billing-free: Workers runtime alone does not import
  // or mount the catalogue. The Workers entry passes registerTiers.
  const workersBare = await buildApp({ runtime: 'workers' })
  const unmounted = await workersBare.app.request(`${ADMIN_API_PREFIX}/tiers`, {
    headers: { Cookie: workersBare.cookie },
  })
  assertEquals(unmounted.status, 404)

  // Mounted on Workers; with no billingConfig on the context it is the
  // route's own 503, not the aggregator's 404.
  const workers = await buildApp({ runtime: 'workers', registerTiers: true })
  const mounted = await workers.app.request(`${ADMIN_API_PREFIX}/tiers`, {
    headers: { Cookie: workers.cookie },
  })
  assertEquals(mounted.status, 503)
})

test('instance-wide forge collection routes are reachable for an admin session', async () => {
  const { app, cookie } = await buildApp()
  const headers = { Cookie: cookie, 'content-type': 'application/json' }
  const list = await app.request(`${ADMIN_API_PREFIX}/forges`, { headers })
  assertEquals(typeof list.status, 'number')

  const create = await app.request(`${ADMIN_API_PREFIX}/forges`, {
    method: 'POST',
    headers,
    body: '{}',
  })
  assertEquals(typeof create.status, 'number')

  const manifest = await app.request(`${ADMIN_API_PREFIX}/forges/github/manifest`, {
    method: 'POST',
    headers,
    body: '{}',
  })
  assertEquals(typeof manifest.status, 'number')

  const callback = await app.request(
    `${ADMIN_API_PREFIX}/forges/github/manifest/callback`,
    { headers: { Cookie: cookie } },
  )
  assertEquals(typeof callback.status, 'number')

  const id = crypto.randomUUID()
  const sync = await app.request(`${ADMIN_API_PREFIX}/forges/${id}/sync`, {
    method: 'POST',
    headers,
    body: '{}',
  })
  assertEquals(typeof sync.status, 'number')

  const get = await app.request(`${ADMIN_API_PREFIX}/forges/${id}`, {
    headers: { Cookie: cookie },
  })
  assertEquals(typeof get.status, 'number')

  const patch = await app.request(`${ADMIN_API_PREFIX}/forges/${id}`, {
    method: 'PATCH',
    headers,
    body: '{}',
  })
  assertEquals(typeof patch.status, 'number')

  const del = await app.request(`${ADMIN_API_PREFIX}/forges/${id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  })
  assertEquals(typeof del.status, 'number')
})
