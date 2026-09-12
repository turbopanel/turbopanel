/**
 * Host-free coverage for managed cluster membership helpers (no Postgres).
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  countReplicas,
  deleteManagedMember,
  ensureManagedPrimaryMember,
  ensureMemberPrivatePorts,
  findManagedMember,
  insertManagedReplicaMember,
  isManagedPrivatePortExhaustedError,
  listManagedMembers,
  listManagedMembersForManagedIds,
  listSerializedManagedMembers,
  markMembersApplying,
  nextReplicaOrdinal,
  replicationPurposeForMemberPair,
  resolveMemberTransports,
  resolvePeersForMember,
  serializeManagedMember,
  updateManagedMemberObservedReplication,
  updateManagedMemberReadEligible,
  updateManagedMemberReplicaClass,
  updateMemberReplicationTransport,
  type ManagedMemberRow,
  MANAGED_PRIVATE_PORT_MIN,
} from './members.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function member(
  overrides: Partial<ManagedMemberRow> & Pick<ManagedMemberRow, 'id' | 'serverId' | 'role' | 'ordinal'>,
): ManagedMemberRow {
  return {
    managedId: 'managed-1',
    replicaClass: overrides.role === 'replica' ? 'failover' : null,
    readEligible: overrides.role === 'primary',
    replicationTransport: null,
    privatePort: null,
    status: 'ready',
    metadata: null,
    options: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    orderBy: () => promise,
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function selectListDb(rows: ManagedMemberRow[]): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as unknown as Db
}

test('nextReplicaOrdinal assigns the smallest unused ordinal at or above 2', () => {
  assertEquals(nextReplicaOrdinal([]), 2)
  assertEquals(nextReplicaOrdinal([member({ id: 'p', serverId: 's', role: 'primary', ordinal: 1 })]), 2)
  assertEquals(
    nextReplicaOrdinal([
      member({ id: 'p', serverId: 's', role: 'primary', ordinal: 1 }),
      member({ id: 'r2', serverId: 's2', role: 'replica', ordinal: 2 }),
    ]),
    3,
  )
  assertEquals(
    nextReplicaOrdinal([
      member({ id: 'p', serverId: 's', role: 'primary', ordinal: 1 }),
      member({ id: 'r2', serverId: 's2', role: 'replica', ordinal: 2 }),
      member({ id: 'r3', serverId: 's3', role: 'replica', ordinal: 3 }),
    ]),
    4,
  )
  assertEquals(
    nextReplicaOrdinal([
      member({ id: 'p', serverId: 's', role: 'primary', ordinal: 1 }),
      member({ id: 'r2', serverId: 's2', role: 'replica', ordinal: 2 }),
      member({ id: 'r3', serverId: 's3', role: 'replica', ordinal: 3 }),
      member({ id: 'r4', serverId: 's4', role: 'replica', ordinal: 4 }),
    ]),
    5,
  )
})

test('countReplicas ignores primary members', () => {
  assertEquals(countReplicas([]), 0)
  assertEquals(
    countReplicas([
      member({ id: 'p', serverId: 's', role: 'primary', ordinal: 1 }),
      member({ id: 'r', serverId: 's2', role: 'replica', ordinal: 2 }),
    ]),
    1,
  )
})

test('isManagedPrivatePortExhaustedError narrows only the exhausted shape', () => {
  assertEquals(
    isManagedPrivatePortExhaustedError({
      kind: 'managed_private_port_exhausted',
      serverId: 'srv',
    }),
    true,
  )
  assertEquals(isManagedPrivatePortExhaustedError({ kind: 'other' }), false)
  assertEquals(isManagedPrivatePortExhaustedError(null), false)
  assertEquals(isManagedPrivatePortExhaustedError('managed_private_port_exhausted'), false)
})

test('serializeManagedMember maps role transport and replication health', () => {
  const base = member({
    id: 'm1',
    serverId: 's1',
    role: 'replica',
    ordinal: 2,
    readEligible: true,
    replicationTransport: 'datacenter',
    privatePort: 45_001,
    status: 'ready',
    metadata: {
      replication: {
        state: 'streaming',
        observedAt: '2020-01-02T00:00:00.000Z',
        lagBytes: 12,
        lagSeconds: 3,
      },
    },
  })
  assertEquals(serializeManagedMember(base, 'db-1'), {
    id: 'm1',
    serverId: 's1',
    serverDisplayName: 'db-1',
    role: 'replica',
    replicaClass: 'failover',
    readEligible: true,
    ordinal: 2,
    status: 'ready',
    replicationTransport: 'datacenter',
    privatePort: 45_001,
    replication: {
      state: 'streaming',
      observedAt: '2020-01-02T00:00:00.000Z',
      lagBytes: 12,
      lagSeconds: 3,
    },
  })

  const primaryish = serializeManagedMember(
    member({
      id: 'm2',
      serverId: 's2',
      role: 'strange',
      ordinal: 1,
      replicationTransport: 'not-a-transport',
      metadata: { replication: { state: 1 } },
    }),
    null,
  )
  assertEquals(primaryish.role, 'primary')
  assertEquals(primaryish.replicaClass, null)
  assertEquals(primaryish.replicationTransport, null)
  assertEquals(primaryish.replication, undefined)

  const transportLocal = serializeManagedMember(
    member({
      id: 'm3',
      serverId: 's3',
      role: 'primary',
      ordinal: 1,
      replicationTransport: 'local',
      metadata: {
        replication: {
          state: 'unknown',
          observedAt: 't',
          lagBytes: Number.NaN,
          lagSeconds: 'bad',
        },
      },
    }),
    'p',
  )
  assertEquals(transportLocal.replicationTransport, 'local')
  assertEquals(transportLocal.replication, {
    state: 'unknown',
    observedAt: 't',
  })

  const transportVpn = serializeManagedMember(
    member({
      id: 'm4',
      serverId: 's4',
      role: 'replica',
      ordinal: 2,
      replicationTransport: 'fabric',
      metadata: null,
    }),
    'v',
  )
  assertEquals(transportVpn.replicationTransport, 'fabric')

  const transportPublic = serializeManagedMember(
    member({
      id: 'm5',
      serverId: 's5',
      role: 'replica',
      ordinal: 2,
      replicationTransport: 'public',
      metadata: null,
    }),
    'pub',
  )
  assertEquals(transportPublic.replicationTransport, 'public')

  const readReplica = serializeManagedMember(
    member({
      id: 'm6',
      serverId: 's6',
      role: 'replica',
      ordinal: 2,
      replicaClass: 'read',
      replicationTransport: 'public',
    }),
    'edge',
  )
  assertEquals(readReplica.replicaClass, 'read')
  assertEquals(readReplica.replicationTransport, 'public')
})

test('listManagedMembers and listManagedMembersForManagedIds wire orderBy / empty short-circuit', async () => {
  const rows = [member({ id: 'p', serverId: 's', role: 'primary', ordinal: 1 })]
  assertEquals(await listManagedMembers(selectListDb(rows), 'managed-1'), rows)
  assertEquals(await listManagedMembersForManagedIds({} as Db, []), [])
  assertEquals(await listManagedMembersForManagedIds(selectListDb(rows), ['managed-1']), rows)
})

test('listSerializedManagedMembers joins server display names', async () => {
  const db = {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () =>
              Promise.resolve([
                {
                  ...member({ id: 'p', serverId: 's', role: 'primary', ordinal: 1 }),
                  serverDisplayName: 'Primary Host',
                },
                {
                  ...member({ id: 'r', serverId: 's2', role: 'replica', ordinal: 2 }),
                  serverDisplayName: null,
                },
              ]),
          }),
        }),
      }),
    }),
  } as unknown as Db

  const serialized = await listSerializedManagedMembers(db, 'managed-1')
  assertEquals(serialized.map((m) => m.serverDisplayName), ['Primary Host', null])
  assertEquals(serialized[1]?.role, 'replica')
})

test('ensureManagedPrimaryMember returns existing primary or rehomes serverId', async () => {
  const existing = member({
    id: 'p1',
    serverId: 'old',
    role: 'primary',
    ordinal: 1,
  })
  assertEquals(
    await ensureManagedPrimaryMember(selectListDb([existing]), {
      managedId: 'managed-1',
      serverId: 'old',
    }),
    existing,
  )

  let updatedServerId: string | null = null
  const rehomeDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([existing]),
        }),
      }),
    }),
    update: () => ({
      set: (patch: { serverId: string }) => {
        updatedServerId = patch.serverId
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([{ ...existing, serverId: patch.serverId }]),
          }),
        }
      },
    }),
  } as unknown as Db
  const rehomed = await ensureManagedPrimaryMember(rehomeDb, {
    managedId: 'managed-1',
    serverId: 'new',
  })
  assertEquals(updatedServerId, 'new')
  assertEquals(rehomed.serverId, 'new')
})

test('ensureManagedPrimaryMember inserts primary and recovers race re-read', async () => {
  const insertedRow = member({
    id: 'p-new',
    serverId: 's',
    role: 'primary',
    ordinal: 1,
    status: 'provisioning',
  })
  let listed = 0
  const insertDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => {
            listed += 1
            return Promise.resolve([])
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([insertedRow]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(
    await ensureManagedPrimaryMember(insertDb, {
      managedId: 'managed-1',
      serverId: 's',
    }),
    insertedRow,
  )
  assertEquals(listed, 1)

  const racedPrimary = member({
    id: 'p-race',
    serverId: 's',
    role: 'primary',
    ordinal: 1,
  })
  let listRound = 0
  const raceDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => {
            listRound += 1
            return Promise.resolve(listRound === 1 ? [] : [racedPrimary])
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(
    await ensureManagedPrimaryMember(raceDb, {
      managedId: 'managed-1',
      serverId: 's',
    }),
    racedPrimary,
  )

  const missingDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  await assertRejects(
    () =>
      ensureManagedPrimaryMember(missingDb, {
        managedId: 'managed-x',
        serverId: 's',
      }),
    Error,
    'managed primary member missing after upsert',
  )
})

type MembershipPinRow = {
  ipId: string
  serverId: string
  datacenterId: string
  networkId: string | null
  address: string
}

function membershipPin(
  serverId: string,
  datacenterId: string,
  address: string,
): MembershipPinRow {
  return {
    ipId: `ip-${serverId}-${datacenterId}`,
    serverId,
    datacenterId,
    networkId: null,
    address,
  }
}

type PrivateEndpointFixtureOpts = {
  fabricId?: string
  relays?: Array<{
    relayId: string
    serverId: string
    fabricId: string
    fabricCreatedAt: string
    address: string
  }>
  publicAddresses?: Array<{ serverId: string; address: string }>
  datacenterOptions?: Array<{ id: string; options: unknown }>
}

/** Route projected field keys the same way private-endpoint pure tests do. */
function privateEndpointSelect(
  memberships: MembershipPinRow[],
  opts?: PrivateEndpointFixtureOpts,
) {
  const datacenterOptions = opts?.datacenterOptions ??
    [...new Set(memberships.map((row) => row.datacenterId))]
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({ id, options: {} }))

  return (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields).sort((a, b) => a.localeCompare(b))
    const keySet = new Set(keys)

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
              return thenableRows(memberships)
            },
          }
        },
      }
    }

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
                  return thenableRows(opts?.publicAddresses ?? [])
                },
              }
            },
          }
        },
      }
    }

    if (keys.length === 1 && keySet.has('fabricId')) {
      return {
        from() {
          return {
            where() {
              return thenableRows(
                opts?.fabricId ? [{ fabricId: opts.fabricId }] : [],
              )
            },
          }
        },
      }
    }

    if (keySet.has('relayId') && keySet.has('fabricCreatedAt')) {
      return {
        from() {
          return {
            innerJoin() {
              return {
                where() {
                  return {
                    orderBy() {
                      return thenableRows(opts?.relays ?? [])
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
              return thenableRows(datacenterOptions)
            },
          }
        },
      }
    }

    throw new TypeError(`unexpected private-endpoint select keys: ${keys.join(',')}`)
  }
}

/** Minimal double covering private-endpoint batch queries used by members.ts. */
function privateEndpointDb(
  memberships: MembershipPinRow[],
  opts?: PrivateEndpointFixtureOpts,
): Db {
  return {
    select: privateEndpointSelect(memberships, opts),
  } as unknown as Db
}

/**
 * Combines container-name lookup with private-endpoint fixture selects.
 * `select` routes by projected field keys (same approach as private-endpoint pure tests).
 */
function peerResolutionDb(opts: {
  containers: Array<{
    serverId: string
    containerName: string
    role: string
    ordinal: number
  }>
  memberships?: MembershipPinRow[]
} & PrivateEndpointFixtureOpts): Db {
  const endpointSelect = privateEndpointSelect(opts.memberships ?? [], opts)
  return {
    select(fields: Record<string, unknown>) {
      const keys = Object.keys(fields)
      const keySet = new Set(keys)
      if (
        keySet.has('containerName') &&
        keySet.has('ordinal') &&
        keySet.has('role') &&
        keySet.has('serverId')
      ) {
        return {
          from() {
            return {
              where() {
                return thenableRows(opts.containers)
              },
            }
          },
        }
      }
      return endpointSelect(fields)
    },
  } as unknown as Db
}

test('resolveMemberTransports maps primary local and replica path results', async () => {
  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const primaryOnly = await resolveMemberTransports(
    {} as Db,
    [primary],
    'read-replication',
  )
  if (!('size' in primaryOnly)) {
    throw new TypeError(`expected transport map, got ${JSON.stringify(primaryOnly)}`)
  }
  assertEquals([...primaryOnly.entries()], [['p', 'local']])
  assertEquals(await resolveMemberTransports({} as Db, [], 'read-replication'), new Map())

  const replicaSame = member({
    id: 'r',
    serverId: 's1',
    role: 'replica',
    ordinal: 2,
  })
  const transports = await resolveMemberTransports(
    privateEndpointDb([]),
    [primary, replicaSame],
    'read-replication',
  )
  if (!('size' in transports)) {
    throw new TypeError(`expected transport map, got ${JSON.stringify(transports)}`)
  }
  assertEquals(transports.get('p'), 'local')
  assertEquals(transports.get('r'), 'local')

  const remote = member({
    id: 'r2',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
  })
  const remoteTransports = await resolveMemberTransports(
    privateEndpointDb([
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-a', '10.0.0.2'),
    ]),
    [primary, remote],
    'read-replication',
  )
  if (!('size' in remoteTransports)) {
    throw new TypeError(JSON.stringify(remoteTransports))
  }
  assertEquals(remoteTransports.get('r2'), 'datacenter')
})

test('resolveMemberTransports surfaces private_path_unavailable from replica overlay', async () => {
  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const replica = member({ id: 'r', serverId: 's2', role: 'replica', ordinal: 2 })
  const db = privateEndpointDb([])
  const result = await resolveMemberTransports(db, [primary, replica], 'read-replication')
  assertEquals(result, {
    kind: 'private_path_unavailable',
    fromServerId: 's1',
    toServerId: 's2',
  })
})

test('resolveMemberTransports uses fabric when relays exist without datacenter IPs', async () => {
  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const replica = member({
    id: 'r',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
  })
  const transports = await resolveMemberTransports(
    privateEndpointDb(
      [],
      {
        fabricId: 'fab-1',
        relays: [
          {
            relayId: 'rel-1',
            serverId: 's1',
            fabricId: 'fab-1',
            fabricCreatedAt: '2020-01-01T00:00:00.000Z',
            address: '203.0.113.10',
          },
          {
            relayId: 'rel-2',
            serverId: 's2',
            fabricId: 'fab-1',
            fabricCreatedAt: '2020-01-01T00:00:00.000Z',
            address: '203.0.113.11',
          },
        ],
      },
    ),
    [primary, replica],
    'read-replication',
  )
  if (!('size' in transports)) {
    throw new TypeError(JSON.stringify(transports))
  }
  assertEquals(transports.get('p'), 'local')
  assertEquals(transports.get('r'), 'fabric')
})

test('resolveMemberTransports walks shared datacenters in priority order', async () => {
  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const failover = member({
    id: 'f',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
    replicaClass: 'failover',
    privatePort: 45_100,
  })
  // dc-a (priority 200, family mismatch) sorts after dc-b (priority 10), so
  // the trusted walk finds dc-b's compatible pin first; the family mismatch
  // on the lower-ranked datacenter is never reached.
  const memberships = [
    membershipPin('s1', 'dc-a', '2001:db8::1'),
    membershipPin('s2', 'dc-a', '10.0.0.2'),
    membershipPin('s1', 'dc-b', '10.1.0.1'),
    membershipPin('s2', 'dc-b', '10.1.0.2'),
  ]
  const datacenterOptions = [
    { id: 'dc-a', options: { priority: 200 } },
    { id: 'dc-b', options: { priority: 10 } },
  ]
  const transports = await resolveMemberTransports(
    privateEndpointDb(memberships, { datacenterOptions }),
    [primary, failover],
    'failover-replication',
  )
  if (!('size' in transports)) {
    throw new TypeError(JSON.stringify(transports))
  }
  assertEquals(transports.get('f'), 'datacenter')

  const peers = await resolvePeersForMember(
    peerResolutionDb({ containers: [], memberships, datacenterOptions }),
    [primary, failover],
    primary,
    5432,
  )
  if (!Array.isArray(peers)) {
    throw new TypeError(JSON.stringify(peers))
  }
  assertEquals(peers[0]?.address, '10.1.0.2')
})

test('resolveMemberTransports surfaces failover_requires_trusted_datacenter for an untrusted-only failover pair', async () => {
  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const failover = member({
    id: 'f',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
    replicaClass: 'failover',
    privatePort: 45_100,
  })
  const db = privateEndpointDb(
    [
      membershipPin('s1', 'dc-shared', '10.0.0.1'),
      membershipPin('s2', 'dc-shared', '10.0.0.2'),
    ],
    {
      datacenterOptions: [{ id: 'dc-shared', options: { trusted: false } }],
      publicAddresses: [
        { serverId: 's1', address: '203.0.113.1' },
        { serverId: 's2', address: '203.0.113.2' },
      ],
    },
  )
  assertEquals(
    await resolveMemberTransports(db, [primary, failover], 'failover-replication'),
    {
      kind: 'failover_requires_trusted_datacenter',
      fromServerId: 's1',
      toServerId: 's2',
      datacenterId: 'dc-shared',
    },
  )
  // The same pair as a read replica skips the untrusted LAN and rides public.
  const readTransports = await resolveMemberTransports(
    db,
    [primary, failover],
    'read-replication',
  )
  if (!('size' in readTransports)) {
    throw new TypeError(JSON.stringify(readTransports))
  }
  assertEquals(readTransports.get('f'), 'public')
})

test('ensureMemberPrivatePorts clears leftover ports on single-member clusters', async () => {
  const sole = member({
    id: 'p',
    serverId: 's',
    role: 'primary',
    ordinal: 1,
    privatePort: 45_010,
  })
  const cleared = member({ ...sole, privatePort: null })
  let clearedId: string | null = null
  const simpleDb = {
    update: () => ({
      set: () => ({
        where: () => {
          clearedId = 'p'
          return Promise.resolve([])
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([cleared]),
        }),
      }),
    }),
  } as unknown as Db

  const result = await ensureMemberPrivatePorts(simpleDb, [sole])
  assertEquals(clearedId, 'p')
  assertEquals(result, [cleared])
  assertEquals(await ensureMemberPrivatePorts({} as Db, []), [])
})

test('ensureMemberPrivatePorts never resurrects members excluded from the input', async () => {
  // Delete-member prepare passes only the surviving primary; the DB still
  // holds the replica being destroyed. The refreshed result must not include
  // it — resurrecting it made the prepare build a payload for the removed
  // member against the just-cleared primary listener (private_path_unavailable).
  const sole = member({
    id: 'p',
    serverId: 's',
    role: 'primary',
    ordinal: 1,
    privatePort: 45_010,
  })
  const cleared = member({ ...sole, privatePort: null })
  const doomedReplica = member({
    id: 'r',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
    privatePort: 45_000,
  })
  const simpleDb = {
    update: () => ({
      set: () => ({ where: () => Promise.resolve([]) }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([cleared, doomedReplica]),
        }),
      }),
    }),
  } as unknown as Db

  const result = await ensureMemberPrivatePorts(simpleDb, [sole])
  assertEquals(result, [cleared])
})

