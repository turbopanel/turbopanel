/**
 * Resolve the host/port a compose service dials for a managed cluster.
 *
 * A placed consuming service always dials **its own server's** ProxySQL
 * listener (Postgres family / MySQL family ports, defaulting to 15432 / 13306
 * and overridable per organization), addressed by Docker
 * container name on the organization's managed network — never a
 * host-published address and never the engine-native port. That listener
 * routes to local or remote engine backends over the private path
 * (configured by `managed.ingress.reconcile` on the consumer host). This is
 * independent of the cluster's public `exposure` setting: a compose service
 * on the same Docker host reaches ProxySQL over the internal network
 * regardless of whether ProxySQL also publishes a host port, so a `127.0.0.1`
 * (loopback-only) endpoint would be unreachable from inside a container even
 * when exposure is enabled. Never returns an engine container address.
 */

import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  binding,
  environment,
  ip,
  replica,
  organization,
  principal,
  project,
  server,
  service,
  slot,
} from '../../lib/db/schema.ts'
import {
  managedIngressPortForEngine,
  resolveManagedIngressPorts,
} from '../../lib/managed/ingress-ports.ts'
import type { PrivateEndpointError } from '../../lib/net/private-endpoint.ts'
import { parseOrganizationOptions } from '../../lib/organization-options.ts'
import {
  parseProjectOptions,
  resolveEffectivePlacementServerId,
} from '../../lib/project-options.ts'
import { ensureManagedIngressHierarchy } from '../system/hierarchy.ts'
import { isPrivateEndpointError } from '../../lib/net/private-endpoint.ts'

export type BindingEndpointError =
  | PrivateEndpointError
  | { kind: 'binding_endpoint_unavailable' }

export type ResolvedBindingEndpoint = {
  /** Docker container name of the target server's ProxySQL frontend. */
  host: string
  port: number
  /** True when the cluster has at least one `read_eligible` replica. */
  readSplit: boolean
  listenerServerId: string
}

export function isBindingEndpointError(
  value: unknown,
): value is BindingEndpointError {
  return (
    isPrivateEndpointError(value) ||
    (typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      (value as { kind: string }).kind === 'binding_endpoint_unavailable')
  )
}

/**
 * Resolve the placement server for a compose service (environment pin, else
 * project default). Exported for binding-side ingress reconcile fan-out.
 */
export async function loadServicePlacementServerId(
  db: Db,
  serviceId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      environmentServerId: environment.serverId,
      projectOptions: project.options,
    })
    .from(service)
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .where(eq(service.id, serviceId))
    .limit(1)
  if (!row) return null
  return resolveEffectivePlacementServerId(
    row.environmentServerId,
    parseProjectOptions(row.projectOptions),
  )
}

async function loadClusterMembers(
  db: Db,
  managedId: string,
): Promise<
  Array<
    { serverId: string; role: string; ordinal: number; readEligible: boolean }
  >
> {
  return await db
    .select({
      serverId: replica.serverId,
      role: replica.role,
      ordinal: replica.ordinal,
      readEligible: replica.isReadEligible,
    })
    .from(replica)
    .where(eq(replica.managedId, managedId))
    .orderBy(
      // Primary first, then lowest ordinal.
      sql`CASE WHEN ${replica.role} = 'primary' THEN 0 ELSE 1 END`,
      asc(replica.ordinal),
    )
}

/**
 * Docker container name and client port of `serverId`'s ProxySQL frontend,
 * provisioning the per-server managed-ingress hierarchy if it does not exist
 * yet. Reachable from any compose service on the same host that joins the
 * organization's managed network — never a `127.0.0.1` / host-published
 * address, which a container cannot dial across its own network namespace.
 *
 * The listener port comes from the **server-owner** organization, not the
 * consuming project's org: `managed.ingress.reconcile` is a whole-server
 * command, so the port that frontend actually binds is whatever
 * `server.organization_id` configured. Those differ for a grant-placed
 * cross-org project, and reading the consumer's org there would hand out a DSN
 * pointing at a port nothing is listening on.
 */
async function listenerForServer(
  db: Db,
  params: Readonly<{
    serverId: string
    engineCode: string
    engineDefaultPort: number
  }>,
): Promise<{ host: string; port: number } | null> {
  const [row] = await db
    .select({
      organizationId: server.organizationId,
      organizationOptions: organization.options,
    })
    .from(server)
    .innerJoin(organization, eq(server.organizationId, organization.id))
    .where(eq(server.id, params.serverId))
    .limit(1)
  if (!row?.organizationId) return null

  const hierarchy = await ensureManagedIngressHierarchy(db, {
    organizationId: row.organizationId,
    serverId: params.serverId,
  })
  const ports = resolveManagedIngressPorts(
    parseOrganizationOptions(row.organizationOptions).managedDatabase?.ports,
  )
  return {
    host: hierarchy.containerName,
    port: managedIngressPortForEngine(
      params.engineCode,
      params.engineDefaultPort,
      ports,
    ),
  }
}

