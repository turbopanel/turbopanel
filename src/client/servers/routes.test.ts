import { assertEquals, assertExists, assertThrows } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb, endDbConnection } from '../../db.ts'
import type { DaemonCell, DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../authn/secrets.ts'
import {
  container,
  command,
  dispatch,
  environment,
  fabric,
  grant,
  license,
  network,
  organization,
  project,
  relay,
  subnet,
  server,
  service,
  team,
  teammate,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import * as hierarchyDelete from '../hierarchy-delete.ts'
import * as systemHierarchy from '../system/hierarchy.ts'
import {
  colocatedServerDeleteBlockedReason,
  SERVER_HAS_BLOCKERS_CODE,
  SERVER_HAS_BLOCKERS_ERROR,
} from './delete-guards.ts'
import { COLOCATED_SERVER_DISPLAY_NAME } from '../authn/install-state.ts'
import { createLicense } from '../authn/license.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { buildServerDaemonState } from '../../daemon/authn/daemon-state.ts'
import { attachDaemonStateToServer } from '../../daemon/authn/server-identity-db.ts'
import { registerServerRoutes } from './routes.ts'
import type { ServerStatusRecord } from './update-status.ts'
import type { QueryCache } from '../../query-cache/contracts.ts'
import type { ServersListRow } from '../../query-cache/read-models/servers-list.ts'
import type { ServerDetailRow } from '../../query-cache/read-models/server-detail.ts'

import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const SERVER_STATUS_RECORD_KEYS: (keyof ServerStatusRecord)[] = [
  'serverId',
  'connected',
  'daemonStatus',
  'connectedAt',
  'statusChangedAt',
  'hostname',
  'remoteAddress',
  'geo',
  'colocatedWithInstance',
]

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type ErrorJson = {
  error: string
  code?: string
  blockers?: Array<{ kind: string; count: number }>
}

type ServersListJson = {
  servers: Array<{
    id: string
    connected: boolean
    geo: unknown
    os: unknown
    osDisplay: unknown
    osLogo: unknown
  }>
}

type ServersStatusListJson = {
  servers: Record<string, unknown>[]
}

async function readJson<T>(res: Response): Promise<T> {
  return await res.json() as T
}

function createMockCell(
  serverId: string,
  purgedIds: string[],
  failPurge = false,
  options?: { listRequestsThrows?: boolean },
): DaemonCell {
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
        serverId,
        version: 0,
        updatedAt: new Date().toISOString(),
        connected: false,
      }),
    putSnapshot: (patch) =>
      Promise.resolve({
        serverId,
        version: 1,
        updatedAt: new Date().toISOString(),
        connected: false,
        ...patch,
      }),
    enqueue: (outbound) =>
      Promise.resolve({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'queued' as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    markSent: noopAsync,
    handleInbound: () => Promise.resolve(null),
    getRequest: () => Promise.resolve(null),
    listRequests: options?.listRequestsThrows
      ? () => Promise.reject(new Error('listRequests should not be called'))
      : () => Promise.resolve([]),
    waitForRequest: () => Promise.resolve(null),
    createRequestAndWait: (outbound) =>
      Promise.resolve({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'done' as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    claimDeliveryLease: () => Promise.resolve(null),
    renewDeliveryLease: () => Promise.resolve(null),
    releaseDeliveryLease: noopAsync,
    readOutboxBatch: () => Promise.resolve([]),
    ackOutbox: noopAsync,
    prune: () => Promise.resolve([]),
    clearUpdateStatus: () => Promise.resolve({ cleared: 0 }),
    purge: () => {
      if (failPurge) {
        return Promise.reject(new Error(`purge failed for ${serverId}`))
      }
      purgedIds.push(serverId)
      return Promise.resolve()
    },
  }
}

function createTrackingRegistry(options?: {
  failPurgeIds?: Set<string>
  listRequestsThrows?: boolean
  getCellThrows?: boolean
  getSnapshotsThrows?: boolean
  listOnlineServerIdsThrows?: boolean
  onlineIds?: string[]
}): DaemonCellRegistry & { purgedIds: string[] } {
  const purgedIds: string[] = []
  const failPurgeIds = options?.failPurgeIds ?? new Set<string>()
  const cells = new Map<string, DaemonCell>()
  const onlineIds = options?.onlineIds ?? []

  const getCell = (serverId: string): DaemonCell => {
    if (options?.getCellThrows) {
      throw new Error('getCell must not be called')
    }
    let cell = cells.get(serverId)
    if (!cell) {
      cell = createMockCell(
        serverId,
        purgedIds,
        failPurgeIds.has(serverId),
        { listRequestsThrows: options?.listRequestsThrows },
      )
      cells.set(serverId, cell)
    }
    return cell
  }

  return {
    purgedIds,
    getCell,
    listOnlineServerIds: options?.listOnlineServerIdsThrows
      ? () => Promise.reject(new Error('listOnlineServerIds must not be called'))
      : () => Promise.resolve(onlineIds),
    getSnapshots: options?.getSnapshotsThrows
      ? () => Promise.reject(new Error('getSnapshots must not be called'))
      : () => Promise.resolve(new Map()),
    purge: async (serverId: string) => {
      await getCell(serverId).purge()
    },
  }
}

async function createServerRoutesTestApp(
  db: ReturnType<typeof createDenoDb>,
  registry?: DaemonCellRegistry,
  queryCache?: QueryCache,
  commandQueue?: import('../../lib/commands/queue.ts').CommandQueue,
) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (registry) {
      c.set('daemonCellRegistry', registry)
    }
    if (queryCache) {
      c.set('queryCache', queryCache)
    }
    if (commandQueue) {
      c.set('commandQueue', commandQueue)
    }
    return next()
  })
  registerServerRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  return { app, secrets }
}

const SERVERS_LIST_SELECT_KEYS = new Set([
  'id',
  'name',
  'organizationId',
  'licenseId',
  'machineClass',
  'options',
  'createdAt',
])

function assertServersListSelectFields(fields: Record<string, unknown>): void {
  const keys = Object.keys(fields)
  const exactColumnSet = keys.length === SERVERS_LIST_SELECT_KEYS.size
    && keys.every((key) => SERVERS_LIST_SELECT_KEYS.has(key))
  if (!exactColumnSet) {
    throw new Error(
      'readDb must only serve the documented servers-list row SELECT column set',
    )
  }
}

