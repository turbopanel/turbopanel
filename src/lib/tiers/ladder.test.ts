/**
 * The tier ladder is the one place that says what a label means, so the
 * things every other module assumes about it are pinned here: labels and
 * ranks are unique and ordered, no rung sells a NIC slot the daemon cannot
 * monitor, the placement thresholds are cut from these rows and nothing
 * else, and the entitlement shape the capability plan consumes is what
 * `ladderEntitlements` emits.
 */

import { assertEquals } from '@std/assert'
import { MAX_NIC_SLOTS } from '../../client/servers/topology-types.ts'
import {
  CATALOGUE_CURRENCY,
  CUSTOM_TIER_LABEL,
  ENTRY_TIER_RANK,
  isTierLabel,
  LADDER,
  ladderEntitlements,
  ladderEntry,
  ladderEntryByRank,
  ladderRank,
  PRICED_LADDER,
  SX_UNBOUNDED_CORES,
  SX_UNBOUNDED_MEMORY_BYTES,
  TIER_LABELS,
} from './ladder.ts'
import {
  cpuBand,
  ramBand,
  TIER_CPU_CORE_THRESHOLDS,
  TIER_DRIVE_SLOT_THRESHOLDS,
  TIER_GPU_SLOT_THRESHOLDS,
  TIER_NIC_SLOT_THRESHOLDS,
  TIER_RAM_BYTE_THRESHOLDS,
} from './tier-placement.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('labels and ranks are unique, and the ladder is S1…S7 then SX in rank order', () => {
  assertEquals(LADDER.map((entry) => entry.label), [...TIER_LABELS])
  assertEquals(new Set(LADDER.map((entry) => entry.label)).size, LADDER.length)
  assertEquals(new Set(LADDER.map((entry) => entry.rank)).size, LADDER.length)
  // Ranks are 1…N with no gaps: the greedy assignment and the bands index by them.
  assertEquals(LADDER.map((entry) => entry.rank), LADDER.map((_, index) => index + 1))
  assertEquals(LADDER[0]?.rank, ENTRY_TIER_RANK)
  assertEquals(LADDER.at(-1)?.label, CUSTOM_TIER_LABEL)
})

test('every ceiling and slot budget is non-decreasing up the ladder', () => {
  const keys = ['maxCores', 'maxMemoryBytes', 'nicSlots', 'driveSlots', 'gpuSlots', 'filesystemSlots'] as const
  for (const key of keys) {
    for (let index = 1; index < LADDER.length; index++) {
      const below = LADDER[index - 1]![key]
      const here = LADDER[index]![key]
      assertEquals(here >= below, true, `${key} falls from ${LADDER[index - 1]!.label} to ${LADDER[index]!.label}`)
    }
  }
})

test('no tier sells a NIC slot the daemon cannot monitor, and SX watches every one', () => {
  for (const entry of LADDER) {
    assertEquals(entry.nicSlots <= MAX_NIC_SLOTS, true, entry.label)
    assertEquals(entry.nicSlots > 0, true, entry.label)
  }
  assertEquals(ladderEntry('SX')?.nicSlots, MAX_NIC_SLOTS)
})

test('SX is the one custom rung: unbounded, unpriced, never purchasable', () => {
  const sx = ladderEntry(CUSTOM_TIER_LABEL)
  assertEquals(sx?.isCustom, true)
  assertEquals(sx?.listPriceCents, null)
  assertEquals([sx?.maxCores, sx?.maxMemoryBytes], [SX_UNBOUNDED_CORES, SX_UNBOUNDED_MEMORY_BYTES])
  assertEquals(LADDER.filter((entry) => entry.isCustom).map((entry) => entry.label), ['SX'])
  // Every priced rung carries a positive list price the provider's Product is expected to match.
  assertEquals(PRICED_LADDER.map((entry) => entry.label), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'])
  for (const entry of PRICED_LADDER) {
    assertEquals(typeof entry.listPriceCents === 'number' && entry.listPriceCents > 0, true, entry.label)
  }
  assertEquals(CATALOGUE_CURRENCY, 'usd')
})

test('the placement thresholds are the priced ladder, column by column', () => {
  assertEquals(TIER_CPU_CORE_THRESHOLDS, PRICED_LADDER.map((entry) => entry.maxCores))
  assertEquals(TIER_RAM_BYTE_THRESHOLDS, PRICED_LADDER.map((entry) => entry.maxMemoryBytes))
  assertEquals(TIER_NIC_SLOT_THRESHOLDS, PRICED_LADDER.map((entry) => entry.nicSlots))
  assertEquals(TIER_DRIVE_SLOT_THRESHOLDS, PRICED_LADDER.map((entry) => entry.driveSlots))
  // GPU counts repeat across neighbouring rungs; the band is the first rank selling each count.
  const distinctGpu = [...new Set(PRICED_LADDER.map((entry) => entry.gpuSlots))]
  assertEquals(TIER_GPU_SLOT_THRESHOLDS, distinctGpu)
  // A server exactly at a rung's ceiling is placed on that rung; one core over needs the next.
  for (const entry of PRICED_LADDER) {
    assertEquals(cpuBand(entry.maxCores).label, entry.label)
    assertEquals(ramBand(entry.maxMemoryBytes).label, entry.label)
  }
  assertEquals(cpuBand(PRICED_LADDER.at(-1)!.maxCores + 1).label, 'SX')
})

test('ladderEntitlements emits the capability-plan shape, with isEntryTier true for S1 only', () => {
  assertEquals(ladderEntitlements('S3'), { nicSlots: 5, driveSlots: 6, gpuSlots: 2, filesystemSlots: 9, isEntryTier: false })
  assertEquals(ladderEntitlements('S1'), { nicSlots: 2, driveSlots: 2, gpuSlots: 2, filesystemSlots: 9, isEntryTier: true })
  for (const entry of LADDER) {
    const entitlements = ladderEntitlements(entry.label)
    assertEquals(Object.keys(entitlements ?? {}).sort(), ['driveSlots', 'filesystemSlots', 'gpuSlots', 'isEntryTier', 'nicSlots'])
    assertEquals(entitlements?.isEntryTier, entry.rank === ENTRY_TIER_RANK, entry.label)
  }
  // A label off the ladder is "no tier": the platform default plan.
  assertEquals(ladderEntitlements('S9'), undefined)
  assertEquals(ladderEntitlements(null), undefined)
  assertEquals(ladderEntitlements(undefined), undefined)
  assertEquals(ladderEntitlements(''), undefined)
})

test('the lookups answer by label and by rank, and refuse anything else', () => {
  assertEquals(ladderEntry('S5')?.rank, 5)
  assertEquals(ladderEntry('s5'), undefined)
  assertEquals(ladderEntry(undefined), undefined)
  assertEquals(ladderEntryByRank(7)?.label, 'S7')
  assertEquals(ladderEntryByRank(0), undefined)
  assertEquals(ladderEntryByRank(null), undefined)
  assertEquals(ladderRank('SX'), 8)
  assertEquals(ladderRank('S9'), null)
  assertEquals(ladderRank(null), null)
  assertEquals(isTierLabel('S1'), true)
  assertEquals(isTierLabel('SX'), true)
  assertEquals(isTierLabel('S0'), false)
  assertEquals(isTierLabel(1), false)
})
