import { assertEquals } from "@std/assert";
import {
  assignNativeAppListenPorts,
  isNativeAppRestartDuration,
  isNativeAppRestartMaxAttempts,
  readNativeAppRestartPolicy,
  readNativeAppServiceLabels,
  splitNativeAppServices,
} from "./native-app.ts";
import { lintComposeYaml } from "./lint.ts";
import { assignSiteListenPorts, splitSiteServices } from "./site.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SOURCE_ID = "11111111-2222-3333-4444-555555555555";

function nodeService(extra: Record<string, unknown> = {}) {
  return {
    "x-turbopanel": {
      serviceKind: "node",
      source: { sourceId: SOURCE_ID },
      ...extra,
    },
  };
}

test("splitNativeAppServices pulls node services out of the container map", () => {
  const { containerServices, apps } = splitNativeAppServices({
    api: { image: "node:24" },
    web: nodeService({ framework: "next", nodeVersion: "24.17.0" }),
  });

  assertEquals(Object.keys(containerServices), ["api"]);
  assertEquals(apps.length, 1);
  assertEquals(apps[0]?.composeServiceName, "web");
  assertEquals(apps[0]?.framework, "next");
  assertEquals(apps[0]?.nodeVersion, "24.17.0");
});

test("splitNativeAppServices defaults framework to auto", () => {
  const { apps } = splitNativeAppServices({ web: nodeService() });
  assertEquals(apps[0]?.framework, "auto");
});

test("splitNativeAppServices carries appMode, enabled, and startupFile", () => {
  const { apps } = splitNativeAppServices({
    web: nodeService({
      appMode: "development",
      enabled: false,
      startupFile: "app.js",
    }),
  });

  // A disabled app is still emitted — dropping it would make reconcile tear
  // the unit down and strand the release.
  assertEquals(apps.length, 1);
  assertEquals(apps[0]?.appMode, "development");
  assertEquals(apps[0]?.enabled, false);
  assertEquals(apps[0]?.startupFile, "app.js");
});

test("undeclared node app settings stay absent on the split spec", () => {
  const { apps } = splitNativeAppServices({ web: nodeService() });
  assertEquals(apps.length, 1);
  assertEquals("appMode" in (apps[0] ?? {}), false);
  assertEquals("enabled" in (apps[0] ?? {}), false);
  assertEquals("startupFile" in (apps[0] ?? {}), false);
});

test("a node service with no source is dropped rather than left for Docker", () => {
  // Validation rejects this document; if one slips through, an image-less
  // service handed to `compose up` would fail the whole deploy.
  const { containerServices, apps } = splitNativeAppServices({
    web: { "x-turbopanel": { serviceKind: "node" } },
  });
  assertEquals(Object.keys(containerServices), []);
  assertEquals(apps, []);
});

test("site and native apps never share a loopback port", () => {
  const services: Record<string, unknown> = {
    site: {
      "x-turbopanel": { serviceKind: "site", engine: "nginx" },
    },
    web: nodeService(),
    worker: nodeService(),
  };

  const used = new Set<number>();
  const split = splitSiteServices(services, new Map(), used);
  const native = splitNativeAppServices(split.containerServices, used);

  const ports = [
    ...split.sites.map((site) => site.listenPort),
    ...native.apps.map((app) => app.listenPort),
  ];
  assertEquals(ports.length, 3);
  assertEquals(new Set(ports).size, 3);
});

test("re-assignment keeps the two lanes disjoint when a hosting pins a port", () => {
  const used = new Set<number>();
  const sites = assignSiteListenPorts(
    [{
      composeServiceName: "site",
      engine: "nginx",
      root: "public",
      listenPort: 0,
    }],
    new Map([["site", 18100]]),
    used,
  );
  const apps = assignNativeAppListenPorts(
    [{ composeServiceName: "web", framework: "auto" as const, listenPort: 0 }],
    // A native app asking for the port the site already took must be moved,
    // not silently given a duplicate.
    new Map([["web", 18100]]),
    used,
  );

  assertEquals(sites[0]?.listenPort, 18100);
  assertEquals(apps[0]?.listenPort === 18100, false);
});

/**
 * `deploy.restart_policy` on a `node` service.
 *
 * The service is about to be removed from `containerServices`, so a plain
 * Compose key it carries has to be read here or it is gone. On the Docker lane
 * the same key survives into the runtime document and the engine acts on it;
 * on this lane the generated systemd unit is the only thing that can.
 */
test("splitNativeAppServices carries deploy.restart_policy onto the app", () => {
  const { apps } = splitNativeAppServices({
    web: {
      ...nodeService(),
      deploy: {
        restart_policy: {
          condition: "any",
          delay: "5s",
          max_attempts: 3,
          window: "1m30s",
        },
      },
    },
  });
  assertEquals(apps[0]?.restartPolicy, {
    condition: "any",
    delay: "5s",
    maxAttempts: 3,
    window: "1m30s",
  });
});

test("splitNativeAppServices keeps only the restart_policy fields authored", () => {
  const { apps } = splitNativeAppServices({
    web: {
      ...nodeService(),
      deploy: { restart_policy: { delay: "10s" } },
    },
  });
  // No synthesized defaults: "absent" has to stay distinguishable from "set to
  // whatever the current default happens to be".
  assertEquals(apps[0]?.restartPolicy, { delay: "10s" });
});

