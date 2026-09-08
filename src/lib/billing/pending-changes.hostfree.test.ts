/**
 * The pending-change ledger: write / consume / prune, idempotency-key reuse
 * across a retry, and the stale-ledger guard on re-subscribe.
 */

import { assertEquals, assertNotEquals } from '@std/assert'
import { setting } from '../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import {
  billingPendingChangesKey,
  deferredDeltasByTier,
  emptyLedger,
  intentForLicense,
  newDeferredIntent,
  newUpgradeIntent,
  outstandingReleasesByTier,
  parseLedger,
  pruneExpiredIntents,
  readPendingChanges,
  UPGRADE_INTENT_TTL_MS,
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

const ORG = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const LICENSE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LICENSE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const S1 = '11111111-1111-4111-8111-111111111111'
const S3 = '33333333-3333-4333-8333-333333333333'
const S5 = '55555555-5555-4555-8555-555555555555'
const NOW = Date.parse('2026-09-07T12:00:00.000Z')

test('an upgrade intent mints its idempotency key once and expires after 24 h', () => {
  const intent = newUpgradeIntent({ licenseId: LICENSE_A, fromTierId: S3, toTierId: S5, nowMs: NOW })
  assertEquals(intent.kind, 'upgrade')
  assertEquals(intent.expiresAt, new Date(NOW + UPGRADE_INTENT_TTL_MS).toISOString())
  assertNotEquals(intent.idempotencyKey, '')
  const ledger = withIntent(emptyLedger('sub_1'), intent)
  // The same intent read back carries the same key: a retry reuses it.
  assertEquals(intentForLicense(ledger, LICENSE_A)?.idempotencyKey, intent.idempotencyKey)
  const { ledger: kept } = pruneExpiredIntents(ledger, NOW + UPGRADE_INTENT_TTL_MS - 1)
  assertEquals(kept.intents.length, 1)
  const { ledger: pruned, pruned: gone } = pruneExpiredIntents(ledger, NOW + UPGRADE_INTENT_TTL_MS)
  assertEquals(pruned.intents.length, 0)
  assertEquals(gone.map((i) => i.id), [intent.id])
})

test('deferred intents never expire and drive the future-phase deltas', () => {
  const down = newDeferredIntent('downgrade', { licenseId: LICENSE_A, fromTierId: S5, toTierId: S3, nowMs: NOW })
  const release = newDeferredIntent('release-seat', { licenseId: LICENSE_B, fromTierId: S1, toTierId: null, nowMs: NOW })
  const anonymous = newDeferredIntent('release-seat', { licenseId: null, fromTierId: S1, toTierId: null, nowMs: NOW })
  let ledger = emptyLedger('sub_1')
  for (const intent of [down, release, anonymous]) ledger = withIntent(ledger, intent)
  assertEquals(pruneExpiredIntents(ledger, NOW + 365 * 24 * 3600 * 1000).pruned, [])
  assertEquals([...deferredDeltasByTier(ledger)], [[S5, -1], [S3, 1], [S1, -2]])
  assertEquals([...outstandingReleasesByTier(ledger)], [[S1, 2]])
  assertEquals(withoutIntents(ledger, [down.id, anonymous.id]).intents.map((i) => i.id), [release.id])
})

test('parseLedger rejects foreign shapes and drops malformed intents', () => {
  assertEquals(parseLedger(null), null)
  assertEquals(parseLedger({ version: 2, providerSubscriptionId: 'sub_1', intents: [] }), null)
  const parsed = parseLedger({
    version: 1,
    providerSubscriptionId: 'sub_1',
    intents: [
      { id: 'x', kind: 'upgrade', licenseId: LICENSE_A, fromTierId: S3, idempotencyKey: 'k', createdAt: 'c' },
      { id: 'y', kind: 'release-seat', fromTierId: S1, idempotencyKey: 'k', createdAt: 'c' },
      { id: 'z', kind: 'bogus' },
    ],
  })
  // The upgrade lacks `toTierId` and is dropped; the anonymous release parses.
  assertEquals(parsed?.intents.map((i) => i.id), ['y'])
  assertEquals(parsed?.intents[0]?.licenseId, null)
})

test('readPendingChanges writes back pruned intents and ignores another subscription\'s ledger', async () => {
  const db = createMemoryDb([[setting, []]])
  const stale = newUpgradeIntent({ licenseId: LICENSE_A, fromTierId: S3, toTierId: S5, nowMs: NOW - UPGRADE_INTENT_TTL_MS - 1 })
  const live = newDeferredIntent('release-seat', { licenseId: LICENSE_B, fromTierId: S1, toTierId: null, nowMs: NOW })
  await writePendingChanges(db, ORG, withIntent(withIntent(emptyLedger('sub_1'), stale), live), NOW)
  assertEquals(db.rows(setting)[0]?.key, billingPendingChangesKey(ORG))

  const first = await readPendingChanges(db, ORG, 'sub_1', NOW)
  assertEquals(first.pruned.map((i) => i.id), [stale.id])
  assertEquals(first.ledger.intents.map((i) => i.id), [live.id])
  // Pruning was persisted: the second read has nothing to prune.
  const second = await readPendingChanges(db, ORG, 'sub_1', NOW)
  assertEquals(second.pruned, [])
  assertEquals(second.ledger.intents.length, 1)

  // A re-subscribe reads an empty ledger — the old subscription's intents do not carry over.
  const other = await readPendingChanges(db, ORG, 'sub_2', NOW)
  assertEquals(other.ledger, emptyLedger('sub_2'))

  // An empty ledger deletes the row.
  await writePendingChanges(db, ORG, emptyLedger('sub_1'), NOW)
  assertEquals(db.rows(setting).length, 0)
})
