import type { Db } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  type FabricEnqueueResult,
  fabricEnqueueTypedError,
  type reconcileFabricMembership,
} from '../../lib/fabric/enqueue.ts'
import {
  type EndpointAddressCaches,
  FabricAllocationError,
  type FabricPathSummaryEntry,
  type FabricRecord,
  type FabricSegmentMaterial,
  type RelayRecord,
  type RelayRole,
  resolveRelayGlobalEndpointAddress,
} from '../../lib/db/fabric-records.ts'
import {
  parseFabricOptions,
  parseIpv4Cidr,
  RELAY_PREFIX_LENGTH,
} from '../../lib/fabric/cidr.ts'
import { PREFERRED_GATEWAY_IDS_MAX, resolveEffectiveAllowRelay } from '../../lib/fabric/policy.ts'
import { isValidCidr, isValidIpAddress } from '../../lib/ip-address.ts'
import { isValidWireguardPublicKey } from '../../lib/fabric/wg.ts'
import type { GatewayRelayReadyError } from '../../lib/net/datacenter-networks.ts'

export type FabricMembershipSecrets = Pick<
  Parameters<typeof reconcileFabricMembership>[0],
  'secretsConfig' | 'dataEncryptionSecrets'
>

export type RelayPatchReconcileFn = typeof reconcileFabricMembership

export type { RelayMetadata } from '../../lib/db/fabric-records.ts'

const ADVERTISED_CIDRS_MAX = 32
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type FabricPutBody = {
  ok: true
  enabled: boolean
  allowRelay?: boolean
  /** Replacement `fabric.options.containerPool` (IPv4, wide enough for one relay `/16`). */
  containerPool?: string
}

/**
 * The fabric container pool is deliberately IPv4-only (see the header of
 * `src/lib/fabric/cidr.ts`) and must fit at least one relay aggregate
 * (`RELAY_PREFIX_LENGTH`), otherwise `requireRelayPrefix` would exhaust on
 * the first relay.
 */
export function parseFabricContainerPoolField(
  value: unknown,
): FieldResult<string> {
  if (typeof value !== 'string') {
    return { ok: false, error: 'Invalid containerPool' }
  }
  const parsed = parseIpv4Cidr(value)
  if (!parsed || parsed.prefix > RELAY_PREFIX_LENGTH) {
    return { ok: false, error: 'Invalid containerPool' }
  }
  return { ok: true, value: value.trim() }
}

export function parseFabricPutBody(
  body: unknown,
): FabricPutBody | {
  ok: false
  error: string
} {
  if (!isPlainObject(body) || typeof body.enabled !== 'boolean') {
    return { ok: false, error: 'Invalid request' }
  }
  const parsed: FabricPutBody = {
    ok: true,
    enabled: body.enabled,
  }
  if (body.allowRelay !== undefined) {
    if (typeof body.allowRelay !== 'boolean') {
      return { ok: false, error: 'Invalid allowRelay' }
    }
    parsed.allowRelay = body.allowRelay
  }
  if (body.containerPool !== undefined) {
    const pool = parseFabricContainerPoolField(body.containerPool)
    if (!pool.ok) return pool
    parsed.containerPool = pool.value
  }
  return parsed
}

export type RelayPatchBody = {
  role?: RelayRole
  advertisedCidrs?: string[]
  keepalive?: number | null
  endpointAddress?: string | null
  presharedKey?: string | null
  allowRelay?: boolean | null
  preferredGatewayIds?: string[]
}

function parseRelayRoleField(value: unknown): FieldResult<RelayRole> {
  if (value !== 'gateway' && value !== 'member') {
    return { ok: false, error: 'Invalid role' }
  }
  return { ok: true, value }
}

function parseAdvertisedCidrsField(value: unknown): FieldResult<string[]> {
  if (!Array.isArray(value) || value.length > ADVERTISED_CIDRS_MAX) {
    return { ok: false, error: 'Invalid advertisedCidrs' }
  }
  const cidrs: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !isValidCidr(entry)) {
      return { ok: false, error: 'Invalid advertisedCidrs' }
    }
    cidrs.push(entry.trim())
  }
  return { ok: true, value: cidrs }
}

function parseKeepaliveField(value: unknown): FieldResult<number | null> {
  if (value === null) return { ok: true, value: null }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65_535
  ) {
    return { ok: false, error: 'Invalid keepalive' }
  }
  return { ok: true, value }
}

function parseEndpointAddressField(value: unknown): FieldResult<string | null> {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || !isValidIpAddress(value)) {
    return { ok: false, error: 'Invalid endpointAddress' }
  }
  return { ok: true, value }
}

