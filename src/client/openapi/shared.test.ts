import { assertEquals, assertExists } from '@std/assert'
import {
  buildResourceCrudPaths,
  clientErrorJson,
  resourceErrorResponses,
} from './shared.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resourceErrorResponses includes the requested status family', () => {
  const all = resourceErrorResponses({
    badRequest: true,
    forbidden: true,
    notFound: true,
  })
  assertEquals(Object.keys(all).sort((a, b) => a.localeCompare(b)), [
    '400',
    '401',
    '403',
    '404',
    '503',
  ])
  assertEquals(
    (all['400'] as { content: { 'application/json': { schema: unknown } } })
      .content['application/json'].schema,
    clientErrorJson,
  )

  const noForbidden = resourceErrorResponses({ forbidden: false })
  assertEquals('403' in noForbidden, false)
  assertEquals('400' in noForbidden, false)
  assertEquals('404' in noForbidden, false)
})

test('buildResourceCrudPaths titles the tag from the plural when omitted', () => {
  const paths = buildResourceCrudPaths({
    plural: 'widgets',
    singular: 'widget',
    listSchema: 'WidgetList',
    rowSchema: 'WidgetRecord',
    createSchema: 'CreateWidgetRequest',
    parentQuery: { name: 'projectId', description: 'Scope to a project' },
  })
  const collection = paths['/api/client/v1/widgets'] as {
    get: {
      tags: string[]
      parameters: Array<{ name: string }>
    }
    post: { requestBody: { required: boolean } }
  }
  assertExists(collection)
  assertEquals(collection.get.tags, ['Widgets'])
  assertEquals(collection.get.parameters[0]?.name, 'projectId')
  assertEquals(collection.post.requestBody.required, true)

  const item = paths['/api/client/v1/widgets/{id}'] as {
    patch: {
      requestBody: {
        content: { 'application/json': { schema: { $ref: string } } }
      }
    }
  }
  assertEquals(
    item.patch.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/UpdateEntityRequest',
  )
})
