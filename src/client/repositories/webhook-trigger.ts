/**
 * Turn a verified provider webhook into zero or more `environment.deploy`
 * enqueues.
 *
 * The whole job is resolution: `(installation, repository, branch, sha)` is
 * provider vocabulary, and it has to become a set of environments plus the
 * commit each of them should build. Once that is settled the work is handed
 * straight to {@link runEnvironmentDeployForActor} — the *same* pipeline the
 * `POST /environments/:id/deploy` route uses. That is deliberate: generation
 * bump, task replacement, fan-out, and the daemon's newer-generation supersede
 * rule all live in that path, so a second push landing on an environment whose
 * previous deploy is still queued is handled by machinery that already exists
 * rather than by new cancellation logic here.
 *
 * Nothing in this module throws for an unroutable delivery. A provider reads a
 * non-2xx as "retry me", and retrying will not conjure a server placement or
 * un-suspend an installation, so every dead end is reported as a `skipped`
 * outcome the caller can log and answer 2xx to.
 *
 * An instance-side fault is the opposite case and is reported separately, as a
 * `failed` outcome. A queue that is down or a deploy that could not be enqueued
 * *would* succeed on a retry, and the provider's redelivery is the only
 * mechanism that brings the commit back — answering 2xx there loses the push
 * permanently. The caller checks {@link triggerSummaryNeedsRetry} and answers
 * 5xx instead.
 *
 * **Everything below is provider-agnostic.** Both webhook surfaces hand it the
 * same `(provider, app, installation, repository, branch, sha)` tuple, and the
 * only thing the provider discriminant changes is which installation rows are
 * candidates — see {@link loadInstallations}.
 *
 * **`forgeId` is not optional and is not a hint.** It is the registered app whose
 * webhook secret verified the delivery, and it is what narrows the candidate
 * installations to the connections granted through that app. See
 * {@link loadInstallations} for why provider and external id alone are not
 * enough — and for what it does *not* do on its own.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import {
  environment,
  gitConnection,
  project,
  repository,
  workspace,
} from '../../lib/db/schema.ts'
import { resolveEffectivePlacementServerId } from '../../lib/project-options.ts'
import type { ProjectOptions } from '../../lib/project-options.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import { logInfo, logWarn } from '../../logger.ts'
import {
  type DeployRequestAuth,
  runEnvironmentDeployForActor,
} from '../environments/deploy-routes.ts'
import type { WebhookGitProviderName } from '../../lib/git/git-provider.ts'
import { COMPOSE_SOURCE_JSONPATH } from './routes-helpers.ts'

/** Why a matched repository did not produce a deploy. */
export type TriggerSkipReason =
  /** No `installation` row for this provider installation id. */
  | 'installation_unknown'
  /** The installation is marked suspended; clones would fail anyway. */
  | 'installation_suspended'
  /** `autoDeploy: 'disabled'` — the repository is wired up but not armed. */
  | 'auto_deploy_disabled'
  /** The push was on a branch this repository does not watch. */
  | 'branch_not_watched'
  /** `autoDeploy: 'checks_passed'` — the SHA is parked until checks report. */
  | 'awaiting_checks'
  /** The repository is attached to nothing deployable (library entry). */
  | 'no_environment'
  /** No environment pin and no project default — nothing to deploy onto. */
  | 'server_placement_required'
  /** The push deleted the branch: no head commit to build. */
  | 'branch_deleted'
  /**
   * The shared deploy pipeline refused for a reason a retry cannot fix —
   * invalid compose, unknown environment, a gate the operator has to clear.
   */
  | 'deploy_rejected'

/**
 * Why a matched repository failed in a way a redelivery could still fix.
 *
 * Kept apart from {@link TriggerSkipReason} because the two get opposite HTTP
 * answers: a skip is final and answers 2xx, a failure answers 5xx so GitHub
 * redelivers.
 */
export type TriggerFailureReason =
  /** The deploy pipeline answered 5xx — command queue, database, or encryption. */
  | 'deploy_unavailable'

