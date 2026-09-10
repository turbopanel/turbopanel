/**
 * Host-free coverage for the GitHub GitProvider adapter (mock fetch + Db).
 */

import { assertEquals, assertRejects } from '@std/assert'
import { encryptSecret } from '../../client/authn/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../client/authn/secrets.ts'
import type { Db } from '../../db.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { gitConnection } from '../db/schema.ts'
import {
  isGitProviderFailure,
  type GitProviderContext,
  type GitProviderSourceRow,
} from './git-provider.ts'
import { ForgeError } from './forge-records.ts'
import { GITHUB_API_BASE, GithubAppTokenError } from './github-app-token.ts'
import { GITHUB_SIGNATURE_HEADER } from './github-webhook.ts'
import {
  githubInstallationExternalId,
  githubProvider,
  githubRepositoryExternalId,
  listGithubInstallationRepositories,
  fetchPublicGithubDefaultBranch,
  resolveGithubCommit,
  successfulCheckSha,
  toGithubRepositorySummary,
} from './github-provider.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SHA = 'a'.repeat(40)
const encoder = new TextEncoder()

function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    return Promise.resolve(handler(url, init))
  }) as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

async function generatePkcs8Pem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  const bytes = new Uint8Array(pkcs8)
  let binary = ''
  for (const byte of bytes) binary += String.fromCodePoint(byte)
  const body = btoa(binary).replaceAll(/(.{64})/g, '$1\n').trim()
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
}

/** Auth pair for the API helpers that no longer take a bare token. */
const AUTH = { token: 'ghs', apiBase: GITHUB_API_BASE }
const AUTH_LIST = { token: 'ghs_list', apiBase: GITHUB_API_BASE }

function gitApp(envelopes: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'app-1',
    organizationId: null,
    provider: 'github',
    name: 'TurboPanel',
    baseUrl: 'https://github.com',
    apiUrl: null,
    externalAppId: '12345',
    appSlug: null,
    clientId: null,
    redirectUri: null,
    webhookRef: 'ref-1',
    webhookTokenHash: null,
    envelopes,
  }
}

/**
 * The app now arrives through an installation → gitapp join rather than a
 * singleton `setting` row; `innerJoin` is what distinguishes the two reads.
 */
