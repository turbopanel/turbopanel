/**
 * Host-free coverage for server route registration and Hono short-circuits
 * (401 / 403 / 404 / validation) — no Postgres.
 */

import { assertEquals, assertThrows } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { DaemonCell, DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import type { Db } from '../../db.ts'
import { seedTrunkManifestCacheForTests } from '../../lib/update/manifest.ts'
import { server } from '../../lib/db/schema.ts'
import type { QueryCache } from '../../query-cache/contracts.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from '../authn/authn-hostfree-doubles.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { deriveSecretsConfig } from '../authn/secrets.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { colocatedServerDeleteBlockedReason } from './delete-guards.ts'
import { registerServerLabelRoutes } from './labels-routes.ts'
import { emptyServersUpdatesPayload } from './routes-helpers.ts'
import { registerServerRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'

const SERVER_PATHS = [
  ['GET', '/servers'],
  ['GET', '/servers/updates'],
  ['POST', '/servers/updates'],
  ['GET', '/servers/status'],
  ['GET', `/servers/${SERVER_ID}`],
  ['PATCH', `/servers/${SERVER_ID}`],
  ['DELETE', `/servers/${SERVER_ID}`],
  ['GET', `/servers/${SERVER_ID}/status`],
  ['GET', `/servers/${SERVER_ID}/cell`],
  ['GET', `/servers/${SERVER_ID}/update`],
  ['POST', `/servers/${SERVER_ID}/update`],
  ['POST', `/servers/${SERVER_ID}/update/reset`],
  ['GET', `/servers/${SERVER_ID}/labels`],
  ['PUT', `/servers/${SERVER_ID}/labels`],
] as const

const ORG_SCOPED_PATHS = [
  ['GET', '/servers'],
  ['GET', '/servers/updates'],
  ['POST', '/servers/updates'],
  ['GET', '/servers/status'],
  ['GET', `/servers/${SERVER_ID}`],
  ['PATCH', `/servers/${SERVER_ID}`],
  ['DELETE', `/servers/${SERVER_ID}`],
] as const

type SessionRole = 'superadmin' | 'admin' | 'user'

type CachedReadModelOpts = {
  readModel?: string
  load?: (db: unknown) => Promise<unknown>
}

type SessionAppOpts = {
  role?: SessionRole
  executeQueue?: unknown[][]
  defaultAllowed?: boolean
  withServerRow?: boolean
  serverOptions?: Record<string, unknown>
  registry?: DaemonCellRegistry
  queryCache?: { getReadModel: (opts: CachedReadModelOpts) => Promise<unknown> }
}

function stubRegistry(): DaemonCellRegistry {
  const cell = {
    getSnapshot: () =>
      Promise.resolve({
        serverId: '',
        version: 0,
        updatedAt: new Date().toISOString(),
        connected: false,
      }),
    clearUpdateStatus: () => Promise.reject(new Error('update in progress')),
    purge: () => Promise.resolve(),
    enqueue: () => Promise.resolve({
      serverId: SERVER_ID,
      requestId: 'req',
      requestKind: 'update',
      status: 'queued' as const,
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    }),
  } as unknown as DaemonCell
  return {
    getCell: () => cell,
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  }
}

function cachedServerRow() {
  return {
    id: SERVER_ID,
    name: 'edge',
    organizationId: ORG_ID,
    licenseId: null,
    options: {},
    createdAt: '2024-01-01T00:00:00.000Z',
  }
}

/**
 * A cached row that still carries the pre-`monitor`-table sealed ProxySQL
 * password on `server.options`. The read model strips it before caching, but a
 * cache entry written by an older control plane can still hold one — the route
 * must refuse to serve it either way.
 */
function cachedServerRowWithLegacyMonitorSecret() {
  return {
    ...cachedServerRow(),
    options: {
      timezone: 'UTC',
      managedMonitor: {
        username: 'tp_monitor_0123456789ab',
        passwordSealed: 'tpsecret.v1.deadbeef',
      },
    },
  }
}

function serverRowSelect(options: Record<string, unknown> = {}) {
  const row = { id: SERVER_ID, options }
  return {
    where: () => {
      const promise = Promise.resolve([row])
      return Object.assign(promise, {
        limit: () => Promise.resolve([row]),
        orderBy: () => Promise.resolve([row]),
      })
    },
    // Chainable: `loadServerLicenseTierJoins` walks
    // `server ⟕ organization ⟕ license ⟕ tier`, so a join must return
    // something that can be joined again. These routes never read the
    // placement rows from this stub, so every chain resolves empty.
    leftJoin: function leftJoin(): Record<string, unknown> {
      return {
        leftJoin,
        where: () =>
          Object.assign(Promise.resolve([]), {
            limit: () => Promise.resolve([]),
            orderBy: () => Promise.resolve([]),
          }),
      }
    },
  }
}

async function buildApp(db: Db | undefined): Promise<Hono<AppEnv>> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (db) c.set('db', db)
    return next()
  })
  registerServerRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  return app
}

