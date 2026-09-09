/**
 * The derived assignment, pure: servers in bind order each take the
 * smallest purchased tier that fits, unknown hardware needs the entry rank,
 * and the coverage gate names the first server a reduction would strand.
 */

import { assertEquals, assertThrows } from '@std/assert'
import {
  applyTierDeltas,
  type AssignableServer,
  computeAssignment,
  coverageLoss,
  effectiveRequiredRank,
  sortByBindOrder,
  type TierQuantity,
} from './assignment.ts'
import { ENTRY_TIER_RANK } from './ladder.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const S1 = 'tier-s1'
const S3 = 'tier-s3'
const S5 = 'tier-s5'
const RANK = new Map([[S1, 1], [S3, 3], [S5, 5]])
const rankOf = (tierId: string) => RANK.get(tierId)

const purchased = (s1: number, s3: number, s5: number): TierQuantity[] => [
  { tierId: S5, rank: 5, quantity: s5 },
  { tierId: S1, rank: 1, quantity: s1 },
  { tierId: S3, rank: 3, quantity: s3 },
]

const server = (serverId: string, requiredRank: number | null, boundAt: string): AssignableServer => ({ serverId, requiredRank, boundAt })

test('each server takes the smallest purchased tier whose rank covers its requirement; the rest is spare', () => {
  const result = computeAssignment(purchased(1, 1, 1), [
    server('a', 3, '2026-09-01T00:00:00.000Z'),
    server('b', 1, '2026-09-02T00:00:00.000Z'),
  ])
  assertEquals([...result.byServer], [['a', S3], ['b', S1]])
  assertEquals([...result.spare], [[S1, 0], [S3, 0], [S5, 1]])
  assertEquals(result.uncovered, [])
})

test('a server is parked on a bigger tier only when the smaller ones are used up or too small', () => {
  // Two rank-1 servers, one S1 and one S5: the second takes the S5 rather than nothing.
  const result = computeAssignment(purchased(1, 0, 1), [
    server('a', 1, '2026-09-01T00:00:00.000Z'),
    server('b', 1, '2026-09-02T00:00:00.000Z'),
  ])
  assertEquals([...result.byServer], [['a', S1], ['b', S5]])
  // A rank-4 need skips S3 and S1 no matter how many are spare.
  const skipped = computeAssignment(purchased(3, 3, 0), [server('big', 4, '2026-09-01T00:00:00.000Z')])
  assertEquals(skipped.byServer.get('big'), null)
  assertEquals(skipped.uncovered, ['big'])
  assertEquals([...skipped.spare], [[S1, 3], [S3, 3]])
})

test('bind order places incumbents first, so a newcomer never displaces a server that was covered', () => {
  const incumbent = server('old', 3, '2026-09-01T00:00:00.000Z')
  const newcomer = server('new', 3, '2026-09-05T00:00:00.000Z')
  // Order of the input array is irrelevant; boundAt decides.
  const result = computeAssignment(purchased(0, 1, 0), [newcomer, incumbent])
  assertEquals(result.byServer.get('old'), S3)
  assertEquals(result.byServer.get('new'), null)
  assertEquals(result.uncovered, ['new'])
  // Even when the newcomer would fit a smaller tier the incumbent cannot use.
  const spareBelow = computeAssignment(purchased(1, 1, 0), [
    server('old', 3, '2026-09-01T00:00:00.000Z'),
    server('new', 1, '2026-09-05T00:00:00.000Z'),
  ])
  assertEquals([...spareBelow.byServer], [['old', S3], ['new', S1]])
})

test('sortByBindOrder is oldest first with ties broken on id, so a recompute is stable', () => {
  const sorted = sortByBindOrder([
    server('b', 1, '2026-09-02T00:00:00.000Z'),
    server('z', 1, '2026-09-01T00:00:00.000Z'),
    server('a', 1, '2026-09-01T00:00:00.000Z'),
  ])
  assertEquals(sorted.map((entry) => entry.serverId), ['a', 'z', 'b'])
})

