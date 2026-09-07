/**
 * Analytics Engine row-budget report.
 *
 * Runs the **real** ingest write path — capability-plan truncation, cadence
 * decimation, AE packing — over a full hour of samples for each archetype,
 * and reports actual rows written. Nothing here is asserted from the design
 * doc; every number falls out of the code that runs in production.
 *
 *   deno run -A scripts/metrics-row-budget.ts
 *
 * AE pricing (Workers Paid, developers.cloudflare.com/analytics/analytics-engine/pricing):
 * 10M data points/month included, then $0.25/M. 20 doubles, 20 blobs, 1 index
 * per point; 250 points max per Worker invocation.
 */
import { buildMetricsSampleV5 } from '../src/daemon/metrics/contract-v5.ts'
import {
  platformDefaultMetricsCapabilityPlan,
  truncateSampleToCapabilityPlanV5,
} from '../src/daemon/metrics/capability-plan.ts'
import { decimateSampleToCadenceTiersV5 } from '../src/daemon/metrics/cadence-tiers-v5.ts'
import { buildMetricsDataPointsV5 } from '../src/daemon/metrics/backends/cloudflare/field-map-v5.ts'
import { representativeMachineFixtures } from '../src/daemon/metrics/testing/representative-machines.ts'
import type { MetricsSampleV5, SlotMapping } from '../src/daemon/metrics/types-v5.ts'

const SERVER_ID = '11111111-2222-4333-8444-555555555555'
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0)

const INCLUDED_WRITES_PER_MONTH = 10_000_000
const PRICE_PER_MILLION = 0.25
const DAYS_PER_MONTH = 30

type Archetype = {
  name: string
  fixture: string
  machineClass: 'physical' | 'virtual'
  deployment: 'hosted' | 'self-hosted'
  note: string
}

/**
 * Machine shapes that matter commercially, mapped onto the pinned
 * representative fixtures so this report and the row-count test cannot drift.
 */
const ARCHETYPES: Archetype[] = [
  {
    name: 'Hosted VM (2 NIC, no ingress)',
    fixture: '2-nic-vm',
    machineClass: 'virtual',
    deployment: 'hosted',
    note: 'the cheapest real server',
  },
  {
    name: 'Hosted VM + site Caddy',
    fixture: 'web-vm',
    machineClass: 'virtual',
    deployment: 'hosted',
    note: 'the common web host',
  },
  {
    name: 'Hosted VM + GPU',
    fixture: 'web-gpu-vm',
    machineClass: 'virtual',
    deployment: 'hosted',
    note: 'vGPU VPS',
  },
  {
    name: 'Bare metal, no GPU',
    fixture: 'bare-metal-low-signals',
    machineClass: 'physical',
    deployment: 'self-hosted',
    note: 'the N150-shaped box',
  },
  {
    name: 'Bare metal + GPU',
    fixture: 'bare-metal-gpu',
    machineClass: 'physical',
    deployment: 'self-hosted',
    note: 'workstation/AI host',
  },
  {
    name: 'Bare metal, 8 NIC',
    fixture: '8-nic',
    machineClass: 'physical',
    deployment: 'self-hosted',
    note: '8 present, self-hosted stores 8',
  },
  {
    name: 'Bare metal, 24 drives',
    fixture: '24-block-devices',
    machineClass: 'physical',
    deployment: 'self-hosted',
    note: '24 present, plan stores 2',
  },
  {
    name: 'Bare metal, 16 GPU',
    fixture: '16-gpu',
    machineClass: 'physical',
    deployment: 'self-hosted',
    note: '16 present, plan stores 1',
  },
]

function fixtureInput(name: string) {
  const found = representativeMachineFixtures().find((f) => f.name === name)
  if (!found) throw new Error(`no representative fixture named ${name}`)
  return found
}

/** One hour of samples through the real write path; returns rows actually written. */
function rowsPerHour(
  archetype: Archetype,
  intervalSeconds: number,
  slotMapping: SlotMapping | undefined
): { rows: number; families: Map<string, number> } {
  const fixture = fixtureInput(archetype.fixture)
  const plan = platformDefaultMetricsCapabilityPlan(archetype.machineClass, archetype.deployment)
  const families = new Map<string, number>()
  let rows = 0
  const ticks = Math.round(3600 / intervalSeconds)
  for (let tick = 0; tick < ticks; tick += 1) {
    const built = buildMetricsSampleV5(fixture.input)
    const sample: MetricsSampleV5 = {
      ...built,
      metadata: {
        ...built.metadata,
        sampledAt: new Date(BASE_MS + tick * intervalSeconds * 1000).toISOString(),
        intervalSeconds,
      },
    }
    const truncated = truncateSampleToCapabilityPlanV5(sample, plan, slotMapping)
    const decimated = decimateSampleToCadenceTiersV5(truncated, slotMapping)
    const points = buildMetricsDataPointsV5(
      { ...decimated, serverId: SERVER_ID, receivedAt: decimated.metadata.sampledAt },
      slotMapping
    )
    rows += points.length
    for (const point of points) {
      const family = String(point.blobs[1] ?? '')
      families.set(family, (families.get(family) ?? 0) + 1)
    }
  }
  return { rows, families }
}

