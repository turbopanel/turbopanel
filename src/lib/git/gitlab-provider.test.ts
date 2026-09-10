import { assertEquals, assertRejects } from '@std/assert'
import { encryptSecret } from '../../client/authn/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../client/authn/secrets.ts'
import type { Db } from '../../db.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { gitConnection } from '../db/schema.ts'
import type { GitProviderContext, GitProviderSourceRow } from './git-provider.ts'
import { GitlabOauthTokenError } from './gitlab-oauth-token.ts'
import {
  GITLAB_OAUTH_HTTPS_USERNAME,
  gitlabProvider,
  gitlabRepositoryExternalId,
  parseGitlabInstallationEvent,
  parseGitlabPipeline,
  parseGitlabPush,
} from './gitlab-provider.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SHA = 'a'.repeat(40)
const NULL_SHA = '0'.repeat(40)

function pushPayload(overrides: Record<string, unknown> = {}) {
  return {
    object_kind: 'push',
    ref: 'refs/heads/main',
    before: 'b'.repeat(40),
    after: SHA,
    checkout_sha: SHA,
    project_id: 15,
    project: { id: 15, path_with_namespace: 'group/app' },
    ...overrides,
  }
}

test('parseGitlabPush reads the branch, head sha, and project', () => {
  assertEquals(parseGitlabPush(pushPayload()), {
    externalInstallationId: null,
    repositoryExternalId: '15',
    ref: 'refs/heads/main',
    branch: 'main',
    commitSha: SHA,
    deleted: false,
  })
})

test('a GitLab push names no connection — every live one is a candidate', () => {
  // GitLab's payload identifies the project, never the OAuth connection the
  // operator registered it under, so the resolver must widen rather than guess.
  assertEquals(parseGitlabPush(pushPayload())?.externalInstallationId, null)
})

test('a branch delete carries no head and is reported as deleted', () => {
  const deleted = parseGitlabPush(
    pushPayload({ after: NULL_SHA, checkout_sha: null }),
  )
  assertEquals(deleted?.deleted, true)
  assertEquals(deleted?.commitSha, null)
})

test('a tag push and a non-branch ref are not push triggers', () => {
  assertEquals(parseGitlabPush(pushPayload({ ref: 'refs/tags/v1' })), null)
  assertEquals(
    parseGitlabPush(pushPayload({ object_kind: 'tag_push' })),
    null,
  )
})

test('a push with no identifiable project is dropped', () => {
  assertEquals(
    parseGitlabPush(pushPayload({ project_id: undefined, project: {} })),
    null,
  )
})

test('parseGitlabPipeline releases only a succeeded pipeline', () => {
  const base = {
    object_kind: 'pipeline',
    project: { id: 15, path_with_namespace: 'group/app' },
  }
  assertEquals(
    parseGitlabPipeline({
      ...base,
      object_attributes: { id: 31, ref: 'main', sha: SHA, status: 'success' },
    }),
    { externalInstallationId: null, repositoryExternalId: '15', commitSha: SHA, ref: 'refs/heads/main' },
  )
  // Anything short of a finished green pipeline is not an all-checks-green
  // signal, which is the whole point of `autoDeploy: 'checks_passed'`.
  for (const status of ['running', 'failed', 'pending', 'canceled']) {
    assertEquals(
      parseGitlabPipeline({
        ...base,
        object_attributes: { sha: SHA, status },
      }),
      null,
    )
  }
})

test('a job hook is never a release signal', () => {
  // One job finishing green says nothing about the rest of the pipeline.
  assertEquals(
    parseGitlabPipeline({
      object_kind: 'build',
      build_status: 'success',
      sha: SHA,
      project: { id: 15 },
    }),
    null,
  )
})

test('gitlabRepositoryExternalId reads either shape GitLab sends', () => {
  assertEquals(gitlabRepositoryExternalId({ project_id: 15 }), '15')
  assertEquals(gitlabRepositoryExternalId({ project: { id: 15 } }), '15')
  assertEquals(gitlabRepositoryExternalId({ project: {} }), null)
})

