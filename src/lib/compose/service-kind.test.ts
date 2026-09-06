import { assertEquals } from "@std/assert";
import { MAX_CRON_JOBS_PER_SERVICE } from "../cron.ts";
import {
  collectServiceTurbopanelValidationIssues,
  isHostNativeServiceKind,
  isNodeComposeService,
  isPrincipalAlias,
  isSafeRoot,
  isSiteComposeService,
  parseServiceSourceExtension,
  parseServiceTurbopanelExtension,
  readServiceSourceExtension,
  readServiceTurbopanelExtension,
} from "./service-kind.ts";
import { validateComposeDocument } from "./validate.ts";
import { blockingComposeLintIssues, lintComposeYaml } from "./lint.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseServiceTurbopanelExtension accepts site with engine", () => {
  assertEquals(
    parseServiceTurbopanelExtension({
      serviceKind: "site",
      engine: "nginx",
    }),
    { serviceKind: "site", engine: "nginx" },
  );
});

test("parseServiceTurbopanelExtension accepts site root", () => {
  assertEquals(
    parseServiceTurbopanelExtension({
      serviceKind: "site",
      engine: "nginx",
      root: "www",
    }),
    { serviceKind: "site", engine: "nginx", root: "www" },
  );
});

test("collectServiceTurbopanelValidationIssues rejects unsafe root", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      "x-turbopanel": {
        serviceKind: "site",
        engine: "nginx",
        root: "../etc",
      },
    },
  });
  assertEquals(
    issues.some((issue) => issue.path === "services.site.x-turbopanel.root"),
    true,
  );
});

test("collectServiceTurbopanelValidationIssues allows a site with no engine", () => {
  // `engine` is optional and defaults to caddy, resolved at the control-plane
  // split. A minimum static site is therefore four lines of compose.
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      // `principal` is the one thing a site cannot omit — it is the account the
      // document root and every scheduled job belong to.
      "x-turbopanel": { serviceKind: "site", principal: "app" },
    },
  });
  assertEquals(issues, []);
});

test("collectServiceTurbopanelValidationIssues accepts caddy as an engine", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      "x-turbopanel": {
        serviceKind: "site",
        engine: "caddy",
        principal: "app",
      },
    },
  });
  assertEquals(issues, []);
});

test("collectServiceTurbopanelValidationIssues rejects engine without site", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      "x-turbopanel": { engine: "apache" },
    },
  });
  assertEquals(issues.length, 1);
  assertEquals(issues[0]?.message.includes("site"), true);
});

test("validateComposeDocument accepts site without image or build", () => {
  const result = validateComposeDocument({
    version: 1,
    data: {
      services: {
        site: {
          "x-turbopanel": {
            serviceKind: "site",
            engine: "openlitespeed",
            principal: "app",
          },
        },
      },
    },
    presentation: { keyOrder: ["services"], comments: {} },
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      isSiteComposeService(
        (result.document.data.services as Record<
          string,
          Record<string, unknown>
        >).site,
      ),
      true,
    );
  }
});

test("lintComposeYaml allows site service without image", () => {
  const source = `services:
  site:
    x-turbopanel:
      serviceKind: site
      engine: nginx
`;
  const issues = lintComposeYaml(source);
  assertEquals(
    issues.some((issue) =>
      issue.message.includes('must define "image" or "build"')
    ),
    false,
  );
});

test("parseServiceTurbopanelExtension rejects non-mapping values", () => {
  assertEquals(parseServiceTurbopanelExtension("bad"), null);
  assertEquals(parseServiceTurbopanelExtension(null), {});
});

test("readServiceTurbopanelExtension returns empty when extension absent", () => {
  assertEquals(readServiceTurbopanelExtension({ image: "nginx" }), {});
});

test("collectServiceTurbopanelValidationIssues rejects invalid serviceKind and engine", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      "x-turbopanel": { serviceKind: "vm", engine: "caddy" },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.site.x-turbopanel.serviceKind"
    ),
    true,
  );
  assertEquals(
    issues.some((issue) => issue.path === "services.site.x-turbopanel.engine"),
    true,
  );
});

