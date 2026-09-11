/**
 * Stripe's product catalogue, as a {@link BillingGateway}.
 *
 * A tier row names a Stripe **Product**, and the product's `default_price`
 * is what every write (Checkout line items, subscription items, schedule
 * phases) resolves at mutation time — so a re-price is "set a new default
 * price in the Dashboard" and nothing here changes. What a product must
 * satisfy is spelled once in {@link productVerificationFailures}; every
 * check is code-dependent — something downstream assumes it:
 *
 *   `active`                         an archived product cannot be bought into
 *   `default_price` present          every write path resolves it
 *   price `active`, `recurring`      a one-time or archived price cannot
 *                                    back a subscription item
 *   `month` / `interval_count` 1     schedule phases and the anchor config
 *                                    assume a monthly cycle
 *   `billing_scheme` per_unit        seats are `quantity`; tiered pricing
 *                                    breaks the proration maths
 *   `currency` usd                   the ladder is priced in one currency
 *   `tax_behavior` resolvable        every subscription and Checkout goes
 *                                    out with automatic tax on. Stripe needs
 *                                    a behaviour, but takes it from the
 *                                    account's Tax settings default when the
 *                                    price says `unspecified` — so this is
 *                                    satisfied by *either*, and only refused
 *                                    when neither names one
 *
 * Binding a priced ladder label also requires `metadata.turbopanel_tier`
 * and `default_price.unit_amount` to match that label's list price. The
 * generic catalogue dropdown omits that check so the operator can still
 * see every sellable product.
 * `livemode` and `name` come back for the operator to eyeball; the form
 * preselects a label from the metadata.
 *
 * Workers-bundleable: nothing at module load.
 */

import { CATALOGUE_CURRENCY, isTierLabel } from "../tiers/ladder.ts";
import type { StripeClient } from "./client.ts";
import { StripeApiError } from "./errors.ts";
import {
  type BillingGateway,
  isResolvedTaxBehavior,
  NO_TAX_DEFAULTS,
  PRODUCT_TIER_METADATA_KEY,
  type ProductLadderExpectation,
  type ProductVerification,
  type ProviderPrice,
  type ProviderProduct,
  type ProviderTaxDefaults,
} from "./gateway.ts";

type StripeObject = Record<string, unknown>;

