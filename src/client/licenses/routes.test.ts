import { assertEquals } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import type { DaemonCell, DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../authn/secrets.ts'
import {
  COLOCATED_SERVER_DISPLAY_NAME,
  colocatedLicenseRevokeError,
} from '../authn/install-state.ts'
import {
  container,
  environment,
  grant,
  license,
  organization,
  project,
  server,
  service,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import { DISPLAY_NAME_MAX_LENGTH } from '../../lib/display-name-format.ts'
import { ensureSelfHostSystemHierarchy } from '../system/hierarchy.ts'
import { registerLicenseRoutes } from './routes.ts'
import { registerServerRoutes } from '../servers/routes.ts'
import { ORG_ID_HEADER } from '../org-context.ts'

import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

function createPermissiveRegistry(): DaemonCellRegistry {
  const noop = async () => {}
  const cell = { purge: noop } as unknown as DaemonCell
  return {
    getCell: () => cell,
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: noop,
  }
}

function createOnlineRegistry(serverIds: string[]): DaemonCellRegistry {
  return {
    getCell: () => {
      throw new Error('getCell must not be called from license revoke tests')
    },
    listOnlineServerIds: () => Promise.resolve(serverIds),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  }
}

async function createLicenseTestApp(
  db: ReturnType<typeof createDenoDb>,
  registry?: DaemonCellRegistry,
) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (registry) c.set('daemonCellRegistry', registry)
    return next()
  })
  registerLicenseRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  registerServerRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  return { app, secrets }
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

function orgRequestHeaders(
  cookie: string,
  organizationId: string,
): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: organizationId,
  }
}