test("collectServiceTurbopanelValidationIssues rejects root without site", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: "node:22",
      "x-turbopanel": { root: "public" },
    },
  });
  assertEquals(
    issues.some((issue) => issue.path === "services.api.x-turbopanel.root"),
    true,
  );
});

test("collectServiceTurbopanelValidationIssues rejects non-mapping x-turbopanel", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: "node:22",
      "x-turbopanel": "bad",
    },
  });
  assertEquals(issues[0]?.message.includes("must be a mapping"), true);
});

test("validateComposeDocument surfaces service extension validation issues", () => {
  const result = validateComposeDocument({
    version: 1,
    data: {
      services: {
        site: {
          "x-turbopanel": { serviceKind: "site", engine: "bad-engine" },
        },
      },
    },
    presentation: { keyOrder: ["services"], comments: {} },
  });
  assertEquals(result.ok, false);
});

test("isSiteComposeService is false for invalid extension mapping", () => {
  assertEquals(
    isSiteComposeService({ "x-turbopanel": "bad" }),
    false,
  );
});

test("collectServiceTurbopanelValidationIssues rejects invalid serviceKind types", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      "x-turbopanel": { serviceKind: 42, engine: "nginx" },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.site.x-turbopanel.serviceKind"
    ),
    true,
  );
});

test("collectServiceTurbopanelValidationIssues accepts safe site roots", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      "x-turbopanel": {
        serviceKind: "site",
        engine: "nginx",
        root: "public/www",
        principal: "app",
      },
    },
  });
  assertEquals(issues.length, 0);
});

test("collectServiceTurbopanelValidationIssues rejects absolute and empty roots", () => {
  const absolute = collectServiceTurbopanelValidationIssues({
    site: {
      "x-turbopanel": {
        serviceKind: "site",
        engine: "nginx",
        root: "/etc",
      },
    },
  });
  assertEquals(
    absolute.some((issue) => issue.path === "services.site.x-turbopanel.root"),
    true,
  );

  const empty = collectServiceTurbopanelValidationIssues({
    site: {
      "x-turbopanel": {
        serviceKind: "site",
        engine: "nginx",
        root: "   ",
      },
    },
  });
  assertEquals(
    empty.some((issue) => issue.path === "services.site.x-turbopanel.engine"),
    false,
  );
});

test("collectServiceTurbopanelValidationIssues skips non-mapping services", () => {
  assertEquals(
    collectServiceTurbopanelValidationIssues({ bad: "raw" }),
    [],
  );
});

test("parseServiceTurbopanelExtension accepts description", () => {
  assertEquals(
    parseServiceTurbopanelExtension({
      serviceKind: "container",
      description: "  API gateway  ",
    }),
    { serviceKind: "container", description: "API gateway" },
  );
});

test("parseServiceTurbopanelExtension drops empty or overlong description", () => {
  assertEquals(
    parseServiceTurbopanelExtension({ description: "   " }),
    {},
  );
  assertEquals(
    parseServiceTurbopanelExtension({ description: "x".repeat(501) }),
    {},
  );
});

test("collectServiceTurbopanelValidationIssues rejects non-string description", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: "node:22",
      "x-turbopanel": { description: 42 },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.api.x-turbopanel.description"
    ),
    true,
  );
});

test("collectServiceTurbopanelValidationIssues rejects overlong description", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: "node:22",
      "x-turbopanel": { description: "y".repeat(501) },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.api.x-turbopanel.description"
    ),
    true,
  );
});

const NODE_SOURCE_ID = "11111111-2222-3333-4444-555555555555";

test("serviceKind node parses with its framework and version hints", () => {
  const parsed = parseServiceTurbopanelExtension({
    serviceKind: "node",
    framework: "next",
    nodeVersion: "24.17.0",
    source: { sourceId: NODE_SOURCE_ID, startCommand: "node server.js" },
  });
  assertEquals(parsed?.serviceKind, "node");
  assertEquals(parsed?.framework, "next");
  assertEquals(parsed?.nodeVersion, "24.17.0");
  assertEquals(parsed?.source?.startCommand, "node server.js");
});

