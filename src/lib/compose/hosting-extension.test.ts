import { assertEquals } from "@std/assert";
import {
  collectHostingExtensionValidationIssues,
  DEFAULT_HOSTING_BIND_SCOPE,
  DEFAULT_HOSTING_PATH_PREFIX,
  DEFAULT_HOSTING_TLS_MODE,
  HOSTING_BIND_SCOPES,
  HOSTING_HOSTNAME_MAX_LENGTH,
  HOSTING_HOSTNAME_REQUIRED_MESSAGE,
  HOSTING_KEY_REDIRECTS,
  HOSTING_NOT_A_PUBLISH_MESSAGE,
  HOSTING_PATH_PREFIX_MAX_LENGTH,
  HOSTING_PATH_PREFIX_MESSAGE,
  HOSTING_REF_MAX_LENGTH,
  HOSTING_TARGET_PORT_NOT_FOR_NODE_MESSAGE,
  HOSTING_TARGET_PORT_NOT_FOR_SITE_MESSAGE,
  HOSTING_TARGET_PORT_RANGE_MESSAGE,
  HOSTING_TLS_MODE_AUTOMATIC_UNSUPPORTED_MESSAGE,
  HOSTING_TLS_MODES,
  hostingBindScopeOf,
  hostingEntryKey,
  hostingIpRefUnresolvedMessage,
  hostingPathPrefixOf,
  hostingTargetPortAuthorable,
  hostingTlsModeOf,
  hostingTlsRefUnresolvedMessage,
  isHostingBindScope,
  isHostingTlsMode,
  MAX_HOSTING_ENTRIES_PER_SERVICE,
  parseHostingExtensionEntries,
  readHostingHostname,
  readHostingPathPrefix,
} from "./hosting-extension.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const BASE = "services.web.x-turbopanel";

function issuesFor(
  entry: Record<string, unknown>,
  serviceKind?: "container" | "site" | "node",
): { path: string; message: string }[] {
  return collectHostingExtensionValidationIssues(BASE, [entry], serviceKind);
}

test("an omitted tls block means internal, the mode the deploy can perform", () => {
  assertEquals(DEFAULT_HOSTING_TLS_MODE, "internal");
  assertEquals(hostingTlsModeOf({ hostname: "app.example.com" }), "internal");
});

test("tls.mode automatic is refused rather than deployed as internal", () => {
  assertEquals(
    issuesFor({
      hostname: "app.example.com",
      tls: { mode: "automatic" },
    }),
    [{
      path: `${BASE}.hosting[0].tls.mode`,
      message: HOSTING_TLS_MODE_AUTOMATIC_UNSUPPORTED_MESSAGE,
    }],
  );
});

test("tls.mode automatic still parses, so deploy-prepare can refuse it too", () => {
  const entries = parseHostingExtensionEntries([
    { hostname: "app.example.com", tls: { mode: "automatic" } },
  ]);
  assertEquals(entries?.[0].tls?.mode, "automatic");
  assertEquals(hostingTlsModeOf(entries![0]), "automatic");
});

test("internal and certificate are accepted", () => {
  assertEquals(
    issuesFor({ hostname: "a.example.com", tls: { mode: "internal" } }),
    [],
  );
  assertEquals(
    issuesFor({
      hostname: "a.example.com",
      tls: { mode: "certificate", certificateRef: "wildcard" },
    }),
    [],
  );
});

test("targetPort is authorable on a container and nowhere else", () => {
  assertEquals(hostingTargetPortAuthorable("container"), true);
  assertEquals(hostingTargetPortAuthorable(undefined), true);
  assertEquals(hostingTargetPortAuthorable("site"), false);
  assertEquals(hostingTargetPortAuthorable("node"), false);
});

test("targetPort on a node service is refused, not ignored", () => {
  assertEquals(
    issuesFor({ hostname: "app.example.com", targetPort: 3000 }, "node"),
    [{
      path: `${BASE}.hosting[0].targetPort`,
      message: HOSTING_TARGET_PORT_NOT_FOR_NODE_MESSAGE,
    }],
  );
});

test("targetPort on a site service keeps its own message", () => {
  assertEquals(
    issuesFor({ hostname: "app.example.com", targetPort: 8080 }, "site"),
    [{
      path: `${BASE}.hosting[0].targetPort`,
      message: HOSTING_TARGET_PORT_NOT_FOR_SITE_MESSAGE,
    }],
  );
});

test("targetPort on a container is accepted when it is a real port", () => {
  assertEquals(
    issuesFor({ hostname: "app.example.com", targetPort: 8080 }, "container"),
    [],
  );
});

