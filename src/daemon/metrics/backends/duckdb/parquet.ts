/**
 * Daily Parquet archive for the DuckDB server-metrics store — v4 seals every
 * family table (`PARQUET_FAMILIES`) independently, each into its own
 * partition subtree:
 *
 *   <parquetRoot>/<family.subdir>/year=YYYY/month=MM/day=DD/metrics.parquet
 *
 * Sealing is crash-safe, per family: export to a tmp file, validate the row
 * count by re-reading the produced Parquet, atomically rename into the
 * partition tree, and only then delete that family's hot rows. A crash at
 * any point leaves either the hot rows intact (tmp leftovers are swept on
 * the next tick) or a complete sealed partition — never a half-archived day.
 * Resealing a day that already has a partition (late-arriving samples)
 * merges the existing sealed rows with the new hot rows, so archiving stays
 * idempotent and one-file-per-day, independently for each family.
 *
 * `server_status_events` is not one of `PARQUET_FAMILIES` — connection-status
 * history has never been sealed to Parquet (unchanged from v3); retention
 * still prunes its old hot rows directly.
 */

import type { DuckDbConnectionLike } from './database.ts'
import { escapeSqlString } from './database.ts'
import {
  BLOCK_SAMPLES_TABLE,
  CPU_CORE_SAMPLES_TABLE,
  CPU_HOTSPOT_SAMPLES_TABLE,
  DATABASE_PROXY_SAMPLES_TABLE,
  FILESYSTEM_SAMPLES_TABLE,
  GPU_SAMPLES_TABLE,
  HARDWARE_SIGNAL_SAMPLES_TABLE,
  HOST_SAMPLES_TABLE,
  INGRESS_SAMPLES_TABLE,
  MEMORY_DETAIL_SAMPLES_TABLE,
  METRIC_EVENTS_TABLE,
  NETWORK_SAMPLES_TABLE,
  STATUS_EVENTS_TABLE,
} from './schema.ts'

export const MS_PER_DAY = 24 * 60 * 60 * 1000

/** File name of each sealed daily partition, under every family's subdir. */
export const PARQUET_PARTITION_FILE = 'metrics.parquet'

export type ParquetFamilyKey =
  | 'host'
  | 'network'
  | 'filesystem'
  | 'block'
  | 'gpu'
  | 'cpu-hotspot'
  | 'cpu-core-live'
  | 'memory-detail'
  | 'hardware'
  | 'ingress'
  | 'database-proxy'
  | 'events'

export type ParquetFamily = {
  key: ParquetFamilyKey
  /** Hot table this family seals out of / prunes from. */
  table: string
  /** Partition subtree under the parquet root (`<parquetRoot>/<subdir>/year=.../...`). */
  subdir: string
  /** SQL-ready column reference for this family's sample timestamp — pre-quoted when the column needs it (e.g. `"at"`). */
  timestampColumn: string
}

