import { AE_DEFAULT_MAX_RANGE_SECONDS } from '../backends/cloudflare/sql-api-v5.ts'
import { bucketFloor } from './buckets.ts'

export { bucketFloor } from './buckets.ts'

export const MAX_METRICS_POINTS = 1500

/** Conservative cap aligned with documented AE retention (90 days). */
export const MAX_METRICS_RANGE_SECONDS = AE_DEFAULT_MAX_RANGE_SECONDS

export const METRICS_RESOLUTION_SECONDS = [10, 60, 300, 900, 3600, 21600, 43200] as const

export type MetricsResolutionSeconds = (typeof METRICS_RESOLUTION_SECONDS)[number]

export type MetricsRangeError =
  | { ok: false; code: 'invalid_range'; message: string }
  | { ok: false; code: 'range_too_large'; message: string }

const TEN_MINUTES_SECONDS = 10 * 60
const ONE_HOUR_SECONDS = 60 * 60
const SIX_HOURS_SECONDS = 6 * 60 * 60
const TWENTY_FOUR_HOURS_SECONDS = 24 * 60 * 60
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60

function isAllowedResolution(value: number): value is MetricsResolutionSeconds {
  return (METRICS_RESOLUTION_SECONDS as readonly number[]).includes(value)
}

function ladderResolutionSeconds(rangeSeconds: number): MetricsResolutionSeconds {
  if (rangeSeconds <= TEN_MINUTES_SECONDS) {
    return 10
  }
  if (rangeSeconds <= ONE_HOUR_SECONDS) {
    return 60
  }
  if (rangeSeconds <= SIX_HOURS_SECONDS) {
    return 300
  }
  if (rangeSeconds <= TWENTY_FOUR_HOURS_SECONDS) {
    return 900
  }
  if (rangeSeconds <= SEVEN_DAYS_SECONDS) {
    return 3600
  }
  if (rangeSeconds <= THIRTY_DAYS_SECONDS) {
    return 21600
  }
  return 43200
}

function clampResolutionForMaxPoints(
  rangeSeconds: number,
  resolutionSeconds: MetricsResolutionSeconds,
  maxPoints: number
): MetricsResolutionSeconds {
  let current = resolutionSeconds
  const steps = METRICS_RESOLUTION_SECONDS
  let index = steps.indexOf(current)
  while (index < steps.length - 1 && rangeSeconds / current > maxPoints) {
    index += 1
    current = steps[index]!
  }
  return current
}

export type ParseMaxPointsResult =
  | { ok: true; value: number }
  | {
      ok: false
      message: string
    }

/** Client `maxPoints` may only lower the server cap — never raise it. */
export function parseMaxPoints(raw: string | undefined): ParseMaxPointsResult {
  if (raw === undefined || raw.trim() === '') {
    return { ok: true, value: MAX_METRICS_POINTS }
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: 'maxPoints must be a positive integer' }
  }
  if (parsed > MAX_METRICS_POINTS) {
    return {
      ok: false,
      message: `maxPoints cannot exceed ${MAX_METRICS_POINTS}`,
    }
  }
  return { ok: true, value: parsed }
}

function effectiveMaxPoints(maxPoints: number | undefined): number {
  const requested = maxPoints ?? MAX_METRICS_POINTS
  return Math.min(requested, MAX_METRICS_POINTS)
}

export function selectResolutionSeconds(input: {
  fromMs: number
  toMs: number
  requested?: number
  maxPoints?: number
}): MetricsResolutionSeconds {
  const rangeSeconds = Math.max(0, (input.toMs - input.fromMs) / 1000)
  const maxPoints = effectiveMaxPoints(input.maxPoints)

  let resolution = ladderResolutionSeconds(rangeSeconds)
  if (
    input.requested !== undefined &&
    Number.isFinite(input.requested) &&
    isAllowedResolution(input.requested)
  ) {
    resolution = input.requested
  }

  return clampResolutionForMaxPoints(rangeSeconds, resolution, maxPoints)
}

/** Bucket-align query/cache range so keys and backend queries stay identical. */
export function canonicalizeMetricsRange(
  fromMs: number,
  toMs: number,
  resolutionSeconds: number
): { fromMs: number; toMs: number; fromIso: string; toIso: string } {
  const canonicalFromMs = bucketFloor(fromMs, resolutionSeconds)
  const canonicalToMs = bucketFloor(toMs, resolutionSeconds)
  return {
    fromMs: canonicalFromMs,
    toMs: canonicalToMs,
    fromIso: new Date(canonicalFromMs).toISOString(),
    toIso: new Date(canonicalToMs).toISOString(),
  }
}

export function validateMetricsRange(
  fromMs: number,
  toMs: number
): { ok: true } | MetricsRangeError {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return {
      ok: false,
      code: 'invalid_range',
      message: 'from and to must be valid timestamps',
    }
  }
  if (fromMs > toMs) {
    return {
      ok: false,
      code: 'invalid_range',
      message: 'from must be before or equal to to',
    }
  }
  const rangeSeconds = (toMs - fromMs) / 1000
  if (rangeSeconds > MAX_METRICS_RANGE_SECONDS) {
    return {
      ok: false,
      code: 'range_too_large',
      message: `range exceeds maximum of ${MAX_METRICS_RANGE_SECONDS} seconds`,
    }
  }
  return { ok: true }
}
