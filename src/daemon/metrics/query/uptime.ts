/**
 * Backend-neutral uptime math for connection status history.
 *
 * AE and DuckDB share this pure calculator so both backends produce
 * identical uptime / downtime / unknown totals (parity seam, like
 * `finalizeHostSeriesResult` / `computeSeriesGapCount`).
 */

import type { ServerStatusTransitionReason, StatusHistoryEvent } from '../types-v4.ts'

export type ComputeStatusUptimeInput = {
  fromMs: number
  toMs: number
  /** State just before `from`; `null` means unknown (accrues to unknownSeconds). */
  initialConnected: boolean | null
  events: readonly StatusHistoryEvent[]
  /**
   * When set (truncated event streams), attribute only through this instant with
   * known up/down state; `(knownUntilMs, toMs]` accrues to `unknownSeconds`.
   * Prevents extending the last retained state through `to` when later
   * transitions are known to exist but were omitted.
   */
  knownUntilMs?: number
}

export type ComputeStatusUptimeResult = {
  uptimeSeconds: number
  downtimeSeconds: number
  unknownSeconds: number
  /** `uptime / (uptime + downtime)`; `null` when the denominator is 0. */
  uptimePercent: number | null
}

type TimedEvent = {
  atMs: number
  connected: boolean
  reason: ServerStatusTransitionReason
}

/**
 * Walk ordered transitions, attributing each span in `[from, to]` to up /
 * down / unknown. Events outside the range and duplicate same-state events
 * are ignored. `initialConnected === null` means the leading span (and any
 * span until the first transition) accrues to `unknownSeconds` — never to
 * uptime or downtime. When `knownUntilMs` is set, the suffix after that
 * instant is always unknown (truncated histories).
 */
export function computeStatusUptime(input: ComputeStatusUptimeInput): ComputeStatusUptimeResult {
  const fromMs = input.fromMs
  const toMs = input.toMs
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return {
      uptimeSeconds: 0,
      downtimeSeconds: 0,
      unknownSeconds: 0,
      uptimePercent: null,
    }
  }

  const knownEndMs = resolveKnownEndMs(fromMs, toMs, input.knownUntilMs)
  const timed = collectInRangeTransitions(fromMs, knownEndMs, input.initialConnected, input.events)

  let uptimeSeconds = 0
  let downtimeSeconds = 0
  let unknownSeconds = 0
  let cursor = fromMs
  let current: boolean | null = input.initialConnected

  for (const event of timed) {
    attributeSpan(cursor, event.atMs, current, (kind, seconds) => {
      if (kind === 'up') uptimeSeconds += seconds
      else if (kind === 'down') downtimeSeconds += seconds
      else unknownSeconds += seconds
    })
    cursor = event.atMs
    current = event.connected
  }

  attributeSpan(cursor, knownEndMs, current, (kind, seconds) => {
    if (kind === 'up') uptimeSeconds += seconds
    else if (kind === 'down') downtimeSeconds += seconds
    else unknownSeconds += seconds
  })

  attributeSpan(knownEndMs, toMs, null, (_kind, seconds) => {
    unknownSeconds += seconds
  })

  const denom = uptimeSeconds + downtimeSeconds
  return {
    uptimeSeconds,
    downtimeSeconds,
    unknownSeconds,
    uptimePercent: denom === 0 ? null : uptimeSeconds / denom,
  }
}

function resolveKnownEndMs(fromMs: number, toMs: number, knownUntilMs: number | undefined): number {
  if (knownUntilMs === undefined || !Number.isFinite(knownUntilMs)) {
    return toMs
  }
  if (knownUntilMs < fromMs) return fromMs
  if (knownUntilMs > toMs) return toMs
  return knownUntilMs
}

function collectInRangeTransitions(
  fromMs: number,
  toMs: number,
  initialConnected: boolean | null,
  events: readonly StatusHistoryEvent[]
): TimedEvent[] {
  const timed: TimedEvent[] = []
  for (const event of events) {
    const atMs = Date.parse(event.at)
    if (!Number.isFinite(atMs)) continue
    if (atMs < fromMs || atMs > toMs) continue
    timed.push({
      atMs,
      connected: event.connected,
      reason: event.reason,
    })
  }
  timed.sort((a, b) => a.atMs - b.atMs)

  const out: TimedEvent[] = []
  let state = initialConnected
  for (const event of timed) {
    if (state === event.connected) continue
    out.push(event)
    state = event.connected
  }
  return out
}

function attributeSpan(
  startMs: number,
  endMs: number,
  state: boolean | null,
  add: (kind: 'up' | 'down' | 'unknown', seconds: number) => void
): void {
  const seconds = (endMs - startMs) / 1000
  if (seconds <= 0) return
  if (state === null) {
    add('unknown', seconds)
    return
  }
  add(state ? 'up' : 'down', seconds)
}
