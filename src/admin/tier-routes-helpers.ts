/**
 * Parsing, validation and serialisation for the superadmin tier catalogue.
 *
 * The `tier` table has no seed any more: a superadmin types rows in, and
 * the only field nothing can derive for them is the Stripe price id. This
 * module is everything about that form that is decidable *without* calling
 * Stripe — the shape rules. What the Price itself must look like is
 * `src/lib/billing/tier-verify.ts`, which the route runs before writing.
 *
 * The split between a refusal and a warning is deliberate:
 *
 *   **refusal**  the row would break something downstream that cannot cope
 *                — a NIC slot count the daemon cannot monitor, a custom row
 *                carrying a price, a malformed label
 *   **warning**  the row is coherent but probably not what was meant — most
 *                importantly a rank whose cores/memory undercut the
 *                placement band, because placement *recommends* tiers from
 *                those bands and would then recommend a tier that cannot
 *                hold the machine it was recommended for
 *
 * Warnings are returned to the operator and do not block the write; the
 * ladder is a business decision and this is not the place to litigate it.
 *
 * Pure, Workers-bundleable: nothing at module load.
 */

import { MAX_NIC_SLOTS } from "../client/servers/topology-types.ts";
import {
  billingCatalogue,
  SX_UNBOUNDED_CORES,
  SX_UNBOUNDED_MEMORY_BYTES,
} from "../lib/billing/catalogue.ts";
import {
  TIER_CPU_CORE_THRESHOLDS,
  TIER_NIC_SLOT_THRESHOLDS,
  TIER_RAM_BYTE_THRESHOLDS,
} from "../lib/tiers/tier-placement.ts";
import type {
  TierReferenceCounts,
  TierRow,
  UpdateTierPatch,
} from "../lib/db/tier-records.ts";

/** `S1`…`S99`, or the negotiated `SX`. */
export const TIER_LABEL_PATTERN = /^S(?:[1-9]\d?|X)$/;

/**
 * Ceilings above which a slot count is refused. NIC is the hard one — the
 * daemon monitors at most {@link MAX_NIC_SLOTS} interfaces, so a tier
 * selling more is selling something that cannot be delivered. The other
 * three are SX's own numbers: nothing in the daemon bounds them, so the top
 * of the shipped ladder is the only defensible ceiling.
 */
export const TIER_SLOT_CEILINGS = {
  nicSlots: MAX_NIC_SLOTS,
  driveSlots: 24,
  gpuSlots: 8,
  filesystemSlots: 18,
} as const;

export type TierFormFields = Readonly<{
  generation: number;
  label: string;
  rank: number;
  priceCents: number | null;
  providerPriceId: string | null;
  isCustom: boolean;
  isActive: boolean;
  maxCores: number;
  maxMemoryBytes: number;
  nicSlots: number;
  driveSlots: number;
  gpuSlots: number;
  filesystemSlots: number;
}>;

export type TierFormIssues = Readonly<{
  /** Blocking. The row is not written while any of these stand. */
  refusals: readonly string[];
  /** Advisory. Returned to the operator; the row is still written. */
  warnings: readonly string[];
}>;

const SLOT_FIELDS = [
  "nicSlots",
  "driveSlots",
  "gpuSlots",
  "filesystemSlots",
] as const;
const POSITIVE_INT_FIELDS = ["maxCores", "maxMemoryBytes"] as const;

function isPositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function refuseIdentity(fields: TierFormFields, refusals: string[]): void {
  if (!isPositiveInt(fields.generation)) {
    refusals.push("generation must be a positive whole number");
  }
  if (!TIER_LABEL_PATTERN.test(fields.label)) {
    refusals.push(`label ${JSON.stringify(fields.label)} must be S1…S99 or SX`);
  }
  if (!isPositiveInt(fields.rank)) {
    refusals.push("rank must be a positive whole number");
  }
}

function refusePricedRow(fields: TierFormFields, refusals: string[]): void {
  if (fields.priceCents === null) {
    refusals.push("a priced tier needs a price in cents");
  } else if (!isPositiveInt(fields.priceCents)) {
    refusals.push("price must be a positive whole number of cents");
  }
  if (fields.providerPriceId === null) {
    refusals.push("a priced tier needs a Stripe price id");
  }
}

function refusePricing(fields: TierFormFields, refusals: string[]): void {
  // A custom row is negotiated per customer: it carries no list price and
  // no Price, which is exactly what makes it unpurchasable through the
  // ordinary flow. A price on it would be bought into by accident.
  if (fields.isCustom) {
    if (fields.priceCents !== null) {
      refusals.push("a custom tier must have no list price");
    }
    if (fields.providerPriceId !== null) {
      refusals.push("a custom tier must have no Stripe price id");
    }
  } else {
    refusePricedRow(fields, refusals);
  }

  if (
    fields.providerPriceId !== null &&
    !fields.providerPriceId.startsWith("price_")
  ) {
    refusals.push(
      `Stripe price id ${
        JSON.stringify(fields.providerPriceId)
      } does not look like a price_… id`,
    );
  }
}

