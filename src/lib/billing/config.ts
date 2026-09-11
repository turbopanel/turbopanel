/**
 * Billing configuration — and the whole feature gate.
 *
 * `resolveBillingConfig` returns `null` when the Stripe secret key is absent or
 * blank. That config is what admin catalogue routes and `/webhook/stripe` hold.
 * **Customer billing** — `billingEnabled` on `GET /api/client/v1/status`, and
 * every `/billing/*` route — is operational only when the webhook signing secret
 * is non-empty as well ({@link isCustomerBillingOperational}). An API-key-only
 * instance can still bind products; it does not expose Checkout or the billing
 * UI, and `/webhook/stripe` answers `503 stripe_webhook_not_configured`.
 *
 * Only `src/workers.ts` resolves this, per request from the binding env (so a
 * dashboard secret change applies without an isolate recycle), and publishes
 * it as `c.get('billingConfig')`. The Deno runtime never does: billing is
 * hosted-only and self-hosted mounts no billing surface. Nothing else parses
 * the env for Stripe values.
 *
 * Workers-bundleable: no `@std/*`, no `Deno.*`, nothing at module load.
 */

/** Env keys. Both secrets are `wrangler secret put` values, never `vars`. */
export const STRIPE_SECRET_KEY_ENV = "TURBOPANEL_STRIPE_SECRET_KEY";
export const STRIPE_WEBHOOK_SIGNING_SECRET_ENV =
  "TURBOPANEL_STRIPE_WEBHOOK_SIGNING_SECRET";
/** Optional override of {@link DEFAULT_STRIPE_API_VERSION}. */
export const STRIPE_API_VERSION_ENV = "TURBOPANEL_STRIPE_API_VERSION";

/**
 * The `Stripe-Version` every request pins.
 *
 * Pinned in code rather than inherited from the account's dashboard default,
 * because the account default can be bumped by anyone with dashboard access
 * and a version bump changes response shapes (`current_period_end` moved from
 * the subscription to its items in the `basil` line). Bumping this constant
 * is a code change that runs the tests.
 */
export const DEFAULT_STRIPE_API_VERSION = "2025-08-27.basil";

export type BillingConfig = Readonly<{
  /** `sk_live_…` / `sk_test_…`. Presence is what builds a config at all. */
  secretKey: string;
  /**
   * `whsec_…`. May be absent while the key is present — customer billing then
   * stays off, and the webhook gate answers `503 stripe_webhook_not_configured`,
   * never an unverified accept.
   */
  webhookSigningSecret: string | null;
  apiVersion: string;
}>;

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `null` when this instance has no Stripe API key. Never throws: a malformed
 * optional value falls back to its default. Customer billing still needs
 * {@link isCustomerBillingOperational}.
 */
export function resolveBillingConfig(
  env: Record<string, string | undefined> | undefined,
): BillingConfig | null {
  const secretKey = nonBlank(env?.[STRIPE_SECRET_KEY_ENV]);
  if (!secretKey) return null;
  return {
    secretKey,
    webhookSigningSecret: nonBlank(env?.[STRIPE_WEBHOOK_SIGNING_SECRET_ENV]),
    apiVersion: nonBlank(env?.[STRIPE_API_VERSION_ENV]) ??
      DEFAULT_STRIPE_API_VERSION,
  };
}

/**
 * Customer billing — Checkout, the billing UI, hosted license minting — is
 * on only when both the API key and the webhook signing secret are present.
 * An API-key-only config is not operational: webhooks cannot be verified, so
 * a completed Checkout would never project.
 */
export function isCustomerBillingOperational(
  config: BillingConfig | null | undefined,
): config is BillingConfig & { webhookSigningSecret: string } {
  return typeof config?.webhookSigningSecret === "string" &&
    config.webhookSigningSecret.length > 0;
}