test("readNativeAppRestartPolicy names values it cannot honour", () => {
  // The old behavior was to keep the translatable subset and let the rest fall
  // on the floor, so an author got a unit running on defaults and no
  // diagnostic. Every unhonourable key now comes back named.
  const read = readNativeAppRestartPolicy({
    deploy: {
      restart_policy: {
        condition: "sometimes",
        delay: "soon",
        // Would render as `StartLimitBurst=0`, which systemd reads as *no*
        // rate limit — the opposite of "do not retry".
        max_attempts: 0,
      },
    },
  });
  assertEquals(read.policy, undefined);
  assertEquals(read.unsupported, ["condition", "delay", "max_attempts"]);
});

test("readNativeAppRestartPolicy reports the bad key beside the good ones", () => {
  const read = readNativeAppRestartPolicy({
    deploy: {
      restart_policy: { condition: "on-failure", window: "a while" },
    },
  });
  assertEquals(read.policy, { condition: "on-failure" });
  assertEquals(read.unsupported, ["window"]);
});

test("readNativeAppRestartPolicy reports nothing when nothing is authored", () => {
  assertEquals(readNativeAppRestartPolicy({}), { unsupported: [] });
  assertEquals(readNativeAppRestartPolicy({ deploy: {} }), { unsupported: [] });
});

/**
 * The refusal the reader's verdict is wired to.
 *
 * `splitNativeAppServices` runs after validation, so the values it would have
 * dropped never reach it: the deploy stops at the linter, which speaks for the
 * same grammar the reader enforces.
 */
test("an unhonourable native restart_policy is refused before deploy", () => {
  const issues = lintComposeYaml(
    `services:
  web:
    x-turbopanel:
      serviceKind: node
      source:
        sourceId: ${SOURCE_ID}
    deploy:
      restart_policy:
        condition: sometimes
        max_attempts: 0
`,
    { strict: true },
  );
  const paths = issues
    .filter((issue) => issue.code === "field_unsupported")
    .map((issue) => issue.path)
    .sort();
  assertEquals(paths, [
    "services.web.deploy.restart_policy.condition",
    "services.web.deploy.restart_policy.max_attempts",
  ]);
  assertEquals(
    issues.every((issue) =>
      issue.code !== "field_unsupported" || issue.level === "error"
    ),
    true,
  );
});

test("a container service keeps the whole Compose restart vocabulary", () => {
  // Docker reads it itself; narrowing it there would refuse documents that work.
  const issues = lintComposeYaml(
    `services:
  web:
    image: nginx:alpine
    deploy:
      restart_policy:
        condition: unless-stopped
        max_attempts: 0
`,
    { strict: true },
  );
  assertEquals(
    issues.filter((issue) => issue.code === "field_unsupported"),
    [],
  );
});

/**
 * `deploy.labels` on a `node` service.
 *
 * Service metadata, not container metadata — Compose keeps the two namespaces
 * apart and so does TurboPanel. On the Docker lane the block simply stays in
 * the runtime document; here the service leaves that document entirely, so the
 * labels have to be carried or they are gone.
 */
test("splitNativeAppServices carries deploy.labels as service metadata", () => {
  const { apps } = splitNativeAppServices({
    web: {
      ...nodeService(),
      deploy: { labels: { "com.example.team": "platform" } },
    },
  });
  assertEquals(apps[0]?.serviceLabels, { "com.example.team": "platform" });
});

test("readNativeAppServiceLabels accepts both Compose spellings", () => {
  assertEquals(
    readNativeAppServiceLabels({
      deploy: { labels: { "com.example.team": "platform", tier: 1 } },
    }),
    { "com.example.team": "platform", tier: "1" },
  );
  // The sequence form is equally valid Compose; a bare key is an empty value.
  assertEquals(
    readNativeAppServiceLabels({
      deploy: { labels: ["com.example.team=platform", "audited"] },
    }),
    { "com.example.team": "platform", audited: "" },
  );
  assertEquals(
    readNativeAppServiceLabels({ deploy: { labels: {} } }),
    undefined,
  );
  assertEquals(readNativeAppServiceLabels({ deploy: {} }), undefined);
  assertEquals(readNativeAppServiceLabels({}), undefined);
});

test("readNativeAppServiceLabels skips empty keys and non-scalar mapping values", () => {
  assertEquals(
    readNativeAppServiceLabels({
      deploy: {
        labels: {
          "": "dropped",
          kept: null,
          also: undefined,
          flag: true,
          nested: { no: true },
        },
      },
    }),
    { kept: "", also: "", flag: "true" },
  );
  assertEquals(
    readNativeAppServiceLabels({
      deploy: { labels: [12, "=orphan", "  team=ops", { no: true }] },
    }),
    { team: "ops" },
  );
});

test("isNativeAppRestartMaxAttempts accepts a whole count of at least one", () => {
  assertEquals(isNativeAppRestartMaxAttempts(3), true);
  assertEquals(isNativeAppRestartMaxAttempts("12"), true);
  assertEquals(isNativeAppRestartMaxAttempts(" 8 "), true);
  assertEquals(isNativeAppRestartMaxAttempts(0), false);
  assertEquals(isNativeAppRestartMaxAttempts("0"), false);
  assertEquals(isNativeAppRestartMaxAttempts(1.5), false);
  assertEquals(isNativeAppRestartMaxAttempts(true), false);
  assertEquals(isNativeAppRestartDuration("5s"), true);
  assertEquals(isNativeAppRestartDuration("1m30s"), true);
  assertEquals(isNativeAppRestartDuration(5), false);
});

test("splitNativeAppServices leaves serviceLabels absent when none are authored", () => {
  const { apps } = splitNativeAppServices({ web: nodeService() });
  assertEquals("serviceLabels" in (apps[0] ?? {}), false);
});

test("splitNativeAppServices leaves restartPolicy absent when none is authored", () => {
  const { apps } = splitNativeAppServices({ web: nodeService() });
  assertEquals("restartPolicy" in (apps[0] ?? {}), false);
});
