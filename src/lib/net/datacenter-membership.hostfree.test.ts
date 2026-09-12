/**
 * Host-free coverage for datacenter membership address/CIDR helpers.
 */

import { assertEquals } from '@std/assert'
import {
  countUnassignedServersAmong,
  isReportedPrivateAddress,
  loadDatacenterDisplayNames,
  loadDatacenterMembershipsForDatacenter,
  loadDatacenterMembershipsForServers,
  loadServerDatacenterPinAddress,
  loadSiteNetworkId,
  normalizeReportedPrivateAddresses,
  reportedAddressesFromServerMetadata,
  reportedCidrForAddress,
  resolveSubnetForAddress,
  sharedDatacenterIds,
  siteCidrForAddress,
  validateMemberPinAddress,
} from './datacenter-membership.ts'
import type { DatacenterSubnetRow } from './datacenter-networks.ts'
import type { ServerReportedIp } from '../../server-addresses.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function createQueuedDb(
  queue: Array<Array<Record<string, unknown>>>,
): Parameters<typeof loadDatacenterMembershipsForServers>[0] {
  let i = 0
  return {
    select() {
      const value = queue[i++] ?? []
      const chain = {
        async limit() {
          return value
        },
        then(
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown,
        ) {
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
  } as unknown as Parameters<typeof loadDatacenterMembershipsForServers>[0]
}

const V4_SUBNET: DatacenterSubnetRow = {
  networkId: 'net-v4',
  cidr: '203.0.113.0/24',
  version: 4,
  name: null,
}
const V6_SUBNET: DatacenterSubnetRow = {
  networkId: 'net-v6',
  cidr: '2001:db8::/32',
  version: 6,
  name: null,
}

test('reportedCidrForAddress uses the aligned interface prefix', () => {
  const metadata = {
    ips: [
      { address: '10.0.0.10', version: 4, scope: 'private', cidr: '10.0.0.10/24' },
    ],
  }
  assertEquals(reportedCidrForAddress(metadata, '10.0.0.10'), '10.0.0.0/24')
  assertEquals(reportedCidrForAddress(metadata, '10.0.0.11'), null)
  assertEquals(
    reportedCidrForAddress(
      { ips: [{ address: '10.0.0.10', version: 4, scope: 'private' }] },
      '10.0.0.10',
    ),
    null,
  )
  assertEquals(reportedCidrForAddress(null, '10.0.0.10'), null)
})

test('siteCidrForAddress infers a typical LAN when the prefix is omitted', () => {
  const withoutPrefix = {
    ips: [{ address: '10.0.0.10', version: 4, scope: 'private' }],
  }
  assertEquals(siteCidrForAddress(withoutPrefix, '10.0.0.10'), '10.0.0.0/24')
  assertEquals(reportedCidrForAddress(withoutPrefix, '10.0.0.10'), null)
  assertEquals(
    siteCidrForAddress(
      {
        ips: [
          {
            address: '10.0.0.10',
            version: 4,
            scope: 'private',
            cidr: '10.0.0.10/16',
          },
        ],
      },
      '10.0.0.10',
    ),
    '10.0.0.0/16',
  )
  assertEquals(siteCidrForAddress(withoutPrefix, '10.0.0.11'), null)
})

test('validateMemberPinAddress still requires a reported host IP in CIDR', () => {
  const metadata = {
    ips: [
      { address: '10.0.0.10', version: 4, scope: 'private', cidr: '10.0.0.0/24' },
    ],
  }
  assertEquals(
    validateMemberPinAddress('10.0.0.10', '10.0.0.0/24', metadata),
    { ok: true, address: '10.0.0.10' },
  )
  assertEquals(
    validateMemberPinAddress('10.0.0.10', '10.0.1.0/24', metadata).ok,
    false,
  )
  assertEquals(
    validateMemberPinAddress('10.0.0.11', '10.0.0.0/24', metadata).ok,
    false,
  )
})

test('resolveSubnetForAddress matches the first containing subnet', () => {
  const subnets = [V6_SUBNET, V4_SUBNET]
  assertEquals(
    resolveSubnetForAddress(subnets, '203.0.113.10'),
    V4_SUBNET,
  )
  assertEquals(resolveSubnetForAddress(subnets, '2001:db8::10'), V6_SUBNET)
  assertEquals(resolveSubnetForAddress(subnets, '198.51.100.10'), null)
  assertEquals(resolveSubnetForAddress([V4_SUBNET], '2001:db8::10'), null)
})

test('validateMemberPinAddress matches a later subnet and returns its networkId', () => {
  const metadata = {
    ips: [
      {
        address: '203.0.113.10',
        version: 4,
        scope: 'private',
        cidr: '203.0.113.0/24',
      },
    ],
  }
  assertEquals(
    validateMemberPinAddress(
      '203.0.113.10',
      [V6_SUBNET, V4_SUBNET],
      metadata,
    ),
    { ok: true, address: '203.0.113.10', networkId: 'net-v4' },
  )
})

test('validateMemberPinAddress rejects an address in no subnet', () => {
  const metadata = {
    ips: [
      {
        address: '198.51.100.10',
        version: 4,
        scope: 'private',
        cidr: '198.51.100.0/24',
      },
    ],
  }
  assertEquals(
    validateMemberPinAddress('198.51.100.10', [V4_SUBNET, V6_SUBNET], metadata),
    { ok: false, error: 'address_not_in_any_subnet' },
  )
})

test('validateMemberPinAddress rejects a matching address that is not reported', () => {
  const metadata = {
    ips: [
      {
        address: '203.0.113.11',
        version: 4,
        scope: 'private',
        cidr: '203.0.113.0/24',
      },
    ],
  }
  assertEquals(
    validateMemberPinAddress('203.0.113.10', [V4_SUBNET], metadata),
    { ok: false, error: 'address_not_reported' },
  )
})

test('loadDatacenterMembershipsForServers derives family for v4 and v6 pins', async () => {
  const db = createQueuedDb([[
    {
      ipId: 'ip-v4',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-v4',
      address: '203.0.113.10',
    },
    {
      ipId: 'ip-v6',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-v6',
      address: '2001:db8::10',
    },
    {
      ipId: 'ip-bad',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-bad',
      address: 'not-an-ip',
    },
  ]])
  const map = await loadDatacenterMembershipsForServers(db, ['s1'])
  assertEquals(map.get('s1'), [
    {
      ipId: 'ip-v4',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-v4',
      address: '203.0.113.10',
      family: 4,
    },
    {
      ipId: 'ip-v6',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-v6',
      address: '2001:db8::10',
      family: 6,
    },
  ])
})

test('resolveSubnetForAddress returns null for a blank address', () => {
  assertEquals(resolveSubnetForAddress([V4_SUBNET], '   '), null)
})

test('validateMemberPinAddress rejects invalid CIDR and invalid addresses', () => {
  const metadata = {
    ips: [
      {
        address: '203.0.113.10',
        version: 4,
        scope: 'private',
        cidr: '203.0.113.0/24',
      },
    ],
  }
  assertEquals(
    validateMemberPinAddress('203.0.113.10', 'not-a-cidr', metadata),
    { ok: false, error: 'invalid_cidr' },
  )
  assertEquals(
    validateMemberPinAddress('not-an-ip', [V4_SUBNET], metadata),
    { ok: false, error: 'invalid_address' },
  )
  assertEquals(
    validateMemberPinAddress('   ', '203.0.113.0/24', metadata),
    { ok: false, error: 'invalid_address' },
  )
})

test('reported address helpers normalize private daemon IPs', () => {
  const metadata: { ips: ServerReportedIp[] } = {
    ips: [
      { address: '203.0.113.10', version: 4, scope: 'private' },
      { address: 'not-an-ip', version: 4, scope: 'private' },
      { address: '203.0.113.99', version: 4, scope: 'public' },
    ],
  }
  assertEquals(normalizeReportedPrivateAddresses(metadata.ips), [
    '203.0.113.10',
  ])
  assertEquals(reportedAddressesFromServerMetadata(metadata), [
    '203.0.113.10',
  ])
  assertEquals(isReportedPrivateAddress(metadata, '203.0.113.10/32'), true)
  assertEquals(isReportedPrivateAddress(metadata, '203.0.113.11'), false)
})

test('sharedDatacenterIds returns a sorted unique intersection', () => {
  assertEquals(
    sharedDatacenterIds(
      [
        {
          ipId: 'a1',
          serverId: 's1',
          datacenterId: 'dc-b',
          networkId: null,
          address: '203.0.113.1',
          family: 4,
        },
        {
          ipId: 'a2',
          serverId: 's1',
          datacenterId: 'dc-a',
          networkId: null,
          address: '198.51.100.1',
          family: 4,
        },
        {
          ipId: 'a3',
          serverId: 's1',
          datacenterId: 'dc-b',
          networkId: null,
          address: '203.0.113.2',
          family: 4,
        },
      ],
      [
        {
          ipId: 'b1',
          serverId: 's2',
          datacenterId: 'dc-b',
          networkId: null,
          address: '203.0.113.20',
          family: 4,
        },
        {
          ipId: 'b2',
          serverId: 's2',
          datacenterId: 'dc-c',
          networkId: null,
          address: '192.0.2.1',
          family: 4,
        },
      ],
    ),
    ['dc-b'],
  )
})

test('loadDatacenterMembershipsForDatacenter skips incomplete pins', async () => {
  const db = createQueuedDb([[
    {
      ipId: 'ip-ok',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-v4',
      address: '203.0.113.10',
    },
    {
      ipId: 'ip-orphan',
      serverId: null,
      datacenterId: 'dc-a',
      networkId: 'net-v4',
      address: '203.0.113.11',
    },
    {
      ipId: 'ip-empty-dc',
      serverId: 's2',
      datacenterId: null,
      networkId: 'net-v4',
      address: '203.0.113.12',
    },
    {
      ipId: 'ip-bad-family',
      serverId: 's3',
      datacenterId: 'dc-a',
      networkId: 'net-v4',
      address: 'not-an-ip',
    },
  ]])
  assertEquals(await loadDatacenterMembershipsForDatacenter(db, 'dc-a'), [
    {
      ipId: 'ip-ok',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-v4',
      address: '203.0.113.10',
      family: 4,
      metadata: null,
    },
  ])
})

test('loadServerDatacenterPinAddress returns the address or null', async () => {
  assertEquals(
    await loadServerDatacenterPinAddress(
      createQueuedDb([[{ address: '203.0.113.10' }]]),
      's1',
      'dc-a',
    ),
    '203.0.113.10',
  )
  assertEquals(
    await loadServerDatacenterPinAddress(createQueuedDb([[]]), 's1', 'dc-a'),
    null,
  )
})

test('loadDatacenterDisplayNames maps ids and skips empty input', async () => {
  assertEquals((await loadDatacenterDisplayNames(createQueuedDb([[]]), [])).size, 0)
  const map = await loadDatacenterDisplayNames(
    createQueuedDb([[
      { id: 'dc-a', name: 'Alpha' },
      { id: 'dc-b', name: null },
    ]]),
    ['dc-a', 'dc-b'],
  )
  assertEquals(map.get('dc-a'), 'Alpha')
  assertEquals(map.get('dc-b'), null)
})

test('loadSiteNetworkId returns the first site subnet or null', async () => {
  assertEquals(
    await loadSiteNetworkId(
      createQueuedDb([[{ id: 'net-1', cidr: '203.0.113.0/24' }]]),
      'dc-a',
    ),
    { networkId: 'net-1', cidr: '203.0.113.0/24' },
  )
  assertEquals(
    await loadSiteNetworkId(createQueuedDb([[{ id: 'net-1', cidr: null }]]), 'dc-a'),
    null,
  )
})

test('countUnassignedServersAmong counts servers without pins', async () => {
  const db = createQueuedDb([[
    {
      ipId: 'ip-1',
      serverId: 's1',
      datacenterId: 'dc-a',
      networkId: 'net-v4',
      address: '203.0.113.10',
    },
  ]])
  const result = await countUnassignedServersAmong(db, ['s1', 's2', 's3'])
  assertEquals([...result.memberServerIds], ['s1'])
  assertEquals(result.unassignedCount, 2)
})
