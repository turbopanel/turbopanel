/**
 * Counter-reset end-to-end (control-plane half). Counter-reset *detection*
 * is entirely the daemon's job (`turbopaneld`'s `CounterBaselineTracker` —
 * see `collector/rates.ts` / `collector/baseline.ts`, not in this repo): by
 * the time a sample reaches `validation-v4.ts` / `contract-v4.ts` / the
 * stores, a reset interval already reports `null` for the affected
 * rate/counter-derived fields (confirmed by reading `validation-v4.ts`,
 * which is a pure wire-format validator with no baseline/reset concept of
 * its own — `sanitizeFinite`/`sanitizeMetricValueV4` only ever pass a
 * missing reading through as `null`, never fabricate a value or coerce it
 * to `0`).
 *
 * This file's job is the control-plane half of that contract: push two
 * samples through `buildMetricsSampleV4` -> DuckDB `writeSample` with a
 * `bootGeneration` bump between them (simulating a reboot) where the second
 * sample's rate-derived NIC and disk-throughput fields are `null` (what the
 * daemon would emit for the reset interval) while unrelated fields keep
 * real values, then assert the stored/queried series shows a real gap
 * (`null`) at the reset boundary — never `0`, never a fabricated/
 * interpolated delta, never the AE sentinel — and that adjacent samples on
 * either side are unaffected.
 */
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSampleV4, type MetricsSampleV4Input } from './contract-v4.ts'
import type { AuthenticatedMetricsSampleV4 } from './types-v4.ts'
import { AE_V4_MISSING_METRIC_SENTINEL } from './backends/cloudflare/field-map-v4.ts'
import { DuckDbParquetServerMetricsStore } from './backends/duckdb/store.ts'

const SERVER_ID = '11111111-2222-4333-8444-555555555555'
const BASE_MS = Date.UTC(2026, 5, 2)
const INTERVAL_SECONDS = 60

