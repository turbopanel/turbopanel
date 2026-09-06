#!/usr/bin/env node
/**
 * v4 metrics boundary check (CI guard).
 *
 * Three invariants for the v4 metrics stack (`src/daemon/metrics/`) and the
 * metrics-contract-facing surfaces that consume it outside that tree:
 *
 *  1. Physical Cloudflare Analytics Engine v4 positional tokens
 *     (`double<N>` / `blob<N>` used as an actual column literal, plus the
 *     raw `-1e308` sentinel value) never appear outside
 *     `backends/cloudflare/` — see `field-map-v4.ts`'s doc comment: "never
 *     inline positional literals elsewhere; always derive columns and write
 *     payloads through this module." Doc-comment prose that merely mentions
 *     a slot name for context (e.g. "double20-equivalent") is not flagged —
 *     only code lines are scanned. Importing the exported
 *     `AE_V4_MISSING_METRIC_SENTINEL` *constant* (rather than inlining its
 *     `-1e308` value) is always fine anywhere — this rule only confines the
 *     raw literal and hardcoded column names, never the symbol. Checked
 *     across all scan surfaces below (none of them are ever legitimately
 *     under `backends/cloudflare/` except the metrics tree itself).
 *  2. v3-only symbols (`MetricPart`, `HOST_METRIC_KEYS`, and the v3 wire
 *     field `parts` — `sample.parts` / `parts:` / `parts?:`, anchored to
 *     property-access and field-declaration shapes so the bare English word
 *     "parts" elsewhere doesn't false-positive) never appear as real code
 *     anywhere under `src/daemon/metrics/`, nor in any metrics-contract
 *     surface outside the metrics backend itself (`EXTRA_SURFACE_DIRS` /
 *     `EXTRA_SURFACE_FILES` below) — the v3 contract (`contract.ts`,
 *     `validation.ts`, `metric-descriptors.ts`, `disabled-store.ts`, the
 *     Cloudflare v3 backend) has been fully deleted; nothing left legitimately
 *     uses these symbols. `V3_SYMBOL_IN_V4_FILE_ALLOWLIST` narrowly exempts
 *     specific fixture files that deliberately construct a retired v3 wire
 *     shape to assert a v4 validator rejects it.
 *     Doc-comment prose contrasting v4 with v3 (e.g. "v4 drops v3's
 *     `MetricPart` allowlist") is not flagged.
 *  3. The v4 paged-entity-series "page identity" symbols — blob9's page
 *     index and blob10's comma-joined page identity list, backend-private
 *     per `field-map-v4.ts`'s doc comments (`AE_V4_BLOB_PAGE_INDEX`,
 *     `AE_V4_BLOB_SOURCE_OR_IDENTITY_INDEX`) and the SQL predicate/parser
 *     built from them (`entityIdInPageIdentityPredicateV4`, exported, and
 *     `splitPageIdentityV4`, module-private — both `sql-api-v4.ts`) — never
 *     appear as real code outside `backends/cloudflare/`. `splitPageIdentityV4`
 *     can never actually be imported from outside its own module since it
 *     isn't exported, so that half of the rule only guards against someone
 *     reimplementing a same-named CSV-splitting helper elsewhere rather than
 *     against an import. Scanned across all of `src/` (not just the surfaces
 *     in invariant 2) because these are unique symbol names with no
 *     false-positive risk, and the leak this rule exists to catch
 *     (`src/daemon/api-routes.test.ts`, see `PAGE_TOKEN_ALLOWLIST` below)
 *     lives well outside those surfaces.
 *
 * Usage:
 *   node scripts/check-v4-boundaries.mjs
 *   pnpm check:v4-boundaries
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url))

const SCAN_ROOT = path.join(ROOT, 'src/daemon/metrics')

// Metrics-contract-facing surfaces outside the metrics backend itself that
// must stay just as backend-agnostic as v4-suffixed files inside it. Kept as
// an explicit directory list (not "all of src/daemon" or "all of
// src/client") because `src/daemon/openapi/` is inherently API-contract
// shaped in full, while `src/client` is not — scanning all of `src/client`
// would make the `parts` regex fire on unrelated, unrelated-to-metrics code.
const EXTRA_SURFACE_DIRS = [path.join(ROOT, 'src/daemon/openapi')]

// Individual metrics-facing files living in otherwise-unrelated directories.
// `src/client` is deliberately NOT scanned wholesale for the same reason as
// above — these are the specific metrics-contract files within it.
const EXTRA_SURFACE_FILES = [
  'src/client/openapi/metrics.ts',
  'src/client/openapi/metrics.test.ts',
  'src/client/servers/metrics-routes.ts',
  'src/client/servers/metrics-routes.test.ts',
  'src/client/servers/metrics-routes-helpers.ts',
  'src/client/servers/metrics-routes-helpers.hostfree.test.ts',
  // Topology/SlotMapping records: `field-map-v4.ts` derives its
  // identity-addressed page ordering (`gpuPageOrder` / `blockPageOrder` /
  // `filesystemPageOrder` / `hardwareSignalPageOrder`) from these, so they
  // sit right next to the backend-private paging concept even though they
  // are themselves backend-neutral (`SlotMapping` is computed once by the
  // ingest route and handed to whichever backend is active).
  'src/client/servers/server-topology-records.ts',
  'src/client/servers/server-topology-records.test.ts',
  'src/client/servers/topology-inventory.ts',
  'src/client/servers/topology-inventory.test.ts',
  'src/client/servers/topology-slot-mapping.ts',
  'src/client/servers/topology-slot-mapping.test.ts',
  'src/client/servers/topology-types.ts',
].map((p) => path.join(ROOT, p))

// Root for the page-identifier scan (invariant 3) — the whole `src/` tree,
// since those symbol names are unique enough to carry no false-positive
// risk, and the one real leak found for this rule sits outside every
// surface list above.
const PAGE_TOKEN_ROOT = path.join(ROOT, 'src')

// Exact repo-relative paths permitted to reference the page-identifier
// symbols outside backends/cloudflare/.
const PAGE_TOKEN_ALLOWLIST = new Set([
  // Daemon end-to-end ingest-route test: asserts on the actual AE row shape
  // (`blobs[...]`) written by CloudflareAnalyticsEngineServerMetricsStoreV4,
  // so it necessarily reaches into the backend-private blob layout directly
  // rather than through a query-side abstraction. Narrow, intentional.
  'src/daemon/api-routes.test.ts',
])

// Exact repo-relative paths permitted to reference v3 symbols inside a
// v4-suffixed file.
const V3_SYMBOL_IN_V4_FILE_ALLOWLIST = new Set([
  // Both construct a `legacyV3Raw()` fixture (a retired v3 wire shape,
  // `parts: [...]` included) specifically to assert that the v4 validator
  // *rejects* it — the v3 shape is the fixture under test, not a real v4
  // dependency on v3's `parts` model.
  'src/daemon/metrics/validation-v4.test.ts',
  'src/daemon/metrics/validation-v4.deno.test.ts',
])

const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', 'dist', 'coverage', '.wrangler', '.turbo'])

function isCommentLine(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      yield* walk(abs)
    } else if (entry.isFile()) {
      yield abs
    }
  }
}

const AE_TOKEN_PATTERN = /(["'`])(double|blob)\d{1,2}\1|\.(double|blob)\d{1,2}\b|-1e308/
const V3_SYMBOL_PATTERN = /\bMetricPart\b|\bHOST_METRIC_KEYS\b|\.parts\b|\bparts\??\s*:/
const PAGE_TOKEN_PATTERN =
  /\bAE_V4_BLOB_PAGE_INDEX\b|\bAE_V4_BLOB_SOURCE_OR_IDENTITY_INDEX\b|\bentityIdInPageIdentityPredicateV4\b|\bsplitPageIdentityV4\b/

function isUnderCloudflareBackend(rel) {
  return rel.includes('backends/cloudflare/')
}

function scanLines(rel, lines, checks) {
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return
    for (const check of checks) {
      const match = check.pattern.exec(line)
      if (match) {
        failures.push(`${rel}:${i + 1} ${check.message(match[0])}`)
      }
    }
  })
}

const failures = []

// --- Invariants 1 & 2 within the metrics backend tree itself -------------
for (const file of walk(SCAN_ROOT)) {
  if (!file.endsWith('.ts')) continue
  const rel = path.relative(ROOT, file)
  if (rel === SELF) continue
  const scanForAeTokens = !isUnderCloudflareBackend(rel)
  const scanForV3Symbols = !V3_SYMBOL_IN_V4_FILE_ALLOWLIST.has(rel)
  if (!scanForAeTokens && !scanForV3Symbols) continue

  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const checks = []
  if (scanForAeTokens) {
    checks.push({
      pattern: AE_TOKEN_PATTERN,
      message: (m) => `references AE v4 physical token "${m}" outside backends/cloudflare/`,
    })
  }
  if (scanForV3Symbols) {
    checks.push({
      pattern: V3_SYMBOL_PATTERN,
      message: (m) => `references retired v3 symbol "${m}"`,
    })
  }
  scanLines(rel, lines, checks)
}

// --- Invariants 1 & 2 on the extra metrics-contract surfaces --------------
const extraSurfaceFiles = [
  ...EXTRA_SURFACE_DIRS.flatMap((dir) => [...walk(dir)]),
  ...EXTRA_SURFACE_FILES.filter((f) => fs.existsSync(f)),
]
for (const file of extraSurfaceFiles) {
  if (!file.endsWith('.ts')) continue
  const rel = path.relative(ROOT, file)
  if (rel === SELF) continue
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  scanLines(rel, lines, [
    {
      pattern: AE_TOKEN_PATTERN,
      message: (m) => `references AE v4 physical token "${m}" outside backends/cloudflare/`,
    },
    {
      pattern: V3_SYMBOL_PATTERN,
      message: (m) =>
        `references v3 symbol "${m}" in a metrics-contract surface that must stay backend-agnostic`,
    },
  ])
}

// --- Invariant 3: page-identifier symbols, everywhere except cloudflare ---
for (const file of walk(PAGE_TOKEN_ROOT)) {
  if (!file.endsWith('.ts')) continue
  const rel = path.relative(ROOT, file)
  if (rel === SELF) continue
  if (isUnderCloudflareBackend(rel)) continue
  if (PAGE_TOKEN_ALLOWLIST.has(rel)) continue
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  scanLines(rel, lines, [
    {
      pattern: PAGE_TOKEN_PATTERN,
      message: (m) =>
        `references backend-private v4 page-identifier symbol "${m}" outside backends/cloudflare/`,
    },
  ])
}

if (failures.length > 0) {
  console.error('v4 metrics boundary check failed:\n')
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`)
  }
  console.error(
    `\n${failures.length} problem(s) found. AE v4 positional tokens (double<N>/blob<N>/-1e308) ` +
      'must stay confined to src/daemon/metrics/backends/cloudflare/ — always derive columns ' +
      'through field-map-v4.ts. The metrics backend and metrics-contract surfaces outside it ' +
      'must never reference v3-only symbols (MetricPart, HOST_METRIC_KEYS, ' +
      'the v3 `parts` field) as real code — the v3 contract was fully removed; see ' +
      'field-map-v4.ts / contract-v4.ts. The v4 page-' +
      'identifier symbols (AE_V4_BLOB_PAGE_INDEX, AE_V4_BLOB_SOURCE_OR_IDENTITY_INDEX, ' +
      'entityIdInPageIdentityPredicateV4) are backend-private and must stay confined to ' +
      'backends/cloudflare/ as well — see sql-api-v4.ts.'
  )
  process.exit(1)
}

console.log(
  'check-v4-boundaries: AE v4 physical tokens and page-identifier symbols stay confined, ' +
    'and v4-only files / metrics-contract surfaces stay v3-free.'
)