export type TriggerOutcome =
  | {
    kind: 'queued'
    sourceId: string
    environmentId: string
    commitSha: string | null
  }
  | {
    kind: 'skipped'
    sourceId: string | null
    environmentId: string | null
    reason: TriggerSkipReason
    /** Status the deploy pipeline returned, when `reason` is `deploy_rejected`. */
    status?: number
  }
  | {
    kind: 'failed'
    sourceId: string
    environmentId: string
    reason: TriggerFailureReason
    /** Status the deploy pipeline returned (always 5xx). */
    status: number
  }

export type TriggerSummary = {
  matchedSources: number
  queued: number
  skipped: number
  /** Instance-side failures — non-zero means the delivery must be retried. */
  failed: number
  outcomes: TriggerOutcome[]
}

export function summarize(outcomes: TriggerOutcome[], matchedSources: number): TriggerSummary {
  return {
    matchedSources,
    queued: outcomes.filter((o) => o.kind === 'queued').length,
    skipped: outcomes.filter((o) => o.kind === 'skipped').length,
    failed: outcomes.filter((o) => o.kind === 'failed').length,
    outcomes,
  }
}

/**
 * Should the delivery be answered 5xx so the provider redelivers it?
 *
 * Only an instance-side fault qualifies. Everything else — auto-deploy off, an
 * unwatched branch, a missing placement — looks exactly the same on the retry,
 * and answering 5xx to it would put the provider into a retry loop against a
 * configuration gap.
 */
export function triggerSummaryNeedsRetry(summary: TriggerSummary): boolean {
  return summary.failed > 0
}

const SOURCE_TRIGGER_SELECT = {
  id: repository.id,
  organizationId: repository.organizationId,
  defaultBranch: repository.defaultBranch,
  autoDeploy: repository.autoDeploy,
  options: repository.options,
}

export type TriggerRepositoryRow = {
  id: string
  organizationId: string
  defaultBranch: string | null
  autoDeploy: string
  options: unknown
}

/**
 * Sources this installation + repository could drive.
 *
 * Matching is on `repositoryExternalId` (the provider's numeric repo id), never
 * on `repositoryUrl`: a repository can be renamed or transferred, and the id is
 * the only field that survives it.
 */
async function findSourcesForRepository(
  db: Db,
  installationIds: readonly string[],
  repositoryExternalId: string,
): Promise<TriggerRepositoryRow[]> {
  if (installationIds.length === 0) return []
  return await db
    .select(SOURCE_TRIGGER_SELECT)
    .from(repository)
    .where(
      and(
        inArray(repository.connectionId, [...installationIds]),
        eq(repository.repositoryExternalId, repositoryExternalId),
      ),
    )
    .orderBy(repository.createdAt)
}

/**
 * Branch policy.
 *
 * A repository with `defaultBranch` set watches exactly that branch. A repository that
 * left it blank never picked one, so it watches **every** branch the repository
 * pushes — the alternative (guessing the repository's own default) would need a
 * live GitHub call on the hot path of every delivery and would silently change
 * behavior when someone renames the default branch upstream.
 */
export type WebhookTriggerDeps = {
  loadInstallations?: (
    db: Db,
    query: InstallationQuery,
  ) => Promise<{ live: string[]; suspended: number }>
  findSources?: (
    db: Db,
    installationIds: readonly string[],
    repositoryExternalId: string,
  ) => Promise<TriggerRepositoryRow[]>
  setPendingChecks?: (
    db: Db,
    row: TriggerRepositoryRow,
    pending: PendingChecks | null,
  ) => Promise<void>
  resolveRepositoryEnvironmentIds?: (
    db: Db,
    row: TriggerRepositoryRow,
  ) => Promise<string[]>
  resolveEnvironmentPlacement?: (
    db: Db,
    environmentId: string,
  ) => Promise<{ serverId: string | null; organizationId: string } | null>
  runDeploy?: typeof runEnvironmentDeployForActor
}

