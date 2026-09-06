import { assertEquals } from "@std/assert";
import { blockingComposeLintIssues, lintComposeYaml } from "./lint.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("lintComposeYaml returns no issues for empty input", () => {
  assertEquals(lintComposeYaml(""), []);
  assertEquals(lintComposeYaml("   \n"), []);
});

test("lintComposeYaml accepts a valid service", () => {
  const source = `services:
  nginx:
    image: nginx:alpine
    ports:
      - "8080:80"
`;
  assertEquals(lintComposeYaml(source), []);
});

test("lintComposeYaml flags misspelled service key with suggestion and line", () => {
  const source = `services:
  # ok
  nginx:
    # comment
    imaage: nginx
`;
  const issues = lintComposeYaml(source);
  const unknown = issues.find((issue) =>
    issue.path === "services.nginx.imaage"
  );
  assertEquals(unknown?.level, "warning");
  assertEquals(unknown?.message.includes('did you mean "image"'), true);
  assertEquals(unknown?.line, 5);
});

test("lintComposeYaml errors when service has neither image nor build", () => {
  const source = `services:
  nginx:
    imaage: nginx
`;
  const issues = lintComposeYaml(source);
  const missing = issues.find(
    (issue) => issue.level === "error" && issue.path === "services.nginx",
  );
  assertEquals(missing !== undefined, true);
  assertEquals(missing?.message.includes("image"), true);
});

test("lintComposeYaml skips image requirement for site services", () => {
  const source = `services:
  site:
    x-turbopanel:
      serviceKind: site
      engine: apache
`;
  assertEquals(lintComposeYaml(source), []);
});

test("lintComposeYaml orders issues by line number", () => {
  const source = `services:
  # ok
  nginx:
    # comment
    imaage: nginx
`;
  const issues = lintComposeYaml(source);
  assertEquals(issues.map((issue) => issue.line), [3, 5]);
  assertEquals(issues[0]?.level, "error");
  assertEquals(issues[1]?.level, "warning");
});

test("blockingComposeLintIssues allows empty-draft warnings", () => {
  const noServices = lintComposeYaml("networks:\n  default: {}\n");
  assertEquals(blockingComposeLintIssues(noServices), []);

  const emptyServices = lintComposeYaml("services: {}\n");
  assertEquals(blockingComposeLintIssues(emptyServices), []);

  const bad = lintComposeYaml(`services:
  nginx:
    imaage: nginx
`);
  assertEquals(blockingComposeLintIssues(bad).length > 0, true);
});

test("lintComposeYaml reports invalid YAML syntax", () => {
  const issues = lintComposeYaml("services: [\n  - broken");
  assertEquals(issues.length > 0, true);
  assertEquals(issues[0]?.level, "error");
  assertEquals(issues[0]?.path, "$");
});

test("lintComposeYaml rejects non-mapping root", () => {
  const issues = lintComposeYaml("- not-a-map\n");
  assertEquals(issues[0]?.message.includes("root must be a mapping"), true);
});

test("lintComposeYaml warns on unknown top-level keys", () => {
  const issues = lintComposeYaml(`servicess:
  nginx:
    image: nginx
`);
  const unknown = issues.find((issue) => issue.path === "servicess");
  assertEquals(unknown?.level, "warning");
  assertEquals(unknown?.message.includes('did you mean "services"'), true);
});

test("lintComposeYaml errors when services is not a mapping", () => {
  const issues = lintComposeYaml("services: []\n");
  assertEquals(
    issues.some((issue) =>
      issue.path === "services" && issue.level === "error"
    ),
    true,
  );
});

test("lintComposeYaml errors when a service entry is not a mapping", () => {
  const issues = lintComposeYaml(`services:
  nginx: not-a-map
`);
  const serviceIssue = issues.find((issue) => issue.path === "services.nginx");
  assertEquals(serviceIssue?.level, "error");
  assertEquals(serviceIssue?.message.includes("must be a mapping"), true);
});

test("lintComposeYaml accepts build without image", () => {
  const source = `services:
  api:
    build: .
`;
  assertEquals(lintComposeYaml(source), []);
});

