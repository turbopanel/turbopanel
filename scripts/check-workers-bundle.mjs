#!/usr/bin/env node
/**
 * Bundle the Cloudflare Workers deploy entrypoint (`src/workers.ts`) without
 * uploading. Catches unresolved imports Wrangler/esbuild cannot resolve —
 * notably Deno `@std/*` / `jsr:` specifiers that Deno import maps satisfy but
 * the Workers bundler does not.
 *
 * `pnpm test:do` is not a substitute: vitest uses `src/workers-vitest.ts` and a
 * narrow include list, so tree-shaking can drop modules that only the full
 * deploy graph pulls in.
 *
 * Usage:
 *   node scripts/check-workers-bundle.mjs
 *   pnpm check:workers-bundle
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(WRANGLER)) {
  fail(
    "check-workers-bundle: wrangler not found — run `pnpm install` in the instance checkout",
  );
}

const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-workers-bundle-"));
const wranglerConfigHome = fs.mkdtempSync(
  path.join(os.tmpdir(), "tp-wrangler-xdg-"),
);

try {
  // Target the top-level wrangler env (deploy entry = src/workers.ts). Empty
  // --env silences the multi-env warning without selecting testing/live.
  const result = spawnSync(
    process.execPath,
    [
      WRANGLER,
      "deploy",
      "--dry-run",
      "--outdir",
      outdir,
      "--env",
      "",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        // Keep CI/local runs quiet; dry-run does not need network telemetry.
        WRANGLER_SEND_METRICS: "false",
        // Guest `/home/vagrant/.config` can be unwritable (EACCES mkdir
        // `.wrangler`). Isolate logs so the check reports bundle errors, not
        // home-directory permissions.
        XDG_CONFIG_HOME: wranglerConfigHome,
      },
    },
  );

  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    console.error(combined.trimEnd());
    fail(
      "check-workers-bundle: Wrangler dry-run failed — the Workers deploy graph does not bundle. Fix unresolved imports (no `@std/*` / `jsr:` in Workers-reachable modules) or add a wrangler alias/shim.",
    );
  }

  console.log("check-workers-bundle: ok");
} finally {
  fs.rmSync(outdir, { recursive: true, force: true });
  fs.rmSync(wranglerConfigHome, { recursive: true, force: true });
}
