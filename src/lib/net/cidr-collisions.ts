/**
 * One collision authority for every CIDR the control plane writes or
 * allocates on behalf of an organization.
 *
 * Every operator-facing CIDR write (`POST`/`PATCH /networks`,
 * `POST /datacenters`, `POST /datacenters/:id/subnets`, the auto-derive path
 * of `POST /datacenters/:id/members`) calls {@link assertCidrAvailable} /
 * {@link assertCidrsAvailable} before touching the `network` table, and the
 * fabric allocators (`requireRelayPrefix`, `requireSubnetCidr`,
 * `pickDefaultFabricHostCidr`) take their exclusion list from
 * {@link loadCidrAllocationExclusions} so a relay `/16` or a `tpn_*` `/24`
 * never lands inside a range an operator declared off-limits.
 *
 * Every pair below is a **hard fail** with its own code:
 *
 * | candidate vs                                                     | code                              |
 * | ---------------------------------------------------------------- | --------------------------------- |
 * | org TurboFabric host range (`fabric.cidr`, `tp0`)                | `cidr_overlaps_fabric`            |
 * | fabric container pool (`fabric.options.containerPool`)           | `cidr_overlaps_fabric_pool`       |
 * | another site subnet in the same datacenter                       | `subnet_overlaps`                 |
 * | a site subnet in another datacenter, both with a gateway relay   | `cidr_overlaps_gateway_advertised`|
 * | a `kind='reserved'` row                                          | `cidr_overlaps_reserved`          |
 * | a `kind='docker'` / `kind='managed'` row carrying a CIDR         | `cidr_overlaps_docker_network`    |
 * | an org Docker address pool or the default bridge network         | `cidr_overlaps_docker_network`    |
 * |   (`organization.options.docker`, `dockerHostCidrs`)             |                                   |
 *
 * The org-wide `subnet_overlaps` behaviour is kept as the default for every
 * site-subnet overlap; `cidr_overlaps_gateway_advertised` is the more specific
 * explanation for the case that actually breaks WireGuard `AllowedIPs` — two
 * gateways in different datacenters pushing overlapping prefixes into the
 * same peer config. Gateway advertisements are resolved through
 * `resolveDerivedAdvertisedCidrsByRelay` (the same function the reconcile
 * payload uses), so IPv6 subnets and operator overrides behave exactly as they
 * do on the wire.
 *
 * Overlap math is family-aware (`cidrsOverlap` in `../ip-address.ts`): an IPv6
 * candidate never collides with an IPv4 range and vice versa.
 */

