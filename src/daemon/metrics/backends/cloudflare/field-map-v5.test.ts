import { assertEquals, assertThrows } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSampleV5, type MetricsSampleV5Input } from '../../contract-v5.ts'
import type { AuthenticatedMetricsSampleV5 } from '../../types-v5.ts'
import {
  _internalFieldMapV5,
  AE_V5_BLOB_COUNT,
  AE_V5_BLOB_EVENT_ENTITY_ID_INDEX,
  AE_V5_BLOB_EVENT_ID_INDEX,
  AE_V5_BLOB_EVENT_PAYLOAD_INDEX,
  AE_V5_BLOB_FAMILY_INDEX,
  AE_V5_BLOB_KIND_INDEX,
  AE_V5_BLOB_PAGE_INDEX,
  AE_V5_BLOB_SAMPLED_AT_INDEX,
  AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX,
  AE_V5_BLOB_STATUS_OR_EVENT_REASON_INDEX,
  AE_V5_DOUBLE_COUNT,
  AE_V5_DOUBLE_INTERVAL_INDEX,
  AE_V5_FAMILY_BLOCK,
  AE_V5_FAMILY_CPU_DETAIL,
  AE_V5_FAMILY_FILESYSTEM,
  AE_V5_FAMILY_GPU,
  AE_V5_FAMILY_HARDWARE_PHYSICAL,
  AE_V5_FAMILY_HOST_IO,
  AE_V5_KIND_EVENT,
  AE_V5_MAX_DATA_POINTS_PER_INVOCATION,
  AE_V5_FAMILY_HOST_SYSTEM,
  AE_V5_FAMILY_MEMORY_DETAIL,
  AE_V5_FAMILY_NETWORK,
  AE_V5_KIND_METRICS,
  AE_V5_MISSING_METRIC_SENTINEL,
  type AnalyticsEngineDataPointLikeV5,
  buildMetricsDataPointsV5,
} from './field-map-v5.ts'

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

function buildSample(
  overrides: Partial<MetricsSampleV5Input> = {},
  identity: { serverId?: string; receivedAt?: string } = {}
): AuthenticatedMetricsSampleV5 {
  const built = buildMetricsSampleV5(baseInput(overrides))
  return {
    ...built,
    serverId: identity.serverId ?? '11111111-2222-4333-8444-555555555555',
    receivedAt: identity.receivedAt ?? '2026-01-01T00:00:01.000Z',
  }
}

function pointFor(
  points: AnalyticsEngineDataPointLikeV5[],
  family: string,
  page = 0
): AnalyticsEngineDataPointLikeV5 {
  const found = points.find(
    (point) =>
      point.blobs[AE_V5_BLOB_FAMILY_INDEX] === family &&
      point.blobs[AE_V5_BLOB_PAGE_INDEX] === String(page)
  )
  if (!found) {
    throw new Error(`no point found for family ${family} page ${page}`)
  }
  return found
}

