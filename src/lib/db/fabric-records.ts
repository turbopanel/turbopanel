/**
 * TurboFabric desired-state helpers (`fabric` / `relay` / `subnet`).
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { nowIso } from "../commands/ids.ts";
import {
  cidrsOverlap,
  inetAddressToString,
  isValidIpAddress,
  nextFreeHostAddress,
  stripInetPrefixSuffix,
} from "../ip-address.ts";
import { fabric, ip, network, relay, subnet, server } from "./schema.ts";
import {
  composeNetworkHostName,
  hostRoute32,
  isRelayAddressUniqueViolation,
  isRelayPrefixUniqueViolation,
  nextFreeSubnetCidr,
  nextFreeSubnet,
  nthSubnet,
  parseFabricOptions,
  pickDefaultFabricHostCidr,
  RELAY_PREFIX_LENGTH,
} from "../fabric/cidr.ts";
import { managedNetworkName } from "../naming.ts";
import {
  collectSpanningComposeNetworkKeys,
  participatingServerIdsForNetwork,
  type PlatformAttachment,
} from "../fabric/spanning.ts";
import type { ComposeDocument } from "../compose/types.ts";
import type {
  FabricReconcileCommandPayload,
  FabricReconcileObservedPeer,
} from "../commands/schemas.ts";
import { sha256HexUtf8 } from "../compose/desired-hash.ts";
import {
  publicIpv4FromIps,
  reportedIpsFromServerMetadata,
  type ServerReportedIp,
} from "../../server-addresses.ts";
import {
  type DatacenterPolicyRow,
  defaultDatacenterPolicyRow,
  loadDatacenterPolicies,
  loadDatacenterSubnetsForServers,
  resolveDerivedAdvertisedCidrsByRelay,
} from "../net/datacenter-networks.ts";
import {
  type DatacenterMembershipRow,
  loadDatacenterMembershipsForServers,
} from "../net/datacenter-membership.ts";
import {
  partitionSharedDatacenters,
  pinAddressForDatacenter,
} from "../net/private-endpoint.ts";
import { loadCidrAllocationExclusions } from "../net/cidr-collisions.ts";
import { WIREGUARD_PERSISTENT_KEEPALIVE } from "../fabric/wg.ts";
import {
  type FabricPolicy,
  mergeRelayPolicyOptions,
  parseFabricPolicy,
  parseRelayPolicy,
} from "../fabric/policy.ts";

export type FabricRecord = {
  id: string;
  organizationId: string;
  cidr: string;
  options: unknown;
};

export type RelayRole = "gateway" | "member";

export type RelayObservedPeer = FabricReconcileObservedPeer;

export type RelayMetadata = {
  appliedPayloadHash?: string;
  appliedAt?: string;
  observed?: {
    at: string;
    peers: RelayObservedPeer[];
  };
  /** Diagnostics-only path summary; never hashed into desired reconcile state. */
  paths?: {
    at: string;
    entries: FabricPathSummaryEntry[];
  };
};

export type FabricPathSummaryEntry = {
  peerServerId: string;
  selected: RelayPathKind;
  endpoint?: string;
  viaServerId?: string;
  lastHandshakeAt?: string;
  latencyMs?: number;
  degraded: boolean;
};

export type RelayRecord = {
  id: string;
  fabricId: string;
  serverId: string;
  address: string;
  role: RelayRole;
  keepalive: number | null;
  endpointAddress: string | null;
  publicKey: string | null;
  prefix: string;
  advertisedCidrs: string[];
  metadata: RelayMetadata;
  allowRelay: boolean | null;
  preferredGatewayIds: string[];
};

export type FabricAllocationErrorKind =
  | "fabric_address_pool_exhausted"
  | "fabric_prefix_pool_exhausted"
  /** Compose-bridge subnet pool (table `subnet`); error code kept as-is. */
  | "fabric_segment_pool_exhausted"
  | "relay_missing"
  | "relay_endpoint_unavailable";

const ALLOCATION_MESSAGES: Record<FabricAllocationErrorKind, string> = {
  fabric_address_pool_exhausted: "TurboFabric address pool exhausted",
  fabric_prefix_pool_exhausted: "TurboFabric prefix address pool exhausted",
  fabric_segment_pool_exhausted: "TurboFabric segment address pool exhausted",
  relay_missing: "TurboFabric relay missing",
  relay_endpoint_unavailable: "TurboFabric relay endpoint unavailable",
};

export class FabricAllocationError extends Error {
  readonly kind: FabricAllocationErrorKind;

  constructor(
    kind: FabricAllocationErrorKind,
    message = ALLOCATION_MESSAGES[kind],
  ) {
    super(message);
    this.name = "FabricAllocationError";
    this.kind = kind;
  }
}

/**
 * Operator policy a `PUT /organizations/:id/fabric` may carry alongside
 * `enabled: true`. Applied **before** any relay is allocated so a first-time
 * enable (or an enable that adds relays for new servers) carves every prefix
 * from the requested pool rather than the default one.
 */
export type FabricEnablePolicy = {
  allowRelay?: boolean;
  /** Replacement `fabric.options.containerPool` (validated by the route). */
  containerPool?: string;
};

/**
 * A first-time enable picks the `tp0` host range automatically; when that
 * range lands inside the requested container pool nothing is written and the
 * route reports `cidr_overlaps_fabric` with both ranges.
 */
export class FabricContainerPoolOverlapError extends Error {
  readonly containerPool: string;
  readonly fabricCidr: string;

  constructor(containerPool: string, fabricCidr: string) {
    super("TurboFabric container pool overlaps the host range");
    this.name = "FabricContainerPoolOverlapError";
    this.containerPool = containerPool;
    this.fabricCidr = fabricCidr;
  }
}

export type RelayPathKind =
  | "direct_lan"
  | "direct_public"
  | "direct_nat"
  | "gateway"
  | "relay"
  | "unreachable";

export type RelayPathCandidate = {
  kind: RelayPathKind;
  address?: string;
  datacenterId?: string;
  viaServerId?: string;
  viaRelayId?: string;
};

export type RelayPathSelected = {
  kind: RelayPathKind;
  /** Present for emitted direct kinds (`direct_lan` / `direct_public` / `direct_nat`). */
  endpoint?: string;
  datacenterId?: string;
  viaServerId?: string;
  viaRelayId?: string;
};

/**
 * Ranked viable candidates plus the selected path. `gateway` /
 * `relay` stay typed on this shape so later phases can fill them without
 * changing the top-level return.
 */
export type RelayPathPlan = {
  candidates: RelayPathCandidate[];
  selected: RelayPathSelected;
  directNat: RelayPathCandidate | null;
  gateway: RelayPathCandidate | null;
  relay: RelayPathCandidate | null;
};

export type RelayPeerMaterial = {
  publicKey: string;
  allowedIPs: string[];
  endpoint: string;
  keepalive: number | null;
  sealedPresharedKey: string | null;
  presharedKey: string | null;
  pathKind: RelayPathKind;
  viaServerId?: string;
};

export type EndpointAddressCaches = {
  publicAddressByServer: Map<string, string>;
  reportedByServer: Map<string, ServerReportedIp[] | undefined>;
  datacenterMembershipsByServer: Map<string, DatacenterMembershipRow[]>;
  /**
   * Effective routing policy per datacenter (`addressPreference`, `priority`,
   * `trusted`). Shared with the private-endpoint ladder so LAN path planning
   * honors the same trust gate and priority order.
   */
  policyByDatacenter: Map<string, DatacenterPolicyRow>;
  /** Runtime-only NAT hole-punch endpoints; never loaded from Postgres. */
  natEndpointByPair: Map<string, string>;
  /** Runtime-only demoted kinds so the planner falls through. */
  failedPathKindsByPair: Map<string, Set<RelayPathKind>>;
};

/** Pair cache key: `${fromServerId}>${toServerId}`. */
export function fabricPairCacheKey(
  fromServerId: string,
  toServerId: string,
): string {
  return `${fromServerId}>${toServerId}`;
}

function emptyPairPlanningCaches(): Pick<
  EndpointAddressCaches,
  | "datacenterMembershipsByServer"
  | "policyByDatacenter"
  | "natEndpointByPair"
  | "failedPathKindsByPair"
> {
  return {
    datacenterMembershipsByServer: new Map(),
    policyByDatacenter: new Map(),
    natEndpointByPair: new Map(),
    failedPathKindsByPair: new Map(),
  };
}

const EMITTED_RELAY_PATH_KINDS = new Set<RelayPathKind>([
  "direct_lan",
  "direct_public",
  "direct_nat",
]);

function isEmittedDirectPath(
  selected: RelayPathSelected,
): selected is RelayPathSelected & {
  kind: "direct_lan" | "direct_public" | "direct_nat";
  endpoint: string;
} {
  return EMITTED_RELAY_PATH_KINDS.has(selected.kind) &&
    typeof selected.endpoint === "string";
}

type ServerEndpointRow = {
  id: string;
  metadata: unknown;
};

/**
 * Every range the org already holds: each CIDR-bearing `network` row (site
 * subnets, `reserved` ranges, docker registrations) plus any existing fabric
 * host range. Sourced from the collision authority so the reverse direction —
 * `pickDefaultFabricHostCidr` stepping around an operator's reserved range —
 * shares one definition with the forward checks.
 */
