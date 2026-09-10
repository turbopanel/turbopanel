import { assertEquals, assertExists } from '@std/assert'
import type { Db } from '../db.ts'
import type { DaemonCell, DaemonCellRegistry, PendingRequestRecord } from '../daemon/cell/contracts.ts'
import { REENCRYPT_BATCH_SIZE } from './reencrypt-secrets.ts'
import {
  extractAddresses,
  isReencryptStage,
  MAX_CELL_PURGE_BATCH_SIZE,
  parseCellPurgeBatchBody,
  parseEmailSettingsUpdates,
  parsePayloadBody,
  parseReencryptRequestBody,
  parseServerMetricsLiveSettingsBody,
  parseSignupEnabledBody,
  publicUrlsApplyWaitToResponse,
  resolvePerServerLimit,
  resolvePlatformEnv,
  resolvePublicUrlsForApply,
  waitForPublicUrlsApply,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('extractAddresses returns ips when status is done', () => {
  const ips = [
    { address: '203.0.113.10', version: 4 as const, scope: 'public' as const },
  ]
  assertEquals(
    extractAddresses({ status: 'done', result: { ips } }),
    ips,
  )
})

test('extractAddresses throws on expired, failed, and missing payload', () => {
  try {
    extractAddresses({ status: 'expired' })
    throw new TypeError('expected throw')
  } catch (err) {
    assertEquals((err as Error).message, 'timeout waiting for addresses')
  }
  try {
    extractAddresses({ status: 'failed' })
    throw new TypeError('expected throw')
  } catch (err) {
    assertEquals((err as Error).message, 'failed to fetch addresses')
  }
  try {
    extractAddresses({ status: 'done', result: {} })
    throw new TypeError('expected throw')
  } catch (err) {
    assertEquals((err as Error).message, 'missing ips in daemon response')
  }
})

test('parseReencryptRequestBody defaults and validates cursor/limit', () => {
  assertEquals(parseReencryptRequestBody(undefined), {
    ok: true,
    cursor: null,
    limit: REENCRYPT_BATCH_SIZE,
  })
  assertEquals(parseReencryptRequestBody({ limit: 9999 }), {
    ok: true,
    cursor: null,
    limit: REENCRYPT_BATCH_SIZE,
  })
  assertEquals(
    parseReencryptRequestBody({ cursor: { stage: 'variables', afterId: 'abc' }, limit: 10 }),
    { ok: true, cursor: { stage: 'variables', afterId: 'abc' }, limit: 10 },
  )
  assertEquals(parseReencryptRequestBody([]), { ok: false, error: 'expected { cursor?, limit? }' })
  assertEquals(parseReencryptRequestBody({ limit: 0 }), {
    ok: false,
    error: 'limit must be a positive integer',
  })
  assertEquals(parseReencryptRequestBody({ cursor: { stage: 'bad' } }), {
    ok: false,
    error: 'cursor.stage is required',
  })
  assertEquals(parseReencryptRequestBody({ cursor: { stage: 'tls', afterId: '' } }), {
    ok: false,
    error: 'cursor.afterId must be a non-empty string',
  })
  assertEquals(parseReencryptRequestBody({ cursor: [] }), {
    ok: false,
    error: 'cursor must be an object',
  })
  assertEquals(parseReencryptRequestBody({ cursor: null }), {
    ok: true,
    cursor: null,
    limit: REENCRYPT_BATCH_SIZE,
  })
})
test('isReencryptStage recognizes configured stages only', () => {
  assertEquals(isReencryptStage('variables'), true)
  assertEquals(isReencryptStage('storage'), true)
  assertEquals(isReencryptStage('secrets'), true)
  assertEquals(isReencryptStage('email'), true)
  assertEquals(isReencryptStage('unknown'), false)
})

test('parsePayloadBody and parseSignupEnabledBody validate shapes', () => {
  assertEquals(parsePayloadBody({ payload: { echo: 1 } }), { ok: true, payload: { echo: 1 } })
  assertEquals(parsePayloadBody(null), { ok: false, error: 'expected { payload: unknown }' })
  assertEquals(parseSignupEnabledBody({ enabled: true }), { ok: true, enabled: true })
  assertEquals(parseSignupEnabledBody({ enabled: 'yes' }), {
    ok: false,
    error: 'expected { enabled: boolean }',
  })
  assertEquals(parseSignupEnabledBody([]), {
    ok: false,
    error: 'expected { enabled: boolean }',
  })
})

test('parseServerMetricsLiveSettingsBody requires an integer maxMinutes', () => {
  assertEquals(parseServerMetricsLiveSettingsBody({ maxMinutes: 30 }), {
    ok: true,
    maxMinutes: 30,
  })
  assertEquals(parseServerMetricsLiveSettingsBody([]), {
    ok: false,
    error: 'expected { maxMinutes: number }',
  })
  assertEquals(parseServerMetricsLiveSettingsBody({ maxMinutes: 1.5 }), {
    ok: false,
    error: 'expected { maxMinutes: number }',
  })
})

test('parseCellPurgeBatchBody enforces non-empty ids and batch cap', () => {
  assertEquals(parseCellPurgeBatchBody({ serverIds: ['a'] }), { ok: true, serverIds: ['a'] })
  assertEquals(parseCellPurgeBatchBody({ serverIds: [] }).ok, false)
  assertEquals(parseCellPurgeBatchBody({ serverIds: [''] }).ok, false)
  const tooMany = Array.from({ length: MAX_CELL_PURGE_BATCH_SIZE + 1 }, (_, i) => `id-${i}`)
  assertEquals(parseCellPurgeBatchBody({ serverIds: tooMany }).ok, false)
})

test('parseEmailSettingsUpdates keeps string/null entries only', () => {
  assertEquals(parseEmailSettingsUpdates(null), null)
  assertEquals(
    parseEmailSettingsUpdates({ SMTP_HOST: 'mail.example.com', SMTP_PORT: 587, BAD: true }),
    { SMTP_HOST: 'mail.example.com' },
  )
  assertEquals(parseEmailSettingsUpdates({ SMTP_PASS: null }), { SMTP_PASS: null })
})

test('resolvePerServerLimit falls back to 50', () => {
  assertEquals(resolvePerServerLimit(undefined), 50)
  assertEquals(resolvePerServerLimit('10'), 10)
  assertEquals(resolvePerServerLimit('nope'), 50)
})

test('publicUrlsApplyWaitToResponse maps wait outcomes to HTTP payloads', () => {
  assertEquals(publicUrlsApplyWaitToResponse({ kind: 'done' }), {
    status: 200,
    body: { ok: true, applied: true },
  })
  assertEquals(publicUrlsApplyWaitToResponse({ kind: 'timeout' }), {
    status: 500,
    body: { ok: false, applied: false, error: 'timeout waiting for daemon' },
  })
  assertEquals(publicUrlsApplyWaitToResponse({ kind: 'failed', error: 'boom' }), {
    status: 500,
    body: { ok: false, applied: false, error: 'boom' },
  })
})

test('resolvePlatformEnv prefers context then opts.getEnv', () => {
  const context = {
    get(key: string) {
      if (key === 'platformEnv') return { TURBOPANEL_MODE: 'development' }
      return undefined
    },
  }
  assertEquals(
    resolvePlatformEnv(context as never, { getEnv: () => ({ OTHER: '1' }) }),
    { TURBOPANEL_MODE: 'development' },
  )
  assertEquals(
    resolvePlatformEnv({ get: () => undefined } as never, { getEnv: () => ({ X: 'y' }) }),
    { X: 'y' },
  )
  assertEquals(resolvePlatformEnv({ get: () => undefined } as never, {}), {})
})

test('resolvePublicUrlsForApply validates, persists, or loads stored urls', async () => {
  let stored: string[] = ['https://panel.example.com']
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ value: stored }]),
        }),
      }),
    }),
    insert: () => ({
      values: (row: { value: string[] }) => {
        stored = row.value
        return {
          onConflictDoUpdate: () => Promise.resolve(),
        }
      },
    }),
  } as unknown as Db

  const badShape = await resolvePublicUrlsForApply(db, { urls: [1] }, false)
  assertEquals(badShape.ok, false)
  if (badShape.ok) throw new TypeError('expected failure')
  assertEquals(badShape.status, 400)

  const invalidUrl = await resolvePublicUrlsForApply(db, { urls: ['https://localhost'] }, false)
  assertEquals(invalidUrl.ok, false)
  if (invalidUrl.ok) throw new TypeError('expected failure')
  assertEquals(invalidUrl.status, 422)

  const applied = await resolvePublicUrlsForApply(
    db,
    { urls: ['https://new.example.com'] },
    false,
  )
  assertEquals(applied.ok, true)
  if (!applied.ok) throw new TypeError('expected ok')
  assertEquals(applied.urls, ['https://new.example.com'])

  const loaded = await resolvePublicUrlsForApply(db, {}, false)
  assertEquals(loaded.ok, true)
  if (!loaded.ok) throw new TypeError('expected ok')
  assertExists(loaded.urls)
})

