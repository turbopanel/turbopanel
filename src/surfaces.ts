/** Versioned API/WS surface prefixes. */
export const HEALTH_PATH = '/api/health'
export const CLIENT_API_PREFIX = '/api/client/v1'
export const DEVELOPER_API_PREFIX = '/api/developer/v1'
export const DAEMON_API_PREFIX = '/api/daemon/v1'
export const INSTALL_API_PREFIX = '/api/install/v1'
export const ADMIN_API_PREFIX = '/api/admin/v1'
/**
 * Inbound provider webhooks — a **top-level traffic class**, not an API.
 *
 * Every other surface here authenticates a caller we enrolled: a browser with a
 * session cookie, or a daemon with a JWT. A webhook has neither. The sender is
 * GitHub, GitLab or Stripe, it carries no `Origin`, its only credential is one
 * it presents in the request itself, and what it delivers is an event rather
 * than a call. That is a different thing from `/api`, so it gets its own prefix rather
 * than a version segment inside one.
 *
 * **Anything fronting the instance must know this prefix.** `Caddyfile`,
 * `dev/orchestration/Caddyfile` (both listener blocks), and the `routes`
 * patterns in `wrangler.jsonc` all end in a catch-all that serves the UI's
 * `index.html`. A prefix missing from those lists does not 404 — it answers
 * `200` with an HTML page, and a provider reads that as a delivered webhook and
 * never retries. See `src/webhook/AGENTS.md`.
 */
export const WEBHOOK_PREFIX = '/webhook'
export const GITHUB_WEBHOOK_PATH = `${WEBHOOK_PREFIX}/github`
/**
 * Per-app GitHub ingress.
 *
 * The `:ref` segment is the app's `forge.webhook_ref`. It is **not** handed out
 * for github.com, where `X-GitHub-Hook-Installation-Target-ID` names the App on
 * every delivery and the bare path resolves cleanly. It *is* handed out for
 * GitHub Enterprise Server, where that header is the least certain — a build
 * that omits it would otherwise 401 every delivery with no way back. See
 * `webhookPathFor` in `src/lib/git/webhook-reachability.ts`.
 */
export const GITHUB_WEBHOOK_SCOPED_PATH = `${GITHUB_WEBHOOK_PATH}/:ref`
/**
 * GitLab's sibling surface. Same reasoning as {@link GITHUB_WEBHOOK_PATH} and
 * the same gate order, with one weaker credential: GitLab does not sign
 * deliveries, so the route authenticates on the static `X-Gitlab-Token` header
 * instead of an HMAC over the body (`src/lib/git/gitlab-webhook.ts`).
 */
export const GITLAB_WEBHOOK_PATH = `${WEBHOOK_PREFIX}/gitlab`
/** {@link GITHUB_WEBHOOK_SCOPED_PATH}'s counterpart; self-managed GitLab only. */
export const GITLAB_WEBHOOK_SCOPED_PATH = `${GITLAB_WEBHOOK_PATH}/:ref`
/**
 * Inbound Stripe events — a **billing** kind that shares the git kinds' traffic
 * class, and for the same reason: no session, no daemon JWT, no `Origin`, the
 * only credential is the `Stripe-Signature` the sender puts on the request,
 * and what arrives is an event rather than a call. Same gate, same order
 * (`src/webhook/billing/stripe.ts`).
 *
 * There is **no** `:ref` variant. An instance holds one Stripe account and
 * one signing secret, so there is nothing to disambiguate in the URL.
 *
 * `/webhook/*` is already forwarded by every fronting layer, so this path
 * inherits the plumbing — and `src/surfaces.test.ts` checks that rather than
 * assuming it. Local forwarding must use this exact path:
 * `stripe listen --forward-to <instance>/webhook/stripe`.
 */
export const STRIPE_WEBHOOK_PATH = `${WEBHOOK_PREFIX}/stripe`
export const CLIENT_WS_PATH = '/ws/client/v1'
export const DEVELOPER_WS_PATH = '/ws/developer/v1'
export const DAEMON_WS_PATH = '/ws/daemon/v1'
