/**
 * Pure helpers for the superadmin tier catalogue: body parsers and
 * serializers. No provider call, no Postgres.
 */

import type {
  ProductLadderExpectation,
  ProductVerification,
  ProviderProduct,
} from "../lib/billing/gateway.ts";
import type { TierReferenceCounts, TierRow } from "../lib/db/tier-records.ts";
import {
  isTierLabel,
  LADDER,
  type LadderEntry,
  ladderEntry,
  type TierLabel,
} from "../lib/tiers/ladder.ts";

export type TierCreateFields = Readonly<{
  label: TierLabel;
  /** Null only on the custom / SX row. */
  providerProductId: string | null;
}>;

export type TierPatchFields = Readonly<{
  providerProductId?: string | null;
  isActive?: boolean;
}>;

function optionalProductId(
  value: unknown,
): { ok: true; value: string | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  return { ok: true, value: trimmed.length === 0 ? null : trimmed };
}

/**
 * `{ label, providerProductId? }`. The label must be on the ladder; the
 * product is required for a priced label and must be absent on the custom
 * one — SX is negotiated per customer and never bought through Checkout.
 */
export function parseTierCreateBody(
  body: Record<string, unknown>,
): TierCreateFields | { error: string } {
  const rawLabel = typeof body.label === "string"
    ? body.label.trim().toUpperCase()
    : null;
  if (!rawLabel || !isTierLabel(rawLabel)) {
    return {
      error: `label must be one of ${
        LADDER.map((entry) => entry.label).join(", ")
      }`,
    };
  }
  const entry = ladderEntry(rawLabel)!;
  const productId = optionalProductId(body.providerProductId);
  if (!productId.ok) return { error: "providerProductId must be a string" };
  if (entry.isCustom) {
    if (productId.value) {
      return {
        error: `${entry.label} is negotiated per customer and takes no product`,
      };
    }
    return { label: entry.label, providerProductId: null };
  }
  if (!productId.value) {
    return {
      error: `${entry.label} needs the provider product it bills against`,
    };
  }
  return { label: entry.label, providerProductId: productId.value };
}

/** `{ providerProductId?, isActive? }` — anything else is refused. */
export function parseTierPatchBody(
  body: Record<string, unknown>,
): TierPatchFields | { error: string } {
  const out: { providerProductId?: string | null; isActive?: boolean } = {};
  const productId = optionalProductId(body.providerProductId);
  if (!productId.ok) return { error: "providerProductId must be a string" };
  if (productId.value !== undefined) out.providerProductId = productId.value;
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      return { error: "isActive must be a boolean" };
    }
    out.isActive = body.isActive;
  }
  const known = new Set(["providerProductId", "isActive"]);
  const unknown = Object.keys(body).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    return { error: `unknown field(s): ${unknown.join(", ")}` };
  }
  return out;
}

export function serializeLadderEntry(entry: LadderEntry) {
  return {
    label: entry.label,
    rank: entry.rank,
    isCustom: entry.isCustom,
    listPriceCents: entry.listPriceCents,
    entitlements: {
      maxCores: entry.maxCores,
      maxMemoryBytes: entry.maxMemoryBytes,
      nicSlots: entry.nicSlots,
      driveSlots: entry.driveSlots,
      gpuSlots: entry.gpuSlots,
      filesystemSlots: entry.filesystemSlots,
    },
  };
}

export function serializeAdminTier(
  row: TierRow,
  references: TierReferenceCounts,
) {
  const entry = ladderEntry(row.label);
  return {
    id: row.id,
    label: row.label,
    rank: row.rank,
    provider: row.provider,
    providerProductId: row.providerProductId,
    priceCents: row.priceCents,
    currency: row.currency,
    isCustom: row.isCustom,
    isActive: row.isActive,
    entitlements: entry ? serializeLadderEntry(entry).entitlements : null,
    references,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function serializeProduct(
  product: ProviderProduct,
  verification: ProductVerification,
  tierId: string | null,
) {
  return {
    id: product.id,
    name: product.name,
    active: product.active,
    livemode: product.livemode,
    suggestedLabel: product.suggestedLabel,
    defaultPrice: product.defaultPrice
      ? {
        id: product.defaultPrice.id,
        active: product.defaultPrice.active,
        currency: product.defaultPrice.currency,
        unitAmount: product.defaultPrice.unitAmount,
        interval: product.defaultPrice.interval,
        intervalCount: product.defaultPrice.intervalCount,
        billingScheme: product.defaultPrice.billingScheme,
        taxBehavior: product.defaultPrice.taxBehavior,
      }
      : null,
    verification: { ok: verification.ok, failures: [...verification.failures] },
    /** The tier row already bound to this product, when one is. */
    tierId,
  };
}

/** Which ladder labels have a row, for the form's "still to map" list. */
export function ladderWithRows(rows: readonly TierRow[]) {
  const byLabel = new Map(rows.map((row) => [row.label, row]));
  return LADDER.map((entry) => ({
    ...serializeLadderEntry(entry),
    tierId: byLabel.get(entry.label)?.id ?? null,
  }));
}

/**
 * What a priced ladder label must match on the provider product. SX (and
 * any custom rung) has no product and no list price.
 */
export function ladderProductExpectation(
  label: string,
): ProductLadderExpectation | null {
  if (!isTierLabel(label)) return null;
  const entry = ladderEntry(label);
  if (!entry || entry.isCustom || entry.listPriceCents === null) return null;
  return { label: entry.label, listPriceCents: entry.listPriceCents };
}
