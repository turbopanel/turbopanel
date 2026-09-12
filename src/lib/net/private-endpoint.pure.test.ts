import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import {
  familiesInDatacenter,
  isPrivateEndpointError,
  loadPublicAddressesForServers,
  loadServerDatacenterAddress,
  loadServerFabricAddress,
  loadServerPublicAddress,
  partitionSharedDatacenters,
  pinAddressForDatacenter,
  preferredFamilyOrder,
  privateEndpointErrorResponse,
  resolvePrivateEndpoint,
  resolvePrivateEndpoints,
  type PrivateEndpointError,
  type PrivateEndpointPurpose,
  type ResolvedPrivateEndpoint,
} from './private-endpoint.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type MembershipPinRow = {
  ipId: string
  serverId: string
  datacenterId: string
  networkId: string | null
  address: string
}
type RelayRow = {
  relayId: string
  serverId: string
  fabricId: string
  fabricCreatedAt: string
  address: string
}

function membershipPin(
  serverId: string,
  datacenterId: string,
  address: string,
): MembershipPinRow {
  return {
    ipId: `ip-${serverId}-${datacenterId}-${address}`,
    serverId,
    datacenterId,
    networkId: null,
    address,
  }
}

type PublicAddressRow = {
  serverId: string
  address: string
}

type Fixture = {
  memberships?: MembershipPinRow[]
  relays?: RelayRow[]
  publicAddresses?: PublicAddressRow[]
  /** Single-row result for loadServerDatacenterAddress / loadServerPublicAddress. */
  singleAddress?: string | null
  datacenterOptions?: Array<{ id: string; options: unknown }>
}

function thenable<T>(value: T) {
  return {
    then(resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject)
    },
  }
}

function createFixtureDb(fixture: Fixture): Parameters<typeof resolvePrivateEndpoint>[0] {
  const memberships = fixture.memberships ?? []
  const relays = fixture.relays ?? []
  const publicAddresses = fixture.publicAddresses ?? []

  return {
    select(fields: Record<string, unknown>) {
      const keys = Object.keys(fields).sort((a, b) => a.localeCompare(b))
      const keySet = new Set(keys)

      // loadServerDatacenterAddress / loadServerPublicAddress: { address }
      if (keys.length === 1 && keySet.has('address')) {
        const rows = fixture.singleAddress === undefined
          ? []
          : fixture.singleAddress === null
          ? []
          : [{ address: fixture.singleAddress }]
        const limited = {
          orderBy() {
            return {
              limit() {
                return rows
              },
            }
          },
        }
        return {
          from() {
            return {
              where() {
                return limited
              },
              innerJoin() {
                return {
                  where() {
                    return limited
                  },
                }
              },
            }
          },
        }
      }

      // loadPublicAddressesForServers: { serverId, address }
      if (
        keys.length === 2 &&
        keySet.has('serverId') &&
        keySet.has('address')
      ) {
        return {
          from() {
            return {
              where() {
                return {
                  orderBy() {
                    return thenable(publicAddresses)
                  },
                }
              },
            }
          },
        }
      }

      // loadDatacenterMembershipsForServers: { ipId, serverId, datacenterId, networkId, address }
      if (
        keySet.has('ipId') &&
        keySet.has('serverId') &&
        keySet.has('datacenterId') &&
        keySet.has('networkId') &&
        keySet.has('address')
      ) {
        return {
          from() {
            return {
              where() {
                return thenable(memberships)
              },
            }
          },
        }
      }

      // membership: { fabricId } only
      if (keys.length === 1 && keySet.has('fabricId')) {
        return {
          from() {
            return {
              where() {
                return thenable(relays.map((row) => ({ fabricId: row.fabricId })))
              },
            }
          },
        }
      }

      // full relay join: relayId, serverId, fabricId, fabricCreatedAt, address
      if (keySet.has('relayId') && keySet.has('fabricCreatedAt')) {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  where() {
                    return {
                      orderBy() {
                        return thenable(relays)
                      },
                    }
                  },
                }
              },
            }
          },
        }
      }

      // loadDatacenterPolicies: { id, options }
      if (keys.length === 2 && keySet.has('id') && keySet.has('options')) {
        return {
          from() {
            return {
              where() {
                return thenable(fixture.datacenterOptions ?? [])
              },
            }
          },
        }
      }

      throw new TypeError(`unexpected select keys: ${keys.join(',')}`)
    },
  } as unknown as Parameters<typeof resolvePrivateEndpoint>[0]
}

