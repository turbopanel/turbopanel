/**
 * Host-free coverage gaps for license create body parsing.
 */

import { assertEquals } from "@std/assert";
import { DISPLAY_NAME_MAX_LENGTH } from "../../lib/display-name-format.ts";
import {
  installBaseUrlValidationError,
  isInvalidInstallBaseUrl,
  isReservedColocatedLicenseName,
  noLicenseAvailableBody,
  parseLicenseCreateFields,
  reservedColocatedLicenseNameError,
  serializeLicenseListEntry,
  serverCapacityExceededBody,
} from "./routes-helpers.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseLicenseCreateFields accepts partial string fields and ignores extras", () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: "Edge node" })),
    { name: "Edge node" },
  );
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: "Rack 2" })),
    { name: "Rack 2" },
  );
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      name: "Preferred",
      installBaseUrl: "https://panel.example.com",
      extra: "ignored",
    })),
    {
      name: "Preferred",
      installBaseUrl: "https://panel.example.com",
    },
  );
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      installBaseUrl: "https://panel.example.com",
      extra: "ignored",
    })),
    { installBaseUrl: "https://panel.example.com" },
  );
});

test("parseLicenseCreateFields normalizes Unicode, smart quotes, and trimming", () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: "Café 东京" })),
    { name: "Café 东京" },
  );
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: "  O\u2019Reilly  " })),
    { name: "O'Reilly" },
  );
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: "  Edge node  " })),
    { name: "Edge node" },
  );
});

test("parseLicenseCreateFields omits absent and whitespace-only optional names", () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: "" })),
    {},
  );
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: "   " })),
    {},
  );
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      name: "Legacy",
      installBaseUrl: "https://panel.example.com",
    })),
    {
      name: "Legacy",
      installBaseUrl: "https://panel.example.com",
    },
  );
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      name: "Preferred",
      displayName: "Ignored",
    })),
    { name: "Preferred" },
  );
});

test("parseLicenseCreateFields rejects control characters and over-length names", () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: "bad\nname" })),
    "invalid",
  );
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      name: "a".repeat(DISPLAY_NAME_MAX_LENGTH + 1),
    })),
    "invalid",
  );
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      name: "😀".repeat(DISPLAY_NAME_MAX_LENGTH),
    })),
    { name: "😀".repeat(DISPLAY_NAME_MAX_LENGTH) },
  );
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({
      name: "😀".repeat(DISPLAY_NAME_MAX_LENGTH + 1),
    })),
    "invalid",
  );
});

test("parseLicenseCreateFields rejects numeric field types", () => {
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ installBaseUrl: 8443 })),
    "invalid",
  );
  assertEquals(
    parseLicenseCreateFields(JSON.stringify({ name: 2 })),
    "invalid",
  );
});

test("reserved colocated license name helpers", () => {
  assertEquals(
    isReservedColocatedLicenseName("this server", "this server"),
    true,
  );
  assertEquals(
    isReservedColocatedLicenseName("  this server  ", "this server"),
    true,
  );
  assertEquals(
    isReservedColocatedLicenseName("THIS SERVER", "this server"),
    true,
  );
  assertEquals(isReservedColocatedLicenseName("edge", "this server"), false);
  assertEquals(
    reservedColocatedLicenseNameError("this server"),
    "'this server' is reserved for the co-located control plane",
  );
});

test("installBaseUrlValidationError depends on developer surface", () => {
  assertEquals(
    installBaseUrlValidationError(true),
    "installBaseUrl must be a valid http(s) URL",
  );
  assertEquals(
    installBaseUrlValidationError(false),
    "installBaseUrl must be a valid https URL",
  );
});

test("serializeLicenseListEntry shapes bound and unbound rows", () => {
  assertEquals(
    serializeLicenseListEntry({
      id: "l1",
      name: "Edge",
      createdAt: "2026-01-01T00:00:00.000Z",
      revocable: true,
      bound: undefined,
      status: undefined,
    }),
    {
      id: "l1",
      name: "Edge",
      createdAt: "2026-01-01T00:00:00.000Z",
      revocable: true,
      boundServer: null,
    },
  );
  assertEquals(
    serializeLicenseListEntry({
      id: "l1",
      name: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      revocable: false,
      bound: { id: "s1", name: "node" },
      status: { serverId: "s1", connected: true },
    }).boundServer,
    { id: "s1", name: "node", connected: true },
  );
});

test("isInvalidInstallBaseUrl is true only when a provided URL failed to parse", () => {
  assertEquals(isInvalidInstallBaseUrl(undefined, null), false);
  assertEquals(isInvalidInstallBaseUrl("", null), false);
  assertEquals(isInvalidInstallBaseUrl("   ", null), false);
  assertEquals(
    isInvalidInstallBaseUrl(
      "https://panel.example.com",
      "https://panel.example.com",
    ),
    false,
  );
  assertEquals(isInvalidInstallBaseUrl("not-a-url", null), true);
  assertEquals(isInvalidInstallBaseUrl(" http://x ", null), true);
});

test("serverCapacityExceededBody preserves capacity fields", () => {
  assertEquals(
    serverCapacityExceededBody(
      {
        maxServers: 2,
        usedSeats: 2,
        serverCount: 1,
        reservedSeatCount: 1,
      },
      "server_capacity_exceeded",
    ),
    {
      error: "server_capacity_exceeded",
      maxServers: 2,
      usedSeats: 2,
      serverCount: 1,
      reservedSeatCount: 1,
    },
  );
});

test("noLicenseAvailableBody carries the four counts the console renders and nothing else", () => {
  assertEquals(
    noLicenseAvailableBody({ purchased: 2, releasing: 1, held: 1, available: 0 }),
    {
      error: "no_license_available",
      purchased: 2,
      releasing: 1,
      held: 1,
      available: 0,
    },
  );
  // The route hands it the full summary; `bound` is not part of the refusal.
  assertEquals(
    noLicenseAvailableBody({
      purchased: 0,
      releasing: 0,
      held: 0,
      bound: 0,
      available: 0,
    } as { purchased: number; releasing: number; held: number; available: number }),
    {
      error: "no_license_available",
      purchased: 0,
      releasing: 0,
      held: 0,
      available: 0,
    },
  );
});

test("parseLicenseCreateFields no longer reads a tierId: a license carries no tier", () => {
  assertEquals(
    parseLicenseCreateFields(
      JSON.stringify({ tierId: "11111111-1111-4111-8111-111111111111" }),
    ),
    {},
  );
  assertEquals(
    parseLicenseCreateFields(
      JSON.stringify({ name: "Edge", tierId: "not-a-uuid" }),
    ),
    { name: "Edge" },
  );
});
