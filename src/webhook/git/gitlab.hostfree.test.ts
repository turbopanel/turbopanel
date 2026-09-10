/**
 * Route-gate coverage for the GitLab webhook surface.
 *
 * Host-free: the only database work these paths reach before answering is the
 * `gitapp` lookup behind `resolveGitlabWebhookForge`, plus the delivery-claim
 * insert. Dispatch skip/retry paths are exercised with a stub ledger so the
 * adapter's `object_kind` table can be pinned without a live provider.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { DaemonCell } from '../../daemon/cell/contracts.ts'
import type { Db } from '../../db.ts'
import {
  GITLAB_WEBHOOK_PATH,
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
import { hashWebhookToken } from '../../lib/git/forge-records.ts'
import {
  GITLAB_WEBHOOK_MAX_BODY_BYTES,
  registerGitlabWebhookRoutes,
} from './gitlab.ts'
import { registerWebhookRoutes } from '../routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const WEBHOOK_REF = 'ref-under-test'
const WEBHOOK_SECRET = 'gitlab-webhook-secret-ok'
const COMMIT_SHA = 'b'.repeat(40)

function stubAppDb(
  rows: unknown[],
  opts: { claimed?: boolean; installations?: unknown[] } = {},
): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows.slice(0, 1)),
          orderBy: () => Promise.resolve(rows),
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
    enqueue: 'success' | 'fail' | 'throw'
    repository?: { autoDeploy?: string; options?: unknown }
    onRelease?: () => void
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
      where: () => {
        opts.onRelease?.()
        return Promise.resolve(undefined)
      },
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
      if (opts.enqueue === 'throw') throw new Error('injected dispatch crash')
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
  webhookSecret?: string
  appRegistered?: boolean
  rateLimited?: boolean
  claimed?: boolean
  webhookTokenHash?: string
  dispatchReady?: boolean
  graph?: {
    enqueue: 'success' | 'fail' | 'throw'
    repository?: { autoDeploy?: string; options?: unknown }
    onRelease?: () => void
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
    provider: 'gitlab',
    name: 'TurboPanel GitLab',
    baseUrl: 'https://gitlab.com',
    apiUrl: null,
    externalAppId: null,
    appSlug: null,
    clientId: null,
    redirectUri: null,
    webhookRef: WEBHOOK_REF,
    webhookTokenHash: opts.webhookTokenHash ?? null,
    envelopes: {
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
          ...(opts.graph.onRelease === undefined ? {} : { onRelease: opts.graph.onRelease }),
        })
        : stubAppDb(rows, { claimed: opts.claimed }),
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
  registerGitlabWebhookRoutes(app, {
    runtime: 'deno',
    ...(opts.rateLimited === undefined ? {} : {
      rateLimiter: { limit: () => Promise.resolve({ success: !opts.rateLimited }) },
    }),
  })
  return app
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
  return postTo(`${GITLAB_WEBHOOK_PATH}/${WEBHOOK_REF}`, body, headers)
}

function tokenHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'x-gitlab-token': WEBHOOK_SECRET,
    'x-gitlab-event': 'Push Hook',
    'x-gitlab-event-uuid': crypto.randomUUID(),
    ...extra,
  }
}

test('rate limit is spent before any App config read', async () => {
  const app = await buildApp({ rateLimited: true })
  const res = await app.request(post('{}'))
  assertEquals(res.status, 429)
  assertEquals(res.headers.get('Retry-After'), '60')
})

test('a ref naming no registered app is rejected, not accepted', async () => {
  const app = await buildApp({ appRegistered: false })
  const res = await app.request(post('{}', { 'x-gitlab-event': 'Push Hook' }))
  assertEquals(res.status, 401)
})

test('an unconfigured App refuses rather than accepting tokenless deliveries', async () => {
  const app = await buildApp({})
  const res = await app.request(post('{}', { 'x-gitlab-event': 'Push Hook' }))
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'gitlab_webhook_not_configured' })
})

test('a missing or wrong token is 401 before the delivery is claimed', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })

  const missing = await app.request(post('{}', { 'x-gitlab-event': 'Push Hook' }))
  assertEquals(missing.status, 401)

  const wrong = await app.request(post('{}', {
    'x-gitlab-event': 'Push Hook',
    'x-gitlab-token': 'definitely-not-the-secret',
  }))
  assertEquals(wrong.status, 401)
})

test('a tokened delivery missing its event header is a bad request', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })
  const res = await app.request(post('{}', {
    'x-gitlab-token': WEBHOOK_SECRET,
    'x-gitlab-event-uuid': crypto.randomUUID(),
  }))
  assertEquals(res.status, 400)
})

test('an oversized declared body is refused before it is buffered', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })
  const res = await app.request(post('{}', {
    'x-gitlab-token': WEBHOOK_SECRET,
    'x-gitlab-event': 'Push Hook',
    'content-length': String(GITLAB_WEBHOOK_MAX_BODY_BYTES + 1),
  }))
  assertEquals(res.status, 413)
})

test('an oversized body with no Content-Length is refused without buffering the full payload', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })
  const chunkSize = 65_536
  const totalChunks = Math.ceil((GITLAB_WEBHOOK_MAX_BODY_BYTES * 4) / chunkSize)
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
    new Request(`http://instance${GITLAB_WEBHOOK_PATH}/${WEBHOOK_REF}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': WEBHOOK_SECRET,
        'x-gitlab-event': 'Push Hook',
      },
      body,
      duplex: 'half',
      // deno-lint-ignore no-explicit-any
    } as any),
  )
  assertEquals(res.status, 413)
  // GITLAB_WEBHOOK_MAX_BODY_BYTES is 1 MiB; the reader must abort within a
  // handful of 64 KiB chunks past that, nowhere near draining 4x the budget.
  assertEquals(pulls < totalChunks, true)
})

test('the scoped and bare paths both reach the same gate', async () => {
  const tokenHash = await hashWebhookToken(WEBHOOK_SECRET)
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET, webhookTokenHash: tokenHash })

  for (const path of [`${GITLAB_WEBHOOK_PATH}/${WEBHOOK_REF}`, GITLAB_WEBHOOK_PATH]) {
    const res = await app.request(
      postTo(path, '{}', { 'x-gitlab-event': 'Push Hook' }),
    )
    // 401 is the gate rejecting a missing token — which means it ran. A 404
    // would mean the path never reached the handler at all.
    assertEquals(res.status, 401, `expected the gate to run for ${path}`)
  }
})

test('the bare path resolves the app from the presented token digest', async () => {
  const tokenHash = await hashWebhookToken(WEBHOOK_SECRET)
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET, webhookTokenHash: tokenHash })
  const res = await app.request(postTo(GITLAB_WEBHOOK_PATH, JSON.stringify({
    object_kind: 'note',
  }), tokenHeaders({ 'x-gitlab-event': 'Note Hook' })))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
})

test('a tokened push that is not a branch ref is accepted as skipped', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })
  const res = await app.request(post(JSON.stringify({
    object_kind: 'push',
    ref: 'refs/tags/v1',
  }), tokenHeaders()))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
})

test('a tokened branch-delete push is accepted as skipped', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })
  const res = await app.request(post(JSON.stringify({
    object_kind: 'push',
    ref: 'refs/heads/main',
    after: '0'.repeat(40),
    checkout_sha: null,
    project_id: 7,
  }), tokenHeaders()))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
})

test('a tokened push that would deploy asks for a retry when dispatch is down', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })
  const res = await app.request(post(JSON.stringify({
    object_kind: 'push',
    ref: 'refs/heads/main',
    after: COMMIT_SHA,
    checkout_sha: COMMIT_SHA,
    project_id: 7,
  }), tokenHeaders()))
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'retry' })
})

test('a tokened pipeline that is not success is accepted as skipped', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })
  const res = await app.request(post(JSON.stringify({
    object_kind: 'pipeline',
    object_attributes: { status: 'failed', sha: COMMIT_SHA },
    project_id: 7,
  }), tokenHeaders({ 'x-gitlab-event': 'Pipeline Hook' })))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
})

test('a tokened successful pipeline asks for a retry when dispatch is down', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })
  const res = await app.request(post(JSON.stringify({
    object_kind: 'pipeline',
    object_attributes: { status: 'success', sha: COMMIT_SHA },
    project: { id: 7 },
  }), tokenHeaders({ 'x-gitlab-event': 'Pipeline Hook' })))
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'retry' })
})

test('dispatch falls back to the ledger event when object_kind is absent', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })
  const res = await app.request(post('{}', tokenHeaders({
    'x-gitlab-event': 'Job Hook',
  })))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
})

test('a body-digest delivery id is used when GitLab omits the UUID header', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })
  const body = JSON.stringify({ object_kind: 'wiki_page' })
  const res = await app.request(post(body, {
    'x-gitlab-token': WEBHOOK_SECRET,
    'x-gitlab-event': 'Wiki Page Hook',
  }))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
})

test('registerWebhookRoutes mounts both providers on the workers runtime', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', stubAppDb([]))
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerWebhookRoutes(app, { runtime: 'workers' })

  const githubRes = await app.request(new Request('http://instance/webhook/github', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }))
  const gitlabRes = await app.request(new Request('http://instance/webhook/gitlab', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }))
  assertEquals(githubRes.status, 401)
  assertEquals(gitlabRes.status, 401)
})

test('registerWebhookRoutes mounts both providers without per-kind limiters', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', stubAppDb([]))
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerWebhookRoutes(app, { runtime: 'deno' })

  const githubRes = await app.request(new Request('http://instance/webhook/github', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }))
  const gitlabRes = await app.request(new Request('http://instance/webhook/gitlab', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }))
  assertEquals(githubRes.status, 401)
  assertEquals(gitlabRes.status, 401)
})

test('dispatch falls back to a push when object_kind is missing', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })
  const res = await app.request(post(JSON.stringify({
    ref: 'refs/tags/v1',
  }), tokenHeaders({ 'x-gitlab-event': 'push' })))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
})

test('dispatch falls back to a pipeline when object_kind is missing', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })
  const res = await app.request(post(JSON.stringify({
    object_attributes: { status: 'success', sha: COMMIT_SHA },
    project: { id: 7 },
  }), tokenHeaders({ 'x-gitlab-event': 'pipeline' })))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
})

test('an empty event header is a bad request after the token is accepted', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET })
  const res = await app.request(post('{}', {
    'x-gitlab-token': WEBHOOK_SECRET,
    'x-gitlab-event': '   ',
    'x-gitlab-event-uuid': crypto.randomUUID(),
  }))
  assertEquals(res.status, 400)
})

test('a tokened push with dispatch up is accepted when no installation matches', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET, dispatchReady: true })
  const res = await app.request(post(JSON.stringify({
    object_kind: 'push',
    ref: 'refs/heads/main',
    after: COMMIT_SHA,
    checkout_sha: COMMIT_SHA,
    project_id: 7,
  }), tokenHeaders()))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
})

test('a tokened successful pipeline with dispatch up is accepted when no installation matches', async () => {
  const app = await buildApp({ webhookSecret: WEBHOOK_SECRET, dispatchReady: true })
  const res = await app.request(post(JSON.stringify({
    object_kind: 'pipeline',
    object_attributes: { status: 'success', sha: COMMIT_SHA },
    project: { id: 7 },
  }), tokenHeaders({ 'x-gitlab-event': 'Pipeline Hook' })))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
})

test('registerWebhookRoutes mounts both providers and keeps limiter buckets apart', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', stubAppDb([]))
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })

  let githubLimited = 0
  let gitlabLimited = 0
  registerWebhookRoutes(app, {
    runtime: 'deno',
    github: {
      limit: () => {
        githubLimited += 1
        return Promise.resolve({ success: true })
      },
    },
    gitlab: {
      limit: () => {
        gitlabLimited += 1
        return Promise.resolve({ success: true })
      },
    },
  })

  const githubRes = await app.request(new Request('http://instance/webhook/github', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }))
  const gitlabRes = await app.request(new Request('http://instance/webhook/gitlab', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }))
  assertEquals(githubRes.status, 401)
  assertEquals(gitlabRes.status, 401)
  assertEquals(githubLimited, 1)
  assertEquals(gitlabLimited, 1)
})

const parkedChecks = {
  pendingChecks: {
    commitSha: COMMIT_SHA,
    ref: 'refs/heads/main',
    recordedAt: '2026-01-01T00:00:00.000Z',
  },
}

const branchPush = {
  object_kind: 'push',
  ref: 'refs/heads/main',
  after: COMMIT_SHA,
  checkout_sha: COMMIT_SHA,
  project_id: 7,
}

const greenPipeline = {
  object_kind: 'pipeline',
  object_attributes: { status: 'success', sha: COMMIT_SHA, ref: 'main' },
  project: { id: 7 },
}

test('a tokened push with a matched repository enqueues a deploy', async () => {
  const app = await buildApp({
    webhookSecret: WEBHOOK_SECRET,
    graph: { enqueue: 'success' },
  })
  const res = await app.request(post(JSON.stringify(branchPush), tokenHeaders()))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
})

test('a tokened push reports enqueue failure so GitLab redelivers', async () => {
  const app = await buildApp({
    webhookSecret: WEBHOOK_SECRET,
    graph: { enqueue: 'fail' },
  })
  const res = await app.request(post(JSON.stringify(branchPush), tokenHeaders()))
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'retry' })
})

test('a tokened successful pipeline with a parked SHA enqueues a deploy', async () => {
  const app = await buildApp({
    webhookSecret: WEBHOOK_SECRET,
    graph: {
      enqueue: 'success',
      repository: { autoDeploy: 'checks_passed', options: parkedChecks },
    },
  })
  const res = await app.request(post(JSON.stringify(greenPipeline), tokenHeaders({
    'x-gitlab-event': 'Pipeline Hook',
  })))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
})

test('a tokened successful pipeline reports enqueue failure so GitLab redelivers', async () => {
  const app = await buildApp({
    webhookSecret: WEBHOOK_SECRET,
    graph: {
      enqueue: 'fail',
      repository: { autoDeploy: 'checks_passed', options: parkedChecks },
    },
  })
  const res = await app.request(post(JSON.stringify(greenPipeline), tokenHeaders({
    'x-gitlab-event': 'Pipeline Hook',
  })))
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'retry' })
})

test('a dispatch throw after the claim releases it so GitLab can retry', async () => {
  let released = false
  const app = await buildApp({
    webhookSecret: WEBHOOK_SECRET,
    graph: {
      enqueue: 'throw',
      onRelease: () => {
        released = true
      },
    },
  })
  const res = await app.request(post(JSON.stringify(branchPush), tokenHeaders()))
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'retry' })
  assertEquals(released, true)
})