/** Cached readDb: only the approved list-row SELECT; presence/colocated must use primary db. */
function createListRowsOnlyReadDb(
  db: ReturnType<typeof createDenoDb>,
): ReturnType<typeof createDenoDb> & { selectCallCount: number } {
  let selectCallCount = 0
  const rejectCachedAccess = (prop: string | symbol): never => {
    throw new Error(
      `readDb must not access ${String(prop)}; only the list-rows SELECT is allowed`,
    )
  }
  const proxy = new Proxy(db, {
    get(_target, prop) {
      if (prop === 'selectCallCount') {
        return selectCallCount
      }
      if (prop === 'select') {
        return (fields: Record<string, unknown>) => {
          selectCallCount += 1
          assertServersListSelectFields(fields)
          return db.select(fields as Parameters<typeof db.select>[0])
        }
      }
      return rejectCachedAccess(prop)
    },
  }) as ReturnType<typeof createDenoDb> & { selectCallCount: number }
  return proxy
}

function createStubDbForCachedReadTests(): ReturnType<typeof createDenoDb> {
  return {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([]),
          }),
        }),
        where: () => ({
          orderBy: () => Promise.resolve([]),
        }),
      }),
    }),
    update: () => {
      throw new Error('underlying update must not run')
    },
  } as unknown as ReturnType<typeof createDenoDb>
}

test('createListRowsOnlyReadDb default-denies non-select database access', () => {
  const db = createStubDbForCachedReadTests()
  const readDb = createListRowsOnlyReadDb(db)

  for (const method of [
    'update',
    'delete',
    'transaction',
    'query',
    'selectDistinct',
    'execute',
    'insert',
    '$client',
    'session',
  ] as const) {
    assertThrows(
      () => Reflect.get(readDb, method),
      Error,
      'readDb must not access',
    )
  }
})

test('createListRowsOnlyReadDb rejects partial servers-list select columns', async () => {
  const db = createStubDbForCachedReadTests()
  const readDb = createListRowsOnlyReadDb(db)

  assertThrows(
    () => readDb.select({ id: server.id }),
    Error,
    'documented servers-list row SELECT column set',
  )
  assertThrows(
    () => readDb.select({
      id: server.id,
      name: server.name,
      organizationId: server.organizationId,
      licenseId: license.id,
      machineClass: server.machineClass,
      options: server.options,
      createdAt: server.createdAt,
      daemon: server.daemon,
    }),
    Error,
    'documented servers-list row SELECT column set',
  )

  const allowedReadDb = createListRowsOnlyReadDb(createStubDbForCachedReadTests())
  await allowedReadDb.select({
    id: server.id,
    name: server.name,
    organizationId: server.organizationId,
    licenseId: license.id,
    machineClass: server.machineClass,
    options: server.options,
    createdAt: server.createdAt,
  })
  assertEquals(allowedReadDb.selectCallCount, 1)
})

function createRecordingQueryCache(
  readDb: ReturnType<typeof createDenoDb>,
): QueryCache & {
  readModels: string[]
  store: Map<string, unknown>
  loadCallCount: number
} {
  const readModels: string[] = []
  const store = new Map<string, unknown>()
  let loadCallCount = 0

  return {
    readModels,
    store,
    get loadCallCount() {
      return loadCallCount
    },
    async getReadModel<T>(opts: {
      readModel: string
      key: string
      ttlSeconds?: number
      load: (readDb: ReturnType<typeof createDenoDb>) => Promise<T>
    }): Promise<T> {
      readModels.push(opts.readModel)
      const cached = store.get(opts.key)
      if (cached !== undefined) {
        return cached as T
      }
      loadCallCount += 1
      const result = await opts.load(readDb)
      store.set(opts.key, result)
      return result
    },
  }
}

const SERVER_DETAIL_SELECT_KEYS = new Set([
  'id',
  'name',
  'organizationId',
  'licenseId',
  'machineClass',
  'options',
  'createdAt',
])

function assertServerDetailSelectFields(fields: Record<string, unknown>): void {
  const keys = Object.keys(fields)
  const exactColumnSet = keys.length === SERVER_DETAIL_SELECT_KEYS.size
    && keys.every((key) => SERVER_DETAIL_SELECT_KEYS.has(key))
  if (!exactColumnSet) {
    throw new Error(
      'readDb must only serve the documented server-detail row SELECT column set',
    )
  }
}

/** Cached readDb: only the approved detail-row SELECT; presence must use primary db. */
function createDetailRowsOnlyReadDb(
  db: ReturnType<typeof createDenoDb>,
): ReturnType<typeof createDenoDb> & { selectCallCount: number } {
  let selectCallCount = 0
  const rejectCachedAccess = (prop: string | symbol): never => {
    throw new Error(
      `readDb must not access ${String(prop)}; only the detail-row SELECT is allowed`,
    )
  }
  const proxy = new Proxy(db, {
    get(_target, prop) {
      if (prop === 'selectCallCount') {
        return selectCallCount
      }
      if (prop === 'select') {
        return (fields: Record<string, unknown>) => {
          selectCallCount += 1
          assertServerDetailSelectFields(fields)
          return db.select(fields as Parameters<typeof db.select>[0])
        }
      }
      return rejectCachedAccess(prop)
    },
  }) as ReturnType<typeof createDenoDb> & { selectCallCount: number }
  return proxy
}

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`
}

/** Org-context access without grants — the `teammate` replacement for retired `membership`. */
async function insertOrgTeamMembership(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
  userId: string,
  teamName: string,
): Promise<string> {
  const [insertedTeam] = await db
    .insert(team)
    .values({ name: teamName, organizationId })
    .returning({ id: team.id })
  const teamId = insertedTeam!.id
  await db.insert(teammate).values({ teamId, userId })
  return teamId
}

async function withServerDeleteFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    serverId: string
    registry: DaemonCellRegistry & { purgedIds: string[] }
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const registry = createTrackingRegistry()
  const { app, secrets } = await createServerRoutesTestApp(db, registry)

  const email = `server-delete-test-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Server Delete Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })
  const teamId = await insertOrgTeamMembership(
    db,
    organizationId,
    userId,
    'Server Delete Team',
  )

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Delete Me',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      serverId,
      registry,
    })
  } finally {
    try {
      await db.delete(server).where(eq(server.id, serverId))
      await db.delete(grant).where(and(
        eq(grant.actorId, userId),
        eq(grant.entityId, organizationId),
      ))
      await db.delete(teammate).where(and(
        eq(teammate.teamId, teamId),
        eq(teammate.userId, userId),
      ))
      await db.delete(team).where(eq(team.id, teamId))
      await db.delete(user).where(eq(user.id, userId))
      await db.delete(organization).where(eq(organization.id, organizationId))
    } finally {
      await endDbConnection(db)
    }
  }
}