function monthly(rowsPerHourValue: number): number {
  return rowsPerHourValue * 24 * DAYS_PER_MONTH
}

function costFor(writesPerMonth: number): string {
  const billable = Math.max(0, writesPerMonth - INCLUDED_WRITES_PER_MONTH)
  return billable === 0 ? '$0.00' : `$${((billable / 1_000_000) * PRICE_PER_MILLION).toFixed(2)}`
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}
function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value
}

function rowsForOneSample(archetype: Archetype, offsetSeconds: number): number {
  const fixture = fixtureInput(archetype.fixture)
  const plan = platformDefaultMetricsCapabilityPlan(archetype.machineClass, archetype.deployment)
  const built = buildMetricsSampleV5(fixture.input)
  const sample: MetricsSampleV5 = {
    ...built,
    metadata: {
      ...built.metadata,
      sampledAt: new Date(BASE_MS + offsetSeconds * 1000).toISOString(),
      intervalSeconds: 60,
    },
  }
  const truncated = truncateSampleToCapabilityPlanV5(sample, plan, fixture.slotMapping)
  const decimated = decimateSampleToCadenceTiersV5(truncated, fixture.slotMapping)
  return buildMetricsDataPointsV5(
    { ...decimated, serverId: SERVER_ID, receivedAt: decimated.metadata.sampledAt },
    fixture.slotMapping
  ).length
}

console.log('ANALYTICS ENGINE ROWS PER SCENARIO — measured from the real write path\n')
console.log('All rows below are under the PLATFORM DEFAULT plan, i.e. what an')
console.log('un-upgraded server costs. Hardware beyond the default entitlement is')
console.log('truncated before packing — see `deno task metrics:inventory` for what a')
console.log('granted plan stores instead.\n')
console.log('A "row" is one Analytics Engine data point. Two things decide the total:')
console.log('  1. rows per sample  — set by the schema + capability plan (what hardware exists)')
console.log(
  '  2. samples per hour — set by cadence (60 at the 60 s baseline, 360 in a 10 s live session)'
)
console.log('Slow-tier families (filesystem, sensors, detail) only write on every 5th minute,')
console.log('so a "typical minute" writes fewer rows than the minute that crosses that boundary.\n')

console.log(
  pad('Scenario', 32) +
    padLeft('typical', 9) +
    padLeft('5th min', 9) +
    padLeft('per hour', 10) +
    padLeft('per day', 10) +
    padLeft('per month', 12)
)
console.log('-'.repeat(82))

const rowsByArchetype = new Map<string, number>()
for (const archetype of ARCHETYPES) {
  const { rows } = rowsPerHour(archetype, 60, fixtureInput(archetype.fixture).slotMapping)
  rowsByArchetype.set(archetype.name, rows)
  // minute 1 crosses the 300 s boundary (slow families due); minute 2 does not
  const onBoundary = rowsForOneSample(archetype, 0)
  const typical = rowsForOneSample(archetype, 60)
  console.log(
    pad(archetype.name, 32) +
      padLeft(String(typical), 9) +
      padLeft(String(onBoundary), 9) +
      padLeft(String(rows), 10) +
      padLeft((rows * 24).toLocaleString('en-US'), 10) +
      padLeft(monthly(rows).toLocaleString('en-US'), 12)
  )
}

console.log('\nWhich families make up those rows (rows/hour at the 60 s baseline)\n')
for (const archetype of ARCHETYPES) {
  const { families } = rowsPerHour(archetype, 60, fixtureInput(archetype.fixture).slotMapping)
  const parts = [...families.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([family, count]) => `${family} ${count}`)
    .join(' | ')
  console.log(`  ${pad(archetype.name, 32)} ${parts}`)
}

console.log('\nLIVE SESSIONS — the daemon samples every 10 s instead of 60 s while a page is open.')
console.log('Rows per sample do not change; there are simply 6x as many samples.\n')
console.log(
  pad('Scenario', 32) +
    padLeft('baseline/h', 12) +
    padLeft('live/h', 9) +
    padLeft('60-min lease', 14)
)
console.log('-'.repeat(67))
for (const archetype of ARCHETYPES) {
  const fixture = fixtureInput(archetype.fixture)
  const baseline = rowsPerHour(archetype, 60, fixture.slotMapping).rows
  const live = rowsPerHour(archetype, 10, fixture.slotMapping).rows
  console.log(
    pad(archetype.name, 32) +
      padLeft(String(baseline), 12) +
      padLeft(String(live), 9) +
      padLeft(`+${live - baseline} rows`, 14)
  )
}

console.log(
  '\nFLEET COST at the common web-host shape (' +
    (rowsByArchetype.get('Hosted VM + site Caddy') ?? 0) +
    ' rows/hour)\n'
)
for (const servers of [50, 100, 250, 500, 1000, 5000]) {
  const writes = monthly(rowsByArchetype.get('Hosted VM + site Caddy') ?? 0) * servers
  console.log(
    `  ${padLeft(String(servers), 5)} servers  ${padLeft(writes.toLocaleString('en-US'), 14)} writes/mo  ${padLeft(costFor(writes), 10)}`
  )
}
console.log('\n  Free allowance: 10,000,000 writes/month, then $0.25 per additional million.')
