/**
 * GitHub App deliveries.
 *
 * The ordering, the delivery ledger and the retry contract live in
 * `../gate.ts`; this file is only what makes GitHub *GitHub* — how a delivery
 * names its App, how its HMAC is checked, and what a `push` or a green
 * `check_suite` means for a deploy.
 *
 * Paths: hosted github.com Apps are handed the bare path and resolve by the
 * App-id header; GitHub Enterprise Apps are handed the `:ref` one.
 */

import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import {
  GITHUB_WEBHOOK_PATH,
  GITHUB_WEBHOOK_SCOPED_PATH,
} from '../../surfaces.ts'
import { logInfo } from '../../logger.ts'
import { githubWebhookRateLimitKey } from '../../daemon/rate-limit/keys.ts'
import { resolveGithubWebhookForge } from '../../lib/git/resolve-webhook-forge.ts'
import type { Forge } from '../../lib/git/forge-records.ts'
import {
  branchFromGitRef,
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
} from '../../lib/git/github-webhook.ts'
import { assertDeployDispatchInfrastructure } from '../../client/environments/deploy-routes.ts'
import {
  githubInstallationExternalId as installationExternalId,
  githubProvider,
} from '../../lib/git/github-provider.ts'
import {
  applyGithubInstallationEvent,
  resolveGithubCheckTrigger,
  resolveGithubPushTrigger,
  triggerSummaryNeedsRetry,
} from '../../client/repositories/webhook-trigger.ts'
import {
  accepted,
  type DeliveryOutcome,
  registerWebhookGate,
  retryable,
  type WebhookGate,
  type WebhookGateOpts,
} from '../gate.ts'

/**
 * Hard ceiling on an accepted delivery body.
 *
 * GitHub's own documented cap is 25 MB, but the payloads this surface acts on
 * (`push`, `check_suite`, `installation`) are orders of magnitude smaller, and
 * the bytes are buffered in memory to be MAC'd. 1 MB is well clear of a real
 * push event (even one with hundreds of commits) while keeping a hostile caller
 * from making the instance hold an arbitrary buffer before authentication.
 */
export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024

/**
 * The suite-level check rule lives with the rest of GitHub's payload vocabulary
 * in `src/lib/git/github-provider.ts`, so the GitLab surface can be written
 * against the same interface. Re-exported unchanged — it is part of this
 * module's tested surface.
 */
export { successfulCheckSha } from '../../lib/git/github-provider.ts'

async function handlePush(
  c: Context<AppEnv>,
  db: Db,
  forgeId: string,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  // `githubProvider.parsePush` applies the branch-ref and identification rules;
  // `null` means the delivery is not a branch push this instance can route.
  const push = githubProvider.parsePush(payload)
  if (!push) {
    const branch = branchFromGitRef(typeof payload.ref === 'string' ? payload.ref : null)
    return accepted({ skipped: branch ? 'unidentified_delivery' : 'non_branch_ref' })
  }

  // Deleting a branch is delivered as a push whose `after` is the all-zero SHA
  // (`isCommitSha` rejects it) with `deleted: true`. There is no head to
  // build, so it is not a deploy trigger for any `autoDeploy` mode — dropping it
  // here keeps a delete from redeploying the previous state on an `immediate`
  // source, and from being indistinguishable from a real push downstream.
  if (push.deleted) return accepted({ skipped: 'branch_deleted' })

  const commandQueue = assertDeployDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return retryable('dispatch_unavailable')

  const summary = await resolveGithubPushTrigger(c, db, commandQueue, {
    forgeId,
    externalInstallationId: push.externalInstallationId,
    repositoryExternalId: push.repositoryExternalId,
    ref: push.ref,
    branch: push.branch,
    commitSha: push.commitSha,
  })
  return { retry: triggerSummaryNeedsRetry(summary), result: summary }
}

