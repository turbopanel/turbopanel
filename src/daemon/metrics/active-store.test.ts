import { assertEquals } from '@std/assert'
import {
  getActiveServerMetricsStore,
  resetActiveServerMetricsStoreForTests,
  setActiveServerMetricsStore,
} from './active-store.ts'
import { DisabledServerMetricsStore } from './disabled-store.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('active store handle starts empty and round-trips a registered store', () => {
  resetActiveServerMetricsStoreForTests()
  assertEquals(getActiveServerMetricsStore(), null)

  const store = new DisabledServerMetricsStore()
  setActiveServerMetricsStore(store)
  assertEquals(getActiveServerMetricsStore(), store)

  setActiveServerMetricsStore(null)
  assertEquals(getActiveServerMetricsStore(), null)

  resetActiveServerMetricsStoreForTests()
})
