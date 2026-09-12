import { assertEquals } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../authn/secrets.ts'
import {
  datacenter,
  fabric,
  grant,
  network,
  organization,
  server,
  user,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerNetworkRoutes } from './routes.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`
}

async function createNetworkRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  return { app, secrets }
}

async function withNetworkFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping network route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createNetworkRoutesTestApp(db)

  const [org] = await db
    .insert(organization)
    .values({ name: 'Network Route Fixture Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id

  const [u] = await db
    .insert(user)
    .values({
      email: `net-fixture-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  try {
    await fn({ db, app, secrets, userId, organizationId })
  } finally {
    await db.delete(fabric).where(eq(fabric.organizationId, organizationId))
    await db.delete(network).where(eq(network.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(datacenter).where(eq(datacenter.organizationId, organizationId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('POST /networks requires dockerNetworkName for kind=docker', async () => {
  if (!dbUrl) {
    console.warn('Skipping network route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'Docker Net Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `docker-net-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const cookie = await sessionCookie(db, secrets, userId)
  const missing = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'docker',
      options: {},
    }),
  })
  assertEquals(missing.status, 400)
  assertEquals((await missing.json() as { error: string }).error, 'docker_network_name_required')

  const created = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'docker',
      options: { dockerNetworkName: '  turbopanel-shared  ' },
    }),
  })
  assertEquals(created.status, 200)
  const createdBody = await created.json() as { ok: true; id: string }
  assertEquals(createdBody.ok, true)

  await db.delete(network).where(eq(network.id, createdBody.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('POST /networks rejects datacenterId and serverId together', async () => {
  if (!dbUrl) {
    console.warn('Skipping network route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'Net Test Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `net-test-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const now = new Date().toISOString()
  const [dc] = await db
    .insert(datacenter)
    .values({ organizationId, name: 'DC1', createdAt: now, updatedAt: now })
    .returning({ id: datacenter.id })
  const [srv] = await db
    .insert(server)
    .values({ organizationId, name: 'Host1', createdAt: now, updatedAt: now })
    .returning({ id: server.id })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'docker',
      datacenterId: dc!.id,
      serverId: srv!.id,
      options: { dockerNetworkName: 'shared' },
    }),
  })

  assertEquals(res.status, 400)
  const body = await res.json() as { error: string }
  assertEquals(body.error, 'network_single_scope_conflict')

  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(datacenter).where(eq(datacenter.id, dc!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('POST /networks rejects kind=vpn and requires per-kind scope FKs', async () => {
  if (!dbUrl) {
    console.warn('Skipping network route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'Net Scope Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `net-scope-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const now = new Date().toISOString()
  const [dc] = await db
    .insert(datacenter)
    .values({ organizationId, name: 'DC1', createdAt: now, updatedAt: now })
    .returning({ id: datacenter.id })
  const [srv] = await db
    .insert(server)
    .values({ organizationId, name: 'Host1', createdAt: now, updatedAt: now })
    .returning({ id: server.id })

  const cookie = await sessionCookie(db, secrets, userId)

  const vpnKind = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'vpn',
      cidr: '203.0.113.0/24',
    }),
  })
  assertEquals(vpnKind.status, 400)

  const missingDc = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'datacenter',
    }),
  })
  assertEquals(missingDc.status, 400)
  assertEquals((await missingDc.json() as { error: string }).error, 'network_scope_required')

  const missingCidr = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'datacenter',
      datacenterId: dc!.id,
    }),
  })
  assertEquals(missingCidr.status, 400)
  assertEquals((await missingCidr.json() as { error: string }).error, 'network_cidr_required')

  const missingServer = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'server',
    }),
  })
  assertEquals(missingServer.status, 400)

  const dockerWithServer = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'docker',
      serverId: srv!.id,
      options: { dockerNetworkName: 'turbopanel-shared' },
    }),
  })
  assertEquals(dockerWithServer.status, 200)
  const dockerBody = await dockerWithServer.json() as { ok: true; id: string }
  await db.delete(network).where(eq(network.id, dockerBody.id))

  const dockerWithDc = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'docker',
      datacenterId: dc!.id,
      options: { dockerNetworkName: 'turbopanel-shared' },
    }),
  })
  assertEquals(dockerWithDc.status, 400)
  assertEquals((await dockerWithDc.json() as { error: string }).error, 'network_single_scope_conflict')

  const okDc = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'datacenter',
      datacenterId: dc!.id,
      cidr: '10.0.0.0/24',
    }),
  })
  assertEquals(okDc.status, 200)
  const okDcBody = await okDc.json() as { ok: true; id: string }

  await db.delete(network).where(eq(network.id, okDcBody.id))
  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(datacenter).where(eq(datacenter.id, dc!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('GET /networks returns 403 for org member without organization:manage', async () => {
  if (!dbUrl) {
    console.warn('Skipping network route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'Net List Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `net-list-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id


  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request('/networks', {
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  })

  assertEquals(res.status, 403)

  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('GET /networks lists networks and applies kind and scope filters', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Filter DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [srv] = await db
      .insert(server)
      .values({ organizationId, name: 'Filter Host', createdAt: now, updatedAt: now })
      .returning({ id: server.id })

    const [dcNet] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.0.0.0/24',
        name: 'DC LAN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })
    const [dockerNet] = await db
      .insert(network)
      .values({
        organizationId,
        serverId: srv!.id,
        kind: 'docker',
        name: 'Host Docker',
        options: { dockerNetworkName: 'turbopanel-filter' },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = { cookie, [ORG_ID_HEADER]: organizationId }

    const all = await app.request('/networks', { headers })
    assertEquals(all.status, 200)
    const allBody = await all.json() as { networks: Array<{ id: string }> }
    assertEquals(allBody.networks.length, 2)

    const dockerOnly = await app.request('/networks?kind=docker', { headers })
    assertEquals(dockerOnly.status, 200)
    const dockerBody = await dockerOnly.json() as { networks: Array<{ id: string }> }
    assertEquals(dockerBody.networks.map((row) => row.id), [dockerNet!.id])

    const byDc = await app.request(`/networks?datacenterId=${dc!.id}`, { headers })
    assertEquals(byDc.status, 200)
    const dcBody = await byDc.json() as { networks: Array<{ id: string }> }
    assertEquals(dcBody.networks.map((row) => row.id), [dcNet!.id])

    const byServer = await app.request(`/networks?serverId=${srv!.id}`, { headers })
    assertEquals(byServer.status, 200)
    const serverBody = await byServer.json() as { networks: Array<{ id: string }> }
    assertEquals(serverBody.networks.map((row) => row.id), [dockerNet!.id])
  })
})

test('GET /networks returns 404 when datacenterId belongs to another org', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const [localDc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Local DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [localNet] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: localDc!.id,
        kind: 'datacenter',
        cidr: '10.9.0.0/24',
        name: 'Local LAN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Foreign Net Org' })
      .returning({ id: organization.id })
    const [foreignDc] = await db
      .insert(datacenter)
      .values({
        organizationId: otherOrg!.id,
        name: 'Foreign DC',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/networks?datacenterId=${foreignDc!.id}`, {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(res.status, 404)

    await db.delete(network).where(eq(network.id, localNet!.id))
    await db.delete(datacenter).where(eq(datacenter.id, localDc!.id))
    await db.delete(datacenter).where(eq(datacenter.id, foreignDc!.id))
    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})

test('GET /networks/:id returns network detail', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Detail DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [netRow] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.1.0.0/24',
        name: 'Detail LAN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/networks/${netRow!.id}`, {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(res.status, 200)
    const body = await res.json() as {
      network: { id: string; name: string; cidr: string; kind: string }
    }
    assertEquals(body.network.id, netRow!.id)
    assertEquals(body.network.name, 'Detail LAN')
    assertEquals(body.network.cidr, '10.1.0.0/24')
    assertEquals(body.network.kind, 'datacenter')
  })
})

test('GET /networks/:id returns 404 for network in another org', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Foreign Detail Org' })
      .returning({ id: organization.id })
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId: otherOrg!.id,
        name: 'Foreign Detail DC',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id })
    const [netRow] = await db
      .insert(network)
      .values({
        organizationId: otherOrg!.id,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.2.0.0/24',
        name: 'Foreign LAN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/networks/${netRow!.id}`, {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(res.status, 404)

    await db.delete(network).where(eq(network.id, netRow!.id))
    await db.delete(datacenter).where(eq(datacenter.id, dc!.id))
    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})

test('PATCH /networks/:id updates name and cidr', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Patch DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [netRow] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.3.0.0/24',
        name: 'Before',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/networks/${netRow!.id}`, {
      method: 'PATCH',
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'After', cidr: '10.3.1.0/24' }),
    })
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { ok: true })

    const [row] = await db
      .select({ name: network.name, cidr: network.cidr })
      .from(network)
      .where(eq(network.id, netRow!.id))
      .limit(1)
    assertEquals(row?.name, 'After')
    assertEquals(row?.cidr, '10.3.1.0/24')
  })
})

test('PATCH /networks/:id rejects immutable scope fields', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Immutable DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [netRow] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.4.0.0/24',
        name: 'Immutable LAN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/networks/${netRow!.id}`, {
      method: 'PATCH',
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ datacenterId: dc!.id }),
    })
    assertEquals(res.status, 400)
  })
})

