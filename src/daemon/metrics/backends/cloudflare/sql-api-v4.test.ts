import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { AE_V4_FAMILY_HOST_IO, AE_V4_FAMILY_HOST_SYSTEM } from './field-map-v4.ts'
import {
  HOST_METRICS_METRIC_DESCRIPTORS_V4,
  type HostMetricsMetricDescriptorV4,
} from '../../metric-descriptors-v4.ts'
import {
  AE_LIVENESS_WINDOW_SECONDS,
  AE_V4_DATASET_NAME,
  AE_V4_SUPPORTED_SCHEMA_VERSIONS,
  aeV4MissingMetricSentinelSql,
  aggregateExpressionForDescriptorV4,
  buildRecentlyActiveServerIdsSqlV4,
  deltaSumExpressionForColumnV4,
  entityIdInPageIdentityPredicateV4,
  eventV4DiscriminatorPredicates,
  familyPredicateV4,
  hostMetricsV4DiscriminatorPredicates,
  lastValueExpressionForColumnV4,
  latestAtExpressionV4,
  maxValueExpressionForColumnV4,
  queryEntityIdsSeenViaSqlApiV4,
  queryEntitySeriesViaSqlApiV4,
  queryFleetHostSnapshotViaSqlApiV4,
  queryHostSeriesViaSqlApiV4,
  queryHostSummaryViaSqlApiV4,
  queryMetricEventsViaSqlApiV4,
  queryRecentlyActiveServerIdsV4,
  queryStatusHistoryViaSqlApiV4,
  quoteSqlStringV4,
  sampleCountExpressionV4,
  serverIdPredicateV4,
  statusV4DiscriminatorPredicates,
  stripAeV4Sentinel,
  timeRangePredicateV4,
  v4EventDiscriminatorPredicates,
  weightedAvgExpressionForColumnV4,
} from './sql-api-v4.ts'

it('AE_V4_DATASET_NAME is the v4 dataset, distinct from the v3 dataset', () => {
  assertEquals(AE_V4_DATASET_NAME, 'turbopanel_server_metrics_v4')
})

it('AE_V4_SUPPORTED_SCHEMA_VERSIONS is exactly [4]', () => {
  assertEquals(AE_V4_SUPPORTED_SCHEMA_VERSIONS, [4])
})

it('quoteSqlStringV4 doubles single quotes', () => {
  assertEquals(quoteSqlStringV4("O'Brien"), "'O''Brien'")
  assertEquals(quoteSqlStringV4('plain'), "'plain'")
})

it('v4EventDiscriminatorPredicates: blob1 = kind, blob3 = schema version', () => {
  const predicates = v4EventDiscriminatorPredicates('metrics')
  assertEquals(predicates, [`blob1 = 'metrics'`, `blob3 = '4'`])
})

it('hostMetricsV4DiscriminatorPredicates matches the metrics kind', () => {
  assertEquals(hostMetricsV4DiscriminatorPredicates(), [`blob1 = 'metrics'`, `blob3 = '4'`])
})

it('eventV4DiscriminatorPredicates matches the event kind', () => {
  assertEquals(eventV4DiscriminatorPredicates(), [`blob1 = 'event'`, `blob3 = '4'`])
})

it('statusV4DiscriminatorPredicates matches the status kind', () => {
  assertEquals(statusV4DiscriminatorPredicates(), [`blob1 = 'status'`, `blob3 = '4'`])
})

it("familyPredicateV4: blob2 = '<family>'", () => {
  assertEquals(familyPredicateV4(AE_V4_FAMILY_HOST_SYSTEM), `blob2 = 'host.system'`)
  assertEquals(familyPredicateV4(AE_V4_FAMILY_HOST_IO), `blob2 = 'host.io'`)
})

it('aeV4MissingMetricSentinelSql: documented AE SQL, no scientific notation', () => {
  assertEquals(aeV4MissingMetricSentinelSql(), '-pow(10, 308)')
})

it('stripAeV4Sentinel: strips values at/below the threshold, keeps real values', () => {
  assertEquals(stripAeV4Sentinel(-1e308), null)
  assertEquals(stripAeV4Sentinel(-1e307), null)
  assertEquals(stripAeV4Sentinel(-1e306), -1e306)
  assertEquals(stripAeV4Sentinel(0), 0)
  assertEquals(stripAeV4Sentinel(42.5), 42.5)
  assertEquals(stripAeV4Sentinel(-100), -100)
})

