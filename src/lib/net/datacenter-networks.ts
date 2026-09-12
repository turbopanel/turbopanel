import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  DEFAULT_DATACENTER_PRIORITY,
  DEFAULT_DATACENTER_TRUSTED,
  parseDatacenterOptions,
  resolveDatacenterPolicy,
} from '../datacenter-options.ts'
import { datacenter, ip, network } from '../db/schema.ts'
import { cidrVersion } from '../ip-address.ts'
import { loadDatacenterMembershipsForServers } from './datacenter-membership.ts'

export type DatacenterCidrRequiredError = {
  kind: 'datacenter_cidr_required'
  datacenterId: string
}

export type ServerDatacenterReadyError =
  | { kind: 'datacenter_required'; serverId: string }
  | DatacenterCidrRequiredError

export type DatacenterSubnetRow = {
  networkId: string
  cidr: string
  version: 4 | 6
  name: string | null
}

export type DatacenterAddressPreference = 'ipv6' | 'ipv4'

/**
 * Load every CIDR-bearing `network(kind='datacenter')` subnet for the given
 * datacenter ids, grouped as `datacenterId → DatacenterSubnetRow[]`.
 * Family is derived from each CIDR (no extra query column).
 */
export async function loadDatacenterSubnets(
  db: Db,
  datacenterIds: string[],
): Promise<Map<string, DatacenterSubnetRow[]>> {
  const byDc = new Map<string, DatacenterSubnetRow[]>()
  if (datacenterIds.length === 0) return byDc

  const rows = await db
    .select({
      id: network.id,
      datacenterId: network.datacenterId,
      cidr: network.cidr,
      name: network.name,
    })
    .from(network)
    .where(
      and(
        eq(network.kind, 'datacenter'),
        isNotNull(network.cidr),
        inArray(network.datacenterId, datacenterIds),
      ),
    )

  for (const row of rows) {
    if (!row.datacenterId || !row.cidr) continue
    const version = cidrVersion(row.cidr)
    if (version === null) continue
    const list = byDc.get(row.datacenterId) ?? []
    list.push({
      networkId: typeof row.id === 'string' ? row.id : '',
      cidr: row.cidr,
      version,
      name: typeof row.name === 'string' ? row.name : null,
    })
    byDc.set(row.datacenterId, list)
  }
  return byDc
}

/**
 * Load every CIDR-bearing `network(kind='datacenter')` row for the given
 * datacenter ids, grouped as `datacenterId → cidr[]` (all subnets, not at most
 * one).
 */
export async function loadDatacenterCidrs(
  db: Db,
  datacenterIds: string[],
): Promise<Map<string, string[]>> {
  const byDc = new Map<string, string[]>()
  const subnetsByDc = await loadDatacenterSubnets(db, datacenterIds)
  for (const [datacenterId, subnets] of subnetsByDc) {
    byDc.set(datacenterId, subnets.map((row) => row.cidr))
  }
  return byDc
}

function uniqueDatacenterIds(
  pins: ReadonlyArray<{ datacenterId: string }>,
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const pin of pins) {
    if (seen.has(pin.datacenterId)) continue
    seen.add(pin.datacenterId)
    ids.push(pin.datacenterId)
  }
  return ids
}

/**
 * Load every CIDR-bearing site subnet for the datacenters the given servers
 * hold membership pins in, grouped as `serverId → DatacenterSubnetRow[]`.
 * Duplicate pins into the same datacenter collapse by `networkId`; rows are
 * sorted by `cidr`.
 */
export async function loadDatacenterSubnetsForServers(
  db: Db,
  serverIds: string[],
): Promise<Map<string, DatacenterSubnetRow[]>> {
  const byServer = new Map<string, DatacenterSubnetRow[]>()
  if (serverIds.length === 0) return byServer

  const memberships = await loadDatacenterMembershipsForServers(db, serverIds)
  const datacenterIds = uniqueDatacenterIds(
    [...memberships.values()].flat(),
  )
  const subnetsByDc = await loadDatacenterSubnets(db, datacenterIds)

  for (const [serverId, pins] of memberships) {
    const seenNetwork = new Set<string>()
    const list: DatacenterSubnetRow[] = []
    for (const pin of pins) {
      for (const subnet of subnetsByDc.get(pin.datacenterId) ?? []) {
        if (seenNetwork.has(subnet.networkId)) continue
        seenNetwork.add(subnet.networkId)
        list.push(subnet)
      }
    }
    list.sort((a, b) => a.cidr.localeCompare(b.cidr))
    byServer.set(serverId, list)
  }
  return byServer
}

