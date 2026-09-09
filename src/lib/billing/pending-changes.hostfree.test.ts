/**
 * The pending-change ledger, v2: intents name a tier and a direction, never
 * a license. Parse discipline (a v1 ledger reads as empty), the per-tier
 * views the schedule and the gates read, the landing rule, and the
 * `setting` row round-trip.
 */

import { assertEquals, assertThrows } from '@std/assert'
import { setting } from '../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import {
  billingPendingChangesKey,
  deferredDeltasByTier,
  emptyLedger,
  landedIntents,
  newDeferredIntent,
  outstandingReleasesByTier,
  parseLedger,
  PENDING_CHANGES_LEDGER_VERSION,
  readPendingChanges,
  withIntent,
  withoutIntents,
  writePendingChanges,
} from './pending-changes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '33333333-3333-4333-8333-333333333333'
const S1 = '11111111-1111-4111-8111-111111111111'
const S3 = '33333333-3333-4333-8333-333333333331'
const S5 = '55555555-5555-4555-8555-555555555555'
const NOW_MS = Date.parse('2026-09-07T12:00:00.000Z')
const PERIOD_END = '2026-10-01T00:00:00.000Z'

const release = (fromTierId: string, fromQuantity: number, landsAt: string | null = PERIOD_END) =>
  newDeferredIntent('release-seat', { fromTierId, toTierId: null, landsAt, fromQuantity, nowMs: NOW_MS })
const downgrade = (fromTierId: string, toTierId: string, fromQuantity: number, landsAt: string | null = PERIOD_END) =>
  newDeferredIntent('downgrade', { fromTierId, toTierId, landsAt, fromQuantity, nowMs: NOW_MS })

test('newDeferredIntent mints an id and a key once, stamps the landing period, and refuses a downgrade with no target', () => {
  const intent = downgrade(S5, S3, 2)
  assertEquals([intent.kind, intent.fromTierId, intent.toTierId, intent.fromQuantity, intent.landsAt], ['downgrade', S5, S3, 2, PERIOD_END])
  assertEquals(intent.createdAt, new Date(NOW_MS).toISOString())
  assertEquals(intent.id.length > 0 && intent.idempotencyKey.length > 0 && intent.id !== intent.idempotencyKey, true)
  // A release names no target even when handed one.
  assertEquals(newDeferredIntent('release-seat', { fromTierId: S3, toTierId: S1, landsAt: null, fromQuantity: 1, nowMs: NOW_MS }).toTierId, null)
  assertThrows(() => newDeferredIntent('downgrade', { fromTierId: S5, toTierId: null, landsAt: null, fromQuantity: 1 }), TypeError)
})

