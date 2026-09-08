/**
 * The tier form's shape rules — everything decidable without calling
 * Stripe. The split that matters: a refusal blocks the write because
 * something downstream cannot cope, a warning is returned and the row is
 * still written because the ladder is the operator's business decision.
 */

import { assertEquals } from "@std/assert";
import { MAX_NIC_SLOTS } from "../client/servers/topology-types.ts";
import type { TierRow } from "../lib/db/tier-records.ts";
import {
  forbiddenPatchKeys,
  ladderOrderWarnings,
  mergeTierPatch,
  parseTierCreateBody,
  parseTierPatchBody,
  referencedEntitlementRefusal,
  serializeAdminTier,
  tierFormDefaults,
  type TierFormFields,
  toUpdateTierPatch,
  validateTierForm,
} from "./tier-routes-helpers.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const GIB = 1024 ** 3;

/** A row matching the shipped S3: rank 3, 16 cores, 64 GiB, 5 NICs. */
function fields(overrides: Partial<TierFormFields> = {}): TierFormFields {
  return {
    generation: 1,
    label: "S3",
    rank: 3,
    priceCents: 1000,
    providerPriceId: "price_s3",
    isCustom: false,
    isActive: true,
    maxCores: 16,
    maxMemoryBytes: 64 * GIB,
    nicSlots: 5,
    driveSlots: 6,
    gpuSlots: 2,
    filesystemSlots: 9,
    ...overrides,
  };
}

function row(overrides: Partial<TierRow> = {}): TierRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    generation: 1,
    rank: 3,
    label: "S3",
    priceCents: 1000,
    providerPriceId: "price_s3",
    isCustom: false,
    isActive: true,
    successorId: null,
    maxCores: 16,
    maxMemoryBytes: 64 * GIB,
    nicSlots: 5,
    driveSlots: 6,
    gpuSlots: 2,
    filesystemSlots: 9,
    ...overrides,
  } as TierRow;
}

test("a row matching the shipped ladder produces neither refusal nor warning", () => {
  assertEquals(validateTierForm(fields()), { refusals: [], warnings: [] });
});

test("labels outside S1…S99 / SX are refused", () => {
  for (const label of ["", "s3", "S0", "S100", "SY", "S3 ", "XL"]) {
    const issues = validateTierForm(fields({ label }));
    assertEquals(
      issues.refusals.some((line) => line.startsWith("label ")),
      true,
      `expected ${JSON.stringify(label)} to be refused`,
    );
  }
  for (const label of ["S1", "S9", "S10", "S99", "SX"]) {
    const issues = validateTierForm(fields({ label, rank: 1 }));
    assertEquals(
      issues.refusals.some((line) => line.startsWith("label ")),
      false,
      `expected ${label} to pass`,
    );
  }
});

test("a custom row must carry neither a price nor a price id", () => {
  const withPrice = validateTierForm(
    fields({
      label: "SX",
      isCustom: true,
      priceCents: 5000,
      providerPriceId: null,
    }),
  );
  assertEquals(
    withPrice.refusals.includes("a custom tier must have no list price"),
    true,
  );
  const withId = validateTierForm(
    fields({
      label: "SX",
      isCustom: true,
      priceCents: null,
      providerPriceId: "price_x",
    }),
  );
  assertEquals(
    withId.refusals.includes("a custom tier must have no Stripe price id"),
    true,
  );
  // The clean custom shape passes.
  const ok = validateTierForm(fields({
    label: "SX",
    rank: 8,
    isCustom: true,
    priceCents: null,
    providerPriceId: null,
    maxCores: 2_147_483_647,
    maxMemoryBytes: Number.MAX_SAFE_INTEGER,
    nicSlots: MAX_NIC_SLOTS,
    driveSlots: 24,
    gpuSlots: 8,
    filesystemSlots: 18,
  }));
  assertEquals(ok.refusals, []);
});

test("a priced row needs both a price and a price id, and the id must look like one", () => {
  assertEquals(
    validateTierForm(fields({ priceCents: null })).refusals.includes(
      "a priced tier needs a price in cents",
    ),
    true,
  );
  assertEquals(
    validateTierForm(fields({ providerPriceId: null })).refusals.includes(
      "a priced tier needs a Stripe price id",
    ),
    true,
  );
  assertEquals(
    validateTierForm(fields({ providerPriceId: "prod_s3" })).refusals.some((
      l,
    ) => l.includes("does not look like")),
    true,
  );
});

test("NIC slots above the daemon ceiling are refused, and the message says why", () => {
  const issues = validateTierForm(fields({ nicSlots: MAX_NIC_SLOTS + 1 }));
  assertEquals(issues.refusals.length, 1);
  assertEquals(issues.refusals[0]?.includes("the daemon cannot monitor"), true);
  // Exactly at the ceiling is fine.
  assertEquals(
    validateTierForm(fields({ nicSlots: MAX_NIC_SLOTS, rank: 7 })).refusals,
    [],
  );
});

