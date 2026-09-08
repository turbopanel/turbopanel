import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import { DuckDbParquetServerMetricsStore } from '../daemon/metrics/backends/duckdb/store.ts'
import {
  getActiveServerMetricsStore,
  resetActiveServerMetricsStoreForTests,
  setActiveServerMetricsStore,
} from '../daemon/metrics/active-store.ts'
import { DisabledServerMetricsStore } from '../daemon/metrics/disabled-store.ts'
import { registerMetricsDuckDbUiRoutes } from './metrics-duckdb-ui-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function duckDbShapedStore(startUiServer: () => Promise<{ port: number }>): unknown {
  const store = { startUiServer }
  Object.setPrototypeOf(store, DuckDbParquetServerMetricsStore.prototype)
  return store
}

test('POST /metrics/duckdb-ui returns 503 when the live store is not DuckDB', async () => {
  resetActiveServerMetricsStoreForTests()
  setActiveServerMetricsStore(new DisabledServerMetricsStore())
  try {
    const developer = new Hono()
    registerMetricsDuckDbUiRoutes(developer)
    const res = await developer.request('http://localhost/metrics/duckdb-ui', {
      method: 'POST',
    })
    assertEquals(res.status, 503)
    assertEquals(await res.json(), {
      ok: false,
      error: 'DuckDB metrics store is not active (Deno runtime only)',
    })
    assertEquals(getActiveServerMetricsStore() instanceof DisabledServerMetricsStore, true)
  } finally {
    resetActiveServerMetricsStoreForTests()
  }
})

test('POST /metrics/duckdb-ui returns the UI port when startUiServer succeeds', async () => {
  const developer = new Hono()
  registerMetricsDuckDbUiRoutes(developer, {
    resolveStore: () => duckDbShapedStore(() => Promise.resolve({ port: 4213 })),
  })
  const res = await developer.request('http://localhost/metrics/duckdb-ui', {
    method: 'POST',
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true, port: 4213 })
})

test('POST /metrics/duckdb-ui returns 500 when startUiServer throws', async () => {
  const developer = new Hono()
  registerMetricsDuckDbUiRoutes(developer, {
    resolveStore: () =>
      duckDbShapedStore(() => Promise.reject(new Error('port already bound'))),
  })
  const errorRes = await developer.request('http://localhost/metrics/duckdb-ui', {
    method: 'POST',
  })
  assertEquals(errorRes.status, 500)
  assertEquals(await errorRes.json(), {
    ok: false,
    error: 'failed to start DuckDB UI: port already bound',
  })

  const stringThrow = new Hono()
  registerMetricsDuckDbUiRoutes(stringThrow, {
    resolveStore: () => duckDbShapedStore(() => Promise.reject('no listener')),
  })
  const stringRes = await stringThrow.request('http://localhost/metrics/duckdb-ui', {
    method: 'POST',
  })
  assertEquals(stringRes.status, 500)
  assertEquals(await stringRes.json(), {
    ok: false,
    error: 'failed to start DuckDB UI: no listener',
  })
})