async function buildSessionApp(
  opts: SessionAppOpts = {},
): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const role = opts.role ?? 'superadmin'
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `srv-authz-${crypto.randomUUID()}@example.com`,
    role,
  })
  seedMockUser(state, {
    id: userId,
    email: `srv-authz-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role,
  })
  state.organizations.push({ id: ORG_ID, name: 'Server Org' })

  const executeQueue = [...(opts.executeQueue ?? [])]
  const authDb = createMockAuthDb(state)
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown }
    }
  ).select.bind(authDb)

  const db = Object.assign(authDb, {
    execute: () => {
      if (executeQueue.length > 0) {
        return Promise.resolve(executeQueue.shift() ?? [])
      }
      return Promise.resolve([{ allowed: opts.defaultAllowed ?? true }])
    },
    ...(opts.withServerRow
      ? {
        select: (fields?: unknown) => ({
          from: (table: unknown) => {
            if (table === server) return serverRowSelect(opts.serverOptions)
            return origSelect(fields).from(table)
          },
        }),
      }
      : {}),
  }) as unknown as Db

  const signed = await buildSignedCookie(token, secrets)
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (opts.registry) c.set('daemonCellRegistry', opts.registry)
    if (opts.queryCache) {
      c.set('queryCache', opts.queryCache as unknown as QueryCache)
    }
    return next()
  })
  registerServerRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  return { app, cookie }
}

function sessionHeaders(
  cookie: string,
  extras?: Record<string, string>,
): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: ORG_ID,
    ...extras,
  }
}

async function expectJson(
  response: Response,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  assertEquals(response.status, status)
  assertEquals(await response.json(), body)
}

test('registerServerLabelRoutes requires session secrets', () => {
  const app = new Hono<AppEnv>()
  assertThrows(
    () =>
      registerServerLabelRoutes(app, {
        secrets: undefined as never,
        runtime: 'deno',
        signupEnvOverride: undefined,
      }),
    TypeError,
    'session secrets are required for server label routes',
  )
})

test('registerServerRoutes requires session secrets', () => {
  const app = new Hono<AppEnv>()
  assertThrows(
    () =>
      registerServerRoutes(app, {
        secrets: undefined as never,
        runtime: 'deno',
        signupEnvOverride: undefined,
      }),
    TypeError,
    'session secrets are required for server routes',
  )
})

test('server routes return 401 without a session cookie', async () => {
  const app = await buildApp({} as Db)
  for (const [method, path] of SERVER_PATHS) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE'
        ? undefined
        : JSON.stringify({}),
    })
    assertEquals(res.status, 401, `${method} ${path}`)
    assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
  }
})

test('org-scoped server routes return 400 when organizationId is missing', async () => {
  const { app, cookie } = await buildSessionApp()
  for (const [method, path] of ORG_SCOPED_PATHS) {
    const res = await app.request(path, {
      method,
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE'
        ? undefined
        : JSON.stringify({ name: 'edge' }),
    })
    assertEquals(res.status, 400, `${method} ${path}`)
    assertEquals(await res.json(), { error: 'organizationId required' })
  }
})

test('org-scoped server routes return 400 for an invalid organizationId', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request('/servers', {
    headers: { Cookie: cookie, [ORG_ID_HEADER]: 'not-a-uuid' },
  })
  await expectJson(res, 400, { error: 'Invalid organizationId' })
})

test('org-scoped server routes return 403 when the org is not accessible', async () => {
  const { app, cookie } = await buildSessionApp({
    role: 'user',
    executeQueue: [[{ allowed: false }], [{ allowed: false }]],
  })
  const res = await app.request('/servers', {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 403, { error: 'Forbidden' })
})

test('GET /servers returns an empty list when nothing is visible', async () => {
  const { app, cookie } = await buildSessionApp({ executeQueue: [[]] })
  const res = await app.request('/servers', {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 200, { servers: [] })
})

test('GET /servers returns 503 when the list read model throws', async () => {
  const { app, cookie } = await buildSessionApp({
    executeQueue: [[{ item_id: SERVER_ID }]],
    queryCache: {
      getReadModel: () => Promise.reject(new Error('cache failed')),
    },
  })
  const res = await app.request('/servers', {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 503, { error: 'Database unavailable' })
})

test('GET /servers maps a cached visible row without datacenter pins', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    executeQueue: [[{ item_id: SERVER_ID }]],
    queryCache: {
      getReadModel: (opts) => {
        if (opts.readModel === 'servers-list') {
          return Promise.resolve([cachedServerRow()])
        }
        return Promise.resolve([])
      },
    },
  })
  const res = await app.request('/servers', {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 200)
  const body = await res.json() as {
    servers: Array<{ id: string; licenseId: null; datacenters: unknown[] }>
  }
  if (!Array.isArray(body.servers)) {
    throw new TypeError('expected servers list')
  }
  assertEquals(body.servers[0]?.id, SERVER_ID)
  assertEquals(body.servers[0]?.licenseId, null)
  assertEquals(body.servers[0]?.datacenters, [])
})

test('GET /servers/updates returns the empty payload when nothing is visible', async () => {
  const { app, cookie } = await buildSessionApp({ executeQueue: [[]] })
  const res = await app.request('/servers/updates', {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 200, emptyServersUpdatesPayload())
})

test('GET /servers/updates returns idle rows for visible offline servers', async () => {
  seedTrunkManifestCacheForTests(null)
  const { app, cookie } = await buildSessionApp({
    executeQueue: [[{ item_id: SERVER_ID }]],
    registry: stubRegistry(),
  })
  const res = await app.request('/servers/updates', {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 200)
  const body = await res.json() as {
    ok: boolean
    servers: Array<{ serverId: string; status: string }>
  }
  if (!body.ok) throw new TypeError('expected ok updates payload')
  assertEquals(body.servers[0]?.serverId, SERVER_ID)
  assertEquals(typeof body.servers[0]?.status, 'string')
})

test('POST /servers/updates returns 503 when the daemon cell registry is missing', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request('/servers/updates', {
    method: 'POST',
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 503, { error: 'Daemon cell registry unavailable' })
})

test('POST /servers/updates reports Forbidden when manage is denied', async () => {
  seedTrunkManifestCacheForTests(null)
  const { app, cookie } = await buildSessionApp({
    registry: stubRegistry(),
    // listVisible, then the self-host environment pin (no rows: this server
    // does not run the control plane), then the per-server manage check.
    executeQueue: [[{ item_id: SERVER_ID }], [], [{ allowed: false }]],
  })
  const res = await app.request('/servers/updates', {
    method: 'POST',
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: false,
    results: [{ serverId: SERVER_ID, ok: false, error: 'Forbidden' }],
  })
})

test('POST /servers/updates reports Daemon not connected when the host is offline', async () => {
  seedTrunkManifestCacheForTests(null)
  const { app, cookie } = await buildSessionApp({
    registry: stubRegistry(),
    // listVisible, self-host pin (no rows), then the per-server manage check.
    executeQueue: [[{ item_id: SERVER_ID }], [], [{ allowed: true }]],
  })
  const res = await app.request('/servers/updates', {
    method: 'POST',
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: false,
    results: [{
      serverId: SERVER_ID,
      ok: false,
      error: 'Daemon not connected',
    }],
  })
})

test('GET /servers/status returns an empty batch when nothing is visible', async () => {
  const { app, cookie } = await buildSessionApp({ executeQueue: [[]] })
  const res = await app.request('/servers/status', {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 200)
  assertEquals(res.headers.get('Cache-Control'), 'private, max-age=5')
  assertEquals(await res.json(), { servers: [] })
})

test('GET /servers/status coalesces a second request onto the cached payload', async () => {
  const { app, cookie } = await buildSessionApp({ executeQueue: [[], []] })
  const headers = sessionHeaders(cookie)
  const first = await app.request('/servers/status', { headers })
  const second = await app.request('/servers/status', { headers })
  assertEquals(first.status, 200)
  assertEquals(second.status, 200)
  assertEquals(await first.json(), { servers: [] })
  assertEquals(await second.json(), { servers: [] })
})

test('GET /servers/:id/update returns idle status without a live daemon', async () => {
  seedTrunkManifestCacheForTests(null)
  const { app, cookie } = await buildSessionApp({
    defaultAllowed: true,
    registry: stubRegistry(),
  })
  const res = await app.request(`/servers/${SERVER_ID}/update`, {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 200)
  const body = await res.json() as {
    ok: boolean
    serverId: string
    status: string
    colocatedWithInstance: boolean
  }
  if (!body.ok) throw new TypeError('expected ok update status')
  assertEquals(body.serverId, SERVER_ID)
  assertEquals(body.colocatedWithInstance, false)
  assertEquals(typeof body.status, 'string')
})

test('GET /servers/:id/status returns 403 when read is denied', async () => {
  const { app, cookie } = await buildSessionApp({ defaultAllowed: false })
  const res = await app.request(`/servers/${SERVER_ID}/status`, {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 403, { error: 'Forbidden' })
})

test('GET /servers/:id/status returns 404 when no status record exists', async () => {
  const { app, cookie } = await buildSessionApp({ defaultAllowed: true })
  const res = await app.request(`/servers/${SERVER_ID}/status`, {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 404, { error: 'Not found' })
})

test('GET /servers/:id/cell returns 403 for a non-admin session', async () => {
  const { app, cookie } = await buildSessionApp({ role: 'user' })
  const res = await app.request(`/servers/${SERVER_ID}/cell`, {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 403, { error: 'Forbidden' })
})

test('GET /servers/:id/cell returns 503 when the registry is missing', async () => {
  const { app, cookie } = await buildSessionApp({
    role: 'admin',
    defaultAllowed: true,
  })
  const res = await app.request(`/servers/${SERVER_ID}/cell`, {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 503, { error: 'Daemon cell registry unavailable' })
})

test('GET /servers/:id/cell returns 404 when the snapshot has no serverId', async () => {
  const { app, cookie } = await buildSessionApp({
    role: 'admin',
    defaultAllowed: true,
    registry: stubRegistry(),
  })
  const res = await app.request(`/servers/${SERVER_ID}/cell`, {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 404, { error: 'server not found' })
})

test('POST /servers/:id/update returns 403 when manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({ defaultAllowed: false })
  const res = await app.request(`/servers/${SERVER_ID}/update`, {
    method: 'POST',
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 403, { error: 'Forbidden' })
})

test('POST /servers/:id/update returns 503 when the registry is missing', async () => {
  const { app, cookie } = await buildSessionApp({ defaultAllowed: true })
  const res = await app.request(`/servers/${SERVER_ID}/update`, {
    method: 'POST',
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 503, { error: 'Daemon cell registry unavailable' })
})

test('POST /servers/:id/update returns 404 when the daemon is offline', async () => {
  seedTrunkManifestCacheForTests(null)
  const { app, cookie } = await buildSessionApp({
    defaultAllowed: true,
    registry: stubRegistry(),
  })
  const res = await app.request(`/servers/${SERVER_ID}/update`, {
    method: 'POST',
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 404, { ok: false, error: 'Daemon not connected' })
})

test('POST /servers/:id/update/reset returns 403 when manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({ defaultAllowed: false })
  const res = await app.request(`/servers/${SERVER_ID}/update/reset`, {
    method: 'POST',
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 403, { error: 'Forbidden' })
})

test('POST /servers/:id/update/reset returns 503 when the registry is missing', async () => {
  const { app, cookie } = await buildSessionApp({ defaultAllowed: true })
  const res = await app.request(`/servers/${SERVER_ID}/update/reset`, {
    method: 'POST',
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 503, { error: 'Daemon cell registry unavailable' })
})

test('POST /servers/:id/update/reset maps update-in-progress to 409', async () => {
  seedTrunkManifestCacheForTests(null)
  const { app, cookie } = await buildSessionApp({
    defaultAllowed: true,
    registry: stubRegistry(),
  })
  const res = await app.request(`/servers/${SERVER_ID}/update/reset`, {
    method: 'POST',
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 409, { ok: false, error: 'update in progress' })
})

test('GET /servers/:id returns 404 when the server is outside the org', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request(`/servers/${SERVER_ID}`, {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 404, { error: 'Not found' })
})

test('GET /servers/:id returns 503 when the detail read model throws', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    defaultAllowed: true,
    queryCache: {
      getReadModel: () => Promise.reject(new Error('cache failed')),
    },
  })
  const res = await app.request(`/servers/${SERVER_ID}`, {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 503, { error: 'Database unavailable' })
})

test('GET /servers/:id returns 404 when the cached detail row is missing', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    defaultAllowed: true,
  })
  const res = await app.request(`/servers/${SERVER_ID}`, {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 404, { error: 'Not found' })
})

test('GET /servers/:id returns the mapped detail payload for a cached row', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    defaultAllowed: true,
    queryCache: {
      getReadModel: (opts) => {
        if (opts.readModel === 'server-detail') {
          return Promise.resolve(cachedServerRow())
        }
        return Promise.resolve(null)
      },
    },
  })
  const res = await app.request(`/servers/${SERVER_ID}`, {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 200)
  const body = await res.json() as {
    ok: boolean
    server: {
      id: string
      labels: unknown[]
      datacenters: unknown[]
      licenseId: null
    }
  }
  if (!body.ok) throw new TypeError('expected ok server detail')
  assertEquals(body.server.id, SERVER_ID)
  assertEquals(body.server.labels, [])
  assertEquals(body.server.datacenters, [])
  assertEquals(body.server.licenseId, null)
})

test('PATCH /servers/:id returns 404 when the server is missing', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request(`/servers/${SERVER_ID}`, {
    method: 'PATCH',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'edge-1' }),
  })
  await expectJson(res, 404, { error: 'Not found' })
})

test('PATCH /servers/:id returns 403 when manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    defaultAllowed: false,
  })
  const res = await app.request(`/servers/${SERVER_ID}`, {
    method: 'PATCH',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'edge-1' }),
  })
  await expectJson(res, 403, { error: 'Forbidden' })
})

test('PATCH /servers/:id returns 400 for empty, invalid JSON, and datacenterId', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    defaultAllowed: true,
  })
  const headers = {
    ...sessionHeaders(cookie),
    'content-type': 'application/json',
  }

  const empty = await app.request(`/servers/${SERVER_ID}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({}),
  })
  await expectJson(empty, 400, { error: 'Invalid request' })

  const badJson = await app.request(`/servers/${SERVER_ID}`, {
    method: 'PATCH',
    headers,
    body: '{',
  })
  await expectJson(badJson, 400, { error: 'Invalid request' })

  const datacenter = await app.request(`/servers/${SERVER_ID}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ datacenterId: SERVER_ID }),
  })
  await expectJson(datacenter, 400, { error: 'Invalid request' })

  const badName = await app.request(`/servers/${SERVER_ID}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ name: '' }),
  })
  await expectJson(badName, 400, { error: 'Invalid request' })

  const badSsh = await app.request(`/servers/${SERVER_ID}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ options: { sshPort: 0 } }),
  })
  await expectJson(badSsh, 400, { error: 'Invalid sshPort' })

  const badNtp = await app.request(`/servers/${SERVER_ID}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ options: { ntp: 'nope' } }),
  })
  await expectJson(badNtp, 400, { error: 'Invalid ntp' })
})

