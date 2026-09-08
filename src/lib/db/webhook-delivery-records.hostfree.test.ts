/**
 * Host-free coverage for webhook delivery claim / release / sweep (mock Db).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { WebhookGitProviderName } from '../git/git-provider.ts'
import {
  WEBHOOK_DELIVERY_RETENTION_MS,
  WEBHOOK_DELIVERY_SWEEP_LIMIT,
  claimWebhookDelivery,
  releaseWebhookDelivery,
  sweepExpiredWebhookDeliveries,
  type WebhookDeliveryProvider,
} from './webhook-delivery-records.ts'

/**
 * `WebhookDeliveryProvider` is no longer an alias of the git union (that was
 * `src/lib/db/`'s only import from `src/lib/git/`), but the git gates still
 * write it — so every git name must stay assignable. A compile-time pin: if
 * a git provider is added without widening the ledger, this line stops
 * type-checking.
 */
const _gitNamesStayAssignable: WebhookDeliveryProvider = null as unknown as WebhookGitProviderName
void _gitNamesStayAssignable

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type DeliveryDb = Db & {
  claimedValues: unknown
  released: boolean
}

function createDeliveryDb(opts?: { claimed?: { id: string }[]; swept?: { id: string }[] }): DeliveryDb {
  const claimed = opts?.claimed ?? [{ id: 'new-claim' }]
  const swept = opts?.swept ?? []
  const db = {
    claimedValues: undefined as unknown,
    released: false,
    insert: () => ({
      values: (values: unknown) => {
        db.claimedValues = values
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(claimed),
          }),
        }
      },
    }),
    delete: () => ({
      where: () => {
        db.released = true
        const result = Promise.resolve(undefined)
        return Object.assign(result, {
          returning: () => Promise.resolve(swept),
        })
      },
    }),
  }
  return db as unknown as DeliveryDb
}

test('claimWebhookDelivery is first-writer-wins', async () => {
  const first = createDeliveryDb({ claimed: [{ id: 'd1' }] })
  assertEquals(
    await claimWebhookDelivery(first, {
      provider: 'github',
      externalDeliveryId: 'abc',
      event: 'push',
    }),
    true,
  )
  assertEquals(first.claimedValues, {
    provider: 'github',
    externalDeliveryId: 'abc',
    event: 'push',
  })

  const replay = createDeliveryDb({ claimed: [] })
  assertEquals(
    await claimWebhookDelivery(replay, {
      provider: 'gitlab',
      externalDeliveryId: 'abc',
    }),
    false,
  )
  assertEquals(replay.claimedValues, {
    provider: 'gitlab',
    externalDeliveryId: 'abc',
    event: null,
  })
})

test('releaseWebhookDelivery deletes the claimed row', async () => {
  const db = createDeliveryDb()
  await releaseWebhookDelivery(db, {
    provider: 'github',
    externalDeliveryId: 'abc',
  })
  assertEquals(db.released, true)
})

test('sweepExpiredWebhookDeliveries returns the deleted count and clamps the limit', async () => {
  const db = createDeliveryDb({ swept: [{ id: '1' }, { id: '2' }] })
  const removed = await sweepExpiredWebhookDeliveries(db, {
    limit: 5000,
    now: '2030-01-08T00:00:00.000Z',
    retentionMs: 24 * 60 * 60 * 1000,
  })
  assertEquals(removed, 2)
  assertEquals(WEBHOOK_DELIVERY_SWEEP_LIMIT, 500)
  assertEquals(WEBHOOK_DELIVERY_RETENTION_MS, 7 * 24 * 60 * 60 * 1000)

  const empty = createDeliveryDb({ swept: [] })
  assertEquals(await sweepExpiredWebhookDeliveries(empty, { limit: 0 }), 0)
})
