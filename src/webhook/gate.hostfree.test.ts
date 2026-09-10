/**
 * The gate's ordering, driven by a stub adapter.
 *
 * These are the assertions that used to be implicit in two hand-written route
 * files. Each one is a property some future adapter could quietly break by
 * reordering a step, and three of them are security properties:
 * an unauthenticated caller must not spend verification work, must not burn a
 * delivery id, and must not reach dispatch.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import type { Db } from '../db.ts'
import { deriveEncryptionSecretsConfig } from '../client/authn/secrets.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import {
  accepted,
  type GateContext,
  registerWebhookGate,
  retryable,
  WEBHOOK_RATE_LIMIT_RETRY_AFTER_SECONDS,
  type WebhookGate,
} from './gate.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PATH = '/webhook/stub'

/** A holder is whatever the kind verifies against; here, just a secret. */
type StubHolder = { secret: string | null }

type Trace = string[]

type StubOptions = {
  candidates?: StubHolder[]
  resolveOk?: boolean
  verifyResult?: boolean
  claimed?: boolean
  dispatchRetry?: boolean
  dispatchThrow?: boolean
}

/** Records every ledger call so ordering can be asserted against the trace. */
function stubDb(trace: Trace, claimed: boolean): Db {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => {
            trace.push('claim')
            return Promise.resolve(claimed ? [{ id: 'row' }] : [])
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => {
        trace.push('release')
        return Promise.resolve(undefined)
      },
    }),
  } as unknown as Db
}

async function buildApp(trace: Trace, opts: StubOptions = {}) {
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )

  const gate: WebhookGate<StubHolder> = {
    kind: 'github',
    logScope: 'stub-webhook',
    maxBodyBytes: 64,
    rateLimitKey: (peer) => {
      trace.push(`rate:${peer}`)
      return `stub:${peer}`
    },
    resolve: (_ctx: GateContext) => {
      trace.push('resolve')
      if (opts.resolveOk === false) {
        return Promise.resolve({ ok: false as const, reason: 'nope' })
      }
      return Promise.resolve({
        ok: true as const,
        candidates: opts.candidates ?? [{ secret: 'shh' }],
      })
    },
    isUnconfigured: (holder) => !holder.secret,
    unconfiguredError: 'stub_not_configured',
    verify: (holder) => {
      trace.push(`verify:${holder.secret}`)
      return Promise.resolve(opts.verifyResult ?? holder.secret === 'shh')
    },
    deliveryId: () => {
      trace.push('deliveryId')
      return Promise.resolve('delivery-1')
    },
    eventName: () => {
      trace.push('eventName')
      return 'push'
    },
    dispatch: () => {
      trace.push('dispatch')
      if (opts.dispatchThrow) throw new Error('injected dispatch crash')
      return Promise.resolve(
        opts.dispatchRetry ? retryable('dispatch_unavailable') : accepted({ ok: 1 }),
      )
    },
  }

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', stubDb(trace, opts.claimed ?? true))
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerWebhookGate(app, [PATH], gate, {
    runtime: 'deno',
    rateLimiter: {
      limit: () => {
        trace.push('limiter')
        return Promise.resolve({ success: true })
      },
    },
  })
  return app
}