test('DELETE /servers/:id deletes the server relay and its segments', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    registry,
  }) => {
    const now = new Date().toISOString()
    const [insertedFabric] = await db
      .insert(fabric)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId,
        cidr: '10.250.0.0/16',
      })
      .returning({ id: fabric.id })
    const fabricId = insertedFabric!.id

    await db.insert(relay).values({
      createdAt: now,
      updatedAt: now,
      fabricId,
      serverId,
      address: '10.250.0.1',
      prefix: '10.192.0.0/16',
    })

    const [insertedNetwork] = await db
      .insert(network)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId,
        kind: 'compose',
      })
      .returning({ id: network.id })
    const networkId = insertedNetwork!.id

    await db.insert(subnet).values({
      createdAt: now,
      updatedAt: now,
      networkId,
      serverId,
      cidr: '10.192.0.0/24',
    })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const remainingRelays = await db
      .select({ id: relay.id })
      .from(relay)
      .where(eq(relay.serverId, serverId))
    const remainingSegments = await db
      .select({ id: subnet.id })
      .from(subnet)
      .where(eq(subnet.serverId, serverId))
    const remainingServers = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, serverId))
    assertEquals(remainingRelays.length, 0)
    assertEquals(remainingSegments.length, 0)
    assertEquals(remainingServers.length, 0)
    assertEquals(registry.purgedIds, [serverId])
  })
})

test('DELETE /servers/:id deletes the row and purges the daemon cell', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    registry,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body, { ok: true, serverId })

    const remaining = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, serverId))
    assertEquals(remaining.length, 0)
    assertEquals(registry.purgedIds, [serverId])
  })
})

test('DELETE /servers/:id returns 404 for a missing server', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    await db.delete(server).where(eq(server.id, serverId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 404)
  })
})

test('DELETE /servers/:id returns 403 for the co-located control plane server', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    registry,
  }) => {
    // Durable self-host pin (includeSelfHostPin) marks this host as co-located.
    await systemHierarchy.ensureSelfHostSystemHierarchy(db, {
      organizationId,
      serverId,
    })

    try {
      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/servers/${serverId}`, {
        method: 'DELETE',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      })

      assertEquals(res.status, 403)
      const body = await readJson<ErrorJson>(res)
      assertEquals(body.error, colocatedServerDeleteBlockedReason())
      assertEquals(registry.purgedIds.length, 0)
    } finally {
      await cleanupOrgSystemSubtree(db, organizationId)
    }
  })
})

async function cleanupOrgSystemSubtree(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
): Promise<void> {
  const workspaceRows = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.organizationId, organizationId))
  for (const ws of workspaceRows) {
    const projectRows = await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.workspaceId, ws.id))
    for (const p of projectRows) {
      const envRows = await db
        .select({ id: environment.id })
        .from(environment)
        .where(eq(environment.projectId, p.id))
      for (const env of envRows) {
        const serviceRows = await db
          .select({ id: service.id })
          .from(service)
          .where(eq(service.environmentId, env.id))
        for (const svc of serviceRows) {
          await db.delete(container).where(eq(container.serviceId, svc.id))
        }
        await db.delete(service).where(eq(service.environmentId, env.id))
        await db.delete(environment).where(eq(environment.id, env.id))
      }
      await db.delete(project).where(eq(project.id, p.id))
    }
    await db.delete(workspace).where(eq(workspace.id, ws.id))
  }
}

test('DELETE /servers/:id returns 403 via durable self-host pin when probes miss', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    registry,
  }) => {
    // Server has no machineKey / __direct__ projection; registry tracking cell
    // is not the live colocated probe — only the turbopanel environment pin.
    await systemHierarchy.ensureSelfHostSystemHierarchy(db, {
      organizationId,
      serverId,
    })

    try {
      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/servers/${serverId}`, {
        method: 'DELETE',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      })

      assertEquals(res.status, 403)
      const body = await readJson<ErrorJson>(res)
      assertEquals(body.error, colocatedServerDeleteBlockedReason())
      assertEquals(registry.purgedIds.length, 0)
    } finally {
      await cleanupOrgSystemSubtree(db, organizationId)
    }
  })
})

test('DELETE /servers/:id returns 403 via reserved colocated license when pin and probes miss', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    registry,
  }) => {
    // Fresh server has no machineKey / __direct__ projection / self-host pin —
    // only the active reserved install license bound to this server.
    const { licenseId } = await createLicense(db, {
      organizationId,
      name: COLOCATED_SERVER_DISPLAY_NAME,
    })
    await db
      .update(license)
      .set({ serverId, updatedAt: new Date().toISOString() })
      .where(eq(license.id, licenseId))

    try {
      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/servers/${serverId}`, {
        method: 'DELETE',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      })

      assertEquals(res.status, 403)
      const body = await readJson<ErrorJson>(res)
      assertEquals(body.error, colocatedServerDeleteBlockedReason())
      assertEquals(registry.purgedIds.length, 0)

      const [licenseRow] = await db
        .select({ revokedAt: license.revokedAt })
        .from(license)
        .where(eq(license.id, licenseId))
        .limit(1)
      assertEquals(licenseRow?.revokedAt ?? null, null)

      const remaining = await db
        .select({ id: server.id })
        .from(server)
        .where(eq(server.id, serverId))
      assertEquals(remaining.length, 1)
    } finally {
      await db.delete(license).where(eq(license.id, licenseId))
    }
  })
})

test('DELETE /servers/:id returns 403 not 503 for self-host-pinned server without registry', async () => {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createServerRoutesTestApp(db)

  const email = `server-delete-pin-no-registry-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Server Delete Pin No Registry Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Pinned No Registry',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  await systemHierarchy.ensureSelfHostSystemHierarchy(db, {
    organizationId,
    serverId,
  })

  try {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 403)
    const body = await readJson<ErrorJson>(res)
    assertEquals(body.error, colocatedServerDeleteBlockedReason())
  } finally {
    await cleanupOrgSystemSubtree(db, organizationId)
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
})

