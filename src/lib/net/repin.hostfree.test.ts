/**
 * Host-free coverage for the pure repin decision and the `ip.metadata`
 * marker parser / writers.
 */

import { assertEquals } from '@std/assert'
import {
  clearedPendingFanoutMetadata,
  clearedStaleMetadata,
  decideRepinActions,
  parseIpPinMetadata,
  type RepinPinInput,
  withRepinMetadata,
  withStaleMetadata,
} from './repin.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER = '00000000-0000-4000-8000-0000000000a1'
const DC = '00000000-0000-4000-8000-0000000000d1'
const NET_V4 = '00000000-0000-4000-8000-0000000000e4'
const NET_V6 = '00000000-0000-4000-8000-0000000000e6'

function v4Pin(overrides: Partial<RepinPinInput> = {}): RepinPinInput {
  return {
    ipId: 'ip-v4',
    serverId: SERVER,
    datacenterId: DC,
    networkId: NET_V4,
    address: '10.20.0.10',
    subnetCidr: '10.20.0.0/24',
    stale: false,
    ...overrides,
  }
}

function v6Pin(overrides: Partial<RepinPinInput> = {}): RepinPinInput {
  return {
    ipId: 'ip-v6',
    serverId: SERVER,
    datacenterId: DC,
    networkId: NET_V6,
    address: 'fd00:20::10',
    subnetCidr: 'fd00:20::/64',
    stale: false,
    ...overrides,
  }
}

test('decideRepinActions: unchanged pin yields no action', () => {
  assertEquals(
    decideRepinActions({
      pins: [v4Pin()],
      reportedPrivateAddresses: ['10.20.0.10', '10.99.0.1'],
      addressesInUse: new Set(),
    }),
    [],
  )
})

test('decideRepinActions: single IPv4 candidate repins', () => {
  assertEquals(
    decideRepinActions({
      pins: [v4Pin()],
      reportedPrivateAddresses: ['10.20.0.42', '10.99.0.1'],
      addressesInUse: new Set(),
    }),
    [{ kind: 'repin', ipId: 'ip-v4', from: '10.20.0.10', to: '10.20.0.42' }],
  )
})

test('decideRepinActions: single IPv6 candidate repins', () => {
  assertEquals(
    decideRepinActions({
      pins: [v6Pin()],
      reportedPrivateAddresses: ['fd00:20::42'],
      addressesInUse: new Set(),
    }),
    [{ kind: 'repin', ipId: 'ip-v6', from: 'fd00:20::10', to: 'fd00:20::42' }],
  )
})

test('decideRepinActions: zero candidates marks address_gone_no_candidate', () => {
  assertEquals(
    decideRepinActions({
      pins: [v4Pin()],
      reportedPrivateAddresses: ['10.99.0.1'],
      addressesInUse: new Set(),
    }),
    [{ kind: 'mark_stale', ipId: 'ip-v4', reason: 'address_gone_no_candidate' }],
  )
})

test('decideRepinActions: two candidates marks address_gone_ambiguous', () => {
  assertEquals(
    decideRepinActions({
      pins: [v4Pin()],
      reportedPrivateAddresses: ['10.20.0.42', '10.20.0.43'],
      addressesInUse: new Set(),
    }),
    [{ kind: 'mark_stale', ipId: 'ip-v4', reason: 'address_gone_ambiguous' }],
  )
})

test('decideRepinActions: candidate already an ip row is stale, not repin', () => {
  assertEquals(
    decideRepinActions({
      pins: [v4Pin()],
      reportedPrivateAddresses: ['10.20.0.42'],
      addressesInUse: new Set(['10.20.0.42']),
    }),
    [{ kind: 'mark_stale', ipId: 'ip-v4', reason: 'address_gone_no_candidate' }],
  )
})

test('decideRepinActions: previously-stale pin whose address returns clears', () => {
  assertEquals(
    decideRepinActions({
      pins: [v4Pin({ stale: true })],
      reportedPrivateAddresses: ['10.20.0.10'],
      addressesInUse: new Set(),
    }),
    [{ kind: 'clear_stale', ipId: 'ip-v4' }],
  )
})

test('decideRepinActions: two pins in one network yield at most one repin', () => {
  const actions = decideRepinActions({
    pins: [
      v4Pin({ ipId: 'ip-a', address: '10.20.0.10' }),
      v4Pin({ ipId: 'ip-b', address: '10.20.0.11' }),
    ],
    reportedPrivateAddresses: ['10.20.0.42'],
    addressesInUse: new Set(),
  })
  assertEquals(actions.filter((a) => a.kind === 'repin').length, 1)
  assertEquals(actions[0], {
    kind: 'repin',
    ipId: 'ip-a',
    from: '10.20.0.10',
    to: '10.20.0.42',
  })
  assertEquals(actions[1]?.kind, 'mark_stale')
})