test("lintComposeYaml treats empty-string image as missing", () => {
  const source = `services:
  app:
    image: ""
`;
  const issues = lintComposeYaml(source);
  const missing = issues.find(
    (issue) => issue.level === "error" && issue.path === "services.app",
  );
  assertEquals(missing !== undefined, true);
  assertEquals(missing?.message.includes("image"), true);
  assertEquals(missing?.message.includes("build"), true);
});

test("lintComposeYaml accepts build when image is an empty string", () => {
  const source = `services:
  app:
    image: ""
    build:
      context: .
      dockerfile_inline: |
        FROM alpine
`;
  assertEquals(lintComposeYaml(source), []);
});

test("lintComposeYaml allows x-turbopanel extension keys on services", () => {
  const source = `services:
  site:
    x-turbopanel:
      serviceKind: site
      engine: nginx
`;
  assertEquals(
    lintComposeYaml(source).some((issue) =>
      issue.path.includes("x-turbopanel")
    ),
    false,
  );
});

test("lintComposeYaml warns when services section is missing", () => {
  const issues = lintComposeYaml("networks:\n  default: {}\n");
  assertEquals(
    issues.some((issue) => issue.message.includes('no "services" section')),
    true,
  );
});

test("lintComposeYaml warns on unknown top-level keys without a close suggestion", () => {
  const issues = lintComposeYaml(`totallyunknown: value
services:
  api:
    image: node:22
`);
  const unknown = issues.find((issue) => issue.path === "totallyunknown");
  assertEquals(unknown?.level, "warning");
  assertEquals(unknown?.message.includes("did you mean"), false);
});

test("lintComposeYaml allows top-level x-* extension keys", () => {
  const issues = lintComposeYaml(`x-custom-meta: true
services:
  api:
    image: node:22
`);
  assertEquals(issues.some((issue) => issue.path === "x-custom-meta"), false);
});

test("lintComposeYaml warns when services mapping is empty", () => {
  const issues = lintComposeYaml(`services: {}
networks:
  default: {}
`);
  assertEquals(
    issues.some((issue) => issue.message === "No services defined"),
    true,
  );
});

test("lintComposeYaml skips services with non-string keys", () => {
  const issues = lintComposeYaml(`services:
  8080:
    image: nginx
  [bad]: true
`);
  assertEquals(issues.some((issue) => issue.path === "services.[bad]"), false);
});

test("lintComposeYaml does not report tagged nodes as unknown keys or invalid services", () => {
  const source = `services:
  web:
    image: nginx
    ports: !override
      - "9000:80"
    environment: !reset null
  gone: !reset null
`;
  const issues = lintComposeYaml(source);
  assertEquals(
    issues.some((issue) => issue.message.includes("Unknown")),
    false,
  );
  assertEquals(
    issues.some((issue) => issue.message.includes("must be a mapping")),
    false,
  );
});

test("base-layer tag advisory is non-blocking; overlay suppresses it", () => {
  const source = `services:
  web:
    image: nginx
    ports: !override
      - "9000:80"
`;
  const baseIssues = lintComposeYaml(source);
  const advisory = baseIssues.find((issue) =>
    issue.message.includes("only take effect in an overlay")
  );
  assertEquals(advisory?.level, "warning");
  assertEquals(advisory?.blocking, false);
  assertEquals(blockingComposeLintIssues(baseIssues), []);

  const overlayIssues = lintComposeYaml(source, { layer: "overlay" });
  assertEquals(
    overlayIssues.some((issue) =>
      issue.message.includes("only take effect in an overlay")
    ),
    false,
  );
});