test("drive, GPU and filesystem slots above the top of the shipped ladder are refused", () => {
  assertEquals(validateTierForm(fields({ driveSlots: 25 })).refusals.length, 1);
  assertEquals(validateTierForm(fields({ gpuSlots: 9 })).refusals.length, 1);
  assertEquals(
    validateTierForm(fields({ filesystemSlots: 19 })).refusals.length,
    1,
  );
  // At the ceiling, accepted.
  assertEquals(
    validateTierForm(
      fields({ driveSlots: 24, gpuSlots: 8, filesystemSlots: 18 }),
    ).refusals,
    [],
  );
});

test("undercutting the rank placement band warns but does not refuse", () => {
  // Rank 3's band is 16 cores / 64 GiB; this row sells 8 / 32 GiB.
  const issues = validateTierForm(
    fields({ maxCores: 8, maxMemoryBytes: 32 * GIB }),
  );
  assertEquals(issues.refusals, []);
  assertEquals(issues.warnings.length, 2);
  assertEquals(
    issues.warnings.every((line) => line.includes("cannot hold")),
    true,
  );
});

test("non-integer and non-positive numbers are refused by field name", () => {
  assertEquals(
    validateTierForm(fields({ maxCores: 0 })).refusals.includes(
      "maxCores must be a positive whole number",
    ),
    true,
  );
  assertEquals(
    validateTierForm(fields({ maxCores: 1.5 })).refusals.includes(
      "maxCores must be a positive whole number",
    ),
    true,
  );
  assertEquals(
    validateTierForm(fields({ nicSlots: -1 })).refusals.includes(
      "nicSlots must be a whole number of zero or more",
    ),
    true,
  );
  assertEquals(
    validateTierForm(fields({ generation: 0 })).refusals.includes(
      "generation must be a positive whole number",
    ),
    true,
  );
  assertEquals(
    validateTierForm(fields({ rank: 0 })).refusals.includes(
      "rank must be a positive whole number",
    ),
    true,
  );
  // Zero slots is legitimate — the entry tier's filesystem carve-out is zero.
  assertEquals(validateTierForm(fields({ gpuSlots: 0 })).refusals, []);
});

test("ladderOrderWarnings names a rung that costs less or entitles less than the one below", () => {
  const siblings = [
    row({ rank: 2, label: "S2", priceCents: 750, maxCores: 10, nicSlots: 2 }),
  ];
  assertEquals(
    ladderOrderWarnings(fields({ rank: 3, priceCents: 500 }), siblings),
    [
      "S3 costs less than the lower-ranked S2",
    ],
  );
  assertEquals(
    ladderOrderWarnings(fields({ rank: 3, maxCores: 8 }), siblings),
    [
      "S3 entitles fewer cores than the lower-ranked S2",
    ],
  );
  // A monotonic ladder says nothing.
  assertEquals(ladderOrderWarnings(fields(), siblings), []);
});

test("ladderOrderWarnings compares against the rung above too, and ignores other generations", () => {
  const above = [
    row({
      id: "x",
      rank: 4,
      label: "S4",
      priceCents: 900,
      maxCores: 32,
      nicSlots: 5,
    }),
  ];
  assertEquals(
    ladderOrderWarnings(fields({ rank: 3, priceCents: 1000 }), above),
    [
      "S4 costs less than the lower-ranked S3",
    ],
  );
  const otherGeneration = [
    row({
      rank: 2,
      label: "S2",
      generation: 2,
      priceCents: 9999,
      maxCores: 999,
    }),
  ];
  assertEquals(ladderOrderWarnings(fields(), otherGeneration), []);
});

test("serializeAdminTier reports the reference counts and locks entitlements once referenced", () => {
  const free = serializeAdminTier(row(), { licenses: 0, seats: 0 });
  assertEquals(free.entitlementsEditable, true);
  assertEquals(free.entitlements.maxCores, 16);
  assertEquals(free.providerPriceId, "price_s3");

  assertEquals(
    serializeAdminTier(row(), { licenses: 1, seats: 0 }).entitlementsEditable,
    false,
  );
  assertEquals(
    serializeAdminTier(row(), { licenses: 0, seats: 1 }).entitlementsEditable,
    false,
  );
});