/**
 * What host/port does service *S* dial for managed cluster *M*?
 *
 * Placed consumers always use **their own server's** ProxySQL listener
 * (by container name, over the organization's managed network) so traffic stays
 * on-box and ProxySQL peers over private/VPN to remote engines. This is
 * independent of the cluster's `exposure` setting — same-host container
 * reachability never depends on whether ProxySQL also publishes a host port.
 */
export async function resolveBindingEndpoint(
  db: Db,
  params: Readonly<{
    serviceId: string
    managedId: string
    engineCode: string
    engineDefaultPort: number
  }>,
): Promise<ResolvedBindingEndpoint | BindingEndpointError> {
  const members = await loadClusterMembers(db, params.managedId)
  if (members.length === 0) {
    return { kind: 'binding_endpoint_unavailable' }
  }

  const readSplit = members.some((m) => m.readEligible)
  const serviceServerId = await loadServicePlacementServerId(
    db,
    params.serviceId,
  )
  // No service placement yet (deploy prerequisite unmet) — fall back to a
  // cluster member's server (primary first) as a best-effort display target.
  const targetServerId = serviceServerId ?? members[0]!.serverId

  const listener = await listenerForServer(db, {
    serverId: targetServerId,
    engineCode: params.engineCode,
    engineDefaultPort: params.engineDefaultPort,
  })
  if (!listener) {
    return { kind: 'binding_endpoint_unavailable' }
  }
  return {
    host: listener.host,
    port: listener.port,
    readSplit,
    listenerServerId: targetServerId,
  }
}

/** Whether a managed cluster `replica` row exists for this (managed, server) pair. */
export async function memberServerIdsForManaged(
  db: Db,
  managedId: string,
): Promise<string[]> {
  const rows = await db
    .select({ serverId: replica.serverId })
    .from(replica)
    .where(and(eq(replica.managedId, managedId)))
  return rows.map((r) => r.serverId)
}

/**
 * Distinct managed clusters with at least one member pinned into the given
 * datacenter (`ip.scope='datacenter'` rows joined to `replica.server_id`).
 * Used by `PATCH /datacenters/:id` to re-converge member transports when the
 * datacenter's routing policy changes.
 */
export async function listManagedIdsForDatacenter(
  db: Db,
  datacenterId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ managedId: replica.managedId })
    .from(replica)
    .innerJoin(ip, eq(ip.serverId, replica.serverId))
    .where(
      and(
        eq(ip.scope, 'datacenter'),
        eq(ip.datacenterId, datacenterId),
      ),
    )
  return rows.map((row) => row.managedId)
}

/**
 * Distinct managed clusters with a replica on the given server. Paired with
 * {@link listManagedIdsForDatacenter} by the automatic-repin sweep: the
 * datacenter set covers every peer whose transport ladder result could have
 * moved, the server set covers the repinned host's own engine listeners and
 * ProxySQL backends.
 */
export async function listManagedIdsForServer(
  db: Db,
  serverId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ managedId: replica.managedId })
    .from(replica)
    .where(eq(replica.serverId, serverId))
  return rows.map((row) => row.managedId)
}

/**
 * Servers that host a compose service bound to this managed cluster.
 * Inverse of `loadBoundManagedIdsForServer`: env pin, project default, and
 * any `slot.serverId`. One query — no per-service round trips.
 */
export async function consumerServerIdsForManaged(
  db: Db,
  managedId: string,
): Promise<string[]> {
  const rows = await db
    .select({
      environmentServerId: environment.serverId,
      projectOptions: project.options,
      taskServerId: slot.serverId,
    })
    .from(binding)
    .innerJoin(principal, eq(binding.principalId, principal.id))
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .leftJoin(slot, eq(slot.serviceId, service.id))
    .where(eq(principal.managedId, managedId))

  const ids = new Set<string>()
  for (const row of rows) {
    const placement = resolveEffectivePlacementServerId(
      row.environmentServerId,
      parseProjectOptions(row.projectOptions),
    )
    if (placement) ids.add(placement)
    if (row.taskServerId) ids.add(row.taskServerId)
  }
  return [...ids]
}
