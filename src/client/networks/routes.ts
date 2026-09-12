import { and, eq, inArray } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { network } from '../../lib/db/schema.ts'
import {
  assertCidrAvailable,
  cidrWriteIntentForKind,
} from '../../lib/net/cidr-collisions.ts'
import { canAccessOrganization } from '../org-context.ts'
import {
  assertCanCreateOr403,
  assertCanManageOr403,
  assertCanReadOr403,
  getOrgId,
  parseJsonBody,
  parseJsonbObject,
} from '../shared.ts'
import {
  assertDatacenterCidr,
  assertNetworkKindScope,
  buildNetworkCreateValues,
  cidrCollisionResponse,
  type NetworkCreateFields,
} from './network-scope.ts'
import {
  parseCreateNetworkOptions,
  parseCreateOrganizationId,
  parseNetworkKind,
  parseNetworkPatchFields,
  parseOptionalCidrField,
  parseOptionalNameField,
  parseUuidQueryParam,
  reconcileDockerNetworkAddressing,
  rejectImmutableNetworkScopePatch,
  resolveKindQueryFilter,
  UUID_RE,
} from './routes-pure.ts'

export {
  assertDatacenterCidr,
  assertNetworkKindScope,
  buildNetworkCreateValues,
  cidrCollisionResponse,
} from './network-scope.ts'

const NETWORK_SELECT = {
  id: network.id,
  organizationId: network.organizationId,
  datacenterId: network.datacenterId,
  serverId: network.serverId,
  kind: network.kind,
  cidr: network.cidr,
  name: network.name,
  metadata: network.metadata,
  options: network.options,
  createdAt: network.createdAt,
  updatedAt: network.updatedAt,
}