function inputForTick(opts: {
  sequence: number
  atMs: number
  bootGeneration: number
  topologyGeneration?: number
  diskReadBytesPerSecond: number | null
  nicReceiveBytesPerSecond: number | null
}): MetricsSampleV4Input {
  return {
    metadata: {
      version: 4,
      sampledAt: new Date(opts.atMs).toISOString(),
      intervalSeconds: INTERVAL_SECONDS,
      sequence: opts.sequence,
      collectionMode: 'baseline',
      topologyGeneration: opts.topologyGeneration ?? 1,
      bootGeneration: opts.bootGeneration,
    },
    host: {
      cpu: {
        busyPercent: 15,
        userPercent: null,
        systemPercent: null,
        iowaitPercent: null,
        stealPercent: null,
        softirqPercent: null,
        pressureSomePercent: null,
        maxCoreBusyPercent: null,
        procsRunning: null,
        procsBlocked: null,
        processCount: null,
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
        // Rate-derived, counter-backed — the field that goes null on a reset.
        diskReadBytesPerSecond: opts.diskReadBytesPerSecond,
        diskWriteBytesPerSecond: null,
        diskReadLatencyMs: null,
        diskWriteLatencyMs: null,
        maxBlockDeviceUtilPercent: null,
        // Not counter-derived — must survive a reset untouched.
        rootFilesystemAvailableBytes: 500_000,
        rootFilesystemFreeInodes: null,
      },
      network: { tcpRetransmitPercent: null, softnetDropsPerSecond: null },
    },
    networks: [
      {
        deviceId: 'eth0',
        receiveBytesPerSecond: opts.nicReceiveBytesPerSecond,
        transmitBytesPerSecond:
          opts.nicReceiveBytesPerSecond === null ? null : opts.nicReceiveBytesPerSecond + 1,
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
  }
}

function authenticate(input: MetricsSampleV4Input): AuthenticatedMetricsSampleV4 {
  const built = buildMetricsSampleV4(input)
  return {
    ...built,
    serverId: SERVER_ID,
    receivedAt: input.metadata.sampledAt,
  }
}

it('counter-reset end-to-end: a bootGeneration bump with null rate fields reports a real gap, not a fabricated delta or the AE sentinel', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-counter-reset-e2e-',
  })
  const store = new DuckDbParquetServerMetricsStore({ metricsDir }, { writeBatchMaxRows: 1 })
  try {
    // Tick 1: pre-reboot, normal counters, bootGeneration 1.
    await store.writeSample(
      authenticate(
        inputForTick({
          sequence: 1,
          atMs: BASE_MS,
          bootGeneration: 1,
          diskReadBytesPerSecond: 1000,
          nicReceiveBytesPerSecond: 500,
        })
      )
    )

    // Tick 2: the reboot interval itself — bootGeneration bumps, rate fields
    // the daemon can't safely derive across a counter reset are null; the
    // non-counter field (rootFilesystemAvailableBytes) is still reported.
    await store.writeSample(
      authenticate(
        inputForTick({
          sequence: 2,
          atMs: BASE_MS + INTERVAL_SECONDS * 1000,
          bootGeneration: 2,
          diskReadBytesPerSecond: null,
          nicReceiveBytesPerSecond: null,
        })
      )
    )

    // Tick 3: post-reboot, counters re-baselined and reporting again.
    await store.writeSample(
      authenticate(
        inputForTick({
          sequence: 3,
          atMs: BASE_MS + INTERVAL_SECONDS * 2000,
          bootGeneration: 2,
          diskReadBytesPerSecond: 200,
          nicReceiveBytesPerSecond: 80,
        })
      )
    )

    const from = new Date(BASE_MS - 60_000).toISOString()
    const to = new Date(BASE_MS + INTERVAL_SECONDS * 2000 + 60_000).toISOString()

    const hostSeries = await store.queryHostSeries({
      serverId: SERVER_ID,
      metrics: ['host.storage.diskReadBytesPerSecond', 'host.storage.rootFilesystemAvailableBytes'],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    })
    assertEquals(hostSeries.points.length, 3)
    const byAt = new Map(hostSeries.points.map((p) => [p.at, p.values]))

    const tick1At = new Date(BASE_MS).toISOString()
    const tick2At = new Date(BASE_MS + INTERVAL_SECONDS * 1000).toISOString()
    const tick3At = new Date(BASE_MS + INTERVAL_SECONDS * 2000).toISOString()

    assertEquals(byAt.get(tick1At)!['host.storage.diskReadBytesPerSecond'], 1000)
    // Reset interval: a real null gap, never 0, never a fabricated delta.
    assertEquals(byAt.get(tick2At)!['host.storage.diskReadBytesPerSecond'], null)
    assertEquals(
      byAt.get(tick2At)!['host.storage.diskReadBytesPerSecond'] === AE_V4_MISSING_METRIC_SENTINEL,
      false
    )
    assertEquals(byAt.get(tick3At)!['host.storage.diskReadBytesPerSecond'], 200)

    // Non-counter field on the same reset-interval sample survives untouched.
    assertEquals(byAt.get(tick2At)!['host.storage.rootFilesystemAvailableBytes'], 500_000)
    assertEquals(byAt.get(tick1At)!['host.storage.rootFilesystemAvailableBytes'], 500_000)
    assertEquals(byAt.get(tick3At)!['host.storage.rootFilesystemAvailableBytes'], 500_000)

    const networkSeries = await store.queryEntitySeries({
      serverId: SERVER_ID,
      family: 'network',
      entityIds: ['eth0'],
      metrics: ['receiveBytesPerSecond', 'transmitBytesPerSecond'],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    })
    const eth0 = networkSeries.entities.find((e) => e.entityId === 'eth0')!
    assertEquals(eth0.points.length, 3)
    const byNetAt = new Map(eth0.points.map((p) => [p.at, p.values]))
    assertEquals(byNetAt.get(tick1At)!.receiveBytesPerSecond, 500)
    assertEquals(byNetAt.get(tick2At)!.receiveBytesPerSecond, null)
    assertEquals(byNetAt.get(tick2At)!.transmitBytesPerSecond, null)
    assertEquals(byNetAt.get(tick3At)!.receiveBytesPerSecond, 80)
  } finally {
    await store.close()
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('counter-reset end-to-end: a topologyGeneration bump with no reboot and continuing counters reports a continuous series, never a fabricated discontinuity', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-counter-reset-e2e-',
  })
  const store = new DuckDbParquetServerMetricsStore({ metricsDir }, { writeBatchMaxRows: 1 })
  try {
    // Tick 1: pre-topology-change, normal counters, topologyGeneration 1.
    await store.writeSample(
      authenticate(
        inputForTick({
          sequence: 1,
          atMs: BASE_MS,
          bootGeneration: 1,
          topologyGeneration: 1,
          diskReadBytesPerSecond: 1000,
          nicReceiveBytesPerSecond: 500,
        })
      )
    )

    // Tick 2: a slot reorder / GPU swap — topologyGeneration bumps, but
    // bootGeneration is unchanged and the daemon's own counters kept
    // counting the same logical device without interruption, so its
    // rate-derived fields are real values, never the daemon-emitted `null`
    // a genuine reset produces.
    await store.writeSample(
      authenticate(
        inputForTick({
          sequence: 2,
          atMs: BASE_MS + INTERVAL_SECONDS * 1000,
          bootGeneration: 1,
          topologyGeneration: 2,
          diskReadBytesPerSecond: 1200,
          nicReceiveBytesPerSecond: 560,
        })
      )
    )

    // Tick 3: topology stays at the new generation, counters keep climbing.
    await store.writeSample(
      authenticate(
        inputForTick({
          sequence: 3,
          atMs: BASE_MS + INTERVAL_SECONDS * 2000,
          bootGeneration: 1,
          topologyGeneration: 2,
          diskReadBytesPerSecond: 1400,
          nicReceiveBytesPerSecond: 620,
        })
      )
    )

    const from = new Date(BASE_MS - 60_000).toISOString()
    const to = new Date(BASE_MS + INTERVAL_SECONDS * 2000 + 60_000).toISOString()

    const hostSeries = await store.queryHostSeries({
      serverId: SERVER_ID,
      metrics: ['host.storage.diskReadBytesPerSecond', 'host.storage.rootFilesystemAvailableBytes'],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    })
    assertEquals(hostSeries.points.length, 3)
    const byAt = new Map(hostSeries.points.map((p) => [p.at, p.values]))

    const tick1At = new Date(BASE_MS).toISOString()
    const tick2At = new Date(BASE_MS + INTERVAL_SECONDS * 1000).toISOString()
    const tick3At = new Date(BASE_MS + INTERVAL_SECONDS * 2000).toISOString()

    // The topology-change tick carries a real, continuing value — never a
    // null gap, and never the AE sentinel standing in for a fabricated reset.
    assertEquals(byAt.get(tick1At)!['host.storage.diskReadBytesPerSecond'], 1000)
    assertEquals(byAt.get(tick2At)!['host.storage.diskReadBytesPerSecond'], 1200)
    assertEquals(
      byAt.get(tick2At)!['host.storage.diskReadBytesPerSecond'] === AE_V4_MISSING_METRIC_SENTINEL,
      false
    )
    assertEquals(byAt.get(tick3At)!['host.storage.diskReadBytesPerSecond'], 1400)

    assertEquals(byAt.get(tick1At)!['host.storage.rootFilesystemAvailableBytes'], 500_000)
    assertEquals(byAt.get(tick2At)!['host.storage.rootFilesystemAvailableBytes'], 500_000)
    assertEquals(byAt.get(tick3At)!['host.storage.rootFilesystemAvailableBytes'], 500_000)

    const networkSeries = await store.queryEntitySeries({
      serverId: SERVER_ID,
      family: 'network',
      entityIds: ['eth0'],
      metrics: ['receiveBytesPerSecond', 'transmitBytesPerSecond'],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    })
    const eth0 = networkSeries.entities.find((e) => e.entityId === 'eth0')!
    assertEquals(eth0.points.length, 3)
    const byNetAt = new Map(eth0.points.map((p) => [p.at, p.values]))
    // Same device identity (`eth0`) throughout — the slot reorder never
    // shows up as a discontinuity on its rate series.
    assertEquals(byNetAt.get(tick1At)!.receiveBytesPerSecond, 500)
    assertEquals(byNetAt.get(tick2At)!.receiveBytesPerSecond, 560)
    assertEquals(byNetAt.get(tick3At)!.receiveBytesPerSecond, 620)
  } finally {
    await store.close()
    await Deno.remove(metricsDir, { recursive: true })
  }
})