test("lintComposeYaml errors on invalid TurboPanel variable refs", () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx
    environment:
      BAD: prefix-{$PORT}
      SCOPE: "{$galaxy.KEY}"
`);
  assertEquals(
    issues.some((issue) => issue.path === "services.web.environment.BAD"),
    true,
  );
  assertEquals(
    issues.some((issue) => issue.path === "services.web.environment.SCOPE"),
    true,
  );
});

test("lintComposeYaml accepts exact scoped variable refs in environment map", () => {
  const source = `services:
  web:
    image: nginx
    environment:
      PORT: "{$project.PORT}"
      HOST: "{$environment.HOST}"
`;
  assertEquals(lintComposeYaml(source), []);
});

test("lintComposeYaml lints build.args variable refs", () => {
  const issues = lintComposeYaml(`services:
  api:
    build:
      context: .
      args:
        TOKEN: prefix-{$TOKEN}
        OK: "{$project.API_KEY}"
`);
  assertEquals(
    issues.some((issue) => issue.path === "services.api.build.args.TOKEN"),
    true,
  );
  assertEquals(
    issues.some((issue) => issue.path === "services.api.build.args.OK"),
    false,
  );
});

test("lintComposeYaml lints list-form environment values after separator", () => {
  // Both entries are `KEY=VALUE` strings, which is the only shape the Compose
  // Specification allows in the list form of `environment:` — a mapping entry
  // here is a stage-1 schema error and would drown out the rule under test.
  const issues = lintComposeYaml(`services:
  web:
    image: nginx
    environment:
      - BAD=prefix-{$PORT}
      - GOOD={$project.PORT}
`);
  assertEquals(
    issues.some((issue) => issue.path === "services.web.environment[0]"),
    true,
  );
  assertEquals(
    issues.some((issue) => issue.path === "services.web.environment[1]"),
    false,
  );
});

test("lintComposeYaml suggests close misspelled service keys", () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx
    restar: always
`);
  const unknown = issues.find((issue) => issue.path === "services.web.restar");
  assertEquals(unknown?.level, "warning");
  assertEquals(unknown?.message.includes('did you mean "restart"'), true);
});

test("lintComposeYaml tagged image satisfies image requirement", () => {
  const source = `services:
  web:
    image: !override nginx:alpine
`;
  assertEquals(
    lintComposeYaml(source).some(
      (issue) => issue.path === "services.web" && issue.level === "error",
    ),
    false,
  );
});

test("lintComposeYaml tagged build satisfies build requirement without image", () => {
  const source = `services:
  api:
    build: !override .
`;
  assertEquals(
    lintComposeYaml(source).some(
      (issue) => issue.path === "services.api" && issue.level === "error",
    ),
    false,
  );
});

test("lintComposeYaml skips structural checks for whole-service tag", () => {
  const source = `services:
  web: !reset null
  api:
    image: node:22
`;
  const issues = lintComposeYaml(source);
  assertEquals(
    issues.some(
      (issue) => issue.path === "services.web" && issue.level === "error",
    ),
    false,
  );
  assertEquals(
    issues.some(
      (issue) => issue.path === "services.api" && issue.level === "error",
    ),
    false,
  );
  assertEquals(
    issues.some(
      (issue) =>
        issue.path === "services.web" &&
        issue.message.includes("only take effect in an overlay"),
    ),
    true,
  );
});

test("lintComposeYaml emits nested tag advisory on base healthcheck.test", () => {
  const source = `services:
  web:
    image: nginx
    healthcheck:
      test: !override
        - CMD-SHELL
        - exit 0
`;
  const issues = lintComposeYaml(source);
  const advisory = issues.find((issue) =>
    issue.path === "services.web.healthcheck.test"
  );
  assertEquals(
    advisory?.message.includes("only take effect in an overlay"),
    true,
  );
  assertEquals(advisory?.blocking, false);
});

test("lintComposeYaml sorts errors before warnings on the same line", () => {
  const source = `services:
  web:
    image: nginx
    restar: always
    environment:
      BAD: prefix-{$X}
`;
  const issues = lintComposeYaml(source);
  const sameLine = issues.filter((issue) => issue.line === 5);
  if (sameLine.length >= 2) {
    assertEquals(sameLine[0]?.level, "error");
  }
});

test("lintComposeYaml rejects site without engine via image requirement", () => {
  const source = `services:
  site:
    x-turbopanel:
      serviceKind: site
`;
  const issues = lintComposeYaml(source);
  assertEquals(
    issues.some(
      (issue) =>
        issue.path === "services.site" && issue.message.includes("image"),
    ),
    false,
  );
});

