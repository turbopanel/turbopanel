/**
 * Cadence-tier decimation: which families are written on which sample.
 *
 * The invariant under test is that the rule is stateless and boundary-based,
 * so the same code produces "every sample" at the 60 s baseline for a 60-tier
 * family and "every sixth" in a 10 s live session, without either path
 * knowing which mode it is in.
 */
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  cadenceTierIsDueV5,
  decimateSampleToCadenceTiersV5,
  METRICS_CADENCE_TIERS_V5,
  METRICS_FAST_TIER_SECONDS_V5,
  METRICS_SLOW_TIER_SECONDS_V5,
} from './cadence-tiers-v5.ts'
import { buildMetricsSampleV5 } from './contract-v5.ts'
import type { MetricsSampleV5 } from './contract-v5.ts'
import type { SlotMapping } from './types-v5.ts'
import { representativeMachineFixtures } from './testing/representative-machines.ts'
import { buildMetricsDataPointsV5 } from './backends/cloudflare/field-map-v5.ts'

const SERVER_ID = '11111111-2222-4333-8444-555555555555'

const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0)

/** How many of `count` consecutive samples at `intervalSeconds` a tier is due on. */
function dueCount(tier: number, intervalSeconds: number, count: number): number {
  let due = 0
  for (let i = 0; i < count; i += 1) {
    if (cadenceTierIsDueV5(tier, BASE_MS + i * intervalSeconds * 1000, intervalSeconds)) {
      due += 1
    }
  }
  return due
}

it('a 60-tier family writes on every sample at the 60 s baseline', () => {
  assertEquals(dueCount(METRICS_FAST_TIER_SECONDS_V5, 60, 10), 10)
})

it('a 60-tier family writes once per minute in a 10 s live session, not six times', () => {
  // 60 samples at 10 s spans 10 minutes -> 10 writes, a 6x reduction. This is
  // what stops a live lease multiplying every family by six.
  assertEquals(dueCount(METRICS_FAST_TIER_SECONDS_V5, 10, 60), 10)
})

it('a 300-tier family writes once every five minutes at the 60 s baseline', () => {
  assertEquals(dueCount(METRICS_SLOW_TIER_SECONDS_V5, 60, 60), 12)
})

it('a 300-tier family writes once every five minutes in a live session too', () => {
  // 300 samples at 10 s is 50 minutes -> 10 writes.
  assertEquals(dueCount(METRICS_SLOW_TIER_SECONDS_V5, 10, 300), 10)
})

it("the 'every' tier is always due", () => {
  assertEquals(cadenceTierIsDueV5('every', BASE_MS, 10), true)
  assertEquals(cadenceTierIsDueV5('every', BASE_MS + 1234, 10), true)
})

it('an interval at least as long as the tier is always due, never silently skipped', () => {
  assertEquals(cadenceTierIsDueV5(300, BASE_MS + 7, 300), true)
  assertEquals(cadenceTierIsDueV5(300, BASE_MS + 7, 900), true)
})

it('a non-positive or non-finite interval falls back to writing, never to dropping', () => {
  assertEquals(cadenceTierIsDueV5(300, BASE_MS, 0), true)
  assertEquals(cadenceTierIsDueV5(300, BASE_MS, Number.NaN), true)
})

it('delta-sum families are pinned to every sample and must never be decimated', () => {
  // Skipping one of these does not coarsen the series, it drops requests and
  // queries outright. Changing either to a number is a data-loss bug.
  assertEquals(METRICS_CADENCE_TIERS_V5.ingressSources, 'every')
  assertEquals(METRICS_CADENCE_TIERS_V5.databaseProxies, 'every')
})

// ---------------------------------------------------------------------------
// Sample-level decimation
// ---------------------------------------------------------------------------

function fixtureSample(name: string): MetricsSampleV5 {
  const fixture = representativeMachineFixtures().find((f) => f.name === name)
  if (!fixture) throw new Error(`no representative fixture named ${name}`)
  return buildMetricsSampleV5(fixture.input)
}

function atOffset(sample: MetricsSampleV5, offsetSeconds: number): MetricsSampleV5 {
  return {
    ...sample,
    metadata: {
      ...sample.metadata,
      sampledAt: new Date(BASE_MS + offsetSeconds * 1000).toISOString(),
      intervalSeconds: 60,
    },
  }
}

it('keeps every family on a sample that lands on the slow-tier boundary', () => {
  const sample = atOffset(fixtureSample('bare-metal-gpu'), 0)
  const decimated = decimateSampleToCadenceTiersV5(sample)
  assertEquals(decimated.hardwareSignals.length, sample.hardwareSignals.length)
  assertEquals(decimated.gpus.length, sample.gpus.length)
})