function mockContext(): Context {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context
}

test('isPrivateEndpointError is a structural kind guard', () => {
  assertEquals(
    isPrivateEndpointError({ kind: 'datacenter_ip_required', serverId: 's1' }),
    true,
  )
  assertEquals(isPrivateEndpointError(null), false)
  assertEquals(isPrivateEndpointError({ address: '10.0.0.1' }), false)
})

test('privateEndpointErrorResponse returns 422 with error-only body', async () => {
  const c = mockContext()
  const errors: PrivateEndpointError[] = [
    { kind: 'datacenter_ip_required', serverId: 's1' },
    {
      kind: 'private_path_unavailable',
      fromServerId: 'a',
      toServerId: 'b',
    },
    {
      kind: 'private_family_mismatch',
      fromServerId: 'a',
      toServerId: 'b',
      datacenterId: 'dc-a',
    },
    {
      kind: 'failover_requires_trusted_datacenter',
      fromServerId: 'a',
      toServerId: 'b',
      datacenterId: 'dc-a',
    },
  ]
  for (const error of errors) {
    const response = privateEndpointErrorResponse(c, error)
    assertEquals(response.status, 422)
    assertEquals(await response.json(), { error: error.kind })
  }
})

test('loadServerDatacenterAddress returns the address string', async () => {
  const db = createFixtureDb({ singleAddress: '10.0.0.5' })
  assertEquals(await loadServerDatacenterAddress(db, 'srv-1'), '10.0.0.5')
})

test('loadServerDatacenterAddress returns null when missing', async () => {
  const db = createFixtureDb({ singleAddress: null })
  assertEquals(await loadServerDatacenterAddress(db, 'srv-1'), null)
})

test('loadServerPublicAddress returns the address string', async () => {
  const db = createFixtureDb({ singleAddress: '203.0.113.5' })
  assertEquals(await loadServerPublicAddress(db, 'srv-1'), '203.0.113.5')
})

test('loadServerPublicAddress returns null when missing', async () => {
  const db = createFixtureDb({ singleAddress: null })
  assertEquals(await loadServerPublicAddress(db, 'srv-1'), null)
})

test('resolvePrivateEndpoint local same-server is loopback', async () => {
  const db = createFixtureDb({
    memberships: [membershipPin('s1', 'dc-a', '10.0.0.1')],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's1',
  }), {
    address: '127.0.0.1',
    transport: 'local',
  } satisfies ResolvedPrivateEndpoint)
})

test('resolvePrivateEndpoint prefers datacenter when both fabric and datacenter exist', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-a', '10.0.0.2'),
    ],
    relays: [
      {
        relayId: 'r1',
        serverId: 's1',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.1',
      },
      {
        relayId: 'r2',
        serverId: 's2',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.2',
      },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    address: '10.0.0.2',
    transport: 'datacenter',
    datacenterId: 'dc-a',
  })
})

test('resolvePrivateEndpoint prefers fabric over datacenter_ip_required', async () => {
  const db = createFixtureDb({
    memberships: [],
    relays: [
      {
        relayId: 'r1',
        serverId: 's1',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.1',
      },
      {
        relayId: 'r2',
        serverId: 's2',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.2',
      },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    address: '10.250.0.2',
    transport: 'fabric',
    fabricId: 'fabric-1',
  })
})

test('resolvePrivateEndpoint falls back to datacenter when there is no shared fabric', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-a', '10.0.0.2'),
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    address: '10.0.0.2',
    transport: 'datacenter',
    datacenterId: 'dc-a',
  })
})

test('resolvePrivateEndpoint returns private_path_unavailable when membership pins have no address', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', ''),
      membershipPin('s2', 'dc-a', ''),
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    kind: 'private_path_unavailable',
    fromServerId: 's1',
    toServerId: 's2',
  })
})

test('resolvePrivateEndpoint picks lowest fabric.createdAt when multiple meshes share', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-b', '10.1.0.2'),
    ],
    relays: [
      {
        relayId: 'r-new-from',
        serverId: 's1',
        fabricId: 'fabric-new',
        fabricCreatedAt: '2021-01-01T00:00:00.000Z',
        address: '10.251.0.1',
      },
      {
        relayId: 'r-old-from',
        serverId: 's1',
        fabricId: 'fabric-old',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.1',
      },
      {
        relayId: 'r-new-to',
        serverId: 's2',
        fabricId: 'fabric-new',
        fabricCreatedAt: '2021-01-01T00:00:00.000Z',
        address: '10.251.0.2',
      },
      {
        relayId: 'r-old-to',
        serverId: 's2',
        fabricId: 'fabric-old',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.2',
      },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    address: '10.250.0.2',
    transport: 'fabric',
    fabricId: 'fabric-old',
  })
})

