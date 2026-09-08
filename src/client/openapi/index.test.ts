import { assertEquals, assertExists } from '@std/assert'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import { getClientOpenApiSpec } from './index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('getClientOpenApiSpec workers runtime omits install tag and paths', () => {
  const spec = getClientOpenApiSpec('https://panel.example.com', { runtime: 'workers' }) as {
    tags: { name: string }[]
    paths: Record<string, unknown>
    components: { schemas: Record<string, unknown> }
  }
  const tagNames = spec.tags.map((tag) => tag.name)
  assertEquals(tagNames.includes('Install'), false)
  assertEquals(Object.keys(spec.paths).some((path) => path.startsWith('/api/install/v1')), false)
  assertExists(spec.paths[`${CLIENT_API_PREFIX}/licenses`])
  assertExists(spec.components.schemas.LicenseRecord)
  // Billing is hosted-only, so the Workers spec is the one that documents it.
  assertEquals(tagNames.includes('Billing'), true)
  assertExists(spec.paths[`${CLIENT_API_PREFIX}/billing/catalog`])
})

test('getClientOpenApiSpec deno runtime includes install surface and omits billing', () => {
  const spec = getClientOpenApiSpec('https://localhost:8443', { runtime: 'deno' }) as {
    tags: { name: string }[]
    paths: Record<string, unknown>
  }
  assertEquals(spec.tags.some((tag) => tag.name === 'Install'), true)
  assertEquals(Object.keys(spec.paths).some((path) => path.startsWith('/api/install/v1')), true)
  // Self-hosted has no billing surface at all — not mounted, so not documented.
  assertEquals(spec.tags.some((tag) => tag.name === 'Billing'), false)
  assertEquals(Object.keys(spec.paths).some((path) => path.startsWith(`${CLIENT_API_PREFIX}/billing`)), false)
})

test('getClientOpenApiSpec wires cookie auth and core resource paths', () => {
  const spec = getClientOpenApiSpec('https://localhost:8443') as {
    openapi: string
    info: { title: string }
    servers: { url: string }[]
    components: { securitySchemes: { cookieAuth: { name: string } } }
    paths: Record<string, unknown>
  }
  assertEquals(spec.openapi, '3.1.0')
  assertEquals(spec.info.title, 'TurboPanel Client API')
  assertEquals(spec.servers[0]?.url, 'https://localhost:8443')
  assertExists(spec.components.securitySchemes.cookieAuth.name)
  assertExists(spec.paths[`${CLIENT_API_PREFIX}/servers`])
  assertExists(spec.paths[`${CLIENT_API_PREFIX}/projects`])
  assertExists(spec.paths[`${CLIENT_API_PREFIX}/environments/{id}/managed`])
})

test('getClientOpenApiSpec registers the batched command status surface', () => {
  const spec = getClientOpenApiSpec('https://localhost:8443') as {
    tags: { name: string; description: string }[]
    paths: Record<string, unknown>
    components: { schemas: Record<string, unknown> }
  }

  assertEquals(spec.tags.some((tag) => tag.name === 'Commands'), true)

  const statusPath = spec.paths[`${CLIENT_API_PREFIX}/commands/status`] as {
    post: {
      tags: string[]
      requestBody: {
        content: { 'application/json': { schema: { $ref: string } } }
      }
      responses: Record<
        string,
        { content?: { 'application/json': { schema: { $ref?: string } } } }
      >
    }
  }
  assertExists(statusPath)
  assertEquals(statusPath.post.tags, ['Commands'])
  assertEquals(
    statusPath.post.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/CommandStatusRequest',
  )
  assertEquals(
    statusPath.post.responses['200']?.content?.['application/json'].schema.$ref,
    '#/components/schemas/CommandStatusResponse',
  )
  assertExists(statusPath.post.responses['400'])

  assertExists(spec.components.schemas.CommandStatusRequest)
  assertExists(spec.components.schemas.CommandStatusResponse)
  const record = spec.components.schemas.CommandStatusRecord as {
    properties: Record<string, unknown>
  }
  assertExists(record)
  // The batched projection is deliberately lean.
  assertEquals('payload' in record.properties, false)
  assertEquals('result' in record.properties, false)
  assertEquals('context' in record.properties, false)
})

test('repository OpenAPI documents forgeId on connect flows and connection rows', () => {
  const spec = getClientOpenApiSpec('https://localhost:8443') as {
    paths: Record<string, {
      get?: { parameters?: Array<{ name: string; in: string }> }
    }>
    components: {
      schemas: {
        GitProviderConnectionRecord: { properties: Record<string, unknown> }
      }
    }
  }

  const githubInstall = spec.paths[`${CLIENT_API_PREFIX}/repositories/github/install`]
  const gitlabOauth = spec.paths[`${CLIENT_API_PREFIX}/repositories/gitlab/oauth`]
  assertEquals(
    githubInstall?.get?.parameters?.some((param) => param.in === 'query' && param.name === 'forgeId'),
    true,
  )
  assertEquals(
    gitlabOauth?.get?.parameters?.some((param) => param.in === 'query' && param.name === 'forgeId'),
    true,
  )
  assertEquals(
    githubInstall?.get?.parameters?.some((param) => param.name === 'appId'),
    false,
  )
  assertEquals(
    gitlabOauth?.get?.parameters?.some((param) => param.name === 'appId'),
    false,
  )
  assertExists(spec.components.schemas.GitProviderConnectionRecord.properties.forgeId)
})
