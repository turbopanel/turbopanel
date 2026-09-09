/**
 * Tier floor and placement evaluation. Pure ranking plus the shared
 * `server → license → assigned tier` join ingest already uses — no HTTP,
 * no priced-offering vocabulary. Callers refuse, nag, or render from the
 * returned ranks. The tier a server sits on is `server.assigned_tier_id`,
 * derived from what the organization bought (`assignment-records.ts`);
 * nothing here chooses it.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { license, organization, server, tier } from "../db/schema.ts";
import { listSeatsForOrganization } from "../db/billing-records.ts";
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
import { metricsCapabilityTierEntitlementsForRank } from "./tier-entitlements.ts";
import { computeAssignment } from "./assignment.ts";
import { loadAssignableServers, tierQuantitiesFromState } from "./assignment-records.ts";
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
  /** The derived tier; null when unlicensed, self-hosted, or uncovered. */
  assignedTierId: string | null;
  tierRank: number | null;
  tierLabel: string | null;
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
  assignedTierId: server.assignedTierId,
  tierRank: tier.rank,
  tierLabel: tier.label,
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
 * `license` (`revoked_at IS NULL`), and the `tier` the server is assigned.
 * One query so ingest and enforcement cannot disagree on the entitlement.
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
    .leftJoin(tier, eq(tier.id, server.assignedTierId))
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
 * Hosted enroll gate that must run before any durable latch/attach: would
 * the organization's purchased tiers still cover every licensed server
 * once this license binds one more? Hardware is unknown at enroll, so the
 * newcomer needs the entry rank; the incumbents are placed first
 * (`computeAssignment`), so the newcomer is the one refused when nothing
 * is free. Reads the license (and its already-bound server, on a
 * re-enroll) so a 400 refusal cannot consume `license.server_id` or
 * replace `server.daemon`.
 */
export async function evaluateHostedEnrollmentTier(
  db: Db,
  licenseId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [row] = await db
    .select({
      organizationId: license.organizationId,
      serverId: license.serverId,
    })
    .from(license)
    .where(and(eq(license.id, licenseId), isNull(license.revokedAt)))
    .limit(1);
  if (!row) return { ok: false, error: LICENSE_TIER_UNASSIGNED_ERROR };

  const state = await listSeatsForOrganization(db, row.organizationId);
  const servers = await loadAssignableServers(db, row.organizationId);
  const already = row.serverId
    ? servers.find((entry) => entry.serverId === row.serverId)
    : undefined;
  const candidate = already ?? {
    serverId: `enrolling:${licenseId}`,
    requiredRank: null,
    // Newest: placed after every incumbent.
    boundAt: "9999-12-31T23:59:59.999Z",
  };
  const assignment = computeAssignment(
    tierQuantitiesFromState(state),
    already ? servers : [...servers, candidate],
  );
  if (assignment.byServer.get(candidate.serverId) === null) {
    return {
      ok: false,
      error: already ? LICENSE_TIER_BELOW_REQUIRED_ERROR : LICENSE_TIER_UNASSIGNED_ERROR,
    };
  }
  return { ok: true };
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
  // Self-hosted has an assigned tier now — the licence grant places every
  // server on `SX` (`src/lib/tiers/self-hosted-grant.ts`) — but placement is
  // a *priced* idea and self-hosted buys nothing. Feeding the grant's rung in
  // here would cap the plan at SX's slot budgets on a deployment that is
  // uncapped by definition, and would put an "SX" badge on a console that has
  // no billing area. So the tier is dropped on this path only: the grant
  // stays what it is, an entitlement the assignment reads.
  const selfHosted = deployment === "self-hosted";
  const tierRank = selfHosted ? null : row.tierRank;
  const entitlements = selfHosted
    ? undefined
    : metricsCapabilityTierEntitlementsForRank(row.tierRank);
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
    tierRank,
    licenseLabel: selfHosted ? null : row.tierLabel,
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