async function handleChecks(
  c: Context<AppEnv>,
  db: Db,
  forgeId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  // All-checks-green only: see `successfulCheckSha`. A single green `check_run`
  // inside a suite that is still running (or that later fails) is not a release
  // signal and never reaches the trigger.
  const check = githubProvider.parseCheck(event, payload)
  if (!check) return accepted({ skipped: 'checks_not_successful' })

  const commandQueue = assertDeployDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return retryable('dispatch_unavailable')

  const summary = await resolveGithubCheckTrigger(c, db, commandQueue, {
    forgeId,
    ...check,
  })
  return { retry: triggerSummaryNeedsRetry(summary), result: summary }
}

/**
 * `installation` / `installation_repositories`.
 *
 * Only the installation's own lifecycle is acted on. Repository add/remove is
 * logged and otherwise ignored in this phase: dropping `source` rows because a
 * repository left the installation's selection would destroy operator
 * configuration on what is very often a temporary change, and the clone would
 * fail loudly anyway once the token no longer covers it.
 */
async function handleInstallation(
  db: Db,
  forgeId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const installation = installationExternalId(payload)
  if (!installation) return accepted({ skipped: 'unidentified_delivery' })

  if (event === 'installation_repositories') {
    logInfo(
      'git-webhook',
      `installation_repositories ${String(payload.action)} for ${installation} ` +
        '(no source rows changed)',
    )
    return accepted({ skipped: 'repositories_noted' })
  }

  const action = typeof payload.action === 'string' ? payload.action : ''
  return accepted(
    await applyGithubInstallationEvent(db, {
      forgeId,
      externalInstallationId: installation,
      action,
    }),
  )
}

async function dispatchDelivery(
  c: Context<AppEnv>,
  db: Db,
  forgeId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  switch (event) {
    case 'push':
      return await handlePush(c, db, forgeId, payload)
    case 'check_suite':
    case 'check_run':
      return await handleChecks(c, db, forgeId, event, payload)
    case 'installation':
    case 'installation_repositories':
      return await handleInstallation(db, forgeId, event, payload)
    default:
      return accepted({ skipped: 'event_not_handled' })
  }
}

const githubGate: WebhookGate<Forge> = {
  kind: 'github',
  logScope: 'git-webhook',
  maxBodyBytes: GITHUB_WEBHOOK_MAX_BODY_BYTES,
  rateLimitKey: githubWebhookRateLimitKey,

  async resolve(ctx, ref) {
    const resolution = await resolveGithubWebhookForge(
      ctx.db,
      ctx.dataEncryptionSecrets,
      ref,
      ctx.headers,
    )
    if (resolution.ok) return { ok: true, candidates: resolution.candidates }
    return {
      ok: false,
      reason: resolution.reason === 'ref_header_mismatch'
        ? 'webhook url and app id name different apps'
        : 'names no registered app',
    }
  },

  isUnconfigured: (app) => !app.webhookSecret,
  unconfiguredError: 'github_app_not_configured',

  verify: (app, raw, ctx) =>
    githubProvider.verifyWebhook(app.webhookSecret ?? '', raw, ctx.headers),

  deliveryId: (ctx) =>
    Promise.resolve(ctx.headers.get(GITHUB_DELIVERY_HEADER)?.trim() || null),

  eventName: (ctx) => ctx.headers.get(GITHUB_EVENT_HEADER)?.trim() || null,

  // Every downstream lookup is scoped to the verified app's id, which is what
  // keeps one organization's push out of another's environments when both
  // connected the same provider account.
  dispatch: (ctx, app, event, payload) =>
    dispatchDelivery(ctx.c, ctx.db, app.id, event, payload),
}

export function registerGithubWebhookRoutes(app: Hono<AppEnv>, opts: WebhookGateOpts) {
  registerWebhookGate(
    app,
    [GITHUB_WEBHOOK_SCOPED_PATH, GITHUB_WEBHOOK_PATH],
    githubGate,
    opts,
  )
}
