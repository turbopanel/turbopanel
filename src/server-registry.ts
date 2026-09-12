import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from './db.ts'
import { verifyDaemonLicense } from './daemon/authn/license.ts'
import {
  mergeServerHostResources,
  osColumnsEqual,
  osColumnsFromMetadata,
  parseServerOsMetadata,
  parseServerTimeSync,
  parseServerHostResources,
  parseServerDockerMetadata,
  parseServerRuntimeMetadata,
  serverHostResourcesEquals,
  serverDockerMetadataEquals,
  serverRuntimeMetadataEquals,
  timeSyncColumnPatch,
  type ServerMetadata,
  type ServerOsColumns,
  type ServerOsMetadata,
  type ServerTimeSync,
  type ServerTimeSyncColumns,
  type ServerHostResources,
  type ServerDockerMetadata,
  type ServerRuntimeMetadata,
} from './lib/db/server-metadata.ts'
import { license, server } from './lib/db/schema.ts'
import { recomputeAssignmentsForServer } from './lib/tiers/assignment-records.ts'
import { applyReportedAddressRepin } from './lib/net/repin-apply.ts'
import { serverIpsEquals } from './server-addresses.ts'
import { normalizeMachineKey } from './lib/machine-key.ts'
import { ensureSystemHierarchy } from './client/system/hierarchy.ts'
import { compatLogWarn } from './log-compat.ts'
import type { CommandQueue } from './lib/commands/queue.ts'
import { isNoopCommandQueue } from './lib/commands/noop-command-queue.ts'
import { reconcileFabricMembership } from './lib/fabric/enqueue.ts'
import type { DerivedSecretsConfig, SecretsConfig } from './client/authn/secrets.ts'