test('resolvePrivateEndpoint returns private_path_unavailable when the target has no relay', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-b', '10.1.0.2'),
    ],
    relays: [
      {
        relayId: 'r-from',
        serverId: 's1',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.1',
      },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    kind: 'private_path_unavailable',
    fromServerId: 's1',
    toServerId: 's2',
  })
})

test('resolvePrivateEndpoint returns private_path_unavailable', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-b', '10.1.0.2'),
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    kind: 'private_path_unavailable',
    fromServerId: 's1',
    toServerId: 's2',
  })
})

test('resolvePrivateEndpoints batches multiple targets', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-a', '10.0.0.2'),
      membershipPin('s3', 'dc-a', '10.0.0.3'),
    ],
  })
  const map = await resolvePrivateEndpoints(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerIds: ['s2', 's3', 's1'],
  })
  assertEquals(map.get('s1'), { address: '127.0.0.1', transport: 'local' })
  assertEquals(map.get('s2'), {
    address: '10.0.0.2',
    transport: 'datacenter',
    datacenterId: 'dc-a',
  })
  assertEquals(map.get('s3'), {
    address: '10.0.0.3',
    transport: 'datacenter',
    datacenterId: 'dc-a',
  })
})

test('resolvePrivateEndpoints returns empty map for empty target list', async () => {
  const db = createFixtureDb({})
  const map = await resolvePrivateEndpoints(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerIds: [],
  })
  assertEquals(map.size, 0)
})

test('resolvePrivateEndpoint uses a shared membership when servers pin into many datacenters', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s1', 'dc-b', '10.1.0.1'),
      membershipPin('s2', 'dc-b', '10.1.0.2'),
      membershipPin('s2', 'dc-c', '10.2.0.2'),
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    address: '10.1.0.2',
    transport: 'datacenter',
    datacenterId: 'dc-b',
  })
})

test('resolvePrivateEndpoint prefers ipv6 when both families share a datacenter', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '203.0.113.1'),
      membershipPin('s1', 'dc-a', '2001:db8::1'),
      membershipPin('s2', 'dc-a', '203.0.113.2'),
      membershipPin('s2', 'dc-a', '2001:db8::2'),
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    address: '2001:db8::2',
    transport: 'datacenter',
    datacenterId: 'dc-a',
  })
})

test('resolvePrivateEndpoint honors datacenter ipv4 addressPreference', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '203.0.113.1'),
      membershipPin('s1', 'dc-a', '2001:db8::1'),
      membershipPin('s2', 'dc-a', '203.0.113.2'),
      membershipPin('s2', 'dc-a', '2001:db8::2'),
    ],
    datacenterOptions: [
      { id: 'dc-a', options: { addressPreference: 'ipv4' } },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    address: '203.0.113.2',
    transport: 'datacenter',
    datacenterId: 'dc-a',
  })
})

test('resolvePrivateEndpoint falls back to the only shared family', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '203.0.113.1'),
      membershipPin('s2', 'dc-a', '203.0.113.2'),
      membershipPin('s2', 'dc-a', '2001:db8::2'),
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    address: '203.0.113.2',
    transport: 'datacenter',
    datacenterId: 'dc-a',
  })
})

test('resolvePrivateEndpoint returns private_family_mismatch when shared pins have no common family', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '2001:db8::1'),
      membershipPin('s2', 'dc-a', '203.0.113.2'),
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    kind: 'private_family_mismatch',
    fromServerId: 's1',
    toServerId: 's2',
    datacenterId: 'dc-a',
  })
})

test('resolvePrivateEndpoint skips a family-mismatched datacenter for a compatible shared one', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '2001:db8::1'),
      membershipPin('s1', 'dc-b', '198.51.100.1'),
      membershipPin('s2', 'dc-a', '203.0.113.2'),
      membershipPin('s2', 'dc-b', '198.51.100.2'),
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    address: '198.51.100.2',
    transport: 'datacenter',
    datacenterId: 'dc-b',
  })
})

const CROSS_DC_PUBLIC_FIXTURE: Fixture = {
  memberships: [
    membershipPin('s1', 'dc-a', '10.0.0.1'),
    membershipPin('s2', 'dc-b', '10.1.0.2'),
  ],
  publicAddresses: [
    { serverId: 's2', address: '203.0.113.20' },
  ],
}