test('DELETE /networks/:id removes network', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Delete DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [netRow] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.5.0.0/24',
        name: 'Delete LAN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/networks/${netRow!.id}`, {
      method: 'DELETE',
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { ok: true })

    const rows = await db
      .select({ id: network.id })
      .from(network)
      .where(eq(network.id, netRow!.id))
    assertEquals(rows.length, 0)
  })
})

test('POST /networks returns 403 when organizationId is not accessible', async () => {
  await withNetworkFixtures(async ({
    app,
    db,
    secrets,
    userId,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Inaccessible Net Org' })
      .returning({ id: organization.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/networks', {
      method: 'POST',
      headers: {
        cookie,
        [ORG_ID_HEADER]: otherOrg!.id,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId: otherOrg!.id,
        kind: 'docker',
        options: { dockerNetworkName: 'foreign-net' },
      }),
    })
    assertEquals(res.status, 403)

    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})

test('POST /networks returns 404 when datacenterId belongs to another org', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Cross Org Net Org' })
      .returning({ id: organization.id })
    const now = new Date().toISOString()
    const [foreignDc] = await db
      .insert(datacenter)
      .values({
        organizationId: otherOrg!.id,
        name: 'Cross Org DC',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/networks', {
      method: 'POST',
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId,
        kind: 'datacenter',
        datacenterId: foreignDc!.id,
      }),
    })
    assertEquals(res.status, 404)

    await db.delete(datacenter).where(eq(datacenter.id, foreignDc!.id))
    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})

