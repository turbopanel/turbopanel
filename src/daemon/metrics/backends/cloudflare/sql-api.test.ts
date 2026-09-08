import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { AE_FAMILY_HOST_IO, AE_FAMILY_HOST_SYSTEM } from './field-map.ts'
import {
  HOST_METRICS_METRIC_DESCRIPTORS,
  type HostMetricsMetricDescriptor,
} from '../../metric-descriptors.ts'
import {
  AE_LIVENESS_WINDOW_SECONDS,
  AE_DATASET_NAME,
  AE_SUPPORTED_SCHEMA_VERSIONS,
  aeMissingMetricSentinelSql,
  aggregateExpressionForDescriptor,
  buildRecentlyActiveServerIdsSql,
  deltaSumExpressionForColumn,
  entityIdInPageIdentityPredicate,
  eventDiscriminatorPredicates,
  familyPredicate,
  hostMetricsDiscriminatorPredicates,
  lastValueExpressionForColumn,
  latestAtExpression,
  maxValueExpressionForColumn,
  queryEntityIdsSeenViaSqlApi,
  queryEntitySeriesViaSqlApi,
  queryFleetHostSnapshotViaSqlApi,
  queryHostSeriesViaSqlApi,
  queryHostSummaryViaSqlApi,
  queryMetricEventsViaSqlApi,
  queryRecentlyActiveServerIds,
  queryStatusHistoryViaSqlApi,
  quoteSqlString,
  sampleCountExpression,
  serverIdPredicate,
  statusDiscriminatorPredicates,
  stripAeSentinel,
  timeRangePredicate,
  kindDiscriminatorPredicates,
  weightedAvgExpressionForColumn,
} from './sql-api.ts'

it('AE_DATASET_NAME is the current dataset', () => {
  assertEquals(AE_DATASET_NAME, 'turbopanel_server_metrics_v6')
})

it('AE_SUPPORTED_SCHEMA_VERSIONS is exactly [6]', () => {
  assertEquals(AE_SUPPORTED_SCHEMA_VERSIONS, [6])
})

it('quoteSqlString doubles single quotes', () => {
  assertEquals(quoteSqlString("O'Brien"), "'O''Brien'")
  assertEquals(quoteSqlString('plain'), "'plain'")
})

it('kindDiscriminatorPredicates: blob1 = kind, blob3 = schema version', () => {
  const predicates = kindDiscriminatorPredicates('metrics')
  assertEquals(predicates, [`blob1 = 'metrics'`, `blob3 = '6'`])
})

it('hostMetricsDiscriminatorPredicates matches the metrics kind', () => {
  assertEquals(hostMetricsDiscriminatorPredicates(), [`blob1 = 'metrics'`, `blob3 = '6'`])
})

it('eventDiscriminatorPredicates matches the event kind', () => {
  assertEquals(eventDiscriminatorPredicates(), [`blob1 = 'event'`, `blob3 = '6'`])
})

it('statusDiscriminatorPredicates matches the status kind', () => {
  assertEquals(statusDiscriminatorPredicates(), [`blob1 = 'status'`, `blob3 = '6'`])
})

it("familyPredicate: blob2 = '<family>'", () => {
  assertEquals(familyPredicate(AE_FAMILY_HOST_SYSTEM), `blob2 = 'host.system'`)
  assertEquals(familyPredicate(AE_FAMILY_HOST_IO), `blob2 = 'host.io'`)
})

it('aeMissingMetricSentinelSql: documented AE SQL, no scientific notation', () => {
  assertEquals(aeMissingMetricSentinelSql(), '-pow(10, 308)')
})

it('stripAeSentinel: strips values at/below the threshold, keeps real values', () => {
  assertEquals(stripAeSentinel(-1e308), null)
  assertEquals(stripAeSentinel(-1e307), null)
  assertEquals(stripAeSentinel(-1e306), -1e306)
  assertEquals(stripAeSentinel(0), 0)
  assertEquals(stripAeSentinel(42.5), 42.5)
  assertEquals(stripAeSentinel(-100), -100)
})