function registryWithWait(
  wait: (outbound: { requestId: string; at: string; kind: string }) => Promise<PendingRequestRecord>,
): DaemonCellRegistry {
  const cell = {
    createRequestAndWait: wait,
  } as unknown as DaemonCell
  return {
    getCell: () => cell,
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
    purge: async () => {},
  }
}

test('waitForPublicUrlsApply maps done, failed, timeout, and thrown errors', async () => {
  const serverId = crypto.randomUUID()
  const urls = ['https://panel.example.com']

  assertEquals(
    await waitForPublicUrlsApply(
      registryWithWait(async (outbound) => ({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'done',
        createdAt: outbound.at,
        expiresAt: outbound.at,
      })),
      serverId,
      urls,
    ),
    { kind: 'done' },
  )

  assertEquals(
    await waitForPublicUrlsApply(
      registryWithWait(async (outbound) => ({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'failed',
        error: 'apply blew up',
        createdAt: outbound.at,
        expiresAt: outbound.at,
      })),
      serverId,
      urls,
    ),
    { kind: 'failed', error: 'apply blew up' },
  )

  assertEquals(
    await waitForPublicUrlsApply(
      registryWithWait(async (outbound) => ({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'failed',
        createdAt: outbound.at,
        expiresAt: outbound.at,
      })),
      serverId,
      urls,
    ),
    { kind: 'failed', error: 'daemon reported failure' },
  )

  assertEquals(
    await waitForPublicUrlsApply(
      registryWithWait(async (outbound) => ({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'expired',
        createdAt: outbound.at,
        expiresAt: outbound.at,
      })),
      serverId,
      urls,
    ),
    { kind: 'timeout' },
  )

  assertEquals(
    await waitForPublicUrlsApply(
      registryWithWait(async () => {
        throw new Error('cell offline')
      }),
      serverId,
      urls,
    ),
    { kind: 'error', error: 'cell offline' },
  )

  assertEquals(
    await waitForPublicUrlsApply(
      registryWithWait(async () => {
        throw 'string-fail'
      }),
      serverId,
      urls,
    ),
    { kind: 'error', error: 'string-fail' },
  )
})
