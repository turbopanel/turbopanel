import { assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
} from '../authn/secrets.ts'
import {
  container,
  environment,
  grant,
  managed,
  organization,
  project,
  server,
  service,
  user,
  variable,
  workspace,
} from '../../lib/db/schema.ts'
import { WORKSPACE_KIND_SYSTEM } from '../../lib/db/workspace-kind.ts'
import { SYSTEM_RESOURCE_IMMUTABLE_ERROR } from '../authz/http.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerProjectRoutes } from './routes.ts'
import { registerEnvironmentRoutes } from '../environments/routes.ts'
import {
  registerEnvironmentDeployRoutes,
} from '../environments/deploy-routes.ts'
import { registerServiceRoutes } from '../services/routes.ts'
import { registerVariableRoutes } from '../variables/routes.ts'
import { registerContainerRoutes } from '../containers/routes.ts'
import {
  registerEnvironmentLifecycleRoutes,
  registerEnvironmentStopRoutes,
} from '../environments/deploy-routes.ts'
import { registerStorageRoutes } from '../storage/routes.ts'
import {
  ensureSelfHostSystemHierarchy,
  ensureSystemHierarchy,
  SYSTEM_PROJECT_METADATA_TYPE,
} from '../system/hierarchy.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createProjectRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerProjectRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
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