function occupiedCidrs(
  db: Db,
  organizationId: string,
): Promise<string[]> {
  return loadCidrAllocationExclusions(db, organizationId);
}

export async function getOrganizationFabric(
  db: Db,
  organizationId: string,
): Promise<FabricRecord | null> {
  const [row] = await db
    .select({
      id: fabric.id,
      organizationId: fabric.organizationId,
      cidr: fabric.cidr,
      options: fabric.options,
    })
    .from(fabric)
    .where(eq(fabric.organizationId, organizationId))
    .limit(1);
  if (!row) return null;
  return serializeFabric(row);
}

export async function getFabricById(
  db: Db,
  fabricId: string,
): Promise<FabricRecord | null> {
  const [row] = await db
    .select({
      id: fabric.id,
      organizationId: fabric.organizationId,
      cidr: fabric.cidr,
      options: fabric.options,
    })
    .from(fabric)
    .where(eq(fabric.id, fabricId))
    .limit(1);
  if (!row) return null;
  return serializeFabric(row);
}

function serializeFabric(row: {
  id: string;
  organizationId: string;
  cidr: unknown;
  options: unknown;
}): FabricRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    cidr: typeof row.cidr === "string" ? row.cidr : String(row.cidr),
    options: row.options,
  };
}

function serializeRelayRole(value: string): RelayRole {
  return value === "gateway" ? "gateway" : "member";
}

function serializeAdvertisedCidrs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string =>
    typeof item === "string" && item.length > 0
  );
}

function serializeRelayMetadata(value: unknown): RelayMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as RelayMetadata;
}

function serializeRelay(row: {
  id: string;
  fabricId: string;
  serverId: string;
  address: unknown;
  role: string;
  keepalive: number | null;
  endpointAddress: unknown;
  publicKey: string | null;
  prefix: unknown;
  advertisedCidrs: unknown;
  metadata: unknown;
  options?: unknown;
}): RelayRecord {
  const role = serializeRelayRole(row.role);
  const policy = parseRelayPolicy(row.options);
  return {
    id: row.id,
    fabricId: row.fabricId,
    serverId: row.serverId,
    address: stripInetPrefixSuffix(
      typeof row.address === "string" ? row.address : String(row.address),
    ),
    role,
    keepalive: row.keepalive,
    endpointAddress: inetAddressToString(row.endpointAddress) ??
      (typeof row.endpointAddress === "string"
        ? stripInetPrefixSuffix(row.endpointAddress)
        : null),
    publicKey: row.publicKey,
    prefix: typeof row.prefix === "string" ? row.prefix : String(row.prefix),
    advertisedCidrs: role === "member"
      ? []
      : serializeAdvertisedCidrs(row.advertisedCidrs),
    metadata: serializeRelayMetadata(row.metadata),
    allowRelay: policy.allowRelay,
    preferredGatewayIds: policy.preferredGatewayIds,
  };
}

const RELAY_SELECT = {
  id: relay.id,
  fabricId: relay.fabricId,
  serverId: relay.serverId,
  address: relay.address,
  role: relay.role,
  keepalive: relay.keepalive,
  endpointAddress: relay.endpointAddress,
  publicKey: relay.publicKey,
  prefix: relay.prefix,
  advertisedCidrs: relay.advertisedCidrs,
  metadata: relay.metadata,
  options: relay.options,
};

export async function listFabricRelays(
  db: Db,
  fabricId: string,
): Promise<RelayRecord[]> {
  const rows = await db
    .select(RELAY_SELECT)
    .from(relay)
    .where(eq(relay.fabricId, fabricId));

  return rows.map((row) => serializeRelay(row));
}

/**
 * Relay `tp0` addresses for the given servers (one `inArray` query).
 * Missing relays are omitted from the map.
 */
export async function loadRelayAddressesForServers(
  db: Db,
  serverIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (serverIds.length === 0) return out;
  const uniqueIds = [...new Set(serverIds)];
  const rows = await db
    .select({
      serverId: relay.serverId,
      address: relay.address,
    })
    .from(relay)
    .where(inArray(relay.serverId, uniqueIds));
  for (const row of rows) {
    const address = stripInetPrefixSuffix(
      typeof row.address === "string" ? row.address : String(row.address),
    );
    if (address.length > 0) out.set(row.serverId, address);
  }
  return out;
}

/** Sealed `tpsecret` only — never surface on {@link RelayRecord}. */
export async function loadRelayPresharedKey(
  db: Db,
  relayId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ presharedKey: relay.presharedKey })
    .from(relay)
    .where(eq(relay.id, relayId))
    .limit(1);
  return row?.presharedKey ?? null;
}

export function requireRelayHostAddress(
  cidrValue: string,
  occupied: readonly string[],
): string {
  const address = nextFreeHostAddress(cidrValue, occupied);
  if (!address) {
    throw new FabricAllocationError("fabric_address_pool_exhausted");
  }
  return address;
}

/**
 * Lowest free relay `/16` in the container pool. `occupied` is the exact set
 * of prefixes other relays already hold; `exclusions` are org ranges the
 * prefix must not overlap (reserved rows, site subnets — see
 * `loadCidrAllocationExclusions`). Exhaustion, including exhaustion caused
 * purely by exclusions, still raises `fabric_prefix_pool_exhausted`.
 */
export function requireRelayPrefix(
  containerPool: string,
  occupied: readonly string[],
  exclusions: readonly string[] = [],
): string {
  const prefix = nextFreeSubnet(
    containerPool,
    RELAY_PREFIX_LENGTH,
    occupied,
    exclusions,
  );
  if (!prefix) {
    throw new FabricAllocationError("fabric_prefix_pool_exhausted");
  }
  return prefix;
}

/**
 * Lowest free `/24` segment inside a relay prefix. `takenCidrs` are the
 * server's existing segments; `exclusions` are org ranges the segment must
 * not overlap. Exhaustion still raises `fabric_segment_pool_exhausted`.
 */
export function requireSubnetCidr(
  relayPrefix: string,
  takenCidrs: readonly string[],
  exclusions: readonly string[] = [],
): string {
  const cidrValue = nextFreeSubnetCidr(relayPrefix, takenCidrs, exclusions);
  if (!cidrValue) {
    throw new FabricAllocationError("fabric_segment_pool_exhausted");
  }
  return cidrValue;
}

async function occupiedRelayAddresses(
  db: Db,
  fabricId: string,
): Promise<string[]> {
  const rows = await db
    .select({ address: relay.address })
    .from(relay)
    .where(eq(relay.fabricId, fabricId));
  return rows.map((row) =>
    stripInetPrefixSuffix(
      typeof row.address === "string" ? row.address : String(row.address),
    )
  );
}

async function occupiedRelayPrefixes(
  db: Db,
  fabricId: string,
): Promise<string[]> {
  const rows = await db
    .select({ prefix: relay.prefix })
    .from(relay)
    .where(eq(relay.fabricId, fabricId));
  return rows.map((row) =>
    typeof row.prefix === "string" ? row.prefix : String(row.prefix)
  );
}

async function insertRelayOnce(
  tx: Db,
  params: {
    fabric: FabricRecord;
    serverId: string;
    containerPool: string;
    /** Org ranges the relay prefix must not overlap (reserved / site / docker). */
    exclusions: readonly string[];
  },
): Promise<void> {
  const [addresses, prefixes] = await Promise.all([
    occupiedRelayAddresses(tx, params.fabric.id),
    occupiedRelayPrefixes(tx, params.fabric.id),
  ]);
  const address = requireRelayHostAddress(params.fabric.cidr, addresses);
  const prefix = requireRelayPrefix(
    params.containerPool,
    prefixes,
    params.exclusions,
  );
  await tx.insert(relay).values({
    fabricId: params.fabric.id,
    serverId: params.serverId,
    address,
    prefix,
  });
}

function isRelayInsertUniqueViolation(err: unknown): boolean {
  return isRelayAddressUniqueViolation(err) ||
    isRelayPrefixUniqueViolation(err);
}

async function insertRelayWithRetry(
  db: Db,
  params: {
    fabric: FabricRecord;
    serverId: string;
    containerPool: string;
    exclusions: readonly string[];
  },
): Promise<void> {
  try {
    await insertRelayOnce(db, params);
  } catch (err) {
    if (!isRelayInsertUniqueViolation(err)) throw err;
    try {
      await insertRelayOnce(db, params);
    } catch (retryErr) {
      if (isRelayAddressUniqueViolation(retryErr)) {
        throw new FabricAllocationError("fabric_address_pool_exhausted");
      }
      if (isRelayPrefixUniqueViolation(retryErr)) {
        throw new FabricAllocationError("fabric_prefix_pool_exhausted");
      }
      throw retryErr;
    }
  }
}

export async function ensureFabricRelays(
  db: Db,
  params: {
    fabric: FabricRecord;
    organizationId: string;
  },
): Promise<RelayRecord[]> {
  const options = parseFabricOptions(params.fabric.options);
  const orgServers = await db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.organizationId, params.organizationId));

  const existing = await listFabricRelays(db, params.fabric.id);
  const have = new Set(existing.map((row) => row.serverId));

  let exclusions: readonly string[] | null = null;
  for (const row of orgServers) {
    if (have.has(row.id)) continue;
    // Loaded lazily: most calls find every server already has a relay.
    exclusions ??= await loadCidrAllocationExclusions(
      db,
      params.organizationId,
    );
    await insertRelayWithRetry(db, {
      fabric: params.fabric,
      serverId: row.id,
      containerPool: options.containerPool,
      exclusions,
    });
  }

  return listFabricRelays(db, params.fabric.id);
}