function slotCeilingRefusal(
  field: (typeof SLOT_FIELDS)[number],
  value: number,
  ceiling: number,
): string {
  if (field === "nicSlots") {
    return `nicSlots ${value} exceeds the daemon ceiling of ${ceiling}: a tier cannot sell a slot the daemon cannot monitor`;
  }
  return `${field} ${value} exceeds ${ceiling}, the top of the shipped ladder; nothing bounds it below that`;
}

function refuseCapacity(fields: TierFormFields, refusals: string[]): void {
  for (const field of POSITIVE_INT_FIELDS) {
    if (!isPositiveInt(fields[field])) {
      refusals.push(`${field} must be a positive whole number`);
    }
  }
  for (const field of SLOT_FIELDS) {
    const value = fields[field];
    if (!isNonNegativeInt(value)) {
      refusals.push(`${field} must be a whole number of zero or more`);
      continue;
    }
    const ceiling = TIER_SLOT_CEILINGS[field];
    if (value > ceiling) {
      refusals.push(slotCeilingRefusal(field, value, ceiling));
    }
  }
}

function warnPlacementBands(fields: TierFormFields, warnings: string[]): void {
  // Placement recommends a tier from the cores/RAM bands. A row that sits
  // at a rank but undercuts that rank's band gets recommended for machines
  // it cannot hold — coherent, wrong, and not something to refuse outright
  // because a deliberately re-cut ladder is the operator's call.
  if (fields.isCustom || !isPositiveInt(fields.rank)) return;
  const index = fields.rank - 1;
  const bandCores = TIER_CPU_CORE_THRESHOLDS[index];
  const bandMemory = TIER_RAM_BYTE_THRESHOLDS[index];
  const bandNics = TIER_NIC_SLOT_THRESHOLDS[index];
  if (bandCores !== undefined && fields.maxCores < bandCores) {
    warnings.push(
      `maxCores ${fields.maxCores} is below rank ${fields.rank}'s placement band of ${bandCores}; ` +
        "placement will recommend this tier for machines it cannot hold",
    );
  }
  if (bandMemory !== undefined && fields.maxMemoryBytes < bandMemory) {
    warnings.push(
      `maxMemoryBytes ${fields.maxMemoryBytes} is below rank ${fields.rank}'s placement band of ${bandMemory}; ` +
        "placement will recommend this tier for machines it cannot hold",
    );
  }
  if (bandNics !== undefined && fields.nicSlots < bandNics) {
    warnings.push(
      `nicSlots ${fields.nicSlots} is below rank ${fields.rank}'s placement band of ${bandNics}`,
    );
  }
}

/**
 * Every shape rule, in one place. Ordering inside `refusals` follows the
 * form's field order so the operator reads them top-to-bottom.
 */
export function validateTierForm(fields: TierFormFields): TierFormIssues {
  const refusals: string[] = [];
  const warnings: string[] = [];
  refuseIdentity(fields, refusals);
  refusePricing(fields, refusals);
  refuseCapacity(fields, refusals);
  warnPlacementBands(fields, warnings);
  return { refusals, warnings };
}

/**
 * Warnings about how this row sits against the rest of its generation.
 * Rank decides upgrade-versus-downgrade direction, so a ladder that is not
 * monotonic in price and entitlements makes "upgrade" mean less at some
 * step — worth saying, never worth refusing.
 */
export function ladderOrderWarnings(
  candidate: TierFormFields,
  siblings: readonly TierRow[],
): string[] {
  const out: string[] = [];
  const sameGeneration = siblings
    .filter((row) => row.generation === candidate.generation)
    .sort((a, b) => a.rank - b.rank);
  const below = sameGeneration.findLast((row) => row.rank < candidate.rank);
  const above = sameGeneration.find((row) => row.rank > candidate.rank);

  const compare = (
    lower: {
      label: string;
      priceCents: number | null;
      maxCores: number;
      nicSlots: number;
    },
    upper: {
      label: string;
      priceCents: number | null;
      maxCores: number;
      nicSlots: number;
    },
  ) => {
    if (
      lower.priceCents !== null && upper.priceCents !== null &&
      upper.priceCents < lower.priceCents
    ) {
      out.push(
        `${upper.label} costs less than the lower-ranked ${lower.label}`,
      );
    }
    if (upper.maxCores < lower.maxCores) {
      out.push(
        `${upper.label} entitles fewer cores than the lower-ranked ${lower.label}`,
      );
    }
    if (upper.nicSlots < lower.nicSlots) {
      out.push(
        `${upper.label} entitles fewer NIC slots than the lower-ranked ${lower.label}`,
      );
    }
  };

  if (below) compare(below, candidate);
  if (above) compare(candidate, above);
  return out;
}

