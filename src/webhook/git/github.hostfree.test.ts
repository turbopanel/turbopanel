/**
 * Route-gate coverage for the GitHub webhook surface.
 *
 * Host-free: the only database work these paths reach before answering is the
 * `gitapp` lookup behind `resolveGithubWebhookForge`, which is stubbed here.
 * The point of these cases is the *order* of the gate — a delivery that names
 * no registered app, one whose app has no webhook secret, and one that is
 * unsigned must each be refused before anything is written.
 *
 * Deliveries arrive on the **scoped** path, which is the URL every registered
 * App is handed; the ref in that path is what selects the secret to verify
 * against.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { DaemonCell } from '../../daemon/cell/contracts.ts'
import type { Db } from '../../db.ts'
import {
  GITHUB_WEBHOOK_PATH,
} from '../../surfaces.ts'
import { deriveEncryptionSecretsConfig } from '../../client/authn/secrets.ts'
import { encryptSecret } from '../../client/authn/data-encryption.ts'
import { emptyComposeDocument } from '../../lib/compose/types.ts'
import {
  deployment,
  environment,
  fabric,
  forge,
  gitConnection,
  network,
  project,
  server,
  repository,
  slot,
} from '../../lib/db/schema.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
  registerGithubWebhookRoutes,
  successfulCheckSha,
} from './github.ts'
import {
  sourceWatchesBranch,
  type TriggerSummary,
  triggerSummaryNeedsRetry,
} from '../../client/repositories/webhook-trigger.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const encoder = new TextEncoder()

/** The ref this instance would have baked into the App's webhook URL. */
const WEBHOOK_REF = 'ref-under-test'

/**
 * Minimal gitapp read stub.
 *
 * Both terminal shapes matter: the ref lookup ends in `.limit(1)`, the App-id
 * fallback ends in `.orderBy(...)` because it returns a candidate list. A stub
 * with only one of them makes the other rung throw, which reads as a 500 and
 * hides whichever path is actually being exercised.
 */
function stubAppDb(
  rows: unknown[],
  opts: { claimed?: boolean; updated?: unknown[]; installations?: unknown[] } = {},
): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows.slice(0, 1)),
          orderBy: () => Promise.resolve(rows),
          // `loadInstallations` awaits the where() chain (no .limit). Keep that
          // list empty so dispatch can finish without a live repository graph.
          then: (
            onFulfilled: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) =>
            Promise.resolve(opts.installations ?? []).then(onFulfilled, onRejected),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () =>
            Promise.resolve(opts.claimed === false ? [] : [{ id: 'row' }]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(opts.updated ?? []),
        }),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(undefined),
    }),
  } as unknown as Db
}

const SOURCE_ID = '11111111-2222-4333-8444-555555555555'
const ENV_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const ORG_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SERVER_ID = '550e8400-e29b-41d4-a716-446655440000'
const INST_ROW_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    orderBy: () => thenableRows(rows),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

/**
 * Flatten a Drizzle SQL object so the execute double can recognize the
 * compose-reference resolver query. Same walk as the routes host-free suite,
 * plus `StringChunk.value` arrays, which is where `sql` templates keep their
 * literal text.
 */
function flattenSql(query: unknown): string {
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
  }
  visit(query)
  return parts.join('')
}

/**
 * Table-aware repository graph + empty-compose deploy stub.
 *
 * Placement JOIN reports a pin so the trigger proceeds; the plan's
 * `environment.where()` row has no pin and no project default, so empty
 * compose plans `{ tasks: [], serverIds: [] }` and persist writes nothing.
 * Returning created commands from `transaction` (without running the
 * callback) is what lets enqueue failure land without a real command row.
 */
