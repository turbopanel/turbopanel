#!/usr/bin/env node
/**
 * Metrics boundary check (CI guard).
 *
 * Two invariants for the unsuffixed v6 metrics stack (`src/daemon/metrics/`)
 * and the metrics-contract-facing surfaces that consume it outside that tree:
 *
 *  1. Physical Cloudflare Analytics Engine positional tokens (`double<N>` /
 *     `blob<N>` used as an actual column literal, plus the raw `-1e308`
 *     sentinel value) never appear outside `backends/cloudflare/` — see
 *     `field-map.ts`'s doc comment: "never inline positional literals
 *     elsewhere; always derive columns and write payloads through this
 *     module." Doc-comment prose that merely mentions a slot name for
 *     context (e.g. "double20-equivalent") is not flagged — only code lines
 *     are scanned. Importing the exported `AE_MISSING_METRIC_SENTINEL`
 *     *constant* (rather than inlining its `-1e308` value) is always fine
 *     anywhere — this rule only confines the raw literal and hardcoded
 *     column names, never the symbol.
 *  2. The paged-entity-series "page identity" symbols — blob9's page index
 *     and blob10's comma-joined page identity list, backend-private per
 *     `field-map.ts`'s doc comments (`AE_BLOB_PAGE_INDEX`,
 *     `AE_BLOB_SOURCE_OR_IDENTITY_INDEX`) and the SQL predicate/parser
 *     built from them (`entityIdInPageIdentityPredicate`, exported, and
 *     `splitPageIdentity`, module-private — both `sql-api.ts`) — never
 *     appear as real code outside `backends/cloudflare/`. `splitPageIdentity`
 *     can never actually be imported from outside its own module since it
 *     isn't exported, so that half of the rule only guards against someone
 *     reimplementing a same-named CSV-splitting helper elsewhere rather than
 *     against an import. Scanned across all of `src/` (not just the surfaces
 *     below) because these are unique symbol names with no false-positive
 *     risk, and the leak this rule exists to catch
 *     (`src/daemon/api-routes.test.ts`, see `PAGE_TOKEN_ALLOWLIST` below)
 *     lives well outside those surfaces.
 *
 * Usage:
 *   node scripts/check-metrics-boundaries.mjs
 *   pnpm check:metrics-boundaries
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url))

const SCAN_ROOT = path.join(ROOT, 'src/daemon/metrics')

const EXTRA_SURFACE_DIRS = [path.join(ROOT, 'src/daemon/openapi')]

const EXTRA_SURFACE_FILES = [
  'src/client/openapi/metrics.ts',
  'src/client/openapi/metrics.test.ts',
  'src/client/servers/metrics-routes.ts',
  'src/client/servers/metrics-routes.test.ts',
  'src/client/servers/metrics-routes-helpers.ts',
  'src/client/servers/metrics-routes-helpers.hostfree.test.ts',
  'src/client/servers/server-topology-records.ts',
  'src/client/servers/server-topology-records.test.ts',
  'src/client/servers/topology-inventory.ts',
  'src/client/servers/topology-inventory.test.ts',
  'src/client/servers/topology-slot-mapping.ts',
  'src/client/servers/topology-slot-mapping.test.ts',
  'src/client/servers/topology-types.ts',
].map((p) => path.join(ROOT, p))

const PAGE_TOKEN_ROOT = path.join(ROOT, 'src')

const PAGE_TOKEN_ALLOWLIST = new Set([
  // Daemon end-to-end ingest-route test: asserts on the actual AE row shape
  // (`blobs[...]`) written by CloudflareAnalyticsEngineServerMetricsStore,
  // so it necessarily reaches into the backend-private blob layout directly
  // rather than through a query-side abstraction. Narrow, intentional.
  'src/daemon/api-routes.test.ts',
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
const PAGE_TOKEN_PATTERN =
  /\bAE_BLOB_PAGE_INDEX\b|\bAE_BLOB_SOURCE_OR_IDENTITY_INDEX\b|\bentityIdInPageIdentityPredicate\b|\bsplitPageIdentity\b/

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

const aeTokenCheck = {
  pattern: AE_TOKEN_PATTERN,
  message: (m) => `references AE physical token "${m}" outside backends/cloudflare/`,
}

for (const file of walk(SCAN_ROOT)) {
  if (!file.endsWith('.ts')) continue
  const rel = path.relative(ROOT, file)
  if (rel === SELF) continue
  if (isUnderCloudflareBackend(rel)) continue
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  scanLines(rel, lines, [aeTokenCheck])
}

const extraSurfaceFiles = [
  ...EXTRA_SURFACE_DIRS.flatMap((dir) => [...walk(dir)]),
  ...EXTRA_SURFACE_FILES.filter((f) => fs.existsSync(f)),
]
for (const file of extraSurfaceFiles) {
  if (!file.endsWith('.ts')) continue
  const rel = path.relative(ROOT, file)
  if (rel === SELF) continue
  if (isUnderCloudflareBackend(rel)) continue
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  scanLines(rel, lines, [aeTokenCheck])
}

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
        `references backend-private page-identifier symbol "${m}" outside backends/cloudflare/`,
    },
  ])
}

if (failures.length > 0) {
  console.error('metrics boundary check failed:\n')
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`)
  }
  console.error(
    `\n${failures.length} problem(s) found. AE positional tokens (double<N>/blob<N>/-1e308) ` +
      'must stay confined to src/daemon/metrics/backends/cloudflare/ — always derive columns ' +
      'through field-map.ts. The page-identifier symbols (AE_BLOB_PAGE_INDEX, ' +
      'AE_BLOB_SOURCE_OR_IDENTITY_INDEX, entityIdInPageIdentityPredicate) are backend-private ' +
      'and must stay confined to backends/cloudflare/ as well — see sql-api.ts.'
  )
  process.exit(1)
}

console.log(
  'check-metrics-boundaries: AE physical tokens and page-identifier symbols stay confined to backends/cloudflare/.'
)
