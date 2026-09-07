import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  createMetricsChartCache,
  createWorkersMetricsChartCacheForTests,
  METRICS_HISTORICAL_CACHE_TTL_SECONDS,
  METRICS_LIVE_10S_CACHE_TTL_SECONDS,
  METRICS_LIVE_CACHE_TTL_SECONDS,
  metricsChartCacheKey,
  resetDenoMetricsChartCacheForTests,
  resolveChartCacheTtlSeconds,
} from './cache.ts'

it('metricsChartCacheKey: stable metric ordering and schema version', () => {
  const keyA = metricsChartCacheKey({
    serverId: '11111111-1111-4111-8111-111111111111',
    fromBucketMs: 1_000,
    toBucketMs: 2_000,
    metrics: ['host.memory.usedBytes', 'host.cpu.userPercent'],
    resolutionSeconds: 300,
    backend: 'duckdb',
    schemaVersion: 5,
  })
  const keyB = metricsChartCacheKey({
    serverId: '11111111-1111-4111-8111-111111111111',
    fromBucketMs: 1_000,
    toBucketMs: 2_000,
    metrics: ['host.cpu.userPercent', 'host.memory.usedBytes'],
    resolutionSeconds: 300,
    backend: 'duckdb',
    schemaVersion: 5,
  })
  assertEquals(keyA, keyB)
  assertEquals(keyA.includes('v5'), true)
})

it('metricsChartCacheKey: topologyGeneration is appended only when provided', () => {
  const withoutGeneration = metricsChartCacheKey({
    serverId: '11111111-1111-4111-8111-111111111111',
    fromBucketMs: 1_000,
    toBucketMs: 2_000,
    metrics: ['host.cpu.userPercent'],
    resolutionSeconds: 300,
    backend: 'duckdb',
    schemaVersion: 5,
  })
  const withGeneration = metricsChartCacheKey({
    serverId: '11111111-1111-4111-8111-111111111111',
    fromBucketMs: 1_000,
    toBucketMs: 2_000,
    metrics: ['host.cpu.userPercent'],
    resolutionSeconds: 300,
    backend: 'duckdb',
    schemaVersion: 5,
    topologyGeneration: 2,
  })
  assertEquals(withoutGeneration.includes(':tg'), false)
  assertEquals(withGeneration.endsWith(':tg2'), true)
  assertEquals(withGeneration === withoutGeneration, false)
})

it('resolveChartCacheTtlSeconds: live vs historical', () => {
  const nowMs = Date.parse('2026-01-01T01:00:00.000Z')
  assertEquals(
    resolveChartCacheTtlSeconds({
      toMs: Date.parse('2026-01-01T00:59:30.000Z'),
      nowMs,
      resolutionSeconds: 60,
    }),
    METRICS_LIVE_CACHE_TTL_SECONDS
  )
  assertEquals(
    resolveChartCacheTtlSeconds({
      toMs: Date.parse('2025-12-31T23:00:00.000Z'),
      nowMs,
      resolutionSeconds: 60,
    }),
    METRICS_HISTORICAL_CACHE_TTL_SECONDS
  )
})

it('resolveChartCacheTtlSeconds: 10 s resolution uses the short live TTL', () => {
  const nowMs = Date.parse('2026-01-01T01:00:00.000Z')
  assertEquals(
    resolveChartCacheTtlSeconds({
      toMs: Date.parse('2026-01-01T00:59:55.000Z'),
      nowMs,
      resolutionSeconds: 10,
    }),
    METRICS_LIVE_10S_CACHE_TTL_SECONDS
  )
  // Much shorter than the standard live TTL — a live 10 s chart refreshes
  // faster than 45 s.
  assertEquals(METRICS_LIVE_10S_CACHE_TTL_SECONDS < METRICS_LIVE_CACHE_TTL_SECONDS, true)
})

it('Deno metrics chart cache: get/set and bounded eviction', async () => {
  resetDenoMetricsChartCacheForTests()
  const cache = createMetricsChartCache('deno')
  const key = metricsChartCacheKey({
    serverId: '11111111-1111-4111-8111-111111111111',
    fromBucketMs: 0,
    toBucketMs: 60_000,
    metrics: ['host.cpu.userPercent'],
    resolutionSeconds: 60,
    backend: 'disabled',
    schemaVersion: 5,
  })

  assertEquals(await cache.get(key), null)
  await cache.set(key, { ok: true, value: 1 }, 60)
  assertEquals(await cache.get<{ ok: true; value: number }>(key), {
    ok: true,
    value: 1,
  })

  for (let i = 0; i < 256; i++) {
    await cache.set(`tp:metrics:chart:evict:${i}`, i, 3600)
  }
  await cache.set('tp:metrics:chart:evict:new', 999, 3600)
  assertEquals(await cache.get('tp:metrics:chart:evict:0'), null)
  assertEquals(await cache.get('tp:metrics:chart:evict:new'), 999)
})

it('Workers metrics chart cache: fail open on storage errors', async () => {
  const cache = createWorkersMetricsChartCacheForTests({
    match: async () => {
      throw new Error('cache read failed')
    },
    put: async () => {
      throw new Error('cache write failed')
    },
  })
  const key = 'tp:metrics:chart:test'
  assertEquals(await cache.get(key), null)
  await cache.set(key, { ok: true }, 30)
})

it('Deno metrics chart cache: expired entries are evicted on get', async () => {
  resetDenoMetricsChartCacheForTests()
  const cache = createMetricsChartCache('deno')
  const key = 'tp:metrics:chart:expired'
  await cache.set(key, { stale: true }, 1)
  assertEquals(await cache.get(key), { stale: true })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assertEquals(await cache.get(key), null)
})
