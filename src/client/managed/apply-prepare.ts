import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import { consumerServerIdsForManaged } from '../bindings/resolve-endpoint.ts'
import { ensureServerMonitorCredential } from './monitor-credential.ts'
import {
  decryptSecret,
  encryptSecret,
  ENVELOPE_PREFIX_SECRET,
  resealSecretForDaemon,
} from '../authn/data-encryption.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../authn/secrets.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../../daemon/authn/server-identity-db.ts'
import type {
  ManagedApplyCommandPayload,
  ManagedApplyOrgTlsMaterial,
} from '../../lib/commands/schemas.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import type { CommandType } from '../../lib/commands/types.ts'
import { TERMINAL_COMMAND_STATUSES } from '../../lib/commands/types.ts'
import {
  type CommandRecord,
  createCommandRecord,
  getCommandRecord,
  transitionCommand,
} from '../../lib/db/command-records.ts'
import { composeDocumentToYaml } from '../../lib/compose/convert.ts'
import type { ComposeDocument } from '../../lib/compose/types.ts'
import type { BuildRuntimeSpecInput, ManagedEngineSpec } from '../../lib/managed/index.ts'
import { DEFAULT_MANAGED_SQL_ACCESS_SCOPE } from '../../lib/managed/access-scope.ts'
import type { ManagedSettings } from '../../lib/managed/settings.ts'
import {
  isPrivateEndpointError,
  type PrivateEndpointError,
  privateEndpointErrorResponse,
  resolvePrivateEndpoint,
  resolvePrivateEndpoints,
} from '../../lib/net/private-endpoint.ts'
import { ensureOrganizationManagedNetwork } from '../../lib/db/fabric-records.ts'
import { managed, principal, server as serverTable, tls } from '../../lib/db/schema.ts'
import {
  issueLeafCertificate,
  metadataFromParsed,
  mintOrganizationCa,
  splitTlsMetadata,
} from '../../lib/tls/index.ts'
import type { Db } from '../../db.ts'
import {
  isManagedAccessAddressError,
  resolveManagedBindAddress,
} from './access-address.ts'
import {
  ensureManagedReplicationPrincipal,
  listManagedPrincipals,
  REPLICATION_PASSWORD_LENGTH,
  setPrincipalPassword,
} from '../principals/store.ts'
import { loadRandomizedUsernamesDefault } from './org-defaults.ts'
import { generatePassword } from '../../generate-secret.ts'
import {
  loadOrganizationCaSet,
  nextOrganizationCaGeneration,
  type OrganizationCaSet,
} from '../tls/organization-ca.ts'
import {
  organizationCaLeafNotAfterIso,
  pendingTlsLeafMetadata,
  type UpsertTlsLeafTrackingParams,
} from '../tls/leaf-tracking.ts'
import { isOrganizationCaUniqueViolation } from '../tls/routes-helpers.ts'
import { ensureManagedIngressHierarchy } from '../system/hierarchy.ts'
import { ensureManagedContainerAllocation } from './allocate-managed-container.ts'
import { enqueueManagedIngressReconcile } from './ingress-desired.ts'
import {
  ensureManagedPrimaryMember,
  ensureMemberPrivatePorts,
  isManagedPrivatePortExhaustedError,
  listManagedMembers,
  type ManagedMemberPeer,
  type ManagedMemberRow,
  replicationPurposeForMemberPair,
  resolvePeersForMember,
  updateMemberReplicationTransport,
} from './members.ts'
import { parseManagedResidual } from './serialize.ts'
import {
  MANAGED_DESTROY_GATE_METADATA_KEY,
  type ManagedDestroyGate,
} from './destroy-gate.ts'

export {
  MANAGED_DESTROY_GATE_CLAIM_KEY,
  MANAGED_DESTROY_GATE_METADATA_KEY,
  type ManagedDestroyGate,
  parseManagedDestroyGate,
  type PendingManagedDestroy,
} from './destroy-gate.ts'

const APPLY_EXPIRES_MS = 600_000
/** Polling cadence while awaiting primary apply before standby enqueue. */
const COMMAND_AWAIT_POLL_MS = 1_000

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait until a command row is terminal or the timeout elapses.
 *
 * **Not for request paths.** Multi-step managed fan-outs sequence themselves
 * through command metadata and the consumer's follow-up handling
 * (`pendingStandbyApplies`, `managedDestroyGate`) so an HTTP handler returns as
 * soon as the work is durably enqueued. This helper remains for out-of-band
 * callers (scripts, tests) that genuinely want to block on one command.
 */
export async function awaitCommandTerminal(
  db: Db,
  commandId: string,
  options?: {
    timeoutMs?: number
    pollMs?: number
    loadCommand?: (db: Db, commandId: string) => Promise<CommandRecord | null>
    sleep?: (ms: number) => Promise<void>
  },
): Promise<CommandRecord | null> {
  const timeoutMs = options?.timeoutMs ?? APPLY_EXPIRES_MS
  const pollMs = options?.pollMs ?? COMMAND_AWAIT_POLL_MS
  const loadCommand = options?.loadCommand ?? getCommandRecord
  const sleep = options?.sleep ?? sleepMs
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = await loadCommand(db, commandId)
    if (record && TERMINAL_COMMAND_STATUSES.has(record.status)) {
      return record
    }
    await sleep(pollMs)
  }
  return await loadCommand(db, commandId)
}

function isPrimaryMemberPayload(
  member: PreparedManagedMemberApply,
): boolean {
  if (member.payload.memberRole === 'primary') return true
  if (member.payload.replication?.role === 'primary') return true
  // Single-member / payloads without replication treat as primary.
  if (!member.payload.replication) return true
  return false
}

function metadataForManagedApplyMember(
  member: PreparedManagedMemberApply,
  extraMetadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const pending = member.pendingTlsLeaf
    ? pendingTlsLeafMetadata(member.pendingTlsLeaf)
    : {}
  const merged = { ...extraMetadata, ...pending }
  return Object.keys(merged).length > 0 ? merged : undefined
}

async function enqueueOneManagedApplyMember(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    member: PreparedManagedMemberApply
    extraMetadata?: Record<string, unknown>
  },
): Promise<ManagedApplyEnqueueResult> {
  const { member } = params
  const expiresAt = new Date(Date.now() + APPLY_EXPIRES_MS).toISOString()
  const metadata = metadataForManagedApplyMember(member, params.extraMetadata)
  try {
    const record = await createCommandRecord(db, {
      serverId: member.serverId,
      actorType: 'user',
      actorId: params.userId,
      type: 'managed.apply',
      payload: member.payload,
      expiresAt,
      ...(metadata ? { metadata } : {}),
    })
    const envelope: CommandEnvelope = {
      commandId: record.id,
      serverId: member.serverId,
      type: 'managed.apply',
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    }
    try {
      await commandQueue.enqueue(envelope)
      return {
        memberId: member.memberId,
        serverId: member.serverId,
        commandId: record.id,
        status: 'queued',
      }
    } catch {
      await transitionCommand(db, record.id, {
        status: 'failed',
        error: 'Command queue unavailable',
      })
      return {
        memberId: member.memberId,
        serverId: member.serverId,
        status: 'failed',
        error: 'Command queue unavailable',
      }
    }
  } catch (err) {
    return {
      memberId: member.memberId,
      serverId: member.serverId,
      status: 'failed',
      error: err instanceof Error ? err.message : 'enqueue failed',
    }
  }
}

export type ManagedApplyPrepareError =
  | { kind: 'datacenter_ip_required'; serverId: string }
  | { kind: 'fabric_address_required'; serverId: string }
  | { kind: 'daemon_key_unavailable'; serverId: string }
  | { kind: 'managed_credential_not_sealed' }
  | { kind: 'managed_settings_invalid' }
  | { kind: 'managed_primary_missing' }
  | { kind: 'managed_private_port_exhausted'; serverId: string }
  /**
   * Peers of one member would dial it on more than one address/transport, and
   * the wire payload carries a single `privateListener` bind. Rejected instead
   * of publishing a bind half the cluster cannot reach.
   */
  | { kind: 'managed_listener_bind_conflict'; serverId: string }
  | PrivateEndpointError

