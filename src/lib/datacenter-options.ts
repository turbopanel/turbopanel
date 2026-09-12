/**
 * Defensive parsers for `datacenter.options` jsonb fields used by the
 * client timezone, host-defaults, and routing-policy APIs.
 */

import {
  parseNtpDefaults,
  parseSshPort,
  type NtpDefaults,
} from './host-defaults.ts'

export type DatacenterOptions = {
  /** Datacenter-wide default timezone applied when a server has no override. */
  defaultServerTimezone?: string
  /**
   * When true, the datacenter default wins over org and per-server overrides
   * (unless another tier also enforces — datacenter is most specific).
   */
  enforceServerTimezone?: boolean
  /**
   * Preferred address family when choosing among a server's pins in this
   * datacenter. Absence implies default `'ipv6'` (RFC 6724 / RFC 8305). The
   * parser only returns the field when it was explicitly set to `'ipv6'` or
   * `'ipv4'`.
   */
  addressPreference?: 'ipv6' | 'ipv4'
  /**
   * Desired SSH listen port for member hosts that do not set a server override.
   * Omitted → inherit the organization default (then 22).
   */
  sshPort?: number
  /** Desired NTP client settings inherited by member servers. */
  ntp?: NtpDefaults
  /**
   * Routing-ladder rank among a server's datacenters — an integer in
   * `DATACENTER_PRIORITY_MIN`..`DATACENTER_PRIORITY_MAX`, **lower wins**.
   * Absence implies `DEFAULT_DATACENTER_PRIORITY`. The parser only returns the
   * field when it was explicitly set to an in-range integer.
   */
  priority?: number
  /**
   * Whether the datacenter's L2 is under the operator's control. Absence
   * implies `DEFAULT_DATACENTER_TRUSTED` (`true`); an untrusted datacenter is
   * one whose L2 the operator does not control (shared or provider-owned
   * segments). The parser only returns the field when it was explicitly set.
   */
  trusted?: boolean
}

/** Effective `priority` when `datacenter.options.priority` is absent. */
export const DEFAULT_DATACENTER_PRIORITY = 100
export const DATACENTER_PRIORITY_MIN = 0
export const DATACENTER_PRIORITY_MAX = 1000
/** Effective `trusted` when `datacenter.options.trusted` is absent. */
export const DEFAULT_DATACENTER_TRUSTED = true

/** Integer in range → the value; anything else → undefined (never clamps). */
export function parseDatacenterPriority(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < DATACENTER_PRIORITY_MIN || value > DATACENTER_PRIORITY_MAX) {
    return undefined
  }
  return value
}

/** Resolved policy fields the API surfaces beside the raw `options`. */
export type DatacenterPolicy = {
  priority: number
  trusted: boolean
}

/**
 * Effective routing policy: parsed `options` with documented defaults applied
 * (`priority` → `DEFAULT_DATACENTER_PRIORITY`, `trusted` → `DEFAULT_DATACENTER_TRUSTED`).
 * Accepts raw jsonb so callers can hand it a `datacenter.options` row value.
 */
export function resolveDatacenterPolicy(value: unknown): DatacenterPolicy {
  const options = parseDatacenterOptions(value)
  return {
    priority: options.priority ?? DEFAULT_DATACENTER_PRIORITY,
    trusted: options.trusted ?? DEFAULT_DATACENTER_TRUSTED,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse datacenter.options jsonb (missing/invalid keys → omitted). */
export function parseDatacenterOptions(value: unknown): DatacenterOptions {
  if (!isRecord(value)) return {}
  const options: DatacenterOptions = {}
  if (typeof value.defaultServerTimezone === 'string') {
    const trimmed = value.defaultServerTimezone.trim()
    if (trimmed.length > 0) options.defaultServerTimezone = trimmed
  }
  if (typeof value.enforceServerTimezone === 'boolean') {
    options.enforceServerTimezone = value.enforceServerTimezone
  }
  if (value.addressPreference === 'ipv6' || value.addressPreference === 'ipv4') {
    options.addressPreference = value.addressPreference
  }
  const sshPort = parseSshPort(value.sshPort)
  if (sshPort !== undefined) options.sshPort = sshPort
  const ntp = parseNtpDefaults(value.ntp)
  if (ntp) options.ntp = ntp
  const priority = parseDatacenterPriority(value.priority)
  if (priority !== undefined) options.priority = priority
  if (typeof value.trusted === 'boolean') options.trusted = value.trusted
  return options
}