test('DELETE /servers/:id returns 409 when networks block deletion', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    registry,
  }) => {
    const now = new Date().toISOString()
    const [insertedNetwork] = await db
      .insert(network)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId,
        serverId,
        kind: 'docker',
        options: { dockerNetworkName: 'tp-restrict-net' },
      })
      .returning({ id: network.id })

    try {
      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/servers/${serverId}`, {
        method: 'DELETE',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      })

      assertEquals(res.status, 409)
      const body = await readJson<ErrorJson>(res)
      assertEquals(body.error, SERVER_HAS_BLOCKERS_ERROR)
      assertEquals(body.code, SERVER_HAS_BLOCKERS_CODE)
      assertEquals(body.blockers, [{ kind: 'network', count: 1 }])
      assertEquals(registry.purgedIds.length, 0)
    } finally {
      if (insertedNetwork) {
        await db.delete(network).where(eq(network.id, insertedNetwork.id))
      }
    }
  })
})

test('DELETE /servers/:id succeeds with stopped system ingress inventory', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    registry,
  }) => {
    const hierarchy = await systemHierarchy.ensureSystemHierarchy(db, {
      organizationId,
      serverId,
    })
    await db
      .update(container)
      .set({ status: 'exited' })
      .where(eq(container.id, hierarchy.containerRowId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body, { ok: true, serverId })
    assertEquals(registry.purgedIds, [serverId])

    const remainingServers = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, serverId))
    assertEquals(remainingServers.length, 0)

    const remainingEnvs = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.id, hierarchy.environmentId))
    assertEquals(remainingEnvs.length, 0)

    const remainingServices = await db
      .select({ id: service.id })
      .from(service)
      .where(eq(service.id, hierarchy.serviceId))
    assertEquals(remainingServices.length, 0)

    const remainingContainers = await db
      .select({ id: container.id })
      .from(container)
      .where(eq(container.id, hierarchy.containerRowId))
    assertEquals(remainingContainers.length, 0)

    // Shared project/workspace remain for other servers — clean for fixtures.
    await db.delete(project).where(eq(project.id, hierarchy.projectId))
    await db.delete(workspace).where(eq(workspace.id, hierarchy.workspaceId))
  })
})

test('DELETE /servers/:id invalidates the bound license', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const { licenseId } = await createLicense(db, { organizationId })
    await db
      .update(license)
      .set({ serverId, updatedAt: new Date().toISOString() })
      .where(eq(license.id, licenseId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)

    const [licenseRow] = await db
      .select({ revokedAt: license.revokedAt })
      .from(license)
      .where(eq(license.id, licenseId))
      .limit(1)
    assertExists(licenseRow?.revokedAt)

    await db.delete(license).where(eq(license.id, licenseId))
  })
})

test('DELETE /servers/:id invalidates the bound license on Workers runtime', async () => {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const registry = createTrackingRegistry()
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', registry)
    return next()
  })
  registerServerRoutes(app, { secrets, runtime: 'workers', signupEnvOverride: undefined })

  const email = `server-delete-workers-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Server Delete Workers Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Workers Delete Me',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    const { licenseId } = await createLicense(db, { organizationId })
    await db
      .update(license)
      .set({ serverId, updatedAt: new Date().toISOString() })
      .where(eq(license.id, licenseId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)

    const [licenseRow] = await db
      .select({ revokedAt: license.revokedAt })
      .from(license)
      .where(eq(license.id, licenseId))
      .limit(1)
    assertExists(licenseRow?.revokedAt)

    await db.delete(license).where(eq(license.id, licenseId))
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
})

test('DELETE /servers/:id returns 409 when child resources block deletion', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    registry,
  }) => {
    // Active system hosting-ingress containers block delete with 409 has_children.
    const hierarchy = await systemHierarchy.ensureSystemHierarchy(db, {
      organizationId,
      serverId,
    })
    const serviceRows = await db
      .select({ id: service.id })
      .from(service)
      .where(eq(service.environmentId, hierarchy.environmentId))
    const serviceId = serviceRows[0]?.id
    assertExists(serviceId)
    const now = new Date().toISOString()
    await db
      .update(container)
      .set({ status: 'running', updatedAt: now })
      .where(eq(container.serviceId, serviceId))

    try {
      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/servers/${serverId}`, {
        method: 'DELETE',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      })

      assertEquals(res.status, 409)
      const body = await readJson<ErrorJson>(res)
      assertEquals(body.error, hierarchyDelete.HIERARCHY_DELETE_HAS_CHILDREN_ERROR)
      assertEquals(registry.purgedIds.length, 0)

      const remaining = await db
        .select({ id: server.id })
        .from(server)
        .where(eq(server.id, serverId))
      assertEquals(remaining.length, 1)
    } finally {
      await cleanupOrgSystemSubtree(db, organizationId)
    }
  })
})

test('DELETE /servers/:id returns 503 when daemon cell registry is unavailable', async () => {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createServerRoutesTestApp(db)

  const email = `server-delete-no-registry-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Server Delete No Registry Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Registry Missing',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 503)
    const body = await readJson<ErrorJson>(res)
    assertEquals(body.error, 'Daemon cell registry unavailable')

    const remaining = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, serverId))
    assertEquals(remaining.length, 1)
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
})