async function withProjectFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    workspaceId: string
    serverId: string
    systemWorkspaceId: string
    systemProjectId: string
    systemEnvironmentId: string
    systemServiceId: string
    selfHostProjectId: string
    selfHostEnvironmentId: string
    selfHostServiceId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping project route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createProjectRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Project Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `project-route-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Project Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Project Route Test Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const hierarchy = await ensureSystemHierarchy(db, { organizationId, serverId })
  const selfHost = await ensureSelfHostSystemHierarchy(db, { organizationId, serverId })

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      workspaceId,
      serverId,
      systemWorkspaceId: hierarchy.workspaceId,
      systemProjectId: hierarchy.projectId,
      systemEnvironmentId: hierarchy.environmentId,
      systemServiceId: hierarchy.serviceId,
      selfHostProjectId: selfHost.projectId,
      selfHostEnvironmentId: selfHost.environmentId,
      selfHostServiceId: selfHost.services[0]!.serviceId,
    })
  } finally {
    const allWorkspaces = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.organizationId, organizationId))
    for (const ws of allWorkspaces) {
      const leftover = await db
        .select({ id: project.id })
        .from(project)
        .where(eq(project.workspaceId, ws.id))
      for (const row of leftover) {
        const envRows = await db
          .select({ id: environment.id })
          .from(environment)
          .where(eq(environment.projectId, row.id))
        for (const env of envRows) {
          await db.delete(variable).where(eq(variable.environmentId, env.id))
        }
        await db.delete(variable).where(eq(variable.projectId, row.id))
        for (const env of envRows) {
          await db.delete(managed).where(eq(managed.environmentId, env.id))
          const serviceRows = await db
            .select({ id: service.id })
            .from(service)
            .where(eq(service.environmentId, env.id))
          const serviceIds = serviceRows.map((s) => s.id)
          if (serviceIds.length > 0) {
            await db.delete(container).where(inArray(container.serviceId, serviceIds))
            await db.delete(service).where(inArray(service.id, serviceIds))
          }
        }
        await db.delete(environment).where(eq(environment.projectId, row.id))
        await db.delete(project).where(eq(project.id, row.id))
      }
    }
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('POST /projects managed postgres scaffolds env without managed row', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'managed',
        code: 'postgres',
        workspaceId,
        name: 'Managed Postgres',
      }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as { ok: boolean; id: string }
    assertEquals(body.ok, true)
    const projectId = body.id

    const [projectRow] = await db
      .select({ metadata: project.metadata })
      .from(project)
      .where(eq(project.id, projectId))
      .limit(1)
    const metadata = projectRow?.metadata as {
      type?: string
      code?: string
    } | null
    assertEquals(metadata?.type, 'managed')
    assertEquals(metadata?.code, 'postgres')

    const envs = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.projectId, projectId))
    assertEquals(envs.length, 1)

    const managedForEnv = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.environmentId, envs[0]!.id))
    assertEquals(managedForEnv.length, 0)

    const vars = await db
      .select({ value: variable.value, isSecret: variable.isSecret })
      .from(variable)
      .where(eq(variable.environmentId, envs[0]!.id))
    assertEquals(vars.length, 1)
    assertEquals(vars[0]!.isSecret, true)
    assertEquals(vars[0]!.value?.startsWith('tpsecret.'), true)
  })
})

test('POST /projects managed rejects unknown catalog code', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'managed',
        code: 'nope',
        workspaceId,
        name: 'Unknown',
      }),
    })

    assertEquals(res.status, 400)
    assertEquals(await res.json(), { error: 'Unknown catalog code' })
  })
})

test('POST /projects empty scaffolds Production once with type empty', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: 'Empty Project',
      }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as { ok: boolean; id: string }
    assertEquals(body.ok, true)

    const [projectRow] = await db
      .select({ metadata: project.metadata, options: project.options })
      .from(project)
      .where(eq(project.id, body.id))
      .limit(1)
    assertEquals(projectRow?.metadata, null)
    assertEquals(projectRow?.options, null)

    const envs = await db
      .select({ name: environment.name })
      .from(environment)
      .where(eq(environment.projectId, body.id))
    assertEquals(envs.length, 1)
    assertEquals(envs[0]!.name, 'Production')
  })
})

test('POST /projects accepts an apostrophe in the display name', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'docker-compose',
        workspaceId,
        name: "next's",
      }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as { ok: boolean; id: string }
    assertEquals(body.ok, true)

    const [projectRow] = await db
      .select({ name: project.name })
      .from(project)
      .where(eq(project.id, body.id))
      .limit(1)
    assertEquals(projectRow?.name, "next's")
  })
})

test('POST /projects rejects missing type', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId,
        name: 'No Type Project',
      }),
    })

    assertEquals(res.status, 400)
    assertEquals(await res.json(), { error: 'Invalid request' })
  })
})

test('POST /projects rejects empty string type', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: '',
        workspaceId,
        name: 'Blank Type Project',
      }),
    })

    assertEquals(res.status, 400)
    assertEquals(await res.json(), { error: 'Invalid request' })
  })
})

test('POST /projects empty uses org defaultEnvironmentName when set', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    await db
      .update(organization)
      .set({ options: { defaultEnvironmentName: 'Staging' } })
      .where(eq(organization.id, organizationId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: 'Custom Env Project',
      }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as { ok: boolean; id: string }
    assertEquals(body.ok, true)

    const envs = await db
      .select({ name: environment.name })
      .from(environment)
      .where(eq(environment.projectId, body.id))
    assertEquals(envs.length, 1)
    assertEquals(envs[0]!.name, 'Staging')
  })
})

test('POST /projects docker-compose uses org defaultEnvironmentName when set', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    await db
      .update(organization)
      .set({ options: { defaultEnvironmentName: 'Live' } })
      .where(eq(organization.id, organizationId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'docker-compose',
        workspaceId,
        name: 'Compose Custom Env',
      }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as { ok: boolean; id: string }

    const envs = await db
      .select({ name: environment.name })
      .from(environment)
      .where(eq(environment.projectId, body.id))
    assertEquals(envs.length, 1)
    assertEquals(envs[0]!.name, 'Live')
  })
})

test('POST /projects cannot persist nested metadata.type system', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const composeRes = await app.request('/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'docker-compose',
        workspaceId,
        name: 'Nested System Compose',
        metadata: { type: SYSTEM_PROJECT_METADATA_TYPE, note: 'keep' },
      }),
    })
    assertEquals(composeRes.status, 200)
    const composeBody = await composeRes.json() as { ok: boolean; id: string }
    const [composeRow] = await db
      .select({ metadata: project.metadata })
      .from(project)
      .where(eq(project.id, composeBody.id))
      .limit(1)
    const composeMetadata = composeRow?.metadata as {
      type?: string
      note?: string
    } | null
    assertEquals(composeMetadata?.type, 'docker-compose')
    assertEquals(composeMetadata?.note, 'keep')

    const managedRes = await app.request('/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'managed',
        code: 'postgres',
        workspaceId,
        name: 'Nested System Managed',
        metadata: { type: SYSTEM_PROJECT_METADATA_TYPE },
      }),
    })
    assertEquals(managedRes.status, 200)
    const managedBody = await managedRes.json() as { ok: boolean; id: string }
    const [managedRow] = await db
      .select({ metadata: project.metadata })
      .from(project)
      .where(eq(project.id, managedBody.id))
      .limit(1)
    const managedMetadata = managedRow?.metadata as {
      type?: string
      code?: string
    } | null
    assertEquals(managedMetadata?.type, 'managed')
    assertEquals(managedMetadata?.code, 'postgres')
  })
})

test('POST /projects/:id/configure reuses custom-named default environment', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    await db
      .update(organization)
      .set({ options: { defaultEnvironmentName: 'Staging' } })
      .where(eq(organization.id, organizationId))

    const cookie = await sessionCookie(db, secrets, userId)
    const createRes = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: 'Configure Custom Env',
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { id: string }

    const configureRes = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'docker-compose' }),
    })
    assertEquals(configureRes.status, 200)

    const envs = await db
      .select({ name: environment.name })
      .from(environment)
      .where(eq(environment.projectId, id))
    assertEquals(envs.length, 1)
    assertEquals(envs[0]!.name, 'Staging')
  })
})

test('POST /projects/:id/configure reuses scaffolded env when org default changed', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    await db
      .update(organization)
      .set({ options: { defaultEnvironmentName: 'Staging' } })
      .where(eq(organization.id, organizationId))

    const cookie = await sessionCookie(db, secrets, userId)
    const createRes = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: 'Stale Default Project',
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { id: string }

    const [scaffolded] = await db
      .select({
        id: environment.id,
        name: environment.name,
      })
      .from(environment)
      .where(eq(environment.projectId, id))
    assertEquals(scaffolded?.name, 'Staging')

    await db
      .update(organization)
      .set({ options: { defaultEnvironmentName: 'Live' } })
      .where(eq(organization.id, organizationId))

    const configureRes = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'managed', code: 'postgres' }),
    })
    assertEquals(configureRes.status, 200)

    const envs = await db
      .select({
        id: environment.id,
        name: environment.name,
      })
      .from(environment)
      .where(eq(environment.projectId, id))
    assertEquals(envs.length, 1)
    assertEquals(envs[0]!.id, scaffolded!.id)
    assertEquals(envs[0]!.name, 'Staging')

    const [projectRow] = await db
      .select({ metadata: project.metadata })
      .from(project)
      .where(eq(project.id, id))
      .limit(1)
    assertEquals(projectRow?.metadata, { type: 'managed', code: 'postgres' })

    const vars = await db
      .select({ key: variable.key })
      .from(variable)
      .where(eq(variable.environmentId, scaffolded!.id))
    assertEquals(vars.map((row) => row.key), ['POSTGRES_PASSWORD'])
  })
})

test('POST /projects/:id/configure prefers literal Production over org default match', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const createRes = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: 'Both Envs Project',
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { id: string }

    await db.insert(environment).values({
      projectId: id,
      name: 'Staging',
      description: 'Custom default sibling',
    })

    await db
      .update(organization)
      .set({ options: { defaultEnvironmentName: 'Staging' } })
      .where(eq(organization.id, organizationId))

    const configureRes = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'managed', code: 'postgres' }),
    })
    assertEquals(configureRes.status, 200)

    const envs = await db
      .select({
        id: environment.id,
        name: environment.name,
        description: environment.description,
      })
      .from(environment)
      .where(eq(environment.projectId, id))
    assertEquals(envs.length, 2)

    const production = envs.find((row) => row.name === 'Production')
    const staging = envs.find((row) => row.name === 'Staging')
    assertEquals(production != null, true)
    assertEquals(staging != null, true)
    assertEquals(staging!.description, 'Custom default sibling')

    const productionVars = await db
      .select({ key: variable.key })
      .from(variable)
      .where(eq(variable.environmentId, production!.id))
    assertEquals(productionVars.map((row) => row.key), ['POSTGRES_PASSWORD'])

    const stagingVars = await db
      .select({ key: variable.key })
      .from(variable)
      .where(eq(variable.environmentId, staging!.id))
    assertEquals(stagingVars.length, 0)
  })
})

test('POST /projects/:id/configure pins serverId on existing default environment', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const createRes = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: 'Pin Server On Configure',
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { id: string }

    const [before] = await db
      .select({ serverId: environment.serverId })
      .from(environment)
      .where(eq(environment.projectId, id))
      .limit(1)
    assertEquals(before?.serverId ?? null, null)

    const now = new Date().toISOString()
    const [insertedServer] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'Configure Pin Server',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id })
    const serverId = insertedServer!.id

    try {
      const configureRes = await app.request(`/projects/${id}/configure`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'docker-compose',
          serverId,
        }),
      })
      assertEquals(configureRes.status, 200)

      const [after] = await db
        .select({
          name: environment.name,
          serverId: environment.serverId,
        })
        .from(environment)
        .where(eq(environment.projectId, id))
        .limit(1)
      assertEquals(after?.name, 'Production')
      assertEquals(after?.serverId, serverId)
    } finally {
      await db
        .update(environment)
        .set({ serverId: null })
        .where(eq(environment.projectId, id))
      await db.delete(server).where(eq(server.id, serverId))
    }
  })
})

test('POST /projects/:id/configure sets docker-compose idempotently', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const createRes = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: 'Configure Me',
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { id: string }

    const configureRes = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'docker-compose' }),
    })
    assertEquals(configureRes.status, 200)
    assertEquals(await configureRes.json(), {
      ok: true,
      alreadyConfigured: false,
    })

    const [after] = await db
      .select({ metadata: project.metadata })
      .from(project)
      .where(eq(project.id, id))
      .limit(1)
    const metadata = after?.metadata as { type?: string } | null
    assertEquals(metadata?.type, 'docker-compose')

    const again = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'docker-compose' }),
    })
    assertEquals(again.status, 200)
    assertEquals(await again.json(), { ok: true, alreadyConfigured: true })

    const conflict = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'managed', code: 'postgres' }),
    })
    assertEquals(conflict.status, 409)

    const envs = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.projectId, id))
    assertEquals(envs.length, 1)
  })
})

test('POST /projects/:id/configure managed postgres reuses Production', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const createRes = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: 'Managed Later',
      }),
    })
    assertEquals(createRes.status, 200)
    const { id } = await createRes.json() as { id: string }

    const configureRes = await app.request(`/projects/${id}/configure`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'managed', code: 'postgres' }),
    })
    assertEquals(configureRes.status, 200)

    const [projectRow] = await db
      .select({ metadata: project.metadata })
      .from(project)
      .where(eq(project.id, id))
      .limit(1)
    const metadata = projectRow?.metadata as {
      type?: string
      code?: string
    } | null
    assertEquals(metadata?.type, 'managed')
    assertEquals(metadata?.code, 'postgres')

    const envs = await db
      .select({ id: environment.id, name: environment.name })
      .from(environment)
      .where(eq(environment.projectId, id))
    assertEquals(envs.length, 1)
    assertEquals(envs[0]!.name, 'Production')

    const managedForEnv = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.environmentId, envs[0]!.id))
    assertEquals(managedForEnv.length, 0)
  })
})

test('POST /projects rejects duplicate display names case-insensitively within the org', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const first = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: 'Alpha App',
      }),
    })
    assertEquals(first.status, 200)

    const duplicate = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: '  alpha app  ',
      }),
    })
    assertEquals(duplicate.status, 409)
    assertEquals(await duplicate.json(), { error: 'project_name_in_use' })
  })
})

test('PATCH /projects/:id rejects renaming onto another project name in the org', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const createA = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: 'Project A',
      }),
    })
    assertEquals(createA.status, 200)

    const createB = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: 'Project B',
      }),
    })
    assertEquals(createB.status, 200)
    const { id: projectBId } = await createB.json() as { id: string }

    const rename = await app.request(`/projects/${projectBId}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'project a' }),
    })
    assertEquals(rename.status, 409)
    assertEquals(await rename.json(), { error: 'project_name_in_use' })
  })
})

