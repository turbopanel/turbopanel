/**
 * The org-scoped quantity lease over an in-memory `setting` row — same shape
 * as `src/admin/reencrypt-secrets.hostfree.test.ts`.
 */

import { assertEquals, assertNotEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  BILLING_QUANTITY_LEASE_MS,
  billingQuantityLockKey,
  endQuantityMutation,
  resetBillingQuantityLockForTests,
  tryBeginQuantityMutation,
} from './quantity-lock.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_A = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const ORG_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

type LockValue = { owner: string; expiresAt: string }

type MemoryDb = Db & {
  rows: Map<string, LockValue>
  deletes: { key: string; owner: string | null }[]
}

/**
 * Keyed rows so two organizations' leases are independent, and a delete that
 * records the owner predicate so owner-scoping can be asserted.
 */
function createLockMemoryDb(initial: Record<string, LockValue> = {}): MemoryDb {
  const rows = new Map<string, LockValue>(Object.entries(initial))
  const deletes: { key: string; owner: string | null }[] = []
  let selectedKey: string | null = null

  const keyFromWhere = (where: unknown): string => {
    // Walk the drizzle SQL object for the string chunk that is a key.
    const parts: string[] = []
    const seen = new Set<unknown>()
    const visit = (node: unknown): void => {
      if (typeof node === 'string') {
        parts.push(node)
        return
      }
      if (!node || typeof node !== 'object' || seen.has(node)) return
      seen.add(node)
      const obj = node as Record<string, unknown>
      if (Array.isArray(obj.queryChunks)) for (const chunk of obj.queryChunks) visit(chunk)
      if (Array.isArray(obj.value)) for (const chunk of obj.value) visit(chunk)
      if (obj.value !== undefined && typeof obj.value === 'string') parts.push(obj.value)
      if ('encoder' in obj && typeof obj.value === 'string') parts.push(obj.value)
    }
    visit(where)
    const key = parts.find((p) => p.startsWith('BILLING_QUANTITY_LOCK:'))
    if (!key) throw new Error('where clause names no lock key')
    return key
  }
  /**
   * Bound values only: drizzle `Param` objects (an `encoder`) and raw
   * template interpolations, which sit as plain strings in `queryChunks`.
   * `StringChunk.value` arrays are SQL text and are not walked here.
   */
  const ownerFromWhere = (where: unknown): string | null => {
    const params: string[] = []
    const seen = new Set<unknown>()
    const visit = (node: unknown): void => {
      if (typeof node === 'string') {
        if (node.length > 0) params.push(node)
        return
      }
      if (!node || typeof node !== 'object' || seen.has(node)) return
      seen.add(node)
      const obj = node as Record<string, unknown>
      if ('encoder' in obj && typeof obj.value === 'string') params.push(obj.value)
      if (Array.isArray(obj.queryChunks)) for (const chunk of obj.queryChunks) visit(chunk)
    }
    visit(where)
    return params.find((p) => !p.startsWith('BILLING_QUANTITY_LOCK:')) ?? null
  }

  const db = {
    rows,
    deletes,
    insert: () => ({
      values: (row: { key: string; value: LockValue }) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            if (rows.has(row.key)) return Promise.resolve([])
            rows.set(row.key, row.value)
            return Promise.resolve([{ key: row.key }])
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: (where: unknown) => {
          selectedKey = keyFromWhere(where)
          return {
            limit: () => {
              const row = selectedKey ? rows.get(selectedKey) : undefined
              return Promise.resolve(row ? [{ value: row }] : [])
            },
          }
        },
      }),
    }),
    update: () => ({
      set: (row: { value: LockValue }) => ({
        where: (where: unknown) => ({
          returning: () => {
            const key = keyFromWhere(where)
            const current = rows.get(key)
            if (!current) return Promise.resolve([])
            // CAS: the `eq(setting.value, existing.value)` predicate — here,
            // the row must still be the one the caller read and expired.
            const expires = Date.parse(current.expiresAt)
            const expired = !Number.isFinite(expires) || expires <= Date.now()
            if (!expired) return Promise.resolve([])
            rows.set(key, row.value)
            return Promise.resolve([{ key }])
          },
        }),
      }),
    }),
    delete: () => ({
      where: (where: unknown) => {
        const key = keyFromWhere(where)
        const owner = ownerFromWhere(where)
        deletes.push({ key, owner })
        const current = rows.get(key)
        if (current && (owner === null || current.owner === owner)) rows.delete(key)
        return Promise.resolve(undefined)
      },
    }),
  }
  return db as unknown as MemoryDb
}

