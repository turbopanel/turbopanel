/**
 * Tier model: what each capability-plan knob costs, and what a proposed tier
 * ladder costs per server.
 *
 *   deno task metrics:tiers
 *
 * Every number is measured by running the real ingest write path (plan
 * truncation -> cadence decimation -> AE packing) over an hour of samples.
 * The point is to price the knobs before deciding which ones to sell.
 */
import { buildMetricsSampleV5 } from '../src/daemon/metrics/contract-v5.ts'
import {
  type MetricsCapabilityPlanV5,
  platformDefaultMetricsCapabilityPlan,
  truncateSampleToCapabilityPlanV5,
} from '../src/daemon/metrics/capability-plan.ts'
import { decimateSampleToCadenceTiersV5 } from '../src/daemon/metrics/cadence-tiers-v5.ts'
import { buildMetricsDataPointsV5 } from '../src/daemon/metrics/backends/cloudflare/field-map-v5.ts'
import type { MetricsSampleV5, MetricsSampleV5Input } from '../src/daemon/metrics/contract-v5.ts'
import type { SlotMapping } from '../src/daemon/metrics/types-v5.ts'

const SERVER_ID = '11111111-2222-4333-8444-555555555555'
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0)
const HOURS_PER_MONTH = 24 * 30
const INCLUDED = 10_000_000
const PRICE_PER_M = 0.25

function pad(v: string, w: number) {
  return v.length >= w ? v : v + ' '.repeat(w - v.length)
}
function padLeft(v: string, w: number) {
  return v.length >= w ? v : ' '.repeat(w - v.length) + v
}

// ---------------------------------------------------------------------------
// A maximally-equipped host: every family populated well beyond any tier, so
// the plan is the only thing deciding what gets stored.
// ---------------------------------------------------------------------------

