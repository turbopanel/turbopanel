import { assertEquals } from '@std/assert'
import {
  loadDatacenterCidrs,
  loadDatacenterSubnets,
  loadDatacenterSubnetsForServers,
  loadDatacenterAddressPreferences,
  loadDatacenterPolicies,
  assertDatacenterHasCidr,
  assertGatewayRelaysReady,
  assertServerDatacenterReady,
  resolveDerivedAdvertisedCidrsByRelay,
  serverIsMemberOfDatacenter,
} from './datacenter-networks.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function createQueuedDb(
  queue: Array<Array<Record<string, unknown>>>,
): Parameters<typeof loadDatacenterCidrs>[0] {
  let i = 0
  return {
    select() {
      const value = queue[i++] ?? []
      const chain = {
        async limit() {
          return value
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(value).then(resolve, reject)
        },
      }
      return {
        from() {
          return {
            where() {
              return chain
            },
          }
        },
      }
    },
  } as unknown as Parameters<typeof loadDatacenterCidrs>[0]
}

function membershipPinRow(
  serverId: string,
  datacenterId: string,
  address = '203.0.113.10',
): Record<string, unknown> {
  return {
    ipId: `ip-${serverId}-${datacenterId}`,
    serverId,
    datacenterId,
    networkId: `net-${datacenterId}`,
    address,
  }
}

test('loadDatacenterCidrs returns empty map for empty id list without querying', async () => {
  const db = createQueuedDb([[{ should: 'not-run' }]])
  const map = await loadDatacenterCidrs(db, [])
  assertEquals(map.size, 0)
})

test('loadDatacenterCidrs groups cidrs by datacenter id', async () => {
  const db = createQueuedDb([[
    { datacenterId: 'dc-a', cidr: '10.0.0.0/24' },
    { datacenterId: 'dc-a', cidr: '10.0.1.0/24' },
    { datacenterId: 'dc-b', cidr: '10.1.0.0/16' },
    { datacenterId: null, cidr: '10.9.0.0/24' },
    { datacenterId: 'dc-c', cidr: null },
  ]])
  const map = await loadDatacenterCidrs(db, ['dc-a', 'dc-b', 'dc-c'])
  assertEquals(map.get('dc-a'), ['10.0.0.0/24', '10.0.1.0/24'])
  assertEquals(map.get('dc-b'), ['10.1.0.0/16'])
  assertEquals(map.has('dc-c'), false)
})

test('loadDatacenterSubnets groups mixed-family rows and derives version', async () => {
  const db = createQueuedDb([[
    { id: 'net-v4', datacenterId: 'dc-a', cidr: '203.0.113.0/24' },
    { id: 'net-v6', datacenterId: 'dc-a', cidr: '2001:db8::/32' },
    { id: 'net-b', datacenterId: 'dc-b', cidr: '198.51.100.0/24' },
    { id: 'net-bad', datacenterId: 'dc-a', cidr: 'not-a-cidr' },
    { id: 'net-orphan', datacenterId: null, cidr: '203.0.113.0/24' },
  ]])
  const map = await loadDatacenterSubnets(db, ['dc-a', 'dc-b'])
  assertEquals(map.get('dc-a'), [
    { networkId: 'net-v4', cidr: '203.0.113.0/24', version: 4, name: null },
    { networkId: 'net-v6', cidr: '2001:db8::/32', version: 6, name: null },
  ])
  assertEquals(map.get('dc-b'), [
    { networkId: 'net-b', cidr: '198.51.100.0/24', version: 4, name: null },
  ])
})

test('loadDatacenterAddressPreferences defaults missing and invalid options to ipv6', async () => {
  const db = createQueuedDb([[
    { id: 'dc-default', options: null },
    { id: 'dc-v4', options: { addressPreference: 'ipv4' } },
    { id: 'dc-bad', options: { addressPreference: 'dual' } },
  ]])
  const map = await loadDatacenterAddressPreferences(db, [
    'dc-missing',
    'dc-default',
    'dc-v4',
    'dc-bad',
  ])
  assertEquals(map.get('dc-missing'), 'ipv6')
  assertEquals(map.get('dc-default'), 'ipv6')
  assertEquals(map.get('dc-v4'), 'ipv4')
  assertEquals(map.get('dc-bad'), 'ipv6')
})

test('loadDatacenterAddressPreferences returns empty map for empty id list', async () => {
  const db = createQueuedDb([[{ should: 'not-run' }]])
  const map = await loadDatacenterAddressPreferences(db, [])
  assertEquals(map.size, 0)
})

