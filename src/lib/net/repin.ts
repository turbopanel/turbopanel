/**
 * Pure repin decision for datacenter membership pins.
 *
 * A pin (`ip.scope='datacenter' AND server_id`) is the single authority for a
 * server's private address inside a site subnet. When a daemon's reported
 * `resources.ips` moves (DHCP renewal, NIC swap, re-addressing), this module
 * decides — with no DB access — what should happen to each pin:
 *
 * - address still reported → nothing (and `clear_stale` when it was flagged);
 * - address gone, exactly one reported private address inside the pin's
 *   subnet and not already an `ip` row elsewhere in the org → `repin`;
 * - address gone, zero candidates → `mark_stale('address_gone_no_candidate')`;
 * - address gone, two or more candidates → `mark_stale('address_gone_ambiguous')`.
 *
 * At most one `repin` is emitted per `(serverId, networkId)`; a second pin in
 * the same subnet whose address disappeared is marked ambiguous instead of
 * racing for the same candidate. Family isolation is inherited from
 * {@link addressInCidr}, which rejects cross-family containment.
 *
 * The `ip.metadata` helpers here are the only readers / writers of the
 * `stale` and `repin` markers so every surface (apply pass, fan-out sweep,
 * `GET /ips`, `GET /datacenters/:id`) shares one shape.
 */

import { stripInetPrefixSuffix } from '../ip-address.ts'
import { resolveSubnetForAddress } from './datacenter-membership.ts'

export type RepinPinInput = {
  ipId: string
  serverId: string
  datacenterId: string
  networkId: string
  address: string
  /** Owning subnet CIDR (`network.cidr` for `ip.network_id`). */
  subnetCidr: string
  /** Whether the pin is currently flagged stale (`ip.metadata.stale`). */
  stale: boolean
}

export type RepinStaleReason =
  | 'address_gone_no_candidate'
  | 'address_gone_ambiguous'

export type RepinAction =
  | { kind: 'repin'; ipId: string; from: string; to: string }
  | { kind: 'mark_stale'; ipId: string; reason: RepinStaleReason }
  | { kind: 'clear_stale'; ipId: string }

export type DecideRepinActionsParams = Readonly<{
  pins: readonly RepinPinInput[]
  /** Daemon-reported private addresses, already normalized (no prefix). */
  reportedPrivateAddresses: readonly string[]
  /**
   * Org-wide `ip.address` values that are already taken by some other row.
   * Callers must exclude each pin's own address (a pin never blocks itself).
   */
  addressesInUse: ReadonlySet<string>
}>

function normalizeAddress(value: string): string {
  return stripInetPrefixSuffix(value.trim())
}

function claimKey(pin: RepinPinInput): string {
  return `${pin.serverId}:${pin.networkId}`
}

/** Reported private addresses inside the pin's subnet that no `ip` row holds. */
function candidateAddresses(
  pin: RepinPinInput,
  reported: readonly string[],
  addressesInUse: ReadonlySet<string>,
  claimedAddresses: ReadonlySet<string>,
): string[] {
  const subnet = [{ networkId: pin.networkId, cidr: pin.subnetCidr }]
  const out: string[] = []
  for (const address of reported) {
    if (addressesInUse.has(address) || claimedAddresses.has(address)) continue
    if (!resolveSubnetForAddress(subnet, address)) continue
    if (!out.includes(address)) out.push(address)
  }
  return out
}

export function decideRepinActions(
  params: DecideRepinActionsParams,
): RepinAction[] {
  const reported = [
    ...new Set(params.reportedPrivateAddresses.map(normalizeAddress)),
  ].filter((address) => address.length > 0)
  const reportedSet = new Set(reported)
  const claimedKeys = new Set<string>()
  const claimedAddresses = new Set<string>()
  const actions: RepinAction[] = []

  for (const pin of params.pins) {
    const current = normalizeAddress(pin.address)
    if (reportedSet.has(current)) {
      if (pin.stale) actions.push({ kind: 'clear_stale', ipId: pin.ipId })
      continue
    }

    const candidates = candidateAddresses(
      pin,
      reported,
      params.addressesInUse,
      claimedAddresses,
    )
    if (candidates.length === 0) {
      actions.push({
        kind: 'mark_stale',
        ipId: pin.ipId,
        reason: 'address_gone_no_candidate',
      })
      continue
    }
    const key = claimKey(pin)
    if (candidates.length > 1 || claimedKeys.has(key)) {
      actions.push({
        kind: 'mark_stale',
        ipId: pin.ipId,
        reason: 'address_gone_ambiguous',
      })
      continue
    }
    const to = candidates[0]
    if (!to || to === current) continue
    claimedKeys.add(key)
    claimedAddresses.add(to)
    actions.push({ kind: 'repin', ipId: pin.ipId, from: current, to })
  }

  return actions
}

