/**
 * `resolveBillingConfig` — the feature gate.
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_STRIPE_API_VERSION,
  isCustomerBillingOperational,
  resolveBillingConfig,
  STRIPE_API_VERSION_ENV,
  STRIPE_SECRET_KEY_ENV,
  STRIPE_WEBHOOK_SIGNING_SECRET_ENV,
} from "./config.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("null when the secret key is absent or blank — that is the whole gate", () => {
  assertEquals(resolveBillingConfig(undefined), null);
  assertEquals(resolveBillingConfig({}), null);
  assertEquals(resolveBillingConfig({ [STRIPE_SECRET_KEY_ENV]: "" }), null);
  assertEquals(resolveBillingConfig({ [STRIPE_SECRET_KEY_ENV]: "   " }), null);
  // A signing secret alone does not turn billing on.
  assertEquals(
    resolveBillingConfig({ [STRIPE_WEBHOOK_SIGNING_SECRET_ENV]: "whsec_x" }),
    null,
  );
});

test("populated when the key is present; signing secret optional; version pinned by default", () => {
  assertEquals(
    resolveBillingConfig({ [STRIPE_SECRET_KEY_ENV]: " sk_test_1 " }),
    {
      secretKey: "sk_test_1",
      webhookSigningSecret: null,
      apiVersion: DEFAULT_STRIPE_API_VERSION,
    },
  );
  assertEquals(
    resolveBillingConfig({
      [STRIPE_SECRET_KEY_ENV]: "sk_test_1",
      [STRIPE_WEBHOOK_SIGNING_SECRET_ENV]: "whsec_1",
      [STRIPE_API_VERSION_ENV]: "2030-01-01",
    }),
    {
      secretKey: "sk_test_1",
      webhookSigningSecret: "whsec_1",
      apiVersion: "2030-01-01",
    },
  );
  // A blank override falls back to the pin rather than sending an empty header.
  assertEquals(
    resolveBillingConfig({
      [STRIPE_SECRET_KEY_ENV]: "sk",
      [STRIPE_API_VERSION_ENV]: " ",
    })?.apiVersion,
    DEFAULT_STRIPE_API_VERSION,
  );
});

test("customer billing is operational only when both the API key and the signing secret are non-empty", () => {
  assertEquals(isCustomerBillingOperational(undefined), false);
  assertEquals(isCustomerBillingOperational(null), false);
  const keyOnly = resolveBillingConfig({
    [STRIPE_SECRET_KEY_ENV]: "sk_test_1",
  });
  assertEquals(isCustomerBillingOperational(keyOnly), false);
  const blankSigning = resolveBillingConfig({
    [STRIPE_SECRET_KEY_ENV]: "sk_test_1",
    [STRIPE_WEBHOOK_SIGNING_SECRET_ENV]: "   ",
  });
  assertEquals(isCustomerBillingOperational(blankSigning), false);
  const both = resolveBillingConfig({
    [STRIPE_SECRET_KEY_ENV]: "sk_test_1",
    [STRIPE_WEBHOOK_SIGNING_SECRET_ENV]: "whsec_1",
  });
  assertEquals(isCustomerBillingOperational(both), true);
});