/** Every sealable family table, in no particular order — `pruneExpiredPartitions` and the daily archive job iterate all of them. */
export const PARQUET_FAMILIES: readonly ParquetFamily[] = [
  {
    key: 'host',
    table: HOST_SAMPLES_TABLE,
    subdir: 'host',
    timestampColumn: 'sampled_at',
  },
  {
    key: 'network',
    table: NETWORK_SAMPLES_TABLE,
    subdir: 'network',
    timestampColumn: 'sampled_at',
  },
  {
    key: 'filesystem',
    table: FILESYSTEM_SAMPLES_TABLE,
    subdir: 'filesystem',
    timestampColumn: 'sampled_at',
  },
  {
    key: 'block',
    table: BLOCK_SAMPLES_TABLE,
    subdir: 'block',
    timestampColumn: 'sampled_at',
  },
  {
    key: 'gpu',
    table: GPU_SAMPLES_TABLE,
    subdir: 'gpu',
    timestampColumn: 'sampled_at',
  },
  {
    key: 'cpu-hotspot',
    table: CPU_HOTSPOT_SAMPLES_TABLE,
    subdir: 'cpu-hotspot',
    timestampColumn: 'sampled_at',
  },
  {
    key: 'cpu-core-live',
    table: CPU_CORE_SAMPLES_TABLE,
    subdir: 'cpu-core-live',
    timestampColumn: 'sampled_at',
  },
  {
    key: 'memory-detail',
    table: MEMORY_DETAIL_SAMPLES_TABLE,
    subdir: 'memory-detail',
    timestampColumn: 'sampled_at',
  },
  {
    key: 'hardware',
    table: HARDWARE_SIGNAL_SAMPLES_TABLE,
    subdir: 'hardware',
    timestampColumn: 'sampled_at',
  },
  {
    key: 'ingress',
    table: INGRESS_SAMPLES_TABLE,
    subdir: 'ingress',
    timestampColumn: 'sampled_at',
  },
  {
    key: 'database-proxy',
    table: DATABASE_PROXY_SAMPLES_TABLE,
    subdir: 'database-proxy',
    timestampColumn: 'sampled_at',
  },
  {
    key: 'events',
    table: METRIC_EVENTS_TABLE,
    subdir: 'events',
    timestampColumn: `"at"`,
  },
]

/** Look up a family descriptor by key — throws on an unknown key (never a silent no-op). */
export function parquetFamily(key: ParquetFamilyKey): ParquetFamily {
  const family = PARQUET_FAMILIES.find((candidate) => candidate.key === key)
  if (!family) throw new TypeError(`unknown parquet family: ${key}`)
  return family
}

/** Floor an epoch-ms instant to its UTC day start. */
export function utcDayStartMs(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY
}

function assertSafeEpochMs(label: string, ms: number): number {
  if (!Number.isSafeInteger(ms)) {
    throw new TypeError(`${label} must be a safe integer epoch-ms value`)
  }
  return ms
}

/** `TIMESTAMP '...'` literal (UTC) for a validated epoch-ms instant. */
export function timestampLiteralFromMs(ms: number): string {
  assertSafeEpochMs('timestamp', ms)
  const iso = new Date(ms).toISOString()
  return `TIMESTAMP '${iso.replace('T', ' ').replace('Z', '')}'`
}

function dayParts(dayStartMs: number): { year: string; month: string; day: string } {
  const date = new Date(dayStartMs)
  return {
    year: String(date.getUTCFullYear()).padStart(4, '0'),
    month: String(date.getUTCMonth() + 1).padStart(2, '0'),
    day: String(date.getUTCDate()).padStart(2, '0'),
  }
}

/** Directory of a family's sealed partition for a UTC day start. */
export function partitionDirForDay(
  parquetRoot: string,
  subdir: string,
  dayStartMs: number
): string {
  const { year, month, day } = dayParts(utcDayStartMs(dayStartMs))
  return `${parquetRoot}/${subdir}/year=${year}/month=${month}/day=${day}`
}

/** Sealed partition file path for a family's UTC day start. */
export function partitionFileForDay(
  parquetRoot: string,
  subdir: string,
  dayStartMs: number
): string {
  return `${partitionDirForDay(parquetRoot, subdir, dayStartMs)}/${PARQUET_PARTITION_FILE}`
}

export type SealDayInput = {
  family: ParquetFamily
  dayStartMs: number
  dayEndMs: number
  parquetRoot: string
  tmpDir: string
}

export type SealDayResult = {
  /** Rows sealed out of the hot table (0 = nothing to archive, no file written). */
  rowCount: number
  /** Final partition file path, or null when the day held no rows. */
  parquetPath: string | null
}

async function countRows(connection: DuckDbConnectionLike, sql: string): Promise<number> {
  const reader = await connection.runAndReadAll(sql)
  const row = reader.getRowObjectsJS()[0]
  return Number(row?.n ?? 0)
}

