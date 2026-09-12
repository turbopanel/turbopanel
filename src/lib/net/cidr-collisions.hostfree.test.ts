/**
 * Host-free coverage for the CIDR collision authority (no Postgres): every
 * error code, precedence, the exclude-self case a `PATCH` relies on, and the
 * allocator exclusion list.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import { fabric, ip, network, organization, relay } from '../db/schema.ts'
import {
  assertCidrAvailable,
  assertCidrsAvailable,
  cidrWriteIntentForKind,
  findCidrCollision,
  loadCidrAllocationExclusions,
  loadOrganizationCidrRegistry,
  type OrganizationCidrRegistry,
} from './cidr-collisions.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '11111111-1111-4111-8111-111111111111'
const DC_A = '22222222-2222-4222-8222-222222222222'
const DC_B = '33333333-3333-4333-8333-333333333333'
const FABRIC_ID = '44444444-4444-4444-8444-444444444444'
const SERVER_A = '55555555-5555-4555-8555-555555555555'
const SERVER_B = '66666666-6666-4666-8666-666666666666'
const RELAY_A = '77777777-7777-4777-8777-777777777777'
const RELAY_B = '88888888-8888-4888-8888-888888888888'
const NET_SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NET_SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NET_RESERVED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NET_DOCKER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

type Row = Record<string, unknown>

type TableRows = {
  fabric?: Row[]
  network?: Row[]
  relay?: Row[]
  ip?: Row[]
  organization?: Row[]
}

function thenableRows(rows: Row[]) {
  const promise = Promise.resolve(rows)
  return Object.assign(promise, {
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
  })
}

/**
 * Table-keyed double: every `select().from(<table>).where(...)` returns the
 * seeded rows verbatim (conditions ignored — scenarios are small and scoped).
 */
function createDb(tables: TableRows): Db & { selects: string[] } {
  const selects: string[] = []
  const rowsFor = (table: unknown): Row[] => {
    if (table === fabric) return tables.fabric ?? []
    if (table === network) return tables.network ?? []
    if (table === relay) return tables.relay ?? []
    if (table === ip) return tables.ip ?? []
    if (table === organization) return tables.organization ?? []
    return []
  }
  const nameFor = (table: unknown): string => {
    if (table === fabric) return 'fabric'
    if (table === network) return 'network'
    if (table === relay) return 'relay'
    if (table === ip) return 'ip'
    if (table === organization) return 'organization'
    return 'other'
  }
  return {
    selects,
    select: () => ({
      from: (table: unknown) => {
        selects.push(nameFor(table))
        return { where: () => thenableRows(rowsFor(table)) }
      },
    }),
  } as unknown as Db & { selects: string[] }
}

const FABRIC_ROW: Row = {
  id: FABRIC_ID,
  cidr: '10.250.0.0/16',
  options: { containerPool: '10.192.0.0/12' },
}

const SITE_A: Row = {
  id: NET_SITE_A,
  kind: 'datacenter',
  cidr: '10.10.0.0/24',
  datacenterId: DC_A,
  name: 'lan-a',
}
const SITE_B: Row = {
  id: NET_SITE_B,
  kind: 'datacenter',
  cidr: '10.20.0.0/24',
  datacenterId: DC_B,
  name: 'lan-b',
}
const RESERVED: Row = {
  id: NET_RESERVED,
  kind: 'reserved',
  cidr: '10.100.0.0/16',
  datacenterId: null,
  name: 'Corp VPN — Chicago branch',
}
const DOCKER: Row = {
  id: NET_DOCKER,
  kind: 'docker',
  cidr: '172.18.0.0/16',
  datacenterId: null,
  name: 'bridge',
}

test('assertCidrAvailable returns null for a free range', async () => {
  const db = createDb({ fabric: [FABRIC_ROW], network: [SITE_A, RESERVED, DOCKER] })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.30.0.0/24',
    intent: 'datacenter',
    datacenterId: DC_A,
  })
  assertEquals(hit, null)
})

test('cidr_overlaps_fabric — candidate inside the tp0 host range', async () => {
  const db = createDb({ fabric: [FABRIC_ROW] })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.250.8.0/24',
    intent: 'reserved',
  })
  assertEquals(hit, {
    code: 'cidr_overlaps_fabric',
    cidr: '10.250.8.0/24',
    conflictingCidr: '10.250.0.0/16',
    networkId: null,
    datacenterId: null,
  })
})

