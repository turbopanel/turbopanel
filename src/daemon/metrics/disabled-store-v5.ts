import type {
  AuthenticatedMetricsSampleV5,
  ServerMetricsStoreV5,
  ServerStatusEvent,
} from './types-v5.ts'

/** Default v5 store when no real backend has been wired yet (write-only no-op). */
export class DisabledServerMetricsStoreV5 implements ServerMetricsStoreV5 {
  writeSample(_input: AuthenticatedMetricsSampleV5): void {
    // no-op
  }

  writeStatusEvent(_input: ServerStatusEvent): void {
    // no-op
  }
}