test('PATCH /servers/:id returns 200 for a name-only update', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    defaultAllowed: true,
  })
  const res = await app.request(`/servers/${SERVER_ID}`, {
    method: 'PATCH',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'edge-1' }),
  })
  await expectJson(res, 200, { ok: true })
})

test('PATCH /servers/:id returns 500 when hosting-enable hierarchy fails', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    defaultAllowed: true,
  })
  const res = await app.request(`/servers/${SERVER_ID}`, {
    method: 'PATCH',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ options: { hosting: { enabled: true } } }),
  })
  await expectJson(res, 500, {
    error: 'Failed to provision hosting hierarchy',
    code: 'hosting_hierarchy_failed',
  })
})

test('PATCH /servers/:id still returns 200 when hosting-disable reconcile is a no-op', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    serverOptions: { hosting: { enabled: true } },
    defaultAllowed: true,
  })
  const res = await app.request(`/servers/${SERVER_ID}`, {
    method: 'PATCH',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ options: { hosting: { enabled: false } } }),
  })
  await expectJson(res, 200, { ok: true })
})

test('DELETE /servers/:id returns 404 when the server is missing', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request(`/servers/${SERVER_ID}`, {
    method: 'DELETE',
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 404, { error: 'Not found' })
})

test('DELETE /servers/:id returns 403 when manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    defaultAllowed: false,
  })
  const res = await app.request(`/servers/${SERVER_ID}`, {
    method: 'DELETE',
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 403, { error: 'Forbidden' })
})

