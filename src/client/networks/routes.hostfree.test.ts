/**
 * Host-free coverage for network route authz short-circuits and the CIDR
 * collision authority on `POST` / `PATCH /networks` (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { fabric, network, organization } from '../../lib/db/schema.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from '../authn/authn-hostfree-doubles.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { deriveSecretsConfig } from '../authn/secrets.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerNetworkRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const id = '11111111-1111-4111-8111-111111111111'

async function buildApp(): Promise<Hono<AppEnv>> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', {} as Db)
    return next()
  })
  registerNetworkRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return app
}

test('network routes return 401 without a session cookie', async () => {
  const app = await buildApp()
  const paths = [
    ['GET', '/networks'],
    ['POST', '/networks'],
    ['GET', `/networks/${id}`],
    ['PATCH', `/networks/${id}`],
    ['DELETE', `/networks/${id}`],
  ] as const
  for (const [method, path] of paths) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE'
        ? undefined
        : JSON.stringify({ kind: 'docker', name: 'net' }),
    })
    assertEquals(res.status, 401, `${method} ${path}`)
    assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
  }
})

// ---------------------------------------------------------------------------
// Session-backed doubles: the collision authority on POST / PATCH /networks.
// ---------------------------------------------------------------------------

const organizationId = '22222222-2222-4222-8222-222222222222'
const reservedId = '33333333-3333-4333-8333-333333333333'
const otherReservedId = '44444444-4444-4444-8444-444444444444'
const datacenterId = '55555555-5555-4555-8555-555555555555'
const siteId = '66666666-6666-4666-8666-666666666666'

type Row = Record<string, unknown>

function thenableRows(rows: Row[]) {
  const promise = Promise.resolve(rows)
  return Object.assign(promise, {
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    orderBy: () => Promise.resolve(rows),
    returning: () => Promise.resolve(rows),
  })
}

const RESERVED_ROW: Row = {
  id: reservedId,
  organizationId,
  datacenterId: null,
  serverId: null,
  kind: 'reserved',
  cidr: '10.100.0.0/16',
  name: 'Corp VPN',
  metadata: null,
  options: null,
}
const OTHER_RESERVED_ROW: Row = {
  ...RESERVED_ROW,
  id: otherReservedId,
  cidr: '10.120.0.0/16',
  name: 'Transit',
}
const SITE_ROW: Row = {
  ...RESERVED_ROW,
  id: siteId,
  kind: 'datacenter',
  datacenterId,
  cidr: '10.10.0.0/24',
  name: 'lan',
}

async function buildSessionApp(opts: {
  networkRows: Row[]
  fabricRows?: Row[]
  /** `organization.options` the collision authority reads the org Docker host addressing from. */
  orgOptions?: Row
}): Promise<{
  app: Hono<AppEnv>
  cookie: string
  inserts: Row[]
  updates: Row[]
}> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `net-collision-${crypto.randomUUID()}@example.com`,
    role: 'superadmin',
  })
  seedMockUser(state, {
    id: userId,
    email: `net-collision-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: 'superadmin',
  })
  state.organizations.push({ id: organizationId, name: 'Net Org' })

  const authDb = createMockAuthDb(state)
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown }
    }
  ).select.bind(authDb)
  const inserts: Row[] = []
  const updates: Row[] = []
  const db = Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: true, organization_id: organizationId }]),
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === network) {
          return { where: () => thenableRows(opts.networkRows) }
        }
        if (table === fabric) {
          return { where: () => thenableRows(opts.fabricRows ?? []) }
        }
        if (table === organization && opts.orgOptions) {
          return {
            where: () =>
              thenableRows([{ id: organizationId, name: 'Net Org', options: opts.orgOptions }]),
          }
        }
        return origSelect(fields).from(table)
      },
    }),
    insert: () => ({
      values: (row: Row) => {
        inserts.push(row)
        return { returning: () => Promise.resolve([{ id: crypto.randomUUID() }]) }
      },
    }),
    update: () => ({
      set: (patch: Row) => ({
        where: () => {
          updates.push(patch)
          return thenableRows([])
        },
      }),
    }),
  }) as unknown as Db

  const signed = await buildSignedCookie(token, secrets)
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`
  const app = new Hono<AppEnv>()
  app.use('*', (c: Context<AppEnv>, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  return { app, cookie, inserts, updates }
}

function sessionHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: organizationId,
    'content-type': 'application/json',
  }
}

test('POST /networks returns 409 cidr_overlaps_reserved and writes nothing', async () => {
  const { app, cookie, inserts } = await buildSessionApp({ networkRows: [RESERVED_ROW] })
  const res = await app.request('/networks', {
    method: 'POST',
    headers: sessionHeaders(cookie),
    body: JSON.stringify({
      organizationId,
      kind: 'reserved',
      cidr: '10.100.4.0/24',
      name: 'Nested',
    }),
  })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), {
    error: 'cidr_overlaps_reserved',
    cidr: '10.100.4.0/24',
    conflictingCidr: '10.100.0.0/16',
    networkId: reservedId,
  })
  assertEquals(inserts.length, 0)
})

