import type { Context } from 'hono'
import { alignedNetworkCidr, isValidCidr } from '../../lib/ip-address.ts'
import {
  isValidDockerNetworkName,
  normalizeDockerNetworkOptionsStrict,
  readNetworkDockerNetworkName,
} from '../../lib/docker-network-name.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { buildPatchUpdateFields, parseName, parseJsonbObject } from '../shared.ts'

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Operator-creatable kinds — `POST /networks` accepts only these.
 * `reserved` declares a range TurboPanel must never allocate from or accept
 * elsewhere (org-only scope, CIDR required, renamable + re-rangeable).
 */
export const NETWORK_KINDS = new Set(['datacenter', 'docker', 'reserved'])

/**
 * Kinds accepted by `?kind=` on `GET /networks`. Wider than
 * {@link NETWORK_KINDS}: `managed` rows are platform-allocated (never
 * operator-created) but must stay listable. `compose` stays out — those rows
 * are readable by id only.
 */
export const NETWORK_FILTER_KINDS = new Set([
  'datacenter',
  'docker',
  'managed',
  'reserved',
])

/** Kinds whose rows must always carry a CIDR (`network_single_scope_check`). */
export const CIDR_REQUIRED_KINDS = new Set(['datacenter', 'reserved'])

export function parseUuidQueryParam(
  c: Context,
  raw: string | undefined,
): string | undefined | Response {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  if (!UUID_RE.test(trimmed)) return c.json({ error: 'Invalid request' }, 400)
  return trimmed
}