test('GET /networks?kind=managed lists the platform-allocated managed network', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Managed DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    await db.insert(network).values({
      organizationId,
      datacenterId: dc!.id,
      kind: 'datacenter',
      cidr: '10.9.0.0/24',
      name: 'Managed Site LAN',
      createdAt: now,
      updatedAt: now,
    })
    const [managedNet] = await db
      .insert(network)
      .values({
        organizationId,
        kind: 'managed',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })
    await db
      .update(network)
      .set({ options: { dockerNetworkName: managedNet!.id } })
      .where(eq(network.id, managedNet!.id))

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = { cookie, [ORG_ID_HEADER]: organizationId }

    const res = await app.request('/networks?kind=managed', { headers })
    assertEquals(res.status, 200)
    const body = await res.json() as {
      networks: Array<{ id: string; kind: string; options: Record<string, unknown> }>
    }
    assertEquals(body.networks.map((row) => row.id), [managedNet!.id])
    assertEquals(body.networks[0]?.kind, 'managed')
    assertEquals(body.networks[0]?.options, { dockerNetworkName: managedNet!.id })
  })
})

test('POST /networks rejects kind=managed', async () => {
  await withNetworkFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/networks', {
      method: 'POST',
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ organizationId, kind: 'managed' }),
    })
    assertEquals(res.status, 400)
    assertEquals((await res.json() as { error: string }).error, 'Invalid request')
  })
})

