import { assertEquals } from '@std/assert'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../app.ts'
import type { DaemonCell, DaemonCellRegistry, PendingRequestRecord } from '../daemon/cell/contracts.ts'
import type { Db } from '../db.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../client/authn/secrets.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'
import {
  COLOCATED_DAEMON_UPDATE_SKIPPED_REASON,
  parseUpdateOverride,
  registerUpdateRoutes,
} from './update-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_ID = '00000000-0000-4000-8000-0000000000d1'
const HTTPS_URL = 'https://203.0.113.10/daemon.tar.gz'
const SHA256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: () => promise,
    orderBy: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => promise.then(onFulfilled, onRejected),
  }
  return chain
}

function createDb(projectionRows: unknown[] = []): Db {
  return {
    select: (fields?: Record<string, unknown>) => {
      const keys = fields ? Object.keys(fields) : []
      const isProjection = keys.includes('daemon') && keys.includes('connected')
      return thenable(isProjection ? projectionRows : [])
    },
  } as unknown as Db
}

function directProjectionRow(id = SERVER_ID) {
  return {
    id,
    daemon: {
      key: {
        id: 'key-1',
        algorithm: 'Ed25519',
        publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
        fingerprint: 'fp-1',
        createdAt: '2020-01-01T00:00:00.000Z',
      },
      projection: { remoteAddress: '__direct__' },
    },
    connected: true,
    statusChangedAt: '2020-01-01T00:00:00.000Z',
  }
}

function createRegistry(opts: {
  onlineIds?: string[]
  connected?: boolean
  requestStatus?: PendingRequestRecord['status']
  requestError?: string
} = {}): DaemonCellRegistry {
  const requestStatus = opts.requestStatus ?? 'done'
  const cell = {
    createRequestAndWait: (outbound: { requestId: string; at: string; kind: string }) => {
      const record: PendingRequestRecord = {
        serverId: SERVER_ID,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: requestStatus,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }
      if (opts.requestError) record.error = opts.requestError
      return Promise.resolve(record)
    },
  } as unknown as DaemonCell

  return {
    getCell: () => cell,
    listOnlineServerIds: () => Promise.resolve(opts.onlineIds ?? [SERVER_ID]),
    getSnapshots: () =>
      Promise.resolve(
        new Map([
          [
            SERVER_ID,
            {
              serverId: SERVER_ID,
              version: 1,
              updatedAt: '2020-01-01T00:00:00.000Z',
              connected: opts.connected ?? true,
            },
          ],
        ]),
      ),
    purge: () => Promise.resolve(),
  }
}

async function createApp(opts: {
  db?: Db | null
  registry?: DaemonCellRegistry | null
} = {}) {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  const app = new Hono()
  app.use('*', async (c, next) => {
    const vars = c as unknown as Context<AppEnv>
    if (opts.db !== null) vars.set('db', opts.db ?? createDb())
    if (opts.registry !== null) {
      vars.set('daemonCellRegistry', opts.registry ?? createRegistry())
    }
    await next()
  })
  registerUpdateRoutes(app, { secrets, authRequired: false })
  return app
}

test('parseUpdateOverride accepts empty body and valid HTTPS pair', () => {
  assertEquals(parseUpdateOverride({}), {})
  assertEquals(
    parseUpdateOverride({ updateUrl: HTTPS_URL, updateSha256: SHA256 }),
    { updateUrl: HTTPS_URL, updateSha256: SHA256 },
  )
})

function parseUpdateOverrideError(body: {
  updateUrl?: unknown
  updateSha256?: unknown
}): string {
  const parsed = parseUpdateOverride(body)
  if (!('error' in parsed)) throw new TypeError('expected parse error')
  return parsed.error
}

test('parseUpdateOverride rejects partial, non-https, and bad hash', () => {
  assertEquals(
    parseUpdateOverrideError({ updateUrl: HTTPS_URL }),
    'updateUrl and updateSha256 must both be provided for explicit URL updates',
  )
  assertEquals(
    parseUpdateOverrideError({ updateUrl: 'http://203.0.113.10/x', updateSha256: SHA256 }),
    'updateUrl must use HTTPS',
  )
  assertEquals(
    parseUpdateOverrideError({ updateUrl: 'not-a-url', updateSha256: SHA256 }),
    'updateUrl must be a valid absolute URL',
  )
  assertEquals(
    parseUpdateOverrideError({ updateUrl: HTTPS_URL, updateSha256: 'deadbeef' }),
    'updateSha256 must be a 64-character hex string',
  )
})

