/**
 * Per-runtime sink for connection status transitions.
 *
 * Transitions fire from four runtimes that do not share a Hono context
 * (request isolate, Durable Object isolate, cron isolate, Deno process), so
 * a module-scoped registry avoids threading a store through the already
 * 7-argument `onDaemonConnected` chain.
 *
 * Module scope is safe here: the sink holds only an AE binding wrapper or the
 * Deno DuckDB store — no request-scoped socket — matching the
 * existing `cachedServerMetricsStore` precedent in `workers.ts`.
 */

import { stripLogInjection } from '../../log-compat.ts'
import type { ServerMetricsStoreV4, ServerStatusEvent } from './types-v4.ts'
import { rateLimitedMetricsLog } from './validation-v4.ts'

export type ServerStatusEventSink = Pick<ServerMetricsStoreV4, 'writeStatusEvent'>

let registeredSink: ServerStatusEventSink | null = null

export function setServerStatusEventSink(sink: ServerStatusEventSink | null): void {
  registeredSink = sink
}

export function getServerStatusEventSink(): ServerStatusEventSink | null {
  return registeredSink
}

/** Test seam: clear the registered sink between suites. */
export function resetServerStatusEventSinkForTests(): void {
  registeredSink = null
}

/**
 * Fire-and-forget status write. Resolves the explicit sink first, then the
 * registered one. Catches sync throws and rejected promises so a throwing /
 * absent AE binding can never surface into a WS handler.
 */
export function emitServerStatusEvent(
  event: ServerStatusEvent,
  sink?: ServerStatusEventSink | null
): void {
  const resolved = sink ?? registeredSink
  if (!resolved) return
  try {
    const result = resolved.writeStatusEvent(event)
    if (result != null && typeof (result as PromiseLike<void>).then === 'function') {
      void Promise.resolve(result).catch((error: unknown) => {
        logStatusWriteFailed(event.serverId, error)
      })
    }
  } catch (error) {
    logStatusWriteFailed(event.serverId, error)
  }
}

function logStatusWriteFailed(serverId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  rateLimitedMetricsLog(serverId, 'status_write_failed', (reason) => {
    console.error(
      `server status metrics write failed serverId=${stripLogInjection(
        serverId
      )} reason=${stripLogInjection(reason)}: ${stripLogInjection(message)}`
    )
  })
}
