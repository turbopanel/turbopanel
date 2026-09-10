import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  applyGithubInstallationEvent,
  applyProviderInstallationEvent,
  readPendingChecks,
  resolveRepositoryEnvironmentIds,
  resolveCheckTrigger,
  resolveGithubCheckTrigger,
  resolveGithubPushTrigger,
  resolvePushTrigger,
  sourceWatchesBranch,
  summarize,
  triggerSummaryNeedsRetry,
  type TriggerOutcome,
  type TriggerRepositoryRow,
  type TriggerSummary,
  type WebhookTriggerDeps,
} from './webhook-trigger.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function summary(failed: number): TriggerSummary {
  return {
    matchedSources: 1,
    queued: 0,
    skipped: failed === 0 ? 1 : 0,
    failed,
    outcomes: [],
  }
}

test('triggerSummaryNeedsRetry is true only when an instance-side fault ran', () => {
  assertEquals(triggerSummaryNeedsRetry(summary(0)), false)
  assertEquals(triggerSummaryNeedsRetry(summary(1)), true)
})

test('sourceWatchesBranch treats a blank default as every branch', () => {
  assertEquals(sourceWatchesBranch(null, 'trunk'), true)
  assertEquals(sourceWatchesBranch('   ', 'trunk'), true)
  assertEquals(sourceWatchesBranch('trunk', 'trunk'), true)
  assertEquals(sourceWatchesBranch(' trunk ', 'trunk'), true)
  assertEquals(sourceWatchesBranch('main', 'trunk'), false)
})

test('readPendingChecks requires a non-empty commitSha', () => {
  assertEquals(readPendingChecks(null), null)
  assertEquals(readPendingChecks([]), null)
  assertEquals(readPendingChecks({ pendingChecks: 'nope' }), null)
  assertEquals(readPendingChecks({ pendingChecks: { commitSha: '' } }), null)
  assertEquals(readPendingChecks({ pendingChecks: { commitSha: 12 } }), null)

  assertEquals(
    readPendingChecks({
      pendingChecks: {
        commitSha: 'abc123',
        ref: 'refs/heads/trunk',
        recordedAt: '2026-01-15T12:00:00.000Z',
      },
    }),
    {
      commitSha: 'abc123',
      ref: 'refs/heads/trunk',
      recordedAt: '2026-01-15T12:00:00.000Z',
    },
  )

  const withoutRef = readPendingChecks({
    pendingChecks: { commitSha: 'def456', ref: 9 },
  })
  if (withoutRef === null) {
    throw new TypeError('expected pending checks')
  }
  assertEquals(withoutRef.commitSha, 'def456')
  assertEquals(withoutRef.ref, null)
  assertEquals(typeof withoutRef.recordedAt, 'string')
})

const SOURCE_ID = '11111111-2222-4333-8444-555555555555'
const ENV_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const ORG_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const SERVER_ID = '550e8400-e29b-41d4-a716-446655440000'
const unusedDb = {} as Db
const unusedCtx = {} as Context<AppEnv>
const unusedQueue = { enqueue: async () => {} } as CommandQueue

function sourceRow(overrides: Partial<TriggerRepositoryRow> = {}): TriggerRepositoryRow {
  return {
    id: SOURCE_ID,
    organizationId: ORG_ID,
    defaultBranch: 'trunk',
    autoDeploy: 'immediate',
    options: null,
    ...overrides,
  }
}

function triggerDeps(
  rows: TriggerRepositoryRow[],
  overrides: WebhookTriggerDeps = {},
): WebhookTriggerDeps {
  return {
    loadInstallations: async () => ({ live: ['inst-row'], suspended: 0 }),
    findSources: async () => rows,
    setPendingChecks: async () => {},
    resolveRepositoryEnvironmentIds: async () => [ENV_ID],
    resolveEnvironmentPlacement: async () => ({
      serverId: SERVER_ID,
      organizationId: ORG_ID,
    }),
    runDeploy: async () => new Response(null, { status: 204 }),
    ...overrides,
  }
}