test('POST /daemon/:id/update returns 503 without registry or database', async () => {
  const noRegistry = await createApp({ registry: null })
  const missingRegistry = await noRegistry.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/update`,
    { method: 'POST', headers: JSON_HEADERS, body: '{}' },
  )
  assertEquals(missingRegistry.status, 503)

  const noDb = await createApp({ db: null })
  const missingDb = await noDb.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/update`,
    { method: 'POST', headers: JSON_HEADERS, body: '{}' },
  )
  assertEquals(missingDb.status, 503)
})

test('POST /daemon/:id/update rejects invalid override and skips colocated', async () => {
  const app = await createApp({
    db: createDb([directProjectionRow()]),
    registry: createRegistry(),
  })
  const bad = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/update`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ updateUrl: HTTPS_URL }),
    },
  )
  assertEquals(bad.status, 400)

  const skipped = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/update`,
    { method: 'POST', headers: JSON_HEADERS, body: '{}' },
  )
  assertEquals(skipped.status, 200)
  const skippedBody = await skipped.json() as {
    results: Array<{ skipped?: boolean; error?: string }>
  }
  assertEquals(skippedBody.results[0]?.skipped, true)
  assertEquals(skippedBody.results[0]?.error, COLOCATED_DAEMON_UPDATE_SKIPPED_REASON)
})

test('POST /daemon/:id/update maps connected and failed daemon outcomes', async () => {
  const okApp = await createApp({ registry: createRegistry() })
  const ok = await okApp.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/update`,
    { method: 'POST', headers: JSON_HEADERS, body: '{"channel":"trunk"}' },
  )
  assertEquals(ok.status, 200)

  const offlineApp = await createApp({
    registry: createRegistry({ connected: false }),
  })
  const offline = await offlineApp.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/update`,
    { method: 'POST', headers: JSON_HEADERS, body: '{}' },
  )
  assertEquals(offline.status, 404)

  const failedApp = await createApp({
    registry: createRegistry({ requestStatus: 'failed', requestError: 'boom' }),
  })
  const failed = await failedApp.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/update`,
    { method: 'POST', headers: JSON_HEADERS, body: '{}' },
  )
  assertEquals(failed.status, 500)

  const expiredApp = await createApp({
    registry: createRegistry({ requestStatus: 'expired' }),
  })
  const expired = await expiredApp.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/update`,
    { method: 'POST', headers: JSON_HEADERS, body: '{}' },
  )
  assertEquals(expired.status, 500)

  const queuedApp = await createApp({
    registry: createRegistry({ requestStatus: 'queued' }),
  })
  const queued = await queuedApp.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/update`,
    { method: 'POST', headers: JSON_HEADERS, body: '{}' },
  )
  assertEquals(queued.status, 500)
})

test('POST /daemon/update fans out skip and success rows', async () => {
  const app = await createApp({
    db: createDb([directProjectionRow()]),
    registry: createRegistry({ onlineIds: [SERVER_ID] }),
  })
  const response = await app.request(`${DEVELOPER_API_PREFIX}/daemon/update`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{}',
  })
  assertEquals(response.status, 200)
  const body = await response.json() as {
    ok: boolean
    results: Array<{ skipped?: boolean }>
  }
  assertEquals(body.ok, true)
  assertEquals(body.results[0]?.skipped, true)
})

test('POST /daemon/update validates override, requires a database, and maps remote failures', async () => {
  const noDb = await createApp({ db: null, registry: createRegistry({ onlineIds: [SERVER_ID] }) })
  const missingDb = await noDb.request(`${DEVELOPER_API_PREFIX}/daemon/update`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{}',
  })
  assertEquals(missingDb.status, 503)

  const bad = await (await createApp({
    registry: createRegistry({ onlineIds: [SERVER_ID] }),
  })).request(`${DEVELOPER_API_PREFIX}/daemon/update`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ updateUrl: HTTPS_URL }),
  })
  assertEquals(bad.status, 400)

  const okApp = await createApp({
    db: createDb(),
    registry: createRegistry({ onlineIds: [SERVER_ID], connected: true }),
  })
  const ok = await okApp.request(`${DEVELOPER_API_PREFIX}/daemon/update`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{}',
  })
  assertEquals(ok.status, 200)
  const okBody = await ok.json() as {
    ok: boolean
    results: Array<{ ok: boolean; skipped?: boolean }>
  }
  assertEquals(okBody.ok, true)
  assertEquals(okBody.results[0]?.skipped, undefined)

  const failedApp = await createApp({
    db: createDb(),
    registry: createRegistry({
      onlineIds: [SERVER_ID],
      connected: false,
    }),
  })
  const failed = await failedApp.request(`${DEVELOPER_API_PREFIX}/daemon/update`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{}',
  })
  assertEquals(failed.status, 200)
  const failedBody = await failed.json() as {
    ok: boolean
    results: Array<{ ok: boolean; error?: string }>
  }
  assertEquals(failedBody.ok, false)
  assertEquals(typeof failedBody.results[0]?.error, 'string')
})
