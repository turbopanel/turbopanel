/**
 * Host-free coverage for {@link ObjectExecutionLogStore} branches that are
 * awkward to hit through the R2/S3 adapter suites alone.
 */

import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  executionLogIndexKey,
  executionLogPartKey,
  executionLogSealedKey,
  createExecutionLogIndex,
} from './index-model.ts'
import {
  ObjectExecutionLogStore,
  type ExecutionLogObjectBackend,
} from './object-store.ts'
import {
  EXECUTION_LOG_TRUNCATION_MARKER,
  MAX_EXECUTION_LOG_TOTAL_BYTES,
} from './types.ts'

function createFakeObjectBackend(): ExecutionLogObjectBackend & {
  keys(): string[]
  raw: Map<string, Uint8Array>
} {
  const objects = new Map<string, Uint8Array>()
  return {
    raw: objects,
    async get(key) {
      return objects.get(key) ?? null
    },
    async put(key, body, _contentType) {
      objects.set(key, body.slice())
    },
    async delete(keys) {
      for (const key of keys) {
        objects.delete(key)
      }
    },
    async list(prefix, limit) {
      return [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .slice(0, limit)
    },
    keys() {
      return [...objects.keys()].sort()
    },
  }
}

describe('ObjectExecutionLogStore', () => {
  const COMMAND_ID = '00000000-0000-7000-8000-000000000001'
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  it('delete is a no-op when the index is missing', async () => {
    const backend = createFakeObjectBackend()
    const store = new ObjectExecutionLogStore(backend)
    await store.delete(COMMAND_ID)
    assertEquals(backend.keys(), [])
  })

  it('readFrom leaves a hole when a part blob is missing', async () => {
    const backend = createFakeObjectBackend()
    const store = new ObjectExecutionLogStore(backend)
    await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('aaa') })
    await store.appendChunk(COMMAND_ID, { seq: 1, bytes: encoder.encode('bbb') })

    const index = await backend.get(executionLogIndexKey(COMMAND_ID))
    if (!index) throw new TypeError('expected execution log index')
    const parsed = JSON.parse(decoder.decode(index)) as {
      datePartition: string
    }
    backend.raw.delete(
      executionLogPartKey(parsed.datePartition, COMMAND_ID, 0),
    )

    const read = await store.readFrom(COMMAND_ID, 0, 1024)
    assertEquals(read?.bytes.byteLength, 6)
    assertEquals(decoder.decode(read?.bytes ?? new Uint8Array()), '\0\0\0bbb')
  })

  it('seal on an already sealed transcript returns cached byte length', async () => {
    const backend = createFakeObjectBackend()
    const store = new ObjectExecutionLogStore(backend)
    await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('sealed') })
    const first = await store.seal(COMMAND_ID)
    const second = await store.seal(COMMAND_ID)
    assertEquals(first?.bytes, 6)
    assertEquals(second?.bytes, 6)
    assertEquals(
      backend.keys().filter((key) => key.endsWith('.part')).length,
      0,
    )
  })

  it('readFrom on a sealed transcript serves bytes from the gzipped object', async () => {
    const backend = createFakeObjectBackend()
    const store = new ObjectExecutionLogStore(backend)
    await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('line-1\n') })
    await store.appendChunk(COMMAND_ID, { seq: 1, bytes: encoder.encode('line-2\n') })
    await store.seal(COMMAND_ID)

    const read = await store.readFrom(COMMAND_ID, 1, 1024)
    assertEquals(decoder.decode(read?.bytes ?? new Uint8Array()), 'line-2\n')
  })

  it('readFrom returns an empty window when the sealed object is missing', async () => {
    const backend = createFakeObjectBackend()
    const store = new ObjectExecutionLogStore(backend)
    await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('gone') })
    await store.seal(COMMAND_ID)

    const index = await backend.get(executionLogIndexKey(COMMAND_ID))
    if (!index) throw new TypeError('expected execution log index')
    const parsed = JSON.parse(decoder.decode(index)) as {
      datePartition: string
    }
    backend.raw.delete(
      executionLogSealedKey(parsed.datePartition, COMMAND_ID),
    )

    const read = await store.readFrom(COMMAND_ID, 0, 1024)
    assertEquals(read?.bytes.byteLength, 0)
    assertEquals(read?.sealed, true)
  })

  it('sweepExpired ignores malformed data keys and deletes expired transcripts', async () => {
    const fixedNow = new Date('2026-03-01T12:00:00.000Z')
    const backend = createFakeObjectBackend()
    const store = new ObjectExecutionLogStore(backend, { now: () => fixedNow })

    await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('old') })
    await store.seal(COMMAND_ID)
    backend.raw.set('execution-logs/data/not-a-date/cmd', encoder.encode('junk'))

    const future = new Date(fixedNow.getTime() + 40 * 24 * 60 * 60 * 1000)
    assertEquals(
      await store.sweepExpired({ retentionDays: 30, limit: 10, now: future }),
      1,
    )
    assertEquals(backend.keys(), ['execution-logs/data/not-a-date/cmd'])
  })

  it('treats a replayed append sequence as a no-op', async () => {
    const backend = createFakeObjectBackend()
    const store = new ObjectExecutionLogStore(backend)
    await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('once') })
    const replay = await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('dup') })
    assertEquals(replay.nextSeq, 1)
    assertEquals(decoder.decode((await store.readFrom(COMMAND_ID, 0, 1024))?.bytes ?? new Uint8Array()), 'once')
  })

  it('writes a truncation marker when the byte cap is reached', async () => {
    const fixedNow = new Date('2026-03-01T12:00:00.000Z')
    const backend = createFakeObjectBackend()
    const store = new ObjectExecutionLogStore(backend, { now: () => fixedNow })
    const index = createExecutionLogIndex(COMMAND_ID, fixedNow)
    index.totalBytes = MAX_EXECUTION_LOG_TOTAL_BYTES
    index.nextSeq = 4
    await backend.put(
      executionLogIndexKey(COMMAND_ID),
      encoder.encode(JSON.stringify(index)),
      'application/json',
    )

    const overflow = await store.appendChunk(COMMAND_ID, {
      seq: 4,
      bytes: encoder.encode('dropped'),
    })
    assertEquals(overflow.nextSeq, 5)
    const read = await store.readFrom(COMMAND_ID, 4, 4096)
    assertEquals(read?.truncated, true)
    assertEquals(
      decoder.decode(read?.bytes ?? new Uint8Array()).includes(EXECUTION_LOG_TRUNCATION_MARKER.trim()),
      true,
    )
  })

  it('swallows further chunks after the transcript is already truncated', async () => {
    const fixedNow = new Date('2026-03-01T12:00:00.000Z')
    const backend = createFakeObjectBackend()
    const store = new ObjectExecutionLogStore(backend, { now: () => fixedNow })
    const index = createExecutionLogIndex(COMMAND_ID, fixedNow)
    index.truncated = true
    index.nextSeq = 2
    index.totalBytes = 128
    await backend.put(
      executionLogIndexKey(COMMAND_ID),
      encoder.encode(JSON.stringify(index)),
      'application/json',
    )

    const swallowed = await store.appendChunk(COMMAND_ID, {
      seq: 2,
      bytes: encoder.encode('ignored'),
    })
    assertEquals(swallowed.nextSeq, 3)
    assertEquals(
      backend.keys().filter((key) => key.endsWith('.part')).length,
      0,
    )
  })

  it('readFrom returns an empty window when fromSeq is past the last chunk', async () => {
    const backend = createFakeObjectBackend()
    const store = new ObjectExecutionLogStore(backend)
    await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('hi') })
    const read = await store.readFrom(COMMAND_ID, 99, 1024)
    assertEquals(read?.bytes.byteLength, 0)
    assertEquals(read?.nextSeq, 99)
  })

  it('readFrom returns an empty slice when no parts cover the window', async () => {
    const fixedNow = new Date('2026-03-01T12:00:00.000Z')
    const backend = createFakeObjectBackend()
    const store = new ObjectExecutionLogStore(backend, { now: () => fixedNow })
    const index = createExecutionLogIndex(COMMAND_ID, fixedNow)
    index.nextSeq = 1
    index.totalBytes = 200
    // Zero-length metadata rows advance seq without contributing bytes; the
    // reader can still expose a byte window beyond them with nothing to assemble.
    index.parts = [{ seq: 0, offset: 100, length: 0 }]
    await backend.put(
      executionLogIndexKey(COMMAND_ID),
      encoder.encode(JSON.stringify(index)),
      'application/json',
    )

    const read = await store.readFrom(COMMAND_ID, 0, 50)
    assertEquals(read?.bytes.byteLength, 0)
    assertEquals(read?.nextSeq, 1)
  })

  it('sweepExpired stops once the per-tick limit is reached', async () => {
    const fixedNow = new Date('2020-01-01T00:00:00.000Z')
    const backend = createFakeObjectBackend()
    const store = new ObjectExecutionLogStore(backend, { now: () => fixedNow })
    const commandIds = [
      '00000000-0000-7000-8000-000000000001',
      '00000000-0000-7000-8000-000000000002',
      '00000000-0000-7000-8000-000000000003',
      '00000000-0000-7000-8000-000000000004',
      '00000000-0000-7000-8000-000000000005',
    ]
    for (const commandId of commandIds) {
      await store.appendChunk(commandId, { seq: 0, bytes: encoder.encode('old') })
      await store.seal(commandId)
    }

    const future = new Date(fixedNow.getTime() + 40 * 24 * 60 * 60 * 1000)
    assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 2, now: future }), 2)
    assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 2, now: future }), 2)
    assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 2, now: future }), 1)
    assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 2, now: future }), 0)
  })
})