function createEnqueueGraphDb(
  appRows: unknown[],
  opts: {
    claimed?: boolean
    enqueue: 'success' | 'fail'
    repository?: { autoDeploy?: string; options?: unknown }
  },
): Db {
  const composeOptions = { compose: emptyComposeDocument() }
  const sourceRow = {
    id: SOURCE_ID,
    organizationId: ORG_ID,
    defaultBranch: null,
    autoDeploy: opts.repository?.autoDeploy ?? 'immediate',
    options: opts.repository?.options ?? null,
  }

  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === forge) {
          return {
            where: () => ({
              limit: () => Promise.resolve(appRows.slice(0, 1)),
              orderBy: () => Promise.resolve(appRows),
            }),
          }
        }
        if (table === gitConnection) {
          return {
            where: () => thenableRows([{ id: INST_ROW_ID, suspendedAt: null }]),
          }
        }
        if (table === repository) {
          return {
            where: () => thenableRows([sourceRow]),
          }
        }
        if (table === environment) {
          return {
            where: () =>
              thenableRows([{
                id: ENV_ID,
                projectId: PROJECT_ID,
                serverId: null,
                options: composeOptions,
                name: 'Production',
              }]),
            innerJoin: () => ({
              innerJoin: () => ({
                where: () =>
                  thenableRows([{
                    serverId: SERVER_ID,
                    projectOptions: composeOptions,
                    organizationId: ORG_ID,
                  }]),
              }),
            }),
          }
        }
        if (table === project) {
          return {
            where: () =>
              thenableRows([{ id: PROJECT_ID, options: composeOptions }]),
          }
        }
        if (table === fabric || table === server) {
          return { where: () => thenableRows([]) }
        }
        if (table === network) {
          return {
            leftJoin: () => ({
              where: () => thenableRows([]),
            }),
          }
        }
        if (table === deployment || table === slot) {
          return { where: () => thenableRows([]) }
        }
        return {
          where: () => thenableRows([]),
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => thenableRows([]),
            }),
            where: () => thenableRows([]),
          }),
          leftJoin: () => ({
            where: () => thenableRows([]),
          }),
        }
      },
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () =>
            Promise.resolve(opts.claimed === false ? [] : [{ id: 'row' }]),
        }),
        returning: () => Promise.resolve([{ id: 'svc-1' }]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
          then: (
            onFulfilled: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => Promise.resolve().then(onFulfilled, onRejected),
        }),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(undefined),
    }),
    // The compose-reference resolver is the one attachment model left, so the
    // raw-SQL lane answers it with the environment this repository deploys.
    execute: (query: unknown) => {
      if (flattenSql(query).includes('jsonb_path_exists')) {
        return Promise.resolve([{ environment_id: ENV_ID }])
      }
      return Promise.resolve([])
    },
    transaction: async () => {
      if (opts.enqueue === 'fail') {
        return [{
          commandId: 'cmd-1',
          serverId: SERVER_ID,
          queuedAt: '2026-01-01T00:00:00.000Z',
        }]
      }
      return []
    },
  } as unknown as Db
}

