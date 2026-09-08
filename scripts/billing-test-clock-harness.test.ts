/**
 * One `deno test` per live-Stripe scenario — the six C16 cases, pinned by
 * name so the set cannot drift. Service-dependent: needs a sandbox key and
 * a hand-entered tier catalogue, so it is registered in
 * `scripts/check-test-inventory.mjs` `SERVICE_DEPENDENT` and never runs in
 * CI. Run it by hand:
 *
 *   TURBOPANEL_STRIPE_SECRET_KEY=sk_test_… TURBOPANEL_DATABASE_URL=… \
 *     deno test -A scripts/billing-test-clock-harness.test.ts
 */
import { assertEquals } from "@std/assert";
import { openHarness, runScenario, SCENARIO_NAMES, SCENARIOS } from "./billing-test-clock-harness.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** The six cases C16 asks for, in run order. */
const EXPECTED_SCENARIOS = [
  "partial-first-month",
  "mid-cycle-upgrade",
  "deferred-downgrade",
  "quantity-up-down",
  "upgrade-while-past-due",
  "dunning-retry-window",
] as const;

test("billing test clocks: the harness is exactly the six C16 scenarios", () => {
  assertEquals([...SCENARIO_NAMES], [...EXPECTED_SCENARIOS]);
});

for (const scenario of SCENARIOS) {
  test(`billing test clocks: ${scenario.name} (${scenario.covers})`, async () => {
    const harness = await openHarness();
    try {
      await runScenario(harness, scenario);
    } finally {
      await harness.close();
    }
  });
}
