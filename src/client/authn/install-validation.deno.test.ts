import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  colocatedLicenseRevokeError,
  getClientPublicStatus,
  getSignupSettingMeta,
  isInstanceInstalled,
  normalizeSignupEnvOverride,
  readLiveSignupEnvOverrideFromWranglerJsonc,
  readLocalMachineKey,
  resolveEffectiveSignupEnabled,
  resolveIsSignupEnabled,
  resolveSignupEnvOverrideFromContext,
  validateOrganizationName,
  validateSuperadminEmail,
  validateSuperadminPassword,
  validateTeamName,
} from "./install-state.ts";
import type { Db } from "../../db.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

it("validateOrganizationName enforces length and rejects control characters", () => {
  assertEquals(validateOrganizationName("Acme Corp"), null);
  assertEquals(validateOrganizationName("O'Reilly"), null);
  assertEquals(validateOrganizationName("O\u2019Reilly"), null);
  assertEquals(validateOrganizationName("Müller GmbH"), null);
  assertEquals(
    validateOrganizationName(""),
    "Organization name must be 1–255 characters",
  );
  assertEquals(
    validateOrganizationName("x".repeat(256)),
    "Organization name must be 1–255 characters",
  );
  assertEquals(
    validateOrganizationName("Bad\nname"),
    "Organization name cannot contain control characters",
  );
});

it("validateTeamName enforces length only", () => {
  assertEquals(validateTeamName("Platform"), null);
  assertEquals(validateTeamName(""), "Team name must be 1–255 characters");
  assertEquals(
    validateTeamName("x".repeat(256)),
    "Team name must be 1–255 characters",
  );
});

it("validateSuperadminEmail accepts simple RFC-like shapes", () => {
  assertEquals(validateSuperadminEmail("admin@203.0.113.10.example"), null);
  assertEquals(validateSuperadminEmail("bad"), "Enter a valid email address");
  assertEquals(
    validateSuperadminEmail("spaces @example.com"),
    "Enter a valid email address",
  );
  assertEquals(
    validateSuperadminEmail("a@b"),
    "Enter a valid email address",
  );
});

it("validateSuperadminPassword mirrors install password policy", () => {
  assertEquals(
    validateSuperadminPassword(" passw0rd! "),
    "Password must not have leading or trailing whitespace",
  );
  assertEquals(
    validateSuperadminPassword("short1!"),
    "Password must be at least 8 characters",
  );
  assertEquals(
    validateSuperadminPassword("abcdefgh!"),
    "Password must include at least one number",
  );
  assertEquals(
    validateSuperadminPassword("abcdefg1"),
    "Password must include at least one special character",
  );
  assertEquals(validateSuperadminPassword("sup3r-secret!"), null);
});

it("normalizeSignupEnvOverride coerces platform binding shapes", () => {
  assertEquals(normalizeSignupEnvOverride(undefined), undefined);
  assertEquals(normalizeSignupEnvOverride(null), undefined);
  assertEquals(normalizeSignupEnvOverride(true), "1");
  assertEquals(normalizeSignupEnvOverride(false), "0");
  assertEquals(normalizeSignupEnvOverride(1), "1");
  assertEquals(normalizeSignupEnvOverride(Number.NaN), undefined);
  assertEquals(normalizeSignupEnvOverride("  true  "), "true");
  assertEquals(normalizeSignupEnvOverride("   "), undefined);
});

it("resolveSignupEnvOverrideFromContext prefers platform env over fallback", () => {
  assertEquals(
    resolveSignupEnvOverrideFromContext(
      { TURBOPANEL_IS_SIGNUP_ENABLED: "0" },
      "1",
    ),
    "0",
  );
  assertEquals(
    resolveSignupEnvOverrideFromContext(undefined, "1"),
    "1",
  );
});

it("resolveIsSignupEnabled defaults to disabled when unset", () => {
  assertEquals(resolveIsSignupEnabled(undefined, undefined), false);
  assertEquals(resolveIsSignupEnabled("1", "0"), false);
  assertEquals(resolveIsSignupEnabled("0", "1"), true);
  assertEquals(resolveIsSignupEnabled("1", "maybe"), true);
  assertEquals(resolveIsSignupEnabled("0", "maybe"), false);
  assertEquals(resolveIsSignupEnabled(undefined, "false"), false);
  assertEquals(resolveIsSignupEnabled(undefined, "TRUE"), true);
});

