import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../client/authn/secrets.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'
import {
  defaultSystemGitRunner,
  describeUnknownError,
  dirtyUpgradeError,
  getUiRepoPath,
  isRuntimePorcelainLine,
  porcelainPath,
  registerSystemRoutes,
  resetSystemRoutesUpgradeLockForTests,
  resolveGitInvocation,
  setSystemRoutesTestHooks,
  type SystemGitRunner,
} from './system-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('porcelainPath reads the path and rename target', () => {
  assertEquals(porcelainPath(' M src/app.ts'), 'src/app.ts')
  assertEquals(porcelainPath('R  old.ts -> new.ts'), 'new.ts')
})

test('isRuntimePorcelainLine ignores checkout-local runtime trees', () => {
  assertEquals(isRuntimePorcelainLine('?? .local/console.log'), true)
  assertEquals(isRuntimePorcelainLine('?? .config/pnpm/store'), true)
  assertEquals(isRuntimePorcelainLine('?? .cache/deno'), true)
  assertEquals(isRuntimePorcelainLine(' M src/developer/routes.ts'), false)
})

test('dirtyUpgradeError names every dirty checkout', () => {
  assertEquals(
    dirtyUpgradeError([
      { repo: 'instance', path: '/tmp/instance', changes: 2 },
      { repo: 'daemon', path: '/tmp/daemon', changes: 1 },
    ]),
    'cannot upgrade: uncommitted changes in instance, daemon (commit or stash first)',
  )
})

test('registerSystemRoutes mounts upgrade-status without auth when disabled', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  await withSystemRouteEnv({ TURBOPANEL_DEV_USER: 'dev' }, async () => {
    setSystemRoutesTestHooks({ gitRunner: scriptedGitRunner({}) })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/system/upgrade-status`,
    )
    assertEquals(response.status, 200)
  })
})

test('porcelainPath trims a rename target with extra spaces', () => {
  assertEquals(porcelainPath('R  old.ts ->  new.ts  '), 'new.ts')
})

test('isRuntimePorcelainLine matches a rename into a runtime tree', () => {
  assertEquals(isRuntimePorcelainLine('R  tmp.log -> .local/console.log'), true)
  assertEquals(isRuntimePorcelainLine('?? src/.local-not-runtime.ts'), false)
})

test('registerSystemRoutes requires developer auth by default', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  const app = new Hono()
  registerSystemRoutes(app, { secrets })
  const response = await app.request(
    `${DEVELOPER_API_PREFIX}/system/upgrade-status`,
  )
  assertEquals(response.status, 401)
})

test('POST /system/upgrade is refused when dirty, git fails, or restart is unset', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  await withSystemRouteEnv({ TURBOPANEL_INSTANCE_SERVICE: undefined }, async () => {
    setSystemRoutesTestHooks({ gitRunner: scriptedGitRunner({}) })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const response = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade`, {
      method: 'POST',
    })
    assertEquals(response.status, 503)
    const body = await response.json()
    if (typeof body !== 'object' || body === null || !('ok' in body)) {
      throw new TypeError('upgrade response must be an object with ok')
    }
    assertEquals(body.ok, false)
  })
})

test('GET /system/upgrade-status reports canUpgrade or a git error', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  await withSystemRouteEnv({ TURBOPANEL_DEV_USER: 'dev' }, async () => {
    setSystemRoutesTestHooks({ gitRunner: scriptedGitRunner({}) })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/system/upgrade-status`,
    )
    const body = await response.json()
    if (typeof body !== 'object' || body === null || !('ok' in body)) {
      throw new TypeError('upgrade-status response must be an object with ok')
    }
    assertEquals(response.status, 200)
    assertEquals(body.ok, true)
    if (!('canUpgrade' in body) || !('dirty' in body)) {
      throw new TypeError('successful upgrade-status must include canUpgrade and dirty')
    }
    assertEquals(typeof body.canUpgrade, 'boolean')
    assertEquals(Array.isArray(body.dirty), true)
  })
})

test('GET /system/upgrade-status fails when TURBOPANEL_UI_REPO is not a checkout', async () => {
  await withSystemRouteEnv({
    TURBOPANEL_DEV_USER: 'dev',
    TURBOPANEL_UI_REPO: '/tmp/turbopanel-missing-ui-checkout',
  }, async () => {
    setSystemRoutesTestHooks({ gitRunner: null })
    const secrets = await deriveSecretsConfig(
      parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
      'session-signing',
    )
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/system/upgrade-status`,
    )
    assertEquals(response.status, 500)
    const body = await response.json()
    if (typeof body !== 'object' || body === null || !('ok' in body) || !('error' in body)) {
      throw new TypeError('failed upgrade-status must include ok and error')
    }
    assertEquals(body.ok, false)
    assertEquals(typeof body.error, 'string')
  })
})