async function validateOptionalScopeId(
  c: Context,
  db: Db,
  organizationId: string,
  kind: 'datacenter' | 'server',
  raw: unknown,
): Promise<string | null | undefined | Response> {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const entityOrgId = await resolveEntityOrganizationId(db, kind, raw)
  if (entityOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  return raw
}

async function resolveOrgScopedQueryFilter(
  c: Context,
  db: Db,
  organizationId: string,
  queryKey: 'datacenterId' | 'serverId',
  kind: 'datacenter' | 'server',
): Promise<string | undefined | Response> {
  const raw = parseUuidQueryParam(c, c.req.query(queryKey))
  if (raw instanceof Response) return raw
  if (!raw) return undefined
  const entityOrgId = await resolveEntityOrganizationId(db, kind, raw)
  if (entityOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  return raw
}

async function resolveCreateNetworkOrganization(
  c: Context,
  db: Db,
  userId: string,
  body: Record<string, unknown>,
): Promise<string | Response> {
  const orgIdRaw = parseCreateOrganizationId(c, body)
  if (orgIdRaw instanceof Response) return orgIdRaw

  const orgAllowed = await canAccessOrganization(db, userId, orgIdRaw)
  if (!orgAllowed) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  return orgIdRaw
}

async function parseNetworkCreateFields(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<NetworkCreateFields | Response> {
  const kind = parseNetworkKind(c, body)
  if (kind instanceof Response) return kind

  const datacenterId = await validateOptionalScopeId(
    c,
    db,
    organizationId,
    'datacenter',
    body.datacenterId,
  )
  if (datacenterId instanceof Response) return datacenterId

  const serverId = await validateOptionalScopeId(
    c,
    db,
    organizationId,
    'server',
    body.serverId,
  )
  if (serverId instanceof Response) return serverId

  const scopeDenied = assertNetworkKindScope(c, kind, datacenterId, serverId)
  if (scopeDenied) return scopeDenied

  const name = parseOptionalNameField(c, body)
  if (name instanceof Response) return name

  const cidr = parseOptionalCidrField(c, body)
  if (cidr instanceof Response) return cidr

  const cidrDenied = assertDatacenterCidr(c, kind, cidr)
  if (cidrDenied) return cidrDenied

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult

  const optionsResult = parseCreateNetworkOptions(c, body, kind)
  if (optionsResult instanceof Response) return optionsResult

  if (kind === 'docker') {
    // `cidr` and `options.subnet` are two views of one range — accept either
    // and write both, refuse a pair that disagrees.
    const reconciled = reconcileDockerNetworkAddressing(c, {
      cidr,
      options: optionsResult ?? {},
    })
    if (reconciled instanceof Response) return reconciled
    return {
      kind,
      datacenterId,
      serverId,
      name,
      cidr: reconciled.cidr,
      metadata: metadataResult,
      options: reconciled.options,
    }
  }

  return {
    kind,
    datacenterId,
    serverId,
    name,
    cidr,
    metadata: metadataResult,
    options: optionsResult,
  }
}

export function registerNetworkRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for network routes')
  }
  const secrets = opts.secrets

  router.use('/networks', createSessionMiddleware(secrets))
  router.use('/networks/:id', createSessionMiddleware(secrets))

  router.get('/networks', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const manageDenied = await assertCanManageOr403(c, 'organization', organizationId)
    if (manageDenied) return manageDenied

    const visibleIds = await listVisible(db, {
      kind: 'network',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ networks: [] })
    }

    const conditions = [
      inArray(network.id, visibleIds),
      eq(network.organizationId, organizationId),
    ]

    const datacenterFilter = await resolveOrgScopedQueryFilter(
      c,
      db,
      organizationId,
      'datacenterId',
      'datacenter',
    )
    if (datacenterFilter instanceof Response) return datacenterFilter
    if (datacenterFilter) {
      conditions.push(eq(network.datacenterId, datacenterFilter))
    }

    const serverFilter = await resolveOrgScopedQueryFilter(
      c,
      db,
      organizationId,
      'serverId',
      'server',
    )
    if (serverFilter instanceof Response) return serverFilter
    if (serverFilter) {
      conditions.push(eq(network.serverId, serverFilter))
    }

    const kindFilter = resolveKindQueryFilter(c)
    if (kindFilter instanceof Response) return kindFilter
    if (kindFilter) {
      conditions.push(eq(network.kind, kindFilter))
    }

    const rows = await db
      .select(NETWORK_SELECT)
      .from(network)
      .where(and(...conditions))
      .orderBy(network.createdAt)

    return c.json({ networks: rows })
  })

  router.get('/networks/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'network', id)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'network', id)
    if (denied) return denied

    const [row] = await db
      .select(NETWORK_SELECT)
      .from(network)
      .where(eq(network.id, id))
      .limit(1)

    if (!row) return c.json({ error: 'Not found' }, 404)

    return c.json({ network: row })
  })

  router.post('/networks', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const organizationId = await resolveCreateNetworkOrganization(
      c,
      db,
      session.userId,
      body,
    )
    if (organizationId instanceof Response) return organizationId

    const denied = await assertCanCreateOr403(c, 'organization', organizationId)
    if (denied) return denied

    const fields = await parseNetworkCreateFields(c, db, organizationId, body)
    if (fields instanceof Response) return fields

    // Every CIDR write goes through the one collision authority — a site
    // subnet, a reserved range or a docker registration must not overlap the
    // fabric, a reserved hole, another registration or another site subnet.
    if (fields.cidr !== null) {
      const collision = await assertCidrAvailable(db, {
        organizationId,
        cidr: fields.cidr,
        intent: cidrWriteIntentForKind(fields.kind),
        datacenterId: fields.datacenterId ?? null,
      })
      if (collision) return cidrCollisionResponse(c, collision)
    }

    const [inserted] = await db
      .insert(network)
      .values(buildNetworkCreateValues({ organizationId, ...fields }))
      .returning({ id: network.id })

    const id = inserted?.id
    if (!id) return c.json({ error: 'Failed to create network' }, 500)

    return c.json({ ok: true as const, id })
  })

  router.patch('/networks/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'network', id)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'network', id)
    if (denied) return denied

    const [existing] = await db
      .select({
        kind: network.kind,
        datacenterId: network.datacenterId,
        cidr: network.cidr,
        options: network.options,
      })
      .from(network)
      .where(eq(network.id, id))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    // Platform-allocated org-wide managed-engine network — the registry row is
    // read-only to operators, so refuse before reading any patch body.
    // (`reserved` rows are operator data: rename and re-range are allowed.)
    if (existing.kind === 'managed') {
      return c.json({ error: 'managed_network_immutable' }, 400)
    }

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const scopePatchDenied = rejectImmutableNetworkScopePatch(c, body)
    if (scopePatchDenied) return scopePatchDenied

    // Docker rows reconcile `cidr` against the stored `options.subnet` (and
    // vice versa), so the patch parser needs the row as it stands.
    const patchFields = parseNetworkPatchFields(c, body, existing.kind, {
      cidr: existing.cidr ?? null,
      options: existing.options,
    })
    if (patchFields instanceof Response) return patchFields

    // Re-ranging goes through the same authority as create; the row itself is
    // excluded so an unchanged or narrowed CIDR never collides with itself.
    if (typeof patchFields.cidr === 'string') {
      const collision = await assertCidrAvailable(db, {
        organizationId,
        cidr: patchFields.cidr,
        intent: cidrWriteIntentForKind(existing.kind),
        datacenterId: existing.datacenterId ?? null,
        excludeNetworkId: id,
      })
      if (collision) return cidrCollisionResponse(c, collision)
    }

    await db.update(network).set(patchFields).where(eq(network.id, id))

    return c.json({ ok: true as const })
  })

  router.delete('/networks/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'network', id)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'network', id)
    if (denied) return denied

    const [existing] = await db
      .select({ kind: network.kind })
      .from(network)
      .where(eq(network.id, id))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    // Platform-allocated org-wide managed-engine network — reclaiming it is
    // not an operator action.
    if (existing.kind === 'managed') {
      return c.json({ error: 'managed_network_immutable' }, 400)
    }

    await db.delete(network).where(eq(network.id, id))

    return c.json({ ok: true as const })
  })
}