const APP_ID = '11111111-1111-4111-8111-111111111111'

const samplePush = {
  provider: 'github' as const,
  forgeId: APP_ID,
  externalInstallationId: '42',
  repositoryExternalId: '99',
  ref: 'refs/heads/trunk',
  branch: 'trunk',
  commitSha: 'abc123def',
}

test('summarize counts queued skipped and failed outcomes', () => {
  const outcomes: TriggerOutcome[] = [
    { kind: 'queued', sourceId: SOURCE_ID, environmentId: ENV_ID, commitSha: 'abc' },
    { kind: 'skipped', sourceId: SOURCE_ID, environmentId: null, reason: 'auto_deploy_disabled' },
    {
      kind: 'failed',
      sourceId: SOURCE_ID,
      environmentId: ENV_ID,
      reason: 'deploy_unavailable',
      status: 503,
    },
  ]
  assertEquals(summarize(outcomes, 3), {
    matchedSources: 3,
    queued: 1,
    skipped: 1,
    failed: 1,
    outcomes,
  })
})

test('resolvePushTrigger skips unknown or suspended installations', async () => {
  const unknown = await resolvePushTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    samplePush,
    { loadInstallations: async () => ({ live: [], suspended: 0 }) },
  )
  assertEquals(unknown.matchedSources, 0)
  assertEquals(unknown.skipped, 1)
  assertEquals(unknown.outcomes[0], {
    kind: 'skipped',
    sourceId: null,
    environmentId: null,
    reason: 'installation_unknown',
  })

  const suspended = await resolvePushTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    samplePush,
    { loadInstallations: async () => ({ live: [], suspended: 2 }) },
  )
  assertEquals(suspended.outcomes[0]?.kind === 'skipped' && suspended.outcomes[0].reason, 'installation_suspended')
})

test('resolvePushTrigger skips disabled unwatched parked and deleted heads', async () => {
  const parked: Array<{ sha: string | null }> = []
  const disabled = await resolvePushTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    samplePush,
    triggerDeps([sourceRow({ autoDeploy: 'disabled' })]),
  )
  assertEquals(disabled.outcomes[0]?.kind === 'skipped' && disabled.outcomes[0].reason, 'auto_deploy_disabled')

  const unwatched = await resolvePushTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    samplePush,
    triggerDeps([sourceRow({ defaultBranch: 'main' })]),
  )
  assertEquals(unwatched.outcomes[0]?.kind === 'skipped' && unwatched.outcomes[0].reason, 'branch_not_watched')

  const awaiting = await resolvePushTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    samplePush,
    triggerDeps([sourceRow({ autoDeploy: 'checks_passed' })], {
      setPendingChecks: async (_db, _row, pending) => {
        parked.push({ sha: pending?.commitSha ?? null })
      },
    }),
  )
  assertEquals(awaiting.outcomes[0]?.kind === 'skipped' && awaiting.outcomes[0].reason, 'awaiting_checks')
  assertEquals(parked, [{ sha: 'abc123def' }])

  const deletedChecks = await resolvePushTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    { ...samplePush, commitSha: null },
    triggerDeps([sourceRow({ autoDeploy: 'checks_passed' })], {
      setPendingChecks: async () => {
        throw new TypeError('branch delete must not park a SHA')
      },
    }),
  )
  assertEquals(
    deletedChecks.outcomes[0]?.kind === 'skipped' && deletedChecks.outcomes[0].reason,
    'awaiting_checks',
  )

  const deletedImmediate = await resolvePushTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    { ...samplePush, commitSha: null },
    triggerDeps([sourceRow()]),
  )
  assertEquals(
    deletedImmediate.outcomes[0]?.kind === 'skipped' && deletedImmediate.outcomes[0].reason,
    'branch_deleted',
  )
})