function hasFabricEnablePolicy(policy: FabricEnablePolicy): boolean {
  return policy.allowRelay !== undefined || policy.containerPool !== undefined;
}

/**
 * Enable TurboFabric for an organization (idempotent) and make sure every org
 * server holds a relay.
 *
 * The optional `policy` is written **before** relays are allocated and the
 * whole step runs in one transaction: a relay prefix is always carved from
 * the pool that ends up persisted (allocation is the containment proof), and
 * pool exhaustion or a host-range collision rolls back the fabric row /
 * policy write instead of leaving Fabric half-enabled. The route still
 * refuses a pool that would orphan an *already allocated* relay prefix before
 * calling this. Note the allocator's unique-violation retry cannot recover
 * inside the transaction (Postgres aborts it on the first violation) — a
 * concurrent allocation race surfaces as a rolled-back enable instead.
 */
export async function enableOrganizationFabric(
  db: Db,
  organizationId: string,
  policy: FabricEnablePolicy = {},
): Promise<FabricRecord> {
  const existing = await getOrganizationFabric(db, organizationId);
  if (existing) {
    return db.transaction(async (tx) => {
      let record = existing;
      if (hasFabricEnablePolicy(policy)) {
        record = (await updateFabricPolicy(tx, {
          fabricId: existing.id,
          ...policy,
        })) ?? existing;
      }
      await ensureFabricRelays(tx, { fabric: record, organizationId });
      return record;
    });
  }

  const cidr = pickDefaultFabricHostCidr(
    await occupiedCidrs(db, organizationId),
  );
  if (!cidr) {
    throw new Error("No free CIDR for TurboFabric");
  }
  if (
    policy.containerPool !== undefined &&
    cidrsOverlap(cidr, policy.containerPool)
  ) {
    throw new FabricContainerPoolOverlapError(policy.containerPool, cidr);
  }

  const defaults = parseFabricOptions(null);
  const options = {
    ...defaults,
    allowRelay: policy.allowRelay ?? defaults.allowRelay,
    containerPool: policy.containerPool ?? defaults.containerPool,
  };

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(fabric)
      .values({ organizationId, cidr, options })
      .returning({
        id: fabric.id,
        organizationId: fabric.organizationId,
        cidr: fabric.cidr,
        options: fabric.options,
      });
    if (!row) throw new Error("TurboFabric insert failed");

    const record: FabricRecord = {
      id: row.id,
      organizationId: row.organizationId,
      cidr: typeof row.cidr === "string" ? row.cidr : String(row.cidr),
      options: row.options,
    };
    await ensureFabricRelays(tx, { fabric: record, organizationId });
    return record;
  });
}

export async function disableOrganizationFabric(
  db: Db,
  organizationId: string,
): Promise<string[]> {
  const existing = await getOrganizationFabric(db, organizationId);
  if (!existing) return [];
  const relays = await listFabricRelays(db, existing.id);
  const serverIds = relays.map((row) => row.serverId);
  await db.delete(fabric).where(eq(fabric.id, existing.id));
  return serverIds;
}

export async function stampRelayPublicKey(
  db: Db,
  params: { fabricId: string; serverId: string; publicKey: string },
): Promise<boolean> {
  const [existing] = await db
    .select({ publicKey: relay.publicKey })
    .from(relay)
    .where(
      and(
        eq(relay.fabricId, params.fabricId),
        eq(relay.serverId, params.serverId),
      ),
    )
    .limit(1);
  if (!existing) return false;
  const filledNullKey = !existing.publicKey;
  await db
    .update(relay)
    .set({ publicKey: params.publicKey, updatedAt: nowIso() })
    .where(
      and(
        eq(relay.fabricId, params.fabricId),
        eq(relay.serverId, params.serverId),
      ),
    );
  return filledNullKey;
}

function mergeRelayMetadata(
  existing: unknown,
  patch: RelayMetadata,
): RelayMetadata {
  const base = serializeRelayMetadata(existing);
  const next: RelayMetadata = { ...base, ...patch };
  if (patch.observed) next.observed = patch.observed;
  return next;
}

export async function stampRelayPathSummary(
  db: Db,
  params: {
    fabricId: string;
    serverId: string;
    entries: FabricPathSummaryEntry[];
  },
): Promise<void> {
  const [existing] = await db
    .select({ metadata: relay.metadata })
    .from(relay)
    .where(
      and(
        eq(relay.fabricId, params.fabricId),
        eq(relay.serverId, params.serverId),
      ),
    )
    .limit(1);
  if (!existing) return;

  const metadata = mergeRelayMetadata(existing.metadata, {
    paths: { at: nowIso(), entries: params.entries },
  });
  await db
    .update(relay)
    .set({ metadata, updatedAt: nowIso() })
    .where(
      and(
        eq(relay.fabricId, params.fabricId),
        eq(relay.serverId, params.serverId),
      ),
    );
}

export async function stampRelayReconcileSuccess(
  db: Db,
  params: {
    fabricId: string;
    serverId: string;
    appliedPayloadHash: string;
    observedPeers?: RelayObservedPeer[];
  },
): Promise<void> {
  const [existing] = await db
    .select({ metadata: relay.metadata })
    .from(relay)
    .where(
      and(
        eq(relay.fabricId, params.fabricId),
        eq(relay.serverId, params.serverId),
      ),
    )
    .limit(1);
  if (!existing) return;

  const metadata = mergeRelayMetadata(existing.metadata, {
    appliedPayloadHash: params.appliedPayloadHash,
    appliedAt: nowIso(),
    ...(params.observedPeers
      ? { observed: { at: nowIso(), peers: params.observedPeers } }
      : {}),
  });
  await db
    .update(relay)
    .set({ metadata, updatedAt: nowIso() })
    .where(
      and(
        eq(relay.fabricId, params.fabricId),
        eq(relay.serverId, params.serverId),
      ),
    );
}

export async function clearRelayAppliedPayloadHash(
  db: Db,
  params: { serverId: string; fabricId?: string },
): Promise<void> {
  const rows = await db
    .select({
      id: relay.id,
      fabricId: relay.fabricId,
      metadata: relay.metadata,
    })
    .from(relay)
    .where(
      params.fabricId
        ? and(
          eq(relay.serverId, params.serverId),
          eq(relay.fabricId, params.fabricId),
        )
        : eq(relay.serverId, params.serverId),
    );
  for (const row of rows) {
    const current = serializeRelayMetadata(row.metadata);
    if (current.appliedPayloadHash === undefined) continue;
    const { appliedPayloadHash: _removed, ...rest } = current;
    await db
      .update(relay)
      .set({ metadata: rest, updatedAt: nowIso() })
      .where(eq(relay.id, row.id));
  }
}

export async function updateFabricRelay(
  db: Db,
  params: {
    fabricId: string;
    serverId: string;
    role?: RelayRole;
    advertisedCidrs?: string[];
    keepalive?: number | null;
    endpointAddress?: string | null;
    presharedKey?: string | null;
    allowRelay?: boolean | null;
    preferredGatewayIds?: string[];
  },
): Promise<RelayRecord | null> {
  const patch: {
    role?: RelayRole;
    advertisedCidrs?: string[];
    keepalive?: number | null;
    endpointAddress?: string | null;
    presharedKey?: string | null;
    options?: unknown;
    updatedAt: string;
  } = { updatedAt: nowIso() };
  if (params.role !== undefined) patch.role = params.role;
  if (params.advertisedCidrs !== undefined) {
    patch.advertisedCidrs = params.advertisedCidrs;
  }
  if (params.keepalive !== undefined) patch.keepalive = params.keepalive;
  if (params.endpointAddress !== undefined) {
    patch.endpointAddress = params.endpointAddress;
  }
  if (params.presharedKey !== undefined) {
    patch.presharedKey = params.presharedKey;
  }
  if (
    params.allowRelay !== undefined || params.preferredGatewayIds !== undefined
  ) {
    const [current] = await db
      .select({ options: relay.options })
      .from(relay)
      .where(
        and(
          eq(relay.fabricId, params.fabricId),
          eq(relay.serverId, params.serverId),
        ),
      )
      .limit(1);
    if (!current) return null;
    patch.options = mergeRelayPolicyOptions(current.options, {
      ...(params.allowRelay !== undefined
        ? { allowRelay: params.allowRelay }
        : {}),
      ...(params.preferredGatewayIds !== undefined
        ? { preferredGatewayIds: params.preferredGatewayIds }
        : {}),
    });
  }

  const [row] = await db
    .update(relay)
    .set(patch)
    .where(
      and(
        eq(relay.fabricId, params.fabricId),
        eq(relay.serverId, params.serverId),
      ),
    )
    .returning(RELAY_SELECT);
  if (!row) return null;
  return serializeRelay(row);
}

const FABRIC_RECORD_SELECT = {
  id: fabric.id,
  organizationId: fabric.organizationId,
  cidr: fabric.cidr,
  options: fabric.options,
};

/**
 * Write the operator-settable fabric policy keys into `fabric.options`.
 * `containerPool` only changes what future relay prefixes are carved from —
 * nothing renumbers an allocated relay `/16`, so the route refuses a pool
 * that would orphan one (`fabric_container_pool_in_use`) before calling this.
 */