function resolveTriggerIo(deps: WebhookTriggerDeps = {}) {
  return {
    loadInstallations: deps.loadInstallations ?? loadInstallations,
    findSources: deps.findSources ?? findSourcesForRepository,
    setPendingChecks: deps.setPendingChecks ?? setPendingChecks,
    resolveRepositoryEnvironmentIds: deps.resolveRepositoryEnvironmentIds ??
      resolveRepositoryEnvironmentIds,
    resolveEnvironmentPlacement: deps.resolveEnvironmentPlacement ??
      resolveEnvironmentPlacement,
    runDeploy: deps.runDeploy ?? runEnvironmentDeployForActor,
  }
}

export function sourceWatchesBranch(
  defaultBranch: string | null,
  pushedBranch: string,
): boolean {
  if (defaultBranch === null || defaultBranch.trim().length === 0) return true
  return defaultBranch.trim() === pushedBranch
}

/** Parked `checks_passed` state, stored on `repository.options`. */
export type PendingChecks = {
  commitSha: string
  ref: string | null
  recordedAt: string
}

function readOptions(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return { ...(value as Record<string, unknown>) }
}

export function readPendingChecks(options: unknown): PendingChecks | null {
  const pending = readOptions(options).pendingChecks
  if (typeof pending !== 'object' || pending === null || Array.isArray(pending)) {
    return null
  }
  const record = pending as Record<string, unknown>
  if (typeof record.commitSha !== 'string' || record.commitSha.length === 0) return null
  return {
    commitSha: record.commitSha,
    ref: typeof record.ref === 'string' ? record.ref : null,
    recordedAt: typeof record.recordedAt === 'string'
      ? record.recordedAt
      : new Date().toISOString(),
  }
}

/**
 * Park a SHA on the repository until its checks report success.
 *
 * `repository.options` is reused rather than a side table: this is one small,
 * short-lived field per repository that only ever matters between a push and the
 * matching `check_suite`, and it is overwritten (not appended to) by the next
 * push, so the newest commit is always the one that eventually deploys.
 */