test('cidr_overlaps_fabric_pool — candidate inside the container pool (default pool applies)', async () => {
  const db = createDb({
    fabric: [{ id: FABRIC_ID, cidr: '10.250.0.0/16', options: null }],
  })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.200.0.0/16',
    intent: 'datacenter',
    datacenterId: DC_A,
  })
  assertEquals(hit?.code, 'cidr_overlaps_fabric_pool')
  assertEquals(hit?.conflictingCidr, '10.192.0.0/12')
})

test('fabric checks are skipped when the organization has no fabric', async () => {
  const db = createDb({})
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.250.0.0/16',
    intent: 'reserved',
  })
  assertEquals(hit, null)
  // No fabric → no relay lookup either.
  assertEquals(db.selects.includes('relay'), false)
})

test('cidr_overlaps_reserved — candidate hits an operator-reserved range', async () => {
  const db = createDb({ network: [RESERVED] })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.100.42.0/24',
    intent: 'datacenter',
    datacenterId: DC_A,
  })
  assertEquals(hit, {
    code: 'cidr_overlaps_reserved',
    cidr: '10.100.42.0/24',
    conflictingCidr: '10.100.0.0/16',
    networkId: NET_RESERVED,
    datacenterId: null,
  })
})

test('cidr_overlaps_reserved — a wider reserved candidate swallowing an existing reserved row', async () => {
  const db = createDb({ network: [RESERVED] })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.0.0.0/8',
    intent: 'reserved',
  })
  assertEquals(hit?.code, 'cidr_overlaps_reserved')
  assertEquals(hit?.networkId, NET_RESERVED)
})

test('cidr_overlaps_docker_network — candidate hits a docker registration with a CIDR', async () => {
  const db = createDb({ network: [DOCKER] })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '172.18.5.0/24',
    intent: 'reserved',
  })
  assertEquals(hit, {
    code: 'cidr_overlaps_docker_network',
    cidr: '172.18.5.0/24',
    conflictingCidr: '172.18.0.0/16',
    networkId: NET_DOCKER,
    datacenterId: null,
  })
})

test('cidr_overlaps_docker_network — a managed row carrying a CIDR counts too', async () => {
  const db = createDb({
    network: [{
      id: NET_DOCKER,
      kind: 'managed',
      cidr: '172.30.0.0/16',
      datacenterId: null,
    }],
  })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '172.30.0.0/24',
    intent: 'docker',
  })
  assertEquals(hit?.code, 'cidr_overlaps_docker_network')
})

test('subnet_overlaps — another subnet in the same datacenter', async () => {
  const db = createDb({ network: [SITE_A] })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.10.0.128/25',
    intent: 'datacenter',
    datacenterId: DC_A,
  })
  assertEquals(hit, {
    code: 'subnet_overlaps',
    cidr: '10.10.0.128/25',
    conflictingCidr: '10.10.0.0/24',
    networkId: NET_SITE_A,
    datacenterId: DC_A,
  })
})

test('subnet_overlaps — org-wide default when the other datacenter has no gateway', async () => {
  const db = createDb({ fabric: [FABRIC_ROW], network: [SITE_A, SITE_B] })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.20.0.0/25',
    intent: 'datacenter',
    datacenterId: DC_A,
  })
  assertEquals(hit?.code, 'subnet_overlaps')
  assertEquals(hit?.networkId, NET_SITE_B)
  assertEquals(hit?.datacenterId, DC_B)
})

const GATEWAY_RELAYS: Row[] = [
  { id: RELAY_A, serverId: SERVER_A, role: 'gateway', advertisedCidrs: [] },
  { id: RELAY_B, serverId: SERVER_B, role: 'gateway', advertisedCidrs: [] },
]
const GATEWAY_PINS: Row[] = [
  {
    ipId: '11111111-aaaa-4aaa-8aaa-111111111111',
    serverId: SERVER_A,
    datacenterId: DC_A,
    networkId: NET_SITE_A,
    address: '10.10.0.2',
  },
  {
    ipId: '22222222-bbbb-4bbb-8bbb-222222222222',
    serverId: SERVER_B,
    datacenterId: DC_B,
    networkId: NET_SITE_B,
    address: '10.20.0.2',
  },
]