import { and, eq, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { fabric, network, organization, relay } from '../db/schema.ts'
import { dockerHostCidrs } from '../docker-address-pools.ts'
import { parseFabricOptions } from '../fabric/cidr.ts'
import { cidrsOverlap } from '../ip-address.ts'
import { parseOrganizationOptions } from '../organization-options.ts'
import { loadDatacenterMembershipsForServers } from './datacenter-membership.ts'
import {
  loadDatacenterSubnetsForServers,
  resolveDerivedAdvertisedCidrsByRelay,
} from './datacenter-networks.ts'

export type CidrCollisionCode =
  | 'cidr_overlaps_fabric'
  | 'cidr_overlaps_fabric_pool'
  | 'subnet_overlaps'
  | 'cidr_overlaps_gateway_advertised'
  | 'cidr_overlaps_reserved'
  | 'cidr_overlaps_docker_network'

/** What the caller is about to write the candidate CIDR as. */
export type CidrWriteIntent = 'datacenter' | 'reserved' | 'docker'

export type CidrCollision = {
  code: CidrCollisionCode
  /** The candidate CIDR that was refused. */
  cidr: string
  /** The existing range the candidate overlaps. */
  conflictingCidr: string
  /** `network.id` of the conflicting registry row, when there is one. */
  networkId: string | null
  /** Owning datacenter of the conflicting site subnet, when it is one. */
  datacenterId: string | null
}

export type CidrCollisionParams = {
  cidr: string
  intent: CidrWriteIntent
  /** Datacenter the candidate site subnet will belong to (site intent only). */
  datacenterId?: string | null
  /** Row being re-ranged (`PATCH`) — never collides with itself. */
  excludeNetworkId?: string | null
  /**
   * Skip the org Docker host addressing (address pools and the default
   * bridge network) — the `PUT` that *replaces* it validates each new range
   * against everything else, never against the config it is about to
   * overwrite. The submitted bridge-vs-pools pair is the route's own check
   * (`findDockerBridgePoolOverlap`).
   */
  excludeDockerHostCidrs?: boolean
}

export type AssertCidrAvailableParams = CidrCollisionParams & {
  organizationId: string
}

export type AssertCidrsAvailableParams = Omit<CidrCollisionParams, 'cidr'> & {
  organizationId: string
  cidrs: readonly string[]
}

export type RegisteredCidr = {
  networkId: string
  kind: string
  cidr: string
  datacenterId: string | null
}

export type GatewayAdvertisement = {
  relayId: string
  serverId: string
  /** Datacenters this gateway's server is pinned into. */
  datacenterIds: readonly string[]
  /** CIDRs this gateway pushes into peer `AllowedIPs` (resolved, IPv4 only unless overridden). */
  advertisedCidrs: readonly string[]
}

/**
 * Everything the authority compares a candidate against, loaded once per
 * request so batch callers (`POST /datacenters` with several derived subnets)
 * pay for the queries a single time.
 */
export type OrganizationCidrRegistry = {
  fabricCidr: string | null
  containerPool: string | null
  /**
   * Org Docker host addressing (`organization.options.docker`): the
   * `default-address-pools` bases plus the network `bip` puts docker0 on.
   * dockerd carves unaddressed bridge networks out of the pools and owns the
   * bridge range on every host, so they collide the same way a registered
   * docker network does.
   */
  dockerHostCidrs: readonly string[]
  networks: readonly RegisteredCidr[]
  gateways: readonly GatewayAdvertisement[]
}

/** Map a `network.kind` onto the write intent the authority understands. */
export function cidrWriteIntentForKind(kind: string): CidrWriteIntent {
  if (kind === 'datacenter') return 'datacenter'
  if (kind === 'reserved') return 'reserved'
  return 'docker'
}

function cidrString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function advertisedCidrsFromJson(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string =>
    typeof item === 'string' && item.length > 0
  )
}

async function loadRegisteredCidrs(
  db: Db,
  organizationId: string,
): Promise<RegisteredCidr[]> {
  const rows = await db
    .select({
      id: network.id,
      kind: network.kind,
      cidr: network.cidr,
      datacenterId: network.datacenterId,
    })
    .from(network)
    .where(
      and(
        eq(network.organizationId, organizationId),
        isNotNull(network.cidr),
      ),
    )
  const out: RegisteredCidr[] = []
  for (const row of rows) {
    const cidr = cidrString(row.cidr)
    if (!cidr || typeof row.kind !== 'string') continue
    out.push({
      networkId: typeof row.id === 'string' ? row.id : String(row.id),
      kind: row.kind,
      cidr,
      datacenterId: typeof row.datacenterId === 'string' ? row.datacenterId : null,
    })
  }
  return out
}

async function loadGatewayAdvertisements(
  db: Db,
  fabricId: string,
): Promise<GatewayAdvertisement[]> {
  const gatewayRows = await db
    .select({
      id: relay.id,
      serverId: relay.serverId,
      role: relay.role,
      advertisedCidrs: relay.advertisedCidrs,
    })
    .from(relay)
    .where(and(eq(relay.fabricId, fabricId), eq(relay.role, 'gateway')))
  const gateways = gatewayRows
    .filter((row) => row.role === 'gateway')
    .map((row) => ({
      id: typeof row.id === 'string' ? row.id : String(row.id),
      serverId: row.serverId,
      role: 'gateway',
      advertisedCidrs: advertisedCidrsFromJson(row.advertisedCidrs),
    }))
  if (gateways.length === 0) return []

  const serverIds = [...new Set(gateways.map((row) => row.serverId))]
  const [memberships, subnetsByServer] = await Promise.all([
    loadDatacenterMembershipsForServers(db, serverIds),
    loadDatacenterSubnetsForServers(db, serverIds),
  ])
  const advertised = resolveDerivedAdvertisedCidrsByRelay(
    gateways,
    subnetsByServer,
  )

  return gateways.map((gateway) => ({
    relayId: gateway.id,
    serverId: gateway.serverId,
    datacenterIds: [
      ...new Set(
        (memberships.get(gateway.serverId) ?? []).map((pin) => pin.datacenterId),
      ),
    ],
    advertisedCidrs: advertised.get(gateway.id) ?? [],
  }))
}

