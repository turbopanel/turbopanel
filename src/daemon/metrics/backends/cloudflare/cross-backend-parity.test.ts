/**
 * Cross-backend parity — DuckDB vs. Cloudflare Analytics Engine — for the v5
 * contract. Supersedes `write-path-parity.test.ts`'s role for v5 (that file
 * stays as the v3 record; it is deleted in the v3-removal phase, not here).
 *
 * This exercises the actual read path on both backends, not just the
 * write-path packer: identical logical samples are written through (a)
 * `DuckDbParquetServerMetricsStore.writeSample` and (b)
 * `CloudflareAnalyticsEngineServerMetricsStore.writeSample` backed by
 * `createFakeAnalyticsEngine` (`testing/fake-analytics-engine.ts`) — an
 * in-memory DuckDB table shaped like the real AE dataset that the real
 * `queryXViaSqlApi` SQL text executes against, so the AE side is a genuine
 * executed read path, not a canned/decoded stand-in. Both stores are then
 * queried back through the exact same `ServerMetricsStore` methods and
 * compared: series values, sample counts, gap counts, `latestAt`, uptime,
 * and events.
 *
 * Includes a mid-stream topology-generation bump (a GPU added, so both
 * `slotMapping.gpuPageOrder` and — since a GPU's thermals are entity-joined
 * `hardware.physical` signals — `slotMapping.hardwareSignalPageOrder` grow,
 * and an existing GPU's page/slot assignment is recomputed) to prove parity
 * holds across a generation change too, not just within one static
 * topology.
 */
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSample, type MetricsSampleInput } from '../../contract.ts'
import {
  resolveMetricsCapabilityPlan,
  truncateSampleToCapabilityPlan,
} from '../../capability-plan.ts'
import type { AuthenticatedMetricsSample, SlotMapping } from '../../types.ts'
import type { ServerStatusEvent } from '../../types.ts'
import { DuckDbParquetServerMetricsStore } from '../duckdb/store.ts'
import { CloudflareAnalyticsEngineServerMetricsStore } from './store.ts'
import { createFakeAnalyticsEngine } from '../../testing/fake-analytics-engine.ts'

const SERVER_ID = '11111111-2222-4333-8444-555555555555'
const BASE_MS = Date.UTC(2026, 5, 2)
const INTERVAL_SECONDS = 60

function emptySlotMapping(overrides: Partial<SlotMapping> = {}): SlotMapping {
  return {
    normalNicSlots: [],
    fabricDeviceIds: [],
    rootFilesystemId: null,
    gpuPageOrder: [],
    blockPageOrder: [],
    filesystemPageOrder: [],
    hardwareSignalPageOrder: [],
    ...overrides,
  }
}

function nic(deviceId: string, seed: number) {
  return {
    deviceId,
    receiveBytesPerSecond: seed,
    transmitBytesPerSecond: seed + 1,
    receiveErrorsPerSecond: 0,
    transmitErrorsPerSecond: 0,
    receiveDropsPerSecond: 0,
    transmitDropsPerSecond: 0,
  }
}

function gpu(gpuId: string, seed: number) {
  return {
    gpuId,
    utilizationPercent: seed,
    memoryUsedBytes: seed * 1000,
    memoryActivityPercent: seed,
    pcieReceiveBytesPerSecond: seed * 10,
    pcieTransmitBytesPerSecond: seed * 11,
    throttlePercent: 0,
  }
}

/**
 * A GPU's temperature / memory temperature / power are `hardware.physical`
 * signals keyed to the owning GPU, not `gpu` fields — 3 per GPU, ids shaped
 * like the daemon's `gpuSignalId`. Included here so the generation bump
 * below grows `hardwareSignals` (3 -> 6) as well as `gpus`, and both
 * backends have to agree on the added signal exactly as they do on the added
 * GPU.
 */
const GPU_SIGNAL_KINDS = ['temperature', 'memory-temperature', 'power'] as const

function gpuSignalId(gpuId: string, kind: string): string {
  return `signal:gpu:${gpuId}:${kind}`
}