it('weightedAvgExpressionForColumnV4: SUM(value*double20*_sample_interval)/SUM(double20*_sample_interval), scoped to family', () => {
  const expr = weightedAvgExpressionForColumnV4(AE_V4_FAMILY_HOST_SYSTEM, 0)
  assertEquals(
    expr,
    "SUM(if(blob2 = 'host.system', if(double1 = -pow(10, 308), 0.0, double1 * double20 * _sample_interval), 0.0)) / " +
      "SUM(if(blob2 = 'host.system', if(double1 = -pow(10, 308), 0.0, double20 * _sample_interval * 1.0), 0.0))"
  )
})

it('deltaSumExpressionForColumnV4: weight by _sample_interval only, never intervalSeconds', () => {
  const expr = deltaSumExpressionForColumnV4(AE_V4_FAMILY_HOST_IO, 2)
  assertEquals(
    expr,
    "SUM(if(blob2 = 'host.io', if(double3 = -pow(10, 308), 0.0, double3 * _sample_interval), 0.0))"
  )
  // Never references double20 (the reserved interval slot).
  assertEquals(expr.includes('double20'), false)
})

it('maxValueExpressionForColumnV4: MAX(if(family, col, sentinel))', () => {
  const expr = maxValueExpressionForColumnV4(AE_V4_FAMILY_HOST_SYSTEM, 5)
  assertEquals(expr, "MAX(if(blob2 = 'host.system', double6, -pow(10, 308)))")
})

it('lastValueExpressionForColumnV4: argMax keyed by row timestamp, sentinel demoted to ordering key 0', () => {
  const expr = lastValueExpressionForColumnV4(AE_V4_FAMILY_HOST_IO, 0)
  assertEquals(
    expr,
    "argMax(if(blob2 = 'host.io', double1, -pow(10, 308)), " +
      "if(if(blob2 = 'host.io', double1, -pow(10, 308)) = -pow(10, 308), toUnixTimestamp(timestamp) * 0, toUnixTimestamp(timestamp)))"
  )
})

it('sampleCountExpressionV4: anchored on host.system, weighted by _sample_interval', () => {
  assertEquals(
    sampleCountExpressionV4(),
    "SUM(if(blob2 = 'host.system', _sample_interval * 1.0, 0.0))"
  )
})

it('latestAtExpressionV4: MAX unix-seconds timestamp anchored on host.system', () => {
  assertEquals(
    latestAtExpressionV4(),
    "MAX(if(blob2 = 'host.system', toUnixTimestamp(timestamp), 0))"
  )
})

it('timeRangePredicateV4: canonical half-open [from, to)', () => {
  assertEquals(
    timeRangePredicateV4(1_700_000_000, 1_700_003_600),
    'timestamp >= toDateTime(1700000000) AND timestamp < toDateTime(1700003600)'
  )
})

it('timeRangePredicateV4: from === to yields an empty (never-true) range, not an error', () => {
  assertEquals(
    timeRangePredicateV4(1_700_000_000, 1_700_000_000),
    'timestamp >= toDateTime(1700000000) AND timestamp < toDateTime(1700000000)'
  )
})

it("serverIdPredicateV4: index1 = '<serverId>'", () => {
  assertEquals(
    serverIdPredicateV4('11111111-2222-4333-8444-555555555555'),
    "index1 = '11111111-2222-4333-8444-555555555555'"
  )
})

it('entityIdInPageIdentityPredicateV4: matches exact, leading, trailing, and mid-list CSV positions', () => {
  const predicate = entityIdInPageIdentityPredicateV4('gpu1')
  assertEquals(predicate.includes("blob10 = 'gpu1'"), true)
  assertEquals(predicate.includes("CONCAT('gpu1,', '%')"), true)
  assertEquals(predicate.includes("CONCAT('%', ',gpu1')"), true)
  assertEquals(predicate.includes("CONCAT('%', ',gpu1,', '%')"), true)
})

