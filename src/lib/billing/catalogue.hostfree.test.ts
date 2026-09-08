/**
 * The catalogue ladder's shape — the defaults the admin tier form
 * prefills. Nothing here is written anywhere on its own; what a row must
 * satisfy on the Stripe side lives in `tier-verify.hostfree.test.ts`.
 */

import { assertEquals } from '@std/assert'
import { MAX_NIC_SLOTS } from '../../client/servers/topology-types.ts'
import {
  TIER_BAND_LABELS,
  TIER_CPU_CORE_THRESHOLDS,
  TIER_NIC_SLOT_THRESHOLDS,
  TIER_RAM_BYTE_THRESHOLDS,
} from '../tiers/tier-placement.ts'
import { billingCatalogue, SX_UNBOUNDED_CORES } from './catalogue.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('the ladder is S1…S7 then SX, ranked 1..8, in placement order', () => {
  const rows = billingCatalogue()
  assertEquals(rows.map((row) => row.label), [...TIER_BAND_LABELS])
  assertEquals(rows.map((row) => row.rank), [1, 2, 3, 4, 5, 6, 7, 8])
})

test('priced tiers take their core and RAM ceilings from the placement thresholds', () => {
  const priced = billingCatalogue().filter((row) => !row.isCustom)
  assertEquals(priced.length, TIER_CPU_CORE_THRESHOLDS.length)
  assertEquals(priced.map((row) => row.maxCores), [...TIER_CPU_CORE_THRESHOLDS])
  assertEquals(priced.map((row) => row.maxMemoryBytes), [...TIER_RAM_BYTE_THRESHOLDS])
  for (const row of priced) {
    assertEquals(typeof row.priceCents, 'number')
    assertEquals((row.priceCents ?? 0) > 0, true)
  }
})

test('SX is custom, unpriced, and unbounded', () => {
  const sx = billingCatalogue().at(-1)
  assertEquals(sx?.label, 'SX')
  assertEquals(sx?.isCustom, true)
  assertEquals(sx?.priceCents, null)
  assertEquals(sx?.maxCores, SX_UNBOUNDED_CORES)
})

test('prices and entitlements never decrease up the ladder', () => {
  const priced = billingCatalogue().filter((row) => !row.isCustom)
  for (let index = 1; index < priced.length; index += 1) {
    const lower = priced[index - 1]!
    const upper = priced[index]!
    assertEquals((upper.priceCents ?? 0) >= (lower.priceCents ?? 0), true, `${upper.label} price`)
    assertEquals(upper.nicSlots >= lower.nicSlots, true, `${upper.label} nic`)
    assertEquals(upper.driveSlots >= lower.driveSlots, true, `${upper.label} drive`)
    assertEquals(upper.gpuSlots >= lower.gpuSlots, true, `${upper.label} gpu`)
    assertEquals(upper.filesystemSlots >= lower.filesystemSlots, true, `${upper.label} fs`)
  }
})

test('NIC slots are the placement bands, never above the daemon ceiling, and the top of the ladder watches every slot', () => {
  const rows = billingCatalogue()
  const priced = rows.filter((row) => !row.isCustom)
  assertEquals(priced.map((row) => row.nicSlots), [...TIER_NIC_SLOT_THRESHOLDS])
  for (const row of rows) assertEquals(row.nicSlots <= MAX_NIC_SLOTS, true, `${row.label} nic ceiling`)
  assertEquals(priced.at(-1)?.nicSlots, MAX_NIC_SLOTS)
  assertEquals(rows.find((row) => row.isCustom)?.nicSlots, MAX_NIC_SLOTS)
})