/** One row as the admin list renders it, with its reference counts. */
export function serializeAdminTier(
  row: TierRow,
  references: TierReferenceCounts,
) {
  return {
    id: row.id,
    generation: row.generation,
    rank: row.rank,
    label: row.label,
    priceCents: row.priceCents,
    providerPriceId: row.providerPriceId,
    isCustom: row.isCustom,
    isActive: row.isActive,
    successorId: row.successorId,
    entitlements: {
      maxCores: row.maxCores,
      maxMemoryBytes: row.maxMemoryBytes,
      nicSlots: row.nicSlots,
      driveSlots: row.driveSlots,
      gpuSlots: row.gpuSlots,
      filesystemSlots: row.filesystemSlots,
    },
    references,
    /**
     * False once anything points at the row: its entitlement columns are
     * what that history was written in terms of, so only `isActive` and
     * `successorId` may still move.
     */
    entitlementsEditable: references.licenses === 0 && references.seats === 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * What `GET /tiers/defaults` hands the form: the shipped ladder plus the
 * numbers the client would otherwise have to hardcode to validate against.
 */
export function tierFormDefaults() {
  return {
    labelPattern: TIER_LABEL_PATTERN.source,
    currency: "usd",
    slotCeilings: { ...TIER_SLOT_CEILINGS },
    unbounded: {
      maxCores: SX_UNBOUNDED_CORES,
      maxMemoryBytes: SX_UNBOUNDED_MEMORY_BYTES,
    },
    placementBands: {
      maxCores: [...TIER_CPU_CORE_THRESHOLDS],
      maxMemoryBytes: [...TIER_RAM_BYTE_THRESHOLDS],
      nicSlots: [...TIER_NIC_SLOT_THRESHOLDS],
    },
    tiers: billingCatalogue().map((entry) => ({
      label: entry.label,
      rank: entry.rank,
      priceCents: entry.priceCents,
      isCustom: entry.isCustom,
      maxCores: entry.maxCores,
      maxMemoryBytes: entry.maxMemoryBytes,
      nicSlots: entry.nicSlots,
      driveSlots: entry.driveSlots,
      gpuSlots: entry.gpuSlots,
      filesystemSlots: entry.filesystemSlots,
    })),
  };
}

function readInt(
  record: Record<string, unknown>,
  key: string,
): number | null | "invalid" {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return "invalid";
  return value;
}

/**
 * Rejection sentinel for {@link readString}.
 *
 * A symbol rather than the string `'invalid'`: that token is a legal string
 * value, so a string sentinel cannot be told apart from a body that actually
 * sent it.
 */
const PARSE_STRING_INVALID: unique symbol = Symbol("parse_string_invalid");

function readString(
  record: Record<string, unknown>,
  key: string,
): string | null | typeof PARSE_STRING_INVALID {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return PARSE_STRING_INVALID;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readBool(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean | "invalid" {
  const value = record[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") return "invalid";
  return value;
}

/**
 * Parse a create body into complete fields. Anything of the wrong *type*
 * fails here; anything of the wrong *value* is {@link validateTierForm}'s
 * to report, so the operator gets every value problem at once instead of
 * one per round trip.
 */
export function parseTierCreateBody(
  body: Record<string, unknown>,
): TierFormFields | "invalid" {
  const label = readString(body, "label");
  const providerPriceId = readString(body, "providerPriceId");
  if (
    label === PARSE_STRING_INVALID || providerPriceId === PARSE_STRING_INVALID
  ) return "invalid";

  const ints: Record<string, number | null> = {};
  for (
    const key of [
      "generation",
      "rank",
      "priceCents",
      "maxCores",
      "maxMemoryBytes",
      "nicSlots",
      "driveSlots",
      "gpuSlots",
      "filesystemSlots",
    ]
  ) {
    const value = readInt(body, key);
    if (value === "invalid") return "invalid";
    ints[key] = value;
  }
  const isCustom = readBool(body, "isCustom", false);
  const isActive = readBool(body, "isActive", true);
  if (isCustom === "invalid" || isActive === "invalid") return "invalid";

  // Missing numerics become NaN-free sentinels that validation refuses by
  // name, rather than a generic "invalid request" that says nothing.
  const required = (key: string): number => ints[key] ?? -1;

  return {
    generation: required("generation"),
    label: label ?? "",
    rank: required("rank"),
    priceCents: ints.priceCents ?? null,
    providerPriceId,
    isCustom,
    isActive,
    maxCores: required("maxCores"),
    maxMemoryBytes: required("maxMemoryBytes"),
    nicSlots: required("nicSlots"),
    driveSlots: required("driveSlots"),
    gpuSlots: required("gpuSlots"),
    filesystemSlots: required("filesystemSlots"),
  };
}

export type TierPatchBody = Readonly<{
  fields: Partial<Record<keyof TierFormFields, unknown>> & {
    successorId?: string | null;
  };
  /** Keys the caller actually sent — `undefined` and "absent" differ here. */
  present: readonly string[];
}>;

const PATCHABLE_KEYS = [
  "rank",
  "priceCents",
  "providerPriceId",
  "isCustom",
  "isActive",
  "successorId",
  "maxCores",
  "maxMemoryBytes",
  "nicSlots",
  "driveSlots",
  "gpuSlots",
  "filesystemSlots",
] as const;

/** The keys a referenced row still accepts. */
export const REFERENCED_PATCHABLE_KEYS = ["isActive", "successorId"] as const;

/**
 * Which patched keys a referenced row may not accept. Empty means the
 * patch is allowed to proceed.
 */
export function forbiddenPatchKeys(present: readonly string[]): string[] {
  const allowed = new Set<string>(REFERENCED_PATCHABLE_KEYS);
  return present.filter((key) => !allowed.has(key));
}

function patchedValue<T>(
  fields: TierPatchBody["fields"],
  key: string,
  fallback: T,
): T {
  return key in fields ? (fields[key as keyof typeof fields] as T) : fallback;
}

/** The row as it would be after applying a patch, identity columns included. */
export function mergeTierPatch(
  existing: TierRow,
  fields: TierPatchBody["fields"],
): TierFormFields {
  return {
    generation: existing.generation,
    label: existing.label,
    rank: (fields.rank as number | undefined) ?? existing.rank,
    priceCents: patchedValue(fields, "priceCents", existing.priceCents),
    providerPriceId: patchedValue(
      fields,
      "providerPriceId",
      existing.providerPriceId,
    ),
    isCustom: (fields.isCustom as boolean | undefined) ?? existing.isCustom,
    isActive: (fields.isActive as boolean | undefined) ?? existing.isActive,
    maxCores: (fields.maxCores as number | undefined) ?? existing.maxCores,
    maxMemoryBytes: (fields.maxMemoryBytes as number | undefined) ??
      existing.maxMemoryBytes,
    nicSlots: (fields.nicSlots as number | undefined) ?? existing.nicSlots,
    driveSlots: (fields.driveSlots as number | undefined) ??
      existing.driveSlots,
    gpuSlots: (fields.gpuSlots as number | undefined) ?? existing.gpuSlots,
    filesystemSlots: (fields.filesystemSlots as number | undefined) ??
      existing.filesystemSlots,
  };
}

/** Columns to write: present keys only, so `undefined` cannot clear a nullable. */
export function toUpdateTierPatch(
  fields: TierPatchBody["fields"],
): UpdateTierPatch {
  return {
    rank: fields.rank as number | undefined,
    priceCents: "priceCents" in fields
      ? (fields.priceCents as number | null)
      : undefined,
    providerPriceId: "providerPriceId" in fields
      ? (fields.providerPriceId as string | null)
      : undefined,
    isCustom: fields.isCustom as boolean | undefined,
    isActive: fields.isActive as boolean | undefined,
    successorId: "successorId" in fields
      ? (fields.successorId as string | null)
      : undefined,
    maxCores: fields.maxCores as number | undefined,
    maxMemoryBytes: fields.maxMemoryBytes as number | undefined,
    nicSlots: fields.nicSlots as number | undefined,
    driveSlots: fields.driveSlots as number | undefined,
    gpuSlots: fields.gpuSlots as number | undefined,
    filesystemSlots: fields.filesystemSlots as number | undefined,
  };
}

/**
 * `null` when the patch may proceed; otherwise the 409 body. A referenced
 * row may still flip `isActive` / `successorId`.
 */
export function referencedEntitlementRefusal(
  patch: TierPatchBody,
  references: TierReferenceCounts,
):
  | Readonly<{
    error: "tier_referenced";
    message: string;
    forbidden: string[];
    references: TierReferenceCounts;
  }>
  | null {
  if (references.licenses === 0 && references.seats === 0) return null;
  const forbidden = forbiddenPatchKeys(patch.present);
  if (forbidden.length === 0) return null;
  return {
    error: "tier_referenced",
    message:
      `only isActive and successorId may change once a license or seat points at this tier; ` +
      `refused ${forbidden.join(", ")}`,
    forbidden,
    references,
  };
}

export function parseTierPatchBody(
  body: Record<string, unknown>,
): TierPatchBody | "invalid" {
  const present: string[] = [];
  const fields: Record<string, unknown> = {};
  for (const key of PATCHABLE_KEYS) {
    if (!(key in body)) continue;
    present.push(key);
    fields[key] = body[key];
  }
  if (present.length === 0) return "invalid";
  return { fields, present };
}