/** Sidecar recording an installed-but-not-yet-deleted seal — see {@link sealDayToParquet}. */
function pendingDeleteMarkerPath(finalPath: string): string {
  return `${finalPath}.pending-delete`
}

type PendingDeleteMarker = { rowCount: number; expectedCount: number }

function parsePendingDeleteMarker(text: string): PendingDeleteMarker | null {
  try {
    const parsed = JSON.parse(text)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Number.isSafeInteger(parsed.rowCount) &&
      Number.isSafeInteger(parsed.expectedCount)
    ) {
      return { rowCount: parsed.rowCount, expectedCount: parsed.expectedCount }
    }
  } catch {
    // Corrupt marker — fall through to null (treated as no valid recovery).
  }
  return null
}

/**
 * Resume a seal that crashed after {@link Deno.rename} installed the
 * partition but before the hot-row delete ran — the marker only proves the
 * install happened once the partition's row count matches what it recorded;
 * otherwise it's a leftover from a crash *before* the rename and is
 * discarded so the normal seal path below runs from scratch.
 */
async function recoverPendingDelete(
  connection: DuckDbConnectionLike,
  opts: {
    markerPath: string
    finalPath: string
    table: string
    windowPredicate: string
  }
): Promise<SealDayResult | null> {
  let markerText: string
  try {
    markerText = await Deno.readTextFile(opts.markerPath)
  } catch {
    return null
  }
  const marker = parsePendingDeleteMarker(markerText)
  const finalCount =
    marker === null
      ? null
      : await countRows(
          connection,
          `SELECT count(*) AS n FROM read_parquet('${escapeSqlString(opts.finalPath)}')`
        ).catch(() => null)

  if (marker !== null && finalCount === marker.expectedCount) {
    // The rename completed; only the hot-row delete never ran.
    await connection.run(`DELETE FROM ${opts.table} WHERE ${opts.windowPredicate}`)
    await Deno.remove(opts.markerPath).catch(() => {})
    return { rowCount: marker.rowCount, parquetPath: opts.finalPath }
  }
  await Deno.remove(opts.markerPath).catch(() => {})
  return null
}

/**
 * Seal one UTC day of one family's hot rows into an immutable Parquet
 * partition.
 *
 * Hot rows are deleted only after the exported file has been validated and
 * atomically renamed into place; a validation mismatch removes the tmp file
 * and throws, leaving the hot table untouched. A crash between the rename
 * and the delete leaves a `.pending-delete` marker next to the partition
 * (written just before the rename, removed just after the delete) so the
 * next call resumes the outstanding delete instead of re-exporting the
 * already-installed rows a second time — {@link recoverPendingDelete}.
 *
 * When the day already has a sealed partition for this family (a late sample
 * arrived after the first seal), the replacement file is rebuilt from the
 * union of the existing partition and the day's hot rows — resealing is
 * idempotent and never drops previously archived rows.
 */