async function setPendingChecks(
  db: Db,
  row: TriggerRepositoryRow,
  pending: PendingChecks | null,
): Promise<void> {
  const options = readOptions(row.options)
  if (pending === null) delete options.pendingChecks
  else options.pendingChecks = pending

  await db
    .update(repository)
    .set({
      options: Object.keys(options).length > 0 ? options : null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(repository.id, row.id))
}

/**
 * Environments a repository can deploy.
 *
 * A repository is "attached" by a compose document naming it at
 * `services.<name>.x-turbopanel.source.sourceId` — the one attachment model
 * left now the legacy `service_id` / `environment_id` parent columns are gone.
 *
 * A project-level compose reference fans out to every environment of that
 * project, because the project document is the base every environment overlays.
 */
export async function resolveRepositoryEnvironmentIds(
  db: Db,
  row: TriggerRepositoryRow,
): Promise<string[]> {
  const ids = new Set<string>()

  const referenced = await db.execute<{ environment_id: string }>(sql`
    SELECT e.id AS environment_id
    FROM environment e
    JOIN project p ON p.id = e.project_id
    JOIN workspace w ON w.id = p.workspace_id
    WHERE w.organization_id = ${row.organizationId}::uuid
      AND (
        jsonb_path_exists(e.options, ${COMPOSE_SOURCE_JSONPATH}::jsonpath,
          jsonb_build_object('sid', ${row.id}::text))
        OR jsonb_path_exists(p.options, ${COMPOSE_SOURCE_JSONPATH}::jsonpath,
          jsonb_build_object('sid', ${row.id}::text))
      )
  `)
  for (const found of referenced) ids.add(found.environment_id)

  return [...ids]
}

/**
 * Effective placement for one environment, or `null` when it has none.
 *
 * Same rule the manual deploy route applies (`loadLifecycleTargets`): the
 * environment's own pin wins, otherwise the project default. An unplaced
 * environment is a configuration gap, not a transient failure, so the caller
 * records it and moves on instead of retrying.
 */
async function resolveEnvironmentPlacement(
  db: Db,
  environmentId: string,
): Promise<{ serverId: string | null; organizationId: string } | null> {
  const [row] = await db
    .select({
      serverId: environment.serverId,
      projectOptions: project.options,
      organizationId: workspace.organizationId,
    })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(eq(environment.id, environmentId))
    .limit(1)
  if (!row) return null

  return {
    serverId: resolveEffectivePlacementServerId(
      row.serverId,
      row.projectOptions as ProjectOptions | null,
    ),
    organizationId: row.organizationId,
  }
}

/**
 * Enqueue one environment through the shared deploy path.
 *
 * `acknowledgeHealthCheckWarnings` is `true` on purpose. That flag exists so a
 * person is shown warn-level health-check gaps before they deploy; there is no
 * person on a webhook, and leaving it false would mean a repository with one
 * warn-level gap silently stops auto-deploying with no surface anywhere to
 * acknowledge it. Enabling auto-deploy on the repository is the acknowledgement.
 */
async function deployEnvironmentForSource(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    row: TriggerRepositoryRow
    environmentId: string
    commitSha: string | null
    ref: string | null
  },
  io: ReturnType<typeof resolveTriggerIo>,
): Promise<TriggerOutcome> {
  const placement = await io.resolveEnvironmentPlacement(db, params.environmentId)
  if (!placement) {
    return {
      kind: 'skipped',
      sourceId: params.row.id,
      environmentId: params.environmentId,
      reason: 'no_environment',
    }
  }
  if (!placement.serverId) {
    return {
      kind: 'skipped',
      sourceId: params.row.id,
      environmentId: params.environmentId,
      reason: 'server_placement_required',
    }
  }

  const auth: DeployRequestAuth = {
    actorType: 'system',
    actorId: params.row.id,
    organizationId: placement.organizationId,
    acknowledgeHealthCheckWarnings: true,
    noCache: false,
    // `sourceId` is what scopes the pinned commit. The event came from exactly
    // this repository row; an environment that also binds other repositories must
    // resolve those from their own declared/default ref, not from this SHA.
    selection: {
      ref: params.ref,
      commitSha: params.commitSha,
      sourceId: params.row.id,
    },
  }

  const response = await io.runDeploy(
    c,
    db,
    commandQueue,
    params.environmentId,
    auth,
  )
  if (!response.ok) {
    // 5xx from the shared pipeline is this instance failing (queue down,
    // database or encryption unavailable), not the request being wrong. The
    // commit is still deployable, so it is reported as a failure and the
    // delivery is answered 5xx — GitHub's redelivery is the only thing that can
    // bring it back.
    if (response.status >= 500) {
      return {
        kind: 'failed',
        sourceId: params.row.id,
        environmentId: params.environmentId,
        reason: 'deploy_unavailable',
        status: response.status,
      }
    }
    return {
      kind: 'skipped',
      sourceId: params.row.id,
      environmentId: params.environmentId,
      reason: 'deploy_rejected',
      status: response.status,
    }
  }

  return {
    kind: 'queued',
    sourceId: params.row.id,
    environmentId: params.environmentId,
    commitSha: params.commitSha,
  }
}

async function deployAllEnvironmentsForSource(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    row: TriggerRepositoryRow
    commitSha: string | null
    ref: string | null
  },
  io: ReturnType<typeof resolveTriggerIo>,
): Promise<TriggerOutcome[]> {
  const environmentIds = await io.resolveRepositoryEnvironmentIds(db, params.row)
  if (environmentIds.length === 0) {
    return [{
      kind: 'skipped',
      sourceId: params.row.id,
      environmentId: null,
      reason: 'no_environment',
    }]
  }

  const outcomes: TriggerOutcome[] = []
  for (const environmentId of environmentIds) {
    outcomes.push(
      await deployEnvironmentForSource(c, db, commandQueue, {
        row: params.row,
        environmentId,
        commitSha: params.commitSha,
        ref: params.ref,
      }, io),
    )
  }
  return outcomes
}

/** What a verified delivery knows about the connection it came from. */
export type InstallationQuery = {
  provider: WebhookGitProviderName
  /**
   * The registered app whose webhook secret verified this delivery. Always
   * known by the time this runs, and the predicate that keeps the candidate set
   * inside one tenant — see the note on {@link loadInstallations}.
   */
  forgeId: string
  /** `null` when the delivery names no connection (GitLab). */
  externalInstallationId: string | null
}

