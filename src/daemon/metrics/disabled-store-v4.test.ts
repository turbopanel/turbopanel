import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSampleV4 } from './contract-v4.ts'
import { DisabledServerMetricsStoreV4 } from './disabled-store-v4.ts'
import { UnavailableServerMetricsStoreV4 } from './store-selection-core.ts'
import type { AuthenticatedMetricsSampleV4 } from './types-v4.ts'

const NULL_HOST = {
  cpu: {
    busyPercent: null,
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
}

const sample: AuthenticatedMetricsSampleV4 = {
  ...buildMetricsSampleV4({
    metadata: {
      version: 4,
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

it('DisabledServerMetricsStoreV4 writeSample is a no-op', () => {
  const store = new DisabledServerMetricsStoreV4()
  store.writeSample(sample)
})

it('DisabledServerMetricsStoreV4 writeStatusEvent is a no-op', () => {
  const store = new DisabledServerMetricsStoreV4()
  store.writeStatusEvent({
    serverId: 'srv-1',
    connected: true,
    reason: 'connect',
    at: '2026-01-01T00:00:00.000Z',
  })
})

it('UnavailableServerMetricsStoreV4 writeSample is a no-op', () => {
  const store = new UnavailableServerMetricsStoreV4('backend down')
  store.writeSample(sample)
})

it('UnavailableServerMetricsStoreV4 writeStatusEvent is a no-op', () => {
  const store = new UnavailableServerMetricsStoreV4('backend down')
  store.writeStatusEvent({
    serverId: 'srv-1',
    connected: false,
    reason: 'disconnect',
    at: '2026-01-01T00:00:00.000Z',
  })
})

it('UnavailableServerMetricsStoreV4 carries its reason', () => {
  const store = new UnavailableServerMetricsStoreV4('DuckDB failed to open')
  assertEquals(store.reason, 'DuckDB failed to open')
})
