import { assertEquals, assertExists } from '@std/assert'
import { buildLicensePaths, buildLicenseSchemas } from './licenses.ts'

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
  const?: unknown
  description?: string
}

const INSTALL_DESC = 'Example install command description'

test('buildLicenseSchemas documents license lifecycle shapes', () => {
  const schemas = buildLicenseSchemas(INSTALL_DESC)
  assertEquals(
    (schemas.LicenseRecord as SchemaObject).required,
    ['id', 'name', 'createdAt', 'revocable', 'boundServer'],
  )
  assertEquals(
    (schemas.CreateLicenseResponse as SchemaObject).required,
    ['licenseId', 'licenseToken', 'installCommand'],
  )
  assertEquals(
    (schemas.CreateLicenseResponse.properties?.installCommand as SchemaObject).description,
    INSTALL_DESC,
  )
  assertEquals((schemas.InvalidateOkResponse.properties?.ok as SchemaObject).const, true)
  assertEquals(
    (schemas.LicenseHasAttachedServerError.properties?.error as SchemaObject).const,
    'license_has_attached_server',
  )
})

test('buildLicensePaths registers list/create/invalidate routes', () => {
  const paths = buildLicensePaths(INSTALL_DESC)
  assertExists(paths['/api/client/v1/licenses'])
  assertExists(paths['/api/client/v1/licenses/{id}'])

  const list = paths['/api/client/v1/licenses'] as {
    get: { tags: string[] }
    post: { responses: Record<string, unknown> }
  }
  assertEquals(list.get.tags, ['Licenses'])
  assertExists(list.post.responses['409'])

  const invalidate = paths['/api/client/v1/licenses/{id}'] as {
    delete: { responses: Record<string, { description: string }> }
  }
  assertEquals(invalidate.delete.responses['403'].description.includes('control plane'), true)
  assertEquals(
    invalidate.delete.responses['409'].description.includes('attached'),
    true,
  )
})
