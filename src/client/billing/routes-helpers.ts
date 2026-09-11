/**
 * Pure helpers and shared guards for the billing client surface.
 *
 * Everything here is either a body parser, a serializer, or a guard that
 * reads already-loaded state. No provider call, no Postgres write.
 */

import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import { StripeApiError } from "../../lib/billing/errors.ts";
import {
  deferredDeltasByTier,
  outstandingReleasesByTier,
  type PendingChangeLedger,
  readPendingChanges,
} from "../../lib/billing/pending-changes.ts";
import {
  isDelinquentStatus,
  isEndedStatus,
  listSeatsForOrganization,
  type OrganizationBillingState,
  seatQuantitiesByTier,
} from "../../lib/db/billing-records.ts";
import {
  countActiveLicenses,
  type LicenseCount,
  type TierRow,
} from "../../lib/db/tier-records.ts";
import {
  applyTierDeltas,
  coverageLoss,
  type TierQuantity,
} from "../../lib/tiers/assignment.ts";
import {
  type AssignedServerRow,
  loadAssignableServers,
  tierQuantitiesFromState,
} from "../../lib/tiers/assignment-records.ts";
import { ladderEntry, ladderEntryByRank } from "../../lib/tiers/ladder.ts";
import type { TierDelta } from "../../lib/billing/subscriptions.ts";

export const BILLING_NOT_CONFIGURED_ERROR = "billing_not_configured";
export const BILLING_MUTATION_IN_PROGRESS_ERROR =
  "billing_mutation_in_progress";
export const SUBSCRIPTION_PAST_DUE_ERROR = "subscription_past_due";
export const SUBSCRIPTION_EXISTS_ERROR = "subscription_exists";
export const CHECKOUT_PENDING_ERROR = "checkout_pending";
export const NO_SUBSCRIPTION_ERROR = "no_subscription";
/** A reduction would leave a licensed server on nothing. */
export const SERVERS_UNCOVERED_ERROR = "servers_uncovered";
/** A reduction would leave more licenses than purchased. */
export const LICENSES_IN_USE_ERROR = "licenses_in_use";
/** Nothing purchased is free for another server. */
export const NO_LICENSE_AVAILABLE_ERROR = "no_license_available";
export const TIER_NOT_PURCHASABLE_ERROR = "tier_not_purchasable";
export const NOT_AN_UPGRADE_ERROR = "not_an_upgrade";
export const NOT_A_DOWNGRADE_ERROR = "not_a_downgrade";
export const STRIPE_ERROR = "stripe_error";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rejection sentinel for {@link readUuidField}.
 *
 * A symbol rather than the string `'invalid'`: that token is itself a
 * `string`, so `string | 'invalid'` collapses and cannot be told apart from
 * a body that actually sent it.
 */
export const PARSE_UUID_INVALID: unique symbol = Symbol("parse_uuid_invalid");

export function readUuidField(
  record: Record<string, unknown>,
  key: string,
): string | null | typeof PARSE_UUID_INVALID {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return PARSE_UUID_INVALID;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : PARSE_UUID_INVALID;
}

export function readIntField(
  record: Record<string, unknown>,
  key: string,
): number | null | "invalid" {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) return "invalid";
  return value;
}

/** `null` when the body is absent/blank; `'invalid'` when it is not a JSON object. */
export function parseJsonObjectBody(
  raw: string,
): Record<string, unknown> | null | "invalid" {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) return "invalid";
    return parsed as Record<string, unknown>;
  } catch {
    return "invalid";
  }
}

/** Everything a billing page or mutation reads, in one Postgres round of reads. */
export type BillingOrgView = Readonly<{
  state: OrganizationBillingState;
  /** Active licenses the organization holds, bound or not. */
  licenses: LicenseCount;
  /** Every licensed server with its hardware requirement and current assignment. */
  servers: readonly AssignedServerRow[];
  ledger: PendingChangeLedger;
}>;

export async function loadBillingOrgView(
  db: Db,
  organizationId: string,
  _nowMs: number,
): Promise<BillingOrgView> {
  const state = await listSeatsForOrganization(db, organizationId);
  const licenses = await countActiveLicenses(db, organizationId);
  const servers = await loadAssignableServers(db, organizationId);
  const { ledger } = state.subscription
    ? await readPendingChanges(
      db,
      organizationId,
      state.subscription.providerSubscriptionId,
    )
    : {
      ledger: { version: 2 as const, providerSubscriptionId: "", intents: [] },
    };
  return { state, licenses, servers, ledger };
}