export type FabricMembershipDeps = {
  commandQueue: CommandQueue
  secretsConfig?: SecretsConfig
  dataEncryptionSecrets?: DerivedSecretsConfig
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function reconcileFabricMembershipBestEffort(
  db: Db,
  organizationId: string,
  serverId: string,
  fabricDeps?: FabricMembershipDeps,
): Promise<void> {
  if (!fabricDeps || isNoopCommandQueue(fabricDeps.commandQueue)) return
  try {
    await reconcileFabricMembership({
      db,
      commandQueue: fabricDeps.commandQueue,
      actorType: 'system',
      actorId: serverId,
      organizationId,
      ...(fabricDeps.secretsConfig ? { secretsConfig: fabricDeps.secretsConfig } : {}),
      ...(fabricDeps.dataEncryptionSecrets
        ? { dataEncryptionSecrets: fabricDeps.dataEncryptionSecrets }
        : {}),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    compatLogWarn(
      'server-registry',
      `reconcileFabricMembership failed for server ${serverId}: ${message}`,
    )
  }
}

export type ServerHelloIdentity = {
  serverId?: string
  machineKey?: string
  hostname?: string
  licenseId?: string
  licenseToken?: string
  os?: ServerOsMetadata
  resources?: ServerHostResources
  timeSync?: ServerTimeSync
  docker?: ServerDockerMetadata
  runtimes?: ServerRuntimeMetadata
}

function metadataPatch(identity: ServerHelloIdentity): Partial<ServerMetadata> {
  const patch: Partial<ServerMetadata> = {}
  const resources = parseServerHostResources(identity.resources)
  if (resources && Object.keys(resources).length > 0) {
    patch.resources = resources
  }
  const docker = parseServerDockerMetadata(identity.docker)
  if (docker) patch.docker = docker
  const runtimes = parseServerRuntimeMetadata(identity.runtimes)
  if (runtimes) patch.runtimes = runtimes
  return patch
}

function identityColumnPatch(identity: ServerHelloIdentity): {
  hostname?: string
  machineKey?: string
} {
  const patch: { hostname?: string; machineKey?: string } = {}
  const machineKey = normalizeMachineKey(identity.machineKey)
  const hostname = identity.hostname?.trim()
  if (machineKey) patch.machineKey = machineKey
  if (hostname) patch.hostname = hostname
  return patch
}

function emptyOsColumns(): ServerOsColumns {
  return {
    osId: null,
    osFamily: null,
    osVersion: null,
    osCodename: null,
    osPrettyName: null,
    osArchitecture: null,
  }
}

function emptyTimeSyncColumns(): ServerTimeSyncColumns {
  return {
    timezone: null,
    isTimeSyncEnabled: null,
    ntpServers: null,
    ntpLastSyncedAt: null,
  }
}

function identityOsColumnPatch(
  identity: ServerHelloIdentity,
  current: ServerOsColumns,
): ServerOsColumns | null {
  const os = parseServerOsMetadata(identity.os)
  if (!os) return null
  const next = osColumnsFromMetadata(os)
  return osColumnsEqual(next, current) ? null : next
}

function identityTimeSyncColumnPatch(
  identity: ServerHelloIdentity,
  current: ServerTimeSyncColumns,
  nowIso: string,
): Partial<ServerTimeSyncColumns> | null {
  const timeSync = parseServerTimeSync(identity.timeSync)
  if (!timeSync) return null
  return timeSyncColumnPatch(timeSync, current, nowIso)
}

/**
 * Pure merge of resources (incl. ips) / docker into `server.metadata` — no DB I/O.
 * Hostname, machineKey, OS, and time-sync are dedicated columns
 * (see {@link touchServerMetadata}). Returns null when nothing would change.
 */
export function mergeServerMetadataIdentity(
  current: ServerMetadata | null | undefined,
  identity: Pick<
    ServerHelloIdentity,
    'hostname' | 'machineKey' | 'os' | 'resources' | 'timeSync' | 'docker'
  >,
): ServerMetadata | null {
  const patch = metadataPatch(identity)
  if (Object.keys(patch).length === 0) return null

  const base = current ?? {}
  const next: ServerMetadata = { ...base }

  let changed = false
  if (patch.resources !== undefined) {
    const merged = mergeServerHostResources(base.resources, patch.resources)
    if (!serverHostResourcesEquals(merged, base.resources)) {
      next.resources = merged
      changed = true
    }
  }
  if (
    patch.docker !== undefined &&
    !serverDockerMetadataEquals(patch.docker, base.docker)
  ) {
    next.docker = patch.docker
    changed = true
  }
  if (
    patch.runtimes !== undefined &&
    !serverRuntimeMetadataEquals(patch.runtimes, base.runtimes)
  ) {
    next.runtimes = patch.runtimes
    changed = true
  }

  return changed ? next : null
}

function defaultDisplayName(_identity: ServerHelloIdentity): string | null {
  return null
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

function nowTs(): string {
  return new Date().toISOString()
}

/**
 * Diff identity patch against current metadata for a jsonb || merge.
 * Only keys that actually change are included so concurrent writers (e.g. geo)
 * are not wiped.
 */
function buildMetadataDelta(
  base: ServerMetadata | null | undefined,
  identity: ServerHelloIdentity,
): Partial<ServerMetadata> {
  const patch = metadataPatch(identity)
  const delta: Partial<ServerMetadata> = {}
  if (patch.resources !== undefined) {
    const merged = mergeServerHostResources(base?.resources, patch.resources)
    if (!serverHostResourcesEquals(merged, base?.resources)) {
      delta.resources = merged
    }
  }
  if (
    patch.docker !== undefined &&
    !serverDockerMetadataEquals(patch.docker, base?.docker)
  ) {
    delta.docker = patch.docker
  }
  if (
    patch.runtimes !== undefined &&
    !serverRuntimeMetadataEquals(patch.runtimes, base?.runtimes)
  ) {
    delta.runtimes = patch.runtimes
  }
  return delta
}

export async function touchServerMetadata(
  db: Db,
  serverId: string,
  identity: ServerHelloIdentity,
): Promise<void> {
  const rows = await db
    .select({
      metadata: server.metadata,
      hostname: server.hostname,
      machineKey: server.machineKey,
      osId: server.osId,
      osFamily: server.osFamily,
      osVersion: server.osVersion,
      osCodename: server.osCodename,
      osPrettyName: server.osPrettyName,
      osArchitecture: server.osArchitecture,
      timezone: server.timezone,
      isTimeSyncEnabled: server.isTimeSyncEnabled,
      ntpServers: server.ntpServers,
      ntpLastSyncedAt: server.ntpLastSyncedAt,
    })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const row = rows[0]
  if (!row) return

  const now = nowTs()
  const base = row.metadata as ServerMetadata | null | undefined
  const columns = identityColumnPatch(identity)
  const osPatch = identityOsColumnPatch(identity, {
    osId: row.osId ?? null,
    osFamily: row.osFamily ?? null,
    osVersion: row.osVersion ?? null,
    osCodename: row.osCodename ?? null,
    osPrettyName: row.osPrettyName ?? null,
    osArchitecture: row.osArchitecture ?? null,
  })
  const timePatch = identityTimeSyncColumnPatch(
    identity,
    {
      timezone: row.timezone ?? null,
      isTimeSyncEnabled: row.isTimeSyncEnabled ?? null,
      ntpServers: row.ntpServers,
      ntpLastSyncedAt: row.ntpLastSyncedAt ?? null,
    },
    now,
  )
  const metadataChanged = mergeServerMetadataIdentity(base, identity) !== null
  const hostnameChanged = Boolean(
    columns.hostname && columns.hostname !== row.hostname,
  )
  const machineKeyChanged = Boolean(
    columns.machineKey && columns.machineKey !== row.machineKey,
  )
  if (
    !metadataChanged &&
    !hostnameChanged &&
    !machineKeyChanged &&
    !osPatch &&
    !timePatch
  ) {
    return
  }

  const delta = buildMetadataDelta(base, identity)
  const update: Record<string, unknown> = { updatedAt: now }
  if (hostnameChanged) update.hostname = columns.hostname
  if (machineKeyChanged) update.machineKey = columns.machineKey
  if (osPatch) Object.assign(update, osPatch)
  if (timePatch) Object.assign(update, timePatch)
  if (Object.keys(delta).length > 0) {
    update.metadata = sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
      JSON.stringify(delta)
    }::jsonb`
  }

  await db.update(server).set(update).where(eq(server.id, serverId))

  // A hardware report can move the server's tier requirement: re-derive the
  // organization's assignment. Best-effort — a failure here must not reject
  // the hello, and the next session check recomputes again.
  if (delta.resources !== undefined) {
    await recomputeAssignmentsForServer(db, serverId).catch((err) => {
      console.warn(`tier assignment recompute failed for ${serverId}: ${String(err)}`)
    })
  }

  // Reported addresses moved: re-point / flag the server's datacenter
  // membership pins. Gated on `ips` specifically so a CPU / docker-only delta
  // never touches `ip` rows. Best-effort like the tier recompute. Nothing is
  // enqueued here — hello and Durable Object handlers must not enqueue
  // commands (DO cost rule, see `client/system/reconcile.ts`); the routing
  // fan-out for a repin is deferred to the maintenance sweep
  // (`client/datacenters/repin-fanout.ts`) via `ip.metadata.repin.pendingFanoutAt`.
  if (
    delta.resources?.ips !== undefined &&
    !serverIpsEquals(delta.resources.ips, base?.resources?.ips)
  ) {
    await applyReportedAddressRepin(db, serverId, delta.resources.ips).catch(
      (err) => {
        compatLogWarn(
          'server-registry',
          `membership repin failed for ${serverId}: ${String(err)}`,
        )
      },
    )
  }
}

async function findExistingServerId(
  db: Db,
  identity: ServerHelloIdentity,
): Promise<string | undefined> {
  const hinted = identity.serverId?.trim()
  if (hinted && UUID_RE.test(hinted)) {
    const existing = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, hinted))
      .limit(1)
    if (existing.length > 0) return existing[0].id
  }

  const machineKey = identity.machineKey?.trim()
  if (machineKey) {
    const byMachine = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.machineKey, machineKey))
      .limit(1)
    if (byMachine.length > 0) return byMachine[0].id
  }

  const hostname = identity.hostname?.trim()
  if (hostname) {
    const byHostname = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.hostname, hostname))
      .orderBy(server.createdAt)
      .limit(1)
    if (byHostname.length > 0) return byHostname[0].id
  }

  return undefined
}

/**
 * Find the single server already latched to this license (one-shot seats).
 */
async function findServerBoundToLicense(
  db: Db,
  licenseId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ serverId: license.serverId })
    .from(license)
    .where(eq(license.id, licenseId))
    .limit(1)
  return row?.serverId ?? undefined
}

/**
 * Resolve an existing server row to reuse for a licensed enrollment.
 *
 * Licenses are one-shot once a server latches onto them:
 *  - Re-enroll is allowed only when the daemon presents its persisted
 *    `serverId` and that row is already bound to *this* license.
 *  - A brand-new host with a already-bound license is rejected (caller gets
 *    null) — mint a new registration key via Add Server instead.
 *  - `machineKey` / `hostname` are never used for reuse: cloned VMs share
 *    `/etc/machine-id` (and the derived key) and often hostnames.
 */
async function findReusableLicensedServerId(
  db: Db,
  identity: ServerHelloIdentity,
  licenseId: string,
): Promise<string | undefined> {
  const boundServerId = await findServerBoundToLicense(db, licenseId)
  if (!boundServerId) return undefined

  const hinted = identity.serverId?.trim()
  if (hinted && UUID_RE.test(hinted) && hinted === boundServerId) {
    return boundServerId
  }

  // License already consumed by another (or unknown) server.
  return undefined
}

type ServerLicenseBinding = {
  licenseId: string | null
  organizationId: string | null
}

export async function getServerLicenseBinding(
  db: Db,
  serverId: string,
): Promise<ServerLicenseBinding | null> {
  const [serverRow] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (!serverRow) return null

  // Prefer an active bound license. When only a revoked latch remains, surface
  // that id so callers can fail closed with a clear inactive-license state.
  const [activeLicense] = await db
    .select({ id: license.id })
    .from(license)
    .where(and(eq(license.serverId, serverId), isNull(license.revokedAt)))
    .limit(1)
  if (activeLicense) {
    return {
      licenseId: activeLicense.id,
      organizationId: serverRow.organizationId,
    }
  }

  const [revokedLicense] = await db
    .select({ id: license.id })
    .from(license)
    .where(eq(license.serverId, serverId))
    .limit(1)

  return {
    licenseId: revokedLicense?.id ?? null,
    organizationId: serverRow.organizationId,
  }
}

/** Accept only the same license that already latched this server (or unbound). */
function credentialAuthorizedForServer(
  binding: ServerLicenseBinding,
  licenseId: string,
): boolean {
  if (!binding.licenseId) return true
  return binding.licenseId === licenseId
}

async function applyLicensedServerBinding(
  db: Db,
  serverId: string,
  identity: ServerHelloIdentity,
  organizationId: string,
): Promise<void> {
  const licenseId = identity.licenseId!.trim()
  const binding = await getServerLicenseBinding(db, serverId)
  if (!binding) return

  const now = nowTs()
  if (!binding.licenseId) {
    await db
      .update(license)
      .set({ serverId, updatedAt: now })
      .where(and(
        eq(license.id, licenseId),
        isNull(license.serverId),
        isNull(license.revokedAt),
      ))
    await db.update(server).set({
      organizationId,
      updatedAt: now,
    }).where(eq(server.id, serverId))
    return
  }

  if (binding.licenseId === licenseId && !binding.organizationId) {
    await db.update(server).set({
      organizationId,
      updatedAt: now,
    }).where(eq(server.id, serverId))
  }
}

/** Touch metadata and latch org/license when the credential matches this row. */
async function authorizeAndBindLicensedServer(
  db: Db,
  serverId: string,
  identity: ServerHelloIdentity,
  licenseId: string,
  organizationId: string,
): Promise<string | null> {
  const binding = await getServerLicenseBinding(db, serverId)
  if (!binding || !credentialAuthorizedForServer(binding, licenseId)) {
    return null
  }
  await touchServerMetadata(db, serverId, identity)
  await applyLicensedServerBinding(db, serverId, identity, organizationId)
  return serverId
}

/**
 * Insert a server then latch the license. If the license was already consumed
 * (concurrent enroll), delete the orphan server and throw unique violation so
 * the caller can take the race-reuse path.
 */
async function insertLicensedServer(
  db: Db,
  identity: ServerHelloIdentity,
  licenseId: string,
  organizationId: string,
): Promise<string> {
  const now = nowTs()
  const patch = metadataPatch(identity)
  const columns = identityColumnPatch(identity)
  const osPatch = identityOsColumnPatch(identity, emptyOsColumns())
  const timePatch = identityTimeSyncColumnPatch(
    identity,
    emptyTimeSyncColumns(),
    now,
  )
  const inserted = await db
    .insert(server)
    .values({
      organizationId,
      name: defaultDisplayName(identity),
      createdAt: now,
      updatedAt: now,
      ...(columns.hostname ? { hostname: columns.hostname } : {}),
      ...(columns.machineKey ? { machineKey: columns.machineKey } : {}),
      ...osPatch,
      ...timePatch,
      metadata: Object.keys(patch).length > 0 ? patch : null,
    })
    .returning({ id: server.id })

  const id = inserted[0]?.id
  if (!id) throw new Error('failed to insert server row')

  const latched = await db
    .update(license)
    .set({ serverId: id, updatedAt: now })
    .where(and(
      eq(license.id, licenseId),
      isNull(license.serverId),
      isNull(license.revokedAt),
    ))
    .returning({ id: license.id })

  if (latched.length === 0) {
    await db.delete(server).where(eq(server.id, id))
    const err = new Error('license already consumed') as Error & { code: string }
    err.code = '23505'
    throw err
  }

  return id
}

async function resolveLicensedServerId(
  db: Db,
  identity: ServerHelloIdentity,
  fabricDeps?: FabricMembershipDeps,
): Promise<string | null> {
  const licenseId = identity.licenseId?.trim()
  const licenseToken = identity.licenseToken?.trim()
  if (!licenseId || !licenseToken) return null

  const verified = await verifyDaemonLicense(db, licenseId, licenseToken)
  if (!verified) return null

  // Already latched: only the bound server may re-enroll (with matching serverId).
  const boundServerId = await findServerBoundToLicense(db, licenseId)
  if (boundServerId) {
    const reusable = await findReusableLicensedServerId(db, identity, licenseId)
    if (!reusable) return null
    return authorizeAndBindLicensedServer(
      db,
      reusable,
      identity,
      licenseId,
      verified.organizationId,
    )
  }

  try {
    const serverId = await insertLicensedServer(
      db,
      identity,
      licenseId,
      verified.organizationId,
    )
    // Best-effort: hierarchy failure must never block daemon enrollment.
    try {
      await ensureSystemHierarchy(db, {
        organizationId: verified.organizationId,
        serverId,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      compatLogWarn(
        'server-registry',
        `ensureSystemHierarchy failed for server ${serverId}: ${message}`,
      )
    }
    await reconcileFabricMembershipBestEffort(
      db,
      verified.organizationId,
      serverId,
      fabricDeps,
    )
    return serverId
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // Concurrent first enroll: the winner owns the license; only that server
    // may continue, and only when this caller presents the matching serverId.
    const raced = await findReusableLicensedServerId(db, identity, licenseId)
    if (!raced) return null
    return authorizeAndBindLicensedServer(
      db,
      raced,
      identity,
      licenseId,
      verified.organizationId,
    )
  }
}

/**
 * Resolve the canonical server.id (uuidv7) for a connecting daemon.
 * Reuses by serverId, `machine_key`, or `hostname` columns. Creates a row only
 * when a valid license is presented. Returns null for unknown servers without
 * a license.
 */
export async function resolveServerId(
  db: Db,
  identity: ServerHelloIdentity,
  fabricDeps?: FabricMembershipDeps,
): Promise<string | null> {
  if (identity.licenseId?.trim()) {
    return resolveLicensedServerId(db, identity, fabricDeps)
  }

  const existing = await findExistingServerId(db, identity)
  if (existing) {
    await touchServerMetadata(db, existing, identity)
    return existing
  }
  return null
}
