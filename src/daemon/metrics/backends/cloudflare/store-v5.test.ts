import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSampleV5, type MetricsSampleV5Input } from '../../contract-v5.ts'
import type { AuthenticatedMetricsSampleV5, SlotMapping } from '../../types-v5.ts'
import { buildMetricsDataPointsV5, buildStatusDataPointV5 } from './field-map-v5.ts'
import {
  type AnalyticsEngineDatasetLike,
  CloudflareAnalyticsEngineServerMetricsStoreV5,
} from './store-v5.ts'

function zeroFields(fields: readonly string[]): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const field of fields) out[field] = null
  return out
}

const HOST_CPU_FIELDS = [
  'busyPercent',
  'userPercent',
  'systemPercent',
  'iowaitPercent',
  'stealPercent',
  'softirqPercent',
  'pressureSomePercent',
  'maxCoreBusyPercent',
  'procsRunning',
  'procsBlocked',
  'processCount',
]
const HOST_KERNEL_FIELDS = ['fileHandlesUsedPercent', 'conntrackUsedPercent']
const HOST_MEMORY_FIELDS = [
  'availableBytes',
  'swapUsedBytes',
  'pressureSomePercent',
  'pressureFullPercent',
  'swapInBytesPerSecond',
  'swapOutBytesPerSecond',
  'majorPageFaultsPerSecond',
]
const HOST_STORAGE_FIELDS = [
  'ioPressureSomePercent',
  'ioPressureFullPercent',
  'diskReadBytesPerSecond',
  'diskWriteBytesPerSecond',
  'diskReadLatencyMs',
  'diskWriteLatencyMs',
  'maxBlockDeviceUtilPercent',
  'rootFilesystemAvailableBytes',
  'rootFilesystemFreeInodes',
]
const HOST_NETWORK_FIELDS = ['tcpRetransmitPercent', 'softnetDropsPerSecond']