it('weightedAvgExpressionForColumn: SUM(value*double20*_sample_interval)/SUM(double20*_sample_interval), scoped to family', () => {
  const expr = weightedAvgExpressionForColumn(AE_FAMILY_HOST_SYSTEM, 0)
  assertEquals(
    expr,
    "SUM(if(blob2 = 'host.system', if(double1 = -pow(10, 308), 0.0, double1 * double20 * _sample_interval), 0.0)) / " +
      "SUM(if(blob2 = 'host.system', if(double1 = -pow(10, 308), 0.0, double20 * _sample_interval * 1.0), 0.0))"
  )
})

it('deltaSumExpressionForColumn: weight by _sample_interval only, never intervalSeconds', () => {
  const expr = deltaSumExpressionForColumn(AE_FAMILY_HOST_IO, 2)
  assertEquals(
    expr,
    "SUM(if(blob2 = 'host.io', if(double3 = -pow(10, 308), 0.0, double3 * _sample_interval), 0.0))"
  )
  // Never references double20 (the reserved interval slot).
  assertEquals(expr.includes('double20'), false)
})

it('maxValueExpressionForColumn: MAX(if(family, col, sentinel))', () => {
  const expr = maxValueExpressionForColumn(AE_FAMILY_HOST_SYSTEM, 5)
  assertEquals(expr, "MAX(if(blob2 = 'host.system', double6, -pow(10, 308)))")
})

it('lastValueExpressionForColumn: argMax keyed by row timestamp, sentinel demoted to ordering key 0', () => {
  const expr = lastValueExpressionForColumn(AE_FAMILY_HOST_IO, 0)
  assertEquals(
    expr,
    "argMax(if(blob2 = 'host.io', double1, -pow(10, 308)), " +
      "if(if(blob2 = 'host.io', double1, -pow(10, 308)) = -pow(10, 308), toUnixTimestamp(timestamp) * 0, toUnixTimestamp(timestamp)))"
  )
})

it('sampleCountExpression: anchored on host.system, weighted by _sample_interval', () => {
  assertEquals(
    sampleCountExpression(),
    "SUM(if(blob2 = 'host.system', _sample_interval * 1.0, 0.0))"
  )
})

it('latestAtExpression: MAX unix-seconds timestamp anchored on host.system', () => {
  assertEquals(
    latestAtExpression(),
    "MAX(if(blob2 = 'host.system', toUnixTimestamp(timestamp), 0))"
  )
})

it('timeRangePredicate: canonical half-open [from, to)', () => {
  assertEquals(
    timeRangePredicate(1_700_000_000, 1_700_003_600),
    'timestamp >= toDateTime(1700000000) AND timestamp < toDateTime(1700003600)'
  )
})

it('timeRangePredicate: from === to yields an empty (never-true) range, not an error', () => {
  assertEquals(
    timeRangePredicate(1_700_000_000, 1_700_000_000),
    'timestamp >= toDateTime(1700000000) AND timestamp < toDateTime(1700000000)'
  )
})

it("serverIdPredicate: index1 = '<serverId>'", () => {
  assertEquals(
    serverIdPredicate('11111111-2222-4333-8444-555555555555'),
    "index1 = '11111111-2222-4333-8444-555555555555'"
  )
})

it('entityIdInPageIdentityPredicate: matches exact, leading, trailing, and mid-list CSV positions', () => {
  const predicate = entityIdInPageIdentityPredicate('gpu1')
  assertEquals(predicate.includes("blob10 = 'gpu1'"), true)
  assertEquals(predicate.includes("CONCAT('gpu1,', '%')"), true)
  assertEquals(predicate.includes("CONCAT('%', ',gpu1')"), true)
  assertEquals(predicate.includes("CONCAT('%', ',gpu1,', '%')"), true)
})

