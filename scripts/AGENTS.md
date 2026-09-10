# CI analysis & coverage (`scripts/`, SonarQube) — AGENTS.md

Moved from the root `AGENTS.md` (**Documentation discipline → SonarQube**).
Covers the SonarCloud CI job, the Vitest+Deno LCOV merge in
`test-coverage.sh`, and the analysis-scope rules.

**When adding, renaming, or deleting a `*.test.ts`:** claim it in exactly one
runner, then run **`pnpm check:test-inventory`**. This repo does not glob test
files — an unclaimed suite never runs in CI and contributes nothing to
`coverage/lcov.info`. Deno suites go in the `deno test` list in
`test-coverage.sh`; Workers/DO suites go in `vitest.config.ts` `test.include`;
Redis (etc.) suites go in `SERVICE_DEPENDENT` in `check-test-inventory.mjs`
with a reason. Full checklist: root `AGENTS.md` → **Adding tests (inventory)**.
The guard is wired into `pnpm test:hook` and CI `build.yml`.

- Analysis runs in GitHub Actions (`.github/workflows/build.yml` **SonarQube**
  job — SonarCloud wizard layout) with `SONAR_TOKEN` and
  `sonar-project.properties` (`sonar.projectKey=turbopanel_turbopanel`,
  `sonar.organization=turbopanel`). The job runs checks +
  **`pnpm test:coverage`** (`scripts/test-coverage.sh`), which merges Vitest
  Istanbul + Deno V8 LCOV into a single **`coverage/lcov.info`**
  (`sonar.javascript.lcov.reportPaths=coverage/lcov.info` in
  `sonar-project.properties` — **not** comma-separated dual paths; SonarCloud
  effectively only imported Deno hits that way, so Workers/DO files showed 0%
  despite real Istanbul coverage). Merge pairs SF records **by covered-line
  count** (higher LH is primary). Secondary may only raise shared hits or add
  **executed** lines — never zero-hit transitive rows. When Vitest only imported
  a Deno-tested module (`LH:0`), Deno unit hits become primary so Sonar no
  longer reports false 0% on `db-url` / `allocate-containers` / similar.
  Dilution of healthy Workers/DO Istanbul reports (e.g. offline-sweep →
  `do-registry.ts`) is still avoided because Deno zero-hit extras never expand
  LF when Vitest has more covered lines. Vitest `SF:` paths are normalized
  repo-relative like Deno. The script asserts non-zero Vitest hits for
  `src/daemon/cell/do.ts`, `do-registry.ts`, and `workers-ws.ts` before merge,
  and re-checks those LH floors on the **merged** `coverage/lcov.info`.
  Intermediate reports remain at `coverage/vitest/lcov.info` and
  `coverage/deno.lcov` for debugging:
  - **Vitest** (`coverage/vitest/lcov.info`) — Workers-pool suites
    (`vitest.config.ts` `test.include`), provider **`istanbul`**. The default
    `v8` provider cannot run inside workerd (no `node:inspector`), but
    `@cloudflare/vitest-pool-workers` bridges Istanbul counters back to Node, so
    `vitest run --coverage` is a real, non-zero report — **do not** assume
    Vitest coverage is unavailable. This is the _only_ LCOV source for
    Durable-Object / admin / other Workers-only code that no Deno suite imports
    (`src/daemon/cell/do.ts`, `src/daemon/workers-ws.ts`,
    `src/admin/public-urls.ts`, …).
  - **Deno** (`coverage/deno.lcov`) — host-free Deno suites listed in
    `scripts/test-coverage.sh`, via `deno coverage --lcov` (native V8). Then the
    scan runs with `sonar.qualitygate.wait=true`; if the quality gate fails, the
    workflow stops. **Coverage attribution (three independent traps — check all
    when Sonar shows 0% / low % while local Vitest is healthy):** (1) a new Deno
    `*.test.ts` file must be added to the `deno test` file list in
    `scripts/test-coverage.sh` — prefer host-free unit suites there;
    DB/Redis/integration suites stay out of LCOV. (2) a new Workers/DO test file
    must be added to `vitest.config.ts` `test.include` — that list is an
    explicit file enumeration, not a glob, because most `*.test.ts` files use
    Deno-only APIs and cannot run under the Workers pool; a file left off
    `test.include` never runs at all, coverage or not. Traps (1) and (2) are
    now enforced by **`pnpm check:test-inventory`**
    (`scripts/check-test-inventory.mjs`, wired into `test:hook` and CI
    `build.yml`): it fails when any `*.test.ts` is claimed by neither list, when
    a list entry names a file that no longer exists, or when a file is claimed
    by both. A suite that needs a service CI does not start (Redis, ClickHouse)
    goes in that script's `SERVICE_DEPENDENT` map **with a reason** — that map
    is the only sanctioned way to leave a suite out of both runners. (3) LCOV smart merge must
    stay in place — do not reintroduce full-record Vitest-wins (drops Deno hits
    for imported-but-untested modules) or naive Deno+Vitest line-union (dilutes
    Workers/DO with zero-hit transitive SF rows). Selective Workers/DO 0% with a
    healthy overall project coverage % is almost always an LCOV merge/path bug,
    not Automatic Analysis (AA being on fails the CI scanner entirely). (4) Co-located
    sibling imports (metrics `contract.ts` parity against `../turbopaneld`) can leak
    an absolute `SF:` path outside this repo. After prefix stripping,
    `test-coverage.sh` drops those out-of-repo LCOV records so SonarCloud does not
    discard the whole report.