test('cidr_overlaps_gateway_advertised — both datacenters have a gateway relay', async () => {
  const db = createDb({
    fabric: [FABRIC_ROW],
    network: [SITE_A, SITE_B],
    relay: GATEWAY_RELAYS,
    ip: GATEWAY_PINS,
  })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.20.0.0/25',
    intent: 'datacenter',
    datacenterId: DC_A,
  })
  assertEquals(hit, {
    code: 'cidr_overlaps_gateway_advertised',
    cidr: '10.20.0.0/25',
    conflictingCidr: '10.20.0.0/24',
    networkId: NET_SITE_B,
    datacenterId: DC_B,
  })
})

test('gateway code is not used when only the other datacenter has a gateway', async () => {
  const db = createDb({
    fabric: [FABRIC_ROW],
    network: [SITE_A, SITE_B],
    relay: [GATEWAY_RELAYS[1]!],
    ip: [GATEWAY_PINS[1]!],
  })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.20.0.0/25',
    intent: 'datacenter',
    datacenterId: DC_A,
  })
  assertEquals(hit?.code, 'subnet_overlaps')
})

test('gateway code is not used when the candidate datacenter is unknown (POST /datacenters)', async () => {
  const db = createDb({
    fabric: [FABRIC_ROW],
    network: [SITE_A, SITE_B],
    relay: GATEWAY_RELAYS,
    ip: GATEWAY_PINS,
  })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.20.0.0/25',
    intent: 'datacenter',
  })
  assertEquals(hit?.code, 'subnet_overlaps')
})

test('gateway code honours an operator advertised-CIDR override', async () => {
  const db = createDb({
    fabric: [FABRIC_ROW],
    network: [SITE_A, SITE_B],
    relay: [
      GATEWAY_RELAYS[0]!,
      { ...GATEWAY_RELAYS[1]!, advertisedCidrs: ['192.168.50.0/24'] },
    ],
    ip: GATEWAY_PINS,
  })
  // The override replaces the derived list, so SITE_B is no longer advertised
  // (falls back to the org-wide default) …
  const site = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.20.0.0/25',
    intent: 'datacenter',
    datacenterId: DC_A,
  })
  assertEquals(site?.code, 'subnet_overlaps')
  // … while the override itself is what AllowedIPs would carry.
  const override = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '192.168.50.0/26',
    intent: 'datacenter',
    datacenterId: DC_A,
  })
  assertEquals(override, {
    code: 'cidr_overlaps_gateway_advertised',
    cidr: '192.168.50.0/26',
    conflictingCidr: '192.168.50.0/24',
    networkId: null,
    datacenterId: DC_B,
  })
})

test('IPv6 site subnets are never auto-advertised, so they fall back to subnet_overlaps', async () => {
  const siteB6: Row = {
    id: NET_SITE_B,
    kind: 'datacenter',
    cidr: '2001:db8:20::/64',
    datacenterId: DC_B,
  }
  const db = createDb({
    fabric: [FABRIC_ROW],
    network: [SITE_A, siteB6],
    relay: GATEWAY_RELAYS,
    ip: GATEWAY_PINS,
  })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '2001:db8:20::/80',
    intent: 'datacenter',
    datacenterId: DC_A,
  })
  assertEquals(hit?.code, 'subnet_overlaps')
  assertEquals(hit?.conflictingCidr, '2001:db8:20::/64')
})

test('cross-family candidates never collide', async () => {
  const db = createDb({ fabric: [FABRIC_ROW], network: [SITE_A, RESERVED, DOCKER] })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '2001:db8::/48',
    intent: 'reserved',
  })
  assertEquals(hit, null)
})

test('precedence: fabric beats pool beats reserved beats docker beats subnet', () => {
  const registry: OrganizationCidrRegistry = {
    fabricCidr: '10.0.0.0/16',
    containerPool: '10.0.0.0/12',
    dockerHostCidrs: [],
    networks: [
      { networkId: NET_RESERVED, kind: 'reserved', cidr: '10.0.0.0/8', datacenterId: null },
      { networkId: NET_DOCKER, kind: 'docker', cidr: '10.0.0.0/8', datacenterId: null },
      { networkId: NET_SITE_A, kind: 'datacenter', cidr: '10.0.0.0/8', datacenterId: DC_A },
    ],
    gateways: [],
  }
  const candidate = { cidr: '10.0.1.0/24', intent: 'datacenter' as const, datacenterId: DC_A }
  assertEquals(findCidrCollision(registry, candidate)?.code, 'cidr_overlaps_fabric')
  assertEquals(
    findCidrCollision({ ...registry, fabricCidr: null }, candidate)?.code,
    'cidr_overlaps_fabric_pool',
  )
  const noFabric = { ...registry, fabricCidr: null, containerPool: null }
  assertEquals(findCidrCollision(noFabric, candidate)?.code, 'cidr_overlaps_reserved')
  const noReserved = {
    ...noFabric,
    networks: noFabric.networks.filter((row) => row.kind !== 'reserved'),
  }
  assertEquals(findCidrCollision(noReserved, candidate)?.code, 'cidr_overlaps_docker_network')
  const onlySite = {
    ...noReserved,
    networks: noReserved.networks.filter((row) => row.kind === 'datacenter'),
  }
  assertEquals(findCidrCollision(onlySite, candidate)?.code, 'subnet_overlaps')
})