test('resolvePushTrigger deploys placed environments and maps pipeline status', async () => {
  const none = await resolvePushTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    samplePush,
    triggerDeps([sourceRow()], {
      resolveRepositoryEnvironmentIds: async () => [],
    }),
  )
  assertEquals(none.outcomes[0], {
    kind: 'skipped',
    sourceId: SOURCE_ID,
    environmentId: null,
    reason: 'no_environment',
  })

  const missing = await resolvePushTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    samplePush,
    triggerDeps([sourceRow()], {
      resolveEnvironmentPlacement: async () => null,
    }),
  )
  assertEquals(missing.outcomes[0], {
    kind: 'skipped',
    sourceId: SOURCE_ID,
    environmentId: ENV_ID,
    reason: 'no_environment',
  })

  const unplaced = await resolvePushTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    samplePush,
    triggerDeps([sourceRow()], {
      resolveEnvironmentPlacement: async () => ({
        serverId: null,
        organizationId: ORG_ID,
      }),
    }),
  )
  assertEquals(unplaced.outcomes[0], {
    kind: 'skipped',
    sourceId: SOURCE_ID,
    environmentId: ENV_ID,
    reason: 'server_placement_required',
  })

  const rejected = await resolvePushTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    samplePush,
    triggerDeps([sourceRow()], {
      runDeploy: async () => new Response(null, { status: 422 }),
    }),
  )
  assertEquals(rejected.outcomes[0], {
    kind: 'skipped',
    sourceId: SOURCE_ID,
    environmentId: ENV_ID,
    reason: 'deploy_rejected',
    status: 422,
  })

  const failed = await resolvePushTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    samplePush,
    triggerDeps([sourceRow()], {
      runDeploy: async () => new Response(null, { status: 503 }),
    }),
  )
  assertEquals(failed.failed, 1)
  assertEquals(failed.outcomes[0], {
    kind: 'failed',
    sourceId: SOURCE_ID,
    environmentId: ENV_ID,
    reason: 'deploy_unavailable',
    status: 503,
  })

  const queued = await resolvePushTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    samplePush,
    triggerDeps([sourceRow()]),
  )
  assertEquals(queued, {
    matchedSources: 1,
    queued: 1,
    skipped: 0,
    failed: 0,
    outcomes: [{
      kind: 'queued',
      sourceId: SOURCE_ID,
      environmentId: ENV_ID,
      commitSha: 'abc123def',
    }],
  })
})

test('resolveCheckTrigger releases only the parked SHA and restores it on 5xx', async () => {
  const pending = {
    commitSha: 'abc123def',
    ref: 'refs/heads/trunk',
    recordedAt: '2026-01-15T12:00:00.000Z',
  }
  const parkedRow = sourceRow({
    autoDeploy: 'checks_passed',
    options: { pendingChecks: pending },
  })

  const ignored = await resolveCheckTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    {
      provider: 'github',
      forgeId: APP_ID,
      externalInstallationId: '42',
      repositoryExternalId: '99',
      commitSha: 'abc123def',
      ref: null,
    },
    triggerDeps([
      sourceRow({ autoDeploy: 'immediate' }),
      sourceRow({
        id: 'other',
        autoDeploy: 'checks_passed',
        options: { pendingChecks: { commitSha: 'other-sha' } },
      }),
    ]),
  )
  assertEquals(ignored.matchedSources, 0)
  assertEquals(ignored.outcomes, [])

  const writes: Array<string | null> = []
  const released = await resolveCheckTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    {
      provider: 'github',
      forgeId: APP_ID,
      externalInstallationId: '42',
      repositoryExternalId: '99',
      commitSha: 'abc123def',
      ref: 'refs/heads/trunk',
    },
    triggerDeps([parkedRow], {
      setPendingChecks: async (_db, _row, next) => {
        writes.push(next?.commitSha ?? null)
      },
    }),
  )
  assertEquals(released.queued, 1)
  assertEquals(writes, [null])

  const restored: Array<string | null> = []
  const retried = await resolveCheckTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    {
      provider: 'github',
      forgeId: APP_ID,
      externalInstallationId: '42',
      repositoryExternalId: '99',
      commitSha: 'abc123def',
      ref: 'refs/heads/trunk',
    },
    triggerDeps([parkedRow], {
      setPendingChecks: async (_db, _row, next) => {
        restored.push(next?.commitSha ?? null)
      },
      runDeploy: async () => new Response(null, { status: 503 }),
    }),
  )
  assertEquals(retried.failed, 1)
  assertEquals(restored, [null, 'abc123def'])
})