test('porcelainPath keeps a path that is not a rename', () => {
  assertEquals(porcelainPath('?? path with spaces.ts'), 'path with spaces.ts')
  assertEquals(porcelainPath('D  gone.ts'), 'gone.ts')
})

test('isRuntimePorcelainLine matches every runtime prefix', () => {
  assertEquals(isRuntimePorcelainLine('?? .config/foo'), true)
  assertEquals(isRuntimePorcelainLine('?? .cache/bar'), true)
  assertEquals(isRuntimePorcelainLine(' M .local/nested/x'), true)
})

test('resolveGitInvocation runs git directly or via sudo -u', () => {
  assertEquals(
    resolveGitInvocation('/repo', ['status', '--porcelain'], {
      direct: true,
      productionGitUser: 'tp',
    }),
    { bin: 'git', args: ['-C', '/repo', 'status', '--porcelain'] },
  )
  assertEquals(
    resolveGitInvocation('/repo', ['fetch', 'origin', 'trunk'], {
      direct: false,
      productionGitUser: 'tp',
    }),
    {
      bin: 'sudo',
      args: ['-u', 'tp', 'git', '-C', '/repo', 'fetch', 'origin', 'trunk'],
    },
  )
})

test('describeUnknownError reads Error.message and stringifies other values', () => {
  assertEquals(describeUnknownError(new Error('boom')), 'boom')
  assertEquals(describeUnknownError('nope'), 'nope')
})

test('getUiRepoPath prefers TURBOPANEL_UI_REPO and otherwise sits beside the instance checkout', () => {
  const previous = Deno.env.get('TURBOPANEL_UI_REPO')
  try {
    Deno.env.set('TURBOPANEL_UI_REPO', '/tmp/custom-ui')
    assertEquals(getUiRepoPath(), '/tmp/custom-ui')
    Deno.env.delete('TURBOPANEL_UI_REPO')
    const fallback = getUiRepoPath()
    assertEquals(fallback.endsWith('/ui'), true)
  } finally {
    if (previous === undefined) Deno.env.delete('TURBOPANEL_UI_REPO')
    else Deno.env.set('TURBOPANEL_UI_REPO', previous)
  }
})

function gitVerb(args: string[]): string {
  const dashC = args.indexOf('-C')
  if (dashC >= 0) return args[dashC + 2] ?? ''
  return args[0] ?? ''
}

function scriptedGitRunner(opts: {
  statusStdout?: string
  statusSuccess?: boolean
  statusStderr?: string
  fetchSuccess?: boolean
  resetSuccess?: boolean
  hangFetch?: { promise: Promise<void> }
}): SystemGitRunner {
  return (_bin, args) => {
    const verb = gitVerb(args)
    if (verb === 'status') {
      return Promise.resolve({
        success: opts.statusSuccess ?? true,
        stdout: opts.statusStdout ?? '',
        stderr: opts.statusStderr ?? '',
      })
    }
    if (verb === 'fetch') {
      if (opts.hangFetch) {
        return opts.hangFetch.promise.then(() => ({
          success: opts.fetchSuccess ?? true,
          stdout: '',
          stderr: '',
        }))
      }
      return Promise.resolve({
        success: opts.fetchSuccess ?? true,
        stdout: '',
        stderr: opts.fetchSuccess === false ? 'fetch denied' : '',
      })
    }
    if (verb === 'reset') {
      return Promise.resolve({
        success: opts.resetSuccess ?? true,
        stdout: '',
        stderr: opts.resetSuccess === false ? 'reset denied' : '',
      })
    }
    return Promise.resolve({ success: true, stdout: '', stderr: '' })
  }
}