test("isNodeComposeService distinguishes node from the other kinds", () => {
  assertEquals(
    isNodeComposeService({ "x-turbopanel": { serviceKind: "node" } }),
    true,
  );
  assertEquals(
    isNodeComposeService({
      "x-turbopanel": { serviceKind: "site" },
    }),
    false,
  );
  assertEquals(isNodeComposeService({ image: "node:24" }), false);
});

test("a node service without a source is rejected", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    web: { "x-turbopanel": { serviceKind: "node" } },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.web.x-turbopanel.source" &&
      issue.message === "node services require source"
    ),
    true,
  );
});

test("image and build are rejected on a node service", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    web: {
      image: "node:24",
      build: ".",
      "x-turbopanel": {
        serviceKind: "node",
        source: { sourceId: NODE_SOURCE_ID },
      },
    },
  });
  assertEquals(
    issues.some((issue) => issue.path === "services.web.image"),
    true,
  );
  assertEquals(
    issues.some((issue) => issue.path === "services.web.build"),
    true,
  );
});

test("framework and nodeVersion are rejected on non-node kinds", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: "node:24",
      "x-turbopanel": { framework: "next", nodeVersion: "24" },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.api.x-turbopanel.framework"
    ),
    true,
  );
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.api.x-turbopanel.nodeVersion"
    ),
    true,
  );
});

test("an unknown framework or an unpinned nodeVersion is reported", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    web: {
      "x-turbopanel": {
        serviceKind: "node",
        framework: "deno",
        nodeVersion: "^24",
        source: { sourceId: NODE_SOURCE_ID },
      },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.web.x-turbopanel.framework"
    ),
    true,
  );
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.web.x-turbopanel.nodeVersion"
    ),
    true,
  );
});

test("the linter does not require image or build on a node service", () => {
  const issues = lintComposeYaml(
    [
      "services:",
      "  web:",
      "    x-turbopanel:",
      "      serviceKind: node",
      "      source:",
      `        sourceId: ${NODE_SOURCE_ID}`,
    ].join("\n"),
  );
  assertEquals(
    issues.some((issue) =>
      issue.message.includes('must define "image" or "build"')
    ),
    false,
  );
});

test("the node app settings parse and enabled: false survives the round-trip", () => {
  assertEquals(
    parseServiceTurbopanelExtension({
      serviceKind: "node",
      packageManager: "pnpm",
      appMode: "development",
      enabled: false,
      documentRoot: "public",
      startupFile: "server.js",
      source: { sourceId: NODE_SOURCE_ID },
    }),
    {
      serviceKind: "node",
      packageManager: "pnpm",
      appMode: "development",
      enabled: false,
      documentRoot: "public",
      startupFile: "server.js",
      source: { sourceId: NODE_SOURCE_ID },
    },
  );
});

test("the node-only settings are rejected on non-node kinds", () => {
  // `enabled: false` on a site proves the check is presence, not truthiness.
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      "x-turbopanel": {
        serviceKind: "site",
        packageManager: "npm",
        appMode: "production",
        enabled: false,
        documentRoot: "public",
        startupFile: "server.js",
      },
    },
  });
  for (
    const field of [
      "packageManager",
      "appMode",
      "enabled",
      "documentRoot",
      "startupFile",
    ]
  ) {
    assertEquals(
      issues.some((issue) =>
        issue.path === `services.site.x-turbopanel.${field}` &&
        issue.message === `${field} is only valid when serviceKind is node`
      ),
      true,
      field,
    );
  }
});

