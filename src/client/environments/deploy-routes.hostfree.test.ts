/**
 * Host-free coverage for deploy-route helpers and Hono short-circuits.
 */

import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import { createNoopCommandQueue } from '../../lib/commands/noop-command-queue.ts'
import { environment } from '../../lib/db/schema.ts'
import { DEFAULT_MANAGED_INGRESS_PORTS } from '../../lib/managed/ingress-ports.ts'
import type { PreparedDeployCompose } from './deploy-prepare.ts'
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
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import {
  assertDeployDispatchInfrastructure,
  attachmentServerIds,
  authorizeDeployRequest,
  authorizeEnvironmentManage,
  deployParticipation,
  ingressServerIdsForDeploy,
  registerEnvironmentDeployPreviewRoutes,
  registerEnvironmentDeployRoutes,
  registerEnvironmentLifecycleRoutes,
  registerEnvironmentStopRoutes,
  runEnvironmentDeployForActor,
  tcpUdpIngressServiceRefs,
} from './deploy-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const environmentId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return promise.then.bind(promise)
        if (prop === 'catch' || prop === 'finally') return undefined
        return () => chain
      },
    },
  )
  return chain
}

function thenableLimit(rows: unknown[]) {
  return {
    limit: () => Promise.resolve(rows),
  }
}

function mockContext(opts: {
  session?: { userId: string } | null
  db?: Db
  bodyText?: string
  headers?: Record<string, string>
}): Context<AppEnv> {
  const headers = opts.headers ?? {}
  const vars = new Map<string, unknown>()
  if (opts.db) vars.set('db', opts.db)
  if (opts.session !== undefined) vars.set('session', opts.session)

  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
      query: () => undefined,
      text: () => Promise.resolve(opts.bodyText ?? ''),
    },
    get: (key: string) => vars.get(key),
    json: (body: unknown, status?: number) =>
      Response.json(body, { status: status ?? 200 }),
  } as unknown as Context<AppEnv>
}

function buildOrgDb(opts: {
  organizationId: string | null
  manageAllowed: boolean
}): Db {
  const executeResults: unknown[][] = []
  if (opts.organizationId) {
    executeResults.push([{ organization_id: opts.organizationId }])
  } else {
    executeResults.push([])
  }
  executeResults.push([{ allowed: opts.manageAllowed }])
  if (opts.manageAllowed) executeResults.push([{ kind: 'user' }])

  let executePhase = 0
  return {
    select: () => ({
      from: () => ({
        where: () => thenableLimit([{ role: 'superadmin' }]),
      }),
    }),
    execute: () => {
      const rows = executeResults[executePhase] ?? []
      executePhase += 1
      return Promise.resolve(rows)
    },
  } as unknown as Db
}

function emptySelectDb(): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => thenableLimit([]),
      }),
    }),
  } as unknown as Db
}

function stubPrepared(managedNetworkServices: string[] = []): PreparedDeployCompose {
  return {
    composeYaml: '',
    composeFiles: [],
    desiredHash: '',
    replicaCounts: {},
    hooks: [],
    variableMaterial: [],
    storageMaterial: [],
    principalMaterial: [],
    sites: [],
    nativeAppServices: [],
    sourceMaterial: [],
    dockerExternalNetworks: [],
    dockerNetworkAddressing: [],
    fabricNetworks: [],
    managedNetworkServices,
    containers: [],
    ingressServices: [],
    hostings: [],
    tlsMaterial: [],
    listenerPorts: DEFAULT_MANAGED_INGRESS_PORTS,
    composeServiceExpansion: {},
    volumes: [],
    warnings: [],
  }
}

function recordingQueue(): CommandQueue {
  return { enqueue: () => Promise.resolve() }
}

function emptyRegistry(): DaemonCellRegistry {
  return {
    getCell: () => {
      throw new TypeError('cell should not be touched in host-free short-circuits')
    },
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  }
}