function gitDb(opts: {
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
  const pem = await generatePkcs8Pem()
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  return {
    db: gitDb({
      app: gitApp({ privateKeyEnvelope: await encryptSecret(secrets, pem) }),
      installation: {
        provider: 'github',
        externalInstallationId: '77',
        suspendedAt: null,
      },
    }),
    dataEncryptionSecrets: secrets,
  }
}

const sourceRow: GitProviderSourceRow = {
  id: 'src-1',
  provider: 'github',
  repositoryUrl: 'https://github.com/acme/app.git',
  defaultBranch: 'main',
  subdirectory: null,
  connectionId: 'install-1',
  secretId: null,
}

function repoPayload(id: number, extra: Record<string, unknown> = {}) {
  return { id, full_name: `acme/app-${id}`, default_branch: 'main', private: true, ...extra }
}

test('fetchPublicGithubDefaultBranch reads anonymous REST and ignores non-github URLs', async () => {
  assertEquals(
    await fetchPublicGithubDefaultBranch('https://gitlab.com/acme/app.git'),
    null,
  )
  await withFetch((url) => {
    assertEquals(url.includes('/repos/acme/app'), true)
    return new Response(JSON.stringify({ default_branch: 'trunk' }))
  }, async () => {
    assertEquals(
      await fetchPublicGithubDefaultBranch('https://github.com/acme/app.git'),
      'trunk',
    )
  })
  await withFetch(
    () => new Response('', { status: 404 }),
    async () => {
      assertEquals(
        await fetchPublicGithubDefaultBranch('https://github.com/acme/missing.git'),
        null,
      )
    },
  )
})

test('githubProvider.readRepositoryFiles uses anonymous REST for a public github.com clone', async () => {
  await withFetch((url, init) => {
    const headers = new Headers(init?.headers)
    assertEquals(headers.has('authorization'), false)
    if (url.includes('/commits/')) {
      return new Response(JSON.stringify({ sha: SHA }))
    }
    if (url.includes('/contents/package.json')) {
      return new Response('{"name":"app"}', {
        headers: { 'content-type': 'text/plain' },
      })
    }
    return new Response('', { status: 500 })
  }, async () => {
    const result = await githubProvider.readRepositoryFiles({ db: gitDb({}) }, {
      row: { ...sourceRow, connectionId: null, secretId: null },
      ref: 'trunk',
      paths: ['package.json'],
    })
    if (!result || isGitProviderFailure(result) || 'unsupported' in result) {
      throw new TypeError('expected a file set')
    }
    assertEquals(result.commitSha, SHA)
    assertEquals(result.files[0]?.found, true)
  })
})

test('toGithubRepositorySummary and external-id helpers', () => {
  assertEquals(toGithubRepositorySummary(null), null)
  assertEquals(toGithubRepositorySummary({ full_name: '' }), null)
  assertEquals(
    toGithubRepositorySummary({
      id: 15,
      full_name: 'acme/app',
      default_branch: 'trunk',
      private: true,
      clone_url: 'https://github.com/acme/app.git',
    }),
    {
      id: '15',
      fullName: 'acme/app',
      defaultBranch: 'trunk',
      private: true,
      cloneUrl: 'https://github.com/acme/app.git',
    },
  )
  assertEquals(toGithubRepositorySummary({ id: ' 9 ', full_name: 'acme/x' })?.id, '9')
  assertEquals(githubRepositoryExternalId({ repository: { id: 42 } }), '42')
  assertEquals(githubRepositoryExternalId({ repository: {} }), null)
  assertEquals(githubInstallationExternalId({ installation: { id: ' 8 ' } }), '8')
  assertEquals(githubInstallationExternalId({}), null)
})

test('listGithubInstallationRepositories paginates and skips junk rows', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => repoPayload(i + 1))
  await withFetch((url) => {
    const page = new URL(url).searchParams.get('page')
    if (page === '1') {
      return new Response(JSON.stringify({ repositories: [...page1, { nope: true }] }))
    }
    return new Response(JSON.stringify({
      repositories: [repoPayload(101, { clone_url: 'https://github.com/acme/last.git' })],
    }))
  }, async () => {
    const repos = await listGithubInstallationRepositories(AUTH_LIST)
    assertEquals(repos.length, 101)
    assertEquals(repos[0]?.fullName, 'acme/app-1')
    assertEquals(repos[100]?.id, '101')
  })
})

test('listGithubInstallationRepositories throws on a non-OK listing', async () => {
  await withFetch(
    () => new Response('', { status: 403 }),
    async () => {
      const error = await assertRejects(
        () => listGithubInstallationRepositories(AUTH_LIST),
        GithubAppTokenError,
        'github repository listing failed (403)',
      )
      if (!(error instanceof GithubAppTokenError)) {
        throw new TypeError('expected GithubAppTokenError')
      }
      assertEquals(error.status, 403)
    },
  )
})

test('resolveGithubCommit returns sha, subject, and author', async () => {
  await withFetch((url) => {
    assertEquals(
      url,
      `${GITHUB_API_BASE}/repos/acme/app/commits/${SHA}`,
    )
    return new Response(JSON.stringify({
      sha: SHA,
      commit: { message: 'fix: deploy\n\nbody', author: { name: 'Ada' } },
    }))
  }, async () => {
    assertEquals(
      await resolveGithubCommit(AUTH, 'https://github.com/acme/app.git', SHA),
      { commitSha: SHA, commitMessage: 'fix: deploy', commitAuthor: 'Ada' },
    )
  })
})

test('resolveGithubCommit maps URL, network, HTTP, and empty-sha failures', async () => {
  await assertRejects(
    () => resolveGithubCommit(AUTH, 'https://github.com/only-one-segment', 'main'),
    GithubAppTokenError,
    'not a github repository path',
  )
  await withFetch(
    () => {
      throw new Error('reset')
    },
    async () => {
      await assertRejects(
        () => resolveGithubCommit(AUTH, 'https://github.com/acme/app.git', 'main'),
        GithubAppTokenError,
        'reset',
      )
    },
  )
  await withFetch(
    () => new Response('', { status: 404 }),
    async () => {
      await assertRejects(
        () => resolveGithubCommit(AUTH, 'https://github.com/acme/app.git', 'main'),
        GithubAppTokenError,
        'github commit lookup failed (404)',
      )
    },
  )
  await withFetch(
    () => new Response(JSON.stringify({}), { status: 200 }),
    async () => {
      await assertRejects(
        () => resolveGithubCommit(AUTH, 'https://github.com/acme/app.git', 'main'),
        GithubAppTokenError,
        'returned no sha',
      )
    },
  )
})