function postLicense(
  app: Hono<AppEnv>,
  cookie: string,
  organizationId: string,
  body: unknown,
) {
  return app.request('/licenses', {
    method: 'POST',
    headers: {
      ...orgRequestHeaders(cookie, organizationId),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function withTestFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    managerId: string
    organizationId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping license route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createLicenseTestApp(db)

  const managerEmail = `license-route-manager-${crypto.randomUUID()}@example.com`

  const insertedOrg = await db
    .insert(organization)
    .values({ name: 'License Route Test Org' })
    .returning({ id: organization.id })

  const organizationId = insertedOrg[0]!.id

  const insertedManager = await db
    .insert(user)
    .values({ email: managerEmail, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })

  const managerId = insertedManager[0]!.id


  // The acting user is only an organization *manager*, never an owner.
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: managerId,
    permission: 'organization:manage',
  })

  try {
    await fn({ db, app, secrets, managerId, organizationId })
  } finally {
    await db.delete(license).where(eq(license.organizationId, organizationId))
    await db.delete(grant).where(eq(grant.entityId, organizationId))
    await db.delete(user).where(eq(user.id, managerId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

async function withOwnerFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    ownerId: string
    organizationId: string
  }) => Promise<void>,
  options?: { registry?: DaemonCellRegistry },
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping license route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createLicenseTestApp(db, options?.registry)

  const ownerEmail = `license-route-owner-${crypto.randomUUID()}@example.com`

  const insertedOrg = await db
    .insert(organization)
    .values({ name: 'License Route Owner Org' })
    .returning({ id: organization.id })

  const organizationId = insertedOrg[0]!.id

  const insertedOwner = await db
    .insert(user)
    .values({ email: ownerEmail, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })

  const ownerId = insertedOwner[0]!.id


  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: ownerId,
    permission: 'organization:own',
  })

  try {
    await fn({ db, app, secrets, ownerId, organizationId })
  } finally {
    await db.delete(license).where(eq(license.organizationId, organizationId))
    await db.delete(grant).where(eq(grant.entityId, organizationId))
    await db.delete(user).where(eq(user.id, ownerId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('POST /licenses is forbidden for an organization manager', async () => {
  await withTestFixtures(async ({ db, app, secrets, managerId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, managerId)
    const res = await app.request('/licenses', {
      method: 'POST',
      headers: {
        ...orgRequestHeaders(cookie, organizationId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    if (res.status !== 403) {
      throw new Error(`expected 403 creating a license as org manager, got ${res.status}`)
    }

    const rows = await db
      .select({ id: license.id })
      .from(license)
      .where(eq(license.organizationId, organizationId))
    if (rows.length !== 0) {
      throw new Error('org manager must not be able to create a license')
    }
  })
})

test('DELETE /licenses/:id is forbidden for an organization manager', async () => {
  await withTestFixtures(async ({ db, app, secrets, managerId, organizationId }) => {
    const [existingLicense] = await db
      .insert(license)
      .values({ organizationId, token: `test-hash-${crypto.randomUUID()}` })
      .returning({ id: license.id })

    const cookie = await sessionCookie(db, secrets, managerId)
    const res = await app.request(`/licenses/${existingLicense!.id}`, {
      method: 'DELETE',
      headers: orgRequestHeaders(cookie, organizationId),
    })

    if (res.status !== 403) {
      throw new Error(`expected 403 revoking a license as org manager, got ${res.status}`)
    }

    const rows = await db
      .select({ revokedAt: license.revokedAt })
      .from(license)
      .where(and(
        eq(license.id, existingLicense!.id),
        eq(license.organizationId, organizationId),
      ))
      .limit(1)
    if (rows[0]?.revokedAt) {
      throw new Error('org manager must not be able to revoke a license')
    }
  })
})

test('DELETE /licenses/:id returns 403 for license bound to self-host-pinned server', async () => {
  await withOwnerFixtures(async ({ db, app, secrets, ownerId, organizationId }) => {
    const now = new Date().toISOString()
    const [insertedServer] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId,
        name: 'Self-host pinned',
      })
      .returning({ id: server.id })
    const serverId = insertedServer!.id

    await ensureSelfHostSystemHierarchy(db, { organizationId, serverId })

    // Distinct display name so protection comes only from the durable pin
    // (no registry, no disk credentials, not the reserved "this server" name).
    const [insertedLicense] = await db
      .insert(license)
      .values({
        organizationId,
        serverId,
        name: 'bound-to-self-host',
        token: `pin-hash-${crypto.randomUUID()}`,
      })
      .returning({ id: license.id })
    const licenseId = insertedLicense!.id

    try {
      const cookie = await sessionCookie(db, secrets, ownerId)
      const res = await app.request(`/licenses/${licenseId}`, {
        method: 'DELETE',
        headers: orgRequestHeaders(cookie, organizationId),
      })

      assertEquals(res.status, 403)
      const body = await res.json() as { error?: string }
      assertEquals(body.error, colocatedLicenseRevokeError())

      const rows = await db
        .select({ revokedAt: license.revokedAt })
        .from(license)
        .where(eq(license.id, licenseId))
        .limit(1)
      assertEquals(rows[0]?.revokedAt ?? null, null)
    } finally {
      await db.delete(license).where(eq(license.id, licenseId))
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
      await db.delete(server).where(eq(server.id, serverId))
    }
  })
})

test('DELETE /licenses/:id still 403 for reserved display-name when registry is present', async () => {
  if (!dbUrl) {
    console.warn('Skipping license route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const now = new Date().toISOString()
  const insertedOrg = await db
    .insert(organization)
    .values({ name: 'Registry and Display-Name Protect Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg[0]!.id

  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Colocated via registry',
      isConnected: true,
      statusChangedAt: now,
      daemon: {
        key: {
          id: crypto.randomUUID(),
          algorithm: 'Ed25519',
          publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'registry-test' },
          fingerprint: `fp-${crypto.randomUUID()}`,
          createdAt: now,
        },
        projection: { remoteAddress: '__direct__' },
      },
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  // Active registry-bound license (different display name) — without the
  // accumulate-all-sources fix, resolving this id would short-circuit and leave
  // the reserved "this server" seat revocable.
  const [registryBound] = await db
    .insert(license)
    .values({
      organizationId,
      serverId,
      name: 'registry-bound',
      token: `registry-hash-${crypto.randomUUID()}`,
    })
    .returning({ id: license.id })

  const [reserved] = await db
    .insert(license)
    .values({
      organizationId,
      name: COLOCATED_SERVER_DISPLAY_NAME,
      token: `reserved-hash-${crypto.randomUUID()}`,
    })
    .returning({ id: license.id })
  const reservedId = reserved!.id

  const insertedOwner = await db
    .insert(user)
    .values({
      email: `license-registry-display-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const ownerId = insertedOwner[0]!.id
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: ownerId,
    permission: 'organization:own',
  })

  const { app, secrets } = await createLicenseTestApp(
    db,
    createOnlineRegistry([serverId]),
  )

  try {
    const cookie = await sessionCookie(db, secrets, ownerId)
    const res = await app.request(`/licenses/${reservedId}`, {
      method: 'DELETE',
      headers: orgRequestHeaders(cookie, organizationId),
    })

    assertEquals(res.status, 403)
    const body = await res.json() as { error?: string }
    assertEquals(body.error, colocatedLicenseRevokeError())

    const rows = await db
      .select({ revokedAt: license.revokedAt })
      .from(license)
      .where(eq(license.id, reservedId))
      .limit(1)
    assertEquals(rows[0]?.revokedAt ?? null, null)
  } finally {
    await db.delete(license).where(eq(license.id, reservedId))
    await db.delete(license).where(eq(license.id, registryBound!.id))
    await db.delete(grant).where(eq(grant.entityId, organizationId))
    await db.delete(user).where(eq(user.id, ownerId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('DELETE /licenses/:id still 403 via fallbacks when registry binding is revoked', async () => {
  if (!dbUrl) {
    console.warn('Skipping license route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const now = new Date().toISOString()
  const insertedOrg = await db
    .insert(organization)
    .values({ name: 'Stale Registry Binding Protect Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg[0]!.id

  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Colocated stale registry',
      isConnected: true,
      statusChangedAt: now,
      daemon: {
        key: {
          id: crypto.randomUUID(),
          algorithm: 'Ed25519',
          publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'stale-registry' },
          fingerprint: `fp-${crypto.randomUUID()}`,
          createdAt: now,
        },
        projection: { remoteAddress: '__direct__' },
      },
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  // Revoked latch on the colocated server — registry must ignore it so
  // display-name / self-host fallbacks still protect the active seat.
  const [staleBound] = await db
    .insert(license)
    .values({
      organizationId,
      serverId,
      name: 'stale-registry-bound',
      token: `stale-registry-${crypto.randomUUID()}`,
      revokedAt: now,
    })
    .returning({ id: license.id })

  const [reserved] = await db
    .insert(license)
    .values({
      organizationId,
      name: COLOCATED_SERVER_DISPLAY_NAME,
      token: `reserved-fallback-${crypto.randomUUID()}`,
    })
    .returning({ id: license.id })
  const reservedId = reserved!.id

  const insertedOwner = await db
    .insert(user)
    .values({
      email: `license-stale-registry-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const ownerId = insertedOwner[0]!.id
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: ownerId,
    permission: 'organization:own',
  })

  const { app, secrets } = await createLicenseTestApp(
    db,
    createOnlineRegistry([serverId]),
  )

  try {
    const cookie = await sessionCookie(db, secrets, ownerId)
    const res = await app.request(`/licenses/${reservedId}`, {
      method: 'DELETE',
      headers: orgRequestHeaders(cookie, organizationId),
    })

    assertEquals(res.status, 403)
    const body = await res.json() as { error?: string }
    assertEquals(body.error, colocatedLicenseRevokeError())

    const rows = await db
      .select({ revokedAt: license.revokedAt })
      .from(license)
      .where(eq(license.id, reservedId))
      .limit(1)
    assertEquals(rows[0]?.revokedAt ?? null, null)
  } finally {
    await db.delete(license).where(eq(license.id, reservedId))
    await db.delete(license).where(eq(license.id, staleBound!.id))
    await db.delete(grant).where(eq(grant.entityId, organizationId))
    await db.delete(user).where(eq(user.id, ownerId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('POST /licenses rejects reserved colocated name', async () => {
  await withOwnerFixtures(async ({ db, app, secrets, ownerId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, ownerId)
    const res = await app.request('/licenses', {
      method: 'POST',
      headers: {
        ...orgRequestHeaders(cookie, organizationId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: COLOCATED_SERVER_DISPLAY_NAME }),
    })

    if (res.status !== 400) {
      throw new Error(
        `expected 400 creating license with reserved name, got ${res.status}`,
      )
    }

    const rows = await db
      .select({ id: license.id })
      .from(license)
      .where(eq(license.organizationId, organizationId))
    if (rows.length !== 0) {
      throw new Error('reserved name must not create a license row')
    }
  })
})

test('POST /licenses normalizes Unicode, smart quotes, and trimming', async () => {
  await withOwnerFixtures(async ({ db, app, secrets, ownerId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, ownerId)
    const res = await postLicense(app, cookie, organizationId, {
      name: '  O\u2019Reilly Café 东京  ',
    })
    assertEquals(res.status, 200)

    const rows = await db
      .select({ name: license.name })
      .from(license)
      .where(eq(license.organizationId, organizationId))
    assertEquals(rows.map((row) => row.name), ["O'Reilly Café 东京"])
  })
})

test('POST /licenses omits whitespace-only optional names', async () => {
  await withOwnerFixtures(async ({ db, app, secrets, ownerId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, ownerId)
    const res = await postLicense(app, cookie, organizationId, {
      name: '   ',
    })
    assertEquals(res.status, 200)

    const rows = await db
      .select({ name: license.name })
      .from(license)
      .where(eq(license.organizationId, organizationId))
    assertEquals(rows.map((row) => row.name), [null])
  })
})

test('POST /licenses rejects control characters and over-length name', async () => {
  await withOwnerFixtures(async ({ db, app, secrets, ownerId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, ownerId)
    const control = await postLicense(app, cookie, organizationId, {
      name: 'bad\nname',
    })
    assertEquals(control.status, 400)

    const overLength = await postLicense(app, cookie, organizationId, {
      name: 'a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1),
    })
    assertEquals(overLength.status, 400)

    const rows = await db
      .select({ id: license.id })
      .from(license)
      .where(eq(license.organizationId, organizationId))
    assertEquals(rows.length, 0)
  })
})

test('POST /licenses returns 409 when org server capacity is exhausted', async () => {
  await withOwnerFixtures(async ({ db, app, secrets, ownerId, organizationId }) => {
    await db.update(organization).set({
      options: { maxServers: 0 },
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, organizationId))

    const cookie = await sessionCookie(db, secrets, ownerId)
    const res = await app.request('/licenses', {
      method: 'POST',
      headers: orgRequestHeaders(cookie, organizationId),
    })

    if (res.status !== 409) {
      throw new Error(`expected 409 when capacity exhausted, got ${res.status}`)
    }
    const body = await res.json() as { error?: string; maxServers?: number }
    if (body.error !== 'server_capacity_exceeded') {
      throw new Error(`expected server_capacity_exceeded, got ${body.error}`)
    }
    if (body.maxServers !== 0) {
      throw new Error(`expected maxServers 0, got ${body.maxServers}`)
    }

    const rows = await db
      .select({ id: license.id })
      .from(license)
      .where(eq(license.organizationId, organizationId))
    if (rows.length !== 0) {
      throw new Error('capacity rejection must not create a license row')
    }
  })
})

test('DELETE /licenses/:id returns 409 while a server is attached', async () => {
  await withOwnerFixtures(
    async ({ db, app, secrets, ownerId, organizationId }) => {
      const now = new Date().toISOString()
      const [insertedServer] = await db
        .insert(server)
        .values({
          createdAt: now,
          updatedAt: now,
          organizationId,
          name: 'Bound host',
        })
        .returning({ id: server.id })
      const serverId = insertedServer!.id

      const [insertedLicense] = await db
        .insert(license)
        .values({
          organizationId,
          serverId,
          name: 'bound-seat',
          token: `bound-hash-${crypto.randomUUID()}`,
        })
        .returning({ id: license.id })
      const licenseId = insertedLicense!.id

      try {
        const cookie = await sessionCookie(db, secrets, ownerId)
        const attached = await app.request(`/licenses/${licenseId}`, {
          method: 'DELETE',
          headers: orgRequestHeaders(cookie, organizationId),
        })
        assertEquals(attached.status, 409)
        const attachedBody = await attached.json() as {
          error?: string
          server?: { id: string; name: string | null }
        }
        assertEquals(attachedBody.error, 'license_has_attached_server')
        assertEquals(attachedBody.server?.id, serverId)
        assertEquals(attachedBody.server?.name, 'Bound host')

        const deletedServer = await app.request(`/servers/${serverId}`, {
          method: 'DELETE',
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
          },
        })
        assertEquals(deletedServer.status, 200)

        const after = await app.request(`/licenses/${licenseId}`, {
          method: 'DELETE',
          headers: orgRequestHeaders(cookie, organizationId),
        })
        assertEquals(after.status, 404)
      } finally {
        await db.delete(license).where(eq(license.id, licenseId))
        await db.delete(server).where(eq(server.id, serverId))
      }
    },
    { registry: createPermissiveRegistry() },
  )
})