- **`sonar.sources` / `sonar.tests` / `sonar.test.inclusions`** must stay set in
  `sonar-project.properties` (and mirrored in vestigial
  `.sonarcloud.properties`). Tests are co-located (`**/*.test.ts` under
  `src`/`mailer`); helpers that do not match the scanner's name heuristics
  (`src/test-fixtures/**`, `*-hostfree-doubles.ts`, `server-status-test-db.ts`,
  `fake-redis-cell-client.ts`, `workers-vitest.ts`, `vitest-env.d.ts`) belong in
  `test.inclusions` + `coverage.exclusions` so they are never main-code. Leaving
  `sonar.tests` unset only yields an INFO and heuristic classification that
  mis-labels those helpers.
- **Automatic Analysis must stay off** for `turbopanel_turbopanel` (SonarCloud →
  project **Administration → Analysis Method**). CI and Automatic Analysis
  cannot run together — Automatic Analysis enabled makes the CI scanner fail.
  There is no Sonar MCP `toggle_automatic_analysis` tool; change this only in
  the SonarCloud UI.
- Sonar-way **Coverage on New Code ≥ 80%** needs LCOV on CI. After switching
  from Automatic Analysis, reset **New Code** (Administration → New Code) so the
  baseline is not months of uncovered history, or the gate will fail even with
  fresh coverage reports.
- Drizzle-generated SQL under **`migrations/`** must stay excluded
  (`**/migrations/**`) — never “fix” smells in those files.
- Hand-authored OpenAPI under `src/client/openapi/**` and
  `src/daemon/openapi/**` is excluded from **duplication (CPD)** via
  `sonar.cpd.exclusions` (keep `sonar-project.properties` and the vestigial
  `.sonarcloud.properties` in sync). Schema/path blocks are intentionally
  repetitive across resources; refactor route/runtime code instead of twisting
  OpenAPI to please CPD.
- **SonarLint Connected Mode** does **not** honor
  `sonarlint.analysisExcludesStandalone` or local `.sonarcloud.properties` /
  `sonar-project.properties`. It only applies exclusions synced from the
  SonarCloud project **Administration → General Settings → Analysis Scope →
  Source File Exclusions**. Keep `**/migrations/**` there too (then SonarLint →
  Update binding / reconnect) or IDE will still raise `plsql:*` on drizzle-kit
  SQL.

