/**
 * Derived needs-redeploy notice after an automatic membership repin.
 *
 * A hosting's `bindAddress` is resolved from `hosting.ip_id` at deploy time
 * (`resolveHostingBindAddress` in `deploy-prepare.ts`) and frozen into the
 * running Caddy / Traefik config, so a repin cannot heal it — only the next
 * deploy re-reads the pin. This module surfaces which
 * `(server, environment)` targets still run a config built before the pin
 * moved: hostings whose `ip_id` points at a pin with `metadata.repin.at`
 * later than the target's last `deployment.finished_at`, or whose last
 * finished apply did not converge. A target that never finished an apply
 * has nothing running and is not listed.
 *
 * Read-only and derived from `ip.metadata` — there is no durable flag, and
 * nothing here enqueues `environment.deploy`. Shape matches the
 * `needsRedeploy` list of `tls/changeover-fanout.ts` so the console reuses
 * the same notice.
 */

import { and, eq, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { deployment, hosting, ip, service } from '../../lib/db/schema.ts'
import { parseIpPinMetadata } from '../../lib/net/repin.ts'

export type RepinNeedsRedeploy = {
  serverId: string
  environmentId: string
}

type HostingPinRow = {
  environmentId: string
  serverId: string
  deploymentStatus: string
  finishedAt: string | null
  pinMetadata: unknown
}

/** Pure: does this deploy target predate the pin's last repin? */
export function deployTargetNeedsRedeployForRepin(
  row: Readonly<HostingPinRow>,
): boolean {
  const repin = parseIpPinMetadata(row.pinMetadata).repin
  if (!repin) return false
  if (!row.finishedAt) return false
  if (row.deploymentStatus !== 'applied') return true
  const repinAt = Date.parse(repin.at)
  const finishedAt = Date.parse(row.finishedAt)
  if (Number.isNaN(repinAt) || Number.isNaN(finishedAt)) return false
  return repinAt > finishedAt
}

function dedupe(rows: readonly HostingPinRow[]): RepinNeedsRedeploy[] {
  const seen = new Set<string>()
  const out: RepinNeedsRedeploy[] = []
  for (const row of rows) {
    if (!deployTargetNeedsRedeployForRepin(row)) continue
    const key = `${row.serverId}:${row.environmentId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ serverId: row.serverId, environmentId: row.environmentId })
  }
  return out
}

/**
 * Deploy targets of one environment whose running hosting config predates a
 * repin of the pin their `hosting.ip_id` names.
 */
export async function loadRepinNeedsRedeployForEnvironment(
  db: Db,
  environmentId: string,
): Promise<RepinNeedsRedeploy[]> {
  const rows = await db
    .select({
      environmentId: service.environmentId,
      serverId: deployment.serverId,
      deploymentStatus: deployment.status,
      finishedAt: deployment.finishedAt,
      pinMetadata: ip.metadata,
    })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .innerJoin(ip, eq(ip.id, hosting.ipId))
    .innerJoin(deployment, eq(deployment.environmentId, service.environmentId))
    .where(
      and(
        eq(service.environmentId, environmentId),
        isNotNull(hosting.ipId),
        eq(ip.scope, 'datacenter'),
      ),
    )
  return dedupe(rows)
}
