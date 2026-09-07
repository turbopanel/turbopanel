/**
 * Complete row inventory: every family, how it pages, and what each backend
 * stores for the same sample.
 *
 *   deno task metrics:inventory
 *
 * Analytics Engine and DuckDB store the *same* sample very differently:
 *
 *   - AE packs N entities into one 19-double row (`entitiesPerPage`), because
 *     a data point is the billing unit. 24 drives at 2/page is 12 rows.
 *   - DuckDB writes one real row per entity into a per-family table with
 *     named nullable columns. 24 drives is 24 rows, and rows are free.
 *
 * Both are fed by the same ingest pipeline, so the capability plan and the
 * cadence tiers apply to both — see the WARNING this report prints.
 */
import { buildMetricsSampleV5 } from '../src/daemon/metrics/contract-v5.ts'
import {
  platformDefaultMetricsCapabilityPlan,
  truncateSampleToCapabilityPlanV5,
} from '../src/daemon/metrics/capability-plan.ts'
import {
  decimateSampleToCadenceTiersV5,
  METRICS_CADENCE_TIERS_V5,
} from '../src/daemon/metrics/cadence-tiers-v5.ts'
import { buildMetricsDataPointsV5 } from '../src/daemon/metrics/backends/cloudflare/field-map-v5.ts'
import { representativeMachineFixtures } from '../src/daemon/metrics/testing/representative-machines.ts'
import type { MetricsSampleV5, SlotMapping } from '../src/daemon/metrics/types-v5.ts'

const SERVER_ID = '11111111-2222-4333-8444-555555555555'
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0)

function pad(v: string, w: number) {
  return v.length >= w ? v : v + ' '.repeat(w - v.length)
}
function padLeft(v: string, w: number) {
  return v.length >= w ? v : ' '.repeat(w - v.length) + v
}

// ---------------------------------------------------------------------------
// 1. Family catalog
// ---------------------------------------------------------------------------

type FamilyRow = {
  family: string
  width: string
  perPage: string
  planCap: string
  cadence: string
  duckdbTable: string
}

/** `floor(19 / width)` — AE gives 19 metric doubles per row, double20 is the interval. */
const AE_METRIC_SLOTS = 19

const FAMILIES: FamilyRow[] = [
  {
    family: 'host.system',
    width: '19 (fixed)',
    perPage: '1 row always',
    planCap: 'none — mandatory',
    cadence: 'every sample',
    duckdbTable: 'server_host_samples',
  },
  {
    family: 'host.io',
    width: '19 (fixed)',
    perPage: '1 row always',
    planCap: 'none — mandatory',
    cadence: 'every sample',
    duckdbTable: 'server_host_samples (same row)',
  },
  {
    family: 'network',
    width: '6/entity',
    perPage: `${Math.floor(AE_METRIC_SLOTS / 6)} NICs/row`,
    planCap: 'normalNicSlots (2 hosted / 8 self-hosted)',
    cadence: '60 s',
    duckdbTable: 'server_network_samples',
  },
  {
    family: 'filesystem',
    width: '2/entity',
    perPage: `${Math.floor(AE_METRIC_SLOTS / 2)} mounts/row`,
    planCap: 'extraFilesystemSlots (0)',
    cadence: '300 s',
    duckdbTable: 'server_filesystem_samples',
  },
  {
    family: 'block',
    width: '9/entity',
    perPage: `${Math.floor(AE_METRIC_SLOTS / 9)} drives/row`,
    planCap: 'detailedBlockDeviceSlots (2)',
    cadence: '60 s',
    duckdbTable: 'server_block_samples',
  },
  {
    family: 'gpu',
    width: '9/entity',
    perPage: `${Math.floor(AE_METRIC_SLOTS / 9)} GPUs/row`,
    planCap: 'gpuSlots (1)',
    cadence: '60 s',
    duckdbTable: 'server_gpu_samples',
  },
  {
    family: 'hardware.physical',
    width: '1/entity',
    perPage: `${AE_METRIC_SLOTS} sensors/row`,
    planCap: 'physicalHardwareSignalSlots (19 physical / 0 VM)',
    cadence: '300 s',
    duckdbTable: 'server_hardware_signal_samples',
  },
  {
    family: 'managed.ingress',
    width: '17 (unpaged)',
    perPage: '1 row per source',
    planCap: 'managedIngressEnabled (bool — no count cap)',
    cadence: 'every sample',
    duckdbTable: 'server_ingress_samples',
  },
  {
    family: 'managed.database_proxy',
    width: '6 (unpaged)',
    perPage: '1 row per source',
    planCap: 'databaseProxyMetricsEnabled (bool — no count cap)',
    cadence: 'every sample',
    duckdbTable: 'server_database_proxy_samples',
  },
  {
    family: 'cpu.detail',
    width: '7 (fixed)',
    perPage: '1 row',
    planCap: 'cpuDetailEnabled (off)',
    cadence: '300 s',
    duckdbTable: 'server_host_samples (columns)',
  },
  {
    family: 'memory.detail',
    width: '19 (fixed)',
    perPage: '1 row',
    planCap: 'memoryDetailEnabled (off)',
    cadence: '300 s',
    duckdbTable: 'server_memory_detail_samples',
  },
  {
    family: 'event',
    width: 'n/a (blobs)',
    perPage: '1 row per event',
    planCap: 'hardwareHealthEventsEnabled (kind filter)',
    cadence: 'every sample',
    duckdbTable: 'server_metric_events',
  },
]