function post(body = '{}'): Request {
  return new Request(`http://instance${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

test('the happy path runs every step in order', async () => {
  const trace: Trace = []
  const res = await (await buildApp(trace)).request(post())
  assertEquals(res.status, 200)
  assertEquals(trace, [
    'rate:unknown',
    'limiter',
    'resolve',
    'verify:shh',
    'deliveryId',
    'eventName',
    'claim',
    'dispatch',
  ])
})

test('the rate limit is spent before any resolution work', async () => {
  const trace: Trace = []
  const app = new Hono<AppEnv>()
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  app.use('*', (c, next) => {
    c.set('db', stubDb(trace, true))
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerWebhookGate(app, [PATH], {
    kind: 'github',
    logScope: 'stub-webhook',
    maxBodyBytes: 64,
    rateLimitKey: () => 'stub',
    resolve: () => {
      trace.push('resolve')
      return Promise.resolve({ ok: true as const, candidates: [{ secret: 'shh' }] })
    },
    isUnconfigured: () => false,
    unconfiguredError: 'stub_not_configured',
    verify: () => Promise.resolve(true),
    deliveryId: () => Promise.resolve('d'),
    eventName: () => 'push',
    dispatch: () => Promise.resolve(accepted({})),
  } satisfies WebhookGate<StubHolder>, {
    runtime: 'deno',
    rateLimiter: { limit: () => Promise.resolve({ success: false }) },
  })

  const res = await app.request(post())
  assertEquals(res.status, 429)
  assertEquals(res.headers.get('Retry-After'), String(WEBHOOK_RATE_LIMIT_RETRY_AFTER_SECONDS))
  // Nothing past the limiter ran — that is the whole point of it being first.
  assertEquals(trace, [])
})

test('an unresolvable delivery is refused, never accepted', async () => {
  const trace: Trace = []
  const res = await (await buildApp(trace, { resolveOk: false })).request(post())
  assertEquals(res.status, 401)
  assertEquals(trace.includes('claim'), false)
  assertEquals(trace.includes('dispatch'), false)
})

test('candidates with no secret answer 503, not 401', async () => {
  // "Not configured" is a gap on this side; saying 401 would send the operator
  // hunting for a credential problem at the provider.
  const trace: Trace = []
  const res = await (await buildApp(trace, { candidates: [{ secret: null }] }))
    .request(post())
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'stub_not_configured' })
  assertEquals(trace.includes('claim'), false)
})

test('a failed verification never reaches the ledger', async () => {
  const trace: Trace = []
  const res = await (await buildApp(trace, { verifyResult: false })).request(post())
  assertEquals(res.status, 401)
  // The claim is what a genuine redelivery needs; an unauthenticated request
  // must not be able to burn it.
  assertEquals(trace.includes('claim'), false)
  assertEquals(trace.includes('dispatch'), false)
})

test('verification walks candidates until one works', async () => {
  const trace: Trace = []
  const res = await (await buildApp(trace, {
    candidates: [{ secret: null }, { secret: 'wrong' }, { secret: 'shh' }],
  })).request(post())
  assertEquals(res.status, 200)
  // The unconfigured one is skipped rather than treated as a pass.
  assertEquals(trace.filter((e) => e.startsWith('verify')), ['verify:wrong', 'verify:shh'])
})

test('a duplicate delivery answers 204 without dispatching', async () => {
  const trace: Trace = []
  const res = await (await buildApp(trace, { claimed: false })).request(post())
  assertEquals(res.status, 204)
  assertEquals(trace.includes('dispatch'), false)
  assertEquals(trace.includes('release'), false)
})

test('a retryable dispatch releases the claim before answering 503', async () => {
  const trace: Trace = []
  const res = await (await buildApp(trace, { dispatchRetry: true })).request(post())
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'retry' })
  // Order matters: the sender retries with the same id, and a claim left behind
  // would turn that retry into the 204 above — dropping the event for good.
  assertEquals(trace.slice(-2), ['dispatch', 'release'])
})

test('an unexpected dispatch throw releases the claim before answering 503', async () => {
  const trace: Trace = []
  const res = await (await buildApp(trace, { dispatchThrow: true })).request(post())
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'retry' })
  assertEquals(trace.slice(-2), ['dispatch', 'release'])
})

test('an accepted dispatch keeps the claim and returns no internal result', async () => {
  const trace: Trace = []
  const res = await (await buildApp(trace)).request(post())
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
  // Releasing here would let a redelivery enqueue the same work twice.
  assertEquals(trace.includes('release'), false)
})

test('an oversized body is refused before it is buffered', async () => {
  const trace: Trace = []
  const app = await buildApp(trace)
  const res = await app.request(
    new Request(`http://instance${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '999' },
      body: '{}',
    }),
  )
  assertEquals(res.status, 413)
})