test('parseGitlabInstallationEvent is always null', () => {
  assertEquals(parseGitlabInstallationEvent({}), null)
})

test('gitlab prepareClone preview and deploy-key lanes', async () => {
  const ctx = { db: null as never }
  const row = {
    id: 'src-1',
    provider: 'gitlab' as const,
    repositoryUrl: 'https://gitlab.com/group/app.git',
    defaultBranch: 'main',
    subdirectory: null,
    connectionId: null,
    secretId: 'cred-1',
  }

  assertEquals(
    await gitlabProvider.prepareClone(ctx, {
      row,
      ref: 'main',
      needsCredential: false,
      requestedCommitSha: SHA,
    }),
    { commit: { commitSha: SHA } },
  )

  assertEquals(
    await gitlabProvider.prepareClone(ctx, {
      row,
      ref: 'main',
      needsCredential: true,
    }),
    { commit: { commitSha: 'main' } },
  )

  assertEquals(
    await gitlabProvider.prepareClone(ctx, {
      row: { ...row, secretId: null },
      ref: 'main',
      needsCredential: true,
    }),
    { failure: 'gitlab source has neither an oauth connection nor a deploy key' },
  )
})

test('gitlab oauth username is the documented basic-auth user', () => {
  assertEquals(GITLAB_OAUTH_HTTPS_USERNAME, 'oauth2')
})

test('gitlab parseCheck is the pipeline hook', () => {
  assertEquals(
    gitlabProvider.parseCheck('Pipeline Hook', {
      object_kind: 'pipeline',
      project: { id: 15 },
      object_attributes: { sha: SHA, status: 'success' },
    }),
    { externalInstallationId: null, repositoryExternalId: '15', commitSha: SHA, ref: null },
  )
  assertEquals(
    gitlabProvider.parseCheck('Pipeline Hook', {
      object_kind: 'pipeline',
      project: { id: 15 },
      object_attributes: { sha: SHA, status: 'success', ref: 'main' },
    }),
    { externalInstallationId: null, repositoryExternalId: '15', commitSha: SHA, ref: 'refs/heads/main' },
  )
})

test('gitlab verifyWebhook compares the shared token', async () => {
  const headers = new Headers({ 'x-gitlab-token': 'shared' })
  assertEquals(await gitlabProvider.verifyWebhook('shared', new Uint8Array(), headers), true)
  assertEquals(await gitlabProvider.verifyWebhook('other', new Uint8Array(), headers), false)
})

const sourceRow: GitProviderSourceRow = {
  id: 'src-1',
  provider: 'gitlab',
  repositoryUrl: 'https://gitlab.com/group/app.git',
  defaultBranch: 'main',
  subdirectory: null,
  connectionId: null,
  secretId: 'cred-1',
}

test('gitlab repository reads are unsupported without an oauth connection', async () => {
  const ctx = { db: null as never }
  assertEquals(
    await gitlabProvider.readRepositoryFiles(ctx, {
      row: sourceRow,
      ref: 'main',
      paths: ['README.md'],
    }),
    { unsupported: true },
  )
  assertEquals(
    await gitlabProvider.listRepositoryEntries(ctx, { row: sourceRow, ref: 'main', path: '' }),
    { unsupported: true },
  )
})

test('gitlab repository reads fail when sealed secrets are unreadable', async () => {
  const ctx = { db: null as never }
  const row = { ...sourceRow, connectionId: 'inst-1' }
  assertEquals(
    await gitlabProvider.readRepositoryFiles(ctx, {
      row,
      ref: 'main',
      paths: ['README.md'],
    }),
    { failure: 'gitlab oauth credentials are unreadable' },
  )
  assertEquals(
    await gitlabProvider.listRepositoryEntries(ctx, { row, ref: 'main', path: '' }),
    { failure: 'gitlab oauth credentials are unreadable' },
  )
})

