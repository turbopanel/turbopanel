/**
 * Host-free coverage for the repin apply pass: a fake `Db` records every
 * `ip` write so the tests can assert exactly what the pass touches.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { ServerReportedIp } from '../../server-addresses.ts'
import { applyReportedAddressRepin } from './repin-apply.ts'
import { parseIpPinMetadata } from './repin.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER = '00000000-0000-4000-8000-0000000000a1'
const ORG = '00000000-0000-4000-8000-0000000000b1'
const DC = '00000000-0000-4000-8000-0000000000d1'
const NET = '00000000-0000-4000-8000-0000000000e4'

type PinRow = {
  ipId: string
  serverId: string
  datacenterId: string
  networkId: string | null
  address: string
  organizationId: string
  metadata: unknown
  subnetCidr: string | null
}

type Write = { patch: Record<string, unknown> }

function thenable<T>(rows: T[]) {
  return {
    then(
      resolve: (value: T[]) => unknown,
      reject?: (err: unknown) => unknown,
    ) {
      return Promise.resolve(rows).then(resolve, reject)
    },
  }
}

/**
 * `select` dispatches on the projection: the pin-detail load selects
 * `subnetCidr`; the in-use lookup selects `{ id, address }` only.
 */
function createFakeDb(params: {
  pins: PinRow[]
  inUse?: Array<{ id: string; address: string }>
  writes: Write[]
  failWriteWith?: (patch: Record<string, unknown>) => unknown
}): Db {
  return {
    select(fields: Record<string, unknown>) {
      const rows: unknown[] = 'subnetCidr' in fields
        ? params.pins
        : (params.inUse ?? [])
      const chain = {
        from: () => chain,
        leftJoin: () => chain,
        where: () => thenable(rows),
      }
      return chain
    },
    update() {
      return {
        set(patch: Record<string, unknown>) {
          return {
            where: () => {
              const failure = params.failWriteWith?.(patch)
              if (failure) return Promise.reject(failure)
              params.writes.push({ patch })
              return Promise.resolve(undefined)
            },
          }
        },
      }
    },
  } as unknown as Db
}

function pin(overrides: Partial<PinRow> = {}): PinRow {
  return {
    ipId: 'ip-1',
    serverId: SERVER,
    datacenterId: DC,
    networkId: NET,
    address: '10.20.0.10',
    organizationId: ORG,
    metadata: null,
    subnetCidr: '10.20.0.0/24',
    ...overrides,
  }
}

function reported(...addresses: string[]): ServerReportedIp[] {
  return addresses.map((address) => ({
    address,
    version: address.includes(':') ? 6 : 4,
    scope: 'private',
  }))
}

test('applyReportedAddressRepin: no pins → zero writes', async () => {
  const writes: Write[] = []
  const db = createFakeDb({ pins: [], writes })
  const applied = await applyReportedAddressRepin(
    db,
    SERVER,
    reported('10.20.0.42'),
  )
  assertEquals(applied, [])
  assertEquals(writes.length, 0)
})

test('applyReportedAddressRepin: unchanged pin → zero writes', async () => {
  const writes: Write[] = []
  const db = createFakeDb({ pins: [pin()], writes })
  const applied = await applyReportedAddressRepin(
    db,
    SERVER,
    reported('10.20.0.10'),
  )
  assertEquals(applied, [])
  assertEquals(writes.length, 0)
})

test('applyReportedAddressRepin: a repin stamps pendingFanoutAt and clears stale', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [pin({
      metadata: {
        note: 'keep',
        stale: { since: '2026-09-01T00:00:00.000Z', reason: 'address_gone_no_candidate' },
      },
    })],
    writes,
  })
  const applied = await applyReportedAddressRepin(
    db,
    SERVER,
    reported('10.20.0.42'),
  )
  assertEquals(applied, [
    { kind: 'repin', ipId: 'ip-1', from: '10.20.0.10', to: '10.20.0.42' },
  ])
  assertEquals(writes.length, 1)
  const patch = writes[0]?.patch
  if (!patch) throw new TypeError('expected one ip write')
  assertEquals(patch.address, '10.20.0.42')
  const metadata = patch.metadata as Record<string, unknown>
  assertEquals(metadata.note, 'keep')
  const parsed = parseIpPinMetadata(metadata)
  assertEquals(parsed.stale, undefined)
  assertEquals(parsed.repin?.from, '10.20.0.10')
  assertEquals(typeof parsed.repin?.pendingFanoutAt, 'string')
  assertEquals(parsed.repin?.pendingFanoutAt, parsed.repin?.at)
})

test('applyReportedAddressRepin: unique violation on repin downgrades to mark_stale', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [pin()],
    writes,
    failWriteWith: (patch) =>
      'address' in patch
        ? Object.assign(new Error('duplicate key uniq_ip_org_address'), {
          code: '23505',
        })
        : undefined,
  })
  const applied = await applyReportedAddressRepin(
    db,
    SERVER,
    reported('10.20.0.42'),
  )
  assertEquals(applied, [
    { kind: 'mark_stale', ipId: 'ip-1', reason: 'address_gone_ambiguous' },
  ])
  assertEquals(writes.length, 1)
  const metadata = writes[0]?.patch.metadata
  assertEquals(parseIpPinMetadata(metadata).stale?.reason, 'address_gone_ambiguous')
  assertEquals((writes[0]?.patch as Record<string, unknown>).address, undefined)
})

test('applyReportedAddressRepin: candidate held by another org row → stale', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [pin()],
    inUse: [{ id: 'ip-other', address: '10.20.0.42' }],
    writes,
  })
  const applied = await applyReportedAddressRepin(
    db,
    SERVER,
    reported('10.20.0.42'),
  )
  assertEquals(applied, [
    { kind: 'mark_stale', ipId: 'ip-1', reason: 'address_gone_no_candidate' },
  ])
  assertEquals(writes.length, 1)
})

test('applyReportedAddressRepin: pin address returning clears stale only', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [pin({
      metadata: {
        stale: { since: '2026-09-01T00:00:00.000Z', reason: 'address_gone_ambiguous' },
      },
    })],
    writes,
  })
  const applied = await applyReportedAddressRepin(
    db,
    SERVER,
    reported('10.20.0.10'),
  )
  assertEquals(applied, [{ kind: 'clear_stale', ipId: 'ip-1' }])
  assertEquals(writes.length, 1)
  assertEquals(writes[0]?.patch.metadata, {})
})

test('applyReportedAddressRepin: a non-unique write failure is swallowed', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [pin()],
    writes,
    failWriteWith: () => new Error('connection reset'),
  })
  const applied = await applyReportedAddressRepin(
    db,
    SERVER,
    reported('10.20.0.42'),
  )
  assertEquals(applied, [])
  assertEquals(writes.length, 0)
})