function parseAllowRelayField(value: unknown): FieldResult<boolean | null> {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'boolean') {
    return { ok: false, error: 'Invalid allowRelay' }
  }
  return { ok: true, value }
}

function parsePreferredGatewayIdsField(value: unknown): FieldResult<string[]> {
  if (value === null) return { ok: true, value: [] }
  if (!Array.isArray(value) || value.length > PREFERRED_GATEWAY_IDS_MAX) {
    return { ok: false, error: 'Invalid preferredGatewayIds' }
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !UUID_RE.test(entry)) {
      return { ok: false, error: 'Invalid preferredGatewayIds' }
    }
    if (seen.has(entry)) continue
    seen.add(entry)
    ids.push(entry)
  }
  return { ok: true, value: ids }
}

function parsePresharedKeyField(value: unknown): FieldResult<string | null> {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || !isValidWireguardPublicKey(value)) {
    return { ok: false, error: 'Invalid presharedKey' }
  }
  return { ok: true, value }
}

function applyOptionalPatchField<K extends keyof RelayPatchBody>(
  patch: RelayPatchBody,
  key: K,
  raw: unknown,
  parse: (value: unknown) => FieldResult<Exclude<RelayPatchBody[K], undefined>>,
): { ok: true } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true }
  const parsed = parse(raw)
  if (!parsed.ok) return parsed
  patch[key] = parsed.value
  return { ok: true }
}

export function parseRelayPatchBody(
  body: unknown,
): { ok: true; patch: RelayPatchBody } | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: 'Invalid request' }

  const patch: RelayPatchBody = {}
  const role = applyOptionalPatchField(
    patch,
    'role',
    body.role,
    parseRelayRoleField,
  )
  if (!role.ok) return role
  const cidrs = applyOptionalPatchField(
    patch,
    'advertisedCidrs',
    body.advertisedCidrs,
    parseAdvertisedCidrsField,
  )
  if (!cidrs.ok) return cidrs
  const keepalive = applyOptionalPatchField(
    patch,
    'keepalive',
    body.keepalive,
    parseKeepaliveField,
  )
  if (!keepalive.ok) return keepalive
  const endpoint = applyOptionalPatchField(
    patch,
    'endpointAddress',
    body.endpointAddress,
    parseEndpointAddressField,
  )
  if (!endpoint.ok) return endpoint
  const psk = applyOptionalPatchField(
    patch,
    'presharedKey',
    body.presharedKey,
    parsePresharedKeyField,
  )
  if (!psk.ok) return psk
  const allowRelay = applyOptionalPatchField(
    patch,
    'allowRelay',
    body.allowRelay,
    parseAllowRelayField,
  )
  if (!allowRelay.ok) return allowRelay
  const preferred = applyOptionalPatchField(
    patch,
    'preferredGatewayIds',
    body.preferredGatewayIds,
    parsePreferredGatewayIdsField,
  )
  if (!preferred.ok) return preferred

  if (patch.role === 'member') {
    patch.advertisedCidrs = []
  }

  return { ok: true, patch }
}

export type RelayPatchUpdateFields = {
  role?: RelayRole
  advertisedCidrs?: string[]
  keepalive?: number | null
  endpointAddress?: string | null
  presharedKey?: string | null
  allowRelay?: boolean | null
  preferredGatewayIds?: string[]
}

export function relayPatchUpdateFields(
  patch: RelayPatchBody,
  sealedPresharedKey: string | null | undefined,
): RelayPatchUpdateFields {
  const fields: RelayPatchUpdateFields = {}
  if (patch.role) fields.role = patch.role
  if (patch.advertisedCidrs !== undefined) {
    fields.advertisedCidrs = patch.advertisedCidrs
  }
  if (patch.keepalive !== undefined) fields.keepalive = patch.keepalive
  if (patch.endpointAddress !== undefined) {
    fields.endpointAddress = patch.endpointAddress
  }
  if (sealedPresharedKey !== undefined) {
    fields.presharedKey = sealedPresharedKey
  }
  if (patch.allowRelay !== undefined) fields.allowRelay = patch.allowRelay
  if (patch.preferredGatewayIds !== undefined) {
    fields.preferredGatewayIds = patch.preferredGatewayIds
  }
  return fields
}

export function resolveSealedRelayPresharedKey(
  presharedKey: string | null | undefined,
  encrypt: ((plaintext: string) => Promise<string>) | null,
): Promise<string | null | undefined> {
  if (presharedKey === undefined) return Promise.resolve(undefined)
  if (presharedKey === null) return Promise.resolve(null)
  if (!encrypt) return Promise.resolve(undefined)
  return encrypt(presharedKey)
}

