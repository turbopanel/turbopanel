import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { getManagedEngineSpec, isManagedEngineCode } from '../../lib/managed/index.ts'
import type { ManagedSettings } from '../../lib/managed/settings.ts'
import {
  defaultManagedRelease,
  describeManagedImage,
  isSameManagedSeries,
  type ManagedReleaseGate,
  resolveManagedImage,
} from '../../lib/managed/releases.ts'
import type { ManagedConnectionRole } from '../../lib/commands/schemas.ts'
import {
  managedIngressPortForEngine,
  resolveManagedIngressPorts,
} from '../../lib/managed/ingress-ports.ts'
import { type ManagedSslMode, resolveManagedSslMode } from '../../lib/managed/ssl.ts'
import {
  isManagedSqlAccessScope,
  type ManagedSqlAccessScope,
} from '../../lib/managed/access-scope.ts'
import { organization, server } from '../../lib/db/schema.ts'
import { parseOrganizationOptions } from '../../lib/organization-options.ts'
import { BadRequestError, parseName, requireStringField } from '../shared.ts'
import { USERNAME_RE } from '../principals/store.ts'
import { PRINCIPAL_APPLIED_SUFFIX_LENGTH } from '../../lib/naming.ts'
import { LOOPBACK_BIND, resolveManagedDialHost } from './access-address.ts'
import { resolveManagedEffectiveExposure } from './host-exposure.ts'
import type { ManagedContext } from './context.ts'
import { parseManagedRowOptions, type ManagedRowOptions } from './options.ts'
import { evaluateManagedPromoteLagGate } from '../../lib/managed/promote-lag.ts'
import { loadManagedStatusError } from './last-error.ts'
import { listManagedMembers, type ManagedMemberRow } from './members.ts'
import type { ManagedResidualMetadata } from './serialize.ts'

export { evaluateManagedPromoteLagGate }
export {
  type ManagedEffectiveExposure,
  resolveManagedEffectiveExposure,
} from './host-exposure.ts'

/** One reachable client endpoint on the shared ProxySQL frontend. */
export type ManagedAccessEndpoint = {
  scope: ManagedSqlAccessScope
  host: string
  port: number
}

/**
 * Scopes a client can actually dial, given what the frontend publishes.
 *
 * `public` publishes on all interfaces, so every narrower address is reachable
 * too and is worth showing an operator; a narrower scope publishes exactly one
 * address and must not imply the others exist.
 *
 * Input is the **host's** published scopes, not one cluster's request: the
 * shared ProxySQL publishes once for every cluster it fronts, so a cluster with
 * its own toggle off is genuinely dialable when a co-resident cluster is
 * exposed (see `./host-exposure.ts`). Reporting the cluster's own intent here
 * would tell an operator a reachable database is unreachable.
 */
function dialScopesForPublishedScopes(
  publishedScopes: readonly ManagedSqlAccessScope[],
): ManagedSqlAccessScope[] {
  const widest = publishedScopes[0]
  if (widest === undefined) return []
  if (widest !== 'public') return [...publishedScopes]
  return ['public', 'turbofabric', 'datacenter', 'local']
}

/**
 * Shared-ProxySQL client listener port for `serverId`.
 *
 * Read from the **server-owner** organization: the listener is configured by
 * whichever org owns the host, which is not necessarily the org of the project
 * asking for the endpoint (grant-placed cross-org projects).
 */
async function resolveListenerPortForServer(
  db: Db,
  params: Readonly<{
    serverId: string
    engineCode: string
    engineDefaultPort: number
  }>,
): Promise<number> {
  const [row] = await db
    .select({ organizationOptions: organization.options })
    .from(server)
    .innerJoin(organization, eq(server.organizationId, organization.id))
    .where(eq(server.id, params.serverId))
    .limit(1)
  return managedIngressPortForEngine(
    params.engineCode,
    params.engineDefaultPort,
    resolveManagedIngressPorts(
      parseOrganizationOptions(row?.organizationOptions).managedDatabase?.ports,
    ),
  )
}

/**
 * Every endpoint this cluster is reachable at, widest scope first.
 *
 * Empty when **no** cluster on the host is exposed: nothing is published to the
 * host at all, and co-located consumers dial the ProxySQL container over the
 * organization's managed network (see `resolveBindingEndpoint`) rather than any
 * host address.
 *
 * Non-empty for an unexposed cluster that shares a host with an exposed one —
 * that listener really does front it. Callers that need to distinguish "this
 * cluster asked for it" from "a neighbour did" read
 * {@link resolveManagedEffectiveExposure}.
 */
export async function resolveManagedAccessEndpoints(
  db: Db,
  params: Readonly<{
    serverId: string
    engineCode: string
    engineDefaultPort: number
    exposure: ManagedSettings['exposure']
  }>,
): Promise<ManagedAccessEndpoint[]> {
  const effective = await resolveManagedEffectiveExposure(db, {
    serverId: params.serverId,
    exposure: params.exposure,
  })
  const scopes = dialScopesForPublishedScopes(effective.scopes)
  if (scopes.length === 0) return []

  const port = await resolveListenerPortForServer(db, params)
  const endpoints: ManagedAccessEndpoint[] = []
  const seenHosts = new Set<string>()
  for (const scope of scopes) {
    const host = await resolveManagedDialHost(db, { serverId: params.serverId, scope })
    if (host === null || seenHosts.has(host)) continue
    seenHosts.add(host)
    endpoints.push({ scope, host, port })
  }
  return endpoints
}