export type DerivedAdvertisedRelay = {
  id: string
  serverId: string
  role: string
  advertisedCidrs: readonly string[]
}

function ipv4CidrsFromSubnets(
  subnets: readonly DatacenterSubnetRow[],
): string[] {
  const cidrs: string[] = []
  const seen = new Set<string>()
  for (const subnet of subnets) {
    if (subnet.version !== 4) continue
    if (seen.has(subnet.cidr)) continue
    seen.add(subnet.cidr)
    cidrs.push(subnet.cidr)
  }
  cidrs.sort((a, b) => a.localeCompare(b))
  return cidrs
}

/**
 * Resolve the advertised CIDR list each relay will actually push into peer
 * `allowedIPs`.
 *
 * IPv6 datacenter subnets are never auto-derived: the daemon's forwarding
 * chain is `iptables`-only (`TP-FORWARD` / `DOCKER-USER`), routed bridges use
 * `com.docker.network.bridge.gateway_mode_ipv4=routed`, and the sysctl drop-in
 * only sets `net.ipv4.ip_forward`. IPv6 remains available through an explicit
 * operator override.
 *
 * When two or more *deriving* gateways would advertise the same CIDR, assign
 * it only to the lexicographically-smallest `relay.id` (same convention as
 * `selectPairPresharedEnvelope`). Two peers advertising an identical prefix in
 * one `wg` config is an AllowedIPs conflict, so a co-sited second gateway must
 * not silently duplicate the range. Operator overrides are exempt — an
 * explicit list is the operator's responsibility.
 *
 * Reconcile payloads must pass only public-keyed relays (the same set
 * `buildReconcilePeerLists` emits as peers). GET fabric may pass every
 * gateway so operators still see planned defaults before a key exists.
 */
export function resolveDerivedAdvertisedCidrsByRelay(
  relays: ReadonlyArray<DerivedAdvertisedRelay>,
  subnetsByServer: ReadonlyMap<string, readonly DatacenterSubnetRow[]>,
): Map<string, string[]> {
  const resolved = new Map<string, string[]>()
  const deriving: Array<{ id: string; cidrs: string[] }> = []

  for (const relay of relays) {
    if (relay.role === 'member') {
      resolved.set(relay.id, [])
      continue
    }
    if (relay.advertisedCidrs.length > 0) {
      resolved.set(relay.id, [...relay.advertisedCidrs])
      continue
    }
    deriving.push({
      id: relay.id,
      cidrs: ipv4CidrsFromSubnets(subnetsByServer.get(relay.serverId) ?? []),
    })
  }

  const ownerByCidr = new Map<string, string>()
  for (const gateway of deriving) {
    for (const cidr of gateway.cidrs) {
      const current = ownerByCidr.get(cidr)
      if (current === undefined || gateway.id.localeCompare(current) < 0) {
        ownerByCidr.set(cidr, gateway.id)
      }
    }
  }

  for (const gateway of deriving) {
    resolved.set(
      gateway.id,
      gateway.cidrs.filter((cidr) => ownerByCidr.get(cidr) === gateway.id),
    )
  }
  return resolved
}

/**
 * Effective per-datacenter routing policy consumed by the private-endpoint
 * ladder and TurboFabric path planning.
 */
export type DatacenterPolicyRow = {
  addressPreference: DatacenterAddressPreference
  priority: number
  trusted: boolean
}

/** Policy row for a datacenter with no stored `options` (or no row at all). */
export function defaultDatacenterPolicyRow(): DatacenterPolicyRow {
  return {
    addressPreference: 'ipv6',
    priority: DEFAULT_DATACENTER_PRIORITY,
    trusted: DEFAULT_DATACENTER_TRUSTED,
  }
}

/**
 * Load the effective routing policy (`addressPreference`, `priority`,
 * `trusted`) for the given datacenter ids in one `inArray` select. Every
 * requested id is seeded with the documented defaults so missing rows and
 * invalid/absent option values resolve to `'ipv6'` /
 * `DEFAULT_DATACENTER_PRIORITY` / `DEFAULT_DATACENTER_TRUSTED`.
 */
