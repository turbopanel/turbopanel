import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { encryptSecret } from '../authn/data-encryption.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { type Db, getDb, getDaemonCellRegistry } from '../../db.ts'
import { organization } from '../../lib/db/schema.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import { assertDispatchInfrastructure } from '../servers/command-dispatch.ts'
import {
  assertGatewayRelaysReady,
  loadDatacenterSubnetsForServers,
  resolveDerivedAdvertisedCidrsByRelay,
} from '../../lib/net/datacenter-networks.ts'
import {
  disableOrganizationFabric,
  enableOrganizationFabric,
  FabricContainerPoolOverlapError,
  type FabricEnablePolicy,
  type FabricRecord,
  getOrganizationFabric,
  listFabricRelays,
  listSubnetsForServers,
  loadEndpointCaches,
  loadRelayPresharedKeyPresence,
  purgeOrganizationComposeNetworks,
  type RelayRecord,
  updateFabricRelay,
} from '../../lib/db/fabric-records.ts'
import { parseFabricPolicy } from '../../lib/fabric/policy.ts'
import {
  findCidrCollision,
  loadOrganizationCidrRegistry,
} from '../../lib/net/cidr-collisions.ts'
import { cidrContains } from '../../lib/ip-address.ts'
import { cidrCollisionResponse } from '../networks/network-scope.ts'
import {
  enqueueFabricReconcileForServers,
  reconcileFabricMembership,
} from '../../lib/fabric/enqueue.ts'
import {
  bindSecretEncryptFn,
  enqueueRelayPatchReconcile,
  type FabricMembershipSecrets,
  type FabricRelayApiRow,
  fabricEnableErrorResponse,
  fabricNotEnabledErrorResponse,
  fabricSettingsResponse,
  fabricTypedEnqueueErrorResponse,
  findByServerId,
  gatewayRolePatchErrorResponse,
  parseFabricPutBody,
  parseRelayPatchBody,
  preferredGatewayPatchErrorResponse,
  relayPatchUpdateFields,
  resolveSealedRelayPresharedKey,
  toFabricRelayApiRow,
} from './fabric-routes-helpers.ts'

/**
 * Validate a replacement `fabric.options.containerPool` before anything is
 * written:
 *
 * 1. the candidate goes through the org CIDR collision authority with the
 *    *current* pool excluded (a narrowed or re-based pool always overlaps
 *    the one it replaces) — 409 via `cidrCollisionResponse`;
 * 2. every allocated relay prefix must still sit inside the new pool.
 *    Nothing renumbers relays, so a pool that orphans one is refused
 *    (409 `fabric_container_pool_in_use`) rather than silently accepted.
 */
async function assertContainerPoolWritable(
  c: Context,
  db: Db,
  organizationId: string,
  containerPool: string,
  existing: FabricRecord | null,
): Promise<Response | null> {
  const registry = await loadOrganizationCidrRegistry(db, organizationId)
  const collision = findCidrCollision(
    { ...registry, containerPool: null },
    { cidr: containerPool, intent: 'docker' },
  )
  if (collision) return cidrCollisionResponse(c, collision)
  if (!existing) return null
  const relays = await listFabricRelays(db, existing.id)
  const orphaned = relays.find((row) => !cidrContains(containerPool, row.prefix))
  if (orphaned) {
    return c.json(
      {
        error: 'fabric_container_pool_in_use',
        containerPool,
        prefix: orphaned.prefix,
        serverId: orphaned.serverId,
      },
      409,
    )
  }
  return null
}

function fabricSecretsFromContext(c: {
  get: (key: 'secretsConfig' | 'dataEncryptionSecrets') => unknown
}): FabricMembershipSecrets {
  const secretsConfig = c.get(
    'secretsConfig',
  ) as FabricMembershipSecrets['secretsConfig']
  const dataEncryptionSecrets = c.get(
    'dataEncryptionSecrets',
  ) as FabricMembershipSecrets['dataEncryptionSecrets']
  return {
    ...(secretsConfig ? { secretsConfig } : {}),
    ...(dataEncryptionSecrets ? { dataEncryptionSecrets } : {}),
  }
}

/**
 * `PUT { enabled: false }`: tear relays down, purge compose networks and
 * clear the fabric row together. A never-enabled org is a no-op.
 */