test('resolveGithubCommit rejects an unsafe ref before any request', async () => {
  for (const ref of ['../main', '/main', 'main?x=1', 'main other', '']) {
    await withFetch(
      () => {
        throw new Error('fetch must not be reached for an unsafe ref')
      },
      async () => {
        await assertRejects(
          () => resolveGithubCommit(AUTH, 'https://github.com/acme/app.git', ref),
          GithubAppTokenError,
          'source ref is not a valid git ref',
        )
      },
    )
  }
})

test('successfulCheckSha only honors a fully green suite', () => {
  assertEquals(
    successfulCheckSha('check_suite', {
      check_suite: { status: 'completed', conclusion: 'success', head_sha: SHA },
    }),
    SHA,
  )
  assertEquals(
    successfulCheckSha('check_run', {
      check_run: {
        status: 'completed',
        conclusion: 'success',
        check_suite: { status: 'completed', conclusion: 'success', head_sha: SHA },
      },
    }),
    SHA,
  )
  assertEquals(
    successfulCheckSha('check_run', {
      check_run: {
        status: 'completed',
        conclusion: 'success',
        head_sha: SHA,
        check_suite: { status: 'in_progress', conclusion: null },
      },
    }),
    null,
  )
  assertEquals(successfulCheckSha('push', {}), null)
})

test('githubProvider.parsePush and parseCheck', () => {
  assertEquals(
    githubProvider.parsePush({
      ref: 'refs/heads/main',
      after: SHA,
      installation: { id: 9 },
      repository: { id: 15 },
    }),
    {
      externalInstallationId: '9',
      repositoryExternalId: '15',
      ref: 'refs/heads/main',
      branch: 'main',
      commitSha: SHA,
      deleted: false,
    },
  )
  assertEquals(
    githubProvider.parsePush({
      ref: 'refs/heads/main',
      after: '0'.repeat(40),
      deleted: true,
      installation: { id: 9 },
      repository: { id: 15 },
    })?.deleted,
    true,
  )
  assertEquals(githubProvider.parsePush({ ref: 'refs/tags/v1' }), null)
  assertEquals(
    githubProvider.parseCheck('check_suite', {
      check_suite: { status: 'completed', conclusion: 'success', head_sha: SHA },
      installation: { id: 9 },
      repository: { id: 15 },
    }),
    { externalInstallationId: '9', repositoryExternalId: '15', commitSha: SHA, ref: null },
  )
  assertEquals(
    githubProvider.parseCheck('check_suite', {
      check_suite: {
        status: 'completed',
        conclusion: 'success',
        head_sha: SHA,
        head_branch: 'main',
      },
      installation: { id: 9 },
      repository: { id: 15 },
    }),
    { externalInstallationId: '9', repositoryExternalId: '15', commitSha: SHA, ref: 'refs/heads/main' },
  )
  assertEquals(
    githubProvider.parseCheck('check_run', {
      check_run: {
        status: 'completed',
        conclusion: 'success',
        head_sha: SHA,
        check_suite: {
          status: 'completed',
          conclusion: 'success',
          head_sha: SHA,
          head_branch: 'feature/x',
        },
      },
      installation: { id: 9 },
      repository: { id: 15 },
    }),
    {
      externalInstallationId: '9',
      repositoryExternalId: '15',
      commitSha: SHA,
      ref: 'refs/heads/feature/x',
    },
  )
  assertEquals(githubProvider.parseCheck('check_suite', { check_suite: {} }), null)
})

test('githubProvider.listRepositories mints a token and lists installation repos', async () => {
  const ctx = await mintedCtx()
  await withFetch((url) => {
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'ghs_list_provider', expires_at: '2031-01-01T00:00:00Z' }))
    }
    if (url.includes('/installation/repositories')) {
      return new Response(JSON.stringify({
        repositories: [repoPayload(7, { full_name: 'acme/widget', clone_url: null })],
      }))
    }
    return new Response('', { status: 500 })
  }, async () => {
    const repos = await githubProvider.listRepositories(ctx, 'install-1')
    assertEquals(repos, [{
      id: '7',
      fullName: 'acme/widget',
      defaultBranch: 'main',
      private: true,
      cloneUrl: null,
    }])
  })
})