test("unsafe documentRoot and startupFile are rejected on a node service", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    web: {
      "x-turbopanel": {
        serviceKind: "node",
        documentRoot: "../x",
        startupFile: "/abs",
        source: { sourceId: NODE_SOURCE_ID },
      },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.web.x-turbopanel.documentRoot" &&
      issue.message.includes("relative path")
    ),
    true,
  );
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.web.x-turbopanel.startupFile" &&
      issue.message.includes("relative path")
    ),
    true,
  );
});

test("bad node setting types are reported as raw type issues", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    web: {
      "x-turbopanel": {
        serviceKind: "node",
        packageManager: "bun",
        appMode: "staging",
        enabled: "yes",
        source: { sourceId: NODE_SOURCE_ID },
      },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.web.x-turbopanel.packageManager" &&
      issue.message.includes('"npm", "yarn", or "pnpm"')
    ),
    true,
  );
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.web.x-turbopanel.appMode" &&
      issue.message.includes('"production" or "development"')
    ),
    true,
  );
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.web.x-turbopanel.enabled" &&
      issue.message.includes("true or false")
    ),
    true,
  );
});

const RAILPACK_SOURCE_ID = "11111111-2222-3333-4444-555555555555";

test("parseServiceSourceExtension keeps a railpack buildKind", () => {
  const parsed = parseServiceTurbopanelExtension({
    serviceKind: "container",
    source: { sourceId: RAILPACK_SOURCE_ID, buildKind: "railpack" },
  });
  assertEquals(parsed?.source?.buildKind, "railpack");
});

test("an unknown buildKind is dropped and reported", () => {
  const parsed = parseServiceTurbopanelExtension({
    source: { sourceId: RAILPACK_SOURCE_ID, buildKind: "nixpacks" },
  });
  assertEquals(parsed?.source?.buildKind, undefined);

  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: "nginx",
      "x-turbopanel": {
        source: { sourceId: RAILPACK_SOURCE_ID, buildKind: "nixpacks" },
      },
    },
  });
  assertEquals(
    issues.map((issue) => issue.path),
    ["services.api.x-turbopanel.source.buildKind"],
  );
});

test("railpack is rejected on a host-native service kind", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      "x-turbopanel": {
        serviceKind: "node",
        principal: "app",
        source: { sourceId: RAILPACK_SOURCE_ID, buildKind: "railpack" },
      },
    },
  });
  assertEquals(
    issues.map((issue) => issue.path),
    ["services.site.x-turbopanel.source.buildKind"],
  );
});

test("railpack is accepted on a container service with no image", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      "x-turbopanel": {
        serviceKind: "container",
        source: { sourceId: RAILPACK_SOURCE_ID, buildKind: "railpack" },
      },
    },
  });
  assertEquals(issues, []);
});

test("a railpack container service needs neither image nor build", () => {
  const source = `services:
  api:
    x-turbopanel:
      serviceKind: container
      source:
        sourceId: ${RAILPACK_SOURCE_ID}
        buildKind: railpack
`;
  const issues = lintComposeYaml(source).filter((issue) =>
    issue.message.includes('must define "image"')
  );
  assertEquals(issues, []);
});

test("sourceKind is rejected on a service that is not a site", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: "nginx",
      "x-turbopanel": {
        serviceKind: "container",
        sourceKind: "managed-directory",
      },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.message.includes(
        "sourceKind is only valid when serviceKind is site",
      )
    ),
    true,
  );
});

test("a site cannot both track a repository and serve an uploaded directory", () => {
  // The daemon takes the release branch, so the flag would be a lie. Rejected
  // at save rather than ignored at deploy: an operator who sets both has a
  // belief about where their content comes from, and one of the two is wrong.
  const issues = collectServiceTurbopanelValidationIssues({
    blog: {
      "x-turbopanel": {
        serviceKind: "site",
        root: "public",
        sourceKind: "managed-directory",
        source: { sourceId: "11111111-2222-4333-8444-555555555555" },
      },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.message.includes("remove the source to serve an uploaded directory")
    ),
    true,
  );
});

test("an uploaded-directory site with no repository validates clean", () => {
  // The Hosting card seeds exactly this; a card that seeds a document the
  // validator rejects is a card that cannot be used.
  assertEquals(
    collectServiceTurbopanelValidationIssues({
      blog: {
        "x-turbopanel": {
          serviceKind: "site",
          engine: "caddy",
          root: "public",
          sourceKind: "managed-directory",
          principal: "app",
        },
      },
    }),
    [],
  );
});

test("cron is rejected on a container service", () => {
  // A container has no principal to run as and no tree to run in.
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: "nginx",
      "x-turbopanel": {
        serviceKind: "container",
        cron: [{ name: "sweep", schedule: "@daily", command: "/bin/true" }],
      },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.message.includes(
        "cron is only valid when serviceKind is site or node",
      )
    ),
    true,
  );
});