export type BuildManagedApplyInput = {
  managedRow: {
    id: string
    metadata?: unknown
    engine?: string | null
    serverId?: string | null
  }
  spec: ManagedEngineSpec
  settings: ManagedSettings
  databases: string[]
  /** Primary pin — the server `ensureManagedPrimaryMember` binds the primary to. */
  serverId: string
  environmentId: string
  /** Org that owns the managed service (and the org CA library). */
  organizationId: string
  /** Cluster root login when persisted; else `spec.rootUsername` preference. */
  rootUsername?: string
  dropUsers?: string[]
  dropDatabases?: string[]
  /** Principals to omit from credentials (e.g. about-to-be-deleted users). */
  omitPrincipalIds?: string[]
  /**
   * Members to omit from this prepare (e.g. a replica being destroyed).
   * Shrinks primary `desiredSlots` / peers before the row is deleted.
   */
  excludeMemberIds?: string[]
  /**
   * Standby members whose payloads carry `forceResync: true` — the daemon
   * wipes and re-seeds their data directory (operator resync action).
   */
  forceResyncMemberIds?: string[]
}

export type PreparedManagedMemberApply = {
  memberId: string
  serverId: string
  payload: ManagedApplyCommandPayload
  /** Minted engine leaf; committed to `leaf` only after command success. */
  pendingTlsLeaf?: UpsertTlsLeafTrackingParams
}

export type ManagedApplyEnqueueResult = {
  memberId: string
  serverId: string
  commandId?: string
  status: 'queued' | 'failed'
  error?: string
}

/**
 * Verify daemon-key + bind resolution before generating show-once passwords or
 * committing irreversible managed mutations. Does not require principals to exist.
 */
export async function preflightManagedApplyInfrastructure(
  c: Context<AppEnv>,
  db: Db,
  params: {
    serverId: string
    scope: ManagedSettings['exposure']['scope']
  },
): Promise<ManagedApplyPrepareError | null> {
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!secretsConfig || !dataEncryptionSecrets) {
    return { kind: 'daemon_key_unavailable', serverId: params.serverId }
  }

  const daemonState = await getServerDaemonStateByServerId(db, params.serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: 'daemon_key_unavailable', serverId: params.serverId }
  }

  // The engine container never publishes a client listener, but an access scope
  // that cannot resolve an address means the operator's chosen ingress will fail
  // at reconcile — catch it before minting show-once passwords.
  const bindResolved = await resolveManagedBindAddress(db, {
    serverId: params.serverId,
    scope: params.scope ?? DEFAULT_MANAGED_SQL_ACCESS_SCOPE,
  })
  if (isManagedAccessAddressError(bindResolved)) return bindResolved

  return null
}

export function isPrepareError(
  value: unknown,
): value is ManagedApplyPrepareError {
  return typeof value === 'object' && value !== null && 'kind' in value
}

export function prepareErrorResponse(
  c: Context<AppEnv>,
  error: ManagedApplyPrepareError,
): Response {
  switch (error.kind) {
    case 'datacenter_ip_required':
      return c.json({ error: 'datacenter_ip_required' }, 422)
    case 'fabric_address_required':
      return c.json({ error: 'fabric_address_required' }, 422)
    case 'daemon_key_unavailable':
      return c.json({ error: 'daemon_key_unavailable' }, 422)
    case 'managed_credential_not_sealed':
      return c.json({ error: 'managed_credential_not_sealed' }, 500)
    case 'managed_settings_invalid':
      return c.json({ error: 'managed_settings_invalid' }, 400)
    case 'managed_primary_missing':
      return c.json({ error: 'managed_primary_missing' }, 500)
    case 'managed_private_port_exhausted':
      return c.json({ error: 'managed_private_port_exhausted' }, 409)
    case 'managed_listener_bind_conflict':
      return c.json({ error: 'managed_listener_bind_conflict' }, 422)
    case 'private_path_unavailable':
    case 'private_family_mismatch':
    case 'failover_requires_trusted_datacenter':
      return privateEndpointErrorResponse(c, error)
  }
}

export function mapManagedApplyPrepareError(
  c: Context<AppEnv>,
  error: ManagedApplyPrepareError,
): Response {
  return prepareErrorResponse(c, error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isManagedRootPrincipal(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false
  return metadata.managedRoot === true
}

function isManagedReplicationPrincipal(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false
  return metadata.managedReplication === true
}

function principalDatabases(metadata: unknown): string[] {
  if (!isRecord(metadata)) return []
  if (!Array.isArray(metadata.databases)) return []
  return metadata.databases.filter((entry): entry is string => typeof entry === 'string')
}

function principalPrivileges(metadata: unknown): string[] | undefined {
  if (!isRecord(metadata)) return undefined
  if (!Array.isArray(metadata.privileges)) return undefined
  const privileges = metadata.privileges.filter(
    (entry): entry is string => typeof entry === 'string',
  )
  return privileges.length > 0 ? privileges : undefined
}

function composeFromRuntimeSpec(
  spec: ManagedEngineSpec,
  settings: ManagedSettings,
  managedId: string,
  rootUsername: string,
  member?: BuildRuntimeSpecInput['member'],
  useOrgTls?: boolean,
  memberCount?: number,
): {
  composeYaml: string
  runtime: ReturnType<ManagedEngineSpec['buildRuntimeSpec']>
} {
  const runtime = spec.buildRuntimeSpec({
    managedId,
    settings,
    rootUsername,
    ...(member !== undefined ? { member } : {}),
    ...(useOrgTls === true ? { useOrgTls: true } : {}),
    ...(memberCount !== undefined ? { memberCount } : {}),
  })

  const volumes: Record<string, Record<string, never>> = {}
  for (const volume of runtime.volumes) {
    volumes[volume.name] = {}
  }

  const document: ComposeDocument = {
    version: 1,
    data: {
      services: {
        [runtime.composeServiceName]: runtime.service,
      },
      ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
    },
    presentation: {
      keyOrder: [
        'services',
        ...(Object.keys(volumes).length > 0 ? ['volumes'] : []),
      ],
      comments: {},
    },
  }

  return { composeYaml: composeDocumentToYaml(document), runtime }
}

async function buildCredentials(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  managedId: string,
  serverId: string,
  omitPrincipalIds?: string[],
): Promise<
  ManagedApplyCommandPayload['credentials'] | ManagedApplyPrepareError
> {
  const omit = new Set(omitPrincipalIds ?? [])
  const rows = (await listManagedPrincipals(db, managedId))
    .filter((row) => !omit.has(row.id))
  if (rows.length === 0) {
    return { kind: 'managed_credential_not_sealed' }
  }

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: 'daemon_key_unavailable', serverId }
  }

  const credentials: ManagedApplyCommandPayload['credentials'] = []
  for (const row of rows) {
    // Replication principals are attached separately when multi-member.
    if (isManagedReplicationPrincipal(row.metadata)) continue

    const [passwordRow] = await db
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, row.id))
      .limit(1)
    const sealed = passwordRow?.password
    if (
      typeof sealed !== 'string' || !sealed.startsWith(ENVELOPE_PREFIX_SECRET)
    ) {
      return { kind: 'managed_credential_not_sealed' }
    }

    const resealed = await resealSecretForDaemon(
      secretsConfig,
      dataEncryptionSecrets,
      { serverId, keyId: daemonState.key.id },
      sealed,
    )

    const role = isManagedRootPrincipal(row.metadata) ? 'root' : 'user'
    const credential: ManagedApplyCommandPayload['credentials'][number] = {
      principalId: row.id,
      // Applied login — the engine role name, not the internal short name.
      username: row.appliedUsername,
      role,
      databases: principalDatabases(row.metadata),
      password: resealed,
    }
    const privileges = principalPrivileges(row.metadata)
    if (privileges !== undefined) credential.privileges = privileges
    credentials.push(credential)
  }

  return credentials
}