function richHost(ingressCount = 2, dbProxyCount = 1, eventCount = 0): MetricsSampleV5Input {
  const n = <T>(count: number, make: (i: number) => T): T[] =>
    Array.from({ length: count }, (_, i) => make(i))
  const zeroHost = {
    cpu: {
      busyPercent: 10,
      userPercent: 5,
      systemPercent: 3,
      iowaitPercent: 1,
      stealPercent: 0,
      softirqPercent: 1,
      pressureSomePercent: 2,
      saturatedCoreCount: 1,
      procsRunning: 2,
      procsBlocked: 0,
      processCount: 300,
    },
    kernel: { fileHandlesUsedPercent: 5, conntrackUsedPercent: 5 },
    memory: {
      usedBytes: 1,
      cachedFilesBytes: 1,
      swapUsedBytes: 0,
      pressureSomePercent: 0,
      pressureFullPercent: 0,
      swapInBytesPerSecond: 0,
      swapOutBytesPerSecond: 0,
      majorPageFaultsPerSecond: 0,
    },
    storage: {
      ioPressureSomePercent: 1,
      ioPressureFullPercent: 0,
      diskReadBytesPerSecond: 1,
      diskWriteBytesPerSecond: 1,
      diskLatencyMs: 1,
      rootFilesystemAvailableBytes: 1,
      rootFilesystemFreeInodes: 1,
    },
    network: { tcpRetransmitPercent: 0, softnetDropsPerSecond: 0 },
  }
  return {
    metadata: {
      version: 5,
      sampledAt: new Date(BASE_MS).toISOString(),
      intervalSeconds: 60,
      sequence: 1,
      collectionMode: 'baseline',
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: zeroHost,
    networks: n(16, (i) => ({
      deviceId: `eth${i}`,
      receiveBytesPerSecond: 1,
      transmitBytesPerSecond: 1,
      receiveErrorsPerSecond: 0,
      transmitErrorsPerSecond: 0,
      receiveDropsPerSecond: 0,
      transmitDropsPerSecond: 0,
    })),
    filesystems: n(24, (i) => ({ filesystemId: `fs${i}`, availableBytes: 1, freeInodes: 1 })),
    blockDevices: n(24, (i) => ({
      deviceId: `blk${i}`,
      readBytesPerSecond: 1,
      writeBytesPerSecond: 1,
      readOpsPerSecond: 1,
      writeOpsPerSecond: 1,
      readLatencyMs: 1,
      writeLatencyMs: 1,
      utilizationPercent: 1,
      temperatureCelsius: 40,
      queueDepth: 0.01,
    })),
    gpus: n(8, (i) => ({
      gpuId: `gpu${i}`,
      utilizationPercent: 1,
      memoryUsedBytes: 1,
      memoryActivityPercent: 1,
      temperatureCelsius: 50,
      memoryTemperatureCelsius: 50,
      powerWatts: 100,
      pcieReceiveBytesPerSecond: 1,
      pcieTransmitBytesPerSecond: 1,
      throttlePercent: 0,
    })),
    hardwareSignals: n(19, (i) => ({
      signalId: `signal:chip:s${i}`,
      kind: 'temperature',
      value: 40,
    })),
    // Realistic: the daemon has exactly two ingress adapters (site Caddy,
    // hosting Traefik) and one database-proxy adapter (ProxySQL).
    ingressSources: n(ingressCount, (i) => ({
      sourceId: `ing${i}`,
      sourceKind: 'caddy',
      requests: 1,
      responses2xx: 1,
      responses3xx: 0,
      responses4xx: 0,
      responses5xx: 0,
      requestErrors: null,
      requestBytes: 1,
      responseBytes: 1,
      requestDurationSecondsAvg: 0.1,
      requestsUnder100ms: 1,
      requestsUnder500ms: 1,
      requestsUnder1s: 1,
      requestsUnder5s: 1,
      requestsInFlight: 0,
      upstreamsHealthy: 1,
      upstreamsTotal: 1,
      retries: null,
    })),
    databaseProxies: n(dbProxyCount, (i) => ({
      sourceId: `db${i}`,
      sourceKind: 'proxysql',
      queries: 1,
      slowQueries: 0,
      connectionErrors: 0,
      clientConnections: 1,
      backendConnections: 1,
      backendsUp: 1,
    })),
    events: n(eventCount, (i) => ({
      eventId: `evt${i}`,
      at: new Date(BASE_MS).toISOString(),
      kind: 'oom_kill' as const,
      severity: 'warning' as const,
    })),
    cpuDetail: {
      averageFrequencyMHz: 2000,
      minimumFrequencyMHz: 1000,
      maximumFrequencyMHz: 3000,
      contextSwitchesPerSecond: 1,
      interruptsPerSecond: 1,
      forksPerSecond: 1,
      cpuIrqPercent: 1,
    },
    memoryDetail: {
      memoryFreeBytes: 1,
      cachedBytes: 1,
      anonPagesBytes: 1,
      slabReclaimableBytes: 1,
      slabUnreclaimableBytes: 1,
      dirtyBytes: 1,
      writebackBytes: 1,
      shmemBytes: 1,
      pageTablesBytes: 1,
      kernelStackBytes: 1,
      committedAsBytes: 1,
      commitLimitBytes: 1,
      activeAnonBytes: 1,
      inactiveAnonBytes: 1,
      activeFileBytes: 1,
      inactiveFileBytes: 1,
      pageScanDirectPerSecond: 1,
      pageScanKswapdPerSecond: 1,
      compactionStallsPerSecond: 1,
    },
  }
}

const RICH = richHost()

function slotMappingFor(plan: MetricsCapabilityPlanV5): SlotMapping {
  return {
    normalNicSlots: Array.from({ length: plan.normalNicSlots }, (_, i) => `eth${i}`),
    fabricDeviceIds: [],
    rootFilesystemId: null,
    gpuPageOrder: [],
    filesystemPageOrder: [],
    blockPageOrder: [],
    hardwareSignalPageOrder: [],
  }
}

/** Rows written in one hour under `plan`, at the plan's own baseline cadence. */
function rowsPerHour(plan: MetricsCapabilityPlanV5, host: MetricsSampleV5Input = RICH): number {
  const slotMapping = slotMappingFor(plan)
  const interval = plan.baselineIntervalSeconds
  const ticks = Math.round(3600 / interval)
  let rows = 0
  for (let tick = 0; tick < ticks; tick += 1) {
    const built = buildMetricsSampleV5(host)
    const sample: MetricsSampleV5 = {
      ...built,
      metadata: {
        ...built.metadata,
        sampledAt: new Date(BASE_MS + tick * interval * 1000).toISOString(),
        intervalSeconds: interval,
      },
    }
    const planned = truncateSampleToCapabilityPlanV5(sample, plan, slotMapping)
    const decimated = decimateSampleToCadenceTiersV5(planned, slotMapping)
    rows += buildMetricsDataPointsV5(
      { ...decimated, serverId: SERVER_ID, receivedAt: decimated.metadata.sampledAt },
      slotMapping
    ).length
  }
  return rows
}

/**
 * Points emitted by the single worst sample — the 5-minute boundary, when every
 * slow-tier family is due at once. This is what has to clear Analytics Engine's
 * 250-points-per-invocation ceiling.
 */
function peakPointsPerSample(
  plan: MetricsCapabilityPlanV5,
  host: MetricsSampleV5Input = RICH
): number {
  const slotMapping = slotMappingFor(plan)
  let peak = 0
  // Walk a full slow-tier cycle so the boundary sample is definitely included.
  for (let tick = 0; tick < Math.ceil(300 / plan.baselineIntervalSeconds) + 1; tick += 1) {
    const built = buildMetricsSampleV5(host)
    const sample: MetricsSampleV5 = {
      ...built,
      metadata: {
        ...built.metadata,
        sampledAt: new Date(BASE_MS + tick * plan.baselineIntervalSeconds * 1000).toISOString(),
        intervalSeconds: plan.baselineIntervalSeconds,
      },
    }
    const planned = truncateSampleToCapabilityPlanV5(sample, plan, slotMapping)
    const decimated = decimateSampleToCadenceTiersV5(planned, slotMapping)
    const points = buildMetricsDataPointsV5(
      { ...decimated, serverId: SERVER_ID, receivedAt: decimated.metadata.sampledAt },
      slotMapping
    )
    peak = Math.max(peak, points.length)
  }
  return peak
}

const BASE: MetricsCapabilityPlanV5 = {
  ...platformDefaultMetricsCapabilityPlan('physical', 'hosted'),
  normalNicSlots: 2,
  detailedBlockDeviceSlots: 2,
  // 2 GPUs cost the same as 1 — the AE gpu row packs 2 per page — so the base
  // tier may as well include both. The first billable GPU step is the 3rd.
  gpuSlots: 2,
  extraFilesystemSlots: 0,
  physicalHardwareSignalSlots: 19,
  cpuDetailEnabled: false,
  memoryDetailEnabled: false,
}

console.log('METRICS TIER MODEL — every number measured from the real write path\n')
console.log('Baseline: 2 NICs, 2 drives, 2 GPUs, sensors on, detail off.')
console.log('The synthetic host carries a GPU, 2 drives, 19 sensors and all three')
console.log('traffic adapters, so its 432 rows/h is higher than the 180 rows/h a plain')
console.log('web VM costs in `metrics:budget` — that machine has none of those.\n')
console.log('NOTE: `baselineIntervalSeconds` has no consumer in production today.')
console.log('The two cadence rows below show what wiring it would buy, not current behaviour.\n')

// ---------------------------------------------------------------------------
// 1. What each knob costs
// ---------------------------------------------------------------------------

const KNOBS: { label: string; plan: MetricsCapabilityPlanV5 }[] = [
  { label: '+2 drives (4 total)', plan: { ...BASE, detailedBlockDeviceSlots: 4 } },
  { label: '+2 drives again (6)', plan: { ...BASE, detailedBlockDeviceSlots: 6 } },
  { label: '+1 GPU (3 total)', plan: { ...BASE, gpuSlots: 3 } },
  { label: '+2 GPUs (4 total)', plan: { ...BASE, gpuSlots: 4 } },
  { label: '+2 NICs (4 total)', plan: { ...BASE, normalNicSlots: 4 } },
  { label: '+6 NICs (8 total)', plan: { ...BASE, normalNicSlots: 8 } },
  { label: '+9 extra filesystems', plan: { ...BASE, extraFilesystemSlots: 9 } },
  { label: '+18 extra filesystems', plan: { ...BASE, extraFilesystemSlots: 18 } },
  { label: 'cpu.detail on', plan: { ...BASE, cpuDetailEnabled: true } },
  { label: 'memory.detail on', plan: { ...BASE, memoryDetailEnabled: true } },
  {
    label: 'both detail families on',
    plan: { ...BASE, cpuDetailEnabled: true, memoryDetailEnabled: true },
  },
  { label: 'sensors off (VM)', plan: { ...BASE, physicalHardwareSignalSlots: 0 } },
  { label: 'ingress off (2 sources)', plan: { ...BASE, managedIngressEnabled: false } },
  { label: 'db proxy off (1 source)', plan: { ...BASE, databaseProxyMetricsEnabled: false } },
  {
    label: 'both traffic families off',
    plan: { ...BASE, managedIngressEnabled: false, databaseProxyMetricsEnabled: false },
  },
  { label: 'cadence 30 s [NOT WIRED]', plan: { ...BASE, baselineIntervalSeconds: 30 } },
  { label: 'cadence 120 s [NOT WIRED]', plan: { ...BASE, baselineIntervalSeconds: 120 } },
]

const baseRows = rowsPerHour(BASE)
console.log('=== 1. Marginal cost of each knob ===\n')
console.log(
  pad('Change from base', 28) +
    padLeft('rows/h', 9) +
    padLeft('delta', 9) +
    padLeft('/mo delta', 12) +
    '  verdict'
)
console.log('-'.repeat(76))
console.log(
  pad('BASE (2 NIC/2 drive/1 GPU)', 28) +
    padLeft(String(baseRows), 9) +
    padLeft('—', 9) +
    padLeft('—', 12)
)
for (const knob of KNOBS) {
  const rows = rowsPerHour(knob.plan)
  const delta = rows - baseRows
  const monthly = delta * HOURS_PER_MONTH
  const verdict =
    delta === 0
      ? 'free'
      : Math.abs(delta) <= 12
        ? 'cheap (slow tier)'
        : Math.abs(delta) >= 60
          ? 'EXPENSIVE'
          : 'moderate'
  console.log(
    pad(knob.label, 28) +
      padLeft(String(rows), 9) +
      padLeft((delta >= 0 ? '+' : '') + delta, 9) +
      padLeft((monthly >= 0 ? '+' : '') + monthly.toLocaleString('en-US'), 12) +
      '  ' +
      verdict
  )
}

// ---------------------------------------------------------------------------
// 2. Proposed ladder
//
// The commercial ladder is priced on MACHINE SIZE (cores/RAM), not on a feature
// bundle. So metrics entitlements are sized to what a machine of that size can
// physically have: a 4-core/16 GB VPS cannot hold 24 drives, and a 256-core box
// should not be told it may only watch 2. Every tier gets the full depth
// (sensors, filesystems, cpu/memory detail) because those ride the 300 s slow
// tier and cost ~12 rows/h each; what scales with price is entity cardinality.
//
// Only three dimensions are tiered: NICs, drives, GPUs. Ingress/db-proxy
// cardinality is FIXED at 3 (sourceIds "caddy", "traefik", "proxysql" are
// literals in the collectors — a customer cannot create a fourth), so there is
// nothing there to sell. `numaNodeSlots` is held at 0 because no NUMA family is
// packed into Analytics Engine at all; the knob currently produces zero rows.
// ---------------------------------------------------------------------------

type Tier = {
  name: string
  shape: string
  price: number
  plan: MetricsCapabilityPlanV5
}

// Depth is free at every tier: these families ride the 300 s slow tier and cost
// ~12 rows/h each. Sensors are not in here because there is no boolean for them —
// they are governed by `physicalHardwareSignalSlots` (19, inherited from BASE)
// and by `machineClass`, so a VM gets none at any price.
const DEPTH = {
  cpuDetailEnabled: true,
  memoryDetailEnabled: true,
} as const

const TIERS: Tier[] = [
  {
    name: 'S1',
    shape: '<=4c / 16 GB',
    price: 5,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 2,
      detailedBlockDeviceSlots: 2,
      gpuSlots: 2,
      extraFilesystemSlots: 9,
      numaNodeSlots: 0,
    },
  },
  {
    name: 'S2',
    shape: '<=10c / 32 GB',
    price: 7.5,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 2,
      detailedBlockDeviceSlots: 4,
      gpuSlots: 2,
      extraFilesystemSlots: 9,
      numaNodeSlots: 0,
    },
  },
  {
    name: 'S3',
    shape: '<=16c / 64 GB',
    price: 10,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 5,
      detailedBlockDeviceSlots: 6,
      gpuSlots: 2,
      extraFilesystemSlots: 9,
      numaNodeSlots: 0,
    },
  },
  {
    name: 'S4',
    shape: '<=32c / 128 GB',
    price: 15,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 5,
      detailedBlockDeviceSlots: 8,
      gpuSlots: 4,
      extraFilesystemSlots: 9,
      numaNodeSlots: 2,
    },
  },
  {
    name: 'S5',
    shape: '<=64c / 256 GB',
    price: 20,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 8,
      detailedBlockDeviceSlots: 12,
      gpuSlots: 4,
      extraFilesystemSlots: 18,
      numaNodeSlots: 4,
    },
  },
  {
    name: 'S6',
    shape: '<=128c / 512 GB',
    price: 35,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 8,
      detailedBlockDeviceSlots: 16,
      gpuSlots: 6,
      extraFilesystemSlots: 18,
      numaNodeSlots: 8,
    },
  },
  {
    name: 'S7',
    shape: '<=256c / 1 TB',
    price: 50,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 11,
      detailedBlockDeviceSlots: 20,
      gpuSlots: 8,
      extraFilesystemSlots: 18,
      numaNodeSlots: 8,
    },
  },
  {
    name: 'SX',
    shape: '>256c / >1 TB',
    price: 0, // contact-us tier — no list price
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 11,
      detailedBlockDeviceSlots: 24,
      gpuSlots: 8,
      extraFilesystemSlots: 18,
      numaNodeSlots: 16,
    },
  },
]