// ---------------------------------------------------------------------------
// queryStatusHistoryViaSqlApiV4 — real entry point, in scope for this phase
// (no per-entity/topology ambiguity for status rows — see module doc comment)
// ---------------------------------------------------------------------------

const STATUS_SERVER_ID = '11111111-2222-4333-8444-555555555555'

function envelopedSqlResponseV4(data: Array<Record<string, unknown>>, rows = data.length): string {
  return JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: { data, meta: [], rows },
  })
}

it('queryStatusHistoryViaSqlApiV4: prior state + in-range transitions produce correct uptime split', async () => {
  const from = '2026-01-01T00:00:00.000Z'
  const to = '2026-01-01T01:00:00.000Z'

  const result = await queryStatusHistoryViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async (_url, init) => {
        const body = String(init?.body ?? '')
        if (body.includes('ORDER BY timestamp DESC')) {
          // State just before `from`: connected.
          return new Response(
            envelopedSqlResponseV4([
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
          envelopedSqlResponseV4([
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

it('queryStatusHistoryViaSqlApiV4: no prior row and no transitions is entirely unknown', async () => {
  const result = await queryStatusHistoryViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () => new Response(envelopedSqlResponseV4([]), { status: 200 }),
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
// aggregateExpressionForDescriptorV4 — dispatch by declared aggregation
// ---------------------------------------------------------------------------

function descriptorWithAggregation(
  aggregation: HostMetricsMetricDescriptorV4['aggregation']
): HostMetricsMetricDescriptorV4 {
  return {
    ...HOST_METRICS_METRIC_DESCRIPTORS_V4['host.cpu.busyPercent'],
    aggregation,
  }
}

it('aggregateExpressionForDescriptorV4 dispatches weighted-average/delta-sum/max/last to the matching builder', () => {
  assertEquals(
    aggregateExpressionForDescriptorV4(
      descriptorWithAggregation('weighted-average'),
      'host.system',
      0
    ),
    weightedAvgExpressionForColumnV4('host.system', 0)
  )
  assertEquals(
    aggregateExpressionForDescriptorV4(descriptorWithAggregation('delta-sum'), 'host.system', 4),
    deltaSumExpressionForColumnV4('host.system', 4)
  )
  assertEquals(
    aggregateExpressionForDescriptorV4(descriptorWithAggregation('max'), 'host.system', 7),
    maxValueExpressionForColumnV4('host.system', 7)
  )
  assertEquals(
    aggregateExpressionForDescriptorV4(descriptorWithAggregation('last'), 'host.system', 2),
    lastValueExpressionForColumnV4('host.system', 2)
  )
})

// ---------------------------------------------------------------------------
// queryHostSeriesViaSqlApiV4 / queryHostSummaryViaSqlApiV4
// ---------------------------------------------------------------------------

const HOST_SERVER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

it('queryHostSeriesViaSqlApiV4: one bucket, one weighted-average metric, topology generation carried through', async () => {
  const result = await queryHostSeriesViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async (_url, init) => {
        const body = String(init?.body ?? '')
        if (body.includes('GROUP BY generation')) {
          return new Response(envelopedSqlResponseV4([{ generation: 3 }]), {
            status: 200,
          })
        }
        return new Response(
          envelopedSqlResponseV4([
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

it('queryHostSeriesViaSqlApiV4: mixed topology generations in a bucket report null', async () => {
  const result = await queryHostSeriesViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async (_url, init) => {
        const body = String(init?.body ?? '')
        if (body.includes('GROUP BY generation')) {
          return new Response(envelopedSqlResponseV4([{ generation: 1 }, { generation: 2 }]), {
            status: 200,
          })
        }
        return new Response(
          envelopedSqlResponseV4([
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

it('queryHostSeriesViaSqlApiV4 rejects a non-host metric', async () => {
  let threw = false
  try {
    await queryHostSeriesViaSqlApiV4(
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

it('queryHostSeriesViaSqlApiV4: cpuDetail.* request also selects+parses the 4 embedded hotspot slots', async () => {
  const result = await queryHostSeriesViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async (_url, init) => {
        const body = String(init?.body ?? '')
        if (body.includes('GROUP BY generation')) {
          return new Response(envelopedSqlResponseV4([]), { status: 200 })
        }
        // Row includes the cpuDetail scalar select (m0) plus every hotspot
        // slot's 3 fields (h{slot}_{fieldIndex}) and the shared coreId label.
        return new Response(
          envelopedSqlResponseV4([
            {
              bucket: 1735689600,
              sample_count: 6,
              avg_interval_seconds: 10,
              topology_gen_min: null,
              topology_gen_max: null,
              m0: 3200,
              h0_0: 91.5,
              h0_1: 1.5,
              h0_2: 0,
              h1_0: 80,
              h1_1: 2,
              h1_2: 0,
              h2_0: 70,
              h2_1: 0,
              h2_2: 0,
              h3_0: 60,
              h3_1: 0,
              h3_2: 0,
              cpu_hotspot_core_ids: 'cpu0,cpu2,cpu5,cpu7',
            },
          ]),
          { status: 200 }
        )
      },
    },
    {
      serverId: HOST_SERVER_ID,
      metrics: ['cpuDetail.averageFrequencyMHz'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:05:00.000Z',
      resolutionSeconds: 60,
    }
  )

  assertEquals(result.points[0].values['cpuDetail.averageFrequencyMHz'], 3200)
  const hotspots = result.points[0].cpuHotspots
  assertEquals(hotspots?.length, 4)
  assertEquals(hotspots?.[0], {
    coreId: 'cpu0',
    values: { busyPercent: 91.5, iowaitPercent: 1.5, stealPercent: 0 },
  })
  assertEquals(hotspots?.[3], {
    coreId: 'cpu7',
    values: { busyPercent: 60, iowaitPercent: 0, stealPercent: 0 },
  })
})

it('queryHostSeriesViaSqlApiV4: a host.*-only request never selects/parses hotspot slots', async () => {
  const result = await queryHostSeriesViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async (_url, init) => {
        const body = String(init?.body ?? '')
        if (body.includes('GROUP BY generation')) {
          return new Response(envelopedSqlResponseV4([]), { status: 200 })
        }
        assertEquals(body.includes('cpu_hotspot_core_ids'), false)
        return new Response(
          envelopedSqlResponseV4([
            {
              bucket: 1735689600,
              sample_count: 6,
              avg_interval_seconds: 10,
              topology_gen_min: null,
              topology_gen_max: null,
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
    }
  )

  assertEquals(result.points[0].cpuHotspots, undefined)
})

it('queryHostSummaryViaSqlApiV4: sample count and latest-at', async () => {
  const result = await queryHostSummaryViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(envelopedSqlResponseV4([{ sample_count: 12, latest_at: 1735689600 }]), {
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

it('queryHostSummaryViaSqlApiV4: zero samples reports latestAt null', async () => {
  const result = await queryHostSummaryViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(envelopedSqlResponseV4([{ sample_count: 0, latest_at: null }]), {
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
// queryFleetHostSnapshotViaSqlApiV4
// ---------------------------------------------------------------------------

it('queryFleetHostSnapshotViaSqlApiV4: empty serverIds short-circuits without a fetch call', async () => {
  const result = await queryFleetHostSnapshotViaSqlApiV4(
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

it("queryFleetHostSnapshotViaSqlApiV4: one server's values and topology generation", async () => {
  const result = await queryFleetHostSnapshotViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponseV4([
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
// queryMetricEventsViaSqlApiV4
// ---------------------------------------------------------------------------

it('queryMetricEventsViaSqlApiV4: parses kind/severity/entityId/payload', async () => {
  const result = await queryMetricEventsViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponseV4([
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

it('queryMetricEventsViaSqlApiV4: truncates beyond MAX_STATUS_EVENTS', async () => {
  const overflowRows = Array.from({ length: 1001 }, (_, i) => ({
    timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
    event_id: `evt${i}`,
    kind: 'nic_link_down',
    severity: 'info',
    entity_id: '',
    source: '',
    payload: '',
  }))
  const result = await queryMetricEventsViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () => new Response(envelopedSqlResponseV4(overflowRows), { status: 200 }),
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
// queryEntitySeriesViaSqlApiV4 — paged families (position-based recombination
// across differing page compositions within the same bucket) and single-row
// families (managed.ingress / managed.database_proxy).
// ---------------------------------------------------------------------------

it("queryEntitySeriesViaSqlApiV4 (paged family): recombines an entity's weighted-average across two different page compositions in the same bucket", async () => {
  const result = await queryEntitySeriesViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponseV4([
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

it('queryEntitySeriesViaSqlApiV4 (paged family): a requested entity absent from every row still comes back with empty points and full gapCount', async () => {
  const result = await queryEntitySeriesViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () => new Response(envelopedSqlResponseV4([]), { status: 200 }),
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

it("queryEntitySeriesViaSqlApiV4 (network family): reconstructs a slot-mapped NIC's rx/tx from host.io while a genuinely paged device still resolves via the paged path", async () => {
  const result = await queryEntitySeriesViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async (_url, init) => {
        const body = String(init?.body ?? '')
        if (body.includes(`blob2 = 'host.io'`)) {
          return new Response(
            envelopedSqlResponseV4([
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
          envelopedSqlResponseV4([
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

it('queryEntitySeriesViaSqlApiV4 (network family): a field with no embedded-slot equivalent resolves to null for a slot-mapped NIC, never a fabricated split of the combined problem-packets rate', async () => {
  const result = await queryEntitySeriesViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponseV4([
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

it('queryEntitySeriesViaSqlApiV4 (network family): an embedded NIC with no resolved topology generation reports empty points rather than guessing which host.io history is current', async () => {
  let fetchCalls = 0
  const result = await queryEntitySeriesViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () => {
        fetchCalls += 1
        return new Response(envelopedSqlResponseV4([]), { status: 200 })
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

it('queryEntitySeriesViaSqlApiV4 (single-row family): groups managed.ingress by source_id, one row per bucket/entity', async () => {
  const result = await queryEntitySeriesViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponseV4([
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

it('queryEntitySeriesViaSqlApiV4 (single-row family): two sources sharing sourceKind resolve as distinct entities', async () => {
  const result = await queryEntitySeriesViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponseV4([
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

it('queryEntitySeriesViaSqlApiV4 rejects an unknown field for the given family', async () => {
  let threw = false
  try {
    await queryEntitySeriesViaSqlApiV4(
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
// queryEntityIdsSeenViaSqlApiV4
// ---------------------------------------------------------------------------

it('queryEntityIdsSeenViaSqlApiV4 (paged family): splits comma-joined page ids into a distinct sorted list', async () => {
  const result = await queryEntityIdsSeenViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(envelopedSqlResponseV4([{ ids: 'eth0,eth1' }, { ids: 'eth0,eth2' }]), {
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

it("queryEntityIdsSeenViaSqlApiV4 (single-row family): each row's ids is already one entity's sourceId, distinct sources of the same sourceKind stay separate", async () => {
  const result = await queryEntityIdsSeenViaSqlApiV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponseV4([{ ids: 'caddy-1' }, { ids: 'caddy-1' }, { ids: 'caddy-2' }]),
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
// buildRecentlyActiveServerIdsSqlV4 / queryRecentlyActiveServerIdsV4
// ---------------------------------------------------------------------------

it('buildRecentlyActiveServerIdsSqlV4: scoped to host.system, since-window predicate, grouped by server', () => {
  const sql = buildRecentlyActiveServerIdsSqlV4({
    sinceSeconds: AE_LIVENESS_WINDOW_SECONDS,
    nowMs: 1735689600_000,
  })
  assertEquals(sql.includes(`blob1 = 'metrics'`), true)
  assertEquals(sql.includes(familyPredicateV4(AE_V4_FAMILY_HOST_SYSTEM)), true)
  assertEquals(sql.includes(`>= toDateTime(${1735689600 - AE_LIVENESS_WINDOW_SECONDS})`), true)
  assertEquals(sql.includes('GROUP BY server_id'), true)
})

it('queryRecentlyActiveServerIdsV4: maps serverId to latest-sample epoch ms, skips unparseable rows', async () => {
  const result = await queryRecentlyActiveServerIdsV4(
    {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async () =>
        new Response(
          envelopedSqlResponseV4([
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
