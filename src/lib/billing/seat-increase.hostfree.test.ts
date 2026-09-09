/**
 * Host-free coverage for the seat-increase record: parse discipline, the
 * 24 h expiry, the foreign-subscription guard, and the match rule a retry
 * relies on. The record is keyed on the per-tier `deltas` of the request —
 * a seat raise is one delta, an upgrade's item swap is two.
 */

import { assertEquals, assertThrows } from '@std/assert'
import { setting } from '../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import {
  billingSeatIncreaseKey,
  clearSeatIncrease,
  newSeatIncreaseRecord,
  parseSeatIncreaseRecord,
  readSeatIncrease,
  SEAT_INCREASE_RECORD_VERSION,
  SEAT_INCREASE_TTL_MS,
  seatIncreaseMatches,
  writeSeatIncrease,
} from './seat-increase.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '33333333-3333-4333-8333-333333333333'
const S3 = '33333333-3333-4333-8333-333333333331'
const S5 = '55555555-5555-4555-8555-555555555555'
const NOW_MS = Date.parse('2026-09-07T12:00:00.000Z')
const ITEMS = [{ id: 'si_1', quantity: 3 }, { price: 'price_S5', quantity: 1 }, { id: 'si_9', deleted: true as const }]
const RAISE = [{ tierId: S3, delta: 2 }]
const SWAP = [{ tierId: S3, delta: -1 }, { tierId: S5, delta: 1 }]

test('newSeatIncreaseRecord pins the deltas and the request parameters, mints one key, and expires with the Stripe key window', () => {
  const record = newSeatIncreaseRecord({ providerSubscriptionId: 'sub_1', deltas: SWAP, items: ITEMS, prorationDate: 1_800_000_000, nowMs: NOW_MS })
  assertEquals(record.version, SEAT_INCREASE_RECORD_VERSION)
  assertEquals(record.deltas, SWAP)
  assertEquals(record.prorationDate, 1_800_000_000)
  // Deltas and items are copied, not aliased: a caller mutating its arrays later cannot change what gets replayed.
  assertEquals(record.deltas[0] === SWAP[0], false)
  assertEquals(record.items, ITEMS)
  assertEquals(record.items[0] === ITEMS[0], false)
  assertEquals(record.idempotencyKey.length > 0, true)
  assertEquals(Date.parse(record.expiresAt) - Date.parse(record.createdAt), SEAT_INCREASE_TTL_MS)
})

test('a record needs at least one non-zero integer delta', () => {
  const base = { providerSubscriptionId: 'sub_1', items: ITEMS, prorationDate: 1, nowMs: NOW_MS }
  assertThrows(() => newSeatIncreaseRecord({ ...base, deltas: [] }), TypeError)
  assertThrows(() => newSeatIncreaseRecord({ ...base, deltas: [{ tierId: S3, delta: 0 }] }), TypeError)
  assertThrows(() => newSeatIncreaseRecord({ ...base, deltas: [{ tierId: S3, delta: 1.5 }] }), TypeError)
  assertThrows(() => newSeatIncreaseRecord({ ...base, deltas: [{ tierId: S3, delta: 1 }, { tierId: S5, delta: 0 }] }), TypeError)
  // A negative delta is fine on its own: the upgrade swap's source side is one.
  assertEquals(newSeatIncreaseRecord({ ...base, deltas: [{ tierId: S3, delta: -1 }] }).deltas, [{ tierId: S3, delta: -1 }])
})