export async function updateFabricPolicy(
  db: Db,
  params: { fabricId: string; allowRelay?: boolean; containerPool?: string },
): Promise<FabricRecord | null> {
  const [existing] = await db
    .select({ options: fabric.options })
    .from(fabric)
    .where(eq(fabric.id, params.fabricId))
    .limit(1);
  if (!existing) return null;
  const current = parseFabricOptions(existing.options);
  const options = {
    ...current,
    allowRelay: params.allowRelay ?? current.allowRelay,
    containerPool: params.containerPool ?? current.containerPool,
  };
  const [row] = await db
    .update(fabric)
    .set({ options, updatedAt: nowIso() })
    .where(eq(fabric.id, params.fabricId))
    .returning(FABRIC_RECORD_SELECT);
  if (!row) return null;
  return serializeFabric(row);
}

export async function deleteServerFabricMembership(
  db: Db,
  serverId: string,
): Promise<void> {
  await db.delete(subnet).where(eq(subnet.serverId, serverId));
  await db.delete(relay).where(eq(relay.serverId, serverId));
}

export type EnvironmentComposeNetworkSubnet = {
  serverId: string;
  subnet: string;
};

export type EnvironmentComposeNetwork = {
  networkId: string;
  hostName: string;
  segments: EnvironmentComposeNetworkSubnet[];
};

async function deleteComposeNetworkIds(
  db: Db,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(subnet).where(inArray(subnet.networkId, [...ids]));
  await db.delete(network).where(inArray(network.id, [...ids]));
}

export async function listEnvironmentComposeNetworks(
  db: Db,
  environmentId: string,
): Promise<EnvironmentComposeNetwork[]> {
  const rows = await db
    .select({
      networkId: network.id,
      serverId: subnet.serverId,
      subnet: subnet.cidr,
    })
    .from(network)
    .leftJoin(subnet, eq(subnet.networkId, network.id))
    .where(
      and(
        eq(network.environmentId, environmentId),
        eq(network.kind, "compose"),
      ),
    );

  const grouped = new Map<string, EnvironmentComposeNetwork>();
  for (const row of rows) {
    let entry = grouped.get(row.networkId);
    if (!entry) {
      entry = {
        networkId: row.networkId,
        hostName: composeNetworkHostName(row.networkId),
        segments: [],
      };
      grouped.set(row.networkId, entry);
    }
    if (row.serverId && typeof row.subnet === "string") {
      entry.segments.push({
        serverId: row.serverId,
        subnet: typeof row.subnet === "string"
          ? row.subnet
          : String(row.subnet),
      });
    }
  }

  return [...grouped.values()].sort((a, b) =>
    a.hostName.localeCompare(b.hostName)
  );
}

export function composeNetworkNamesByServer(
  rows: readonly EnvironmentComposeNetwork[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    for (const seg of row.segments) {
      const names = map.get(seg.serverId) ?? [];
      names.push(row.hostName);
      map.set(seg.serverId, names);
    }
  }
  for (const [serverId, names] of map) {
    map.set(
      serverId,
      [...new Set(names)].sort((a, b) => a.localeCompare(b)),
    );
  }
  return map;
}

export async function purgeEnvironmentsComposeNetworks(
  db: Db,
  environmentIds: readonly string[],
): Promise<void> {
  if (environmentIds.length === 0) return;
  const rows = await db
    .select({ id: network.id })
    .from(network)
    .where(
      and(
        inArray(network.environmentId, [...environmentIds]),
        eq(network.kind, "compose"),
      ),
    );
  await deleteComposeNetworkIds(db, rows.map((row) => row.id));
}

export async function purgeEnvironmentComposeNetworks(
  db: Db,
  environmentId: string,
): Promise<void> {
  await purgeEnvironmentsComposeNetworks(db, [environmentId]);
}

/**
 * Drop compose `network` / `subnet` rows created after `prior` was snapshotted.
 * Used to compensate a deploy attempt that exits before deployment-target
 * writes succeed.
 */
export async function purgeComposeNetworksCreatedAfter(
  db: Db,
  environmentId: string,
  prior: readonly EnvironmentComposeNetwork[],
): Promise<void> {
  const priorIds = new Set(prior.map((row) => row.networkId));
  const priorSegments = new Map<string, Set<string>>();
  for (const row of prior) {
    priorSegments.set(
      row.networkId,
      new Set(row.segments.map((segmentRow) => segmentRow.serverId)),
    );
  }

  const current = await listEnvironmentComposeNetworks(db, environmentId);
  const createdNetworkIds = current
    .map((row) => row.networkId)
    .filter((id) => !priorIds.has(id));
  await deleteComposeNetworkIds(db, createdNetworkIds);

  for (const row of current) {
    if (!priorIds.has(row.networkId)) continue;
    const known = priorSegments.get(row.networkId) ?? new Set<string>();
    const extraServerIds = row.segments
      .map((segmentRow) => segmentRow.serverId)
      .filter((serverId) => !known.has(serverId));
    if (extraServerIds.length === 0) continue;
    await db.delete(subnet).where(
      and(
        eq(subnet.networkId, row.networkId),
        inArray(subnet.serverId, extraServerIds),
      ),
    );
  }
}

export async function releaseSubnetsForServer(
  db: Db,
  params: { environmentId: string; serverId: string },
): Promise<void> {
  const networks = await db
    .select({ id: network.id })
    .from(network)
    .where(
      and(
        eq(network.environmentId, params.environmentId),
        eq(network.kind, "compose"),
      ),
    );
  const ids = networks.map((row) => row.id);
  if (ids.length === 0) return;
  await db.delete(subnet).where(
    and(
      eq(subnet.serverId, params.serverId),
      inArray(subnet.networkId, ids),
    ),
  );
  const remaining = await db
    .select({ networkId: subnet.networkId })
    .from(subnet)
    .where(inArray(subnet.networkId, ids));
  const remainingIds = new Set(remaining.map((row) => row.networkId));
  await deleteComposeNetworkIds(
    db,
    ids.filter((id) => !remainingIds.has(id)),
  );
}

export async function purgeOrganizationComposeNetworks(
  db: Db,
  organizationId: string,
): Promise<void> {
  const rows = await db
    .select({ id: network.id })
    .from(network)
    .where(
      and(
        eq(network.organizationId, organizationId),
        eq(network.kind, "compose"),
      ),
    );
  await deleteComposeNetworkIds(db, rows.map((row) => row.id));
}

export async function loadRelayPresharedKeyPresence(
  db: Db,
  relayIds: readonly string[],
): Promise<Set<string>> {
  const present = new Set<string>();
  if (relayIds.length === 0) return present;
  const rows = await loadRelayPresharedKeyRows(db, relayIds);
  for (const row of rows) {
    if (row.presharedKey) present.add(row.id);
  }
  return present;
}

async function loadRelayPresharedKeyRows(
  db: Db,
  relayIds: readonly string[],
): Promise<Array<{ id: string; presharedKey: string | null }>> {
  if (relayIds.length === 0) return [];
  return await db
    .select({ id: relay.id, presharedKey: relay.presharedKey })
    .from(relay)
    .where(inArray(relay.id, [...relayIds]));
}

/**
 * Canonical per-pair PSK: both peer stanzas use the envelope owned by the
 * lexicographically smaller relay id, falling back to the other relay when
 * that owner has none. A mesh with two different stored PSKs still encrypts
 * the pair with one plaintext.
 */
export function selectPairPresharedEnvelope(
  selfRelayId: string,
  otherRelayId: string,
  sealedByRelayId: ReadonlyMap<string, string | null>,
): string | null {
  const ownerId = selfRelayId.localeCompare(otherRelayId) <= 0
    ? selfRelayId
    : otherRelayId;
  const fallbackId = ownerId === selfRelayId ? otherRelayId : selfRelayId;
  return sealedByRelayId.get(ownerId) ?? sealedByRelayId.get(fallbackId) ??
    null;
}

function reportedIpsFromMetadata(
  metadata: unknown,
): ServerReportedIp[] | undefined {
  return reportedIpsFromServerMetadata(metadata);
}

/**
 * Globally-meaningful endpoint for a relay, for display only. Not
 * authoritative for peer building — use {@link planRelayPath} instead.
 *
 * **Deliberately excludes datacenter and other private addresses.** GET fabric
 * lists every relay with no viewer/`self` pair, so a destination-only lookup
 * cannot know whether the reader shares that datacenter; publishing a private
 * LAN pin as a generic `resolvedEndpoint` told cross-datacenter readers to dial
 * an address that is not routable for them. Pair-aware detail belongs on the
 * per-peer path summary (`relay.metadata.paths.entries[].endpoint`), which is
 * source-aware by construction.
 *
 * Returns `null` when the relay has no operator pin and no public address —
 * the mesh may still be reachable over a shared LAN or a gateway, which the
 * path summary reports.
 */
export function resolveRelayGlobalEndpointAddress(
  row: Pick<RelayRecord, "serverId" | "endpointAddress">,
  caches: Pick<
    EndpointAddressCaches,
    "publicAddressByServer" | "reportedByServer"
  >,
): string | null {
  if (row.endpointAddress) return row.endpointAddress;

  const publicAddress = caches.publicAddressByServer.get(row.serverId);
  if (publicAddress) return publicAddress;

  return publicIpv4FromIps(caches.reportedByServer.get(row.serverId)) ?? null;
}

