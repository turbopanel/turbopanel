/**
 * Deferred routing fan-out for automatically repinned membership pins.
 *
 * The repin itself (`ip.address` rewrite) rides the change-detected
 * `touchServerMetadata` write on the daemon presence path
 * (`src/lib/net/repin-apply.ts`). That path cannot enqueue commands — hello
 * and Durable Object handlers must not enqueue (DO cost rule) — so the apply
 * pass only stamps `ip.metadata.repin.pendingFanoutAt`, and this sweep drains
 * those markers from the shared maintenance tick, which already holds a real
 * command queue and the secrets bundle (`runSystemReconcileSweepTick` in
 * `deno-server.ts`; the `tlsRenewal`-gated block in
 * `daemon/cell/offline-sweep.ts`).
 *
 * Per `(organizationId, datacenterId)` group — several pins moving in one
 * heartbeat collapse into one fan-out — `fanOutDatacenterRoutingChange`
 * recomputes `replica.replication_transport`, re-materializes bindings,
 * enqueues `managed.ingress.reconcile` for members and bound consumers, and
 * runs `reconcileFabricMembership`, which re-derives relay `endpoint_address`
 * / gateway `advertisedCidrs` and enqueues `server.fabric.reconcile` only
 * where the desired hash moved. `extraManagedIds` adds the repinned servers'
 * own clusters (`listManagedIdsForServer`) so their engine listeners and
 * ProxySQL backends re-converge even when no peer is pinned into the
 * datacenter.
 *
 * Leaf SANs: no issuance path lives here. The `managed.ingress.reconcile`
 * enqueued above re-mints the ProxySQL listener leaf with the corrected SAN
 * set through the existing `pendingTlsLeafMetadata` rail
 * (`client/tls/leaf-tracking.ts`); engine leaves reissue on the next
 * `managed.apply` or when `renewDueTlsLeaves` picks them up.
 *
 * `pendingFanoutAt` is cleared only after the group's fan-out succeeds, so a
 * failure leaves the marker in place for the next tick. `repin.at` /
 * `repin.from` stay — they feed the needs-redeploy read
 * (`client/environments/repin-needs-redeploy.ts`).
 */

import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db.ts";
import type { CommandQueue } from "../../lib/commands/queue.ts";
import { ip } from "../../lib/db/schema.ts";
import { clearedPendingFanoutMetadata } from "../../lib/net/repin.ts";
import { compatLogWarn } from "../../log-compat.ts";
import type {
  DerivedSecretsConfig,
  SecretsConfig,
} from "../authn/secrets.ts";
import { listManagedIdsForServer } from "../bindings/resolve-endpoint.ts";
import { fanOutDatacenterRoutingChange } from "./routing-fanout.ts";

/** Bounded batch for one repin fan-out sweep tick. */
export const DATACENTER_REPIN_FANOUT_SWEEP_CAP = 25;

/** Injectable collaborators (host-free tests swap the enqueueing core). */
export type DatacenterRepinFanoutDeps = Readonly<{
  fanOut?: typeof fanOutDatacenterRoutingChange;
  listManagedIdsForServer?: typeof listManagedIdsForServer;
}>;

type PendingPinRow = {
  id: string;
  organization_id: string;
  datacenter_id: string;
  server_id: string;
  metadata: unknown;
};

type PendingGroup = {
  organizationId: string;
  datacenterId: string;
  pins: PendingPinRow[];
};

function groupKey(row: PendingPinRow): string {
  return `${row.organization_id}:${row.datacenter_id}`;
}

function groupPendingPins(rows: readonly PendingPinRow[]): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  for (const row of rows) {
    const key = groupKey(row);
    const group = groups.get(key) ?? {
      organizationId: row.organization_id,
      datacenterId: row.datacenter_id,
      pins: [],
    };
    group.pins.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

async function loadPendingPins(
  db: Db,
  budget: number,
): Promise<PendingPinRow[]> {
  const rows = await db.execute<PendingPinRow>(sql`
    SELECT i.id, i.organization_id, i.datacenter_id, i.server_id, i.metadata
    FROM ip i
    WHERE i.scope = 'datacenter'
      AND i.server_id IS NOT NULL
      AND i.datacenter_id IS NOT NULL
      AND i.metadata->'repin'->>'pendingFanoutAt' IS NOT NULL
    ORDER BY i.metadata->'repin'->>'pendingFanoutAt', i.id
    LIMIT ${budget}
  `);
  return [...rows];
}

async function clearPendingFanout(
  db: Db,
  pins: readonly PendingPinRow[],
  nowIso: string,
): Promise<void> {
  for (const pin of pins) {
    await db
      .update(ip)
      .set({
        metadata: clearedPendingFanoutMetadata(pin.metadata),
        updatedAt: nowIso,
      })
      .where(eq(ip.id, pin.id));
  }
}

async function fanOutGroup(
  db: Db,
  commandQueue: CommandQueue,
  group: PendingGroup,
  params: Readonly<{
    secretsConfig: SecretsConfig;
    dataEncryptionSecrets: DerivedSecretsConfig;
  }>,
  deps: DatacenterRepinFanoutDeps,
): Promise<void> {
  const serverIds = [...new Set(group.pins.map((pin) => pin.server_id))]
    .sort((a, b) => a.localeCompare(b));
  const listForServer = deps.listManagedIdsForServer ?? listManagedIdsForServer;
  const extraManagedIds = new Set<string>();
  for (const serverId of serverIds) {
    for (const managedId of await listForServer(db, serverId)) {
      extraManagedIds.add(managedId);
    }
  }
  const fanOut = deps.fanOut ?? fanOutDatacenterRoutingChange;
  await fanOut(db, commandQueue, {
    datacenterId: group.datacenterId,
    organizationId: group.organizationId,
    actorType: "system",
    actorId: serverIds[0] ?? group.datacenterId,
    secretsConfig: params.secretsConfig,
    dataEncryptionSecrets: params.dataEncryptionSecrets,
    extraManagedIds: [...extraManagedIds],
  });
}

/**
 * Drain `ip.metadata.repin.pendingFanoutAt` markers: one routing fan-out per
 * `(organization, datacenter)` group, then clear the markers of that group.
 * Returns the number of pins whose marker was cleared.
 */
export async function runDatacenterRepinFanoutSweep(
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{
    secretsConfig: SecretsConfig;
    dataEncryptionSecrets: DerivedSecretsConfig;
    budget?: number;
  }>,
  deps: DatacenterRepinFanoutDeps = {},
): Promise<{ processed: number }> {
  const budget = Math.min(
    Math.max(1, params.budget ?? DATACENTER_REPIN_FANOUT_SWEEP_CAP),
    DATACENTER_REPIN_FANOUT_SWEEP_CAP,
  );
  const pending = await loadPendingPins(db, budget);
  if (pending.length === 0) return { processed: 0 };

  let processed = 0;
  for (const group of groupPendingPins(pending)) {
    try {
      await fanOutGroup(db, commandQueue, group, params, deps);
    } catch (err) {
      // Marker stays; the next tick retries this group.
      compatLogWarn(
        "datacenter-repin",
        `repin fan-out failed for datacenter ${group.datacenterId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    await clearPendingFanout(db, group.pins, new Date().toISOString());
    processed += group.pins.length;
  }
  return { processed };
}