test('githubProvider.listRepositories and prepareClone gate credentials', async () => {
  const db = gitDb({})
  await assertRejects(
    () => githubProvider.listRepositories({ db }, 'install-1'),
    GithubAppTokenError,
    'github app credentials are unreadable',
  )
  assertEquals(
    await githubProvider.prepareClone({ db }, {
      row: sourceRow,
      ref: 'main',
      needsCredential: false,
      requestedCommitSha: SHA,
    }),
    { commit: { commitSha: SHA } },
  )
  assertEquals(
    await githubProvider.prepareClone({ db }, {
      row: { ...sourceRow, connectionId: null },
      ref: 'main',
      needsCredential: true,
    }),
    { failure: 'github source has no app installation' },
  )
  assertEquals(
    await githubProvider.prepareClone({ db }, {
      row: sourceRow,
      ref: 'main',
      needsCredential: true,
    }),
    { failure: 'github app credentials are unreadable' },
  )
})

test('githubProvider.prepareClone resolves a ref when no pinned sha is supplied', async () => {
  const ctx = await mintedCtx()
  await withFetch((url) => {
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'ghs_ref', expires_at: '2031-01-01T00:00:00Z' }))
    }
    if (url.includes('/commits/main')) {
      return new Response(JSON.stringify({
        sha: SHA,
        commit: { message: 'feat: ship', author: { name: 'Bot' } },
      }))
    }
    return new Response('', { status: 500 })
  }, async () => {
    const prepared = await githubProvider.prepareClone(ctx, {
      row: sourceRow,
      ref: 'main',
      needsCredential: true,
    })
    assertEquals(prepared, {
      commit: { commitSha: SHA, commitMessage: 'feat: ship', commitAuthor: 'Bot' },
      minted: { secret: 'ghs_ref', kind: 'token' },
    })
  })
})

test('githubProvider.prepareClone mints a token and degrades a decorative lookup', async () => {
  const ctx = await mintedCtx()
  await withFetch((url) => {
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'ghs_clone', expires_at: '2031-01-01T00:00:00Z' }))
    }
    return new Response('', { status: 502 })
  }, async () => {
    const prepared = await githubProvider.prepareClone(ctx, {
      row: sourceRow,
      ref: 'main',
      needsCredential: true,
      requestedCommitSha: SHA,
    })
    assertEquals(prepared, {
      commit: { commitSha: SHA },
      minted: { secret: 'ghs_clone', kind: 'token' },
    })
  })
})

test('githubProvider.prepareClone maps a mint failure and rethrows config errors', async () => {
  const ctx = await mintedCtx()
  await withFetch(
    () => new Response(JSON.stringify({ message: 'suspended' }), { status: 403 }),
    async () => {
      assertEquals(
        await githubProvider.prepareClone(ctx, {
          row: sourceRow,
          ref: 'main',
          needsCredential: true,
        }),
        { failure: 'github request failed (403): suspended', status: 403 },
      )
    },
  )

  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  const unsealed = {
    db: gitDb({
      app: gitApp({ privateKeyEnvelope: 'not-a-tpsecret' }),
      installation: {
        provider: 'github',
        externalInstallationId: '1',
        suspendedAt: null,
      },
    }),
    dataEncryptionSecrets: secrets,
  }
  await assertRejects(
    () =>
      githubProvider.prepareClone(unsealed, {
        row: sourceRow,
        ref: 'main',
        needsCredential: true,
      }),
    ForgeError,
    'git app private key is not sealed',
  )
})