test('acquire writes a lease row keyed by organization, release deletes it', async () => {
  const db = createLockMemoryDb()
  const lock = await tryBeginQuantityMutation(db, ORG_A)
  assertNotEquals(lock, null)
  assertEquals(lock?.organizationId, ORG_A)
  const row = db.rows.get(billingQuantityLockKey(ORG_A))
  assertEquals(row?.owner, lock?.owner)
  assertEquals(
    Date.parse(row?.expiresAt ?? '') > Date.now() + BILLING_QUANTITY_LEASE_MS - 5_000,
    true,
  )
  await endQuantityMutation(db, lock!)
  assertEquals(db.rows.has(billingQuantityLockKey(ORG_A)), false)
})

test('a second caller for the same organization is refused while the lease is live', async () => {
  const db = createLockMemoryDb()
  const first = await tryBeginQuantityMutation(db, ORG_A)
  assertNotEquals(first, null)
  assertEquals(await tryBeginQuantityMutation(db, ORG_A), null)
  // A different organization is a different lease entirely.
  const other = await tryBeginQuantityMutation(db, ORG_B)
  assertNotEquals(other, null)
  assertEquals(db.rows.size, 2)
})

test('an expired lease is stolen; a live one is not', async () => {
  const past = new Date(Date.now() - 1_000).toISOString()
  const db = createLockMemoryDb({
    [billingQuantityLockKey(ORG_A)]: { owner: 'crashed-holder', expiresAt: past },
  })
  const stolen = await tryBeginQuantityMutation(db, ORG_A)
  assertNotEquals(stolen, null)
  assertNotEquals(stolen?.owner, 'crashed-holder')
  assertEquals(db.rows.get(billingQuantityLockKey(ORG_A))?.owner, stolen?.owner)

  // Now live again: nobody else gets it.
  assertEquals(await tryBeginQuantityMutation(db, ORG_A), null)
  // Malformed value counts as expired.
  db.rows.set(billingQuantityLockKey(ORG_A), { owner: 'x', expiresAt: 'not-a-date' })
  assertNotEquals(await tryBeginQuantityMutation(db, ORG_A), null)
})

test('release is owner-scoped: a former holder cannot release a stolen lease', async () => {
  const past = new Date(Date.now() - 1_000).toISOString()
  const db = createLockMemoryDb({
    [billingQuantityLockKey(ORG_A)]: { owner: 'former', expiresAt: past },
  })
  const thief = await tryBeginQuantityMutation(db, ORG_A)
  assertNotEquals(thief, null)

  await endQuantityMutation(db, { organizationId: ORG_A, owner: 'former' })
  assertEquals(db.deletes.at(-1)?.owner, 'former')
  // Still held by the thief.
  assertEquals(db.rows.get(billingQuantityLockKey(ORG_A))?.owner, thief?.owner)

  await endQuantityMutation(db, thief!)
  assertEquals(db.rows.has(billingQuantityLockKey(ORG_A)), false)
})

test('the test reset drops one organization\'s row and tolerates no db', async () => {
  const db = createLockMemoryDb({
    [billingQuantityLockKey(ORG_A)]: { owner: 'a', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    [billingQuantityLockKey(ORG_B)]: { owner: 'b', expiresAt: new Date(Date.now() + 60_000).toISOString() },
  })
  await resetBillingQuantityLockForTests(undefined, ORG_A)
  assertEquals(db.rows.size, 2)
  await resetBillingQuantityLockForTests(db, ORG_A)
  assertEquals([...db.rows.keys()], [billingQuantityLockKey(ORG_B)])
})
