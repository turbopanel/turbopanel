# Billing — AGENTS.md

The Stripe integration's transport and the projection it feeds. This
directory is the *only* place that talks to Stripe; `src/lib/db/billing-records.ts`
is the only place that writes what it learns; `src/webhook/billing/stripe.ts`
is the only way anything arrives.

```
src/lib/billing/
├── config.ts             BillingConfig + resolveBillingConfig — the feature gate
├── client.ts             createStripeClient — get / post / del / listAll
├── form-encode.ts        Stripe's bracket-syntax form encoding (pure)
├── errors.ts             StripeApiError, permanent vs transient
├── webhook-signature.ts  Stripe-Signature over raw bytes, tolerance, multi-v1
├── customer-subject.ts   customer.metadata → organization or user
├── quantity-lock.ts      the per-organization mutation lease
├── pending-changes.ts    the per-organization intent ledger (a `setting` row)
├── subscriptions.ts      the mutation surface — the only module that changes items
├── schedules.ts          deferred changes: subscription-schedule phases, `mutateSubscription`
├── entitlements.ts       ledger → `applySeatEntitlements` → schedule rebuild, under the lease
├── seat-increase.ts      the in-flight seat raise's idempotency key + params, persisted before Stripe
├── checkout.ts           first purchase (hosted Checkout) + customer creation
├── portal.ts             Customer Portal: invoices and payment methods only
├── grace-clock.ts        maintenance phase: cancel what Stripe leaves past due
├── reconcile.ts          maintenance phase: seats vs licenses, alert only
├── catalogue.ts          the S1…S7 + SX ladder — the admin form's defaults (pure)
├── tier-verify.ts        read-only Stripe check gating every hand-entered tier row
└── test-clock.ts         /v1/test_helpers/test_clocks, for the live harness only

src/client/billing/mutations.ts        changeSeats / upgradeLicense / downgradeLicense — the
                                       route bodies as functions; the routes and the harness call them
scripts/billing-test-clock-harness.ts  C16 — six lifecycle scenarios on test clocks
```

## Stripe owns money, Postgres owns entitlement

Stripe is the system of record for what a customer has paid for. Postgres —
`payer`, `subscription`, `seat` (`src/lib/db/AGENTS.md`) — is the system of
record for what an organization is *entitled to* right now. The webhook
ingress copies the former into the latter; nothing copies the other way.

The projection exists because of where entitlement is read. Tier placement,
license minting, and the **metrics truncation that runs on every sample**
all need "how many seats at which tier" — a Stripe call there is impossible
on cost alone, and it would also mean a Stripe outage breaks monitoring.
So: **nothing on the ingest or page-load path may call Stripe.** Reads are
local rows; Stripe is called only from the webhook's deferred task, from the
explicit mutation routes (`src/client/billing/`, the license revoke gate), and
from the grace clock on the maintenance tick. The reconciliation sweep reads
Postgres only.

## The switch

`resolveBillingConfig(env)` returns `null` when `TURBOPANEL_STRIPE_SECRET_KEY`
is absent or blank, and that `null` **is** billing off. There is no separate
boolean. `src/workers.ts` resolves it per request from the binding env (so a
dashboard secret change applies without an isolate recycle) and publishes it
as `c.get('billingConfig')`. Presence is what `GET /api/client/v1/status`
reports as `billingEnabled`, so the console hides the billing area wholesale
when it is off without a second probe. The key itself never leaves the
server. The Deno runtime never resolves it: see *Billing runs on Workers,
not Deno* below.

Both `TURBOPANEL_STRIPE_SECRET_KEY` and
`TURBOPANEL_STRIPE_WEBHOOK_SIGNING_SECRET` are **secrets**
(`wrangler secret put`), never `vars` in `wrangler.jsonc`; `keep_vars: true`
protects dashboard-set values across deploys. `TURBOPANEL_STRIPE_API_VERSION`
is an optional override of the pin below.