test("lintComposeYaml warns on unknown service key without suggestion beyond distance 2", () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx
    zztotallyunknownkey: true
`);
  const unknown = issues.find((issue) =>
    issue.path === "services.web.zztotallyunknownkey"
  );
  assertEquals(unknown?.level, "warning");
  assertEquals(unknown?.message.includes("did you mean"), false);
});

test("lintComposeYaml emits base-layer advisory when top-level services is tagged", () => {
  const source = `services: !override
  web:
    image: nginx
`;
  const issues = lintComposeYaml(source);
  const advisory = issues.find((issue) => issue.path === "services");
  assertEquals(
    advisory?.message.includes("only take effect in an overlay"),
    true,
  );
  assertEquals(advisory?.blocking, false);
  assertEquals(blockingComposeLintIssues(issues), []);
  assertEquals(
    lintComposeYaml(source, { layer: "overlay" }).some((issue) =>
      issue.path === "services"
    ),
    false,
  );
});

test("lintComposeYaml accepts build shorthand scalar and tagged override shorthand", () => {
  assertEquals(
    lintComposeYaml(`services:
  api:
    build: .
`),
    [],
  );

  assertEquals(
    lintComposeYaml(`services:
  api:
    build: !override .
`).some(
      (issue) => issue.path === "services.api" && issue.level === "error",
    ),
    false,
  );
});

const SOURCE_ID = "01989d42-9adb-7e65-bc2e-f38792c53691";

test("lintComposeYaml emits a non-blocking source advisory and skips unknown ids when the set is omitted", () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx
    x-turbopanel:
      source:
        sourceId: ${SOURCE_ID}
`);
  const advisory = issues.find((issue) =>
    issue.path === "services.web.x-turbopanel.source"
  );
  assertEquals(advisory?.level, "warning");
  assertEquals(advisory?.blocking, false);
  assertEquals(
    advisory?.message.includes("builds and promotes a release"),
    true,
  );
  assertEquals(
    issues.some((issue) => issue.message.includes("was not found")),
    false,
  );
  assertEquals(blockingComposeLintIssues(issues), []);
});

test("lintComposeYaml errors when knownSourceIds does not contain the bound source", () => {
  const issues = lintComposeYaml(
    `services:
  web:
    image: nginx
    x-turbopanel:
      source:
        sourceId: ${SOURCE_ID}
`,
    { knownSourceIds: new Set(["00000000-0000-4000-8000-000000000001"]) },
  );
  const missing = issues.find((issue) =>
    issue.path === "services.web.x-turbopanel.source.sourceId"
  );
  assertEquals(missing?.level, "error");
  assertEquals(missing?.message.includes(SOURCE_ID), true);
  assertEquals(blockingComposeLintIssues(issues).length > 0, true);
});

test("lintComposeYaml accepts a sourceId that resolves in knownSourceIds", () => {
  const issues = lintComposeYaml(
    `services:
  web:
    image: nginx
    x-turbopanel:
      source:
        sourceId: ${SOURCE_ID}
`,
    { knownSourceIds: new Set([SOURCE_ID]) },
  );
  assertEquals(
    issues.some((issue) => issue.message.includes("was not found")),
    false,
  );
});

test("lintComposeYaml skips resolution when sourceId is blank even if knownSourceIds is set", () => {
  const issues = lintComposeYaml(
    `services:
  web:
    image: nginx
    x-turbopanel:
      source:
        sourceId: "  "
`,
    { knownSourceIds: new Set([SOURCE_ID]) },
  );
  assertEquals(
    issues.some((issue) => issue.message.includes("was not found")),
    false,
  );
});

test("lintComposeYaml skips resolution when source is not a mapping", () => {
  const issues = lintComposeYaml(
    `services:
  web:
    image: nginx
    x-turbopanel:
      source: ${SOURCE_ID}
`,
    { knownSourceIds: new Set([SOURCE_ID]) },
  );
  assertEquals(
    issues.some((issue) => issue.path === "services.web.x-turbopanel.source"),
    true,
  );
  assertEquals(
    issues.some((issue) => issue.message.includes("was not found")),
    false,
  );
});

test("lintComposeYaml skips resolution when source omits sourceId", () => {
  const issues = lintComposeYaml(
    `services:
  web:
    image: nginx
    x-turbopanel:
      source:
        branch: main
`,
    { knownSourceIds: new Set([SOURCE_ID]) },
  );
  assertEquals(
    issues.some((issue) => issue.message.includes("was not found")),
    false,
  );
});

test("lintComposeYaml treats a null image as missing and ignores a scalar environment", () => {
  const issues = lintComposeYaml(`services:
  app:
    image: null
    environment: PRODUCTION
`);
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.app" && issue.message.includes("image")
    ),
    true,
  );
});

