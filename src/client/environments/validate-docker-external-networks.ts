import { and, eq, or, isNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { EnvironmentDeployDockerNetwork } from '../../lib/commands/schemas.ts'
import { network } from '../../lib/db/schema.ts'
import {
  readNetworkDockerAddressing,
  readNetworkDockerNetworkName,
} from '../../lib/docker-network-name.ts'

export type ResolvedExternalDockerNetworks = {
  /** Compose names with no matching `kind='docker'` registration, sorted. */
  missing: string[] | null
  /**
   * Addressing for the matched rows that carry any, sorted by name — rides
   * `environment.deploy` as `dockerNetworkAddressing`. A registration with
   * no `cidr` / addressing keys is absent here (the daemon creates it bare).
   */
  addressing: EnvironmentDeployDockerNetwork[]
}

/**
 * Resolve the compose document's `external: true` Docker networks against
 * the org's `kind='docker'` registrations visible to this server (org-wide
 * or pinned to it): which names are unregistered, and the addressing the
 * registered ones were declared with. One query serves both — the rows
 * loaded for the registration check are exactly the rows whose addressing
 * the daemon needs.
 */
export async function resolveRegisteredExternalDockerNetworks(
  db: Db,
  organizationId: string,
  serverId: string,
  requiredNames: readonly string[],
): Promise<ResolvedExternalDockerNetworks> {
  if (requiredNames.length === 0) return { missing: null, addressing: [] }

  const rows = await db
    .select({
      serverId: network.serverId,
      cidr: network.cidr,
      options: network.options,
      metadata: network.metadata,
    })
    .from(network)
    .where(
      and(
        eq(network.organizationId, organizationId),
        eq(network.kind, 'docker'),
        or(isNull(network.serverId), eq(network.serverId, serverId)),
      ),
    )

  const required = new Set(requiredNames)
  const registered = new Set<string>()
  const addressingByName = new Map<string, EnvironmentDeployDockerNetwork>()
  for (const row of rows) {
    const name = readNetworkDockerNetworkName(row.options, row.metadata)
    if (!name) continue
    registered.add(name)
    if (!required.has(name) || addressingByName.has(name)) continue
    const addressing = readNetworkDockerAddressing(
      typeof row.cidr === 'string' ? row.cidr : null,
      row.options,
    )
    if (Object.keys(addressing).length === 0) continue
    addressingByName.set(name, { name, ...addressing })
  }

  const missing = requiredNames.filter((name) => !registered.has(name))
  return {
    missing: missing.length > 0
      ? missing.toSorted((a, b) => a.localeCompare(b))
      : null,
    addressing: [...addressingByName.values()].toSorted((a, b) =>
      a.name.localeCompare(b.name)
    ),
  }
}

/** Registration check only — `null` when every name is registered. */
export async function validateRegisteredExternalDockerNetworks(
  db: Db,
  organizationId: string,
  serverId: string,
  requiredNames: readonly string[],
): Promise<string[] | null> {
  const resolved = await resolveRegisteredExternalDockerNetworks(
    db,
    organizationId,
    serverId,
    requiredNames,
  )
  return resolved.missing
}