A Workers deployment with no key: the three tables exist and are empty,
`/webhook/stripe` answers `503 stripe_webhook_not_configured`, no Stripe call
is ever made, the UI hides billing. A self-hosted (Deno) instance has none of
those routes at all — `404`, not `503`.

## Why there is no `stripe` npm package

The SDK brings a Node HTTP stack and module-load crypto that the Workers
bundle rejects (Cloudflare error 10021 — `src/workers.ts` imports this tree on
boot, and `pnpm check:workers-bundle` is the guard). The calls this instance
makes are a handful of HTTPS requests with three headers, so `client.ts` is a
few hundred lines over `fetch`, `crypto.subtle` and `URLSearchParams`. Rules
that come with owning the transport:

- **No `@std/*`, no bare `jsr:`**, and no `crypto` / `fetch` / `setTimeout`
  at module load anywhere in this directory. `AbortSignal.timeout` and the
  comparison key are minted per call.
- **Every mutating call carries an `Idempotency-Key`.** `post` and `del` mint
  one with `crypto.randomUUID()` when the caller supplies none, so it cannot
  be forgotten. A caller that retries a mutation must pass the *same* key it
  used the first time — Stripe will otherwise happily create a second
  subscription.
- **`Stripe-Version` is pinned** (`DEFAULT_STRIPE_API_VERSION`). The account's
  dashboard default can be bumped by anyone with dashboard access, and a bump
  changes response shapes: in the `basil` line `current_period_end` moved
  from the subscription to its items, and `invoice.subscription` moved under
  `invoice.parent.subscription_details`. The projection reads both shapes;
  bumping the pin is a code change that runs the tests.
- Form encoding follows Stripe's bracket syntax (`form-encode.ts`), and the
  `null` (clear this field) vs `undefined` (leave it alone) distinction is
  load-bearing for partial updates.
- `listAll` walks `has_more` / `starting_after` with a hard page cap and
  throws rather than looping or silently truncating.
- A non-2xx body becomes a `StripeApiError` with `type`, `code`, `param` and
  a `permanent` / `transient` classification; the raw body is never retained
  and never reaches a client response.

## Signature verification

`verifyStripeSignature(rawBody, header, secret)` — HMAC-SHA256 over
`${t}.${rawBody}`, the **raw bytes** the gate read before any parse. Every
`v1=` element is tried (Stripe sends two during a secret roll), `v0=` is
ignored, and `t` must be inside a 300 s tolerance — replay protection
independent of the delivery ledger, which only stops the *same* event landing
twice. Comparison goes through `timingSafeSecretEquals` from
`src/lib/git/gitlab-webhook.ts`; the fact that billing imports one helper from
`git` is deliberate and the reverse direction does not exist.

## Which subject a customer is

A Stripe `Customer` names its TurboPanel subject in `metadata`:
`turbopanel_organization_id` **or** `turbopanel_user_id`, exactly one
(`customer-subject.ts`). The projection reads it from the **refetched**
customer, never the event payload. A customer naming neither, both, or a
malformed id is logged and skipped. This is the same exactly-one rule
`payer_subject_check` enforces at the table.

## The quantity lease

Stripe has no compare-and-swap, and a subscription update **replaces the
whole `items` array**. Two concurrent mutations for one organization would
each read the items, each compute a new array, and the second write would
undo the first. `quantity-lock.ts` therefore serialises quantity mutations
per organization.

It is a `setting`-row lease, not `pg_advisory_lock`: advisory locks are
session-scoped and **unsupported on the Workers/Hyperdrive path**, where
sessions are pooled. The implementation is a direct port of
`tryBeginReencryptSweep` in `src/admin/reencrypt-secrets.ts`: insert-or-steal
only when expired *and* the compare-and-set on the exact previous value still
matches; release is owner-scoped so a stolen lease is never released by its
former holder. Key `BILLING_QUANTITY_LOCK:<organizationId>`, TTL 60 s (a
Stripe round trip plus the projection write). Rows are transient — created
on mutation, deleted on release.