function mkNic(deviceId: string, seed = 0) {
  return {
    deviceId,
    receiveBytesPerSecond: seed + 1,
    transmitBytesPerSecond: seed + 2,
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

function mkFilesystem(filesystemId: string) {
  return { filesystemId, availableBytes: 1, freeInodes: 1 }
}

function mkCpuDetail(): MetricsSampleV5Input['cpuDetail'] {
  return {
    averageFrequencyMHz: 2000,
    minimumFrequencyMHz: 1000,
    maximumFrequencyMHz: 3000,
    contextSwitchesPerSecond: 1,
    interruptsPerSecond: 2,
    forksPerSecond: 3,
    cpuIrqPercent: 4,
  }
}

function mkMemoryDetail(): MetricsSampleV5Input['memoryDetail'] {
  return {
    memoryFreeBytes: 1,
    cachedBytes: 2,
    anonPagesBytes: 3,
    slabReclaimableBytes: 4,
    slabUnreclaimableBytes: 5,
    dirtyBytes: 6,
    writebackBytes: 7,
    shmemBytes: 8,
    pageTablesBytes: 9,
    kernelStackBytes: 10,
    committedAsBytes: 11,
    commitLimitBytes: 12,
    activeAnonBytes: 13,
    inactiveAnonBytes: 14,
    activeFileBytes: 15,
    inactiveFileBytes: 16,
    pageScanDirectPerSecond: 17,
    pageScanKswapdPerSecond: 18,
    compactionStallsPerSecond: 19,
  }
}

function mkCpuCoreLive(coreId: string, seed = 1) {
  return {
    coreId,
    busyPercent: seed,
    iowaitPercent: seed + 1,
    stealPercent: seed + 2,
  }
}

function mkBlock(deviceId: string) {
  return {
    deviceId,
    readBytesPerSecond: 1,
    writeBytesPerSecond: 1,
    readOpsPerSecond: 1,
    writeOpsPerSecond: 1,
    readLatencyMs: 1,
    writeLatencyMs: 1,
    utilizationPercent: 1,
    temperatureCelsius: 1,
    queueDepth: 1,
  }
}

function mkSignal(signalId: string, value: number) {
  return { signalId, kind: 'temp', value }
}

// ---------------------------------------------------------------------------
// host.system / host.io exact positions
// ---------------------------------------------------------------------------

it('host.system doubles: exact field order double1..double19, double20 = interval', () => {
  const sample = buildSample({
    host: {
      cpu: {
        busyPercent: 1,
        userPercent: 2,
        systemPercent: 3,
        iowaitPercent: 4,
        stealPercent: 5,
        softirqPercent: 6,
        pressureSomePercent: 7,
        saturatedCoreCount: 8,
        procsRunning: 9,
        procsBlocked: 10,
        processCount: 20,
      },
      kernel: { fileHandlesUsedPercent: 11, conntrackUsedPercent: 12 },
      memory: {
        usedBytes: 13,
        cachedFilesBytes: 14,
        swapUsedBytes: 15,
        pressureSomePercent: 16,
        pressureFullPercent: 17,
        swapInBytesPerSecond: 18,
        swapOutBytesPerSecond: 19,
        majorPageFaultsPerSecond: 99,
      },
      storage: zeroFields(HOST_STORAGE_FIELDS) as MetricsSampleV5Input['host']['storage'],
      network: zeroFields(HOST_NETWORK_FIELDS) as MetricsSampleV5Input['host']['network'],
    },
  })
  const point = pointFor(buildMetricsDataPointsV5(sample), AE_V5_FAMILY_HOST_SYSTEM)
  // 19 slots: 10 host.cpu (processCount overflows to host.io), 2 host.kernel,
  // 7 host.memory (majorPageFaultsPerSecond also overflows to host.io).
  assertEquals(
    point.doubles.slice(0, 19),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
  )
  assertEquals(point.doubles[AE_V5_DOUBLE_INTERVAL_INDEX], 60)
  assertEquals(point.blobs[AE_V5_BLOB_KIND_INDEX], AE_V5_KIND_METRICS)
  assertEquals(point.blobs[AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX], '')
})

it('host.io doubles: 9 descriptor slots + 6 NIC-embedded slots + 2 overflow slots + 2 reserved + interval', () => {
  const sample = buildSample({
    host: {
      cpu: {
        ...zeroFields(HOST_CPU_FIELDS),
        processCount: 218,
      } as MetricsSampleV5Input['host']['cpu'],
      kernel: zeroFields(HOST_KERNEL_FIELDS) as MetricsSampleV5Input['host']['kernel'],
      memory: {
        ...zeroFields(HOST_MEMORY_FIELDS),
        majorPageFaultsPerSecond: 219,
      } as MetricsSampleV5Input['host']['memory'],
      storage: {
        ioPressureSomePercent: 1,
        ioPressureFullPercent: 2,
        diskReadBytesPerSecond: 3,
        diskWriteBytesPerSecond: 4,
        diskLatencyMs: 1.8,
        rootFilesystemAvailableBytes: 8,
        rootFilesystemFreeInodes: 9,
      },
      network: { tcpRetransmitPercent: 10, softnetDropsPerSecond: 11 },
    },
    networks: [
      {
        deviceId: 'eth0',
        receiveBytesPerSecond: 100,
        transmitBytesPerSecond: 200,
        receiveErrorsPerSecond: 1,
        transmitErrorsPerSecond: 2,
        receiveDropsPerSecond: 3,
        transmitDropsPerSecond: 4,
      },
      {
        deviceId: 'eth1',
        receiveBytesPerSecond: 300,
        transmitBytesPerSecond: 400,
        receiveErrorsPerSecond: 0,
        transmitErrorsPerSecond: 0,
        receiveDropsPerSecond: 0,
        transmitDropsPerSecond: 0,
      },
    ],
  })
  const point = pointFor(buildMetricsDataPointsV5(sample), AE_V5_FAMILY_HOST_IO)
  // 7 host.storage + 2 host.network descriptor slots.
  assertEquals(point.doubles.slice(0, 9), [1, 2, 3, 4, 1.8, 8, 9, 10, 11])
  // NIC0: receive=100, transmit=200, problem=1+2+3+4=10
  assertEquals(point.doubles.slice(9, 12), [100, 200, 10])
  // NIC1: receive=300, transmit=400, problem=0
  assertEquals(point.doubles.slice(12, 15), [300, 400, 0])
  // Overflow slots, in HOST_IO_OVERFLOW_FIELD_ORDER order.
  assertEquals(point.doubles[15], 218)
  assertEquals(point.doubles[16], 219)
  assertEquals(point.doubles[17], AE_V5_MISSING_METRIC_SENTINEL)
  assertEquals(point.doubles[18], AE_V5_MISSING_METRIC_SENTINEL)
  assertEquals(point.doubles[AE_V5_DOUBLE_INTERVAL_INDEX], 60)
})

it('host.io NIC-embedded problem-packets is sentinel when any input NIC field is missing', () => {
  const sample = buildSample({
    networks: [
      {
        deviceId: 'eth0',
        receiveBytesPerSecond: 1,
        transmitBytesPerSecond: 2,
        receiveErrorsPerSecond: null,
        transmitErrorsPerSecond: 0,
        receiveDropsPerSecond: 0,
        transmitDropsPerSecond: 0,
      },
    ],
  })
  const point = pointFor(buildMetricsDataPointsV5(sample), AE_V5_FAMILY_HOST_IO)
  assertEquals(point.doubles[13], AE_V5_MISSING_METRIC_SENTINEL)
})

it('host.io with no networks: NIC-embedded slots are sentinel', () => {
  const sample = buildSample()
  const point = pointFor(buildMetricsDataPointsV5(sample), AE_V5_FAMILY_HOST_IO)
  for (let i = 11; i <= 16; i++) {
    assertEquals(point.doubles[i], AE_V5_MISSING_METRIC_SENTINEL)
  }
})

it('sentinel-fill: missing host metrics map to AE_V5_MISSING_METRIC_SENTINEL, never 0', () => {
  const sample = buildSample()
  const points = buildMetricsDataPointsV5(sample)
  const hostSystem = pointFor(points, AE_V5_FAMILY_HOST_SYSTEM)
  for (let i = 0; i < 19; i++) {
    assertEquals(hostSystem.doubles[i], AE_V5_MISSING_METRIC_SENTINEL)
  }
})

// ---------------------------------------------------------------------------
// Presence gating — empty arrays emit nothing
// ---------------------------------------------------------------------------

it('presence-gated families emit no rows when their source array is empty', () => {
  const sample = buildSample()
  const points = buildMetricsDataPointsV5(sample)
  assertEquals(points.length, 2)
  assertEquals(
    points.map((p) => p.blobs[AE_V5_BLOB_FAMILY_INDEX]),
    [AE_V5_FAMILY_HOST_SYSTEM, AE_V5_FAMILY_HOST_IO]
  )
})

// ---------------------------------------------------------------------------
// Page-count formulas for per-entity families
// ---------------------------------------------------------------------------

function countPointsOfFamily(points: AnalyticsEngineDataPointLikeV5[], family: string): number {
  return points.filter((p) => p.blobs[AE_V5_BLOB_FAMILY_INDEX] === family).length
}

const PAGE_TEST_COUNTS = [0, 1, 2, 3, 4, 8, 16]

it('gpu page-count formula: ceil(count/2) pages (width 9, floor(19/9)=2/page)', () => {
  for (const count of PAGE_TEST_COUNTS) {
    const gpus = Array.from({ length: count }, (_, i) => mkGpu(`gpu${i}`))
    const sample = buildSample({ gpus })
    const points = buildMetricsDataPointsV5(sample)
    const expected = count === 0 ? 0 : Math.ceil(count / 2)
    assertEquals(countPointsOfFamily(points, AE_V5_FAMILY_GPU), expected, `count=${count}`)
  }
})

it('block page-count formula: ceil(count/2) pages (width 9, floor(19/9)=2/page)', () => {
  for (const count of PAGE_TEST_COUNTS) {
    const blockDevices = Array.from({ length: count }, (_, i) => mkBlock(`sd${i}`))
    const sample = buildSample({ blockDevices })
    const points = buildMetricsDataPointsV5(sample)
    const expected = count === 0 ? 0 : Math.ceil(count / 2)
    assertEquals(countPointsOfFamily(points, AE_V5_FAMILY_BLOCK), expected, `count=${count}`)
  }
})

it('filesystem page-count formula: ceil(count/9) pages (width 2, floor(19/2)=9/page)', () => {
  for (const count of PAGE_TEST_COUNTS) {
    const filesystems = Array.from({ length: count }, (_, i) => mkFilesystem(`fs${i}`))
    const sample = buildSample({ filesystems })
    const points = buildMetricsDataPointsV5(sample)
    const expected = count === 0 ? 0 : Math.ceil(count / 9)
    assertEquals(countPointsOfFamily(points, AE_V5_FAMILY_FILESYSTEM), expected, `count=${count}`)
  }
})

it('network page-count formula: extras beyond the first two embedded NICs, ceil(extra/3) pages', () => {
  for (const extra of PAGE_TEST_COUNTS) {
    const networks = [
      mkNic('eth0'),
      mkNic('eth1'),
      ...Array.from({ length: extra }, (_, i) => mkNic(`ethX${i}`)),
    ]
    const sample = buildSample({ networks })
    const points = buildMetricsDataPointsV5(sample)
    const expected = extra === 0 ? 0 : Math.ceil(extra / 3)
    assertEquals(countPointsOfFamily(points, AE_V5_FAMILY_NETWORK), expected, `extra=${extra}`)
  }
})

it('network with fewer than 2 total NICs never emits a network page', () => {
  for (const networks of [[], [mkNic('eth0')]]) {
    const sample = buildSample({ networks })
    const points = buildMetricsDataPointsV5(sample)
    assertEquals(countPointsOfFamily(points, AE_V5_FAMILY_NETWORK), 0)
  }
})

// ---------------------------------------------------------------------------
// hardware.physical — blob10 signal-id round-trip
// ---------------------------------------------------------------------------

it('hardware.physical: blob10 carries comma-joined signalIds in positional order, one page for <=19 signals', () => {
  const signals = Array.from({ length: 5 }, (_, i) => mkSignal(`sig${i}`, i))
  const sample = buildSample({ hardwareSignals: signals })
  const points = buildMetricsDataPointsV5(sample)
  const page0 = pointFor(points, AE_V5_FAMILY_HARDWARE_PHYSICAL, 0)
  assertEquals(page0.blobs[AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX], 'sig0,sig1,sig2,sig3,sig4')
  assertEquals(page0.doubles.slice(0, 5), [0, 1, 2, 3, 4])
})

it("hardware.physical: 20 signals span two pages (19/page), each page's ids match its doubles", () => {
  const signals = Array.from({ length: 20 }, (_, i) => mkSignal(`sig${i}`, i))
  const sample = buildSample({ hardwareSignals: signals })
  const points = buildMetricsDataPointsV5(sample)
  assertEquals(countPointsOfFamily(points, AE_V5_FAMILY_HARDWARE_PHYSICAL), 2)
  const page0 = pointFor(points, AE_V5_FAMILY_HARDWARE_PHYSICAL, 0)
  const page1 = pointFor(points, AE_V5_FAMILY_HARDWARE_PHYSICAL, 1)
  assertEquals(page0.blobs[AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX].split(',').length, 19)
  assertEquals(page1.blobs[AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX], 'sig19')
  assertEquals(page1.doubles[0], 19)
})

// ---------------------------------------------------------------------------
// Shape assertion
// ---------------------------------------------------------------------------

it('every produced point has exactly AE_V5_DOUBLE_COUNT doubles and AE_V5_BLOB_COUNT blobs', () => {
  const sample = buildSample({
    networks: [mkNic('eth0'), mkNic('eth1'), mkNic('eth2')],
    gpus: [mkGpu('gpu0')],
    filesystems: [mkFilesystem('fs0')],
    blockDevices: [mkBlock('sd0')],
    hardwareSignals: [mkSignal('sig0', 1)],
    ingressSources: [
      {
        sourceId: 'caddy0',
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
      },
    ],
    databaseProxies: [
      {
        sourceId: 'proxysql0',
        sourceKind: 'proxysql',
        queries: 1,
        slowQueries: 0,
        connectionErrors: 0,
        clientConnections: 1,
        backendConnections: 1,
        backendsUp: 1,
      },
    ],
    events: [
      {
        eventId: 'evt1',
        at: '2026-01-01T00:00:00.500Z',
        kind: 'nic_link_down',
        severity: 'warning',
        entityId: 'eth0',
        source: 'daemon',
        payload: { reason: 'carrier lost' },
      },
    ],
  })
  const points = buildMetricsDataPointsV5(sample)
  for (const point of points) {
    assertEquals(point.doubles.length, AE_V5_DOUBLE_COUNT)
    assertEquals(point.blobs.length, AE_V5_BLOB_COUNT)
    assertEquals(point.indexes, [sample.serverId])
  }
})

it('managed.ingress / managed.database_proxy: one unpaged row per entry, blob10 = sourceId', () => {
  const sample = buildSample({
    ingressSources: [
      {
        sourceId: 'caddy0',
        sourceKind: 'caddy',
        requests: 5,
        responses2xx: 4,
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
      },
    ],
    databaseProxies: [
      {
        sourceId: 'proxysql0',
        sourceKind: 'proxysql',
        queries: 7,
        slowQueries: 0,
        connectionErrors: 0,
        clientConnections: 1,
        backendConnections: 1,
        backendsUp: 1,
      },
    ],
  })
  const points = buildMetricsDataPointsV5(sample)
  const ingress = pointFor(points, 'managed.ingress', 0)
  assertEquals(ingress.blobs[AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX], 'caddy0')
  assertEquals(ingress.doubles[0], 5)
  const dbProxy = pointFor(points, 'managed.database_proxy', 0)
  assertEquals(dbProxy.blobs[AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX], 'proxysql0')
  assertEquals(dbProxy.doubles[0], 7)
})

it('managed.ingress: two sources sharing sourceKind stay distinct rows keyed by sourceId', () => {
  const sample = buildSample({
    ingressSources: [
      {
        sourceId: 'caddy-1',
        sourceKind: 'caddy',
        requests: 5,
        responses2xx: 4,
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
      },
      {
        sourceId: 'caddy-2',
        sourceKind: 'caddy',
        requests: 15,
        responses2xx: 4,
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
      },
    ],
  })
  const points = buildMetricsDataPointsV5(sample)
  const ingressPoints = points.filter(
    (point) => point.blobs[AE_V5_BLOB_FAMILY_INDEX] === 'managed.ingress'
  )
  assertEquals(ingressPoints.length, 2)
  const ids = ingressPoints.map((point) => point.blobs[AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX]).sort()
  assertEquals(ids, ['caddy-1', 'caddy-2'])
})

it('events: one event-kind row per entry, entityId/payload/severity carried', () => {
  const sample = buildSample({
    events: [
      {
        eventId: 'evt1',
        at: '2026-01-01T00:00:00.500Z',
        kind: 'nic_link_down',
        severity: 'warning',
        entityId: 'eth0',
        source: 'daemon',
        payload: { reason: 'carrier lost' },
      },
    ],
  })
  const points = buildMetricsDataPointsV5(sample)
  const event = points.find((p) => p.blobs[AE_V5_BLOB_KIND_INDEX] === 'event')!
  assertEquals(event.blobs[AE_V5_BLOB_FAMILY_INDEX], 'nic_link_down')
  assertEquals(event.blobs[AE_V5_BLOB_SAMPLED_AT_INDEX], '2026-01-01T00:00:00.500Z')
  assertEquals(event.blobs[AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX], 'daemon')
  assertEquals(event.blobs[AE_V5_BLOB_EVENT_ENTITY_ID_INDEX], 'eth0')
  assertEquals(event.blobs[AE_V5_BLOB_EVENT_ID_INDEX], 'evt1')
  assertEquals(JSON.parse(event.blobs[AE_V5_BLOB_EVENT_PAYLOAD_INDEX]), {
    reason: 'carrier lost',
  })
  assertEquals(event.blobs[AE_V5_BLOB_STATUS_OR_EVENT_REASON_INDEX], 'warning')
  // Every metric slot stays sentinel — an event row carries no measurements —
  // but double20 carries the interval weight like every other row. v4 left it
  // at the sentinel, contradicting its own documented invariant.
  assertEquals(event.doubles[AE_V5_DOUBLE_INTERVAL_INDEX], 60)
  for (const value of event.doubles.slice(0, AE_V5_DOUBLE_INTERVAL_INDEX)) {
    assertEquals(value, AE_V5_MISSING_METRIC_SENTINEL)
  }
})

// ---------------------------------------------------------------------------
// cpu.detail / memory.detail / cpu.core.live
// ---------------------------------------------------------------------------

it('memory.detail is absent from a baseline sample with no memoryDetail set', () => {
  const sample = buildSample()
  const points = buildMetricsDataPointsV5(sample)
  assertEquals(countPointsOfFamily(points, AE_V5_FAMILY_MEMORY_DETAIL), 0)
})

it('memory.detail present: +1 row, exact double1..double19 field order', () => {
  const sample = buildSample({ memoryDetail: mkMemoryDetail() })
  const points = buildMetricsDataPointsV5(sample)
  assertEquals(countPointsOfFamily(points, AE_V5_FAMILY_MEMORY_DETAIL), 1)
  const point = pointFor(points, AE_V5_FAMILY_MEMORY_DETAIL)
  assertEquals(
    point.doubles.slice(0, 19),
    Array.from({ length: 19 }, (_, i) => i + 1)
  )
  assertEquals(point.doubles[AE_V5_DOUBLE_INTERVAL_INDEX], 60)
})

// ---------------------------------------------------------------------------
// Module-load invariant failure cases
// ---------------------------------------------------------------------------

it('assertFieldOrderMatchesDescriptors throws on an unknown field', () => {
  assertThrows(
    () =>
      _internalFieldMapV5.assertFieldOrderMatchesDescriptors('test', 'gpu', [
        'utilizationPercent',
        'notARealGpuField',
      ]),
    TypeError,
    'unknown field'
  )
})

it('assertFieldOrderMatchesDescriptors throws when a descriptor field is missing', () => {
  assertThrows(
    () =>
      _internalFieldMapV5.assertFieldOrderMatchesDescriptors('test', 'filesystem', [
        'availableBytes',
      ]),
    TypeError,
    'missing descriptor field'
  )
})

it('assertFieldOrderMatchesDescriptors throws on a duplicate field', () => {
  assertThrows(
    () =>
      _internalFieldMapV5.assertFieldOrderMatchesDescriptors('test', 'filesystem', [
        'availableBytes',
        'availableBytes',
      ]),
    TypeError,
    'duplicate'
  )
})

it('assertWithinPageBudget throws when a field-order array exceeds the 19-slot page budget', () => {
  assertThrows(
    () => _internalFieldMapV5.assertWithinPageBudget('test family', 20),
    TypeError,
    'exceeding the 19-slot'
  )
})

// ---------------------------------------------------------------------------
// Analytics Engine invocation limit
// ---------------------------------------------------------------------------

/** A sample at the contract's own array caps — the largest thing the wire can carry. */
function maxCardinalitySample() {
  const n = <T>(count: number, make: (i: number) => T): T[] =>
    Array.from({ length: count }, (_, i) => make(i))
  return buildSample({
    networks: n(64, (i) => ({
      deviceId: `eth${i}`,
      receiveBytesPerSecond: 1,
      transmitBytesPerSecond: 1,
      receiveErrorsPerSecond: 0,
      transmitErrorsPerSecond: 0,
      receiveDropsPerSecond: 0,
      transmitDropsPerSecond: 0,
    })),
    filesystems: n(64, (i) => ({ filesystemId: `fs${i}`, availableBytes: 1, freeInodes: 1 })),
    blockDevices: n(64, (i) => ({
      deviceId: `blk${i}`,
      readBytesPerSecond: 1,
      writeBytesPerSecond: 1,
      readOpsPerSecond: 1,
      writeOpsPerSecond: 1,
      readLatencyMs: 1,
      writeLatencyMs: 1,
      utilizationPercent: 1,
      temperatureCelsius: 1,
      queueDepth: 1,
    })),
    gpus: n(64, (i) => ({
      gpuId: `gpu${i}`,
      utilizationPercent: 1,
      memoryUsedBytes: 1,
      memoryActivityPercent: 1,
      temperatureCelsius: 1,
      memoryTemperatureCelsius: 1,
      powerWatts: 1,
      pcieReceiveBytesPerSecond: 1,
      pcieTransmitBytesPerSecond: 1,
      throttlePercent: 1,
    })),
    hardwareSignals: n(64, (i) => ({ signalId: `sig${i}`, kind: 'temperature', value: 1 })),
    // Cardinality here is scrape-derived and gated only by a boolean in the
    // capability plan, which is what makes the limit reachable in practice.
    ingressSources: n(64, (i) => ({
      sourceId: `ing${i}`,
      sourceKind: 'caddy',
      requests: 1,
      responses2xx: 1,
      responses3xx: 1,
      responses4xx: 1,
      responses5xx: 1,
      requestErrors: null,
      requestBytes: 1,
      responseBytes: 1,
      requestDurationSecondsAvg: 1,
      requestsUnder100ms: 1,
      requestsUnder500ms: 1,
      requestsUnder1s: 1,
      requestsUnder5s: 1,
      requestsInFlight: 1,
      upstreamsHealthy: 1,
      upstreamsTotal: 1,
      retries: null,
    })),
    databaseProxies: n(64, (i) => ({
      sourceId: `db${i}`,
      sourceKind: 'proxysql',
      queries: 1,
      slowQueries: 1,
      connectionErrors: 1,
      clientConnections: 1,
      backendConnections: 1,
      backendsUp: 1,
    })),
    events: n(128, (i) => ({
      eventId: `e${i}`,
      at: '2026-01-01T00:00:00.000Z',
      kind: 'oom_kill' as const,
      severity: 'warning' as const,
    })),
  })
}

it('never emits more data points than Analytics Engine accepts per invocation', () => {
  // Exceeding the limit rejects the *whole* invocation, so this has to be a
  // structural guarantee rather than something the capability plan happens to
  // keep us under. At the contract's own caps an unguarded sample produces 355.
  const points = buildMetricsDataPointsV5(maxCardinalitySample())
  assertEquals(points.length, AE_V5_MAX_DATA_POINTS_PER_INVOCATION)
})

it('keeps the mandatory host rows when shedding for the invocation limit', () => {
  const points = buildMetricsDataPointsV5(maxCardinalitySample())
  assertEquals(countPointsOfFamily(points, AE_V5_FAMILY_HOST_SYSTEM), 1)
  assertEquals(countPointsOfFamily(points, AE_V5_FAMILY_HOST_IO), 1)
})

it('keeps every event row when shedding, since a dropped transition is lost forever', () => {
  // An entity row is one missing point in a continuous series; an event is a
  // discrete state change nothing re-reports.
  const points = buildMetricsDataPointsV5(maxCardinalitySample())
  const events = points.filter((point) => point.blobs[AE_V5_BLOB_KIND_INDEX] === AE_V5_KIND_EVENT)
  assertEquals(events.length, 128)
})

it('leaves a normally-sized sample completely untouched', () => {
  const sample = buildSample({ networks: [mkNic('eth0')] })
  const points = buildMetricsDataPointsV5(sample)
  assertEquals(points.length < AE_V5_MAX_DATA_POINTS_PER_INVOCATION, true)
  assertEquals(points.length, 2)
})