export function gatewayRelayReadyErrorResponse(
  gatewayError: GatewayRelayReadyError | null,
): Response | null {
  if (!gatewayError) return null
  return Response.json({ error: gatewayError.kind }, { status: 422 })
}

export function gatewayRolePatchErrorResponse(
  role: string,
  gatewayError: GatewayRelayReadyError | null,
): Response | null {
  if (role !== 'gateway') return null
  return gatewayRelayReadyErrorResponse(gatewayError)
}

export function preferredGatewayInvalidErrorResponse(): Response {
  return Response.json({ error: 'preferred_gateway_invalid' }, { status: 422 })
}

export function findByServerId<T extends { serverId: string }>(
  rows: readonly T[],
  serverId: string,
): T | undefined {
  return rows.find((row) => row.serverId === serverId)
}

export function preferredGatewayPatchErrorResponse(
  patch: Pick<RelayPatchBody, 'preferredGatewayIds' | 'role'>,
  relays: readonly RelayRecord[],
  serverId: string,
): Response | null {
  if (!patch.preferredGatewayIds) return null
  return preferredGatewayIdsErrorResponse(
    patch.preferredGatewayIds,
    relays,
    serverId,
    patch.role,
  )
}

export function bindSecretEncryptFn<T>(
  secrets: T | undefined,
  encrypt: (secrets: T, plaintext: string) => Promise<string>,
): ((plaintext: string) => Promise<string>) | null {
  if (!secrets) return null
  return (plaintext) => encrypt(secrets, plaintext)
}

export function preferredGatewayIdsErrorResponse(
  preferredGatewayIds: readonly string[],
  relays: readonly RelayRecord[],
  patchServerId: string,
  patchedRole: RelayRole | undefined,
): Response | null {
  if (preferredGatewayIds.length === 0) return null
  const gatewayServerIds = new Set<string>()
  for (const row of relays) {
    const role = row.serverId === patchServerId ? (patchedRole ?? row.role) : row.role
    if (role === 'gateway') gatewayServerIds.add(row.serverId)
  }
  for (const id of preferredGatewayIds) {
    if (!gatewayServerIds.has(id)) {
      return preferredGatewayInvalidErrorResponse()
    }
  }
  return null
}

export function fabricTypedEnqueueErrorResponse(
  results: readonly FabricEnqueueResult[],
): Response | null {
  const enqueueError = fabricEnqueueTypedError(results)
  if (!enqueueError) return null
  return Response.json({ error: enqueueError }, { status: 422 })
}

/** Map enable-organization fabric failures to stable API error codes. */
/**
 * 409 for every typed allocation failure an enable can raise
 * (`fabric_address_pool_exhausted` for the tp0 host range,
 * `fabric_prefix_pool_exhausted` for a container pool too small for the org's
 * relays), `fabric_cidr_unavailable` when no host range is free, 500 otherwise.
 */
export function fabricEnableErrorResponse(err: unknown): Response {
  if (err instanceof FabricAllocationError) {
    return Response.json({ error: err.kind }, { status: 409 })
  }
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('No free CIDR')) {
    return Response.json({ error: 'fabric_cidr_unavailable' }, { status: 409 })
  }
  if (message.includes('address pool exhausted')) {
    return Response.json({ error: 'fabric_address_pool_exhausted' }, {
      status: 409,
    })
  }
  return Response.json({ error: 'TurboFabric update failed' }, { status: 500 })
}

/** Stable 409 when TurboFabric is off but a relay/apply route requires it. */
export function fabricNotEnabledErrorResponse(): Response {
  return Response.json({ error: 'TurboFabric is not enabled' }, {
    status: 409,
  })
}

export async function enqueueRelayPatchReconcile(params: {
  session: { userId: string } | null | undefined
  commandQueue: CommandQueue | Response
  db: Db
  organizationId: string
  secrets: FabricMembershipSecrets
  reconcile: RelayPatchReconcileFn
}): Promise<Response | null> {
  if (params.commandQueue instanceof Response || !params.session) return null
  return fabricTypedEnqueueErrorResponse(
    await params.reconcile({
      db: params.db,
      commandQueue: params.commandQueue,
      actorType: 'user',
      actorId: params.session.userId,
      organizationId: params.organizationId,
      ...params.secrets,
    }),
  )
}

export type FabricRelayObserved = {
  lastHandshakeAt?: string
  transferRx?: number
  transferTx?: number
}