test('DELETE /servers/:id returns 500 when purge fails after row delete', async () => {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const serverId = crypto.randomUUID()
  const registry = createTrackingRegistry({ failPurgeIds: new Set([serverId]) })
  const { app, secrets } = await createServerRoutesTestApp(db, registry)

  const email = `server-delete-purge-fail-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Server Delete Purge Fail Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const now = new Date().toISOString()
  const { licenseId } = await createLicense(db, { organizationId })
  await db.insert(server).values({
    id: serverId,
    createdAt: now,
    updatedAt: now,
    organizationId,
    name: 'Purge Fail',
  })
  await db
    .update(license)
    .set({ serverId, updatedAt: now })
    .where(eq(license.id, licenseId))

  try {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 500)
    const body = await readJson<{
      ok: boolean
      serverId: string
      deleted: boolean
      error: string
    }>(res)
    assertEquals(body.ok, false)
    assertEquals(body.serverId, serverId)
    assertEquals(body.deleted, true)
    assertEquals(typeof body.error, 'string')
    assertEquals(body.error.includes('purge failed'), true)

    const [licenseRow] = await db
      .select({ revokedAt: license.revokedAt })
      .from(license)
      .where(eq(license.id, licenseId))
      .limit(1)
    assertExists(licenseRow?.revokedAt)

    const remaining = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, serverId))
    assertEquals(remaining.length, 0)
    assertEquals(registry.purgedIds.length, 0)
  } finally {
    await db.delete(license).where(eq(license.id, licenseId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
})

test('GET /servers/updates does not call listRequests on the cell', async () => {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const registry = createTrackingRegistry({ listRequestsThrows: true })
  const { app, secrets } = await createServerRoutesTestApp(db, registry)

  const email = `server-updates-batch-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Server Updates Batch Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Updates Batch',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await attachDaemonStateToServer(db, serverId, {
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
      fingerprint: 'fp-test',
    })
    const daemonState = buildServerDaemonState({
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
      fingerprint: 'fp-test',
    })
    daemonState.projection = {
      daemonBuild: { commit: 'aaa', buildId: 'b1' },
      update: { status: 'updating', requestId: 'req-1', channel: 'trunk' },
    }
    await db.update(server).set({
      daemon: daemonState,
      updatedAt: new Date().toISOString(),
    }).where(eq(server.id, serverId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/servers/updates', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await readJson<{
      ok: boolean
      servers: Array<{ serverId: string; status: string }>
    }>(res)
    assertEquals(body.ok, true)
    assertEquals(body.servers.length, 1)
    assertEquals(body.servers[0].serverId, serverId)
    assertEquals(body.servers[0].status, 'updating')
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
})

async function attachConnectedDaemonStatus(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
): Promise<void> {
  await attachDaemonStateToServer(db, serverId, {
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
    fingerprint: 'fp-test',
  })
  const now = new Date().toISOString()
  // Fleet status lives on dedicated `server` columns now — never on
  // `server.daemon` jsonb (see `mapServerDaemonStatusFromColumns`).
  await db.update(server).set({
    isConnected: true,
    statusChangedAt: now,
    updatedAt: now,
  }).where(eq(server.id, serverId))
}

function assertServerStatusRecordShape(record: Record<string, unknown>): void {
  assertEquals(Object.keys(record).sort(), [...SERVER_STATUS_RECORD_KEYS].sort())
}

test('GET /servers returns Postgres data without calling getSnapshots', async () => {
  await withServerDeleteFixtures(async ({
    db,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const { app: listApp, secrets: listSecrets } = await createServerRoutesTestApp(
      db,
      registry,
    )

    await attachConnectedDaemonStatus(db, serverId)

    const cookie = await sessionCookie(db, listSecrets, userId)
    const res = await listApp.request('/servers', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await readJson<ServersListJson>(res)
    assertEquals(body.servers.length, 1)
    assertEquals(body.servers[0].id, serverId)
    assertEquals(body.servers[0].connected, true)
    assertEquals(body.servers[0].geo, null)
    assertEquals(body.servers[0].os, null)
    assertEquals(body.servers[0].osDisplay, null)
    assertEquals(body.servers[0].osLogo, null)
  })
})

test('GET /servers includes os, osDisplay, and osLogo from metadata without caching them', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const existing = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    await db
      .update(server)
      .set({
        // hostname is a dedicated column now — only os-shaped facts live in metadata.
        metadata: {
          ...(existing[0]?.metadata ?? {}),
          os: {
            family: 'linux',
            id: 'debian',
            version: '13',
            codename: 'trixie',
            prettyName: 'Debian GNU/Linux 13 (trixie)',
          },
        },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(server.id, serverId))

    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    await attachConnectedDaemonStatus(db, serverId)

    const readDb = createListRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/servers', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await readJson<ServersListJson>(res)
    assertEquals(body.servers.length, 1)
    assertEquals(body.servers[0].os, {
      family: 'linux',
      id: 'debian',
      version: '13',
      codename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
    })
    assertEquals(body.servers[0].osDisplay, 'Debian 13 (Trixie)')
    assertEquals(body.servers[0].osLogo, 'debian')
    assertEquals(recordingCache.readModels, ['servers-list'])
    const cachedRows = recordingCache.store.values().next().value as
      | ServersListRow[]
      | undefined
    assertEquals(cachedRows?.[0] && 'os' in cachedRows[0], false)
  })
})

test('GET /servers/status returns Postgres data without calling getSnapshots', async () => {
  await withServerDeleteFixtures(async ({
    db,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const { app: statusApp, secrets: statusSecrets } = await createServerRoutesTestApp(
      db,
      registry,
    )

    await attachConnectedDaemonStatus(db, serverId)

    const cookie = await sessionCookie(db, statusSecrets, userId)
    const res = await statusApp.request('/servers/status', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    assertEquals(res.headers.get('Cache-Control'), 'private, max-age=5')
    const body = await readJson<ServersStatusListJson>(res)
    assertEquals(body.servers.length, 1)
    assertEquals(body.servers[0].serverId, serverId)
    assertEquals(body.servers[0].connected, true)
    assertServerStatusRecordShape(body.servers[0])
  })
})

test('GET /servers/:id/status returns Postgres data without calling getSnapshots', async () => {
  await withServerDeleteFixtures(async ({
    db,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const { app: statusApp, secrets: statusSecrets } = await createServerRoutesTestApp(
      db,
      registry,
    )

    await attachConnectedDaemonStatus(db, serverId)

    const cookie = await sessionCookie(db, statusSecrets, userId)
    const res = await statusApp.request(`/servers/${serverId}/status`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    assertEquals(res.headers.get('Cache-Control'), 'private, max-age=5')
    const body = await readJson<Record<string, unknown>>(res)
    assertEquals(body.serverId, serverId)
    assertEquals(body.connected, true)
    assertServerStatusRecordShape(body)
  })
})

test('GET /servers/:id/cell returns 403 for a non-admin session user', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}/cell`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 403)
  })
})

test('GET /servers/:id/cell returns data for an admin user', async () => {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const registry = createTrackingRegistry()
  const { app, secrets } = await createServerRoutesTestApp(db, registry)

  const email = `server-cell-admin-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Server Cell Admin Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'admin' })
    .returning({ id: user.id })
  const userId = insertedUser!.id


  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Cell Admin',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}/cell`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await readJson<{
      ok: boolean
      snapshot: { serverId: string }
    }>(res)
    assertEquals(body.ok, true)
    assertEquals(body.snapshot.serverId, serverId)
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
})