test('DELETE /servers/:id returns 403 for a self-host-pinned server', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    executeQueue: [[{ allowed: true }], [{ server_id: SERVER_ID }]],
  })
  const res = await app.request(`/servers/${SERVER_ID}`, {
    method: 'DELETE',
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 403, { error: colocatedServerDeleteBlockedReason() })
})

test('GET /servers/:id/labels returns 403 when read is denied', async () => {
  const { app, cookie } = await buildSessionApp({ defaultAllowed: false })
  const res = await app.request(`/servers/${SERVER_ID}/labels`, {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 403, { error: 'Forbidden' })
})

test('GET /servers/:id/labels returns 404 when the server is outside the org', async () => {
  const { app, cookie } = await buildSessionApp({ defaultAllowed: true })
  const res = await app.request(`/servers/${SERVER_ID}/labels`, {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 404, { error: 'Not found' })
})

test('GET /servers/:id/labels returns an empty list for a visible server', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    defaultAllowed: true,
  })
  const res = await app.request(`/servers/${SERVER_ID}/labels`, {
    headers: sessionHeaders(cookie),
  })
  await expectJson(res, 200, { ok: true, labels: [] })
})

test('PUT /servers/:id/labels returns 403 when manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({ defaultAllowed: false })
  const res = await app.request(`/servers/${SERVER_ID}/labels`, {
    method: 'PUT',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ labels: { env: 'prod' } }),
  })
  await expectJson(res, 403, { error: 'Forbidden' })
})

