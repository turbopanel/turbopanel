/**
 * Datacenter membership is an `ip` row with
 * `scope='datacenter' AND server_id AND datacenter_id` (optional `network_id`
 * → the site CIDR network). A server may hold many pins (multi-NIC / ranges).
 * Unassign deletes that pin row.
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { datacenter, ip, network } from '../db/schema.ts'
import {
  addressInCidr,
  inferSiteCidrFromAddress,
  inetAddressToString,
  isValidCidr,
  isValidIpAddress,
  parseIpVersion,
  stripInetPrefixSuffix,
} from '../ip-address.ts'
import {
  reportedIpsFromServerMetadata,
  privateAddressesFromIps,
  type ServerReportedIp,
} from '../../server-addresses.ts'

export type DatacenterMemberPin = {
  serverId: string
  address: string
}

export type DatacenterMembershipRow = {
  ipId: string
  serverId: string
  datacenterId: string
  networkId: string | null
  address: string
  family: 4 | 6
}

/**
 * Membership pin with the columns the automatic repin pass needs on top of
 * {@link DatacenterMembershipRow}: the org (for the `uniq_ip_org_address`
 * lookup), the owning subnet CIDR, and the raw `ip.metadata` markers.
 */
export type DatacenterMembershipPinDetailRow = DatacenterMembershipRow & {
  organizationId: string
  subnetCidr: string | null
  metadata: unknown
}

export type MemberPinSubnet = {
  networkId: string
  cidr: string
}

export function resolveSubnetForAddress<T extends MemberPinSubnet>(
  subnets: readonly T[],
  address: string,
): T | null {
  const normalized = stripInetPrefixSuffix(address.trim())
  if (!normalized) return null
  for (const subnet of subnets) {
    if (addressInCidr(normalized, subnet.cidr)) return subnet
  }
  return null
}

function toMembershipRow(row: {
  ipId: string
  serverId: string | null
  datacenterId: string | null
  networkId: string | null
  address: unknown
}): DatacenterMembershipRow | null {
  if (!row.serverId || !row.datacenterId) return null
  const address = inetAddressToString(row.address)
  if (!address) return null
  const family = parseIpVersion(address)
  if (!family) return null
  return {
    ipId: row.ipId,
    serverId: row.serverId,
    datacenterId: row.datacenterId,
    networkId: row.networkId,
    address,
    family,
  }
}

export function normalizeReportedPrivateAddresses(
  ips: ServerReportedIp[] | null | undefined,
): string[] {
  return privateAddressesFromIps(ips).filter((address) =>
    isValidIpAddress(address)
  )
}

export function reportedAddressesFromServerMetadata(
  metadata: unknown,
): string[] {
  return normalizeReportedPrivateAddresses(
    reportedIpsFromServerMetadata(metadata),
  )
}

export function isReportedPrivateAddress(
  metadata: unknown,
  address: string,
): boolean {
  const normalized = stripInetPrefixSuffix(address.trim())
  return reportedAddressesFromServerMetadata(metadata).includes(normalized)
}

function findReportedPrivateIp(
  metadata: unknown,
  address: string,
): ServerReportedIp | null {
  const ips = reportedIpsFromServerMetadata(metadata)
  if (!ips) return null
  const normalized = stripInetPrefixSuffix(address.trim())
  return ips.find(
    (row) => row.scope === 'private' && row.address === normalized,
  ) ?? null
}

/**
 * Aligned interface CIDR for a daemon-reported private address.
 * Returns null when the host has not reported a prefix for that IP.
 */
export function reportedCidrForAddress(
  metadata: unknown,
  address: string,
): string | null {
  return findReportedPrivateIp(metadata, address)?.cidr ?? null
}

/**
 * Site CIDR for a daemon-reported private address: the aligned interface
 * prefix when present, otherwise a typical LAN (`/24` IPv4, `/64` IPv6).
 * Returns null when the address is not a reported private IP.
 */
export function siteCidrForAddress(
  metadata: unknown,
  address: string,
): string | null {
  const match = findReportedPrivateIp(metadata, address)
  if (!match) return null
  return match.cidr ?? inferSiteCidrFromAddress(match.address)
}

type MemberPinSuccess = { ok: true; address: string; networkId: string }
type MemberPinFailure<E extends string> = { ok: false; error: E }