test("a cron job on a site validates clean", () => {
  assertEquals(
    collectServiceTurbopanelValidationIssues({
      blog: {
        "x-turbopanel": {
          serviceKind: "site",
          root: "public",
          principal: "app",
          cron: [
            {
              name: "wp-cron",
              schedule: "*/5 * * * *",
              command: "php wp-cron.php",
            },
          ],
        },
      },
    }),
    [],
  );
});

test("the day-of-week trap surfaces as a save-time issue", () => {
  // Not a deploy-time surprise: cron unions the two day fields and systemd
  // intersects them, so this expression means two different things.
  const issues = collectServiceTurbopanelValidationIssues({
    blog: {
      "x-turbopanel": {
        serviceKind: "site",
        root: "public",
        cron: [{
          name: "billing",
          schedule: "0 0 13 * 5",
          command: "/bin/true",
        }],
      },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.blog.x-turbopanel.cron[0].schedule" &&
      issue.message.includes("both to match")
    ),
    true,
  );
});

test("shell syntax in a cron command is a save-time issue", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    blog: {
      "x-turbopanel": {
        serviceKind: "site",
        root: "public",
        cron: [
          { name: "sweep", schedule: "@daily", command: "php x.php >> /tmp/l" },
        ],
      },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.blog.x-turbopanel.cron[0].command" &&
      issue.message.includes("no shell")
    ),
    true,
  );
});

test("a cron job name must be usable as a unit filename, and unique", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    blog: {
      "x-turbopanel": {
        serviceKind: "site",
        root: "public",
        cron: [
          { name: "Sweep Me", schedule: "@daily", command: "/bin/true" },
          { name: "ok", schedule: "@daily", command: "/bin/true" },
          { name: "ok", schedule: "@hourly", command: "/bin/true" },
        ],
      },
    },
  });
  assertEquals(
    issues.some((issue) => issue.message.includes("becomes the timer's name")),
    true,
  );
  // Two jobs with one name would render one unit and silently lose a job.
  assertEquals(
    issues.some((issue) => issue.message.includes('duplicate job name "ok"')),
    true,
  );
});

test("isHostNativeServiceKind covers site and node only", () => {
  assertEquals(isHostNativeServiceKind("site"), true);
  assertEquals(isHostNativeServiceKind("node"), true);
  assertEquals(isHostNativeServiceKind("container"), false);
  assertEquals(isHostNativeServiceKind(undefined), false);
});

test("isSafeRoot rejects empty, absolute, traversal, and NUL paths", () => {
  assertEquals(isSafeRoot(""), false);
  assertEquals(isSafeRoot("   "), false);
  assertEquals(isSafeRoot("/etc"), false);
  assertEquals(isSafeRoot("\\windows"), false);
  assertEquals(isSafeRoot("apps/../secret"), false);
  assertEquals(isSafeRoot("apps\0web"), false);
  assertEquals(isSafeRoot("a".repeat(201)), false);
  assertEquals(isSafeRoot("apps/web"), true);
});

test("parseServiceSourceExtension drops unusable or over-long fields", () => {
  assertEquals(parseServiceSourceExtension("bad"), null);
  assertEquals(parseServiceSourceExtension({ sourceId: "not-a-uuid" }), null);
  assertEquals(
    parseServiceSourceExtension({
      sourceId: RAILPACK_SOURCE_ID,
      branch: "   ",
      buildCommand: "x".repeat(1001),
      subdirectory: "apps/web",
    }),
    { sourceId: RAILPACK_SOURCE_ID, subdirectory: "apps/web" },
  );
});