function dispatchContext(opts: {
  registry?: DaemonCellRegistry
  commandQueue?: CommandQueue
}): Context<AppEnv> {
  const vars = new Map<string, unknown>()
  if (opts.registry) vars.set('daemonCellRegistry', opts.registry)
  if (opts.commandQueue) vars.set('commandQueue', opts.commandQueue)
  return {
    get: (key: string) => vars.get(key),
    json: (body: unknown, status?: number) =>
      Response.json(body, { status: status ?? 200 }),
  } as unknown as Context<AppEnv>
}

function actorAuth() {
  return {
    actorType: 'system' as const,
    actorId: 'source-1',
    organizationId,
    acknowledgeHealthCheckWarnings: false,
    noCache: false,
    selection: { ref: null, commitSha: null, sourceId: null },
  }
}

test('attachmentServerIds and tcpUdpIngressServiceRefs project ids', () => {
  assertEquals(attachmentServerIds([]), [])
  assertEquals(
    attachmentServerIds([
      { serverId: 'srv-a', networkKeys: [] },
      { serverId: 'srv-b', networkKeys: ['default'] },
    ]),
    ['srv-a', 'srv-b'],
  )
  assertEquals(tcpUdpIngressServiceRefs([]), [])
  assertEquals(
    tcpUdpIngressServiceRefs([{ serviceId: 'svc-1' }, { serviceId: 'svc-2' }]),
    [{ serviceId: 'svc-1' }, { serviceId: 'svc-2' }],
  )
})

test('deployParticipation drains previous hosts that left the plan', () => {
  const withDrain = deployParticipation({
    planServerIds: ['srv-a'],
    attachments: [{ serverId: 'srv-attach', networkKeys: ['default'] }],
    previous: [{ serverId: 'srv-a' }, { serverId: 'srv-old' }],
  })
  assertEquals([...withDrain.attachmentServers], ['srv-attach'])
  assertEquals(
    [...withDrain.participating].sort((a, b) => a.localeCompare(b)),
    ['srv-a', 'srv-attach'],
  )
  assertEquals(withDrain.drainedIds, ['srv-old'])

  const empty = deployParticipation({
    planServerIds: ['srv-a'],
    attachments: [],
    previous: [],
  })
  assertEquals([...empty.attachmentServers], [])
  assertEquals([...empty.participating], ['srv-a'])
  assertEquals(empty.drainedIds, [])
})

test('ingressServerIdsForDeploy unions attachments, leftovers, and managed hosts', () => {
  const ids = ingressServerIdsForDeploy({
    planServerIds: ['srv-a', 'srv-b'],
    preparedByServer: [
      {
        serverId: 'srv-a',
        prepared: stubPrepared(['web']),
      },
      {
        serverId: 'srv-b',
        prepared: stubPrepared([]),
      },
    ],
    attachments: [{ serverId: 'srv-attach', networkKeys: ['default'] }],
    consumers: [],
    spanning: new Map(),
    segmentsByServer: new Map(),
    listenerNames: new Map(),
    releasedListeners: ['srv-orphan'],
  })
  assertEquals(
    [...ids].sort((a, b) => a.localeCompare(b)),
    ['srv-a', 'srv-attach', 'srv-orphan'],
  )
})

test('ingressServerIdsForDeploy adds a plan host that only needs reserved ingress', () => {
  const ids = ingressServerIdsForDeploy({
    planServerIds: ['srv-plan'],
    preparedByServer: [{
      serverId: 'srv-plan',
      prepared: stubPrepared([]),
    }],
    attachments: [{ serverId: 'srv-listener', networkKeys: ['default'] }],
    consumers: [{
      composeServiceName: 'api',
      networkKeys: ['default'],
      listenerServerId: 'srv-listener',
    }],
    spanning: new Map([['default', 'tpn_default']]),
    segmentsByServer: new Map([
      ['srv-listener', [{ name: 'tpn_default', subnet: '10.0.0.0/24' }]],
    ]),
    listenerNames: new Map([['srv-listener', 'proxy']]),
    releasedListeners: [],
  })
  assertEquals(
    [...ids].sort((a, b) => a.localeCompare(b)),
    ['srv-listener', 'srv-plan'],
  )
})

