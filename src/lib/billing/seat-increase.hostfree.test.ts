/**
 * Host-free coverage for the seat-increase record: parse discipline, the
 * 24 h expiry, the foreign-subscription guard, and the match rule a retry
 * relies on.
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
const NOW_MS = Date.parse('2026-09-07T12:00:00.000Z')
const ITEMS = [{ id: 'si_1', quantity: 3 }, { price: 'price_S5', quantity: 1 }, { id: 'si_9', deleted: true as const }]

test('newSeatIncreaseRecord pins the request parameters, mints one key, and expires with the Stripe key window', () => {
  const record = newSeatIncreaseRecord({ providerSubscriptionId: 'sub_1', tierId: S3, delta: 2, items: ITEMS, prorationDate: 1_800_000_000, nowMs: NOW_MS })
  assertEquals(record.tierId, S3)
  assertEquals(record.delta, 2)
  assertEquals(record.prorationDate, 1_800_000_000)
  // The items are copied, not aliased: a caller mutating its array later cannot change what gets replayed.
  assertEquals(record.items, ITEMS)
  assertEquals(record.items[0] === ITEMS[0], false)
  assertEquals(record.idempotencyKey.length > 0, true)
  assertEquals(Date.parse(record.expiresAt) - Date.parse(record.createdAt), SEAT_INCREASE_TTL_MS)
  assertThrows(() => newSeatIncreaseRecord({ providerSubscriptionId: 'sub_1', tierId: S3, delta: 0, items: ITEMS, prorationDate: 1, nowMs: NOW_MS }), TypeError)
  assertThrows(() => newSeatIncreaseRecord({ providerSubscriptionId: 'sub_1', tierId: S3, delta: -1, items: ITEMS, prorationDate: 1, nowMs: NOW_MS }), TypeError)
})

test('parseSeatIncreaseRecord round-trips a record and rejects anything else', () => {
  const record = newSeatIncreaseRecord({ providerSubscriptionId: 'sub_1', tierId: S3, delta: 1, items: ITEMS, prorationDate: 1_800_000_000, nowMs: NOW_MS })
  assertEquals(parseSeatIncreaseRecord(JSON.parse(JSON.stringify(record))), record)
  assertEquals(parseSeatIncreaseRecord(null), null)
  assertEquals(parseSeatIncreaseRecord([]), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, version: 2 }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, delta: 0 }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, idempotencyKey: '' }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, prorationDate: 'soon' }), null)
  // Items are replayed byte-for-byte, so any unreadable entry invalidates the whole record.
  assertEquals(parseSeatIncreaseRecord({ ...record, items: [] }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, items: [{ id: 'si_1' }] }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, items: [{ id: 'si_1', quantity: 2 }, { quantity: 1 }] }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, items: [{ id: 'si_1', quantity: -1 }] }), null)
  assertEquals(parseSeatIncreaseRecord({ ...record, items: [{ price: 'price_x', quantity: 1, extra: 'dropped' }] })?.items, [{ price: 'price_x', quantity: 1 }])
})

test('seatIncreaseMatches compares tier and delta only — the stored proration date is what gets replayed', () => {
  const record = newSeatIncreaseRecord({ providerSubscriptionId: 'sub_1', tierId: S3, delta: 2, items: ITEMS, prorationDate: 1_800_000_000, nowMs: NOW_MS })
  assertEquals(seatIncreaseMatches(record, { tierId: S3, delta: 2 }), true)
  assertEquals(seatIncreaseMatches(record, { tierId: S3, delta: 1 }), false)
  assertEquals(seatIncreaseMatches(record, { tierId: 'other', delta: 2 }), false)
})

test('read/write/clear round-trip through the setting row; an expired or foreign record reads as null and is cleared', async () => {
  const db = createMemoryDb([[setting, []]])
  assertEquals(await readSeatIncrease(db, ORG, 'sub_1', NOW_MS), null)

  const record = newSeatIncreaseRecord({ providerSubscriptionId: 'sub_1', tierId: S3, delta: 1, items: ITEMS, prorationDate: 1_800_000_000, nowMs: NOW_MS })
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