async function disableOrganizationFabricForPut(params: {
  db: Db
  commandQueue: CommandQueue
  organizationId: string
  actorId: string
  secrets: FabricMembershipSecrets
}): Promise<void> {
  const { db, commandQueue, organizationId, actorId, secrets } = params
  const existing = await getOrganizationFabric(db, organizationId)
  if (!existing) return
  const relays = await listFabricRelays(db, existing.id)
  await enqueueFabricReconcileForServers({
    db,
    commandQueue,
    actorType: 'user',
    actorId,
    fabric: existing,
    serverIds: relays.map((row) => row.serverId),
    enabled: false,
    ...secrets,
  })
  await db.transaction(async (tx) => {
    await purgeOrganizationComposeNetworks(tx, organizationId)
    await disableOrganizationFabric(tx, organizationId)
  })
}

/**
 * Enable (or re-policy) the fabric, mapping the typed enable failures onto
 * their HTTP responses. A first-time enable picks the tp0 host range before
 * anything is written; a pool that range lands in is refused with nothing
 * enabled.
 */
async function enableOrganizationFabricOrResponse(
  c: Context,
  db: Db,
  organizationId: string,
  policy: FabricEnablePolicy,
): Promise<FabricRecord | Response> {
  try {
    return await enableOrganizationFabric(db, organizationId, policy)
  } catch (err) {
    if (err instanceof FabricContainerPoolOverlapError) {
      return cidrCollisionResponse(c, {
        code: 'cidr_overlaps_fabric',
        cidr: err.containerPool,
        conflictingCidr: err.fabricCidr,
        networkId: null,
        datacenterId: null,
      })
    }
    return fabricEnableErrorResponse(err)
  }
}

async function loadFabricRelayApiRows(
  db: Parameters<typeof listFabricRelays>[0],
  relays: RelayRecord[],
  orgAllowRelay: boolean,
): Promise<FabricRelayApiRow[]> {
  const serverIds = relays.map((row) => row.serverId)
  const [{ caches }, segmentsByServer, pskPresence, subnetsByServer] =
    await Promise.all([
      loadEndpointCaches(db, serverIds),
      listSubnetsForServers(db, serverIds),
      loadRelayPresharedKeyPresence(db, relays.map((row) => row.id)),
      loadDatacenterSubnetsForServers(db, serverIds),
    ])
  const derivedByRelayId = resolveDerivedAdvertisedCidrsByRelay(
    relays,
    subnetsByServer,
  )
  return relays.map((row) =>
    toFabricRelayApiRow({
      relay: row,
      hasPresharedKey: pskPresence.has(row.id),
      segments: segmentsByServer.get(row.serverId) ?? [],
      caches,
      relays,
      resolvedAdvertisedCidrs: derivedByRelayId.get(row.id) ?? [],
      orgAllowRelay,
    })
  )
}

