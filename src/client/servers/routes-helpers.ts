/**
 * Pure helpers for server routes — validation, response shaping, and
 * decision trees that do not need a Hono Context or live DB client.
 */

import {
  formatServerOsDisplay,
  parseServerOptions,
  resolveEffectiveServerTimezone,
  resolveServerResponseTimezone,
  resolveServerOsLogoKey,
  type ServerHardwareProfile,
  type ServerOptions,
  type ServerOsMetadata,
  type ServerTimeSync,
  type ServerHostResources,
  type ServerDockerMetadata,
  type ServerRuntimeMetadata,
} from '../../lib/db/server-metadata.ts'
import type { OrganizationOptions } from '../../lib/organization-options.ts'
import type { DatacenterOptions } from '../../lib/datacenter-options.ts'
import { parseName } from '../shared.ts'
import {
  isServerMachineClass,
  type MetricsDeploymentKind,
  type ServerMachineClass,
} from '../../daemon/metrics/capability-plan.ts'
import {
  colocatedServerUpdateBlockedReason,
  type ServerUpdateCommit,
} from './update-status.ts'
import {
  parseNtpDefaultsInput,
  parseSshPortInput,
  resolveEffectiveNtpDefaults,
  resolveEffectiveSshPort,
  type NtpDefaults,
} from '../../lib/host-defaults.ts'
import {
  DIRECT_ATTACH_SENTINEL,
  resolveServerAddress,
} from '../../lib/peer-address.ts'
import { parseServerIps } from '../../server-addresses.ts'

export const SERVER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const STATUS_CACHE_CONTROL = 'private, max-age=5'
export const STATUS_CACHE_MAX_AGE_MS = 5_000
export const UPDATE_CHANNEL = 'trunk' as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isServerUuid(value: unknown): value is string {
  return typeof value === 'string' && SERVER_UUID_RE.test(value)
}

export function buildBatchStatusCoalesceKey(
  userId: string,
  organizationId: string,
  visibleIds: string[],
): string {
  const sortedIds = [...visibleIds].sort((a, b) => a.localeCompare(b))
  return `${userId}:${organizationId}:${sortedIds.join(',')}`
}

export type BatchStatusCoalesceEntryLike = {
  expiresAt: number
  promise?: unknown
}

/** Keys whose cached result may be dropped (in-flight promises are kept). */
export function expiredBatchStatusCoalesceKeys(
  entries: Iterable<[string, BatchStatusCoalesceEntryLike]>,
  now: number,
): string[] {
  const expired: string[] = []
  for (const [key, entry] of entries) {
    if (entry.promise !== undefined) continue
    if (entry.expiresAt <= now) expired.push(key)
  }
  return expired
}

export function currentCommitFromDaemonBuild(
  daemonBuild:
    | { commit?: string; buildId?: string; builtAt?: string }
    | undefined,
): ServerUpdateCommit | null {
  return daemonBuild?.commit
    ? {
      commit: daemonBuild.commit,
      buildId: daemonBuild.buildId ?? '',
      builtAt: daemonBuild.builtAt ?? '',
    }
    : null
}

export type ServerPatchFields = {
  name?: string | null
  /** Pins `server.machine_class`; `null` clears the pin so ingest infers again. */
  machineClass?: ServerMachineClass | null
  options?: Omit<ServerOptions, 'sshPort' | 'ntp'> & {
    sshPort?: number | null
    ntp?: NtpDefaults | null
  }
  updatedAt: string
}

export type ServerRouteValidationError = {
  ok: false
  error: string
  status: 400
}

export type ServerDatacenterRef = {
  id: string
  name: string | null
}

/**
 * Unique datacenter memberships for a server list/detail DTO, sorted by id.
 */
