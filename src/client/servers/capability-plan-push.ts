/**
 * Best-effort `capability-plan-update` cell push — mirrors
 * `metrics-routes.ts`'s `pushHardwareProfileUpdate`. Enqueue failures are
 * logged and never thrown: the daemon still has server-side truncation as
 * defense-in-depth, and the next attach/ingest will retry.
 */
import type { Db } from "../../db.ts";
import type { DaemonCellRegistry } from "../../daemon/cell/contracts.ts";
import type { DaemonOutboundEnvelope } from "../../daemon/cell/protocol.ts";
import {
  generateDeliveryId,
  generateRequestId,
} from "../../daemon/cell/protocol.ts";
import {
  type MetricsCapabilityPlan,
  type MetricsDeploymentKind,
  parseMetricsCapabilityPlan,
} from "../../daemon/metrics/capability-plan.ts";
import { cellTrace } from "../../logger.ts";
import { getLatestCapabilityPlanGeneration } from "./capability-plan-records.ts";

type CapabilityPlanUpdateEnvelope = Extract<
  DaemonOutboundEnvelope,
  { kind: "capability-plan-update" }
>;

export function buildCapabilityPlanUpdateEnvelope(
  plan: MetricsCapabilityPlan,
  generation: number,
): CapabilityPlanUpdateEnvelope {
  return {
    kind: "capability-plan-update",
    deliveryId: generateDeliveryId(),
    requestId: generateRequestId(),
    plan,
    generation,
    at: new Date().toISOString(),
  };
}

export async function enqueueCapabilityPlanUpdate(
  registry: DaemonCellRegistry | undefined,
  serverId: string,
  plan: MetricsCapabilityPlan,
  generation: number,
): Promise<boolean> {
  if (!registry) return false;

  const envelope = buildCapabilityPlanUpdateEnvelope(plan, generation);
  cellTrace("request-start", {
    requestId: envelope.requestId,
    serverId,
    kind: "capability-plan-update",
  });
  try {
    await registry.getCell(serverId).enqueue(envelope);
    cellTrace("request-enqueued", {
      requestId: envelope.requestId,
      serverId,
      kind: "capability-plan-update",
      deliveryId: envelope.deliveryId,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cellTrace("request-result", {
      requestId: envelope.requestId,
      serverId,
      kind: "capability-plan-update",
      status: "failed",
      error: message,
    });
    console.warn(
      `capability-plan-update enqueue failed for ${serverId}: ${message}`,
    );
    return false;
  }
}

export async function enqueueLatestRecordedCapabilityPlan(
  db: Db,
  serverId: string,
  enqueue: (envelope: DaemonOutboundEnvelope) => unknown,
  deployment: MetricsDeploymentKind = "hosted",
): Promise<void> {
  // Self-hosted never caps outbound samples — do not replay a leftover
  // finite plan that would start truncating after reconnect.
  if (deployment === "self-hosted") return;
  try {
    const latest = await getLatestCapabilityPlanGeneration(db, serverId);
    if (!latest) return;
    const plan = parseMetricsCapabilityPlan(latest.plan);
    if (!plan) return;
    await enqueue(buildCapabilityPlanUpdateEnvelope(plan, latest.generation));
  } catch (err) {
    console.warn(
      `capability-plan-update attach push failed for ${serverId}: ${
        String(err)
      }`,
    );
  }
}