// ---------------------------------------------------------------------------
// queryStatusHistoryViaSqlApi — real entry point, in scope for this phase
// (no per-entity/topology ambiguity for status rows — see module doc comment)
// ---------------------------------------------------------------------------

const STATUS_SERVER_ID = '11111111-2222-4333-8444-555555555555'

function envelopedSqlResponse(data: Array<Record<string, unknown>>, rows = data.length): string {
  return JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: { data, meta: [], rows },
  })
}

it('queryStatusHistoryViaSqlApi: prior state + in-range transitions produce correct uptime split', async () => {
  const from = '2026-01-01T00:00:00.000Z'
  const to = '2026-01-01T01:00:00.000Z'

  const result = await queryStatusHistoryViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async (_url, init) => {
        const body = String(init?.body ?? '')
        if (body.includes('ORDER BY timestamp DESC')) {
          // State just before `from`: connected.
          return new Response(
            envelopedSqlResponse([
              {
                timestamp: '2025-12-31T23:00:00.000Z',
                connected: 1,
                reason: 'connect',
              },
            ]),
            { status: 200 }
          )
        }
        // One disconnect transition 30 minutes into the range.
        return new Response(
          envelopedSqlResponse([
            {
              timestamp: '2026-01-01T00:30:00.000Z',
              connected: 0,
              reason: 'disconnect',
            },
          ]),
          { status: 200 }
        )
      },
    },
    { serverId: STATUS_SERVER_ID, from, to }
  )

  assertEquals(result.kind, 'analytics-engine')
  assertEquals(result.available, true)
  assertEquals(result.initialConnected, true)
  assertEquals(result.events.length, 1)
  assertEquals(result.events[0], {
    at: '2026-01-01T00:30:00.000Z',
    connected: false,
    reason: 'disconnect',
  })
  assertEquals(result.uptimeSeconds, 30 * 60)
  assertEquals(result.downtimeSeconds, 30 * 60)
  assertEquals(result.truncated, false)
})

it('queryStatusHistoryViaSqlApi: no prior row and no transitions is entirely unknown', async () => {
  const result = await queryStatusHistoryViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () => new Response(envelopedSqlResponse([]), { status: 200 }),
    },
    {
      serverId: STATUS_SERVER_ID,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T01:00:00.000Z',
    }
  )

  assertEquals(result.initialConnected, null)
  assertEquals(result.events, [])
  assertEquals(result.unknownSeconds, 3600)
  assertEquals(result.uptimeSeconds, 0)
  assertEquals(result.downtimeSeconds, 0)
})

// ---------------------------------------------------------------------------
// aggregateExpressionForDescriptor — dispatch by declared aggregation
// ---------------------------------------------------------------------------

function descriptorWithAggregation(
  aggregation: HostMetricsMetricDescriptor['aggregation']
): HostMetricsMetricDescriptor {
  return {
    ...HOST_METRICS_METRIC_DESCRIPTORS['host.cpu.busyPercent'],
    aggregation,
  }
}

it('aggregateExpressionForDescriptor dispatches weighted-average/delta-sum/max/last to the matching builder', () => {
  assertEquals(
    aggregateExpressionForDescriptor(
      descriptorWithAggregation('weighted-average'),
      'host.system',
      0
    ),
    weightedAvgExpressionForColumn('host.system', 0)
  )
  assertEquals(
    aggregateExpressionForDescriptor(descriptorWithAggregation('delta-sum'), 'host.system', 4),
    deltaSumExpressionForColumn('host.system', 4)
  )
  assertEquals(
    aggregateExpressionForDescriptor(descriptorWithAggregation('max'), 'host.system', 7),
    maxValueExpressionForColumn('host.system', 7)
  )
  assertEquals(
    aggregateExpressionForDescriptor(descriptorWithAggregation('last'), 'host.system', 2),
    lastValueExpressionForColumn('host.system', 2)
  )
})

