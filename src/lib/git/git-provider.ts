/**
 * The one place a Git provider's vocabulary is turned into TurboPanel's.
 *
 * Before this module every caller branched on `row.provider === 'github'` (and
 * treated everything else as generic SSH), which meant adding a second hosted
 * provider would have touched deploy-prepare, the webhook resolver, the
 * repository picker, and the webhook ingress independently. The interface below
 * is deliberately **narrow**: it holds exactly the five things those callers
 * actually ask a provider for, and nothing speculative.
 *
 *   1. {@link GitProvider.listRepositories} — the connect-a-repository picker.
 *   2. {@link GitProvider.prepareClone} — deploy-prepare's "which commit, and
 *      what credential clones it".
 *   3. {@link GitProvider.verifyWebhook} — is this delivery really from them.
 *   4. {@link GitProvider.parsePush} / {@link GitProvider.parseCheck} — the
 *      provider payload → the `(installation, repository, branch, sha)` tuple
 *      `src/client/repositories/webhook-trigger.ts` resolves.
 *
 * Generic SSH (`provider: 'git'`) is expressed here too, as a degenerate
 * implementation: it resolves no remote SHA (the ref passes through), mints no
 * credential (the source's stored `credential` row is the clone key), and
 * receives no webhooks. Modelling it as a provider rather than as an `else`
 * branch is what collapses the three-way `if` in deploy-prepare into one
 * dispatch.
 *
 * **Credential shapes.** `prepareClone` returns a *minted* secret or nothing.
 * Nothing means "this source clones with the credential row it already points
 * at", which is the generic-SSH lane — and also the GitLab deploy-key lane, so
 * the two share one code path in `deploy-sources.ts` rather than forking. A
 * minted secret is short-lived, is sealed straight into the deploy payload by
 * the caller, and is never persisted.
 */

import type {
  RepositoryEntry as _RepositoryEntry,
  RepositoryFileSet as _RepositoryFileSet,
  RepositoryReadUnsupported as _RepositoryReadUnsupported,
} from './repository-read.ts'
import type { Db } from '../../db.ts'
import type { DerivedSecretsConfig } from '../../client/authn/secrets.ts'
import { genericGitProvider } from './generic-git-provider.ts'
import { githubProvider } from './github-provider.ts'
import { gitlabProvider } from './gitlab-provider.ts'

export { normalizeCheckRef } from './check-ref.ts'

/**
 * Every provider a `source` row may name.
 *
 * Kept in step with `SOURCE_PROVIDERS` in
 * `src/client/repositories/routes-helpers.ts` (which stays database-free and so
 * repeats the literal) and with the `source_provider_check` constraint in
 * `src/lib/db/schema.ts`.
 */
export const GIT_PROVIDERS = ['github', 'gitlab', 'git'] as const
export type GitProviderName = (typeof GIT_PROVIDERS)[number]

/** Providers that authenticate an inbound webhook and can be delivered to. */
export const WEBHOOK_GIT_PROVIDERS = ['github', 'gitlab'] as const
export type WebhookGitProviderName = (typeof WEBHOOK_GIT_PROVIDERS)[number]

export function isGitProviderName(value: unknown): value is GitProviderName {
  return typeof value === 'string' && (GIT_PROVIDERS as readonly string[]).includes(value)
}

/** Narrow repository shape the connect-repository picker renders. */
export type RepositorySummary = {
  /** Provider-side repository id, as text — what webhook matching keys on. */
  id: string
  fullName: string
  defaultBranch: string | null
  private: boolean
  cloneUrl: string | null
}

/**
 * Commit metadata the release surface renders.
 *
 * `commitMessage` / `commitAuthor` are best-effort: a provider that cannot
 * answer them (generic SSH) omits them and every reader treats them as
 * optional. Only `commitSha` is load-bearing for the build.
 */
export type ResolvedSourceCommit = {
  commitSha: string
  commitMessage?: string
  commitAuthor?: string
}

/** Auth shape of a clone credential — mirrors the wire's `credentialKind`. */
export type CloneCredentialKind = 'token' | 'ssh_key'

