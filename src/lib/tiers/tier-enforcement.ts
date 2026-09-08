/**
 * License-tier floor and placement evaluation. Pure ranking plus the shared
 * `server → license → tier` join ingest already used — no HTTP, no priced-
 * offering vocabulary. Callers refuse, nag, or render from the returned ranks.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { license, organization, server, tier } from "../db/schema.ts";
import {
  parseServerHardwareProfile,
  parseServerHostResources,
  parseServerOptions,
  resolveEffectiveMetricsCapabilityPlan,
  type ServerHostResources,
} from "../db/server-metadata.ts";
import { parseOrganizationOptions } from "../organization-options.ts";
import {
  isServerMachineClass,
  type MetricsCapabilityPlan,
  type MetricsDeploymentKind,
  resolveServerMachineClass,
} from "../../daemon/metrics/capability-plan.ts";
import { getLatestTopologyGenerations } from "../../client/servers/server-topology-records.ts";
import { computeSlotMapping } from "../../client/servers/topology-slot-mapping.ts";
import {
  EMPTY_TOPOLOGY_OVERRIDES,
  type TopologyOverrides,
  type TopologySnapshot,
} from "../../client/servers/topology-types.ts";
import { metricsCapabilityTierEntitlementsFromRow } from "./tier-entitlements.ts";
import {
  resolveRecommendedTier,
  resolveRequiredTier,
  type TierBandLabel,
  totalPhysicalCores,
} from "./tier-placement.ts";

/** Byte-for-byte daemon `classifyConnectFailure` permanent-auth/enroll message. */
export const LICENSE_TIER_BELOW_REQUIRED_ERROR = "License tier below required";

/** Byte-for-byte daemon `classifyConnectFailure` permanent-auth/enroll message. */
export const LICENSE_TIER_UNASSIGNED_ERROR = "License tier not assigned";

export type ServerLicenseTierJoinRow = {
  serverId: string;
  organizationId: string;
  serverName: string | null;
  organizationName: string | null;
  serverOptions: unknown;
  orgOptions: unknown;
  serverMetadata: unknown;
  machineClass: unknown;
  licenseId: string | null;
  licenseTierId: string | null;
  nicSlots: number | null;
  driveSlots: number | null;
  gpuSlots: number | null;
  filesystemSlots: number | null;
  tierRank: number | null;
  tierLabel: string | null;
  tierGeneration: number | null;
  tierIsCustom: boolean | null;
};

export type ServerTierBinding = {
  licenseId: string;
  tierId: string | null;
  tierRank: number | null;
  tierLabel: string | null;
  generation: number | null;
  custom: boolean | null;
};

export type TierFloorEvaluation = {
  requiredRank: number;
  requiredLabel: TierBandLabel;
  satisfied: boolean;
};

export type TierUnwatchedIds = {
  nics: string[];
  drives: string[];
  gpus: string[];
};

export type TierUnwatchedCounts = {
  nics: number;
  drives: number;
  gpus: number;
};

export type TierPlacementEvaluation = {
  requiredRank: number;
  requiredLabel: TierBandLabel;
  recommendedRank: number;
  recommendedLabel: TierBandLabel;
  licenseRank: number | null;
  licenseLabel: string | null;
  unwatched: TierUnwatchedIds;
  satisfied: boolean;
};

export type TierPlacementDto<
  U extends TierUnwatchedIds | TierUnwatchedCounts = TierUnwatchedIds,
> = {
  licenseTier: string | null;
  requiredTier: string;
  recommendedTier: string;
  unwatched: U;
};

const JOIN_COLUMNS = {
  serverId: server.id,
  organizationId: server.organizationId,
  serverName: server.name,
  organizationName: organization.name,
  serverOptions: server.options,
  orgOptions: organization.options,
  serverMetadata: server.metadata,
  machineClass: server.machineClass,
  licenseId: license.id,
  licenseTierId: license.tierId,
  nicSlots: tier.nicSlots,
  driveSlots: tier.driveSlots,
  gpuSlots: tier.gpuSlots,
  filesystemSlots: tier.filesystemSlots,
  tierRank: tier.rank,
  tierLabel: tier.label,
  tierGeneration: tier.generation,
  tierIsCustom: tier.isCustom,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSlotMappableTopologySnapshot(
  value: Record<string, unknown>,
): value is TopologySnapshot {
  return (
    Array.isArray(value.networks) &&
    Array.isArray(value.filesystems) &&
    Array.isArray(value.blockDevices) &&
    Array.isArray(value.gpus) &&
    Array.isArray(value.hardwareSignals)
  );
}

export function parseTopologySnapshot(
  value: unknown,
): TopologySnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (!isSlotMappableTopologySnapshot(value)) return undefined;
  return value;
}