/**
 * Live installation rows that could own this delivery.
 *
 * **`forgeId` is the load-bearing predicate.** Without it the only filters are
 * provider and external id, and neither is unique across tenants: the unique
 * index is `(organization_id, app_id, external_installation_id)`, so the same
 * GitHub installation id may exist as a row for several organizations. Matching
 * without the app would hand one organization's push to another organization's
 * environments. Scoping to the app that actually signed the delivery is what
 * makes the candidate set exactly the connections granted through it.
 *
 * Still plural: one app may legitimately be installed by several organizations
 * on a shared instance, and each of them gets its own sources.
 *
 * **What `app_id` does not do.** For an *instance-wide* app it narrows to the
 * app, not to one tenant — several organizations connect through it, and the
 * final narrowing is `repository.repository_external_id`. That is only sound
 * because an installation is claimed by exactly one organization per app
 * (`assertConnectionUnclaimed` in `../repositories/routes.ts` enforces first-come,
 * since the provider cannot tell us who is entitled to an account). Without
 * that check a second organization could register someone else's installation
 * id and receive their deliveries.
 *
 * **`externalInstallationId` may be `null`, and that is not a failure.** GitHub
 * names the installation on every delivery; GitLab names only the project,
 * because its webhook has no idea which OAuth connection an operator registered
 * the project under. A `null` therefore means "every live connection granted
 * through this app is a candidate", and the repository id does the narrowing in
 * {@link findSourcesForRepository} — which is safe because it matches on the
 * provider-side project id, and a repository can only carry an id the connection
 * that created it could see. Before `app_id` existed that fallback spanned
 * every GitLab connection on the instance, including other origins' projects
 * whose numeric ids happened to collide.
 */
async function loadInstallations(
  db: Db,
  query: InstallationQuery,
): Promise<{ live: string[]; suspended: number }> {
  const conditions = [
    eq(gitConnection.provider, query.provider),
    eq(gitConnection.forgeId, query.forgeId),
  ]
  if (query.externalInstallationId) {
    conditions.push(
      eq(gitConnection.externalInstallationId, query.externalInstallationId),
    )
  }

  const rows = await db
    .select({
      id: gitConnection.id,
      suspendedAt: gitConnection.suspendedAt,
    })
    .from(gitConnection)
    .where(and(...conditions))

  return {
    live: rows.filter((row) => row.suspendedAt === null).map((row) => row.id),
    suspended: rows.filter((row) => row.suspendedAt !== null).length,
  }
}

export type PushTrigger = {
  /** Which provider delivered it — decides the candidate installation set. */
  provider: WebhookGitProviderName
  /** The registered app whose secret verified the delivery. */
  forgeId: string
  /** `null` when the delivery names no connection (GitLab). */
  externalInstallationId: string | null
  repositoryExternalId: string
  /** Full git ref as delivered (`refs/heads/main`). */
  ref: string
  branch: string
  /** Head commit after the push. */
  commitSha: string | null
}