async function withSystemRouteEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const key of Object.keys(env)) previous.set(key, Deno.env.get(key))
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
    return await fn()
  } finally {
    resetSystemRoutesUpgradeLockForTests()
    setSystemRoutesTestHooks({ gitRunner: null, restarter: null })
    for (const [key, value] of previous.entries()) {
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
  }
}

test('GET /system/upgrade-status reports dirty checkouts and git status failures', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  await withSystemRouteEnv({ TURBOPANEL_DEV_USER: 'dev' }, async () => {
    setSystemRoutesTestHooks({
      gitRunner: scriptedGitRunner({ statusStdout: ' M src/app.ts\n' }),
    })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const dirty = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade-status`)
    assertEquals(dirty.status, 200)
    const dirtyBody = await dirty.json() as {
      ok: boolean
      canUpgrade: boolean
      dirty: Array<{ repo: string; changes: number }>
    }
    assertEquals(dirtyBody.ok, true)
    assertEquals(dirtyBody.canUpgrade, false)
    assertEquals(dirtyBody.dirty.length > 0, true)
    assertEquals(dirtyBody.dirty[0]?.changes, 1)
  })

  await withSystemRouteEnv({}, async () => {
    setSystemRoutesTestHooks({
      gitRunner: scriptedGitRunner({ statusSuccess: false, statusStderr: '' }),
    })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const failed = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade-status`)
    assertEquals(failed.status, 500)
    const body = await failed.json() as { ok: boolean; error: string }
    assertEquals(body.ok, false)
    assertEquals(body.error.includes('git status failed'), true)
  })
})