async function buildApp(opts: {
  /** `undefined` = the app exists but has no webhook secret configured. */
  webhookSecret?: string
  /** `false` = the ref resolves to nothing at all. */
  appRegistered?: boolean
  rateLimited?: boolean
  claimed?: boolean
  updated?: unknown[]
  /** Set a real (non-noop) command queue so dispatch can resolve a trigger. */
  dispatchReady?: boolean
  /** Live installation + repository graph; enqueue success skips persist, fail delivers a stub command. */
  graph?: {
    enqueue: 'success' | 'fail'
    repository?: { autoDeploy?: string; options?: unknown }
  }
}) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )

  const rows = opts.appRegistered === false ? [] : [{
    id: 'app-1',
    organizationId: null,
    provider: 'github',
    name: 'TurboPanel',
    baseUrl: 'https://github.com',
    apiUrl: null,
    externalAppId: '1234',
    appSlug: null,
    clientId: null,
    redirectUri: null,
    webhookRef: WEBHOOK_REF,
    webhookTokenHash: null,
    envelopes: {
      privateKeyEnvelope: await encryptSecret(dataEncryptionSecrets, 'pem-placeholder'),
      ...(opts.webhookSecret === undefined ? {} : {
        webhookSecretEnvelope: await encryptSecret(
          dataEncryptionSecrets,
          opts.webhookSecret,
        ),
      }),
    },
  }]

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set(
      'db',
      opts.graph
        ? createEnqueueGraphDb(rows, {
          claimed: opts.claimed,
          enqueue: opts.graph.enqueue,
          ...(opts.graph.repository === undefined ? {} : { repository: opts.graph.repository }),
        })
        : stubAppDb(rows, { claimed: opts.claimed, updated: opts.updated }),
    )
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    if (opts.dispatchReady || opts.graph) {
      c.set('commandQueue', {
        enqueue: () =>
          opts.graph?.enqueue === 'fail'
            ? Promise.reject(new Error('queue down'))
            : Promise.resolve(),
      })
      c.set('daemonCellRegistry', {
        getCell: () => ({} as unknown as DaemonCell),
        listOnlineServerIds: () => Promise.resolve([]),
        getSnapshots: () => Promise.resolve(new Map()),
        purge: () => Promise.resolve(),
      })
    }
    return next()
  })
  registerGithubWebhookRoutes(app, {
    runtime: 'deno',
    ...(opts.rateLimited === undefined ? {} : {
      rateLimiter: { limit: () => Promise.resolve({ success: !opts.rateLimited }) },
    }),
  })
  return app
}

async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    { name: 'HMAC' },
    key,
    encoder.encode(body) as BufferSource,
  )
  const hex = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `sha256=${hex}`
}

function postTo(
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://instance${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://instance${GITHUB_WEBHOOK_PATH}/${WEBHOOK_REF}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

test('rate limit is spent before any App config read', async () => {
  const app = await buildApp({ rateLimited: true })
  const res = await app.request(post('{}'))
  assertEquals(res.status, 429)
})

test('a ref naming no registered app is rejected, not accepted', async () => {
  const app = await buildApp({ appRegistered: false })
  const res = await app.request(post('{}', { 'x-github-event': 'push' }))
  assertEquals(res.status, 401)
})

test('an unconfigured App refuses rather than accepting unsigned deliveries', async () => {
  const app = await buildApp({})
  const res = await app.request(post('{}', { 'x-github-event': 'push' }))
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'github_app_not_configured' })
})

test('a missing or wrong signature is 401 before the delivery is claimed', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })

  const unsigned = await app.request(post('{}', { 'x-github-event': 'push' }))
  assertEquals(unsigned.status, 401)

  const wrong = await app.request(post('{}', {
    'x-github-event': 'push',
    'x-hub-signature-256': `sha256=${'a'.repeat(64)}`,
  }))
  assertEquals(wrong.status, 401)
})

test('a signed delivery missing its event or id headers is a bad request', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const body = '{}'
  const signature = await signBody('shh', body)

  const noEvent = await app.request(post(body, {
    'x-hub-signature-256': signature,
    'x-github-delivery': crypto.randomUUID(),
  }))
  assertEquals(noEvent.status, 400)

  const noDelivery = await app.request(post(body, {
    'x-hub-signature-256': signature,
    'x-github-event': 'push',
  }))
  assertEquals(noDelivery.status, 400)
})

test('an oversized declared body is refused before it is buffered', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await app.request(post('{}', {
    'x-github-event': 'push',
    'content-length': String(GITHUB_WEBHOOK_MAX_BODY_BYTES + 1),
  }))
  assertEquals(res.status, 413)
})

