/** Dependency-free IPv4/IPv6 and CIDR validators (Deno + Workers). */

const IPV4_OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)`
const IPV4_ADDRESS_RE = new RegExp(
  String.raw`^${IPV4_OCTET}\.${IPV4_OCTET}\.${IPV4_OCTET}\.${IPV4_OCTET}$`,
)

function isIpv6Hextet(part: string): boolean {
  if (part.length === 0 || part.length > 4) return false
  return /^[0-9a-fA-F]+$/.test(part)
}

function areValidIpv6Hextets(parts: readonly string[]): boolean {
  return parts.every(isIpv6Hextet)
}

function hextetsAroundCompression(address: string): string[] {
  const [left, right] = address.split('::')
  const leftParts = left === '' ? [] : left.split(':')
  const rightParts = right === '' ? [] : right.split(':')
  return [...leftParts, ...rightParts]
}

/** Compressed form with a single `::` (0–7 hextets around the gap). */
function isValidCompressedIpv6(address: string): boolean {
  const parts = hextetsAroundCompression(address)
  if (!areValidIpv6Hextets(parts)) return false
  return parts.length < 8
}

/** Full form: exactly eight hextets, no `::`. */
function isValidFullIpv6(address: string): boolean {
  const parts = address.split(':')
  if (parts.length !== 8) return false
  return areValidIpv6Hextets(parts)
}

/** RFC 5952-style IPv6 (single `::`, non-empty groups, no zone id). */
function isValidIpv6Address(address: string): boolean {
  if (address.includes('.') || address.includes('%')) return false

  const doubleColonMatches = address.match(/::/g)
  const doubleColonCount = doubleColonMatches?.length ?? 0
  if (doubleColonCount > 1) return false
  if (doubleColonCount === 1) return isValidCompressedIpv6(address)
  return isValidFullIpv6(address)
}

/** Strip a Postgres `inet` `/prefix` suffix when present. */
export function stripInetPrefixSuffix(value: string): string {
  const trimmed = value.trim()
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0) return trimmed
  const suffix = trimmed.slice(slash + 1)
  if (!/^\d+$/.test(suffix)) return trimmed
  return trimmed.slice(0, slash)
}

export type IpAddressVersion = 4 | 6

export function parseIpVersion(address: string): IpAddressVersion | null {
  const trimmed = address.trim()
  if (trimmed.length === 0) return null
  if (IPV4_ADDRESS_RE.test(trimmed)) return 4
  if (trimmed.includes(':') && isValidIpv6Address(trimmed)) return 6
  return null
}

export function isValidIpAddress(address: string): boolean {
  return parseIpVersion(address) !== null
}

/**
 * Coerce a Postgres `inet` driver value (possibly with a `/prefix` suffix) into
 * a plain address string, or `undefined` when the value is not a valid IP.
 */
export function inetAddressToString(address: unknown): string | undefined {
  if (typeof address !== 'string') return undefined
  const stripped = stripInetPrefixSuffix(address)
  if (!isValidIpAddress(stripped)) return undefined
  return stripped
}

function parsePrefix(value: string, version: 4 | 6): number | null {
  if (!/^\d+$/.test(value)) return null
  const prefix = Number.parseInt(value, 10)
  const max = version === 4 ? 32 : 128
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null
  return prefix
}

export function isValidCidr(value: string): boolean {
  return parseCidr(value) !== null
}

/** Derive address family from an IP string (API response helper; not a DB column). */
export function deriveIpVersion(address: string): 4 | 6 | null {
  return parseIpVersion(address)
}

export type ParsedCidr = {
  version: 4 | 6
  base: bigint
  prefix: number
}

export function parseCidr(value: string): ParsedCidr | null {
  const trimmed = value.trim()
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return null
  const addressPart = trimmed.slice(0, slash)
  const prefixPart = trimmed.slice(slash + 1)
  const version = parseIpVersion(addressPart)
  if (version === null) return null
  const prefix = parsePrefix(prefixPart, version)
  if (prefix === null) return null
  const base = ipToBigInt(addressPart)
  if (base === null) return null
  const hostBits = (version === 4 ? 32 : 128) - prefix
  const aligned = hostBits === 0
    ? base
    : (base >> BigInt(hostBits)) << BigInt(hostBits)
  return { version, base: aligned, prefix }
}

/** Address family of a CIDR, or null when the value is not a valid CIDR. */
export function cidrVersion(cidr: string): 4 | 6 | null {
  return parseCidr(cidr)?.version ?? null
}

/** Render an aligned network CIDR (`10.0.0.5/24` → `10.0.0.0/24`). */
export function formatCidr(parsed: ParsedCidr): string {
  return `${bigIntToIp(parsed.base, parsed.version)}/${parsed.prefix}`
}

/**
 * Normalize a host-or-network CIDR to the network address + prefix.
 * Daemon interface reports are typically `address/prefix`.
 */
export function alignedNetworkCidr(value: string): string | null {
  const parsed = parseCidr(value)
  if (!parsed) return null
  return formatCidr(parsed)
}

/** Typical LAN prefixes when a daemon has not reported an interface CIDR. */
export const SITE_LAN_PREFIX_V4 = 24
export const SITE_LAN_PREFIX_V6 = 64

/**
 * Infer a site CIDR from a host address: IPv4 /24, IPv6 /64, aligned to the
 * network address. Used when hello/heartbeat still omits `ips[].cidr`.
 */
export function inferSiteCidrFromAddress(address: string): string | null {
  const host = stripInetPrefixSuffix(address.trim())
  const version = parseIpVersion(host)
  if (version === null) return null
  const prefix = version === 4 ? SITE_LAN_PREFIX_V4 : SITE_LAN_PREFIX_V6
  return alignedNetworkCidr(`${host}/${prefix}`)
}

export function ipToBigInt(address: string): bigint | null {
  const trimmed = stripInetPrefixSuffix(address)
  const version = parseIpVersion(trimmed)
  if (version === 4) {
    const parts = trimmed.split('.')
    if (parts.length !== 4) return null
    let value = 0n
    for (const part of parts) {
      value = (value << 8n) + BigInt(Number.parseInt(part, 10))
    }
    return value
  }
  if (version === 6) {
    const hextets = expandIpv6Hextets(trimmed)
    if (!hextets) return null
    let value = 0n
    for (const hextet of hextets) {
      value = (value << 16n) + BigInt(Number.parseInt(hextet, 16))
    }
    return value
  }
  return null
}

function expandIpv6Hextets(address: string): string[] | null {
  if (address.includes('::')) {
    const [left, right] = address.split('::')
    const leftParts = left === '' ? [] : left.split(':')
    const rightParts = right === '' ? [] : right.split(':')
    const missing = 8 - leftParts.length - rightParts.length
    if (missing < 0) return null
    return [
      ...leftParts,
      ...Array.from({ length: missing }, () => '0'),
      ...rightParts,
    ]
  }
  const parts = address.split(':')
  if (parts.length !== 8) return null
  return parts
}

function bigIntToIpv4(value: bigint): string {
  const n = value & 0xff_ff_ff_ffn
  return [
    Number((n >> 24n) & 0xffn),
    Number((n >> 16n) & 0xffn),
    Number((n >> 8n) & 0xffn),
    Number(n & 0xffn),
  ].join('.')
}

function ipv6HextetsFromBigInt(value: bigint): number[] {
  const hextets: number[] = []
  let remaining = value & ((1n << 128n) - 1n)
  for (let i = 0; i < 8; i++) {
    hextets.unshift(Number(remaining & 0xffffn))
    remaining >>= 16n
  }
  return hextets
}

/** Longest run of zero hextets (RFC 5952 prefers the leftmost on ties). */
function longestIpv6ZeroRun(
  hextets: readonly number[],
): { start: number; length: number } {
  let bestStart = -1
  let bestLen = 0
  let runStart = -1
  let runLen = 0
  for (let i = 0; i <= hextets.length; i++) {
    if (i < hextets.length && hextets[i] === 0) {
      if (runStart === -1) runStart = i
      runLen += 1
      continue
    }
    if (runStart !== -1 && runLen > bestLen) {
      bestStart = runStart
      bestLen = runLen
    }
    runStart = -1
    runLen = 0
  }
  return { start: bestStart, length: bestLen }
}

function formatHexHextets(hextets: readonly number[]): string {
  return hextets.map((h) => h.toString(16)).join(':')
}

/** RFC 5952-canonical IPv6 (lowercase, longest zero-run compressed). */
function bigIntToIpv6(value: bigint): string {
  const hextets = ipv6HextetsFromBigInt(value)
  const { start: bestStart, length: bestLen } = longestIpv6ZeroRun(hextets)

  if (bestLen < 2) return formatHexHextets(hextets)

  const left = formatHexHextets(hextets.slice(0, bestStart))
  const right = formatHexHextets(hextets.slice(bestStart + bestLen))
  if (bestStart === 0 && bestStart + bestLen === 8) return '::'
  if (bestStart === 0) return `::${right}`
  if (bestStart + bestLen === 8) return `${left}::`
  return `${left}::${right}`
}

export function bigIntToIp(value: bigint, version: 4 | 6): string {
  if (version === 4) return bigIntToIpv4(value)
  return bigIntToIpv6(value)
}

export function addressInCidr(address: string, cidr: string): boolean {
  const parsed = parseCidr(cidr)
  const value = ipToBigInt(address)
  if (!parsed || value === null) return false
  if (parseIpVersion(stripInetPrefixSuffix(address)) !== parsed.version) {
    return false
  }
  const bitWidth = parsed.version === 4 ? 32 : 128
  const hostBits = bitWidth - parsed.prefix
  if (hostBits === 0) return value === parsed.base
  const hostMask = (1n << BigInt(hostBits)) - 1n
  return (value & ~hostMask) === parsed.base
}

function cidrInclusiveLast(parsed: ParsedCidr): bigint {
  const bitWidth = parsed.version === 4 ? 32 : 128
  const hostBits = bitWidth - parsed.prefix
  const size = 1n << BigInt(hostBits)
  return parsed.base + size - 1n
}

/**
 * Dual-family CIDR overlap authority (IPv4 + IPv6, BigInt math).
 *
 * True when two CIDRs share any address. Same family is required; invalid or
 * cross-family inputs never overlap. `src/lib/fabric/cidr.ts` delegates its
 * IPv4 `cidrOverlaps` here — do not grow another copy.
 */
export function cidrsOverlap(a: string, b: string): boolean {
  const left = parseCidr(a)
  const right = parseCidr(b)
  if (!left || !right) return false
  if (left.version !== right.version) return false
  return left.base <= cidrInclusiveLast(right) &&
    right.base <= cidrInclusiveLast(left)
}

/**
 * Dual-family CIDR containment authority (IPv4 + IPv6, BigInt math).
 *
 * True when every address of `child` lies inside `parent` (same family and a
 * longer-or-equal prefix). A CIDR contains itself. Invalid or cross-family
 * inputs are never contained. `src/lib/fabric/cidr.ts` delegates its IPv4
 * `cidrContains` here.
 */
export function cidrContains(parent: string, child: string): boolean {
  const outer = parseCidr(parent)
  const inner = parseCidr(child)
  if (!outer || !inner) return false
  if (outer.version !== inner.version) return false
  if (inner.prefix < outer.prefix) return false
  return inner.base >= outer.base &&
    cidrInclusiveLast(inner) <= cidrInclusiveLast(outer)
}

export type CidrHostRange = {
  first: bigint
  last: bigint
}

export function cidrHostRange(cidr: string): CidrHostRange | null {
  const parsed = parseCidr(cidr)
  if (!parsed) return null
  const bitWidth = parsed.version === 4 ? 32 : 128
  const hostBits = bitWidth - parsed.prefix
  const size = 1n << BigInt(hostBits)
  const network = parsed.base
  const broadcast = network + size - 1n

  if (parsed.version === 4) {
    if (parsed.prefix <= 30) {
      if (size < 4n) return null
      return { first: network + 1n, last: broadcast - 1n }
    }
    return { first: network, last: broadcast }
  }

  // IPv6: skip subnet-router anycast / unspecified (::). Never hand out ::.
  if (size === 1n) {
    if (network === 0n) return null
    return { first: network, last: network }
  }
  return { first: network + 1n, last: broadcast }
}

export function nextFreeHostAddress(
  cidr: string,
  usedAddresses: Iterable<string>,
): string | null {
  const range = cidrHostRange(cidr)
  const parsed = parseCidr(cidr)
  if (!range || !parsed) return null

  const used = new Set<bigint>()
  for (const raw of usedAddresses) {
    const value = ipToBigInt(raw)
    if (value !== null) used.add(value)
  }

  const maxIterations = used.size + 1
  let candidate = range.first
  for (let i = 0; i < maxIterations && candidate <= range.last; i++) {
    if (!used.has(candidate)) {
      return bigIntToIp(candidate, parsed.version)
    }
    candidate += 1n
  }
  return null
}

const IPV4_MAPPED_PREFIX_RE = /^(?:::ffff:|::ffff:0:)/i

/**
 * Canonicalize an address as it arrives off the wire.
 *
 * Strips a `%zone` suffix, an `inet` `/prefix` suffix, `[]` brackets, and
 * unwraps IPv4-mapped IPv6 (`::ffff:203.0.113.9` → `203.0.113.9`). Reverse
 * proxies and socket APIs emit all four forms for what is one address, and
 * every downstream comparison here is string equality.
 *
 * Returns `null` when the result is not a valid IP.
 */
export function normalizeIpAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let candidate = stripInetPrefixSuffix(value.trim())
  if (candidate.startsWith('[') && candidate.endsWith(']')) {
    candidate = candidate.slice(1, -1)
  }
  const zone = candidate.indexOf('%')
  if (zone > 0) candidate = candidate.slice(0, zone)
  const mapped = candidate.replace(IPV4_MAPPED_PREFIX_RE, '')
  if (mapped !== candidate && IPV4_ADDRESS_RE.test(mapped)) return mapped
  return isValidIpAddress(candidate) ? candidate : null
}

export type IpAddressScope = 'loopback' | 'link-local' | 'private' | 'public'

const LOOPBACK_CIDRS = ['127.0.0.0/8', '::1/128'] as const // NOSONAR typescript:S1313 — IANA loopback classification ranges
const LINK_LOCAL_CIDRS = [
  '169.254.0.0/16', // NOSONAR typescript:S1313 — RFC3927 IPv4 link-local classification
  'fe80::/10', // NOSONAR typescript:S1313 — RFC4291 IPv6 link-local classification
] as const
/**
 * Not globally routable, but a real host address a peer on the same network
 * can reach. `100.64.0.0/10` (RFC 6598) is here because carrier-grade NAT and
 * Tailscale both hand out addresses from it.
 */
const PRIVATE_CIDRS = [
  '10.0.0.0/8', // NOSONAR typescript:S1313 — RFC1918 private classification
  '172.16.0.0/12', // NOSONAR typescript:S1313 — RFC1918 private classification
  '192.168.0.0/16', // NOSONAR typescript:S1313 — RFC1918 private classification
  '100.64.0.0/10', // NOSONAR typescript:S1313 — RFC6598 CGNAT classification
  'fc00::/7', // NOSONAR typescript:S1313 — RFC4193 ULA classification
] as const
/** Never a host address: unspecified, multicast, broadcast. */
const UNUSABLE_CIDRS = [
  '0.0.0.0/8', // NOSONAR typescript:S1313 — unspecified IPv4, not a host
  '224.0.0.0/4', // NOSONAR typescript:S1313 — IPv4 multicast classification
  '255.255.255.255/32', // NOSONAR typescript:S1313 — IPv4 limited broadcast, not a host
  '::/128', // NOSONAR typescript:S1313 — unspecified IPv6, not a host
  'ff00::/8', // NOSONAR typescript:S1313 — IPv6 multicast classification
] as const

function matchesAny(address: string, cidrs: readonly string[]): boolean {
  return cidrs.some((cidr) => addressInCidr(address, cidr))
}

/**
 * Classify an address for "can a peer reach the host on this?".
 *
 * `null` means the value is not an address a host can be reached on at all
 * (malformed, unspecified, multicast, broadcast).
 */
export function ipAddressScope(value: string): IpAddressScope | null {
  const address = normalizeIpAddress(value)
  if (!address) return null
  if (matchesAny(address, UNUSABLE_CIDRS)) return null
  if (matchesAny(address, LOOPBACK_CIDRS)) return 'loopback'
  if (matchesAny(address, LINK_LOCAL_CIDRS)) return 'link-local'
  if (matchesAny(address, PRIVATE_CIDRS)) return 'private'
  return 'public'
}

/** True when a peer on some network could reach the host at this address. */
export function isRoutableHostAddress(value: string): boolean {
  const scope = ipAddressScope(value)
  return scope === 'private' || scope === 'public'
}
