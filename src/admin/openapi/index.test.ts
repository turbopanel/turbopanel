import { assertEquals, assertExists } from '@std/assert'
import { ADMIN_API_PREFIX } from '../../surfaces.ts'
import { getAdminOpenApiSpec } from './index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type SchemaObject = {
  properties?: Record<string, unknown>
  required?: string[]
  enum?: string[]
  const?: unknown
}

test('getAdminOpenApiSpec exposes OpenAPI 3.1 metadata and cookie auth', () => {
  const spec = getAdminOpenApiSpec('https://panel.example.com:8443') as {
    openapi: string
    info: { title: string }
    servers: { url: string }[]
    components: { securitySchemes: { cookieAuth: { name: string } } }
    tags: { name: string }[]
  }
  assertEquals(spec.openapi, '3.1.0')
  assertEquals(spec.info.title, 'TurboPanel Admin API')
  assertEquals(spec.servers[0]?.url, 'https://panel.example.com:8443')
  assertExists(spec.components.securitySchemes.cookieAuth.name)
  assertEquals(
    spec.tags.map((tag) => tag.name).sort((a, b) => a.localeCompare(b)),
    ['Daemon Fleet', 'Instance', 'Settings'],
  )
})

test('getAdminOpenApiSpec documents the tier catalogue on Workers only', () => {
  type Spec = {
    tags: { name: string }[]
    'x-tagGroups': { name: string }[]
    paths: Record<string, unknown>
  }
  const workers = getAdminOpenApiSpec('https://localhost:8443', { runtime: 'workers' }) as Spec
  assertEquals(workers.tags.some((tag) => tag.name === 'Tiers'), true)
  assertEquals(workers['x-tagGroups'].some((group) => group.name === 'Billing'), true)
  assertExists(workers.paths[`${ADMIN_API_PREFIX}/tiers`])
  assertExists(workers.paths[`${ADMIN_API_PREFIX}/tiers/{id}/verify`])

  // Self-hosted Deno mounts no billing surface, so its spec has none either.
  const deno = getAdminOpenApiSpec('https://localhost:8443', { runtime: 'deno' }) as Spec
  assertEquals(deno.tags.some((tag) => tag.name === 'Tiers'), false)
  assertEquals(deno['x-tagGroups'].some((group) => group.name === 'Billing'), false)
  assertEquals(Object.keys(deno.paths).some((path) => path.startsWith(`${ADMIN_API_PREFIX}/tiers`)), false)
})

test('getAdminOpenApiSpec documents public URL and reencrypt paths', () => {
  const spec = getAdminOpenApiSpec('https://localhost:8443') as {
    paths: Record<string, unknown>
    components: { schemas: Record<string, SchemaObject> }
  }
  assertExists(spec.paths[`${ADMIN_API_PREFIX}/instance/public-urls`])
  assertExists(spec.paths[`${ADMIN_API_PREFIX}/instance/public-urls/apply`])
  assertExists(spec.paths[`${ADMIN_API_PREFIX}/secrets/reencrypt`])
  assertExists(spec.paths[`${ADMIN_API_PREFIX}/cells/purge-batch`])

  const reencryptCursor = spec.components.schemas.SecretsReencryptCursor
  assertEquals(reencryptCursor?.required, ['stage'])
  assertEquals(
    (reencryptCursor?.properties?.stage as SchemaObject).enum,
    ['variables', 'tls', 'principals', 'storage', 'secrets', 'email'],
  )

  const publicUrls = spec.components.schemas.PublicUrlsPutResponse
  assertEquals((publicUrls?.properties?.applied as SchemaObject).const, false)
})

test('getAdminOpenApiSpec documents the git app collection', () => {
  const spec = getAdminOpenApiSpec('https://localhost:8443') as {
    paths: Record<string, Record<string, unknown>>
    components: { schemas: Record<string, SchemaObject> }
  }

  const collection = spec.paths[`${ADMIN_API_PREFIX}/forges`]
  assertExists(collection)
  assertExists(collection.get)
  assertExists(collection.post)

  const item = spec.paths[`${ADMIN_API_PREFIX}/forges/{id}`]
  assertExists(item)
  assertExists(item.get)
  assertExists(item.patch)
  assertExists(item.delete)

  // The manifest flow is the supported way to register a GitHub App, so both
  // of its hops have to be discoverable.
  assertExists(spec.paths[`${ADMIN_API_PREFIX}/forges/github/manifest`])
  assertExists(spec.paths[`${ADMIN_API_PREFIX}/forges/github/manifest/callback`])

  // The write surface has to expose every field the runtime reads, or a
  // provider stays unconfigurable without direct database access.
  const body = spec.components.schemas.ForgeCreateBody
  assertEquals(
    Object.keys(body?.properties ?? {}).sort((a, b) => a.localeCompare(b)),
    [
      'apiUrl',
      'appSlug',
      'baseUrl',
      'clientId',
      'clientSecret',
      'externalAppId',
      'name',
      'privateKeyPem',
      'provider',
      'redirectUri',
      'webhookSecret',
    ],
  )

  // Secrets are reported as presence only; the sealed values never come back.
  const app = spec.components.schemas.Forge
  const properties = Object.keys(app?.properties ?? {})
  assertEquals(properties.includes('credentials'), false)
  for (const key of ['hasPrivateKey', 'hasClientSecret', 'hasWebhookSecret']) {
    assertEquals(properties.includes(key), true)
  }
  // The routing token and its resolved URL are what an operator copies into
  // the provider, so both are part of the documented shape.
  assertEquals(properties.includes('webhookRef'), true)
  assertEquals(properties.includes('webhookUrl'), true)
})

test('getAdminOpenApiSpec accepts devSurface option without changing core paths', () => {
  const withDev = getAdminOpenApiSpec('https://localhost:8443', { devSurface: true }) as {
    paths: Record<string, unknown>
  }
  const withoutDev = getAdminOpenApiSpec('https://localhost:8443') as {
    paths: Record<string, unknown>
  }
  assertEquals(Object.keys(withDev.paths).sort((a, b) => a.localeCompare(b)), Object.keys(withoutDev.paths).sort((a, b) => a.localeCompare(b)))
})