/**
 * The single endpoint used for the primary DSN and the listener TLS SANs.
 *
 * Widest scope wins so the advertised host is the one an operator outside the
 * host can actually reach. Clusters on a host that publishes nothing keep
 * reporting loopback: the DSN shape stays useful, and the connection surface
 * separately reports that no host endpoint is published.
 *
 * `null` means "asked to be exposed, but no address resolved" — a real
 * misconfiguration worth surfacing rather than papering over with loopback.
 */
export async function resolveManagedConnectionListener(
  db: Db,
  params: Readonly<{
    serverId: string
    engineCode: string
    engineDefaultPort: number
    exposure: ManagedSettings['exposure']
  }>,
): Promise<{ host: string; port: number } | null> {
  const endpoints = await resolveManagedAccessEndpoints(db, params)
  const primary = endpoints[0]
  if (primary) return { host: primary.host, port: primary.port }
  if (params.exposure.enabled) return null

  return {
    host: LOOPBACK_BIND,
    port: await resolveListenerPortForServer(db, params),
  }
}

/**
 * Args for {@link resolveManagedConnectionListener} on GET …/managed/status.
 *
 * Returns null when the cluster is unplaced, uncatalogued, or has unreadable
 * options — the status route then falls back to residual `host`/`port`.
 */
export function managedStatusListenerParams(
  row: {
    serverId: string | null
    engine: string | null
    options: unknown
  } | null,
): {
  serverId: string
  engineCode: string
  engineDefaultPort: number
  exposure: ManagedSettings['exposure']
} | null {
  if (!row?.serverId) return null
  if (!row.engine || !isManagedEngineCode(row.engine)) return null
  const spec = getManagedEngineSpec(row.engine)
  if (!spec) return null
  const parsed = parseManagedRowOptions(spec, row.options)
  if (!parsed) return null
  return {
    serverId: row.serverId,
    engineCode: spec.engine,
    engineDefaultPort: spec.defaultPort,
    exposure: parsed.settings.exposure,
  }
}

type ManagedStatusContextRow = {
  id: string
  status: string | null
  serverId: string | null
  engine: string | null
  options: unknown
}