test("lintComposeYaml skips non-string environment map values", () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx
    environment:
      PORT: 8080
      BAD: prefix-{$PORT}
`);
  assertEquals(
    issues.some((issue) => issue.path === "services.web.environment.PORT"),
    false,
  );
  assertEquals(
    issues.some((issue) => issue.path === "services.web.environment.BAD"),
    true,
  );
});

test("lintComposeYaml skips list-form environment entries with no separator", () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx
    environment:
      - BARE
      - BAD=prefix-{$PORT}
`);
  assertEquals(
    issues.some((issue) => issue.path === "services.web.environment[0]"),
    false,
  );
  assertEquals(
    issues.some((issue) => issue.path === "services.web.environment[1]"),
    true,
  );
});

test("lintComposeYaml lints colon-form and mixed-separator list environment values", () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx
    environment:
      - COLON:prefix-{$PORT}
      - MIXED=prefix-{$PORT}:tail
`);
  assertEquals(
    issues.some((issue) => issue.path === "services.web.environment[0]"),
    true,
  );
  assertEquals(
    issues.some((issue) => issue.path === "services.web.environment[1]"),
    true,
  );
});

test("lintComposeYaml treats a blank image string as missing", () => {
  const issues = lintComposeYaml(`services:
  app:
    image: "   "
`);
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.app" && issue.message.includes("image")
    ),
    true,
  );
});

test("lintComposeYaml skips boolean top-level keys", () => {
  const issues = lintComposeYaml(`true: ignored
services:
  web:
    image: nginx
`);
  assertEquals(issues.some((issue) => issue.path === "true"), false);
});

test("lintComposeYaml advisories a tagged top-level networks key on the base layer", () => {
  const source = `networks: !override
  front: {}
services:
  web:
    image: nginx
`;
  const issues = lintComposeYaml(source);
  const advisory = issues.find((issue) => issue.path === "networks");
  assertEquals(advisory?.blocking, false);
  assertEquals(
    advisory?.message.includes("only take effect in an overlay"),
    true,
  );
  assertEquals(
    lintComposeYaml(source, { layer: "overlay" }).some((issue) =>
      issue.path === "networks"
    ),
    false,
  );
});

test("lintComposeYaml sorts same-line same-level issues by path", () => {
  const issues = lintComposeYaml(`services:
  web: { image: nginx, zzbar: 1, zzfoo: 2 }
`);
  const unknown = issues.filter((issue) =>
    issue.path.startsWith("services.web.zz")
  );
  assertEquals(
    unknown.map((issue) => issue.path),
    ["services.web.zzbar", "services.web.zzfoo"],
  );
});

test("lintComposeYaml does not treat a non-mapping x-turbopanel as host-native", () => {
  const issues = lintComposeYaml(`services:
  app:
    x-turbopanel: true
`);
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.app" && issue.message.includes("image")
    ),
    true,
  );
});

test("lintComposeYaml railpack source is not host-native when source is a scalar", () => {
  const issues = lintComposeYaml(`services:
  app:
    x-turbopanel:
      source: not-a-map
`);
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.app" && issue.message.includes("image")
    ),
    true,
  );
});

test("lintComposeYaml skips image requirement for a railpack-built source", () => {
  const issues = lintComposeYaml(`services:
  app:
    x-turbopanel:
      source:
        sourceId: ${SOURCE_ID}
        buildKind: railpack
`);
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.app" && issue.message.includes("image")
    ),
    false,
  );
});

test("lintComposeYaml trims whitespace around railpack buildKind", () => {
  const issues = lintComposeYaml(`services:
  app:
    x-turbopanel:
      source:
        sourceId: ${SOURCE_ID}
        buildKind: "  railpack  "
`);
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.app" && issue.message.includes("image")
    ),
    false,
  );
});

test("lintComposeYaml list-form environment picks the earlier of = and : separators", () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx
    environment:
      - BOTH=prefix-{$PORT}:tail
      - COLONFIRST:prefix-{$PORT}=tail
`);
  assertEquals(
    issues.some((issue) => issue.path === "services.web.environment[0]"),
    true,
  );
  assertEquals(
    issues.some((issue) => issue.path === "services.web.environment[1]"),
    true,
  );
});

