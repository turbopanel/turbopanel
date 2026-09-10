import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { executionLogStoreConformanceCases } from './execution-log-store.conformance.ts'
import { FilesystemExecutionLogStore } from './filesystem-store.ts'

describe('FilesystemExecutionLogStore', () => {
  for (const testCase of executionLogStoreConformanceCases) {
    it(testCase.name, async () => {
      const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
      try {
        await testCase.run(new FilesystemExecutionLogStore(root))
      } finally {
        await Deno.remove(root, { recursive: true })
      }
    })
  }

  it('writes transcripts under the state-tree date partition, owner-only', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const store = new FilesystemExecutionLogStore(root)
      await store.appendChunk('cmd-1', { seq: 0, bytes: new TextEncoder().encode('hi') })

      const today = new Date()
      const partition = [
        String(today.getUTCFullYear()).padStart(4, '0'),
        String(today.getUTCMonth() + 1).padStart(2, '0'),
        String(today.getUTCDate()).padStart(2, '0'),
      ].join('/')

      const logStat = await Deno.stat(`${root}/data/${partition}/cmd-1.log`)
      assertEquals(logStat.mode === null ? 0o600 : logStat.mode & 0o777, 0o600)
      // The index is flat and date-free so a read never has to guess the partition.
      await Deno.stat(`${root}/index/cmd-1.json`)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  it('replaces the plain log with a gzipped object on seal', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const store = new FilesystemExecutionLogStore(root)
      await store.appendChunk('cmd-2', { seq: 0, bytes: new TextEncoder().encode('output') })
      await store.seal('cmd-2')

      const partitions: string[] = []
      for await (const year of Deno.readDir(`${root}/data`)) {
        for await (const month of Deno.readDir(`${root}/data/${year.name}`)) {
          for await (const day of Deno.readDir(`${root}/data/${year.name}/${month.name}`)) {
            partitions.push(`${root}/data/${year.name}/${month.name}/${day.name}`)
          }
        }
      }
      assertEquals(partitions.length, 1)

      const names: string[] = []
      for await (const entry of Deno.readDir(partitions[0])) names.push(entry.name)
      assertEquals(names.sort(), ['cmd-2.log.gz'])
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  it('returns an empty window when fromSeq is past the last chunk', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const store = new FilesystemExecutionLogStore(root)
      await store.appendChunk('cmd-empty-window', { seq: 0, bytes: new TextEncoder().encode('hi') })
      const read = await store.readFrom('cmd-empty-window', 99, 1024)
      assertEquals(read?.bytes.byteLength, 0)
      assertEquals(read?.nextSeq, 99)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  it('reads an empty slice when the live log file is missing', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const store = new FilesystemExecutionLogStore(root)
      await store.appendChunk('cmd-missing-log', { seq: 0, bytes: new TextEncoder().encode('gone') })
      const today = new Date()
      const partition = [
        String(today.getUTCFullYear()).padStart(4, '0'),
        String(today.getUTCMonth() + 1).padStart(2, '0'),
        String(today.getUTCDate()).padStart(2, '0'),
      ].join('/')
      await Deno.remove(`${root}/data/${partition}/cmd-missing-log.log`)
      const read = await store.readFrom('cmd-missing-log', 0, 1024)
      assertEquals(read?.bytes.byteLength, 0)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  it('reads an empty slice when a sealed object is missing', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const store = new FilesystemExecutionLogStore(root)
      await store.appendChunk('cmd-missing-gz', { seq: 0, bytes: new TextEncoder().encode('sealed') })
      await store.seal('cmd-missing-gz')
      const today = new Date()
      const partition = [
        String(today.getUTCFullYear()).padStart(4, '0'),
        String(today.getUTCMonth() + 1).padStart(2, '0'),
        String(today.getUTCDate()).padStart(2, '0'),
      ].join('/')
      await Deno.remove(`${root}/data/${partition}/cmd-missing-gz.log.gz`)
      const read = await store.readFrom('cmd-missing-gz', 0, 1024)
      assertEquals(read?.bytes.byteLength, 0)
      assertEquals(read?.sealed, true)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  it('returns a short slice when the live log is shorter than the index', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const store = new FilesystemExecutionLogStore(root)
      await store.appendChunk('cmd-short', { seq: 0, bytes: new TextEncoder().encode('abcdef') })
      const today = new Date()
      const partition = [
        String(today.getUTCFullYear()).padStart(4, '0'),
        String(today.getUTCMonth() + 1).padStart(2, '0'),
        String(today.getUTCDate()).padStart(2, '0'),
      ].join('/')
      await Deno.writeFile(`${root}/data/${partition}/cmd-short.log`, new Uint8Array(2), {
        mode: 0o600,
      })
      const read = await store.readFrom('cmd-short', 0, 1024)
      assertEquals(read?.bytes.byteLength, 2)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  it('rethrows when the index path exists but is unreadable as a file', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const store = new FilesystemExecutionLogStore(root)
      await Deno.mkdir(`${root}/index/cmd-isdir.json`, { recursive: true })
      let failed = false
      try {
        await store.readFrom('cmd-isdir', 0, 10)
      } catch {
        failed = true
      }
      assertEquals(failed, true)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  it('rethrows when a sealed object path is a directory', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const store = new FilesystemExecutionLogStore(root)
      await store.appendChunk('cmd-gz-dir', { seq: 0, bytes: new TextEncoder().encode('x') })
      await store.seal('cmd-gz-dir')
      const today = new Date()
      const partition = [
        String(today.getUTCFullYear()).padStart(4, '0'),
        String(today.getUTCMonth() + 1).padStart(2, '0'),
        String(today.getUTCDate()).padStart(2, '0'),
      ].join('/')
      const gzPath = `${root}/data/${partition}/cmd-gz-dir.log.gz`
      await Deno.remove(gzPath)
      await Deno.mkdir(gzPath)
      let failed = false
      try {
        await store.readFrom('cmd-gz-dir', 0, 1024)
      } catch {
        failed = true
      }
      assertEquals(failed, true)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  it('rethrows delete when a transcript path is a non-empty directory', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const store = new FilesystemExecutionLogStore(root)
      await store.appendChunk('cmd-rm-dir', { seq: 0, bytes: new TextEncoder().encode('x') })
      const today = new Date()
      const partition = [
        String(today.getUTCFullYear()).padStart(4, '0'),
        String(today.getUTCMonth() + 1).padStart(2, '0'),
        String(today.getUTCDate()).padStart(2, '0'),
      ].join('/')
      const logPath = `${root}/data/${partition}/cmd-rm-dir.log`
      await Deno.remove(logPath)
      await Deno.mkdir(logPath)
      await Deno.writeTextFile(`${logPath}/nested`, 'keep')
      let failed = false
      try {
        await store.delete('cmd-rm-dir')
      } catch {
        failed = true
      }
      assertEquals(failed, true)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  it('sweepExpired skips junk names, nested dirs, and honors the per-tick budget', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const store = new FilesystemExecutionLogStore(root, {
        now: () => new Date('2026-03-01T00:00:00.000Z'),
      })
      await Deno.mkdir(`${root}/data/2020/01/01`, { recursive: true })
      await Deno.writeTextFile(`${root}/data/2020/01/01/cmd-a.log`, 'a')
      await Deno.writeTextFile(`${root}/data/2020/01/01/cmd-b.log`, 'b')
      await Deno.mkdir(`${root}/data/2020/01/01/not-a-file`)
      await Deno.writeTextFile(`${root}/data/2020/not-a-month`, 'file')
      await Deno.mkdir(`${root}/data/skip-me`, { recursive: true })

      const future = new Date('2026-06-01T00:00:00.000Z')
      assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 1, now: future }), 1)
      assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 10, now: future }), 1)
      assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 10, now: future }), 0)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  it('sweepExpired stops at the first unexpired partition', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const now = new Date('2026-03-15T00:00:00.000Z')
      const store = new FilesystemExecutionLogStore(root, { now: () => now })
      await Deno.mkdir(`${root}/data/2026/03/01`, { recursive: true })
      await Deno.writeTextFile(`${root}/data/2026/03/01/old.log`, 'old')
      await Deno.mkdir(`${root}/data/2026/03/14`, { recursive: true })
      await Deno.writeTextFile(`${root}/data/2026/03/14/keep.log`, 'keep')

      assertEquals(await store.sweepExpired({ retentionDays: 7, limit: 10, now }), 1)
      await Deno.stat(`${root}/data/2026/03/14/keep.log`)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  it('sweepExpired is a no-op when the data root is missing', async () => {
    const root = await Deno.makeTempDir({ prefix: 'turbopanel-execution-logs-' })
    try {
      const store = new FilesystemExecutionLogStore(root)
      assertEquals(await store.sweepExpired({ retentionDays: 1, limit: 10 }), 0)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })
})