export type TierSummary = Readonly<{
  tierId: string;
  label: string;
  rank: number;
  /** Committed quantity — the licenses bought at this tier. */
  purchased: number;
  /** Servers currently assigned this tier. */
  inUse: number;
  /** Of `purchased`, how many leave at the period boundary. */
  releasing: number;
  priceCents: number | null;
  currency: string | null;
}>;

/** Per-tier purchased vs in use, in ladder order. */
export function summarizeTiers(view: BillingOrgView): TierSummary[] {
  const seats = seatQuantitiesByTier(view.state);
  const releases = outstandingReleasesByTier(view.ledger);
  const inUse = new Map<string, number>();
  for (const server of view.servers) {
    if (server.assignedTierId) {
      inUse.set(
        server.assignedTierId,
        (inUse.get(server.assignedTierId) ?? 0) + 1,
      );
    }
  }
  const out: TierSummary[] = [];
  for (const seat of view.state.seats) {
    if (out.some((entry) => entry.tierId === seat.tierId)) continue;
    out.push({
      tierId: seat.tierId,
      label: seat.tier.label,
      rank: seat.tier.rank,
      purchased: seats.get(seat.tierId) ?? 0,
      inUse: inUse.get(seat.tierId) ?? 0,
      releasing: releases.get(seat.tierId) ?? 0,
      priceCents: seat.tier.priceCents,
      currency: seat.tier.currency,
    });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

export type LicenseSummary = Readonly<{
  /**
   * Total entitled quantity across tiers — projected provider seats plus
   * the self-hosted grant. The grant is the reason a self-hosted
   * organization has any entitlement at all; it has no price and no tier
   * line, so `purchased` can exceed the sum of {@link summarizeTiers}.
   */
  purchased: number;
  /** Of `purchased`, the part that is a grant rather than a purchase. */
  granted: number;
  /** Of `purchased`, how many leave at the period boundary. */
  releasing: number;
  /** Active licenses held, bound or waiting to connect. */
  held: number;
  bound: number;
  /** `purchased − releasing − held`, floored at zero: how many more servers can be added. */
  available: number;
}>;

export function summarizeLicenses(view: BillingOrgView): LicenseSummary {
  // `tierQuantitiesFromState`, not `seatQuantitiesByTier`: the mint gate is
  // an entitlement question, so it counts the self-hosted grant.
  let purchased = 0;
  for (const entry of tierQuantitiesFromState(view.state)) {
    purchased += entry.quantity;
  }
  const granted = view.state.grant?.quantity ?? 0;
  let releasing = 0;
  for (const count of outstandingReleasesByTier(view.ledger).values()) {
    releasing += count;
  }
  const held = view.licenses.active;
  return {
    purchased,
    granted,
    releasing,
    held,
    bound: view.licenses.bound,
    available: Math.max(0, purchased - releasing - held),
  };
}

/** The mint gate: one more license fits under what is purchased and not already leaving. */
export function canMintLicense(view: BillingOrgView): boolean {
  return summarizeLicenses(view).available > 0;
}

export function hasLiveSubscription(view: BillingOrgView): boolean {
  return Boolean(view.state.subscription) &&
    !isEndedStatus(view.state.subscription!.status);
}

/** Current committed quantities per tier, with rank. */
export function currentTierQuantities(view: BillingOrgView): TierQuantity[] {
  return tierQuantitiesFromState(view.state);
}

export type CoverageRefusal =
  | {
    error: typeof SERVERS_UNCOVERED_ERROR;
    serverId: string;
    requiredTier: string;
  }
  | {
    error: typeof LICENSES_IN_USE_ERROR;
    purchasedAfter: number;
    licensesHeld: number;
  };

/**
 * The gate every reduction and deferred change runs: apply the ledger's
 * outstanding deltas **and** the proposed ones to the committed
 * quantities, and refuse when a licensed server would go uncovered or the
 * organization would hold more licenses than it pays for.
 *
 * `rankOf` resolves a tier the seats do not yet carry (a downgrade target).
 */
export function coverageRefusal(
  view: BillingOrgView,
  proposed: readonly TierDelta[],
  rankOf: (tierId: string) => number | undefined,
): CoverageRefusal | null {
  const current = currentTierQuantities(view);
  const deltas = deferredDeltasByTier(view.ledger);
  for (const { tierId, delta } of proposed) {
    deltas.set(tierId, (deltas.get(tierId) ?? 0) + delta);
  }
  let future: TierQuantity[];
  try {
    future = applyTierDeltas(current, deltas, rankOf);
  } catch (err) {
    // A tier going negative is the caller's arithmetic, refused as invalid
    // upstream. An unresolvable rank is a bug in the caller's resolver and
    // must not read as "safe".
    if (err instanceof RangeError) return null;
    throw err;
  }
  const purchasedAfter = future.reduce((sum, entry) => sum + entry.quantity, 0);
  if (purchasedAfter < view.licenses.active) {
    return {
      error: LICENSES_IN_USE_ERROR,
      purchasedAfter,
      licensesHeld: view.licenses.active,
    };
  }
  const loss = coverageLoss(current, future, view.servers);
  if (loss) {
    return {
      error: SERVERS_UNCOVERED_ERROR,
      serverId: loss.serverId,
      requiredTier: ladderEntryByRank(loss.requiredRank)?.label ??
        `rank ${loss.requiredRank}`,
    };
  }
  return null;
}

/** The catalogue entry the console renders: the row plus what the ladder says it entitles. */
export function serializeTier(row: TierRow) {
  const entry = ladderEntry(row.label);
  return {
    id: row.id,
    label: row.label,
    rank: row.rank,
    priceCents: row.priceCents,
    currency: row.currency,
    isCustom: row.isCustom,
    entitlements: entry
      ? {
        maxCores: entry.maxCores,
        maxMemoryBytes: entry.maxMemoryBytes,
        nicSlots: entry.nicSlots,
        driveSlots: entry.driveSlots,
        gpuSlots: entry.gpuSlots,
        filesystemSlots: entry.filesystemSlots,
      }
      : null,
  };
}

/** {@link LicenseSummary} minus the fields that are internal plumbing. */
function publicLicenseSummary(
  summary: LicenseSummary,
): Omit<LicenseSummary, "granted"> {
  const { granted: _granted, ...rest } = summary;
  return rest;
}

export function serializeSubscriptionSummary(view: BillingOrgView) {
  const sub = view.state.subscription;
  return {
    payer: view.state.payer ? { taxId: view.state.payer.taxId } : null,
    subscription: sub
      ? {
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd,
        pastDueSince: sub.pastDueSince,
        graceExpiresAt: sub.graceExpiresAt,
        scheduleAttached: sub.scheduleId !== null,
      }
      : null,
    tiers: summarizeTiers(view),
    // `granted` is dropped on the way out: the self-hosted grant is
    // plumbing, not something the console renders or a customer bought. It
    // still moves `purchased` and `available`, which is the whole point.
    licenses: publicLicenseSummary(summarizeLicenses(view)),
    servers: view.servers.map((server) => ({
      serverId: server.serverId,
      assignedTierId: server.assignedTierId,
      requiredTier: server.requiredRank === null
        ? null
        : ladderEntryByRank(server.requiredRank)?.label ?? null,
    })),
    pendingChanges: view.ledger.intents.map((intent) => ({
      id: intent.id,
      kind: intent.kind,
      fromTierId: intent.fromTierId,
      toTierId: intent.toTierId,
      createdAt: intent.createdAt,
      landsAt: intent.landsAt,
    })),
  };
}

/**
 * C8 — no entitlement-raising change while the subscription is delinquent.
 * A pending update expires in 23 h and Smart Retries are days apart, so it
 * could never apply; refusing up front is the honest answer.
 */
export function assertTierChangeAllowed(
  c: Context<AppEnv>,
  view: BillingOrgView,
): Response | null {
  const refusal = tierChangeRefusal(view);
  return refusal ? c.json(refusal, 409) : null;
}

export type TierChangeRefusal =
  | { error: typeof NO_SUBSCRIPTION_ERROR }
  | {
    error: typeof SUBSCRIPTION_PAST_DUE_ERROR;
    graceExpiresAt: string | null;
  };

/**
 * The C8 gate as a value: the `409` body an entitlement-raising change
 * gets, or `null` when it may go ahead. `mutations.ts` and the live harness
 * read this; the routes wrap it in a `Response` above.
 */
export function tierChangeRefusal(
  view: BillingOrgView,
): TierChangeRefusal | null {
  const sub = view.state.subscription;
  if (!sub || isEndedStatus(sub.status)) {
    return { error: NO_SUBSCRIPTION_ERROR };
  }
  if (isDelinquentStatus(sub.status)) {
    return {
      error: SUBSCRIPTION_PAST_DUE_ERROR,
      graceExpiresAt: sub.graceExpiresAt,
    };
  }
  return null;
}

/** Map a Stripe failure to a client answer without leaking the raw body. */
export function stripeErrorResponse(
  c: Context<AppEnv>,
  err: unknown,
): Response {
  if (err instanceof StripeApiError) {
    return c.json(
      {
        error: STRIPE_ERROR,
        type: err.type,
        code: err.code,
        transient: err.isTransient,
      },
      err.isTransient ? 503 : 502,
    );
  }
  throw err;
}
