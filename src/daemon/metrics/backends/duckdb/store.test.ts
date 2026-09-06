import { assertEquals, assertExists } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSampleV4 } from '../../contract-v4.ts'
import type {
  CpuCoreLiveSampleV4,
  CpuDetailSampleV4,
  DatabaseProxySampleV4,
  IngressSourceSampleV4,
  MemoryDetailSampleV4,
  MetricEventV4,
  NetworkDeviceSampleV4,
} from '../../contract-v4.ts'
import type { AuthenticatedMetricsSampleV4, ServerStatusEvent } from '../../types-v4.ts'
import { AE_V4_MISSING_METRIC_SENTINEL } from '../cloudflare/field-map-v4.ts'
import { MAX_STATUS_EVENTS } from '../cloudflare/sql-api-v4.ts'
import { type DuckDbConnectionLike, openDuckDb, resolveDuckDbPaths } from './database.ts'
import { MS_PER_DAY, partitionFileForDay } from './parquet.ts'
import {
  CPU_CORE_SAMPLES_TABLE,
  CPU_HOTSPOT_SAMPLES_TABLE,
  GPU_SAMPLES_TABLE,
  HOST_SAMPLES_TABLE,
  MEMORY_DETAIL_SAMPLES_TABLE,
  METRIC_EVENTS_TABLE,
  NETWORK_SAMPLES_TABLE,
} from './schema.ts'
import { DUCKDB_WRITE_BATCH_MAX_AGE_MS, DuckDbParquetServerMetricsStore } from './store.ts'

const SERVER_A = '11111111-2222-4333-8444-555555555555'
const DAY_START = Date.UTC(2026, 5, 2) // 2026-06-02T00:00:00Z

function makeStore(
  metricsDir: string,
  config: { retentionDays?: number } = {}
): DuckDbParquetServerMetricsStore {
  // writeBatchMaxRows 1 → every accepted write flushes before resolving, so
  // tests never leave a pending flush timer behind.
  return new DuckDbParquetServerMetricsStore({ metricsDir, ...config }, { writeBatchMaxRows: 1 })
}

async function withStore(
  run: (store: DuckDbParquetServerMetricsStore, metricsDir: string) => Promise<void>,
  config: { retentionDays?: number } = {}
): Promise<void> {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-store-' })
  const store = makeStore(metricsDir, config)
  try {
    await run(store, metricsDir)
  } finally {
    await store.close()
    await Deno.remove(metricsDir, { recursive: true })
  }
}

function sampleV4(overrides: {
  serverId?: string
  atMs: number
  intervalSeconds?: number
  sequence?: number
  topologyGeneration?: number
  bootGeneration?: number
  cpuBusyPercent?: number | null
  gpuCount?: number
  networkCount?: number
  networks?: NetworkDeviceSampleV4[]
  ingressSources?: IngressSourceSampleV4[]
  databaseProxies?: DatabaseProxySampleV4[]
  events?: MetricEventV4[]
  collectionMode?: 'baseline' | 'live'
  cpuDetail?: CpuDetailSampleV4
  memoryDetail?: MemoryDetailSampleV4
  cpuCoreLive?: CpuCoreLiveSampleV4[]
}): AuthenticatedMetricsSampleV4 {
  const at = new Date(overrides.atMs).toISOString()
  const gpuCount = overrides.gpuCount ?? 0
  const networkCount = overrides.networkCount ?? 0
  const sample = buildMetricsSampleV4({
    metadata: {
      version: 4,
      sampledAt: at,
      intervalSeconds: overrides.intervalSeconds ?? 60,
      sequence: overrides.sequence ?? 1,
      collectionMode: overrides.collectionMode ?? 'baseline',
      topologyGeneration: overrides.topologyGeneration ?? 1,
      bootGeneration: overrides.bootGeneration ?? 1,
    },
    cpuDetail: overrides.cpuDetail,
    memoryDetail: overrides.memoryDetail,
    cpuCoreLive: overrides.cpuCoreLive,
    host: {
      cpu: {
        busyPercent: overrides.cpuBusyPercent ?? null,
        userPercent: null,
        systemPercent: null,
        iowaitPercent: null,
        stealPercent: null,
        softirqPercent: null,
        pressureSomePercent: null,
        maxCoreBusyPercent: null,
        procsRunning: null,
        procsBlocked: null,
      },
      kernel: { fileHandlesUsedPercent: null, conntrackUsedPercent: null },
      memory: {
        availableBytes: null,
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
        diskReadLatencyMs: null,
        diskWriteLatencyMs: null,
        maxBlockDeviceUtilPercent: null,
        rootFilesystemAvailableBytes: null,
        rootFilesystemFreeInodes: null,
      },
      network: { tcpRetransmitPercent: null, softnetDropsPerSecond: null },
    },
    networks:
      overrides.networks ??
      Array.from({ length: networkCount }, (_, i) => ({
        deviceId: `eth${i}`,
        receiveBytesPerSecond: 100 + i,
        transmitBytesPerSecond: null,
        receiveErrorsPerSecond: null,
        transmitErrorsPerSecond: null,
        receiveDropsPerSecond: null,
        transmitDropsPerSecond: null,
      })),
    filesystems: [],
    blockDevices: [],
    gpus: Array.from({ length: gpuCount }, (_, i) => ({
      gpuId: `gpu${i}`,
      utilizationPercent: i,
      memoryUsedBytes: null,
      memoryActivityPercent: null,
      temperatureCelsius: null,
      memoryTemperatureCelsius: null,
      powerWatts: null,
      pcieReceiveBytesPerSecond: null,
      pcieTransmitBytesPerSecond: null,
      throttlePercent: null,
    })),
    hardwareSignals: [],
    ingressSources: overrides.ingressSources ?? [],
    databaseProxies: overrides.databaseProxies ?? [],
    events: overrides.events ?? [],
  })
  return {
    ...sample,
    serverId: overrides.serverId ?? SERVER_A,
    receivedAt: at,
  }
}