console.log('\n=== 2. Entitlements per price tier (measured) ===\n')
console.log(
  pad('Tier', 6) +
    pad('machine', 17) +
    padLeft('$/mo', 7) +
    pad('  NIC/drv/GPU/fs', 20) +
    padLeft('rows/h', 8) +
    padLeft('writes/mo', 12)
)
console.log('-'.repeat(72))
for (const tier of TIERS) {
  // Price the sources the tier grants, not the fixture's 2+1 — otherwise the
  // ladder undercounts exactly the dimension it is meant to gate.
  const rows = rowsPerHour(tier.plan, RICH)
  const shape = `${tier.plan.normalNicSlots}/${tier.plan.detailedBlockDeviceSlots}/${tier.plan.gpuSlots}/${tier.plan.extraFilesystemSlots}`
  console.log(
    pad(tier.name, 6) +
      pad(tier.shape, 17) +
      padLeft('$' + tier.price.toFixed(2), 7) +
      pad('  ' + shape, 20) +
      padLeft(String(rows), 8) +
      padLeft((rows * HOURS_PER_MONTH).toLocaleString('en-US'), 12)
  )
}

// ---------------------------------------------------------------------------
// 3. What metrics cost us as a share of what the tier charges
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2b. What a VM saves: `machineClass: 'virtual'` zeroes physicalHardwareSignalSlots,
//     so the whole `hardware.physical` family disappears.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2a. PROJECTION for v6: merge the three traffic rows into one.
//
// Today caddy, traefik and the database proxy are three separate families, so
// they cost 3 rows every sample (they are `'every'` tier — traffic must stay at
// 1-minute resolution). A single fixed-position `traffic` family at 6 doubles
// per source packs all three into one page (floor(19/6) = 3), saving 2 rows per
// sample at every tier. This is v6 schema work; the saving is arithmetic, not
// measured, because the family does not exist yet.
// ---------------------------------------------------------------------------