/**
 * A credential minted for exactly one clone.
 *
 * Returned **unsealed**: the caller seals it to the target daemon
 * (`encryptSecretForDaemon`) and drops it. Nothing in this layer persists it.
 *
 * `username` is the HTTPS basic-auth user the host must answer git's
 * `Username` prompt with. It exists because that half of the credential is
 * *provider policy*, not a daemon default: GitHub ignores it for an
 * installation token, but GitLab authenticates an OAuth access token only when
 * the user is literally `oauth2`. Saying it here keeps the knowledge with the
 * provider that owns it — deploy-prepare and the daemon carry the string
 * opaquely and never test which provider produced it. Absent means "the host's
 * default is fine", which is every token lane but GitLab's.
 */
export type MintedCloneSecret = {
  secret: string
  kind: CloneCredentialKind
  username?: string
}

/** The `source` columns a provider needs to act on one binding. */
export type GitProviderSourceRow = {
  id: string
  provider: string
  repositoryUrl: string
  defaultBranch: string | null
  subdirectory: string | null
  connectionId: string | null
  secretId: string | null
}

/** Ambient state a provider call needs: the database plus the at-rest key. */
export type GitProviderContext = {
  db: Db
  /** Absent only where nothing sealed is read — providers must check. */
  dataEncryptionSecrets?: DerivedSecretsConfig
}

export type PrepareCloneParams = {
  row: GitProviderSourceRow
  /** Branch or tag from the compose binding, else the source's default. */
  ref: string
  /**
   * Commit the trigger already knows (a webhook push head). When set the
   * provider pins it and treats any commit lookup as decoration.
   */
  requestedCommitSha?: string
  /**
   * Whether the caller will actually clone.
   *
   * `false` on the preview path: resolve shape only — no provider round trip
   * and no token minted, because a preview runs on every editor keystroke.
   */
  needsCredential: boolean
}

/** What deploy-prepare needs for one binding. */
export type PreparedClone = {
  commit: ResolvedSourceCommit
  /**
   * Short-lived clone secret. Absent means "clone with the source's stored
   * `credential` row" — the generic-SSH and GitLab deploy-key lanes.
   */
  minted?: MintedCloneSecret
}

/**
 * A provider-side failure a retry cannot fix, reported rather than thrown.
 *
 * Deploy-prepare turns it into a `source_ref_unresolved` prepare error, which
 * is what the operator sees; throwing would surface as a 500 with no binding
 * named.
 */
export type GitProviderFailure = {
  failure: string
  /** Provider HTTP status, when the failure came from its API. */
  status?: number
}

export function isGitProviderFailure(
  value: unknown,
): value is GitProviderFailure {
  return typeof value === 'object' && value !== null && 'failure' in value
}

/**
 * A `push` delivery, in TurboPanel's vocabulary.
 *
 * `externalInstallationId` ties the delivery back to a
 * `gitConnection` row — GitHub's numeric App installation id, which
 * every delivery carries.
 *
 * **`null` is a real answer**, and GitLab is why. GitLab has no per-repository
 * install and its webhook payload names no OAuth connection, so a delivery
 * cannot say which connection it belongs to. `null` means "every live
 * connection for this provider is a candidate"; the provider-side repository
 * id then does the disambiguating, exactly as it already does within one GitHub
 * installation. See `loadInstallations` in
 * `src/client/repositories/webhook-trigger.ts`.
 */
export type ProviderPushEvent = {
  externalInstallationId: string | null
  repositoryExternalId: string
  /** Full git ref as delivered (`refs/heads/main`). */
  ref: string
  branch: string
  /** Head commit after the push; `null` when the branch was deleted. */
  commitSha: string | null
  /** The push removed the branch — no head to build, for any auto-deploy mode. */
  deleted: boolean
}

/** A CI signal that released a parked `checks_passed` SHA. */
export type ProviderCheckEvent = {
  /** `null` when the delivery names no connection — see {@link ProviderPushEvent}. */
  externalInstallationId: string | null
  repositoryExternalId: string
  commitSha: string
  /**
   * Branch ref normalized to `refs/heads/…`, matching a parked push ref.
   * `null` when the provider omitted it.
   */
  ref: string | null
}

/** An installation lifecycle event (suspend / resume / removal). */
export type ProviderInstallationEvent = {
  externalInstallationId: string
  action: string
}