function organizationCaSetOrSealedError(
  set: OrganizationCaSet | null,
): OrganizationCaSet | ManagedApplyPrepareError {
  if (
    !set ||
    set.signer.certificatePem.length === 0 ||
    !set.signer.privateKeyPemSealed.startsWith(ENVELOPE_PREFIX_SECRET)
  ) {
    return { kind: 'managed_credential_not_sealed' }
  }
  return set
}

/**
 * Look up the active Organization CA set, or mint + insert one when absent
 * (same ensure semantics as `GET /tls/ca`). Signing uses `signer` only; trust
 * material is `trustBundlePem` (active+retired).
 */
export async function ensureActiveOrganizationCa(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  organizationId: string,
): Promise<OrganizationCaSet | ManagedApplyPrepareError> {
  const existingSet = await loadOrganizationCaSet(db, organizationId)
  if (existingSet) return organizationCaSetOrSealedError(existingSet)

  const material = await mintOrganizationCa({ organizationId })
  const privateKeyPemSealed = await encryptSecret(
    dataEncryptionSecrets,
    material.privateKeyPem,
  )
  if (!privateKeyPemSealed.startsWith(ENVELOPE_PREFIX_SECRET)) {
    return { kind: 'managed_credential_not_sealed' }
  }
  const { columns, residual } = splitTlsMetadata(
    metadataFromParsed(material.parsed, 'ready'),
  )

  try {
    await db.transaction(async (tx) => {
      const race = await loadOrganizationCaSet(tx, organizationId)
      if (race) return

      const caGeneration = await nextOrganizationCaGeneration(tx, organizationId)
      await tx.insert(tls).values({
        organizationId,
        name: 'Organization CA',
        source: 'organization_ca',
        certificatePem: material.certificatePem,
        privateKeyPem: privateKeyPemSealed,
        status: columns.status,
        notAfter: columns.notAfter,
        fingerprintSha256: columns.fingerprintSha256,
        metadata: residual,
        options: null,
        caState: 'active',
        caGeneration,
      })
    })
  } catch (err) {
    if (!isOrganizationCaUniqueViolation(err)) throw err
  }

  return organizationCaSetOrSealedError(
    await loadOrganizationCaSet(db, organizationId),
  )
}

/**
 * Issue a managed leaf from an org CA and reseal the leaf private key as a
 * daemon-bound `tpdaemon` envelope for `payload.orgTlsMaterial`.
 *
 * Exported for host-free unit tests (no DB).
 *
 * `ipAddresses` become iPAddress SANs so remote MySQL/MariaDB (and similar)
 * clients dialling the private listener IP with verify-identity can match.
 */
export async function buildManagedOrgTlsMaterial(
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  recipient: { serverId: string; keyId: string },
  ca: {
    certificatePem: string
    privateKeyPem: string
    trustBundlePem: string
  },
  managedId: string,
  extraSans: readonly string[] = [],
  ipAddresses: readonly string[] = [],
): Promise<ManagedApplyOrgTlsMaterial> {
  const leafName = `managed-${managedId}`
  const sans = [
    leafName,
    'localhost',
    ...extraSans.filter((s) => s.length > 0 && s !== leafName && s !== 'localhost'),
  ]
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    sans,
    {
      commonName: leafName,
      // ProxySQL presents this leaf as a *client* cert on proxy-to-server
      // connections (ssl_p2s_cert), and Postgres verifies client certs
      // whenever ssl_ca_file is set — without clientAuth EKU the handshake
      // fails with "unsuitable certificate purpose".
      includeClientAuth: true,
      ...(ipAddresses.length > 0 ? { ipAddresses: [...ipAddresses] } : {}),
    },
  )
  const sealedLeafKey = await encryptSecret(
    dataEncryptionSecrets,
    leaf.privateKeyPem,
  )
  const privateKeyEnvelope = await resealSecretForDaemon(
    secretsConfig,
    dataEncryptionSecrets,
    recipient,
    sealedLeafKey,
  )
  return {
    certificatePem: leaf.certificatePem,
    privateKeyEnvelope,
    caCertPem: ca.trustBundlePem,
  }
}

async function buildOrgTlsMaterialForServer(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: {
    organizationId: string
    serverId: string
    managedId: string
    replicaId: string
    extraSans?: readonly string[]
    ipAddresses?: readonly string[]
  },
): Promise<
  | { material: ManagedApplyOrgTlsMaterial; pendingTlsLeaf: UpsertTlsLeafTrackingParams }
  | ManagedApplyPrepareError
> {
  const {
    organizationId,
    serverId,
    managedId,
    replicaId,
    extraSans = [],
    ipAddresses = [],
  } = params
  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: 'daemon_key_unavailable', serverId }
  }

  const ca = await ensureActiveOrganizationCa(
    db,
    dataEncryptionSecrets,
    organizationId,
  )
  if ('kind' in ca) return ca

  const caPrivateKeyPem = await decryptSecret(
    dataEncryptionSecrets,
    ca.signer.privateKeyPemSealed,
  )
  const material = await buildManagedOrgTlsMaterial(
    secretsConfig,
    dataEncryptionSecrets,
    { serverId, keyId: daemonState.key.id },
    {
      certificatePem: ca.signer.certificatePem,
      privateKeyPem: caPrivateKeyPem,
      trustBundlePem: ca.trustBundlePem,
    },
    managedId,
    extraSans,
    ipAddresses,
  )
  return {
    material,
    pendingTlsLeaf: {
      kind: 'engine',
      organizationId,
      serverId,
      managedId,
      replicaId,
      caId: ca.signer.id,
      caGeneration: ca.signer.caGeneration,
      notAfter: organizationCaLeafNotAfterIso(),
    },
  }
}

function resolveRootUsername(
  input: BuildManagedApplyInput,
): string {
  const residual = parseManagedResidual(input.managedRow.metadata)
  return residual.rootUsername ?? input.rootUsername ?? input.spec.rootUsername
}

type ResolvedMemberPrivateBind = {
  address: string
  transport: 'datacenter' | 'fabric' | 'public'
}

/**
 * Resolve the address this member publishes its private listener on by asking
 * the reverse question for every remote peer: "which address does that peer
 * dial to reach this member?" — the same class-aware ladder
 * (`replicationPurposeForMemberPair`) the peer list itself was built with, so
 * the publish can never disagree with the dial.
 *
 * Returns `undefined` when no remote peer needs a published bind (single-member
 * or all co-resident — those dial the container name on the organization's
 * managed network),
 * a `PrivateEndpointError` when a peer has no path to this member, and
 * `managed_listener_bind_conflict` when peers disagree on the address or
 * transport: the wire payload carries exactly one `privateListener`, so a mixed
 * datacenter/fabric/public peer set is rejected instead of shipping a bind that
 * only some peers can reach.
 *
 * The returned `transport` tags the wire payload so the daemon can mandate
 * org-CA TLS for a public bind.
 *
 * Exported for host-free unit tests (fake `Db`).
 */
export async function resolveMemberPrivateBindAddress(
  db: Db,
  member: ManagedMemberRow,
  members: readonly ManagedMemberRow[],
): Promise<ResolvedMemberPrivateBind | undefined | ManagedApplyPrepareError> {
  const remotePeers = members.filter(
    (row) => row.id !== member.id && row.serverId !== member.serverId,
  )
  if (remotePeers.length === 0) return undefined

  let bind: ResolvedMemberPrivateBind | undefined
  for (const peer of remotePeers) {
    const resolved = await resolvePrivateEndpoint(db, {
      fromServerId: peer.serverId,
      toServerId: member.serverId,
      purpose: replicationPurposeForMemberPair(member, peer),
    })
    if (isPrivateEndpointError(resolved)) return resolved
    if (resolved.transport === 'local') continue

    const candidate: ResolvedMemberPrivateBind = {
      address: resolved.address,
      transport: resolved.transport,
    }
    if (!bind) {
      bind = candidate
      continue
    }
    if (
      bind.address !== candidate.address ||
      bind.transport !== candidate.transport
    ) {
      return {
        kind: 'managed_listener_bind_conflict',
        serverId: member.serverId,
      }
    }
  }
  return bind
}