// ---------------------------------------------------------------------------
// `ip.metadata` markers
// ---------------------------------------------------------------------------

export type IpPinStaleMetadata = {
  /** ISO timestamp the pin was first flagged. */
  since: string
  reason: RepinStaleReason
}

export type IpPinRepinMetadata = {
  /** ISO timestamp of the last automatic repin. */
  at: string
  /** Address the pin held before the repin. */
  from: string
  /**
   * Set by the apply pass and cleared by the maintenance sweep once the
   * datacenter routing fan-out for this pin has been enqueued.
   */
  pendingFanoutAt?: string
}

export type IpPinMetadata = {
  stale?: IpPinStaleMetadata
  repin?: IpPinRepinMetadata
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return Number.isNaN(Date.parse(value)) ? undefined : value
}

function parseStaleReason(value: unknown): RepinStaleReason | undefined {
  if (
    value === 'address_gone_no_candidate' ||
    value === 'address_gone_ambiguous'
  ) {
    return value
  }
  return undefined
}

function parseStaleMarker(value: unknown): IpPinStaleMetadata | undefined {
  if (!isRecord(value)) return undefined
  const since = parseIsoTimestamp(value.since)
  const reason = parseStaleReason(value.reason)
  if (!since || !reason) return undefined
  return { since, reason }
}

function parseRepinMarker(value: unknown): IpPinRepinMetadata | undefined {
  if (!isRecord(value)) return undefined
  const at = parseIsoTimestamp(value.at)
  if (!at) return undefined
  if (typeof value.from !== 'string') return undefined
  const from = normalizeAddress(value.from)
  if (!from) return undefined
  const pendingFanoutAt = parseIsoTimestamp(value.pendingFanoutAt)
  return {
    at,
    from,
    ...(pendingFanoutAt ? { pendingFanoutAt } : {}),
  }
}

/**
 * Parse the repin markers on an `ip.metadata` jsonb value. Fields are only
 * returned when explicitly and validly set; anything else reads as absent.
 */
export function parseIpPinMetadata(value: unknown): IpPinMetadata {
  if (!isRecord(value)) return {}
  const out: IpPinMetadata = {}
  const stale = parseStaleMarker(value.stale)
  if (stale) out.stale = stale
  const repin = parseRepinMarker(value.repin)
  if (repin) out.repin = repin
  return out
}

function baseMetadata(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {}
}

/**
 * Merge a `stale` marker into existing metadata, preserving unknown keys. A
 * pin that is already flagged keeps its original `since` so the marker reads
 * as "stale since first noticed", not "since the latest heartbeat".
 */
export function withStaleMetadata(
  existing: unknown,
  stale: IpPinStaleMetadata,
): Record<string, unknown> {
  const next = baseMetadata(existing)
  const previous = parseStaleMarker(next.stale)
  next.stale = { since: previous?.since ?? stale.since, reason: stale.reason }
  return next
}

/** Merge a `repin` marker into existing metadata and drop any `stale` flag. */
export function withRepinMetadata(
  existing: unknown,
  repin: IpPinRepinMetadata,
): Record<string, unknown> {
  const next = baseMetadata(existing)
  delete next.stale
  next.repin = repin
  return next
}

/** Existing metadata without its `stale` marker (unknown keys preserved). */
export function clearedStaleMetadata(existing: unknown): Record<string, unknown> {
  const next = baseMetadata(existing)
  delete next.stale
  return next
}

/** Existing metadata with `repin.pendingFanoutAt` removed (`repin.at` / `from` kept). */
export function clearedPendingFanoutMetadata(
  existing: unknown,
): Record<string, unknown> {
  const next = baseMetadata(existing)
  const repin = parseRepinMarker(next.repin)
  if (!repin) {
    delete next.repin
    return next
  }
  next.repin = { at: repin.at, from: repin.from }
  return next
}
