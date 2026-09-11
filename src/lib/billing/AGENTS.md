# Billing — AGENTS.md

The Stripe integration's transport and the projection it feeds. This directory
is the _only_ place that talks to Stripe; `src/lib/db/billing-records.ts` is the
only place that writes what it learns; `src/webhook/billing/stripe.ts` is the
only way anything arrives.

```
src/lib/billing/
├── config.ts             BillingConfig + resolveBillingConfig — the feature gate
├── gateway.ts            BillingGateway — the provider seam (catalogue: list / get / verify products)
├── stripe-products.ts    the Stripe gateway: products with their default price, the verification rules
├── tier-prices.ts        which price a tier bills at, resolved from its product at mutation time
├── client.ts             createStripeClient — get / post / del / listAll
├── form-encode.ts        Stripe's bracket-syntax form encoding (pure)
├── errors.ts             StripeApiError, permanent vs transient
├── webhook-signature.ts  Stripe-Signature over raw bytes, tolerance, multi-v1
├── customer-subject.ts   customer.metadata → organization or user
├── quantity-lock.ts      the per-organization mutation lease
├── pending-changes.ts    the per-organization deferred-quantity ledger (a `setting` row)
├── subscriptions.ts      the mutation surface — the only module that changes items
├── schedules.ts          deferred changes: subscription-schedule phases, `mutateSubscription`
├── entitlements.ts       landed intents → derived server assignment → schedule rebuild, under the lease
├── seat-increase.ts      an immediate change's idempotency key + params, persisted before Stripe
├── pending-checkout.ts    an in-flight first Checkout session, persisted under the lease
├── checkout.ts           first purchase (hosted Checkout) + customer creation
├── portal.ts             Customer Portal: invoices and payment methods only
├── grace-clock.ts        maintenance phase: cancel what Stripe leaves past due
├── reconcile.ts          maintenance phase: purchased vs held vs covered, alert only
└── test-clock.ts         /v1/test_helpers/test_clocks, for the live harness only

src/lib/tiers/ladder.ts                the S1…S7 + SX ladder: what a label entitles (the one matrix)
src/lib/tiers/assignment.ts            the greedy server → tier assignment (pure)
src/lib/tiers/assignment-records.ts    reads seats + licensed servers, writes `server.assigned_tier_id`
src/lib/tiers/self-hosted-grant.ts     what a self-hosted organization is entitled to: one SX unit per licence (pure)
src/lib/tiers/self-hosted-grant-records.ts  the grant's `setting` row + the grow-on-self-hosted / shrink-only rule
src/client/billing/mutations.ts        changeSeats / upgradeTier / downgradeTier — the route bodies
                                       as functions; the routes and the harness call them
scripts/billing-test-clock-harness.ts  C16 — six lifecycle scenarios on test clocks
```

## Stripe owns money, Postgres owns entitlement

Stripe is the system of record for what a customer has paid for. Postgres —
`payer`, `subscription`, `seat` (`src/lib/db/AGENTS.md`) — is the system of
record for what an organization is _entitled to_ right now. The webhook ingress
copies the former into the latter; nothing copies the other way.

The projection exists because of where entitlement is read. Tier placement,
license minting, and the **metrics truncation that runs on every sample** all
need "how many at which tier" and "which tier is this server on" — a Stripe call
there is impossible on cost alone, and it would also mean a Stripe outage breaks
monitoring. So: **nothing on the ingest or page-load path may call Stripe.**
Reads are local rows; Stripe is called only from the webhook's deferred task,
from the explicit mutation routes (`src/client/billing/`), the admin catalogue
routes, and from the grace clock on the maintenance tick. The reconciliation
sweep reads Postgres only.

## The switch

`resolveBillingConfig(env)` returns `null` when `TURBOPANEL_STRIPE_SECRET_KEY`
is absent or blank. That config is published as `c.get('billingConfig')` and is
enough for the admin catalogue. **Customer billing** — `billingEnabled` on
`GET /api/client/v1/status`, and every `/billing/*` route — is on only when the
webhook signing secret is non-empty as well (`isCustomerBillingOperational`). An
API-key-only instance can bind products; it does not expose Checkout or the
billing UI, and `/webhook/stripe` answers `503 stripe_webhook_not_configured`.
`src/workers.ts` resolves the config per request from the binding env (so a
dashboard secret change applies without an isolate recycle). The keys themselves
never leave the server. The Deno runtime never resolves it: see _Billing runs on
Workers, not Deno_ below.