export async function loadDatacenterPolicies(
  db: Db,
  datacenterIds: string[],
): Promise<Map<string, DatacenterPolicyRow>> {
  const byDc = new Map<string, DatacenterPolicyRow>()
  if (datacenterIds.length === 0) return byDc
  for (const id of datacenterIds) {
    byDc.set(id, defaultDatacenterPolicyRow())
  }

  const rows = await db
    .select({
      id: datacenter.id,
      options: datacenter.options,
    })
    .from(datacenter)
    .where(inArray(datacenter.id, datacenterIds))

  for (const row of rows) {
    const policy = resolveDatacenterPolicy(row.options)
    byDc.set(row.id, {
      addressPreference: parseDatacenterOptions(row.options).addressPreference ??
        'ipv6',
      priority: policy.priority,
      trusted: policy.trusted,
    })
  }
  return byDc
}

/**
 * Load `datacenter.options.addressPreference` for the given ids. Missing rows
 * and invalid/absent preference values default to `'ipv6'` (RFC 6724).
 * Thin projection over {@link loadDatacenterPolicies}.
 */
export async function loadDatacenterAddressPreferences(
  db: Db,
  datacenterIds: string[],
): Promise<Map<string, DatacenterAddressPreference>> {
  const byDc = new Map<string, DatacenterAddressPreference>()
  const policies = await loadDatacenterPolicies(db, datacenterIds)
  for (const [id, policy] of policies) {
    byDc.set(id, policy.addressPreference)
  }
  return byDc
}

/** Prerequisite for private/replica placement: the site has at least one subnet. */
export async function assertDatacenterHasCidr(
  db: Db,
  datacenterId: string,
): Promise<null | DatacenterCidrRequiredError> {
  const cidrsByDc = await loadDatacenterCidrs(db, [datacenterId])
  const cidrs = cidrsByDc.get(datacenterId) ?? []
  if (cidrs.length === 0) {
    return { kind: 'datacenter_cidr_required', datacenterId }
  }
  return null
}

/**
 * Placement prerequisite: the server has at least one datacenter membership
 * pin **and** at least one of those datacenters has a CIDR-bearing site subnet.
 */
export async function assertServerDatacenterReady(
  db: Db,
  serverId: string,
): Promise<null | ServerDatacenterReadyError> {
  const memberships = await loadDatacenterMembershipsForServers(db, [serverId])
  const pins = memberships.get(serverId) ?? []
  const firstPin = pins[0]
  if (!firstPin) {
    return { kind: 'datacenter_required', serverId }
  }

  let firstCidrError: DatacenterCidrRequiredError | null = null
  for (const datacenterId of uniqueDatacenterIds(pins)) {
    const error = await assertDatacenterHasCidr(db, datacenterId)
    if (!error) return null
    firstCidrError ??= error
  }
  return firstCidrError ?? {
    kind: 'datacenter_cidr_required',
    datacenterId: firstPin.datacenterId,
  }
}

export type GatewayRelayReadyError =
  | { kind: 'gateway_datacenter_required'; serverId: string }
  | { kind: 'gateway_datacenter_cidr_required'; datacenterId: string }

/**
 * Gateways must hold a datacenter membership pin on a site that has a CIDR.
 * Delegates to {@link assertServerDatacenterReady} and maps the placement
 * errors onto gateway wire codes (keyed on `serverId`).
 */
export async function assertGatewayRelaysReady(
  db: Db,
  rows: ReadonlyArray<{ serverId: string; role: string }>,
): Promise<GatewayRelayReadyError | null> {
  for (const row of rows) {
    if (row.role !== 'gateway') continue
    const ready = await assertServerDatacenterReady(db, row.serverId)
    if (!ready) continue
    if (ready.kind === 'datacenter_required') {
      return {
        kind: 'gateway_datacenter_required',
        serverId: row.serverId,
      }
    }
    return {
      kind: 'gateway_datacenter_cidr_required',
      datacenterId: ready.datacenterId,
    }
  }
  return null
}

/** True when the server has any membership pin into the given datacenter. */
export async function serverIsMemberOfDatacenter(
  db: Db,
  serverId: string,
  datacenterId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: ip.id })
    .from(ip)
    .where(
      and(
        eq(ip.scope, 'datacenter'),
        eq(ip.serverId, serverId),
        eq(ip.datacenterId, datacenterId),
      ),
    )
    .limit(1)
  return Boolean(row)
}