/**
 * Resolve this member's private-listener address (when it has a private
 * port) and its `BuildRuntimeSpecInput['member']` replication shape (primary
 * desired-slots / peer addresses, or standby slot + upstream primary).
 * Returns `undefined` for single-member clusters (no replication username).
 *
 * Bind is whatever address remote peers actually dial for this member (see
 * `resolveMemberPrivateBindAddress`), not an independent ladder walk.
 */
async function resolveMemberReplicationInput(
  db: Db,
  managedId: string,
  params: {
    members: ManagedMemberRow[]
    member: ManagedMemberRow
    roleForSpec: 'primary' | 'standby'
    replicationUsername: string | null
    multiMember: boolean
    peers: ManagedMemberPeer[]
  },
): Promise<
  BuildRuntimeSpecInput['member'] | undefined | ManagedApplyPrepareError
> {
  const {
    members,
    member,
    roleForSpec,
    replicationUsername,
    multiMember,
    peers,
  } = params
  if (!multiMember || !replicationUsername) return undefined

  let privateListener:
    | NonNullable<
      NonNullable<BuildRuntimeSpecInput['member']>['privateListener']
    >
    | undefined
  if (member.privatePort !== null) {
    const privateBind = await resolveMemberPrivateBindAddress(
      db,
      member,
      members,
    )
    if (isPrepareError(privateBind)) return privateBind
    if (privateBind) {
      privateListener = {
        address: privateBind.address,
        port: member.privatePort,
        transport: privateBind.transport,
      }
    }
    // All co-resident: no private listener publish needed.
  }

  if (roleForSpec === 'primary') {
    const desiredSlots = members
      .filter((m) => m.role === 'replica')
      .map((m) => `tp_member_${m.ordinal}`)
    return {
      role: 'primary',
      ordinal: member.ordinal,
      replication: {
        username: replicationUsername,
        desiredSlots,
        peerAddresses: peers.map((p) => p.address),
      },
      ...(privateListener !== undefined ? { privateListener } : {}),
    }
  }

  const primaryPeer = peers.find((p) => p.role === 'primary')
  if (!primaryPeer) {
    return { kind: 'managed_primary_missing' }
  }
  const host = primaryPeer.containerName ?? `managed-${managedId}`
  return {
    role: 'standby',
    ordinal: member.ordinal,
    replication: {
      username: replicationUsername,
      slotName: `tp_member_${member.ordinal}`,
      primary: {
        host,
        ...(primaryPeer.containerName ? {} : { hostaddr: primaryPeer.address }),
        port: primaryPeer.port,
      },
      // Standbys need peers too: every member server hosts a ProxySQL ingress
      // that dials this engine's private listener (monitor + client traffic),
      // so pg_hba and the daemon firewall must admit them — not just the
      // primary's replication peers.
      peerAddresses: peers.map((p) => p.address),
    },
    ...(privateListener !== undefined ? { privateListener } : {}),
  }
}

/**
 * Attach the cluster's replication principal credential, when one exists.
 * No-op for single-member clusters (no replication username).
 */
async function attachReplicationCredential(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: {
    managedId: string
    serverId: string
    multiMember: boolean
    replicationUsername: string | null
    credentials: ManagedApplyCommandPayload['credentials']
  },
): Promise<ManagedApplyPrepareError | null> {
  const { managedId, serverId, multiMember, replicationUsername, credentials } = params
  if (!multiMember || !replicationUsername) return null

  const rows = await listManagedPrincipals(db, managedId)
  const repl = rows.find((row) => isManagedReplicationPrincipal(row.metadata))
  if (!repl) return null

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: 'daemon_key_unavailable', serverId }
  }
  const [passwordRow] = await db
    .select({ password: principal.password })
    .from(principal)
    .where(eq(principal.id, repl.id))
    .limit(1)
  const sealed = passwordRow?.password
  if (
    typeof sealed !== 'string' || !sealed.startsWith(ENVELOPE_PREFIX_SECRET)
  ) {
    return { kind: 'managed_credential_not_sealed' }
  }
  const resealed = await resealSecretForDaemon(
    secretsConfig,
    dataEncryptionSecrets,
    { serverId, keyId: daemonState.key.id },
    sealed,
  )
  credentials.push({
    principalId: repl.id,
    username: repl.appliedUsername,
    role: 'replication',
    databases: [],
    password: resealed,
  })
  return null
}

/** Build the payload `replication` field from a resolved member input, if any. */
function buildReplicationPayloadField(
  memberInput: BuildRuntimeSpecInput['member'] | undefined,
): ManagedApplyCommandPayload['replication'] | undefined {
  if (!memberInput?.replication) return undefined
  return {
    role: memberInput.role,
    username: memberInput.replication.username,
    ...(memberInput.replication.slotName !== undefined
      ? { slotName: memberInput.replication.slotName }
      : {}),
    ...(memberInput.replication.desiredSlots !== undefined
      ? { desiredSlots: memberInput.replication.desiredSlots }
      : {}),
    ...(memberInput.replication.peerAddresses !== undefined
      ? { peerAddresses: memberInput.replication.peerAddresses }
      : {}),
    ...(memberInput.replication.primary !== undefined
      ? { primary: memberInput.replication.primary }
      : {}),
  }
}

/** Attach optional replication, resource, database, TLS, and member flags. */
function attachOptionalPayloadFields(
  payload: ManagedApplyCommandPayload,
  input: BuildManagedApplyInput,
  memberInput: BuildRuntimeSpecInput['member'] | undefined,
  runtime: ReturnType<ManagedEngineSpec['buildRuntimeSpec']>,
  databases: NonNullable<ManagedApplyCommandPayload['databases']>,
  extra: {
    memberId: string
    roleForSpec: 'primary' | 'standby'
    monitorUsers?: NonNullable<ManagedApplyCommandPayload['monitorUsers']>
  },
): void {
  if (memberInput?.privateListener) {
    payload.privateListener = memberInput.privateListener
  }
  const replication = buildReplicationPayloadField(memberInput)
  if (replication) payload.replication = replication

  if (input.settings.resources) payload.resources = input.settings.resources
  if (input.settings.dockerOptions) {
    payload.dockerOptions = input.settings.dockerOptions
  }
  if (databases.length > 0) payload.databases = databases
  if (input.dropUsers && input.dropUsers.length > 0) {
    payload.dropUsers = input.dropUsers
  }
  if (runtime.tlsMaterial) payload.tlsMaterial = runtime.tlsMaterial
  attachMemberApplyFlags(payload, input, memberInput, extra)
}

function attachMemberApplyFlags(
  payload: ManagedApplyCommandPayload,
  input: BuildManagedApplyInput,
  memberInput: BuildRuntimeSpecInput['member'] | undefined,
  extra: {
    memberId: string
    roleForSpec: 'primary' | 'standby'
    monitorUsers?: NonNullable<ManagedApplyCommandPayload['monitorUsers']>
  },
): void {
  if (extra.monitorUsers !== undefined) payload.monitorUsers = extra.monitorUsers
  if (
    extra.roleForSpec === 'standby' &&
    (input.forceResyncMemberIds?.includes(extra.memberId) ?? false)
  ) {
    payload.forceResync = true
  }
  if (memberInput?.clientSourceAddresses?.length) {
    payload.ingressSourceAddresses = memberInput.clientSourceAddresses
  }
}

/**
 * Owning organization of the member's server. Scopes both the org-CA leaf and
 * the org-wide managed Docker network — a member placed on another org's
 * server follows that server's org, not the caller's.
 */
async function resolveMemberOrganizationId(
  db: Db,
  input: BuildManagedApplyInput,
  member: ManagedMemberRow,
): Promise<string> {
  const [memberServer] = await db
    .select({ organizationId: serverTable.organizationId })
    .from(serverTable)
    .where(eq(serverTable.id, member.serverId))
    .limit(1)
  return memberServer?.organizationId ?? input.organizationId
}