test('githubProvider.readRepositoryFiles returns a pinned file set', async () => {
  const ctx = await mintedCtx()
  await withFetch((url) => {
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'ghs_read' }))
    }
    if (url.includes('/commits/')) {
      return new Response(JSON.stringify({ sha: SHA }))
    }
    if (url.includes('/contents/compose.yaml')) {
      return new Response('services: {}\n', {
        headers: { 'content-type': 'text/plain' },
      })
    }
    if (url.includes('/contents/missing.yml')) {
      return new Response('', { status: 404 })
    }
    return new Response('', { status: 500 })
  }, async () => {
    const result = await githubProvider.readRepositoryFiles(ctx, {
      row: sourceRow,
      ref: 'main',
      paths: ['compose.yaml', 'missing.yml'],
    })
    if (!result || isGitProviderFailure(result) || 'unsupported' in result) {
      throw new TypeError('expected a file set')
    }
    assertEquals(result.commitSha, SHA)
    assertEquals(result.files[0], {
      path: 'compose.yaml',
      found: true,
      content: 'services: {}\n',
      bytes: encoder.encode('services: {}\n').byteLength,
    })
    assertEquals(result.files[1], {
      path: 'missing.yml',
      found: false,
      reason: 'not_found',
    })
  })
})

test('githubProvider.readRepositoryFiles aborts on transport failure', async () => {
  const ctx = await mintedCtx()

  await withFetch((url) => {
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'ghs_read' }))
    }
    if (url.includes('/commits/')) {
      return new Response('', { status: 502 })
    }
    return new Response('', { status: 500 })
  }, async () => {
    const commitFail = await githubProvider.readRepositoryFiles(ctx, {
      row: sourceRow,
      ref: 'main',
      paths: ['compose.yaml'],
    })
    if (!commitFail || !isGitProviderFailure(commitFail)) {
      throw new TypeError('expected a provider failure')
    }
    assertEquals(commitFail.failure.includes('github commit lookup failed (502)'), true)
  })

  await withFetch((url) => {
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'ghs_read' }))
    }
    if (url.includes('/commits/')) {
      return new Response(JSON.stringify({ sha: SHA }))
    }
    return new Response('', { status: 503 })
  }, async () => {
    const fileFail = await githubProvider.readRepositoryFiles(ctx, {
      row: sourceRow,
      ref: 'main',
      paths: ['compose.yaml'],
    })
    assertEquals(fileFail, { failure: 'github file read failed', status: 503 })
  })
})

test('githubProvider.readRepositoryFiles reports miss reasons and auth gaps', async () => {
  assertEquals(
    await githubProvider.readRepositoryFiles({ db: gitDb({}) }, {
      row: { ...sourceRow, connectionId: null, secretId: 'key-1' },
      ref: 'main',
      paths: ['compose.yaml'],
    }),
    { unsupported: true },
  )
  assertEquals(
    await githubProvider.readRepositoryFiles({ db: gitDb({}) }, {
      row: sourceRow,
      ref: 'main',
      paths: ['compose.yaml'],
    }),
    { failure: 'github app credentials are unreadable' },
  )

  const ctx = await mintedCtx()
  await withFetch((url) => {
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'ghs_read' }))
    }
    if (url.includes('/commits/')) {
      return new Response(JSON.stringify({ sha: SHA }))
    }
    if (url.includes('/contents/dir')) {
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    if (url.includes('/contents/huge')) {
      return new Response('x'.repeat(32), { headers: { 'content-type': 'text/plain' } })
    }
    if (url.includes('/contents/bin')) {
      return new Response(new Uint8Array([0x00, 0x01]), {
        headers: { 'content-type': 'application/octet-stream' },
      })
    }
    return new Response('', { status: 500 })
  }, async () => {
    const dir = await githubProvider.readRepositoryFiles(ctx, {
      row: sourceRow,
      ref: 'main',
      paths: ['dir'],
    })
    if (!dir || isGitProviderFailure(dir) || 'unsupported' in dir) {
      throw new TypeError('expected a file set')
    }
    assertEquals(dir.files[0], { path: 'dir', found: false, reason: 'not_a_file' })

    const huge = await githubProvider.readRepositoryFiles(ctx, {
      row: sourceRow,
      ref: 'main',
      paths: ['huge'],
      maxBytesPerFile: 8,
    })
    if (!huge || isGitProviderFailure(huge) || 'unsupported' in huge) {
      throw new TypeError('expected a file set')
    }
    assertEquals(huge.files[0], { path: 'huge', found: false, reason: 'too_large' })

    const bin = await githubProvider.readRepositoryFiles(ctx, {
      row: sourceRow,
      ref: 'main',
      paths: ['bin'],
    })
    if (!bin || isGitProviderFailure(bin) || 'unsupported' in bin) {
      throw new TypeError('expected a file set')
    }
    assertEquals(bin.files[0], { path: 'bin', found: false, reason: 'binary' })
  })
})