test('PATCH /networks/:id refuses every patch on a managed network', async () => {
  await withNetworkFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const now = new Date().toISOString()
    const [managedNet] = await db
      .insert(network)
      .values({ organizationId, kind: 'managed', createdAt: now, updatedAt: now })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const patches: Record<string, unknown>[] = [
      { options: { dockerNetworkName: 'operator-supplied' } },
      { name: 'Operator rename' },
      { cidr: '10.42.0.0/24' },
      { metadata: { note: 'operator' } },
    ]
    for (const patch of patches) {
      const res = await app.request(`/networks/${managedNet!.id}`, {
        method: 'PATCH',
        headers: {
          cookie,
          [ORG_ID_HEADER]: organizationId,
          'content-type': 'application/json',
        },
        body: JSON.stringify(patch),
      })
      assertEquals(res.status, 400)
      assertEquals(
        (await res.json() as { error: string }).error,
        'managed_network_immutable',
      )
    }

    const [unchanged] = await db
      .select({ name: network.name, cidr: network.cidr, options: network.options })
      .from(network)
      .where(eq(network.id, managedNet!.id))
      .limit(1)
    assertEquals(unchanged?.name, null)
    assertEquals(unchanged?.cidr, null)
  })
})

test('DELETE /networks/:id refuses a managed network', async () => {
  await withNetworkFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const now = new Date().toISOString()
    const [managedNet] = await db
      .insert(network)
      .values({ organizationId, kind: 'managed', createdAt: now, updatedAt: now })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/networks/${managedNet!.id}`, {
      method: 'DELETE',
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(res.status, 400)
    assertEquals(
      (await res.json() as { error: string }).error,
      'managed_network_immutable',
    )

    const [still] = await db
      .select({ id: network.id })
      .from(network)
      .where(eq(network.id, managedNet!.id))
      .limit(1)
    assertEquals(still?.id, managedNet!.id)
  })
})

function jsonHeaders(cookie: string, organizationId: string) {
  return {
    cookie,
    [ORG_ID_HEADER]: organizationId,
    'content-type': 'application/json',
  }
}

test('POST /networks creates a reserved range, lists it by kind and keeps it org-only', async () => {
  await withNetworkFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = jsonHeaders(cookie, organizationId)

    const created = await app.request('/networks', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        organizationId,
        kind: 'reserved',
        cidr: '10.100.0.0/16',
        name: 'Corp VPN - Chicago branch',
      }),
    })
    assertEquals(created.status, 200)
    const { id } = await created.json() as { ok: true; id: string }

    const [row] = await db
      .select({
        kind: network.kind,
        cidr: network.cidr,
        name: network.name,
        datacenterId: network.datacenterId,
        serverId: network.serverId,
      })
      .from(network)
      .where(eq(network.id, id))
      .limit(1)
    assertEquals(row, {
      kind: 'reserved',
      cidr: '10.100.0.0/16',
      name: 'Corp VPN - Chicago branch',
      datacenterId: null,
      serverId: null,
    })

    const listed = await app.request('/networks?kind=reserved', { headers })
    assertEquals(listed.status, 200)
    const { networks } = await listed.json() as { networks: { id: string; kind: string }[] }
    assertEquals(networks.map((n) => [n.id, n.kind]), [[id, 'reserved']])

    // A reserved range exists because of its CIDR.
    const noCidr = await app.request('/networks', {
      method: 'POST',
      headers,
      body: JSON.stringify({ organizationId, kind: 'reserved', name: 'No range' }),
    })
    assertEquals(noCidr.status, 400)
    assertEquals(await noCidr.json(), { error: 'network_cidr_required' })

    // … and is never scoped to a datacenter or a host.
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Reserved DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [srv] = await db
      .insert(server)
      .values({ organizationId, name: 'Reserved Host', createdAt: now, updatedAt: now })
      .returning({ id: server.id })
    for (const scope of [{ datacenterId: dc!.id }, { serverId: srv!.id }]) {
      const scoped = await app.request('/networks', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          organizationId,
          kind: 'reserved',
          cidr: '10.101.0.0/16',
          ...scope,
        }),
      })
      assertEquals(scoped.status, 400)
      assertEquals(await scoped.json(), { error: 'network_single_scope_conflict' })
    }
  })
})

test('POST /networks routes every CIDR write through the collision authority', async () => {
  await withNetworkFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = jsonHeaders(cookie, organizationId)
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Collision DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [otherDc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Other DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    await db.insert(fabric).values({
      organizationId,
      cidr: '10.250.0.0/16',
      options: { containerPool: '10.192.0.0/12' },
    })
    const [reserved] = await db
      .insert(network)
      .values({
        organizationId,
        kind: 'reserved',
        cidr: '10.100.0.0/16',
        name: 'Corp VPN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })
    const [bridge] = await db
      .insert(network)
      .values({
        organizationId,
        kind: 'docker',
        cidr: '172.18.0.0/16',
        options: { dockerNetworkName: 'bridge-shared' },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })
    const [otherSite] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: otherDc!.id,
        kind: 'datacenter',
        cidr: '10.20.0.0/24',
        name: 'other-lan',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const post = (body: Record<string, unknown>) =>
      app.request('/networks', {
        method: 'POST',
        headers,
        body: JSON.stringify({ organizationId, ...body }),
      })

    const fabricHit = await post({ kind: 'datacenter', datacenterId: dc!.id, cidr: '10.250.9.0/24' })
    assertEquals(fabricHit.status, 409)
    assertEquals(await fabricHit.json(), {
      error: 'cidr_overlaps_fabric',
      cidr: '10.250.9.0/24',
      conflictingCidr: '10.250.0.0/16',
    })

    const poolHit = await post({ kind: 'reserved', cidr: '10.200.0.0/16' })
    assertEquals(poolHit.status, 409)
    assertEquals(await poolHit.json(), {
      error: 'cidr_overlaps_fabric_pool',
      cidr: '10.200.0.0/16',
      conflictingCidr: '10.192.0.0/12',
    })

    const reservedHit = await post({ kind: 'datacenter', datacenterId: dc!.id, cidr: '10.100.7.0/24' })
    assertEquals(reservedHit.status, 409)
    assertEquals(await reservedHit.json(), {
      error: 'cidr_overlaps_reserved',
      cidr: '10.100.7.0/24',
      conflictingCidr: '10.100.0.0/16',
      networkId: reserved!.id,
    })

    const dockerHit = await post({ kind: 'reserved', cidr: '172.18.0.0/20' })
    assertEquals(dockerHit.status, 409)
    assertEquals(await dockerHit.json(), {
      error: 'cidr_overlaps_docker_network',
      cidr: '172.18.0.0/20',
      conflictingCidr: '172.18.0.0/16',
      networkId: bridge!.id,
    })

    const siteHit = await post({ kind: 'datacenter', datacenterId: dc!.id, cidr: '10.20.0.128/25' })
    assertEquals(siteHit.status, 409)
    assertEquals(await siteHit.json(), {
      error: 'subnet_overlaps',
      cidr: '10.20.0.128/25',
      conflictingCidr: '10.20.0.0/24',
      networkId: otherSite!.id,
      datacenterId: otherDc!.id,
    })

    // A docker registration with a CIDR is checked the same way.
    const dockerVsReserved = await post({
      kind: 'docker',
      cidr: '10.100.200.0/24',
      options: { dockerNetworkName: 'bridge-two' },
    })
    assertEquals(dockerVsReserved.status, 409)
    assertEquals((await dockerVsReserved.json() as { error: string }).error, 'cidr_overlaps_reserved')

    // A free range still lands.
    const free = await post({ kind: 'datacenter', datacenterId: dc!.id, cidr: '10.30.0.0/24' })
    assertEquals(free.status, 200)
  })
})

test('PATCH /networks/:id re-ranges a reserved row and excludes itself from the collision check', async () => {
  await withNetworkFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = jsonHeaders(cookie, organizationId)
    const now = new Date().toISOString()
    const [reserved] = await db
      .insert(network)
      .values({
        organizationId,
        kind: 'reserved',
        cidr: '10.100.0.0/16',
        name: 'Before',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })
    const [otherReserved] = await db
      .insert(network)
      .values({
        organizationId,
        kind: 'reserved',
        cidr: '10.120.0.0/16',
        name: 'Transit',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const patch = (body: Record<string, unknown>) =>
      app.request(`/networks/${reserved!.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      })

    // Rename + re-submit the same CIDR: the row never collides with itself.
    const same = await patch({ name: 'After', cidr: '10.100.0.0/16' })
    assertEquals(same.status, 200)
    assertEquals(await same.json(), { ok: true })

    // Narrowing is fine for the same reason.
    const narrowed = await patch({ cidr: '10.100.8.0/24' })
    assertEquals(narrowed.status, 200)

    const [row] = await db
      .select({ name: network.name, cidr: network.cidr })
      .from(network)
      .where(eq(network.id, reserved!.id))
      .limit(1)
    assertEquals(row, { name: 'After', cidr: '10.100.8.0/24' })

    // Another row is still a hard fail …
    const collide = await patch({ cidr: '10.120.4.0/24' })
    assertEquals(collide.status, 409)
    assertEquals(await collide.json(), {
      error: 'cidr_overlaps_reserved',
      cidr: '10.120.4.0/24',
      conflictingCidr: '10.120.0.0/16',
      networkId: otherReserved!.id,
    })

    // … and a reserved range cannot lose its CIDR.
    const cleared = await patch({ cidr: null })
    assertEquals(cleared.status, 400)
    assertEquals(await cleared.json(), { error: 'network_cidr_required' })
  })
})