/**
 * Ensure the ingress hierarchy for this member's org and mint + attach its
 * org-CA leaf material onto `payload`.
 */
async function attachManagedOrgTlsMaterial(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: {
    input: BuildManagedApplyInput
    member: ManagedMemberRow
    memberInput: BuildRuntimeSpecInput['member'] | undefined
    containerSans: readonly string[]
    containerName: string
    memberOrganizationId: string
    payload: ManagedApplyCommandPayload
  },
): Promise<
  | { pendingTlsLeaf: UpsertTlsLeafTrackingParams }
  | ManagedApplyPrepareError
> {
  const {
    input,
    member,
    memberInput,
    containerSans,
    containerName,
    memberOrganizationId,
    payload,
  } = params

  await ensureManagedIngressHierarchy(db, {
    organizationId: memberOrganizationId,
    serverId: member.serverId,
  })

  const orgTlsMaterial = await buildOrgTlsMaterialForServer(
    db,
    secretsConfig,
    dataEncryptionSecrets,
    {
      organizationId: memberOrganizationId,
      serverId: member.serverId,
      managedId: input.managedRow.id,
      replicaId: member.id,
      extraSans: [...containerSans, containerName],
      // Private listener IP must be an IP SAN so remote MySQL/MariaDB replicas
      // using hostaddr + VERIFY_IDENTITY match the primary leaf.
      ipAddresses: memberInput?.privateListener ? [memberInput.privateListener.address] : [],
    },
  )
  if ('kind' in orgTlsMaterial) return orgTlsMaterial
  payload.orgTlsMaterial = orgTlsMaterial.material
  return { pendingTlsLeaf: orgTlsMaterial.pendingTlsLeaf }
}

function buildApplyPeersField(
  peers: readonly ManagedMemberPeer[],
): ManagedApplyCommandPayload['peers'] {
  return peers.map((p) => ({
    memberId: p.memberId,
    role: p.role,
    readEligible: p.readEligible,
    address: p.address,
    transport: p.transport,
    port: p.port,
    ...(p.containerName !== undefined ? { containerName: p.containerName } : {}),
  }))
}

/**
 * Cross-host consumer servers (bound apps elsewhere) run ProxySQL ingress
 * that dials this engine's private listener — pg_hba / engine account host
 * scoping must admit them. Multi-member only: single-member engines have no
 * private listener for a remote consumer to dial. Best effort per consumer:
 * one without a private path cannot reach the listener anyway.
 */
async function attachConsumerSourceAddresses(
  db: Db,
  input: BuildManagedApplyInput,
  members: readonly ManagedMemberRow[],
  member: ManagedMemberRow,
  memberInput: NonNullable<BuildRuntimeSpecInput['member']>,
): Promise<void> {
  const memberServerIds = new Set(members.map((m) => m.serverId))
  const consumerIds = (await consumerServerIdsForManaged(db, input.managedRow.id))
    .filter((id) => !memberServerIds.has(id) && id !== member.serverId)
  if (consumerIds.length === 0) return

  const endpoints = await resolvePrivateEndpoints(db, {
    fromServerId: member.serverId,
    toServerIds: consumerIds,
    purpose: 'client-backend',
  })
  const addresses: string[] = []
  for (const resolved of endpoints.values()) {
    if ('kind' in resolved) continue
    if (!addresses.includes(resolved.address)) addresses.push(resolved.address)
  }
  if (addresses.length > 0) {
    memberInput.clientSourceAddresses = addresses.toSorted((a, b) =>
      a.localeCompare(b)
    )
  }
}

/**
 * Per-server ProxySQL monitor credentials for every server fronting this
 * cluster (members + bound consumers). Primary payloads only: the engine
 * creates one monitor role per server and standbys inherit them via WAL —
 * see `monitor-credential.ts` for why per-host `monitor.cnf` cannot work.
 */
async function buildPrimaryMonitorUsers(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  input: BuildManagedApplyInput,
  members: readonly ManagedMemberRow[],
  member: ManagedMemberRow,
): Promise<
  | { monitorUsers: NonNullable<ManagedApplyCommandPayload['monitorUsers']> }
  | ManagedApplyPrepareError
> {
  const frontingServerIds = new Set<string>(members.map((m) => m.serverId))
  for (
    const consumerId of await consumerServerIdsForManaged(
      db,
      input.managedRow.id,
    )
  ) {
    frontingServerIds.add(consumerId)
  }
  const daemonState = await getServerDaemonStateByServerId(db, member.serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: 'daemon_key_unavailable', serverId: member.serverId }
  }
  const monitorUsers: NonNullable<ManagedApplyCommandPayload['monitorUsers']> =
    []
  for (
    const frontingServerId of [...frontingServerIds].toSorted((a, b) =>
      a.localeCompare(b)
    )
  ) {
    const cred = await ensureServerMonitorCredential(
      db,
      dataEncryptionSecrets,
      frontingServerId,
    )
    monitorUsers.push({
      username: cred.username,
      password: await resealSecretForDaemon(
        secretsConfig,
        dataEncryptionSecrets,
        { serverId: member.serverId, keyId: daemonState.key.id },
        cred.passwordSealed,
      ),
    })
  }
  return { monitorUsers }
}

/**
 * Primary payloads ship monitor roles; standbys inherit them via WAL and
 * omit `monitorUsers` so the daemon does not recreate the same logins.
 */
async function resolvePayloadMonitorUsers(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  input: BuildManagedApplyInput,
  members: readonly ManagedMemberRow[],
  member: ManagedMemberRow,
  roleForSpec: 'primary' | 'standby',
): Promise<
  | { monitorUsers?: NonNullable<ManagedApplyCommandPayload['monitorUsers']> }
  | ManagedApplyPrepareError
> {
  if (roleForSpec !== 'primary') return {}
  return buildPrimaryMonitorUsers(
    db,
    secretsConfig,
    dataEncryptionSecrets,
    input,
    members,
    member,
  )
}

async function buildPayloadForMember(
  c: Context<AppEnv>,
  db: Db,
  input: BuildManagedApplyInput,
  params: {
    members: ManagedMemberRow[]
    member: ManagedMemberRow
    multiMember: boolean
    replicationUsername: string | null
    containerSans: readonly string[]
  },
): Promise<
  | { payload: ManagedApplyCommandPayload; pendingTlsLeaf: UpsertTlsLeafTrackingParams }
  | ManagedApplyPrepareError
