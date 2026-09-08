import type { PendingRequestStatus } from "./contracts.ts";
import type { DaemonInboundEnvelope } from "./protocol.ts";

/** Correlation status + payload derived from a terminal inbound envelope. */
export type InboundOutcome = {
  status: PendingRequestStatus;
  result?: unknown;
  error?: string;
};

function inboundOutcomeFromError(
  result: unknown,
  error: string | undefined,
): InboundOutcome {
  if (error) return { status: "failed", result, error };
  return { status: "done", result };
}

function inboundOutcomeFromOk(
  ok: boolean,
  error: string | undefined,
  result: unknown,
): InboundOutcome {
  if (ok) return { status: "done", result };
  return { status: "failed", result, error };
}

function commandOutcomePayload(
  inbound: Extract<DaemonInboundEnvelope, { kind: "command-outcome" }>,
): unknown {
  if (inbound.result === undefined) {
    return { ok: inbound.ok, error: inbound.error };
  }
  return inbound.result;
}

function repoReadResultPayload(
  inbound: Extract<DaemonInboundEnvelope, { kind: "repo-read-result" }>,
): unknown {
  return {
    ok: inbound.ok,
    commitSha: inbound.commitSha,
    files: inbound.files,
    entries: inbound.entries,
    error: inbound.error,
  };
}

/**
 * Map a daemon inbound envelope to a pending-request completion.
 * Returns `null` for non-terminal kinds (`command-ack` and similar).
 */
export function deriveInboundOutcome(
  inbound: DaemonInboundEnvelope,
): InboundOutcome | null {
  switch (inbound.kind) {
    case "addresses-result":
      return { status: "done", result: { ips: inbound.ips } };
    case "managed-logs-result":
    case "container-logs-result":
      return inboundOutcomeFromError({ logs: inbound.logs }, inbound.error);
    case "fabric-paths-result":
      return inboundOutcomeFromError({ paths: inbound.paths }, inbound.error);
    case "repo-read-result":
      return inboundOutcomeFromOk(
        inbound.ok,
        inbound.error,
        repoReadResultPayload(inbound),
      );
    case "command-outcome":
      return inboundOutcomeFromOk(
        inbound.ok,
        inbound.error,
        commandOutcomePayload(inbound),
      );
    case "public-urls-update-result":
    case "dev-sync-result":
    case "tunnel-token-result":
    case "update-result":
    case "metrics-live-start-result":
    case "metrics-live-stop-result":
    case "topology-overrides-update-result":
    case "capability-plan-update-result":
      return inboundOutcomeFromOk(inbound.ok, inbound.error, {
        ok: inbound.ok,
        error: inbound.error,
      });
    default:
      return null;
  }
}