test('POST /networks kind=docker keeps cidr and options.subnet in agreement', async () => {
  await withNetworkFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = jsonHeaders(cookie, organizationId)
    const post = (body: Record<string, unknown>) =>
      app.request('/networks', {
        method: 'POST',
        headers,
        body: JSON.stringify({ organizationId, kind: 'docker', ...body }),
      })
    const stored = async (id: string) => {
      const [row] = await db
        .select({ cidr: network.cidr, options: network.options })
        .from(network)
        .where(eq(network.id, id))
        .limit(1)
      return row
    }

    // options.subnet alone → cidr derived.
    const fromSubnet = await post({
      options: {
        dockerNetworkName: 'edge-a',
        subnet: '10.77.0.0/16',
        ipRange: '10.77.8.0/24',
        gateway: '10.77.0.1',
        mtu: 1450,
      },
    })
    assertEquals(fromSubnet.status, 200)
    const a = await fromSubnet.json() as { id: string }
    assertEquals(await stored(a.id), {
      cidr: '10.77.0.0/16',
      options: {
        dockerNetworkName: 'edge-a',
        subnet: '10.77.0.0/16',
        ipRange: '10.77.8.0/24',
        gateway: '10.77.0.1',
        mtu: 1450,
      },
    })

    // cidr alone → options.subnet derived.
    const fromCidr = await post({ cidr: '10.78.0.0/16', options: { dockerNetworkName: 'edge-b' } })
    assertEquals(fromCidr.status, 200)
    const b = await fromCidr.json() as { id: string }
    assertEquals(await stored(b.id), {
      cidr: '10.78.0.0/16',
      options: { dockerNetworkName: 'edge-b', subnet: '10.78.0.0/16' },
    })

    // Top-level cidr anchors ipRange / gateway without an explicit
    // options.subnet — the derived subnet is what they are validated against.
    const cidrAnchored = await post({
      cidr: '10.83.0.0/16',
      options: { dockerNetworkName: 'edge-f', ipRange: '10.83.8.0/24', gateway: '10.83.0.1' },
    })
    assertEquals(cidrAnchored.status, 200)
    const f = await cidrAnchored.json() as { id: string }
    assertEquals(await stored(f.id), {
      cidr: '10.83.0.0/16',
      options: {
        dockerNetworkName: 'edge-f',
        subnet: '10.83.0.0/16',
        ipRange: '10.83.8.0/24',
        gateway: '10.83.0.1',
      },
    })
    const outsideCidr = await post({
      cidr: '10.84.0.0/16',
      options: { dockerNetworkName: 'edge-g', gateway: '10.85.0.1' },
    })
    assertEquals(outsideCidr.status, 400)
    assertEquals(await outsideCidr.json(), { error: 'docker_network_gateway_invalid' })

    // A disagreeing pair is refused.
    const mismatch = await post({
      cidr: '10.79.0.0/16',
      options: { dockerNetworkName: 'edge-c', subnet: '10.80.0.0/16' },
    })
    assertEquals(mismatch.status, 400)
    assertEquals(await mismatch.json(), { error: 'docker_network_subnet_mismatch' })

    // Addressing validation reports the offending key.
    const badRange = await post({
      options: { dockerNetworkName: 'edge-d', subnet: '10.81.0.0/16', ipRange: '10.82.0.0/24' },
    })
    assertEquals(badRange.status, 400)
    assertEquals(await badRange.json(), { error: 'docker_network_ip_range_invalid' })

    // The derived cidr still runs the collision authority.
    const collide = await post({
      options: { dockerNetworkName: 'edge-e', subnet: '10.77.8.0/24' },
    })
    assertEquals(collide.status, 409)
    assertEquals((await collide.json() as { error: string }).error, 'cidr_overlaps_docker_network')
  })
})

