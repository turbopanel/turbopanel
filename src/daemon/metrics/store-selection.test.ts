import { assertEquals, assertInstanceOf, assertRejects, assertStringIncludes } from '@std/assert'
import { CloudflareAnalyticsEngineServerMetricsStoreV4 } from './backends/cloudflare/store-v4.ts'
import { AE_DEFAULT_MAX_RANGE_SECONDS } from './backends/cloudflare/sql-api-v4.ts'
import { DuckDbParquetServerMetricsStore } from './backends/duckdb/store.ts'
import { buildMetricsSampleV4 } from './contract-v4.ts'
import type { AuthenticatedMetricsSampleV4 } from './types-v4.ts'
import { DisabledServerMetricsStoreV4 } from './disabled-store-v4.ts'
import { it } from '@std/testing/bdd'
import {
  parseAnalyticsEngineMaxRangeSeconds,
  parseMetricsRetentionDays,
  resetMetricsStoreSelectionWarningsForTests,
  resolveCloudflareAnalyticsSqlConfig,
  resolveServerMetricsStoreV4,
  UnavailableServerMetricsStoreV4,
} from './store-selection.ts'

it('resolveServerMetricsStoreV4 workers + AE → AnalyticsEngine store', () => {
  resetMetricsStoreSelectionWarningsForTests()
  const store = resolveServerMetricsStoreV4({
    runtime: 'workers',
    analyticsEngine: { writeDataPoint() {} },
  })
  assertInstanceOf(store, CloudflareAnalyticsEngineServerMetricsStoreV4)
})

it('resolveServerMetricsStoreV4 workers without AE → unconfigured store', () => {
  resetMetricsStoreSelectionWarningsForTests()
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg))
  }
  try {
    const store = resolveServerMetricsStoreV4({
      runtime: 'workers',
    })
    assertInstanceOf(store, DisabledServerMetricsStoreV4)
    assertEquals(warnings.length, 1)
  } finally {
    console.warn = originalWarn
  }
})

it('resolveServerMetricsStoreV4 deno → DuckDB store', () => {
  resetMetricsStoreSelectionWarningsForTests()
  const metricsDir = Deno.makeTempDirSync({ prefix: 'tp-metrics-select-' })
  try {
    const store = resolveServerMetricsStoreV4({
      runtime: 'deno',
      duckdb: { metricsDir },
    })
    assertInstanceOf(store, DuckDbParquetServerMetricsStore)
  } finally {
    Deno.removeSync(metricsDir, { recursive: true })
  }
})

it('resolveServerMetricsStoreV4 deno construction failure → reads reject as unavailable', async () => {
  resetMetricsStoreSelectionWarningsForTests()
  // A regular file where the metrics directory should be makes mkdir fail.
  const blocker = Deno.makeTempFileSync({ prefix: 'tp-metrics-blocker-' })
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg))
  }
  try {
    const store = resolveServerMetricsStoreV4({
      runtime: 'deno',
      duckdb: { metricsDir: `${blocker}/metrics` },
    })
    // A real DuckDB outage must never degrade to the disabled store — reads
    // reject so metrics routes return 503 metrics_backend_unavailable.
    assertInstanceOf(store, UnavailableServerMetricsStoreV4)
    assertEquals(warnings.length, 1)
    assertStringIncludes(warnings[0]!, 'DuckDB store failed to open')

    const range = {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T01:00:00.000Z',
    }
    await assertRejects(
      () => store.queryHostSeries!({ serverId: 'srv-1', metrics: [], ...range }),
      Error,
      'DuckDB metrics store failed to open'
    )
    await assertRejects(
      () => store.queryHostSummary!({ serverId: 'srv-1', ...range }),
      Error,
      'DuckDB metrics store failed to open'
    )
    await assertRejects(
      () => store.queryStatusHistory!({ serverId: 'srv-1', ...range }),
      Error,
      'DuckDB metrics store failed to open'
    )
    await assertRejects(
      () =>
        store.queryFleetHostSnapshot!({
          serverIds: ['srv-1'],
          metrics: [],
          ...range,
        }),
      Error,
      'DuckDB metrics store failed to open'
    )

    // Writes stay fire-and-forget no-ops — never a throw into callers.
    store.writeStatusEvent({
      serverId: 'srv-1',
      connected: true,
      reason: 'connect',
      at: range.from,
    })
  } finally {
    console.warn = originalWarn
    Deno.removeSync(blocker)
  }
})

it('parseAnalyticsEngineMaxRangeSeconds accepts positive integers', () => {
  assertEquals(parseAnalyticsEngineMaxRangeSeconds('7776000'), 7_776_000)
  assertEquals(parseAnalyticsEngineMaxRangeSeconds(3600), 3600)
  assertEquals(parseAnalyticsEngineMaxRangeSeconds(''), undefined)
  assertEquals(parseAnalyticsEngineMaxRangeSeconds('0'), undefined)
  assertEquals(parseAnalyticsEngineMaxRangeSeconds('-1'), undefined)
  assertEquals(parseAnalyticsEngineMaxRangeSeconds('1.5'), undefined)
  assertEquals(parseAnalyticsEngineMaxRangeSeconds(undefined), undefined)
})

it('resolveCloudflareAnalyticsSqlConfig defaults maxRangeSeconds to AE retention', () => {
  const config = resolveCloudflareAnalyticsSqlConfig({
    CLOUDFLARE_ACCOUNT_ID: 'acct123',
    TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN: 'token-xyz',
  })
  assertEquals(config, {
    accountId: 'acct123',
    apiToken: 'token-xyz',
    maxRangeSeconds: AE_DEFAULT_MAX_RANGE_SECONDS,
  })
})