test('read-replication falls back to public across datacenters', async () => {
  const db = createFixtureDb(CROSS_DC_PUBLIC_FIXTURE)
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    address: '203.0.113.20',
    transport: 'public',
  })
})

test('client-backend falls back to public across datacenters', async () => {
  const db = createFixtureDb(CROSS_DC_PUBLIC_FIXTURE)
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'client-backend',
    toServerId: 's2',
  }), {
    address: '203.0.113.20',
    transport: 'public',
  })
})

test('failover-replication omits fabric and public when no shared datacenter', async () => {
  const db = createFixtureDb({
    ...CROSS_DC_PUBLIC_FIXTURE,
    relays: [
      {
        relayId: 'r1',
        serverId: 's1',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.1',
      },
      {
        relayId: 'r2',
        serverId: 's2',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.2',
      },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'failover-replication',
    toServerId: 's2',
  }), {
    kind: 'private_path_unavailable',
    fromServerId: 's1',
    toServerId: 's2',
  })
})

test('private_family_mismatch surfaces under every purpose before fabric or public', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '2001:db8::1'),
      membershipPin('s2', 'dc-a', '203.0.113.2'),
    ],
    relays: [
      {
        relayId: 'r1',
        serverId: 's1',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.1',
      },
      {
        relayId: 'r2',
        serverId: 's2',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.2',
      },
    ],
    publicAddresses: [
      { serverId: 's2', address: '203.0.113.20' },
    ],
  })
  const expected: PrivateEndpointError = {
    kind: 'private_family_mismatch',
    fromServerId: 's1',
    toServerId: 's2',
    datacenterId: 'dc-a',
  }
  const purposes: PrivateEndpointPurpose[] = [
    'failover-replication',
    'read-replication',
    'client-backend',
  ]
  for (const purpose of purposes) {
    assertEquals(
      await resolvePrivateEndpoint(db, {
        fromServerId: 's1',
        purpose,
        toServerId: 's2',
      }),
      expected,
    )
  }
})

test('loadServerFabricAddress returns the address or null', async () => {
  assertEquals(
    await loadServerFabricAddress(
      createFixtureDb({ singleAddress: '10.250.0.1' }),
      's1',
    ),
    '10.250.0.1',
  )
  assertEquals(
    await loadServerFabricAddress(createFixtureDb({ singleAddress: null }), 's1'),
    null,
  )
  assertEquals(
    await loadServerFabricAddress(
      createFixtureDb({ singleAddress: 'not-an-ip' }),
      's1',
    ),
    'not-an-ip',
  )
})

test('loadPublicAddressesForServers skips empty input and later duplicate rows', async () => {
  const empty = await loadPublicAddressesForServers(createFixtureDb({}), [])
  assertEquals(empty.size, 0)

  const map = await loadPublicAddressesForServers(
    createFixtureDb({
      publicAddresses: [
        { serverId: 's2', address: '203.0.113.20' },
        { serverId: 's2', address: '203.0.113.21' },
        { serverId: '', address: '203.0.113.22' },
        { serverId: 's3', address: 'not-an-ip' },
      ],
    }),
    ['s2', 's3'],
  )
  assertEquals(map.get('s2'), '203.0.113.20')
  assertEquals(map.has('s3'), false)
})

test('resolvePrivateEndpoint skips blank fabric relay addresses', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '203.0.113.1'),
      membershipPin('s2', 'dc-b', '198.51.100.2'),
    ],
    relays: [
      {
        relayId: 'r1',
        serverId: 's1',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '',
      },
      {
        relayId: 'r2',
        serverId: 's2',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '',
      },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    kind: 'private_path_unavailable',
    fromServerId: 's1',
    toServerId: 's2',
  })
})

test('preferredFamilyOrder and pinAddressForDatacenter honor address preference', () => {
  assertEquals(preferredFamilyOrder('ipv4'), [4, 6])
  assertEquals(preferredFamilyOrder('ipv6'), [6, 4])

  const fromPins = [
    {
      ipId: 'a4',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: null,
      address: '203.0.113.1',
      family: 4 as const,
    },
    {
      ipId: 'a6',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: null,
      address: '2001:db8::1',
      family: 6 as const,
    },
  ]
  const toPins = [
    {
      ipId: 'b4',
      serverId: 's2',
      datacenterId: 'dc-a',
      networkId: null,
      address: '203.0.113.2',
      family: 4 as const,
    },
    {
      ipId: 'b6',
      serverId: 's2',
      datacenterId: 'dc-a',
      networkId: null,
      address: '2001:db8::2',
      family: 6 as const,
    },
  ]
  assertEquals(familiesInDatacenter(fromPins, 'dc-a'), new Set([4, 6]))
  assertEquals(
    pinAddressForDatacenter(fromPins, toPins, 'dc-a', 'ipv4'),
    '203.0.113.2',
  )
  assertEquals(
    pinAddressForDatacenter(fromPins, toPins, 'dc-missing', 'ipv6'),
    null,
  )
})