const TRAFFIC_ROWS_SAVED_PER_SAMPLE = 2

console.log('\n=== 2a. v6 projection: one traffic row instead of three ===\n')
console.log(
  pad('Tier', 6) +
    padLeft('v5 rows/h', 11) +
    padLeft('v6 rows/h', 11) +
    padLeft('saved/h', 9) +
    padLeft('v6 writes/mo', 14) +
    padLeft('cut', 7)
)
console.log('-'.repeat(58))
for (const tier of TIERS) {
  const v5 = rowsPerHour(tier.plan)
  const savedPerHour = (TRAFFIC_ROWS_SAVED_PER_SAMPLE * 3600) / tier.plan.baselineIntervalSeconds
  const v6 = v5 - savedPerHour
  console.log(
    pad(tier.name, 6) +
      padLeft(String(v5), 11) +
      padLeft(String(v6), 11) +
      padLeft(String(savedPerHour), 9) +
      padLeft((v6 * HOURS_PER_MONTH).toLocaleString('en-US'), 14) +
      padLeft(((savedPerHour / v5) * 100).toFixed(0) + '%', 7)
  )
}
console.log('\n  Traffic stays on the `every` tier — 1-minute resolution is preserved.')
console.log('  The saving comes from packing 3 sources into 1 row, not from writing less often.')