test('system workspace project mutations return system_resource_immutable', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
    systemWorkspaceId,
    systemProjectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    const createIntoSystem = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId: systemWorkspaceId,
        name: 'Into System',
      }),
    })
    assertEquals(createIntoSystem.status, 403)
    assertEquals(await createIntoSystem.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    const createUser = await app.request('/projects', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: 'User Project',
      }),
    })
    assertEquals(createUser.status, 200)
    const { id: userProjectId } = await createUser.json() as { id: string }

    const moveIntoSystem = await app.request(`/projects/${userProjectId}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workspaceId: systemWorkspaceId }),
    })
    assertEquals(moveIntoSystem.status, 403)
    assertEquals(await moveIntoSystem.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    const patchSystem = await app.request(`/projects/${systemProjectId}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Renamed Ingress' }),
    })
    assertEquals(patchSystem.status, 403)
    assertEquals(await patchSystem.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    const deleteSystem = await app.request(`/projects/${systemProjectId}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(deleteSystem.status, 403)
    assertEquals(await deleteSystem.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    const getSystem = await app.request(`/projects/${systemProjectId}`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(getSystem.status, 200)

    const [systemWs] = await db
      .select({ kind: workspace.kind })
      .from(workspace)
      .where(eq(workspace.id, systemWorkspaceId))
      .limit(1)
    assertEquals(systemWs?.kind, WORKSPACE_KIND_SYSTEM)
  })
})

test('system descendant mutations return system_resource_immutable; container read stays open', async () => {
  await withProjectFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    systemEnvironmentId,
    systemServiceId,
  }) => {
    const secretsConfig = parseTestSecretsConfig('deno')
    const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
      secretsConfig,
      'data-encryption',
    )
    const descendantApp = new Hono<AppEnv>()
    descendantApp.use('*', (c, next) => {
      c.set('db', db)
      c.set('dataEncryptionSecrets', dataEncryptionSecrets)
      return next()
    })
    const opts = { secrets, runtime: 'deno' as const, signupEnvOverride: undefined }
    registerEnvironmentRoutes(descendantApp, opts)
    registerEnvironmentDeployRoutes(descendantApp, opts)
    registerServiceRoutes(descendantApp, opts)
    registerVariableRoutes(descendantApp, opts)
    registerContainerRoutes(descendantApp, opts)

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const patchEnv = await descendantApp.request(
      `/environments/${systemEnvironmentId}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name: 'Nope' }),
      },
    )
    assertEquals(patchEnv.status, 403)
    assertEquals(await patchEnv.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    const deleteService = await descendantApp.request(
      `/services/${systemServiceId}`,
      {
        method: 'DELETE',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      },
    )
    assertEquals(deleteService.status, 403)
    assertEquals(await deleteService.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    const createVar = await descendantApp.request('/variables', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        environmentId: systemEnvironmentId,
        key: 'SYSTEM_BLOCKED',
        value: '1',
      }),
    })
    assertEquals(createVar.status, 403)
    assertEquals(await createVar.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    const deploy = await descendantApp.request(
      `/environments/${systemEnvironmentId}/deploy`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      },
    )
    assertEquals(deploy.status, 403)
    assertEquals(await deploy.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    const containers = await descendantApp.request(
      `/containers?environmentId=${systemEnvironmentId}`,
      {
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      },
    )
    assertEquals(containers.status, 200)
    const containerBody = await containers.json() as {
      containers: Array<{ role?: string }>
    }
    if (!Array.isArray(containerBody.containers)) {
      throw new TypeError('expected containers array')
    }
    assertEquals(
      containerBody.containers.some((row) => row.role === 'ingress'),
      true,
    )
  })
})

