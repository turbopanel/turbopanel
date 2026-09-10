import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  computeDaemonSourceFingerprint,
  type DevOverlayHooks,
  ensureDevOverlayCurrent,
  readDevOverlayIdentity,
  resetDevOverlayCacheForTests,
  resolveDevTrunkManifest,
} from "./dev-update-overlay.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const HEAD = "abcdef0123456789abcdef0123456789abcdef01";

function stubGit(
  outputs: Record<string, string | Error>,
): NonNullable<DevOverlayHooks["runGit"]> {
  return (_repo, args) => {
    const value = outputs[args[0]!];
    if (value instanceof Error) {
      return Promise.resolve({
        success: false,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode(value.message),
      });
    }
    return Promise.resolve({
      success: true,
      stdout: new TextEncoder().encode(value ?? ""),
      stderr: new Uint8Array(),
    });
  };
}

const CLEAN_GIT = stubGit({
  "rev-parse": `${HEAD}\n`,
  diff: "",
  "ls-files": "",
});

function manifestText(source?: string): string {
  return JSON.stringify({
    schema: 1,
    channel: "trunk",
    commit: `${HEAD}+1767225600`,
    buildId: "dev-abcdef0+1767225600",
    builtAt: "2026-01-01T00:00:00.000Z",
    ...(source ? { source } : {}),
  });
}

test("computeDaemonSourceFingerprint matches the daemon algorithm shapes", async () => {
  const clean = await computeDaemonSourceFingerprint("/repo", CLEAN_GIT);
  assertEquals(clean, HEAD);

  const dirty = await computeDaemonSourceFingerprint(
    "/repo",
    stubGit({ "rev-parse": HEAD, diff: "+x\n", "ls-files": "" }),
  );
  assertEquals(dirty.startsWith(`${HEAD}+dirty.`), true);
  assertEquals(/[0-9a-f]{12}$/.test(dirty), true);

  const untracked = await computeDaemonSourceFingerprint(
    "/repo",
    stubGit({
      "rev-parse": HEAD,
      diff: "",
      "ls-files": "src/new.ts\n",
      "hash-object": "1111111111111111111111111111111111111111\n",
    }),
  );
  assertNotEquals(untracked, HEAD);
  assertNotEquals(untracked, dirty);

  await assertRejects(
    () =>
      computeDaemonSourceFingerprint(
        "/repo",
        stubGit({ "rev-parse": new Error("not a git repository") }),
      ),
    Error,
    "git rev-parse failed",
  );
});

test("readDevOverlayIdentity parses the catalog and rejects malformed input", async () => {
  const identity = await readDevOverlayIdentity(
    "/repo",
    () => Promise.resolve(manifestText(HEAD)),
  );
  assertEquals(identity, {
    commit: `${HEAD}+1767225600`,
    buildId: "dev-abcdef0+1767225600",
    builtAt: "2026-01-01T00:00:00.000Z",
    source: HEAD,
  });

  const withoutSource = await readDevOverlayIdentity(
    "/repo",
    () => Promise.resolve(manifestText()),
  );
  assertEquals(withoutSource?.source, undefined);

  assertEquals(
    await readDevOverlayIdentity("/repo", () => Promise.resolve("not json")),
    null,
  );
  assertEquals(
    await readDevOverlayIdentity(
      "/repo",
      () => Promise.resolve(JSON.stringify({ commit: 7 })),
    ),
    null,
  );
  assertEquals(
    await readDevOverlayIdentity(
      "/repo",
      () => Promise.reject(new Error("ENOENT")),
    ),
    null,
  );
});

test("resolveDevTrunkManifest returns the overlay identity when fresh", async () => {
  resetDevOverlayCacheForTests();
  const target = await resolveDevTrunkManifest({
    repoPath: () => "/repo",
    runGit: CLEAN_GIT,
    readManifestText: () => Promise.resolve(manifestText(HEAD)),
  });
  assertEquals(target?.commit, `${HEAD}+1767225600`);
  assertEquals(target?.buildId, "dev-abcdef0+1767225600");
  assertEquals(target?.channel, "trunk");
  assertEquals(target?.manifestUrl, "/repo/dist/manifest.json");
});

