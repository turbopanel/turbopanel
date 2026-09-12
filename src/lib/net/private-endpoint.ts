import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db.ts'
import { fabric, ip, relay } from '../db/schema.ts'
import { inetAddressToString } from '../ip-address.ts'
import {
  defaultDatacenterPolicyRow,
  loadDatacenterPolicies,
  type DatacenterAddressPreference,
  type DatacenterPolicyRow,
} from './datacenter-networks.ts'
import {
  loadDatacenterMembershipsForServers,
  sharedDatacenterIds,
  type DatacenterMembershipRow,
} from './datacenter-membership.ts'

export type PrivateEndpointPurpose =
  | 'failover-replication'
  | 'read-replication'
  | 'client-backend'

export type PrivateEndpointTransport = 'local' | 'datacenter' | 'fabric' | 'public'

export type ResolvedPrivateEndpoint = {
  address: string
  transport: PrivateEndpointTransport
  /** Present when transport is `datacenter`. */
  datacenterId?: string
  /** Present when transport is `fabric`. */
  fabricId?: string
}

export type PrivateEndpointError =
  | { kind: 'datacenter_ip_required'; serverId: string }
  | {
    kind: 'private_path_unavailable'
    fromServerId: string
    toServerId: string
  }
  | {
    kind: 'private_family_mismatch'
    fromServerId: string
    toServerId: string
    datacenterId: string
  }
  | {
    /**
     * The only datacenters the pair shares are `trusted: false`. Failover
     * replication never rides an untrusted L2, and it never falls through to
     * fabric/public either. `datacenterId` is the first untrusted shared
     * datacenter (priority order) for operator messaging.
     */
    kind: 'failover_requires_trusted_datacenter'
    fromServerId: string
    toServerId: string
    datacenterId: string
  }

export function isPrivateEndpointError(
  value: unknown,
): value is PrivateEndpointError {
  return typeof value === 'object' && value !== null && 'kind' in value
}

/**
 * Map a prepare error to a 422 JSON body with `{ error: kind }` only — never
 * leak id fields on the wire (mirrors managed `prepareErrorResponse`).
 */
export function privateEndpointErrorResponse(
  c: Context,
  error: PrivateEndpointError,
): Response {
  return c.json({ error: error.kind }, 422)
}

/** One membership pin address for a server (oldest first) — any datacenter. */
export async function loadServerDatacenterAddress(
  db: Db,
  serverId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ address: ip.address })
    .from(ip)
    .where(
      and(
        eq(ip.serverId, serverId),
        eq(ip.scope, 'datacenter'),
        isNotNull(ip.datacenterId),
      ),
    )
    .orderBy(asc(ip.createdAt))
    .limit(1)
  return inetAddressToString(row?.address) ?? null
}

/**
 * This server's own TurboFabric (`tp0`) address, from its relay row.
 *
 * A server may be enrolled in more than one fabric; the oldest fabric wins,
 * matching how {@link resolvePrivateEndpoints} orders relay candidates. Returns
 * `null` when the server is not enrolled, which callers must treat as "the
 * fabric path is unavailable" rather than falling back to a wider address.
 */
export async function loadServerFabricAddress(
  db: Db,
  serverId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ address: relay.address })
    .from(relay)
    .innerJoin(fabric, eq(relay.fabricId, fabric.id))
    .where(eq(relay.serverId, serverId))
    .orderBy(asc(fabric.createdAt))
    .limit(1)
  if (row === undefined) return null
  return inetAddressToString(row.address) ??
    (typeof row.address === 'string' ? row.address : null)
}

/**
 * Newest/oldest `ip.scope='public'` address for a server (oldest first).
 *
 * Future: when no public `ip` row exists, a later phase may fall back to
 * daemon-reported public addresses from hello/heartbeat.
 */
export async function loadServerPublicAddress(
  db: Db,
  serverId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ address: ip.address })
    .from(ip)
    .where(
      and(
        eq(ip.serverId, serverId),
        eq(ip.scope, 'public'),
      ),
    )
    .orderBy(asc(ip.createdAt))
    .limit(1)
  return inetAddressToString(row?.address) ?? null
}

/**
 * Oldest `ip.scope='public'` address per server (one `inArray` select).
 *
 * Future: when no public `ip` row exists, a later phase may fall back to
 * daemon-reported public addresses from hello/heartbeat.
 */