// ---------------------------------------------------------------------------
// queryHostSeriesViaSqlApi / queryHostSummaryViaSqlApi
// ---------------------------------------------------------------------------

const HOST_SERVER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

it('queryHostSeriesViaSqlApi: one bucket, one weighted-average metric, topology generation carried through', async () => {
  const result = await queryHostSeriesViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async (_url, init) => {
        const body = String(init?.body ?? '')
        if (body.includes('GROUP BY generation')) {
          return new Response(envelopedSqlResponse([{ generation: 3 }]), {
            status: 200,
          })
        }
        return new Response(
          envelopedSqlResponse([
            {
              bucket: 1735689600,
              sample_count: 6,
              avg_interval_seconds: 10,
              topology_gen_min: '3',
              topology_gen_max: '3',
              m0: 42.5,
            },
          ]),
          { status: 200 }
        )
      },
    },
    {
      serverId: HOST_SERVER_ID,
      metrics: ['host.cpu.busyPercent'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
      resolutionSeconds: 60,
    }
  )

  assertEquals(result.kind, 'analytics-engine')
  assertEquals(result.available, true)
  assertEquals(result.sampleCount, 6)
  assertEquals(result.topologyGenerations, [3])
  assertEquals(result.points.length, 1)
  assertEquals(result.points[0].values['host.cpu.busyPercent'], 42.5)
  assertEquals(result.points[0].topologyGeneration, 3)
})

it('queryHostSeriesViaSqlApi: mixed topology generations in a bucket report null', async () => {
  const result = await queryHostSeriesViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async (_url, init) => {
        const body = String(init?.body ?? '')
        if (body.includes('GROUP BY generation')) {
          return new Response(envelopedSqlResponse([{ generation: 1 }, { generation: 2 }]), {
            status: 200,
          })
        }
        return new Response(
          envelopedSqlResponse([
            {
              bucket: 1735689600,
              sample_count: 2,
              avg_interval_seconds: 10,
              topology_gen_min: '1',
              topology_gen_max: '2',
              m0: 10,
            },
          ]),
          { status: 200 }
        )
      },
    },
    {
      serverId: HOST_SERVER_ID,
      metrics: ['host.cpu.busyPercent'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
    }
  )

  assertEquals(result.points[0].topologyGeneration, null)
  assertEquals(result.topologyGenerations, [1, 2])
})

it('queryHostSeriesViaSqlApi rejects a non-host metric', async () => {
  let threw = false
  try {
    await queryHostSeriesViaSqlApi(
      { accountId: 'a', apiToken: 'b', fetch: async () => new Response('{}') },
      {
        serverId: HOST_SERVER_ID,
        metrics: ['gpu.utilizationPercent'],
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:05:00.000Z',
      }
    )
  } catch {
    threw = true
  }
  assertEquals(threw, true)
})

it('queryHostSummaryViaSqlApi: sample count and latest-at', async () => {
  const result = await queryHostSummaryViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(envelopedSqlResponse([{ sample_count: 12, latest_at: 1735689600 }]), {
          status: 200,
        }),
    },
    {
      serverId: HOST_SERVER_ID,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
    }
  )
  assertEquals(result.sampleCount, 12)
  assertEquals(result.latestAt, new Date(1735689600 * 1000).toISOString())
})

it('queryHostSummaryViaSqlApi: zero samples reports latestAt null', async () => {
  const result = await queryHostSummaryViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(envelopedSqlResponse([{ sample_count: 0, latest_at: null }]), {
          status: 200,
        }),
    },
    {
      serverId: HOST_SERVER_ID,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
    }
  )
  assertEquals(result.sampleCount, 0)
  assertEquals(result.latestAt, null)
})

// ---------------------------------------------------------------------------
// queryFleetHostSnapshotViaSqlApi
// ---------------------------------------------------------------------------