it('drops only the slow families on a sample between slow-tier boundaries', () => {
  // 60 s past the boundary: the 60-tier families are still due, the 300-tier
  // ones are not.
  const sample = atOffset(fixtureSample('bare-metal-gpu'), 60)
  const decimated = decimateSampleToCadenceTiersV5(sample)
  assertEquals(decimated.hardwareSignals, [])
  assertEquals(decimated.filesystems, [])
  assertEquals(decimated.gpus.length, sample.gpus.length)
  assertEquals(decimated.blockDevices.length, sample.blockDevices.length)
})

it('never drops the host groups or events', () => {
  const sample = atOffset(fixtureSample('vm-with-event'), 60)
  const decimated = decimateSampleToCadenceTiersV5(sample)
  assertEquals(decimated.host, sample.host)
  assertEquals(decimated.events.length, sample.events.length)
})

it('keeps the two host.io-embedded NIC slots even when the network tier is not due', () => {
  // 10 s live cadence, 10 s past the boundary: the networks tier is not due,
  // but blanking these would blank the host row's own NIC throughput.
  const base = fixtureSample('8-nic')
  const sample: MetricsSampleV5 = {
    ...base,
    metadata: {
      ...base.metadata,
      sampledAt: new Date(BASE_MS + 10_000).toISOString(),
      intervalSeconds: 10,
    },
  }
  const slotMapping: SlotMapping = {
    normalNicSlots: sample.networks.map((n) => n.deviceId),
    fabricDeviceIds: [],
    rootFilesystemId: null,
    gpuPageOrder: [],
    filesystemPageOrder: [],
    blockPageOrder: [],
    hardwareSignalPageOrder: [],
  }
  const decimated = decimateSampleToCadenceTiersV5(sample, slotMapping)
  assertEquals(decimated.networks.length, 2)
  assertEquals(
    decimated.networks.map((n) => n.deviceId),
    slotMapping.normalNicSlots.slice(0, 2)
  )
})

it('falls back to positional NIC embedding when no slot mapping is available', () => {
  const base = fixtureSample('8-nic')
  const sample: MetricsSampleV5 = {
    ...base,
    metadata: {
      ...base.metadata,
      sampledAt: new Date(BASE_MS + 10_000).toISOString(),
      intervalSeconds: 10,
    },
  }
  const decimated = decimateSampleToCadenceTiersV5(sample)
  assertEquals(
    decimated.networks.map((n) => n.deviceId),
    sample.networks.slice(0, 2).map((n) => n.deviceId)
  )
})

it('never mutates the input sample', () => {
  const sample = atOffset(fixtureSample('bare-metal-gpu'), 60)
  const signalCount = sample.hardwareSignals.length
  decimateSampleToCadenceTiersV5(sample)
  assertEquals(sample.hardwareSignals.length, signalCount)
})

// ---------------------------------------------------------------------------
// The cost claim itself
// ---------------------------------------------------------------------------

/** AE rows a fixture actually writes over `minutes` of 60 s samples, with tiering applied. */
function rowsOverWindow(name: string, minutes: number, slotMapping?: SlotMapping): number {
  const base = fixtureSample(name)
  let rows = 0
  for (let minute = 0; minute < minutes; minute += 1) {
    const decimated = decimateSampleToCadenceTiersV5(atOffset(base, minute * 60), slotMapping)
    rows += buildMetricsDataPointsV5(
      {
        ...decimated,
        serverId: SERVER_ID,
        receivedAt: decimated.metadata.sampledAt,
      },
      slotMapping
    ).length
  }
  return rows
}

/** The same window with no tiering at all — what v4 wrote. */
function untieredRowsOverWindow(name: string, minutes: number): number {
  const base = fixtureSample(name)
  const perSample = buildMetricsDataPointsV5({
    ...base,
    serverId: SERVER_ID,
    receivedAt: base.metadata.sampledAt,
  }).length
  return perSample * minutes
}

it('cuts the bare-metal sensor family from every minute to one minute in five', () => {
  // The N150-shaped box: host.system + host.io + block + hardware.physical.
  // Over 5 minutes v4 wrote the sensor row 5 times; v5 writes it once.
  const tiered = rowsOverWindow('bare-metal-low-signals', 5)
  const untiered = untieredRowsOverWindow('bare-metal-low-signals', 5)
  assertEquals(untiered, 15)
  assertEquals(tiered, 11)
})

it('leaves a plain VM untouched — it has no slow families to decimate', () => {
  assertEquals(rowsOverWindow('2-nic-vm', 5), untieredRowsOverWindow('2-nic-vm', 5))
})

it('never decimates a web VM below its ingress row, which is delta-sum', () => {
  // host.system + host.io + managed.ingress every minute: dropping the
  // ingress row would lose requests outright, not coarsen them.
  assertEquals(rowsOverWindow('web-vm', 5), 15)
})