test('excludeNetworkId lets a PATCH keep or narrow its own range', async () => {
  const db = createDb({ network: [RESERVED, SITE_A] })
  // Unchanged CIDR on the row itself is not a collision …
  assertEquals(
    await assertCidrAvailable(db, {
      organizationId: ORG,
      cidr: '10.100.0.0/16',
      intent: 'reserved',
      excludeNetworkId: NET_RESERVED,
    }),
    null,
  )
  // … nor is narrowing it …
  assertEquals(
    await assertCidrAvailable(db, {
      organizationId: ORG,
      cidr: '10.100.8.0/24',
      intent: 'reserved',
      excludeNetworkId: NET_RESERVED,
    }),
    null,
  )
  // … but the same candidate without the exclusion still collides …
  assertEquals(
    (await assertCidrAvailable(db, {
      organizationId: ORG,
      cidr: '10.100.8.0/24',
      intent: 'reserved',
    }))?.code,
    'cidr_overlaps_reserved',
  )
  // … and excluding one row never hides a different one.
  assertEquals(
    (await assertCidrAvailable(db, {
      organizationId: ORG,
      cidr: '10.10.0.0/24',
      intent: 'reserved',
      excludeNetworkId: NET_RESERVED,
    }))?.code,
    'subnet_overlaps',
  )
})

test('a gateway pinned into the candidate datacenter never conflicts, even when multi-pinned', async () => {
  const db = createDb({
    fabric: [FABRIC_ROW],
    network: [SITE_A, SITE_B],
    relay: GATEWAY_RELAYS,
    ip: [
      GATEWAY_PINS[0]!,
      GATEWAY_PINS[1]!,
      // SERVER_A is pinned into both datacenters: it advertises SITE_B as
      // well, but a gateway inside the candidate datacenter never conflicts.
      {
        ipId: '33333333-cccc-4ccc-8ccc-333333333333',
        serverId: SERVER_A,
        datacenterId: DC_B,
        networkId: NET_SITE_B,
        address: '10.20.0.3',
      },
    ],
  })
  // Re-ranging SITE_B itself: every gateway that advertises 10.20.0.0/24 is
  // pinned into DC_B, so the only remaining comparison is the excluded row.
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.20.0.0/25',
    intent: 'datacenter',
    datacenterId: DC_B,
    excludeNetworkId: NET_SITE_B,
  })
  assertEquals(hit, null)
})

test('assertCidrsAvailable rejects candidates that overlap each other before touching the registry', async () => {
  const db = createDb({ network: [RESERVED] })
  const hit = await assertCidrsAvailable(db, {
    organizationId: ORG,
    cidrs: ['10.40.0.0/24', '10.41.0.0/24', '10.40.0.0/25'],
    intent: 'datacenter',
  })
  assertEquals(hit, {
    code: 'subnet_overlaps',
    cidr: '10.40.0.0/25',
    conflictingCidr: '10.40.0.0/24',
    networkId: null,
    datacenterId: null,
  })
  assertEquals(db.selects.length, 0)
})

test('assertCidrsAvailable loads the registry once and reports the first registry hit', async () => {
  const db = createDb({ fabric: [FABRIC_ROW], network: [RESERVED, SITE_A] })
  const hit = await assertCidrsAvailable(db, {
    organizationId: ORG,
    cidrs: ['10.40.0.0/24', '10.40.0.0/24', '10.100.1.0/24', '10.10.0.0/24'],
    intent: 'datacenter',
    datacenterId: DC_B,
  })
  assertEquals(hit?.code, 'cidr_overlaps_reserved')
  assertEquals(hit?.cidr, '10.100.1.0/24')
  assertEquals(db.selects.filter((name) => name === 'network').length, 1)
  assertEquals(db.selects.filter((name) => name === 'fabric').length, 1)
})

