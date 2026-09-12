/**
 * Re-converge everything that read a datacenter's routing inputs after they
 * changed — the `priority` / `trusted` policy (`PATCH /datacenters/:id`) or a
 * member pin's address (automatic repin, drained by the maintenance sweep in
 * `repin-fanout.ts`):
 *
 * - every managed cluster with a member pinned into this datacenter, plus any
 *   `extraManagedIds` the caller already knows are affected →
 *   `fanOutManagedIngressReconcile` (recompute `replica.replication_transport`,
 *   re-materialize bindings, enqueue `managed.ingress.reconcile` on members
 *   and bound consumers);
 * - the org fabric (when present) → `reconcileFabricMembership`, which
 *   re-plans every relay path and enqueues `server.fabric.reconcile` only
 *   where the desired payload hash moved.
 *
 * Needs a real command queue and the secrets bundle; callers gate on those
 * and decide whether a failure is logged or propagated.
 */

import type { Db } from "../../db.ts";
import type { CommandQueue } from "../../lib/commands/queue.ts";
import type {
  DerivedSecretsConfig,
  SecretsConfig,
} from "../authn/secrets.ts";
import { reconcileFabricMembership } from "../../lib/fabric/enqueue.ts";
import { listManagedIdsForDatacenter } from "../bindings/resolve-endpoint.ts";
import { fanOutManagedIngressReconcile } from "../managed/ingress-desired.ts";

export type DatacenterRoutingFanoutParams = Readonly<{
  datacenterId: string;
  organizationId: string;
  actorType: "user" | "system";
  actorId: string;
  secretsConfig: SecretsConfig;
  dataEncryptionSecrets: DerivedSecretsConfig;
  /** Clusters to re-converge beyond those pinned into the datacenter. */
  extraManagedIds?: readonly string[];
}>;

export async function fanOutDatacenterRoutingChange(
  db: Db,
  commandQueue: CommandQueue,
  params: DatacenterRoutingFanoutParams,
): Promise<{ managedIds: string[] }> {
  const pinned = await listManagedIdsForDatacenter(db, params.datacenterId);
  const managedIds = [
    ...new Set([...pinned, ...(params.extraManagedIds ?? [])]),
  ].sort((a, b) => a.localeCompare(b));

  for (const managedId of managedIds) {
    await fanOutManagedIngressReconcile(db, commandQueue, {
      managedId,
      actorType: params.actorType,
      actorId: params.actorId,
      secretsConfig: params.secretsConfig,
      dataEncryptionSecrets: params.dataEncryptionSecrets,
    });
  }
  await reconcileFabricMembership({
    db,
    commandQueue,
    actorType: params.actorType,
    actorId: params.actorId,
    organizationId: params.organizationId,
    secretsConfig: params.secretsConfig,
    dataEncryptionSecrets: params.dataEncryptionSecrets,
  });
  return { managedIds };
}