function hasKnownHardware(
  resources: ServerHostResources | undefined,
): boolean {
  if (!resources) return false;
  return totalPhysicalCores(resources) > 0 ||
    (resources.memory?.totalBytes ?? 0) > 0;
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function discoveredDeviceIds(
  snapshot: TopologySnapshot | undefined,
): TierUnwatchedIds {
  if (!snapshot) {
    return { nics: [], drives: [], gpus: [] };
  }
  const nics = snapshot.networks
    .filter((device) => device.kind === "uplink")
    .map((device) => device.deviceId);
  const drives = snapshot.blockDevices
    .filter((device) => device.isServiceDevice)
    .map((device) => device.deviceId);
  const gpus = snapshot.gpus.map((gpu) => gpu.gpuId);
  return {
    nics: sortedIds(nics),
    drives: sortedIds(drives),
    gpus: sortedIds(gpus),
  };
}

function unwatchedBeyondSlots(
  discovered: readonly string[],
  slotCount: number,
): string[] {
  if (slotCount <= 0) return [...discovered];
  return discovered.slice(slotCount);
}

function topologyOverridesFromMetadata(
  metadata: Record<string, unknown> | undefined,
): TopologyOverrides {
  const hardwareProfile = parseServerHardwareProfile(metadata?.hardwareProfile);
  return {
    ...EMPTY_TOPOLOGY_OVERRIDES,
    nicSlotDeviceIds: hardwareProfile?.nicSlotDeviceIds ?? [],
    hostingFilesystemId: hardwareProfile?.hostingFilesystemId ?? null,
    drivetempEnabled: hardwareProfile?.drivetempEnabled ?? false,
  };
}

/**
 * The operator's monitored NIC set, in slot order — the slot mapping's
 * `normalNicSlots`: `nicSlotDeviceIds` when pinned, otherwise the
 * `defaultRoute` uplink, otherwise the first uplink by sorted id — never
 * "alphabetical first N". This is the same list hosted ingest truncates and
 * the picker renders, so the recommendation, the unwatched notice and the
 * stored sample all describe one selection.
 */
function monitoredNicIds(
  snapshot: TopologySnapshot | undefined,
  overrides: TopologyOverrides | undefined,
): string[] {
  if (!snapshot) return [];
  return computeSlotMapping(snapshot, overrides ?? EMPTY_TOPOLOGY_OVERRIDES)
    .normalNicSlots;
}

/**
 * Unwatched NICs are discovered uplinks the stored sample will not carry:
 * everything outside the monitored set, plus monitored slots beyond the
 * plan's `normalNicSlots` (hosted ingest keeps the first N in slot order —
 * `truncateSampleToCapabilityPlan`). A pinned slot the tier cannot store is
 * therefore reported unwatched, which is what the recommendation is for.
 */
function unwatchedNicIds(
  discovered: readonly string[],
  monitored: readonly string[],
  slotCount: number,
): string[] {
  const watched = new Set(monitored.slice(0, Math.max(slotCount, 0)));
  return discovered.filter((id) => !watched.has(id));
}

/**
 * Identical hosted join ingest uses: `server → organization`, active
 * `license` (`revoked_at IS NULL`), `tier`. One query so ingest and
 * enforcement cannot disagree on the bound entitlement.
 */
export async function loadServerLicenseTierJoin(
  db: Db,
  serverId: string,
): Promise<ServerLicenseTierJoinRow | undefined> {
  const rows = await loadServerLicenseTierJoins(db, [serverId]);
  return rows.get(serverId);
}

export async function loadServerLicenseTierJoins(
  db: Db,
  serverIds: readonly string[],
): Promise<Map<string, ServerLicenseTierJoinRow>> {
  const byId = new Map<string, ServerLicenseTierJoinRow>();
  if (serverIds.length === 0) return byId;

  const rows = await db
    .select(JOIN_COLUMNS)
    .from(server)
    .leftJoin(organization, eq(organization.id, server.organizationId))
    .leftJoin(
      license,
      and(eq(license.serverId, server.id), isNull(license.revokedAt)),
    )
    .leftJoin(tier, eq(tier.id, license.tierId))
    .where(inArray(server.id, [...serverIds]));

  for (const row of rows) {
    // A server that belongs to no organization has no license to bind, no
    // tier to place against and no owners to notify: it has no placement.
    if (row.organizationId === null) continue;
    byId.set(row.serverId, { ...row, organizationId: row.organizationId });
  }
  return byId;
}

/**
 * Hosted enroll gate that must run before any durable latch/attach. Looks at
 * the license itself (and the already-bound server, when one exists) so a
 * 400 refusal cannot consume `license.server_id` or replace `server.daemon`.
 */
export async function evaluateHostedEnrollmentTier(
  db: Db,
  licenseId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [row] = await db
    .select({
      licenseTierId: license.tierId,
      tierRank: tier.rank,
      serverMetadata: server.metadata,
    })
    .from(license)
    .leftJoin(tier, eq(tier.id, license.tierId))
    .leftJoin(server, eq(server.id, license.serverId))
    .where(eq(license.id, licenseId))
    .limit(1);

  if (!row?.licenseTierId || row.tierRank == null) {
    return { ok: false, error: LICENSE_TIER_UNASSIGNED_ERROR };
  }

  const metadata = isRecord(row.serverMetadata)
    ? row.serverMetadata
    : undefined;
  const floor = evaluateTierFloor({
    resources: parseServerHostResources(metadata?.resources),
    tierRank: row.tierRank,
  });
  if (!floor.satisfied) {
    return { ok: false, error: LICENSE_TIER_BELOW_REQUIRED_ERROR };
  }
  return { ok: true };
}

export async function loadServerTierBinding(
  db: Db,
  serverId: string,
): Promise<ServerTierBinding | null> {
  const row = await loadServerLicenseTierJoin(db, serverId);
  if (!row?.licenseId) return null;
  return {
    licenseId: row.licenseId,
    tierId: row.licenseTierId,
    tierRank: row.tierRank,
    tierLabel: row.tierLabel,
    generation: row.tierGeneration,
    custom: row.tierIsCustom,
  };
}

/**
 * Hard floor: required rank from CPU cores + RAM compared to `tier.rank`.
 * Unknown hardware (absent `resources`, or zero cores and zero bytes) never
 * blocks. Soft dimensions (NICs / drives / GPUs) are ignored.
 */
export function evaluateTierFloor(input: {
  resources: ServerHostResources | undefined;
  tierRank: number;
}): TierFloorEvaluation {
  const resources = input.resources ?? {};
  const required = resolveRequiredTier(resources);
  if (!hasKnownHardware(input.resources)) {
    return {
      requiredRank: required.rank,
      requiredLabel: required.label,
      satisfied: true,
    };
  }
  return {
    requiredRank: required.rank,
    requiredLabel: required.label,
    satisfied: input.tierRank >= required.rank,
  };
}

export function evaluateTierPlacement(input: {
  resources: ServerHostResources | undefined;
  topologySnapshot: TopologySnapshot | undefined;
  plan: Pick<
    MetricsCapabilityPlan,
    "normalNicSlots" | "detailedBlockDeviceSlots" | "gpuSlots"
  >;
  tierRank: number | null;
  licenseLabel?: string | null;
  topologyOverrides?: TopologyOverrides;
}): TierPlacementEvaluation {
  const floor = evaluateTierFloor({
    resources: input.resources,
    tierRank: input.tierRank ?? 0,
  });
  const discovered = discoveredDeviceIds(input.topologySnapshot);
  // NICs recommend from what the operator monitors, not from every uplink
  // discovered — a six-port box watching one NIC needs no NIC-driven
  // upgrade. Drives and GPUs have no operator selection and use discovery.
  const monitoredNics = monitoredNicIds(
    input.topologySnapshot,
    input.topologyOverrides,
  );
  const recommended = resolveRecommendedTier(
    input.resources ?? {},
    monitoredNics.length,
    discovered.drives.length,
    discovered.gpus.length,
  );
  return {
    requiredRank: floor.requiredRank,
    requiredLabel: floor.requiredLabel,
    recommendedRank: recommended.rank,
    recommendedLabel: recommended.label,
    licenseRank: input.tierRank,
    licenseLabel: input.licenseLabel ?? null,
    unwatched: {
      nics: unwatchedNicIds(
        discovered.nics,
        monitoredNics,
        input.plan.normalNicSlots,
      ),
      drives: unwatchedBeyondSlots(
        discovered.drives,
        input.plan.detailedBlockDeviceSlots,
      ),
      gpus: unwatchedBeyondSlots(discovered.gpus, input.plan.gpuSlots),
    },
    satisfied: floor.satisfied,
  };
}

export function toTierPlacementDto(
  placement: TierPlacementEvaluation,
  unwatched: "ids",
): TierPlacementDto<TierUnwatchedIds>;
export function toTierPlacementDto(
  placement: TierPlacementEvaluation,
  unwatched: "counts",
): TierPlacementDto<TierUnwatchedCounts>;
export function toTierPlacementDto(
  placement: TierPlacementEvaluation,
  unwatched: "ids" | "counts",
): TierPlacementDto<TierUnwatchedIds | TierUnwatchedCounts> {
  const ids = placement.unwatched;
  return {
    licenseTier: placement.licenseLabel,
    requiredTier: placement.requiredLabel,
    recommendedTier: placement.recommendedLabel,
    unwatched: unwatched === "counts"
      ? {
        nics: ids.nics.length,
        drives: ids.drives.length,
        gpus: ids.gpus.length,
      }
      : ids,
  };
}

function placementFromJoinRow(
  row: ServerLicenseTierJoinRow,
  snapshot: TopologySnapshot | undefined,
  deployment: MetricsDeploymentKind,
  orgOptionsOverride?: ReturnType<typeof parseOrganizationOptions>,
): TierPlacementEvaluation {
  const metadata = isRecord(row.serverMetadata)
    ? row.serverMetadata
    : undefined;
  const resources = parseServerHostResources(metadata?.resources);
  const machineClass = isServerMachineClass(row.machineClass)
    ? row.machineClass
    : resolveServerMachineClass(row.machineClass, snapshot);
  const orgOptions = orgOptionsOverride ??
    parseOrganizationOptions(row.orgOptions);
  const serverOptions = parseServerOptions(row.serverOptions) ?? undefined;
  const entitlements = metricsCapabilityTierEntitlementsFromRow({
    nicSlots: row.nicSlots,
    driveSlots: row.driveSlots,
    gpuSlots: row.gpuSlots,
    filesystemSlots: row.filesystemSlots,
    rank: row.tierRank,
  });
  const plan = resolveEffectiveMetricsCapabilityPlan(
    machineClass,
    orgOptions,
    serverOptions,
    deployment,
    entitlements,
  );
  return evaluateTierPlacement({
    resources,
    topologySnapshot: snapshot,
    plan,
    tierRank: row.tierRank,
    licenseLabel: row.tierLabel,
    topologyOverrides: topologyOverridesFromMetadata(metadata),
  });
}

export async function loadTierPlacementsForServers(
  db: Db,
  serverIds: readonly string[],
  opts: {
    deployment: MetricsDeploymentKind;
    orgOptions?: ReturnType<typeof parseOrganizationOptions>;
    unwatched: "ids";
  },
): Promise<Map<string, TierPlacementDto<TierUnwatchedIds>>>;
export async function loadTierPlacementsForServers(
  db: Db,
  serverIds: readonly string[],
  opts: {
    deployment: MetricsDeploymentKind;
    orgOptions?: ReturnType<typeof parseOrganizationOptions>;
    unwatched: "counts";
  },
): Promise<Map<string, TierPlacementDto<TierUnwatchedCounts>>>;
export async function loadTierPlacementsForServers(
  db: Db,
  serverIds: readonly string[],
  opts: {
    deployment: MetricsDeploymentKind;
    orgOptions?: ReturnType<typeof parseOrganizationOptions>;
    unwatched: "ids" | "counts";
  },
): Promise<
  Map<string, TierPlacementDto<TierUnwatchedIds | TierUnwatchedCounts>>
> {
  const result = new Map<
    string,
    TierPlacementDto<TierUnwatchedIds | TierUnwatchedCounts>
  >();
  if (serverIds.length === 0) return result;

  const [joins, topologyByServer] = await Promise.all([
    loadServerLicenseTierJoins(db, serverIds),
    getLatestTopologyGenerations(db, serverIds),
  ]);

  for (const serverId of serverIds) {
    const row = joins.get(serverId);
    if (!row) continue;
    const snapshot = parseTopologySnapshot(
      topologyByServer.get(serverId)?.snapshot,
    );
    const placement = placementFromJoinRow(
      row,
      snapshot,
      opts.deployment,
      opts.orgOptions,
    );
    if (opts.unwatched === "ids") {
      result.set(serverId, toTierPlacementDto(placement, "ids"));
    } else {
      result.set(serverId, toTierPlacementDto(placement, "counts"));
    }
  }
  return result;
}

export { placementFromJoinRow };