test("isHostingTlsMode and isHostingBindScope accept only the named values", () => {
  for (const mode of HOSTING_TLS_MODES) {
    assertEquals(isHostingTlsMode(mode), true);
  }
  for (const scope of HOSTING_BIND_SCOPES) {
    assertEquals(isHostingBindScope(scope), true);
  }
  assertEquals(isHostingTlsMode("mutual"), false);
  assertEquals(isHostingTlsMode(1), false);
  assertEquals(isHostingBindScope("anywhere"), false);
  assertEquals(isHostingBindScope(null), false);
});

test("readHostingHostname lowercases a DNS name and drops everything else", () => {
  assertEquals(readHostingHostname("App.Example.COM"), "app.example.com");
  assertEquals(readHostingHostname("*.example.com"), "*.example.com");
  assertEquals(readHostingHostname(12), undefined);
  assertEquals(readHostingHostname("   "), undefined);
  assertEquals(readHostingHostname("not a host"), undefined);
  assertEquals(
    readHostingHostname(`a.${"b".repeat(HOSTING_HOSTNAME_MAX_LENGTH)}`),
    undefined,
  );
});

test("readHostingPathPrefix accepts an absolute traversal-free path", () => {
  assertEquals(readHostingPathPrefix("/api"), "/api");
  assertEquals(readHostingPathPrefix("  /v2  "), "/v2");
  assertEquals(readHostingPathPrefix(1), undefined);
  assertEquals(readHostingPathPrefix(""), undefined);
  assertEquals(readHostingPathPrefix("relative"), undefined);
  assertEquals(readHostingPathPrefix("/has space"), undefined);
  assertEquals(readHostingPathPrefix("/../secret"), undefined);
  assertEquals(
    readHostingPathPrefix(`/${"a".repeat(HOSTING_PATH_PREFIX_MAX_LENGTH)}`),
    undefined,
  );
});

test("unresolved-ref messages name the certificate or address the operator typed", () => {
  assertEquals(
    hostingTlsRefUnresolvedMessage("wildcard"),
    "certificate 'wildcard' was not found for this organization",
  );
  assertEquals(
    hostingIpRefUnresolvedMessage("203.0.113.10"),
    "ip '203.0.113.10' was not found for this organization",
  );
});

test("parseHostingExtensionEntries drops malformed rows and keeps forceHttps false", () => {
  assertEquals(parseHostingExtensionEntries("not-a-list"), undefined);
  assertEquals(parseHostingExtensionEntries([]), undefined);
  assertEquals(
    parseHostingExtensionEntries([{ hostname: "   " }, { ports: 80 }]),
    undefined,
  );

  const parsed = parseHostingExtensionEntries([
    {
      hostname: "App.Example.com",
      pathPrefix: "/api",
      targetPort: 8080,
      forceHttps: false,
      tls: { mode: "certificate", certificateRef: "  wildcard  " },
      bind: { scope: "datacenter", ipRef: "  203.0.113.10  " },
    },
    { hostname: "app.example.com", pathPrefix: "/api" },
    {
      hostname: "other.example.com",
      tls: { mode: "internal", certificateRef: "ignored" },
    },
  ]);
  if (!parsed) throw new TypeError("expected parsed hosting entries");
  assertEquals(parsed.length, 2);
  assertEquals(parsed[0], {
    hostname: "app.example.com",
    pathPrefix: "/api",
    targetPort: 8080,
    forceHttps: false,
    tls: { mode: "certificate", certificateRef: "wildcard" },
    bind: { scope: "datacenter", ipRef: "203.0.113.10" },
  });
  assertEquals(parsed[1]?.tls, { mode: "internal" });
  assertEquals("certificateRef" in (parsed[1]?.tls ?? {}), false);
});

test("parseHostingExtensionEntries stops at the per-service ceiling", () => {
  const raw = Array.from(
    { length: MAX_HOSTING_ENTRIES_PER_SERVICE + 5 },
    (_, i) => ({
      hostname: `app${String(i)}.example.com`,
    }),
  );
  const parsed = parseHostingExtensionEntries(raw);
  if (!parsed) throw new TypeError("expected parsed hosting entries");
  assertEquals(parsed.length, MAX_HOSTING_ENTRIES_PER_SERVICE);
});

