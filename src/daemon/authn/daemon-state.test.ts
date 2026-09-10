import { assertEquals } from "@std/assert";
import {
  buildDefaultDaemonStatus,
  buildServerDaemonState,
  isDaemonKeyActive,
  mapServerDaemonStatusFromColumns,
  parseServerDaemonState,
} from "./daemon-state.ts";

const baseKey = {
  id: "key-1",
  algorithm: "Ed25519" as const,
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
  fingerprint: "fp-1",
  createdAt: "2020-01-01T00:00:00.000Z",
};

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test("parseServerDaemonState parses key + projection only", () => {
  const row = {
    key: baseKey,
    projection: {
      hostname: "legacy-host",
    },
  };

  const parsed = parseServerDaemonState(row);
  assertEquals(parsed?.key.id, "key-1");
  assertEquals(parsed?.projection?.hostname, "legacy-host");
});

test("parseServerDaemonState ignores an unknown status key on the jsonb blob", () => {
  // `server.daemon` does not carry `status` — fleet liveness lives on dedicated
  // columns. The parser is allowlist-shaped, so an extra key on the jsonb blob
  // must not surface on the parsed state.
  const row = {
    key: baseKey,
    projection: {
      hostname: "legacy-host",
    },
    status: {
      connected: false,
      daemonStatus: "offline",
      lastSeenAt: "2020-02-01T00:00:00.000Z",
      connectedAt: null,
      disconnectedAt: "2020-02-01T00:00:00.000Z",
      statusChangedAt: "2020-02-01T00:00:00.000Z",
    },
  };

  const parsed = parseServerDaemonState(row);
  assertEquals(parsed && "status" in parsed, false);
  assertEquals(parsed?.projection?.hostname, "legacy-host");
});

test("parseServerDaemonState without projection omits the projection field", () => {
  const row = { key: baseKey };

  const parsed = parseServerDaemonState(row);
  assertEquals(parsed?.projection, undefined);
  assertEquals(parsed?.key.id, "key-1");
});

test("buildDefaultDaemonStatus returns unknown/disconnected defaults", () => {
  const status = buildDefaultDaemonStatus();
  assertEquals(status.connected, false);
  assertEquals(status.daemonStatus, "unknown");
  assertEquals(status.statusChangedAt, null);
});

test("mapServerDaemonStatusFromColumns derives online when connected + statusChangedAt", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: true,
    statusChangedAt: "2020-01-15T00:00:00.000Z",
  });

  assertEquals(status.connected, true);
  assertEquals(status.daemonStatus, "online");
  assertEquals(status.statusChangedAt, "2020-01-15T00:00:00.000Z");
});

test("mapServerDaemonStatusFromColumns derives offline when !connected + statusChangedAt", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: false,
    statusChangedAt: "2020-02-01T00:00:00.000Z",
  });

  assertEquals(status.connected, false);
  assertEquals(status.daemonStatus, "offline");
  assertEquals(status.statusChangedAt, "2020-02-01T00:00:00.000Z");
});

test("mapServerDaemonStatusFromColumns derives unknown when statusChangedAt is null", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: false,
    statusChangedAt: null,
  });

  assertEquals(status.daemonStatus, "unknown");
  assertEquals(status.statusChangedAt, null);
});

test("mapServerDaemonStatusFromColumns coerces null/undefined connected to false", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: null,
    statusChangedAt: undefined,
  });

  assertEquals(status.connected, false);
  assertEquals(status.daemonStatus, "unknown");
  assertEquals(status.statusChangedAt, null);
});

test("mapServerDaemonStatusFromColumns treats blank statusChangedAt as unknown", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: true,
    statusChangedAt: "   ",
  });
  assertEquals(status.daemonStatus, "unknown");
});

test("parseServerDaemonState rejects invalid shapes", () => {
  assertEquals(parseServerDaemonState(null), null);
  assertEquals(parseServerDaemonState([]), null);
  assertEquals(parseServerDaemonState({}), null);
  assertEquals(parseServerDaemonState({ key: { id: "" } }), null);
  assertEquals(parseServerDaemonState({
    key: { ...baseKey, algorithm: "RSA" },
  }), null);
  assertEquals(parseServerDaemonState({
    key: { ...baseKey, publicJwk: { kty: "RSA" } },
  }), null);
  assertEquals(parseServerDaemonState({
    key: { ...baseKey, publicJwk: [] },
  }), null);
});

test("parseServerDaemonState ignores a non-object projection", () => {
  const parsed = parseServerDaemonState({
    key: baseKey,
    projection: [],
  });
  assertEquals(parsed?.key.id, "key-1");
  assertEquals(parsed?.projection, undefined);
});

test("parseServerDaemonState parses daemonBuild and update projection fields", () => {
  const parsed = parseServerDaemonState({
    key: baseKey,
    projection: {
      hostname: "host-1",
      machineKey: "mk-1",
      remoteAddress: "203.0.113.1",
      keyId: "key-1",
      daemonBuild: {
        commit: "abc123",
        buildId: "build-1",
        builtAt: "2020-01-01T00:00:00.000Z",
        channel: "trunk",
      },
      update: {
        status: "updating",
        channel: "trunk",
        requestId: "req-1",
        queuedAt: "2020-01-01T00:00:00.000Z",
        finishedAt: "2020-01-02T00:00:00.000Z",
        error: "boom",
      },
    },
  });

  assertEquals(parsed?.projection?.hostname, "host-1");
  assertEquals(parsed?.projection?.daemonBuild?.commit, "abc123");
  assertEquals(parsed?.projection?.update?.status, "updating");
  assertEquals(parsed?.projection?.update?.error, "boom");
});

test("parseServerDaemonState drops empty projection objects", () => {
  const parsed = parseServerDaemonState({
    key: baseKey,
    projection: {
      hostname: "   ",
      daemonBuild: {},
      update: { status: "not-a-status" },
    },
  });
  assertEquals(parsed?.projection, undefined);
});

test("isDaemonKeyActive reflects revokedAt", () => {
  assertEquals(isDaemonKeyActive({ ...baseKey, revokedAt: null }), true);
  assertEquals(isDaemonKeyActive({ ...baseKey, revokedAt: undefined }), true);
  assertEquals(
    isDaemonKeyActive({
      ...baseKey,
      revokedAt: "2020-01-01T00:00:00.000Z",
    }),
    false,
  );
});

test("buildServerDaemonState mints an active Ed25519 key row", () => {
  const state = buildServerDaemonState({
    publicJwk: baseKey.publicJwk,
    fingerprint: "fp-new",
  });
  assertEquals(state.key.algorithm, "Ed25519");
  assertEquals(state.key.fingerprint, "fp-new");
  assertEquals(state.key.revokedAt, null);
  assertEquals(state.key.id.length > 0, true);
  assertEquals(state.key.createdAt.length > 0, true);
  assertEquals(state.projection, undefined);
});