test("readServiceSourceExtension reads a bound source off the service", () => {
  assertEquals(
    readServiceSourceExtension({
      image: "nginx",
      "x-turbopanel": {
        source: { sourceId: RAILPACK_SOURCE_ID, branch: "trunk" },
      },
    }),
    { sourceId: RAILPACK_SOURCE_ID, branch: "trunk" },
  );
  assertEquals(readServiceSourceExtension({ image: "nginx" }), undefined);
});

test("malformed cron entries are dropped while valid ones remain", () => {
  const parsed = parseServiceTurbopanelExtension({
    serviceKind: "site",
    cron: [
      "not-a-job",
      { name: "ok", schedule: "@daily" },
      { name: "keep", schedule: "@hourly", command: "/bin/true" },
      { name: 42, schedule: "@daily", command: "/bin/true" },
    ],
  });
  assertEquals(parsed?.cron, [
    { name: "keep", schedule: "@hourly", command: "/bin/true" },
  ]);
});

test("a service may not define more than MAX_CRON_JOBS_PER_SERVICE jobs", () => {
  const jobs = Array.from(
    { length: MAX_CRON_JOBS_PER_SERVICE + 1 },
    (_, i) => ({
      name: `job-${i}`,
      schedule: "@daily",
      command: "/bin/true",
    }),
  );
  const issues = collectServiceTurbopanelValidationIssues({
    blog: {
      "x-turbopanel": {
        serviceKind: "site",
        root: "public",
        cron: jobs,
      },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.blog.x-turbopanel.cron" &&
      issue.message.includes(`at most ${MAX_CRON_JOBS_PER_SERVICE}`)
    ),
    true,
  );
});

test("source field type and length errors are reported", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: "nginx",
      "x-turbopanel": {
        source: {
          sourceId: "not-a-uuid",
          branch: 12,
          buildCommand: "x".repeat(1001),
        },
      },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.api.x-turbopanel.source.sourceId"
    ),
    true,
  );
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.api.x-turbopanel.source.branch" &&
      issue.message.includes("must be a string")
    ),
    true,
  );
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.api.x-turbopanel.source.buildCommand" &&
      issue.message.includes("at most")
    ),
    true,
  );
});

test("source must be a mapping when present", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: "nginx",
      "x-turbopanel": { source: "github.com/org/repo" },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.api.x-turbopanel.source" &&
      issue.message.includes("must be a mapping")
    ),
    true,
  );
});

test("unsafe source path fields are rejected", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: "nginx",
      "x-turbopanel": {
        source: {
          sourceId: RAILPACK_SOURCE_ID,
          subdirectory: "../etc",
          outputDirectory: "/abs",
        },
      },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.api.x-turbopanel.source.subdirectory"
    ),
    true,
  );
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.api.x-turbopanel.source.outputDirectory"
    ),
    true,
  );
});

test("php is parsed and accepted on a site service", () => {
  const parsed = parseServiceTurbopanelExtension({
    serviceKind: "site",
    engine: "nginx",
    php: {
      version: "8.4",
      extensions: ["redis", "REDIS", "not-valid!!", 12, "gd"],
      settings: {
        memory_limit: "256M",
        nested: { ignored: true },
        display_errors: "On",
      },
      pool: {
        pm: "dynamic",
        "pm.max_children": 10,
      },
    },
  });
  assertEquals(parsed?.php?.version, "8.4");
  assertEquals(parsed?.php?.extensions, ["gd", "redis"]);
  assertEquals(parsed?.php?.settings, {
    memory_limit: "256M",
    display_errors: "On",
  });
  assertEquals(parsed?.php?.pool, {
    pm: "dynamic",
    "pm.max_children": 10,
  });

  assertEquals(
    collectServiceTurbopanelValidationIssues({
      blog: {
        "x-turbopanel": {
          serviceKind: "site",
          engine: "nginx",
          principal: "app",
          php: {
            version: "8.4",
            extensions: ["redis", "gd"],
            settings: { memory_limit: "256M" },
            pool: { pm: "ondemand", "pm.max_children": 4 },
          },
        },
      },
    }),
    [],
  );
});

