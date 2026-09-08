import { assertEquals } from '@std/assert'
import { serverSchemas } from './servers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('ServerDeleteBlockersConflict kind enum includes network and container', () => {
  const schema = serverSchemas.ServerDeleteBlockersConflict as {
    properties: {
      blockers: {
        items: {
          properties: {
            kind: { enum: string[] }
          }
        }
      }
    }
  }
  assertEquals(
    schema.properties.blockers.items.properties.kind.enum,
    ['network', 'container'],
  )
})

test('ServerRow documents tierPlacement against ServerTierPlacement', () => {
  const row = serverSchemas.ServerRow as {
    properties: {
      tierPlacement: { oneOf: Array<{ $ref?: string; type?: string }> }
    }
  }
  const placement = serverSchemas.ServerTierPlacement as {
    required: string[]
  }
  assertEquals(placement.required, [
    'licenseTier',
    'requiredTier',
    'recommendedTier',
    'unwatched',
  ])
  assertEquals(
    row.properties.tierPlacement.oneOf.some(
      (entry) => entry.$ref === '#/components/schemas/ServerTierPlacement',
    ),
    true,
  )
})