test('parseSeatIncreaseRecord round-trips a v2 record and rejects anything else', () => {
  const record = newSeatIncreaseRecord({ providerSubscriptionId: 'sub_1', deltas: RAISE, items: ITEMS, prorationDate: 1_800_000_000, nowMs: NOW_MS })
  assertEquals(parseSeatIncreaseRecord(JSON.parse(JSON.stringify(record))), record)
  assertEquals(parseSeatIncreaseRecord(null), null)
  assertEquals(parseSeatIncreaseRecord([]), null)
  // A v1 record (single `tierId` / `delta`) is not this record: a fresh request is the safe outcome.
  assertEquals(parseSeatIncreaseRecord({ ...record, version: 1, deltas: undefined, tierId: S3, delta: 2 }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, version: 3 }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, deltas: [] }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, deltas: [{ tierId: S3, delta: 0 }] }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, deltas: [{ tierId: S3, delta: 1 }, { tierId: '', delta: 1 }] }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, deltas: [{ tierId: S3, delta: '2' }] }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, idempotencyKey: '' }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, prorationDate: 'soon' }), null)
  // Items are replayed byte-for-byte, so any unreadable entry invalidates the whole record.
  assertEquals(parseSeatIncreaseRecord({ ...record, items: [] }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, items: [{ id: 'si_1' }] }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, items: [{ id: 'si_1', quantity: 2 }, { quantity: 1 }] }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, items: [{ id: 'si_1', quantity: -1 }] }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, items: [{ price: 'price_x', quantity: 1, extra: 'dropped' }] })?.items, [{ price: 'price_x', quantity: 1 }])
  // Unknown keys on a delta are dropped too.
  assertEquals(parseSeatIncreaseRecord({ ...record, deltas: [{ tierId: S3, delta: 2, note: 'dropped' }] })?.deltas, [{ tierId: S3, delta: 2 }])
})

test('seatIncreaseMatches compares the delta list in order and nothing else — the stored proration date is what gets replayed', () => {
  const record = newSeatIncreaseRecord({ providerSubscriptionId: 'sub_1', deltas: SWAP, items: ITEMS, prorationDate: 1_800_000_000, nowMs: NOW_MS })
  assertEquals(seatIncreaseMatches(record, SWAP), true)
  assertEquals(seatIncreaseMatches(record, [{ tierId: S3, delta: -1 }, { tierId: S5, delta: 1 }]), true)
  // Same deltas, other order: a different request.
  assertEquals(seatIncreaseMatches(record, [{ tierId: S5, delta: 1 }, { tierId: S3, delta: -1 }]), false)
  assertEquals(seatIncreaseMatches(record, [{ tierId: S3, delta: -1 }]), false)
  assertEquals(seatIncreaseMatches(record, [...SWAP, { tierId: 'other', delta: 1 }]), false)
  assertEquals(seatIncreaseMatches(record, [{ tierId: S3, delta: -2 }, { tierId: S5, delta: 1 }]), false)
  const raise = newSeatIncreaseRecord({ providerSubscriptionId: 'sub_1', deltas: RAISE, items: ITEMS, prorationDate: 1, nowMs: NOW_MS })
  assertEquals(seatIncreaseMatches(raise, [{ tierId: S3, delta: 2 }]), true)
  assertEquals(seatIncreaseMatches(raise, [{ tierId: S3, delta: 1 }]), false)
  assertEquals(seatIncreaseMatches(raise, [{ tierId: 'other', delta: 2 }]), false)
})

test('read/write/clear round-trip through the setting row; an expired or foreign record reads as null and is cleared', async () => {
  const db = createMemoryDb([[setting, []]])
  assertEquals(await readSeatIncrease(db, ORG, 'sub_1', NOW_MS), null)

  const record = newSeatIncreaseRecord({ providerSubscriptionId: 'sub_1', deltas: RAISE, items: ITEMS, prorationDate: 1_800_000_000, nowMs: NOW_MS })
  await writeSeatIncrease(db, ORG, record, NOW_MS)
  assertEquals(db.rows(setting).map((row) => row.key), [billingSeatIncreaseKey(ORG)])
  assertEquals(await readSeatIncrease(db, ORG, 'sub_1', NOW_MS), record)
  // Same key on a second write: one row, updated in place.
  await writeSeatIncrease(db, ORG, { ...record, idempotencyKey: 'k2' }, NOW_MS + 1)
  assertEquals(db.rows(setting).length, 1)
  assertEquals((await readSeatIncrease(db, ORG, 'sub_1', NOW_MS))?.idempotencyKey, 'k2')

  // A re-subscribe must not inherit the previous subscription's record.
  assertEquals(await readSeatIncrease(db, ORG, 'sub_2', NOW_MS), null)
  assertEquals(db.rows(setting).length, 0)

  await writeSeatIncrease(db, ORG, record, NOW_MS)
  // Stripe no longer honours the key after 24 h: the record is pruned on read.
  assertEquals(await readSeatIncrease(db, ORG, 'sub_1', NOW_MS + SEAT_INCREASE_TTL_MS), null)
  assertEquals(db.rows(setting).length, 0)

  await writeSeatIncrease(db, ORG, record, NOW_MS)
  await clearSeatIncrease(db, ORG)
  assertEquals(db.rows(setting).length, 0)
})
