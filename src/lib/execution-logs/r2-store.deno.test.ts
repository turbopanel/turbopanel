import { assert, assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { executionLogStoreConformanceCases } from './execution-log-store.conformance.ts'
import { createFakeR2Bucket } from './fake-r2-bucket.ts'
import { R2ExecutionLogStore } from './r2-store.ts'

/**
 * Host-free coverage for the shared keyed-object driver via its R2 adapter.
 * The workerd-pool suite (`r2-store.workers.test.ts`) runs the same cases
 * against a real `R2Bucket` binding shape inside the Workers runtime.
 */
describe('R2ExecutionLogStore', () => {
  for (const testCase of executionLogStoreConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(new R2ExecutionLogStore(createFakeR2Bucket()))
    })
  }

  it('stores one part per chunk while the transcript is live', async () => {
    const bucket = createFakeR2Bucket()
    const store = new R2ExecutionLogStore(bucket)
    await store.appendChunk('cmd-1', { seq: 0, bytes: new TextEncoder().encode('a') })
    await store.appendChunk('cmd-1', { seq: 1, bytes: new TextEncoder().encode('b') })

    const parts = bucket.keys().filter((key) => key.endsWith('.part'))
    assertEquals(parts.length, 2)
    // Zero-padded so a lexical list is also a sequence-ordered list.
    assert(parts[0].endsWith('/000000000.part'))
    assert(parts[1].endsWith('/000000001.part'))
  })

  it('compacts parts into a single gzipped object on seal', async () => {
    const bucket = createFakeR2Bucket()
    const store = new R2ExecutionLogStore(bucket)
    await store.appendChunk('cmd-2', { seq: 0, bytes: new TextEncoder().encode('a') })
    await store.appendChunk('cmd-2', { seq: 1, bytes: new TextEncoder().encode('b') })
    await store.seal('cmd-2')

    assertEquals(bucket.keys().filter((key) => key.endsWith('.part')).length, 0)
    assertEquals(bucket.keys().filter((key) => key.endsWith('.log.gz')).length, 1)
    // The flat index survives sealing — it carries the date partition.
    assertEquals(bucket.keys().filter((key) => key.startsWith('execution-logs/index/')).length, 1)
  })

  it('leaves nothing behind after a retention sweep', async () => {
    const bucket = createFakeR2Bucket()
    const store = new R2ExecutionLogStore(bucket)
    await store.appendChunk('cmd-3', { seq: 0, bytes: new TextEncoder().encode('a') })
    await store.seal('cmd-3')

    const future = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000)
    assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 100, now: future }), 1)
    assertEquals(bucket.keys(), [])
  })

  it('pages R2 list results when a listing is truncated with a cursor', async () => {
    const listed: string[] = []
    const bucket = {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(),
      list: ({ cursor }: { cursor?: string }) => {
        if (!cursor) {
          listed.push('page-1')
          return Promise.resolve({
            objects: [{ key: 'execution-logs/data/2020/01/01/cmd-a.log.gz' }],
            truncated: true,
            cursor: 'next',
          })
        }
        listed.push('page-2')
        return Promise.resolve({
          objects: [{ key: 'execution-logs/data/2020/01/01/cmd-b.log.gz' }],
          truncated: false,
        })
      },
    }
    const store = new R2ExecutionLogStore(bucket)
    await store.sweepExpired({
      retentionDays: 1,
      limit: 10,
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    // Sweep lists the data prefix, then lists again per expired transcript to
    // drop leftover parts — pagination must fire on the first of those calls.
    assertEquals(listed.slice(0, 2), ['page-1', 'page-2'])
  })

  it('bounds one sweep tick to the requested limit', async () => {
    const bucket = createFakeR2Bucket()
    const store = new R2ExecutionLogStore(bucket)
    for (let index = 0; index < 5; index++) {
      await store.appendChunk(`cmd-${index}`, { seq: 0, bytes: new TextEncoder().encode('a') })
    }

    const future = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000)
    assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 2, now: future }), 2)
    assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 2, now: future }), 2)
    assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 2, now: future }), 1)
    assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 2, now: future }), 0)
  })
})
