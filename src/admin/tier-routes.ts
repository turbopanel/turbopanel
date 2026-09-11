/**
 * The superadmin tier catalogue: `/api/admin/v1/tiers`.
 *
 * A tier row binds a ladder label (`S1`…`S7`, `SX`) to a product on the
 * payment provider. The provider owns the price; the ladder
 * (`src/lib/tiers/ladder.ts`) owns what the label entitles; the row owns
 * only the binding and a cached display price. So the form is one
 * dropdown: `GET /tiers/products` lists the provider's active products
 * with their default price and a pass/fail verification, the operator
 * picks one per label, and `POST /tiers` verifies it again before
 * writing — a wrong product is silent downstream (the projection logs and
 * skips items whose product maps to no tier), so nothing unverified lands.
 *
 * Shape:
 *
 *   - **root-only.** The admin middleware is already on the router; each
 *     route nests `createRootOnlyMiddleware`, the same pattern
 *     `/secrets/reencrypt` uses.
 *   - **`503` when billing is off**, matching the client billing routes.
 *   - **no `DELETE`.** Deactivation is the documented end of a row; a
 *     `tier` a seat once counted against must stay readable, and the FK
 *     restricts anyway.
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
import {
  type BillingGateway,
  needsAccountTaxDefaults,
  NO_TAX_DEFAULTS,
  type ProductLadderExpectation,
  type ProductVerification,
  resolveBillingGateway,
} from "../lib/billing/gateway.ts";
import {
  countTierReferences,
  getTierById,
  getTierByLabel,
  insertTier,
  listAllTiers,
  type TierRow,
  updateTierById,
} from "../lib/db/tier-records.ts";
import {
  ladderProductExpectation,
  ladderWithRows,
  parseTierCreateBody,
  parseTierPatchBody,
  serializeAdminTier,
  serializeProduct,
  type TierPatchFields,
} from "./tier-routes-helpers.ts";

export const BILLING_NOT_CONFIGURED_ERROR = "billing_not_configured";

/** Re-exported so the console and the harness agree on catalogue order. */
export { listActiveTiers } from "../lib/db/tier-records.ts";

type Ctx = Context<AppEnv>;

export type TierRouteDeps = Readonly<{
  createClient?: (config: BillingConfig) => StripeClient;
  /** Test seam: the gateway over the client. */
  resolveGateway?: (client: StripeClient) => BillingGateway;
}>;

function verificationPayload(result: ProductVerification) {
  return {
    ok: result.ok,
    failures: [...result.failures],
    product: serializeProduct(result.product, result, null),
  };
}

type VerificationPayload = ReturnType<typeof verificationPayload>;