test('GET /servers uses only the approved servers-list read model cache helper', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const readDb = createListRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/servers', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    assertEquals(recordingCache.readModels, ['servers-list'])
    assertEquals(recordingCache.loadCallCount, 1)
    assertEquals(readDb.selectCallCount, 1)
  })
})

test('GET /servers — cached payload is list rows only (presence comes from primary db)', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    await attachConnectedDaemonStatus(db, serverId)

    const readDb = createListRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/servers', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await readJson<ServersListJson>(res)
    assertEquals(body.servers.length, 1)
    assertEquals(recordingCache.store.size, 1)
    assertEquals(recordingCache.loadCallCount, 1)
    assertEquals(recordingCache.readModels, ['servers-list'])
    assertEquals(readDb.selectCallCount, 1)

    const cachedRows = recordingCache.store.values().next().value as ServersListRow[]
    assertEquals(cachedRows.length, 1)
    assertEquals(cachedRows[0].id, serverId)
    assertEquals('connected' in cachedRows[0], false)
    assertEquals(body.servers[0].connected, true)
  })
})

test('GET /servers — empty visibleIds short-circuits before cache', async () => {
  if (!dbUrl) {
    console.warn('Skipping server route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const registry = createTrackingRegistry()
  const readDb = createListRowsOnlyReadDb(db)
  const recordingCache = createRecordingQueryCache(readDb)
  const { app, secrets } = await createServerRoutesTestApp(db, registry, recordingCache)

  const email = `server-list-no-grant-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'No Grant Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id
  const teamId = await insertOrgTeamMembership(
    db,
    organizationId,
    userId,
    'No Grant Team',
  )

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Hidden Server',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/servers', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await readJson<ServersListJson>(res)
    assertEquals(body.servers, [])
    assertEquals(recordingCache.readModels.length, 0)
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(teammate).where(and(
      eq(teammate.teamId, teamId),
      eq(teammate.userId, userId),
    ))
    await db.delete(team).where(eq(team.id, teamId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
})

test('GET /servers — differing visibleIds produce different cache keys', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const readDb = createListRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
    }

    const first = await app.request('/servers', { headers })
    assertEquals(first.status, 200)
    assertEquals(recordingCache.store.size, 1)
    assertEquals(recordingCache.loadCallCount, 1)

    const now = new Date().toISOString()
    const [secondServer] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId,
        name: 'Second Server',
      })
      .returning({ id: server.id })

    const second = await app.request('/servers', { headers })
    assertEquals(second.status, 200)
    const secondBody = await readJson<ServersListJson>(second)
    assertEquals(secondBody.servers.length, 2)
    assertEquals(recordingCache.store.size, 2)
    assertEquals(recordingCache.loadCallCount, 2)

    await db.delete(server).where(eq(server.id, secondServer!.id))
  })
})

test('GET /servers — presence reflects live data, not cached value', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const readDb = createListRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
    }

    const first = await app.request('/servers', { headers })
    assertEquals(first.status, 200)
    const firstBody = await readJson<ServersListJson>(first)
    assertEquals(firstBody.servers[0].connected, false)
    assertEquals(recordingCache.loadCallCount, 1)

    await attachConnectedDaemonStatus(db, serverId)

    const second = await app.request('/servers', { headers })
    assertEquals(second.status, 200)
    const secondBody = await readJson<ServersListJson>(second)
    assertEquals(secondBody.servers[0].connected, true)
    assertEquals(recordingCache.store.size, 1)
    assertEquals(recordingCache.loadCallCount, 1)
  })
})

test('GET /servers does not return stale servers after organization grant revocation', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const readDb = createListRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
    }

    const first = await app.request('/servers', { headers })
    assertEquals(first.status, 200)
    const firstBody = await readJson<ServersListJson>(first)
    assertEquals(firstBody.servers.length, 1)
    assertEquals(firstBody.servers[0].id, serverId)
    assertEquals(recordingCache.store.size, 1)
    assertEquals(recordingCache.loadCallCount, 1)

    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
      eq(grant.entityType, 'organization'),
    ))

    const second = await app.request('/servers', { headers })
    assertEquals(second.status, 200)
    const secondBody = await readJson<ServersListJson>(second)
    assertEquals(secondBody.servers, [])
    assertEquals(recordingCache.loadCallCount, 1)
  })
})

test('GET /servers/:id returns detail with effective timezone/addresses/timeSync', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    await db
      .update(organization)
      .set({
        options: {
          defaultServerTimezone: 'UTC',
          enforceServerTimezone: false,
        },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(organization.id, organizationId))

    const existing = await db
      .select({ metadata: server.metadata, options: server.options })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    await db
      .update(server)
      .set({
        options: {
          ...((existing[0]?.options as Record<string, unknown> | null) ?? {}),
          timezone: 'America/Chicago',
        },
        metadata: {
          ...(existing[0]?.metadata ?? {}),
          resources: {
            ips: [
              { address: '10.0.0.1', version: 4, scope: 'private', interface: 'eth0' },
              { address: '203.0.113.10', version: 4, scope: 'public', interface: 'eth0' },
            ],
          },
        },
        timezone: 'America/Chicago',
        isTimeSyncEnabled: true,
        ntpServers: [{ host: 'time.cloudflare.com' }],
        updatedAt: new Date().toISOString(),
      })
      .where(eq(server.id, serverId))

    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const readDb = createDetailRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok: boolean
      server: {
        id: string
        timezone: string
        timezoneSource: string
        orgDefaultTimezone: string
        ips: Array<{ address: string; scope: string }>
        timeSync: { timezone: string }
      }
    }
    assertEquals(body.ok, true)
    assertEquals(body.server.id, serverId)
    assertEquals(body.server.timezone, 'America/Chicago')
    assertEquals(body.server.timezoneSource, 'server')
    assertEquals(body.server.orgDefaultTimezone, 'UTC')
    assertEquals(
      body.server.ips.find((ip) => ip.scope === 'public')?.address,
      '203.0.113.10',
    )
    assertEquals(body.server.timeSync.timezone, 'America/Chicago')
    assertEquals(recordingCache.readModels, ['server-detail'])
    assertEquals(readDb.selectCallCount, 1)
    const cached = recordingCache.store.values().next().value as ServerDetailRow
    assertEquals(cached.id, serverId)
    assertEquals('daemon' in cached, false)
    assertEquals('connected' in cached, false)
  })
})

test('GET /servers/:id returns statusChangedAt for offline servers', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const offlineAt = '2020-02-01T12:00:00.000Z'
    await db
      .update(server)
      .set({
        isConnected: false,
        statusChangedAt: offlineAt,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(server.id, serverId))

    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const readDb = createDetailRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok: boolean
      server: {
        connected: boolean
        connectedAt: string | null
        statusChangedAt: string | null
      }
    }
    assertEquals(body.ok, true)
    assertEquals(body.server.connected, false)
    assertEquals(body.server.connectedAt, null)
    assertEquals(
      body.server.statusChangedAt
        ? new Date(body.server.statusChangedAt).toISOString()
        : null,
      offlineAt,
    )
  })
})

test('GET /servers/:id uses daemon timeSync when no configured timezone override', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    await db
      .update(organization)
      .set({
        options: {
          defaultServerTimezone: 'UTC',
          enforceServerTimezone: false,
        },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(organization.id, organizationId))

    await db
      .update(server)
      .set({
        options: {},
        timezone: 'Europe/Berlin',
        isTimeSyncEnabled: true,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(server.id, serverId))

    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const readDb = createDetailRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app } = await createServerRoutesTestApp(db, registry, recordingCache)

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json() as {
      server: { timezone: string | null; timezoneSource: string | null }
    }
    assertEquals(body.server.timezone, 'Europe/Berlin')
    assertEquals(body.server.timezoneSource, null)
  })
})

test('PATCH /servers/:id rejects datacenterId (membership is via member pins)', async () => {
  if (!dbUrl) return

  const db = createDenoDb()
  try {
    const { app, secrets } = await createServerRoutesTestApp(db)

    const [orgA] = await db
      .insert(organization)
      .values({ name: 'Patch Server Org A' })
      .returning({ id: organization.id })

    const [u] = await db
      .insert(user)
      .values({ email: `patch-srv-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
      .returning({ id: user.id })
    const userId = u!.id

    await db.insert(grant).values({
      entityType: 'organization',
      entityId: orgA!.id,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
    })

    const now = new Date().toISOString()
    const [srv] = await db
      .insert(server)
      .values({
        organizationId: orgA!.id,
        name: 'Host',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id })

    const cookie = await sessionCookie(db, secrets, userId)

    const rejected = await app.request(`/servers/${srv!.id}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: orgA!.id,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ datacenterId: crypto.randomUUID() }),
    })
    assertEquals(rejected.status, 400)

    await db.delete(server).where(eq(server.id, srv!.id))
    await db.delete(grant).where(eq(grant.actorId, userId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, orgA!.id))
  } finally {
    await endDbConnection(db)
  }
})

test('PATCH /servers/:id does not commit hosting.enabled when hierarchy fails', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const originalEnsure = systemHierarchy.systemHierarchyProvision.ensure
    systemHierarchy.systemHierarchyProvision.ensure = () =>
      Promise.reject(new Error('forced hierarchy failure'))

    try {
      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/servers/${serverId}`, {
        method: 'PATCH',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ options: { hosting: { enabled: true } } }),
      })

      assertEquals(res.status, 500)
      const body = await readJson<ErrorJson>(res)
      assertEquals(body.code, 'hosting_hierarchy_failed')

      const [row] = await db
        .select({ options: server.options })
        .from(server)
        .where(eq(server.id, serverId))
        .limit(1)
      const options = row?.options as { hosting?: { enabled?: boolean } } | null
      assertEquals(options?.hosting?.enabled === true, false)
    } finally {
      systemHierarchy.systemHierarchyProvision.ensure = originalEnsure
    }
  })
})