test('assertCidrsAvailable with no candidates is a no-op', async () => {
  const db = createDb({ network: [RESERVED] })
  assertEquals(
    await assertCidrsAvailable(db, { organizationId: ORG, cidrs: [], intent: 'datacenter' }),
    null,
  )
  assertEquals(db.selects.length, 0)
})

test('loadOrganizationCidrRegistry skips CIDR-less and malformed rows', async () => {
  const db = createDb({
    fabric: [FABRIC_ROW],
    network: [
      SITE_A,
      { id: 'x', kind: 'compose', cidr: null, datacenterId: null },
      { id: 'y', kind: 'docker', cidr: '   ', datacenterId: null },
      { id: 'z', kind: 7, cidr: '10.1.0.0/24', datacenterId: null },
    ],
    relay: [{ id: RELAY_A, serverId: SERVER_A, role: 'member', advertisedCidrs: [] }],
  })
  const registry = await loadOrganizationCidrRegistry(db, ORG)
  assertEquals(registry.fabricCidr, '10.250.0.0/16')
  assertEquals(registry.containerPool, '10.192.0.0/12')
  assertEquals(registry.networks.map((row) => row.networkId), [NET_SITE_A])
  assertEquals(registry.gateways, [])
})

test('loadCidrAllocationExclusions returns every registered CIDR plus the fabric host range, deduplicated', async () => {
  const db = createDb({
    fabric: [FABRIC_ROW],
    network: [SITE_A, SITE_B, RESERVED, DOCKER, { ...DOCKER, id: 'dup' }],
  })
  assertEquals(await loadCidrAllocationExclusions(db, ORG), [
    '10.10.0.0/24',
    '10.20.0.0/24',
    '10.100.0.0/16',
    '172.18.0.0/16',
    '10.250.0.0/16',
  ])
})

test('cidrWriteIntentForKind maps registry kinds onto write intents', () => {
  assertEquals(cidrWriteIntentForKind('datacenter'), 'datacenter')
  assertEquals(cidrWriteIntentForKind('reserved'), 'reserved')
  assertEquals(cidrWriteIntentForKind('docker'), 'docker')
  assertEquals(cidrWriteIntentForKind('managed'), 'docker')
  assertEquals(cidrWriteIntentForKind('compose'), 'docker')
})

const ORG_WITH_POOLS: Row = {
  id: ORG,
  options: {
    docker: {
      addressPools: [
        { base: '10.200.0.0/16', size: 24 },
        { base: '10.201.0.0/16', size: 24 },
      ],
    },
  },
}

test('cidr_overlaps_docker_network — candidate hits an org Docker address pool', async () => {
  const db = createDb({ organization: [ORG_WITH_POOLS] })
  const hit = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.201.7.0/24',
    intent: 'datacenter',
    datacenterId: DC_A,
  })
  assertEquals(hit, {
    code: 'cidr_overlaps_docker_network',
    cidr: '10.201.7.0/24',
    conflictingCidr: '10.201.0.0/16',
    networkId: null,
    datacenterId: null,
  })
  assertEquals(db.selects.includes('organization'), true)
})

test('excludeDockerHostCidrs lets the docker PUT replace the stored pools/bridge without colliding with them', async () => {
  const db = createDb({ organization: [ORG_WITH_POOLS], network: [SITE_A] })
  const narrowed = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.200.0.0/17',
    intent: 'docker',
    excludeDockerHostCidrs: true,
  })
  assertEquals(narrowed, null)
  // Everything else still applies.
  const site = await assertCidrAvailable(db, {
    organizationId: ORG,
    cidr: '10.10.0.0/16',
    intent: 'docker',
    excludeDockerHostCidrs: true,
  })
  assertEquals(site?.code, 'subnet_overlaps')
  // The stored bridge is part of the same replace-all config, so it is
  // skipped too — the route compares the submitted pair itself.
  const overBridge = await assertCidrAvailable(
    createDb({ organization: [ORG_WITH_BRIDGE] }),
    {
      organizationId: ORG,
      cidr: '172.26.0.0/16',
      intent: 'docker',
      excludeDockerHostCidrs: true,
    },
  )
  assertEquals(overBridge, null)
})

