import type { Env, Hono } from 'hono'
import { createDeveloperAccessMiddleware } from '../client/authn/middleware.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import { getDaemonRepoPath, getInstanceCommit } from '../daemon/version.ts'
import type { Db } from '../db.ts'
import { dirname, fromFileUrl, join } from '@std/path'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'

const INSTANCE_REPO_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '..', '..')
})()

export function getUiRepoPath(): string {
  const override = Deno.env.get('TURBOPANEL_UI_REPO')?.trim()
  if (override) return override
  return join(INSTANCE_REPO_ROOT, '..', 'ui')
}

/** Platform checkouts Upgrade System may reset — all must be clean first. */
const PLATFORM_REPOS = [
  { name: 'instance', path: INSTANCE_REPO_ROOT },
  { name: 'daemon', path: getDaemonRepoPath },
  { name: 'ui', path: getUiRepoPath },
] as const

export type DirtyRepo = {
  repo: string
  path: string
  changes: number
}

export type UpgradeStatus = {
  ok: true
  canUpgrade: boolean
  dirty: DirtyRepo[]
}

export type SystemGitResult = {
  success: boolean
  stdout: string
  stderr: string
}

export type SystemGitRunner = (
  bin: string,
  args: string[],
) => Promise<SystemGitResult>

export function resolveGitInvocation(
  repoRoot: string,
  args: string[],
  opts: Readonly<{ direct: boolean; productionGitUser: string }>,
): { bin: string; args: string[] } {
  const gitArgs = ['-C', repoRoot, ...args]
  if (opts.direct) {
    return { bin: 'git', args: gitArgs }
  }
  return {
    bin: 'sudo',
    args: ['-u', opts.productionGitUser, 'git', ...gitArgs],
  }
}

export function describeUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function trunkBranch(): string {
  return Deno.env.get('TURBOPANEL_TRUNK_BRANCH')?.trim() || 'trunk'
}

function instanceServiceName(): string | undefined {
  return Deno.env.get('TURBOPANEL_INSTANCE_SERVICE')?.trim() || undefined
}

function usesDirectGit(): boolean {
  return (Deno.env.get('TURBOPANEL_DEV_USER')?.trim() ?? '').length > 0
}

function productionGitUser(): string {
  return Deno.env.get('TURBOPANEL_USER')?.trim() || 'tp'
}

export async function defaultSystemGitRunner(
  bin: string,
  args: string[],
): Promise<SystemGitResult> {
  try {
    const command = new Deno.Command(bin, {
      args,
      stdout: 'piped',
      stderr: 'piped',
    })
    const out = await command.output()
    const decoder = new TextDecoder()
    return {
      success: out.success,
      stdout: decoder.decode(out.stdout).trim(),
      stderr: decoder.decode(out.stderr).trim(),
    }
  } catch (err) {
    return { success: false, stdout: '', stderr: describeUnknownError(err) }
  }
}

function defaultRestartInstance(service: string): void {
  new Deno.Command('sudo', {
    args: ['systemctl', 'restart', service],
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
  }).spawn()
}

let systemGitRunner: SystemGitRunner = defaultSystemGitRunner
let instanceRestarter: (service: string) => void = defaultRestartInstance
let upgrading = false

export function setSystemRoutesTestHooks(hooks: {
  gitRunner?: SystemGitRunner | null
  restarter?: ((service: string) => void) | null
} = {}): void {
  if (hooks.gitRunner !== undefined) {
    systemGitRunner = hooks.gitRunner ?? defaultSystemGitRunner
  }
  if (hooks.restarter !== undefined) {
    instanceRestarter = hooks.restarter ?? defaultRestartInstance
  }
}

export function resetSystemRoutesUpgradeLockForTests(): void {
  upgrading = false
}

/** Run git as the dev user directly, or via sudo -u on managed production hosts. */
async function git(
  repoRoot: string,
  args: string[],
): Promise<SystemGitResult> {
  const invocation = resolveGitInvocation(repoRoot, args, {
    direct: usesDirectGit(),
    productionGitUser: productionGitUser(),
  })
  return await systemGitRunner(invocation.bin, invocation.args)
}

const RUNTIME_DIR_PREFIXES = ['.config/', '.local/', '.cache/'] as const

export function porcelainPath(line: string): string {
  const raw = line.slice(3).trim()
  const arrow = raw.indexOf(' -> ')
  return (arrow >= 0 ? raw.slice(arrow + 4) : raw).trim()
}

export function isRuntimePorcelainLine(line: string): boolean {
  const path = porcelainPath(line)
  return RUNTIME_DIR_PREFIXES.some((prefix) => path.startsWith(prefix))
}

