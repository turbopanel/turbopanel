/**
 * DB round trip for the automatic membership repin.
 *
 * Runs as a best-effort follow-up of the change-detected
 * `touchServerMetadata` write (see `src/server-registry.ts`) whenever a
 * daemon's reported `resources.ips` moved. It loads the server's pins, asks
 * {@link decideRepinActions} what to do, and writes only `ip.address` /
 * `ip.metadata`:
 *
 * - `repin` → new address + `metadata.repin { at, from, pendingFanoutAt }`
 *   (any `stale` flag dropped);
 * - `mark_stale` → `metadata.stale { since, reason }`;
 * - `clear_stale` → `stale` removed.
 *
 * Nothing is enqueued here: hello / Durable Object handlers must not enqueue
 * commands, so the routing fan-out is deferred to the maintenance sweep
 * (`src/client/datacenters/repin-fanout.ts`), which selects pins by
 * `metadata.repin.pendingFanoutAt`.
 *
 * The common case — a server with no pins — costs one indexed read. Never
 * throws: a failed write is logged and the rest of the pass continues.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { ip } from '../db/schema.ts'
import { inetAddressToString } from '../ip-address.ts'
import { compatLogWarn } from '../../log-compat.ts'
import type { ServerReportedIp } from '../../server-addresses.ts'
import { isIpAddressUniqueViolation } from '../../client/ips/ip-create-validation.ts'
import {
  type DatacenterMembershipPinDetailRow,
  loadDatacenterMembershipPinDetailsForServers,
  normalizeReportedPrivateAddresses,
  validateMemberPinAddress,
} from './datacenter-membership.ts'
import {
  clearedStaleMetadata,
  decideRepinActions,
  parseIpPinMetadata,
  type RepinAction,
  type RepinPinInput,
  type RepinStaleReason,
  withRepinMetadata,
  withStaleMetadata,
} from './repin.ts'

const LOG_COMPONENT = 'datacenter-repin'

type PinDetail = DatacenterMembershipPinDetailRow & {
  networkId: string
  subnetCidr: string
}

function isRepinablePin(
  pin: DatacenterMembershipPinDetailRow,
): pin is PinDetail {
  return pin.networkId !== null && pin.subnetCidr !== null
}

function toRepinInput(pin: PinDetail): RepinPinInput {
  return {
    ipId: pin.ipId,
    serverId: pin.serverId,
    datacenterId: pin.datacenterId,
    networkId: pin.networkId,
    address: pin.address,
    subnetCidr: pin.subnetCidr,
    stale: parseIpPinMetadata(pin.metadata).stale !== undefined,
  }
}

/**
 * Org-wide `ip.address` values among the candidate set. Only the candidates
 * are looked up (`WHERE organization_id = … AND address IN (…)`), never the
 * whole table. The server's own pin addresses are excluded so a pin never
 * blocks itself.
 */
async function loadAddressesInUse(
  db: Db,
  organizationId: string,
  candidates: readonly string[],
  ownPinIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const inUse = new Set<string>()
  if (candidates.length === 0) return inUse
  const rows = await db
    .select({ id: ip.id, address: ip.address })
    .from(ip)
    .where(
      and(
        eq(ip.organizationId, organizationId),
        inArray(ip.address, [...candidates]),
      ),
    )
  for (const row of rows) {
    if (ownPinIds.has(row.id)) continue
    const address = inetAddressToString(row.address)
    if (address) inUse.add(address)
  }
  return inUse
}

