import { assertEquals } from '@std/assert'
import type { Db } from '../db.ts'
import type { CommandQueue } from '../lib/commands/queue.ts'
import { mintOrganizationCa } from '../lib/tls/self-signed.ts'
import {
  enqueuePlatformCaTrustReconcile,
  enqueuePlatformCaTrustReconcileBestEffort,
} from './tls-trust-reconcile.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const unusedDb = {} as Db
const ACTOR = '550e8400-e29b-41d4-a716-446655440000'
const SERVER_A = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const SERVER_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

async function sampleBundle(): Promise<string> {
  const material = await mintOrganizationCa({ organizationId: 'tls-trust-hostfree' })
  return material.certificatePem
}

function recordingQueue(): { queue: CommandQueue; envelopes: unknown[] } {
  const envelopes: unknown[] = []
  return {
    envelopes,
    queue: {
      enqueue: async (envelope) => {
        envelopes.push(envelope)
      },
    },
  }
}

test('enqueuePlatformCaTrustReconcile fans one command per connected server', async () => {
  const { queue, envelopes } = recordingQueue()
  const created: string[] = []
  const { enqueued } = await enqueuePlatformCaTrustReconcile({
    db: unusedDb,
    commandQueue: queue,
    actorId: ACTOR,
    nowMs: 1_700_000_000_000,
    readBundle: sampleBundle,
    listServerIds: async () => [SERVER_A, SERVER_B],
    createCommand: async (_db, input) => {
      created.push(input.serverId)
      assertEquals(input.type, 'server.tls.trust.reconcile')
      assertEquals(input.actorId, ACTOR)
      return {
        id: `cmd-${input.serverId}`,
        queuedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:01.000Z',
      }
    },
  })
  assertEquals(enqueued, 2)
  assertEquals(created, [SERVER_A, SERVER_B])
  assertEquals(envelopes.length, 2)
})

test('enqueuePlatformCaTrustReconcile uses createdAt when queuedAt is null', async () => {
  const { queue, envelopes } = recordingQueue()
  await enqueuePlatformCaTrustReconcile({
    db: unusedDb,
    commandQueue: queue,
    actorId: ACTOR,
    readBundle: sampleBundle,
    listServerIds: async () => [SERVER_A],
    createCommand: async () => ({
      id: 'cmd-created',
      queuedAt: null,
      createdAt: '2026-02-02T00:00:00.000Z',
    }),
  })
  const first = envelopes[0] as { queuedAt?: string }
  assertEquals(first.queuedAt, '2026-02-02T00:00:00.000Z')
})

test('enqueuePlatformCaTrustReconcile is a no-op when the fleet is empty', async () => {
  const { queue, envelopes } = recordingQueue()
  const { enqueued } = await enqueuePlatformCaTrustReconcile({
    db: unusedDb,
    commandQueue: queue,
    actorId: ACTOR,
    readBundle: sampleBundle,
    listServerIds: async () => [],
    createCommand: async () => {
      throw new TypeError('must not create a command without servers')
    },
  })
  assertEquals(enqueued, 0)
  assertEquals(envelopes, [])
})

test('enqueuePlatformCaTrustReconcileBestEffort logs when no servers are connected', async () => {
  const { queue } = recordingQueue()
  await enqueuePlatformCaTrustReconcileBestEffort({
    db: unusedDb,
    commandQueue: queue,
    actorId: ACTOR,
    readBundle: sampleBundle,
    listServerIds: async () => [],
    createCommand: async () => {
      throw new TypeError('must not create a command without servers')
    },
  })
})

test('enqueuePlatformCaTrustReconcileBestEffort swallows non-Error throws', async () => {
  const { queue } = recordingQueue()
  await enqueuePlatformCaTrustReconcileBestEffort({
    db: unusedDb,
    commandQueue: queue,
    actorId: ACTOR,
    readBundle: async () => {
      throw 'bundle missing'
    },
    listServerIds: async () => [SERVER_A],
  })
})

test('enqueuePlatformCaTrustReconcileBestEffort swallows fan-out failures', async () => {
  const { queue } = recordingQueue()
  await enqueuePlatformCaTrustReconcileBestEffort({
    db: unusedDb,
    commandQueue: queue,
    actorId: ACTOR,
    readBundle: sampleBundle,
    listServerIds: async () => [],
    createCommand: async () => {
      throw new TypeError('must not create a command without servers')
    },
  })
  await enqueuePlatformCaTrustReconcileBestEffort({
    db: unusedDb,
    commandQueue: queue,
    actorId: ACTOR,
    readBundle: async () => {
      throw new TypeError('bundle unreadable')
    },
    listServerIds: async () => [SERVER_A],
  })
})