test('loadDatacenterPolicies seeds defaults for missing rows and drops invalid values', async () => {
  const db = createQueuedDb([[
    { id: 'dc-default', options: null },
    { id: 'dc-set', options: { addressPreference: 'ipv4', priority: 7, trusted: false } },
    {
      id: 'dc-bad',
      options: { addressPreference: 'dual', priority: 1.5, trusted: 'no' },
    },
    { id: 'dc-range', options: { priority: 5000 } },
  ]])
  const map = await loadDatacenterPolicies(db, [
    'dc-missing',
    'dc-default',
    'dc-set',
    'dc-bad',
    'dc-range',
  ])
  const defaults = { addressPreference: 'ipv6', priority: 100, trusted: true }
  assertEquals(map.get('dc-missing'), defaults)
  assertEquals(map.get('dc-default'), defaults)
  assertEquals(map.get('dc-set'), {
    addressPreference: 'ipv4',
    priority: 7,
    trusted: false,
  })
  assertEquals(map.get('dc-bad'), defaults)
  assertEquals(map.get('dc-range'), defaults)
  assertEquals(map.size, 5)
})

test('loadDatacenterPolicies returns empty map for empty id list', async () => {
  const db = createQueuedDb([[{ should: 'not-run' }]])
  const map = await loadDatacenterPolicies(db, [])
  assertEquals(map.size, 0)
})

test('assertDatacenterHasCidr fails when no CIDR rows exist', async () => {
  const db = createQueuedDb([[]])
  assertEquals(await assertDatacenterHasCidr(db, 'dc-a'), {
    kind: 'datacenter_cidr_required',
    datacenterId: 'dc-a',
  })
})

test('assertDatacenterHasCidr succeeds when a CIDR row exists', async () => {
  const db = createQueuedDb([[
    { datacenterId: 'dc-a', cidr: '10.0.0.0/24' },
  ]])
  assertEquals(await assertDatacenterHasCidr(db, 'dc-a'), null)
})

test('assertServerDatacenterReady requires a pin and a site CIDR', async () => {
  assertEquals(
    await assertServerDatacenterReady(
      createQueuedDb([[{ datacenterId: null }]]),
      'srv-1',
    ),
    { kind: 'datacenter_required', serverId: 'srv-1' },
  )

  assertEquals(
    await assertServerDatacenterReady(
      createQueuedDb([
        [membershipPinRow('srv-1', 'dc-a')],
        [],
      ]),
      'srv-1',
    ),
    { kind: 'datacenter_cidr_required', datacenterId: 'dc-a' },
  )

  assertEquals(
    await assertServerDatacenterReady(
      createQueuedDb([
        [membershipPinRow('srv-1', 'dc-a')],
        [{ datacenterId: 'dc-a', cidr: '10.0.0.0/24' }],
      ]),
      'srv-1',
    ),
    null,
  )
})

test('assertServerDatacenterReady succeeds when a later pin datacenter has a subnet', async () => {
  assertEquals(
    await assertServerDatacenterReady(
      createQueuedDb([
        [
          membershipPinRow('srv-1', 'dc-empty'),
          membershipPinRow('srv-1', 'dc-ok', '198.51.100.10'),
        ],
        [],
        [{ id: 'net-ok', datacenterId: 'dc-ok', cidr: '198.51.100.0/24' }],
      ]),
      'srv-1',
    ),
    null,
  )
})

test('assertServerDatacenterReady names the first pin datacenter when none have a subnet', async () => {
  assertEquals(
    await assertServerDatacenterReady(
      createQueuedDb([
        [
          membershipPinRow('srv-1', 'dc-a'),
          membershipPinRow('srv-1', 'dc-b', '198.51.100.10'),
        ],
        [],
        [],
      ]),
      'srv-1',
    ),
    { kind: 'datacenter_cidr_required', datacenterId: 'dc-a' },
  )
})

test('assertGatewayRelaysReady ignores member relays', async () => {
  const db = createQueuedDb([[{ should: 'not-run' }]])
  assertEquals(
    await assertGatewayRelaysReady(db, [
      { serverId: 'srv-1', role: 'member' },
      { serverId: 'srv-2', role: 'member' },
    ]),
    null,
  )
})

test('assertGatewayRelaysReady maps placement errors onto gateway wire codes', async () => {
  assertEquals(
    await assertGatewayRelaysReady(
      createQueuedDb([[{ datacenterId: null }]]),
      [{ serverId: 'gw-1', role: 'gateway' }],
    ),
    { kind: 'gateway_datacenter_required', serverId: 'gw-1' },
  )

  assertEquals(
    await assertGatewayRelaysReady(
      createQueuedDb([
        [membershipPinRow('gw-2', 'dc-a')],
        [],
      ]),
      [{ serverId: 'gw-2', role: 'gateway' }],
    ),
    { kind: 'gateway_datacenter_cidr_required', datacenterId: 'dc-a' },
  )

  assertEquals(
    await assertGatewayRelaysReady(
      createQueuedDb([
        [membershipPinRow('gw-3', 'dc-a')],
        [{ datacenterId: 'dc-a', cidr: '10.0.0.0/24' }],
      ]),
      [{ serverId: 'gw-3', role: 'gateway' }],
    ),
    null,
  )
})

