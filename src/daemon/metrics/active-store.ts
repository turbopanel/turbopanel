/**
 * Module-level handle to the process's active server-metrics store, set once
 * at boot (`deno-server.ts`). Lets Deno-only developer routes reach the live
 * DuckDB-backed store — the dev "Open DuckDB UI" action must run inside the
 * same embedded instance the store owns, since a second process opening the
 * database file would be a second writer. Mirrors the `status-events.ts`
 * module-scoped sink pattern (and its safety rationale).
 */

import type { ServerMetricsStoreV4 } from './types-v4.ts'

let activeStore: ServerMetricsStoreV4 | null = null

export function setActiveServerMetricsStore(store: ServerMetricsStoreV4 | null): void {
  activeStore = store
}

export function getActiveServerMetricsStore(): ServerMetricsStoreV4 | null {
  return activeStore
}

/** Test seam: clear the registered store. */
export function resetActiveServerMetricsStoreForTests(): void {
  activeStore = null
}