export function shapeServerDatacenters(
  memberships: ReadonlyArray<{ datacenterId: string }>,
  displayNamesById: ReadonlyMap<string, string | null>,
): ServerDatacenterRef[] {
  const seen = new Set<string>()
  const out: ServerDatacenterRef[] = []
  for (const row of memberships) {
    if (seen.has(row.datacenterId)) continue
    seen.add(row.datacenterId)
    out.push({
      id: row.datacenterId,
      name: displayNamesById.get(row.datacenterId) ?? null,
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function invalidServerPatchRequest(): ServerRouteValidationError {
  return { ok: false, error: 'Invalid request', status: 400 }
}

function parseServerPatchName(
  body: Record<string, unknown>,
): { ok: true; name: string | null } | ServerRouteValidationError {
  try {
    return { ok: true, name: parseName(body) }
  } catch {
    return invalidServerPatchRequest()
  }
}

/**
 * Overlay sshPort / ntp onto parsed server options. `null` clears inherit.
 */
function parseServerPatchOptions(
  raw: unknown,
):
  | { ok: true; options: NonNullable<ServerPatchFields['options']> }
  | ServerRouteValidationError {
  const parsed = parseServerOptions(raw)
  if (!isRecord(raw) || parsed === null) {
    return invalidServerPatchRequest()
  }
  const options: NonNullable<ServerPatchFields['options']> = { ...parsed }
  if ('sshPort' in raw) {
    const sshPort = parseSshPortInput(raw.sshPort)
    if (!sshPort.ok) {
      return { ok: false, error: 'Invalid sshPort', status: 400 }
    }
    options.sshPort = sshPort.value
  }
  if ('ntp' in raw) {
    const ntp = parseNtpDefaultsInput(raw.ntp)
    if (!ntp.ok) {
      return { ok: false, error: 'Invalid ntp', status: 400 }
    }
    options.ntp = ntp.value
  }
  return { ok: true, options }
}

/**
 * Validate name / options / emptiness for a server PATCH body.
 * Datacenter membership is managed via IP pins, not server PATCH.
 */
export function parseServerPatchCore(
  body: Record<string, unknown>,
  updatedAt = new Date().toISOString(),
):
  | {
    ok: true
    patch: ServerPatchFields
  }
  | ServerRouteValidationError {
  const patch: ServerPatchFields = { updatedAt }

  if (body.name !== undefined) {
    const name = parseServerPatchName(body)
    if (!name.ok) return name
    patch.name = name.name
  }

  if (body.datacenterId !== undefined) {
    return invalidServerPatchRequest()
  }

  if (body.options !== undefined) {
    const options = parseServerPatchOptions(body.options)
    if (!options.ok) return options
    patch.options = options.options
  }

  if (body.machineClass !== undefined) {
    if (body.machineClass !== null && !isServerMachineClass(body.machineClass)) {
      return { ok: false, error: 'Invalid machineClass', status: 400 }
    }
    patch.machineClass = body.machineClass
  }

  if (
    patch.name === undefined &&
    patch.options === undefined &&
    patch.machineClass === undefined
  ) {
    return invalidServerPatchRequest()
  }

  return { ok: true, patch }
}

export function isHostingEnableTransition(
  previousOptions: ServerOptions | null,
  patch: ServerPatchFields,
): boolean {
  const wasHostingEnabled = previousOptions?.hosting?.enabled === true
  return patch.options?.hosting?.enabled === true && !wasHostingEnabled
}

export function isHostingDisableTransition(
  previousOptions: ServerOptions | null,
  patch: ServerPatchFields,
): boolean {
  const wasHostingEnabled = previousOptions?.hosting?.enabled === true
  return patch.options?.hosting?.enabled === false && wasHostingEnabled
}

export function hostingHierarchyFailedBody(): {
  error: string
  code: string
} {
  return {
    error: 'Failed to provision hosting hierarchy',
    code: 'hosting_hierarchy_failed',
  }
}

export type ServerDeletedPayload =
  | { ok: true; serverId: string; status: 200 }
  | {
    ok: false
    serverId: string
    deleted: true
    error: string
    status: 500
  }

export function serverDeletedPayload(
  serverId: string,
  purgeError: string | null,
): ServerDeletedPayload {
  if (purgeError) {
    return {
      ok: false,
      serverId,
      deleted: true,
      error: `Server deleted but daemon cell purge failed: ${purgeError}`,
      status: 500,
    }
  }
  return { ok: true, serverId, status: 200 }
}

export function queueServerUpdateHttpStatus(error: string): 403 | 404 {
  return error === colocatedServerUpdateBlockedReason() ? 403 : 404
}

export function emptyServersUpdatesPayload(): {
  ok: true
  channel: typeof UPDATE_CHANNEL
  target: null
  targetStatus: 'unknown'
  targetError: string
  servers: []
} {
  return {
    ok: true,
    channel: UPDATE_CHANNEL,
    target: null,
    targetStatus: 'unknown',
    targetError: 'Could not resolve trunk channel manifest',
    servers: [],
  }
}

export type TrunkTargetFields = {
  target: {
    commit: string
    buildId: string
    builtAt: string
    manifestUrl: string
  } | null
  targetStatus: 'ok' | 'unknown'
  targetError: string | undefined
}

export function resolveTrunkTargetFields(
  targetManifest: {
    commit: string
    buildId: string
    builtAt: string
    manifestUrl: string
  } | null,
): TrunkTargetFields {
  const target = targetManifest
    ? {
      commit: targetManifest.commit,
      buildId: targetManifest.buildId,
      builtAt: targetManifest.builtAt,
      manifestUrl: targetManifest.manifestUrl,
    }
    : null
  return {
    target,
    targetStatus: target ? 'ok' : 'unknown',
    targetError: target ? undefined : 'Could not resolve trunk channel manifest',
  }
}

export type BatchUpdateEligibility =
  | { ok: false; error: string }
  | { ok: true; updateAvailable: true }

/**
 * Decision tree for POST /servers/updates before enqueueing.
 * Caller still performs the manage check and queueServerUpdate.
 */
export function resolveBatchUpdateEligibility(params: Readonly<{
  connected: boolean
  colocated: boolean
  current: ServerUpdateCommit | null
  targetCommit: string | null
}>): BatchUpdateEligibility {
  if (!params.connected) {
    return { ok: false, error: 'Daemon not connected' }
  }
  if (params.colocated) {
    return { ok: false, error: colocatedServerUpdateBlockedReason() }
  }
  const updateAvailable = params.targetCommit
    ? params.current?.commit !== params.targetCommit
    : false
  if (!updateAvailable) {
    return {
      ok: false,
      error: params.targetCommit ? 'Up to date' : 'Target unavailable',
    }
  }
  return { ok: true, updateAvailable: true }
}

export function updateResetErrorStatus(message: string): 409 | 500 {
  return message === 'update in progress' ? 409 : 500
}

/**
 * Deferred update release for the dev-only prepare step (rebuild the local
 * daemon overlay before daemons install it). The projection was already marked
 * queued when the trigger was accepted; on success the envelope is enqueued and
 * the queued timestamp refreshed so the daemon gets the full request TTL after
 * the build. A failed prepare or enqueue lands as a failed update result.
 */
export async function runPreparedServerUpdate(params: {
  prepare: () => Promise<void>
  enqueue: () => Promise<void>
  markQueued: (queuedAt: string) => Promise<void>
  markFailed: (error: string, finishedAt: string) => Promise<void>
}): Promise<void> {
  try {
    await params.prepare()
  } catch (err) {
    await params.markFailed(
      `Dev daemon rebuild failed: ${errorMessageFromUnknown(err)}`,
      new Date().toISOString(),
    )
    return
  }
  try {
    await params.enqueue()
    await params.markQueued(new Date().toISOString())
  } catch (err) {
    await params.markFailed(
      errorMessageFromUnknown(err),
      new Date().toISOString(),
    )
  }
}

export function distinctNonEmptyIds(
  ids: Array<string | null | undefined>,
): string[] {
  return [
    ...new Set(
      ids.filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ]
}

export function errorMessageFromUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type PresenceLike = {
  connected?: boolean
  hostname?: string | null
  remoteAddress?: string | null
  /**
   * The daemon's stored peer address is the local-attach sentinel: it dialled
   * the Unix socket. `remoteAddress` is `null` in that case — the sentinel is
   * not an address — so this flag is the only surviving record of *how* the
   * daemon reached us.
   */
  directAttach?: boolean
  colocatedWithInstance?: boolean
  lastInboundAt?: string | null
  connectedAt?: string | null
  statusChangedAt?: string | null
  geo?: unknown
  os?: ServerOsMetadata | null
  resources?: ServerHostResources | null
  ips?: unknown
  timeSync?: ServerTimeSync | null
  docker?: ServerDockerMetadata | null
  /** Runtimes the daemon reports installed; `null` when it has not reported. */
  runtimes?: ServerRuntimeMetadata | null
  /** Operator hardware profile (sensor/NIC slots, hosting path); `null` when none are set. */
  hardwareProfile?: ServerHardwareProfile | null
}

export type ServerListTimezoneFields = {
  timezone: string | null
  timezoneSource: string | null
}

export type ServerHostDefaultsFields = {
  sshPort: number
  sshPortSource: string | null
  ntpDefaults: NtpDefaults | null
  ntpDefaultsSource: string | null
}

export function resolveServerTimezoneFields(
  rowOptions: unknown,
  orgOptions: OrganizationOptions | null | undefined,
  dcOptions: DatacenterOptions | null | undefined,
  observedTimezone: string | null | undefined,
): ServerListTimezoneFields {
  const effective = resolveServerResponseTimezone(
    resolveEffectiveServerTimezone(
      parseServerOptions(rowOptions),
      orgOptions ?? null,
      dcOptions,
    ),
    observedTimezone,
  )
  return {
    timezone: effective.timezone,
    timezoneSource: effective.source,
  }
}

export function resolveServerHostDefaultsFields(
  rowOptions: unknown,
  orgOptions: OrganizationOptions | null | undefined,
  dcOptions: DatacenterOptions | null | undefined,
): ServerHostDefaultsFields {
  const serverOptions = parseServerOptions(rowOptions)
  const ssh = resolveEffectiveSshPort(serverOptions, dcOptions, orgOptions)
  const ntp = resolveEffectiveNtpDefaults(serverOptions, dcOptions, orgOptions)
  return {
    sshPort: ssh.sshPort,
    sshPortSource: ssh.source,
    ntpDefaults: ntp.ntp,
    ntpDefaultsSource: ntp.source,
  }
}

export function shapeServerOsFields(os: ServerOsMetadata | null | undefined) {
  return {
    os: os ?? null,
    osDisplay: formatServerOsDisplay(os ?? null),
    osLogo: resolveServerOsLogoKey(os ?? null),
  }
}

/**
 * Co-location and transport are two different facts.
 *
 * A co-located daemon runs on the control plane's own host. On the
 * **self-hosted** runtime it also *reaches* the instance over the local Unix
 * socket, and `deno-ws.ts` stores the `__direct__` sentinel as its peer
 * address to say so — which is what `presence.directAttach` reports. On the
 * **hosted** runtime there is no socket to dial: the very same daemon
 * connects over HTTPS/WSS from an address, exactly like any remote one, and
 * that address is the right thing to show.
 *
 * So the transport is read from `directAttach`, narrowed by the deployment,
 * and never from `colocated`:
 *
 * - `colocated` does not force the sentinel. It used to, which labelled a
 *   co-located host on the hosted runtime "via Local Unix Socket" for a
 *   connection that never touched a socket.
 * - `directAttach` is ignored when the deployment is hosted. A sentinel can
 *   only have been written by the self-hosted transport, so on Workers it is
 *   necessarily a **stale** row left by a control plane that used to run on
 *   Deno — which is exactly what a development instance switching runtimes
 *   leaves behind. Believing it would pin the co-located host to the socket
 *   label until something else happened to rewrite the projection.
 */
export function shapeServerPresenceFields(
  live: PresenceLike | null | undefined,
  colocated: boolean,
  deployment: MetricsDeploymentKind = 'self-hosted',
) {
  const os = live?.os ?? null
  const ips = parseServerIps(live?.ips) ?? null
  const attachedOverSocket = deployment === 'self-hosted' && live?.directAttach === true
  // The wire address is not always the host's address: behind a co-located
  // reverse proxy, a Cloudflare Tunnel connector, or a forwarded port it is
  // the proxy's. `resolveServerAddress` reconciles it against the interfaces
  // the daemon reports so readers get one address that is actually the host's.
  const address = resolveServerAddress({
    remoteAddress: attachedOverSocket ? DIRECT_ATTACH_SENTINEL : live?.remoteAddress,
    ips,
  })
  return {
    connected: live?.connected ?? false,
    hostname: live?.hostname ?? null,
    remoteAddress: live?.remoteAddress ?? null,
    /** Best-known network address for this host; `null` until one is known. */
    address: address && address.source !== 'local' ? address.address : null,
    /** Which fact `address` came from: `observed` | `interface` | `local`. */
    addressSource: address?.source ?? null,
    addressScope: address && address.source !== 'local' ? address.scope : null,
    addressInterface: address?.interface ?? null,
    colocatedWithInstance: colocated,
    lastInboundAt: live?.lastInboundAt ?? null,
    connectedAt: live?.connectedAt ?? null,
    statusChangedAt: live?.statusChangedAt ?? null,
    geo: live?.geo ?? null,
    ...shapeServerOsFields(os),
    resources: live?.resources ?? null,
    ips: ips ?? live?.ips ?? null,
    timeSync: live?.timeSync ?? null,
    docker: live?.docker ?? null,
    runtimes: live?.runtimes ?? null,
    hardwareProfile: live?.hardwareProfile ?? null,
  }
}

export function shouldSkipProjectedUpdateRepair(
  projectedUpdate: { status?: string } | null | undefined,
): boolean {
  return projectedUpdate?.status !== 'updating'
}

export function repairedUpdateDoneProjection(params: Readonly<{
  requestId?: string
  channel?: string
  queuedAt?: string
  finishedAt: string
}>) {
  return {
    status: 'done' as const,
    requestId: params.requestId,
    channel: params.channel,
    queuedAt: params.queuedAt,
    finishedAt: params.finishedAt,
  }
}

export function repairedUpdateIdleProjection() {
  return { status: 'idle' as const }
}