function baseInput(overrides: Partial<MetricsSampleV5Input> = {}): MetricsSampleV5Input {
  return {
    metadata: {
      version: 5,
      sampledAt: '2026-01-01T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 1,
      collectionMode: 'baseline',
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: {
      cpu: zeroFields(HOST_CPU_FIELDS) as MetricsSampleV5Input['host']['cpu'],
      kernel: zeroFields(HOST_KERNEL_FIELDS) as MetricsSampleV5Input['host']['kernel'],
      memory: zeroFields(HOST_MEMORY_FIELDS) as MetricsSampleV5Input['host']['memory'],
      storage: zeroFields(HOST_STORAGE_FIELDS) as MetricsSampleV5Input['host']['storage'],
      network: zeroFields(HOST_NETWORK_FIELDS) as MetricsSampleV5Input['host']['network'],
    },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
    ...overrides,
  }
}

function buildSample(overrides: Partial<MetricsSampleV5Input> = {}): AuthenticatedMetricsSampleV5 {
  const built = buildMetricsSampleV5(baseInput(overrides))
  return {
    ...built,
    serverId: '11111111-2222-4333-8444-555555555555',
    receivedAt: '2026-01-01T00:00:01.000Z',
  }
}

function mkNic(deviceId: string) {
  return {
    deviceId,
    receiveBytesPerSecond: 1,
    transmitBytesPerSecond: 2,
    receiveErrorsPerSecond: 0,
    transmitErrorsPerSecond: 0,
    receiveDropsPerSecond: 0,
    transmitDropsPerSecond: 0,
  }
}

function mkGpu(gpuId: string) {
  return {
    gpuId,
    utilizationPercent: 1,
    memoryUsedBytes: 1,
    memoryActivityPercent: 1,
    temperatureCelsius: 1,
    memoryTemperatureCelsius: 1,
    powerWatts: 1,
    pcieReceiveBytesPerSecond: 1,
    pcieTransmitBytesPerSecond: 1,
    throttlePercent: 1,
  }
}

function mkSignal(signalId: string) {
  return { signalId, kind: 'temp', value: 1 }
}

function mkIngress(sourceId: string) {
  return {
    sourceId,
    sourceKind: 'caddy',
    requests: 1,
    responses2xx: 1,
    responses3xx: 0,
    responses4xx: 0,
    responses5xx: 0,
    requestErrors: 0,
    requestBytes: 1,
    responseBytes: 1,
    requestDurationSecondsAvg: 0.1,
    requestsUnder100ms: 1,
    requestsUnder500ms: 1,
    requestsUnder1s: 1,
    requestsUnder5s: 1,
    requestsInFlight: 1,
    upstreamsHealthy: 1,
    upstreamsTotal: 1,
    retries: 0,
  }
}

function mkDatabaseProxy(sourceId: string) {
  return {
    sourceId,
    sourceKind: 'proxysql',
    queries: 1,
    slowQueries: 0,
    connectionErrors: 0,
    clientConnections: 1,
    backendConnections: 1,
    backendsUp: 1,
  }
}

function createFakeDataset(): {
  dataset: AnalyticsEngineDatasetLike
  calls: Array<{ indexes?: string[]; doubles?: number[]; blobs?: string[] }>
} {
  const calls: Array<{ indexes?: string[]; doubles?: number[]; blobs?: string[] }> = []
  return {
    calls,
    dataset: {
      writeDataPoint(event) {
        calls.push(event)
      },
    },
  }
}

function writeCountFor(
  overrides: Partial<MetricsSampleV5Input>,
  slotMapping?: SlotMapping
): number {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStoreV5(fake.dataset)
  store.writeSample(buildSample(overrides), slotMapping)
  return fake.calls.length
}

/** Slot mapping for a 2-uplink host: `eth0`/`eth1` are the normal NIC slots. */
function twoUplinkSlotMapping(fabricDeviceIds: string[] = []): SlotMapping {
  return {
    normalNicSlots: ['eth0', 'eth1'],
    fabricDeviceIds,
    rootFilesystemId: null,
    gpuPageOrder: [],
    blockPageOrder: [],
    filesystemPageOrder: [],
    hardwareSignalPageOrder: [],
  }
}

// ---------------------------------------------------------------------------
// Row-count matrix (see plan §6 for the machine-shape → expected-row-count
// list this mirrors). host.system + host.io are always 2 baseline rows;
// every other row is presence-gated / paged on top of that.
// ---------------------------------------------------------------------------

it('1-NIC VM: 2 rows (both NICs embed in host.io; here just 1)', () => {
  assertEquals(writeCountFor({ networks: [mkNic('eth0')] }), 2)
})

it('2-NIC VM: 2 rows (both NICs embed in host.io)', () => {
  assertEquals(writeCountFor({ networks: [mkNic('eth0'), mkNic('eth1')] }), 2)
})

it('2-NIC + extra fabric device, topology generation unknown: 3 rows (conservative positional fallback, no slot mapping to tell fabric apart yet)', () => {
  assertEquals(
    writeCountFor({
      networks: [mkNic('eth0'), mkNic('eth1'), mkNic('fabric0')],
    }),
    3
  )
})

it('2-NIC + extra fabric device, topology generation known: 2 rows — fabric never pages once SlotMapping identifies it', () => {
  assertEquals(
    writeCountFor(
      { networks: [mkNic('eth0'), mkNic('eth1'), mkNic('fabric0')] },
      twoUplinkSlotMapping(['fabric0'])
    ),
    2
  )
})

it('2-NIC + a genuine 3rd uplink, topology generation known: 3 rows — only fabric is excluded from paging, not every extra device', () => {
  assertEquals(
    writeCountFor(
      { networks: [mkNic('eth0'), mkNic('eth1'), mkNic('eth2')] },
      twoUplinkSlotMapping([])
    ),
    3
  )
})

it('+1 GPU: 3 rows (host.system, host.io, one gpu page)', () => {
  assertEquals(writeCountFor({ gpus: [mkGpu('gpu0')] }), 3)
})

it('+Caddy (managed.ingress): 3 rows', () => {
  assertEquals(writeCountFor({ ingressSources: [mkIngress('caddy0')] }), 3)
})

it('web (Caddy) + GPU: 4 rows', () => {
  assertEquals(
    writeCountFor({
      ingressSources: [mkIngress('caddy0')],
      gpus: [mkGpu('gpu0')],
    }),
    4
  )
})

it('DB-only VM (no ProxySQL): 2 rows', () => {
  assertEquals(writeCountFor({}), 2)
})

it('DB + ProxySQL (managed.database_proxy): 3 rows', () => {
  assertEquals(writeCountFor({ databaseProxies: [mkDatabaseProxy('proxysql0')] }), 3)
})

it('bare-metal <=19 hardware signals: 3 rows (host.system, host.io, one hardware.physical page)', () => {
  const signals = Array.from({ length: 12 }, (_, i) => mkSignal(`sig${i}`))
  assertEquals(writeCountFor({ hardwareSignals: signals }), 3)
})

it('bare-metal + GPU: 4 rows', () => {
  const signals = Array.from({ length: 12 }, (_, i) => mkSignal(`sig${i}`))
  assertEquals(writeCountFor({ hardwareSignals: signals, gpus: [mkGpu('gpu0')] }), 4)
})

it('4-NIC host: 3 rows (host.system, host.io, one network page of the 2 extras)', () => {
  const networks = [mkNic('eth0'), mkNic('eth1'), mkNic('eth2'), mkNic('eth3')]
  assertEquals(writeCountFor({ networks }), 3)
})

it('8-NIC host: 4 rows (host.system, host.io, two network pages of the 6 extras)', () => {
  const networks = Array.from({ length: 8 }, (_, i) => mkNic(`eth${i}`))
  assertEquals(writeCountFor({ networks }), 4)
})

it('16-GPU host: 10 rows (host.system, host.io, eight gpu pages of 2 each)', () => {
  const gpus = Array.from({ length: 16 }, (_, i) => mkGpu(`gpu${i}`))
  assertEquals(writeCountFor({ gpus }), 10)
})

it('presence-gated empty arrays: exactly 2 rows, no extra writes', () => {
  assertEquals(writeCountFor({}), 2)
})

it('events: one extra writeDataPoint call per event, on top of the host.system/host.io baseline', () => {
  const events = [
    {
      eventId: 'evt1',
      at: '2026-01-01T00:00:00.500Z',
      kind: 'nic_link_down' as const,
      severity: 'warning' as const,
    },
    {
      eventId: 'evt2',
      at: '2026-01-01T00:00:01.500Z',
      kind: 'fs_read_only' as const,
      severity: 'critical' as const,
    },
  ]
  assertEquals(writeCountFor({ events }), 4)
})

// ---------------------------------------------------------------------------
// writeSample / writeStatusEvent delegate to field-map-v5.ts exactly
// ---------------------------------------------------------------------------

it('writeSample: calls match buildMetricsDataPointsV5 exactly, fire-and-forget', () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStoreV5(fake.dataset)
  const sample = buildSample({ gpus: [mkGpu('gpu0')] })
  store.writeSample(sample)
  assertEquals(fake.calls, buildMetricsDataPointsV5(sample))
})