/** Members, failure text, and listener for GET …/managed/status. */
export async function loadManagedStatusSnapshot(
  db: Db,
  row: ManagedStatusContextRow | null,
  residual: ManagedResidualMetadata,
): Promise<{
  memberRows: ManagedMemberRow[]
  lastError: string | null
  listener: Awaited<ReturnType<typeof resolveManagedConnectionListener>>
}> {
  if (!row) {
    return { memberRows: [], lastError: null, listener: null }
  }

  const memberRows = await listManagedMembers(db, row.id)
  const lastError = await loadManagedStatusError(db, {
    managedId: row.id,
    status: row.status,
    residualError: residual.error ?? null,
    serverIds: [row.serverId, ...memberRows.map((entry) => entry.serverId)],
  })
  const listenerParams = managedStatusListenerParams(row)
  const listener = listenerParams
    ? await resolveManagedConnectionListener(db, listenerParams)
    : null
  return { memberRows, lastError, listener }
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function managedSessionPaths(): string[] {
  return [
    '/environments/:id/managed',
    '/environments/:id/managed/apply',
    '/environments/:id/managed/lifecycle',
    '/environments/:id/managed/root-password',
    '/environments/:id/managed/users',
    '/environments/:id/managed/users/:principalId',
    '/environments/:id/managed/users/:principalId/password',
    '/environments/:id/managed/databases',
    '/environments/:id/managed/databases/:databaseName',
    '/environments/:id/managed/status',
    '/environments/:id/managed/logs',
    '/environments/:id/managed/backups',
    '/environments/:id/managed/backups/:backupId',
    '/environments/:id/managed/backups/:backupId/restore',
    '/environments/:id/managed/members',
    '/environments/:id/managed/members/:memberId',
    '/environments/:id/managed/members/:memberId/promote',
    '/environments/:id/managed/members/:memberId/resync',
    '/organizations/:id/managed',
  ]
}

/**
 * Accept only `scope`. Retired `bind` and other keys reject the create.
 */
function parseCreateExposureScope(
  exposureRaw: Record<string, unknown>,
): ManagedSqlAccessScope | undefined | null {
  if (exposureRaw.bind !== undefined) return null
  if (exposureRaw.scope === undefined) return undefined
  if (!isManagedSqlAccessScope(exposureRaw.scope)) return null
  return exposureRaw.scope
}

function mergeCreateExposure(
  base: ManagedSettings['exposure'],
  exposureRaw: unknown,
): ManagedSettings['exposure'] | null | undefined {
  if (!isPlainObject(exposureRaw)) return undefined
  const scope = parseCreateExposureScope(exposureRaw)
  if (scope === null) return null
  const next = { ...base }
  if (typeof exposureRaw.enabled === 'boolean') {
    next.enabled = exposureRaw.enabled
  }
  if (scope !== undefined) next.scope = scope
  return next
}

export function mergeCreateSettings(
  spec: {
    defaultSettings: ManagedSettings
    parseSettings: (v: unknown) => ManagedSettings | null
  },
  body: Record<string, unknown>,
  /** Resolved catalog image from {@link parseManagedVersionSelection}. */
  image?: string,
): ManagedSettings | null {
  const base = spec.parseSettings(spec.defaultSettings)
  if (!base) return null

  const overrides: Record<string, unknown> = {}
  if (image !== undefined) overrides.image = image

  const exposure = mergeCreateExposure(base.exposure, body.exposure)
  if (exposure === null) return null
  if (exposure !== undefined) overrides.exposure = exposure

  if (Object.keys(overrides).length === 0) return base
  return spec.parseSettings({ ...base, ...overrides })
}

/** Requested engine series or image variant is not in the release catalog. */
export const MANAGED_VERSION_UNSUPPORTED_ERROR = 'managed_version_unsupported'

/** A cluster's engine series cannot change after create. */
export const MANAGED_SERIES_IMMUTABLE_ERROR = 'managed_series_immutable'

/**
 * Resolve create-time `engineSeries` / `imageVariant` to a catalog image.
 *
 * Both fields are optional — omitting them keeps the engine spec's default
 * image, which is how every existing client creates a cluster. `imageVariant`
 * alone selects that variant of the default series. An unknown series or
 * variant is a **422** rather than a generic settings rejection so the UI can
 * say which version was refused (an EOL, never-supported, or merely untested
 * major must not be creatable).
 *
 * Only **tested** series resolve. `gate.includeUntested` is the one explicit
 * opt-in — the catalog's own suites use it to prove an untested series is
 * refused by default rather than absent from the catalog.
 */
export function parseManagedVersionSelection(
  engine: string,
  body: Record<string, unknown>,
  gate?: ManagedReleaseGate,
):
  | { ok: true; image?: string }
  | { ok: false; error: string; status: 400 | 422 } {
  const seriesRaw = body.engineSeries
  const variantRaw = body.imageVariant
  if (seriesRaw === undefined && variantRaw === undefined) return { ok: true }

  if (seriesRaw !== undefined && typeof seriesRaw !== 'string') {
    return { ok: false, error: 'Invalid engineSeries', status: 400 }
  }
  if (variantRaw !== undefined && typeof variantRaw !== 'string') {
    return { ok: false, error: 'Invalid imageVariant', status: 400 }
  }

  const series = seriesRaw ?? defaultManagedRelease(engine, gate)?.series
  if (series === undefined) {
    return { ok: false, error: MANAGED_VERSION_UNSUPPORTED_ERROR, status: 422 }
  }

  const image = resolveManagedImage(engine, series, variantRaw, gate)
  if (image === undefined) {
    return { ok: false, error: MANAGED_VERSION_UNSUPPORTED_ERROR, status: 422 }
  }
  return { ok: true, image }
}

/**
 * Refuse a settings patch that moves an existing cluster to another engine
 * series.
 *
 * An engine refuses to start on a data directory written by a different major,
 * and cross-major replication is not a supported topology, so an in-place
 * series change would break the cluster rather than upgrade it. Changing the
 * base-OS variant within one series (`alpine` ↔ `debian`) is allowed. Series
 * migration is a separate managed service plus a data move, not a settings
 * edit.
 */
export function assertManagedSeriesUnchanged(
  spec: { defaultImage: string },
  currentSettings: ManagedSettings,
  nextSettings: ManagedSettings,
): { ok: false; error: string; status: 409 } | null {
  const current = currentSettings.image ?? spec.defaultImage
  const next = nextSettings.image ?? spec.defaultImage
  if (isSameManagedSeries(current, next)) return null
  return { ok: false, error: MANAGED_SERIES_IMMUTABLE_ERROR, status: 409 }
}

export function readInitialDatabase(spec: {
  parseSettings: (v: unknown) => ManagedSettings | null
  defaultSettings: ManagedSettings
}): string {
  const parsed = spec.parseSettings(spec.defaultSettings)
  if (parsed && typeof parsed === 'object' && 'initialDatabase' in parsed) {
    const initial = (parsed as Record<string, unknown>).initialDatabase
    if (typeof initial === 'string' && initial.length > 0) {
      return initial
    }
  }
  return 'defaultdb'
}

/**
 * Display-only server id for serialization/read paths — returns `null` when
 * neither `managed.server_id` nor the environment's placement is known.
 */
export function resolveManagedServerId(
  managedRow: { serverId: string | null },
  fallbackServerId: string | null,
): string | null {
  return managedRow.serverId ?? fallbackServerId
}

export function principalMetadata(metadata: unknown): Record<string, unknown> {
  if (
    typeof metadata === 'object' && metadata !== null &&
    !Array.isArray(metadata)
  ) {
    return metadata as Record<string, unknown>
  }
  return {}
}

export function isManagedRootPrincipal(metadata: unknown): boolean {
  return principalMetadata(metadata).managedRoot === true
}

/** Replication principal is platform-managed — never listed as a client login. */
export function isManagedReplicationPrincipal(metadata: unknown): boolean {
  return principalMetadata(metadata).managedReplication === true
}

export function serializeManagedUser(
  row: {
    id: string
    username: string
    appliedUsername: string
    metadata: unknown
    createdAt: string
  },
) {
  const meta = principalMetadata(row.metadata)
  const databases = Array.isArray(meta.databases)
    ? meta.databases.filter((entry): entry is string => typeof entry === 'string')
    : []
  const privileges = Array.isArray(meta.privileges)
    ? meta.privileges.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    id: row.id,
    username: row.username,
    appliedUsername: row.appliedUsername,
    databases,
    privileges,
    connectionRole: meta.connectionRole === 'read-only'
      ? ('read-only' as const)
      : ('read-write' as const),
    createdAt: row.createdAt,
  }
}

