/**
 * IPv4 **pool arithmetic** for TurboFabric host (`tp0`) and per-relay container
 * aggregates: `nthSubnet`, `nextFreeSubnet`, `nthHostAddress`, and friends.
 *
 * The fabric pool itself stays IPv4 (dual-stack is reserved in
 * `fabric.options`; not implemented here). Overlap / containment math is
 * **not** owned here: `cidrOverlaps` / `cidrContains` below are thin IPv4-named
 * aliases that delegate to the dual-family authority in `../ip-address.ts`
 * (`cidrsOverlap` / `cidrContains`), so datacenter subnets — which may be IPv6 —
 * and fabric pools share one comparison implementation.
 */

import {
  cidrContains as cidrContainsAnyFamily,
  cidrsOverlap,
  isValidCidr,
  isValidIpAddress,
  stripInetPrefixSuffix,
} from '../ip-address.ts'

export const DEFAULT_FABRIC_HOST_CIDR = '10.250.0.0/16' // NOSONAR typescript:S1313 — RFC1918 TurboFabric tp0 default, not a reachable host
export const DEFAULT_FABRIC_CONTAINER_POOL = '10.192.0.0/12' // NOSONAR typescript:S1313 — RFC1918 container-pool default, not a reachable host
export const DEFAULT_FABRIC_LISTEN_PORT = 51821
export const DEFAULT_FABRIC_MTU = 1420
export const RELAY_PREFIX_LENGTH = 16

const CANDIDATE_HOST_CIDRS = [
  DEFAULT_FABRIC_HOST_CIDR,
  '10.251.0.0/16', // NOSONAR typescript:S1313 — RFC1918 fallback tp0 range when the default overlaps
  '10.252.0.0/16', // NOSONAR typescript:S1313 — RFC1918 fallback tp0 range when the default overlaps
  '10.253.0.0/16', // NOSONAR typescript:S1313 — RFC1918 fallback tp0 range when the default overlaps
]

type Ipv4Cidr = {
  network: number
  prefix: number
  hostCount: number
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number.parseInt(part, 10)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = (value << 8) + octet
  }
  return value >>> 0
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.')
}

function maskForPrefix(prefix: number): number {
  if (prefix <= 0) return 0
  if (prefix >= 32) return 0xffffffff
  return (0xffffffff << (32 - prefix)) >>> 0
}

export function parseIpv4Cidr(value: string): Ipv4Cidr | null {
  const trimmed = value.trim()
  if (!isValidCidr(trimmed)) return null
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0) return null
  const address = trimmed.slice(0, slash)
  const prefix = Number.parseInt(trimmed.slice(slash + 1), 10)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const ip = ipv4ToInt(address)
  if (ip === null) return null
  const mask = maskForPrefix(prefix)
  const network = ip & mask
  const hostCount = prefix >= 32 ? 1 : 2 ** (32 - prefix)
  return { network, prefix, hostCount }
}

/** Delegates to the dual-family authority (`ip-address.ts` `cidrsOverlap`). */
export function cidrOverlaps(a: string, b: string): boolean {
  return cidrsOverlap(a, b)
}

export function pickNonOverlappingCidr(
  candidates: readonly string[],
  occupied: readonly string[],
): string | null {
  for (const candidate of candidates) {
    if (occupied.some((row) => cidrOverlaps(candidate, row))) continue
    return candidate
  }
  return null
}

export function pickDefaultFabricHostCidr(occupied: readonly string[]): string | null {
  return pickNonOverlappingCidr(CANDIDATE_HOST_CIDRS, occupied)
}

export function nthHostAddress(cidrValue: string, index: number): string | null {
  const parsed = parseIpv4Cidr(cidrValue)
  if (!parsed || parsed.prefix >= 31) return null
  // Skip network (0) and broadcast (hostCount-1); index is 0-based among hosts.
  if (index < 0 || index >= parsed.hostCount - 2) return null
  return intToIpv4(parsed.network + 1 + index)
}

/**
 * Last usable host in a segment CIDR — reserved for the ProxySQL platform
 * attachment so tenant tasks never collide with it.
 */
