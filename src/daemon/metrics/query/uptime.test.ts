import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { computeStatusUptime } from './uptime.ts'

const FROM = '2026-01-01T00:00:00.000Z'
const TO = '2026-01-01T01:00:00.000Z'
const FROM_MS = Date.parse(FROM)
const TO_MS = Date.parse(TO)
const HOUR = 3600

it('unknown leading span accrues to unknownSeconds', () => {
  const result = computeStatusUptime({
    fromMs: FROM_MS,
    toMs: TO_MS,
    initialConnected: null,
    events: [
      {
        at: '2026-01-01T00:30:00.000Z',
        connected: true,
        reason: 'connect',
      },
    ],
  })
  assertEquals(result.unknownSeconds, HOUR / 2)
  assertEquals(result.uptimeSeconds, HOUR / 2)
  assertEquals(result.downtimeSeconds, 0)
  assertEquals(result.uptimePercent, 1)
})

it('single connect from known offline', () => {
  const result = computeStatusUptime({
    fromMs: FROM_MS,
    toMs: TO_MS,
    initialConnected: false,
    events: [
      {
        at: '2026-01-01T00:15:00.000Z',
        connected: true,
        reason: 'connect',
      },
    ],
  })
  assertEquals(result.downtimeSeconds, 15 * 60)
  assertEquals(result.uptimeSeconds, 45 * 60)
  assertEquals(result.unknownSeconds, 0)
  assertEquals(result.uptimePercent, 0.75)
})

it('flap sequence attributes each span', () => {
  const result = computeStatusUptime({
    fromMs: FROM_MS,
    toMs: TO_MS,
    initialConnected: true,
    events: [
      {
        at: '2026-01-01T00:10:00.000Z',
        connected: false,
        reason: 'disconnect',
      },
      {
        at: '2026-01-01T00:40:00.000Z',
        connected: true,
        reason: 'connect',
      },
    ],
  })
  assertEquals(result.uptimeSeconds, 10 * 60 + 20 * 60)
  assertEquals(result.downtimeSeconds, 30 * 60)
  assertEquals(result.unknownSeconds, 0)
  assertEquals(result.uptimePercent, 0.5)
})

it('no events with known initial state fills the whole range', () => {
  const up = computeStatusUptime({
    fromMs: FROM_MS,
    toMs: TO_MS,
    initialConnected: true,
    events: [],
  })
  assertEquals(up.uptimeSeconds, HOUR)
  assertEquals(up.downtimeSeconds, 0)
  assertEquals(up.uptimePercent, 1)

  const down = computeStatusUptime({
    fromMs: FROM_MS,
    toMs: TO_MS,
    initialConnected: false,
    events: [],
  })
  assertEquals(down.uptimeSeconds, 0)
  assertEquals(down.downtimeSeconds, HOUR)
  assertEquals(down.uptimePercent, 0)
})

it('events outside the range are ignored; in-range events clamp spans', () => {
  const result = computeStatusUptime({
    fromMs: FROM_MS,
    toMs: TO_MS,
    initialConnected: false,
    events: [
      {
        at: '2025-12-31T23:00:00.000Z',
        connected: true,
        reason: 'connect',
      },
      {
        at: '2026-01-01T00:30:00.000Z',
        connected: true,
        reason: 'connect',
      },
      {
        at: '2026-01-01T02:00:00.000Z',
        connected: false,
        reason: 'disconnect',
      },
    ],
  })
  // Outside events ignored; same-state connect at 00:30 ignored vs initial false? No —
  // initial is false, connect at 00:30 flips. Outside connect does not update initial.
  assertEquals(result.downtimeSeconds, HOUR / 2)
  assertEquals(result.uptimeSeconds, HOUR / 2)
  assertEquals(result.unknownSeconds, 0)
})

it('uptimePercent is null when only unknown', () => {
  const result = computeStatusUptime({
    fromMs: FROM_MS,
    toMs: TO_MS,
    initialConnected: null,
    events: [],
  })
  assertEquals(result.unknownSeconds, HOUR)
  assertEquals(result.uptimeSeconds, 0)
  assertEquals(result.downtimeSeconds, 0)
  assertEquals(result.uptimePercent, null)
})