export type {
  RepositoryEntry,
  RepositoryFileEntry,
  RepositoryFileSet,
  RepositoryReadUnsupported,
} from './repository-read.ts'
export {
  isRepositoryReadUnsupported,
  MAX_REPOSITORY_FILE_BYTES,
  MAX_REPOSITORY_READ_PATHS,
} from './repository-read.ts'

export type ReadRepositoryFilesParams = {
  row: GitProviderSourceRow
  ref: string
  /** Relative, `isSafeRoot`-shaped paths. */
  paths: readonly string[]
  maxBytesPerFile?: number
}

export type ListRepositoryEntriesParams = {
  row: GitProviderSourceRow
  ref: string
  path: string
  maxEntries?: number
}

/** Headers a webhook verifier may read, lower-cased by the caller. */
export type WebhookHeaders = {
  get(name: string): string | null | undefined
}

export interface GitProvider {
  readonly provider: GitProviderName

  /**
   * Repositories this installation can see. Providers that have no installation
   * concept (generic SSH) answer with an empty list rather than throwing — the
   * picker simply has nothing to offer.
   */
  listRepositories(
    ctx: GitProviderContext,
    connectionId: string,
  ): Promise<RepositorySummary[]>

  /**
   * The commit to build and, when the provider mints one, the credential that
   * clones it.
   */
  prepareClone(
    ctx: GitProviderContext,
    params: PrepareCloneParams,
  ): Promise<PreparedClone | GitProviderFailure>

  /**
   * Is this delivery authentic? `secret` is the instance-side shared secret
   * (an HMAC key for GitHub, a static token for GitLab). An absent or empty
   * secret is a configuration gap and must answer `false`, never `true`.
   */
  verifyWebhook(
    secret: string | null | undefined,
    rawBody: Uint8Array,
    headers: WebhookHeaders,
  ): Promise<boolean>

  /** `push` payload → the tuple the trigger resolver consumes, or `null`. */
  parsePush(payload: Record<string, unknown>): ProviderPushEvent | null

  /**
   * A **completed, all-green** CI payload → the released SHA, or `null`.
   * Partial success is not a release signal — see each implementation.
   */
  parseCheck(
    event: string,
    payload: Record<string, unknown>,
  ): ProviderCheckEvent | null

  /**
   * Read file contents at a ref.
   *
   * Three outcomes, and the distinction is the design:
   * - {@link RepositoryFileSet} — the read happened; per-file misses are inside.
   * - {@link GitProviderFailure} **with** `status` — the provider answered
   *   (401/403/404/429). Surface it; the daemon would get the same answer.
   * - {@link GitProviderFailure} **without** `status` — the fetch never got an
   *   HTTP answer, i.e. a reachability problem. The daemon may reach what the
   *   instance cannot, so the caller falls back. This is the whole LAN-egress
   *   story, and it needs no configuration toggle.
   * - {@link RepositoryReadUnsupported} — this provider cannot read; fall back.
   */
  readRepositoryFiles(
    ctx: GitProviderContext,
    params: ReadRepositoryFilesParams,
  ): Promise<_RepositoryFileSet | GitProviderFailure | _RepositoryReadUnsupported>

  /** Directory listing at a ref, same outcome model as {@link readRepositoryFiles}. */
  listRepositoryEntries(
    ctx: GitProviderContext,
    params: ListRepositoryEntriesParams,
  ): Promise<
    | { commitSha: string; entries: _RepositoryEntry[] }
    | GitProviderFailure
    | _RepositoryReadUnsupported
  >
}

const PROVIDERS: Record<GitProviderName, GitProvider> = {
  github: githubProvider,
  gitlab: gitlabProvider,
  git: genericGitProvider,
}

/**
 * Provider for one `source.provider` / `installation.provider` value.
 *
 * Unknown values fall back to the generic-SSH implementation rather than
 * throwing: the database `CHECK` constraint already bounds the column, and a
 * row that somehow escapes it should degrade to "clone with whatever credential
 * you were given" instead of failing a deploy with a type error.
 */
export function resolveGitProvider(provider: string): GitProvider {
  return PROVIDERS[provider as GitProviderName] ?? genericGitProvider
}

/** Provider for an inbound webhook surface. */
export function resolveWebhookGitProvider(
  provider: WebhookGitProviderName,
): GitProvider {
  return PROVIDERS[provider]
}