test("hosting identity helpers resolve omitted prefix and bind scope", () => {
  assertEquals(DEFAULT_HOSTING_PATH_PREFIX, "/");
  assertEquals(DEFAULT_HOSTING_BIND_SCOPE, "public");
  assertEquals(hostingPathPrefixOf({}), "/");
  assertEquals(hostingPathPrefixOf({ pathPrefix: "/api" }), "/api");
  assertEquals(hostingBindScopeOf({ hostname: "app.example.com" }), "public");
  assertEquals(
    hostingBindScopeOf({
      hostname: "app.example.com",
      bind: { scope: "local" },
    }),
    "local",
  );
  assertEquals(
    hostingEntryKey({ hostname: "app.example.com" }),
    "app.example.com /",
  );
  assertEquals(
    hostingEntryKey({ hostname: "app.example.com", pathPrefix: "/api" }),
    "app.example.com /api",
  );
});

test("collectHostingExtensionValidationIssues treats omitted hosting as valid", () => {
  assertEquals(
    collectHostingExtensionValidationIssues(BASE, null, "container"),
    [],
  );
  assertEquals(
    collectHostingExtensionValidationIssues(BASE, undefined, "container"),
    [],
  );
});

test("collectHostingExtensionValidationIssues refuses a non-list hosting value", () => {
  assertEquals(
    collectHostingExtensionValidationIssues(BASE, {
      hostname: "app.example.com",
    }, "container"),
    [{
      path: `${BASE}.hosting`,
      message: "hosting must be a list of ingress entries",
    }],
  );
});

test("collectHostingExtensionValidationIssues refuses more than the per-service ceiling", () => {
  const tooMany = Array.from(
    { length: MAX_HOSTING_ENTRIES_PER_SERVICE + 1 },
    (_, i) => ({
      hostname: `app${String(i)}.example.com`,
    }),
  );
  assertEquals(
    collectHostingExtensionValidationIssues(BASE, tooMany, "container"),
    [{
      path: `${BASE}.hosting`,
      message:
        `hosting must declare at most ${MAX_HOSTING_ENTRIES_PER_SERVICE} entries`,
    }],
  );
});

test("collectHostingExtensionValidationIssues reports a non-mapping entry", () => {
  assertEquals(
    collectHostingExtensionValidationIssues(
      BASE,
      ["app.example.com"],
      "container",
    ),
    [{
      path: `${BASE}.hosting[0]`,
      message: "hosting entry must be a mapping",
    }],
  );
});

test("collectHostingExtensionValidationIssues redirects publish keys and names unknown ones", () => {
  const issues = issuesFor({
    hostname: "app.example.com",
    ports: "80:80",
    mystery: true,
  });
  assertEquals(
    issues.find((row) => row.path === `${BASE}.hosting[0].ports`)?.message,
    HOSTING_NOT_A_PUBLISH_MESSAGE,
  );
  assertEquals(
    issues.find((row) => row.path === `${BASE}.hosting[0].mystery`)?.message
      ?.includes('unknown hosting key "mystery"'),
    true,
  );
  assertEquals(HOSTING_KEY_REDIRECTS.publish, HOSTING_NOT_A_PUBLISH_MESSAGE);
});

test("collectHostingExtensionValidationIssues requires a usable hostname", () => {
  assertEquals(
    issuesFor({ hostname: "not a host" }),
    [{
      path: `${BASE}.hosting[0].hostname`,
      message: HOSTING_HOSTNAME_REQUIRED_MESSAGE,
    }],
  );
});

test("collectHostingExtensionValidationIssues refuses a malformed pathPrefix", () => {
  assertEquals(
    issuesFor({ hostname: "app.example.com", pathPrefix: "relative" }),
    [{
      path: `${BASE}.hosting[0].pathPrefix`,
      message: HOSTING_PATH_PREFIX_MESSAGE,
    }],
  );
});

test("collectHostingExtensionValidationIssues refuses an out-of-range container targetPort", () => {
  assertEquals(
    issuesFor({ hostname: "app.example.com", targetPort: 0 }, "container"),
    [{
      path: `${BASE}.hosting[0].targetPort`,
      message: HOSTING_TARGET_PORT_RANGE_MESSAGE,
    }],
  );
  assertEquals(
    issuesFor({ hostname: "app.example.com", targetPort: 65536 }, "container"),
    [{
      path: `${BASE}.hosting[0].targetPort`,
      message: HOSTING_TARGET_PORT_RANGE_MESSAGE,
    }],
  );
  assertEquals(
    issuesFor({ hostname: "app.example.com", targetPort: 80.5 }, "container"),
    [{
      path: `${BASE}.hosting[0].targetPort`,
      message: HOSTING_TARGET_PORT_RANGE_MESSAGE,
    }],
  );
});