export async function loadPublicAddressesForServers(
  db: Db,
  serverIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (serverIds.length === 0) return out

  const rows = await db
    .select({
      serverId: ip.serverId,
      address: ip.address,
    })
    .from(ip)
    .where(
      and(
        eq(ip.scope, 'public'),
        isNotNull(ip.serverId),
        inArray(ip.serverId, serverIds),
      ),
    )
    .orderBy(asc(ip.createdAt))

  for (const row of rows) {
    if (!row.serverId || out.has(row.serverId)) continue
    const address = inetAddressToString(row.address)
    if (address) out.set(row.serverId, address)
  }
  return out
}

type RelayJoinRow = {
  relayId: string
  serverId: string
  fabricId: string
  fabricCreatedAt: string
  address: string
}

/**
 * Relays on fabrics that include at least one of the listed servers.
 * The peer address is `relay.address` (no `ip` join).
 */
async function loadFabricRelayRows(
  db: Db,
  serverIds: string[],
): Promise<RelayJoinRow[]> {
  if (serverIds.length === 0) return []

  const membership = await db
    .select({ fabricId: relay.fabricId })
    .from(relay)
    .where(inArray(relay.serverId, serverIds))

  const fabricIds = [...new Set(membership.map((row) => row.fabricId))]
  if (fabricIds.length === 0) return []

  const rows = await db
    .select({
      relayId: relay.id,
      serverId: relay.serverId,
      fabricId: relay.fabricId,
      fabricCreatedAt: fabric.createdAt,
      address: relay.address,
    })
    .from(relay)
    .innerJoin(fabric, eq(relay.fabricId, fabric.id))
    .where(inArray(relay.fabricId, fabricIds))
    .orderBy(asc(fabric.createdAt))

  const out: RelayJoinRow[] = []
  for (const row of rows) {
    const address = inetAddressToString(row.address) ??
      (typeof row.address === 'string' ? row.address : String(row.address))
    if (!address) continue
    out.push({
      relayId: row.relayId,
      serverId: row.serverId,
      fabricId: row.fabricId,
      fabricCreatedAt: row.fabricCreatedAt,
      address,
    })
  }
  return out
}

/**
 * Address families present for a server in one datacenter.
 * Shared with TurboFabric path planning (`planRelayPath`).
 */
export function familiesInDatacenter(
  pins: readonly DatacenterMembershipRow[],
  datacenterId: string,
): Set<4 | 6> {
  const families = new Set<4 | 6>()
  for (const pin of pins) {
    if (pin.datacenterId === datacenterId) families.add(pin.family)
  }
  return families
}

/**
 * Datacenter address-family preference order (RFC 6724 default IPv6-first).
 * Shared with TurboFabric path planning (`planRelayPath`).
 */
export function preferredFamilyOrder(
  preference: DatacenterAddressPreference,
): Array<4 | 6> {
  if (preference === 'ipv4') return [4, 6]
  return [6, 4]
}

/**
 * Family-intersected pin address for `toPins` in a shared datacenter.
 * Shared with TurboFabric path planning (`planRelayPath`).
 */
export function pinAddressForDatacenter(
  fromPins: readonly DatacenterMembershipRow[],
  toPins: readonly DatacenterMembershipRow[],
  datacenterId: string,
  preference: DatacenterAddressPreference,
): string | null {
  const fromFamilies = familiesInDatacenter(fromPins, datacenterId)
  const toFamilies = familiesInDatacenter(toPins, datacenterId)
  const intersection = new Set<4 | 6>()
  for (const family of fromFamilies) {
    if (toFamilies.has(family)) intersection.add(family)
  }
  for (const family of preferredFamilyOrder(preference)) {
    if (!intersection.has(family)) continue
    const address = toPins.find(
      (row) => row.datacenterId === datacenterId && row.family === family,
    )?.address
    if (address) return address
  }
  return null
}

export type SharedDatacenterPartition = {
  /** `trusted: true` shared datacenters, sorted `(priority asc, id asc)`. */
  trusted: string[]
  /** `trusted: false` shared datacenters, sorted `(priority asc, id asc)`. */
  untrusted: string[]
}

function policyFor(
  policiesByDatacenter: ReadonlyMap<string, DatacenterPolicyRow>,
  datacenterId: string,
): DatacenterPolicyRow {
  return policiesByDatacenter.get(datacenterId) ?? defaultDatacenterPolicyRow()
}

