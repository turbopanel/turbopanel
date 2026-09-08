import { assertEquals } from "@std/assert";
import { deriveInboundOutcome } from "./inbound-outcome.ts";
import type { DaemonInboundEnvelope } from "./protocol.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const AT = "2020-01-01T00:00:00.000Z";
const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const TEST_PUBLIC_IPV4 = "203.0.113.1"; // RFC 5737 TEST-NET-3

test("deriveInboundOutcome maps addresses-result to done", () => {
  const ips = [
    {
      address: TEST_PUBLIC_IPV4,
      version: 4 as const,
      scope: "public" as const,
    },
  ];
  assertEquals(
    deriveInboundOutcome({
      kind: "addresses-result",
      requestId: REQUEST_ID,
      at: AT,
      ips,
    }),
    { status: "done", result: { ips } },
  );
});

test("deriveInboundOutcome maps managed-logs-result done and failed", () => {
  const done: DaemonInboundEnvelope = {
    kind: "managed-logs-result",
    requestId: REQUEST_ID,
    at: AT,
    logs: "ok",
  };
  assertEquals(deriveInboundOutcome(done), {
    status: "done",
    result: { logs: "ok" },
  });
  assertEquals(
    deriveInboundOutcome({ ...done, error: "boom" }),
    { status: "failed", result: { logs: "ok" }, error: "boom" },
  );
});

test("deriveInboundOutcome maps container-logs-result done and failed", () => {
  const done: DaemonInboundEnvelope = {
    kind: "container-logs-result",
    requestId: REQUEST_ID,
    at: AT,
    logs: "line\n",
  };
  assertEquals(deriveInboundOutcome(done), {
    status: "done",
    result: { logs: "line\n" },
  });
  assertEquals(
    deriveInboundOutcome({ ...done, error: "not owned" }),
    { status: "failed", result: { logs: "line\n" }, error: "not owned" },
  );
});

test("deriveInboundOutcome maps fabric-paths-result done and failed", () => {
  const paths = [{ publicKey: "pk", health: "healthy" as const }];
  const done: DaemonInboundEnvelope = {
    kind: "fabric-paths-result",
    requestId: REQUEST_ID,
    at: AT,
    paths,
  };
  assertEquals(deriveInboundOutcome(done), {
    status: "done",
    result: { paths },
  });
  assertEquals(
    deriveInboundOutcome({ ...done, error: "probe failed" }),
    { status: "failed", result: { paths }, error: "probe failed" },
  );
});

test("deriveInboundOutcome maps repo-read-result done and failed", () => {
  const files = [{
    path: "package.json",
    found: true,
    content: "{}",
    bytes: 2,
  }];
  const entries = [{ path: ".", kind: "dir" }];
  assertEquals(
    deriveInboundOutcome({
      kind: "repo-read-result",
      requestId: REQUEST_ID,
      at: AT,
      ok: true,
      commitSha: "deadbeef",
      files,
      entries,
    }),
    {
      status: "done",
      result: {
        ok: true,
        commitSha: "deadbeef",
        files,
        entries,
        error: undefined,
      },
    },
  );
  assertEquals(
    deriveInboundOutcome({
      kind: "repo-read-result",
      requestId: REQUEST_ID,
      at: AT,
      ok: false,
      error: "git fetch failed",
    }),
    {
      status: "failed",
      result: {
        ok: false,
        commitSha: undefined,
        files: undefined,
        entries: undefined,
        error: "git fetch failed",
      },
      error: "git fetch failed",
    },
  );
});

test("deriveInboundOutcome maps command-outcome with and without result", () => {
  assertEquals(
    deriveInboundOutcome({
      kind: "command-outcome",
      requestId: REQUEST_ID,
      at: AT,
      ok: true,
      result: { hostname: "box" },
    }),
    { status: "done", result: { hostname: "box" } },
  );
  assertEquals(
    deriveInboundOutcome({
      kind: "command-outcome",
      requestId: REQUEST_ID,
      at: AT,
      ok: true,
    }),
    { status: "done", result: { ok: true, error: undefined } },
  );
  assertEquals(
    deriveInboundOutcome({
      kind: "command-outcome",
      requestId: REQUEST_ID,
      at: AT,
      ok: false,
      error: "denied",
    }),
    {
      status: "failed",
      result: { ok: false, error: "denied" },
      error: "denied",
    },
  );
});

test("deriveInboundOutcome maps ok-result kinds", () => {
  for (
    const kind of [
      "public-urls-update-result",
      "dev-sync-result",
      "tunnel-token-result",
      "update-result",
      "capability-plan-update-result",
    ] as const
  ) {
    assertEquals(
      deriveInboundOutcome({
        kind,
        requestId: REQUEST_ID,
        at: AT,
        ok: true,
      }),
      { status: "done", result: { ok: true, error: undefined } },
    );
    assertEquals(
      deriveInboundOutcome({
        kind,
        requestId: REQUEST_ID,
        at: AT,
        ok: false,
        error: `${kind} failed`,
      }),
      {
        status: "failed",
        result: { ok: false, error: `${kind} failed` },
        error: `${kind} failed`,
      },
    );
  }
});

test("deriveInboundOutcome returns null for command-ack", () => {
  assertEquals(
    deriveInboundOutcome({
      kind: "command-ack",
      requestId: REQUEST_ID,
      at: AT,
      daemonReceivedAt: AT,
    }),
    null,
  );
});