/**
 * First family-compatible pin in a **trusted** shared datacenter, walked in
 * `(priority asc, id asc)` order — the same partition the managed ladder
 * uses (`partitionSharedDatacenters`). A `direct_lan` candidate is never
 * produced on an untrusted segment; otherwise WireGuard would pick a LAN
 * endpoint the managed ladder just refused.
 */
function lanPathCandidate(
  selfServerId: string,
  otherServerId: string,
  caches: EndpointAddressCaches,
): RelayPathCandidate | null {
  const fromPins = caches.datacenterMembershipsByServer.get(selfServerId) ?? [];
  const toPins = caches.datacenterMembershipsByServer.get(otherServerId) ?? [];
  const { trusted } = partitionSharedDatacenters(
    fromPins,
    toPins,
    caches.policyByDatacenter,
  );
  for (const datacenterId of trusted) {
    const policy = caches.policyByDatacenter.get(datacenterId) ??
      defaultDatacenterPolicyRow();
    const address = pinAddressForDatacenter(
      fromPins,
      toPins,
      datacenterId,
      policy.addressPreference,
    );
    if (address) return { kind: "direct_lan", address, datacenterId };
  }
  return null;
}

function reportedPublicIpv4(
  ips: ServerReportedIp[] | undefined,
): string | undefined {
  return ips?.find((row) => row.scope === "public" && row.version === 4)
    ?.address;
}

function publicPathCandidate(
  other: Pick<RelayRecord, "serverId" | "endpointAddress">,
  caches: EndpointAddressCaches,
): RelayPathCandidate | null {
  if (other.endpointAddress) {
    return { kind: "direct_public", address: other.endpointAddress };
  }
  const publicAddress = caches.publicAddressByServer.get(other.serverId);
  if (publicAddress) return { kind: "direct_public", address: publicAddress };
  const reported = reportedPublicIpv4(
    caches.reportedByServer.get(other.serverId),
  );
  if (reported) return { kind: "direct_public", address: reported };
  return null;
}

function natPathCandidate(
  selfServerId: string,
  other: Pick<RelayRecord, "serverId">,
  caches: EndpointAddressCaches,
): RelayPathCandidate | null {
  const endpoint = caches.natEndpointByPair.get(
    fabricPairCacheKey(selfServerId, other.serverId),
  );
  if (!endpoint) return null;
  return { kind: "direct_nat", address: endpoint };
}

function failedKindsForPair(
  selfServerId: string,
  otherServerId: string,
  caches: EndpointAddressCaches,
): Set<RelayPathKind> | undefined {
  return caches.failedPathKindsByPair.get(
    fabricPairCacheKey(selfServerId, otherServerId),
  );
}

/** Direct LAN then public then NAT candidates for an arbitrary `(from → to)` pair. */
export function directCandidates(
  selfServerId: string,
  other: Pick<RelayRecord, "serverId" | "endpointAddress">,
  caches: EndpointAddressCaches,
): RelayPathCandidate[] {
  const failed = failedKindsForPair(selfServerId, other.serverId, caches);
  const candidates: RelayPathCandidate[] = [];
  const lan = lanPathCandidate(selfServerId, other.serverId, caches);
  if (lan && !failed?.has("direct_lan")) candidates.push(lan);
  const pub = publicPathCandidate(other, caches);
  if (pub && !failed?.has("direct_public")) candidates.push(pub);
  const nat = natPathCandidate(selfServerId, other, caches);
  if (nat && !failed?.has("direct_nat")) candidates.push(nat);
  return candidates;
}

function selectedFromCandidate(
  candidate: RelayPathCandidate,
): RelayPathSelected {
  if (
    (candidate.kind === "direct_lan" ||
      candidate.kind === "direct_public" ||
      candidate.kind === "direct_nat") &&
    candidate.address
  ) {
    return {
      kind: candidate.kind,
      endpoint: candidate.address,
      ...(candidate.datacenterId
        ? { datacenterId: candidate.datacenterId }
        : {}),
    };
  }
  if (candidate.kind === "gateway") {
    return {
      kind: "gateway",
      ...(candidate.viaServerId ? { viaServerId: candidate.viaServerId } : {}),
      ...(candidate.viaRelayId ? { viaRelayId: candidate.viaRelayId } : {}),
    };
  }
  return { kind: candidate.kind };
}

const UNIMPLEMENTED_PATH_CANDIDATES: Pick<
  RelayPathPlan,
  "gateway" | "relay"
> = {
  gateway: null,
  relay: null,
};

function relayPathPlan(
  candidates: RelayPathCandidate[],
  selected: RelayPathSelected,
  extras?: Partial<Pick<RelayPathPlan, "directNat" | "gateway" | "relay">>,
): RelayPathPlan {
  const directNat = extras?.directNat ??
    candidates.find((row) => row.kind === "direct_nat") ??
    null;
  return {
    candidates,
    selected,
    directNat,
    ...UNIMPLEMENTED_PATH_CANDIDATES,
    ...extras,
  };
}

function selectRelayPath(
  candidates: readonly RelayPathCandidate[],
  operatorPin: string | null,
): RelayPathSelected {
  if (operatorPin) {
    const pinned = candidates.find((row) =>
      row.kind === "direct_public" && row.address === operatorPin
    );
    if (pinned) return selectedFromCandidate(pinned);
  }
  const first = candidates[0];
  if (first) return selectedFromCandidate(first);
  return { kind: "unreachable" };
}

/** Public-keyed `role === 'gateway'` relays (a keyless gateway cannot be a peer). */
export type GatewayCandidateRelay = Pick<
  RelayRecord,
  "id" | "serverId" | "role" | "publicKey" | "endpointAddress"
>;

const MAX_GATEWAY_HOPS = 2;

function gatewayCandidateRelays(
  relays: readonly GatewayCandidateRelay[],
  selfServerId: string,
  otherServerId: string,
): GatewayCandidateRelay[] {
  return relays.filter((row) =>
    row.role === "gateway" &&
    Boolean(row.publicKey) &&
    row.serverId !== selfServerId &&
    row.serverId !== otherServerId
  );
}

// Gateway locality (`datacenterIdSet` / `sharesDatacenterIds` /
// `gatewayLocalityAllowed` / `gatewayRankTier`) deliberately ignores
// `policyByDatacenter`: these rank *which* gateway to route through, using
// co-location as a proximity hint. The hop itself is still chosen by
// `directCandidates`, whose LAN rung is trust-filtered — so an untrusted
// shared datacenter can make a gateway *look* nearby without ever yielding a
// `direct_lan` endpoint on that segment. Do not "fix" this by trust-filtering
// locality.
function datacenterIdSet(
  serverId: string,
  caches: EndpointAddressCaches,
): Set<string> {
  const ids = new Set<string>();
  for (const pin of caches.datacenterMembershipsByServer.get(serverId) ?? []) {
    ids.add(pin.datacenterId);
  }
  return ids;
}

function sharesDatacenterIds(
  serverId: string,
  ids: ReadonlySet<string>,
  caches: EndpointAddressCaches,
): boolean {
  for (const pin of caches.datacenterMembershipsByServer.get(serverId) ?? []) {
    if (ids.has(pin.datacenterId)) return true;
  }
  return false;
}

function gatewayReachesDestination(
  from: GatewayCandidateRelay,
  dest: Pick<RelayRecord, "serverId" | "endpointAddress">,
  gateways: readonly GatewayCandidateRelay[],
  caches: EndpointAddressCaches,
  remainingHops: number,
  visited: ReadonlySet<string>,
): boolean {
  if (remainingHops < 1) return false;
  if (visited.has(from.serverId)) return false;
  const nextVisited = new Set(visited);
  nextVisited.add(from.serverId);
  if (directCandidates(from.serverId, dest, caches).length > 0) return true;
  if (remainingHops < 2) return false;
  for (const hop of gateways) {
    if (hop.serverId === from.serverId || hop.serverId === dest.serverId) {
      continue;
    }
    if (hop.role !== "gateway" || !hop.publicKey) continue;
    if (directCandidates(from.serverId, hop, caches).length === 0) continue;
    if (
      gatewayReachesDestination(
        hop,
        dest,
        gateways,
        caches,
        remainingHops - 1,
        nextVisited,
      )
    ) {
      return true;
    }
  }
  return false;
}

function gatewayLocalityAllowed(
  gateway: GatewayCandidateRelay,
  destDcIds: ReadonlySet<string>,
  selfDcIds: ReadonlySet<string>,
  caches: EndpointAddressCaches,
): boolean {
  return sharesDatacenterIds(gateway.serverId, destDcIds, caches) ||
    sharesDatacenterIds(gateway.serverId, selfDcIds, caches);
}

function gatewayRankTier(
  gateway: GatewayCandidateRelay,
  destDcIds: ReadonlySet<string>,
  selfDcIds: ReadonlySet<string>,
  caches: EndpointAddressCaches,
): number {
  if (sharesDatacenterIds(gateway.serverId, destDcIds, caches)) return 0;
  if (sharesDatacenterIds(gateway.serverId, selfDcIds, caches)) return 1;
  return 2;
}

function preferredGatewayRank(
  serverId: string,
  preferredGatewayIds: readonly string[],
): number {
  const index = preferredGatewayIds.indexOf(serverId);
  return index === -1 ? preferredGatewayIds.length : index;
}