test('unknown hardware requires the entry rank: it needs a tier, and the smallest will do', () => {
  assertEquals(effectiveRequiredRank({ requiredRank: null }), ENTRY_TIER_RANK)
  assertEquals(effectiveRequiredRank({ requiredRank: 4 }), 4)
  const result = computeAssignment(purchased(1, 1, 0), [
    server('known', 3, '2026-09-01T00:00:00.000Z'),
    server('unknown', null, '2026-09-02T00:00:00.000Z'),
  ])
  assertEquals([...result.byServer], [['known', S3], ['unknown', S1]])
  // With no purchase at all, every server is uncovered in bind order.
  const none = computeAssignment([], [server('b', null, '2026-09-02T00:00:00.000Z'), server('a', null, '2026-09-01T00:00:00.000Z')])
  assertEquals(none.uncovered, ['a', 'b'])
  assertEquals([...none.byServer.values()], [null, null])
  assertEquals(none.spare.size, 0)
})

test('zero-quantity tiers are left out of the pool and the spare map', () => {
  const result = computeAssignment(purchased(0, 2, 0), [server('a', 1, '2026-09-01T00:00:00.000Z')])
  assertEquals([...result.spare], [[S3, 1]])
  assertEquals(result.byServer.get('a'), S3)
})

test('coverageLoss names the first server, in bind order, that the proposed mix would newly strand', () => {
  const servers = [
    server('a', 1, '2026-09-01T00:00:00.000Z'),
    server('b', 3, '2026-09-02T00:00:00.000Z'),
    server('c', 3, '2026-09-03T00:00:00.000Z'),
  ]
  // Dropping one S3 strands the younger S3 server, not the older one.
  assertEquals(coverageLoss(purchased(1, 2, 0), purchased(1, 1, 0), servers), { serverId: 'c', requiredRank: 3 })
  // Dropping both S3 strands b first.
  assertEquals(coverageLoss(purchased(1, 2, 0), purchased(1, 0, 0), servers), { serverId: 'b', requiredRank: 3 })
  // An upgrade of one S3 to S5 is safe: the S5 still covers a rank-3 need.
  assertEquals(coverageLoss(purchased(1, 2, 0), purchased(1, 1, 1), servers), null)
  // Unknown hardware reports the entry rank as its requirement.
  assertEquals(coverageLoss(purchased(1, 0, 0), purchased(0, 0, 0), [server('u', null, '2026-09-01T00:00:00.000Z')]), { serverId: 'u', requiredRank: ENTRY_TIER_RANK })
})

test('coverageLoss is null when nothing changes and ignores servers that were already uncovered', () => {
  const servers = [server('a', 1, '2026-09-01T00:00:00.000Z'), server('big', 5, '2026-09-02T00:00:00.000Z')]
  assertEquals(coverageLoss(purchased(1, 0, 0), purchased(1, 0, 0), servers), null)
  // `big` is stranded today and stays stranded: not a loss the proposal causes.
  assertEquals(coverageLoss(purchased(1, 0, 0), purchased(2, 0, 0), servers), null)
  assertEquals(coverageLoss([], [], servers), null)
})

test('applyTierDeltas adds to existing rows, creates missing ones at rankOf, and refuses a negative result', () => {
  const current = purchased(1, 2, 0)
  const next = applyTierDeltas(current, new Map([[S3, -1], [S5, 1]]), rankOf)
  assertEquals(next, [
    { tierId: S5, rank: 5, quantity: 1 },
    { tierId: S1, rank: 1, quantity: 1 },
    { tierId: S3, rank: 3, quantity: 1 },
  ])
  // The input is not mutated.
  assertEquals(current, purchased(1, 2, 0))
  // A tier not yet held is created from rankOf, even to zero.
  assertEquals(applyTierDeltas([], new Map([[S3, 2]]), rankOf), [{ tierId: S3, rank: 3, quantity: 2 }])
  assertEquals(applyTierDeltas([], new Map([[S3, 0]]), rankOf), [{ tierId: S3, rank: 3, quantity: 0 }])
  assertThrows(() => applyTierDeltas(current, new Map([[S3, -3]]), rankOf), RangeError)
  assertThrows(() => applyTierDeltas([], new Map([['tier-unknown', 1]]), rankOf), TypeError)
  assertThrows(() => applyTierDeltas([], new Map([[S1, -1]]), rankOf), RangeError)
})
