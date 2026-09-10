import { assert, assertEquals } from '@std/assert'
import { describe, it, beforeEach } from '@std/testing/bdd'
import { DisabledExecutionLogStore } from './disabled-store.ts'
import { FilesystemExecutionLogStore } from './filesystem-store.ts'
import { R2ExecutionLogStore } from './r2-store.ts'
import { S3ExecutionLogStore } from './s3-store.ts'
import { createFakeR2Bucket } from './fake-r2-bucket.ts'
import {
  parseExecutionLogDriver,
  parseExecutionLogRetentionDays,
  resetExecutionLogStoreSelectionWarningsForTests,
  resolveExecutionLogStore,
  resolveS3ExecutionLogConfig,
} from './store-selection.ts'
import { EXECUTION_LOG_RETENTION_DAYS } from './types.ts'

const FULL_S3 = {
  endpoint: 'https://s3.example.test',
  bucket: 'transcripts',
  region: 'us-east-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
}

describe('parseExecutionLogDriver', () => {
  it('defaults to filesystem for anything unrecognized', () => {
    assertEquals(parseExecutionLogDriver(undefined), 'filesystem')
    assertEquals(parseExecutionLogDriver(''), 'filesystem')
    assertEquals(parseExecutionLogDriver('r2'), 'filesystem')
    assertEquals(parseExecutionLogDriver(' S3 '), 's3')
  })
})

describe('parseExecutionLogRetentionDays', () => {
  it('falls back to the default for empty or invalid values', () => {
    assertEquals(parseExecutionLogRetentionDays(undefined), EXECUTION_LOG_RETENTION_DAYS)
    assertEquals(parseExecutionLogRetentionDays(''), EXECUTION_LOG_RETENTION_DAYS)
    assertEquals(parseExecutionLogRetentionDays('0'), EXECUTION_LOG_RETENTION_DAYS)
    assertEquals(parseExecutionLogRetentionDays('-5'), EXECUTION_LOG_RETENTION_DAYS)
    assertEquals(parseExecutionLogRetentionDays('7.5'), EXECUTION_LOG_RETENTION_DAYS)
  })

  it('accepts a positive integer override', () => {
    assertEquals(parseExecutionLogRetentionDays('7'), 7)
    assertEquals(parseExecutionLogRetentionDays(90), 90)
  })
})

describe('resolveS3ExecutionLogConfig', () => {
  it('reads the documented env vars and defaults to path-style addressing', () => {
    const config = resolveS3ExecutionLogConfig({
      TURBOPANEL_EXECUTION_LOG_S3_ENDPOINT: ' https://minio.internal ',
      TURBOPANEL_EXECUTION_LOG_S3_BUCKET: 'transcripts',
      TURBOPANEL_EXECUTION_LOG_S3_REGION: 'us-east-1',
      TURBOPANEL_EXECUTION_LOG_S3_ACCESS_KEY_ID: 'key',
      TURBOPANEL_EXECUTION_LOG_S3_SECRET_ACCESS_KEY: 'secret',
    })
    assertEquals(config.endpoint, 'https://minio.internal')
    assertEquals(config.forcePathStyle, true)
  })

  it('honors an explicit virtual-hosted-style opt-out', () => {
    const config = resolveS3ExecutionLogConfig({
      TURBOPANEL_EXECUTION_LOG_S3_FORCE_PATH_STYLE: 'false',
    })
    assertEquals(config.forcePathStyle, false)
  })
})

describe('resolveExecutionLogStore', () => {
  beforeEach(() => {
    resetExecutionLogStoreSelectionWarningsForTests()
  })

  it('uses R2 on Workers when the binding is present', () => {
    const store = resolveExecutionLogStore({ runtime: 'workers', r2: createFakeR2Bucket() })
    assert(store instanceof R2ExecutionLogStore)
  })

  it('falls back to a disabled store when the Workers R2 binding is missing', () => {
    const store = resolveExecutionLogStore({ runtime: 'workers' })
    assert(store instanceof DisabledExecutionLogStore)
  })

  it('uses the filesystem driver by default on Deno', () => {
    const store = resolveExecutionLogStore({
      runtime: 'deno',
      deno: { directory: '/var/lib/turbopanel/execution-logs' },
    })
    assert(store instanceof FilesystemExecutionLogStore)
  })

  it('uses S3 on Deno when opted in with a complete config', () => {
    const store = resolveExecutionLogStore({
      runtime: 'deno',
      deno: { driver: 's3', s3: FULL_S3 },
    })
    assert(store instanceof S3ExecutionLogStore)
  })

  it('falls back to a disabled store when the S3 config is incomplete', () => {
    const store = resolveExecutionLogStore({
      runtime: 'deno',
      deno: { driver: 's3', s3: { ...FULL_S3, secretAccessKey: '' } },
    })
    assert(store instanceof DisabledExecutionLogStore)
  })

  it('falls back to a disabled store when the S3 driver is selected without a config object', () => {
    const store = resolveExecutionLogStore({
      runtime: 'deno',
      deno: { driver: 's3' },
    })
    assert(store instanceof DisabledExecutionLogStore)
  })

  it('falls back to a disabled store when no Deno directory resolved', () => {
    const store = resolveExecutionLogStore({ runtime: 'deno', deno: { directory: '  ' } })
    assert(store instanceof DisabledExecutionLogStore)
  })
})

describe('DisabledExecutionLogStore', () => {
  it('never makes a caller branch on availability', async () => {
    const store = new DisabledExecutionLogStore()
    assertEquals(await store.appendChunk('cmd', { seq: 3, bytes: new Uint8Array(1) }), {
      nextSeq: 4,
    })
    assertEquals(await store.readFrom('cmd', 0, 10), null)
    assertEquals(await store.exists('cmd'), false)
    assertEquals(await store.seal('cmd'), null)
    assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 10 }), 0)
    await store.delete('cmd')
  })
})