it('duplicate same-state events are ignored', () => {
  const result = computeStatusUptime({
    fromMs: FROM_MS,
    toMs: TO_MS,
    initialConnected: true,
    events: [
      {
        at: '2026-01-01T00:10:00.000Z',
        connected: true,
        reason: 'connect',
      },
      {
        at: '2026-01-01T00:20:00.000Z',
        connected: false,
        reason: 'disconnect',
      },
      {
        at: '2026-01-01T00:30:00.000Z',
        connected: false,
        reason: 'disconnect',
      },
    ],
  })
  assertEquals(result.uptimeSeconds, 20 * 60)
  assertEquals(result.downtimeSeconds, 40 * 60)
})

it('knownUntilMs stops extending last state; suffix is unknown', () => {
  const knownUntilMs = Date.parse('2026-01-01T00:30:00.000Z')
  const result = computeStatusUptime({
    fromMs: FROM_MS,
    toMs: TO_MS,
    initialConnected: false,
    events: [
      {
        at: '2026-01-01T00:15:00.000Z',
        connected: true,
        reason: 'connect',
      },
      {
        at: '2026-01-01T00:30:00.000Z',
        connected: false,
        reason: 'disconnect',
      },
    ],
    knownUntilMs,
  })
  // Known prefix: 15m down + 15m up. Truncated suffix (30m) is unknown —
  // not downtime from the last retained offline state.
  assertEquals(result.downtimeSeconds, 15 * 60)
  assertEquals(result.uptimeSeconds, 15 * 60)
  assertEquals(result.unknownSeconds, 30 * 60)
  assertEquals(result.uptimePercent, 0.5)
})

it('invalid or inverted ranges return zero totals', () => {
  const invalid = computeStatusUptime({
    fromMs: Number.NaN,
    toMs: TO_MS,
    initialConnected: true,
    events: [],
  })
  assertEquals(invalid, {
    uptimeSeconds: 0,
    downtimeSeconds: 0,
    unknownSeconds: 0,
    uptimePercent: null,
  })

  const inverted = computeStatusUptime({
    fromMs: TO_MS,
    toMs: FROM_MS,
    initialConnected: true,
    events: [],
  })
  assertEquals(inverted.uptimePercent, null)
})

it('returns zeros for an inverted or non-finite window', () => {
  assertEquals(
    computeStatusUptime({
      fromMs: TO_MS,
      toMs: FROM_MS,
      initialConnected: true,
      events: [],
    }),
    {
      uptimeSeconds: 0,
      downtimeSeconds: 0,
      unknownSeconds: 0,
      uptimePercent: null,
    }
  )
})

it('skips unparseable events and treats NaN knownUntilMs as the full window', () => {
  const result = computeStatusUptime({
    fromMs: FROM_MS,
    toMs: TO_MS,
    initialConnected: true,
    events: [
      { at: 'not-a-time', connected: false, reason: 'disconnect' },
      {
        at: new Date(FROM_MS + 1_800_000).toISOString(),
        connected: false,
        reason: 'disconnect',
      },
    ],
    knownUntilMs: Number.NaN,
  })
  assertEquals(result.uptimeSeconds, 1800)
  assertEquals(result.downtimeSeconds, 1800)
  assertEquals(result.unknownSeconds, 0)
})

it('knownUntilMs clamps to the query window', () => {
  const beforeFrom = computeStatusUptime({
    fromMs: FROM_MS,
    toMs: TO_MS,
    initialConnected: true,
    events: [],
    knownUntilMs: FROM_MS - 60_000,
  })
  assertEquals(beforeFrom.unknownSeconds, HOUR)

  const afterTo = computeStatusUptime({
    fromMs: FROM_MS,
    toMs: TO_MS,
    initialConnected: true,
    events: [],
    knownUntilMs: TO_MS + 60_000,
  })
  assertEquals(afterTo.uptimeSeconds, HOUR)
  assertEquals(afterTo.unknownSeconds, 0)
})