export function resolveKindQueryFilter(c: Context): string | undefined | Response {
  const kindFilter = c.req.query('kind')?.trim()
  if (!kindFilter) return undefined
  if (!NETWORK_FILTER_KINDS.has(kindFilter)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return kindFilter
}

export function parseCreateOrganizationId(
  c: Context,
  body: Record<string, unknown>,
): string | Response {
  const orgIdRaw = body.organizationId
  if (typeof orgIdRaw !== 'string' || !UUID_RE.test(orgIdRaw)) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const contextOrgId = c.req.header(ORG_ID_HEADER)?.trim() ||
    c.req.query('organizationId')?.trim()
  if (contextOrgId && contextOrgId !== orgIdRaw) {
    return c.json({ error: 'organizationId mismatch' }, 400)
  }

  return orgIdRaw
}

export function parseNetworkKind(
  c: Context,
  body: Record<string, unknown>,
): string | Response {
  const kindRaw = body.kind
  if (typeof kindRaw !== 'string' || !NETWORK_KINDS.has(kindRaw)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return kindRaw
}

export function parseOptionalNameField(
  c: Context,
  body: Record<string, unknown>,
): string | null | Response {
  if (body.name === undefined) return null
  try {
    return parseName(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }
}

export function parseOptionalCidrField(
  c: Context,
  body: Record<string, unknown>,
): string | null | Response {
  if (body.cidr === undefined || body.cidr === null) return null
  if (typeof body.cidr !== 'string' || !isValidCidr(body.cidr)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return body.cidr.trim()
}

export type NetworkPatchFields = {
  name?: string | null
  cidr?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  updatedAt: string
}

export function applyCidrPatch(
  c: Context,
  body: Record<string, unknown>,
  patchFields: NetworkPatchFields,
): Response | null {
  if (body.cidr === undefined) return null
  if (body.cidr === null) {
    patchFields.cidr = null
    return null
  }
  if (typeof body.cidr === 'string' && isValidCidr(body.cidr)) {
    patchFields.cidr = body.cidr.trim()
    return null
  }
  return c.json({ error: 'Invalid request' }, 400)
}

function applyOptionsPatch(
  c: Context,
  body: Record<string, unknown>,
  kind: string,
  patchFields: NetworkPatchFields,
): Response | null {
  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult
  if (optionsResult === null) return null
  if (kind !== 'docker') {
    patchFields.options = optionsResult
    return null
  }
  // Only the name is checked here: the addressing keys are validated by
  // `applyDockerAddressingPatch` once the stored / patched `cidr` has been
  // merged into `options.subnet`, so an `ipRange` or `gateway` that relies on
  // the row's range is not refused before that range is known.
  const nameDenied = requireDockerNetworkName(c, optionsResult)
  if (nameDenied) return nameDenied
  patchFields.options = optionsResult
  return null
}

/**
 * `kind: docker` rows register long-lived host Docker networks for compose
 * `networks.*.external`. Require a valid `options.dockerNetworkName`; the
 * optional addressing keys (`subnet` / `ipRange` / `gateway` / `mtu`) are
 * validated together (`docker_network_*_invalid`).
 */
export function requireDockerNetworkOptions(
  c: Context,
  options: Record<string, unknown> | null,
): Record<string, unknown> | Response {
  const normalized = normalizeDockerNetworkOptionsStrict(options)
  if (!normalized.ok) {
    return c.json({ error: normalized.reason }, 400)
  }
  return normalized.options
}

/**
 * Name-only half of {@link requireDockerNetworkOptions}: refuse a docker
 * `options` object without a valid `dockerNetworkName` up front, leaving the
 * addressing keys for {@link reconcileDockerNetworkAddressing} once the
 * top-level / stored `cidr` has been merged into `options.subnet`.
 */
export function requireDockerNetworkName(
  c: Context,
  options: Record<string, unknown> | null,
): Response | null {
  const name = readNetworkDockerNetworkName(options, null)
  if (!name || !isValidDockerNetworkName(name)) {
    return c.json({ error: 'docker_network_name_required' }, 400)
  }
  return null
}

function optionsSubnet(options: Record<string, unknown>): string | null {
  const raw = options.subnet
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Keep `network.cidr` (the registry-visible range) and `options.subnet` (the
 * Docker-facing copy) in agreement on a `kind: docker` write. Either side may
 * be sent alone and the other is derived; a pair that disagrees is refused
 * rather than silently picking one. `clearingCidr` is the explicit
 * `cidr: null` patch — it also drops `options.subnet`, and is refused while
 * an `ipRange` / `gateway` would be left dangling without a subnet.
 */
export function reconcileDockerNetworkAddressing(
  c: Context,
  params: {
    cidr: string | null
    options: Record<string, unknown>
    clearingCidr?: boolean
  },
): { cidr: string | null; options: Record<string, unknown> } | Response {
  const options: Record<string, unknown> = { ...params.options }
  const subnet = optionsSubnet(options)
  let cidr = params.cidr

  if (params.clearingCidr) {
    if (options.ipRange !== undefined && options.ipRange !== null) {
      return c.json({ error: 'docker_network_subnet_required' }, 400)
    }
    if (options.gateway !== undefined && options.gateway !== null) {
      return c.json({ error: 'docker_network_subnet_required' }, 400)
    }
    delete options.subnet
    cidr = null
  } else if (cidr && subnet) {
    if (alignedNetworkCidr(cidr) !== alignedNetworkCidr(subnet)) {
      return c.json({ error: 'docker_network_subnet_mismatch' }, 400)
    }
    options.subnet = cidr
  } else if (cidr) {
    options.subnet = cidr
  } else if (subnet) {
    cidr = subnet
  }

  const normalized = requireDockerNetworkOptions(c, options)
  if (normalized instanceof Response) return normalized
  return { cidr, options: normalized }
}

export type ExistingNetworkAddressing = {
  cidr: string | null
  options: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Docker rows: a patch that touches `cidr` or `options` is reconciled against
 * the row as it stands, then both columns are written together:
 *
 * - `cidr` only → the stored options are kept and `options.subnet` is
 *   re-derived from the new range (a stale `ipRange` / `gateway` is refused);
 * - `options` only → an `options.subnet` re-ranges the row; without one the
 *   stored `cidr` is kept and mirrored back into `options.subnet`;
 * - both → they must agree (`docker_network_subnet_mismatch`).
 */
function applyDockerAddressingPatch(
  c: Context,
  body: Record<string, unknown>,
  patchFields: NetworkPatchFields,
  existing: ExistingNetworkAddressing | undefined,
): Response | null {
  if (body.cidr === undefined && body.options === undefined) return null
  // Without the stored row there is nothing to reconcile a cidr-only patch
  // against — the plain cidr patch stands (the route always passes it).
  if (existing === undefined && body.options === undefined) return null
  const clearingCidr = body.cidr === null
  const cidrOnly = body.cidr !== undefined && body.options === undefined
  const optionsOnly = body.cidr === undefined && body.options !== undefined
  let options: Record<string, unknown> = {}
  if (body.options === undefined) {
    const stored = existing?.options
    if (isRecord(stored)) options = { ...stored }
  } else {
    options = { ...patchFields.options }
  }
  let cidr = body.cidr === undefined
    ? existing?.cidr ?? null
    : patchFields.cidr ?? null
  if (cidrOnly) delete options.subnet
  if (optionsOnly && optionsSubnet(options)) cidr = null
  const reconciled = reconcileDockerNetworkAddressing(c, {
    cidr,
    options,
    clearingCidr,
  })
  if (reconciled instanceof Response) return reconciled
  patchFields.cidr = reconciled.cidr
  patchFields.options = reconciled.options
  return null
}

export function parseNetworkPatchFields(
  c: Context,
  body: Record<string, unknown>,
  kind: string,
  existing?: ExistingNetworkAddressing,
): NetworkPatchFields | Response {
  // `kind: managed` rows are platform-allocated and read-only: the name, CIDR
  // and `options.dockerNetworkName` all derive from the row itself, so any
  // operator patch would desync the registry from the on-host Docker network.
  // Refuse the whole body outright.
  if (kind === 'managed') {
    return c.json({ error: 'managed_network_immutable' }, 400)
  }

  let patchFields: NetworkPatchFields
  try {
    patchFields = buildPatchUpdateFields(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  if (body.name !== undefined) {
    try {
      patchFields.name = parseName(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }
  }

  // Site subnets and reserved ranges exist *because* of their CIDR — clearing
  // it would trip `network_single_scope_check`; refuse up front instead.
  if (body.cidr === null && CIDR_REQUIRED_KINDS.has(kind)) {
    return c.json({ error: 'network_cidr_required' }, 400)
  }

  const cidrDenied = applyCidrPatch(c, body, patchFields)
  if (cidrDenied) return cidrDenied

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult
  if (metadataResult !== null) patchFields.metadata = metadataResult

  const optionsDenied = applyOptionsPatch(c, body, kind, patchFields)
  if (optionsDenied) return optionsDenied

  if (kind === 'docker') {
    const addressingDenied = applyDockerAddressingPatch(
      c,
      body,
      patchFields,
      existing,
    )
    if (addressingDenied) return addressingDenied
  }

  return patchFields
}

/**
 * Docker rows come back name-checked but otherwise raw: the route hands them
 * to {@link reconcileDockerNetworkAddressing} with the top-level `cidr`,
 * which derives `options.subnet` *before* the strict addressing validation
 * runs — so `cidr` + `options.ipRange` / `options.gateway` without an
 * explicit `options.subnet` is accepted.
 */
export function parseCreateNetworkOptions(
  c: Context,
  body: Record<string, unknown>,
  kind: string,
): Record<string, unknown> | null | Response {
  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult
  if (kind !== 'docker') return optionsResult
  const nameDenied = requireDockerNetworkName(c, optionsResult)
  if (nameDenied) return nameDenied
  return optionsResult
}

export function rejectImmutableNetworkScopePatch(
  c: Context,
  body: Record<string, unknown>,
): Response | null {
  if (body.datacenterId !== undefined || body.serverId !== undefined) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return null
}