test('gitlab prepareClone without secrets cannot mint an oauth token', async () => {
  assertEquals(
    await gitlabProvider.prepareClone({ db: null as never }, {
      row: { ...sourceRow, connectionId: 'inst-1' },
      ref: 'main',
      needsCredential: true,
    }),
    { failure: 'gitlab oauth credentials are unreadable' },
  )
})

function withFetch(
  handler: (url: string) => Response | Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    return Promise.resolve(handler(url))
  }) as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

function gitlabDb(opts: {
  app?: Record<string, unknown> | null
  installation?: Record<string, unknown> | null
}): Db {
  const joined = () => ({
    where: () => ({
      limit: () => Promise.resolve(opts.app ? [{ app: opts.app }] : []),
    }),
  })
  return {
    select: () => ({
      from: (table: unknown) => ({
        innerJoin: joined,
        where: () => ({
          limit: () => {
            if (table === gitConnection) {
              return Promise.resolve(opts.installation ? [opts.installation] : [])
            }
            return Promise.resolve([])
          },
        }),
      }),
    }),
  } as unknown as Db
}

async function mintedCtx(): Promise<GitProviderContext> {
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  const access = await encryptSecret(secrets, 'glpat-x')
  return {
    db: gitlabDb({
      app: {
        id: 'app-1',
        organizationId: null,
        provider: 'gitlab',
        name: 'GitLab',
        baseUrl: 'https://gitlab.example.com',
        apiUrl: null,
        externalAppId: '1',
        appSlug: null,
        clientId: 'id',
        redirectUri: null,
        webhookRef: 'ref-1',
        webhookOrigin: null,
        isPublic: true,
        customGitUser: null,
        customGitPort: null,
        syncedAt: null,
        envelopes: {
          clientSecretEnvelope: await encryptSecret(secrets, 'app-secret'),
        },
      },
      installation: {
        provider: 'gitlab',
        suspendedAt: null,
        oauthEnvelope: {
          accessTokenEnvelope: access,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      },
    }),
    dataEncryptionSecrets: secrets,
  }
}

const oauthRow = { ...sourceRow, connectionId: 'inst-1' }

test('gitlab listRepositories mints a token and lists projects', async () => {
  const ctx = await mintedCtx()
  await withFetch((url) => {
    assertEquals(url.includes('/projects?'), true)
    return new Response(
      JSON.stringify([
        { id: 15, path_with_namespace: 'group/app', visibility: 'public' },
      ]),
      { status: 200 },
    )
  }, async () => {
    assertEquals(await gitlabProvider.listRepositories(ctx, 'inst-1'), [{
      id: '15',
      fullName: 'group/app',
      defaultBranch: null,
      private: false,
      cloneUrl: null,
    }])
  })
})

test('gitlab listRepositories requires secrets and a configured app', async () => {
  await assertRejects(
    () => gitlabProvider.listRepositories({ db: null as never }, 'inst-1'),
    GitlabOauthTokenError,
    'gitlab oauth credentials are unreadable',
  )
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  await assertRejects(
    () =>
      gitlabProvider.listRepositories(
        { db: gitlabDb({}), dataEncryptionSecrets: secrets },
        'inst-1',
      ),
    GitlabOauthTokenError,
    'gitlab oauth application is not configured',
  )
})

test('gitlab listRepositoryEntries maps tree entries and 404s', async () => {
  const ctx = await mintedCtx()
  await withFetch((url) => {
    if (url.includes('/repository/commits/')) {
      return new Response(JSON.stringify({ id: SHA }), { status: 200 })
    }
    if (url.includes('/repository/tree')) {
      return new Response(
        JSON.stringify([
          { path: 'src', type: 'tree' },
          { path: 'README.md', type: 'blob' },
          { type: 'blob' },
          null,
        ]),
        { status: 200 },
      )
    }
    throw new TypeError(`unexpected ${url}`)
  }, async () => {
    assertEquals(
      await gitlabProvider.listRepositoryEntries(ctx, {
        row: oauthRow,
        ref: 'main',
        path: 'src',
      }),
      {
        commitSha: SHA,
        entries: [
          { path: 'src', kind: 'dir' },
          { path: 'README.md', kind: 'file' },
        ],
      },
    )
  })

  await withFetch((url) => {
    if (url.includes('/repository/commits/')) {
      return new Response(JSON.stringify({ id: SHA }), { status: 200 })
    }
    return new Response('missing', { status: 404 })
  }, async () => {
    assertEquals(
      await gitlabProvider.listRepositoryEntries(ctx, {
        row: oauthRow,
        ref: 'main',
        path: '',
      }),
      { commitSha: SHA, entries: [] },
    )
  })
})

test('gitlab readRepositoryFiles classifies missing, binary, and oversized files', async () => {
  const ctx = await mintedCtx()
  await withFetch((url) => {
    if (url.includes('/repository/commits/')) {
      return new Response(JSON.stringify({ id: SHA }), { status: 200 })
    }
    if (url.includes('README.md')) {
      return new Response('hello', { status: 200 })
    }
    if (url.includes('missing.txt')) {
      return new Response('nope', { status: 404 })
    }
    if (url.includes('big.txt')) {
      return new Response('0123456789abcdef', { status: 200 })
    }
    if (url.includes('bin.dat')) {
      return new Response(new Uint8Array([0, 1, 2]), { status: 200 })
    }
    throw new TypeError(`unexpected ${url}`)
  }, async () => {
    assertEquals(
      await gitlabProvider.readRepositoryFiles(ctx, {
        row: oauthRow,
        ref: 'main',
        paths: ['README.md', 'missing.txt', 'big.txt', 'bin.dat'],
        maxBytesPerFile: 8,
      }),
      {
        commitSha: SHA,
        files: [
          { path: 'README.md', found: true, content: 'hello', bytes: 5 },
          { path: 'missing.txt', found: false, reason: 'not_found' },
          { path: 'big.txt', found: false, reason: 'too_large' },
          { path: 'bin.dat', found: false, reason: 'binary' },
        ],
      },
    )
  })
})

test('gitlab read auth maps API failures with and without a status', async () => {
  const ctx = await mintedCtx()
  await withFetch(() => new Response('gitlab said no', { status: 401 }), async () => {
    assertEquals(
      await gitlabProvider.listRepositoryEntries(ctx, {
        row: oauthRow,
        ref: 'main',
        path: '',
      }),
      { failure: 'gitlab request failed (401)', status: 401 },
    )
  })

  await withFetch(() => {
    throw new Error('could not reach gitlab')
  }, async () => {
    assertEquals(
      await gitlabProvider.listRepositoryEntries(ctx, {
        row: oauthRow,
        ref: 'main',
        path: '',
      }),
      { failure: 'gitlab request failed: gitlab request failed: could not reach gitlab' },
    )
  })
})

test('gitlab listRepositoryEntries maps a listing failure and a non-array payload', async () => {
  const ctx = await mintedCtx()
  await withFetch((url) => {
    if (url.includes('/repository/commits/')) {
      return new Response(JSON.stringify({ id: SHA }), { status: 200 })
    }
    return new Response('busy', { status: 503 })
  }, async () => {
    assertEquals(
      await gitlabProvider.listRepositoryEntries(ctx, {
        row: oauthRow,
        ref: 'main',
        path: '',
      }),
      { failure: 'gitlab listing failed', status: 503 },
    )
  })

  await withFetch((url) => {
    if (url.includes('/repository/commits/')) {
      return new Response(JSON.stringify({ id: SHA }), { status: 200 })
    }
    return new Response(JSON.stringify({ tree: [] }), { status: 200 })
  }, async () => {
    assertEquals(
      await gitlabProvider.listRepositoryEntries(ctx, {
        row: oauthRow,
        ref: 'main',
        path: '',
      }),
      { commitSha: SHA, entries: [] },
    )
  })
})

test('gitlab read auth maps a missing app and a bad clone url', async () => {
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  assertEquals(
    await gitlabProvider.listRepositoryEntries(
      { db: gitlabDb({}), dataEncryptionSecrets: secrets },
      { row: oauthRow, ref: 'main', path: '' },
    ),
    { failure: 'gitlab oauth application is not configured' },
  )

  const ctx = await mintedCtx()
  assertEquals(
    await gitlabProvider.listRepositoryEntries(ctx, {
      row: { ...oauthRow, repositoryUrl: 'not-a-url' },
      ref: 'main',
      path: '',
    }),
    { failure: 'source repository url is not a gitlab project path' },
  )
})

test('gitlab prepareClone maps a missing app, a bad clone url, and oauth errors', async () => {
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  assertEquals(
    await gitlabProvider.prepareClone(
      { db: gitlabDb({}), dataEncryptionSecrets: secrets },
      { row: oauthRow, ref: 'main', needsCredential: true },
    ),
    { failure: 'gitlab oauth application is not configured' },
  )

  const ctx = await mintedCtx()
  assertEquals(
    await gitlabProvider.prepareClone(ctx, {
      row: { ...oauthRow, repositoryUrl: 'not-a-url' },
      ref: 'main',
      needsCredential: true,
    }),
    { failure: 'source repository url is not a gitlab project path' },
  )

  assertEquals(
    await gitlabProvider.prepareClone(
      {
        db: gitlabDb({
          app: {
            id: 'app-1',
            organizationId: null,
            provider: 'gitlab',
            name: 'GitLab',
            baseUrl: 'https://gitlab.example.com',
            apiUrl: null,
            externalAppId: '1',
            appSlug: null,
            clientId: 'id',
            redirectUri: null,
            webhookRef: 'ref-1',
            webhookOrigin: null,
            isPublic: true,
            customGitUser: null,
            customGitPort: null,
            syncedAt: null,
            envelopes: {},
          },
          installation: null,
        }),
        dataEncryptionSecrets: secrets,
      },
      { row: oauthRow, ref: 'main', needsCredential: true },
    ),
    { failure: 'installation not found', status: 404 },
  )
})

test('gitlab prepareClone mints oauth2 credentials and pins a known sha', async () => {
  const ctx = await mintedCtx()
  await withFetch(() => new Response('nope', { status: 404 }), async () => {
    assertEquals(
      await gitlabProvider.prepareClone(ctx, {
        row: oauthRow,
        ref: 'main',
        needsCredential: true,
        requestedCommitSha: SHA,
      }),
      {
        commit: { commitSha: SHA },
        minted: { secret: 'glpat-x', kind: 'token', username: 'oauth2' },
      },
    )
  })

  await withFetch(
    () =>
      new Response(
        JSON.stringify({ id: SHA, title: 'feat: ship' }),
        { status: 200 },
      ),
    async () => {
      assertEquals(
        await gitlabProvider.prepareClone(ctx, {
          row: oauthRow,
          ref: 'main',
          needsCredential: true,
        }),
        {
          commit: { commitSha: SHA, commitMessage: 'feat: ship' },
          minted: { secret: 'glpat-x', kind: 'token', username: 'oauth2' },
        },
      )
    },
  )
})

test('gitlab readRepositoryFiles maps a non-404 file failure and a tree transport error', async () => {
  const ctx = await mintedCtx()
  await withFetch((url) => {
    if (url.includes('/repository/commits/')) {
      return new Response(JSON.stringify({ id: SHA }), { status: 200 })
    }
    return new Response('denied', { status: 403 })
  }, async () => {
    assertEquals(
      await gitlabProvider.readRepositoryFiles(ctx, {
        row: oauthRow,
        ref: 'main',
        paths: ['README.md'],
      }),
      { failure: 'gitlab file read failed', status: 403 },
    )
  })

  await withFetch((url) => {
    if (url.includes('/repository/commits/')) {
      return new Response(JSON.stringify({ id: SHA }), { status: 200 })
    }
    throw new Error('reset')
  }, async () => {
    assertEquals(
      await gitlabProvider.listRepositoryEntries(ctx, {
        row: oauthRow,
        ref: 'main',
        path: '',
      }),
      { failure: 'gitlab request failed: gitlab request failed: reset' },
    )
  })
})
