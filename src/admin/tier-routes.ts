/**
 * The superadmin tier catalogue: `/api/admin/v1/tiers`.
 *
 * This is what replaced the seed script. Nothing writes `tier` rows on its
 * own any more — the owner creates the Product and Price in the Stripe
 * Dashboard, and a superadmin types the row in here. Every write runs the
 * read-only Stripe verification in `src/lib/billing/tier-verify.ts` first
 * and refuses on any failure, because a wrong price id is silent
 * downstream: the projection logs and skips items whose price maps to no
 * tier, so a typo would lose entitlement rather than error.
 *
 * Shape:
 *
 *   - **root-only.** The admin middleware is already on the router; each
 *     route nests `createRootOnlyMiddleware`, the same pattern
 *     `/secrets/reencrypt` uses.
 *   - **`503` when billing is off**, matching the client billing routes.
 *     There is no catalogue to keep on an instance with no Stripe key.
 *   - **no `DELETE`.** Deactivation is the documented end of a row; a
 *     `tier` a license once held must stay readable, and the FK restricts
 *     anyway.
 *
 * Once any license or seat points at a row, only `is_active` and
 * `successor_id` may still change: the entitlement columns are what that
 * row's history was written in terms of, and editing them rewrites the
 * past.
 */

import type { Context, Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { createRootOnlyMiddleware } from "../client/authn/middleware.ts";
import type { DerivedSecretsConfig } from "../client/authn/secrets.ts";
import { type Db, getDb } from "../db.ts";
import {
  createStripeClient,
  type StripeClient,
} from "../lib/billing/client.ts";
import type { BillingConfig } from "../lib/billing/config.ts";
import { StripeApiError } from "../lib/billing/errors.ts";
import { verifyTierPrice } from "../lib/billing/tier-verify.ts";
import {
  countTierReferences,
  getTierByGenerationLabel,
  getTierById,
  insertTier,
  type TierRow,
  updateTierById,
} from "../lib/db/tier-records.ts";
import { tier } from "../lib/db/schema.ts";
import { asc } from "drizzle-orm";
import {
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

export const BILLING_NOT_CONFIGURED_ERROR = "billing_not_configured";

/** Re-exported so the console and the harness agree on catalogue order. */
export { listActiveTiers } from "../lib/db/tier-records.ts";

type Ctx = Context<AppEnv>;

export type TierRouteDeps = Readonly<{
  createClient?: (config: BillingConfig) => StripeClient;
}>;

/** Every row, active and inactive, in catalogue order. */
async function listAllTiers(db: Db): Promise<TierRow[]> {
  return await db.select().from(tier).orderBy(
    asc(tier.generation),
    asc(tier.rank),
  );
}

function verificationPayload(
  result: Awaited<ReturnType<typeof verifyTierPrice>>,
) {
  return {
    ok: result.ok,
    failures: result.failures,
    price: {
      id: result.price.id,
      active: result.price.active,
      currency: result.price.currency,
      unitAmount: result.price.unitAmount,
      interval: result.price.interval,
      intervalCount: result.price.intervalCount,
      billingScheme: result.price.billingScheme,
      taxBehavior: result.price.taxBehavior,
      // Reported so a live price pasted into a sandbox instance is visible,
      // never checked — the key's own mode is the authority.
      livemode: result.price.livemode,
      lookupKey: result.price.lookupKey,
      nickname: result.price.nickname,
      productId: result.price.productId,
      productName: result.price.productName,
      productActive: result.price.productActive,
    },
  };
}

type VerificationPayload = ReturnType<typeof verificationPayload>;

type VerifyResult =
  | { ok: true; payload: VerificationPayload | null }
  | {
    ok: false;
    body:
      | {
        error: "price_verification_failed";
        message: string;
        verification: VerificationPayload;
      }
      | {
        error: "price_lookup_failed";
        status: number;
        message: string;
      };
  };

/** Database and billing config, or the response that refuses. */
function resolve(c: Ctx): { db: Db; config: BillingConfig } | Response {
  const db = getDb(c);
  if (!db) return c.json({ error: "Database unavailable" }, 503);
  const config = c.get("billingConfig");
  if (!config) return c.json({ error: BILLING_NOT_CONFIGURED_ERROR }, 503);
  return { db, config };
}

async function readBody(c: Ctx): Promise<Record<string, unknown> | Response> {
  const raw = await c.req.text().catch(() => "");
  if (raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      return c.json({ error: "Invalid request" }, 400);
    }
    return parsed as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid request" }, 400);
  }
}

/**
 * Verify a priced row's price against Stripe. A custom row has no price
 * id and is nothing to verify, so it passes trivially.
 */
async function verify(
  client: StripeClient,
  fields: Pick<TierFormFields, "providerPriceId" | "priceCents">,
): Promise<VerifyResult> {
  if (fields.providerPriceId === null) return { ok: true, payload: null };
  try {
    const result = await verifyTierPrice(client, {
      providerPriceId: fields.providerPriceId,
      expectedPriceCents: fields.priceCents,
    });
    if (!result.ok) {
      return {
        ok: false,
        body: {
          error: "price_verification_failed",
          // `message` is the field the console surfaces; without it the
          // operator sees only the bare code and none of the reasons.
          message: result.failures.join("; "),
          verification: verificationPayload(result),
        },
      };
    }
    return { ok: true, payload: verificationPayload(result) };
  } catch (err) {
    if (err instanceof StripeApiError) {
      // A 404 here is the common case — a mistyped or live-mode id. Its
      // message is Stripe's, so it is summarised rather than forwarded.
      return {
        ok: false,
        body: {
          error: "price_lookup_failed",
          status: err.status,
          message: err.status === 404
            ? "Stripe has no price with that id on this key"
            : "Stripe could not be reached to verify the price",
        },
      };
    }
    throw err;
  }
}

async function resolveDeactivateSuccessor(
  db: Db,
  id: string,
  body: Record<string, unknown>,
): Promise<
  | { ok: true; successorId?: string | null }
  | { ok: false; error: string; status: 400 }
> {
  const rawSuccessor = body.successorId;
  if (rawSuccessor === undefined) return { ok: true };
  if (rawSuccessor !== null && typeof rawSuccessor !== "string") {
    return { ok: false, error: "Invalid request", status: 400 };
  }
  if (typeof rawSuccessor !== "string") return { ok: true, successorId: null };
  if (rawSuccessor === id) {
    return { ok: false, error: "a tier cannot succeed itself", status: 400 };
  }
  const successor = await getTierById(db, rawSuccessor);
  if (!successor) {
    return { ok: false, error: "Successor tier not found", status: 400 };
  }
  return { ok: true, successorId: rawSuccessor };
}

async function verifyPriceIfChanged(
  client: StripeClient,
  existing: TierRow,
  merged: TierFormFields,
): Promise<VerifyResult> {
  const priceChanged = merged.providerPriceId !== existing.providerPriceId ||
    merged.priceCents !== existing.priceCents;
  if (!priceChanged) return { ok: true, payload: null };
  return await verify(client, merged);
}

export function registerAdminTierRoutes(
  admin: Hono<AppEnv>,
  opts: { secrets: DerivedSecretsConfig },
  deps: TierRouteDeps = {},
): void {
  const createClient = deps.createClient ??
    ((config: BillingConfig) => createStripeClient(config));
  const rootOnly = createRootOnlyMiddleware(opts.secrets);

  admin.get("/tiers", rootOnly, async (c) => {
    const resolved = resolve(c);
    if (resolved instanceof Response) return resolved;
    const rows = await listAllTiers(resolved.db);
    const tiers = [];
    for (const row of rows) {
      tiers.push(
        serializeAdminTier(row, await countTierReferences(resolved.db, row.id)),
      );
    }
    return c.json({ tiers });
  });

  /**
   * The shipped ladder and the numbers the form validates against, so the
   * console never hardcodes the catalogue. Available whenever billing is
   * on, including before a single row exists — this is what "Add from
   * defaults" reads.
   */
  admin.get("/tiers/defaults", rootOnly, (c) => {
    const resolved = resolve(c);
    if (resolved instanceof Response) return resolved;
    return c.json(tierFormDefaults());
  });

  /** Read-only verification of every priced row — the "Verify all" button. */
  admin.post("/tiers/verify", rootOnly, async (c) => {
    const resolved = resolve(c);
    if (resolved instanceof Response) return resolved;
    const client = createClient(resolved.config);
    const rows = (await listAllTiers(resolved.db)).filter((row) =>
      row.providerPriceId !== null
    );
    const results = [];
    for (const row of rows) {
      try {
        const result = await verifyTierPrice(client, {
          providerPriceId: row.providerPriceId!,
          expectedPriceCents: row.priceCents,
        });
        results.push({
          id: row.id,
          label: row.label,
          generation: row.generation,
          ...verificationPayload(result),
        });
      } catch (err) {
        if (!(err instanceof StripeApiError)) throw err;
        results.push({
          id: row.id,
          label: row.label,
          generation: row.generation,
          ok: false,
          failures: [
            err.status === 404
              ? "Stripe has no price with that id on this key"
              : `Stripe answered ${err.status}`,
          ],
          price: null,
        });
      }
    }
    return c.json({ results });
  });

  admin.post("/tiers", rootOnly, async (c) => {
    const resolved = resolve(c);
    if (resolved instanceof Response) return resolved;
    const body = await readBody(c);
    if (body instanceof Response) return body;

    const fields = parseTierCreateBody(body);
    if (fields === "invalid") return c.json({ error: "Invalid request" }, 400);

    const issues = validateTierForm(fields);
    if (issues.refusals.length > 0) {
      return c.json({
        error: "tier_invalid",
        message: issues.refusals.join("; "),
        refusals: issues.refusals,
        warnings: issues.warnings,
      }, 400);
    }

    // Cheap duplicate check before spending a Stripe call. The unique index
    // is still the authority — two concurrent creates would race past this.
    const clash = await getTierByGenerationLabel(
      resolved.db,
      fields.generation,
      fields.label,
    );
    if (clash) {
      return c.json({
        error: "tier_exists",
        message:
          `generation ${fields.generation} already has a ${fields.label}`,
      }, 409);
    }

    const verified = await verify(createClient(resolved.config), fields);
    if (!verified.ok) return c.json(verified.body, 400);

    const siblings = await listAllTiers(resolved.db);
    let row: TierRow;
    try {
      row = await insertTier(resolved.db, fields);
    } catch (err) {
      // The indexes are the real guard: `(generation, label)`, and the
      // partial unique on `provider_price_id`.
      const message = err instanceof Error ? err.message : String(err);
      if (/unique|duplicate/i.test(message)) {
        return c.json({
          error: "tier_exists",
          message: "a tier with that label, rank or price id already exists",
        }, 409);
      }
      throw err;
    }

    return c.json({
      tier: serializeAdminTier(row, { licenses: 0, seats: 0 }),
      verification: verified.payload,
      warnings: [...issues.warnings, ...ladderOrderWarnings(fields, siblings)],
    }, 201);
  });

  admin.patch("/tiers/:id", rootOnly, async (c) => {
    const resolved = resolve(c);
    if (resolved instanceof Response) return resolved;
    const id = c.req.param("id");
    const existing = await getTierById(resolved.db, id);
    if (!existing) return c.json({ error: "Tier not found" }, 404);

    const body = await readBody(c);
    if (body instanceof Response) return body;
    const patch = parseTierPatchBody(body);
    if (patch === "invalid") return c.json({ error: "Invalid request" }, 400);

    const references = await countTierReferences(resolved.db, id);
    const refusal = referencedEntitlementRefusal(patch, references);
    if (refusal) return c.json(refusal, 409);

    // Validate the whole row as it would be after the patch, so a change
    // cannot walk a row into a shape a create would have refused.
    const merged = mergeTierPatch(existing, patch.fields);
    const issues = validateTierForm(merged);
    if (issues.refusals.length > 0) {
      return c.json({
        error: "tier_invalid",
        message: issues.refusals.join("; "),
        refusals: issues.refusals,
        warnings: issues.warnings,
      }, 400);
    }

    // Re-verify only when the thing being verified moved: the price id or
    // the amount it is checked against.
    const verified = await verifyPriceIfChanged(
      createClient(resolved.config),
      existing,
      merged,
    );
    if (!verified.ok) return c.json(verified.body, 400);

    const updated = await updateTierById(
      resolved.db,
      id,
      toUpdateTierPatch(patch.fields),
    );
    if (!updated) return c.json({ error: "Tier not found" }, 404);

    return c.json({
      tier: serializeAdminTier(updated, references),
      verification: verified.payload,
      warnings: [
        ...issues.warnings,
        ...ladderOrderWarnings(merged, await listAllTiers(resolved.db)),
      ],
    });
  });

  /** Retire a row, optionally naming what replaces it. Never deletes. */
  admin.post("/tiers/:id/deactivate", rootOnly, async (c) => {
    const resolved = resolve(c);
    if (resolved instanceof Response) return resolved;
    const id = c.req.param("id");
    const existing = await getTierById(resolved.db, id);
    if (!existing) return c.json({ error: "Tier not found" }, 404);

    const body = await readBody(c);
    if (body instanceof Response) return body;
    const successor = await resolveDeactivateSuccessor(resolved.db, id, body);
    if (!successor.ok) {
      return c.json({ error: successor.error }, successor.status);
    }

    const updated = await updateTierById(resolved.db, id, {
      isActive: false,
      successorId: successor.successorId,
    });
    if (!updated) return c.json({ error: "Tier not found" }, 404);
    return c.json({
      tier: serializeAdminTier(
        updated,
        await countTierReferences(resolved.db, id),
      ),
    });
  });

  admin.post("/tiers/:id/verify", rootOnly, async (c) => {
    const resolved = resolve(c);
    if (resolved instanceof Response) return resolved;
    const id = c.req.param("id");
    const row = await getTierById(resolved.db, id);
    if (!row) return c.json({ error: "Tier not found" }, 404);
    if (!row.providerPriceId) {
      return c.json({
        error: "tier_has_no_price",
        message: "a custom tier has no Stripe price to verify",
      }, 400);
    }
    const verified = await verify(createClient(resolved.config), row);
    if (!verified.ok) return c.json(verified.body, 400);
    return c.json({ verification: verified.payload });
  });
}