function compareGatewayNextHops(
  a: GatewayCandidateRelay,
  b: GatewayCandidateRelay,
  destDcIds: ReadonlySet<string>,
  selfDcIds: ReadonlySet<string>,
  caches: EndpointAddressCaches,
  preferredGatewayIds: readonly string[],
): number {
  const tierDiff = gatewayRankTier(a, destDcIds, selfDcIds, caches) -
    gatewayRankTier(b, destDcIds, selfDcIds, caches);
  if (tierDiff !== 0) return tierDiff;
  const preferredDiff = preferredGatewayRank(a.serverId, preferredGatewayIds) -
    preferredGatewayRank(b.serverId, preferredGatewayIds);
  if (preferredDiff !== 0) return preferredDiff;
  return a.id.localeCompare(b.id);
}

export function resolveGatewayNextHop(params: {
  self: Pick<RelayRecord, "serverId">;
  other: Pick<RelayRecord, "serverId" | "endpointAddress">;
  gateways: readonly GatewayCandidateRelay[];
  caches: EndpointAddressCaches;
  preferredGatewayIds: readonly string[];
}): GatewayCandidateRelay | null {
  const destDcIds = datacenterIdSet(params.other.serverId, params.caches);
  const selfDcIds = datacenterIdSet(params.self.serverId, params.caches);
  const candidates = gatewayCandidateRelays(
    params.gateways,
    params.self.serverId,
    params.other.serverId,
  ).filter((gateway) => {
    if (directCandidates(params.self.serverId, gateway, params.caches).length === 0) {
      return false;
    }
    if (
      !gatewayReachesDestination(
        gateway,
        params.other,
        params.gateways,
        params.caches,
        MAX_GATEWAY_HOPS,
        new Set(),
      )
    ) {
      return false;
    }
    return gatewayLocalityAllowed(
      gateway,
      destDcIds,
      selfDcIds,
      params.caches,
    );
  });
  candidates.sort((a, b) =>
    compareGatewayNextHops(
      a,
      b,
      destDcIds,
      selfDcIds,
      params.caches,
      params.preferredGatewayIds,
    )
  );
  return candidates[0] ?? null;
}

/**
 * Pair-aware path from `self` to `other`. Returns ranked `direct_lan` then
 * `direct_public` then `direct_nat` candidates plus the selected path. An
 * operator pin still wins selection over LAN. When no direct candidate exists
 * and `gateways` is provided, fills `plan.gateway` with a bounded (≤2 hop)
 * next hop. `relay` stays unset (relay data plane is out of scope).
 * `allowRelay` is reserved for a future relay candidate slot and must not
 * loosen gateway locality.
 */
export function planRelayPath(params: {
  self: Pick<RelayRecord, "serverId">;
  other: Pick<RelayRecord, "serverId" | "endpointAddress">;
  caches: EndpointAddressCaches;
  gateways?: readonly GatewayCandidateRelay[];
  allowRelay?: boolean;
  preferredGatewayIds?: readonly string[];
}): RelayPathPlan {
  const candidates = directCandidates(
    params.self.serverId,
    params.other,
    params.caches,
  );
  if (candidates.length > 0) {
    return relayPathPlan(
      candidates,
      selectRelayPath(candidates, params.other.endpointAddress),
    );
  }
  if (!params.gateways) {
    return relayPathPlan(candidates, { kind: "unreachable" });
  }
  const hop = resolveGatewayNextHop({
    self: params.self,
    other: params.other,
    gateways: params.gateways,
    caches: params.caches,
    preferredGatewayIds: params.preferredGatewayIds ?? [],
  });
  if (!hop) return relayPathPlan(candidates, { kind: "unreachable" });
  const gateway: RelayPathCandidate = {
    kind: "gateway",
    viaServerId: hop.serverId,
    viaRelayId: hop.id,
  };
  return relayPathPlan(candidates, selectedFromCandidate(gateway), { gateway });
}

export async function loadEndpointCaches(
  db: Db,
  serverIds: readonly string[],
): Promise<
  { caches: EndpointAddressCaches; serversById: Map<string, ServerEndpointRow> }
> {
  const caches: EndpointAddressCaches = {
    publicAddressByServer: new Map(),
    reportedByServer: new Map(),
    ...emptyPairPlanningCaches(),
  };
  const serversById = new Map<string, ServerEndpointRow>();
  if (serverIds.length === 0) return { caches, serversById };

  const ids = [...serverIds];
  const [ipRows, serverRows] = await Promise.all([
    // Public pins only. Datacenter pins are pair-aware — path planning reads
    // them through `datacenterMembershipsByServer` so it can require *shared*
    // membership; a destination-only datacenter address has no valid consumer.
    db
      .select({
        serverId: ip.serverId,
        address: ip.address,
        scope: ip.scope,
        createdAt: ip.createdAt,
      })
      .from(ip)
      .where(and(inArray(ip.serverId, ids), eq(ip.scope, "public")))
      .orderBy(asc(ip.createdAt)),
    db
      .select({
        id: server.id,
        metadata: server.metadata,
      })
      .from(server)
      .where(inArray(server.id, ids)),
  ]);

  for (const row of ipRows) {
    if (!row.serverId) continue;
    const address = inetAddressToString(row.address);
    if (!address) continue;
    if (
      row.scope === "public" && !caches.publicAddressByServer.has(row.serverId)
    ) {
      caches.publicAddressByServer.set(row.serverId, address);
    }
  }

  for (const row of serverRows) {
    serversById.set(row.id, row);
    caches.reportedByServer.set(
      row.id,
      reportedIpsFromMetadata(row.metadata),
    );
  }
  return { caches, serversById };
}

function appendUniqueCidrs(
  target: string[],
  values: readonly string[],
): void {
  for (const value of values) {
    if (value.length === 0 || target.includes(value)) continue;
    target.push(value);
  }
}

export async function buildPeerMaterial(
  params: {
    self: Pick<RelayRecord, "serverId">;
    other: RelayRecord;
    listenPort: number;
    caches: EndpointAddressCaches;
    sealedPresharedKey: string | null;
    plan: RelayPathPlan;
    extraAllowedIPs?: readonly string[];
    resealPresharedKey?: (sealed: string) => Promise<string | null>;
    advertisedCidrs?: readonly string[];
  },
): Promise<RelayPeerMaterial | null> {
  if (!isEmittedDirectPath(params.plan.selected)) return null;

  const host32 = hostRoute32(params.other.address);
  const allowedIPs: string[] = [];
  appendUniqueCidrs(
    allowedIPs,
    [host32, params.other.prefix].filter(
      (value): value is string => typeof value === "string",
    ),
  );
  if (params.other.role === "gateway") {
    const advertised = params.advertisedCidrs ?? params.other.advertisedCidrs;
    appendUniqueCidrs(allowedIPs, advertised);
  }
  const extra = [...(params.extraAllowedIPs ?? [])].sort((a, b) =>
    a.localeCompare(b)
  );
  appendUniqueCidrs(allowedIPs, extra);

  let presharedKey: string | null = null;
  if (params.sealedPresharedKey && params.resealPresharedKey) {
    presharedKey = await params.resealPresharedKey(params.sealedPresharedKey);
  }

  const carriesTransit = extra.length > 0;
  const keepalive = params.other.keepalive ??
    (params.plan.selected.kind === "direct_nat"
      ? WIREGUARD_PERSISTENT_KEEPALIVE
      : null);
  const endpoint = params.plan.selected.kind === "direct_nat"
    ? params.plan.selected.endpoint
    : `${params.plan.selected.endpoint}:${String(params.listenPort)}`;
  const material: RelayPeerMaterial = {
    publicKey: params.other.publicKey ?? "",
    allowedIPs,
    endpoint,
    keepalive,
    sealedPresharedKey: params.sealedPresharedKey,
    presharedKey,
    pathKind: carriesTransit ? "gateway" : params.plan.selected.kind,
  };
  if (carriesTransit) material.viaServerId = params.other.serverId;
  return material;
}

export type FabricSegmentMaterial = {
  name: string;
  subnet: string;
  mtu?: number;
  gateway?: string;
};

function parseSegmentNetworkExtras(
  options: unknown,
): Pick<FabricSegmentMaterial, "mtu" | "gateway"> {
  if (!isOptionsRecord(options)) return {};
  const extras: Pick<FabricSegmentMaterial, "mtu" | "gateway"> = {};
  if (
    typeof options.mtu === "number" &&
    Number.isInteger(options.mtu) &&
    options.mtu >= 1280 &&
    options.mtu <= 9000
  ) {
    extras.mtu = options.mtu;
  }
  if (
    typeof options.gateway === "string" &&
    isValidIpAddress(options.gateway) &&
    !options.gateway.includes(":")
  ) {
    extras.gateway = options.gateway;
  }
  return extras;
}

export async function listServerSubnets(
  db: Db,
  serverId: string,
): Promise<FabricSegmentMaterial[]> {
  const rows = await db
    .select({
      networkId: subnet.networkId,
      cidr: subnet.cidr,
      options: subnet.options,
    })
    .from(subnet)
    .where(eq(subnet.serverId, serverId));

  return rows.map((row) => ({
    name: composeNetworkHostName(row.networkId),
    subnet: typeof row.cidr === "string" ? row.cidr : String(row.cidr),
    ...parseSegmentNetworkExtras(row.options),
  }));
}