test('TurboPanel self-host project mutations return system_resource_immutable; reads stay open', async () => {
  await withProjectFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
    selfHostProjectId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    // Compose/override edit (options.compose) is blocked the same as any
    // other patch — image changes go through this same `options` field.
    const composeEdit = await app.request(`/projects/${selfHostProjectId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        options: { compose: { services: { database: { image: 'postgres:16' } } } },
      }),
    })
    assertEquals(composeEdit.status, 403)
    assertEquals(await composeEdit.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    // Move OUT of the system workspace onto a normal user workspace.
    const moveOut = await app.request(`/projects/${selfHostProjectId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ workspaceId }),
    })
    assertEquals(moveOut.status, 403)
    assertEquals(await moveOut.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    // Move INTO the system workspace from a normal user project.
    const createUser = await app.request('/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'empty',
        workspaceId,
        name: 'Not Self-Host',
      }),
    })
    assertEquals(createUser.status, 200)
    const { id: userProjectId } = await createUser.json() as { id: string }

    const [selfHostRow] = await db
      .select({ workspaceId: project.workspaceId })
      .from(project)
      .where(eq(project.id, selfHostProjectId))
      .limit(1)
    const moveIn = await app.request(`/projects/${userProjectId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ workspaceId: selfHostRow!.workspaceId }),
    })
    assertEquals(moveIn.status, 403)
    assertEquals(await moveIn.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    const deleteSelfHost = await app.request(`/projects/${selfHostProjectId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(deleteSelfHost.status, 403)
    assertEquals(await deleteSelfHost.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    // Reads stay open for an authorized org administrator.
    const getSelfHost = await app.request(`/projects/${selfHostProjectId}`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(getSelfHost.status, 200)
  })
})

