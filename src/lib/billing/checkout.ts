/**
 * Hosted Checkout — the **first** purchase only (C14).
 *
 * The customer is created first, so `metadata[turbopanel_organization_id]`
 * exists before Stripe emits `checkout.session.completed` and the
 * projection can resolve its subject. Every later quantity or tier change
 * goes through `subscriptions.ts` / `schedules.ts`, never a second
 * Checkout.
 *
 * The session carries the same anchor and billing-mode invariant as a
 * direct `POST /v1/subscriptions` (`SUBSCRIPTION_ANCHOR_PARAMS`, verified
 * accepted under `subscription_data` for the pinned `2025-08-27.basil`
 * version). Tax: automatic tax on, tax-id collection on, and
 * `customer_update[address|name]=auto` so Checkout may write what it
 * collects onto the existing customer — Stripe requires both when a
 * `customer` is passed with `tax_id_collection`.
 *
 * Workers-bundleable: nothing at module load.
 */

import type { Db } from "../../db.ts";
import { getPayerForOrganization, upsertPayer } from "../db/billing-records.ts";
import type { StripeClient } from "./client.ts";
import { STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY } from "./customer-subject.ts";
import {
  createCustomerForOrganization,
  SUBSCRIPTION_ANCHOR_PARAMS,
} from "./subscriptions.ts";

type StripeObject = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Stripe substitutes the session id into the success URL. */
export const CHECKOUT_SESSION_ID_PLACEHOLDER = "{CHECKOUT_SESSION_ID}";

/** Console return URLs for one organization. */
export function checkoutReturnUrls(
  publicBaseUrl: string,
  organizationId: string,
): { successUrl: string; cancelUrl: string; portalReturnUrl: string } {
  const base = publicBaseUrl.replace(/\/$/, "");
  const page = `${base}/${encodeURIComponent(organizationId)}/billing`;
  return {
    successUrl:
      `${page}?checkout=success&session_id=${CHECKOUT_SESSION_ID_PLACEHOLDER}`,
    cancelUrl: `${page}?checkout=cancel`,
    portalReturnUrl: page,
  };
}

export type EnsureCustomerInput = Readonly<{
  organizationId: string;
  email?: string | null;
  name?: string | null;
  now?: string;
}>;

/**
 * The organization's provider customer: the existing `payer` when there is
 * one, otherwise created (keyed on the organization id, so a retry cannot
 * mint a second customer) and upserted into `payer` immediately.
 */
export async function ensureCustomerForOrganization(
  db: Db,
  client: StripeClient,
  input: EnsureCustomerInput,
): Promise<{ providerCustomerId: string; created: boolean }> {
  const existing = await getPayerForOrganization(db, input.organizationId);
  if (existing) {
    return { providerCustomerId: existing.providerCustomerId, created: false };
  }
  const { providerCustomerId } = await createCustomerForOrganization(client, {
    organizationId: input.organizationId,
    email: input.email ?? null,
    name: input.name ?? null,
    idempotencyKey: `customer:${input.organizationId}`,
  });
  await upsertPayer(db, {
    provider: "stripe",
    providerCustomerId,
    subject: { organizationId: input.organizationId, userId: null },
    now: input.now,
  });
  return { providerCustomerId, created: true };
}

export type CreateCheckoutSessionInput = Readonly<{
  providerCustomerId: string;
  providerPriceId: string;
  quantity: number;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  organizationId: string;
}>;

/** Stable key so a retry of the same first purchase cannot mint a second session. */
export function checkoutIdempotencyKey(
  organizationId: string,
  tierId: string,
  quantity: number,
): string {
  return `checkout:${organizationId}:${tierId}:${quantity}`;
}

export async function createCheckoutSession(
  client: StripeClient,
  input: CreateCheckoutSessionInput,
): Promise<{ sessionId: string; url: string }> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new RangeError("checkout quantity must be a positive integer");
  }
  const orgMetadata = {
    [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: input.organizationId,
  };
  const session = await client.post<StripeObject>(
    "/v1/checkout/sessions",
    {
      mode: "subscription",
      customer: input.providerCustomerId,
      line_items: [{ price: input.providerPriceId, quantity: input.quantity }],
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
      metadata: orgMetadata,
      subscription_data: {
        ...SUBSCRIPTION_ANCHOR_PARAMS,
        metadata: orgMetadata,
      },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    },
    { idempotencyKey: input.idempotencyKey },
  );
  const sessionId = str(session.id);
  const url = str(session.url);
  if (!sessionId || !url) {
    throw new Error("stripe checkout session returned no url");
  }
  return { sessionId, url };
}