function isObject(value: unknown): value is StripeObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readMetadata(raw: unknown): Record<string, string> {
  if (!isObject(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Normalise one Stripe Price object. */
export function summarizeStripePrice(raw: StripeObject): ProviderPrice {
  const id = str(raw.id);
  if (!id) throw new TypeError("stripe price without an id");
  const recurring = isObject(raw.recurring) ? raw.recurring : null;
  return {
    id,
    active: raw.active === true,
    type: str(raw.type),
    currency: str(raw.currency) ?? "",
    unitAmount: num(raw.unit_amount),
    interval: recurring ? str(recurring.interval) : null,
    intervalCount: recurring ? num(recurring.interval_count) : null,
    billingScheme: str(raw.billing_scheme),
    taxBehavior: str(raw.tax_behavior),
    livemode: raw.livemode === true,
  };
}

/**
 * Normalise one Stripe Product. `default_price` is read only when it came
 * back expanded; a bare id string leaves `defaultPrice` null, which the
 * verification reports rather than silently passing.
 */
export function summarizeStripeProduct(raw: StripeObject): ProviderProduct {
  const id = str(raw.id);
  if (!id) throw new TypeError("stripe product without an id");
  const metadata = readMetadata(raw.metadata);
  const suggested = metadata[PRODUCT_TIER_METADATA_KEY]?.trim().toUpperCase();
  const price = isObject(raw.default_price) ? raw.default_price : null;
  return {
    id,
    name: str(raw.name) ?? id,
    active: raw.active === true,
    livemode: raw.livemode === true,
    metadata,
    suggestedLabel: isTierLabel(suggested) ? suggested : null,
    defaultPrice: price ? summarizeStripePrice(price) : null,
  };
}

/**
 * Every reason this product cannot back a tier row, in operator-readable
 * form. Pure.
 *
 * `taxDefaults` is the account's Stripe Tax configuration. A price whose
 * own `tax_behavior` is `unspecified` is fine when the account carries a
 * default, which is the setup Stripe recommends and the one the Dashboard
 * shows as "Use default".
 */
export function productVerificationFailures(
  product: ProviderProduct,
  taxDefaults: ProviderTaxDefaults = NO_TAX_DEFAULTS,
): string[] {
  const out: string[] = [];
  if (!product.active) out.push("product is archived (active=false)");
  const price = product.defaultPrice;
  if (!price) {
    out.push("product has no default price; set one in the Dashboard");
    return out;
  }
  if (!price.active) out.push("default price is archived (active=false)");
  if (price.type !== null && price.type !== "recurring") {
    out.push(`default price type ${price.type} ≠ recurring`);
  }
  if (price.interval !== "month") {
    out.push(`recurring.interval ${price.interval} ≠ month`);
  }
  if (price.intervalCount !== 1) {
    out.push(`recurring.interval_count ${price.intervalCount} ≠ 1`);
  }
  if (price.billingScheme !== "per_unit") {
    out.push(`billing_scheme ${price.billingScheme} ≠ per_unit`);
  }
  if (price.currency !== CATALOGUE_CURRENCY) {
    out.push(`currency ${price.currency} ≠ ${CATALOGUE_CURRENCY}`);
  }
  if (price.unitAmount === null) out.push("default price has no unit_amount");
  if (
    !isResolvedTaxBehavior(price.taxBehavior) &&
    !isResolvedTaxBehavior(taxDefaults.taxBehavior)
  ) {
    out.push(
      "no tax behaviour resolves for this price: it is unspecified and Stripe Tax carries no " +
        "default. Set a default under Settings → Tax, or set tax_behavior on the price.",
    );
  }
  return out;
}

function ladderMatchFailures(
  product: ProviderProduct,
  expected: ProductLadderExpectation,
): string[] {
  const out: string[] = [];
  if (product.suggestedLabel !== expected.label) {
    out.push(
      product.suggestedLabel
        ? `turbopanel_tier metadata ${product.suggestedLabel} ≠ ${expected.label}`
        : `turbopanel_tier metadata is missing or not ${expected.label}`,
    );
  }
  const amount = product.defaultPrice?.unitAmount ?? null;
  if (amount !== expected.listPriceCents) {
    out.push(
      `default price unit_amount ${amount} ≠ ${expected.listPriceCents}`,
    );
  }
  return out;
}

export function verifyStripeProduct(
  product: ProviderProduct,
  taxDefaults: ProviderTaxDefaults = NO_TAX_DEFAULTS,
  expected: ProductLadderExpectation | null = null,
): ProductVerification {
  const failures = [
    ...productVerificationFailures(product, taxDefaults),
    ...(expected ? ladderMatchFailures(product, expected) : []),
  ];
  return { ok: failures.length === 0, product, failures };
}

/** Normalise `GET /v1/tax/settings`. */
export function summarizeStripeTaxDefaults(
  raw: StripeObject,
): ProviderTaxDefaults {
  const defaults = isObject(raw.defaults) ? raw.defaults : null;
  return {
    taxBehavior: defaults ? str(defaults.tax_behavior) : null,
    status: str(raw.status),
  };
}

/**
 * `GET /v1/tax/settings`.
 *
 * An account with Stripe Tax not yet set up answers with an error rather
 * than an object. That is not fatal here: it means "no default", which
 * makes verification stricter rather than laxer, so it degrades instead of
 * breaking the admin dropdown. Non-Stripe failures still propagate.
 */
export async function getStripeTaxDefaults(
  client: StripeClient,
): Promise<ProviderTaxDefaults> {
  try {
    return summarizeStripeTaxDefaults(
      await client.get<StripeObject>("/v1/tax/settings"),
    );
  } catch (err) {
    if (err instanceof StripeApiError) return NO_TAX_DEFAULTS;
    throw err;
  }
}

/** `GET /v1/products?active=true&expand[]=data.default_price`, every page. */
export async function listStripeProducts(
  client: StripeClient,
): Promise<ProviderProduct[]> {
  const raw = await client.listAll<StripeObject>("/v1/products", {
    active: true,
    expand: ["data.default_price"],
  });
  return raw.map(summarizeStripeProduct);
}

/** `GET /v1/products/:id?expand[]=default_price`. A missing id raises `StripeApiError` (404). */
export async function getStripeProduct(
  client: StripeClient,
  productId: string,
): Promise<ProviderProduct> {
  const raw = await client.get<StripeObject>(
    `/v1/products/${encodeURIComponent(productId)}`,
    { expand: ["default_price"] },
  );
  return summarizeStripeProduct(raw);
}

export function createStripeGateway(client: StripeClient): BillingGateway {
  return {
    id: "stripe",
    listProducts: () => listStripeProducts(client),
    getProduct: (productId) => getStripeProduct(client, productId),
    getTaxDefaults: () => getStripeTaxDefaults(client),
    verifyProduct: (product, taxDefaults, expected) =>
      verifyStripeProduct(product, taxDefaults, expected),
  };
}