> {
  const { members, member, multiMember, replicationUsername, containerSans } = params
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!secretsConfig || !dataEncryptionSecrets) {
    return { kind: 'daemon_key_unavailable', serverId: member.serverId }
  }

  const infra = await preflightManagedApplyInfrastructure(c, db, {
    serverId: member.serverId,
    scope: input.settings.exposure.scope,
  })
  if (infra) return infra

  const roleForSpec: 'primary' | 'standby' = member.role === 'replica' ? 'standby' : 'primary'

  // Resolve peer endpoints early — needed for replication + private listener.
  // The ladder per link is class-aware (see `replicationPurposeForMemberPair`).
  const peers = await resolvePeersForMember(
    db,
    members,
    member,
    // Engine-native backend port (5432/3306), not the ProxySQL client listener.
    input.spec.defaultPort,
  )
  if (isPrivateEndpointError(peers)) return peers

  const resolvedMemberInput = await resolveMemberReplicationInput(
    db,
    input.managedRow.id,
    {
      members,
      member,
      roleForSpec,
      replicationUsername,
      multiMember,
      peers,
    },
  )
  if (isPrepareError(resolvedMemberInput)) return resolvedMemberInput
  const memberInput = resolvedMemberInput

  if (memberInput) {
    await attachConsumerSourceAddresses(db, input, members, member, memberInput)
  }

  const rootUsername = resolveRootUsername(input)
  const { composeYaml, runtime } = composeFromRuntimeSpec(
    input.spec,
    input.settings,
    input.managedRow.id,
    rootUsername,
    memberInput,
    multiMember,
    members.length,
  )

  // Both the payload's `managedNetwork` and the org-CA leaf below are scoped
  // to the member server's owning org — resolved once, used by both.
  const memberOrganizationId = await resolveMemberOrganizationId(db, input, member)
  const managedNetwork = await ensureOrganizationManagedNetwork(db, {
    organizationId: memberOrganizationId,
  })

  const memberOrdinals = members.map((m) => m.ordinal)
  const allocation = await ensureManagedContainerAllocation(db, {
    environmentId: input.environmentId,
    serverId: member.serverId,
    composeServiceName: runtime.composeServiceName,
    ordinal: member.ordinal,
    memberOrdinals,
  })

  // No `bindAddress`: managed engines are loopback-only and the daemon resolves
  // them that way (`resolveManagedApplyHost`). Client reachability is entirely
  // the shared ProxySQL frontend's job — see `access-scope.ts`.
  const exposure: ManagedApplyCommandPayload['exposure'] = {
    enabled: input.settings.exposure.enabled,
    protocol: input.spec.exposeProtocol,
  }

  const credentials = await buildCredentials(
    db,
    secretsConfig,
    dataEncryptionSecrets,
    input.managedRow.id,
    member.serverId,
    input.omitPrincipalIds,
  )
  if (!Array.isArray(credentials)) return credentials

  const replError = await attachReplicationCredential(
    db,
    secretsConfig,
    dataEncryptionSecrets,
    {
      managedId: input.managedRow.id,
      serverId: member.serverId,
      multiMember,
      replicationUsername,
      credentials,
    },
  )
  if (replError) return replError

  const databases: NonNullable<ManagedApplyCommandPayload['databases']> = [
    ...input.databases.map((name) => ({ name, action: 'create' as const })),
    ...(input.dropDatabases ?? []).map((name) => ({
      name,
      action: 'drop' as const,
    })),
  ]

  const builtMonitorUsers = await resolvePayloadMonitorUsers(
    db,
    secretsConfig,
    dataEncryptionSecrets,
    input,
    members,
    member,
    roleForSpec,
  )
  if (isPrepareError(builtMonitorUsers)) return builtMonitorUsers

  const payload: ManagedApplyCommandPayload = {
    managedId: input.managedRow.id,
    environmentId: input.environmentId,
    engine: input.spec.engine,
    // Bare `managed` row UUID — the daemon's `managedComposeProject` returns
    // the same value, and the two must stay in lockstep.
    projectName: input.managedRow.id,
    containerName: allocation.containerName,
    managedNetwork: managedNetwork.hostName,
    image: input.settings.image ?? input.spec.defaultImage,
    // Engine-native listen port inside the container — not the ingress listener.
    containerPort: input.spec.defaultPort,
    composeYaml,
    configFiles: runtime.configFiles,
    volumes: runtime.volumes,
    exposure,
    memberId: member.id,
    memberRole: member.role === 'replica' ? 'replica' : 'primary',
    memberOrdinal: member.ordinal,
    readEligible: member.readEligible,
    peers: buildApplyPeersField(peers),
    credentials,
  }

  attachOptionalPayloadFields(payload, input, memberInput, runtime, databases, {
    memberId: member.id,
    roleForSpec,
    monitorUsers: builtMonitorUsers.monitorUsers,
  })

  const tlsResult = await attachManagedOrgTlsMaterial(
    db,
    secretsConfig,
    dataEncryptionSecrets,
    {
      input,
      member,
      memberInput,
      containerSans,
      containerName: allocation.containerName,
      memberOrganizationId,
      payload,
    },
  )
  if (isPrepareError(tlsResult)) return tlsResult

  return { payload, pendingTlsLeaf: tlsResult.pendingTlsLeaf }
}

/**
 * Prepare one `managed.apply` payload per cluster member (ordered by ordinal).
 * Self-heals primary membership and allocates containers per member ordinal.
 */
export async function prepareManagedApplyPayloads(
  c: Context<AppEnv>,
  db: Db,
  input: BuildManagedApplyInput,
): Promise<
  { members: PreparedManagedMemberApply[] } | ManagedApplyPrepareError
> {
  await ensureManagedPrimaryMember(db, {
    managedId: input.managedRow.id,
    serverId: input.serverId,
  })

  let members = await listManagedMembers(db, input.managedRow.id)
  if (input.excludeMemberIds && input.excludeMemberIds.length > 0) {
    const exclude = new Set(input.excludeMemberIds)
    members = members.filter((m) => !exclude.has(m.id))
  }
  if (members.length === 0) {
    return { kind: 'managed_primary_missing' }
  }

  const ports = await ensureMemberPrivatePorts(db, members)
  if (isManagedPrivatePortExhaustedError(ports)) {
    return ports
  }
  members = ports

  const multiMember = members.length > 1
  let replicationUsername: string | null = null
  if (multiMember) {
    const usernameOrError = await ensureClusterReplicationUsername(
      c,
      db,
      input,
    )
    if (isPrepareError(usernameOrError)) return usernameOrError
    replicationUsername = usernameOrError
  }

  const containerSans = [`managed-${input.managedRow.id}`]

  const prepared: PreparedManagedMemberApply[] = []
  for (const member of members) {
    const result = await prepareOneMemberApply(c, db, input, {
      members,
      member,
      multiMember,
      replicationUsername,
      containerSans,
    })
    if (isPrepareError(result)) return result
    prepared.push(result)
  }

  return { members: prepared }
}

/** Mint (or reuse) the cluster's replication principal and persist its username. */
async function ensureClusterReplicationUsername(
  c: Context<AppEnv>,
  db: Db,
  input: BuildManagedApplyInput,
): Promise<string | ManagedApplyPrepareError> {
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!c.get('secretsConfig') || !dataEncryptionSecrets) {
    return { kind: 'daemon_key_unavailable', serverId: input.serverId }
  }

  const repl = await ensureManagedReplicationPrincipal(
    db,
    dataEncryptionSecrets,
    {
      managedId: input.managedRow.id,
      preferredUsername: 'tp_repl',
      provider: input.spec.principalProvider,
      identifier: input.spec.userOperations.identifier,
      randomizeSuffix: await loadRandomizedUsernamesDefault(
        db,
        input.organizationId,
      ),
    },
  )

  // MySQL caps `CHANGE REPLICATION SOURCE … SOURCE_PASSWORD` at 32 chars
  // (error 3056). Pre-fix replication principals were minted at 48 —
  // self-heal by rotating to a compliant password. mysql-family only:
  // rotating a Postgres cluster's replication password would strand
  // streaming standbys whose seeded primary_conninfo holds the old one.
  if (
    input.spec.engine === 'mysql' || input.spec.engine === 'mariadb'
  ) {
    const [pwRow] = await db
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, repl.principalId))
      .limit(1)
    if (
      typeof pwRow?.password === 'string' &&
      pwRow.password.startsWith(ENVELOPE_PREFIX_SECRET)
    ) {
      const plain = await decryptSecret(dataEncryptionSecrets, pwRow.password)
      if (plain.length > REPLICATION_PASSWORD_LENGTH) {
        await setPrincipalPassword(db, dataEncryptionSecrets, repl.principalId, {
          password: generatePassword(REPLICATION_PASSWORD_LENGTH),
        })
      }
    }
  }

  const residual = parseManagedResidual(input.managedRow.metadata)
  await db
    .update(managed)
    .set({
      metadata: {
        ...residual,
        replicationUsername: repl.appliedUsername,
      },
      updatedAt: new Date().toISOString(),
    })
    .where(eq(managed.id, input.managedRow.id))

  return repl.appliedUsername
}