it('queryFleetHostSnapshotViaSqlApi: empty serverIds short-circuits without a fetch call', async () => {
  const result = await queryFleetHostSnapshotViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: () => {
        throw new Error('must not be called')
      },
    },
    {
      serverIds: [],
      metrics: ['host.cpu.busyPercent'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
    }
  )
  assertEquals(result.servers, [])
})

it("queryFleetHostSnapshotViaSqlApi: one server's values and topology generation", async () => {
  const result = await queryFleetHostSnapshotViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            {
              server_id: HOST_SERVER_ID,
              sample_count: 3,
              latest_at: 1735689600,
              topology_gen_min: '5',
              topology_gen_max: '5',
              m0: 77,
            },
          ]),
          { status: 200 }
        ),
    },
    {
      serverIds: [HOST_SERVER_ID],
      metrics: ['host.cpu.busyPercent'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
    }
  )
  assertEquals(result.servers.length, 1)
  assertEquals(result.servers[0].serverId, HOST_SERVER_ID)
  assertEquals(result.servers[0].values['host.cpu.busyPercent'], 77)
  assertEquals(result.servers[0].topologyGeneration, 5)
})

// ---------------------------------------------------------------------------
// queryMetricEventsViaSqlApi
// ---------------------------------------------------------------------------

it('queryMetricEventsViaSqlApi: parses kind/severity/entityId/payload', async () => {
  const result = await queryMetricEventsViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            {
              timestamp: '2026-01-01T00:00:00.500Z',
              event_id: 'evt1',
              kind: 'nic_link_down',
              severity: 'warning',
              entity_id: 'eth0',
              source: 'daemon',
              payload: JSON.stringify({ reason: 'carrier lost' }),
            },
          ]),
          { status: 200 }
        ),
    },
    {
      serverId: HOST_SERVER_ID,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T01:00:00.000Z',
    }
  )
  assertEquals(result.truncated, false)
  assertEquals(result.events, [
    {
      eventId: 'evt1',
      at: '2026-01-01T00:00:00.500Z',
      kind: 'nic_link_down',
      severity: 'warning',
      entityId: 'eth0',
      source: 'daemon',
      payload: { reason: 'carrier lost' },
    },
  ])
})

it('queryMetricEventsViaSqlApi: truncates beyond MAX_STATUS_EVENTS', async () => {
  const overflowRows = Array.from({ length: 1001 }, (_, i) => ({
    timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
    event_id: `evt${i}`,
    kind: 'nic_link_down',
    severity: 'info',
    entity_id: '',
    source: '',
    payload: '',
  }))
  const result = await queryMetricEventsViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () => new Response(envelopedSqlResponse(overflowRows), { status: 200 }),
    },
    {
      serverId: HOST_SERVER_ID,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T01:00:00.000Z',
    }
  )
  assertEquals(result.truncated, true)
  assertEquals(result.events.length, 1000)
})

// ---------------------------------------------------------------------------
// queryEntitySeriesViaSqlApi — paged families (position-based recombination
// across differing page compositions within the same bucket) and single-row
// families (managed.ingress / managed.database_proxy).
// ---------------------------------------------------------------------------

