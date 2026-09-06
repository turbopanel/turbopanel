import { assertEquals } from '@std/assert'
import {
  composeSourceDigest,
  parseContainerNamingInput,
  parseDefaultServerIdInput,
  parseProjectOptions,
  resolveContainerNaming,
  resolveDefaultServerId,
  resolveEffectivePlacementServerId,
} from './project-options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_A = '11111111-1111-4111-8111-111111111111'
const SERVER_B = '22222222-2222-4222-8222-222222222222'

test('parseProjectOptions reads containerNaming and defaultServerId', () => {
  const options = parseProjectOptions({
    containerNaming: 'custom',
    defaultServerId: SERVER_A,
    compose: { services: {} },
  })
  assertEquals(options, {
    containerNaming: 'custom',
    defaultServerId: SERVER_A,
  })
})

test('parseProjectOptions drops invalid containerNaming and defaultServerId', () => {
  assertEquals(parseProjectOptions({ containerNaming: 'random' }), {})
  assertEquals(parseProjectOptions({ defaultServerId: 'not-a-uuid' }), {})
  assertEquals(parseProjectOptions({ defaultServerId: null }), {})
  assertEquals(parseProjectOptions(null), {})
})

test('parseProjectOptions keeps a valid composeSource and drops a failed parse', async () => {
  const sourceId = '00000000-0000-4000-8000-000000000001'
  const seededDigest = await composeSourceDigest('services: {}\n')
  const composeSource = {
    sourceId,
    path: 'compose.yaml',
    seededCommitSha: 'a'.repeat(40),
    seededDigest,
  }
  assertEquals(parseProjectOptions({ composeSource }).composeSource, composeSource)
  assertEquals(parseProjectOptions({ composeSource: { sourceId: '' } }), {})
})

test('parseContainerNamingInput accepts uuid and custom only', () => {
  assertEquals(parseContainerNamingInput('uuid'), { ok: true, value: 'uuid' })
  assertEquals(parseContainerNamingInput('custom'), { ok: true, value: 'custom' })
  assertEquals(parseContainerNamingInput('other'), { ok: false })
})

test('parseDefaultServerIdInput accepts UUID or null', () => {
  assertEquals(parseDefaultServerIdInput(SERVER_A), {
    ok: true,
    value: SERVER_A,
  })
  assertEquals(parseDefaultServerIdInput(null), { ok: true, value: null })
  assertEquals(parseDefaultServerIdInput('bad'), { ok: false })
})

test('resolveContainerNaming defaults to uuid', () => {
  assertEquals(resolveContainerNaming(undefined), 'uuid')
  assertEquals(resolveContainerNaming({}), 'uuid')
  assertEquals(resolveContainerNaming({ containerNaming: 'custom' }), 'custom')
})

test('resolveDefaultServerId and effective placement inherit project default', () => {
  assertEquals(resolveDefaultServerId(undefined), null)
  assertEquals(resolveDefaultServerId({ defaultServerId: SERVER_A }), SERVER_A)
  assertEquals(
    resolveEffectivePlacementServerId(null, { defaultServerId: SERVER_A }),
    SERVER_A,
  )
  assertEquals(
    resolveEffectivePlacementServerId(SERVER_B, { defaultServerId: SERVER_A }),
    SERVER_B,
  )
  assertEquals(resolveEffectivePlacementServerId(null, {}), null)
})