Holders: every `/billing/*` mutation route, the hosted license mint (the
free-seat read and the insert), the license revoke gate, and the entitlement
sync the webhook task runs after a projection. A held lease answers
`409 billing_mutation_in_progress` on a route; the webhook task logs and
skips the sync (the seat rows are still written — they are Stripe's truth) and
the mutation holder, which runs the same sync before releasing, catches up.

## The mutation surface

Seats are bought through Stripe; keys are minted by the operator against a
free seat. Seat *purchase* and key *minting* are separate acts because a
license token is shown once at creation, so nothing on a webhook can mint a
usable key.

`subscriptions.ts` is the only module that changes a subscription's items,
`schedules.ts` the only one that parks a change for later, and
`buildItemMutation` the only function that produces an `items[]` array — it
always emits `quantity` beside `items[n][id]`, because sending `id` or
`price` alone makes Stripe reset the quantity to **1** with a `200`.

**One raise path.** Every entitlement-raising mutation goes out with
`payment_behavior=pending_if_incomplete`. When the proration invoice cannot
be paid, Stripe parks the change under `subscription.pending_update` and
leaves `subscription.items` alone; the projection reads `items` only, so an
unpaid change never raises entitlement and there is no second gate to keep
in step. The projection reads `pending_update` for its *presence* alone,
which stops an upgrade intent being consumed early on the `updated` event
Stripe sends when it parks the change.

**The schedule is the only deferral.** A downgrade or a seat removal is a
second phase on a subscription schedule starting at `current_period_end`;
the first phase restates the current items. That is how "decreases generate
no proration" is achieved — `proration_behavior` is never set to the
disabling value anywhere here. Rules: every update resends **every** phase
(a partial list rewrites history); the future phase is recomputed from
scratch as *current seats + all outstanding deferred intents*; phase items
are `price` + `quantity`, never `items[n][id]`; and `mutateSubscription`
**releases** the schedule before any immediate change (editing items under
a schedule auto-splits the phase), then rebuilds it from the intents that
survived in the ledger.

**Giving back the last seat cancels at the boundary.** A phase needs at
least one item, so when the outstanding intents empty the subscription the
schedule is written with the current phase alone and `end_behavior=cancel`:
paid-for until the period ends, cancelled there. A release (the first step
of every immediate change) drops that pending cancellation by default —
`preserve_cancel_date` is never sent — so buying a seat again before the
boundary resumes the subscription. Verified against the API reference; the
live confirmation belongs to the harness.

**Anchor and mode.** `SUBSCRIPTION_ANCHOR_PARAMS` spells the invariant once:
flexible billing mode, `billing_cycle_anchor_config` at day 1 / 00:00:00
UTC, and no `proration_behavior` on create so the default prorates the
first month. Checkout passes the same block under `subscription_data`
(verified accepted on the pinned `2025-08-27.basil` version).

## The pending-change ledger

A Stripe pending update or schedule phase carries no TurboPanel identity —
"one fewer S3, one more S5", never "server X's seat". So every mutation
first records an **intent** in `BILLING_PENDING_CHANGES:<organizationId>`
(`pending-changes.ts`, a `setting` row like the lease — no migration),
keyed to the exact `license.id` it moves, with the `idempotencyKey` minted
once and reused on every retry of that Stripe call. `upgrade` intents live
24 h (one hour past Stripe's 23 h pending-update expiry) and are pruned on
read; `downgrade` / `release-seat` intents live until the boundary. The
ledger names its `providerSubscriptionId` so a re-subscribe reads empty.

A seat **increase** names no license, so it has no intent in the ledger.
Its key lives in `BILLING_SEAT_INCREASE:<organizationId>` instead
(`seat-increase.ts`, another `setting` row under the lease): `changeSeats`
writes the key together with the tier, delta, the `items[]` array and the
proration date **before** calling Stripe, replays exactly those on a retry of
the same `(tierId, delta)` (never items rebuilt from seat rows a webhook may
have moved meanwhile — Stripe answers `idempotency_error` to a reused key
with different params), and clears the row once the reprojection has landed — or at once on
a permanent Stripe refusal, which applied nothing. A transient failure after
Stripe accepted the update (the reprojection refetch timing out, say) keeps
the row, so the console's retry cannot buy the seats a second time. Records
expire with Stripe's 24 h key window.

After each projection (and at the end of each mutation route, under the
same lease) `entitlements.ts` reads the ledger and calls
`applySeatEntitlements` (`src/lib/db/billing-records.ts`), which moves
`license.tier_id` **only when the committed seats show the change landed**,
closes residual gaps with unbound licenses only, and reports a gap only a
bound license could close as drift. On `pending_update_expired` the upgrade
intents are dropped and logged; the console offers a retry.

## Grace clock and reconciliation

`grace-clock.ts` owns cancellation. Stripe's dunning is configured in the
Dashboard and stays `past_due` forever by design; the projection latches
`grace_expires_at = past_due_since + BILLING_GRACE_WINDOW_MS` (the constant
beside the latch in `billing-records.ts` is the only place the length is
written), and the maintenance tick (`runGraceClock`) cancels what is still
delinquent after it — `DELETE /v1/subscriptions/:id` keyed on
`(subscription, expiry)` so a retried tick replays — then reprojects, which
is what revokes the licenses, bound ones included. Leftover credit is
forfeited; there is no refund call anywhere.
`runGraceClockForSubscription` is the same step narrowed to one provider
subscription id: it exists for the live harness, which must never run the
batch against a shared development database (it would cancel whatever
other delinquent rows were there), and nothing in the instance calls it.

`reconcile.ts` compares `seat.quantity` to `countActiveLicensesByTier` per
tier per organization and asserts the quantity never falls below the bound
subset. **Alert, never auto-correct**: an error-level structured log and the
last report in `BILLING_RECONCILE_REPORT` for the admin surface. No Stripe
write, no license write.

Both run as optional phases of the Workers maintenance cron
(`src/daemon/cell/offline-sweep.ts`, minute-divisor predicates, each isolated
by `runOptionalPhase`), and are skipped entirely when `resolveBillingConfig`
returns `null`. The Deno maintenance tick has no billing phases.

## Footguns that return `200`

- The raw anchor-timestamp parameter (the one *without* the `_config`
  suffix) on an existing subscription silently resets the anchor.
- `proration_behavior` set to the disabling value silently waives a credit
  the customer was owed.

`subscriptions.hostfree.test.ts` scans every non-test file in this
directory and fails on either spelling.

## Tier catalogue (C15)

**Nothing seeds the catalogue.** There is one High-Availability instance
and fewer than ten plans, and no script should hold the ability to write
its own catalogue — so the seed script is gone. The owner creates the
Products and Prices in the Stripe Dashboard by hand, and a superadmin
types the `tier` rows in under Admin → Tiers.

`catalogue.ts` is what survives of it: the S1…S7 + SX ladder as the
**defaults the admin form prefills**, so the operator supplies only the one
field nothing can derive — the Stripe price id. It writes nothing and is
imported by the form, not by any writer.

`tier-verify.ts` is the gate. Saving a row runs one
`GET /v1/prices/:id?expand[]=product` and refuses on any failure, because a
wrong price id is **not** loud downstream: the projection logs and skips
subscription items whose price maps to no tier, so a typo silently loses
entitlement instead of erroring. Every check is code-dependent — `active`
and `product.active` (the purchasable gate assumes live), monthly
`interval` with `interval_count` 1 (schedule phases and the anchor config
assume it), `billing_scheme = per_unit` (seats are `quantity`; tiered
pricing breaks the proration maths), `currency` and `unit_amount` matching
`price_cents` (the UI shows it, the harness compares invoice totals to it),
and `tax_behavior` not `unspecified` (automatic tax fails against such a
price without an account default). `livemode`, `product.name`, `nickname`,
`lookup_key` and `metadata` come back for the operator to eyeball; nothing
reads them. In particular the lookup key stopped being an idempotency
handle when the seed died — it is now Dashboard decoration.

Writes go through `insertTier` / `updateTierById` in
`src/lib/db/tier-records.ts`. The insert is **plain**, not an upsert: the
seed's converge-on-`(generation, label)` was right for a script that owned
the catalogue and wrong behind a form, where an operator mistyping a label
that matches an existing row would silently overwrite that row's
entitlements. `uniq_tier_generation_label` raises and the route answers
`409`. Two further indexes close gaps the seed's discipline used to cover:
`uniq_tier_generation_rank` (rank decides upgrade-versus-downgrade
direction, so a tie makes it undefined) and a partial
`uniq_tier_provider_price_id` where not null (the projection's price→tier
map would otherwise resolve a duplicate to whichever row it saw last).

Rows are **deactivated, never deleted**, and once any license or seat
references a row only `is_active` and `successor_id` may change — the
entitlement columns are what that row's history was written in terms of.

SX is a row with no price and no price id, so it is never purchasable.
When a negotiated deal exists, sales creates that customer's Price and a
superadmin sets it on the SX row or on a per-customer custom row.

## Live harness (C16)

`deno task billing:test-clocks` (or
`deno test -A scripts/billing-test-clock-harness.test.ts`) runs six
scenarios, each on its own Stripe **test clock** and its own throw-away
organization; both, and the organization's ledger and lease rows, are
deleted in a `finally`:

| Scenario                 | Proves                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `partial-first-month`    | C2: signup mid-month — day-1 anchor, one prorated first invoice, `active` projection, no latch                                                                                |
| `mid-cycle-upgrade`      | C4/C6: `upgradeLicense` on a failing card is parked (`pending: true`); seats, ledger and `license.tier_id` are unchanged, a reprojection raises nothing; paying the open proration makes Stripe apply it (`pending_update_applied`), and only then does the projection add the S5 seat, repoint the license and consume the intent |
| `deferred-downgrade`     | C5/C7: `downgradeLicense` parks S5 → S3 on a schedule; seats and license hold until the boundary, then S3 replaces S5, the ledger consumes the intent, and the renewal bills S3 with no proration invoice |
| `quantity-up-down`       | C3/C5, one scenario: `changeSeats(+2)` is immediate and invoiced (`always_invoice`); `changeSeats(−1)` is a `release-seat` intent on a schedule that lands at the boundary, `current_period_end` rolls, and the renewal bills the reduced quantity at full price |
| `upgrade-while-past-due` | C8: after a failed renewal `upgradeLicense` and `changeSeats(+1)` answer `409 subscription_past_due` (naming `graceExpiresAt`) with **zero** Stripe writes, no intent, no invoice, lease released; paying the renewal clears both latches and the same upgrade then applies |
| `dunning-retry-window`   | C13: the failed renewal latches `past_due` + grace; the clock is walked through Smart Retries' window a fortnight at a time with the status delinquent, the latches held and the seat and license intact; `runGraceClockForSubscription` does nothing a millisecond early and at expiry cancels, reprojects to `canceled`, zero seats, license revoked; a second tick is a no-op |

Every seat or tier change is made through `src/client/billing/mutations.ts`
— the bodies of the `/billing/*` routes, called with the same deps the
routes pass — and then read back through `projectSubscriptionById`, the
seam the webhook task ends in. Assertions are on the rows production
reads, never on Stripe's objects. Nothing in the harness writes
`license.tier_id`, `license.revoked_at` or a ledger row directly; minting a
license is the one direct write, as setup. The scenario's test clock is
its wall clock — projection `now`, intent timestamps, `prorationDate` and
the grace clock's `nowMs` all read the frozen time — so a latch written at
a simulated boundary and a sweep run at a simulated expiry agree.

It is service-dependent (`scripts/check-test-inventory.mjs`) and never
runs in CI. The traps live in the shared helpers, not the scenarios:
customers are created **on** the clock (a clock cannot be attached later);
`advance` is asynchronous and is polled to `ready`; invoices settle about
an hour after a boundary, so `advanceAndSettle` adds one; invoice lists are
always filtered by subscription; consecutive mutations are separated by a
few simulated minutes; a paid pending update is polled to applied; a clock
advances at most a couple of billing intervals per call, so the retry
window is stepped; cards are test **tokens** (`tok_visa`,
`tok_chargeCustomerFail` — attaches, then fails every charge).

## Local development

Billing only exists in the Workers build, so local billing work means the
**Workers dev instance** (`turbopanel_instance_runtime: workers`: the
instance unit runs `scripts/workers-serve.sh` → `wrangler dev`, every
binding in local mode, Caddy in front on the usual port). Three things the
dev VM does for you, all in the daemon's `instance-launch` role:

- **Cron.** `wrangler dev` never fires the Worker's `* * * * *` trigger, so
  the offline sweep, TLS renewal and the billing chores would never run.
  The Workers dev runtime installs `turbopanel-instance-cron.timer`, which
  hits wrangler's local trigger endpoint
  (`/cdn-cgi/local/scheduled`) every minute. Fire one by hand with
  `curl http://127.0.0.1:18787/cdn-cgi/local/scheduled`.
- **Secrets that survive a converge.** Put the sandbox secret key in
  `/etc/turbopanel/instance/.stripe_secret_key` and the webhook signing
  secret in `/etc/turbopanel/instance/.stripe_webhook_signing_secret`
  (0640 root:dev-group, by hand, never committed). The converge reads
  both into `runtime.dev-vars` as `TURBOPANEL_STRIPE_SECRET_KEY` /
  `TURBOPANEL_STRIPE_WEBHOOK_SIGNING_SECRET`; editing `.dev.vars` directly
  is lost on the next converge. The Deno unit never loads either. On the
  co-located VM, keep the two values in the dev checkout's gitignored
  `dev/local/stripe.env` (see `dev/local/README.md`): the checkout is
  mounted into the guest, and the converge seeds both protected files from
  it, so a VM rebuild needs no re-entry.
- **Postgres on `localhost:5432`** (the Hyperdrive local connection string),
  exposed by the runtime switch.

**Webhook delivery.** Events reach `/webhook/stripe` (singular — the plural
falls through to the SPA catch-all and answers `200` with HTML, which Stripe
records as delivered; `src/surfaces.test.ts` pins the path). Two ways:

1. A public hostname in front of the VM (a Cloudflare Tunnel to the Caddy
   listener): register a **Dashboard endpoint** at
   `https://<host>/webhook/stripe`, pin its API version to
   `DEFAULT_STRIPE_API_VERSION`, subscribe `checkout.session.completed`,
   `customer.subscription.*`, `invoice.*`, `customer.*`, and put its
   `whsec_…` in `.stripe_webhook_signing_secret`. Production's shape.
2. The optional **Stripe CLI** service (`turbopanel-stripe-listen`, off by
   default; Developer → *Optional services…*): `stripe listen
   --forward-to https://<instance>/webhook/stripe`. It needs the test-mode
   key in `/etc/turbopanel/stripe-listen/stripe.env` as
   `TURBOPANEL_STRIPE_SECRET_KEY` and writes its own forwarding secret there
   as `TURBOPANEL_STRIPE_WEBHOOK_SIGNING_SECRET` (distinct from any Dashboard
   endpoint's). That file is also what the test-clock harness reads. Copy
   the forwarding secret into `.stripe_webhook_signing_secret` for the
   instance.

**Not available locally:** metrics. The Analytics Engine binding accepts
writes in local mode and discards them, and reads need the account SQL API
token, so charts stay empty on a local Workers instance; the offline sweep
tolerates that (`ae-unavailable` → probe). A daemon whose licence has no
tier is refused by the hosted gate (`License tier not assigned`) — enter
tiers and buy a seat in the sandbox first.

## Billing runs on Workers, not Deno

Self-hosted TurboPanel is free software: run as much as you like, nothing is
metered, nothing is billed. So the Deno runtime has **no billing surface and
no billing behaviour**, not a mounted-but-503 one. Three gates, all on
`runtime === 'workers'`, in the shared registrars both entrypoints call:

- `registerWebhookRoutes` (`src/webhook/routes.ts`) mounts `/webhook/stripe`.
- `registerClientRoutes` (`src/client/routes.ts`) mounts `/billing/*`.
- `registerAdminRoutes` (`src/admin/routes.ts`) mounts the tier catalogue.

The client and admin OpenAPI specs follow the same gate, so the self-hosted
reference does not document routes it does not have. `deno-server.ts`
resolves no `BillingConfig`, builds no Stripe rate-limit bucket, and its
maintenance tick has no grace-clock, reconcile or tier-notice phase; the
grace clock and reconcile run on the Workers cron
(`src/daemon/cell/offline-sweep.ts`). `createApp` has no `billingConfig`
option — `workers.ts` sets the context variable per request in its own
middleware.

This lines up with the deployment kind: `metricsDeploymentKindForRuntime`
maps `deno → "self-hosted"` with no override, so ingest is never truncated
to a plan and tier entitlements are never enforced there.

What the Deno bundle still *imports* from `src/lib/billing/` is the
absent-config no-op path in `src/client/authn/license-lifecycle.ts` and the
licence routes (`c.get('billingConfig')` is simply never set). That is
import-level coupling, not behaviour; splitting it out is a larger refactor
and has not been asked for.

Hosted billing is Workers, where `wrangler secret put --env live` holds both
secrets and they are read per request (a rotation applies without an isolate
recycle).

## Dashboard runbook

These are **account-level settings, not API fields**; set them once per
Stripe account (the sandbox included) and keep them so. Nothing here can be
done from code.

1. *Billing → Settings → Subscriptions and emails → Manage failed payments*:
   Smart Retries, retry for up to **2 months** (C13).
2. *If all retries fail*: **leave the subscription past-due**. Not "cancel"
   (the grace clock is the cancel) and not "mark unpaid" (also fine — the
   clock treats `unpaid` as delinquent — but past-due keeps invoices
   collectable). The grace clock exists because of this step: Stripe will
   never end the subscription on its own, and entitlement must end somewhere.
3. **Customer Portal.** Features are set by `portal.ts` on the configuration
   it creates, not in the Dashboard; a Dashboard-edited default configuration
   is never used because sessions name their configuration explicitly. What
   the Dashboard still owns in a fresh sandbox: the portal's branding, and
   *Settings → Tax* (a business address, and a tax behaviour on each Price
   you create by hand), or the portal shows prices without tax.
4. **Stripe Tax registrations.** Every subscription and Checkout session is
   created with `automatic_tax[enabled]=true`. That collects nothing until
   *Tax → Registrations* holds at least one jurisdiction; before then Stripe
   reports `not_collecting` and totals carry no tax. Register a test
   jurisdiction (the harness's customers are in California, US) before
   running the proration-sensitive scenarios, or the invoice totals the
   harness compares will differ from a registered account's. A customer
   with no address fails `customer_tax_location_invalid` — the harness sets
   one; production gets it from Checkout's `customer_update[address]=auto`.
5. **Do not configure Billing Automations in the sandbox.** An account with
   Automations refuses to attach a test clock to an existing customer, and
   although the harness always creates its customers directly on a clock,
   Automations also run against clock-driven subscriptions and change the
   outcomes the scenarios assert. Keep them off, or the harness cannot be
   trusted at all.