test('resolveCheckTrigger skips a parked SHA when the CI ref does not match', async () => {
  const parkedRow = sourceRow({
    autoDeploy: 'checks_passed',
    options: {
      pendingChecks: {
        commitSha: 'abc123def',
        ref: 'refs/heads/trunk',
        recordedAt: '2026-01-15T12:00:00.000Z',
      },
    },
  })

  const mismatched = await resolveCheckTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    {
      provider: 'github',
      forgeId: APP_ID,
      externalInstallationId: '42',
      repositoryExternalId: '99',
      commitSha: 'abc123def',
      ref: 'refs/heads/feature',
    },
    triggerDeps([parkedRow]),
  )
  assertEquals(mismatched.matchedSources, 0)
  assertEquals(mismatched.outcomes, [])

  const omittedRef = await resolveCheckTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    {
      provider: 'github',
      forgeId: APP_ID,
      externalInstallationId: '42',
      repositoryExternalId: '99',
      commitSha: 'abc123def',
      ref: null,
    },
    triggerDeps([parkedRow]),
  )
  assertEquals(omittedRef.matchedSources, 0)

  const matching = await resolveCheckTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    {
      provider: 'github',
      forgeId: APP_ID,
      externalInstallationId: '42',
      repositoryExternalId: '99',
      commitSha: 'abc123def',
      ref: 'refs/heads/trunk',
    },
    triggerDeps([parkedRow]),
  )
  assertEquals(matching.queued, 1)
})

test('GitHub aliases bind the github provider discriminant', async () => {
  const seen: string[] = []
  const deps: WebhookTriggerDeps = {
    loadInstallations: async (_db, query) => {
      seen.push(query.provider)
      return { live: [], suspended: 0 }
    },
  }
  await resolveGithubPushTrigger(unusedCtx, unusedDb, unusedQueue, {
    forgeId: APP_ID,
    externalInstallationId: '42',
    repositoryExternalId: '99',
    ref: 'refs/heads/trunk',
    branch: 'trunk',
    commitSha: 'abc',
  }, deps)
  await resolveGithubCheckTrigger(unusedCtx, unusedDb, unusedQueue, {
    forgeId: APP_ID,
    externalInstallationId: '42',
    repositoryExternalId: '99',
    commitSha: 'abc',
    ref: null,
  }, deps)
  assertEquals(seen, ['github', 'github'])
})

test('resolveRepositoryEnvironmentIds resolves compose refs and dedupes them', async () => {
  const db = {
    execute: async () => [
      { environment_id: 'compose-env' },
      { environment_id: 'compose-env' },
      { environment_id: ENV_ID },
    ],
  } as unknown as Db
  const ids = await resolveRepositoryEnvironmentIds(db, sourceRow())
  assertEquals([...ids].toSorted((a, b) => a.localeCompare(b)), [
    ENV_ID,
    'compose-env',
  ])

  const empty = await resolveRepositoryEnvironmentIds(
    { execute: async () => [] } as unknown as Db,
    sourceRow(),
  )
  assertEquals(empty, [])
})

/**
 * The literal values a Drizzle predicate binds.
 *
 * Drizzle condition objects hold back-references to their table, so they cannot
 * be serialized; this walks them with a seen-set and collects the strings,
 * which is enough to assert *which* app id a query was scoped to.
 */