console.log('METRICS ROW INVENTORY — every family, measured and cross-checked\n')
console.log('=== 1. Family catalog ===\n')
console.log(
  pad('AE family', 24) +
    pad('doubles', 14) +
    pad('AE packing', 18) +
    pad('cadence', 14) +
    'capability-plan cap'
)
console.log('-'.repeat(118))
for (const f of FAMILIES) {
  console.log(
    pad(f.family, 24) + pad(f.width, 14) + pad(f.perPage, 18) + pad(f.cadence, 14) + f.planCap
  )
}

console.log('\n=== 2. DuckDB table per family (self-hosted backend) ===\n')
for (const f of FAMILIES) {
  console.log('  ' + pad(f.family, 24) + '-> ' + f.duckdbTable)
}
console.log(
  '\n  DuckDB writes ONE ROW PER ENTITY with named nullable columns — no paging,\n' +
    '  no positional slots, no sentinel. AE packing is a Cloudflare-only concern.'
)

// ---------------------------------------------------------------------------
// 2. The three cardinality cases
// ---------------------------------------------------------------------------

type Case = { name: string; fixture: string; entities: number; family: string; perPage: number }

const CASES: Case[] = [
  { name: '8 NICs', fixture: '8-nic', entities: 8, family: 'network', perPage: 3 },
  { name: '24 drives', fixture: '24-block-devices', entities: 24, family: 'block', perPage: 2 },
  { name: '16 GPUs', fixture: '16-gpu', entities: 16, family: 'gpu', perPage: 2 },
]

function fixtureFor(name: string) {
  const f = representativeMachineFixtures().find((x) => x.name === name)
  if (!f) throw new Error(`no fixture ${name}`)
  return f
}

/** Rows AE writes for one sample, with and without the capability plan applied. */
function aeRows(fixtureName: string, applyPlan: boolean, slotMapping?: SlotMapping) {
  const fixture = fixtureFor(fixtureName)
  const built = buildMetricsSampleV5(fixture.input)
  const sample: MetricsSampleV5 = {
    ...built,
    metadata: {
      ...built.metadata,
      sampledAt: new Date(BASE_MS).toISOString(),
      intervalSeconds: 60,
    },
  }
  const planned = applyPlan
    ? truncateSampleToCapabilityPlanV5(sample, fixture.plan, slotMapping)
    : sample
  const points = buildMetricsDataPointsV5(
    { ...planned, serverId: SERVER_ID, receivedAt: planned.metadata.sampledAt },
    slotMapping
  )
  const byFamily = new Map<string, number>()
  for (const p of points) {
    const fam = String(p.blobs[1] ?? '')
    byFamily.set(fam, (byFamily.get(fam) ?? 0) + 1)
  }
  return { total: points.length, byFamily, sample: planned }
}

console.log('\n=== 3. High-cardinality handling ===\n')
console.log('The same hardware produces very different row counts depending on the')
console.log('capability plan in force. Three plans shown:')
console.log('  hosted   = platform default for a hosted VM   (2 NIC, 2 drives, 1 GPU)')
console.log('  selfhost = platform default for self-hosted   (8 NIC, 2 drives, 1 GPU)')
console.log('  granted  = an operator explicitly entitled to the full hardware\n')