async function repoDirty(
  repoRoot: string,
): Promise<{ ok: true; dirty: boolean; changes: number } | { ok: false; error: string }> {
  const status = await git(repoRoot, ['status', '--porcelain'])
  if (!status.success) {
    return {
      ok: false,
      error: status.stderr || 'git status failed',
    }
  }
  const lines = status.stdout
    ? status.stdout.split('\n').filter(Boolean).filter((line) => !isRuntimePorcelainLine(line))
    : []
  return { ok: true, dirty: lines.length > 0, changes: lines.length }
}

async function collectDirtyRepos(): Promise<
  { ok: true; dirty: DirtyRepo[] } | { ok: false; error: string }
> {
  const dirty: DirtyRepo[] = []
  for (const repo of PLATFORM_REPOS) {
    const path = typeof repo.path === 'function' ? repo.path() : repo.path
    const result = await repoDirty(path)
    if (!result.ok) {
      return { ok: false, error: `${repo.name}: ${result.error}` }
    }
    if (result.dirty) {
      dirty.push({ repo: repo.name, path, changes: result.changes })
    }
  }
  return { ok: true, dirty }
}

export function dirtyUpgradeError(dirty: DirtyRepo[]): string {
  const names = dirty.map((entry) => entry.repo).join(', ')
  return `cannot upgrade: uncommitted changes in ${names} (commit or stash first)`
}

async function syncRepoToTrunk(
  repoRoot: string,
  label: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const fetched = await git(repoRoot, ['fetch', 'origin', trunkBranch()])
  if (!fetched.success) {
    return {
      ok: false,
      error: `${label} git fetch failed: ${fetched.stderr}`,
    }
  }

  const reset = await git(repoRoot, ['reset', '--hard', `origin/${trunkBranch()}`])
  if (!reset.success) {
    return {
      ok: false,
      error: `${label} git reset failed: ${reset.stderr}`,
    }
  }

  return { ok: true }
}

export function registerSystemRoutes<E extends Env>(
  app: Hono<E>,
  opts: { secrets: DerivedSecretsConfig; db?: Db; authRequired?: boolean },
): Hono<E> {
  if (opts.authRequired !== false) {
    app.use(`${DEVELOPER_API_PREFIX}/system/*`, createDeveloperAccessMiddleware(opts.secrets))
  }

  app.get(`${DEVELOPER_API_PREFIX}/system/upgrade-status`, async (c) => {
    const result = await collectDirtyRepos()
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 500)
    }
    const body: UpgradeStatus = {
      ok: true,
      canUpgrade: result.dirty.length === 0,
      dirty: result.dirty,
    }
    return c.json(body)
  })

  app.post(`${DEVELOPER_API_PREFIX}/system/upgrade`, async (c) => {
    if (upgrading) {
      return c.json({ ok: false, error: 'upgrade already in progress' }, 409)
    }

    const dirtyCheck = await collectDirtyRepos()
    if (!dirtyCheck.ok) {
      return c.json({ ok: false, error: dirtyCheck.error }, 500)
    }
    if (dirtyCheck.dirty.length > 0) {
      return c.json(
        {
          ok: false,
          error: dirtyUpgradeError(dirtyCheck.dirty),
          dirty: dirtyCheck.dirty,
        },
        409,
      )
    }

    const service = instanceServiceName()
    if (!service) {
      return c.json(
        {
          ok: false,
          error:
            'instance upgrade restart unavailable: TURBOPANEL_INSTANCE_SERVICE is not set (run under systemd or configure a managed service)',
        },
        503,
      )
    }

    upgrading = true
    try {
      const instanceSync = await syncRepoToTrunk(INSTANCE_REPO_ROOT, 'instance')
      if (!instanceSync.ok) {
        return c.json({ ok: false, error: instanceSync.error }, 500)
      }

      const daemonSync = await syncRepoToTrunk(getDaemonRepoPath(), 'daemon')
      if (!daemonSync.ok) {
        return c.json({ ok: false, error: daemonSync.error }, 500)
      }

      const instanceVersion = await getInstanceCommit()
      const commit = instanceVersion.commit

      // Queue restart without awaiting — awaiting systemctl restart kills this
      // process before the HTTP response reaches Caddy (client sees HTTP 502).
      instanceRestarter(service)

      return c.json({ ok: true, commit })
    } catch (err) {
      return c.json({ ok: false, error: describeUnknownError(err) }, 500)
    } finally {
      upgrading = false
    }
  })

  return app
}