function boundValues(condition: unknown): string[] {
  const found: string[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      found.push(value)
      return
    }
    if (typeof value !== 'object' || value === null) return
    if (seen.has(value)) return
    seen.add(value)
    for (const entry of Object.values(value as Record<string, unknown>)) visit(entry)
  }
  visit(condition)
  return found
}

test('installation lookup is scoped to the app that signed the delivery', async () => {
  // The regression this guards: a GitHub installation id is unique only within
  // its App, and `installation` is unique on (org, app, external id) — so the
  // same numeric id legitimately exists as a row for several organizations.
  // Matching on provider + external id alone returned all of them, and one
  // organization's push deployed another organization's environments.
  const OTHER_APP = '33333333-3333-4333-8333-333333333333'
  const rowsByApp: Record<string, Array<{ id: string; suspendedAt: string | null }>> = {
    [APP_ID]: [{ id: 'ours', suspendedAt: null }],
    [OTHER_APP]: [{ id: 'theirs', suspendedAt: null }],
  }

  const scopedDb = {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          // Stand in for SQL: answer with the rows of whichever app id the
          // predicate actually binds, and nothing when it binds neither.
          const bound = boundValues(condition)
          const forgeId = bound.includes(APP_ID)
            ? APP_ID
            : bound.includes(OTHER_APP)
            ? OTHER_APP
            : null
          return Promise.resolve(forgeId ? rowsByApp[forgeId] : [])
        },
      }),
    }),
  } as unknown as Db

  const seenInstallations: string[][] = []
  const summary = await resolvePushTrigger(
    unusedCtx,
    scopedDb,
    unusedQueue,
    samplePush,
    {
      findSources: async (_db, installationIds) => {
        seenInstallations.push([...installationIds])
        return []
      },
    },
  )

  assertEquals(summary.matchedSources, 0)
  // Only the signing app's installation is a candidate; `theirs` never appears.
  assertEquals(seenInstallations, [['ours']])
})

test('a gitlab delivery still narrows to the app, not to every connection', async () => {
  // GitLab names no connection on a delivery, so the external-id predicate is
  // dropped. Before `app_id` that left *every* live GitLab connection on the
  // instance as a candidate — including projects on a different GitLab origin
  // whose numeric ids happened to collide.
  let sawAppPredicate = false
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          sawAppPredicate = boundValues(condition).includes(APP_ID)
          return Promise.resolve([{ id: 'gl-conn', suspendedAt: null }])
        },
      }),
    }),
  } as unknown as Db

  await resolvePushTrigger(
    unusedCtx,
    db,
    unusedQueue,
    { ...samplePush, provider: 'gitlab', externalInstallationId: null },
    { findSources: async () => [] },
  )
  assertEquals(sawAppPredicate, true)
})

