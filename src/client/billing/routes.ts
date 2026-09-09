/**
 * Billing client surface — `/api/client/v1/billing/*`.
 *
 * Owner-only (`assertOrgOwnerOr403`, the same guard as licenses), session
 * middleware on every path, and **`503 billing_not_configured`** on every
 * route when `c.get('billingConfig')` is absent — self-hosted has no
 * billing surface at all.
 *
 * Mounted by `registerClientRoutes` on Workers only. `GET` routes read
 * Postgres only. The mutation routes may call the provider (they are
 * neither ingest nor page load). The quantity mutations are
 * `mutations.ts` — `changeSeats`, `upgradeTier`, `downgradeTier` — which
 * the routes call after parsing the body and answer with verbatim; each
 * one wraps the organization's quantity lease in `try/finally` and answers
 * `409 billing_mutation_in_progress` while another holder has it. The live
 * harness drives the same three functions.
 *
 * Nothing on this surface names a license or a server: an admin buys and
 * releases *quantities* per tier, and which server sits where is derived
 * (`src/lib/tiers/assignment.ts`).
 */

import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDb, type Db } from '../../db.ts'
import { createStripeClient, type StripeClient } from '../../lib/billing/client.ts'
import type { BillingConfig } from '../../lib/billing/config.ts'
import {
  checkoutReturnUrls,
  createCheckoutSession,
  ensureCustomerForOrganization,
} from '../../lib/billing/checkout.ts'
import { seatLinesFromState } from '../../lib/billing/entitlements.ts'
import { resolveBillingGateway } from '../../lib/billing/gateway.ts'
import { createPortalSession } from '../../lib/billing/portal.ts'
import {
  type BillingQuantityLock,
  endQuantityMutation,
  tryBeginQuantityMutation,
} from '../../lib/billing/quantity-lock.ts'
import {
  buildItemMutation,
  previewSubscriptionChange,
  type TierDelta,
} from '../../lib/billing/subscriptions.ts'
import { resolveTierPrice } from '../../lib/billing/tier-prices.ts'
import { listActiveTiers } from '../../lib/db/tier-records.ts'
import { resolvePublicBaseUrl } from '../../lib/resolve-public-base-url.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertOrgOwnerOr403 } from '../authz/index.ts'
import { getOrgId } from '../shared.ts'
import {
  type BillingMutationDeps,
  type BillingMutationOutcome,
  changeSeats,
  downgradeTier,
  upgradeTier,
} from './mutations.ts'
import {
  assertTierChangeAllowed,
  BILLING_MUTATION_IN_PROGRESS_ERROR,
  BILLING_NOT_CONFIGURED_ERROR,
  type BillingOrgView,
  hasLiveSubscription,
  loadBillingOrgView,
  PARSE_UUID_INVALID,
  parseJsonObjectBody,
  readIntField,
  readUuidField,
  serializeSubscriptionSummary,
  serializeTier,
  stripeErrorResponse,
  SUBSCRIPTION_EXISTS_ERROR,
  TIER_NOT_PURCHASABLE_ERROR,
} from './routes-helpers.ts'

/** Test seams: every Postgres read and the Stripe client are injectable. */
export type BillingRouteDeps = Readonly<{
  createClient?: (config: BillingConfig) => StripeClient
  loadView?: (db: Db, organizationId: string, nowMs: number) => Promise<BillingOrgView>
  beginMutation?: (db: Db, organizationId: string, nowMs: number) => Promise<BillingQuantityLock | null>
  endMutation?: (db: Db, lock: BillingQuantityLock) => Promise<void>
  nowMs?: () => number
}>

const BILLING_PATHS = [
  '/billing/catalog',
  '/billing/subscription',
  '/billing/checkout',
  '/billing/portal',
  '/billing/preview',
  '/billing/seats',
  '/billing/upgrade',
  '/billing/downgrade',
] as const

type Ctx = Context<AppEnv>

type Authed = { db: Db; organizationId: string; config: BillingConfig; userEmail: string | null }

/** Session → org → owner → billing on. The order keeps 401/403 ahead of 503. */
async function authenticate(c: Ctx): Promise<Authed | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult
  const denied = await assertOrgOwnerOr403(c, 'organization', orgResult)
  if (denied) return denied
  const config = c.get('billingConfig')
  if (!config) return c.json({ error: BILLING_NOT_CONFIGURED_ERROR }, 503)
  return { db, organizationId: orgResult, config, userEmail: session.email ?? null }
}

