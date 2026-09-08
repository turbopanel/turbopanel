import type {
  AuthenticatedMetricsSample,
  ServerMetricsStore,
  ServerStatusEvent,
} from './types.ts'

/** Default v5 store when no real backend has been wired yet (write-only no-op). */
export class DisabledServerMetricsStore implements ServerMetricsStore {
  writeSample(_input: AuthenticatedMetricsSample): void {
    // no-op
  }

  writeStatusEvent(_input: ServerStatusEvent): void {
    // no-op
  }
}
