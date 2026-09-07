/**
 * Orphan-row semantics: a per-entity-family row that survives without its
 * corresponding `host.system` anchor (e.g. the host row was lost in
 * transit while an entity row made it through) must never leak into
 * host-level aggregates. `queryHostSummary` / `queryHostSeries`'
 * `sampleCount` / `latestAt` / `gapCount` are computed from the host
 * samples alone.
 *
 * DuckDB half: writes an orphan `network` row directly into
 * `server_network_samples` (bypassing `writeSample` entirely, so no
 * `server_host_samples` row exists for that timestamp), then a real
 * complete sample via `writeSample` at a different timestamp, and asserts
 * the host-level query result (`sampleCount` / `latestAt` / `gapCount`)
 * reflects only the real sample.
 *
 * AE half: writes the orphan row via `dataset.writeDataPoint` directly
 * (bypassing `CloudflareAnalyticsEngineServerMetricsStoreV5.writeSample`
 * entirely) into `createFakeAnalyticsEngineV5`'s in-memory DuckDB-backed AE
 * dataset (`testing/fake-analytics-engine-v5.ts`), then queries back through
 * the real `queryHostSummary`/`queryHostSeries` SQL — an executed check, not
 * a structural one, so it actually proves the aggregate never leaks. A cheap
 * structural predicate-level test stays at the bottom of this file too,
 * pinning the invariant the executed tests rely on.
 */
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSampleV5 } from './contract-v5.ts'
import type { AuthenticatedMetricsSampleV5, SlotMapping } from './types-v5.ts'
import {
  AE_V5_BLOB_FAMILY_INDEX,
  AE_V5_FAMILY_HOST_IO,
  AE_V5_FAMILY_HOST_SYSTEM,
  AE_V5_FAMILY_NETWORK,
  buildMetricsDataPointsV5,
} from './backends/cloudflare/field-map-v5.ts'
import {
  familyPredicateV5,
  hostMetricsV5DiscriminatorPredicates,
} from './backends/cloudflare/sql-api-v5.ts'
import { CloudflareAnalyticsEngineServerMetricsStoreV5 } from './backends/cloudflare/store-v5.ts'
import {
  createFakeAnalyticsEngineV5,
  type FakeAnalyticsEngineV5,
} from './testing/fake-analytics-engine-v5.ts'
import { openDuckDb, resolveDuckDbPaths } from './backends/duckdb/database.ts'
import { NETWORK_SAMPLES_TABLE, networkSamplesInsertColumns } from './backends/duckdb/schema.ts'
import { DuckDbParquetServerMetricsStore } from './backends/duckdb/store.ts'

const SERVER_ID = '11111111-2222-4333-8444-555555555555'
const FROM_MS = Date.UTC(2026, 5, 2)
const TO_MS = FROM_MS + 3_600_000

const EMPTY_HOST_INPUT = {
  cpu: {
    busyPercent: 10,
    userPercent: null,
    systemPercent: null,
    iowaitPercent: null,
    stealPercent: null,
    softirqPercent: null,
    pressureSomePercent: null,
    saturatedCoreCount: null,
    procsRunning: null,
    procsBlocked: null,
    processCount: null,
  },
  kernel: { fileHandlesUsedPercent: null, conntrackUsedPercent: null },
  memory: {
    usedBytes: null,
    cachedFilesBytes: null,
    swapUsedBytes: null,
    pressureSomePercent: null,
    pressureFullPercent: null,
    swapInBytesPerSecond: null,
    swapOutBytesPerSecond: null,
    majorPageFaultsPerSecond: null,
  },
  storage: {
    ioPressureSomePercent: null,
    ioPressureFullPercent: null,
    diskReadBytesPerSecond: null,
    diskWriteBytesPerSecond: null,
    diskLatencyMs: null,
    rootFilesystemAvailableBytes: null,
    rootFilesystemFreeInodes: null,
  },
  network: { tcpRetransmitPercent: null, softnetDropsPerSecond: null },
}

const EMPTY_SLOT_MAPPING: SlotMapping = {
  normalNicSlots: [],
  fabricDeviceIds: [],
  rootFilesystemId: null,
  gpuPageOrder: [],
  blockPageOrder: [],
  filesystemPageOrder: [],
  hardwareSignalPageOrder: [],
}