export function registerOrganizationFabricRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for fabric routes')
  }
  const secrets = opts.secrets

  router.use('/organizations/:id/fabric', createSessionMiddleware(secrets))
  router.use(
    '/organizations/:id/fabric/relays/:serverId',
    createSessionMiddleware(secrets),
  )
  router.use('/organizations/:id/fabric/apply', createSessionMiddleware(secrets))

  router.get('/organizations/:id/fabric', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    const record = await getOrganizationFabric(db, id)
    if (!record) return c.json(fabricSettingsResponse(null))
    const relays = await listFabricRelays(db, record.id)
    return c.json(
      fabricSettingsResponse(
        record,
        await loadFabricRelayApiRows(
          db,
          relays,
          parseFabricPolicy(record.options).allowRelay,
        ),
      ),
    )
  })

  router.patch('/organizations/:id/fabric/relays/:serverId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const serverId = c.req.param('serverId')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseRelayPatchBody(body)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)

    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    const record = await getOrganizationFabric(db, id)
    if (!record) return fabricNotEnabledErrorResponse()

    const fabricRelays = await listFabricRelays(db, record.id)
    const existing = findByServerId(fabricRelays, serverId)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const role = parsed.patch.role ?? existing.role
    const gatewayDenied = gatewayRolePatchErrorResponse(
      role,
      await assertGatewayRelaysReady(db, [{ serverId, role }]),
    )
    if (gatewayDenied) return gatewayDenied

    const preferredDenied = preferredGatewayPatchErrorResponse(
      parsed.patch,
      fabricRelays,
      serverId,
    )
    if (preferredDenied) return preferredDenied

    const sealedPresharedKey = await resolveSealedRelayPresharedKey(
      parsed.patch.presharedKey,
      bindSecretEncryptFn(c.get('dataEncryptionSecrets'), encryptSecret),
    )
    const updated = await updateFabricRelay(db, {
      fabricId: record.id,
      serverId,
      ...relayPatchUpdateFields(parsed.patch, sealedPresharedKey),
    })
    if (!updated) return c.json({ error: 'Not found' }, 404)

    const enqueueDenied = await enqueueRelayPatchReconcile({
      session: c.get('session'),
      commandQueue: assertDispatchInfrastructure(c),
      db,
      organizationId: id,
      secrets: fabricSecretsFromContext(c),
      reconcile: reconcileFabricMembership,
    })
    if (enqueueDenied) return enqueueDenied

    const relays = await listFabricRelays(db, record.id)
    const row = findByServerId(
      await loadFabricRelayApiRows(
        db,
        relays,
        parseFabricPolicy(record.options).allowRelay,
      ),
      serverId,
    )
    if (!row) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true, relay: row })
  })

  router.post('/organizations/:id/fabric/apply', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    const record = await getOrganizationFabric(db, id)
    if (!record) return fabricNotEnabledErrorResponse()

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const results = await reconcileFabricMembership({
      db,
      commandQueue,
      actorType: 'user',
      actorId: session.userId,
      organizationId: id,
      force: true,
      registry: getDaemonCellRegistry(c),
      ...fabricSecretsFromContext(c),
    })
    const enqueueDenied = fabricTypedEnqueueErrorResponse(results)
    if (enqueueDenied) return enqueueDenied

    return c.json({
      ok: true,
      fabricId: record.id,
      interfaceName: 'tp0',
      results: results.map((row) => ({
        serverId: row.serverId,
        status: row.status,
        ...(row.commandId ? { commandId: row.commandId } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...(row.unreachablePeers && row.unreachablePeers.length > 0
          ? { unreachablePeers: row.unreachablePeers }
          : {}),
        ...(row.gatewayRoutedPeers && row.gatewayRoutedPeers.length > 0
          ? { gatewayRoutedPeers: row.gatewayRoutedPeers }
          : {}),
        ...(row.natCandidates && row.natCandidates > 0
          ? { natCandidates: row.natCandidates }
          : {}),
        ...(row.degradedPeers && row.degradedPeers > 0
          ? { degradedPeers: row.degradedPeers }
          : {}),
      })),
    })
  })

  router.put('/organizations/:id/fabric', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseFabricPutBody(body)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)

    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const secrets = fabricSecretsFromContext(c)

    if (!parsed.enabled) {
      await disableOrganizationFabricForPut({
        db,
        commandQueue,
        organizationId: id,
        actorId: session.userId,
        secrets,
      })
      return c.json(fabricSettingsResponse(null))
    }

    if (parsed.containerPool !== undefined) {
      const poolDenied = await assertContainerPoolWritable(
        c,
        db,
        id,
        parsed.containerPool,
        await getOrganizationFabric(db, id),
      )
      if (poolDenied) return poolDenied
    }

    // The policy rides along with the enable so relay prefixes are carved
    // from the requested pool (never the default) and the fabric row, policy
    // and relays land — or roll back — together.
    const policy: FabricEnablePolicy = {
      ...(parsed.allowRelay === undefined ? {} : { allowRelay: parsed.allowRelay }),
      ...(parsed.containerPool === undefined
        ? {}
        : { containerPool: parsed.containerPool }),
    }
    const record = await enableOrganizationFabricOrResponse(c, db, id, policy)
    if (record instanceof Response) return record
    const enqueueResults = await reconcileFabricMembership({
      db,
      commandQueue,
      actorType: 'user',
      actorId: session.userId,
      organizationId: id,
      registry: getDaemonCellRegistry(c),
      ...secrets,
    })
    const enqueueDenied = fabricTypedEnqueueErrorResponse(enqueueResults)
    if (enqueueDenied) return enqueueDenied
    const relays = await listFabricRelays(db, record.id)
    return c.json(
      fabricSettingsResponse(
        record,
        await loadFabricRelayApiRows(
          db,
          relays,
          parseFabricPolicy(record.options).allowRelay,
        ),
      ),
    )
  })
}