test('assertDeployDispatchInfrastructure refuses missing registry and queues', async () => {
  const noRegistry = assertDeployDispatchInfrastructure(dispatchContext({}))
  if (!(noRegistry instanceof Response)) {
    throw new TypeError('expected missing registry to fail')
  }
  assertEquals(noRegistry.status, 503)
  assertEquals(await noRegistry.json(), {
    error: 'Daemon cell registry unavailable',
  })

  const noQueue = assertDeployDispatchInfrastructure(
    dispatchContext({ registry: emptyRegistry() }),
  )
  if (!(noQueue instanceof Response)) {
    throw new TypeError('expected missing queue to fail')
  }
  assertEquals(noQueue.status, 503)
  assertEquals(await noQueue.json(), { error: 'Command queue unavailable' })

  const noop = assertDeployDispatchInfrastructure(
    dispatchContext({
      registry: emptyRegistry(),
      commandQueue: createNoopCommandQueue(),
    }),
  )
  if (!(noop instanceof Response)) {
    throw new TypeError('expected noop queue to fail')
  }
  assertEquals(noop.status, 503)
  assertEquals(await noop.json(), { error: 'Command queue unavailable' })
})

test('assertDeployDispatchInfrastructure returns a usable queue', () => {
  const queue = recordingQueue()
  const result = assertDeployDispatchInfrastructure(
    dispatchContext({ registry: emptyRegistry(), commandQueue: queue }),
  )
  assertEquals(result, queue)
})

test('register* deploy routes require session secrets', () => {
  const app = new Hono<AppEnv>()
  const opts = { runtime: 'deno' as const, signupEnvOverride: undefined }
  const registrars = [
    registerEnvironmentDeployPreviewRoutes,
    registerEnvironmentDeployRoutes,
    registerEnvironmentStopRoutes,
    registerEnvironmentLifecycleRoutes,
  ]
  for (const register of registrars) {
    let threw = false
    try {
      register(app, opts)
    } catch (error) {
      threw = true
      assertEquals(error instanceof TypeError, true)
    }
    assertEquals(threw, true)
  }
})

async function buildManageApp(opts: {
  register: (app: Hono<AppEnv>, routeOpts: {
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    runtime: 'deno'
    signupEnvOverride: undefined
  }) => void
  withRegistry?: boolean
  withQueue?: boolean
}): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `deploy-sc-${crypto.randomUUID()}@example.com`,
    role: 'superadmin',
  })
  seedMockUser(state, {
    id: userId,
    email: `deploy-sc-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: 'superadmin',
  })
  state.organizations.push({ id: organizationId, name: 'Deploy Org' })

  let executePhase = 0
  const authDb = createMockAuthDb(state)
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown }
    }
  ).select.bind(authDb)
  const db = Object.assign(authDb, {
    execute: () => {
      executePhase += 1
      if (executePhase === 1) {
        return Promise.resolve([{ organization_id: organizationId }])
      }
      if (executePhase === 2) return Promise.resolve([{ allowed: true }])
      return Promise.resolve([{ kind: 'user' }])
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === environment) return thenableRows([])
        return origSelect(fields).from(table)
      },
    }),
  }) as unknown as Db

  const signed = await buildSignedCookie(token, secrets)
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (opts.withRegistry) c.set('daemonCellRegistry', emptyRegistry())
    if (opts.withQueue) c.set('commandQueue', recordingQueue())
    return next()
  })
  opts.register(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return { app, cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}` }
}

function authHeaders(cookie: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    Cookie: cookie,
    [ORG_ID_HEADER]: organizationId,
  }
}

test('authorizeEnvironmentManage requires an organization header and a db on context', async () => {
  const missingOrg = await authorizeEnvironmentManage(
    mockContext({ session: { userId: 'user-1' }, db: {} as Db }),
    {} as Db,
    environmentId,
  )
  if (!(missingOrg instanceof Response)) {
    throw new TypeError('expected organizationId required')
  }
  assertEquals(missingOrg.status, 400)
  assertEquals(await missingOrg.json(), { error: 'organizationId required' })

  const missingDb = await authorizeEnvironmentManage(
    mockContext({
      session: { userId: 'user-1' },
      headers: { [ORG_ID_HEADER]: organizationId },
    }),
    {} as Db,
    environmentId,
  )
  if (!(missingDb instanceof Response)) {
    throw new TypeError('expected Database unavailable')
  }
  assertEquals(missingDb.status, 503)
  assertEquals(await missingDb.json(), { error: 'Database unavailable' })
})

