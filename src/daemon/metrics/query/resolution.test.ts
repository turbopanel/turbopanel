import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  bucketFloor,
  canonicalizeMetricsRange,
  MAX_METRICS_POINTS,
  MAX_METRICS_RANGE_SECONDS,
  parseMaxPoints,
  selectResolutionSeconds,
  validateMetricsRange,
} from './resolution.ts'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const MINUTE_MS = 60 * 1000

it('selectResolutionSeconds: ladder mapping', () => {
  const base = Date.parse('2026-01-01T00:00:00.000Z')

  assertEquals(selectResolutionSeconds({ fromMs: base, toMs: base + 5 * MINUTE_MS }), 10)
  assertEquals(selectResolutionSeconds({ fromMs: base, toMs: base + 10 * MINUTE_MS }), 10)
  assertEquals(selectResolutionSeconds({ fromMs: base, toMs: base + HOUR_MS }), 60)
  assertEquals(selectResolutionSeconds({ fromMs: base, toMs: base + 6 * HOUR_MS }), 300)
  assertEquals(selectResolutionSeconds({ fromMs: base, toMs: base + 24 * HOUR_MS }), 900)
  assertEquals(selectResolutionSeconds({ fromMs: base, toMs: base + 7 * DAY_MS }), 3600)
  assertEquals(selectResolutionSeconds({ fromMs: base, toMs: base + 30 * DAY_MS }), 21600)
  assertEquals(selectResolutionSeconds({ fromMs: base, toMs: base + 90 * DAY_MS }), 43200)
})

it('selectResolutionSeconds: exact tier boundaries and the instant above each', () => {
  const base = Date.parse('2026-01-01T00:00:00.000Z')

  // Exactly 10 minutes stays on the 10 s tier; one second more moves to 60 s.
  assertEquals(selectResolutionSeconds({ fromMs: base, toMs: base + 10 * MINUTE_MS }), 10)
  assertEquals(
    selectResolutionSeconds({
      fromMs: base,
      toMs: base + 10 * MINUTE_MS + 1000,
    }),
    60
  )

  // Exactly 1 hour stays on the 60 s tier; one second more moves to 300 s.
  assertEquals(selectResolutionSeconds({ fromMs: base, toMs: base + HOUR_MS }), 60)
  assertEquals(selectResolutionSeconds({ fromMs: base, toMs: base + HOUR_MS + 1000 }), 300)

  // Exactly 90 days lands on the coarsest 43200 s tier, and the resulting
  // point count (180) stays well under MAX_METRICS_POINTS (1500).
  assertEquals(selectResolutionSeconds({ fromMs: base, toMs: base + 90 * DAY_MS }), 43200)
  assertEquals((90 * DAY_MS) / 1000 / 43200, 180)
  assertEquals((90 * DAY_MS) / 1000 / 43200 <= MAX_METRICS_POINTS, true)
  assertEquals(
    selectResolutionSeconds({
      fromMs: base,
      toMs: base + 90 * DAY_MS + 1000,
    }),
    43200
  )
})

it('selectResolutionSeconds: honors requested resolution', () => {
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  assertEquals(
    selectResolutionSeconds({
      fromMs: base,
      toMs: base + HOUR_MS,
      requested: 3600,
    }),
    3600
  )
})

it('selectResolutionSeconds: clamps up for max points', () => {
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  const toMs = base + 90 * DAY_MS
  assertEquals(
    selectResolutionSeconds({
      fromMs: base,
      toMs,
      requested: 60,
      maxPoints: 100,
    }),
    43200
  )
})

it('selectResolutionSeconds: oversized maxPoints cannot bypass server cap', () => {
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  const toMs = base + 90 * DAY_MS
  // maxPoints is clamped to MAX_METRICS_POINTS (1500), so the 90-day range
  // climbs the ladder until 21600 s (360 points) satisfies the server cap.
  assertEquals(
    selectResolutionSeconds({
      fromMs: base,
      toMs,
      requested: 60,
      maxPoints: 200_000,
    }),
    21600
  )
})

it('parseMaxPoints: defaults blank input and rejects non-integers', () => {
  assertEquals(parseMaxPoints(undefined), {
    ok: true,
    value: MAX_METRICS_POINTS,
  })
  assertEquals(parseMaxPoints('  '), {
    ok: true,
    value: MAX_METRICS_POINTS,
  })
  assertEquals(parseMaxPoints(''), {
    ok: true,
    value: MAX_METRICS_POINTS,
  })
  assertEquals(parseMaxPoints('1.5'), {
    ok: false,
    message: 'maxPoints must be a positive integer',
  })
  assertEquals(parseMaxPoints('0'), {
    ok: false,
    message: 'maxPoints must be a positive integer',
  })
})

it('selectResolutionSeconds: ignores disallowed requested values and inverted ranges', () => {
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  assertEquals(
    selectResolutionSeconds({
      fromMs: base,
      toMs: base + HOUR_MS,
      requested: 90,
    }),
    60
  )
  // Inverted range collapses to zero width — the finest (10 s) tier.
  assertEquals(selectResolutionSeconds({ fromMs: base + HOUR_MS, toMs: base }), 10)
})

it('validateMetricsRange: accepts an equal from/to pair', () => {
  assertEquals(validateMetricsRange(1_000, 1_000), { ok: true })
})

it('parseMaxPoints: rejects values above MAX_METRICS_POINTS', () => {
  const parsed = parseMaxPoints(String(MAX_METRICS_POINTS + 1))
  assertEquals(parsed.ok, false)
  if (!parsed.ok) {
    assertEquals(parsed.message.includes(String(MAX_METRICS_POINTS)), true)
  }
  // One call, then narrow it — a fresh call expression re-widens the union.
  const hundred = parseMaxPoints('100')
  assertEquals(hundred.ok, true)
  if (hundred.ok) {
    assertEquals(hundred.value, 100)
  }
})

it('canonicalizeMetricsRange: bucket-aligns from and to', () => {
  const fromMs = Date.parse('2026-01-01T00:07:30.000Z')
  const toMs = Date.parse('2026-01-01T00:12:45.000Z')
  const range = canonicalizeMetricsRange(fromMs, toMs, 300)
  assertEquals(range.fromMs, Date.parse('2026-01-01T00:05:00.000Z'))
  assertEquals(range.toMs, Date.parse('2026-01-01T00:10:00.000Z'))
  assertEquals(range.fromIso, '2026-01-01T00:05:00.000Z')
  assertEquals(range.toIso, '2026-01-01T00:10:00.000Z')
})

it('validateMetricsRange: rejects invalid and oversized ranges', () => {
  assertEquals(validateMetricsRange(Number.NaN, 1), {
    ok: false,
    code: 'invalid_range',
    message: 'from and to must be valid timestamps',
  })
  assertEquals(validateMetricsRange(2, 1), {
    ok: false,
    code: 'invalid_range',
    message: 'from must be before or equal to to',
  })
  const fromMs = 0
  const toMs = (MAX_METRICS_RANGE_SECONDS + 1) * 1000
  const tooLarge = validateMetricsRange(fromMs, toMs)
  assertEquals(tooLarge.ok, false)
  if (!tooLarge.ok) {
    assertEquals(tooLarge.code, 'range_too_large')
  }
})

it('bucketFloor: aligns to resolution boundary', () => {
  const ms = Date.parse('2026-01-01T00:07:30.000Z')
  assertEquals(bucketFloor(ms, 300), Date.parse('2026-01-01T00:05:00.000Z'))
})