export async function sealDayToParquet(
  connection: DuckDbConnectionLike,
  input: SealDayInput
): Promise<SealDayResult> {
  assertSafeEpochMs('dayStartMs', input.dayStartMs)
  assertSafeEpochMs('dayEndMs', input.dayEndMs)
  if (input.dayEndMs <= input.dayStartMs) {
    throw new TypeError('dayEndMs must be > dayStartMs')
  }
  const { table, subdir, timestampColumn } = input.family
  const windowPredicate =
    `${timestampColumn} >= ${timestampLiteralFromMs(input.dayStartMs)}` +
    ` AND ${timestampColumn} < ${timestampLiteralFromMs(input.dayEndMs)}`
  const finalPath = partitionFileForDay(input.parquetRoot, subdir, input.dayStartMs)
  const markerPath = pendingDeleteMarkerPath(finalPath)

  const recovered = await recoverPendingDelete(connection, {
    markerPath,
    finalPath,
    table,
    windowPredicate,
  })
  if (recovered !== null) return recovered

  const rowCount = await countRows(
    connection,
    `SELECT count(*) AS n FROM ${table} WHERE ${windowPredicate}`
  )
  if (rowCount === 0) {
    return { rowCount: 0, parquetPath: null }
  }

  let hasExistingPartition = false
  try {
    hasExistingPartition = (await Deno.stat(finalPath)).isFile
  } catch {
    // No sealed partition yet — first seal for this day.
  }
  const existingCount = hasExistingPartition
    ? await countRows(
        connection,
        `SELECT count(*) AS n FROM read_parquet('${escapeSqlString(finalPath)}')`
      )
    : 0

  const { year, month, day } = dayParts(utcDayStartMs(input.dayStartMs))
  const tmpPath = `${input.tmpDir}/${subdir}-${year}${month}${day}-${crypto.randomUUID()}.parquet`
  const hotSelect = `SELECT * FROM ${table} WHERE ${windowPredicate}`
  const exportSelect = hasExistingPartition
    ? `SELECT * FROM (${hotSelect} UNION ALL BY NAME ` +
      `SELECT * FROM read_parquet('${escapeSqlString(finalPath)}'))` +
      ` ORDER BY server_id, ${timestampColumn}`
    : `${hotSelect} ORDER BY server_id, ${timestampColumn}`
  await connection.run(`COPY (${exportSelect}) TO '${escapeSqlString(tmpPath)}' (FORMAT PARQUET)`)

  const expectedCount = rowCount + existingCount
  const exportedCount = await countRows(
    connection,
    `SELECT count(*) AS n FROM read_parquet('${escapeSqlString(tmpPath)}')`
  )
  if (exportedCount !== expectedCount) {
    await Deno.remove(tmpPath).catch(() => {})
    throw new Error(
      `parquet seal validation failed: exported ${exportedCount} rows, expected ${expectedCount}`
    )
  }

  await Deno.mkdir(partitionDirForDay(input.parquetRoot, subdir, input.dayStartMs), {
    recursive: true,
  })
  // Written before the rename so a crash right after it can prove (via
  // `finalPath`'s row count) whether the rename below actually completed.
  await Deno.writeTextFile(markerPath, JSON.stringify({ rowCount, expectedCount }))
  // Atomic replace — overwrites the previous partition file when resealing.
  await Deno.rename(tmpPath, finalPath)

  await connection.run(`DELETE FROM ${table} WHERE ${windowPredicate}`)
  await Deno.remove(markerPath).catch(() => {})
  return { rowCount, parquetPath: finalPath }
}

/**
 * Sweep leftover in-flight exports (`<tmpDir>/*.parquet`) from a crashed or
 * interrupted seal — an interrupted export must never be mistaken for a
 * sealed partition, and its hot rows are still in the hot table. Shared
 * across every family: all families export into the same tmp directory.
 */
export async function cleanupTmpParquetFiles(tmpDir: string): Promise<void> {
  let entries: AsyncIterable<Deno.DirEntry>
  try {
    entries = Deno.readDir(tmpDir)
  } catch {
    return
  }
  try {
    for await (const entry of entries) {
      if (entry.isFile && entry.name.endsWith('.parquet')) {
        await Deno.remove(`${tmpDir}/${entry.name}`).catch(() => {})
      }
    }
  } catch {
    // Missing/racing directory — nothing to clean.
  }
}

type PartitionDay = { dayStartMs: number; dir: string; file: string }

async function readDirSafe(path: string): Promise<Deno.DirEntry[]> {
  const out: Deno.DirEntry[] = []
  try {
    for await (const entry of Deno.readDir(path)) out.push(entry)
  } catch {
    return []
  }
  return out
}