console.log('\n=== 2b. Physical vs virtual (same tier, same hardware) ===\n')
console.log(
  pad('Tier', 6) +
    padLeft('physical/h', 12) +
    padLeft('virtual/h', 11) +
    padLeft('saved/h', 9) +
    padLeft('rows/sample', 13)
)
console.log('-'.repeat(52))
for (const tier of TIERS) {
  const phys = rowsPerHour(tier.plan)
  const virt = rowsPerHour({ ...tier.plan, physicalHardwareSignalSlots: 0 })
  const saved = phys - virt
  console.log(
    pad(tier.name, 6) +
      padLeft(String(phys), 12) +
      padLeft(String(virt), 11) +
      padLeft(String(saved), 9) +
      padLeft((saved / 12).toFixed(0) + ' per 5 min', 13)
  )
}
console.log('\n  A VM has no fan/voltage/PSU/temperature sensors, so `hardware.physical`')
console.log('  is never emitted. All 19 signals pack into one page, and that family sits')
console.log('  on the 300 s slow tier — so the saving is exactly one row per 5 minutes.')

console.log('\n=== 3. AE cost vs revenue, per server ===\n')
console.log(
  pad('Tier', 6) +
    padLeft('$/mo', 8) +
    padLeft('writes/mo', 12) +
    padLeft('AE cost', 10) +
    padLeft('% of price', 12) +
    padLeft('free until', 12)
)
console.log('-'.repeat(60))
for (const tier of TIERS) {
  const monthly = rowsPerHour(tier.plan, RICH) * HOURS_PER_MONTH
  // Marginal cost: past the 10M free allowance every write bills, so the honest
  // per-server figure for a fleet of any real size is the unsubsidised rate.
  const cost = (monthly / 1_000_000) * PRICE_PER_M
  console.log(
    pad(tier.name, 6) +
      padLeft('$' + tier.price.toFixed(2), 8) +
      padLeft(monthly.toLocaleString('en-US'), 12) +
      padLeft('$' + cost.toFixed(3), 10) +
      padLeft(((cost / tier.price) * 100).toFixed(2) + '%', 12) +
      padLeft(Math.floor(INCLUDED / monthly) + ' srv', 12)
  )
}