Both `TURBOPANEL_STRIPE_SECRET_KEY` and
`TURBOPANEL_STRIPE_WEBHOOK_SIGNING_SECRET` are **secrets**
(`wrangler secret put`), never `vars` in `wrangler.jsonc`; `keep_vars: true`
protects dashboard-set values across deploys. `TURBOPANEL_STRIPE_API_VERSION` is
an optional override of the pin below.

A Workers deployment with no key: the three tables exist and are empty,
`/webhook/stripe` answers `503 stripe_webhook_not_configured`, no Stripe call is
ever made, the UI hides billing. A self-hosted (Deno) instance has none of those
routes at all — `404`, not `503`.

## Why there is no `stripe` npm package

The SDK brings a Node HTTP stack and module-load crypto that the Workers bundle
rejects (Cloudflare error 10021 — `src/workers.ts` imports this tree on boot,
and `pnpm check:workers-bundle` is the guard). The calls this instance makes are
a handful of HTTPS requests with three headers, so `client.ts` is a few hundred
lines over `fetch`, `crypto.subtle` and `URLSearchParams`. Rules that come with
owning the transport:

- **No `@std/*`, no bare `jsr:`**, and no `crypto` / `fetch` / `setTimeout` at
  module load anywhere in this directory. `AbortSignal.timeout` and the
  comparison key are minted per call.
- **Every mutating call carries an `Idempotency-Key`.** `post` and `del` mint
  one with `crypto.randomUUID()` when the caller supplies none, so it cannot be
  forgotten. A caller that retries a mutation must pass the _same_ key it used
  the first time — Stripe will otherwise happily create a second subscription.
- **`Stripe-Version` is pinned** (`DEFAULT_STRIPE_API_VERSION`). The account's
  dashboard default can be bumped by anyone with dashboard access, and a bump
  changes response shapes: in the `basil` line `current_period_end` moved from
  the subscription to its items, and `invoice.subscription` moved under
  `invoice.parent.subscription_details`. The projection reads both shapes;
  bumping the pin is a code change that runs the tests.
- Form encoding follows Stripe's bracket syntax (`form-encode.ts`), and the
  `null` (clear this field) vs `undefined` (leave it alone) distinction is
  load-bearing for partial updates.
- `listAll` walks `has_more` / `starting_after` with a hard page cap and throws
  rather than looping or silently truncating.
- A non-2xx body becomes a `StripeApiError` with `type`, `code`, `param` and a
  `permanent` / `transient` classification; the raw body is never retained and
  never reaches a client response.

## Signature verification

`verifyStripeSignature(rawBody, header, secret)` — HMAC-SHA256 over
`${t}.${rawBody}`, the **raw bytes** the gate read before any parse. Every `v1=`
element is tried (Stripe sends two during a secret roll), `v0=` is ignored, and
`t` must be inside a 300 s tolerance — replay protection independent of the
delivery ledger, which only stops the _same_ event landing twice. Comparison
goes through `timingSafeSecretEquals` from `src/lib/git/gitlab-webhook.ts`; the
fact that billing imports one helper from `git` is deliberate and the reverse
direction does not exist.

## Which subject a customer is

A Stripe `Customer` names its TurboPanel subject in `metadata`:
`turbopanel_organization_id` **or** `turbopanel_user_id`, exactly one
(`customer-subject.ts`). The projection reads it from the **refetched**
customer, never the event payload. A customer naming neither, both, or a
malformed id is logged and skipped. This is the same exactly-one rule
`payer_subject_check` enforces at the table.

## The quantity lease

Stripe has no compare-and-swap, and a subscription update **replaces the whole
`items` array**. Two concurrent mutations for one organization would each read
the items, each compute a new array, and the second write would undo the first.
`quantity-lock.ts` therefore serialises quantity mutations per organization.

It is a `setting`-row lease, not `pg_advisory_lock`: advisory locks are
session-scoped and **unsupported on the Workers/Hyperdrive path**, where
sessions are pooled. The implementation is a direct port of
`tryBeginReencryptSweep` in `src/admin/reencrypt-secrets.ts`: insert-or-steal
only when expired _and_ the compare-and-set on the exact previous value still
matches; release is owner-scoped so a stolen lease is never released by its
former holder. Key `BILLING_QUANTITY_LOCK:<organizationId>`, TTL 60 s (a Stripe
round trip plus the projection write). Rows are transient — created on mutation,
deleted on release.