it('writeSample: indexes is the authenticated serverId on every row', () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStoreV5(fake.dataset)
  const sample = buildSample({ gpus: [mkGpu('gpu0')] })
  store.writeSample(sample)
  for (const call of fake.calls) {
    assertEquals(call.indexes, [sample.serverId])
  }
})

it('writeStatusEvent: exactly one writeDataPoint, matching buildStatusDataPointV5', () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStoreV5(fake.dataset)
  const event = {
    serverId: '11111111-2222-4333-8444-555555555555',
    connected: false,
    reason: 'disconnect' as const,
    at: '2026-01-01T00:00:00.000Z',
  }
  store.writeStatusEvent(event)
  assertEquals(fake.calls.length, 1)
  assertEquals(fake.calls[0], buildStatusDataPointV5(event))
})

// ---------------------------------------------------------------------------
// v5 read-path wiring — no `sql` config reports `available: false` with the
// correct empty shape; a configured `sql` client delegates to sql-api-v5.ts.
// ---------------------------------------------------------------------------

const READ_SERVER_ID = '11111111-2222-4333-8444-555555555555'

it('queryHostSeries: no sql config reports available:false with an empty series', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStoreV5(fake.dataset)
  const result = await store.queryHostSeries!({
    serverId: READ_SERVER_ID,
    metrics: ['host.cpu.busyPercent'],
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, false)
  assertEquals(result.points, [])
  assertEquals(result.sampleCount, 0)
})

it('queryHostSummary: no sql config reports available:false', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStoreV5(fake.dataset)
  const result = await store.queryHostSummary!({
    serverId: READ_SERVER_ID,
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, false)
  assertEquals(result.sampleCount, 0)
  assertEquals(result.latestAt, null)
})

it('queryFleetHostSnapshot: no sql config reports available:false with no servers', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStoreV5(fake.dataset)
  const result = await store.queryFleetHostSnapshot!({
    serverIds: [READ_SERVER_ID],
    metrics: ['host.cpu.busyPercent'],
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, false)
  assertEquals(result.servers, [])
})

it('queryMetricEvents: no sql config reports available:false with no events', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStoreV5(fake.dataset)
  const result = await store.queryMetricEvents!({
    serverId: READ_SERVER_ID,
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, false)
  assertEquals(result.events, [])
  assertEquals(result.truncated, false)
})

it('queryEntitySeries: no sql config reports available:false with no entities', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStoreV5(fake.dataset)
  const result = await store.queryEntitySeries!({
    serverId: READ_SERVER_ID,
    family: 'gpu',
    entityIds: ['gpu0'],
    metrics: ['utilizationPercent'],
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, false)
  assertEquals(result.entities, [])
})

it('queryEntityIdsSeen: no sql config reports available:false with no ids', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStoreV5(fake.dataset)
  const result = await store.queryEntityIdsSeen!({
    serverId: READ_SERVER_ID,
    family: 'gpu',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, false)
  assertEquals(result.entityIds, [])
})

it('queryHostSeries: with sql config, delegates to the AE SQL API path', async () => {
  const fake = createFakeDataset()
  const store = new CloudflareAnalyticsEngineServerMetricsStoreV5(fake.dataset, {
    sql: {
      accountId: 'acct123',
      apiToken: 'token-xyz',
      fetch: async (_url, init) => {
        const body = String(init?.body ?? '')
        if (body.includes('GROUP BY generation')) {
          return new Response(
            JSON.stringify({
              success: true,
              errors: [],
              messages: [],
              result: { data: [], meta: [], rows: 0 },
            }),
            { status: 200 }
          )
        }
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: {
              data: [
                {
                  bucket: 1735689600,
                  sample_count: 1,
                  avg_interval_seconds: 10,
                  m0: 55,
                },
              ],
              meta: [],
              rows: 1,
            },
          }),
          { status: 200 }
        )
      },
    },
  })
  const result = await store.queryHostSeries!({
    serverId: READ_SERVER_ID,
    metrics: ['host.cpu.busyPercent'],
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:05:00.000Z',
  })
  assertEquals(result.available, true)
  assertEquals(result.points[0].values['host.cpu.busyPercent'], 55)
})