type VerifyResult =
  | {
    ok: true;
    payload: VerificationPayload | null;
    priceCents: number | null;
    currency: string | null;
  }
  | {
    ok: false;
    body:
      | {
        error: "product_verification_failed";
        message: string;
        verification: VerificationPayload;
      }
      | {
        error: "product_lookup_failed";
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
 * Verify a product against the provider. A custom row has no product and
 * is nothing to verify, so it passes trivially.
 */
async function verify(
  gateway: BillingGateway,
  providerProductId: string | null,
  expected: ProductLadderExpectation | null = null,
): Promise<VerifyResult> {
  if (providerProductId === null) {
    return { ok: true, payload: null, priceCents: null, currency: null };
  }
  try {
    const product = await gateway.getProduct(providerProductId);
    // The account's Tax settings default can satisfy a price whose own
    // tax_behavior is "unspecified", so verification needs both — but only
    // such a price is worth a second provider round trip.
    const taxDefaults = needsAccountTaxDefaults(product)
      ? await gateway.getTaxDefaults()
      : NO_TAX_DEFAULTS;
    const result = gateway.verifyProduct(product, taxDefaults, expected);
    if (!result.ok) {
      return {
        ok: false,
        body: {
          error: "product_verification_failed",
          // `message` is the field the console surfaces; without it the
          // operator sees only the bare code and none of the reasons.
          message: result.failures.join("; "),
          verification: verificationPayload(result),
        },
      };
    }
    return {
      ok: true,
      payload: verificationPayload(result),
      priceCents: product.defaultPrice?.unitAmount ?? null,
      currency: product.defaultPrice?.currency ?? null,
    };
  } catch (err) {
    if (err instanceof StripeApiError) {
      return {
        ok: false,
        body: {
          error: "product_lookup_failed",
          status: err.status,
          message: err.status === 404
            ? "the provider has no product with that id on this key"
            : "the provider could not be reached to verify the product",
        },
      };
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unique|duplicate/i.test(message);
}

/**
 * The product binding only moves one way per row kind: the custom row never
 * gains a product, a priced row never loses one. Null when the patch is fine.
 */
function productPatchError(
  existing: TierRow,
  patch: TierPatchFields,
): string | null {
  if (patch.providerProductId === undefined) return null;
  if (existing.isCustom && patch.providerProductId !== null) {
    return `${existing.label} takes no product`;
  }
  if (!existing.isCustom && patch.providerProductId === null) {
    return `${existing.label} needs a product`;
  }
  return null;
}

/**
 * Re-verify only when the thing being verified moved. `openGateway` is a
 * thunk so an unrelated patch never builds a provider client.
 */
async function verifyPatchedProduct(
  openGateway: () => BillingGateway,
  existing: TierRow,
  patch: TierPatchFields,
): Promise<VerifyResult | null> {
  if (patch.providerProductId === undefined) return null;
  if (patch.providerProductId === existing.providerProductId) return null;
  return await verify(
    openGateway(),
    patch.providerProductId,
    ladderProductExpectation(existing.label),
  );
}

/** Only the fields the patch names, plus the price a fresh verification returned. */
function tierUpdateFields(
  patch: TierPatchFields,
  verified: VerifyResult | null,
) {
  return {
    ...(patch.providerProductId !== undefined
      ? { providerProductId: patch.providerProductId }
      : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    ...(verified?.ok
      ? { priceCents: verified.priceCents, currency: verified.currency }
      : {}),
  };
}

export function registerAdminTierRoutes(
  admin: Hono<AppEnv>,
  opts: { secrets: DerivedSecretsConfig },
  deps: TierRouteDeps = {},
): void {
  const createClient = deps.createClient ??
    ((config: BillingConfig) => createStripeClient(config));
  const resolveGateway = deps.resolveGateway ?? resolveBillingGateway;
  const gatewayFor = (config: BillingConfig) =>
    resolveGateway(createClient(config));
  const rootOnly = createRootOnlyMiddleware(opts.secrets);

  /** Every row with its references, plus the ladder with which labels are still unmapped. */
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
    return c.json({ tiers, ladder: ladderWithRows(rows) });
  });

  /**
   * The provider's active products with their default price, each with
   * the verification the form shows inline and the tier already bound to
   * it — the dropdown, so nobody copies an id out of the Dashboard.
   */
  admin.get("/tiers/products", rootOnly, async (c) => {
    const resolved = resolve(c);
    if (resolved instanceof Response) return resolved;
    const gateway = gatewayFor(resolved.config);
    let products;
    try {
      products = await gateway.listProducts();
    } catch (err) {
      if (!(err instanceof StripeApiError)) throw err;
      return c.json({
        error: "product_lookup_failed",
        status: err.status,
        message: "the provider could not be reached to list products",
      }, 502);
    }
    const taxDefaults = products.some(needsAccountTaxDefaults)
      ? await gateway.getTaxDefaults()
      : NO_TAX_DEFAULTS;
    const rows = await listAllTiers(resolved.db);
    const tierByProduct = new Map(
      rows.flatMap((row) =>
        row.providerProductId ? [[row.providerProductId, row.id] as const] : []
      ),
    );
    return c.json({
      provider: gateway.id,
      // Surfaced so the operator can see *why* a price left at "Use
      // default" passes, without opening the Stripe Dashboard.
      taxDefaults,
      products: products.map((product) =>
        serializeProduct(
          product,
          gateway.verifyProduct(product, taxDefaults),
          tierByProduct.get(product.id) ?? null,
        )
      ),
    });
  });

  /** Re-verify every priced row and refresh its cached price — the "Verify all" button. */
  admin.post("/tiers/verify", rootOnly, async (c) => {
    const resolved = resolve(c);
    if (resolved instanceof Response) return resolved;
    const gateway = gatewayFor(resolved.config);
    const rows = (await listAllTiers(resolved.db)).filter((row) =>
      row.providerProductId !== null
    );
    const results = [];
    for (const row of rows) {
      const verified = await verify(
        gateway,
        row.providerProductId,
        ladderProductExpectation(row.label),
      );
      if (verified.ok) {
        await updateTierById(resolved.db, row.id, {
          priceCents: verified.priceCents,
          currency: verified.currency,
        });
        results.push({ id: row.id, label: row.label, ...verified.payload! });
      } else {
        results.push({
          id: row.id,
          label: row.label,
          ok: false,
          failures: [verified.body.message],
          product: null,
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
    if ("error" in fields) {
      return c.json({ error: "tier_invalid", message: fields.error }, 400);
    }

    // Cheap duplicate check before spending a provider call. The unique
    // index is still the authority — two concurrent creates would race past this.
    const clash = await getTierByLabel(resolved.db, fields.label);
    if (clash) {
      return c.json({
        error: "tier_exists",
        message: `${fields.label} already has a row`,
      }, 409);
    }

    const verified = await verify(
      gatewayFor(resolved.config),
      fields.providerProductId,
      ladderProductExpectation(fields.label),
    );
    if (!verified.ok) return c.json(verified.body, 400);

    let row: TierRow;
    try {
      row = await insertTier(resolved.db, {
        label: fields.label,
        providerProductId: fields.providerProductId,
        priceCents: verified.priceCents,
        currency: verified.currency,
      });
    } catch (err) {
      // The indexes are the real guard: `label`, and the partial unique on `(provider, provider_product_id)`.
      if (isUniqueViolation(err)) {
        return c.json({
          error: "tier_exists",
          message: "a tier with that label or product already exists",
        }, 409);
      }
      throw err;
    }

    return c.json({
      tier: serializeAdminTier(row, { seats: 0, servers: 0 }),
      verification: verified.payload,
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
    if ("error" in patch) {
      return c.json({ error: "tier_invalid", message: patch.error }, 400);
    }
    const productError = productPatchError(existing, patch);
    if (productError !== null) {
      return c.json({ error: "tier_invalid", message: productError }, 400);
    }

    const verified = await verifyPatchedProduct(
      () => gatewayFor(resolved.config),
      existing,
      patch,
    );
    if (verified && !verified.ok) return c.json(verified.body, 400);

    let updated: TierRow | null;
    try {
      updated = await updateTierById(
        resolved.db,
        id,
        tierUpdateFields(patch, verified),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({
          error: "tier_exists",
          message: "another tier already bills against that product",
        }, 409);
      }
      throw err;
    }
    if (!updated) return c.json({ error: "Tier not found" }, 404);

    return c.json({
      tier: serializeAdminTier(
        updated,
        await countTierReferences(resolved.db, id),
      ),
      verification: verified?.ok ? verified.payload : null,
    });
  });

  /** Retire a row. Never deletes. */
  admin.post("/tiers/:id/deactivate", rootOnly, async (c) => {
    const resolved = resolve(c);
    if (resolved instanceof Response) return resolved;
    const id = c.req.param("id");
    const existing = await getTierById(resolved.db, id);
    if (!existing) return c.json({ error: "Tier not found" }, 404);
    const updated = await updateTierById(resolved.db, id, { isActive: false });
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
    if (!row.providerProductId) {
      return c.json({
        error: "tier_has_no_product",
        message: "a custom tier has no provider product to verify",
      }, 400);
    }
    const verified = await verify(
      gatewayFor(resolved.config),
      row.providerProductId,
      ladderProductExpectation(row.label),
    );
    if (!verified.ok) return c.json(verified.body, 400);
    const updated = await updateTierById(resolved.db, id, {
      priceCents: verified.priceCents,
      currency: verified.currency,
    });
    return c.json({
      verification: verified.payload,
      tier: serializeAdminTier(
        updated ?? row,
        await countTierReferences(resolved.db, id),
      ),
    });
  });
}