/**
 * Split the datacenters two servers share into trusted / untrusted lists,
 * each ordered by `(priority asc, datacenterId asc)`. The id tiebreak keeps
 * the order deterministic when two datacenters carry the same priority.
 * Absent policy entries fall back to the documented defaults
 * (`priority` 100, `trusted` true, `addressPreference` ipv6).
 *
 * Shared with TurboFabric path planning (`planRelayPath`) so the managed
 * ladder and WireGuard endpoint selection can never disagree on which LAN
 * segment a pair may use.
 */
export function partitionSharedDatacenters(
  fromPins: readonly DatacenterMembershipRow[],
  toPins: readonly DatacenterMembershipRow[],
  policiesByDatacenter: ReadonlyMap<string, DatacenterPolicyRow>,
): SharedDatacenterPartition {
  const shared = sharedDatacenterIds(fromPins, toPins)
  const compare = (a: string, b: string): number => {
    const diff = policyFor(policiesByDatacenter, a).priority -
      policyFor(policiesByDatacenter, b).priority
    if (diff !== 0) return diff
    return a.localeCompare(b)
  }
  const trusted: string[] = []
  const untrusted: string[] = []
  for (const datacenterId of shared) {
    if (policyFor(policiesByDatacenter, datacenterId).trusted) {
      trusted.push(datacenterId)
    } else {
      untrusted.push(datacenterId)
    }
  }
  trusted.sort(compare)
  untrusted.sort(compare)
  return { trusted, untrusted }
}

function unavailablePath(
  fromServerId: string,
  toServerId: string,
): PrivateEndpointError {
  return {
    kind: 'private_path_unavailable',
    fromServerId,
    toServerId,
  }
}

/**
 * Datacenter rung of the ladder: walk only the **trusted** shared datacenters
 * in priority order and return the first family-compatible pin address. A
 * trusted shared datacenter with no common family still reports
 * `private_family_mismatch` (before any fall-through). Untrusted datacenters
 * are never inspected, so they can neither win nor raise a mismatch.
 */
function resolveDatacenterFromCaches(params: {
  fromServerId: string
  toServerId: string
  fromPins: readonly DatacenterMembershipRow[]
  toPins: readonly DatacenterMembershipRow[]
  partition: SharedDatacenterPartition
  policiesByDatacenter: ReadonlyMap<string, DatacenterPolicyRow>
}): ResolvedPrivateEndpoint | PrivateEndpointError | null {
  const { fromPins, toPins } = params
  let mismatchDatacenterId: string | undefined
  for (const sharedDc of params.partition.trusted) {
    const address = pinAddressForDatacenter(
      fromPins,
      toPins,
      sharedDc,
      policyFor(params.policiesByDatacenter, sharedDc).addressPreference,
    )
    if (address) {
      return {
        address,
        transport: 'datacenter',
        datacenterId: sharedDc,
      }
    }
    mismatchDatacenterId ??= sharedDc
  }
  if (mismatchDatacenterId) {
    return {
      kind: 'private_family_mismatch',
      fromServerId: params.fromServerId,
      toServerId: params.toServerId,
      datacenterId: mismatchDatacenterId,
    }
  }
  return null
}

function resolveFabricFromCaches(params: {
  fromServerId: string
  toServerId: string
  relays: RelayJoinRow[]
}): ResolvedPrivateEndpoint | null {
  const fromFabricIds = new Set(
    params.relays
      .filter((row) => row.serverId === params.fromServerId)
      .map((row) => row.fabricId),
  )
  const sharedOnTo = params.relays
    .filter(
      (row) =>
        row.serverId === params.toServerId && fromFabricIds.has(row.fabricId),
    )
    .sort((a, b) => a.fabricCreatedAt.localeCompare(b.fabricCreatedAt))

  const chosen = sharedOnTo[0]
  if (!chosen) return null
  return {
    address: chosen.address,
    transport: 'fabric',
    fabricId: chosen.fabricId,
  }
}

/**
 * Purpose-aware ladder. Same-host loopback is always first. Cross-host order
 * is inverted from the former fabric-first path: datacenter (LAN) before
 * fabric, then public.
 *
 * The datacenter rung is **trust-gated and priority-ordered**: only shared
 * datacenters with `trusted: true` are candidates, walked in
 * `(priority asc, id asc)` order (see {@link partitionSharedDatacenters}).
 * Untrusted shared datacenters are skipped for every purpose.
 *
 * - `failover-replication`: `local` → `datacenter` only (never fabric/public).
 *   When the pair shares only untrusted datacenters the error is
 *   `failover_requires_trusted_datacenter`; with no shared datacenter at all
 *   it stays `private_path_unavailable`.
 * - `read-replication` / `client-backend`: `local` → `datacenter` → `fabric`
 *   → `public`.
 *
 * A trusted shared-datacenter family mismatch is returned before fabric/public
 * for every purpose.
 */
