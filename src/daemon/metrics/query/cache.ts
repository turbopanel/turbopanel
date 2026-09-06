import type { MetricsBackendKind } from '../types-v4.ts'

export const METRICS_CHART_CACHE_PREFIX = 'tp:metrics:chart:'

export const METRICS_LIVE_CACHE_TTL_SECONDS = 45
export const METRICS_HISTORICAL_CACHE_TTL_SECONDS = 300

/**
 * TTL for 10 s-resolution reads (live sessions) — a 45 s TTL would collapse
 * a fast-cadence chart into ~4 identical refreshes per cached response.
 */
export const METRICS_LIVE_10S_CACHE_TTL_SECONDS = 5

const DENO_CACHE_MAX_ENTRIES = 256

export interface MetricsChartCache {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>
}

export function metricsChartCacheKey(input: {
  serverId: string
  fromBucketMs: number
  toBucketMs: number
  /** Canonical v4 metric names. */
  metrics: readonly string[]
  resolutionSeconds: number
  backend: MetricsBackendKind
  /** v4 callers must pass `4` explicitly. */
  schemaVersion: number
  kind?: 'series' | 'summary' | 'connection' | 'fleet-latest' | 'events' | 'entity-series'
  /**
   * Scopes the cache entry to one topology generation. Uses a distinct
   * `tg{gen}` token, appended only when provided so it never collides with a
   * full-range entry, which omits it.
   */
  topologyGeneration?: number
}): string {
  const sortedMetrics = [...input.metrics].sort((a, b) => a.localeCompare(b)).join(',')
  const kind = input.kind ?? 'series'
  return [
    METRICS_CHART_CACHE_PREFIX,
    kind,
    input.serverId,
    String(input.fromBucketMs),
    String(input.toBucketMs),
    sortedMetrics,
    String(input.resolutionSeconds),
    input.backend,
    `v${input.schemaVersion}`,
    ...(input.topologyGeneration !== undefined ? [`tg${input.topologyGeneration}`] : []),
  ].join(':')
}

export function resolveChartCacheTtlSeconds(input: {
  toMs: number
  nowMs: number
  resolutionSeconds: number
}): number {
  // 10 s resolution only exists for short live windows — cache barely.
  if (input.resolutionSeconds <= 10) {
    return METRICS_LIVE_10S_CACHE_TTL_SECONDS
  }
  const liveThresholdMs = input.nowMs - input.resolutionSeconds * 1000
  if (input.toMs >= liveThresholdMs) {
    return METRICS_LIVE_CACHE_TTL_SECONDS
  }
  return METRICS_HISTORICAL_CACHE_TTL_SECONDS
}

type DenoCacheEntry = {
  value: unknown
  expiresAtMs: number
}

let denoCacheSingleton: Map<string, DenoCacheEntry> | null = null

function getDenoCacheMap(): Map<string, DenoCacheEntry> {
  denoCacheSingleton ??= new Map()
  return denoCacheSingleton
}

/** Test seam: reset the Deno in-process chart cache. */
export function resetDenoMetricsChartCacheForTests(): void {
  denoCacheSingleton = new Map()
}

function evictOldestDenoEntry(cache: Map<string, DenoCacheEntry>): void {
  const firstKey = cache.keys().next().value
  if (firstKey !== undefined) {
    cache.delete(firstKey)
  }
}

function createDenoMetricsChartCache(): MetricsChartCache {
  const cache = getDenoCacheMap()
  return {
    async get<T>(key: string): Promise<T | null> {
      const entry = cache.get(key)
      if (!entry) return null
      if (Date.now() >= entry.expiresAtMs) {
        cache.delete(key)
        return null
      }
      return entry.value as T
    },
    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      if (cache.size >= DENO_CACHE_MAX_ENTRIES && !cache.has(key)) {
        evictOldestDenoEntry(cache)
      }
      cache.set(key, {
        value,
        expiresAtMs: Date.now() + Math.max(1, ttlSeconds) * 1000,
      })
    },
  }
}

type WorkersCacheStorage = {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

function resolveWorkersCacheStorage(): WorkersCacheStorage | null {
  const globalCaches = (
    globalThis as {
      caches?: { default?: WorkersCacheStorage }
    }
  ).caches
  return globalCaches?.default ?? null
}

function workersCacheRequestForKey(key: string): Request {
  const encoded = encodeURIComponent(key)
  return new Request(`https://metrics-cache.turbopanel.internal/${encoded}`)
}

function createWorkersMetricsChartCache(storage?: WorkersCacheStorage | null): MetricsChartCache {
  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        const resolved = storage ?? resolveWorkersCacheStorage()
        if (!resolved) return null
        const response = await resolved.match(workersCacheRequestForKey(key))
        if (!response) return null
        return (await response.json()) as T
      } catch {
        return null
      }
    },
    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      try {
        const resolved = storage ?? resolveWorkersCacheStorage()
        if (!resolved) return
        const response = new Response(JSON.stringify(value), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `max-age=${Math.max(1, ttlSeconds)}`,
          },
        })
        await resolved.put(workersCacheRequestForKey(key), response)
      } catch {
        // fail open
      }
    },
  }
}

/** @internal Test seam for injected Workers Cache API storage. */
export function createWorkersMetricsChartCacheForTests(
  storage: WorkersCacheStorage | null
): MetricsChartCache {
  return createWorkersMetricsChartCache(storage)
}

export function createMetricsChartCache(runtime: 'workers' | 'deno'): MetricsChartCache {
  if (runtime === 'workers') {
    return createWorkersMetricsChartCache()
  }
  return createDenoMetricsChartCache()
}