const TWO_SHARED_DC_MEMBERSHIPS: MembershipPinRow[] = [
  membershipPin('s1', 'dc-a', '10.0.0.1'),
  membershipPin('s1', 'dc-b', '10.1.0.1'),
  membershipPin('s2', 'dc-a', '10.0.0.2'),
  membershipPin('s2', 'dc-b', '10.1.0.2'),
]

test('resolvePrivateEndpoint picks the shared datacenter with the lower priority number', async () => {
  const db = createFixtureDb({
    memberships: TWO_SHARED_DC_MEMBERSHIPS,
    datacenterOptions: [
      { id: 'dc-a', options: { priority: 200 } },
      { id: 'dc-b', options: { priority: 10 } },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'failover-replication',
    toServerId: 's2',
  }), {
    address: '10.1.0.2',
    transport: 'datacenter',
    datacenterId: 'dc-b',
  })
})

test('resolvePrivateEndpoint breaks equal priority by datacenter id', async () => {
  const db = createFixtureDb({
    memberships: TWO_SHARED_DC_MEMBERSHIPS,
    datacenterOptions: [
      { id: 'dc-a', options: { priority: 50 } },
      { id: 'dc-b', options: { priority: 50 } },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    address: '10.0.0.2',
    transport: 'datacenter',
    datacenterId: 'dc-a',
  })
})

const UNTRUSTED_ONLY_FIXTURE: Fixture = {
  memberships: [
    membershipPin('s1', 'dc-shared', '10.0.0.1'),
    membershipPin('s2', 'dc-shared', '10.0.0.2'),
  ],
  datacenterOptions: [
    { id: 'dc-shared', options: { trusted: false } },
  ],
  relays: [
    {
      relayId: 'r1',
      serverId: 's1',
      fabricId: 'fabric-1',
      fabricCreatedAt: '2020-01-01T00:00:00.000Z',
      address: '10.250.0.1',
    },
    {
      relayId: 'r2',
      serverId: 's2',
      fabricId: 'fabric-1',
      fabricCreatedAt: '2020-01-01T00:00:00.000Z',
      address: '10.250.0.2',
    },
  ],
  publicAddresses: [
    { serverId: 's2', address: '203.0.113.20' },
  ],
}

test('failover-replication over an untrusted-only shared datacenter is failover_requires_trusted_datacenter', async () => {
  const db = createFixtureDb(UNTRUSTED_ONLY_FIXTURE)
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'failover-replication',
    toServerId: 's2',
  }), {
    kind: 'failover_requires_trusted_datacenter',
    fromServerId: 's1',
    toServerId: 's2',
    datacenterId: 'dc-shared',
  })
})

test('read-replication and client-backend skip an untrusted shared datacenter and use fabric', async () => {
  const db = createFixtureDb(UNTRUSTED_ONLY_FIXTURE)
  for (const purpose of ['read-replication', 'client-backend'] as const) {
    assertEquals(await resolvePrivateEndpoint(db, {
      fromServerId: 's1',
      purpose,
      toServerId: 's2',
    }), {
      address: '10.250.0.2',
      transport: 'fabric',
      fabricId: 'fabric-1',
    })
  }
})

test('read-replication and client-backend fall from an untrusted shared datacenter to public without fabric', async () => {
  const db = createFixtureDb({ ...UNTRUSTED_ONLY_FIXTURE, relays: [] })
  for (const purpose of ['read-replication', 'client-backend'] as const) {
    assertEquals(await resolvePrivateEndpoint(db, {
      fromServerId: 's1',
      purpose,
      toServerId: 's2',
    }), {
      address: '203.0.113.20',
      transport: 'public',
    })
  }
})