test('ensureMemberPrivatePorts allocates free private ports per server', async () => {
  const primary = member({
    id: 'p',
    serverId: 's1',
    role: 'primary',
    ordinal: 1,
    privatePort: null,
  })
  const replica = member({
    id: 'r',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
    privatePort: null,
  })
  const assigned = [
    { ...primary, privatePort: MANAGED_PRIVATE_PORT_MIN },
    { ...replica, privatePort: MANAGED_PRIVATE_PORT_MIN },
  ]
  let selectN = 0
  const updates: Array<{ id: unknown; port: number }> = []

  const tx = {
    select: () => ({
      from: () => ({
        where: () => {
          selectN += 1
          if (selectN === 2) {
            // occupied private ports: foreign cluster holds min on s1
            return Promise.resolve([
              { serverId: 's1', privatePort: MANAGED_PRIVATE_PORT_MIN, id: 'other' },
            ])
          }
          return {
            orderBy: () =>
              Promise.resolve(
                selectN === 1 ? [primary, replica] : assigned,
              ),
          }
        },
      }),
    }),
    update: () => ({
      set: (patch: { privatePort: number }) => ({
        where: (cond: unknown) => {
          updates.push({ id: cond, port: patch.privatePort })
          return Promise.resolve([])
        },
      }),
    }),
  }

  const db = {
    transaction: (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Db

  const result = await ensureMemberPrivatePorts(db, [primary, replica])
  assertEquals(Array.isArray(result), true)
  if (Array.isArray(result)) {
    assertEquals(result.map((m) => m.privatePort), [
      MANAGED_PRIVATE_PORT_MIN,
      MANAGED_PRIVATE_PORT_MIN,
    ])
  }
  assertEquals(updates.length, 2)
  // s1 skips occupied min → min+1; s2 takes min
  assertEquals(updates.map((u) => u.port).sort((a, b) => a - b), [
    MANAGED_PRIVATE_PORT_MIN,
    MANAGED_PRIVATE_PORT_MIN + 1,
  ])
})

test('ensureMemberPrivatePorts returns exhausted when the range is full', async () => {
  const primary = member({
    id: 'p',
    serverId: 's1',
    role: 'primary',
    ordinal: 1,
    privatePort: null,
  })
  const replica = member({
    id: 'r',
    serverId: 's1',
    role: 'replica',
    ordinal: 2,
    privatePort: null,
  })
  const fullOccupied = Array.from({ length: 1000 }, (_, i) => ({
    serverId: 's1',
    privatePort: MANAGED_PRIVATE_PORT_MIN + i,
    id: `other-${i}`,
  }))
  let selectN = 0
  const tx = {
    select: () => ({
      from: () => ({
        where: () => {
          selectN += 1
          if (selectN === 2) return Promise.resolve(fullOccupied)
          return {
            orderBy: () => Promise.resolve([primary, replica]),
          }
        },
      }),
    }),
    update: () => {
      throw new TypeError('must not update when exhausted')
    },
  }
  const db = {
    transaction: (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Db

  const result = await ensureMemberPrivatePorts(db, [primary, replica])
  assertEquals(isManagedPrivatePortExhaustedError(result), true)
  if (isManagedPrivatePortExhaustedError(result)) {
    assertEquals(result.serverId, 's1')
  }
})

test('resolvePeersForMember returns empty for sole members and co-resident peers', async () => {
  const sole = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  assertEquals(await resolvePeersForMember({} as Db, [sole], sole, 5432), [])

  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const replica = member({
    id: 'r',
    serverId: 's1',
    role: 'replica',
    ordinal: 2,
    privatePort: null,
  })
  const db = peerResolutionDb({
    containers: [
      {
        serverId: 's1',
        containerName: 'engine-p',
        role: 'service',
        ordinal: 1,
      },
      {
        serverId: 's1',
        containerName: 'engine-r',
        role: 'service',
        ordinal: 2,
      },
    ],
    memberships: [],
  })

  const peers = await resolvePeersForMember(db, [primary, replica], primary, 5432)
  if (!Array.isArray(peers)) {
    throw new TypeError(`expected peers array: ${JSON.stringify(peers)}`)
  }
  assertEquals(peers.length, 1)
  assertEquals(peers[0], {
    memberId: 'r',
    role: 'replica',
    readEligible: false,
    address: 'engine-r',
    transport: 'local',
    port: 5432,
    containerName: 'engine-r',
  })
})

test('resolvePeersForMember remote peer uses privatePort and datacenter address', async () => {
  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const replica = member({
    id: 'r',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
    privatePort: 45_100,
    readEligible: true,
  })
  const db = peerResolutionDb({
    containers: [],
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-a', '10.0.0.22'),
    ],
  })

  const peers = await resolvePeersForMember(db, [primary, replica], primary, 5432)
  if (!Array.isArray(peers)) {
    throw new TypeError(JSON.stringify(peers))
  }
  assertEquals(peers[0], {
    memberId: 'r',
    role: 'replica',
    readEligible: true,
    address: '10.0.0.22',
    transport: 'datacenter',
    port: 45_100,
  })
})

test('resolvePeersForMember errors when co-resident peer lacks a container name', async () => {
  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const replica = member({ id: 'r', serverId: 's1', role: 'replica', ordinal: 2 })
  const db = peerResolutionDb({
    containers: [],
    memberships: [],
  })

  const err = await resolvePeersForMember(db, [primary, replica], primary, 5432)
  assertEquals(err, {
    kind: 'private_path_unavailable',
    fromServerId: 's1',
    toServerId: 's1',
  })
})

test('resolvePeersForMember errors when remote peer has no privatePort', async () => {
  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const replica = member({
    id: 'r',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
    privatePort: null,
  })
  const db = peerResolutionDb({
    containers: [],
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-a', '10.0.0.22'),
    ],
  })

  assertEquals(await resolvePeersForMember(db, [primary, replica], primary, 5432), {
    kind: 'private_path_unavailable',
    fromServerId: 's1',
    toServerId: 's2',
  })
})

test('resolveMemberTransports returns private path error from replica', async () => {
  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const replica = member({ id: 'r', serverId: 's2', role: 'replica', ordinal: 2 })
  const db = privateEndpointDb([
    membershipPin('s1', 'dc-a', '10.0.0.1'),
    membershipPin('s2', 'dc-b', '10.1.0.2'),
  ])
  const result = await resolveMemberTransports(db, [primary, replica], 'read-replication')
  assertEquals(result, {
    kind: 'private_path_unavailable',
    fromServerId: 's1',
    toServerId: 's2',
  })
})

test('ensureMemberPrivatePorts reuses ports already on members', async () => {
  const primary = member({
    id: 'p',
    serverId: 's1',
    role: 'primary',
    ordinal: 1,
    privatePort: MANAGED_PRIVATE_PORT_MIN,
  })
  const replica = member({
    id: 'r',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
    privatePort: MANAGED_PRIVATE_PORT_MIN + 1,
  })
  let selectN = 0
  let updates = 0
  const tx = {
    select: () => ({
      from: () => ({
        where: () => {
          selectN += 1
          if (selectN === 2) {
            return Promise.resolve([
              { serverId: 's1', privatePort: null, id: 'foreign-null' },
              {
                serverId: 's1',
                privatePort: MANAGED_PRIVATE_PORT_MIN,
                id: 'p',
              },
            ])
          }
          return {
            orderBy: () => Promise.resolve([primary, replica]),
          }
        },
      }),
    }),
    update: () => {
      updates += 1
      throw new TypeError('should not reassign ports')
    },
  }
  const db = {
    transaction: (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Db

  const result = await ensureMemberPrivatePorts(db, [primary, replica])
  assertEquals(Array.isArray(result), true)
  assertEquals(updates, 0)
})

test('resolvePeersForMember surfaces private endpoint resolution failures', async () => {
  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const replica = member({
    id: 'r',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
    privatePort: 45_050,
  })
  // Different DCs, no VPN → private_path_unavailable on remote peer
  const db = peerResolutionDb({
    containers: [],
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-b', '10.1.0.2'),
    ],
  })
  assertEquals(await resolvePeersForMember(db, [primary, replica], primary, 5432), {
    kind: 'private_path_unavailable',
    fromServerId: 's1',
    toServerId: 's2',
  })
})

test('replicationPurposeForMemberPair keeps failover links off fabric and public', () => {
  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const failover = member({
    id: 'f',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
    replicaClass: 'failover',
  })
  const read = member({
    id: 'r',
    serverId: 's3',
    role: 'replica',
    ordinal: 3,
    replicaClass: 'read',
  })
  const legacy = member({
    id: 'l',
    serverId: 's4',
    role: 'replica',
    ordinal: 4,
    replicaClass: null,
  })

  assertEquals(
    replicationPurposeForMemberPair(primary, failover),
    'failover-replication',
  )
  assertEquals(
    replicationPurposeForMemberPair(failover, primary),
    'failover-replication',
  )
  assertEquals(
    replicationPurposeForMemberPair(failover, legacy),
    'failover-replication',
  )
  assertEquals(replicationPurposeForMemberPair(primary, read), 'read-replication')
  assertEquals(replicationPurposeForMemberPair(read, failover), 'read-replication')
})

test('resolvePeersForMember routes each peer by its replica class', async () => {
  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const failover = member({
    id: 'f',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
    replicaClass: 'failover',
    privatePort: 45_100,
  })
  const read = member({
    id: 'r',
    serverId: 's3',
    role: 'replica',
    ordinal: 3,
    replicaClass: 'read',
    readEligible: true,
    privatePort: 45_101,
  })
  // s2 shares dc-a with the primary; s3 is reachable only over public.
  const db = peerResolutionDb({
    containers: [],
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-a', '10.0.0.22'),
    ],
    publicAddresses: [
      { serverId: 's1', address: '203.0.113.1' },
      { serverId: 's3', address: '203.0.113.3' },
    ],
  })

  const peers = await resolvePeersForMember(db, [primary, failover, read], primary, 5432)
  if (!Array.isArray(peers)) {
    throw new TypeError(JSON.stringify(peers))
  }
  assertEquals(
    peers.map((peer) => [peer.memberId, peer.transport, peer.address]),
    [
      ['f', 'datacenter', '10.0.0.22'],
      ['r', 'public', '203.0.113.3'],
    ],
  )
})

test('resolvePeersForMember refuses a failover peer that only public can reach', async () => {
  const primary = member({ id: 'p', serverId: 's1', role: 'primary', ordinal: 1 })
  const failover = member({
    id: 'f',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
    replicaClass: 'failover',
    privatePort: 45_100,
  })
  // No shared datacenter: a read replica would take the public rung, a
  // failover peer must not.
  const db = peerResolutionDb({
    containers: [],
    memberships: [],
    publicAddresses: [
      { serverId: 's1', address: '203.0.113.1' },
      { serverId: 's2', address: '203.0.113.2' },
    ],
  })

  assertEquals(await resolvePeersForMember(db, [primary, failover], primary, 5432), {
    kind: 'private_path_unavailable',
    fromServerId: 's1',
    toServerId: 's2',
  })
})

test('crud helpers: insert update delete find mark and observed replication', async () => {
  let insertValues: unknown
  const insertDb = {
    insert: () => ({
      values: (values: unknown) => {
        insertValues = values
        return {
          returning: () =>
            Promise.resolve([
              member({
                id: 'r-new',
                serverId: 's2',
                role: 'replica',
                ordinal: 2,
                status: 'provisioning',
              }),
            ]),
        }
      },
    }),
  } as unknown as Db
  const inserted = await insertManagedReplicaMember(insertDb, {
    managedId: 'managed-1',
    serverId: 's2',
    ordinal: 2,
    replicaClass: 'failover',
    readEligible: true,
    replicationTransport: 'fabric',
  })
  assertEquals(inserted.id, 'r-new')
  assertEquals((insertValues as { role: string; replicaClass: string }).role, 'replica')
  assertEquals((insertValues as { replicaClass: string }).replicaClass, 'failover')

  const emptyInsert = {
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([]),
      }),
    }),
  } as unknown as Db
  await assertRejects(
    () =>
      insertManagedReplicaMember(emptyInsert, {
        managedId: 'm',
        serverId: 's',
        ordinal: 2,
        replicaClass: 'read',
        readEligible: false,
        replicationTransport: null,
      }),
    Error,
    'Failed to insert managed replica member',
  )

  const updatedRow = member({
    id: 'r1',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
    readEligible: true,
  })
  const updateDb = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([updatedRow]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await updateManagedMemberReadEligible(updateDb, 'r1', true), updatedRow)

  const missUpdate = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await updateManagedMemberReadEligible(missUpdate, 'missing', false), null)

  const classRow = member({
    id: 'r1',
    serverId: 's2',
    role: 'replica',
    ordinal: 2,
    replicaClass: 'read',
  })
  const classDb = {
    update: () => ({
      set: (values: { replicaClass?: string }) => {
        assertEquals(values.replicaClass, 'read')
        return {
          where: () => ({
            returning: () => Promise.resolve([classRow]),
          }),
        }
      },
    }),
  } as unknown as Db
  assertEquals(await updateManagedMemberReplicaClass(classDb, 'r1', 'read'), classRow)

  let deleted = false
  const deleteDb = {
    delete: () => ({
      where: () => {
        deleted = true
        return Promise.resolve([])
      },
    }),
  } as unknown as Db
  await deleteManagedMember(deleteDb, 'r1')
  assertEquals(deleted, true)

  const findDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([updatedRow]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await findManagedMember(findDb, 'r1'), updatedRow)
  const missFind = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await findManagedMember(missFind, 'x'), null)

  let marked = false
  const markDb = {
    update: () => ({
      set: () => ({
        where: () => {
          marked = true
          return Promise.resolve([])
        },
      }),
    }),
  } as unknown as Db
  await markMembersApplying(markDb, 'managed-1')
  assertEquals(marked, true)

  let transport: string | null = 'unset'
  const transportDb = {
    update: () => ({
      set: (patch: { replicationTransport: string | null }) => ({
        where: () => {
          transport = patch.replicationTransport
          return Promise.resolve([])
        },
      }),
    }),
  } as unknown as Db
  await updateMemberReplicationTransport(transportDb, 'r1', 'datacenter')
  assertEquals(transport, 'datacenter')

  let observedMeta: unknown
  let observedStatus: string | null = null
  let metaSelect = 0
  const observeDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            metaSelect += 1
            return Promise.resolve(
              metaSelect === 1
                ? [{ metadata: { keep: true } }]
                : [],
            )
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: { status: string; metadata: unknown }) => ({
        where: () => {
          observedStatus = patch.status
          observedMeta = patch.metadata
          return Promise.resolve([])
        },
      }),
    }),
  } as unknown as Db
  await updateManagedMemberObservedReplication(observeDb, 'r1', {
    status: 'ready',
    replication: {
      state: 'streaming',
      observedAt: 't',
      lagBytes: 1,
    },
  })
  assertEquals(observedStatus, 'ready')
  assertEquals(observedMeta, {
    keep: true,
    replication: { state: 'streaming', observedAt: 't', lagBytes: 1 },
  })

  // Missing member is a no-op on the second select path.
  await updateManagedMemberObservedReplication(observeDb, 'gone', {
    status: 'failed',
  })
})