test('DELETE /servers/:id succeeds after enable → disable → reconcile lifecycle', async () => {
  await withServerDeleteFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
    registry,
  }) => {
    const envelopes: Array<{ type: string; commandId: string }> = []
    const commandQueue = {
      envelopes,
      enqueue: (envelope: { type: string; commandId: string }) => {
        envelopes.push({ type: envelope.type, commandId: envelope.commandId })
        return Promise.resolve()
      },
    }
    const { app } = await createServerRoutesTestApp(
      db,
      registry,
      undefined,
      commandQueue,
    )
    const cookie = await sessionCookie(db, secrets, userId)

    // 1. Enable hosting → provisions hierarchy + reconcile enqueue.
    const enableRes = await app.request(`/servers/${serverId}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ options: { hosting: { enabled: true } } }),
    })
    assertEquals(enableRes.status, 200)

    const hierarchyEnvId = await systemHierarchy.findSystemEnvironmentForServer(
      db,
      serverId,
      systemHierarchy.SYSTEM_HOSTING_INGRESS_COMPONENT,
    )
    assertExists(hierarchyEnvId)

    const [containerRow] = await db
      .select({
        id: container.id,
        status: container.status,
      })
      .from(container)
      .innerJoin(service, eq(service.id, container.serviceId))
      .where(eq(service.environmentId, hierarchyEnvId))
      .limit(1)
    assertExists(containerRow)

    // Simulate a successful enable reconcile (proxy running).
    await db
      .update(container)
      .set({ status: 'running', containerId: 'ingress-cid-live' })
      .where(eq(container.id, containerRow.id))

    // Running ingress blocks delete.
    const blockedRes = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(blockedRes.status, 409)

    envelopes.length = 0

    // 2. Disable hosting → enqueues action: stop for hosting-ingress.
    const disableRes = await app.request(`/servers/${serverId}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ options: { hosting: { enabled: false } } }),
    })
    assertEquals(disableRes.status, 200)
    assertEquals(envelopes.length >= 1, true)
    assertEquals(envelopes[0]?.type, 'system.reconcile')

    const [stopCommand] = await db
      .select({
        id: dispatch.commandId,
        payload: dispatch.payload,
      })
      .from(dispatch)
      .where(eq(dispatch.commandId, envelopes[0]!.commandId))
      .limit(1)
    const stopPayload = stopCommand?.payload as {
      action?: string
      environmentId?: string
    } | null
    assertEquals(stopPayload?.action, 'stop')
    assertEquals(stopPayload?.environmentId, hierarchyEnvId)

    // 3. Simulate stop reconcile settling the row.
    await db
      .update(container)
      .set({ status: 'exited', containerId: null })
      .where(eq(container.id, containerRow.id))

    // 4. Delete succeeds once ingress is idle.
    const deleteRes = await app.request(`/servers/${serverId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(deleteRes.status, 200)
    const body = await deleteRes.json()
    assertEquals(body, { ok: true, serverId })

    const remainingEnvs = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.id, hierarchyEnvId))
    assertEquals(remainingEnvs.length, 0)

    // Clean shared project/workspace left by hierarchy.
    const remainingProjects = await db
      .select({ id: project.id, workspaceId: project.workspaceId })
      .from(project)
      .innerJoin(workspace, eq(workspace.id, project.workspaceId))
      .where(eq(workspace.organizationId, organizationId))
    for (const row of remainingProjects) {
      await db.delete(project).where(eq(project.id, row.id))
      await db.delete(workspace).where(eq(workspace.id, row.workspaceId))
    }
    await db.delete(command).where(eq(command.serverId, serverId))
  })
})

test('registerServerRoutes requires session secrets', () => {
  const app = new Hono<AppEnv>()
  assertThrows(
    () => registerServerRoutes(app, {
      secrets: undefined as never,
      runtime: 'deno',
      signupEnvOverride: undefined,
    }),
    TypeError,
    'session secrets are required for server routes',
  )
})

test('PATCH /servers/:id rejects an empty patch body', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    assertEquals(res.status, 400)
    const body = await readJson<ErrorJson>(res)
    assertEquals(body.error, 'Invalid request')
  })
})

test('PATCH /servers/:id updates name', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Renamed Host' }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as { ok: boolean }
    assertEquals(body.ok, true)

    const [row] = await db
      .select({ name: server.name })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    assertEquals(row?.name, 'Renamed Host')
  })
})

test('GET /servers/:id/update returns idle status for a disconnected server', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}/update`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok: boolean
      serverId: string
      status: string
      colocatedWithInstance: boolean
    }
    assertEquals(body.ok, true)
    assertEquals(body.serverId, serverId)
    assertEquals(body.colocatedWithInstance, false)
    assertEquals(typeof body.status, 'string')
  })
})