export type FabricRelayApiRow = {
  serverId: string
  address: string
  role: RelayRole
  advertisedCidrs: string[]
  resolvedAdvertisedCidrs: string[]
  keepalive: number | null
  endpointAddress: string | null
  resolvedEndpoint: string | null
  publicKey: string | null
  prefix: string
  hasPresharedKey: boolean
  segments: FabricSegmentMaterial[]
  observed: FabricRelayObserved | null
  allowRelay: boolean | null
  effectiveAllowRelay: boolean
  preferredGatewayIds: string[]
  gatewayEligible: boolean
  /** Diagnostics-only per-peer path summary. */
  paths: FabricPathSummaryEntry[]
}

export function observedForRelay(
  relays: readonly Pick<RelayRecord, 'publicKey' | 'metadata'>[],
  publicKey: string | null,
): FabricRelayObserved | null {
  if (!publicKey) return null
  let latestAt = ''
  let match: FabricRelayObserved | null = null
  for (const row of relays) {
    const observed = row.metadata.observed
    if (!observed?.at || !Array.isArray(observed.peers)) continue
    const peer = observed.peers.find((entry) => entry.publicKey === publicKey)
    if (!peer) continue
    if (latestAt && observed.at <= latestAt) continue
    latestAt = observed.at
    match = {
      ...(peer.lastHandshakeAt ? { lastHandshakeAt: peer.lastHandshakeAt } : {}),
      ...(peer.transferRx !== undefined ? { transferRx: peer.transferRx } : {}),
      ...(peer.transferTx !== undefined ? { transferTx: peer.transferTx } : {}),
    }
  }
  return match
}

/**
 * `resolvedEndpoint` for GET fabric: the operator pin, else a public address,
 * else `null`.
 *
 * GET lists every relay with no viewer/`self` pair, so this value has to be
 * meaningful from **anywhere**. Private datacenter pins are therefore excluded
 * — a LAN address published here read as a generic endpoint to callers in
 * other datacenters, who cannot route it. Source-aware detail (including LAN,
 * NAT, and gateway hops) lives on `paths[]`, which is stamped per source relay.
 */
export function resolveRelayEndpointOrNull(
  row: Pick<RelayRecord, 'serverId' | 'endpointAddress'>,
  caches: Pick<
    EndpointAddressCaches,
    'publicAddressByServer' | 'reportedByServer'
  >,
): string | null {
  return resolveRelayGlobalEndpointAddress(row, caches)
}

export function toFabricRelayApiRow(params: {
  relay: RelayRecord
  hasPresharedKey: boolean
  segments: FabricSegmentMaterial[]
  caches: EndpointAddressCaches
  relays: readonly RelayRecord[]
  resolvedAdvertisedCidrs: string[]
  orgAllowRelay?: boolean
}): FabricRelayApiRow {
  return {
    serverId: params.relay.serverId,
    address: params.relay.address,
    role: params.relay.role,
    advertisedCidrs: params.relay.advertisedCidrs,
    resolvedAdvertisedCidrs: params.resolvedAdvertisedCidrs,
    keepalive: params.relay.keepalive,
    endpointAddress: params.relay.endpointAddress,
    resolvedEndpoint: resolveRelayEndpointOrNull(params.relay, params.caches),
    publicKey: params.relay.publicKey,
    prefix: params.relay.prefix,
    hasPresharedKey: params.hasPresharedKey,
    segments: params.segments,
    observed: observedForRelay(params.relays, params.relay.publicKey),
    allowRelay: params.relay.allowRelay,
    effectiveAllowRelay: resolveEffectiveAllowRelay(
      params.orgAllowRelay === true,
      params.relay.allowRelay,
    ),
    preferredGatewayIds: params.relay.preferredGatewayIds,
    gatewayEligible: params.relay.role === 'gateway',
    paths: params.relay.metadata.paths?.entries ?? [],
  }
}

export function fabricSettingsResponse(
  record: FabricRecord | null,
  relays: FabricRelayApiRow[] = [],
): {
  enabled: boolean
  fabric?: {
    id: string
    cidr: string
    mtu: number
    allowRelay: boolean
    containerPool: string
  }
  relays: FabricRelayApiRow[]
} {
  if (!record) return { enabled: false, relays: [] }
  const options = parseFabricOptions(record.options)
  return {
    enabled: true,
    fabric: {
      id: record.id,
      cidr: record.cidr,
      mtu: options.mtu,
      allowRelay: options.allowRelay,
      containerPool: options.containerPool,
    },
    relays,
  }
}
