import type { Context } from 'hono'
import type { CidrCollision } from '../../lib/net/cidr-collisions.ts'

export function assertNetworkKindScope(
  c: Context,
  kind: string,
  datacenterId: string | null | undefined,
  serverId: string | null | undefined,
): Response | null {
  const hasDatacenter = datacenterId !== undefined && datacenterId !== null
  const hasServer = serverId !== undefined && serverId !== null

  if (hasDatacenter && hasServer) {
    return c.json({ error: 'network_single_scope_conflict' }, 400)
  }

  if (kind === 'datacenter') {
    if (!hasDatacenter) {
      return c.json({ error: 'network_scope_required' }, 400)
    }
    if (hasServer) {
      return c.json({ error: 'network_single_scope_conflict' }, 400)
    }
    return null
  }

  // reserved: org-only — a reserved range is not attached to any datacenter
  // or host, it is a hole the whole organization must route around.
  if (kind === 'reserved') {
    if (hasDatacenter || hasServer) {
      return c.json({ error: 'network_single_scope_conflict' }, 400)
    }
    return null
  }

  // docker: optional serverId (host-local external network); never datacenterId
  if (hasDatacenter) {
    return c.json({ error: 'network_single_scope_conflict' }, 400)
  }
  return null
}

/**
 * Site subnets (`kind='datacenter'`) and reserved ranges (`kind='reserved'`)
 * require a CIDR; docker does not.
 */
export function assertDatacenterCidr(
  c: Context,
  kind: string,
  cidr: string | null,
): Response | null {
  if ((kind === 'datacenter' || kind === 'reserved') && cidr === null) {
    return c.json({ error: 'network_cidr_required' }, 400)
  }
  return null
}

/**
 * Map a collision from `src/lib/net/cidr-collisions.ts` onto the wire: **409**
 * with the collision code as `error`, plus the candidate and the range it hit
 * so an operator can see *what* is in the way, not just that something is.
 */
export function cidrCollisionResponse(
  c: Context,
  collision: CidrCollision,
): Response {
  return c.json(
    {
      error: collision.code,
      cidr: collision.cidr,
      conflictingCidr: collision.conflictingCidr,
      ...(collision.networkId ? { networkId: collision.networkId } : {}),
      ...(collision.datacenterId
        ? { datacenterId: collision.datacenterId }
        : {}),
    },
    409,
  )
}

export type NetworkCreateFields = {
  kind: string
  datacenterId: string | null | undefined
  serverId: string | null | undefined
  name: string | null
  cidr: string | null
  metadata: Record<string, unknown> | null
  options: Record<string, unknown> | null
}

export function buildNetworkCreateValues(input: {
  organizationId: string
} & NetworkCreateFields) {
  return {
    organizationId: input.organizationId,
    kind: input.kind,
    ...(input.datacenterId !== undefined ? { datacenterId: input.datacenterId } : {}),
    ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
    ...(input.name !== null ? { name: input.name } : {}),
    ...(input.cidr !== null ? { cidr: input.cidr } : {}),
    ...(input.metadata !== null ? { metadata: input.metadata } : {}),
    ...(input.options !== null ? { options: input.options } : {}),
  }
}