async function loadDockerHostCidrs(
  db: Db,
  organizationId: string,
): Promise<string[]> {
  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  if (!orgRow) return []
  return dockerHostCidrs(parseOrganizationOptions(orgRow.options).docker)
}

/**
 * Load the org's fabric ranges, Docker host addressing (pools + bridge),
 * every CIDR-bearing `network` row and the resolved gateway advertisements
 * in one pass.
 */
export async function loadOrganizationCidrRegistry(
  db: Db,
  organizationId: string,
): Promise<OrganizationCidrRegistry> {
  const [fabricRow] = await db
    .select({
      id: fabric.id,
      cidr: fabric.cidr,
      options: fabric.options,
    })
    .from(fabric)
    .where(eq(fabric.organizationId, organizationId))
    .limit(1)

  const networks = await loadRegisteredCidrs(db, organizationId)
  const dockerHostCidrs = await loadDockerHostCidrs(db, organizationId)

  if (!fabricRow) {
    return {
      fabricCidr: null,
      containerPool: null,
      dockerHostCidrs,
      networks,
      gateways: [],
    }
  }

  const fabricId = typeof fabricRow.id === 'string'
    ? fabricRow.id
    : String(fabricRow.id)
  const gateways = await loadGatewayAdvertisements(db, fabricId)
  return {
    fabricCidr: cidrString(fabricRow.cidr),
    containerPool: parseFabricOptions(fabricRow.options).containerPool,
    dockerHostCidrs,
    networks,
    gateways,
  }
}

function collision(
  code: CidrCollisionCode,
  cidr: string,
  conflictingCidr: string,
  row?: { networkId: string | null; datacenterId: string | null } | null,
): CidrCollision {
  return {
    code,
    cidr,
    conflictingCidr,
    networkId: row?.networkId ?? null,
    datacenterId: row?.datacenterId ?? null,
  }
}

function isDockerLike(kind: string): boolean {
  return kind === 'docker' || kind === 'managed'
}

/** First registered row of a matching kind whose CIDR overlaps the candidate. */
function findRowCollision(
  rows: readonly RegisteredCidr[],
  candidate: string,
  matchesKind: (kind: string) => boolean,
  code: CidrCollisionCode,
): CidrCollision | null {
  const row = rows.find((entry) =>
    matchesKind(entry.kind) && cidrsOverlap(candidate, entry.cidr)
  )
  return row ? collision(code, candidate, row.cidr, row) : null
}

/** Org Docker host addressing (pools + default bridge) overlapping the candidate. */
function findDockerHostCollision(
  registry: OrganizationCidrRegistry,
  candidate: string,
): CidrCollision | null {
  const hostCidr = registry.dockerHostCidrs.find((cidr) =>
    cidrsOverlap(candidate, cidr)
  )
  return hostCidr
    ? collision('cidr_overlaps_docker_network', candidate, hostCidr)
    : null
}

function findGatewayAdvertisedCollision(
  registry: OrganizationCidrRegistry,
  params: CidrCollisionParams,
): CidrCollision | null {
  if (params.intent !== 'datacenter' || !params.datacenterId) return null
  const candidateDc = params.datacenterId
  const candidateHasGateway = registry.gateways.some((gateway) =>
    gateway.datacenterIds.includes(candidateDc)
  )
  if (!candidateHasGateway) return null

  for (const gateway of registry.gateways) {
    // A gateway pinned into the candidate datacenter advertises the candidate
    // itself — only *other* datacenters' gateways can conflict in AllowedIPs.
    if (gateway.datacenterIds.includes(candidateDc)) continue
    for (const advertised of gateway.advertisedCidrs) {
      if (!cidrsOverlap(params.cidr, advertised)) continue
      const row = registry.networks.find((entry) =>
        entry.kind === 'datacenter' && entry.cidr === advertised
      ) ?? null
      if (row && row.networkId === params.excludeNetworkId) continue
      return collision(
        'cidr_overlaps_gateway_advertised',
        params.cidr,
        advertised,
        row ?? { networkId: null, datacenterId: gateway.datacenterIds[0] ?? null },
      )
    }
  }
  return null
}

/**
 * Pure comparison of one candidate against an already-loaded registry.
 * Returns the first collision in precedence order (fabric → pool → reserved →
 * docker rows → docker host addressing → gateway-advertised → site subnet) or
 * `null` when the range is free.
 */