/** Resolve and act on one `push` delivery, from any provider. */
export async function resolvePushTrigger(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  push: PushTrigger,
  deps: WebhookTriggerDeps = {},
): Promise<TriggerSummary> {
  const io = resolveTriggerIo(deps)
  const installations = await io.loadInstallations(db, {
    provider: push.provider,
    forgeId: push.forgeId,
    externalInstallationId: push.externalInstallationId,
  })
  if (installations.live.length === 0) {
    return summarize([{
      kind: 'skipped',
      sourceId: null,
      environmentId: null,
      reason: installations.suspended > 0
        ? 'installation_suspended'
        : 'installation_unknown',
    }], 0)
  }

  const rows = await io.findSources(
    db,
    installations.live,
    push.repositoryExternalId,
  )

  const outcomes: TriggerOutcome[] = []
  for (const row of rows) {
    if (row.autoDeploy === 'disabled') {
      outcomes.push({
        kind: 'skipped',
        sourceId: row.id,
        environmentId: null,
        reason: 'auto_deploy_disabled',
      })
      continue
    }
    if (!sourceWatchesBranch(row.defaultBranch, push.branch)) {
      outcomes.push({
        kind: 'skipped',
        sourceId: row.id,
        environmentId: null,
        reason: 'branch_not_watched',
      })
      continue
    }
    if (row.autoDeploy === 'checks_passed') {
      // Park the SHA and wait for the matching check_suite / check_run. A push
      // that carried no head SHA (a branch delete) has nothing to park and
      // nothing a later check could match, so it is simply dropped.
      if (push.commitSha) {
        await io.setPendingChecks(db, row, {
          commitSha: push.commitSha,
          ref: push.ref,
          recordedAt: new Date().toISOString(),
        })
      }
      outcomes.push({
        kind: 'skipped',
        sourceId: row.id,
        environmentId: null,
        reason: 'awaiting_checks',
      })
      continue
    }

    if (!push.commitSha) {
      // Mirrors the `checks_passed` guard above: a branch delete carries no head
      // SHA, so there is nothing to build and an immediate deploy would either
      // redeploy the previous state or fail at checkout. The webhook route
      // short-circuits these before they reach here; this is the same rule for
      // any other caller.
      outcomes.push({
        kind: 'skipped',
        sourceId: row.id,
        environmentId: null,
        reason: 'branch_deleted',
      })
      continue
    }

    outcomes.push(
      ...await deployAllEnvironmentsForSource(c, db, commandQueue, {
        row,
        commitSha: push.commitSha,
        ref: push.ref,
      }, io),
    )
  }

  const summary = summarize(outcomes, rows.length)
  logInfo(
    'git-webhook',
    `push ${push.repositoryExternalId}@${push.branch}: ` +
      `${summary.queued} queued, ${summary.skipped} skipped, ${summary.failed} failed`,
  )
  return summary
}

export type CheckTrigger = {
  provider: WebhookGitProviderName
  /** The registered app whose secret verified the delivery. */
  forgeId: string
  /** `null` when the delivery names no connection (GitLab). */
  externalInstallationId: string | null
  repositoryExternalId: string
  commitSha: string
  /**
   * Normalized `refs/heads/…` from the CI event, or `null` when the provider
   * omitted a branch. When a parked SHA also recorded a ref, they must match.
   */
  ref: string | null
}

/**
 * Resolve and act on a completed, successful CI signal — GitHub's
 * `check_suite` / `check_run`, or GitLab's `pipeline`.
 *
 * Only sources that actually parked *this* SHA (and, when recorded, this
 * branch ref) are released. A success for a commit nobody is waiting on
 * (an older run finishing late, a branch nothing watches, a green check
 * on a different ref than the parked push) is a no-op, which is what
 * keeps a burst of check events from deploying the same commit repeatedly.
 */
export async function resolveCheckTrigger(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  check: CheckTrigger,
  deps: WebhookTriggerDeps = {},
): Promise<TriggerSummary> {
  const io = resolveTriggerIo(deps)
  const installations = await io.loadInstallations(db, {
    provider: check.provider,
    forgeId: check.forgeId,
    externalInstallationId: check.externalInstallationId,
  })
  if (installations.live.length === 0) {
    return summarize([{
      kind: 'skipped',
      sourceId: null,
      environmentId: null,
      reason: installations.suspended > 0
        ? 'installation_suspended'
        : 'installation_unknown',
    }], 0)
  }

  const rows = await io.findSources(
    db,
    installations.live,
    check.repositoryExternalId,
  )

  const outcomes: TriggerOutcome[] = []
  let matched = 0
  for (const row of rows) {
    if (row.autoDeploy !== 'checks_passed') continue
    const pending = readPendingChecks(row.options)
    if (pending?.commitSha !== check.commitSha) continue
    if (pending.ref && pending.ref !== check.ref) continue
    matched += 1

    // Clear first: a deploy that fails to enqueue must not leave the SHA parked
    // so a later unrelated success replays it.
    await io.setPendingChecks(db, row, null)
    const results = await deployAllEnvironmentsForSource(c, db, commandQueue, {
      row,
      commitSha: pending.commitSha,
      ref: pending.ref,
    }, io)
    // ...but an instance-side failure is not a replay risk, it is lost work: the
    // delivery is about to be answered 5xx, and GitHub's redelivery has nothing
    // to release unless the SHA goes back. Restore exactly what was parked.
    if (results.some((outcome) => outcome.kind === 'failed')) {
      await io.setPendingChecks(db, row, pending)
    }
    outcomes.push(...results)
  }

  const summary = summarize(outcomes, matched)
  if (matched > 0) {
    logInfo(
      'git-webhook',
      `checks passed ${check.repositoryExternalId}@${check.commitSha.slice(0, 7)}: ` +
        `${summary.queued} queued, ${summary.skipped} skipped, ${summary.failed} failed`,
    )
  }
  return summary
}

