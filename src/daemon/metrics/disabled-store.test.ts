import { assertEquals, assertRejects } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSample } from './contract.ts'
import { DisabledServerMetricsStore } from './disabled-store.ts'
import { UnavailableServerMetricsStore } from './store-selection-core.ts'
import type { AuthenticatedMetricsSample } from './types.ts'

const NULL_HOST = {
  cpu: {
    busyPercent: null,
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

const sample: AuthenticatedMetricsSample = {
  ...buildMetricsSample({
    metadata: {
      version: 6,
      sampledAt: '2026-01-01T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 0,
      bootGeneration: 0,
    },
    host: NULL_HOST,
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
  }),
  serverId: 'srv-1',
  receivedAt: '2026-01-01T00:00:01.000Z',
}

it('DisabledServerMetricsStore writeSample is a no-op', () => {
  const store = new DisabledServerMetricsStore()
  store.writeSample(sample)
})

it('DisabledServerMetricsStore writeStatusEvent is a no-op', () => {
  const store = new DisabledServerMetricsStore()
  store.writeStatusEvent({
    serverId: 'srv-1',
    connected: true,
    reason: 'connect',
    at: '2026-01-01T00:00:00.000Z',
  })
})

it('UnavailableServerMetricsStore writeSample is a no-op', () => {
  const store = new UnavailableServerMetricsStore('backend down')
  store.writeSample(sample)
})

it('UnavailableServerMetricsStore writeStatusEvent is a no-op', () => {
  const store = new UnavailableServerMetricsStore('backend down')
  store.writeStatusEvent({
    serverId: 'srv-1',
    connected: false,
    reason: 'disconnect',
    at: '2026-01-01T00:00:00.000Z',
  })
})

it('UnavailableServerMetricsStore carries its reason', () => {
  const store = new UnavailableServerMetricsStore('DuckDB failed to open')
  assertEquals(store.reason, 'DuckDB failed to open')
})

it('UnavailableServerMetricsStore query methods reject with the store reason', async () => {
  const store = new UnavailableServerMetricsStore('backend down')
  const range = {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T01:00:00.000Z',
  }
  await assertRejects(
    () =>
      store.queryEntitySeries({
        serverId: 'srv-1',
        family: 'network',
        entityIds: ['eth0'],
        metrics: ['receiveBytesPerSecond'],
        ...range,
      }),
    Error,
    'backend down'
  )
  await assertRejects(
    () =>
      store.queryEntityIdsSeen({
        serverId: 'srv-1',
        family: 'network',
        ...range,
      }),
    Error,
    'backend down'
  )
  await assertRejects(
    () => store.queryMetricEvents({ serverId: 'srv-1', ...range }),
    Error,
    'backend down'
  )
})