export function findCidrCollision(
  registry: OrganizationCidrRegistry,
  params: CidrCollisionParams,
): CidrCollision | null {
  const candidate = params.cidr
  const exclude = params.excludeNetworkId ?? null

  if (registry.fabricCidr && cidrsOverlap(candidate, registry.fabricCidr)) {
    return collision('cidr_overlaps_fabric', candidate, registry.fabricCidr)
  }
  if (registry.containerPool && cidrsOverlap(candidate, registry.containerPool)) {
    return collision('cidr_overlaps_fabric_pool', candidate, registry.containerPool)
  }

  const rows = registry.networks.filter((row) => row.networkId !== exclude)

  // Org Docker host addressing sits in the same rung as docker rows: dockerd
  // carves every unaddressed bridge out of the pools and owns the default
  // bridge range, so they are docker networks that just have not been
  // created yet.
  return (
    findRowCollision(rows, candidate, (kind) => kind === 'reserved', 'cidr_overlaps_reserved') ??
    findRowCollision(rows, candidate, isDockerLike, 'cidr_overlaps_docker_network') ??
    (params.excludeDockerHostCidrs ? null : findDockerHostCollision(registry, candidate)) ??
    findGatewayAdvertisedCollision(registry, params) ??
    findRowCollision(rows, candidate, (kind) => kind === 'datacenter', 'subnet_overlaps')
  )
}

/**
 * Assert one candidate CIDR may be written for the organization. Resolves to
 * `null` when free, otherwise the typed collision (never throws for a
 * collision — callers map it onto their own 409).
 */
export async function assertCidrAvailable(
  db: Db,
  params: AssertCidrAvailableParams,
): Promise<CidrCollision | null> {
  const registry = await loadOrganizationCidrRegistry(db, params.organizationId)
  return findCidrCollision(registry, params)
}

/**
 * Batch form for requests that derive several CIDRs at once. Candidates are
 * also checked against each other (two auto-derived site subnets in one
 * `POST /datacenters` body must not overlap) — that pair reports
 * `subnet_overlaps`, matching the org-wide default.
 */
export async function assertCidrsAvailable(
  db: Db,
  params: AssertCidrsAvailableParams,
): Promise<CidrCollision | null> {
  const unique = [...new Set(params.cidrs)]
  if (unique.length === 0) return null

  for (let i = 0; i < unique.length; i++) {
    const left = unique[i]
    if (!left) continue
    for (let j = i + 1; j < unique.length; j++) {
      const right = unique[j]
      if (right && cidrsOverlap(left, right)) {
        return collision('subnet_overlaps', right, left)
      }
    }
  }

  const registry = await loadOrganizationCidrRegistry(db, params.organizationId)
  for (const cidr of unique) {
    const hit = findCidrCollision(registry, {
      cidr,
      intent: params.intent,
      datacenterId: params.datacenterId,
      excludeNetworkId: params.excludeNetworkId,
      excludeDockerHostCidrs: params.excludeDockerHostCidrs,
    })
    if (hit) return hit
  }
  return null
}

/**
 * Ranges the fabric allocators must never carve a prefix or segment out of:
 * every CIDR-bearing `network` row in the organization (site subnets,
 * reserved ranges, docker registrations), the fabric host range itself and
 * the org Docker host addressing (address pools and the default bridge
 * network). Relay prefixes and `subnet` segments are the allocators' own
 * `taken` lists and are deliberately not part of this set.
 */
export async function loadCidrAllocationExclusions(
  db: Db,
  organizationId: string,
): Promise<string[]> {
  const [networks, fabrics, dockerHostCidrs] = await Promise.all([
    db
      .select({ cidr: network.cidr })
      .from(network)
      .where(
        and(
          eq(network.organizationId, organizationId),
          isNotNull(network.cidr),
        ),
      ),
    db
      .select({ cidr: fabric.cidr })
      .from(fabric)
      .where(eq(fabric.organizationId, organizationId)),
    loadDockerHostCidrs(db, organizationId),
  ])
  const out: string[] = []
  const seen = new Set<string>()
  const push = (value: unknown) => {
    const cidr = cidrString(value)
    if (!cidr || seen.has(cidr)) return
    seen.add(cidr)
    out.push(cidr)
  }
  for (const row of networks) push(row.cidr)
  for (const row of fabrics) push(row.cidr)
  for (const hostCidr of dockerHostCidrs) push(hostCidr)
  return out
}
