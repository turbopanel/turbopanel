import type {
  AuthenticatedMetricsSampleV4,
  ServerMetricsStoreV4,
  ServerStatusEvent,
} from './types-v4.ts'

/** Default v4 store when no real backend has been wired yet (write-only no-op). */
export class DisabledServerMetricsStoreV4 implements ServerMetricsStoreV4 {
  writeSample(_input: AuthenticatedMetricsSampleV4): void {
    // no-op
  }

  writeStatusEvent(_input: ServerStatusEvent): void {
    // no-op
  }
}