it("queryEntitySeriesViaSqlApi (paged family): recombines an entity's weighted-average across two different page compositions in the same bucket", async () => {
  const result = await queryEntitySeriesViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            {
              // Page composition A: eth0 at slot0, eth1 at slot1, eth2 at slot2.
              bucket: 1735689600,
              ids: 'eth0,eth1,eth2',
              sample_count: 2,
              avg_interval_seconds: 10,
              f0_s0_n: 3000,
              f0_s0_d: 20,
              f0_s1_n: 1000,
              f0_s1_d: 20,
              f0_s2_n: 0,
              f0_s2_d: 0,
            },
            {
              // Page composition B, same bucket: topology reshuffled — eth1
              // dropped, eth3 added — eth0 stays at slot0 with more samples.
              bucket: 1735689600,
              ids: 'eth0,eth3',
              sample_count: 1,
              avg_interval_seconds: 10,
              f0_s0_n: 3000,
              f0_s0_d: 10,
              f0_s1_n: 0,
              f0_s1_d: 0,
              f0_s2_n: 0,
              f0_s2_d: 0,
            },
          ]),
          { status: 200 }
        ),
    },
    {
      serverId: HOST_SERVER_ID,
      family: 'network',
      entityIds: ['eth0', 'eth1'],
      metrics: ['receiveBytesPerSecond'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
    }
  )

  assertEquals(result.available, true)
  assertEquals(result.entities.length, 2)

  const eth0 = result.entities.find((e) => e.entityId === 'eth0')!
  assertEquals(eth0.points.length, 1)
  assertEquals(eth0.points[0].values.receiveBytesPerSecond, 200) // (3000+3000)/(20+10)
  assertEquals(eth0.sampleCount, 3) // 2 (composition A) + 1 (composition B)

  const eth1 = result.entities.find((e) => e.entityId === 'eth1')!
  assertEquals(eth1.points.length, 1)
  assertEquals(eth1.points[0].values.receiveBytesPerSecond, 50) // 1000/20
  assertEquals(eth1.sampleCount, 2) // only present in composition A
})

it('queryEntitySeriesViaSqlApi (paged family): a requested entity absent from every row still comes back with empty points and full gapCount', async () => {
  const result = await queryEntitySeriesViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () => new Response(envelopedSqlResponse([]), { status: 200 }),
    },
    {
      serverId: HOST_SERVER_ID,
      family: 'gpu',
      entityIds: ['gpu0'],
      metrics: ['utilizationPercent'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
      resolutionSeconds: 60,
    }
  )
  assertEquals(result.entities.length, 1)
  assertEquals(result.entities[0].entityId, 'gpu0')
  assertEquals(result.entities[0].points, [])
  assertEquals(result.entities[0].sampleCount, 0)
  assertEquals(result.entities[0].gapCount > 0, true)
})

const EMPTY_SLOT_MAPPING = {
  normalNicSlots: [],
  fabricDeviceIds: [],
  rootFilesystemId: null,
  gpuPageOrder: [],
  blockPageOrder: [],
  filesystemPageOrder: [],
  hardwareSignalPageOrder: [],
}

it("queryEntitySeriesViaSqlApi (network family): reconstructs a slot-mapped NIC's rx/tx from host.io while a genuinely paged device still resolves via the paged path", async () => {
  const result = await queryEntitySeriesViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async (_url, init) => {
        const body = String(init?.body ?? '')
        if (body.includes(`blob2 = 'host.io'`)) {
          return new Response(
            envelopedSqlResponse([
              {
                bucket: 1735689600,
                sample_count: 2,
                avg_interval_seconds: 10,
                nic0_receiveBytesPerSecond: 400,
                nic0_transmitBytesPerSecond: 100,
              },
            ]),
            { status: 200 }
          )
        }
        return new Response(
          envelopedSqlResponse([
            {
              bucket: 1735689600,
              ids: 'eth2',
              sample_count: 2,
              avg_interval_seconds: 10,
              f0_s0_n: 6000,
              f0_s0_d: 20,
              f1_s0_n: 2000,
              f1_s0_d: 20,
            },
          ]),
          { status: 200 }
        )
      },
    },
    {
      serverId: HOST_SERVER_ID,
      family: 'network',
      entityIds: ['eth0', 'eth2'],
      metrics: ['receiveBytesPerSecond', 'transmitBytesPerSecond'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
      slotMapping: { ...EMPTY_SLOT_MAPPING, normalNicSlots: ['eth0'] },
      topologyGeneration: 7,
    }
  )

  assertEquals(result.entities.length, 2)
  const eth0 = result.entities.find((e) => e.entityId === 'eth0')!
  assertEquals(eth0.points.length, 1)
  assertEquals(eth0.points[0].values.receiveBytesPerSecond, 400)
  assertEquals(eth0.points[0].values.transmitBytesPerSecond, 100)
  assertEquals(eth0.sampleCount, 2)

  const eth2 = result.entities.find((e) => e.entityId === 'eth2')!
  assertEquals(eth2.points.length, 1)
  assertEquals(eth2.points[0].values.receiveBytesPerSecond, 300) // 6000/20
  assertEquals(eth2.points[0].values.transmitBytesPerSecond, 100) // 2000/20
  assertEquals(eth2.sampleCount, 2)
})