export function validateMemberPinAddress(
  address: string,
  subnets: readonly MemberPinSubnet[],
  serverMetadata: unknown,
):
  | MemberPinSuccess
  | MemberPinFailure<
    'invalid_address' | 'address_not_in_any_subnet' | 'address_not_reported'
  >
export function validateMemberPinAddress(
  address: string,
  cidr: string,
  serverMetadata: unknown,
):
  | { ok: true; address: string }
  | MemberPinFailure<
    | 'invalid_address'
    | 'invalid_cidr'
    | 'address_not_in_cidr'
    | 'address_not_reported'
  >
export function validateMemberPinAddress(
  address: string,
  cidrOrSubnets: string | readonly MemberPinSubnet[],
  serverMetadata: unknown,
):
  | MemberPinSuccess
  | { ok: true; address: string }
  | MemberPinFailure<
    | 'invalid_address'
    | 'invalid_cidr'
    | 'address_not_in_cidr'
    | 'address_not_in_any_subnet'
    | 'address_not_reported'
  > {
  if (typeof cidrOrSubnets === 'string') {
    const cidr = cidrOrSubnets.trim()
    if (!isValidCidr(cidr)) {
      return { ok: false, error: 'invalid_cidr' }
    }
    const result = validateMemberPinAgainstSubnets(
      address,
      [{ networkId: '', cidr }],
      serverMetadata,
    )
    if (!result.ok && result.error === 'address_not_in_any_subnet') {
      return { ok: false, error: 'address_not_in_cidr' }
    }
    if (result.ok) {
      return { ok: true, address: result.address }
    }
    return result
  }
  return validateMemberPinAgainstSubnets(address, cidrOrSubnets, serverMetadata)
}

function validateMemberPinAgainstSubnets(
  address: string,
  subnets: readonly MemberPinSubnet[],
  serverMetadata: unknown,
):
  | MemberPinSuccess
  | MemberPinFailure<
    'invalid_address' | 'address_not_in_any_subnet' | 'address_not_reported'
  > {
  const normalized = stripInetPrefixSuffix(address.trim())
  if (!normalized || !isValidIpAddress(normalized)) {
    return { ok: false, error: 'invalid_address' }
  }
  const matched = resolveSubnetForAddress(subnets, normalized)
  if (!matched) {
    return { ok: false, error: 'address_not_in_any_subnet' }
  }
  if (!isReportedPrivateAddress(serverMetadata, normalized)) {
    return { ok: false, error: 'address_not_reported' }
  }
  return { ok: true, address: normalized, networkId: matched.networkId }
}

const MEMBERSHIP_PIN_WHERE = (serverIds: string[]) =>
  and(
    eq(ip.scope, 'datacenter'),
    isNotNull(ip.serverId),
    isNotNull(ip.datacenterId),
    inArray(ip.serverId, serverIds),
  )

function groupPinsByServer<T extends DatacenterMembershipRow>(
  pins: readonly T[],
): Map<string, T[]> {
  const byServer = new Map<string, T[]>()
  for (const pin of pins) {
    const list = byServer.get(pin.serverId) ?? []
    list.push(pin)
    byServer.set(pin.serverId, list)
  }
  return byServer
}

export async function loadDatacenterMembershipsForServers(
  db: Db,
  serverIds: string[],
): Promise<Map<string, DatacenterMembershipRow[]>> {
  if (serverIds.length === 0) return new Map()

  const rows = await db
    .select({
      ipId: ip.id,
      serverId: ip.serverId,
      datacenterId: ip.datacenterId,
      networkId: ip.networkId,
      address: ip.address,
    })
    .from(ip)
    .where(MEMBERSHIP_PIN_WHERE(serverIds))

  const pins: DatacenterMembershipRow[] = []
  for (const row of rows) {
    const pin = toMembershipRow(row)
    if (pin) pins.push(pin)
  }
  return groupPinsByServer(pins)
}

/**
 * {@link loadDatacenterMembershipsForServers} with the owning subnet CIDR and
 * `ip.metadata` joined in — the projection the automatic repin pass reads.
 * One indexed read (`idx_ip_scope_server_datacenter`) plus the `network`
 * join; a server without pins costs exactly that one read.
 */