/** Build one member's apply payload and self-heal its replication transport. */
async function prepareOneMemberApply(
  c: Context<AppEnv>,
  db: Db,
  input: BuildManagedApplyInput,
  params: {
    members: ManagedMemberRow[]
    member: ManagedMemberRow
    multiMember: boolean
    replicationUsername: string | null
    containerSans: readonly string[]
  },
): Promise<PreparedManagedMemberApply | ManagedApplyPrepareError> {
  const { member } = params
  const built = await buildPayloadForMember(c, db, input, params)
  if (isPrepareError(built)) return built

  if (member.role === 'replica' && built.payload.peers.length > 0) {
    const primaryPeer = built.payload.peers.find((p) => p.role === 'primary')
    if (primaryPeer) {
      await updateMemberReplicationTransport(
        db,
        member.id,
        primaryPeer.transport,
      )
    }
  }

  return {
    memberId: member.id,
    serverId: member.serverId,
    payload: built.payload,
    pendingTlsLeaf: built.pendingTlsLeaf,
  }
}

/**
 * Shared enqueue-and-record path for every `managed.*` command. `setApplying`
 * flips `managed.status` to `'applying'` before enqueue (used by
 * `managed.apply` and `managed.restore` — both mutate the running engine —
 * but never by `managed.backup`, which is read-only and must not perturb a
 * healthy engine's status).
 */
export async function enqueueTypedCommand(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    serverId: string
    type: CommandType
    payload: unknown
    expiresAtMs: number
    managedId?: string
    setApplying?: boolean
    metadata?: Record<string, unknown>
  },
): Promise<
  | { ok: true; commandId: string; status: 'queued'; serverId: string }
  | Response
> {
  if (params.setApplying && params.managedId) {
    await db
      .update(managed)
      .set({ status: 'applying', updatedAt: new Date().toISOString() })
      .where(eq(managed.id, params.managedId))
  }

  const expiresAt = new Date(Date.now() + params.expiresAtMs).toISOString()
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: 'user',
    actorId: params.userId,
    type: params.type,
    payload: params.payload,
    expiresAt,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  })

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: params.serverId,
    type: params.type,
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }

  try {
    await commandQueue.enqueue(envelope)
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    if (params.setApplying && params.managedId) {
      await db
        .update(managed)
        .set({ status: 'failed', updatedAt: new Date().toISOString() })
        .where(eq(managed.id, params.managedId))
    }
    return c.json({ error: 'Command queue unavailable' }, 503)
  }

  return {
    ok: true as const,
    commandId: record.id,
    status: 'queued' as const,
    serverId: params.serverId,
  }
}

/**
 * Fan-out: one `managed.apply` per member server.
 *
 * Multi-member clusters enqueue the primary immediately and return command ids
 * without waiting. Standby members are recorded in command metadata so the
 * command consumer enqueues them only after primary apply succeeds.
 * Flips `managed.status` to `applying` once before enqueue; sets `failed` only
 * if every member fails to enqueue.
 */
export async function enqueuePreparedManagedApply(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    managedId: string
    members: PreparedManagedMemberApply[]
  },
): Promise<ManagedApplyEnqueueResult[] | Response> {
  if (params.members.length === 0) {
    return []
  }

  await db
    .update(managed)
    .set({ status: 'applying', updatedAt: new Date().toISOString() })
    .where(eq(managed.id, params.managedId))

  const primaryMembers = params.members.filter(isPrimaryMemberPayload)
  const standbyMembers = params.members.filter((m) => !isPrimaryMemberPayload(m))

  // Single-phase when no standby depends on primary prep.
  if (standbyMembers.length === 0) {
    return enqueueSinglePhaseManagedApply(c, db, commandQueue, {
      userId: params.userId,
      managedId: params.managedId,
      members: params.members,
    })
  }

  return enqueueTwoPhaseManagedApply(c, db, commandQueue, {
    userId: params.userId,
    managedId: params.managedId,
    primaryMembers,
    standbyMembers,
  })
}

/** No standby depends on primary prep — enqueue every member concurrently. */
async function enqueueSinglePhaseManagedApply(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    managedId: string
    members: PreparedManagedMemberApply[]
  },
): Promise<ManagedApplyEnqueueResult[] | Response> {
  const results = await Promise.all(
    params.members.map((member) =>
      enqueueOneManagedApplyMember(db, commandQueue, {
        userId: params.userId,
        member,
      })
    ),
  )
  return finalizePreparedManagedApplyResults(c, db, commandQueue, {
    userId: params.userId,
    managedId: params.managedId,
    results,
  })
}

/**
 * At least one standby depends on primary prep — enqueue primaries only and
 * defer standbys to the command consumer via `pendingStandbyApplies` metadata.
 */
async function enqueueTwoPhaseManagedApply(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    managedId: string
    primaryMembers: PreparedManagedMemberApply[]
    standbyMembers: PreparedManagedMemberApply[]
  },
): Promise<ManagedApplyEnqueueResult[] | Response> {
  const { primaryMembers, standbyMembers } = params
  const results: ManagedApplyEnqueueResult[] = []

  if (primaryMembers.length === 0) {
    for (const standby of standbyMembers) {
      results.push({
        memberId: standby.memberId,
        serverId: standby.serverId,
        status: 'failed',
        error: 'Primary apply missing from multi-member prepare',
      })
    }
    return finalizePreparedManagedApplyResults(c, db, commandQueue, {
      userId: params.userId,
      managedId: params.managedId,
      results,
    })
  }

  const pendingStandbyApplies = standbyMembers.map((member) => ({
    serverId: member.serverId,
    memberId: member.memberId,
    payload: member.payload,
    ...(member.pendingTlsLeaf
      ? { pendingTlsLeaf: member.pendingTlsLeaf }
      : {}),
  }))

  let queuedPrimary = false
  for (const member of primaryMembers) {
    const result = await enqueueOneManagedApplyMember(db, commandQueue, {
      userId: params.userId,
      member,
      // Attach only once on the first primary command.
      extraMetadata: queuedPrimary ? undefined : { pendingStandbyApplies },
    })
    results.push(result)
    if (result.status === 'queued') queuedPrimary = true
    if (result.status !== 'queued') {
      for (const standby of standbyMembers) {
        results.push({
          memberId: standby.memberId,
          serverId: standby.serverId,
          status: 'failed',
          error: 'Primary apply failed before standby enqueue',
        })
      }
      return finalizePreparedManagedApplyResults(c, db, commandQueue, {
        userId: params.userId,
        managedId: params.managedId,
        results,
      })
    }
  }

  // Standbys are pending until the primary command succeeds (consumer).
  for (const standby of standbyMembers) {
    results.push({
      memberId: standby.memberId,
      serverId: standby.serverId,
      status: 'queued',
    })
  }

  return finalizePreparedManagedApplyResults(c, db, commandQueue, {
    userId: params.userId,
    managedId: params.managedId,
    results,
  })
}

async function finalizePreparedManagedApplyResults(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    managedId: string
    results: ManagedApplyEnqueueResult[]
  },
): Promise<ManagedApplyEnqueueResult[] | Response> {
  const allFailed = params.results.every((r) => r.status === 'failed')
  if (allFailed) {
    await db
      .update(managed)
      .set({ status: 'failed', updatedAt: new Date().toISOString() })
      .where(eq(managed.id, params.managedId))
    return c.json({ error: 'Command queue unavailable' }, 503)
  }

  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (secretsConfig && dataEncryptionSecrets) {
    const serverIds = new Set(
      params.results
        .filter((r) => r.status === 'queued')
        .map((r) => r.serverId),
    )
    const { enqueueManagedHaReconcile } = await import('./ha-desired.ts')
    for (const serverId of serverIds) {
      await enqueueManagedIngressReconcile(db, commandQueue, {
        serverId,
        actorType: 'user',
        actorId: params.userId,
        secretsConfig,
        dataEncryptionSecrets,
      })
      await enqueueManagedHaReconcile(db, commandQueue, {
        serverId,
        actorType: 'user',
        actorId: params.userId,
        secretsConfig,
        dataEncryptionSecrets,
      })
    }
  }

  return params.results
}