it('queryEntitySeriesViaSqlApi (network family): a field with no embedded-slot equivalent resolves to null for a slot-mapped NIC, never a fabricated split of the combined problem-packets rate', async () => {
  const result = await queryEntitySeriesViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            {
              bucket: 1735689600,
              sample_count: 2,
              avg_interval_seconds: 10,
              nic0_receiveBytesPerSecond: 400,
            },
          ]),
          { status: 200 }
        ),
    },
    {
      serverId: HOST_SERVER_ID,
      family: 'network',
      entityIds: ['eth0'],
      metrics: ['receiveBytesPerSecond', 'receiveErrorsPerSecond'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
      slotMapping: { ...EMPTY_SLOT_MAPPING, normalNicSlots: ['eth0'] },
      topologyGeneration: 7,
    }
  )

  const eth0 = result.entities[0]
  assertEquals(eth0.points[0].values.receiveBytesPerSecond, 400)
  assertEquals(eth0.points[0].values.receiveErrorsPerSecond, null)
})

it('queryEntitySeriesViaSqlApi (network family): an embedded NIC with no resolved topology generation reports empty points rather than guessing which host.io history is current', async () => {
  let fetchCalls = 0
  const result = await queryEntitySeriesViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () => {
        fetchCalls += 1
        return new Response(envelopedSqlResponse([]), { status: 200 })
      },
    },
    {
      serverId: HOST_SERVER_ID,
      family: 'network',
      entityIds: ['eth0'],
      metrics: ['receiveBytesPerSecond'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
      slotMapping: { ...EMPTY_SLOT_MAPPING, normalNicSlots: ['eth0'] },
    }
  )

  assertEquals(fetchCalls, 0)
  assertEquals(result.entities.length, 1)
  assertEquals(result.entities[0].entityId, 'eth0')
  assertEquals(result.entities[0].points, [])
  assertEquals(result.entities[0].sampleCount, 0)
})

it('queryEntitySeriesViaSqlApi (single-row family): groups managed.ingress by source_id, one row per bucket/entity', async () => {
  const result = await queryEntitySeriesViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            {
              bucket: 1735689600,
              entity_id: 'caddy-1',
              sample_count: 5,
              avg_interval_seconds: 10,
              m0: 42,
            },
          ]),
          { status: 200 }
        ),
    },
    {
      serverId: HOST_SERVER_ID,
      family: 'managed.ingress',
      entityIds: ['caddy-1'],
      metrics: ['requests'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
    }
  )
  assertEquals(result.entities.length, 1)
  assertEquals(result.entities[0].entityId, 'caddy-1')
  assertEquals(result.entities[0].points[0].values.requests, 42)
  assertEquals(result.entities[0].sampleCount, 5)
})