export async function listSubnetsForServers(
  db: Db,
  serverIds: readonly string[],
): Promise<Map<string, FabricSegmentMaterial[]>> {
  const byServer = new Map<string, FabricSegmentMaterial[]>();
  for (const serverId of serverIds) byServer.set(serverId, []);
  if (serverIds.length === 0) return byServer;

  const rows = await db
    .select({
      serverId: subnet.serverId,
      networkId: subnet.networkId,
      cidr: subnet.cidr,
      options: subnet.options,
    })
    .from(subnet)
    .where(inArray(subnet.serverId, [...serverIds]));

  for (const row of rows) {
    const list = byServer.get(row.serverId) ?? [];
    list.push({
      name: composeNetworkHostName(row.networkId),
      subnet: typeof row.cidr === "string" ? row.cidr : String(row.cidr),
      ...parseSegmentNetworkExtras(row.options),
    });
    byServer.set(row.serverId, list);
  }
  return byServer;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  return `{${
    keys
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")
  }}`;
}

export async function hashFabricReconcileDesired(
  value: unknown,
): Promise<string> {
  return await sha256HexUtf8(stableJson(value));
}

export type FabricReconcileSnapshot = {
  fabric: FabricRecord;
  relays: RelayRecord[];
  caches: EndpointAddressCaches;
  sealedPresharedKeyByRelayId: Map<string, string | null>;
  segmentsByServer: Map<string, FabricSegmentMaterial[]>;
  derivedAdvertisedCidrsByRelayId: Map<string, string[]>;
  policy: FabricPolicy;
};

type EnabledFabricReconcilePayload = Extract<
  FabricReconcileCommandPayload,
  { enabled: true }
>;
type FabricReconcilePeer = EnabledFabricReconcilePayload["peers"][number];

/**
 * Relays that can appear in `buildReconcilePeerLists` (non-empty WireGuard
 * public key). Derived CIDR ownership must use this same set so a keyless
 * co-sited gateway cannot win a shared subnet that never lands in a peer
 * stanza. The GET fabric path still derives planned defaults for gateways
 * without keys.
 */
function publicKeyedRelays(relays: readonly RelayRecord[]): RelayRecord[] {
  return relays.filter((row) => row.publicKey);
}

/**
 * One batched read of everything needed to build every relay's reconcile
 * payload: relays, endpoint caches, PSK envelopes, segments, derived
 * gateway advertised CIDRs (owned among public-keyed relays only), plus
 * datacenter memberships and address-family preferences for pair-aware
 * `planRelayPath`.
 */
export async function loadFabricReconcileSnapshot(
  db: Db,
  fabric: FabricRecord,
): Promise<FabricReconcileSnapshot> {
  const relays = await listFabricRelays(db, fabric.id);
  const serverIds = relays.map((row) => row.serverId);
  const relayIds = relays.map((row) => row.id);
  const [
    { caches: endpointCaches },
    sealedRows,
    segmentsByServer,
    subnetsByServer,
    datacenterMembershipsByServer,
  ] = await Promise.all([
    loadEndpointCaches(db, serverIds),
    loadRelayPresharedKeyRows(db, relayIds),
    listSubnetsForServers(db, serverIds),
    loadDatacenterSubnetsForServers(db, serverIds),
    loadDatacenterMembershipsForServers(db, serverIds),
  ]);
  const datacenterIds = new Set<string>();
  for (const pins of datacenterMembershipsByServer.values()) {
    for (const pin of pins) datacenterIds.add(pin.datacenterId);
  }
  const policyByDatacenter = await loadDatacenterPolicies(
    db,
    [...datacenterIds],
  );
  const sealedPresharedKeyByRelayId = new Map<string, string | null>();
  for (const row of sealedRows) {
    sealedPresharedKeyByRelayId.set(row.id, row.presharedKey);
  }
  const caches: EndpointAddressCaches = {
    ...endpointCaches,
    datacenterMembershipsByServer,
    policyByDatacenter,
  };
  return {
    fabric,
    relays,
    caches,
    sealedPresharedKeyByRelayId,
    segmentsByServer,
    derivedAdvertisedCidrsByRelayId: resolveDerivedAdvertisedCidrsByRelay(
      publicKeyedRelays(relays),
      subnetsByServer,
    ),
    policy: parseFabricPolicy(fabric.options),
  };
}

function optionalNetworksField(
  networks: FabricSegmentMaterial[],
): { networks?: FabricSegmentMaterial[] } {
  if (networks.length === 0) return {};
  return { networks };
}

function reconcilePeerViews(material: RelayPeerMaterial): {
  peer: FabricReconcilePeer;
  hashPeer: Record<string, unknown>;
} {
  const peer: FabricReconcilePeer = {
    publicKey: material.publicKey,
    allowedIPs: material.allowedIPs,
    endpoint: material.endpoint,
  };
  const hashPeer: Record<string, unknown> = {
    publicKey: material.publicKey,
    allowedIPs: material.allowedIPs,
    endpoint: material.endpoint,
    pathKind: material.pathKind,
  };
  if (
    material.pathKind === "direct_lan" ||
    material.pathKind === "direct_public" ||
    material.pathKind === "direct_nat" ||
    material.pathKind === "gateway"
  ) {
    peer.pathKind = material.pathKind;
  }
  if (material.viaServerId) {
    peer.viaServerId = material.viaServerId;
    hashPeer.viaServerId = material.viaServerId;
  }
  if (material.presharedKey) {
    peer.presharedKeyEnvelope = material.presharedKey;
  }
  if (material.keepalive != null) {
    peer.keepalive = material.keepalive;
    hashPeer.keepalive = material.keepalive;
  }
  if (material.sealedPresharedKey) {
    hashPeer.presharedKey = material.sealedPresharedKey;
  }
  return { peer, hashPeer };
}

function destinationOwnedCidrs(other: RelayRecord): string[] {
  const host32 = hostRoute32(other.address);
  const cidrs: string[] = [];
  if (host32) cidrs.push(host32);
  cidrs.push(other.prefix);
  return cidrs;
}

export type GatewayRoutedPeer = { serverId: string; viaServerId: string };

type PeerListBuild = {
  peers: FabricReconcilePeer[];
  hashPeers: unknown[];
  unreachablePeers: Array<{ serverId: string }>;
  gatewayRoutedPeers: GatewayRoutedPeer[];
};

function planPathToOther(
  snapshot: FabricReconcileSnapshot,
  self: RelayRecord,
  other: RelayRecord,
  gateways: readonly RelayRecord[],
): RelayPathPlan {
  return planRelayPath({
    self,
    other,
    caches: snapshot.caches,
    gateways,
    preferredGatewayIds: self.preferredGatewayIds,
  });
}

async function emitPeerStanza(
  snapshot: FabricReconcileSnapshot,
  self: RelayRecord,
  other: RelayRecord,
  plan: RelayPathPlan,
  extraAllowedIPs: readonly string[],
  params: {
    resealPresharedKey?: (sealed: string) => Promise<string | null>;
  },
  listenPort: number,
): Promise<
  { peer: FabricReconcilePeer; hashPeer: Record<string, unknown> } | null
> {
  const sealedPresharedKey = selectPairPresharedEnvelope(
    self.id,
    other.id,
    snapshot.sealedPresharedKeyByRelayId,
  );
  const material = await buildPeerMaterial({
    self,
    other,
    listenPort,
    caches: snapshot.caches,
    sealedPresharedKey,
    plan,
    extraAllowedIPs,
    advertisedCidrs: snapshot.derivedAdvertisedCidrsByRelayId.get(other.id) ??
      other.advertisedCidrs,
    ...(params.resealPresharedKey
      ? { resealPresharedKey: params.resealPresharedKey }
      : {}),
  });
  if (!material) return null;
  return reconcilePeerViews(material);
}

async function buildReconcilePeerLists(
  snapshot: FabricReconcileSnapshot,
  self: RelayRecord,
  params: {
    serverId: string;
    resealPresharedKey?: (sealed: string) => Promise<string | null>;
  },
  listenPort: number,
): Promise<PeerListBuild> {
  const peers: FabricReconcilePeer[] = [];
  const hashPeers: unknown[] = [];
  const unreachablePeers: Array<{ serverId: string }> = [];
  const gatewayRoutedPeers: GatewayRoutedPeer[] = [];
  const peerRelays = snapshot.relays.filter(
    (row) => row.serverId !== params.serverId && row.publicKey,
  );
  const gateways = snapshot.relays.filter((row) =>
    row.role === "gateway" && Boolean(row.publicKey)
  );
  const extraByNextHopId = new Map<string, string[]>();
  const emitIds = new Set<string>();
  const plansByRelayId = new Map<string, RelayPathPlan>();

  for (const other of peerRelays) {
    const plan = planPathToOther(snapshot, self, other, gateways);
    plansByRelayId.set(other.id, plan);
    if (isEmittedDirectPath(plan.selected)) {
      emitIds.add(other.id);
      continue;
    }
    if (
      plan.selected.kind === "gateway" && plan.selected.viaRelayId &&
      plan.selected.viaServerId
    ) {
      const extra = extraByNextHopId.get(plan.selected.viaRelayId) ?? [];
      appendUniqueCidrs(extra, destinationOwnedCidrs(other));
      extraByNextHopId.set(plan.selected.viaRelayId, extra);
      emitIds.add(plan.selected.viaRelayId);
      gatewayRoutedPeers.push({
        serverId: other.serverId,
        viaServerId: plan.selected.viaServerId,
      });
      continue;
    }
    unreachablePeers.push({ serverId: other.serverId });
  }

  for (const other of peerRelays) {
    if (!emitIds.has(other.id)) continue;
    const plan = plansByRelayId.get(other.id) ??
      planPathToOther(snapshot, self, other, gateways);
    const extra = extraByNextHopId.get(other.id) ?? [];
    extra.sort((a, b) => a.localeCompare(b));
    const views = await emitPeerStanza(
      snapshot,
      self,
      other,
      plan,
      extra,
      params,
      listenPort,
    );
    if (!views) {
      unreachablePeers.push({ serverId: other.serverId });
      continue;
    }
    peers.push(views.peer);
    hashPeers.push(views.hashPeer);
  }
  return { peers, hashPeers, unreachablePeers, gatewayRoutedPeers };
}