async function writeRepin(
  db: Db,
  pin: PinDetail,
  action: Extract<RepinAction, { kind: 'repin' }>,
  serverMetadata: unknown,
  nowIso: string,
): Promise<RepinAction> {
  const validated = validateMemberPinAddress(
    action.to,
    pin.subnetCidr,
    serverMetadata,
  )
  if (!validated.ok) {
    compatLogWarn(
      LOG_COMPONENT,
      `repin ${pin.ipId} ${action.from} -> ${action.to} rejected: ${validated.error}`,
    )
    return writeStale(db, pin, 'address_gone_no_candidate', nowIso)
  }
  try {
    await db
      .update(ip)
      .set({
        address: validated.address,
        metadata: withRepinMetadata(pin.metadata, {
          at: nowIso,
          from: action.from,
          pendingFanoutAt: nowIso,
        }),
        updatedAt: nowIso,
      })
      .where(eq(ip.id, pin.ipId))
    return action
  } catch (err) {
    if (!isIpAddressUniqueViolation(err)) throw err
    // Lost the race for the address (another row claimed it between the
    // in-use lookup and this write). Never abort the pass — flag instead.
    return writeStale(db, pin, 'address_gone_ambiguous', nowIso)
  }
}

async function writeStale(
  db: Db,
  pin: PinDetail,
  reason: RepinStaleReason,
  nowIso: string,
): Promise<RepinAction> {
  await db
    .update(ip)
    .set({
      metadata: withStaleMetadata(pin.metadata, { since: nowIso, reason }),
      updatedAt: nowIso,
    })
    .where(eq(ip.id, pin.ipId))
  return { kind: 'mark_stale', ipId: pin.ipId, reason }
}

async function writeClearStale(
  db: Db,
  pin: PinDetail,
  nowIso: string,
): Promise<RepinAction> {
  await db
    .update(ip)
    .set({
      metadata: clearedStaleMetadata(pin.metadata),
      updatedAt: nowIso,
    })
    .where(eq(ip.id, pin.ipId))
  return { kind: 'clear_stale', ipId: pin.ipId }
}

async function applyAction(
  db: Db,
  pin: PinDetail,
  action: RepinAction,
  serverMetadata: unknown,
  nowIso: string,
): Promise<RepinAction> {
  switch (action.kind) {
    case 'repin':
      return writeRepin(db, pin, action, serverMetadata, nowIso)
    case 'mark_stale':
      return writeStale(db, pin, action.reason, nowIso)
    case 'clear_stale':
      return writeClearStale(db, pin, nowIso)
  }
}

/**
 * Re-point / flag the server's membership pins against its freshly reported
 * addresses. Returns the actions actually applied (a `repin` that lost a
 * unique race comes back as `mark_stale`). Never throws.
 *
 * `reportedIps` is the daemon's full reported list; `validateMemberPinAddress`
 * needs it in `server.metadata` shape, so a `{ resources: { ips } }` view is
 * built for the re-validation step.
 */
export async function applyReportedAddressRepin(
  db: Db,
  serverId: string,
  reportedIps: ServerReportedIp[] | null | undefined,
): Promise<RepinAction[]> {
  try {
    const byServer = await loadDatacenterMembershipPinDetailsForServers(db, [
      serverId,
    ])
    const pins = (byServer.get(serverId) ?? []).filter(isRepinablePin)
    if (pins.length === 0) return []

    const reported = normalizeReportedPrivateAddresses(reportedIps)
    const ownPinIds = new Set(pins.map((pin) => pin.ipId))
    const organizationId = pins[0]?.organizationId
    if (!organizationId) return []
    const addressesInUse = await loadAddressesInUse(
      db,
      organizationId,
      reported,
      ownPinIds,
    )

    const decided = decideRepinActions({
      pins: pins.map(toRepinInput),
      reportedPrivateAddresses: reported,
      addressesInUse,
    })
    if (decided.length === 0) return []

    const byIpId = new Map(pins.map((pin) => [pin.ipId, pin]))
    const serverMetadata = { resources: { ips: reportedIps ?? [] } }
    const nowIso = new Date().toISOString()
    const applied: RepinAction[] = []
    for (const action of decided) {
      const pin = byIpId.get(action.ipId)
      if (!pin) continue
      try {
        applied.push(
          await applyAction(db, pin, action, serverMetadata, nowIso),
        )
      } catch (err) {
        compatLogWarn(
          LOG_COMPONENT,
          `${action.kind} for pin ${action.ipId} on server ${serverId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    return applied
  } catch (err) {
    compatLogWarn(
      LOG_COMPONENT,
      `repin pass for server ${serverId} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }
}