/**
 * Apply an `installation` lifecycle event.
 *
 * Suspension is the provider telling us its tokens will stop working; recording
 * it here is what makes {@link loadInstallations} (and the per-provider token
 * minters) refuse further work instead of failing at clone time. Deletion is
 * treated as suspension rather than a row delete: the `repository` rows that
 * reference the installation stay intact, so re-installing the App — or
 * re-authorizing the OAuth grant — restores them instead of orphaning every
 * repository binding.
 *
 * Only GitHub delivers these. GitLab has no installation-lifecycle webhook: a
 * revoked grant surfaces as a failing token refresh, which the deploy path
 * reports as a prepare error rather than as a suspension recorded up front.
 *
 * **Scoped to `forgeId` for the same reason the lookup above is.** A GitHub
 * installation id is unique only within its App, so suspending on provider and
 * external id alone would suspend every organization's row for that account the
 * moment any one of them uninstalled.
 */
export async function applyProviderInstallationEvent(
  db: Db,
  params: {
    provider: WebhookGitProviderName
    forgeId: string
    externalInstallationId: string
    action: string
  },
): Promise<{ updated: number }> {
  const suspendActions = new Set(['suspend', 'deleted'])
  const resumeActions = new Set(['unsuspend', 'created', 'new_permissions_accepted'])

  let suspendedAt: string | null
  if (suspendActions.has(params.action)) suspendedAt = new Date().toISOString()
  else if (resumeActions.has(params.action)) suspendedAt = null
  else return { updated: 0 }

  const updated = await db
    .update(gitConnection)
    .set({ suspendedAt, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(gitConnection.provider, params.provider),
        eq(gitConnection.forgeId, params.forgeId),
        eq(
          gitConnection.externalInstallationId,
          params.externalInstallationId,
        ),
      ),
    )
    .returning({ id: gitConnection.id })

  if (updated.length === 0) {
    logWarn(
      'git-webhook',
      `installation ${params.action} for unknown installation ` +
        params.externalInstallationId,
    )
  }
  return { updated: updated.length }
}

/**
 * GitHub-named aliases.
 *
 * The resolvers above are provider-agnostic; these keep the GitHub webhook
 * route (and its tests) reading in its own vocabulary while binding the
 * discriminant once, so a GitHub delivery can never be resolved against a
 * GitLab connection by omission.
 */
export function resolveGithubPushTrigger(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  push: Omit<PushTrigger, 'provider'>,
  deps?: WebhookTriggerDeps,
): Promise<TriggerSummary> {
  return resolvePushTrigger(
    c,
    db,
    commandQueue,
    { provider: 'github', ...push },
    deps,
  )
}

export function resolveGithubCheckTrigger(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  check: Omit<CheckTrigger, 'provider'>,
  deps?: WebhookTriggerDeps,
): Promise<TriggerSummary> {
  return resolveCheckTrigger(
    c,
    db,
    commandQueue,
    { provider: 'github', ...check },
    deps,
  )
}

export function applyGithubInstallationEvent(
  db: Db,
  params: { forgeId: string; externalInstallationId: string; action: string },
): Promise<{ updated: number }> {
  return applyProviderInstallationEvent(db, { provider: 'github', ...params })
}