export function serializeContainerRow(row: {
  id: string
  serviceId: string
  serverId: string
  containerId: string | null
  containerName: string
  status: string
  role: string
  composeServiceName: string
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}) {
  return {
    id: row.id,
    serviceId: row.serviceId,
    serverId: row.serverId,
    containerId: row.containerId,
    containerName: row.containerName,
    status: row.status,
    role: row.role,
    composeServiceName: row.composeServiceName,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Login names reserved for platform-internal engine accounts: the engines'
 * real bootstrap/socket admins (`postgres`, `root`, `mysql`) and the
 * `superadmin` name held back for turbopanel internals. The exposed
 * administrative login is always the suffixed `postgres_<11 rand>`/`root_<11 rand>`
 * principal, so these bare names must never become client logins.
 */
const RESERVED_MANAGED_USERNAMES = new Set([
  'postgres',
  'root',
  'mysql',
  'superadmin',
])

export function parseManagedUserCreateFields(
  c: Context<AppEnv>,
  ctx: ManagedContext,
  body: Record<string, unknown>,
  options: ManagedRowOptions,
  /** Persisted cluster root username when known; falls back to spec preference. */
  rootUsername?: string,
  /**
   * Org randomized-usernames default: when on, the applied login gets a
   * `_<11>` suffix, so the short name must leave room for it within the
   * engine's identifier maxLength.
   */
  randomizeSuffix?: boolean,
):
  | {
    username: string
    databases: string[]
    privileges: string[]
    connectionRole: ManagedConnectionRole
  }
  | Response {
  const username = requireStringField(c, body, 'username')
  if (username instanceof Response) return username

  const effectiveRoot = rootUsername ?? ctx.spec.rootUsername
  const { pattern, maxLength } = ctx.spec.userOperations.identifier
  const maxShortLength = randomizeSuffix
    ? maxLength - PRINCIPAL_APPLIED_SUFFIX_LENGTH
    : maxLength
  if (
    !USERNAME_RE.test(username) ||
    !pattern.test(username) ||
    username.length > maxShortLength ||
    username === effectiveRoot ||
    RESERVED_MANAGED_USERNAMES.has(username.toLowerCase())
  ) {
    return c.json({ error: 'Invalid username' }, 400)
  }

  if (!Array.isArray(body.databases) || body.databases.length === 0) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const databases = body.databases.filter(
    (entry): entry is string => typeof entry === 'string',
  )
  if (
    databases.length === 0 ||
    databases.length !== body.databases.length ||
    !databases.every((name) => options.databases.includes(name))
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const privileges = Array.isArray(body.privileges)
    ? body.privileges.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (
    Array.isArray(body.privileges) &&
    privileges.length !== body.privileges.length
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const allowedPrivileges = new Set<string>(ctx.spec.userOperations.privileges)
  if (!privileges.every((entry) => allowedPrivileges.has(entry))) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const connectionRole = parseManagedConnectionRole(body.connectionRole)
  if (connectionRole === null) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  return { username, databases, privileges, connectionRole }
}

/** A `read-only` login was requested for a cluster with no read-eligible replica. */
export const MANAGED_NO_READ_TARGETS_ERROR = 'managed_no_read_targets'

export type ManagedReadOnlyLoginGuardError = {
  ok: false
  error: typeof MANAGED_NO_READ_TARGETS_ERROR
  status: 422
}

/**
 * Refuse a `read-only` login when the cluster has no read-eligible replica.
 * `read-write` is always allowed here.
 */
export function evaluateReadOnlyLoginTargets(
  connectionRole: ManagedConnectionRole,
  members: ReadonlyArray<{ role: string; readEligible: boolean }>,
): ManagedReadOnlyLoginGuardError | null {
  if (connectionRole !== 'read-only') return null
  const hasReadTarget = members.some(
    (member) => member.role === 'replica' && member.readEligible,
  )
  if (hasReadTarget) return null
  return { ok: false, error: MANAGED_NO_READ_TARGETS_ERROR, status: 422 }
}

/**
 * Same guard as {@link evaluateReadOnlyLoginTargets}, but loads members only
 * when a `read-only` login was requested.
 */
export async function evaluateReadOnlyLoginTargetsLazy(
  connectionRole: ManagedConnectionRole,
  loadMembers: () => Promise<
    ReadonlyArray<{ role: string; readEligible: boolean }>
  >,
): Promise<ManagedReadOnlyLoginGuardError | null> {
  if (connectionRole !== 'read-only') return null
  return evaluateReadOnlyLoginTargets(connectionRole, await loadMembers())
}

/**
 * Frontend hostgroup a login defaults to. Absent means `read-write` — the
 * historical behavior and the only safe default, since a `read-only` login is
 * useless (and provisioning is refused) when the cluster has no read-eligible
 * replica.
 */
export function parseManagedConnectionRole(
  value: unknown,
): ManagedConnectionRole | null {
  if (value === undefined || value === null) return 'read-write'
  if (value === 'read-write' || value === 'read-only') return value
  return null
}

export type ManagedRouteValidationError = {
  ok: false
  error: string
  status: 400 | 409 | 422
}

export type ManagedLifecycleAction = 'start' | 'stop' | 'restart'

export function parseManagedLifecycleAction(
  body: Record<string, unknown>,
):
  | { ok: true; action: ManagedLifecycleAction }
  | ManagedRouteValidationError {
  const action = body.action
  if (action !== 'start' && action !== 'stop' && action !== 'restart') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return { ok: true, action }
}

/**
 * Name parse for managed create — mirrors {@link parseName}
 * but returns a typed validation error instead of throwing.
 */
export function parseManagedCreateName(
  body: Record<string, unknown>,
):
  | { ok: true; name: string | null }
  | ManagedRouteValidationError {
  try {
    return { ok: true, name: parseName(body) }
  } catch (error) {
    if (error instanceof BadRequestError) {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    throw error
  }
}

/**
 * Merge PATCH `settings` onto current managed settings and re-validate via
 * the engine spec. Returns `null` when the merged shape is invalid.
 */
export function mergeManagedPatchSettings(
  spec: {
    parseSettings: (v: unknown) => ManagedSettings | null
  },
  currentSettings: ManagedSettings,
  body: Record<string, unknown>,
): ManagedSettings | null {
  return spec.parseSettings({
    ...currentSettings,
    ...(isPlainObject(body.settings) ? body.settings : {}),
  })
}

export function validateManagedDatabaseCreateName(
  name: string,
  databases: readonly string[],
  identifier: { pattern: RegExp; maxLength: number },
): ManagedRouteValidationError | null {
  if (!identifier.pattern.test(name) || name.length > identifier.maxLength) {
    return { ok: false, error: 'Invalid database name', status: 400 }
  }
  if (databases.includes(name)) {
    return { ok: false, error: 'database_exists', status: 409 }
  }
  return null
}

/** Narrow the false status union — delete-not-found uses HTTP 404. */
export type ManagedDatabaseDeleteError =
  | { ok: false; error: 'Not found'; status: 404 }
  | { ok: false; error: 'cannot_drop_initial_database'; status: 409 }

export function evaluateManagedDatabaseDelete(
  databaseName: string,
  databases: readonly string[],
  initialDatabase: string,
): ManagedDatabaseDeleteError | null {
  if (!databases.includes(databaseName)) {
    return { ok: false, error: 'Not found', status: 404 }
  }
  if (databaseName === initialDatabase) {
    return { ok: false, error: 'cannot_drop_initial_database', status: 409 }
  }
  return null
}

export function nextDatabasesAfterCreate(
  databases: readonly string[],
  name: string,
): string[] {
  return [...databases, name].sort((a, b) => a.localeCompare(b))
}

export function nextDatabasesAfterDelete(
  databases: readonly string[],
  databaseName: string,
): string[] {
  return databases.filter((entry) => entry !== databaseName)
}

export function parsePromoteForce(body: Record<string, unknown>): boolean {
  return body.force === true
}

export function parseDisasterRecoveryPromoteBody(
  body: Record<string, unknown>,
):
  | { ok: true; memberId: string }
  | { ok: false; error: 'Invalid request'; status: 400 } {
  if (body.confirm !== true) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (typeof body.memberId !== 'string' || body.memberId.length === 0) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return { ok: true, memberId: body.memberId }
}

export function parseMemberReadEligibleCreate(
  body: Record<string, unknown>,
): boolean {
  return body.readEligible === true
}

export function parseReplicaClassCreate(
  body: Record<string, unknown>,
):
  | { ok: true; replicaClass: 'failover' | 'read' }
  | ManagedRouteValidationError {
  if (body.replicaClass === undefined) {
    return { ok: true, replicaClass: 'failover' }
  }
  if (body.replicaClass === 'failover' || body.replicaClass === 'read') {
    return { ok: true, replicaClass: body.replicaClass }
  }
  return { ok: false, error: 'Invalid request', status: 400 }
}

export function parseMemberReadEligiblePatch(
  body: Record<string, unknown>,
): { ok: true; readEligible: boolean } | ManagedRouteValidationError {
  if (typeof body.readEligible !== 'boolean') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return { ok: true, readEligible: body.readEligible }
}

export type MemberPatchFields = {
  readEligible?: boolean
  replicaClass?: 'failover' | 'read'
}

export function parseMemberPatch(
  body: Record<string, unknown>,
): ({ ok: true } & MemberPatchFields) | ManagedRouteValidationError {
  const hasReadEligible = Object.hasOwn(body, 'readEligible')
  const hasReplicaClass = Object.hasOwn(body, 'replicaClass')
  if (!hasReadEligible && !hasReplicaClass) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  const patch: { ok: true } & MemberPatchFields = { ok: true }
  if (hasReadEligible) {
    if (typeof body.readEligible !== 'boolean') {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    patch.readEligible = body.readEligible
  }
  if (hasReplicaClass) {
    if (body.replicaClass !== 'failover' && body.replicaClass !== 'read') {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    patch.replicaClass = body.replicaClass
  }
  return patch
}

/**
 * Hard-delete is safe only when the cluster has no placement pin — there is
 * no host runtime to tear down. Stopped / failed / provisioning clusters can
 * still have Docker containers (lifecycle stop is non-destructive; apply may
 * have brought the engine up before failing).
 */
export function canHardDeleteManaged(
  serverId: string | null | undefined,
): boolean {
  return !serverId
}

export type ReplicaPlacementPrecheckError = {
  ok: false
  error: 'managed_member_exists'
  status: 409
}

/**
 * Pure prechecks before datacenter / private-endpoint / online probes.
 */
export function evaluateReplicaPlacementPrechecks(
  members: ReadonlyArray<{ serverId: string; role: string }>,
  serverId: string,
): ReplicaPlacementPrecheckError | null {
  if (members.some((m) => m.serverId === serverId)) {
    return { ok: false, error: 'managed_member_exists', status: 409 }
  }
  return null
}

export function replicaEndpointPurpose(
  replicaClass: 'failover' | 'read',
): 'failover-replication' | 'read-replication' {
  return replicaClass === 'read' ? 'read-replication' : 'failover-replication'
}

export type FailoverReplicaTransportError = {
  kind: 'failover_replica_requires_datacenter_transport'
}

/**
 * Failover replicas may only use local or datacenter transport — never
 * fabric/public.
 *
 * An untrusted shared datacenter is rejected **upstream** by the resolver
 * (`failover_requires_trusted_datacenter` from `resolvePrivateEndpoint`), so
 * a `datacenter` transport reaching this check is always trusted-derived.
 */
export function assertFailoverReplicaTransportAllowed(
  transport: 'local' | 'datacenter' | 'fabric' | 'public',
): FailoverReplicaTransportError | null {
  if (transport === 'fabric' || transport === 'public') {
    return { kind: 'failover_replica_requires_datacenter_transport' }
  }
  return null
}

/**
 * Whether placement still needs a ready datacenter CIDR after transport resolve.
 * Failover always needs a datacenter (fabric/public are rejected earlier).
 * Read replicas skip the CIDR check on fabric/public (already overlay/TLS).
 *
 * Only trusted-derived transports reach here: the resolver already refused an
 * untrusted-only failover pair with `failover_requires_trusted_datacenter`.
 */
export function replicaPlacementNeedsDatacenter(
  transport: 'local' | 'datacenter' | 'fabric' | 'public',
  replicaClass: 'failover' | 'read',
): boolean {
  if (replicaClass === 'failover') {
    return true
  }
  return transport !== 'fabric' && transport !== 'public'
}

export function evaluatePromoteMemberRole(
  role: string,
): ManagedRouteValidationError | null {
  if (role !== 'replica') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return null
}

export function evaluatePromoteReplicaClass(
  replicaClass: string | null,
): { ok: false; error: 'managed_replica_not_promotable'; status: 422 } | null {
  if (replicaClass !== 'failover') {
    return { ok: false, error: 'managed_replica_not_promotable', status: 422 }
  }
  return null
}

export type ReplicaClassConversionError =
  | { ok: false; error: 'Invalid request'; status: 400 }
  | {
    ok: false
    error: 'failover_replica_requires_datacenter_transport'
    status: 422
  }

/**
 * Class conversion: failover → read always allowed; read → failover requires
 * shared-datacenter placement to already have succeeded.
 */
export function evaluateReplicaClassConversion(
  member: Readonly<{ role: string; replicaClass: string | null }>,
  targetClass: 'failover' | 'read',
  placementOk: boolean,
): ReplicaClassConversionError | null {
  if (member.role !== 'replica') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (targetClass === 'read') return null
  if (!placementOk) {
    return {
      ok: false,
      error: 'failover_replica_requires_datacenter_transport',
      status: 422,
    }
  }
  return null
}

export type ManagedUserRotateGuardError =
  | { ok: false; error: 'use_root_password_route'; status: 400 }
  | { ok: false; error: 'cannot_rotate_replication_user'; status: 400 }

export function evaluateManagedUserRotateGuard(
  metadata: unknown,
): ManagedUserRotateGuardError | null {
  if (isManagedRootPrincipal(metadata)) {
    return { ok: false, error: 'use_root_password_route', status: 400 }
  }
  if (isManagedReplicationPrincipal(metadata)) {
    return { ok: false, error: 'cannot_rotate_replication_user', status: 400 }
  }
  return null
}

export function evaluateManagedUserDropGuard(
  metadata: unknown,
): { ok: false; error: 'cannot_drop_root_user'; status: 400 } | null {
  if (isManagedRootPrincipal(metadata)) {
    return { ok: false, error: 'cannot_drop_root_user', status: 400 }
  }
  return null
}

/**
 * Promote lag gate for HTTP — `force` bypasses. Returns the 409 error code
 * when blocked, else `null`.
 */
export function evaluatePromoteLagHttpGate(
  replication: unknown,
  force: boolean,
  nowMs?: number,
):
  | null
  | 'managed_replica_not_streaming'
  | 'managed_replica_lagging'
  | 'managed_replica_health_stale' {
  if (force) return null
  return evaluateManagedPromoteLagGate(replication, nowMs)
}

export type QueuedCommandFanoutRow = {
  commandId?: string
  serverId?: string
}

/**
 * Prefer the first fan-out row that already has a command id (primary), else
 * the first row — matches every managed enqueue response.
 */
export function pickPrimaryCommandResult<T extends QueuedCommandFanoutRow>(
  enqueued: readonly T[],
): T | undefined {
  return enqueued.find((r) => r.commandId) ?? enqueued[0]
}

export function buildQueuedFanoutResponse<T extends QueuedCommandFanoutRow>(
  enqueued: readonly T[],
  fallbackServerId: string,
): {
  ok: true
  results: readonly T[]
  commandId: string | undefined
  serverId: string
  status: 'queued'
} {
  const primary = pickPrimaryCommandResult(enqueued)
  return {
    ok: true as const,
    results: enqueued,
    commandId: primary?.commandId,
    serverId: primary?.serverId ?? fallbackServerId,
    status: 'queued' as const,
  }
}

/**
 * Detail shape for an environment whose managed row does not exist yet. `ssl`
 * is still resolved so the create surface can state the TLS policy a new
 * cluster will inherit instead of leaving it blank until after provisioning.
 * `rootUsername` is `null`: the administrative login (`postgres_<11 rand>` /
 * `root_<11 rand>`) is generated at create and unknowable before it.
 */
export function buildEmptyManagedDetailResponse(
  organizationSslMode?: ManagedSslMode | undefined,
) {
  return {
    managed: null,
    connection: null,
    endpoints: [] as const,
    exposure: null,
    settings: null,
    ssl: buildManagedSslView(undefined, organizationSslMode),
    release: null,
    server: null,
    rootUsername: null,
    members: [] as const,
    recovery: null,
  }
}

/**
 * `configured` is the service override (`null` = inheriting); `effective` is
 * what ProxySQL enforces and DSNs render, so the UI can label the inherit
 * option with what it resolves to without recomputing the hierarchy.
 */
export function buildManagedSslView(
  configured: ManagedSslMode | undefined,
  organizationDefault: ManagedSslMode | undefined,
) {
  return {
    configured: configured ?? null,
    effective: resolveManagedSslMode(configured, organizationDefault),
    organizationDefault: organizationDefault ?? null,
  }
}

export type ManagedReleaseView = {
  /** Operator-facing version (`18`, `9.7`, `12.3`). */
  series: string
  variantId: string
  lifecycle: string
  /**
   * False when the running series is catalogued but no longer creatable — the
   * UI surfaces it as unsupported rather than silently showing a normal version.
   */
  tested: boolean
  image: string
}

/**
 * Catalog identity of the image this cluster runs, derived rather than stored
 * so `settings.image` stays the single persisted source of truth. `null` when
 * the resolved image is outside the catalog (an engine with no catalog, or a
 * series retired after the row was written) — the UI then falls back to showing
 * the raw image.
 */
export function buildManagedReleaseView(
  spec: { defaultImage: string },
  settings: ManagedSettings,
): ManagedReleaseView | null {
  const image = settings.image ?? spec.defaultImage
  const descriptor = describeManagedImage(image)
  if (!descriptor) return null
  return {
    series: descriptor.series,
    variantId: descriptor.variantId,
    lifecycle: descriptor.lifecycle,
    tested: descriptor.tested,
    image,
  }
}

export function sortManagedBackupsDesc<T extends { createdAt: string }>(
  backups: readonly T[],
): T[] {
  return [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function findManagedBackupById<T extends { id: string }>(
  backups: readonly T[],
  backupId: string,
): T | undefined {
  return backups.find((entry) => entry.id === backupId)
}

/**
 * Status endpoint member row — same identity field as detail (`id`), not
 * `memberId`. The UI merges status onto detail by id; a different key
 * produced a ghost second "primary" with no React key.
 */
export function buildStatusMemberView(serialized: {
  id: string
  serverId: string
  role: string
  replicaClass?: string | null
  status: string | null
  replicationTransport: string | null
  privatePort: number | null
  replication?: unknown
}) {
  return {
    id: serialized.id,
    serverId: serialized.serverId,
    role: serialized.role,
    replicaClass: serialized.replicaClass ?? null,
    status: serialized.status,
    replicationTransport: serialized.replicationTransport,
    privatePort: serialized.privatePort,
    ...(serialized.replication !== undefined ? { replication: serialized.replication } : {}),
  }
}

export function buildManagedDestroyQueuedResponse(params: {
  commandId: string
  serverId: string
}) {
  return {
    ok: true as const,
    destroyCommandId: params.commandId,
    commandId: params.commandId,
    serverId: params.serverId,
    status: 'queued' as const,
  }
}

export function buildManagedDeleteHardResponse() {
  return { ok: true as const, deleted: true as const }
}

export function buildManagedDeleteQueuedResponse<
  T extends QueuedCommandFanoutRow,
>(
  enqueued: readonly T[],
  fallbackServerId: string,
) {
  const primary = pickPrimaryCommandResult(enqueued)
  return {
    ok: true as const,
    deleted: false as const,
    commandId: primary?.commandId,
    serverId: primary?.serverId ?? fallbackServerId,
    results: enqueued,
  }
}

export function buildFencePromotePendingResponse(params: {
  commandId: string
  serverId: string
}) {
  return {
    ok: true as const,
    commandId: params.commandId,
    serverId: params.serverId,
    status: 'queued' as const,
    fenceCommandId: params.commandId,
    promotePending: true as const,
  }
}

export function buildPromoteQueuedResponse(params: {
  commandId: string
  serverId: string
}) {
  return {
    ok: true as const,
    commandId: params.commandId,
    status: 'queued' as const,
    serverId: params.serverId,
  }
}

export type OperatorPromoteRecoveryInput =
  | { ok: false; error: string; status: 409 | 422 | 503 }
  | { ok: true; commandId: string; serverId: string; fencePending: boolean }

export type OperatorPromoteHttpResult =
  | { status: 409 | 422 | 503; body: { error: string } }
  | {
    status: 200
    body:
      | ReturnType<typeof buildFencePromotePendingResponse>
      | ReturnType<typeof buildPromoteQueuedResponse>
  }

/**
 * Map a switchover enqueue result onto the promote HTTP body. Extracted so
 * POST …/members/:memberId/promote stays under the route-handler complexity
 * budget.
 */
export function operatorPromoteHttpResult(
  recovery: OperatorPromoteRecoveryInput,
): OperatorPromoteHttpResult {
  if (!recovery.ok) {
    return { status: recovery.status, body: { error: recovery.error } }
  }
  const queued = {
    commandId: recovery.commandId,
    serverId: recovery.serverId,
  }
  if (recovery.fencePending) {
    return { status: 200, body: buildFencePromotePendingResponse(queued) }
  }
  return { status: 200, body: buildPromoteQueuedResponse(queued) }
}

export function buildDisasterRecoveryQueuedResponse(params: {
  commandId: string
  serverId: string
  fencePending: boolean
  lagBytes: number | null
  sourceMemberId: string
  sourceServerId: string
  sourceDatacenterId: string | null
  targetMemberId: string
  targetServerId: string
  targetDatacenterId: string | null
}) {
  return {
    ok: true as const,
    commandId: params.commandId,
    status: 'queued' as const,
    serverId: params.serverId,
    fencePending: params.fencePending,
    kind: 'disaster-recovery' as const,
    lagBytes: params.lagBytes,
    source: {
      memberId: params.sourceMemberId,
      serverId: params.sourceServerId,
      datacenterId: params.sourceDatacenterId,
    },
    target: {
      memberId: params.targetMemberId,
      serverId: params.targetServerId,
      datacenterId: params.targetDatacenterId,
    },
  }
}

type OrgManagedListEntryExtras = {
  engineDisplayName: string | null
  environmentDisplayName: string | null
  projectId: string
  projectDisplayName: string | null
  workspaceId: string
  workspaceDisplayName: string | null
  serverDisplayName: string | null
  members: unknown[]
}

export function buildOrgManagedListEntry<T extends Record<string, unknown>>(
  params: OrgManagedListEntryExtras & { serializedRow: T },
): T & OrgManagedListEntryExtras {
  return {
    ...params.serializedRow,
    engineDisplayName: params.engineDisplayName,
    environmentDisplayName: params.environmentDisplayName,
    projectId: params.projectId,
    projectDisplayName: params.projectDisplayName,
    workspaceId: params.workspaceId,
    workspaceDisplayName: params.workspaceDisplayName,
    serverDisplayName: params.serverDisplayName,
    members: params.members,
  }
}