function resolveOneFromCaches(params: {
  fromServerId: string
  toServerId: string
  purpose: PrivateEndpointPurpose
  membershipsByServer: Map<string, DatacenterMembershipRow[]>
  relays: RelayJoinRow[]
  policiesByDatacenter: ReadonlyMap<string, DatacenterPolicyRow>
  publicAddressesByServer: Map<string, string>
}): ResolvedPrivateEndpoint | PrivateEndpointError {
  if (params.fromServerId === params.toServerId) {
    return { address: '127.0.0.1', transport: 'local' }
  }

  const fromPins = params.membershipsByServer.get(params.fromServerId) ?? []
  const toPins = params.membershipsByServer.get(params.toServerId) ?? []
  const partition = partitionSharedDatacenters(
    fromPins,
    toPins,
    params.policiesByDatacenter,
  )
  const datacenter = resolveDatacenterFromCaches({
    fromServerId: params.fromServerId,
    toServerId: params.toServerId,
    fromPins,
    toPins,
    partition,
    policiesByDatacenter: params.policiesByDatacenter,
  })
  if (datacenter) return datacenter

  if (params.purpose === 'failover-replication') {
    const untrustedDatacenterId = partition.untrusted[0]
    if (untrustedDatacenterId !== undefined) {
      return {
        kind: 'failover_requires_trusted_datacenter',
        fromServerId: params.fromServerId,
        toServerId: params.toServerId,
        datacenterId: untrustedDatacenterId,
      }
    }
    return unavailablePath(params.fromServerId, params.toServerId)
  }

  const fabricPath = resolveFabricFromCaches(params)
  if (fabricPath) return fabricPath

  const publicAddress = params.publicAddressesByServer.get(params.toServerId)
  if (publicAddress) {
    return { address: publicAddress, transport: 'public' }
  }

  return unavailablePath(params.fromServerId, params.toServerId)
}

/**
 * Answer "what address does `fromServerId` use to reach `toServerId`?" using
 * the purpose-aware ladder (see {@link resolveOneFromCaches}).
 */
export async function resolvePrivateEndpoint(
  db: Db,
  params: Readonly<{
    fromServerId: string
    toServerId: string
    purpose: PrivateEndpointPurpose
  }>,
): Promise<ResolvedPrivateEndpoint | PrivateEndpointError> {
  const results = await resolvePrivateEndpoints(db, {
    fromServerId: params.fromServerId,
    toServerIds: [params.toServerId],
    purpose: params.purpose,
  })
  const value = results.get(params.toServerId)
  if (!value) {
    return unavailablePath(params.fromServerId, params.toServerId)
  }
  return value
}

/**
 * Batched resolver for one source server → many targets (one membership query,
 * one relay join, one public-address query — no N+1). Relays and public
 * addresses are always loaded; failover-replication simply ignores them.
 */
export async function resolvePrivateEndpoints(
  db: Db,
  params: Readonly<{
    fromServerId: string
    toServerIds: readonly string[]
    purpose: PrivateEndpointPurpose
  }>,
): Promise<Map<string, ResolvedPrivateEndpoint | PrivateEndpointError>> {
  const out = new Map<string, ResolvedPrivateEndpoint | PrivateEndpointError>()
  if (params.toServerIds.length === 0) return out

  const uniqueTargets = [...new Set(params.toServerIds)]
  const allServerIds = [...new Set([params.fromServerId, ...uniqueTargets])]

  const [membershipsByServer, relays, publicAddressesByServer] = await Promise.all([
    loadDatacenterMembershipsForServers(db, allServerIds),
    loadFabricRelayRows(db, allServerIds),
    loadPublicAddressesForServers(db, allServerIds),
  ])

  const datacenterIds = new Set<string>()
  for (const pins of membershipsByServer.values()) {
    for (const pin of pins) datacenterIds.add(pin.datacenterId)
  }
  const policiesByDatacenter = await loadDatacenterPolicies(
    db,
    [...datacenterIds],
  )

  for (const toServerId of uniqueTargets) {
    out.set(
      toServerId,
      resolveOneFromCaches({
        fromServerId: params.fromServerId,
        toServerId,
        purpose: params.purpose,
        membershipsByServer,
        relays,
        policiesByDatacenter,
        publicAddressesByServer,
      }),
    )
  }
  return out
}