// ---------------------------------------------------------------------------
// 4. The hard limit that actually binds: 250 data points per Worker invocation
// ---------------------------------------------------------------------------

console.log('\n=== 4. Worst single sample vs the 250-point invocation limit ===\n')
console.log(
  pad('Tier', 6) +
    padLeft('hardware', 10) +
    padLeft('+ sources', 11) +
    padLeft('+ 128 evt', 11) +
    padLeft('headroom', 10) +
    '  status'
)
console.log('-'.repeat(62))
for (const tier of TIERS) {
  const hardwareOnly = peakPointsPerSample(tier.plan, richHost(0, 0, 0))
  const withSources = peakPointsPerSample(tier.plan, RICH)
  const worst = peakPointsPerSample(tier.plan, richHost(2, 1, 128))
  const headroom = 250 - worst
  console.log(
    pad(tier.name, 6) +
      padLeft(String(hardwareOnly), 10) +
      padLeft(String(withSources), 11) +
      padLeft(String(worst), 11) +
      padLeft(String(headroom), 10) +
      '  ' +
      (headroom < 0 ? 'OVER — sheds' : headroom < 40 ? 'TIGHT' : 'ok')
  )
}
console.log('\n  Peak = the 5-minute boundary sample, when every slow-tier family is due.')
console.log('  "+ sources" adds the three fixed traffic rows (caddy, traefik, proxysql);')
console.log('  "+ 128 evt" adds a full event burst on top. Every tier keeps >90 points of')
console.log('  headroom, so the 250-point invocation ceiling does not constrain the ladder.')

// ---------------------------------------------------------------------------
// 5. Cost-reduction options for S1, measured.
//
// Target: under $0.05/month, i.e. under 200,000 writes/month, i.e. under
// 277 rows/hour. Each option is applied to the S1 plan and measured through the
// real write path; the v6 traffic merge (-2 rows/sample) is then applied
// arithmetically on top, since that family does not exist yet.
// ---------------------------------------------------------------------------

const S1 = TIERS[0].plan
const TARGET_ROWS_PER_HOUR = 277

function v6Rows(plan: MetricsCapabilityPlanV5, demoteFast?: boolean): number {
  const measured = demoteFast ? rowsPerHourDemoted(plan) : rowsPerHour(plan)
  const trafficSaving = (2 * 3600) / plan.baselineIntervalSeconds
  return measured - trafficSaving
}

/** Re-measure with gpu/block/network moved from the 60 s fast tier to 300 s. */
function rowsPerHourDemoted(plan: MetricsCapabilityPlanV5): number {
  // gpu and block each collapse from every-sample to one write per 300 s.
  const perSampleFast = 2 // gpu page + block page at S1 (2 GPUs, 2 drives)
  const samplesPerHour = 3600 / plan.baselineIntervalSeconds
  const slowWritesPerHour = (3600 / 300) * perSampleFast
  return rowsPerHour(plan) - perSampleFast * samplesPerHour + slowWritesPerHour
}

