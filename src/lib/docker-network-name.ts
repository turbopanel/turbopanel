/**
 * Read / validate the Docker network name and optional addressing from a
 * `network` row (`kind = docker`).
 *
 * `options.dockerNetworkName` is the compose `networks.*.external` name the
 * daemon ensures on the host. The optional addressing keys (`subnet`,
 * `ipRange`, `gateway`, `mtu`) are what that `docker network create` is
 * given; `subnet` is mirrored into the `network.cidr` column so the org CIDR
 * registry (`net/cidr-collisions.ts`) sees the range — the column is the
 * registry-visible truth, `options.subnet` is the Docker-facing copy.
 */

import { addressInCidr, cidrContains, isValidCidr } from './ip-address.ts'

const DOCKER_NETWORK_NAME_KEY = 'dockerNetworkName'

/** Docker Engine network name allowlist (compose `name:` / host `docker network`). */
export const DOCKER_NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** Same bounds as the TurboFabric bridge MTU (`parseFabricOptions`). */
export const DOCKER_NETWORK_MTU_MIN = 1280
export const DOCKER_NETWORK_MTU_MAX = 9000

/** Addressing a `kind='docker'` row hands to `docker network create`. */
export type DockerNetworkAddressing = {
  subnet?: string
  ipRange?: string
  gateway?: string
  mtu?: number
}

export type DockerNetworkOptionsRejection =
  | 'docker_network_name_required'
  | 'docker_network_subnet_invalid'
  | 'docker_network_ip_range_invalid'
  | 'docker_network_gateway_invalid'
  | 'docker_network_mtu_invalid'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isValidDockerNetworkName(value: string): boolean {
  return DOCKER_NETWORK_NAME_RE.test(value)
}

export function isValidDockerNetworkMtu(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= DOCKER_NETWORK_MTU_MIN &&
    value <= DOCKER_NETWORK_MTU_MAX
}

export function readNetworkDockerNetworkName(
  options: unknown,
  metadata: unknown,
): string | null {
  if (isRecord(options)) {
    const raw = options[DOCKER_NETWORK_NAME_KEY]
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed.length > 0) return trimmed
    }
  }
  if (isRecord(metadata)) {
    const raw = metadata[DOCKER_NETWORK_NAME_KEY]
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed.length > 0) return trimmed
    }
  }
  return null
}

export function buildNetworkDockerOptions(dockerNetworkName: string): Record<string, string> {
  return { [DOCKER_NETWORK_NAME_KEY]: dockerNetworkName.trim() }
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Absent (or `null`) addressing keys are simply absent — Docker picks. */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null
}

/** `ipRange` must be a CIDR nested inside the (already validated) subnet. */
function isValidIpRange(ipRange: string | null, subnet: string | undefined): ipRange is string {
  return !!ipRange && !!subnet && isValidCidr(ipRange) && cidrContains(subnet, ipRange)
}

/** `gateway` must be a bare address inside the (already validated) subnet. */
function isValidGateway(gateway: string | null, subnet: string | undefined): gateway is string {
  return !!gateway && !!subnet && !gateway.includes('/') && addressInCidr(gateway, subnet)
}

/**
 * Validate the addressing keys of a docker network `options` object.
 * `subnet` anchors the rest: an `ipRange` must sit inside it, a `gateway`
 * must be an address inside it, and neither is meaningful without it. `mtu`
 * stands alone. Absent (or `null`) keys are simply absent — Docker picks.
 */
export function validateDockerNetworkAddressing(
  options: Record<string, unknown>,
): { ok: true; addressing: DockerNetworkAddressing } | {
  ok: false
  reason: DockerNetworkOptionsRejection
} {
  const addressing: DockerNetworkAddressing = {}

  if (isSet(options.subnet)) {
    const subnet = trimmedString(options.subnet)
    if (!subnet || !isValidCidr(subnet)) {
      return { ok: false, reason: 'docker_network_subnet_invalid' }
    }
    addressing.subnet = subnet
  }

  if (isSet(options.ipRange)) {
    const ipRange = trimmedString(options.ipRange)
    if (!isValidIpRange(ipRange, addressing.subnet)) {
      return { ok: false, reason: 'docker_network_ip_range_invalid' }
    }
    addressing.ipRange = ipRange
  }

  if (isSet(options.gateway)) {
    const gateway = trimmedString(options.gateway)
    if (!isValidGateway(gateway, addressing.subnet)) {
      return { ok: false, reason: 'docker_network_gateway_invalid' }
    }
    addressing.gateway = gateway
  }

  if (isSet(options.mtu)) {
    if (!isValidDockerNetworkMtu(options.mtu)) {
      return { ok: false, reason: 'docker_network_mtu_invalid' }
    }
    addressing.mtu = options.mtu
  }

  return { ok: true, addressing }
}

/**
 * Normalize `options` for a `kind: docker` network row: trimmed name plus
 * validated addressing, every other key passed through. Returns the typed
 * rejection when the name is missing/invalid or an addressing key is bad.
 */
export function normalizeDockerNetworkOptionsStrict(
  options: Record<string, unknown> | null | undefined,
): { ok: true; options: Record<string, unknown> } | {
  ok: false
  reason: DockerNetworkOptionsRejection
} {
  const name = readNetworkDockerNetworkName(options ?? null, null)
  if (!name || !isValidDockerNetworkName(name)) {
    return { ok: false, reason: 'docker_network_name_required' }
  }
  const addressing = validateDockerNetworkAddressing(options ?? {})
  if (!addressing.ok) return addressing
  const normalized: Record<string, unknown> = {
    ...options,
    ...buildNetworkDockerOptions(name),
  }
  // Rewrite the addressing keys in trimmed form and drop explicit nulls so a
  // stored row never carries a half-cleared key.
  for (const key of ['subnet', 'ipRange', 'gateway', 'mtu'] as const) {
    if (addressing.addressing[key] === undefined) delete normalized[key]
    else normalized[key] = addressing.addressing[key]
  }
  return { ok: true, options: normalized }
}

/**
 * Normalize `options` for a `kind: docker` network row.
 * Returns null when `options.dockerNetworkName` is missing or invalid, or
 * when an addressing key does not validate.
 */
export function normalizeDockerNetworkOptions(
  options: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const normalized = normalizeDockerNetworkOptionsStrict(options)
  return normalized.ok ? normalized.options : null
}

/**
 * Resolve the addressing the daemon should create the network with. The
 * `cidr` column wins over `options.subnet` — it is the registry-visible
 * range and the routes keep the two in sync on write. `ipRange` / `gateway`
 * are dropped when they no longer sit inside the resolved subnet (a stale
 * pair from before a re-range) rather than handed to Docker to refuse.
 */
export function readNetworkDockerAddressing(
  cidr: string | null | undefined,
  options: unknown,
): DockerNetworkAddressing {
  const record = isRecord(options) ? options : {}
  const subnet = trimmedString(cidr) ?? trimmedString(record.subnet)
  const out: DockerNetworkAddressing = {}
  if (subnet && isValidCidr(subnet)) out.subnet = subnet
  const validated = validateDockerNetworkAddressing({
    ...record,
    subnet: out.subnet,
  })
  if (validated.ok) return validated.addressing
  // Partial salvage: keep the subnet and the MTU, drop the keys that no
  // longer agree with it.
  if (isValidDockerNetworkMtu(record.mtu)) out.mtu = record.mtu
  return out
}