it('queryEntitySeriesViaSqlApi (single-row family): two sources sharing sourceKind resolve as distinct entities', async () => {
  const result = await queryEntitySeriesViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            {
              bucket: 1735689600,
              entity_id: 'caddy-1',
              sample_count: 5,
              avg_interval_seconds: 10,
              m0: 42,
            },
            {
              bucket: 1735689600,
              entity_id: 'caddy-2',
              sample_count: 3,
              avg_interval_seconds: 10,
              m0: 99,
            },
          ]),
          { status: 200 }
        ),
    },
    {
      serverId: HOST_SERVER_ID,
      family: 'managed.ingress',
      entityIds: ['caddy-1', 'caddy-2'],
      metrics: ['requests'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
    }
  )
  assertEquals(result.entities.length, 2)
  const caddy1 = result.entities.find((e) => e.entityId === 'caddy-1')!
  assertEquals(caddy1.points[0].values.requests, 42)
  const caddy2 = result.entities.find((e) => e.entityId === 'caddy-2')!
  assertEquals(caddy2.points[0].values.requests, 99)
})

it('queryEntitySeriesViaSqlApi rejects an unknown field for the given family', async () => {
  let threw = false
  try {
    await queryEntitySeriesViaSqlApi(
      { accountId: 'a', apiToken: 'b', fetch: async () => new Response('{}') },
      {
        serverId: HOST_SERVER_ID,
        family: 'gpu',
        entityIds: ['gpu0'],
        metrics: ['notAField'],
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:05:00.000Z',
      }
    )
  } catch {
    threw = true
  }
  assertEquals(threw, true)
})

// ---------------------------------------------------------------------------
// queryEntityIdsSeenViaSqlApi
// ---------------------------------------------------------------------------

it('queryEntityIdsSeenViaSqlApi (paged family): splits comma-joined page ids into a distinct sorted list', async () => {
  const result = await queryEntityIdsSeenViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(envelopedSqlResponse([{ ids: 'eth0,eth1' }, { ids: 'eth0,eth2' }]), {
          status: 200,
        }),
    },
    {
      serverId: HOST_SERVER_ID,
      family: 'network',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
    }
  )
  assertEquals(result.entityIds, ['eth0', 'eth1', 'eth2'])
})

it("queryEntityIdsSeenViaSqlApi (single-row family): each row's ids is already one entity's sourceId, distinct sources of the same sourceKind stay separate", async () => {
  const result = await queryEntityIdsSeenViaSqlApi(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            { ids: 'caddy-1' },
            { ids: 'caddy-1' },
            {
              ids: 'caddy-2',
            },
          ]),
          { status: 200 }
        ),
    },
    {
      serverId: HOST_SERVER_ID,
      family: 'managed.ingress',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
    }
  )
  assertEquals(result.entityIds, ['caddy-1', 'caddy-2'])
})

// ---------------------------------------------------------------------------
// buildRecentlyActiveServerIdsSql / queryRecentlyActiveServerIds
// ---------------------------------------------------------------------------

it('buildRecentlyActiveServerIdsSql: scoped to host.system, since-window predicate, grouped by server', () => {
  const sql = buildRecentlyActiveServerIdsSql({
    sinceSeconds: AE_LIVENESS_WINDOW_SECONDS,
    nowMs: 1735689600_000,
  })
  assertEquals(sql.includes(`blob1 = 'metrics'`), true)
  assertEquals(sql.includes(familyPredicate(AE_FAMILY_HOST_SYSTEM)), true)
  assertEquals(sql.includes(`>= toDateTime(${1735689600 - AE_LIVENESS_WINDOW_SECONDS})`), true)
  assertEquals(sql.includes('GROUP BY server_id'), true)
})

it('queryRecentlyActiveServerIds: maps serverId to latest-sample epoch ms, skips unparseable rows', async () => {
  const result = await queryRecentlyActiveServerIds(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponse([
            { server_id: HOST_SERVER_ID, latest_at: 1735689600 },
            { server_id: null, latest_at: 1735689600 },
          ]),
          { status: 200 }
        ),
    },
    { sinceSeconds: AE_LIVENESS_WINDOW_SECONDS }
  )
  assertEquals(result.size, 1)
  assertEquals(result.get(HOST_SERVER_ID), 1735689600 * 1000)
})
