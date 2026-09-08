import { assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import {
  ADMIN_API_PREFIX,
  CLIENT_API_PREFIX,
  CLIENT_WS_PATH,
  DAEMON_API_PREFIX,
  DAEMON_WS_PATH,
  GITHUB_WEBHOOK_PATH,
  GITHUB_WEBHOOK_SCOPED_PATH,
  GITLAB_WEBHOOK_PATH,
  GITLAB_WEBHOOK_SCOPED_PATH,
  STRIPE_WEBHOOK_PATH,
  WEBHOOK_PREFIX,
  DEVELOPER_API_PREFIX,
  DEVELOPER_WS_PATH,
  HEALTH_PATH,
  INSTALL_API_PREFIX,
} from './surfaces.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('versioned API and WebSocket prefixes stay stable', () => {
  assertEquals(HEALTH_PATH, '/api/health')
  assertEquals(CLIENT_API_PREFIX, '/api/client/v1')
  assertEquals(DEVELOPER_API_PREFIX, '/api/developer/v1')
  assertEquals(DAEMON_API_PREFIX, '/api/daemon/v1')
  assertEquals(INSTALL_API_PREFIX, '/api/install/v1')
  assertEquals(ADMIN_API_PREFIX, '/api/admin/v1')
  assertEquals(CLIENT_WS_PATH, '/ws/client/v1')
  assertEquals(DEVELOPER_WS_PATH, '/ws/developer/v1')
  assertEquals(DAEMON_WS_PATH, '/ws/daemon/v1')
})

test('the webhook surface is its own top-level prefix', () => {
  // These are pinned because they are not ours alone to change: the same
  // strings are enumerated in `Caddyfile`, `dev/orchestration/Caddyfile`, and
  // the `routes` patterns in `wrangler.jsonc`. A prefix that drifts out of
  // those lists does not 404 — every front here ends in a catch-all that
  // serves the UI's index.html, so a Git provider would get HTTP 200 and an
  // HTML page, read it as a delivered webhook, and never retry.
  assertEquals(WEBHOOK_PREFIX, '/webhook')
  assertEquals(GITHUB_WEBHOOK_PATH, '/webhook/github')
  assertEquals(GITHUB_WEBHOOK_SCOPED_PATH, '/webhook/github/:ref')
  assertEquals(GITLAB_WEBHOOK_PATH, '/webhook/gitlab')
  assertEquals(GITLAB_WEBHOOK_SCOPED_PATH, '/webhook/gitlab/:ref')
  // Billing shares the prefix. `/webhooks/stripe` (plural) would fall through
  // to the SPA catch-all on every front below; this is the path
  // `stripe listen --forward-to` must use.
  assertEquals(STRIPE_WEBHOOK_PATH, '/webhook/stripe')
})

/**
 * The fronting layers forward `/webhook/*` — so every kind under the prefix
 * inherits the plumbing. Checked, not assumed: the failure mode of a missing
 * matcher is a 200 with an HTML page, which no sender ever retries.
 */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null
    throw err
  }
}

test('every fronting layer forwards the whole /webhook/* prefix', async () => {
  const here = dirname(fromFileUrl(import.meta.url))
  const repo = join(here, '..')
  for (const path of [STRIPE_WEBHOOK_PATH, GITHUB_WEBHOOK_PATH, GITLAB_WEBHOOK_PATH]) {
    assertEquals(path.startsWith(`${WEBHOOK_PREFIX}/`), true)
  }

  const caddy = await Deno.readTextFile(join(repo, 'Caddyfile'))
  assertEquals(caddy.includes(`path ${WEBHOOK_PREFIX}/*`), true, 'Caddyfile forwards /webhook/*')

  // The dev orchestration Caddyfile lives in the sibling `dev` checkout; CI
  // may not have it. When it is there, both listener blocks must forward.
  const devCaddy = await readIfPresent(join(repo, '..', 'dev', 'orchestration', 'Caddyfile'))
  if (devCaddy !== null) {
    const matchers = devCaddy.match(new RegExp(`path ${WEBHOOK_PREFIX}/\\*`, 'g')) ?? []
    assertEquals(matchers.length >= 2, true, 'dev Caddyfile forwards /webhook/* on both listeners')
  }

  // wrangler.jsonc: every `routes` block (testing, live) names the prefix.
  const wrangler = await Deno.readTextFile(join(repo, 'wrangler.jsonc'))
  const routePatterns = wrangler.match(/"pattern":\s*"[^"]*\/webhook\/\*"/g) ?? []
  const routeBlocks = wrangler.match(/"routes":\s*\[/g) ?? []
  assertEquals(routeBlocks.length >= 2, true, 'wrangler.jsonc declares a routes block per env')
  assertEquals(
    routePatterns.length,
    routeBlocks.length,
    'each wrangler routes block forwards /webhook/*',
  )
})