test('resolvePushTrigger default loaders read a fake installation and source chain', async () => {
  const installationDb = {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            { id: 'live-1', suspendedAt: null },
            { id: 'susp-1', suspendedAt: '2026-01-01T00:00:00.000Z' },
          ]),
      }),
    }),
  } as unknown as Db
  const gitlab = await resolvePushTrigger(
    unusedCtx,
    installationDb,
    unusedQueue,
    { ...samplePush, provider: 'gitlab', externalInstallationId: null },
    { findSources: async () => [] },
  )
  assertEquals(gitlab.matchedSources, 0)
  assertEquals(gitlab.outcomes, [])

  const github = await resolvePushTrigger(
    unusedCtx,
    installationDb,
    unusedQueue,
    samplePush,
    { findSources: async () => [] },
  )
  assertEquals(github.outcomes, [])

  const parkedDb = {
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  } as unknown as Db
  const parked = await resolvePushTrigger(
    unusedCtx,
    parkedDb,
    unusedQueue,
    samplePush,
    {
      loadInstallations: async () => ({ live: ['inst-row'], suspended: 0 }),
      findSources: async () => [sourceRow({ autoDeploy: 'checks_passed' })],
    },
  )
  assertEquals(parked.outcomes[0]?.kind === 'skipped' && parked.outcomes[0].reason, 'awaiting_checks')

  const unknownCheck = await resolveCheckTrigger(
    unusedCtx,
    unusedDb,
    unusedQueue,
    {
      provider: 'github',
      forgeId: APP_ID,
      externalInstallationId: '42',
      repositoryExternalId: '99',
      commitSha: 'abc123def',
      ref: null,
    },
    { loadInstallations: async () => ({ live: [], suspended: 1 }) },
  )
  assertEquals(
    unknownCheck.outcomes[0]?.kind === 'skipped' && unknownCheck.outcomes[0].reason,
    'installation_suspended',
  )

  const sourcesDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([]),
        }),
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([{
                  serverId: SERVER_ID,
                  projectOptions: null,
                  organizationId: ORG_ID,
                }]),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
  const noSources = await resolvePushTrigger(
    unusedCtx,
    sourcesDb,
    unusedQueue,
    samplePush,
    { loadInstallations: async () => ({ live: ['inst-row'], suspended: 0 }) },
  )
  assertEquals(noSources.matchedSources, 0)

  const placed = await resolvePushTrigger(
    unusedCtx,
    sourcesDb,
    unusedQueue,
    samplePush,
    {
      loadInstallations: async () => ({ live: ['inst-row'], suspended: 0 }),
      findSources: async () => [sourceRow()],
      resolveRepositoryEnvironmentIds: async () => [ENV_ID],
      runDeploy: async () => new Response(null, { status: 204 }),
    },
  )
  assertEquals(placed.queued, 1)

  const missingPlacementDb = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db
  const missingPlacement = await resolvePushTrigger(
    unusedCtx,
    missingPlacementDb,
    unusedQueue,
    samplePush,
    {
      loadInstallations: async () => ({ live: ['inst-row'], suspended: 0 }),
      findSources: async () => [sourceRow()],
      resolveRepositoryEnvironmentIds: async () => [ENV_ID],
    },
  )
  assertEquals(missingPlacement.outcomes[0], {
    kind: 'skipped',
    sourceId: SOURCE_ID,
    environmentId: ENV_ID,
    reason: 'no_environment',
  })
})

test('applyProviderInstallationEvent suspends resumes or ignores the action', async () => {
  const calls: Array<{ suspendedAt: string | null }> = []
  const db = {
    update: () => ({
      set: (values: { suspendedAt: string | null }) => {
        calls.push({ suspendedAt: values.suspendedAt })
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: 'inst-row' }]),
          }),
        }
      },
    }),
  } as unknown as Db

  assertEquals(
    await applyProviderInstallationEvent(db, {
      provider: 'github',
      forgeId: APP_ID,
      externalInstallationId: '42',
      action: 'new_permissions_granted',
    }),
    { updated: 0 },
  )
  assertEquals(calls.length, 0)

  assertEquals(
    await applyProviderInstallationEvent(db, {
      provider: 'github',
      forgeId: APP_ID,
      externalInstallationId: '42',
      action: 'suspend',
    }),
    { updated: 1 },
  )
  if (calls[0]?.suspendedAt === null) {
    throw new TypeError('suspend must stamp suspendedAt')
  }

  assertEquals(
    await applyGithubInstallationEvent(db, {
      forgeId: APP_ID,
      externalInstallationId: '42',
      action: 'unsuspend',
    }),
    { updated: 1 },
  )
  assertEquals(calls[1]?.suspendedAt, null)

  const empty = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(
    await applyProviderInstallationEvent(empty, {
      provider: 'gitlab',
      forgeId: APP_ID,
      externalInstallationId: '99',
      action: 'deleted',
    }),
    { updated: 0 },
  )
})