test("resolveDevTrunkManifest reports a pending target on fingerprint drift", async () => {
  resetDevOverlayCacheForTests();
  const now = new Date("2026-02-02T00:00:00.000Z");
  const target = await resolveDevTrunkManifest({
    repoPath: () => "/repo",
    runGit: stubGit({ "rev-parse": HEAD, diff: "+edited\n", "ls-files": "" }),
    readManifestText: () => Promise.resolve(manifestText(HEAD)),
    now: () => now,
  });
  assertEquals(target?.commit.startsWith(`${HEAD}+dirty.`), true);
  assertEquals(target?.buildId, `dev-${HEAD.slice(0, 7)}+pending`);
  assertEquals(target?.builtAt, now.toISOString());

  // A missing overlay catalog is also a pending target, never "up to date".
  resetDevOverlayCacheForTests();
  const missing = await resolveDevTrunkManifest({
    repoPath: () => "/repo",
    runGit: CLEAN_GIT,
    readManifestText: () => Promise.reject(new Error("ENOENT")),
  });
  assertEquals(missing?.commit, HEAD);
});

test("resolveDevTrunkManifest caches and returns null when git fails", async () => {
  resetDevOverlayCacheForTests();
  let calls = 0;
  const hooks: DevOverlayHooks = {
    repoPath: () => "/repo",
    runGit: (_repo, args) => {
      if (args[0] === "rev-parse") calls += 1;
      return CLEAN_GIT("/repo", args);
    },
    readManifestText: () => Promise.resolve(manifestText(HEAD)),
  };
  await resolveDevTrunkManifest(hooks);
  await resolveDevTrunkManifest(hooks);
  assertEquals(calls, 1);

  resetDevOverlayCacheForTests();
  const failed = await resolveDevTrunkManifest({
    repoPath: () => "/repo",
    runGit: stubGit({ "rev-parse": new Error("boom") }),
  });
  assertEquals(failed, null);
});

test("ensureDevOverlayCurrent skips the build when the overlay is fresh", async () => {
  resetDevOverlayCacheForTests();
  let built = 0;
  await ensureDevOverlayCurrent({
    repoPath: () => "/repo",
    runGit: CLEAN_GIT,
    readManifestText: () => Promise.resolve(manifestText(HEAD)),
    runRebuild: () => {
      built += 1;
      return Promise.resolve({ success: true, code: 0, output: "" });
    },
  });
  assertEquals(built, 0);
});

test("ensureDevOverlayCurrent rebuilds on drift and coalesces callers", async () => {
  resetDevOverlayCacheForTests();
  let built = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hooks: DevOverlayHooks = {
    repoPath: () => "/repo",
    runGit: CLEAN_GIT,
    readManifestText: () => Promise.resolve(manifestText("stale-source")),
    runRebuild: async () => {
      built += 1;
      await gate;
      return { success: true, code: 0, output: "done" };
    },
  };
  const first = ensureDevOverlayCurrent(hooks);
  const second = ensureDevOverlayCurrent(hooks);
  release!();
  await Promise.all([first, second]);
  assertEquals(built, 1);
});

test("ensureDevOverlayCurrent rejects when the build fails", async () => {
  resetDevOverlayCacheForTests();
  await assertRejects(
    () =>
      ensureDevOverlayCurrent({
        repoPath: () => "/repo",
        runGit: CLEAN_GIT,
        readManifestText: () => Promise.reject(new Error("ENOENT")),
        runRebuild: () =>
          Promise.resolve({ success: false, code: 7, output: "compile boom" }),
      }),
    Error,
    "exited 7",
  );
});

test("readDevOverlayIdentity rejects non-object manifests", async () => {
  assertEquals(
    await readDevOverlayIdentity("/repo", () => Promise.resolve("null")),
    null,
  );
  assertEquals(
    await readDevOverlayIdentity("/repo", () => Promise.resolve("42")),
    null,
  );
});

test("computeDaemonSourceFingerprint uses the default git runner", async () => {
  await assertRejects(() =>
    computeDaemonSourceFingerprint("/tmp/turbopanel-missing-overlay-repo")
  );
});