export async function enqueueManagedLifecycleFanout(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    managedId: string
    action: 'start' | 'stop' | 'restart'
    members: ManagedMemberRow[]
    engine?: string
  },
): Promise<ManagedApplyEnqueueResult[] | Response> {
  const results = await Promise.all(
    params.members.map(async (member): Promise<ManagedApplyEnqueueResult> => {
      const enqueued = await enqueueTypedCommand(c, db, commandQueue, {
        userId: params.userId,
        serverId: member.serverId,
        type: 'managed.lifecycle',
        payload: {
          managedId: params.managedId,
          action: params.action,
          memberId: member.id,
          ...(params.engine !== undefined ? { engine: params.engine } : {}),
        },
        expiresAtMs: 120_000,
      })
      if (enqueued instanceof Response) {
        return {
          memberId: member.id,
          serverId: member.serverId,
          status: 'failed',
          error: 'Command queue unavailable',
        }
      }
      return {
        memberId: member.id,
        serverId: member.serverId,
        commandId: enqueued.commandId,
        status: 'queued',
      }
    }),
  )
  return results
}

function buildManagedDestroyPayload(
  params: {
    managedId: string
    removeVolumes: boolean
    deleteAfterDestroy?: boolean
    environmentId?: string
  },
  member: ManagedMemberRow,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    managedId: params.managedId,
    removeVolumes: params.removeVolumes,
    memberId: member.id,
    ...(params.environmentId ? { environmentId: params.environmentId } : {}),
  }
  if (params.deleteAfterDestroy && member.role === 'primary') {
    payload.deleteAfterDestroy = true
  }
  if (member.role === 'replica') {
    // Delete the member row as part of each replica's destroy outcome so
    // the follow-up ingress reconcile on that server sees an empty
    // fronting set and tears ProxySQL down immediately — otherwise the
    // lingering row keeps the shared frontend alive until the primary's
    // outcome cascades it (or the orphan sweep catches up minutes later).
    payload.deleteMemberAfterDestroy = true
  }
  return payload
}

export async function enqueueManagedDestroyFanout(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    managedId: string
    removeVolumes: boolean
    members: ManagedMemberRow[]
    /** When true, only the primary command carries `deleteAfterDestroy`. */
    deleteAfterDestroy?: boolean
    /** Stamped on every destroy so side effects survive the row deletion. */
    environmentId?: string
    /**
     * Best-effort teardown: do not gate the primary on replica success —
     * enqueue everything at once and let sweeps mop up leftovers.
     */
    force?: boolean
  },
): Promise<ManagedApplyEnqueueResult[] | Response> {
  const enqueueOne = async (
    member: ManagedMemberRow,
    metadata?: Record<string, unknown>,
  ): Promise<ManagedApplyEnqueueResult> => {
    const enqueued = await enqueueTypedCommand(c, db, commandQueue, {
      userId: params.userId,
      serverId: member.serverId,
      type: 'managed.destroy',
      payload: buildManagedDestroyPayload(params, member),
      expiresAtMs: 600_000,
      ...(metadata ? { metadata } : {}),
    })
    if (enqueued instanceof Response) {
      return {
        memberId: member.id,
        serverId: member.serverId,
        status: 'failed',
        error: 'Command queue unavailable',
      }
    }
    return {
      memberId: member.id,
      serverId: member.serverId,
      commandId: enqueued.commandId,
      status: 'queued',
    }
  }

  const replicas = params.members.filter((m) => m.role === 'replica')
  const primaries = params.members.filter((m) => m.role !== 'replica')

  // Nothing to sequence: no replica to tear down first, or a force-delete that
  // deliberately skips the gate because a member host may be broken or offline.
  if (params.force || replicas.length === 0 || primaries.length === 0) {
    const replicaResults = await Promise.all(
      replicas.map((member) => enqueueOne(member)),
    )
    const primaryResults = await Promise.all(
      primaries.map((member) => enqueueOne(member)),
    )
    return [...replicaResults, ...primaryResults]
  }

  // Replicas tear down first: their side effects (container rows, ProxySQL
  // ingress teardown, member deletion) must not race the primary's
  // `deleteAfterDestroy` row removal.
  //
  // The wait is the **consumer's**, not this route's. Every replica command
  // carries the gate; whichever replica side effect observes the last sibling
  // succeed enqueues the primaries (`enqueuePendingManagedDestroys` in
  // `src/lib/commands/consumer.ts`), mirroring `pendingStandbyApplies`. A
  // replica that fails or expires simply never opens the gate, which leaves the
  // primary — and the `managed` row — intact for a retry or a force-delete.
  const memberIds = replicas.map((member) => member.id).toSorted((a, b) =>
    a.localeCompare(b)
  )
  const gate: ManagedDestroyGate = {
    gateId: crypto.randomUUID(),
    memberIds,
    followups: primaries.map((member) => ({
      serverId: member.serverId,
      memberId: member.id,
      payload: buildManagedDestroyPayload(params, member),
    })),
  }

  const replicaResults = await Promise.all(
    replicas.map((member) =>
      enqueueOne(member, { [MANAGED_DESTROY_GATE_METADATA_KEY]: gate })
    ),
  )

  if (replicaResults.some((result) => result.status === 'failed')) {
    // A replica that never reached the queue can never open the gate, so the
    // primaries would hang forever. Report the failure and leave the primary
    // (and the managed row) intact for a retry — or a force-delete, which skips
    // this gate entirely.
    return [
      ...replicaResults,
      ...primaries.map((member): ManagedApplyEnqueueResult => ({
        memberId: member.id,
        serverId: member.serverId,
        status: 'failed',
        error: 'Replica destroy failed before primary enqueue',
      })),
    ]
  }

  // Primaries are queued behind the gate: durably recorded on the replica
  // commands, with no command row of their own until the gate opens.
  return [
    ...replicaResults,
    ...primaries.map((member): ManagedApplyEnqueueResult => ({
      memberId: member.id,
      serverId: member.serverId,
      status: 'queued',
    })),
  ]
}

/** Compatibility wrappers used by paths that still target a single primary. */
export function enqueueManagedApply(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    serverId: string
    managedId: string
    payload: ManagedApplyCommandPayload
  },
): Promise<
  | { ok: true; commandId: string; status: 'queued'; serverId: string }
  | Response
> {
  return enqueueTypedCommand(c, db, commandQueue, {
    userId: params.userId,
    serverId: params.serverId,
    type: 'managed.apply',
    payload: params.payload,
    expiresAtMs: APPLY_EXPIRES_MS,
    managedId: params.managedId,
    setApplying: true,
  })
}

export function enqueueManagedLifecycle(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    serverId: string
    managedId: string
    action: 'start' | 'stop' | 'restart'
    memberId?: string
    engine?: string
  },
): Promise<
  | { ok: true; commandId: string; status: 'queued'; serverId: string }
  | Response
> {
  const payload: Record<string, unknown> = {
    managedId: params.managedId,
    action: params.action,
  }
  if (params.memberId) payload.memberId = params.memberId
  if (params.engine !== undefined) payload.engine = params.engine
  return enqueueTypedCommand(c, db, commandQueue, {
    userId: params.userId,
    serverId: params.serverId,
    type: 'managed.lifecycle',
    payload,
    expiresAtMs: 120_000,
  })
}

export function enqueueManagedDestroy(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    serverId: string
    managedId: string
    removeVolumes: boolean
    deleteAfterDestroy?: boolean
    memberId?: string
  },
): Promise<
  | { ok: true; commandId: string; status: 'queued'; serverId: string }
  | Response
> {
  const payload: Record<string, unknown> = {
    managedId: params.managedId,
    removeVolumes: params.removeVolumes,
  }
  if (params.deleteAfterDestroy) {
    payload.deleteAfterDestroy = true
  }
  if (params.memberId) payload.memberId = params.memberId
  return enqueueTypedCommand(c, db, commandQueue, {
    userId: params.userId,
    serverId: params.serverId,
    type: 'managed.destroy',
    payload,
    expiresAtMs: 600_000,
  })
}