test('POST /servers/:id/update returns 404 when daemon is offline', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}/update`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 404)
    const body = await readJson<{ ok: boolean; error: string }>(res)
    assertEquals(body.ok, false)
    assertEquals(body.error, 'Daemon not connected')
  })
})

test('GET /servers/:id/labels returns an empty list then PUT replace-all', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const emptyRes = await app.request(`/servers/${serverId}/labels`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(emptyRes.status, 200)
    const emptyBody = await readJson<{ ok: boolean; labels: Array<{ key: string; value: string }> }>(
      emptyRes,
    )
    assertEquals(emptyBody.ok, true)
    assertEquals(emptyBody.labels, [])

    const putRes = await app.request(`/servers/${serverId}/labels`, {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ labels: { region: 'us-east', env: 'prod' } }),
    })
    assertEquals(putRes.status, 200)
    const putBody = await readJson<{ ok: boolean; labels: Array<{ key: string; value: string }> }>(
      putRes,
    )
    assertEquals(putBody.ok, true)
    assertEquals(putBody.labels, [
      { key: 'env', value: 'prod' },
      { key: 'region', value: 'us-east' },
    ])

    const getRes = await app.request(`/servers/${serverId}/labels`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(getRes.status, 200)
    const getBody = await readJson<{ ok: boolean; labels: Array<{ key: string; value: string }> }>(
      getRes,
    )
    assertEquals(getBody.labels, putBody.labels)
  })
})

test('PUT /servers/:id/labels returns 400 for invalid keys', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}/labels`, {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ labels: { '-nope': 'x' } }),
    })
    assertEquals(res.status, 400)
    const body = await readJson<{ error: string }>(res)
    assertEquals(body.error.includes('invalid'), true)
  })
})

test('PUT /servers/:id/labels returns 403 for a non-manager', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    organizationId,
    serverId,
  }) => {
    const email = `server-labels-reader-${crypto.randomUUID()}@example.com`
    const [insertedUser] = await db
      .insert(user)
      .values({ email, isEmailVerified: true, role: 'user' })
      .returning({ id: user.id })
    const readerId = insertedUser!.id

    try {
      const cookie = await sessionCookie(db, secrets, readerId)
      const res = await app.request(`/servers/${serverId}/labels`, {
        method: 'PUT',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ labels: { env: 'prod' } }),
      })
      assertEquals(res.status, 403)
    } finally {
      await db.delete(user).where(eq(user.id, readerId))
    }
  })
})

test('GET /servers/:id still issues exactly one cached select after labels are added', async () => {
  await withServerDeleteFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const putRes = await app.request(`/servers/${serverId}/labels`, {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ labels: { env: 'prod' } }),
    })
    assertEquals(putRes.status, 200)

    const registry = createTrackingRegistry({
      getCellThrows: true,
      getSnapshotsThrows: true,
      listOnlineServerIdsThrows: true,
    })
    const readDb = createDetailRowsOnlyReadDb(db)
    const recordingCache = createRecordingQueryCache(readDb)
    const { app: detailApp } = await createServerRoutesTestApp(db, registry, recordingCache)

    const res = await detailApp.request(`/servers/${serverId}`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await readJson<{
      ok: boolean
      server: { id: string; labels: Array<{ key: string; value: string }> }
    }>(res)
    assertEquals(body.ok, true)
    assertEquals(body.server.id, serverId)
    assertEquals(body.server.labels, [{ key: 'env', value: 'prod' }])
    assertEquals(recordingCache.readModels, ['server-detail'])
    assertEquals(readDb.selectCallCount, 1)
  })
})