type FabricReconcileBuild = {
  payload: FabricReconcileCommandPayload;
  desiredHash: string;
  unreachablePeers: Array<{ serverId: string }>;
  gatewayRoutedPeers: GatewayRoutedPeer[];
};

export async function buildFabricReconcilePayloadFromSnapshot(
  snapshot: FabricReconcileSnapshot,
  params: {
    serverId: string;
    mtu?: number;
    resealPresharedKey?: (sealed: string) => Promise<string | null>;
  },
): Promise<FabricReconcileBuild | null> {
  const self = snapshot.relays.find((row) => row.serverId === params.serverId);
  if (!self) return null;

  const host32 = hostRoute32(self.address);
  if (!host32) return null;

  const options = parseFabricOptions(snapshot.fabric.options);
  const mtu = params.mtu ?? options.mtu;
  const { peers, hashPeers, unreachablePeers, gatewayRoutedPeers } =
    await buildReconcilePeerLists(
      snapshot,
      self,
      params,
      options.listenPort,
    );
  const networks = snapshot.segmentsByServer.get(params.serverId) ?? [];
  const gatewayFlag = self.role === "gateway" ? { gateway: true as const } : {};
  const shared = {
    enabled: true as const,
    fabricId: snapshot.fabric.id,
    listenPort: options.listenPort,
    mtu,
    address: host32,
    prefix: self.prefix,
    ...optionalNetworksField(networks),
    ...gatewayFlag,
  };
  const payload: EnabledFabricReconcilePayload = { ...shared, peers };
  const desiredHash = await hashFabricReconcileDesired({
    ...shared,
    peers: hashPeers,
  });
  return { payload, desiredHash, unreachablePeers, gatewayRoutedPeers };
}

export async function buildFabricReconcilePayload(
  db: Db,
  params: {
    fabric: FabricRecord;
    serverId: string;
    mtu?: number;
    resealPresharedKey?: (sealed: string) => Promise<string | null>;
  },
): Promise<FabricReconcileBuild | null> {
  const snapshot = await loadFabricReconcileSnapshot(db, params.fabric);
  return await buildFabricReconcilePayloadFromSnapshot(snapshot, {
    serverId: params.serverId,
    ...(params.mtu !== undefined ? { mtu: params.mtu } : {}),
    ...(params.resealPresharedKey
      ? { resealPresharedKey: params.resealPresharedKey }
      : {}),
  });
}

export async function ensureComposeNetworkRow(
  db: Db,
  params: {
    organizationId: string;
    environmentId: string;
    composeKey: string;
  },
): Promise<{ id: string; hostName: string }> {
  const existing = await db
    .select({ id: network.id, options: network.options })
    .from(network)
    .where(
      and(
        eq(network.organizationId, params.organizationId),
        eq(network.kind, "compose"),
        eq(network.environmentId, params.environmentId),
      ),
    );

  for (const row of existing) {
    const options = isOptionsRecord(row.options) ? row.options : {};
    if (options.composeKey === params.composeKey) {
      const hostName = typeof options.dockerNetworkName === "string"
        ? options.dockerNetworkName
        : composeNetworkHostName(row.id);
      return { id: row.id, hostName };
    }
  }

  const [row] = await db
    .insert(network)
    .values({
      organizationId: params.organizationId,
      kind: "compose",
      environmentId: params.environmentId,
      name: params.composeKey,
      options: { composeKey: params.composeKey },
    })
    .returning({ id: network.id });
  if (!row) throw new Error("compose network insert failed");

  const hostName = composeNetworkHostName(row.id);
  await db
    .update(network)
    .set({
      options: { composeKey: params.composeKey, dockerNetworkName: hostName },
      updatedAt: nowIso(),
    })
    .where(eq(network.id, row.id));
  return { id: row.id, hostName };
}

async function loadManagedNetworkRow(
  db: Db,
  organizationId: string,
): Promise<{ id: string; hostName: string } | null> {
  const [row] = await db
    .select({ id: network.id, options: network.options })
    .from(network)
    .where(
      and(
        eq(network.organizationId, organizationId),
        eq(network.kind, "managed"),
      ),
    )
    .limit(1);
  if (!row) return null;

  const options = isOptionsRecord(row.options) ? row.options : {};
  const pinned = options.dockerNetworkName;
  const hostName = typeof pinned === "string" && pinned.length > 0
    ? pinned
    : managedNetworkName(row.id);
  return { id: row.id, hostName };
}

/**
 * Platform-allocated org-wide managed-engine network. At most one row per
 * organization (`uniq_network_organization_managed`); the Docker network name
 * is the row's own bare UUID, stamped into `options.dockerNetworkName`.
 *
 * Never operator-created — `POST /networks` rejects `kind: 'managed'`.
 */
export async function ensureOrganizationManagedNetwork(
  db: Db,
  params: { organizationId: string },
): Promise<{ id: string; hostName: string }> {
  const existing = await loadManagedNetworkRow(db, params.organizationId);
  if (existing) return existing;

  const [row] = await db
    .insert(network)
    .values({
      organizationId: params.organizationId,
      kind: "managed",
    })
    .onConflictDoNothing()
    .returning({ id: network.id });

  if (!row) {
    // A concurrent caller won the partial unique index — converge on its row
    // instead of failing the allocation.
    const raced = await loadManagedNetworkRow(db, params.organizationId);
    if (!raced) throw new Error("managed network insert failed");
    return raced;
  }

  const hostName = managedNetworkName(row.id);
  await db
    .update(network)
    .set({
      options: { dockerNetworkName: hostName },
      updatedAt: nowIso(),
    })
    .where(eq(network.id, row.id));
  return { id: row.id, hostName };
}

function isOptionsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function ensureNetworkSubnet(
  db: Db,
  params: {
    networkId: string;
    serverId: string;
    cidr: string;
  },
): Promise<void> {
  await db
    .insert(subnet)
    .values({
      networkId: params.networkId,
      serverId: params.serverId,
      cidr: params.cidr,
    })
    .onConflictDoNothing({
      target: [subnet.networkId, subnet.serverId],
    });
}

export async function materializeSpanningNetworks(
  db: Db,
  params: {
    organizationId: string;
    environmentId: string;
    fabric: FabricRecord;
    document: ComposeDocument;
    slots: ReadonlyArray<{ serviceId: string; serverId: string }>;
    serviceRows: ReadonlyArray<{ id: string; composeServiceName: string }>;
    platformAttachments?: readonly PlatformAttachment[];
  },
): Promise<Map<string, string>> {
  const attachments = params.platformAttachments ?? [];
  const keys = collectSpanningComposeNetworkKeys(
    params.document,
    params.slots,
    params.serviceRows,
    attachments,
  );
  const spanning = new Map<string, string>();
  if (keys.length === 0) return spanning;

  await ensureFabricRelays(db, {
    fabric: params.fabric,
    organizationId: params.organizationId,
  });
  const relays = await listFabricRelays(db, params.fabric.id);
  const relayByServer = new Map(relays.map((row) => [row.serverId, row]));
  const exclusions = await loadCidrAllocationExclusions(
    db,
    params.organizationId,
  );

  for (const composeKey of keys) {
    const networkRow = await ensureComposeNetworkRow(db, {
      organizationId: params.organizationId,
      environmentId: params.environmentId,
      composeKey,
    });
    spanning.set(composeKey, networkRow.hostName);

    const serverIds = participatingServerIdsForNetwork(
      params.document,
      params.slots,
      params.serviceRows,
      composeKey,
      attachments,
    );
    for (const serverId of serverIds) {
      const relayRow = relayByServer.get(serverId);
      if (!relayRow) {
        throw new FabricAllocationError("relay_missing");
      }
      const [have] = await db
        .select({ id: subnet.id })
        .from(subnet)
        .where(
          and(
            eq(subnet.networkId, networkRow.id),
            eq(subnet.serverId, serverId),
          ),
        )
        .limit(1);
      if (have) continue;
      const existing = await db
        .select({ cidr: subnet.cidr })
        .from(subnet)
        .where(eq(subnet.serverId, serverId));
      const taken = existing.map((row) =>
        typeof row.cidr === "string" ? row.cidr : String(row.cidr)
      );
      const cidrValue = requireSubnetCidr(relayRow.prefix, taken, exclusions);
      await ensureNetworkSubnet(db, {
        networkId: networkRow.id,
        serverId,
        cidr: cidrValue,
      });
    }
  }
  return spanning;
}

export function nthSubnetCidr(
  relayPrefix: string,
  index: number,
): string | null {
  return nthSubnet(relayPrefix, 24, index);
}