test("php is rejected outside site and for malformed blocks", () => {
  const wrongKind = collectServiceTurbopanelValidationIssues({
    api: {
      image: "nginx",
      "x-turbopanel": {
        serviceKind: "container",
        php: { version: "8.4" },
      },
    },
  });
  assertEquals(
    wrongKind.some((issue) =>
      issue.path === "services.api.x-turbopanel.php" &&
      issue.message.includes("only valid when serviceKind is site")
    ),
    true,
  );

  const notMapping = collectServiceTurbopanelValidationIssues({
    blog: {
      "x-turbopanel": {
        serviceKind: "site",
        php: "8.4",
      },
    },
  });
  assertEquals(
    notMapping.some((issue) =>
      issue.path === "services.blog.x-turbopanel.php" &&
      issue.message.includes("must be a mapping")
    ),
    true,
  );
});

test("php version series and extension membership are enforced", () => {
  const patchVersion = collectServiceTurbopanelValidationIssues({
    blog: {
      "x-turbopanel": {
        serviceKind: "site",
        php: { version: "8.4.1" },
      },
    },
  });
  assertEquals(
    patchVersion.some((issue) =>
      issue.path === "services.blog.x-turbopanel.php.version" &&
      issue.message.includes("series like")
    ),
    true,
  );

  const unsupported = collectServiceTurbopanelValidationIssues({
    blog: {
      "x-turbopanel": {
        serviceKind: "site",
        php: { version: "7.4" },
      },
    },
  });
  assertEquals(
    unsupported.some((issue) =>
      issue.path === "services.blog.x-turbopanel.php.version" &&
      issue.message.includes("not supported")
    ),
    true,
  );

  const badExtensions = collectServiceTurbopanelValidationIssues({
    blog: {
      "x-turbopanel": {
        serviceKind: "site",
        php: { extensions: "redis" },
      },
    },
  });
  assertEquals(
    badExtensions.some((issue) =>
      issue.path === "services.blog.x-turbopanel.php.extensions" &&
      issue.message.includes("must be a list")
    ),
    true,
  );

  const unknownExt = collectServiceTurbopanelValidationIssues({
    blog: {
      "x-turbopanel": {
        serviceKind: "site",
        php: { extensions: ["redis", "evil"] },
      },
    },
  });
  assertEquals(
    unknownExt.some((issue) =>
      issue.path === "services.blog.x-turbopanel.php.extensions" &&
      issue.message.includes('"evil"')
    ),
    true,
  );
});

test("php settings and pool directives are validated key by key", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    blog: {
      "x-turbopanel": {
        serviceKind: "site",
        php: {
          settings: "memory_limit=256M",
          pool: {
            pm: "dynamic",
            "pm.max_children": 9999,
            unknown_key: 1,
          },
        },
      },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.blog.x-turbopanel.php.settings" &&
      issue.message.includes("must be a mapping")
    ),
    true,
  );
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.blog.x-turbopanel.php.pool.pm.max_children"
    ),
    true,
  );
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.blog.x-turbopanel.php.pool.unknown_key"
    ),
    true,
  );
});

test("isNodeComposeService is false for invalid extension mappings", () => {
  assertEquals(isNodeComposeService({ "x-turbopanel": "bad" }), false);
  assertEquals(
    isNodeComposeService({
      "x-turbopanel": {
        serviceKind: "node",
        source: { sourceId: RAILPACK_SOURCE_ID },
      },
    }),
    true,
  );
});

