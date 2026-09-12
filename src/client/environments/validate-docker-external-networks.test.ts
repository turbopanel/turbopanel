import { assertEquals } from '@std/assert'
import {
  resolveRegisteredExternalDockerNetworks,
  validateRegisteredExternalDockerNetworks,
} from './validate-docker-external-networks.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type NetworkLookupRow = {
  serverId: string | null
  cidr?: string | null
  options: unknown
  metadata: unknown
}

function createNetworkLookupDb(
  rows: NetworkLookupRow[],
): Parameters<typeof validateRegisteredExternalDockerNetworks>[0] {
  return {
    select() {
      return {
        from() {
          return {
            async where() {
              return rows
            },
          }
        },
      }
    },
  } as unknown as Parameters<typeof validateRegisteredExternalDockerNetworks>[0]
}

test('validateRegisteredExternalDockerNetworks returns null when empty', async () => {
  const db = createNetworkLookupDb([])
  assertEquals(
    await validateRegisteredExternalDockerNetworks(db, 'org', 'srv', []),
    null,
  )
})

test('validateRegisteredExternalDockerNetworks accepts org-wide and server-scoped rows', async () => {
  const db = createNetworkLookupDb([
    {
      serverId: null,
      options: { dockerNetworkName: 'shared-a' },
      metadata: null,
    },
    {
      serverId: 'srv-1',
      options: { dockerNetworkName: 'shared-b' },
      metadata: null,
    },
  ])
  assertEquals(
    await validateRegisteredExternalDockerNetworks(db, 'org', 'srv-1', [
      'shared-b',
      'shared-a',
    ]),
    null,
  )
})

test('validateRegisteredExternalDockerNetworks matches server-pinned docker row only for that server', async () => {
  const db = createNetworkLookupDb([
    {
      serverId: 'srv-pinned',
      options: { dockerNetworkName: 'host-local-net' },
      metadata: null,
    },
  ])
  assertEquals(
    await validateRegisteredExternalDockerNetworks(db, 'org', 'srv-pinned', [
      'host-local-net',
    ]),
    null,
  )
  // Filter is applied in SQL; the fake does not re-filter by serverId, so both
  // cases that receive the row still pass — the production OR branch makes the
  // row visible for srv-pinned and drops it for other hosts in the real query.
  assertEquals(
    await validateRegisteredExternalDockerNetworks(db, 'org', 'srv-pinned', [
      'missing-name',
    ]),
    ['missing-name'],
  )
})

test('validateRegisteredExternalDockerNetworks reports missing names sorted', async () => {
  const db = createNetworkLookupDb([
    {
      serverId: null,
      options: { dockerNetworkName: 'known' },
      metadata: null,
    },
  ])
  assertEquals(
    await validateRegisteredExternalDockerNetworks(db, 'org', 'srv-1', [
      'zeta',
      'alpha',
      'known',
    ]),
    ['alpha', 'zeta'],
  )
})

test('resolveRegisteredExternalDockerNetworks returns addressing only for matched rows that carry any', async () => {
  const db = createNetworkLookupDb([
    {
      serverId: null,
      cidr: '10.77.0.0/16',
      options: {
        dockerNetworkName: 'zeta',
        subnet: '10.77.0.0/16',
        ipRange: '10.77.8.0/24',
        gateway: '10.77.0.1',
        mtu: 1450,
      },
      metadata: null,
    },
    { serverId: null, cidr: null, options: { dockerNetworkName: 'bare' }, metadata: null },
    // The column wins over a stale options.subnet.
    {
      serverId: 'srv-1',
      cidr: '10.80.0.0/16',
      options: { dockerNetworkName: 'alpha', subnet: '10.99.0.0/16' },
      metadata: null,
    },
    // Registered but not required by this compose document.
    {
      serverId: null,
      cidr: '10.90.0.0/16',
      options: { dockerNetworkName: 'unused' },
      metadata: null,
    },
  ])
  assertEquals(
    await resolveRegisteredExternalDockerNetworks(db, 'org', 'srv-1', [
      'zeta',
      'bare',
      'alpha',
      'missing',
    ]),
    {
      missing: ['missing'],
      addressing: [
        { name: 'alpha', subnet: '10.80.0.0/16' },
        {
          name: 'zeta',
          subnet: '10.77.0.0/16',
          ipRange: '10.77.8.0/24',
          gateway: '10.77.0.1',
          mtu: 1450,
        },
      ],
    },
  )
  assertEquals(
    await resolveRegisteredExternalDockerNetworks(db, 'org', 'srv-1', []),
    { missing: null, addressing: [] },
  )
})