const ORG_WITH_BRIDGE: Row = {
  id: ORG,
  options: {
    docker: {
      addressPools: [{ base: '10.200.0.0/16', size: 24 }],
      defaultBridgeCidr: '172.26.0.1/16',
    },
  },
}

test('cidr_overlaps_docker_network — a stored default bridge keeps later writes out of docker0', async () => {
  const db = createDb({ organization: [ORG_WITH_BRIDGE] })
  // `bip` is a host address; the registry holds the aligned network.
  const registry = await loadOrganizationCidrRegistry(db, ORG)
  assertEquals(registry.dockerHostCidrs, ['10.200.0.0/16', '172.26.0.0/16'])
  for (
    const params of [
      { cidr: '172.26.8.0/24', intent: 'reserved' as const },
      { cidr: '172.26.0.0/20', intent: 'datacenter' as const, datacenterId: DC_A },
      { cidr: '172.16.0.0/12', intent: 'docker' as const },
    ]
  ) {
    const hit = await assertCidrAvailable(db, { organizationId: ORG, ...params })
    assertEquals(hit, {
      code: 'cidr_overlaps_docker_network',
      cidr: params.cidr,
      conflictingCidr: '172.26.0.0/16',
      networkId: null,
      datacenterId: null,
    }, params.cidr)
  }
  // Adjacent range is still free.
  assertEquals(
    await assertCidrAvailable(db, { organizationId: ORG, cidr: '172.27.0.0/16', intent: 'reserved' }),
    null,
  )
})

test('precedence: docker rows beat docker host cidrs, host cidrs beat gateway/site rungs', () => {
  const registry: OrganizationCidrRegistry = {
    fabricCidr: null,
    containerPool: null,
    dockerHostCidrs: ['10.0.0.0/8'],
    networks: [
      { networkId: NET_DOCKER, kind: 'docker', cidr: '10.0.0.0/8', datacenterId: null },
      { networkId: NET_SITE_A, kind: 'datacenter', cidr: '10.0.0.0/8', datacenterId: DC_A },
    ],
    gateways: [],
  }
  const candidate = { cidr: '10.0.1.0/24', intent: 'datacenter' as const, datacenterId: DC_A }
  const rowHit = findCidrCollision(registry, candidate)
  assertEquals(rowHit?.code, 'cidr_overlaps_docker_network')
  assertEquals(rowHit?.networkId, NET_DOCKER)
  const poolHit = findCidrCollision(
    { ...registry, networks: registry.networks.filter((row) => row.kind !== 'docker') },
    candidate,
  )
  assertEquals(poolHit?.code, 'cidr_overlaps_docker_network')
  assertEquals(poolHit?.networkId, null)
  assertEquals(
    findCidrCollision({ ...registry, dockerHostCidrs: [], networks: registry.networks.filter((row) => row.kind !== 'docker') }, candidate)?.code,
    'subnet_overlaps',
  )
})

test('loadOrganizationCidrRegistry carries the org Docker host cidrs (empty when unconfigured)', async () => {
  const withPools = await loadOrganizationCidrRegistry(
    createDb({ fabric: [FABRIC_ROW], organization: [ORG_WITH_POOLS] }),
    ORG,
  )
  assertEquals(withPools.dockerHostCidrs, ['10.200.0.0/16', '10.201.0.0/16'])
  const without = await loadOrganizationCidrRegistry(
    createDb({ organization: [{ id: ORG, options: null }] }),
    ORG,
  )
  assertEquals(without.dockerHostCidrs, [])
  const noOrg = await loadOrganizationCidrRegistry(createDb({}), ORG)
  assertEquals(noOrg.dockerHostCidrs, [])
})

test('loadCidrAllocationExclusions appends the org Docker host cidrs', async () => {
  const db = createDb({
    fabric: [FABRIC_ROW],
    network: [SITE_A],
    organization: [ORG_WITH_POOLS],
  })
  assertEquals(await loadCidrAllocationExclusions(db, ORG), [
    '10.10.0.0/24',
    '10.250.0.0/16',
    '10.200.0.0/16',
    '10.201.0.0/16',
  ])
  // The default bridge network is excluded too, so an allocator never carves
  // a relay prefix or segment inside docker0.
  assertEquals(
    await loadCidrAllocationExclusions(
      createDb({ fabric: [FABRIC_ROW], organization: [ORG_WITH_BRIDGE] }),
      ORG,
    ),
    ['10.250.0.0/16', '10.200.0.0/16', '172.26.0.0/16'],
  )
})