test('decideRepinActions: to === from is a no-op', () => {
  // A prefix-suffixed pin address normalizes to a reported address.
  assertEquals(
    decideRepinActions({
      pins: [v4Pin({ address: '10.20.0.10/24' })],
      reportedPrivateAddresses: ['10.20.0.10'],
      addressesInUse: new Set(),
    }),
    [],
  )
})

test('decideRepinActions: cross-family candidate is ignored', () => {
  assertEquals(
    decideRepinActions({
      pins: [v4Pin()],
      reportedPrivateAddresses: ['fd00:20::42'],
      addressesInUse: new Set(),
    }),
    [{ kind: 'mark_stale', ipId: 'ip-v4', reason: 'address_gone_no_candidate' }],
  )
  assertEquals(
    decideRepinActions({
      pins: [v6Pin()],
      reportedPrivateAddresses: ['10.20.0.42', 'fd00:20::42'],
      addressesInUse: new Set(),
    }),
    [{ kind: 'repin', ipId: 'ip-v6', from: 'fd00:20::10', to: 'fd00:20::42' }],
  )
})

test('decideRepinActions: dual-family pins on one server repin independently', () => {
  assertEquals(
    decideRepinActions({
      pins: [v4Pin(), v6Pin()],
      reportedPrivateAddresses: ['10.20.0.42', 'fd00:20::42'],
      addressesInUse: new Set(),
    }),
    [
      { kind: 'repin', ipId: 'ip-v4', from: '10.20.0.10', to: '10.20.0.42' },
      { kind: 'repin', ipId: 'ip-v6', from: 'fd00:20::10', to: 'fd00:20::42' },
    ],
  )
})

test('parseIpPinMetadata round-trips stale and repin markers', () => {
  const stale = withStaleMetadata(
    { note: 'keep me' },
    { since: '2026-09-01T00:00:00.000Z', reason: 'address_gone_ambiguous' },
  )
  assertEquals(stale.note, 'keep me')
  assertEquals(parseIpPinMetadata(stale), {
    stale: { since: '2026-09-01T00:00:00.000Z', reason: 'address_gone_ambiguous' },
  })

  const repinned = withRepinMetadata(stale, {
    at: '2026-09-02T00:00:00.000Z',
    from: '10.20.0.10',
    pendingFanoutAt: '2026-09-02T00:00:00.000Z',
  })
  assertEquals(repinned.note, 'keep me')
  assertEquals(parseIpPinMetadata(repinned), {
    repin: {
      at: '2026-09-02T00:00:00.000Z',
      from: '10.20.0.10',
      pendingFanoutAt: '2026-09-02T00:00:00.000Z',
    },
  })

  const drained = clearedPendingFanoutMetadata(repinned)
  assertEquals(drained.note, 'keep me')
  assertEquals(parseIpPinMetadata(drained), {
    repin: { at: '2026-09-02T00:00:00.000Z', from: '10.20.0.10' },
  })

  const cleared = clearedStaleMetadata(stale)
  assertEquals(cleared, { note: 'keep me' })
})

test('withStaleMetadata keeps the original since on re-flag', () => {
  const first = withStaleMetadata(null, {
    since: '2026-09-01T00:00:00.000Z',
    reason: 'address_gone_no_candidate',
  })
  const second = withStaleMetadata(first, {
    since: '2026-09-05T00:00:00.000Z',
    reason: 'address_gone_ambiguous',
  })
  assertEquals(parseIpPinMetadata(second).stale, {
    since: '2026-09-01T00:00:00.000Z',
    reason: 'address_gone_ambiguous',
  })
})

test('parseIpPinMetadata ignores invalid or partial markers', () => {
  assertEquals(parseIpPinMetadata(null), {})
  assertEquals(parseIpPinMetadata('x'), {})
  assertEquals(parseIpPinMetadata({ stale: { since: 'nope', reason: 'address_gone_ambiguous' } }), {})
  assertEquals(parseIpPinMetadata({ stale: { since: '2026-09-01T00:00:00.000Z', reason: 'other' } }), {})
  assertEquals(parseIpPinMetadata({ repin: { at: '2026-09-01T00:00:00.000Z' } }), {})
  assertEquals(
    parseIpPinMetadata({
      repin: { at: '2026-09-01T00:00:00.000Z', from: '10.0.0.1', pendingFanoutAt: 'bad' },
    }),
    { repin: { at: '2026-09-01T00:00:00.000Z', from: '10.0.0.1' } },
  )
})