test('authorizeDeployRequest returns 400 for invalid JSON', async () => {
  const db = buildOrgDb({ organizationId, manageAllowed: true })
  const result = await authorizeDeployRequest(
    mockContext({
      session: { userId: 'user-1' },
      db,
      headers: { [ORG_ID_HEADER]: organizationId },
      bodyText: '{',
    }),
    db,
    environmentId,
  )
  if (!(result instanceof Response)) {
    throw new TypeError('expected Invalid request')
  }
  assertEquals(result.status, 400)
  assertEquals(await result.json(), { error: 'Invalid request' })
})

test('GET /environments/:id/deploy-preview returns 404 when the plan is missing', async () => {
  const { app, cookie } = await buildManageApp({
    register: registerEnvironmentDeployPreviewRoutes,
  })
  const res = await app.request(`/environments/${environmentId}/deploy-preview`, {
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('POST /environments/:id/deploy returns 404 when the plan is missing', async () => {
  const { app, cookie } = await buildManageApp({
    register: registerEnvironmentDeployRoutes,
    withRegistry: true,
    withQueue: true,
  })
  const res = await app.request(`/environments/${environmentId}/deploy`, {
    method: 'POST',
    headers: authHeaders(cookie),
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('POST /environments/:id/stop returns 503 when dispatch infra is missing', async () => {
  const { app, cookie } = await buildManageApp({
    register: registerEnvironmentStopRoutes,
  })
  const res = await app.request(`/environments/${environmentId}/stop`, {
    method: 'POST',
    headers: authHeaders(cookie),
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'Daemon cell registry unavailable' })
})

test('POST /environments/:id/stop returns 404 when the environment is missing', async () => {
  const { app, cookie } = await buildManageApp({
    register: registerEnvironmentStopRoutes,
    withRegistry: true,
    withQueue: true,
  })
  const res = await app.request(`/environments/${environmentId}/stop`, {
    method: 'POST',
    headers: authHeaders(cookie),
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('POST /environments/:id/lifecycle rejects an invalid action after manage', async () => {
  const { app, cookie } = await buildManageApp({
    register: registerEnvironmentLifecycleRoutes,
  })
  const res = await app.request(`/environments/${environmentId}/lifecycle`, {
    method: 'POST',
    headers: authHeaders(cookie),
    body: JSON.stringify({ action: 'down' }),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid request' })
})

test('POST /environments/:id/lifecycle returns 503 when dispatch infra is missing', async () => {
  const { app, cookie } = await buildManageApp({
    register: registerEnvironmentLifecycleRoutes,
  })
  const res = await app.request(`/environments/${environmentId}/lifecycle`, {
    method: 'POST',
    headers: authHeaders(cookie),
    body: JSON.stringify({ action: 'start' }),
  })
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'Daemon cell registry unavailable' })
})

test('POST /environments/:id/lifecycle returns 404 when the environment is missing', async () => {
  const { app, cookie } = await buildManageApp({
    register: registerEnvironmentLifecycleRoutes,
    withRegistry: true,
    withQueue: true,
  })
  const res = await app.request(`/environments/${environmentId}/lifecycle`, {
    method: 'POST',
    headers: authHeaders(cookie),
    body: JSON.stringify({ action: 'restart' }),
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('runEnvironmentDeployForActor returns 404 when the environment is missing', async () => {
  const c = {
    json: (body: unknown, status?: number) =>
      Response.json(body, { status: status ?? 200 }),
    get: () => undefined,
  } as unknown as Context<AppEnv>
  const result = await runEnvironmentDeployForActor(
    c,
    emptySelectDb(),
    recordingQueue(),
    environmentId,
    actorAuth(),
  )
  assertEquals(result.status, 404)
  assertEquals(await result.json(), { error: 'Not found' })
})