test('an oversized body with no Content-Length is refused without buffering the full payload', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const chunkSize = 65_536
  const totalChunks = Math.ceil((GITHUB_WEBHOOK_MAX_BODY_BYTES * 4) / chunkSize)
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

  const res = await app.request(
    new Request(`http://instance${GITHUB_WEBHOOK_PATH}/${WEBHOOK_REF}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body,
      duplex: 'half',
      // deno-lint-ignore no-explicit-any
    } as any),
  )
  assertEquals(res.status, 413)
  // GITHUB_WEBHOOK_MAX_BODY_BYTES is 1 MiB; the reader must abort within a
  // handful of 64 KiB chunks past that, nowhere near draining 4x the budget.
  assertEquals(pulls < totalChunks, true)
})

test('the scoped and bare paths both reach the same gate', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })

  // Both are URLs a provider is actually pointed at: the scoped path for
  // self-hosted apps, the bare path for github.com. Retiring either silently
  // stops the Apps holding it from ever deploying again.
  for (const path of [`${GITHUB_WEBHOOK_PATH}/${WEBHOOK_REF}`, GITHUB_WEBHOOK_PATH]) {
    const res = await app.request(
      postTo(path, '{}', {
        'x-github-event': 'push',
        'x-github-hook-installation-target-type': 'integration',
        'x-github-hook-installation-target-id': '1234',
      }),
    )
    // 401 is the gate rejecting an unsigned body — which means it ran. A 404
    // would mean the path never reached the handler at all.
    assertEquals(res.status, 401, `expected the gate to run for ${path}`)
  }
})

test('successfulCheckSha reads only completed successful suites', () => {
  assertEquals(
    successfulCheckSha('check_suite', {
      check_suite: { status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40) },
    }),
    'a'.repeat(40),
  )
  assertEquals(
    successfulCheckSha('check_suite', {
      check_suite: { status: 'completed', conclusion: 'failure', head_sha: 'a'.repeat(40) },
    }),
    null,
  )
  assertEquals(
    successfulCheckSha('check_suite', {
      check_suite: { status: 'in_progress', conclusion: null, head_sha: 'a'.repeat(40) },
    }),
    null,
  )
  assertEquals(successfulCheckSha('check_suite', {}), null)
})

test('successfulCheckSha releases a check_run only once its suite is green', () => {
  // The suite has concluded successfully: every run in it finished green, so
  // this last run is a valid all-checks-passed signal. The SHA nests one level
  // down, on the suite.
  assertEquals(
    successfulCheckSha('check_run', {
      check_run: {
        status: 'completed',
        conclusion: 'success',
        check_suite: {
          status: 'completed',
          conclusion: 'success',
          head_sha: 'b'.repeat(40),
        },
      },
    }),
    'b'.repeat(40),
  )
  // One green job while the rest of the suite is still running must not release
  // a `checks_passed` deploy.
  assertEquals(
    successfulCheckSha('check_run', {
      check_run: {
        status: 'completed',
        conclusion: 'success',
        head_sha: 'b'.repeat(40),
        check_suite: { status: 'in_progress', conclusion: null, head_sha: 'b'.repeat(40) },
      },
    }),
    null,
  )
  // Nor may one that passed inside a suite that ended up failing.
  assertEquals(
    successfulCheckSha('check_run', {
      check_run: {
        status: 'completed',
        conclusion: 'success',
        head_sha: 'b'.repeat(40),
        check_suite: { status: 'completed', conclusion: 'failure', head_sha: 'b'.repeat(40) },
      },
    }),
    null,
  )
  // A run with no suite at all carries no all-checks-green claim.
  assertEquals(
    successfulCheckSha('check_run', {
      check_run: { status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) },
    }),
    null,
  )
  assertEquals(
    successfulCheckSha('check_run', {
      check_run: {
        status: 'completed',
        conclusion: 'failure',
        check_suite: { status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) },
      },
    }),
    null,
  )
})

test('triggerSummaryNeedsRetry asks for a redelivery only on instance faults', () => {
  const summary = (over: Partial<TriggerSummary>): TriggerSummary => ({
    matchedSources: 1,
    queued: 0,
    skipped: 0,
    failed: 0,
    outcomes: [],
    ...over,
  })

  // A queue that was down will be up on the retry: the commit is recoverable
  // only if GitHub is told to come back.
  assertEquals(triggerSummaryNeedsRetry(summary({ failed: 1 })), true)
  // Everything else looks identical on a retry, so 5xx would only loop.
  assertEquals(triggerSummaryNeedsRetry(summary({ skipped: 3 })), false)
  assertEquals(triggerSummaryNeedsRetry(summary({ queued: 2 })), false)
  assertEquals(triggerSummaryNeedsRetry(summary({ queued: 1, failed: 1 })), true)
})

const COMMIT_SHA = 'a'.repeat(40)

async function signedDispatch(
  app: Hono<AppEnv>,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  return await app.request(post(body, {
    'x-hub-signature-256': await signBody('shh', body),
    'x-github-delivery': crypto.randomUUID(),
    ...headers,
  }))
}

test('a scoped path whose App id header names a different app is 401', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await app.request(post('{}', {
    'x-github-event': 'push',
    'x-github-hook-installation-target-type': 'integration',
    'x-github-hook-installation-target-id': '9999',
  }))
  assertEquals(res.status, 401)
})

test('a signed push whose ref is not a string is a non-branch skip', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await signedDispatch(app, JSON.stringify({ ref: 12 }), {
    'x-github-event': 'push',
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'push',
    result: { skipped: 'non_branch_ref' },
  })
})

test('a signed branch push that names no installation is unidentified', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await signedDispatch(app, JSON.stringify({ ref: 'refs/heads/main' }), {
    'x-github-event': 'push',
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'push',
    result: { skipped: 'unidentified_delivery' },
  })
})

test('a signed branch-delete push is accepted as skipped', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await signedDispatch(app, JSON.stringify({
    ref: 'refs/heads/main',
    after: '0'.repeat(40),
    deleted: true,
    installation: { id: 99 },
    repository: { id: 42 },
  }), { 'x-github-event': 'push' })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'push',
    result: { skipped: 'branch_deleted' },
  })
})

test('a signed push that would deploy asks for a retry when dispatch is down', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await signedDispatch(app, JSON.stringify({
    ref: 'refs/heads/main',
    after: COMMIT_SHA,
    installation: { id: 99 },
    repository: { id: 42 },
  }), { 'x-github-event': 'push' })
  assertEquals(res.status, 503)
  assertEquals(await res.json(), {
    ok: false,
    event: 'push',
    result: { error: 'dispatch_unavailable' },
  })
})

test('a signed check_suite that is not all-green is accepted as skipped', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await signedDispatch(app, JSON.stringify({
    check_suite: { status: 'in_progress', conclusion: null, head_sha: COMMIT_SHA },
  }), { 'x-github-event': 'check_suite' })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'check_suite',
    result: { skipped: 'checks_not_successful' },
  })
})

test('a signed green check_suite asks for a retry when dispatch is down', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await signedDispatch(app, JSON.stringify({
    check_suite: { status: 'completed', conclusion: 'success', head_sha: COMMIT_SHA },
    installation: { id: 99 },
    repository: { id: 42 },
  }), { 'x-github-event': 'check_suite' })
  assertEquals(res.status, 503)
  assertEquals(await res.json(), {
    ok: false,
    event: 'check_suite',
    result: { error: 'dispatch_unavailable' },
  })
})

test('a signed green check_run whose suite is green asks for a retry when dispatch is down', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await signedDispatch(app, JSON.stringify({
    check_run: {
      status: 'completed',
      conclusion: 'success',
      check_suite: {
        status: 'completed',
        conclusion: 'success',
        head_sha: COMMIT_SHA,
      },
    },
    installation: { id: 99 },
    repository: { id: 42 },
  }), { 'x-github-event': 'check_run' })
  assertEquals(res.status, 503)
  assertEquals(await res.json(), {
    ok: false,
    event: 'check_run',
    result: { error: 'dispatch_unavailable' },
  })
})

test('a signed installation without an id is unidentified', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await signedDispatch(app, JSON.stringify({ action: 'created' }), {
    'x-github-event': 'installation',
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'installation',
    result: { skipped: 'unidentified_delivery' },
  })
})

test('installation_repositories is noted without mutating repository rows', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await signedDispatch(app, JSON.stringify({
    action: 'added',
    installation: { id: 99 },
  }), { 'x-github-event': 'installation_repositories' })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'installation_repositories',
    result: { skipped: 'repositories_noted' },
  })
})

test('a signed installation lifecycle event applies against the verified app', async () => {
  const app = await buildApp({ webhookSecret: 'shh', updated: [{ id: 'inst-1' }] })
  const res = await signedDispatch(app, JSON.stringify({
    action: 'deleted',
    installation: { id: 99 },
  }), { 'x-github-event': 'installation' })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'installation',
    result: { updated: 1 },
  })
})

test('an unhandled signed event is accepted as skipped', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await signedDispatch(app, '{}', { 'x-github-event': 'ping' })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'ping',
    result: { skipped: 'event_not_handled' },
  })
})

test('sourceWatchesBranch: a blank default branch watches every branch', () => {
  assertEquals(sourceWatchesBranch('main', 'main'), true)
  assertEquals(sourceWatchesBranch('main', 'develop'), false)
  assertEquals(sourceWatchesBranch(' main ', 'main'), true)
  assertEquals(sourceWatchesBranch(null, 'anything'), true)
  assertEquals(sourceWatchesBranch('   ', 'anything'), true)
})

test('whitespace-only event or delivery headers are treated as missing', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const body = '{}'
  const signature = await signBody('shh', body)

  const blankEvent = await app.request(post(body, {
    'x-hub-signature-256': signature,
    'x-github-event': '   ',
    'x-github-delivery': crypto.randomUUID(),
  }))
  assertEquals(blankEvent.status, 400)

  const blankDelivery = await app.request(post(body, {
    'x-hub-signature-256': signature,
    'x-github-event': 'push',
    'x-github-delivery': '   ',
  }))
  assertEquals(blankDelivery.status, 400)
})

test('a green check_suite without an installation is not a release signal', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await signedDispatch(app, JSON.stringify({
    check_suite: { status: 'completed', conclusion: 'success', head_sha: COMMIT_SHA },
  }), { 'x-github-event': 'check_suite' })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'check_suite',
    result: { skipped: 'checks_not_successful' },
  })
})

test('an installation event with a non-string action is a no-op apply', async () => {
  // Only the named lifecycle verbs mutate rows; a numeric action becomes ''
  // and apply reports zero updates rather than guessing a suspend/resume.
  const app = await buildApp({ webhookSecret: 'shh', updated: [{ id: 'inst-1' }] })
  const res = await signedDispatch(app, JSON.stringify({
    action: 1,
    installation: { id: 99 },
  }), { 'x-github-event': 'installation' })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'installation',
    result: { updated: 0 },
  })
})

const unidentifiedTrigger = {
  matchedSources: 0,
  queued: 0,
  skipped: 1,
  failed: 0,
  outcomes: [{
    kind: 'skipped',
    sourceId: null,
    environmentId: null,
    reason: 'installation_unknown',
  }],
}

test('a signed push with dispatch up is accepted when no installation matches', async () => {
  const app = await buildApp({ webhookSecret: 'shh', dispatchReady: true })
  const res = await signedDispatch(app, JSON.stringify({
    ref: 'refs/heads/main',
    after: COMMIT_SHA,
    installation: { id: 99 },
    repository: { id: 42 },
  }), { 'x-github-event': 'push' })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'push',
    result: unidentifiedTrigger,
  })
})

test('a signed green check_suite with dispatch up is accepted when no installation matches', async () => {
  const app = await buildApp({ webhookSecret: 'shh', dispatchReady: true })
  const res = await signedDispatch(app, JSON.stringify({
    check_suite: { status: 'completed', conclusion: 'success', head_sha: COMMIT_SHA },
    installation: { id: 99 },
    repository: { id: 42 },
  }), { 'x-github-event': 'check_suite' })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'check_suite',
    result: unidentifiedTrigger,
  })
})

test('a signed green check_run with dispatch up is accepted when no installation matches', async () => {
  const app = await buildApp({ webhookSecret: 'shh', dispatchReady: true })
  const res = await signedDispatch(app, JSON.stringify({
    check_run: {
      status: 'completed',
      conclusion: 'success',
      check_suite: {
        status: 'completed',
        conclusion: 'success',
        head_sha: COMMIT_SHA,
      },
    },
    installation: { id: 99 },
    repository: { id: 42 },
  }), { 'x-github-event': 'check_run' })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'check_run',
    result: unidentifiedTrigger,
  })
})

const queuedOutcome = {
  kind: 'queued' as const,
  sourceId: SOURCE_ID,
  environmentId: ENV_ID,
  commitSha: COMMIT_SHA,
}

const failedOutcome = {
  kind: 'failed' as const,
  sourceId: SOURCE_ID,
  environmentId: ENV_ID,
  reason: 'deploy_unavailable' as const,
  status: 503,
}

const parkedChecks = {
  pendingChecks: {
    commitSha: COMMIT_SHA,
    ref: 'refs/heads/main',
    recordedAt: '2026-01-01T00:00:00.000Z',
  },
}

const greenCheckSuite = {
  check_suite: { status: 'completed', conclusion: 'success', head_sha: COMMIT_SHA },
  installation: { id: 99 },
  repository: { id: 42 },
}

const greenCheckRun = {
  check_run: {
    status: 'completed',
    conclusion: 'success',
    check_suite: {
      status: 'completed',
      conclusion: 'success',
      head_sha: COMMIT_SHA,
    },
  },
  installation: { id: 99 },
  repository: { id: 42 },
}

const branchPush = {
  ref: 'refs/heads/main',
  after: COMMIT_SHA,
  installation: { id: 99 },
  repository: { id: 42 },
}

test('a signed push with a matched repository enqueues a deploy', async () => {
  const app = await buildApp({
    webhookSecret: 'shh',
    graph: { enqueue: 'success' },
  })
  const res = await signedDispatch(app, JSON.stringify(branchPush), {
    'x-github-event': 'push',
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'push',
    result: {
      matchedSources: 1,
      queued: 1,
      skipped: 0,
      failed: 0,
      outcomes: [queuedOutcome],
    },
  })
})

test('a signed push reports enqueue failure so GitHub redelivers', async () => {
  const app = await buildApp({
    webhookSecret: 'shh',
    graph: { enqueue: 'fail' },
  })
  const res = await signedDispatch(app, JSON.stringify(branchPush), {
    'x-github-event': 'push',
  })
  assertEquals(res.status, 503)
  assertEquals(await res.json(), {
    ok: false,
    event: 'push',
    result: {
      matchedSources: 1,
      queued: 0,
      skipped: 0,
      failed: 1,
      outcomes: [failedOutcome],
    },
  })
})

test('a signed green check_suite with a parked SHA enqueues a deploy', async () => {
  const app = await buildApp({
    webhookSecret: 'shh',
    graph: {
      enqueue: 'success',
      repository: { autoDeploy: 'checks_passed', options: parkedChecks },
    },
  })
  const res = await signedDispatch(app, JSON.stringify(greenCheckSuite), {
    'x-github-event': 'check_suite',
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'check_suite',
    result: {
      matchedSources: 1,
      queued: 1,
      skipped: 0,
      failed: 0,
      outcomes: [queuedOutcome],
    },
  })
})

test('a signed green check_run with a parked SHA reports enqueue failure', async () => {
  const app = await buildApp({
    webhookSecret: 'shh',
    graph: {
      enqueue: 'fail',
      repository: { autoDeploy: 'checks_passed', options: parkedChecks },
    },
  })
  const res = await signedDispatch(app, JSON.stringify(greenCheckRun), {
    'x-github-event': 'check_run',
  })
  assertEquals(res.status, 503)
  assertEquals(await res.json(), {
    ok: false,
    event: 'check_run',
    result: {
      matchedSources: 1,
      queued: 0,
      skipped: 0,
      failed: 1,
      outcomes: [failedOutcome],
    },
  })
})