export async function loadDatacenterMembershipPinDetailsForServers(
  db: Db,
  serverIds: string[],
): Promise<Map<string, DatacenterMembershipPinDetailRow[]>> {
  if (serverIds.length === 0) return new Map()

  const rows = await db
    .select({
      ipId: ip.id,
      serverId: ip.serverId,
      datacenterId: ip.datacenterId,
      networkId: ip.networkId,
      address: ip.address,
      organizationId: ip.organizationId,
      metadata: ip.metadata,
      subnetCidr: network.cidr,
    })
    .from(ip)
    .leftJoin(network, eq(network.id, ip.networkId))
    .where(MEMBERSHIP_PIN_WHERE(serverIds))

  const pins: DatacenterMembershipPinDetailRow[] = []
  for (const row of rows) {
    const pin = toMembershipRow(row)
    if (!pin) continue
    pins.push({
      ...pin,
      organizationId: row.organizationId,
      subnetCidr: row.subnetCidr ?? null,
      metadata: row.metadata ?? null,
    })
  }
  return groupPinsByServer(pins)
}

/** Membership row plus the raw `ip.metadata` (stale / repin markers). */
export type DatacenterMembershipWithMetadataRow = DatacenterMembershipRow & {
  metadata: unknown
}

export async function loadDatacenterMembershipsForDatacenter(
  db: Db,
  datacenterId: string,
): Promise<DatacenterMembershipWithMetadataRow[]> {
  const rows = await db
    .select({
      ipId: ip.id,
      serverId: ip.serverId,
      datacenterId: ip.datacenterId,
      networkId: ip.networkId,
      address: ip.address,
      metadata: ip.metadata,
    })
    .from(ip)
    .where(
      and(
        eq(ip.scope, 'datacenter'),
        eq(ip.datacenterId, datacenterId),
        isNotNull(ip.serverId),
      ),
    )

  const out: DatacenterMembershipWithMetadataRow[] = []
  for (const row of rows) {
    const pin = toMembershipRow(row)
    if (!pin) continue
    out.push({ ...pin, metadata: row.metadata ?? null })
  }
  return out
}

/** Shared datacenter ids between two servers (intersection of memberships). */
export function sharedDatacenterIds(
  a: readonly DatacenterMembershipRow[],
  b: readonly DatacenterMembershipRow[],
): string[] {
  const bIds = new Set(b.map((row) => row.datacenterId))
  const shared = a
    .map((row) => row.datacenterId)
    .filter((id) => bIds.has(id))
  return [...new Set(shared)].sort((x, y) => x.localeCompare(y))
}

export async function loadServerDatacenterPinAddress(
  db: Db,
  serverId: string,
  datacenterId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ address: ip.address })
    .from(ip)
    .where(
      and(
        eq(ip.scope, 'datacenter'),
        eq(ip.serverId, serverId),
        eq(ip.datacenterId, datacenterId),
      ),
    )
    .limit(1)
  return inetAddressToString(row?.address) ?? null
}

export async function countUnassignedServersAmong(
  db: Db,
  serverIds: string[],
): Promise<{ memberServerIds: Set<string>; unassignedCount: number }> {
  const memberships = await loadDatacenterMembershipsForServers(db, serverIds)
  const memberServerIds = new Set(memberships.keys())
  let unassignedCount = 0
  for (const id of serverIds) {
    if (!memberServerIds.has(id)) unassignedCount += 1
  }
  return { memberServerIds, unassignedCount }
}

export async function loadDatacenterDisplayNames(
  db: Db,
  datacenterIds: string[],
): Promise<Map<string, string | null>> {
  const byId = new Map<string, string | null>()
  if (datacenterIds.length === 0) return byId
  const rows = await db
    .select({ id: datacenter.id, name: datacenter.name })
    .from(datacenter)
    .where(inArray(datacenter.id, datacenterIds))
  for (const row of rows) {
    byId.set(row.id, row.name)
  }
  return byId
}

export async function loadSiteNetworkId(
  db: Db,
  datacenterId: string,
): Promise<{ networkId: string; cidr: string } | null> {
  const [row] = await db
    .select({
      id: network.id,
      cidr: network.cidr,
    })
    .from(network)
    .where(
      and(
        eq(network.kind, 'datacenter'),
        eq(network.datacenterId, datacenterId),
      ),
    )
    .limit(1)
  if (!row?.cidr) return null
  return { networkId: row.id, cidr: row.cidr }
}
