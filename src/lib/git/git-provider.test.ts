import { assert, assertEquals } from '@std/assert'
import {
  isGitProviderFailure,
  isGitProviderName,
  normalizeCheckRef,
  resolveGitProvider,
  resolveWebhookGitProvider,
} from './git-provider.ts'
import {
  githubInstallationExternalId,
  githubRepositoryExternalId,
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

test('isGitProviderName accepts only the three known providers', () => {
  assert(isGitProviderName('github'))
  assert(isGitProviderName('gitlab'))
  assert(isGitProviderName('git'))
  assertEquals(isGitProviderName('bitbucket'), false)
  assertEquals(isGitProviderName(undefined), false)
})

test('isGitProviderFailure recognizes provider transport errors', () => {
  assert(isGitProviderFailure({ failure: 'rate limited', status: 429 }))
  assertEquals(isGitProviderFailure({ unsupported: true }), false)
})

test('resolveGitProvider maps known names and degrades unknown ones', () => {
  assertEquals(resolveGitProvider('github').provider, 'github')
  assertEquals(resolveGitProvider('gitlab').provider, 'gitlab')
  assertEquals(resolveGitProvider('git').provider, 'git')
  assertEquals(resolveGitProvider('legacy').provider, 'git')
})

test('resolveWebhookGitProvider returns webhook-capable providers', () => {
  assertEquals(resolveWebhookGitProvider('github').provider, 'github')
  assertEquals(resolveWebhookGitProvider('gitlab').provider, 'gitlab')
})

test('toGithubRepositorySummary narrows a GitHub repository payload', () => {
  assertEquals(
    toGithubRepositorySummary({
      id: 99,
      full_name: 'org/app',
      default_branch: 'main',
      private: true,
      clone_url: 'https://github.com/org/app.git',
    }),
    {
      id: '99',
      fullName: 'org/app',
      defaultBranch: 'main',
      private: true,
      cloneUrl: 'https://github.com/org/app.git',
    },
  )
  assertEquals(toGithubRepositorySummary({ id: 1 }), null)
  assertEquals(toGithubRepositorySummary('nope'), null)
})

test('github external ids accept numeric and string forms', () => {
  assertEquals(githubRepositoryExternalId({ repository: { id: 99 } }), '99')
  assertEquals(githubInstallationExternalId({ installation: { id: 42 } }), '42')
  assertEquals(githubInstallationExternalId({}), null)
})

test('successfulCheckSha honors only all-green suite-level signals', () => {
  const suite = {
    status: 'completed',
    conclusion: 'success',
    head_sha: SHA,
  }
  assertEquals(successfulCheckSha('check_suite', { check_suite: suite }), SHA)
  assertEquals(
    successfulCheckSha('check_run', {
      check_run: {
        status: 'completed',
        conclusion: 'success',
        head_sha: SHA,
        check_suite: suite,
      },
    }),
    SHA,
  )
  assertEquals(
    successfulCheckSha('check_suite', {
      check_suite: { ...suite, conclusion: 'failure' },
    }),
    null,
  )
})

test('github parsePush and parseCheck delegate through the provider registry', () => {
  const github = resolveGitProvider('github')
  const pushSha = 'b'.repeat(40)
  assertEquals(
    github.parsePush({
      ref: 'refs/heads/main',
      after: pushSha,
      installation: { id: 42 },
      repository: { id: 99 },
    }),
    {
      externalInstallationId: '42',
      repositoryExternalId: '99',
      ref: 'refs/heads/main',
      branch: 'main',
      commitSha: pushSha,
      deleted: false,
    },
  )
  assertEquals(
    github.parseCheck('check_suite', {
      installation: { id: 7 },
      repository: { id: 15 },
      check_suite: {
        status: 'completed',
        conclusion: 'success',
        head_sha: SHA,
      },
    }),
    {
      externalInstallationId: '7',
      repositoryExternalId: '15',
      commitSha: SHA,
      ref: null,
    },
  )
})

test('normalizeCheckRef maps branch names onto parked push refs', () => {
  assertEquals(normalizeCheckRef('main'), 'refs/heads/main')
  assertEquals(normalizeCheckRef('refs/heads/main'), 'refs/heads/main')
  assertEquals(normalizeCheckRef('refs/tags/v1'), null)
  assertEquals(normalizeCheckRef(''), null)
  assertEquals(normalizeCheckRef(12), null)
})