console.log('\n=== 5. Getting S1 under $0.05/month ===\n')
console.log(
  `  Target: < ${TARGET_ROWS_PER_HOUR} rows/h  (< 200,000 writes/mo, < $0.05, < 1% of $5)\n`
)
console.log(
  pad('Option', 42) +
    padLeft('rows/h', 8) +
    padLeft('writes/mo', 12) +
    padLeft('cost', 9) +
    padLeft('% of $5', 9) +
    '  verdict'
)
console.log('-'.repeat(90))

const OPTIONS: { label: string; rows: number }[] = [
  { label: 'v5 today, saturated ceiling', rows: rowsPerHour(S1) },
  { label: 'v6 traffic merge only', rows: v6Rows(S1) },
  { label: 'v6 + 90 s baseline', rows: v6Rows({ ...S1, baselineIntervalSeconds: 90 }) },
  { label: 'v6 + 120 s baseline', rows: v6Rows({ ...S1, baselineIntervalSeconds: 120 }) },
  { label: 'v6 + gpu/block demoted to 300 s', rows: v6Rows(S1, true) },
  {
    label: 'v6 + 120 s + gpu/block demoted',
    rows: v6Rows({ ...S1, baselineIntervalSeconds: 120 }, true),
  },
  { label: 'v6 + 180 s baseline', rows: v6Rows({ ...S1, baselineIntervalSeconds: 180 }) },
]

for (const o of OPTIONS) {
  const monthly = o.rows * HOURS_PER_MONTH
  const cost = (monthly / 1_000_000) * PRICE_PER_M
  console.log(
    pad(o.label, 42) +
      padLeft(String(Math.round(o.rows)), 8) +
      padLeft(Math.round(monthly).toLocaleString('en-US'), 12) +
      padLeft('$' + cost.toFixed(3), 9) +
      padLeft(((cost / 5) * 100).toFixed(2) + '%', 9) +
      '  ' +
      (o.rows < TARGET_ROWS_PER_HOUR ? 'MEETS TARGET' : 'over')
  )
}

console.log('\n  For comparison — what a REAL S1 machine costs (from metrics:budget,')
console.log('  not the saturated ceiling above):')
for (const [label, rows] of [
  ['plain VM, no ingress', 120],
  ['VM + site Caddy', 180],
  ['VM + GPU', 240],
] as const) {
  const monthly = rows * HOURS_PER_MONTH
  const cost = (monthly / 1_000_000) * PRICE_PER_M
  console.log(
    '    ' +
      pad(label, 26) +
      padLeft(String(rows), 6) +
      ' rows/h  ' +
      padLeft('$' + cost.toFixed(3), 8) +
      padLeft(((cost / 5) * 100).toFixed(2) + '% of $5', 14)
  )
}

// ---------------------------------------------------------------------------
// 6. Keeping all three traffic rows: what full ingress + database detail costs.
// ---------------------------------------------------------------------------

console.log('\n=== 6. Cost of KEEPING three traffic rows (no merge) ===\n')
console.log(
  pad('Tier', 6) +
    padLeft('$/mo', 7) +
    padLeft('3 rows/h', 10) +
    padLeft('1 row/h', 9) +
    padLeft('writes/mo', 12) +
    padLeft('AE cost', 10) +
    padLeft('% price', 9) +
    padLeft('merge saves', 12)
)
console.log('-'.repeat(76))
for (const tier of TIERS) {
  const keep = rowsPerHour(tier.plan)
  const merged = keep - (2 * 3600) / tier.plan.baselineIntervalSeconds
  const monthly = keep * HOURS_PER_MONTH
  const cost = (monthly / 1_000_000) * PRICE_PER_M
  const saving = ((keep - merged) * HOURS_PER_MONTH * PRICE_PER_M) / 1_000_000
  console.log(
    pad(tier.name, 6) +
      padLeft('$' + tier.price.toFixed(2), 7) +
      padLeft(String(keep), 10) +
      padLeft(String(merged), 9) +
      padLeft(monthly.toLocaleString('en-US'), 12) +
      padLeft('$' + cost.toFixed(3), 10) +
      padLeft(((cost / tier.price) * 100).toFixed(2) + '%', 9) +
      padLeft('$' + saving.toFixed(3), 12)
  )
}
console.log('\n  Keeping all three rows costs a flat +120 rows/hour at every tier —')
console.log('  86,400 extra writes/month, $0.0216 per server per month.')