Holders: every `/billing/*` mutation route, the hosted license mint (the
availability read and the insert), and the entitlement sync the webhook task
runs after a projection. A held lease answers `409 billing_mutation_in_progress`
on a route; the webhook task logs and skips the sync (the seat rows are still
written — they are Stripe's truth) and the mutation holder, which runs the same
sync before releasing, catches up.

## Who chooses a tier: nobody

An organization owns a **quantity per tier** (the `seat` rows). Each server with
an active license needs a tier from its hardware (`tier-placement`: required =
max(core band, RAM band)). Which server gets which tier is **derived**, never
chosen: `src/lib/tiers/assignment.ts` takes the servers in bind order (oldest
first), gives each the smallest purchased tier whose rank covers its need
(unknown hardware needs the entry rank), and leaves the newest uncovered when
nothing fits. Incumbents are placed before any newcomer, so adding hardware can
never move a covered server onto nothing. `assignment-records.ts` writes the
result to `server.assigned_tier_id` after every projection and mutation, on
every hardware report, on enroll, on delete and on revoke; ingest and the
capability plan read the column.

A self-hosted organization has no purchased quantity at all; its quantity is the
grant (see _Billing runs on Workers, not Deno_ below), one `SX` unit per active
license, so the same greedy assignment places every self-hosted server on `SX`
rather than on nothing.

A license therefore carries no tier. It is minted only inside "Add server"
(gated on `purchased − releasing − held > 0`), embedded in the install command,
and revoked when its server is deleted — without touching Stripe. An uncovered
licensed server is refused at its next `/auth/session` with
`License tier below required` (byte-identical to the daemon's permanent list)
and reported by the reconcile sweep.

## The mutation surface

Quantities are bought through Stripe; keys are minted by the console against the
total. Every mutation is a **quantity** change — nothing names a license or a
server:

- `changeSeats(tierId, +n)` — immediate, invoiced now.
- `changeSeats(tierId, −n)` — one `release-seat` intent per unit, a schedule
  phase at the boundary.
- `upgradeTier(from, to)` — `−1` at the lower and `+1` at the higher tier,
  **now** (the item swap under `pending_if_incomplete`).
- `downgradeTier(from, to)` — the same pair as a `downgrade` intent and a
  schedule phase at the boundary.

Every reduction and deferred change runs the **coverage gate**
(`coverageRefusal`): apply the ledger's outstanding deltas and the proposed ones
to the committed quantities, run the assignment against the licensed servers,
and refuse `409 servers_uncovered` (naming the server and the tier it needs)
when one would go uncovered, or `409 licenses_in_use` when the organization
would hold more licenses than it pays for.

Which price a tier bills at is resolved at mutation time from its product
(`tier-prices.ts`: `resolveTierPrice` → `product.default_price`, refusing a
product that no longer verifies, and refreshing the row's cached display price).
A re-price is therefore "set a new default price in the Dashboard". Existing
items keep their old price and still map by product; the projection stores each
item's price on `seat.provider_price_id` because a restated `items[]` or
schedule phase must name the price the item has.

`subscriptions.ts` is the only module that changes a subscription's items,
`schedules.ts` the only one that parks a change for later, and
`buildItemMutation` the only function that produces an `items[]` array — it
always emits `quantity` beside `items[n][id]`, because sending `id` or `price`
alone makes Stripe reset the quantity to **1** with a `200`.

**One raise path.** Every entitlement-raising mutation goes out with
`payment_behavior=pending_if_incomplete`. When the proration invoice cannot be
paid, Stripe parks the change under `subscription.pending_update` and leaves
`subscription.items` alone; the projection reads `items` only, so an unpaid
change never raises entitlement and there is no second gate to keep in step. The
projection reads `pending_update` for its _presence_ alone, which holds the
deferred-schedule rebuild until the parked change resolves.

**The schedule is the only deferral.** A downgrade or a seat removal is a second
phase on a subscription schedule starting at `current_period_end`; the first
phase restates the current items. That is how "decreases generate no proration"
is achieved — `proration_behavior` is never set to the disabling value anywhere
here. Rules: every update resends **every** phase (a partial list rewrites
history); the future phase is recomputed from scratch as _current seats + all
outstanding deferred intents_; phase items are `price` + `quantity`, never
`items[n][id]`; and `mutateSubscription` **releases** the schedule before any
immediate change (editing items under a schedule auto-splits the phase), then
rebuilds it from the intents that survived in the ledger.

**Giving back the last seat cancels at the boundary.** A phase needs at least
one item, so when the outstanding intents empty the subscription the schedule is
written with the current phase alone and `end_behavior=cancel`: paid-for until
the period ends, cancelled there. A release (the first step of every immediate
change) drops that pending cancellation by default — `preserve_cancel_date` is
never sent — so buying a seat again before the boundary resumes the
subscription.

**Anchor and mode.** `SUBSCRIPTION_ANCHOR_PARAMS` spells the invariant once:
flexible billing mode, `billing_cycle_anchor_config` at day 1 / 00:00:00 UTC,
and no `proration_behavior` on create so the default prorates the first month.
Checkout passes the same block under `subscription_data` (verified accepted on
the pinned `2025-08-27.basil` version).

## The pending-change ledger

A Stripe schedule phase carries no reason: "one fewer S3 next period", never
why. So every deferred mutation first records an **intent** in
`BILLING_PENDING_CHANGES:<organizationId>` (`pending-changes.ts`, a `setting`
row like the lease — no migration, ledger version 2): `kind` (`release-seat` /
`downgrade`), `fromTierId`, `toTierId`, the `idempotencyKey` minted once and
reused on every retry of that Stripe call, `landsAt` (the `current_period_end`
it is parked behind) and `fromQuantity` (the tier's quantity when it was
written). The ledger names its `providerSubscriptionId` so a re-subscribe reads
empty; a version-1 (license-keyed) ledger reads as empty too.

An intent **lands** when the projected `current_period_end` has rolled past
`landsAt`, when the tier's quantity has dropped below `fromQuantity`, or when
the subscription ended (`landedIntents`). `entitlements.ts` drops landed intents
after every projection and mutation, then recomputes the assignment, revokes
every license when the subscription ended, and rebuilds the schedule when
intents remain but no schedule is attached.

An **immediate** change (a seat raise, an upgrade's swap) has no intent. Its key
lives in `BILLING_SEAT_INCREASE:<organizationId>` instead (`seat-increase.ts`,
another `setting` row under the lease): the mutation writes the key together
with the per-tier deltas, the `items[]` array and the proration date **before**
calling Stripe, replays exactly those on a retry of the same deltas (never items
rebuilt from seat rows a webhook may have moved meanwhile — Stripe answers
`idempotency_error` to a reused key with different params), and clears the row
once the reprojection has landed — or at once on a permanent Stripe refusal,
which applied nothing. A transient failure after Stripe accepted the update
keeps the row, so the console's retry cannot buy twice. Records expire with
Stripe's 24 h key window.

## Grace clock and reconciliation

`grace-clock.ts` owns cancellation. Stripe's dunning is configured in the
Dashboard and stays `past_due` forever by design; the projection latches
`grace_expires_at = past_due_since + BILLING_GRACE_WINDOW_MS` (the constant
beside the latch in `billing-records.ts` is the only place the length is
written), and the maintenance tick (`runGraceClock`) cancels what is still
delinquent after it — `DELETE /v1/subscriptions/:id` keyed on
`(subscription, expiry)` so a retried tick replays — then reprojects, which is
what revokes the licenses, bound ones included. Leftover credit is forfeited;
there is no refund call anywhere. `runGraceClockForSubscription` is the same
step narrowed to one provider subscription id: it exists for the live harness,
which must never run the batch against a shared development database (it would
cancel whatever other delinquent rows were there), and nothing in the instance
calls it.

`reconcile.ts` compares, per organization, the purchased total to the active
licenses (`licenses_exceed_purchased`), runs the assignment and reports every
licensed server nothing covers (`servers_uncovered`), and notes bought-ahead
quantity (`purchased_unused`, informational). **Alert, never auto-correct**: an
error-level structured log and the last report in `BILLING_RECONCILE_REPORT` for
the admin surface. No Stripe write, no license write. Reconcile does **not**
refetch Stripe and is not recovery for a missed webhook — that is
`runPendingStripeProjections` on the same maintenance tick, which retries
claimed deliveries whose `projected_at` is still null.

Both run as optional phases of the Workers maintenance cron
(`src/daemon/cell/offline-sweep.ts`; stripe-projection every tick, grace clock
and reconcile on minute-divisor predicates, each isolated by
`runOptionalPhase`), and are skipped entirely when `resolveBillingConfig`
returns `null`. The Deno maintenance tick has no billing phases.

## Footguns that return `200`

- The raw anchor-timestamp parameter (the one _without_ the `_config` suffix) on
  an existing subscription silently resets the anchor.
- `proration_behavior` set to the disabling value silently waives a credit the
  customer was owed.

`subscriptions.hostfree.test.ts` scans every non-test file in this directory and
fails on either spelling.

## Tier catalogue (C15)

**The ladder is code; the row is a binding.** `src/lib/tiers/ladder.ts` is the
one matrix — for each label, the core / RAM ceilings that place a server, the
NIC / drive / GPU / filesystem slots the daemon's plan is built from, and the
list price the Dashboard is expected to carry. A `tier` row holds only `label`,
the provider `product` it bills against, and a cached display price; `rank` and
`is_custom` are copied from the ladder on insert and never taken from a request.
NIC slots top out at the daemon's `MAX_NIC_SLOTS` (`ladder.test.ts` pins it).

**Nothing seeds the catalogue.** The owner creates the Products (one per label,
with a default Price) in the Stripe Dashboard, and a superadmin binds each label
to a product under Admin → Tiers — from a **dropdown**
(`GET /api/admin/v1/tiers/products`), never by pasting an id. The dropdown lists
every active product with its default price expanded and an inline pass/fail; a
product whose `metadata.turbopanel_tier` names a valid label is preselected for
it.

`gateway.ts` is the provider seam the admin routes talk to (`BillingGateway`:
`listProducts`, `getProduct`, `verifyProduct`); `stripe-products.ts` is the
Stripe implementation. Checkout, the item mutations, the schedule and the
projection remain Stripe modules driven by `StripeClient` — abstracting them
before a second gateway exists would be guessing at its shape — and rows carry a
`provider` discriminator so a second gateway can coexist. Adding one: a second
`BillingGateway`, a second projection under `src/webhook/billing/`, and routing
on `provider` in the mutation routes.

**Verification** (`productVerificationFailures`) runs before every write and
every mutation that resolves a price, and refuses on any failure, because a
wrong product is **not** loud downstream: the projection logs and skips
subscription items whose product maps to no tier, so a mistake silently loses
entitlement instead of erroring. Every check is code-dependent — the product and
its default price `active` (the purchasable gate assumes live), a
`default_price` present (every write names it), monthly `interval` with
`interval_count` 1 (schedule phases and the anchor config assume it),
`billing_scheme = per_unit` (quantities are `quantity`; tiered pricing breaks
the proration maths), `currency` usd (the ladder is priced in one currency), and
a **resolvable tax behaviour**. `livemode`, `name` and `metadata` come back for
the operator to eyeball.

"Resolvable" means the price names `inclusive`/`exclusive` **or** the account's
Stripe Tax settings carry a default; Stripe documents `tax_behavior` as "only
required if a default tax behavior was not provided in the Stripe Tax settings",
and recommends the account default. The Dashboard renders that state as _"Use
default (no)"_ while the API still returns `unspecified`, so refusing on the
price alone rejects the setup Stripe recommends — it did, and that was a bug.
`getTaxDefaults()` reads `GET /v1/tax/settings`, and `needsAccountTaxDefaults`
keeps it to the prices that actually need it, so a catalogue of explicit prices
costs no extra round trip. An account with Tax not set up errors on that
endpoint; that degrades to "no default", which only makes the gate stricter.

The cached display price is written on every verify and refreshed by the
`product.updated` / `price.updated` webhooks (`refreshTierCatalogue` in the
projection); nothing does arithmetic on it. Writes go through `insertTier` /
`updateTierById` in `src/lib/db/tier-records.ts`. The insert is **plain**, not
an upsert: `uniq_tier_label` raises and the route answers `409`, and
`uniq_tier_provider_product` stops two labels billing against one product (the
projection's product→tier map would otherwise resolve to whichever row it saw
last).

Rows are **deactivated, never deleted**. SX is a row with no product, so it is
never purchasable. When a negotiated deal exists, sales creates that customer's
Product and a superadmin binds it to the SX row.

## Live harness (C16)

`deno task billing:test-clocks` (or
`deno test -A scripts/billing-test-clock-harness.test.ts`) runs six scenarios,
each on its own Stripe **test clock** and its own throw-away organization; both,
and the organization's ledger and lease rows, are deleted in a `finally`:

| Scenario                 | Proves                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `partial-first-month`    | C2: signup mid-month — day-1 anchor, one prorated first invoice, `active` projection, no latch                                                                                                                                                                                                                                                                                   |
| `mid-cycle-upgrade`      | C4/C6: `upgradeTier` on a failing card is parked (`pending: true`); seats and the server's `assigned_tier_id` are unchanged, a reprojection raises nothing; paying the open proration makes Stripe apply it (`pending_update_applied`), and only then does the projection add the S5 seat and the assignment move the server onto it                                             |
| `deferred-downgrade`     | C5/C7: `downgradeTier` parks S5 → S3 on a schedule; seats and the assignment hold until the boundary, then S3 replaces S5, the intent lands, the server is reassigned S3, and the renewal bills S3 with no proration invoice                                                                                                                                                     |
| `quantity-up-down`       | C3/C5, one scenario: `changeSeats(+2)` is immediate and invoiced (`always_invoice`); `changeSeats(−1)` is a `release-seat` intent on a schedule that lands at the boundary, `current_period_end` rolls, and the renewal bills the reduced quantity at full price                                                                                                                 |
| `upgrade-while-past-due` | C8: after a failed renewal `upgradeTier` and `changeSeats(+1)` answer `409 subscription_past_due` (naming `graceExpiresAt`) with **zero** Stripe writes, no intent, no invoice, lease released; paying the renewal clears both latches and the same upgrade then applies                                                                                                         |
| `dunning-retry-window`   | C13: the failed renewal latches `past_due` + grace; the clock is walked through Smart Retries' window a fortnight at a time with the status delinquent, the latches held and the seat and license intact; `runGraceClockForSubscription` does nothing a millisecond early and at expiry cancels, reprojects to `canceled`, zero seats, license revoked; a second tick is a no-op |

Every seat or tier change is made through `src/client/billing/mutations.ts` —
the bodies of the `/billing/*` routes, called with the same deps the routes pass
— and then read back through `projectSubscriptionById`, the seam the webhook
task ends in. Assertions are on the rows production reads, never on Stripe's
objects. Nothing in the harness writes `server.assigned_tier_id`,
`license.revoked_at` or a ledger row directly; minting a license and binding it
to a `server` row sized for the tier under test are the only direct writes, as
setup. The scenario's test clock is its wall clock — projection `now`, intent
timestamps, `prorationDate` and the grace clock's `nowMs` all read the frozen
time — so a latch written at a simulated boundary and a sweep run at a simulated
expiry agree.

It is service-dependent (`scripts/check-test-inventory.mjs`) and never runs in
CI. The traps live in the shared helpers, not the scenarios: customers are
created **on** the clock (a clock cannot be attached later); `advance` is
asynchronous and is polled to `ready`; invoices settle about an hour after a
boundary, so `advanceAndSettle` adds one; invoice lists are always filtered by
subscription; consecutive mutations are separated by a few simulated minutes; a
paid pending update is polled to applied; a clock advances at most a couple of
billing intervals per call, so the retry window is stepped; cards are test
**tokens** (`tok_visa`, `tok_chargeCustomerFail` — attaches, then fails every
charge).

## Local development

Billing only exists in the Workers build, so local billing work means the
**Workers dev instance** (`turbopanel_instance_runtime: workers`: the instance
unit runs `scripts/workers-serve.sh` → `wrangler dev`, every binding in local
mode, Caddy in front on the usual port). Three things the dev VM does for you,
all in the daemon's `instance-launch` role:

- **Cron.** `wrangler dev` never fires the Worker's `* * * * *` trigger, so the
  offline sweep, TLS renewal and the billing chores would never run. The Workers
  dev runtime installs `turbopanel-instance-cron.timer`, which hits wrangler's
  local trigger endpoint (`/cdn-cgi/local/scheduled`) every minute. Fire one by
  hand with `curl http://127.0.0.1:18787/cdn-cgi/local/scheduled`.
- **Secrets that survive a converge.** Put the sandbox secret key in
  `/etc/turbopanel/instance/.stripe_secret_key` and the webhook signing secret
  in `/etc/turbopanel/instance/.stripe_webhook_signing_secret` (0640
  root:dev-group, by hand, never committed). The converge reads both into
  `runtime.dev-vars` as `TURBOPANEL_STRIPE_SECRET_KEY` /
  `TURBOPANEL_STRIPE_WEBHOOK_SIGNING_SECRET`; editing `.dev.vars` directly is
  lost on the next converge. The Deno unit never loads either. On the co-located
  VM, keep the two values in the dev checkout's gitignored
  `dev/local/stripe.env` (see `dev/local/README.md`): the checkout is mounted
  into the guest, and the converge seeds both protected files from it, so a VM
  rebuild needs no re-entry.
- **Postgres on `localhost:5432`** (the Hyperdrive local connection string),
  exposed by the runtime switch.

**Webhook delivery.** Events reach `/webhook/stripe` (singular — the plural
falls through to the SPA catch-all and answers `200` with HTML, which Stripe
records as delivered; `src/surfaces.test.ts` pins the path). Two ways:

1. A public hostname in front of the VM (a Cloudflare Tunnel to the Caddy
   listener): register a **Dashboard endpoint** at
   `https://<host>/webhook/stripe`, pin its API version to
   `DEFAULT_STRIPE_API_VERSION`, subscribe `checkout.session.completed`,
   `customer.subscription.*`, `invoice.*`, `customer.*`, `product.updated`,
   `price.updated`, and put its `whsec_…` in `.stripe_webhook_signing_secret`.
   Production's shape.
2. The optional **Stripe CLI** service (`turbopanel-stripe-listen`, off by
   default; Developer → _Optional services…_):
   `stripe listen
   --forward-to https://<instance>/webhook/stripe`. It needs
   the test-mode key in `/etc/turbopanel/stripe-listen/stripe.env` as
   `TURBOPANEL_STRIPE_SECRET_KEY` and writes its own forwarding secret there as
   `TURBOPANEL_STRIPE_WEBHOOK_SIGNING_SECRET` (distinct from any Dashboard
   endpoint's). That file is also what the test-clock harness reads. Copy the
   forwarding secret into `.stripe_webhook_signing_secret` for the instance.

**Not available locally:** metrics. The Analytics Engine binding accepts writes
in local mode and discards them, and reads need the account SQL API token, so
charts stay empty on a local Workers instance; the offline sweep tolerates that
(`ae-unavailable` → probe). A daemon whose organization has bought nothing is
refused by the hosted gate (`License tier not assigned`) — bind the tiers under
Admin → Tiers and buy in the sandbox first.

## Billing runs on Workers, not Deno — but licensing runs on both

Self-hosted TurboPanel is free software: run as much as you like, nothing is
metered, nothing is billed. So the Deno runtime has **no billing surface and no
billing behaviour**, not a mounted-but-503 one. Shared registrars stay
billing-free (no static Stripe import). The Workers entry mounts the hosted
surface:

- `src/workers.ts` calls `registerStripeWebhookRoutes`
  (`src/webhook/billing/stripe.ts`) for `/webhook/stripe`.
- `createApp({ registerBilling: registerBillingRoutes, getClientOpenApiSpec: getWorkersClientOpenApiSpec })`
  mounts `/billing/*` and the Workers client spec.
- `registerAdminRoutes({ registerTiers, getOpenApiSpec: getWorkersAdminOpenApiSpec })`
  mounts the tier catalogue.

The self-hosted OpenAPI builders (`src/client/openapi/index.ts`,
`src/admin/openapi/index.ts`) do not import billing or tier definitions.
`deno-server.ts` resolves no `BillingConfig`, builds no Stripe rate-limit
bucket, and its maintenance tick has no grace-clock, reconcile or tier-notice
phase; the grace clock and reconcile run on the Workers cron
(`src/daemon/cell/offline-sweep.ts`). `createApp` has no `billingConfig` option
— `workers.ts` sets the context variable per request in its own middleware.

This lines up with the deployment kind for **metering**:
`metricsDeploymentKindForRuntime` maps `deno → "self-hosted"` with no override,
so ingest is never truncated to a plan there — a self-hosted instance stores
whatever the daemon reports.

What is _not_ Workers-only is the **licensing machinery**. A server is licensed,
placed and assigned a tier on both runtimes, and the enroll gate and the
`/auth/session` entitlement check are one code path with no `self-hosted`
exemption. Self-hosted passes them by being entitled rather than by being
skipped: `src/lib/tiers/self-hosted-grant.ts` holds one granted `SX` unit per
active license in a `setting` row (`SELF_HOSTED_GRANT:<organizationId>`), and
`listSeatsForOrganization` returns it on `OrganizationBillingState.grant`.

Read that file for the rules; the two that matter here are:

- **A grant is not a seat.** It is deliberately outside `state.seats`, so
  `buildItemMutation` and the schedule phases — which restate `items[]` from the
  seat rows — can never emit one at the provider. It is counted by the
  entitlement readers only: `tierQuantitiesFromState` (the assignment and every
  coverage gate) and `summarizeLicenses` (the mint gate). It is absent from
  `seatQuantitiesByTier`, so `summarizeTiers` never renders it and
  `serializeSubscriptionSummary` drops `granted` on the way out. The console
  shows nothing.
- **Only self-hosted grows one.** `syncSelfHostedGrant` takes `allowGrow`, true
  only when the deployment is self-hosted. On Workers the grant may fall — a
  revoked license gives its granted unit back, or the free license it left
  behind would be mintable again — but never rise. So a control plane moved from
  Deno to Workers keeps every server it already had connected, and buys through
  Checkout for the next one.

That asymmetry is what makes the two runtimes interchangeable in development
without a licence setup step, and it is why `recomputeOrganizationAssignments`
now runs on both.

What the Deno bundle still _imports_ from `src/lib/billing/` is the
absent-config no-op path in `src/client/authn/license-lifecycle.ts` and the
licence routes (`c.get('billingConfig')` is simply never set). That is
import-level coupling, not behaviour; splitting it out is a larger refactor and
has not been asked for.

Hosted billing is Workers, where `wrangler secret put --env live` holds both
secrets and they are read per request (a rotation applies without an isolate
recycle).

## Dashboard runbook

These are **account-level settings, not API fields**; set them once per Stripe
account (the sandbox included) and keep them so. Nothing here can be done from
code.

1. _Billing → Settings → Subscriptions and emails → Manage failed payments_:
   Smart Retries, retry for up to **2 months** (C13).
2. _If all retries fail_: **leave the subscription past-due**. Not "cancel" (the
   grace clock is the cancel) and not "mark unpaid" (also fine — the clock
   treats `unpaid` as delinquent — but past-due keeps invoices collectable). The
   grace clock exists because of this step: Stripe will never end the
   subscription on its own, and entitlement must end somewhere.
3. **Customer Portal.** Features are set by `portal.ts` on the configuration it
   creates, not in the Dashboard; a Dashboard-edited default configuration is
   never used because sessions name their configuration explicitly. What the
   Dashboard still owns in a fresh sandbox: the portal's branding, and _Settings
   → Tax_ (a business address, and a **default tax behaviour** — preferred over
   stamping each Price, and what verification reads when a price says "Use
   default"), or the portal shows prices without tax.
4. **Stripe Tax registrations.** Every subscription and Checkout session is
   created with `automatic_tax[enabled]=true`. That collects nothing until _Tax
   → Registrations_ holds at least one jurisdiction; before then Stripe reports
   `not_collecting` and totals carry no tax. Register a test jurisdiction (the
   harness's customers are in California, US) before running the
   proration-sensitive scenarios, or the invoice totals the harness compares
   will differ from a registered account's. A customer with no address fails
   `customer_tax_location_invalid` — the harness sets one; production gets it
   from Checkout's `customer_update[address]=auto`.
5. **Do not configure Billing Automations in the sandbox.** An account with
   Automations refuses to attach a test clock to an existing customer, and
   although the harness always creates its customers directly on a clock,
   Automations also run against clock-driven subscriptions and change the
   outcomes the scenarios assert. Keep them off, or the harness cannot be
   trusted at all.