test('assertGatewayRelaysReady returns the first gateway failure when multiple are checked', async () => {
  assertEquals(
    await assertGatewayRelaysReady(
      createQueuedDb([
        [{ datacenterId: null }],
      ]),
      [
        { serverId: 'gw-bad', role: 'gateway' },
        { serverId: 'gw-ok', role: 'gateway' },
      ],
    ),
    { kind: 'gateway_datacenter_required', serverId: 'gw-bad' },
  )
})

test('loadDatacenterSubnetsForServers returns empty map for empty input without querying', async () => {
  const db = createQueuedDb([[{ should: 'not-run' }]])
  const map = await loadDatacenterSubnetsForServers(db, [])
  assertEquals(map.size, 0)
})

test('loadDatacenterSubnetsForServers groups and dedupes by networkId across multiple pins', async () => {
  const db = createQueuedDb([
    [
      membershipPinRow('srv-1', 'dc-a', '203.0.113.10'),
      {
        ...membershipPinRow('srv-1', 'dc-a', '203.0.113.11'),
        ipId: 'ip-srv-1-dc-a-nic2',
        networkId: 'net-dc-a-v4',
      },
      membershipPinRow('srv-1', 'dc-b', '198.51.100.10'),
      membershipPinRow('srv-2', 'dc-a', '203.0.113.20'),
    ],
    [
      {
        id: 'net-dc-a-v4',
        datacenterId: 'dc-a',
        cidr: '203.0.113.0/24',
        name: 'a-v4',
      },
      {
        id: 'net-dc-a-v6',
        datacenterId: 'dc-a',
        cidr: '2001:db8::/32',
        name: 'a-v6',
      },
      {
        id: 'net-dc-b',
        datacenterId: 'dc-b',
        cidr: '198.51.100.0/24',
        name: 'b-v4',
      },
    ],
  ])
  const map = await loadDatacenterSubnetsForServers(db, ['srv-1', 'srv-2'])
  assertEquals(map.get('srv-1'), [
    {
      networkId: 'net-dc-b',
      cidr: '198.51.100.0/24',
      version: 4,
      name: 'b-v4',
    },
    {
      networkId: 'net-dc-a-v6',
      cidr: '2001:db8::/32',
      version: 6,
      name: 'a-v6',
    },
    {
      networkId: 'net-dc-a-v4',
      cidr: '203.0.113.0/24',
      version: 4,
      name: 'a-v4',
    },
  ])
  assertEquals(map.get('srv-2'), [
    {
      networkId: 'net-dc-a-v6',
      cidr: '2001:db8::/32',
      version: 6,
      name: 'a-v6',
    },
    {
      networkId: 'net-dc-a-v4',
      cidr: '203.0.113.0/24',
      version: 4,
      name: 'a-v4',
    },
  ])
})

test('resolveDerivedAdvertisedCidrsByRelay returns empty for members', () => {
  const map = resolveDerivedAdvertisedCidrsByRelay(
    [{
      id: 'r-mem',
      serverId: 'srv-1',
      role: 'member',
      advertisedCidrs: ['203.0.113.0/24'],
    }],
    new Map([
      ['srv-1', [{
        networkId: 'net-a',
        cidr: '203.0.113.0/24',
        version: 4,
        name: null,
      }]],
    ]),
  )
  assertEquals(map.get('r-mem'), [])
})

test('resolveDerivedAdvertisedCidrsByRelay keeps a non-empty override verbatim', () => {
  const map = resolveDerivedAdvertisedCidrsByRelay(
    [{
      id: 'r-gw',
      serverId: 'srv-1',
      role: 'gateway',
      advertisedCidrs: ['2001:db8::/32', '203.0.113.0/24'],
    }],
    new Map([
      ['srv-1', [{
        networkId: 'net-a',
        cidr: '198.51.100.0/24',
        version: 4,
        name: null,
      }]],
    ]),
  )
  assertEquals(map.get('r-gw'), ['2001:db8::/32', '203.0.113.0/24'])
})

test('resolveDerivedAdvertisedCidrsByRelay derives both IPv4 subnets of a datacenter', () => {
  const map = resolveDerivedAdvertisedCidrsByRelay(
    [{
      id: 'r-gw',
      serverId: 'srv-1',
      role: 'gateway',
      advertisedCidrs: [],
    }],
    new Map([
      ['srv-1', [
        {
          networkId: 'net-b',
          cidr: '198.51.100.0/24',
          version: 4,
          name: null,
        },
        {
          networkId: 'net-a',
          cidr: '203.0.113.0/24',
          version: 4,
          name: null,
        },
      ]],
    ]),
  )
  assertEquals(map.get('r-gw'), ['198.51.100.0/24', '203.0.113.0/24'])
})