export function reservedManagedIngressAddress(cidrValue: string): string | null {
  const parsed = parseIpv4Cidr(cidrValue)
  if (!parsed || parsed.prefix >= 31) return null
  return nthHostAddress(cidrValue, parsed.hostCount - 3)
}

export function nthSubnet(
  poolCidr: string,
  prefixLength: number,
  index: number,
): string | null {
  const pool = parseIpv4Cidr(poolCidr)
  if (!pool || prefixLength < pool.prefix || prefixLength > 32) return null
  const blockSize = 2 ** (32 - prefixLength)
  const available = 2 ** (prefixLength - pool.prefix)
  if (index < 0 || index >= available) return null
  const network = pool.network + index * blockSize
  return `${intToIpv4(network)}/${String(prefixLength)}`
}

export function hostRoute32(address: string): string | null {
  const stripped = stripInetPrefixSuffix(address)
  if (!isValidIpAddress(stripped)) return null
  return `${stripped}/32`
}

export function parseFabricOptions(value: unknown): {
  containerPool: string
  listenPort: number
  mtu: number
  allowRelay: boolean
} {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const pool = typeof record.containerPool === 'string' && isValidCidr(record.containerPool)
    ? record.containerPool.trim()
    : DEFAULT_FABRIC_CONTAINER_POOL
  const port = typeof record.listenPort === 'number' &&
      Number.isInteger(record.listenPort) &&
      record.listenPort >= 1 &&
      record.listenPort <= 65535
    ? record.listenPort
    : DEFAULT_FABRIC_LISTEN_PORT
  const mtu = typeof record.mtu === 'number' &&
      Number.isInteger(record.mtu) &&
      record.mtu >= 1280 &&
      record.mtu <= 9000
    ? record.mtu
    : DEFAULT_FABRIC_MTU
  return {
    containerPool: pool,
    listenPort: port,
    mtu,
    allowRelay: record.allowRelay === true,
  }
}

export function composeNetworkHostName(networkId: string): string {
  return `tpn_${networkId}`
}

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

/** True when the unique violation is on `relay(fabric_id, address)`. */
export function isRelayAddressUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('uniq_relay_fabric_address')
}

/** True when the unique violation is on `relay(fabric_id, prefix)`. */
export function isRelayPrefixUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('uniq_relay_fabric_prefix')
}

/**
 * True when `child` is entirely inside `parent` (same family, longer-or-equal
 * prefix). Delegates to the dual-family authority (`ip-address.ts` `cidrContains`).
 */
export function cidrContains(parent: string, child: string): boolean {
  return cidrContainsAnyFamily(parent, child)
}

/**
 * Lowest-free subnet of `prefixLength` inside `poolCidr` that is not already
 * listed in `taken` (exact match — the pool's own allocations) and does not
 * overlap any range in `exclusions` (reserved rows, site subnets, docker
 * registrations — fed from `../net/cidr-collisions.ts`). Returns null when
 * the pool is exhausted.
 */
export function nextFreeSubnet(
  poolCidr: string,
  prefixLength: number,
  taken: Iterable<string>,
  exclusions: Iterable<string> = [],
): string | null {
  const takenSet = new Set(taken)
  const excluded = [...exclusions]
  for (let i = 0; ; i++) {
    const candidate = nthSubnet(poolCidr, prefixLength, i)
    if (!candidate) return null
    if (takenSet.has(candidate)) continue
    if (excluded.some((range) => cidrOverlaps(candidate, range))) continue
    return candidate
  }
}

/**
 * Lowest-free `/24` inside `relayPrefix` whose CIDR is not already held by a
 * segment that actually falls inside this prefix and does not overlap any
 * `exclusions` range that reaches into the prefix.
 */
export function nextFreeSubnetCidr(
  relayPrefix: string,
  takenCidrs: Iterable<string>,
  exclusions: Iterable<string> = [],
): string | null {
  const scoped: string[] = []
  for (const cidrValue of takenCidrs) {
    if (cidrContains(relayPrefix, cidrValue)) scoped.push(cidrValue)
  }
  const scopedExclusions: string[] = []
  for (const range of exclusions) {
    if (cidrOverlaps(relayPrefix, range)) scopedExclusions.push(range)
  }
  return nextFreeSubnet(relayPrefix, 24, scoped, scopedExclusions)
}