function authenticate(
  built: ReturnType<typeof buildMetricsSampleV5>,
  atMs: number
): AuthenticatedMetricsSampleV5 {
  return {
    ...built,
    serverId: SERVER_ID,
    receivedAt: new Date(atMs).toISOString(),
  }
}

function realHostSample(atMs: number): AuthenticatedMetricsSampleV5 {
  const built = buildMetricsSampleV5({
    metadata: {
      version: 5,
      sampledAt: new Date(atMs).toISOString(),
      intervalSeconds: 60,
      sequence: 1,
      collectionMode: 'baseline',
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: EMPTY_HOST_INPUT,
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
  })
  return authenticate(built, atMs)
}

/** DuckDB `TIMESTAMP`-castable UTC string from an epoch-ms timestamp (mirrors `store.ts`'s private `toDuckDbTimestamp`). */
function toDuckDbTimestamp(atMs: number): string {
  return new Date(atMs).toISOString().replace('T', ' ').replace('Z', '')
}

/**
 * Insert one `network`-family row directly into `server_network_samples`,
 * bypassing `writeSample` (and therefore never touching `server_host_samples`)
 * — simulates a host-anchor sample lost in transit while an entity-family
 * row survived.
 */
async function insertOrphanNetworkRow(metricsDir: string, atMs: number): Promise<void> {
  const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
  try {
    const columns = networkSamplesInsertColumns()
    // COMMON_METADATA_COLUMNS: server_id, sampled_at, received_at,
    // interval_seconds, collection_mode, sequence, topology_generation,
    // boot_generation — then device_id, then every NETWORK_METRIC_FIELDS
    // column (left NULL).
    const metricPlaceholders = columns
      .slice(9)
      .map(() => 'NULL')
      .join(', ')
    const sql =
      `INSERT INTO ${NETWORK_SAMPLES_TABLE} (${columns.join(', ')}) VALUES (` +
      `CAST(? AS UUID), CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP), CAST(? AS SMALLINT), ` +
      `?, CAST(? AS BIGINT), CAST(? AS INTEGER), CAST(? AS INTEGER), ?, ${metricPlaceholders})`
    await handle.connection.run(sql, [
      SERVER_ID,
      toDuckDbTimestamp(atMs),
      toDuckDbTimestamp(atMs),
      60,
      'baseline',
      1,
      1,
      1,
      'orphan-eth0',
    ])
  } finally {
    handle.close()
  }
}

it('orphan network row (DuckDB): queryHostSummary reflects only the real host sample', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-orphan-row-' })
  try {
    // Orphan entity row first, at an earlier timestamp, with no host row.
    await insertOrphanNetworkRow(metricsDir, FROM_MS + 30_000)

    const store = new DuckDbParquetServerMetricsStore(
      { metricsDir },
      {
        writeBatchMaxRows: 1,
      }
    )
    try {
      await store.writeSample(realHostSample(FROM_MS + 90_000))

      const summary = await store.queryHostSummary({
        serverId: SERVER_ID,
        from: new Date(FROM_MS).toISOString(),
        to: new Date(TO_MS).toISOString(),
      })
      // Only the one real host sample counts — the orphan network row (which
      // predates it) must not inflate sampleCount or move latestAt earlier.
      assertEquals(summary.sampleCount, 1)
      assertEquals(summary.latestAt, new Date(FROM_MS + 90_000).toISOString())

      // Range spans two 1-hour buckets at a 60s sample interval (60 expected
      // samples/bucket, `computeSeriesGapCount`'s default): the real sample
      // fills 1 of the first bucket's 60 expected slots (59-sample gap) and
      // the wholly-empty second bucket contributes its full 60 — the orphan
      // row (which predates even the first bucket) must not shrink either
      // figure.
      const series = await store.queryHostSeries({
        serverId: SERVER_ID,
        metrics: ['host.cpu.busyPercent'],
        from: new Date(FROM_MS).toISOString(),
        to: new Date(FROM_MS + 2 * 3_600_000).toISOString(),
        resolutionSeconds: 3600,
      })
      assertEquals(series.sampleCount, 1)
      assertEquals(series.points.length, 1)
      assertEquals(series.points[0]!.values['host.cpu.busyPercent'], 10)
      assertEquals(
        series.gapCount,
        119,
        '59 (first bucket, 1/60 filled) + 60 (second bucket, fully empty) — the orphan row must not shrink this'
      )
    } finally {
      await store.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('orphan network row (DuckDB): an orphan row with no real sample in range yields an empty host summary', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-orphan-row-empty-' })
  try {
    await insertOrphanNetworkRow(metricsDir, FROM_MS + 30_000)

    const store = new DuckDbParquetServerMetricsStore(
      { metricsDir },
      {
        writeBatchMaxRows: 1,
      }
    )
    try {
      const summary = await store.queryHostSummary({
        serverId: SERVER_ID,
        from: new Date(FROM_MS).toISOString(),
        to: new Date(TO_MS).toISOString(),
      })
      assertEquals(summary.sampleCount, 0)
      assertEquals(summary.latestAt, null)

      const series = await store.queryHostSeries({
        serverId: SERVER_ID,
        metrics: ['host.cpu.busyPercent'],
        from: new Date(FROM_MS).toISOString(),
        to: new Date(FROM_MS + 2 * 3_600_000).toISOString(),
        resolutionSeconds: 3600,
      })
      assertEquals(series.sampleCount, 0)
      assertEquals(series.points.length, 0)
      assertEquals(
        series.gapCount,
        120,
        'both buckets fully empty (60 expected samples/bucket) — the orphan row must not fill either'
      )
    } finally {
      await store.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

/**
 * Write one `network`-family AE row directly via `dataset.writeDataPoint`
 * (bypassing `CloudflareAnalyticsEngineServerMetricsStoreV5.writeSample`
 * entirely, so no `host.system`/`host.io` row exists for this timestamp) —
 * the AE analogue of `insertOrphanNetworkRow`'s direct DuckDB table insert.
 * Built via the real `buildMetricsDataPointsV5` packer (on a sample that
 * declares one NIC not assigned to the first two `normalNicSlots` — a NIC
 * in either of those slots gets embedded directly into the `host.io` row
 * instead of paging as its own `network`-family row, per this module's doc
 * comment) so the row's blob/double layout is exactly what production would
 * emit; only the network-family point is kept.
 */
function writeOrphanNetworkRowV5(fakeAe: FakeAnalyticsEngineV5, atMs: number): void {
  const sample = authenticate(
    buildMetricsSampleV5({
      metadata: {
        version: 5,
        sampledAt: new Date(atMs).toISOString(),
        intervalSeconds: 60,
        sequence: 1,
        collectionMode: 'baseline',
        topologyGeneration: 1,
        bootGeneration: 1,
      },
      host: EMPTY_HOST_INPUT,
      networks: [
        {
          deviceId: 'orphan-eth0',
          receiveBytesPerSecond: 1,
          transmitBytesPerSecond: 1,
          receiveErrorsPerSecond: 0,
          transmitErrorsPerSecond: 0,
          receiveDropsPerSecond: 0,
          transmitDropsPerSecond: 0,
        },
      ],
      filesystems: [],
      blockDevices: [],
      gpus: [],
      hardwareSignals: [],
      ingressSources: [],
      databaseProxies: [],
      events: [],
    }),
    atMs
  )
  const points = buildMetricsDataPointsV5(sample, EMPTY_SLOT_MAPPING)
  const orphanPoints = points.filter(
    (p) => p.blobs[AE_V5_BLOB_FAMILY_INDEX] === AE_V5_FAMILY_NETWORK
  )
  assertEquals(orphanPoints.length > 0, true, 'fixture must actually produce a network-family row')
  fakeAe.setNow(atMs)
  for (const point of orphanPoints) fakeAe.dataset.writeDataPoint(point)
}

it('orphan network row (AE, executed): queryHostSummary/queryHostSeries reflect only the real host sample', async () => {
  const fakeAe = await createFakeAnalyticsEngineV5()
  const store = new CloudflareAnalyticsEngineServerMetricsStoreV5(fakeAe.dataset, {
    sql: fakeAe.sqlConfig,
  })
  try {
    writeOrphanNetworkRowV5(fakeAe, FROM_MS + 30_000)

    fakeAe.setNow(FROM_MS + 90_000)
    store.writeSample(realHostSample(FROM_MS + 90_000), EMPTY_SLOT_MAPPING)

    const summary = await store.queryHostSummary({
      serverId: SERVER_ID,
      from: new Date(FROM_MS).toISOString(),
      to: new Date(TO_MS).toISOString(),
    })
    assertEquals(summary.sampleCount, 1)
    assertEquals(summary.latestAt, new Date(FROM_MS + 90_000).toISOString())

    const series = await store.queryHostSeries({
      serverId: SERVER_ID,
      metrics: ['host.cpu.busyPercent'],
      from: new Date(FROM_MS).toISOString(),
      to: new Date(FROM_MS + 2 * 3_600_000).toISOString(),
      resolutionSeconds: 3600,
    })
    assertEquals(series.sampleCount, 1)
    assertEquals(series.points.length, 1)
    assertEquals(series.points[0]!.values['host.cpu.busyPercent'], 10)
    assertEquals(
      series.gapCount,
      119,
      '59 (first bucket, 1/60 filled) + 60 (second bucket, fully empty) — the orphan row must not shrink this'
    )
  } finally {
    await fakeAe.close()
  }
})

it('orphan network row (AE, executed): an orphan row with no real sample in range yields an empty host summary/series', async () => {
  const fakeAe = await createFakeAnalyticsEngineV5()
  const store = new CloudflareAnalyticsEngineServerMetricsStoreV5(fakeAe.dataset, {
    sql: fakeAe.sqlConfig,
  })
  try {
    writeOrphanNetworkRowV5(fakeAe, FROM_MS + 30_000)

    const summary = await store.queryHostSummary({
      serverId: SERVER_ID,
      from: new Date(FROM_MS).toISOString(),
      to: new Date(TO_MS).toISOString(),
    })
    assertEquals(summary.sampleCount, 0)
    assertEquals(summary.latestAt, null)

    const series = await store.queryHostSeries({
      serverId: SERVER_ID,
      metrics: ['host.cpu.busyPercent'],
      from: new Date(FROM_MS).toISOString(),
      to: new Date(FROM_MS + 2 * 3_600_000).toISOString(),
      resolutionSeconds: 3600,
    })
    assertEquals(series.sampleCount, 0)
    assertEquals(series.points.length, 0)
    assertEquals(
      series.gapCount,
      120,
      'both buckets fully empty (60 expected samples/bucket) — the orphan row must not fill either'
    )
  } finally {
    await fakeAe.close()
  }
})

it('orphan row (structural, AE): a network-family row can never satisfy a host-scoped predicate', () => {
  // `hostFamilyScopePredicateV5` (private to sql-api-v5.ts) composes every
  // host query's WHERE clause as
  // `(blob2 = 'host.system' OR blob2 = 'host.io' [...])` from exactly these
  // exported building blocks — see its doc comment. `blob2` carries exactly
  // one family value per row, so a `network`-family row's predicate is
  // mutually exclusive with both host predicates by construction. The
  // executed tests above prove this end to end; this keeps the cheap
  // predicate-level invariant pinned too.
  const hostSystemPredicate = familyPredicateV5(AE_V5_FAMILY_HOST_SYSTEM)
  const hostIoPredicate = familyPredicateV5(AE_V5_FAMILY_HOST_IO)
  const networkPredicate = familyPredicateV5(AE_V5_FAMILY_NETWORK)

  assertEquals(hostSystemPredicate, `blob2 = 'host.system'`)
  assertEquals(hostIoPredicate, `blob2 = 'host.io'`)
  assertEquals(networkPredicate, `blob2 = 'network'`)
  assertEquals(networkPredicate === hostSystemPredicate, false)
  assertEquals(networkPredicate === hostIoPredicate, false)

  // Every host query also requires the shared metrics-row discriminator —
  // an orphan row written through any other path still has to satisfy this
  // too, and blob2's family value alone already rules it out above.
  assertEquals(hostMetricsV5DiscriminatorPredicates(), [`blob1 = 'metrics'`, `blob3 = '5'`])
})