test('failover-replication with no shared datacenter at all stays private_path_unavailable', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-b', '10.1.0.2'),
    ],
    datacenterOptions: [
      { id: 'dc-a', options: { trusted: false } },
      { id: 'dc-b', options: { trusted: false } },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'failover-replication',
    toServerId: 's2',
  }), {
    kind: 'private_path_unavailable',
    fromServerId: 's1',
    toServerId: 's2',
  })
})

test('resolvePrivateEndpoint prefers a trusted shared datacenter over a lower-priority untrusted one', async () => {
  const db = createFixtureDb({
    memberships: TWO_SHARED_DC_MEMBERSHIPS,
    datacenterOptions: [
      { id: 'dc-a', options: { priority: 0, trusted: false } },
      { id: 'dc-b', options: { priority: 900 } },
    ],
  })
  for (const purpose of ['failover-replication', 'read-replication', 'client-backend'] as const) {
    assertEquals(await resolvePrivateEndpoint(db, {
      fromServerId: 's1',
      purpose,
      toServerId: 's2',
    }), {
      address: '10.1.0.2',
      transport: 'datacenter',
      datacenterId: 'dc-b',
    })
  }
})

test('a trusted family mismatch still wins over falling through past an untrusted datacenter', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-trusted', '2001:db8::1'),
      membershipPin('s2', 'dc-trusted', '203.0.113.2'),
      membershipPin('s1', 'dc-untrusted', '10.0.0.1'),
      membershipPin('s2', 'dc-untrusted', '10.0.0.2'),
    ],
    datacenterOptions: [
      { id: 'dc-untrusted', options: { priority: 0, trusted: false } },
    ],
    publicAddresses: [
      { serverId: 's2', address: '203.0.113.20' },
    ],
  })
  for (const purpose of ['failover-replication', 'read-replication', 'client-backend'] as const) {
    assertEquals(await resolvePrivateEndpoint(db, {
      fromServerId: 's1',
      purpose,
      toServerId: 's2',
    }), {
      kind: 'private_family_mismatch',
      fromServerId: 's1',
      toServerId: 's2',
      datacenterId: 'dc-trusted',
    })
  }
})

test('untrusted datacenters never raise a family mismatch', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-untrusted', '2001:db8::1'),
      membershipPin('s2', 'dc-untrusted', '203.0.113.2'),
    ],
    datacenterOptions: [
      { id: 'dc-untrusted', options: { trusted: false } },
    ],
    publicAddresses: [
      { serverId: 's2', address: '203.0.113.20' },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'read-replication',
    toServerId: 's2',
  }), {
    address: '203.0.113.20',
    transport: 'public',
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    purpose: 'failover-replication',
    toServerId: 's2',
  }), {
    kind: 'failover_requires_trusted_datacenter',
    fromServerId: 's1',
    toServerId: 's2',
    datacenterId: 'dc-untrusted',
  })
})

test('partitionSharedDatacenters sorts by (priority, id) and defaults absent policies', () => {
  const pin = (
    serverId: string,
    datacenterId: string,
  ) => ({
    ipId: `${serverId}-${datacenterId}`,
    serverId,
    datacenterId,
    networkId: null,
    address: '10.0.0.1',
    family: 4 as const,
  })
  const fromPins = [
    pin('s1', 'dc-z'),
    pin('s1', 'dc-a'),
    pin('s1', 'dc-m'),
    pin('s1', 'dc-u2'),
    pin('s1', 'dc-u1'),
    pin('s1', 'dc-only-from'),
  ]
  const toPins = [
    pin('s2', 'dc-z'),
    pin('s2', 'dc-a'),
    pin('s2', 'dc-m'),
    pin('s2', 'dc-u2'),
    pin('s2', 'dc-u1'),
    pin('s2', 'dc-only-to'),
  ]
  const policies = new Map([
    ['dc-z', { addressPreference: 'ipv6' as const, priority: 5, trusted: true }],
    ['dc-a', { addressPreference: 'ipv6' as const, priority: 100, trusted: true }],
    ['dc-u2', { addressPreference: 'ipv6' as const, priority: 50, trusted: false }],
    ['dc-u1', { addressPreference: 'ipv6' as const, priority: 50, trusted: false }],
  ])
  // dc-m has no policy row → defaults (priority 100, trusted) → ties with dc-a, id order.
  assertEquals(partitionSharedDatacenters(fromPins, toPins, policies), {
    trusted: ['dc-z', 'dc-a', 'dc-m'],
    untrusted: ['dc-u1', 'dc-u2'],
  })
  assertEquals(partitionSharedDatacenters([], toPins, policies), {
    trusted: [],
    untrusted: [],
  })
})