async function readBody(c: Ctx): Promise<Record<string, unknown> | Response> {
  const parsed = parseJsonObjectBody(await c.req.text().catch(() => ''))
  if (parsed === 'invalid') return c.json({ error: 'Invalid request' }, 400)
  return parsed ?? {}
}

/**
 * Turn a request body into per-tier deltas: `{ tierId, delta }` for a
 * quantity change, or `{ fromTierId, toTierId }` for a tier move.
 */
function deltasFromBody(c: Ctx, body: Record<string, unknown>): TierDelta[] | Response {
  const fromTierId = readUuidField(body, 'fromTierId')
  const toTierId = readUuidField(body, 'toTierId')
  const tierId = readUuidField(body, 'tierId')
  const delta = readIntField(body, 'delta')
  if (
    fromTierId === PARSE_UUID_INVALID ||
    toTierId === PARSE_UUID_INVALID ||
    tierId === PARSE_UUID_INVALID ||
    delta === 'invalid'
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (fromTierId && toTierId && fromTierId !== toTierId) {
    return [{ tierId: fromTierId, delta: -1 }, { tierId: toTierId, delta: 1 }]
  }
  if (tierId && delta !== null && delta !== 0) return [{ tierId, delta }]
  return c.json({ error: 'Invalid request' }, 400)
}

/** Send a mutation's outcome verbatim; a Stripe failure maps as everywhere else. */
async function answer<T extends Record<string, unknown>>(
  c: Ctx,
  run: () => Promise<BillingMutationOutcome<T>>,
): Promise<Response> {
  try {
    const outcome = await run()
    return c.json(outcome.body, outcome.status)
  } catch (err) {
    return stripeErrorResponse(c, err)
  }
}

function readTierMove(c: Ctx, body: Record<string, unknown>, withProration: boolean) {
  const fromTierId = readUuidField(body, 'fromTierId')
  const toTierId = readUuidField(body, 'toTierId')
  const prorationDate = withProration ? readIntField(body, 'prorationDate') : null
  if (
    fromTierId === PARSE_UUID_INVALID || !fromTierId ||
    toTierId === PARSE_UUID_INVALID || !toTierId ||
    prorationDate === 'invalid'
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return { fromTierId, toTierId, prorationDate }
}

export function registerBillingRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
  deps: BillingRouteDeps = {},
): void {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for billing routes')
  }
  const secrets = opts.secrets
  const createClient = deps.createClient ?? ((config: BillingConfig) => createStripeClient(config))
  const loadView = deps.loadView ?? loadBillingOrgView
  const beginMutation = deps.beginMutation ?? tryBeginQuantityMutation
  const endMutation = deps.endMutation ?? endQuantityMutation
  const nowMs = deps.nowMs ?? (() => Date.now())

  for (const path of BILLING_PATHS) router.use(path, createSessionMiddleware(secrets))

  /** Run `work` under the organization's lease; `409` when it is held. */
  async function underLease(
    c: Ctx,
    auth: Authed,
    work: (lock: BillingQuantityLock) => Promise<Response>,
  ): Promise<Response> {
    const lock = await beginMutation(auth.db, auth.organizationId, nowMs())
    if (!lock) return c.json({ error: BILLING_MUTATION_IN_PROGRESS_ERROR }, 409)
    try {
      return await work(lock)
    } finally {
      await endMutation(auth.db, lock).catch(() => {})
    }
  }

  router.get('/billing/catalog', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const tiers = await listActiveTiers(auth.db)
    return c.json({ tiers: tiers.map(serializeTier) })
  })

  router.get('/billing/subscription', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const view = await loadView(auth.db, auth.organizationId, nowMs())
    return c.json(serializeSubscriptionSummary(view))
  })

  router.post('/billing/checkout', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const body = await readBody(c)
    if (body instanceof Response) return body
    const tierId = readUuidField(body, 'tierId')
    const quantity = readIntField(body, 'quantity') ?? 1
    if (tierId === PARSE_UUID_INVALID || !tierId || quantity === 'invalid' || quantity < 1) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    const view = await loadView(auth.db, auth.organizationId, nowMs())
    if (hasLiveSubscription(view)) return c.json({ error: SUBSCRIPTION_EXISTS_ERROR }, 409)

    return await underLease(c, auth, async () => {
      const client = createClient(auth.config)
      try {
        const price = await resolveTierPrice(auth.db, resolveBillingGateway(client), tierId)
        if (!price.ok) {
          return c.json({ error: TIER_NOT_PURCHASABLE_ERROR, reason: price.reason, failures: price.failures ?? [] }, 400)
        }
        const { providerCustomerId } = await ensureCustomerForOrganization(auth.db, client, {
          organizationId: auth.organizationId,
          email: auth.userEmail,
        })
        const urls = checkoutReturnUrls(await resolvePublicBaseUrl(c, opts), auth.organizationId)
        const session = await createCheckoutSession(client, {
          providerCustomerId,
          providerPriceId: price.providerPriceId,
          quantity,
          successUrl: urls.successUrl,
          cancelUrl: urls.cancelUrl,
          idempotencyKey: crypto.randomUUID(),
        })
        return c.json({ url: session.url, sessionId: session.sessionId })
      } catch (err) {
        return stripeErrorResponse(c, err)
      }
    })
  })

  router.post('/billing/portal', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const view = await loadView(auth.db, auth.organizationId, nowMs())
    if (!view.state.payer) return c.json({ error: 'Not found' }, 404)
    const client = createClient(auth.config)
    try {
      const urls = checkoutReturnUrls(await resolvePublicBaseUrl(c, opts), auth.organizationId)
      const session = await createPortalSession(client, {
        providerCustomerId: view.state.payer.providerCustomerId,
        returnUrl: urls.portalReturnUrl,
      })
      return c.json({ url: session.url })
    } catch (err) {
      return stripeErrorResponse(c, err)
    }
  })

  router.post('/billing/preview', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const body = await readBody(c)
    if (body instanceof Response) return body
    const deltas = deltasFromBody(c, body)
    if (deltas instanceof Response) return deltas
    const view = await loadView(auth.db, auth.organizationId, nowMs())
    const denied = assertTierChangeAllowed(c, view)
    if (denied) return denied
    const client = createClient(auth.config)
    const gateway = resolveBillingGateway(client)
    const { lines, priceByTier } = seatLinesFromState(view.state)
    try {
      for (const { tierId, delta } of deltas) {
        if (delta > 0 && !priceByTier.has(tierId)) {
          const price = await resolveTierPrice(auth.db, gateway, tierId)
          if (!price.ok) {
            return c.json({ error: TIER_NOT_PURCHASABLE_ERROR, reason: price.reason, failures: price.failures ?? [] }, 400)
          }
          priceByTier.set(tierId, price.providerPriceId)
        }
      }
      let items
      try {
        items = buildItemMutation(lines, deltas, priceByTier)
      } catch {
        return c.json({ error: 'Invalid request' }, 400)
      }
      const preview = await previewSubscriptionChange(client, {
        providerSubscriptionId: view.state.subscription!.providerSubscriptionId,
        items,
        nowMs: nowMs(),
      })
      return c.json(preview)
    } catch (err) {
      return stripeErrorResponse(c, err)
    }
  })

  /** The mutation module's seams are the routes' seams, forwarded. */
  function mutationDeps(auth: Authed): BillingMutationDeps {
    return {
      db: auth.db,
      client: createClient(auth.config),
      loadView,
      beginMutation,
      endMutation,
      nowMs,
    }
  }

  router.post('/billing/seats', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const body = await readBody(c)
    if (body instanceof Response) return body
    const tierId = readUuidField(body, 'tierId')
    const delta = readIntField(body, 'delta')
    const prorationDate = readIntField(body, 'prorationDate')
    if (
      tierId === PARSE_UUID_INVALID ||
      !tierId ||
      delta === 'invalid' ||
      delta === null ||
      delta === 0 ||
      prorationDate === 'invalid'
    ) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    return await answer(c, () =>
      changeSeats(mutationDeps(auth), { organizationId: auth.organizationId, tierId, delta, prorationDate }))
  })

  router.post('/billing/upgrade', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const body = await readBody(c)
    if (body instanceof Response) return body
    const move = readTierMove(c, body, true)
    if (move instanceof Response) return move
    return await answer(c, () =>
      upgradeTier(mutationDeps(auth), { organizationId: auth.organizationId, ...move }))
  })

  router.post('/billing/downgrade', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const body = await readBody(c)
    if (body instanceof Response) return body
    const move = readTierMove(c, body, false)
    if (move instanceof Response) return move
    return await answer(c, () =>
      downgradeTier(mutationDeps(auth), { organizationId: auth.organizationId, fromTierId: move.fromTierId, toTierId: move.toTierId }))
  })
}