test("lintComposeYaml tag walk skips nested non-string map keys", () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx
    healthcheck:
      42: !override
        - ignored
      test: !override
        - CMD-SHELL
        - exit 0
`);
  assertEquals(
    issues.some((issue) => issue.path === "services.web.healthcheck.test"),
    true,
  );
  assertEquals(
    issues.some((issue) => issue.path.includes("healthcheck.42")),
    false,
  );
});

const OTHER_SOURCE_ID = "01989d42-9adb-7e65-bc2e-f38792c53692";

/** Two services, each naming its own repository. */
const TWO_REPOSITORIES = `services:
  web:
    image: nginx
    x-turbopanel:
      source:
        sourceId: ${SOURCE_ID}
  jobs:
    image: nginx
    x-turbopanel:
      source:
        sourceId: ${OTHER_SOURCE_ID}
`;

test("lintComposeYaml skips the single-repository rule when projectRepositoryId is omitted", () => {
  const issues = lintComposeYaml(TWO_REPOSITORIES);
  assertEquals(
    issues.some((issue) => issue.message.includes("one repository")),
    false,
  );
});

test("lintComposeYaml rejects a second repository on an unbound project", () => {
  const issues = lintComposeYaml(TWO_REPOSITORIES, {
    projectRepositoryId: null,
  });
  const offender = issues.find((issue) =>
    issue.path === "services.jobs.x-turbopanel.source.sourceId"
  );
  assertEquals(offender?.level, "error");
  assertEquals(offender?.message.includes("one repository"), true);
  // The first id is the one the project adopts, so it is never the offender.
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.web.x-turbopanel.source.sourceId" &&
      issue.level === "error"
    ),
    false,
  );
  assertEquals(blockingComposeLintIssues(issues).length > 0, true);
});

test("lintComposeYaml accepts several services bound to one repository", () => {
  const issues = lintComposeYaml(
    `services:
  web:
    image: nginx
    x-turbopanel:
      source:
        sourceId: ${SOURCE_ID}
        subdirectory: apps/web
  api:
    image: nginx
    x-turbopanel:
      source:
        sourceId: ${SOURCE_ID}
        subdirectory: apps/api
`,
    { projectRepositoryId: SOURCE_ID, knownSourceIds: new Set([SOURCE_ID]) },
  );
  assertEquals(
    issues.some((issue) => issue.message.includes("one repository")),
    false,
  );
  assertEquals(blockingComposeLintIssues(issues), []);
});

test("lintComposeYaml rejects a source that is not the bound project repository", () => {
  const issues = lintComposeYaml(
    `services:
  web:
    image: nginx
    x-turbopanel:
      source:
        sourceId: ${OTHER_SOURCE_ID}
`,
    { projectRepositoryId: SOURCE_ID },
  );
  const offender = issues.find((issue) =>
    issue.path === "services.web.x-turbopanel.source.sourceId"
  );
  assertEquals(offender?.level, "error");
  assertEquals(offender?.message.includes(OTHER_SOURCE_ID), true);
  assertEquals(offender?.message.includes("this project's repository"), true);
});

test("lintComposeYaml leaves a project with no bound services alone", () => {
  const issues = lintComposeYaml(
    `services:
  db:
    image: postgres:17
`,
    { projectRepositoryId: null },
  );
  assertEquals(
    issues.some((issue) => issue.message.includes("one repository")),
    false,
  );
});

test("lintComposeYaml warns when nodeVersion pins an unoffered series", () => {
  const issues = lintComposeYaml(`services:
  web:
    x-turbopanel:
      serviceKind: node
      nodeVersion: "18"
      source:
        sourceId: ${SOURCE_ID}
`);
  const advisory = issues.find((issue) =>
    issue.path === "services.web.x-turbopanel.nodeVersion"
  );
  assertEquals(advisory?.level, "warning");
  assertEquals(advisory?.blocking, false);
  assertEquals(advisory?.message.includes("not an offered series"), true);
});

test("lintComposeYaml stays quiet for an offered node series and its minor pins", () => {
  for (const version of ["24", "24.17"]) {
    const issues = lintComposeYaml(`services:
  web:
    x-turbopanel:
      serviceKind: node
      nodeVersion: "${version}"
      source:
        sourceId: ${SOURCE_ID}
`);
    assertEquals(
      issues.some((issue) => issue.message.includes("not an offered series")),
      false,
      version,
    );
  }
});

test("lintComposeYaml skips the principal rule when no alias set is supplied", () => {
  // Same contract as `knownSourceIds`: a caller with no scope must not be made
  // to false-flag a document whose sibling layer it cannot see.
  const issues = lintComposeYaml(`services:
  blog:
    x-turbopanel:
      serviceKind: site
      principal: app
`);
  assertEquals(
    issues.some((issue) => issue.message.includes("x-turbopanel.principals")),
    false,
  );
});

test("lintComposeYaml blocks a principal alias the document does not declare", () => {
  const issues = lintComposeYaml(
    `services:
  blog:
    x-turbopanel:
      serviceKind: site
      principal: ghost
`,
    { knownPrincipalAliases: new Set(["app"]) },
  );
  const issue = issues.find((entry) =>
    entry.path === "services.blog.x-turbopanel.principal"
  );
  assertEquals(issue?.level, "error");
  assertEquals(issue?.line, 5);
  assertEquals(issue?.message.includes("principal 'ghost'"), true);
});

test("lintComposeYaml accepts a principal alias the set contains", () => {
  const issues = lintComposeYaml(
    `services:
  blog:
    x-turbopanel:
      serviceKind: site
      principal: app
`,
    { knownPrincipalAliases: new Set(["app"]) },
  );
  assertEquals(
    issues.some((issue) =>
      issue.path === "services.blog.x-turbopanel.principal"
    ),
    false,
  );
});

test("lintComposeYaml refuses targetPort on a node service hosting entry", () => {
  const source = `services:
  app:
    image: node:24
    x-turbopanel:
      serviceKind: node
      hosting:
        - hostname: app.example.com
          targetPort: 3000
`;
  const issue = lintComposeYaml(source).find((row) =>
    row.path === "services.app.x-turbopanel.hosting[0].targetPort"
  );
  assertEquals(issue?.level, "error");
  assertEquals(
    issue?.message,
    "targetPort is not valid on a node service; the daemon allocates the app listen port",
  );
  assertEquals(issue?.line, 8);
});

test("lintComposeYaml refuses tls.mode automatic with the line that names it", () => {
  const source = `services:
  web:
    image: nginx:alpine
    x-turbopanel:
      hosting:
        - hostname: app.example.com
          tls:
            mode: automatic
`;
  const issue = lintComposeYaml(source).find((row) =>
    row.path === "services.web.x-turbopanel.hosting[0].tls.mode"
  );
  assertEquals(issue?.level, "error");
  assertEquals(issue?.line, 8);
});

test("lintComposeYaml accepts tls.mode internal on a container hosting entry", () => {
  const source = `services:
  web:
    image: nginx:alpine
    x-turbopanel:
      hosting:
        - hostname: app.example.com
          targetPort: 8080
          tls:
            mode: internal
`;
  assertEquals(
    lintComposeYaml(source).filter((row) => row.path.includes(".hosting")),
    [],
  );
});

test("lintComposeYaml refuses a hosting entry with no usable hostname", () => {
  const source = `services:
  web:
    image: nginx:alpine
    x-turbopanel:
      hosting:
        - hostname: not a host
`;
  const issue = lintComposeYaml(source).find((row) =>
    row.path === "services.web.x-turbopanel.hosting[0].hostname"
  );
  assertEquals(issue?.level, "error");
  assertEquals(issue?.message.includes("hostname is required"), true);
});

test("lintComposeYaml refuses targetPort on a site service hosting entry", () => {
  const source = `services:
  blog:
    x-turbopanel:
      serviceKind: site
      hosting:
        - hostname: blog.example.com
          targetPort: 8080
`;
  const issue = lintComposeYaml(source).find((row) =>
    row.path === "services.blog.x-turbopanel.hosting[0].targetPort"
  );
  assertEquals(issue?.level, "error");
  assertEquals(
    issue?.message,
    "targetPort is not valid on a site service; the daemon allocates the engine listen port",
  );
});

test("lintComposeYaml resolves tls.certificateRef only when knownTlsIds is supplied", () => {
  const source = `services:
  web:
    image: nginx:alpine
    x-turbopanel:
      hosting:
        - hostname: app.example.com
          tls:
            mode: certificate
            certificateRef: wildcard
`;
  assertEquals(
    lintComposeYaml(source).some((row) =>
      row.path === "services.web.x-turbopanel.hosting[0].tls.certificateRef"
    ),
    false,
  );
  const missing = lintComposeYaml(source, {
    knownTlsIds: new Set(["other"]),
  }).find((row) =>
    row.path === "services.web.x-turbopanel.hosting[0].tls.certificateRef"
  );
  assertEquals(missing?.level, "error");
  assertEquals(missing?.message.includes("certificate 'wildcard'"), true);
  assertEquals(
    lintComposeYaml(source, { knownTlsIds: new Set(["wildcard"]) }).some((
      row,
    ) =>
      row.path === "services.web.x-turbopanel.hosting[0].tls.certificateRef"
    ),
    false,
  );
  const blankRef = `services:
  web:
    image: nginx:alpine
    x-turbopanel:
      hosting:
        - hostname: app.example.com
          tls:
            mode: certificate
            certificateRef: "   "
`;
  assertEquals(
    lintComposeYaml(blankRef, { knownTlsIds: new Set(["wildcard"]) }).some((
      row,
    ) =>
      row.path === "services.web.x-turbopanel.hosting[0].tls.certificateRef"
    ),
    false,
  );
});

test("lintComposeYaml resolves bind.ipRef only when knownIpIds is supplied", () => {
  const source = `services:
  web:
    image: nginx:alpine
    x-turbopanel:
      hosting:
        - hostname: app.example.com
          bind:
            scope: public
            ipRef: 203.0.113.10
`;
  assertEquals(
    lintComposeYaml(source).some((row) =>
      row.path === "services.web.x-turbopanel.hosting[0].bind.ipRef"
    ),
    false,
  );
  const missing = lintComposeYaml(source, {
    knownIpIds: new Set(["203.0.113.99"]),
  }).find((row) =>
    row.path === "services.web.x-turbopanel.hosting[0].bind.ipRef"
  );
  assertEquals(missing?.level, "error");
  assertEquals(missing?.message.includes("ip '203.0.113.10'"), true);
  assertEquals(
    lintComposeYaml(source, { knownIpIds: new Set(["203.0.113.10"]) }).some((
      row,
    ) => row.path === "services.web.x-turbopanel.hosting[0].bind.ipRef"),
    false,
  );
});

/**
 * `deploy.mode` job values, at both postures.
 *
 * The two Swarm job modes are schema-valid Compose (the vendored spec types
 * `mode` as a bare string), and `parseDeployMode` in `lib/schedule/interpret.ts`
 * would fold either into `replicated` — deploying a long-running service where
 * the document asked for finite work. Save-time keeps the draft editable;
 * deploy-time refuses it.
 */
for (const mode of ["replicated-job", "global-job"]) {
  test(`lintComposeYaml warns on deploy.mode: ${mode} while editing`, () => {
    const source = `services:
  worker:
    image: nginx:alpine
    deploy:
      mode: ${mode}
`;
    const issues = lintComposeYaml(source);
    const found = issues.find((row) =>
      row.path === "services.worker.deploy.mode"
    );
    assertEquals(found?.level, "warning");
    assertEquals(found?.code, "field_unsupported");
    assertEquals(found?.blocking, false);
    assertEquals(found?.line, 5);
    assertEquals(found?.message.includes(mode), true);
    // Advice, not a refusal: the draft still saves.
    assertEquals(
      blockingComposeLintIssues(issues).some(
        (row) => row.path === "services.worker.deploy.mode",
      ),
      false,
    );
  });

  test(`lintComposeYaml refuses deploy.mode: ${mode} at deploy time`, () => {
    const source = `services:
  worker:
    image: nginx:alpine
    deploy:
      mode: ${mode}
`;
    const found = lintComposeYaml(source, { strict: true }).find(
      (row) => row.path === "services.worker.deploy.mode",
    );
    assertEquals(found?.level, "error");
    assertEquals(found?.code, "field_unsupported");
    assertEquals(found?.blocking, undefined);
  });
}

test("lintComposeYaml leaves the two modes TurboPanel schedules alone", () => {
  for (const mode of ["replicated", "global"]) {
    const source = `services:
  worker:
    image: nginx:alpine
    deploy:
      mode: ${mode}
`;
    assertEquals(lintComposeYaml(source), []);
    assertEquals(lintComposeYaml(source, { strict: true }), []);
  }
});
