import { assertEquals, assertRejects } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSampleV5 } from './contract-v5.ts'
import { DisabledServerMetricsStoreV5 } from './disabled-store-v5.ts'
import { UnavailableServerMetricsStoreV5 } from './store-selection-core.ts'
import type { AuthenticatedMetricsSampleV5 } from './types-v5.ts'

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

const sample: AuthenticatedMetricsSampleV5 = {
  ...buildMetricsSampleV5({
    metadata: {
      version: 5,
      sampledAt: '2026-01-01T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 1,
      collectionMode: 'baseline',
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

it('DisabledServerMetricsStoreV5 writeSample is a no-op', () => {
  const store = new DisabledServerMetricsStoreV5()
  store.writeSample(sample)
})

it('DisabledServerMetricsStoreV5 writeStatusEvent is a no-op', () => {
  const store = new DisabledServerMetricsStoreV5()
  store.writeStatusEvent({
    serverId: 'srv-1',
    connected: true,
    reason: 'connect',
    at: '2026-01-01T00:00:00.000Z',
  })
})

it('UnavailableServerMetricsStoreV5 writeSample is a no-op', () => {
  const store = new UnavailableServerMetricsStoreV5('backend down')
  store.writeSample(sample)
})

it('UnavailableServerMetricsStoreV5 writeStatusEvent is a no-op', () => {
  const store = new UnavailableServerMetricsStoreV5('backend down')
  store.writeStatusEvent({
    serverId: 'srv-1',
    connected: false,
    reason: 'disconnect',
    at: '2026-01-01T00:00:00.000Z',
  })
})

it('UnavailableServerMetricsStoreV5 carries its reason', () => {
  const store = new UnavailableServerMetricsStoreV5('DuckDB failed to open')
  assertEquals(store.reason, 'DuckDB failed to open')
})

it('UnavailableServerMetricsStoreV5 query methods reject with the store reason', async () => {
  const store = new UnavailableServerMetricsStoreV5('backend down')
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