test('a malformed body is rejected after the claim, not before verification', async () => {
  const trace: Trace = []
  const res = await (await buildApp(trace)).request(post('not json'))
  assertEquals(res.status, 400)
  // Verification still ran on the raw bytes; only the parse failed.
  assertEquals(trace.includes('verify:shh'), true)
  assertEquals(trace.includes('dispatch'), false)
  assertEquals(trace.includes('release'), false)
})

test('a JSON value that is not an object is rejected after the claim', async () => {
  // parsePayload only accepts a plain object — an array is well-formed JSON
  // but not a delivery this gate can dispatch.
  const trace: Trace = []
  const res = await (await buildApp(trace)).request(post('[]'))
  assertEquals(res.status, 400)
  assertEquals(trace.includes('verify:shh'), true)
  assertEquals(trace.includes('dispatch'), false)
})

test('an oversized body without content-length is refused', async () => {
  const trace: Trace = []
  const app = await buildApp(trace)
  const res = await app.request(
    new Request(`http://instance${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"pad":"${'x'.repeat(80)}"}`,
    }),
  )
  assertEquals(res.status, 413)
  assertEquals(trace.includes('dispatch'), false)
})

test('an oversized body without content-length is refused without buffering the full payload', async () => {
  // maxBodyBytes is 64 in this suite's stub gate. Stream far more than that
  // through a custom ReadableStream and assert the reader stops pulling
  // shortly after crossing the budget — not after draining the whole body.
  const trace: Trace = []
  const app = await buildApp(trace)
  const chunkSize = 1024
  const totalChunks = 4096 // 4 MiB if fully drained
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      if (pulls > totalChunks) {
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(chunkSize).fill(120))
    },
  })

  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    duplex: 'half',
    // deno-lint-ignore no-explicit-any
  } as any
  const res = await app.request(new Request(`http://instance${PATH}`, init))
  assertEquals(res.status, 413)
  // The reader aborts once the accumulated bytes cross maxBodyBytes (64) —
  // nowhere near the 4096 chunks a full drain would require.
  assertEquals(pulls < totalChunks, true)
})

test('a missing database answers 503 before resolution', async () => {
  const trace: Trace = []
  const app = new Hono<AppEnv>()
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  app.use('*', (c, next) => {
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerWebhookGate(app, [PATH], {
    kind: 'github',
    logScope: 'stub-webhook',
    maxBodyBytes: 64,
    rateLimitKey: () => 'stub',
    resolve: () => {
      trace.push('resolve')
      return Promise.resolve({ ok: true as const, candidates: [{ secret: 'shh' }] })
    },
    isUnconfigured: () => false,
    unconfiguredError: 'stub_not_configured',
    verify: () => Promise.resolve(true),
    deliveryId: () => Promise.resolve('d'),
    eventName: () => 'push',
    dispatch: () => Promise.resolve(accepted({})),
  } satisfies WebhookGate<StubHolder>, { runtime: 'deno' })

  const res = await app.request(post())
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'Database unavailable' })
  assertEquals(trace, [])
})

test('missing encryption secrets answer 503 before resolution', async () => {
  const trace: Trace = []
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', stubDb(trace, true))
    return next()
  })
  registerWebhookGate(app, [PATH], {
    kind: 'github',
    logScope: 'stub-webhook',
    maxBodyBytes: 64,
    rateLimitKey: () => 'stub',
    resolve: () => {
      trace.push('resolve')
      return Promise.resolve({ ok: true as const, candidates: [{ secret: 'shh' }] })
    },
    isUnconfigured: () => false,
    unconfiguredError: 'stub_not_configured',
    verify: () => Promise.resolve(true),
    deliveryId: () => Promise.resolve('d'),
    eventName: () => 'push',
    dispatch: () => Promise.resolve(accepted({})),
  } satisfies WebhookGate<StubHolder>, { runtime: 'deno' })

  const res = await app.request(post())
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'Encryption unavailable' })
  assertEquals(trace, [])
})