function gpuSignals(gpus: ReturnType<typeof gpu>[]) {
  return gpus.flatMap((entry) =>
    GPU_SIGNAL_KINDS.map((kind, index) => ({
      signalId: gpuSignalId(entry.gpuId, kind),
      kind: kind === 'power' ? 'power' : 'temperature',
      value: entry.utilizationPercent + index,
    }))
  )
}

function gpuSignalPageOrder(gpuIds: readonly string[]): string[] {
  return gpuIds
    .flatMap((gpuId) => GPU_SIGNAL_KINDS.map((kind) => gpuSignalId(gpuId, kind)))
    .sort((a, b) => a.localeCompare(b))
}

function inputForTick(opts: {
  sequence: number
  atMs: number
  topologyGeneration: number
  cpuBusy: number
  routerBackendsUp: number
  hostingUsedBytes: number
  gpus: ReturnType<typeof gpu>[]
  events?: MetricsSampleInput['events']
}): MetricsSampleInput {
  return {
    metadata: {
      version: 6,
      sampledAt: new Date(opts.atMs).toISOString(),
      intervalSeconds: INTERVAL_SECONDS,
      sequence: opts.sequence,
      topologyGeneration: opts.topologyGeneration,
      bootGeneration: 1,
    },
    host: {
      cpu: {
        busyPercent: opts.cpuBusy,
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
    },
    networks: [nic('eth0', 1), nic('eth1', 2)],
    filesystems: [],
    blockDevices: [],
    gpus: opts.gpus,
    hardwareSignals: gpuSignals(opts.gpus),
    ingressSources: [],
    databaseProxies: [],
    events: opts.events ?? [],
    // `managed.router` is host-wide and singleton — no entity id — so both
    // backends must resolve it on the *host*-series path (AE by family +
    // double index like `host.diagnostics`; DuckDB by a second left join on
    // its own singleton table). That divergence in physical shape is exactly
    // what this fixture exists to pin.
    router: {
      backendsUp: opts.routerBackendsUp,
      backendsTotal: 4,
      servicesTotal: 2,
      routersTotal: 3,
      retries: 0,
      backendErrors5xx: 0,
      backendLatencyMsAvg: 12,
      backendRequests: 100,
      httpOpenConnections: 5,
      configReloads: 1,
      configLastReloadAgeSeconds: 90,
      tlsCertSoonestExpiryDays: 45,
    },
    // `managed.storage` / `managed.docker` are the other two host-wide
    // singletons, and their physical shapes diverge the most between
    // backends: AE packs both onto their own 19-slot rows (with the nested
    // per-engine groups flattened into contiguous slots), while DuckDB writes
    // `server_storage_samples` — which also carries a `docker_*`-prefixed
    // copy of the breakdown — plus a separate `server_docker_samples`. The
    // queryable series must still agree field for field.
    storage: {
      hostingUsedBytes: opts.hostingUsedBytes,
      backupUsedBytes: 2048,
      dockerUsedBytes: 8192,
      logsUsedBytes: 512,
      hostingFreeBytes: 1_000_000,
      backupFreeBytes: 2_000_000,
      logsFreeBytes: 3_000_000,
      postgres: {
        instancesRunning: 2,
        instancesHealthy: 1,
        connectionsUsed: 30,
        connectionsMax: 100,
      },
      mysql: {
        instancesRunning: null,
        instancesHealthy: null,
        connectionsUsed: null,
        connectionsMax: null,
      },
      mariadb: {
        instancesRunning: 1,
        instancesHealthy: 1,
        connectionsUsed: 5,
        connectionsMax: 50,
      },
    },
    dockerUsage: {
      layersBytes: 6000,
      imagesCount: 4,
      imagesReclaimableBytes: 1000,
      containersBytes: 1200,
      containersCount: 3,
      volumesBytes: 900,
      volumesCount: 2,
      volumesReclaimableBytes: 100,
      buildCacheBytes: 92,
      buildCacheReclaimableBytes: 92,
    },
  }
}

it('cross-backend parity: DuckDB and Cloudflare AE agree on host series, entity series, summary, status, and events', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-cross-backend-parity-',
  })
  const duckStore = new DuckDbParquetServerMetricsStore(
    { metricsDir },
    {
      writeBatchMaxRows: 1,
    }
  )
  const fakeAe = await createFakeAnalyticsEngine()
  const aeStore = new CloudflareAnalyticsEngineServerMetricsStore(fakeAe.dataset, {
    sql: fakeAe.sqlConfig,
  })
  // 'physical', not 'virtual': a virtual machine's
  // `physicalHardwareSignalSlots` is 0, which would truncate every GPU signal
  // away before either store saw it and quietly reduce this to a
  // GPU-fields-only parity check.
  const plan = resolveMetricsCapabilityPlan(
    'physical',
    undefined,
    {
      gpuSlots: 2,
    },
    'hosted'
  )
  try {
    // Tick 1: generation 1, one GPU.
    const tick1Input = inputForTick({
      sequence: 1,
      atMs: BASE_MS,
      topologyGeneration: 1,
      cpuBusy: 12,
      routerBackendsUp: 3,
      hostingUsedBytes: 4096,
      gpus: [gpu('gpu0', 5)],
      events: [
        {
          eventId: '11111111-1111-4111-8111-111111111111',
          at: new Date(BASE_MS).toISOString(),
          kind: 'oom_kill',
          severity: 'critical',
          payload: { pid: 1234 },
        },
      ],
    })
    const tick1Built = truncateSampleToCapabilityPlan(buildMetricsSample(tick1Input), plan)
    const tick1Sample: AuthenticatedMetricsSample = {
      ...tick1Built,
      serverId: SERVER_ID,
      receivedAt: tick1Input.metadata.sampledAt,
    }
    const tick1SlotMapping = emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      gpuPageOrder: ['gpu0'],
      hardwareSignalPageOrder: gpuSignalPageOrder(['gpu0']),
    })
    await duckStore.writeSample(tick1Sample)
    fakeAe.setNow(BASE_MS)
    aeStore.writeSample(tick1Sample, tick1SlotMapping)

    // Tick 2: generation 2 (a GPU added — the bump), two GPUs. Deliberately
    // skips tick 1 + 1 interval so the queried range also has a real gap on
    // both backends (gapCount parity, not just point-value parity).
    const tick2AtMs = BASE_MS + INTERVAL_SECONDS * 1000 * 2
    const tick2Input = inputForTick({
      sequence: 2,
      atMs: tick2AtMs,
      topologyGeneration: 2,
      cpuBusy: 34,
      routerBackendsUp: 1,
      hostingUsedBytes: 8192,
      gpus: [gpu('gpu0', 7), gpu('gpu1', 9)],
    })
    const tick2Built = truncateSampleToCapabilityPlan(buildMetricsSample(tick2Input), plan)
    const tick2Sample: AuthenticatedMetricsSample = {
      ...tick2Built,
      serverId: SERVER_ID,
      receivedAt: tick2Input.metadata.sampledAt,
    }
    const tick2SlotMapping = emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      gpuPageOrder: ['gpu0', 'gpu1'],
      hardwareSignalPageOrder: gpuSignalPageOrder(['gpu0', 'gpu1']),
    })
    await duckStore.writeSample(tick2Sample)
    fakeAe.setNow(tick2AtMs)
    aeStore.writeSample(tick2Sample, tick2SlotMapping)

    const statusEvent: ServerStatusEvent = {
      serverId: SERVER_ID,
      at: new Date(BASE_MS).toISOString(),
      connected: true,
      reason: 'connect',
    }
    await duckStore.writeStatusEvent(statusEvent)
    fakeAe.setNow(BASE_MS)
    aeStore.writeStatusEvent(statusEvent)

    const from = new Date(BASE_MS - 60_000).toISOString()
    const to = new Date(tick2AtMs + 60_000).toISOString()

    // --- host series: values, sample count, gap count all agree ---
    const hostQuery = {
      serverId: SERVER_ID,
      metrics: ['host.cpu.busyPercent'],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    }
    const duckHost = await duckStore.queryHostSeries(hostQuery)
    const aeHost = await aeStore.queryHostSeries(hostQuery)
    assertEquals(aeHost.gapCount, duckHost.gapCount, 'gapCount must agree')
    assertEquals(aeHost.sampleCount, duckHost.sampleCount, 'sampleCount must agree')
    const duckHostByAt = new Map(
      duckHost.points.map((p) => [p.at, p.values['host.cpu.busyPercent']])
    )
    const aeHostByAt = new Map(aeHost.points.map((p) => [p.at, p.values['host.cpu.busyPercent']]))
    assertEquals(
      aeHostByAt.get(tick1Sample.metadata.sampledAt),
      duckHostByAt.get(tick1Sample.metadata.sampledAt)
    )
    assertEquals(
      aeHostByAt.get(tick2Sample.metadata.sampledAt),
      duckHostByAt.get(tick2Sample.metadata.sampledAt)
    )
    assertEquals(aeHostByAt.get(tick1Sample.metadata.sampledAt), tick1Input.host.cpu.busyPercent)

    // --- managed.router: the host-wide singleton family, queried the same way
    // host scalars are on both backends despite entirely different physical
    // storage (AE double slot vs. a joined DuckDB table). ---
    const routerQuery = {
      serverId: SERVER_ID,
      // Both aggregations: two `weighted-average` gauges and one `delta-sum`
      // counter, since AE resolves those through different SQL expressions
      // (`weightedAvgExpressionForColumn` vs `deltaSumExpressionForColumn`)
      // than DuckDB's plain column aggregation.
      metrics: [
        'router.backendsUp',
        'router.tlsCertSoonestExpiryDays',
        'router.configReloads',
      ],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    }
    const duckRouter = await duckStore.queryHostSeries(routerQuery)
    const aeRouter = await aeStore.queryHostSeries(routerQuery)
    const routerValues = (
      result: Awaited<ReturnType<typeof duckStore.queryHostSeries>>,
      at: string,
      field: string
    ) => result.points.find((point) => point.at === at)?.values[field] ?? null
    for (
      const field of [
        'router.backendsUp',
        'router.tlsCertSoonestExpiryDays',
        'router.configReloads',
      ]
    ) {
      for (const sample of [tick1Sample, tick2Sample]) {
        assertEquals(
          routerValues(aeRouter, sample.metadata.sampledAt, field),
          routerValues(duckRouter, sample.metadata.sampledAt, field),
          `${field} must agree across backends at ${sample.metadata.sampledAt}`
        )
      }
    }
    // Pin the actual value too, not just agreement — two backends resolving
    // the same wrong slot would otherwise pass.
    assertEquals(
      routerValues(aeRouter, tick1Sample.metadata.sampledAt, 'router.backendsUp'),
      3
    )
    assertEquals(
      routerValues(aeRouter, tick2Sample.metadata.sampledAt, 'router.backendsUp'),
      1
    )
    assertEquals(
      routerValues(aeRouter, tick1Sample.metadata.sampledAt, 'router.tlsCertSoonestExpiryDays'),
      45
    )
    // delta-sum: one sample of 1 reload per bucket, summed rather than averaged.
    assertEquals(routerValues(aeRouter, tick1Sample.metadata.sampledAt, 'router.configReloads'), 1)

    // --- managed.storage / managed.docker: the other two host-wide
    // singletons. Covers a flat storage gauge, a *nested* per-engine reading
    // (flattened to `storage.postgresConnectionsUsed` on both backends), an
    // engine group that reported nothing, and a Docker breakdown field the
    // two backends store in structurally different tables. ---
    const storageMetrics = [
      'storage.hostingUsedBytes',
      'storage.postgresConnectionsUsed',
      'storage.mysqlInstancesRunning',
      'dockerUsage.layersBytes',
      'dockerUsage.buildCacheReclaimableBytes',
    ]
    const storageQuery = {
      serverId: SERVER_ID,
      metrics: storageMetrics,
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    }
    const duckStorage = await duckStore.queryHostSeries(storageQuery)
    const aeStorage = await aeStore.queryHostSeries(storageQuery)
    const storageValues = (
      result: Awaited<ReturnType<typeof duckStore.queryHostSeries>>,
      at: string,
      field: string
    ) => result.points.find((point) => point.at === at)?.values[field] ?? null
    for (const field of storageMetrics) {
      for (const sample of [tick1Sample, tick2Sample]) {
        assertEquals(
          storageValues(aeStorage, sample.metadata.sampledAt, field),
          storageValues(duckStorage, sample.metadata.sampledAt, field),
          `${field} must agree across backends at ${sample.metadata.sampledAt}`
        )
      }
    }
    // Pin the values too — agreeing on the same wrong slot would otherwise pass.
    assertEquals(
      storageValues(aeStorage, tick1Sample.metadata.sampledAt, 'storage.hostingUsedBytes'),
      4096
    )
    assertEquals(
      storageValues(aeStorage, tick2Sample.metadata.sampledAt, 'storage.hostingUsedBytes'),
      8192
    )
    assertEquals(
      storageValues(aeStorage, tick1Sample.metadata.sampledAt, 'storage.postgresConnectionsUsed'),
      30
    )
    // An engine that reported nothing stays null on both backends, never 0.
    assertEquals(
      storageValues(aeStorage, tick1Sample.metadata.sampledAt, 'storage.mysqlInstancesRunning'),
      null
    )
    assertEquals(
      storageValues(aeStorage, tick1Sample.metadata.sampledAt, 'dockerUsage.layersBytes'),
      6000
    )

    // --- entity series: gpu0 (both ticks) and gpu1 (only from the generation bump) ---
    const gpu0Query = {
      serverId: SERVER_ID,
      family: 'gpu' as const,
      entityIds: ['gpu0'],
      metrics: ['utilizationPercent'],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    }
    const duckGpu0 = await duckStore.queryEntitySeries(gpu0Query)
    const aeGpu0 = await aeStore.queryEntitySeries(gpu0Query)
    const duckGpu0Entity = duckGpu0.entities.find((e) => e.entityId === 'gpu0')!
    const aeGpu0Entity = aeGpu0.entities.find((e) => e.entityId === 'gpu0')!
    const duckGpu0ByAt = new Map(
      duckGpu0Entity.points.map((p) => [p.at, p.values.utilizationPercent])
    )
    const aeGpu0ByAt = new Map(aeGpu0Entity.points.map((p) => [p.at, p.values.utilizationPercent]))
    assertEquals(
      aeGpu0ByAt.get(tick1Sample.metadata.sampledAt),
      duckGpu0ByAt.get(tick1Sample.metadata.sampledAt)
    )
    assertEquals(
      aeGpu0ByAt.get(tick2Sample.metadata.sampledAt),
      duckGpu0ByAt.get(tick2Sample.metadata.sampledAt)
    )

    const gpu1Query = { ...gpu0Query, entityIds: ['gpu1'] }
    const duckGpu1 = await duckStore.queryEntitySeries(gpu1Query)
    const aeGpu1 = await aeStore.queryEntitySeries(gpu1Query)
    const duckGpu1Entity = duckGpu1.entities.find((e) => e.entityId === 'gpu1')!
    const aeGpu1Entity = aeGpu1.entities.find((e) => e.entityId === 'gpu1')!
    assertEquals(aeGpu1Entity.points.length, duckGpu1Entity.points.length)
    assertEquals(aeGpu1Entity.points.length, 1, 'gpu1 only exists from the generation-2 tick')
    assertEquals(
      aeGpu1Entity.points[0]!.values.utilizationPercent,
      duckGpu1Entity.points[0]!.values.utilizationPercent
    )

    // --- hardware.physical: the entity-joined GPU signals A2 moved off the
    //     `gpu` row. gpu0's temperature spans both ticks; gpu1's only exists
    //     from the generation bump, same as its `gpu` row. ---
    assertEquals(tick1Sample.hardwareSignals.length, 3, 'gpu0 contributes 3 signals')
    assertEquals(tick2Sample.hardwareSignals.length, 6, 'a second GPU adds 3 more')

    const signalQuery = {
      serverId: SERVER_ID,
      family: 'hardware.physical' as const,
      entityIds: ['signal:gpu:gpu0:temperature', 'signal:gpu:gpu1:temperature'],
      metrics: ['value'],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    }
    const duckSignals = await duckStore.queryEntitySeries(signalQuery)
    const aeSignals = await aeStore.queryEntitySeries(signalQuery)
    const duckGpu0Temp = duckSignals.entities.find(
      (e) => e.entityId === 'signal:gpu:gpu0:temperature'
    )!
    const aeGpu0Temp = aeSignals.entities.find((e) => e.entityId === 'signal:gpu:gpu0:temperature')!
    assertEquals(aeGpu0Temp.points.length, duckGpu0Temp.points.length)
    assertEquals(aeGpu0Temp.points.length, 2, 'gpu0 temperature exists in both ticks')
    const duckTempByAt = new Map(duckGpu0Temp.points.map((p) => [p.at, p.values.value]))
    const aeTempByAt = new Map(aeGpu0Temp.points.map((p) => [p.at, p.values.value]))
    assertEquals(
      aeTempByAt.get(tick1Sample.metadata.sampledAt),
      duckTempByAt.get(tick1Sample.metadata.sampledAt)
    )
    assertEquals(
      aeTempByAt.get(tick2Sample.metadata.sampledAt),
      duckTempByAt.get(tick2Sample.metadata.sampledAt)
    )

    const duckGpu1Temp = duckSignals.entities.find(
      (e) => e.entityId === 'signal:gpu:gpu1:temperature'
    )!
    const aeGpu1Temp = aeSignals.entities.find((e) => e.entityId === 'signal:gpu:gpu1:temperature')!
    assertEquals(aeGpu1Temp.points.length, duckGpu1Temp.points.length)
    assertEquals(aeGpu1Temp.points.length, 1, 'gpu1 signals only exist from the generation-2 tick')
    assertEquals(aeGpu1Temp.points[0]!.values.value, duckGpu1Temp.points[0]!.values.value)

    // --- host summary: sample count + latestAt agree ---
    const summaryQuery = { serverId: SERVER_ID, from, to }
    const duckSummary = await duckStore.queryHostSummary(summaryQuery)
    const aeSummary = await aeStore.queryHostSummary(summaryQuery)
    assertEquals(aeSummary.sampleCount, duckSummary.sampleCount)
    assertEquals(aeSummary.latestAt, duckSummary.latestAt)

    // --- status history: uptime split agrees ---
    const statusQuery = { serverId: SERVER_ID, from, to }
    const duckStatus = await duckStore.queryStatusHistory(statusQuery)
    const aeStatus = await aeStore.queryStatusHistory(statusQuery)
    assertEquals(aeStatus.uptimeSeconds, duckStatus.uptimeSeconds)
    assertEquals(aeStatus.downtimeSeconds, duckStatus.downtimeSeconds)
    assertEquals(aeStatus.uptimePercent, duckStatus.uptimePercent)
    assertEquals(aeStatus.events.length, duckStatus.events.length)

    // --- metric events: the tick-1 oom_kill event round-trips identically ---
    const eventsQuery = { serverId: SERVER_ID, from, to }
    const duckEvents = await duckStore.queryMetricEvents(eventsQuery)
    const aeEvents = await aeStore.queryMetricEvents(eventsQuery)
    assertEquals(aeEvents.events.length, duckEvents.events.length)
    assertEquals(aeEvents.events.length, 1)
    assertEquals(aeEvents.events[0]!.kind, duckEvents.events[0]!.kind)
    assertEquals(aeEvents.events[0]!.severity, duckEvents.events[0]!.severity)
    assertEquals(aeEvents.events[0]!.at, duckEvents.events[0]!.at)
  } finally {
    await duckStore.close()
    await fakeAe.close()
    await Deno.remove(metricsDir, { recursive: true })
  }
})