test('PATCH /networks/:id kind=docker reconciles cidr and options.subnet against the stored row', async () => {
  await withNetworkFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = jsonHeaders(cookie, organizationId)
    const now = new Date().toISOString()
    const [row] = await db
      .insert(network)
      .values({
        organizationId,
        kind: 'docker',
        cidr: '10.77.0.0/16',
        options: {
          dockerNetworkName: 'edge',
          subnet: '10.77.0.0/16',
          ipRange: '10.77.8.0/24',
          gateway: '10.77.0.1',
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })
    const id = row!.id
    const patch = (body: Record<string, unknown>) =>
      app.request(`/networks/${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
    const stored = async () => {
      const [current] = await db
        .select({ cidr: network.cidr, options: network.options })
        .from(network)
        .where(eq(network.id, id))
        .limit(1)
      return current
    }

    // Re-stating the row's own range never collides with itself.
    const same = await patch({ cidr: '10.77.0.0/16' })
    assertEquals(same.status, 200)

    // Clearing the range while ipRange/gateway remain is refused.
    const dangling = await patch({ cidr: null })
    assertEquals(dangling.status, 400)
    assertEquals(await dangling.json(), { error: 'docker_network_subnet_required' })

    // A cidr-only re-range keeps the stored name, re-derives options.subnet,
    // and refuses to carry a now-stale ipRange.
    const stale = await patch({ cidr: '10.90.0.0/16' })
    assertEquals(stale.status, 400)
    assertEquals(await stale.json(), { error: 'docker_network_ip_range_invalid' })

    // An options-only patch may re-state ipRange / gateway against the stored
    // cidr without carrying options.subnet — the stored range anchors them.
    const relyOnStored = await patch({
      options: { dockerNetworkName: 'edge', ipRange: '10.77.16.0/24', gateway: '10.77.0.2' },
    })
    assertEquals(relyOnStored.status, 200)
    assertEquals(await stored(), {
      cidr: '10.77.0.0/16',
      options: {
        dockerNetworkName: 'edge',
        subnet: '10.77.0.0/16',
        ipRange: '10.77.16.0/24',
        gateway: '10.77.0.2',
      },
    })
    const outsideStored = await patch({
      options: { dockerNetworkName: 'edge', gateway: '10.78.0.1' },
    })
    assertEquals(outsideStored.status, 400)
    assertEquals(await outsideStored.json(), { error: 'docker_network_gateway_invalid' })

    // An options-only patch without subnet keeps the stored cidr.
    const optionsOnly = await patch({ options: { dockerNetworkName: 'edge', mtu: 1400 } })
    assertEquals(optionsOnly.status, 200)
    assertEquals(await stored(), {
      cidr: '10.77.0.0/16',
      options: { dockerNetworkName: 'edge', subnet: '10.77.0.0/16', mtu: 1400 },
    })

    // Now a cidr-only re-range lands and mirrors into options.subnet.
    const reranged = await patch({ cidr: '10.90.0.0/16' })
    assertEquals(reranged.status, 200)
    assertEquals(await stored(), {
      cidr: '10.90.0.0/16',
      options: { dockerNetworkName: 'edge', subnet: '10.90.0.0/16', mtu: 1400 },
    })

    // Clearing works once nothing depends on the subnet.
    const cleared = await patch({ cidr: null })
    assertEquals(cleared.status, 200)
    assertEquals(await stored(), {
      cidr: null,
      options: { dockerNetworkName: 'edge', mtu: 1400 },
    })
  })
})