test('TurboPanel self-host descendant mutations return system_resource_immutable; reads stay open', async () => {
  await withProjectFixtures(async ({
    db,
    secrets,
    userId,
    organizationId,
    serverId,
    selfHostEnvironmentId,
    selfHostServiceId,
  }) => {
    const secretsConfig = parseTestSecretsConfig('deno')
    const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
      secretsConfig,
      'data-encryption',
    )
    const descendantApp = new Hono<AppEnv>()
    descendantApp.use('*', (c, next) => {
      c.set('db', db)
      c.set('dataEncryptionSecrets', dataEncryptionSecrets)
      return next()
    })
    const opts = { secrets, runtime: 'deno' as const, signupEnvOverride: undefined }
    registerEnvironmentRoutes(descendantApp, opts)
    registerEnvironmentDeployRoutes(descendantApp, opts)
    registerEnvironmentLifecycleRoutes(descendantApp, opts)
    registerEnvironmentStopRoutes(descendantApp, opts)
    registerServiceRoutes(descendantApp, opts)
    registerVariableRoutes(descendantApp, opts)
    registerContainerRoutes(descendantApp, opts)
    registerStorageRoutes(descendantApp, opts)

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    // Environment / service delete.
    const patchEnv = await descendantApp.request(
      `/environments/${selfHostEnvironmentId}`,
      { method: 'PATCH', headers, body: JSON.stringify({ name: 'Nope' }) },
    )
    assertEquals(patchEnv.status, 403)
    assertEquals(await patchEnv.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    const deleteService = await descendantApp.request(
      `/services/${selfHostServiceId}`,
      { method: 'DELETE', headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId } },
    )
    assertEquals(deleteService.status, 403)
    assertEquals(await deleteService.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    // Variable mutation.
    const createVar = await descendantApp.request('/variables', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        environmentId: selfHostEnvironmentId,
        key: 'SELF_HOST_BLOCKED',
        value: '1',
      }),
    })
    assertEquals(createVar.status, 403)
    assertEquals(await createVar.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    // Storage mutation.
    const createStorage = await descendantApp.request('/storage', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        environmentId: selfHostEnvironmentId,
        kind: 'volume',
        name: 'self-host-blocked',
        location: { provider: 'docker', serverId },
      }),
    })
    assertEquals(createStorage.status, 403)
    assertEquals(await createStorage.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    // Deploy / lifecycle / stop.
    const deploy = await descendantApp.request(
      `/environments/${selfHostEnvironmentId}/deploy`,
      { method: 'POST', headers, body: JSON.stringify({}) },
    )
    assertEquals(deploy.status, 403)
    assertEquals(await deploy.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    const lifecycle = await descendantApp.request(
      `/environments/${selfHostEnvironmentId}/lifecycle`,
      { method: 'POST', headers, body: JSON.stringify({ action: 'start' }) },
    )
    assertEquals(lifecycle.status, 403)
    assertEquals(await lifecycle.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    const stop = await descendantApp.request(
      `/environments/${selfHostEnvironmentId}/stop`,
      { method: 'POST', headers, body: JSON.stringify({}) },
    )
    assertEquals(stop.status, 403)
    assertEquals(await stop.json(), {
      error: SYSTEM_RESOURCE_IMMUTABLE_ERROR,
    })

    // Reads stay open for an authorized org administrator.
    const getEnv = await descendantApp.request(
      `/environments/${selfHostEnvironmentId}`,
      { headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId } },
    )
    assertEquals(getEnv.status, 200)

    const containers = await descendantApp.request(
      `/containers?environmentId=${selfHostEnvironmentId}`,
      { headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId } },
    )
    assertEquals(containers.status, 200)
    const containerBody = await containers.json() as {
      containers: Array<{ role?: string }>
    }
    if (!Array.isArray(containerBody.containers)) {
      throw new TypeError('expected containers array')
    }
    assertEquals(
      containerBody.containers.every((row) => row.role === 'turbopanel'),
      true,
    )
    assertEquals(containerBody.containers.length > 0, true)
  })
})