test('POST /system/upgrade refuses dirty trees, a missing service, and in-flight upgrades', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  await withSystemRouteEnv({ TURBOPANEL_INSTANCE_SERVICE: undefined }, async () => {
    setSystemRoutesTestHooks({
      gitRunner: scriptedGitRunner({ statusStdout: ' M src/app.ts\n' }),
    })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const dirty = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade`, {
      method: 'POST',
    })
    assertEquals(dirty.status, 409)
    const body = await dirty.json() as { ok: boolean; dirty: unknown[] }
    assertEquals(body.ok, false)
    assertEquals(Array.isArray(body.dirty), true)
  })

  await withSystemRouteEnv({ TURBOPANEL_INSTANCE_SERVICE: undefined }, async () => {
    setSystemRoutesTestHooks({ gitRunner: scriptedGitRunner({}) })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const missing = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade`, {
      method: 'POST',
    })
    assertEquals(missing.status, 503)
  })

  await withSystemRouteEnv({ TURBOPANEL_INSTANCE_SERVICE: 'turbopanel-instance' }, async () => {
    let releaseFetch: (() => void) | undefined
    const hang = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    let fetchStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve
    })
    setSystemRoutesTestHooks({
      gitRunner: async (bin, args) => {
        if (gitVerb(args) === 'fetch') fetchStarted?.()
        return await scriptedGitRunner({ hangFetch: { promise: hang } })(bin, args)
      },
      restarter: () => {},
    })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const first = app.request(`${DEVELOPER_API_PREFIX}/system/upgrade`, {
      method: 'POST',
    })
    try {
      await started
      const second = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade`, {
        method: 'POST',
      })
      assertEquals(second.status, 409)
      const secondBody = await second.json() as { error: string }
      assertEquals(secondBody.error, 'upgrade already in progress')
    } finally {
      releaseFetch?.()
      await first
    }
  })
})

test('POST /system/upgrade maps fetch/reset failures and restarts when sync succeeds', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  await withSystemRouteEnv({
    TURBOPANEL_INSTANCE_SERVICE: 'turbopanel-instance',
    TURBOPANEL_DEV_USER: 'dev',
    TURBOPANEL_TRUNK_BRANCH: 'trunk',
  }, async () => {
    setSystemRoutesTestHooks({
      gitRunner: scriptedGitRunner({ fetchSuccess: false }),
      restarter: () => {
        throw new TypeError('must not restart after fetch failure')
      },
    })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const fetchFail = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade`, {
      method: 'POST',
    })
    assertEquals(fetchFail.status, 500)
    const fetchBody = await fetchFail.json() as { error: string }
    assertEquals(fetchBody.error.includes('git fetch failed'), true)
  })

  await withSystemRouteEnv({
    TURBOPANEL_INSTANCE_SERVICE: 'turbopanel-instance',
  }, async () => {
    setSystemRoutesTestHooks({
      gitRunner: scriptedGitRunner({ resetSuccess: false }),
      restarter: () => {
        throw new TypeError('must not restart after reset failure')
      },
    })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const resetFail = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade`, {
      method: 'POST',
    })
    assertEquals(resetFail.status, 500)
    const resetBody = await resetFail.json() as { error: string }
    assertEquals(resetBody.error.includes('git reset failed'), true)
  })

  await withSystemRouteEnv({
    TURBOPANEL_INSTANCE_SERVICE: 'turbopanel-instance',
  }, async () => {
    const restarted: string[] = []
    setSystemRoutesTestHooks({
      gitRunner: scriptedGitRunner({}),
      restarter: (service) => {
        restarted.push(service)
      },
    })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const ok = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade`, {
      method: 'POST',
    })
    assertEquals(ok.status, 200)
    const body = await ok.json() as { ok: boolean; commit: string }
    assertEquals(body.ok, true)
    assertEquals(typeof body.commit, 'string')
    assertEquals(restarted, ['turbopanel-instance'])
  })

  await withSystemRouteEnv({
    TURBOPANEL_INSTANCE_SERVICE: 'turbopanel-instance',
  }, async () => {
    setSystemRoutesTestHooks({
      gitRunner: scriptedGitRunner({}),
      restarter: () => {
        throw new TypeError('restart boom')
      },
    })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const failed = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade`, {
      method: 'POST',
    })
    assertEquals(failed.status, 500)
    const failedBody = await failed.json() as { error: string }
    assertEquals(failedBody.error, 'restart boom')
  })
})

async function initTempGitCheckout(prefix: string): Promise<string> {
  const path = await Deno.makeTempDir({ prefix })
  const init = await new Deno.Command('git', {
    args: ['-C', path, 'init', '-q', '-b', 'trunk'],
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdout: 'null',
    stderr: 'piped',
  }).output()
  if (!init.success) {
    await Deno.remove(path, { recursive: true })
    const stderr = new TextDecoder().decode(init.stderr).trim()
    throw new Error(`git init failed: ${stderr}`)
  }
  return path
}

test('GET /system/upgrade-status uses the default git runner', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  // Host-free: CI has this checkout but not sibling ui/daemon trees.
  const created: string[] = []
  try {
    const daemonRepo = await initTempGitCheckout('tp-daemon-git-')
    created.push(daemonRepo)
    const uiRepo = await initTempGitCheckout('tp-ui-git-')
    created.push(uiRepo)
    await withSystemRouteEnv({
      TURBOPANEL_DEV_USER: 'dev',
      TURBOPANEL_DAEMON_REPO: daemonRepo,
      TURBOPANEL_UI_REPO: uiRepo,
    }, async () => {
      setSystemRoutesTestHooks({ gitRunner: null, restarter: null })
      const app = new Hono()
      registerSystemRoutes(app, { secrets, authRequired: false })
      const status = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade-status`)
      assertEquals(status.status, 200)
      const body = await status.json() as {
        ok: boolean
        canUpgrade: boolean
        dirty: unknown[]
      }
      assertEquals(body.ok, true)
      assertEquals(typeof body.canUpgrade, 'boolean')
      assertEquals(Array.isArray(body.dirty), true)
    })
  } finally {
    for (const repo of created) await Deno.remove(repo, { recursive: true })
  }
})

test('defaultSystemGitRunner maps a missing binary to success:false', async () => {
  const missing = `/tmp/turbopanel-missing-git-${crypto.randomUUID()}`
  const result = await defaultSystemGitRunner(missing, ['status', '--porcelain'])
  assertEquals(result.success, false)
  assertEquals(result.stdout, '')
  assertEquals(result.stderr.length > 0, true)
})