test("empty php and cron arrays do not attach to the parsed extension", () => {
  assertEquals(
    parseServiceTurbopanelExtension({
      serviceKind: "site",
      php: { extensions: [], settings: { nested: { a: 1 } } },
      cron: [],
    }),
    { serviceKind: "site" },
  );
});

test("principal is refused on a container service", () => {
  // A container has no account to run as; the message names the field rather
  // than letting the blanket table check say only "unknown key".
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: "nginx",
      "x-turbopanel": { serviceKind: "container", principal: "app" },
    },
  });
  assertEquals(
    issues.map((issue) => issue.path),
    ["services.api.x-turbopanel.principal"],
  );
  assertEquals(
    issues[0]?.message,
    "principal is only valid when serviceKind is site or node",
  );
});

test("a legacy site or node service without a principal alias still validates", () => {
  // The alias is the newer of the two ways a host-native service names its
  // account. Every document authored before `x-turbopanel.principals` existed
  // names none, and is owned by whatever principal an operator assigned in the
  // panel — so requiring the field here would reject those outright and put
  // the sole-steward fallback in `client/environments/deploy-sources.ts` out of
  // reach. Ownership is refused there, where the stewards are actually known.
  assertEquals(
    collectServiceTurbopanelValidationIssues({
      blog: { "x-turbopanel": { serviceKind: "site" } },
    }),
    [],
  );

  assertEquals(
    collectServiceTurbopanelValidationIssues({
      api: {
        "x-turbopanel": {
          serviceKind: "node",
          source: { sourceId: RAILPACK_SOURCE_ID },
        },
      },
    }),
    [],
  );
});

test("a whole legacy document with no principals block lints clean", () => {
  // The document-level pass is the one an operator actually meets on save, and
  // it resolves aliases against the root `principals` map. A document that
  // declares neither has nothing to resolve, which is not an error.
  const issues = lintComposeYaml(`services:
  blog:
    x-turbopanel:
      serviceKind: site
      engine: caddy
      root: public
  api:
    x-turbopanel:
      serviceKind: node
      source:
        sourceId: ${RAILPACK_SOURCE_ID}
`);
  assertEquals(
    blockingComposeLintIssues(issues).map((issue) => issue.path),
    [],
  );
});

test("a malformed principal alias reports its own shape message", () => {
  // Dropped by the parser *and* reported: without the raw-type pass the only
  // message would be "site services require principal", which sends the
  // operator looking for a missing line rather than a bad one.
  const issues = collectServiceTurbopanelValidationIssues({
    blog: { "x-turbopanel": { serviceKind: "site", principal: "9lives!" } },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.blog.x-turbopanel.principal" &&
      issue.message.includes("x-turbopanel.principals")
    ),
    true,
  );
});

test("a declared principal alias parses and round-trips trimmed", () => {
  const parsed = parseServiceTurbopanelExtension({
    serviceKind: "site",
    principal: "  app_1  ",
  });
  assertEquals(parsed?.principal, "app_1");
});

test("isPrincipalAlias is the one alias-shape rule both blocks share", () => {
  assertEquals(isPrincipalAlias("app"), true);
  assertEquals(isPrincipalAlias("App-1_2"), true);
  assertEquals(isPrincipalAlias("1app"), false);
  assertEquals(isPrincipalAlias("has space"), false);
  assertEquals(isPrincipalAlias(7), false);
  assertEquals(isPrincipalAlias(`a${"b".repeat(64)}`), false);
});

test("collectServiceTurbopanelValidationIssues delegates hosting shape to the hosting module", () => {
  assertEquals(
    collectServiceTurbopanelValidationIssues({
      web: {
        image: "nginx:alpine",
        "x-turbopanel": {
          hosting: [{ hostname: "app.example.com", targetPort: 8080 }],
        },
      },
    }),
    [],
  );
  const issues = collectServiceTurbopanelValidationIssues({
    web: {
      image: "nginx:alpine",
      "x-turbopanel": {
        hosting: [{ hostname: "not a host" }],
      },
    },
  });
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.web.x-turbopanel.hosting[0].hostname"
    ),
    true,
  );
});