function parsePartitionComponent(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix)) return null
  const value = Number(name.slice(prefix.length))
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** Subdirectories of `dir` named `<prefix><non-negative integer>`. */
async function listNumericSubdirs(
  dir: string,
  prefix: string
): Promise<{ value: number; path: string }[]> {
  const out: { value: number; path: string }[] = []
  for (const entry of await readDirSafe(dir)) {
    if (!entry.isDirectory) continue
    const value = parsePartitionComponent(entry.name, prefix)
    if (value === null) continue
    out.push({ value, path: `${dir}/${entry.name}` })
  }
  return out
}

/** The day's partition, or null when its parquet file is missing (unsealed). */
async function sealedPartitionDay(
  year: number,
  month: number,
  day: number,
  dir: string
): Promise<PartitionDay | null> {
  const file = `${dir}/${PARQUET_PARTITION_FILE}`
  try {
    const stat = await Deno.stat(file)
    if (!stat.isFile) return null
  } catch {
    return null
  }
  return { dayStartMs: Date.UTC(year, month - 1, day), dir, file }
}

/** Enumerate all sealed day partitions under one family's subdir, sorted by day. */
export async function listPartitionDays(
  parquetRoot: string,
  subdir: string
): Promise<PartitionDay[]> {
  const base = `${parquetRoot}/${subdir}`
  const days: PartitionDay[] = []
  for (const year of await listNumericSubdirs(base, 'year=')) {
    for (const month of await listNumericSubdirs(year.path, 'month=')) {
      for (const day of await listNumericSubdirs(month.path, 'day=')) {
        const partition = await sealedPartitionDay(year.value, month.value, day.value, day.path)
        if (partition) days.push(partition)
      }
    }
  }
  days.sort((a, b) => a.dayStartMs - b.dayStartMs)
  return days
}

/**
 * Sealed partition files (one family's subdir) whose UTC day overlaps the
 * half-open `[fromMs, toMs)` range, sorted by day — a future query layer
 * unions these with that family's hot table via
 * `read_parquet([...], union_by_name := true)`.
 */
export async function listPartitionFilesInRange(
  parquetRoot: string,
  subdir: string,
  fromMs: number,
  toMs: number
): Promise<string[]> {
  const days = await listPartitionDays(parquetRoot, subdir)
  return days
    .filter((day) => day.dayStartMs < toMs && day.dayStartMs + MS_PER_DAY > fromMs)
    .map((day) => day.file)
}

export type PruneExpiredPartitionsInput = {
  retentionDays: number
  parquetRoot: string
  nowMs?: number
}

/**
 * Delete sealed partitions and hot rows older than the retention cutoff, for
 * every family in {@link PARQUET_FAMILIES} plus `server_status_events` (never
 * sealed to Parquet, but still subject to hot-row retention).
 *
 * The hot-table delete is defense-in-depth: normally the daily archive job
 * seals every completed day, but if it missed one, retention still holds.
 */
export async function pruneExpiredPartitions(
  connection: DuckDbConnectionLike,
  input: PruneExpiredPartitionsInput
): Promise<void> {
  if (!Number.isInteger(input.retentionDays) || input.retentionDays <= 0) {
    throw new TypeError('retentionDays must be a positive integer')
  }
  const nowMs = input.nowMs ?? Date.now()
  const cutoffMs = utcDayStartMs(nowMs) - input.retentionDays * MS_PER_DAY
  const cutoffLiteral = timestampLiteralFromMs(cutoffMs)

  for (const family of PARQUET_FAMILIES) {
    for (const day of await listPartitionDays(input.parquetRoot, family.subdir)) {
      if (day.dayStartMs + MS_PER_DAY <= cutoffMs) {
        await Deno.remove(day.dir, { recursive: true }).catch(() => {})
      }
    }
    await connection.run(
      `DELETE FROM ${family.table} WHERE ${family.timestampColumn} < ${cutoffLiteral}`
    )
  }

  await connection.run(`DELETE FROM ${STATUS_EVENTS_TABLE} WHERE "at" < ${cutoffLiteral}`)
}