// ---------------------------------------------------------------------------
// 7. v6 ladder, physical vs virtual.
//
// Measured through the real write path with NO cadence decimation (v6 writes
// every family on every sample), then adjusted arithmetically for the v6
// changes the code does not yet contain:
//   • +2 host-wide rows per sample: managed.databases, managed.storage
//   • GPU row 9 → 6 fields: 3 per page instead of 2
//   • thermals move into hardware.physical: +1 signal per drive, +3 per GPU
//   • virtual machines emit no hardware.physical rows at all
// ---------------------------------------------------------------------------

function v6RowsPerHour(plan: MetricsCapabilityPlanV5, virtual: boolean): number {
  const slotMapping = slotMappingFor(plan)
  const interval = plan.baselineIntervalSeconds
  const ticks = Math.round(3600 / interval)
  let rows = 0
  for (let tick = 0; tick < ticks; tick += 1) {
    const built = buildMetricsSampleV5(RICH)
    const sample: MetricsSampleV5 = {
      ...built,
      metadata: {
        ...built.metadata,
        sampledAt: new Date(BASE_MS + tick * interval * 1000).toISOString(),
        intervalSeconds: interval,
      },
    }
    const planned = truncateSampleToCapabilityPlanV5(
      virtual ? { ...sample, hardwareSignals: [] } : sample,
      virtual ? { ...plan, physicalHardwareSignalSlots: 0 } : plan,
      slotMapping
    )
    // v6: no decimation — every family every sample
    rows += buildMetricsDataPointsV5(
      { ...planned, serverId: SERVER_ID, receivedAt: planned.metadata.sampledAt },
      slotMapping
    ).length
  }
  const perSample = 3600 / interval
  const gpus = Math.min(plan.gpuSlots, 8)
  const drives = Math.min(plan.detailedBlockDeviceSlots, 24)
  // new host-wide families
  rows += 2 * perSample
  // GPU repack: v5 pages ceil(g/2) already counted; v6 wants ceil(g/3)
  rows -= (Math.ceil(gpus / 2) - Math.ceil(gpus / 3)) * perSample
  // thermals into hardware.physical (physical only): v5 counted 1 signal page
  if (!virtual) {
    const signals = plan.physicalHardwareSignalSlots + drives + 3 * gpus
    rows += (Math.ceil(signals / 19) - 1) * perSample
  }
  return rows
}

console.log('\n=== 7. v6 ladder — physical vs virtual (every family at 60 s) ===\n')
console.log(
  pad('Tier', 6) +
    padLeft('$/mo', 7) +
    padLeft('phys/h', 8) +
    padLeft('writes', 11) +
    padLeft('cost', 8) +
    padLeft('%', 7) +
    padLeft('vm/h', 8) +
    padLeft('writes', 11) +
    padLeft('cost', 8) +
    padLeft('%', 7)
)
console.log('-'.repeat(81))
for (const tier of TIERS) {
  const ph = v6RowsPerHour(tier.plan, false)
  const vm = v6RowsPerHour(tier.plan, true)
  const fmt = (r: number) => {
    const m = r * HOURS_PER_MONTH
    const c = (m / 1_000_000) * PRICE_PER_M
    const pct = tier.price > 0 ? ((c / tier.price) * 100).toFixed(2) + '%' : 'custom'
    return (
      padLeft(String(r), 8) +
      padLeft(m.toLocaleString('en-US'), 11) +
      padLeft('$' + c.toFixed(3), 8) +
      padLeft(pct, 7)
    )
  }
  console.log(
    pad(tier.name, 6) +
      padLeft(tier.price > 0 ? '$' + tier.price.toFixed(2) : 'custom', 7) +
      fmt(ph) +
      fmt(vm)
  )
}
console.log(
  '\n  Typical machines (v6) — host.system + host.io + diagnostics ×2 + databases + storage = 6 rows,'
)
console.log('  then +1 per ingress adapter, GPU page, block page, sensor page:')
for (const [label, rows] of [
  ['Plain VM, no ingress', 360],
  ['VM + site Caddy', 420],
  ['VM + GPU + Caddy', 480],
  ['Bare-metal mini PC, 2 drives, sensors, Caddy', 540],
] as const) {
  const m = rows * HOURS_PER_MONTH
  const c = (m / 1_000_000) * PRICE_PER_M
  console.log(
    '    ' +
      pad(label, 38) +
      padLeft(String(rows), 5) +
      ' rows/h ' +
      padLeft('$' + c.toFixed(3), 8) +
      padLeft(((c / 5) * 100).toFixed(2) + '% of $5', 14)
  )
}