function statusEvent(overrides: {
  atMs: number
  connected: boolean
  reason?: ServerStatusEvent['reason']
}): ServerStatusEvent {
  return {
    serverId: SERVER_A,
    connected: overrides.connected,
    reason: overrides.reason ?? (overrides.connected ? 'connect' : 'disconnect'),
    at: new Date(overrides.atMs).toISOString(),
  }
}

async function rowCount(connection: DuckDbConnectionLike, table: string): Promise<number> {
  const reader = await connection.runAndReadAll(
    `SELECT CAST(count(*) AS DOUBLE) AS n FROM ${table}`
  )
  return Number(reader.getRowObjectsJS()[0]?.n ?? Number.NaN)
}

it('writeSample persists the host row and every entity row with real NULLs, never the AE sentinel', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-write-' })
  try {
    const store = makeStore(metricsDir)
    await store.writeSample(
      sampleV4({
        atMs: DAY_START + 60_000,
        cpuBusyPercent: 42,
        networkCount: 1,
      })
    )
    await store.close()

    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
    try {
      const hostReader = await handle.connection.runAndReadAll(
        `SELECT cpu_busy_percent, cpu_user_percent, ` +
          `CAST(sequence AS DOUBLE) AS sequence, topology_generation, boot_generation ` +
          `FROM ${HOST_SAMPLES_TABLE}`
      )
      const hostRow = hostReader.getRowObjectsJS()[0]!
      assertEquals(hostRow.cpu_busy_percent, 42)
      // Never-set metric is a real SQL NULL — never the AE sentinel.
      assertEquals(hostRow.cpu_user_percent, null)
      assertEquals(hostRow.cpu_user_percent === AE_V4_MISSING_METRIC_SENTINEL, false)
      assertEquals(hostRow.sequence, 1)
      assertEquals(hostRow.topology_generation, 1)
      assertEquals(hostRow.boot_generation, 1)

      const networkReader = await handle.connection.runAndReadAll(
        `SELECT device_id, receive_bytes_per_second, transmit_bytes_per_second FROM ${NETWORK_SAMPLES_TABLE}`
      )
      const networkRow = networkReader.getRowObjectsJS()[0]!
      assertEquals(networkRow.device_id, 'eth0')
      assertEquals(networkRow.receive_bytes_per_second, 100)
      assertEquals(networkRow.transmit_bytes_per_second, null)
    } finally {
      handle.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('arbitrary entity cardinality: 16 GPUs and 24 network devices land as that many rows, no page ceiling', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-duckdb-cardinality-',
  })
  try {
    const store = makeStore(metricsDir)
    await store.writeSample(
      sampleV4({
        atMs: DAY_START + 60_000,
        gpuCount: 16,
        networkCount: 24,
      })
    )
    await store.close()

    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
    try {
      assertEquals(await rowCount(handle.connection, GPU_SAMPLES_TABLE), 16)
      assertEquals(await rowCount(handle.connection, NETWORK_SAMPLES_TABLE), 24)
    } finally {
      handle.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('events land in server_metric_events with server-scoped payload/entity fields', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-events-' })
  try {
    const store = makeStore(metricsDir)
    await store.writeSample(
      sampleV4({
        atMs: DAY_START + 60_000,
        events: [
          {
            eventId: 'evt-1',
            at: new Date(DAY_START + 60_000).toISOString(),
            kind: 'oom_kill',
            severity: 'critical',
            entityId: 'proc-123',
            payload: { pid: 123, killed: true },
          },
        ],
      })
    )
    await store.close()

    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
    try {
      const reader = await handle.connection.runAndReadAll(
        `SELECT server_id, event_id, kind, severity, entity_id, payload FROM ${METRIC_EVENTS_TABLE}`
      )
      const row = reader.getRowObjectsJS()[0]!
      assertEquals(row.event_id, 'evt-1')
      assertEquals(row.kind, 'oom_kill')
      assertEquals(row.severity, 'critical')
      assertEquals(row.entity_id, 'proc-123')
      assertEquals(JSON.parse(String(row.payload)), { pid: 123, killed: true })
    } finally {
      handle.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it("writeSample's row fan-out lands inside a single BEGIN/COMMIT transaction", async () => {
  const calls: string[] = []
  const fakeConnection: DuckDbConnectionLike = {
    // deno-lint-ignore require-await
    run: async (sql) => {
      calls.push(sql)
    },
    // deno-lint-ignore require-await
    runAndReadAll: async (sql) => {
      calls.push(sql)
      return { getRowObjectsJS: () => [] }
    },
    closeSync: () => {},
  }
  const store = new DuckDbParquetServerMetricsStore(
    {},
    {
      openHandle: () => Promise.resolve({ connection: fakeConnection, close: () => {} }),
      writeBatchMaxRows: 1,
    }
  )
  try {
    await store.writeSample(
      sampleV4({
        atMs: DAY_START + 60_000,
        gpuCount: 3,
        networkCount: 2,
        events: [
          {
            eventId: 'evt-1',
            at: new Date(DAY_START + 60_000).toISOString(),
            kind: 'oom_kill',
            severity: 'critical',
          },
        ],
      })
    )
  } finally {
    await store.close()
  }
  const beginIndex = calls.indexOf('BEGIN TRANSACTION')
  const commitIndex = calls.indexOf('COMMIT')
  assertEquals(beginIndex >= 0, true)
  assertEquals(commitIndex > beginIndex, true)
  // host + network + gpu + event tables all fan out from one sample.
  const insertCalls = calls.filter((sql) => sql.startsWith('INSERT INTO'))
  assertEquals(insertCalls.length, 4)
  for (const sql of insertCalls) {
    const idx = calls.indexOf(sql)
    assertEquals(idx > beginIndex && idx < commitIndex, true, sql)
  }
})

it('rows persist across close + reopen at the same path', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-restart-' })
  try {
    const first = makeStore(metricsDir)
    await first.writeSample(sampleV4({ atMs: DAY_START + 60_000, cpuBusyPercent: 10 }))
    await first.close()

    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
    try {
      assertEquals(await rowCount(handle.connection, HOST_SAMPLES_TABLE), 1)
    } finally {
      handle.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('sparse writes arm a short flush timer (a few seconds, never minutes)', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-sparse-' })
  let capturedDelay: number | undefined
  let fireFlush: (() => void) | undefined
  const store = new DuckDbParquetServerMetricsStore(
    { metricsDir },
    {
      setTimeoutFn: ((handler: () => void, timeout?: number) => {
        capturedDelay = timeout
        fireFlush = handler
        return 0
      }) as unknown as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
    }
  )
  try {
    // Default batch size (10) — a single sparse sample stays pending and
    // must arm the age timer at the short default.
    await store.writeSample(sampleV4({ atMs: DAY_START + 60_000, cpuBusyPercent: 10 }))
    assertEquals(capturedDelay, DUCKDB_WRITE_BATCH_MAX_AGE_MS)
    assertEquals(DUCKDB_WRITE_BATCH_MAX_AGE_MS, 5_000)

    fireFlush!()
    await store.flushWrites()
  } finally {
    await store.close()
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('close() persists pending batched writes (graceful shutdown)', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-shutdown-' })
  try {
    // Default batching — one accepted sample sits in the pending buffer
    // (below the row threshold, age timer not yet fired) when close() runs.
    const first = new DuckDbParquetServerMetricsStore({ metricsDir })
    await first.writeSample(sampleV4({ atMs: DAY_START + 60_000, cpuBusyPercent: 10 }))
    await first.close()

    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
    try {
      assertEquals(await rowCount(handle.connection, HOST_SAMPLES_TABLE), 1)
    } finally {
      handle.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('daily archive seals every family independently into its own Parquet subdir', async () => {
  await withStore(async (store) => {
    const yesterday = DAY_START - MS_PER_DAY
    await store.writeSample(
      sampleV4({
        atMs: yesterday + 60_000,
        cpuBusyPercent: 10,
        gpuCount: 2,
        events: [
          {
            eventId: 'evt-1',
            at: new Date(yesterday + 60_000).toISOString(),
            kind: 'oom_kill',
            severity: 'critical',
          },
        ],
      })
    )

    await store.runDailyArchiveOnce(DAY_START + 3600_000)

    for (const subdir of ['host', 'gpu', 'events']) {
      const partition = partitionFileForDay(store.paths.parquetRoot, subdir, yesterday)
      assertExists(await Deno.stat(partition))
    }

    const handle = await openDuckDb({
      paths: resolveDuckDbPaths(store.paths.metricsDir),
    })
    try {
      assertEquals(await rowCount(handle.connection, HOST_SAMPLES_TABLE), 0)
      assertEquals(await rowCount(handle.connection, GPU_SAMPLES_TABLE), 0)
      assertEquals(await rowCount(handle.connection, METRIC_EVENTS_TABLE), 0)
    } finally {
      handle.close()
    }
  })
})

it('retention prunes rows and partitions older than retentionDays across every family', async () => {
  await withStore(
    async (store) => {
      const oldDay = DAY_START - 10 * MS_PER_DAY
      const yesterday = DAY_START - MS_PER_DAY
      await store.writeSample(sampleV4({ atMs: oldDay + 60_000, cpuBusyPercent: 10, gpuCount: 1 }))
      await store.writeSample(sampleV4({ atMs: yesterday + 3600_000, cpuBusyPercent: 20 }))

      await store.runDailyArchiveOnce(DAY_START + 3600_000)

      const handle = await openDuckDb({
        paths: resolveDuckDbPaths(store.paths.metricsDir),
      })
      try {
        // Both completed days were sealed to Parquet — nothing stays hot.
        assertEquals(await rowCount(handle.connection, HOST_SAMPLES_TABLE), 0)
        assertEquals(await rowCount(handle.connection, GPU_SAMPLES_TABLE), 0)
      } finally {
        handle.close()
      }
      let oldPartitionExists = true
      try {
        await Deno.stat(partitionFileForDay(store.paths.parquetRoot, 'host', oldDay))
      } catch {
        oldPartitionExists = false
      }
      // 10-day-old partition is outside the 2-day retention window.
      assertEquals(oldPartitionExists, false)

      // Yesterday's partition (1 day old) survives the 2-day retention.
      const survivingPartition = partitionFileForDay(store.paths.parquetRoot, 'host', yesterday)
      assertExists(await Deno.stat(survivingPartition))
      const survivingHandle = await openDuckDb({
        paths: resolveDuckDbPaths(store.paths.metricsDir),
      })
      try {
        const reader = await survivingHandle.connection.runAndReadAll(
          `SELECT cpu_busy_percent FROM read_parquet('${survivingPartition}')`
        )
        assertEquals(
          reader.getRowObjectsJS().map((row) => row.cpu_busy_percent),
          [20]
        )
      } finally {
        survivingHandle.close()
      }
    },
    { retentionDays: 2 }
  )
})

it('late sample for an already archived day merges on the next archive tick', async () => {
  await withStore(async (store) => {
    const yesterday = DAY_START - MS_PER_DAY
    await store.writeSample(sampleV4({ atMs: yesterday + 60_000, cpuBusyPercent: 10 }))
    await store.runDailyArchiveOnce(DAY_START + 3600_000)

    // Late arrival for the already sealed day, then a second archive pass.
    await store.writeSample(sampleV4({ atMs: yesterday + 120_000, cpuBusyPercent: 20 }))
    await store.runDailyArchiveOnce(DAY_START + 7200_000)

    const partition = partitionFileForDay(store.paths.parquetRoot, 'host', yesterday)
    const handle = await openDuckDb({
      paths: resolveDuckDbPaths(store.paths.metricsDir),
    })
    try {
      assertEquals(await rowCount(handle.connection, HOST_SAMPLES_TABLE), 0)
      const reader = await handle.connection.runAndReadAll(
        `SELECT cpu_busy_percent FROM read_parquet('${partition}') ORDER BY sampled_at`
      )
      assertEquals(
        reader.getRowObjectsJS().map((row) => row.cpu_busy_percent),
        [10, 20]
      )
    } finally {
      handle.close()
    }
  })
})

it('status history: prior state + in-range transitions + uptime math (queryStatusHistory parity)', async () => {
  await withStore(async (store) => {
    const from = DAY_START
    const to = DAY_START + 3600_000
    await store.writeStatusEvent(statusEvent({ atMs: from - 600_000, connected: false }))
    await store.writeStatusEvent(statusEvent({ atMs: from + 600_000, connected: true }))
    await store.writeStatusEvent(
      statusEvent({
        atMs: from + 1800_000,
        connected: false,
        reason: 'sweep_stale',
      })
    )

    const history = await store.queryStatusHistory!({
      serverId: SERVER_A,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    })
    assertEquals(history.kind, 'duckdb')
    assertEquals(history.initialConnected, false)
    assertEquals(history.events.length, 2)
    assertEquals(history.events[0]!.connected, true)
    assertEquals(history.events[1]!.reason, 'sweep_stale')
    assertEquals(history.truncated, false)
    // down 10 min, up 20 min, down 40 min.
    assertEquals(history.uptimeSeconds, 1200)
    assertEquals(history.downtimeSeconds, 2400)
    assertEquals(history.unknownSeconds, 0)
  })
})

it('half-open range: a status event exactly at `to` is excluded', async () => {
  await withStore(async (store) => {
    const from = DAY_START
    const to = DAY_START + 600_000
    await store.writeStatusEvent(statusEvent({ atMs: from + 60_000, connected: true }))
    await store.writeStatusEvent(statusEvent({ atMs: to, connected: false }))

    const history = await store.queryStatusHistory!({
      serverId: SERVER_A,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    })
    assertEquals(history.events.length, 1)
    assertEquals(history.events[0]!.connected, true)
  })
})

it('resource caps default to threads=2 / memory_limit=128MiB (duckdb_settings)', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-caps-def-' })
  try {
    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
    try {
      const reader = await handle.connection.runAndReadAll(
        'SELECT name, value FROM duckdb_settings() ' + "WHERE name IN ('threads', 'memory_limit')"
      )
      const settings = new Map(
        reader.getRowObjectsJS().map((row) => [String(row.name), String(row.value)])
      )
      assertEquals(settings.get('threads'), '2')
      assertEquals(settings.get('memory_limit')?.includes('128'), true)
    } finally {
      handle.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('stray tmp export from a crash is swept and never double-deletes hot rows', async () => {
  await withStore(async (store) => {
    const yesterday = DAY_START - MS_PER_DAY
    await store.writeSample(sampleV4({ atMs: yesterday + 60_000, cpuBusyPercent: 10 }))
    const strayPath = `${store.paths.tmpDir}/host-crashed.parquet`
    await Deno.writeTextFile(strayPath, 'interrupted export')

    await store.runDailyArchiveOnce(DAY_START + 3600_000)

    let strayExists = true
    try {
      await Deno.stat(strayPath)
    } catch {
      strayExists = false
    }
    assertEquals(strayExists, false)

    const handle = await openDuckDb({
      paths: resolveDuckDbPaths(store.paths.metricsDir),
    })
    try {
      assertEquals(await rowCount(handle.connection, HOST_SAMPLES_TABLE), 0)
    } finally {
      handle.close()
    }
  })
})

// ---------------------------------------------------------------------------
// v4-native read path: queryHostSeries / queryHostSummary /
// queryFleetHostSnapshot / queryEntitySeries / queryEntityIdsSeen /
// queryMetricEvents.
// ---------------------------------------------------------------------------

it('v4 queryHostSeries: weighted-average math, real NULL for an unpopulated metric, mixed-generation bucket is null, generations union sorted', async () => {
  await withStore(async (store) => {
    await store.writeSample(
      sampleV4({
        atMs: DAY_START,
        intervalSeconds: 60,
        cpuBusyPercent: 10,
        topologyGeneration: 1,
      })
    )
    await store.writeSample(
      sampleV4({
        atMs: DAY_START + 300_000,
        sequence: 2,
        intervalSeconds: 60,
        cpuBusyPercent: 30,
        topologyGeneration: 2,
      })
    )

    const result = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ['host.cpu.busyPercent', 'host.memory.availableBytes'],
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
      resolutionSeconds: 600,
    })

    assertEquals(result.kind, 'duckdb')
    assertEquals(result.points.length, 1)
    const point = result.points[0]!
    // interval-weighted average: (10*60 + 30*60) / (60 + 60) = 20.
    assertEquals(point.values['host.cpu.busyPercent'], 20)
    // Never populated by either sample in range — real SQL NULL.
    assertEquals(point.values['host.memory.availableBytes'], null)
    // Bucket spans two topology generations — null, never a fabricated single value.
    assertEquals(point.topologyGeneration, null)
    assertEquals(result.topologyGenerations, [1, 2])
    assertEquals(result.sampleCount, 2)
  })
})

it("v4 queryHostSeries: topologyGeneration is the shared generation when a bucket's samples agree", async () => {
  await withStore(async (store) => {
    await store.writeSample(
      sampleV4({
        atMs: DAY_START,
        cpuBusyPercent: 10,
        topologyGeneration: 3,
      })
    )
    await store.writeSample(
      sampleV4({
        atMs: DAY_START + 60_000,
        sequence: 2,
        cpuBusyPercent: 20,
        topologyGeneration: 3,
      })
    )

    const result = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ['host.cpu.busyPercent'],
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 300_000).toISOString(),
      resolutionSeconds: 300,
    })

    assertEquals(result.points.length, 1)
    assertEquals(result.points[0]!.topologyGeneration, 3)
    assertEquals(result.topologyGenerations, [3])
  })
})

it("v4 queryHostSeries: cpuDetail.* fields resolve from the host row's cpu_detail_* columns, and requesting one attaches cpuHotspots", async () => {
  await withStore(async (store) => {
    await store.writeSample(sampleV4({ atMs: DAY_START, cpuDetail: CPU_DETAIL_FIXTURE }))

    const result = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ['cpuDetail.averageFrequencyMHz', 'cpuDetail.cpuIrqPercent'],
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
      resolutionSeconds: 600,
    })

    assertEquals(result.points.length, 1)
    const point = result.points[0]!
    assertEquals(point.values['cpuDetail.averageFrequencyMHz'], 3200)
    assertEquals(point.values['cpuDetail.cpuIrqPercent'], 2.5)
    assertExists(point.cpuHotspots)
    assertEquals(
      [...point.cpuHotspots!].map((h) => h.coreId).sort(),
      CPU_DETAIL_FIXTURE.hotspots.map((h) => h.coreId).sort()
    )
    const cpu0 = point.cpuHotspots!.find((h) => h.coreId === 'cpu0')!
    assertEquals(cpu0.values.busyPercent, 91)
  })
})

it('v4 queryHostSeries: a request with no cpuDetail.* field never attaches cpuHotspots', async () => {
  await withStore(async (store) => {
    await store.writeSample(sampleV4({ atMs: DAY_START, cpuDetail: CPU_DETAIL_FIXTURE }))

    const result = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ['host.cpu.busyPercent'],
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
      resolutionSeconds: 600,
    })

    assertEquals(result.points.length, 1)
    assertEquals(result.points[0]!.cpuHotspots, undefined)
  })
})

it('v4 queryHostSeries: memoryDetail.* fields resolve via the left-joined memory-detail table, real NULL for a bucket sample missing memoryDetail', async () => {
  await withStore(async (store) => {
    await store.writeSample(
      sampleV4({
        atMs: DAY_START,
        memoryDetail: MEMORY_DETAIL_FIXTURE,
      })
    )
    await store.writeSample(
      sampleV4({
        // No memoryDetail this tick — the left join must not drop the host row.
        atMs: DAY_START + 60_000,
        sequence: 2,
      })
    )

    const result = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: ['memoryDetail.memoryFreeBytes', 'memoryDetail.pageScanDirectPerSecond'],
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
      resolutionSeconds: 600,
    })

    assertEquals(result.points.length, 1)
    const point = result.points[0]!
    // Only one of the two rows in the bucket carries a memoryDetail row —
    // the weighted average/last-value aggregates ignore the NULL row rather
    // than averaging it in as 0.
    assertEquals(
      point.values['memoryDetail.memoryFreeBytes'],
      MEMORY_DETAIL_FIXTURE.memoryFreeBytes
    )
    assertEquals(
      point.values['memoryDetail.pageScanDirectPerSecond'],
      MEMORY_DETAIL_FIXTURE.pageScanDirectPerSecond
    )
    // sample_count/topologyGeneration still reflect both host rows, not just the joined one.
    assertEquals(result.sampleCount, 2)
  })
})

it('v4 queryHostSeries: combining host.*, cpuDetail.*, and memoryDetail.* selectors in one request resolves all three', async () => {
  await withStore(async (store) => {
    await store.writeSample(
      sampleV4({
        atMs: DAY_START,
        cpuBusyPercent: 42,
        cpuDetail: CPU_DETAIL_FIXTURE,
        memoryDetail: MEMORY_DETAIL_FIXTURE,
      })
    )

    const result = await store.queryHostSeries({
      serverId: SERVER_A,
      metrics: [
        'host.cpu.busyPercent',
        'cpuDetail.averageFrequencyMHz',
        'memoryDetail.memoryFreeBytes',
      ],
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
      resolutionSeconds: 600,
    })

    assertEquals(result.points.length, 1)
    const point = result.points[0]!
    assertEquals(point.values['host.cpu.busyPercent'], 42)
    assertEquals(point.values['cpuDetail.averageFrequencyMHz'], 3200)
    assertEquals(
      point.values['memoryDetail.memoryFreeBytes'],
      MEMORY_DETAIL_FIXTURE.memoryFreeBytes
    )
  })
})

it('v4 queryHostSummary: sample count + latestAt, zero samples means null latestAt', async () => {
  await withStore(async (store) => {
    const from = DAY_START
    const to = DAY_START + 600_000

    const empty = await store.queryHostSummary({
      serverId: SERVER_A,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    })
    assertEquals(empty.sampleCount, 0)
    assertEquals(empty.latestAt, null)

    await store.writeSample(sampleV4({ atMs: from + 60_000, cpuBusyPercent: 10 }))
    await store.writeSample(sampleV4({ atMs: from + 120_000, sequence: 2, cpuBusyPercent: 20 }))

    const summary = await store.queryHostSummary({
      serverId: SERVER_A,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    })
    assertEquals(summary.sampleCount, 2)
    assertEquals(summary.latestAt, new Date(from + 120_000).toISOString())
  })
})

it('v4 queryFleetHostSnapshot: multiple servers, values map, a requested-but-absent server is excluded', async () => {
  await withStore(async (store) => {
    const serverB = '22222222-3333-4444-8555-666666666666'
    const serverC = '33333333-4444-5555-8666-777777777777'
    await store.writeSample(sampleV4({ serverId: SERVER_A, atMs: DAY_START, cpuBusyPercent: 10 }))
    await store.writeSample(sampleV4({ serverId: serverB, atMs: DAY_START, cpuBusyPercent: 50 }))

    const result = await store.queryFleetHostSnapshot({
      serverIds: [SERVER_A, serverB, serverC],
      metrics: ['host.cpu.busyPercent'],
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
    })

    assertEquals(result.servers.length, 2)
    const byId = new Map(result.servers.map((s) => [s.serverId, s]))
    assertEquals(byId.get(SERVER_A)?.values['host.cpu.busyPercent'], 10)
    assertEquals(byId.get(serverB)?.values['host.cpu.busyPercent'], 50)
    assertEquals(byId.has(serverC), false)
  })
})

it('v4 queryEntitySeries: network family — per-entity buckets, missing entity gets empty points + full gap, unpopulated metric is real NULL', async () => {
  await withStore(async (store) => {
    const from = DAY_START
    const to = DAY_START + 600_000
    const networkRow = (deviceId: string, rx: number): NetworkDeviceSampleV4 => ({
      deviceId,
      receiveBytesPerSecond: rx,
      transmitBytesPerSecond: null,
      receiveErrorsPerSecond: null,
      transmitErrorsPerSecond: null,
      receiveDropsPerSecond: null,
      transmitDropsPerSecond: null,
    })
    await store.writeSample(
      sampleV4({
        atMs: from + 60_000,
        networks: [networkRow('eth0', 100), networkRow('eth1', 200)],
      })
    )

    const result = await store.queryEntitySeries({
      serverId: SERVER_A,
      family: 'network',
      entityIds: ['eth0', 'eth1', 'eth2'],
      metrics: ['receiveBytesPerSecond', 'transmitBytesPerSecond'],
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      resolutionSeconds: 300,
    })

    assertEquals(result.entities.length, 3)
    const byId = new Map(result.entities.map((e) => [e.entityId, e]))
    const eth0 = byId.get('eth0')!
    assertEquals(eth0.points.length, 1)
    assertEquals(eth0.points[0]!.values.receiveBytesPerSecond, 100)
    // Never reported by any row in range — real SQL NULL.
    assertEquals(eth0.points[0]!.values.transmitBytesPerSecond, null)
    assertEquals(eth0.sampleCount, 1)

    const eth2 = byId.get('eth2')!
    assertEquals(eth2.points.length, 0)
    assertEquals(eth2.sampleCount, 0)
    assertEquals(eth2.gapCount > 0, true)
  })
})

it('v4 queryEntitySeries: managed.ingress groups by source_id, keeping distinct sources of the same source_kind separate', async () => {
  await withStore(async (store) => {
    const from = DAY_START
    const to = DAY_START + 600_000
    const ingressRow = (sourceId: string, rps: number): IngressSourceSampleV4 => ({
      sourceId,
      sourceKind: 'caddy',
      requests: rps,
      responses2xx: null,
      responses3xx: null,
      responses4xx: null,
      responses5xx: null,
      requestErrors: null,
      requestBytes: null,
      responseBytes: null,
      requestDurationSecondsAvg: null,
      requestsUnder100ms: null,
      requestsUnder500ms: null,
      requestsUnder1s: null,
      requestsUnder5s: null,
      requestsInFlight: null,
      upstreamsHealthy: null,
      upstreamsTotal: null,
      retries: null,
    })
    await store.writeSample(
      sampleV4({
        atMs: from + 60_000,
        ingressSources: [ingressRow('caddy-1', 10), ingressRow('caddy-2', 30)],
      })
    )

    const result = await store.queryEntitySeries({
      serverId: SERVER_A,
      family: 'managed.ingress',
      entityIds: ['caddy-1', 'caddy-2'],
      metrics: ['requests'],
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      resolutionSeconds: 300,
    })

    assertEquals(result.entities.length, 2)
    const caddy1 = result.entities.find((entity) => entity.entityId === 'caddy-1')!
    assertEquals(caddy1.sampleCount, 1)
    assertEquals(caddy1.points.length, 1)
    assertEquals(caddy1.points[0]!.values.requests, 10)
    const caddy2 = result.entities.find((entity) => entity.entityId === 'caddy-2')!
    assertEquals(caddy2.sampleCount, 1)
    assertEquals(caddy2.points.length, 1)
    assertEquals(caddy2.points[0]!.values.requests, 30)
  })
})

it('v4 queryEntityIdsSeen: returns exactly the observed entity ids for a per-device family', async () => {
  await withStore(async (store) => {
    const networkRow = (deviceId: string): NetworkDeviceSampleV4 => ({
      deviceId,
      receiveBytesPerSecond: 1,
      transmitBytesPerSecond: null,
      receiveErrorsPerSecond: null,
      transmitErrorsPerSecond: null,
      receiveDropsPerSecond: null,
      transmitDropsPerSecond: null,
    })
    await store.writeSample(
      sampleV4({
        atMs: DAY_START + 60_000,
        networks: [networkRow('eth0'), networkRow('eth1')],
      })
    )

    const result = await store.queryEntityIdsSeen({
      serverId: SERVER_A,
      family: 'network',
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
    })
    assertEquals(result.entityIds.slice().sort(), ['eth0', 'eth1'])
  })
})

it('v4 queryEntityIdsSeen: managed.database_proxy returns source_id values, keeping distinct sources of the same source_kind separate', async () => {
  await withStore(async (store) => {
    const proxyRow = (sourceId: string, sourceKind: string): DatabaseProxySampleV4 => ({
      sourceId,
      sourceKind,
      queries: 1,
      slowQueries: null,
      connectionErrors: null,
      clientConnections: null,
      backendConnections: null,
      backendsUp: null,
    })
    await store.writeSample(
      sampleV4({
        atMs: DAY_START + 60_000,
        databaseProxies: [proxyRow('proxysql-1', 'proxysql'), proxyRow('proxysql-2', 'proxysql')],
      })
    )

    const result = await store.queryEntityIdsSeen({
      serverId: SERVER_A,
      family: 'managed.database_proxy',
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
    })
    assertEquals(result.entityIds.slice().sort(), ['proxysql-1', 'proxysql-2'])
  })
})

it('v4 queryMetricEvents: parses entityId/source/payload when present and omits them entirely when absent', async () => {
  await withStore(async (store) => {
    await store.writeSample(
      sampleV4({
        atMs: DAY_START + 60_000,
        events: [
          {
            eventId: 'evt-full',
            at: new Date(DAY_START + 60_000).toISOString(),
            kind: 'oom_kill',
            severity: 'critical',
            entityId: 'proc-1',
            source: 'kernel',
            payload: { pid: 42, killed: true },
          },
          {
            eventId: 'evt-bare',
            at: new Date(DAY_START + 120_000).toISOString(),
            kind: 'nic_link_down',
            severity: 'warning',
          },
        ],
      })
    )

    const result = await store.queryMetricEvents({
      serverId: SERVER_A,
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + 600_000).toISOString(),
    })

    assertEquals(result.truncated, false)
    assertEquals(result.events.length, 2)
    const full = result.events.find((e) => e.eventId === 'evt-full')!
    assertEquals(full.entityId, 'proc-1')
    assertEquals(full.source, 'kernel')
    assertEquals(full.payload, { pid: 42, killed: true })

    const bare = result.events.find((e) => e.eventId === 'evt-bare')!
    assertEquals('entityId' in bare, false)
    assertEquals('source' in bare, false)
    assertEquals('payload' in bare, false)
  })
})

it('v4 queryMetricEvents: truncates at MAX_STATUS_EVENTS and reports truncated: true', async () => {
  await withStore(async (store) => {
    const total = MAX_STATUS_EVENTS + 1
    const allEvents: MetricEventV4[] = Array.from({ length: total }, (_, i) => ({
      eventId: `evt-${i}`,
      at: new Date(DAY_START + i * 1000).toISOString(),
      kind: 'oom_kill',
      severity: 'info',
    }))
    // `buildMetricsSampleV4` caps events per sample at 128 — split across
    // several `writeSample` calls (each call still fans its own events out
    // inside a single transaction; the cap is per-sample, not per-store).
    const CHUNK = 100
    for (let offset = 0; offset < allEvents.length; offset += CHUNK) {
      const chunk = allEvents.slice(offset, offset + CHUNK)
      await store.writeSample(
        sampleV4({
          atMs: DAY_START + offset * 1000,
          sequence: offset + 1,
          events: chunk,
        })
      )
    }

    const result = await store.queryMetricEvents({
      serverId: SERVER_A,
      from: new Date(DAY_START).toISOString(),
      to: new Date(DAY_START + total * 1000 + 60_000).toISOString(),
    })

    assertEquals(result.truncated, true)
    assertEquals(result.events.length, MAX_STATUS_EVENTS)
    assertEquals(result.events[0]!.eventId, 'evt-0')
  })
})

const CPU_DETAIL_FIXTURE: CpuDetailSampleV4 = {
  hotspots: [
    { coreId: 'cpu0', busyPercent: 91, iowaitPercent: 1, stealPercent: 0 },
    { coreId: 'cpu1', busyPercent: 88, iowaitPercent: 2, stealPercent: 0 },
    { coreId: 'cpu2', busyPercent: 80, iowaitPercent: 0, stealPercent: 1 },
    { coreId: 'cpu3', busyPercent: 77, iowaitPercent: 0, stealPercent: 0 },
  ],
  averageFrequencyMHz: 3200,
  minimumFrequencyMHz: 800,
  maximumFrequencyMHz: 4500,
  contextSwitchesPerSecond: 12000,
  interruptsPerSecond: 4000,
  forksPerSecond: 15,
  cpuIrqPercent: 2.5,
}

const MEMORY_DETAIL_FIXTURE: MemoryDetailSampleV4 = {
  memoryFreeBytes: 1_000_000,
  cachedBytes: 2_000_000,
  anonPagesBytes: 3_000_000,
  slabReclaimableBytes: 400_000,
  slabUnreclaimableBytes: 100_000,
  dirtyBytes: 5000,
  writebackBytes: 0,
  shmemBytes: 60_000,
  pageTablesBytes: 70_000,
  kernelStackBytes: 8000,
  committedAsBytes: 9_000_000,
  commitLimitBytes: 16_000_000,
  activeAnonBytes: 2_500_000,
  inactiveAnonBytes: 500_000,
  activeFileBytes: 1_500_000,
  inactiveFileBytes: 500_000,
  pageScanDirectPerSecond: 10,
  pageScanKswapdPerSecond: 5,
  compactionStallsPerSecond: 1,
}

function cpuCoreLiveFixture(count: number): CpuCoreLiveSampleV4[] {
  return Array.from({ length: count }, (_, i) => ({
    coreId: `cpu${i}`,
    busyPercent: 10 + i,
    iowaitPercent: 1,
    stealPercent: 0,
  }))
}

it("writeSample fans cpuDetail into the host row's cpu_detail_* columns and 4 rows into server_cpu_hotspot_samples", async () => {
  await withStore(async (store, metricsDir) => {
    await store.writeSample(sampleV4({ atMs: DAY_START, cpuDetail: CPU_DETAIL_FIXTURE }))
    await store.close()

    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
    try {
      const hostReader = await handle.connection.runAndReadAll(
        `SELECT cpu_detail_average_frequency_m_hz, cpu_detail_cpu_irq_percent, ` +
          `cpu_detail_context_switches_per_second FROM ${HOST_SAMPLES_TABLE}`
      )
      const hostRow = hostReader.getRowObjectsJS()[0]!
      assertEquals(hostRow.cpu_detail_average_frequency_m_hz, 3200)
      assertEquals(hostRow.cpu_detail_cpu_irq_percent, 2.5)
      assertEquals(hostRow.cpu_detail_context_switches_per_second, 12000)

      assertEquals(await rowCount(handle.connection, CPU_HOTSPOT_SAMPLES_TABLE), 4)
      const hotspotReader = await handle.connection.runAndReadAll(
        `SELECT core_id, busy_percent FROM ${CPU_HOTSPOT_SAMPLES_TABLE} ORDER BY core_id`
      )
      const hotspotRows = hotspotReader.getRowObjectsJS()
      assertEquals(
        hotspotRows.map((r) => r.core_id),
        ['cpu0', 'cpu1', 'cpu2', 'cpu3']
      )
      assertEquals(hotspotRows[0]!.busy_percent, 91)
    } finally {
      handle.close()
    }
  })
})

it("writeSample without cpuDetail leaves the host row's cpu_detail_* columns real NULL and writes no hotspot rows", async () => {
  await withStore(async (store, metricsDir) => {
    await store.writeSample(sampleV4({ atMs: DAY_START, cpuBusyPercent: 5 }))
    await store.close()

    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
    try {
      const hostReader = await handle.connection.runAndReadAll(
        `SELECT cpu_detail_average_frequency_m_hz FROM ${HOST_SAMPLES_TABLE}`
      )
      assertEquals(hostReader.getRowObjectsJS()[0]!.cpu_detail_average_frequency_m_hz, null)
      assertEquals(await rowCount(handle.connection, CPU_HOTSPOT_SAMPLES_TABLE), 0)
    } finally {
      handle.close()
    }
  })
})

it('writeSample fans memoryDetail into a single server_memory_detail_samples row (19 real fields, no row when absent)', async () => {
  await withStore(async (store, metricsDir) => {
    await store.writeSample(sampleV4({ atMs: DAY_START, memoryDetail: MEMORY_DETAIL_FIXTURE }))
    await store.close()

    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
    try {
      assertEquals(await rowCount(handle.connection, MEMORY_DETAIL_SAMPLES_TABLE), 1)
      const reader = await handle.connection.runAndReadAll(
        `SELECT memory_free_bytes, compaction_stalls_per_second FROM ${MEMORY_DETAIL_SAMPLES_TABLE}`
      )
      const row = reader.getRowObjectsJS()[0]!
      assertEquals(row.memory_free_bytes, 1_000_000)
      assertEquals(row.compaction_stalls_per_second, 1)
    } finally {
      handle.close()
    }
  })

  await withStore(async (store, metricsDir) => {
    await store.writeSample(sampleV4({ atMs: DAY_START, cpuBusyPercent: 5 }))
    await store.close()
    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
    try {
      assertEquals(await rowCount(handle.connection, MEMORY_DETAIL_SAMPLES_TABLE), 0)
    } finally {
      handle.close()
    }
  })
})

it('daily archive seals cpu-hotspot / cpu-core-live / memory-detail families into their own Parquet subdirs', async () => {
  await withStore(async (store) => {
    const yesterday = DAY_START - MS_PER_DAY
    await store.writeSample(
      sampleV4({
        atMs: yesterday + 60_000,
        cpuDetail: CPU_DETAIL_FIXTURE,
        memoryDetail: MEMORY_DETAIL_FIXTURE,
        collectionMode: 'live',
        cpuCoreLive: cpuCoreLiveFixture(4),
      })
    )

    await store.runDailyArchiveOnce(DAY_START + 3600_000)

    for (const subdir of ['cpu-hotspot', 'cpu-core-live', 'memory-detail']) {
      const partition = partitionFileForDay(store.paths.parquetRoot, subdir, yesterday)
      assertExists(await Deno.stat(partition))
    }

    const handle = await openDuckDb({
      paths: resolveDuckDbPaths(store.paths.metricsDir),
    })
    try {
      assertEquals(await rowCount(handle.connection, CPU_HOTSPOT_SAMPLES_TABLE), 0)
      assertEquals(await rowCount(handle.connection, CPU_CORE_SAMPLES_TABLE), 0)
      assertEquals(await rowCount(handle.connection, MEMORY_DETAIL_SAMPLES_TABLE), 0)
    } finally {
      handle.close()
    }
  })
})

it('writeSample fans cpuCoreLive into N server_cpu_core_samples rows only when present (live sessions)', async () => {
  await withStore(async (store, metricsDir) => {
    await store.writeSample(
      sampleV4({
        atMs: DAY_START,
        collectionMode: 'live',
        cpuCoreLive: cpuCoreLiveFixture(8),
      })
    )
    await store.close()

    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
    try {
      assertEquals(await rowCount(handle.connection, CPU_CORE_SAMPLES_TABLE), 8)
      const reader = await handle.connection.runAndReadAll(
        `SELECT core_id, busy_percent FROM ${CPU_CORE_SAMPLES_TABLE} ORDER BY core_id`
      )
      assertEquals(reader.getRowObjectsJS()[0]!.core_id, 'cpu0')
    } finally {
      handle.close()
    }
  })

  await withStore(async (store, metricsDir) => {
    await store.writeSample(sampleV4({ atMs: DAY_START, cpuBusyPercent: 5 }))
    await store.close()
    const handle = await openDuckDb({ paths: resolveDuckDbPaths(metricsDir) })
    try {
      assertEquals(await rowCount(handle.connection, CPU_CORE_SAMPLES_TABLE), 0)
    } finally {
      handle.close()
    }
  })
})