test('parseLedger round-trips a v2 ledger and reads a v1 ledger (license-keyed) as nothing', () => {
  const ledger = withIntent(withIntent(emptyLedger('sub_1'), release(S3, 2)), downgrade(S5, S3, 1, null))
  assertEquals(parseLedger(JSON.parse(JSON.stringify(ledger))), ledger)
  assertEquals(parseLedger(emptyLedger('sub_1')), emptyLedger('sub_1'))
  assertEquals(PENDING_CHANGES_LEDGER_VERSION, 2)
  const v1 = {
    version: 1,
    providerSubscriptionId: 'sub_1',
    intents: [{ id: 'i1', kind: 'upgrade', licenseId: 'lic-1', fromTierId: S1, toTierId: S3, idempotencyKey: 'k', createdAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-09-02T00:00:00.000Z' }],
  }
  assertEquals(parseLedger(v1), null)
  assertEquals(parseLedger(null), null)
  assertEquals(parseLedger([]), null)
  assertEquals(parseLedger({ version: 2, providerSubscriptionId: 'sub_1' }), null)
  assertEquals(parseLedger({ version: 2, intents: [] }), null)
})

test('parseLedger drops an intent it cannot read and keeps the rest — the ledger survives one bad entry', () => {
  const good = release(S3, 2)
  const parsed = parseLedger({
    version: 2,
    providerSubscriptionId: 'sub_1',
    intents: [
      { ...good, kind: 'upgrade' },
      { ...good, id: 'no-key', idempotencyKey: undefined },
      { ...downgrade(S5, S3, 1), toTierId: null },
      'not an intent',
      good,
      // Missing optional fields read as unknown period / zero quantity, and a release never keeps a target.
      { id: 'lean', kind: 'release-seat', fromTierId: S1, toTierId: S3, idempotencyKey: 'k', createdAt: good.createdAt },
    ],
  })
  assertEquals(parsed?.intents, [good, { id: 'lean', kind: 'release-seat', fromTierId: S1, toTierId: null, idempotencyKey: 'k', createdAt: good.createdAt, landsAt: null, fromQuantity: 0 }])
})

test('withIntent replaces by id and appends; withoutIntents drops the named ids and returns the same ledger for none', () => {
  const first = release(S3, 2)
  const second = downgrade(S5, S3, 1)
  const ledger = withIntent(withIntent(emptyLedger('sub_1'), first), second)
  assertEquals(ledger.intents.map((i) => i.id), [first.id, second.id])
  const replaced = withIntent(ledger, { ...first, fromQuantity: 9 })
  assertEquals(replaced.intents.map((i) => [i.id, i.fromQuantity]), [[second.id, 1], [first.id, 9]])
  assertEquals(withoutIntents(ledger, [first.id]).intents, [second])
  assertEquals(withoutIntents(ledger, []) === ledger, true)
  assertEquals(withoutIntents(ledger, ['nope']).intents, ledger.intents)
})

test('deferredDeltasByTier is the future phase: −1 at every source, +1 at each downgrade target', () => {
  const ledger = withIntent(withIntent(withIntent(emptyLedger('sub_1'), release(S3, 3)), downgrade(S5, S3, 2)), downgrade(S5, S1, 2))
  assertEquals([...deferredDeltasByTier(ledger)], [[S3, 0], [S5, -2], [S1, 1]])
  assertEquals(deferredDeltasByTier(emptyLedger('sub_1')), new Map())
})

test('outstandingReleasesByTier counts every source side, downgrades included', () => {
  const ledger = withIntent(withIntent(withIntent(emptyLedger('sub_1'), release(S3, 3)), downgrade(S5, S3, 2)), release(S3, 3))
  assertEquals([...outstandingReleasesByTier(ledger)], [[S3, 2], [S5, 1]])
  assertEquals(outstandingReleasesByTier(emptyLedger('sub_1')), new Map())
})

test('landedIntents: an ended subscription lands everything', () => {
  const ledger = withIntent(withIntent(emptyLedger('sub_1'), release(S3, 3)), downgrade(S5, S3, 2, null))
  const landed = landedIntents(ledger, { ended: true, currentPeriodEnd: null, seatsAt: () => 99 })
  assertEquals(landed, [...ledger.intents])
})

test('landedIntents: the period rolling past landsAt is the signal; equal or unknown is not', () => {
  const intent = release(S3, 3)
  const ledger = withIntent(emptyLedger('sub_1'), intent)
  const seatsUnchanged = () => 3
  assertEquals(landedIntents(ledger, { ended: false, currentPeriodEnd: '2026-11-01T00:00:00.000Z', seatsAt: seatsUnchanged }), [intent])
  assertEquals(landedIntents(ledger, { ended: false, currentPeriodEnd: PERIOD_END, seatsAt: seatsUnchanged }), [])
  assertEquals(landedIntents(ledger, { ended: false, currentPeriodEnd: '2026-09-15T00:00:00.000Z', seatsAt: seatsUnchanged }), [])
  assertEquals(landedIntents(ledger, { ended: false, currentPeriodEnd: null, seatsAt: seatsUnchanged }), [])
  // An intent written while the period end was unknown can only land on quantity.
  const unknown = withIntent(emptyLedger('sub_1'), release(S3, 3, null))
  assertEquals(landedIntents(unknown, { ended: false, currentPeriodEnd: '2026-11-01T00:00:00.000Z', seatsAt: seatsUnchanged }), [])
})

test('landedIntents: the source tier dropping below fromQuantity lands the intent, per intent', () => {
  const s3 = release(S3, 3)
  const s5 = downgrade(S5, S3, 2)
  const ledger = withIntent(withIntent(emptyLedger('sub_1'), s3), s5)
  const seats = new Map([[S3, 2], [S5, 2]])
  assertEquals(landedIntents(ledger, { ended: false, currentPeriodEnd: PERIOD_END, seatsAt: (tierId) => seats.get(tierId) ?? 0 }), [s3])
  seats.set(S5, 1)
  assertEquals(landedIntents(ledger, { ended: false, currentPeriodEnd: PERIOD_END, seatsAt: (tierId) => seats.get(tierId) ?? 0 }), [s3, s5])
  // A rise at the source is not a landing.
  assertEquals(landedIntents(ledger, { ended: false, currentPeriodEnd: PERIOD_END, seatsAt: () => 10 }), [])
})

test('read/write round-trip through the setting row; an empty ledger deletes it; a foreign subscription reads as empty', async () => {
  const db = createMemoryDb([[setting, []]])
  assertEquals(await readPendingChanges(db, ORG, 'sub_1'), { ledger: emptyLedger('sub_1') })

  const ledger = withIntent(emptyLedger('sub_1'), release(S3, 2))
  await writePendingChanges(db, ORG, ledger, NOW_MS)
  assertEquals(db.rows(setting).map((row) => [row.key, row.updatedAt]), [[billingPendingChangesKey(ORG), new Date(NOW_MS).toISOString()]])
  assertEquals(await readPendingChanges(db, ORG, 'sub_1'), { ledger })

  // Same key on a second write: one row, updated in place.
  const grown = withIntent(ledger, downgrade(S5, S3, 1))
  await writePendingChanges(db, ORG, grown, NOW_MS + 1)
  assertEquals(db.rows(setting).length, 1)
  assertEquals((await readPendingChanges(db, ORG, 'sub_1')).ledger.intents.length, 2)

  // A re-subscribe must not inherit the previous subscription's intents; the row itself is left for the next write.
  assertEquals(await readPendingChanges(db, ORG, 'sub_2'), { ledger: emptyLedger('sub_2') })
  assertEquals(db.rows(setting).length, 1)

  // Writing an empty ledger removes the row.
  await writePendingChanges(db, ORG, withoutIntents(grown, grown.intents.map((i) => i.id)), NOW_MS + 2)
  assertEquals(db.rows(setting).length, 0)
  await writePendingChanges(db, ORG, emptyLedger('sub_1'), NOW_MS + 3)
  assertEquals(db.rows(setting).length, 0)
})

test('a stored v1 ledger reads as empty for the subscription asked about', async () => {
  const db = createMemoryDb([[setting, [{
    id: 'row-1',
    key: billingPendingChangesKey(ORG),
    value: { version: 1, providerSubscriptionId: 'sub_1', intents: [{ id: 'i1', kind: 'release-seat', licenseId: 'lic', fromTierId: S3, toTierId: null, idempotencyKey: 'k', createdAt: '2026-09-01T00:00:00.000Z' }] },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }]]])
  const { ledger } = await readPendingChanges(db, ORG, 'sub_1')
  assertEquals(ledger, emptyLedger('sub_1'))
})