test("tierFormDefaults carries the whole ladder plus the numbers the form validates against", () => {
  const defaults = tierFormDefaults();
  assertEquals(defaults.tiers.map((t) => t.label), [
    "S1",
    "S2",
    "S3",
    "S4",
    "S5",
    "S6",
    "S7",
    "SX",
  ]);
  assertEquals(defaults.slotCeilings.nicSlots, MAX_NIC_SLOTS);
  assertEquals(defaults.currency, "usd");
  assertEquals(defaults.placementBands.maxCores.length, 7);
  // SX is prefilled unpriced, so "Add from defaults" cannot produce a
  // custom row that carries a price.
  assertEquals(defaults.tiers.at(-1)?.priceCents, null);
  assertEquals(defaults.tiers.at(-1)?.isCustom, true);
});

test("parseTierCreateBody rejects wrong types and leaves value problems to validation", () => {
  assertEquals(parseTierCreateBody({ label: 5 }), "invalid");
  assertEquals(parseTierCreateBody({ generation: "one" }), "invalid");
  assertEquals(parseTierCreateBody({ isCustom: "yes" }), "invalid");

  // A body missing its numbers parses, then fails validation by field name.
  const sparse = parseTierCreateBody({ label: "S3" });
  assertEquals(sparse === "invalid", false);
  if (sparse !== "invalid") {
    const issues = validateTierForm(sparse);
    assertEquals(
      issues.refusals.includes("maxCores must be a positive whole number"),
      true,
    );
  }

  // A blank price id string is the same as absent, so whitespace cannot
  // slip past the "priced tiers need an id" refusal.
  const blank = parseTierCreateBody({ label: "S3", providerPriceId: "   " });
  assertEquals(blank === "invalid", false);
  if (blank !== "invalid") assertEquals(blank.providerPriceId, null);

  // The word "invalid" is a legal string, not the type-error sentinel.
  const namedInvalid = parseTierCreateBody({ label: "invalid" });
  assertEquals(namedInvalid === "invalid", false);
  if (namedInvalid !== "invalid") assertEquals(namedInvalid.label, "invalid");
});

test("parseTierPatchBody keeps only patchable keys and records which were present", () => {
  const patch = parseTierPatchBody({
    isActive: false,
    label: "S9",
    nicSlots: 4,
  });
  assertEquals(patch === "invalid", false);
  if (patch !== "invalid") {
    // `label` is identity, not data — a re-label is a new row.
    assertEquals(patch.present.includes("label"), false);
    assertEquals([...patch.present].sort(), ["isActive", "nicSlots"]);
  }
  // An empty patch is a client bug, not a no-op write.
  assertEquals(parseTierPatchBody({}), "invalid");
  assertEquals(parseTierPatchBody({ label: "S9" }), "invalid");
});

test("a referenced row accepts only isActive and successorId", () => {
  assertEquals(forbiddenPatchKeys(["isActive", "successorId"]), []);
  assertEquals(forbiddenPatchKeys(["isActive", "nicSlots", "priceCents"]), [
    "nicSlots",
    "priceCents",
  ]);
  // An explicit null successor (clearing it) is still just the key.
  assertEquals(forbiddenPatchKeys(["successorId"]), []);
});

test("mergeTierPatch overlays only the patched fields", () => {
  const patch = parseTierPatchBody({
    isActive: false,
    nicSlots: 7,
    priceCents: null,
  });
  if (patch === "invalid") throw new TypeError("expected a patch");
  const merged = mergeTierPatch(row(), patch.fields);
  assertEquals(merged.isActive, false);
  assertEquals(merged.nicSlots, 7);
  assertEquals(merged.priceCents, null);
  assertEquals(merged.rank, 3);
  assertEquals(merged.providerPriceId, "price_s3");
});

test("toUpdateTierPatch leaves unpatched columns undefined so they cannot clear", () => {
  const patch = parseTierPatchBody({ isActive: false, priceCents: null });
  if (patch === "invalid") throw new TypeError("expected a patch");
  const update = toUpdateTierPatch(patch.fields);
  assertEquals(update.isActive, false);
  assertEquals(update.priceCents, null);
  assertEquals(update.rank, undefined);
  assertEquals(update.nicSlots, undefined);
});

test("referencedEntitlementRefusal names the forbidden keys only when the row is in use", () => {
  const entitlement = parseTierPatchBody({ nicSlots: 4, isActive: false });
  if (entitlement === "invalid") throw new TypeError("expected a patch");
  const refusal = referencedEntitlementRefusal(entitlement, {
    licenses: 1,
    seats: 0,
  });
  assertEquals(refusal?.error, "tier_referenced");
  assertEquals(refusal?.forbidden, ["nicSlots"]);
  assertEquals(
    referencedEntitlementRefusal(entitlement, { licenses: 0, seats: 0 }),
    null,
  );

  const allowed = parseTierPatchBody({ isActive: false });
  if (allowed === "invalid") throw new TypeError("expected a patch");
  assertEquals(
    referencedEntitlementRefusal(allowed, { licenses: 1, seats: 0 }),
    null,
  );
});