test('POST /networks returns 409 cidr_overlaps_fabric for a reserved range inside tp0', async () => {
  const { app, cookie, inserts } = await buildSessionApp({
    networkRows: [],
    fabricRows: [{ id: '77777777-7777-4777-8777-777777777777', cidr: '10.250.0.0/16', options: {} }],
  })
  const res = await app.request('/networks', {
    method: 'POST',
    headers: sessionHeaders(cookie),
    body: JSON.stringify({ organizationId, kind: 'reserved', cidr: '10.250.0.0/24' }),
  })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), {
    error: 'cidr_overlaps_fabric',
    cidr: '10.250.0.0/24',
    conflictingCidr: '10.250.0.0/16',
  })
  assertEquals(inserts.length, 0)
})

test('POST /networks returns 409 cidr_overlaps_docker_network for a range inside the stored Docker default bridge', async () => {
  const { app, cookie, inserts } = await buildSessionApp({
    networkRows: [],
    orgOptions: {
      docker: {
        addressPools: [{ base: '10.200.0.0/16', size: 24 }],
        defaultBridgeCidr: '172.26.0.1/16',
      },
    },
  })
  // `bip` names a host address; the registry holds the docker0 network.
  const reserved = await app.request('/networks', {
    method: 'POST',
    headers: sessionHeaders(cookie),
    body: JSON.stringify({ organizationId, kind: 'reserved', cidr: '172.26.8.0/24', name: 'VPN' }),
  })
  assertEquals(reserved.status, 409)
  assertEquals(await reserved.json(), {
    error: 'cidr_overlaps_docker_network',
    cidr: '172.26.8.0/24',
    conflictingCidr: '172.26.0.0/16',
  })
  const docker = await app.request('/networks', {
    method: 'POST',
    headers: sessionHeaders(cookie),
    body: JSON.stringify({
      organizationId,
      kind: 'docker',
      name: 'wide',
      options: { dockerNetworkName: 'wide', subnet: '172.16.0.0/12' },
    }),
  })
  assertEquals(docker.status, 409)
  assertEquals((await docker.json() as { error: string }).error, 'cidr_overlaps_docker_network')
  assertEquals(inserts.length, 0)
})

test('POST /networks inserts a reserved range that collides with nothing', async () => {
  const { app, cookie, inserts } = await buildSessionApp({ networkRows: [RESERVED_ROW, SITE_ROW] })
  const res = await app.request('/networks', {
    method: 'POST',
    headers: sessionHeaders(cookie),
    body: JSON.stringify({
      organizationId,
      kind: 'reserved',
      cidr: '192.168.0.0/16',
      name: 'Corp VPN - Chicago branch',
    }),
  })
  assertEquals(res.status, 200)
  assertEquals((await res.json() as { ok: boolean }).ok, true)
  assertEquals(inserts, [{
    organizationId,
    kind: 'reserved',
    name: 'Corp VPN - Chicago branch',
    cidr: '192.168.0.0/16',
  }])
})

test('PATCH /networks/:id excludes the row itself but still collides with another row', async () => {
  const { app, cookie, updates } = await buildSessionApp({
    networkRows: [RESERVED_ROW, OTHER_RESERVED_ROW],
  })
  const patch = (body: Record<string, unknown>) =>
    app.request(`/networks/${reservedId}`, {
      method: 'PATCH',
      headers: sessionHeaders(cookie),
      body: JSON.stringify(body),
    })

  // Note: the double returns every seeded row for any `network` select, so
  // the "existing row" lookup sees RESERVED_ROW first — exactly the row
  // being patched.
  const same = await patch({ name: 'Renamed', cidr: '10.100.0.0/16' })
  assertEquals(same.status, 200)
  assertEquals(updates.length, 1)
  assertEquals(updates[0]?.name, 'Renamed')
  assertEquals(updates[0]?.cidr, '10.100.0.0/16')

  const narrowed = await patch({ cidr: '10.100.8.0/24' })
  assertEquals(narrowed.status, 200)
  assertEquals(updates.length, 2)

  const collide = await patch({ cidr: '10.120.4.0/24' })
  assertEquals(collide.status, 409)
  assertEquals(await collide.json(), {
    error: 'cidr_overlaps_reserved',
    cidr: '10.120.4.0/24',
    conflictingCidr: '10.120.0.0/16',
    networkId: otherReservedId,
  })
  assertEquals(updates.length, 2)

  const cleared = await patch({ cidr: null })
  assertEquals(cleared.status, 400)
  assertEquals(await cleared.json(), { error: 'network_cidr_required' })
  assertEquals(updates.length, 2)
})

test('PATCH /networks/:id on a site subnet reports subnet_overlaps against a sibling', async () => {
  const sibling: Row = {
    ...SITE_ROW,
    id: '88888888-8888-4888-8888-888888888888',
    cidr: '10.11.0.0/24',
  }
  const { app, cookie, updates } = await buildSessionApp({
    networkRows: [SITE_ROW, sibling],
  })
  const res = await app.request(`/networks/${siteId}`, {
    method: 'PATCH',
    headers: sessionHeaders(cookie),
    body: JSON.stringify({ cidr: '10.11.0.128/25' }),
  })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), {
    error: 'subnet_overlaps',
    cidr: '10.11.0.128/25',
    conflictingCidr: '10.11.0.0/24',
    networkId: sibling.id,
    datacenterId,
  })
  assertEquals(updates.length, 0)
})
