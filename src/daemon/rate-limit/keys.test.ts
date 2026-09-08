import { assertEquals } from '@std/assert'
import {
  DAEMON_ENROLL_CHALLENGE_RATE_LIMIT_ID,
  daemonConnectRateLimitKey,
  daemonEnrollChallengeRateLimitKey,
  daemonMetricsRateLimitKey,
  daemonRestRateLimitKey,
  githubWebhookRateLimitKey,
  gitlabWebhookRateLimitKey,
  stripeWebhookRateLimitKey,
} from './keys.ts'
import {
  createFailClosedRateLimiter,
  createNoopRateLimiter,
} from './contracts.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('daemon rate-limit keys are stable and id-scoped', () => {
  assertEquals(daemonConnectRateLimitKey('srv-1'), 'daemon:connect:srv-1')
  assertEquals(
    daemonRestRateLimitKey('lic-1', 'enroll'),
    'daemon:rest:enroll:lic-1',
  )
  assertEquals(
    daemonRestRateLimitKey('srv-2', 'auth-challenge'),
    'daemon:rest:auth-challenge:srv-2',
  )
  assertEquals(
    daemonRestRateLimitKey('srv-2', 'auth-session'),
    'daemon:rest:auth-session:srv-2',
  )
  assertEquals(
    daemonRestRateLimitKey('srv-2', 'commands-lease'),
    'daemon:rest:commands-lease:srv-2',
  )
  assertEquals(
    daemonRestRateLimitKey('srv-2', 'secrets-decrypt'),
    'daemon:rest:secrets-decrypt:srv-2',
  )
  assertEquals(
    daemonRestRateLimitKey('srv-2', 'secrets-rehydrate'),
    'daemon:rest:secrets-rehydrate:srv-2',
  )
  assertEquals(
    daemonRestRateLimitKey('srv-2', 'commands-log'),
    'daemon:rest:commands-log:srv-2',
  )
  assertEquals(daemonMetricsRateLimitKey('srv-1'), 'daemon:metrics:srv-1')
  assertEquals(
    daemonEnrollChallengeRateLimitKey(),
    `daemon:rest:auth-challenge:${DAEMON_ENROLL_CHALLENGE_RATE_LIMIT_ID}`,
  )
  assertEquals(DAEMON_ENROLL_CHALLENGE_RATE_LIMIT_ID, 'enroll-challenge')
  assertEquals(
    githubWebhookRateLimitKey('203.0.113.10'),
    'git:webhook:github:203.0.113.10',
  )
  assertEquals(githubWebhookRateLimitKey('  '), 'git:webhook:github:unknown')
  assertEquals(
    gitlabWebhookRateLimitKey('203.0.113.11'),
    'git:webhook:gitlab:203.0.113.11',
  )
  assertEquals(gitlabWebhookRateLimitKey(''), 'git:webhook:gitlab:unknown')
})

test('the Stripe webhook key is a billing traffic class with its own bucket', () => {
  // `billing:` rather than `git:` — the git keys are pinned above and by live
  // counters, so a non-git kind gets a new prefix instead of a rename.
  assertEquals(
    stripeWebhookRateLimitKey('203.0.113.12'),
    'billing:webhook:stripe:203.0.113.12',
  )
  assertEquals(stripeWebhookRateLimitKey(' 203.0.113.12 '), 'billing:webhook:stripe:203.0.113.12')
  assertEquals(stripeWebhookRateLimitKey(''), 'billing:webhook:stripe:unknown')
  assertEquals(stripeWebhookRateLimitKey('   '), 'billing:webhook:stripe:unknown')
})

test('noop limiter always allows and fail-closed always denies', async () => {
  assertEquals(
    await createNoopRateLimiter().limit({ key: 'any' }),
    { success: true },
  )
  assertEquals(
    await createFailClosedRateLimiter().limit({ key: 'any' }),
    { success: false },
  )
})