function keptFor(
  c: Case,
  plan: ReturnType<typeof platformDefaultMetricsCapabilityPlan> | undefined
) {
  const fixture = fixtureFor(c.fixture)
  const built = buildMetricsSampleV5(fixture.input)
  const sample: MetricsSampleV5 = {
    ...built,
    metadata: {
      ...built.metadata,
      sampledAt: new Date(BASE_MS).toISOString(),
      intervalSeconds: 60,
    },
  }
  const effective = plan ?? fixture.plan
  const planned = truncateSampleToCapabilityPlanV5(sample, effective, fixture.slotMapping)
  const points = buildMetricsDataPointsV5(
    { ...planned, serverId: SERVER_ID, receivedAt: planned.metadata.sampledAt },
    fixture.slotMapping
  )
  const byFamily = new Map<string, number>()
  for (const p of points) {
    const fam = String(p.blobs[1] ?? '')
    byFamily.set(fam, (byFamily.get(fam) ?? 0) + 1)
  }
  const arr =
    c.family === 'network'
      ? planned.networks
      : c.family === 'block'
        ? planned.blockDevices
        : planned.gpus
  return { kept: arr.length, aeFamilyRows: byFamily.get(c.family) ?? 0, aeTotal: points.length }
}

console.log(
  pad('Case', 12) +
    pad('plan', 10) +
    padLeft('kept', 6) +
    padLeft('AE fam', 8) +
    padLeft('AE total', 10) +
    padLeft('DuckDB', 8) +
    '  arithmetic'
)
console.log('-'.repeat(92))
for (const c of CASES) {
  const variants: [string, ReturnType<typeof platformDefaultMetricsCapabilityPlan> | undefined][] =
    [
      ['hosted', platformDefaultMetricsCapabilityPlan('virtual', 'hosted')],
      ['selfhost', platformDefaultMetricsCapabilityPlan('physical', 'self-hosted')],
      ['granted', undefined],
    ]
  for (const [label, plan] of variants) {
    const { kept, aeFamilyRows, aeTotal } = keptFor(c, plan)
    const paged = c.family === 'network' ? Math.max(0, kept - 2) : kept
    const expected = paged === 0 ? 0 : Math.ceil(paged / c.perPage)
    const ok = aeFamilyRows === expected ? 'ok' : `MISMATCH exp ${expected}`
    console.log(
      pad(label === 'hosted' ? c.name : '', 12) +
        pad(label, 10) +
        padLeft(String(kept), 6) +
        padLeft(String(aeFamilyRows), 8) +
        padLeft(String(aeTotal), 10) +
        padLeft(String(kept), 8) +
        `  ${c.entities} reported -> ceil(${paged}/${c.perPage}) = ${expected} [${ok}]`
    )
  }
  console.log('')
}

// ---------------------------------------------------------------------------
// 3. Backend divergence
// ---------------------------------------------------------------------------

console.log('\n=== 4. Same sample, both backends ===\n')
for (const c of CASES) {
  const fixture = fixtureFor(c.fixture)
  const capped = aeRows(c.fixture, true, fixture.slotMapping)
  const duck = [...capped.byFamily.entries()].reduce((total, [fam, rows]) => {
    // AE pages entities; DuckDB does not. Recover per-entity counts.
    if (fam === 'network') return total + capped.sample.networks.length
    if (fam === 'block') return total + capped.sample.blockDevices.length
    if (fam === 'gpu') return total + capped.sample.gpus.length
    if (fam === 'hardware.physical') return total + capped.sample.hardwareSignals.length
    if (fam === 'filesystem') return total + capped.sample.filesystems.length
    return total + rows
  }, 0)
  console.log(
    `  ${pad(c.name, 12)} AE ${padLeft(String(capped.total), 3)} data points   DuckDB ${padLeft(String(duck), 3)} table rows`
  )
}

console.log('\n=== 5. Cadence tiers, by backend ===\n')
for (const [family, tier] of Object.entries(METRICS_CADENCE_TIERS_V5)) {
  console.log(`  ${pad(family, 22)} ${tier === 'every' ? 'every sample' : `every ${tier} s`}`)
}

console.log(
  '\nWARNING: the capability plan and the cadence tiers are applied at ingest,\n' +
    'BEFORE store selection, so a self-hosted DuckDB deployment is truncated and\n' +
    'decimated by controls that exist only to bound the hosted Cloudflare bill.\n' +
    'DuckDB rows are local disk and cost nothing. A self-hosted operator with 24\n' +
    'drives currently stores 2 of them, and their sensor history is 5-minute\n' +
    'resolution, for no benefit to them. See api-routes.ts.'
)

// sanity: decimation must never touch the two mandatory host rows
const probe = fixtureFor('bare-metal-gpu')
const built = buildMetricsSampleV5(probe.input)
const offTier: MetricsSampleV5 = {
  ...built,
  metadata: {
    ...built.metadata,
    sampledAt: new Date(BASE_MS + 60_000).toISOString(),
    intervalSeconds: 60,
  },
}
const after = decimateSampleToCadenceTiersV5(offTier, probe.slotMapping)
console.log(
  `\nInvariant check — host groups survive decimation: ${
    JSON.stringify(after.host) === JSON.stringify(offTier.host) ? 'ok' : 'FAILED'
  }`
)