test('PUT /servers/:id/labels returns 400 for invalid JSON and invalid keys', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    defaultAllowed: true,
  })
  const headers = {
    ...sessionHeaders(cookie),
    'content-type': 'application/json',
  }

  const badJson = await app.request(`/servers/${SERVER_ID}/labels`, {
    method: 'PUT',
    headers,
    body: '{',
  })
  await expectJson(badJson, 400, { error: 'Invalid request' })

  const empty = await app.request(`/servers/${SERVER_ID}/labels`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({}),
  })
  await expectJson(empty, 200, { ok: true, labels: [] })

  const missing = await app.request(`/servers/${SERVER_ID}/labels`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ labels: null }),
  })
  await expectJson(missing, 400, {
    error: 'Labels must be an object of string keys to string values',
  })

  const res = await app.request(`/servers/${SERVER_ID}/labels`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ labels: { '-nope': 'x' } }),
  })
  assertEquals(res.status, 400)
  const body = await res.json() as { error: string }
  if (typeof body.error !== 'string') {
    throw new TypeError('expected label validation error')
  }
  assertEquals(body.error.includes('invalid'), true)
})

test('GET /servers never returns a managedMonitor secret from a stale cache entry', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    executeQueue: [[{ item_id: SERVER_ID }]],
    queryCache: {
      getReadModel: (opts) => {
        if (opts.readModel === 'servers-list') {
          return Promise.resolve([cachedServerRowWithLegacyMonitorSecret()])
        }
        return Promise.resolve([])
      },
    },
  })
  const res = await app.request('/servers', {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 200)
  const raw = await res.text()
  assertEquals(raw.includes('managedMonitor'), false)
  assertEquals(raw.includes('passwordSealed'), false)
  assertEquals(raw.includes('tpsecret.v1.deadbeef'), false)
  // The operator-facing options survive the redaction.
  const body = JSON.parse(raw) as {
    servers: Array<{ options: Record<string, unknown> }>
  }
  assertEquals(body.servers[0]?.options, { timezone: 'UTC' })
})

test('GET /servers/:id never returns a managedMonitor secret from a stale cache entry', async () => {
  const { app, cookie } = await buildSessionApp({
    withServerRow: true,
    defaultAllowed: true,
    queryCache: {
      getReadModel: (opts) => {
        if (opts.readModel === 'server-detail') {
          return Promise.resolve(cachedServerRowWithLegacyMonitorSecret())
        }
        return Promise.resolve(null)
      },
    },
  })
  const res = await app.request(`/servers/${SERVER_ID}`, {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 200)
  const raw = await res.text()
  assertEquals(raw.includes('managedMonitor'), false)
  assertEquals(raw.includes('passwordSealed'), false)
  assertEquals(raw.includes('tpsecret.v1.deadbeef'), false)
  const body = JSON.parse(raw) as {
    server: { options: Record<string, unknown> }
  }
  assertEquals(body.server.options, { timezone: 'UTC' })
})
