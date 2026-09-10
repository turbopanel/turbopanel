/**
 * Best-effort `capability-plan-update` / `capability-plan-clear` cell push —
 * mirrors `metrics-routes.ts`'s `pushHardwareProfileUpdate`. Enqueue failures
 * are logged and never thrown: the daemon still has server-side truncation as
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

type CapabilityPlanClearEnvelope = Extract<
  DaemonOutboundEnvelope,
  { kind: "capability-plan-clear" }
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

export function buildCapabilityPlanClearEnvelope(): CapabilityPlanClearEnvelope {
  return {
    kind: "capability-plan-clear",
    deliveryId: generateDeliveryId(),
    requestId: generateRequestId(),
    at: new Date().toISOString(),
  };
}

async function enqueueCapabilityPlanEnvelope(
  registry: DaemonCellRegistry | undefined,
  serverId: string,
  envelope: DaemonOutboundEnvelope,
): Promise<boolean> {
  if (!registry) return false;

  cellTrace("request-start", {
    requestId: envelope.requestId,
    serverId,
    kind: envelope.kind,
  });
  try {
    await registry.getCell(serverId).enqueue(envelope);
    cellTrace("request-enqueued", {
      requestId: envelope.requestId,
      serverId,
      kind: envelope.kind,
      deliveryId: envelope.deliveryId,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cellTrace("request-result", {
      requestId: envelope.requestId,
      serverId,
      kind: envelope.kind,
      status: "failed",
      error: message,
    });
    console.warn(
      `${envelope.kind} enqueue failed for ${serverId}: ${message}`,
    );
    return false;
  }
}

export async function enqueueCapabilityPlanUpdate(
  registry: DaemonCellRegistry | undefined,
  serverId: string,
  plan: MetricsCapabilityPlan,
  generation: number,
): Promise<boolean> {
  return await enqueueCapabilityPlanEnvelope(
    registry,
    serverId,
    buildCapabilityPlanUpdateEnvelope(plan, generation),
  );
}

export async function enqueueCapabilityPlanClear(
  registry: DaemonCellRegistry | undefined,
  serverId: string,
): Promise<boolean> {
  return await enqueueCapabilityPlanEnvelope(
    registry,
    serverId,
    buildCapabilityPlanClearEnvelope(),
  );
}

export async function enqueueLatestRecordedCapabilityPlan(
  db: Db,
  serverId: string,
  enqueue: (envelope: DaemonOutboundEnvelope) => unknown,
  deployment: MetricsDeploymentKind = "hosted",
): Promise<void> {
  // Self-hosted never caps outbound samples. Tell a remote daemon that
  // previously stored a hosted plan to delete it — skipping the push
  // leaves the leftover file in place.
  if (deployment === "self-hosted") {
    try {
      await enqueue(buildCapabilityPlanClearEnvelope());
    } catch (err) {
      console.warn(
        `capability-plan-clear attach push failed for ${serverId}: ${
          String(err)
        }`,
      );
    }
    return;
  }
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