test('githubProvider.listRepositoryEntries lists files and treats 404 as empty', async () => {
  const ctx = await mintedCtx()
  await withFetch((url) => {
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'ghs_ls' }))
    }
    if (url.includes('/commits/')) {
      return new Response(JSON.stringify({ sha: SHA }))
    }
    if (url.includes('/contents/missing')) {
      return new Response('', { status: 404 })
    }
    if (url.includes('/contents/src')) {
      return new Response(JSON.stringify([
        { path: 'src/a.ts', type: 'file', size: 12 },
        { path: 'src/lib', type: 'dir' },
        { nope: true },
      ]))
    }
    return new Response('', { status: 500 })
  }, async () => {
    const listed = await githubProvider.listRepositoryEntries(ctx, {
      row: sourceRow,
      ref: 'main',
      path: 'src',
    })
    if (!listed || isGitProviderFailure(listed) || 'unsupported' in listed) {
      throw new TypeError('expected a listing')
    }
    assertEquals(listed.commitSha, SHA)
    assertEquals(listed.entries, [
      { path: 'src/a.ts', kind: 'file', bytes: 12 },
      { path: 'src/lib', kind: 'dir' },
    ])

    const missing = await githubProvider.listRepositoryEntries(ctx, {
      row: sourceRow,
      ref: 'main',
      path: 'missing',
    })
    assertEquals(missing, { commitSha: SHA, entries: [] })
  })
})

test('githubProvider.listRepositoryEntries rejects a non-github repository url', async () => {
  const ctx = await mintedCtx()
  await withFetch((url) => {
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'ghs_ls' }))
    }
    return new Response('', { status: 500 })
  }, async () => {
    const result = await githubProvider.listRepositoryEntries(ctx, {
      row: { ...sourceRow, repositoryUrl: 'https://github.com/only-one-segment' },
      ref: 'main',
      path: 'src',
    })
    if (!result || !isGitProviderFailure(result)) {
      throw new TypeError('expected a provider failure')
    }
    assertEquals(
      result.failure,
      'github request failed: source repository url is not a github repository path',
    )
  })
})

test('githubProvider.listRepositoryEntries rejects an unsafe path before any request', async () => {
  const ctx = await mintedCtx()
  for (const path of ['../secrets', '/etc', 'src?ref=other', 'src other']) {
    const seen: string[] = []
    await withFetch((url) => {
      seen.push(url)
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_ls' }))
      }
      throw new Error('fetch must not be reached for an unsafe path')
    }, async () => {
      assertEquals(
        await githubProvider.listRepositoryEntries(ctx, {
          row: sourceRow,
          ref: 'main',
          path,
        }),
        { failure: 'listing path is not a valid repository path' },
      )
    })
    // Only the token mint may have happened — no commit lookup, no listing.
    assertEquals(seen.filter((url) => !url.includes('/access_tokens')), [])
  }
})

test('githubProvider.listRepositoryEntries maps HTTP and network failures', async () => {
  const ctx = await mintedCtx()
  await withFetch((url) => {
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'ghs_ls' }))
    }
    if (url.includes('/commits/')) {
      return new Response(JSON.stringify({ sha: SHA }))
    }
    return new Response('', { status: 500 })
  }, async () => {
    assertEquals(
      await githubProvider.listRepositoryEntries(ctx, {
        row: sourceRow,
        ref: 'main',
        path: 'src',
      }),
      { failure: 'github listing failed', status: 500 },
    )
  })

  await withFetch((url) => {
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'ghs_ls' }))
    }
    if (url.includes('/commits/')) {
      return new Response(JSON.stringify({ sha: SHA }))
    }
    throw new Error('unreachable')
  }, async () => {
    assertEquals(
      await githubProvider.listRepositoryEntries(ctx, {
        row: sourceRow,
        ref: 'main',
        path: 'src',
      }),
      { failure: 'github request failed: unreachable' },
    )
  })
})

test('githubProvider.verifyWebhook delegates to the GitHub MAC', async () => {
  const body = encoder.encode('{"ok":true}')
  assertEquals(
    await githubProvider.verifyWebhook(null, body, { get: () => 'sha256=ab' }),
    false,
  )
  assertEquals(
    GITHUB_SIGNATURE_HEADER,
    'x-hub-signature-256',
  )
})