test("collectHostingExtensionValidationIssues requires forceHttps to be a boolean", () => {
  assertEquals(
    issuesFor({ hostname: "app.example.com", forceHttps: "yes" }),
    [{
      path: `${BASE}.hosting[0].forceHttps`,
      message: "forceHttps must be true or false",
    }],
  );
  assertEquals(
    issuesFor({ hostname: "app.example.com", forceHttps: true }),
    [],
  );
});

test("collectHostingExtensionValidationIssues refuses a non-mapping tls block", () => {
  assertEquals(
    issuesFor({ hostname: "app.example.com", tls: "internal" }),
    [{ path: `${BASE}.hosting[0].tls`, message: "tls must be a mapping" }],
  );
});

test("collectHostingExtensionValidationIssues redirects unknown tls keys and names the rest", () => {
  const issues = issuesFor({
    hostname: "app.example.com",
    tls: { mode: "internal", certificate: "pem", extra: true },
  });
  assertEquals(
    issues.find((row) => row.path === `${BASE}.hosting[0].tls.certificate`)
      ?.message,
    HOSTING_KEY_REDIRECTS.certificate,
  );
  assertEquals(
    issues.find((row) => row.path === `${BASE}.hosting[0].tls.extra`)?.message
      ?.includes('unknown tls key "extra"'),
    true,
  );
});

test("collectHostingExtensionValidationIssues refuses an unknown tls.mode", () => {
  assertEquals(
    issuesFor({ hostname: "app.example.com", tls: { mode: "mutual" } }),
    [{
      path: `${BASE}.hosting[0].tls.mode`,
      message: 'tls.mode must be "automatic", "internal", or "certificate"',
    }],
  );
});

test("collectHostingExtensionValidationIssues requires certificateRef only for certificate mode", () => {
  assertEquals(
    issuesFor({ hostname: "app.example.com", tls: { mode: "certificate" } }),
    [{
      path: `${BASE}.hosting[0].tls.certificateRef`,
      message:
        'tls.certificateRef is required when tls.mode is "certificate"; name a certificate in this organization by id or name',
    }],
  );
  assertEquals(
    issuesFor({
      hostname: "app.example.com",
      tls: { mode: "internal", certificateRef: "wildcard" },
    }),
    [{
      path: `${BASE}.hosting[0].tls.certificateRef`,
      message:
        'tls.certificateRef is only valid when tls.mode is "certificate"',
    }],
  );
});

test("collectHostingExtensionValidationIssues refuses a non-mapping bind block", () => {
  assertEquals(
    issuesFor({ hostname: "app.example.com", bind: "public" }),
    [{ path: `${BASE}.hosting[0].bind`, message: "bind must be a mapping" }],
  );
});

test("collectHostingExtensionValidationIssues redirects unknown bind keys and names the rest", () => {
  const issues = issuesFor({
    hostname: "app.example.com",
    bind: { scope: "public", ip: "203.0.113.10", extra: true },
  });
  assertEquals(
    issues.find((row) => row.path === `${BASE}.hosting[0].bind.ip`)?.message,
    HOSTING_KEY_REDIRECTS.ip,
  );
  assertEquals(
    issues.find((row) => row.path === `${BASE}.hosting[0].bind.extra`)?.message
      ?.includes('unknown bind key "extra"'),
    true,
  );
});

test("collectHostingExtensionValidationIssues refuses an unknown bind.scope", () => {
  assertEquals(
    issuesFor({ hostname: "app.example.com", bind: { scope: "anywhere" } }),
    [{
      path: `${BASE}.hosting[0].bind.scope`,
      message: 'bind.scope must be "public", "datacenter", or "local"',
    }],
  );
});

test("collectHostingExtensionValidationIssues refuses an empty or overlong bind.ipRef", () => {
  assertEquals(
    issuesFor({
      hostname: "app.example.com",
      bind: { scope: "public", ipRef: "   " },
    }),
    [{
      path: `${BASE}.hosting[0].bind.ipRef`,
      message:
        `bind.ipRef must name a managed address in this organization by id or address (at most ${HOSTING_REF_MAX_LENGTH} characters)`,
    }],
  );
});

test("collectHostingExtensionValidationIssues reports a duplicate hostname and pathPrefix", () => {
  const issues = collectHostingExtensionValidationIssues(BASE, [
    { hostname: "app.example.com" },
    { hostname: "app.example.com", pathPrefix: "/" },
  ], "container");
  assertEquals(
    issues.some((row) =>
      row.path === `${BASE}.hosting[1]` &&
      row.message.includes("hosting already declares app.example.com/")
    ),
    true,
  );
});