it("getClientPublicStatus returns workers shape without install fields", async () => {
  const status = await getClientPublicStatus(undefined, "workers", "0");
  assertEquals(status, {
    ok: true,
    runtime: "workers",
    isSignupEnabled: false,
    isSignupEmailVerificationEnabled: false,
    billingEnabled: false,
  });
});

it("getClientPublicStatus reports billing presence only", async () => {
  const status = await getClientPublicStatus(undefined, "workers", "0", {}, true);
  assertEquals(status?.billingEnabled, true);
  // Never the key — the payload has no field that could carry it.
  assertEquals(Object.keys(status ?? {}).some((k) => /secret|key/i.test(k)), false);
});

it("getSignupSettingMeta reports env force and db value", async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ value: "1" }]),
        }),
      }),
    }),
  } as unknown as Db;

  const meta = await getSignupSettingMeta(db, "deno", "0");
  assertEquals(meta.dbValue, "1");
  assertEquals(meta.isEnvForced, true);
  assertEquals(meta.envOverride, "0");
  assertEquals(meta.enabled, false);
});

it("colocatedLicenseRevokeError returns stable copy", () => {
  assertEquals(
    colocatedLicenseRevokeError(),
    "The license for the co-located control plane daemon cannot be revoked",
  );
});

it("isInstanceInstalled returns false when org exists but no superadmin", async () => {
  let call = 0;
  const noAdminDb = {
    select: () => ({
      from: () => ({
        where: () => {
          call += 1;
          if (call === 1) {
            return {
              limit: () => Promise.resolve([{ id: "org-1" }]),
            };
          }
          return {
            limit: () => Promise.resolve([]),
          };
        },
      }),
    }),
  } as unknown as Db;

  assertEquals(await isInstanceInstalled(noAdminDb), false);
});

it("resolveEffectiveSignupEnabled works without a database client", async () => {
  assertEquals(
    await resolveEffectiveSignupEnabled(undefined, "workers", "1"),
    true,
  );
});

it("getClientPublicStatus returns null for deno without db", async () => {
  assertEquals(await getClientPublicStatus(undefined, "deno", "0"), null);
});

it("normalizeSignupEnvOverride ignores non-primitive and non-finite values", () => {
  assertEquals(normalizeSignupEnvOverride({} as never), undefined);
  assertEquals(normalizeSignupEnvOverride(Number.POSITIVE_INFINITY), undefined);
  assertEquals(normalizeSignupEnvOverride(Number.NEGATIVE_INFINITY), undefined);
});

it("validateSuperadminEmail enforces 3–255 character length", () => {
  assertEquals(validateSuperadminEmail("ab"), "Email must be 3–255 characters");
  assertEquals(
    validateSuperadminEmail("x".repeat(256)),
    "Email must be 3–255 characters",
  );
});

it("readLiveSignupEnvOverrideFromWranglerJsonc handles missing and empty live vars", () => {
  assertEquals(readLiveSignupEnvOverrideFromWranglerJsonc("{}"), undefined);
  assertEquals(
    readLiveSignupEnvOverrideFromWranglerJsonc('{"staging":{"vars":{}}}'),
    undefined,
  );
  assertEquals(
    readLiveSignupEnvOverrideFromWranglerJsonc('{"live":{}}'),
    undefined,
  );
  assertEquals(
    readLiveSignupEnvOverrideFromWranglerJsonc('{"live":{"vars":{}}}'),
    undefined,
  );
  assertEquals(
    readLiveSignupEnvOverrideFromWranglerJsonc(
      '{"live":{"vars":{"TURBOPANEL_IS_SIGNUP_ENABLED":""}}}',
    ),
    undefined,
  );
  assertEquals(
    readLiveSignupEnvOverrideFromWranglerJsonc(
      [
        "{",
        '  "live": { // comment',
        '    "vars": {',
        '      "nested": { "x": 1 },',
        '      "TURBOPANEL_IS_SIGNUP_ENABLED": "0"',
        "    }",
        "  }",
        "}",
      ].join("\n"),
    ),
    "0",
  );
});

it("readLocalMachineKey returns a derived key or undefined on this host", async () => {
  const key = await readLocalMachineKey();
  assertEquals(key === undefined || typeof key === "string", true);
});

test("install validation helpers are functions", () => {
  assertEquals(typeof validateSuperadminEmail, "function");
});