test('resolveDerivedAdvertisedCidrsByRelay derives only IPv4 from a mixed-family datacenter', () => {
  const map = resolveDerivedAdvertisedCidrsByRelay(
    [{
      id: 'r-gw',
      serverId: 'srv-1',
      role: 'gateway',
      advertisedCidrs: [],
    }],
    new Map([
      ['srv-1', [
        {
          networkId: 'net-v6',
          cidr: '2001:db8::/32',
          version: 6,
          name: null,
        },
        {
          networkId: 'net-v4',
          cidr: '203.0.113.0/24',
          version: 4,
          name: null,
        },
      ]],
    ]),
  )
  assertEquals(map.get('r-gw'), ['203.0.113.0/24'])
})

test('resolveDerivedAdvertisedCidrsByRelay assigns a shared subnet to the smallest deriving relay id', () => {
  const subnets = [
    {
      networkId: 'net-v4',
      cidr: '203.0.113.0/24',
      version: 4 as const,
      name: null,
    },
  ]
  const map = resolveDerivedAdvertisedCidrsByRelay(
    [
      {
        id: 'r-zzz',
        serverId: 'srv-z',
        role: 'gateway',
        advertisedCidrs: [],
      },
      {
        id: 'r-aaa',
        serverId: 'srv-a',
        role: 'gateway',
        advertisedCidrs: [],
      },
    ],
    new Map([
      ['srv-z', subnets],
      ['srv-a', subnets],
    ]),
  )
  assertEquals(map.get('r-aaa'), ['203.0.113.0/24'])
  assertEquals(map.get('r-zzz'), [])
})

test('serverIsMemberOfDatacenter is true when a pin row exists', async () => {
  const db = createQueuedDb([[{ id: 'ip-1' }]])
  assertEquals(await serverIsMemberOfDatacenter(db, 'srv-1', 'dc-a'), true)
})

test('serverIsMemberOfDatacenter is false when no pin exists', async () => {
  const db = createQueuedDb([[]])
  assertEquals(await serverIsMemberOfDatacenter(db, 'srv-1', 'dc-a'), false)
})

test('resolveDerivedAdvertisedCidrsByRelay dedupes identical IPv4 cidrs', () => {
  const map = resolveDerivedAdvertisedCidrsByRelay(
    [{
      id: 'r-gw',
      serverId: 'srv-1',
      role: 'gateway',
      advertisedCidrs: [],
    }],
    new Map([
      ['srv-1', [
        {
          networkId: 'net-a',
          cidr: '203.0.113.0/24',
          version: 4,
          name: null,
        },
        {
          networkId: 'net-a-dup',
          cidr: '203.0.113.0/24',
          version: 4,
          name: null,
        },
      ]],
    ]),
  )
  assertEquals(map.get('r-gw'), ['203.0.113.0/24'])
})

test('loadDatacenterSubnets coerces non-string ids and names', async () => {
  const db = createQueuedDb([[
    { id: 17, datacenterId: 'dc-a', cidr: '203.0.113.0/24', name: 9 },
  ]])
  const map = await loadDatacenterSubnets(db, ['dc-a'])
  assertEquals(map.get('dc-a'), [
    { networkId: '', cidr: '203.0.113.0/24', version: 4, name: null },
  ])
})

test('assertGatewayRelaysReady accepts a multi-subnet datacenter and still emits the two gateway wire codes', async () => {
  assertEquals(
    await assertGatewayRelaysReady(
      createQueuedDb([
        [membershipPinRow('gw-multi', 'dc-a')],
        [
          { id: 'net-a', datacenterId: 'dc-a', cidr: '203.0.113.0/24' },
          { id: 'net-b', datacenterId: 'dc-a', cidr: '198.51.100.0/24' },
        ],
      ]),
      [{ serverId: 'gw-multi', role: 'gateway' }],
    ),
    null,
  )

  assertEquals(
    await assertGatewayRelaysReady(
      createQueuedDb([[{ datacenterId: null }]]),
      [{ serverId: 'gw-1', role: 'gateway' }],
    ),
    { kind: 'gateway_datacenter_required', serverId: 'gw-1' },
  )

  assertEquals(
    await assertGatewayRelaysReady(
      createQueuedDb([
        [membershipPinRow('gw-2', 'dc-a')],
        [],
      ]),
      [{ serverId: 'gw-2', role: 'gateway' }],
    ),
    { kind: 'gateway_datacenter_cidr_required', datacenterId: 'dc-a' },
  )
})
