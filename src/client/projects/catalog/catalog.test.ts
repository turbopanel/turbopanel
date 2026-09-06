import { assertEquals } from '@std/assert'
import { getManagedEngineSpec } from '../../../lib/managed/index.ts'
import {
  getCatalogEntry,
  isCreateProjectType,
  isManagedEngineCatalogEntry,
  listCatalog,
  listManagedCatalogEntries,
  MANAGED_ENGINE_CODES,
  readManagedEngineOptions,
  resolveCatalogVariablePlaintext,
  type CatalogEntry,
} from './index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PRINCIPAL_PROVIDERS = new Set([
  'server',
  'postgres',
  'mysql',
  'redis',
  'clickhouse',
])

test('listCatalog includes all managed engine codes as kind managed', () => {
  const byCode = new Map(listCatalog().map((entry) => [entry.code, entry]))
  for (const code of MANAGED_ENGINE_CODES) {
    const summary = byCode.get(code)
    assertEquals(summary?.kind, 'managed', `${code} missing or wrong kind`)
  }
})

test('isManagedEngineCatalogEntry is true for engines and false for templates', () => {
  for (const code of MANAGED_ENGINE_CODES) {
    const entry = getCatalogEntry(code)
    if (!entry) throw new TypeError(`missing catalog entry ${code}`)
    assertEquals(isManagedEngineCatalogEntry(entry), true)
  }

  const wordpress = getCatalogEntry('wordpress-mysql')
  if (!wordpress) throw new TypeError('missing wordpress-mysql')
  assertEquals(wordpress.kind, 'template')
  assertEquals(isManagedEngineCatalogEntry(wordpress), false)

  const staticSite = getCatalogEntry('static-site')
  if (!staticSite) throw new TypeError('missing static-site')
  assertEquals(isManagedEngineCatalogEntry(staticSite), false)
})

test('readManagedEngineOptions returns validated engine metadata', () => {
  for (const code of MANAGED_ENGINE_CODES) {
    const entry = getCatalogEntry(code)
    if (!entry) throw new TypeError(`missing catalog entry ${code}`)
    const options = readManagedEngineOptions(entry)
    if (!options) throw new TypeError(`expected engine options for ${code}`)
    assertEquals(options.engine, code)
    assertEquals(options.port > 0, true, `${code} port must be positive`)
    assertEquals(options.rootUsername.length > 0, true)
    assertEquals(
      PRINCIPAL_PROVIDERS.has(options.provider),
      true,
      `${code} provider ${options.provider} not in principal check set`,
    )
  }

  const wordpress = getCatalogEntry('wordpress-mysql')
  if (!wordpress) throw new TypeError('missing wordpress-mysql')
  assertEquals(wordpress.kind, 'template')
  assertEquals(readManagedEngineOptions(wordpress), null)
})

test('each managed engine declares one environment with one secret and no plaintext default', () => {
  for (const code of MANAGED_ENGINE_CODES) {
    const entry = getCatalogEntry(code)
    if (!entry) throw new TypeError(`missing catalog entry ${code}`)
    assertEquals(entry.environments.length, 1, `${code} environment count`)
    const variables = entry.environments[0]?.variables ?? []
    assertEquals(variables.length, 1, `${code} variable count`)
    const variable = variables[0]!
    assertEquals(variable.isSecret, true)
    assertEquals(variable.value, undefined)
  }
})

test('PRINCIPAL_PROVIDERS includes clickhouse and ClickHouse catalog uses it', () => {
  assertEquals(PRINCIPAL_PROVIDERS.has('clickhouse'), true)
  const entry = getCatalogEntry('clickhouse')
  if (!entry) throw new TypeError('missing clickhouse')
  const options = readManagedEngineOptions(entry)
  if (!options) throw new TypeError('expected clickhouse options')
  assertEquals(options.provider, 'clickhouse')
})

test('available catalog engines match managed engine spec defaults', () => {
  for (const code of ['postgres', 'mysql', 'mariadb'] as const) {
    const spec = getManagedEngineSpec(code)
    if (!spec) throw new TypeError(`${code} spec missing`)
    const entry = getCatalogEntry(code)
    if (!entry) throw new TypeError(`missing ${code}`)
    const services = entry.compose.data.services as Record<string, { image?: string }>
    assertEquals(services[code]?.image, spec.defaultImage)
  }
})

function stubManagedEntry(
  options: Record<string, unknown> | undefined,
): CatalogEntry {
  return {
    code: 'postgres',
    kind: 'managed',
    displayName: 'PostgreSQL',
    description: 'stub',
    compose: {
      version: 1,
      data: {},
      presentation: { keyOrder: [], comments: {} },
    },
    environments: [],
    ...(options === undefined ? {} : { options }),
  }
}

test('readManagedEngineOptions rejects incomplete or mismatched engine options', () => {
  assertEquals(readManagedEngineOptions(stubManagedEntry(undefined)), null)
  assertEquals(readManagedEngineOptions(stubManagedEntry({})), null)
  assertEquals(
    readManagedEngineOptions(stubManagedEntry({
      engine: 'mysql',
      rootUsername: 'postgres',
      provider: 'postgres',
      port: 5432,
    })),
    null,
  )
  assertEquals(
    readManagedEngineOptions(stubManagedEntry({
      engine: 'postgres',
      rootUsername: '',
      provider: 'postgres',
      port: 5432,
    })),
    null,
  )
  assertEquals(
    readManagedEngineOptions(stubManagedEntry({
      engine: 'postgres',
      rootUsername: 'postgres',
      provider: 'not-a-provider',
      port: 5432,
    })),
    null,
  )
  assertEquals(
    readManagedEngineOptions(stubManagedEntry({
      engine: 'postgres',
      rootUsername: 'postgres',
      provider: 'postgres',
      port: 0,
    })),
    null,
  )
})

test('resolveCatalogVariablePlaintext generates and reuses shared secrets', () => {
  const shared = new Map<string, string>()
  assertEquals(
    resolveCatalogVariablePlaintext({ key: 'NAME', isSecret: false, value: 'app' }, shared),
    'app',
  )
  let missing = false
  try {
    resolveCatalogVariablePlaintext({ key: 'NAME', isSecret: false }, shared)
  } catch (err) {
    missing = err instanceof TypeError
  }
  assertEquals(missing, true)

  const first = resolveCatalogVariablePlaintext({
    key: 'A',
    isSecret: true,
    sharedCredentialId: 'db',
  }, shared)
  const second = resolveCatalogVariablePlaintext({
    key: 'B',
    isSecret: true,
    sharedCredentialId: 'db',
  }, shared)
  assertEquals(first.length > 0, true)
  assertEquals(second, first)

  const unique = resolveCatalogVariablePlaintext({ key: 'C', isSecret: true }, shared)
  assertEquals(unique.length > 0, true)
  assertEquals(unique === first, false)
})

test('isCreateProjectType and listManagedCatalogEntries cover catalog helpers', () => {
  assertEquals(isCreateProjectType('docker-compose'), true)
  assertEquals(isCreateProjectType('template'), true)
  assertEquals(isCreateProjectType('managed'), true)
  assertEquals(isCreateProjectType('system'), false)
  assertEquals(getCatalogEntry('no-such-code'), undefined)

  const managed = listManagedCatalogEntries()
  assertEquals(managed.every((entry) => entry.kind === 'managed'), true)
  for (const code of MANAGED_ENGINE_CODES) {
    assertEquals(managed.some((entry) => entry.code === code), true)
  }
})