it('resolveCloudflareAnalyticsSqlConfig honors TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS', () => {
  const config = resolveCloudflareAnalyticsSqlConfig({
    CLOUDFLARE_ACCOUNT_ID: 'acct123',
    TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN: 'token-xyz',
    TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS: '3600',
  })
  assertEquals(config?.maxRangeSeconds, 3600)
})

it('resolveCloudflareAnalyticsSqlConfig returns null when credentials missing', () => {
  assertEquals(
    resolveCloudflareAnalyticsSqlConfig({
      CLOUDFLARE_ACCOUNT_ID: 'acct123',
    }),
    null
  )
  assertEquals(
    resolveCloudflareAnalyticsSqlConfig({
      TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN: 'token-xyz',
    }),
    null
  )
})

it('parseMetricsRetentionDays accepts positive integers only', () => {
  assertEquals(parseMetricsRetentionDays('90'), 90)
  assertEquals(parseMetricsRetentionDays(30), 30)
  assertEquals(parseMetricsRetentionDays(''), undefined)
  assertEquals(parseMetricsRetentionDays('bad'), undefined)
})

it('resolveServerMetricsStoreV4 deno DuckDB honors retentionDays override', () => {
  resetMetricsStoreSelectionWarningsForTests()
  const metricsDir = Deno.makeTempDirSync({ prefix: 'tp-metrics-retention-' })
  try {
    const store = resolveServerMetricsStoreV4({
      runtime: 'deno',
      duckdb: { metricsDir, retentionDays: 30 },
    })
    assertInstanceOf(store, DuckDbParquetServerMetricsStore)
  } finally {
    Deno.removeSync(metricsDir, { recursive: true })
  }
})

it('resolveServerMetricsStoreV4 warns only once per missing-backend key', () => {
  resetMetricsStoreSelectionWarningsForTests()
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg))
  }
  try {
    resolveServerMetricsStoreV4({ runtime: 'workers' })
    resolveServerMetricsStoreV4({ runtime: 'workers' })
    assertEquals(warnings.length, 1)
  } finally {
    console.warn = originalWarn
  }
})

const INTEGRATION_SERVER_ID = '11111111-2222-4333-8444-555555555555'

function buildV4HostSample(overrides: {
  atMs: number
  cpuUserPercent: number
  memoryAvailableBytes: number
}): AuthenticatedMetricsSampleV4 {
  const at = new Date(overrides.atMs).toISOString()
  const sample = buildMetricsSampleV4({
    metadata: {
      version: 4,
      sampledAt: at,
      intervalSeconds: 60,
      sequence: 1,
      collectionMode: 'baseline',
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: {
      cpu: {
        busyPercent: null,
        userPercent: overrides.cpuUserPercent,
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
        availableBytes: overrides.memoryAvailableBytes,
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
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
  })
  return { ...sample, serverId: INTEGRATION_SERVER_ID, receivedAt: at }
}

it('resolveServerMetricsStoreV4 deno: real v4 ingest lands data the series/summary/fleet-snapshot routes can read back', async () => {
  resetMetricsStoreSelectionWarningsForTests()
  const metricsDir = Deno.makeTempDirSync({
    prefix: 'tp-metrics-integration-',
  })
  let store: DuckDbParquetServerMetricsStore | undefined
  try {
    const resolved = resolveServerMetricsStoreV4({
      runtime: 'deno',
      duckdb: { metricsDir },
    })
    assertInstanceOf(resolved, DuckDbParquetServerMetricsStore)
    store = resolved

    const sampledAtMs = Date.UTC(2026, 5, 2, 12, 0, 0)
    // The real Deno ingest write path (`POST /api/daemon/v1/metrics` calls
    // this on `serverMetricsStoreV4` directly).
    await store.writeSample(
      buildV4HostSample({
        atMs: sampledAtMs,
        cpuUserPercent: 12.5,
        memoryAvailableBytes: 1_000_000,
      })
    )

    const range = {
      from: new Date(sampledAtMs - 60_000).toISOString(),
      to: new Date(sampledAtMs + 60_000).toISOString(),
    }

    // `/servers/:id/metrics/series`
    const series = await store.queryHostSeries!({
      serverId: INTEGRATION_SERVER_ID,
      metrics: ['host.cpu.userPercent'],
      ...range,
    })
    assertEquals(series.available, true)
    assertEquals(series.points.length, 1)
    assertEquals(series.points[0]?.values['host.cpu.userPercent'], 12.5)

    // `/servers/:id/metrics/summary`
    const summary = await store.queryHostSummary!({
      serverId: INTEGRATION_SERVER_ID,
      ...range,
    })
    assertEquals(summary.sampleCount, 1)
    assertEquals(summary.latestAt, new Date(sampledAtMs).toISOString())

    // `/servers/metrics/latest`
    const fleet = await store.queryFleetHostSnapshot!({
      serverIds: [INTEGRATION_SERVER_ID],
      metrics: ['host.cpu.userPercent', 'host.memory.availableBytes'],
      ...range,
    })
    assertEquals(fleet.servers.length, 1)
    assertEquals(fleet.servers[0]?.values['host.cpu.userPercent'], 12.5)
    assertEquals(fleet.servers[0]?.values['host.memory.availableBytes'], 1_000_000)
  } finally {
    await store?.close()
    Deno.removeSync(metricsDir, { recursive: true })
  }
})
