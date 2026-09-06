/**
 * Executing fake Cloudflare Analytics Engine v4 for tests, backed by an
 * in-memory DuckDB table shaped like the real AE dataset (`index1`,
 * `timestamp`, `blob1..blob{AE_V4_BLOB_COUNT}`,
 * `double1..double{AE_V4_DOUBLE_COUNT}`, plus a literal `_sample_interval`
 * column, always `1.0` — every real write in this codebase samples at
 * interval 1, so a constant stands in for AE's approximate-sampling weight).
 *
 * The point of this harness is that tests write through the real
 * `CloudflareAnalyticsEngineServerMetricsStoreV4` write path and read back
 * through the real `queryXViaSqlApiV4` functions (`sql-api-v4.ts`) by
 * literally executing the SQL text those functions generate against this
 * table — never reimplementing their aggregation semantics in TypeScript, so
 * a regression in the query builders can't hide behind a harness that
 * duplicates (and silently drifts from) the same logic.
 *
 * A handful of ClickHouse-flavored SQL identifiers the generated queries use
 * have no DuckDB-native equivalent under the same name; `installAeShimsV4`
 * defines them as DuckDB macros once per connection. `if(cond, a, b)` and
 * string `LIKE`/`CONCAT` are DuckDB built-ins already and need no shim.
 */

import { DuckDBInstance } from '@duckdb/node-api'
import {
  AE_V4_BLOB_COUNT,
  AE_V4_DATASET_NAME,
  AE_V4_DOUBLE_COUNT,
} from '../backends/cloudflare/field-map-v4.ts'
import type { AnalyticsEngineDatasetLike } from '../backends/cloudflare/store-v4.ts'
import type { CloudflareAnalyticsSqlConfig } from '../backends/cloudflare/sql-api-v4.ts'

type FakeAeConnectionLike = {
  run(sql: string, values?: unknown[]): Promise<unknown>
  runAndReadAll(
    sql: string,
    values?: unknown[]
  ): Promise<{ getRowObjectsJS(): Array<Record<string, unknown>> }>
  closeSync(): void
}

type PendingWrite = {
  index1: string
  atMs: number
  blobs: string[]
  doubles: number[]
}

export type FakeAnalyticsEngineV4 = {
  /** Pass to `CloudflareAnalyticsEngineServerMetricsStoreV4`'s constructor. */
  dataset: AnalyticsEngineDatasetLike
  /** Pass as `{ sql: sqlConfig }` to the store, or straight to a `queryXViaSqlApiV4` call. */
  sqlConfig: CloudflareAnalyticsSqlConfig
  /**
   * Sets the ingest timestamp `writeDataPoint` stamps on every write from
   * here on. Real AE assigns `timestamp` server-side at write time (the
   * caller has no control over it); tests need it controllable, so this
   * harness stands in for that clock — call it before each
   * `store.writeSample(...)` / `store.writeStatusEvent(...)` to place the
   * row at a specific instant.
   */
  setNow(atMs: number): void
  close(): Promise<void>
}

async function installAeShimsV4(connection: FakeAeConnectionLike): Promise<void> {
  // Every generated query's `toDateTime(...)` range bound and `timestamp`
  // column must agree on a timezone, or `WHERE timestamp >= toDateTime(...)`
  // silently drops every row whenever the host machine's local timezone
  // isn't UTC.
  await connection.run(`SET TimeZone = 'UTC'`)
  await connection.run(
    `CREATE OR REPLACE MACRO intDiv(a, b) AS (CAST(a AS BIGINT) // CAST(b AS BIGINT))`
  )
  await connection.run(`CREATE OR REPLACE MACRO toUnixTimestamp(ts) AS epoch(ts)`)
  await connection.run(
    `CREATE OR REPLACE MACRO toDateTime(x) AS CAST(to_timestamp(x) AS TIMESTAMP)`
  )
  await connection.run(`CREATE OR REPLACE MACRO argMax(val, ord) AS arg_max(val, ord)`)
}

/** JSON can't serialize BigInt (DuckDB returns BIGINT-typed expressions, e.g. `intDiv`, as JS `bigint`) — normalize recursively before enveloping a query result. */
function normalizeForJsonV4(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(normalizeForJsonV4)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeForJsonV4(inner)
    }
    return out
  }
  return value
}

// Values are inlined as SQL literals rather than bound via `?` --
// `@duckdb/node-api`'s parameter binder infers BIGINT for any
// integer-valued JS `number` (including the AE v4 missing-metric sentinel
// `-1e308`, which is integer-valued) and overflows converting it to
// `BigInt`. Every value here is either a controlled string (escaped) or a
// finite double we format ourselves, so literal interpolation is safe.
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function doubleLiteral(value: number): string {
  if (!Number.isFinite(value)) return 'NULL'
  return value.toString()
}

export async function createFakeAnalyticsEngineV4(options?: {
  dataset?: string
}): Promise<FakeAnalyticsEngineV4> {
  const datasetName = options?.dataset ?? AE_V4_DATASET_NAME
  const instance = await DuckDBInstance.create(':memory:')
  const connection = (await instance.connect()) as unknown as FakeAeConnectionLike
  await installAeShimsV4(connection)

  const blobColumns = Array.from({ length: AE_V4_BLOB_COUNT }, (_, i) => `blob${i + 1} VARCHAR`)
  const doubleColumns = Array.from(
    { length: AE_V4_DOUBLE_COUNT },
    (_, i) => `double${i + 1} DOUBLE`
  )
  await connection.run(
    `CREATE TABLE ${datasetName} (` +
      `index1 VARCHAR, "timestamp" TIMESTAMP, _sample_interval DOUBLE, ` +
      `${blobColumns.join(', ')}, ${doubleColumns.join(', ')})`
  )

  let nowMs = Date.now()
  let pending: PendingWrite[] = []

  const dataset: AnalyticsEngineDatasetLike = {
    writeDataPoint(event) {
      const doubles = new Array<number>(AE_V4_DOUBLE_COUNT).fill(0)
      ;(event.doubles ?? []).forEach((value, i) => {
        if (i < AE_V4_DOUBLE_COUNT) doubles[i] = value
      })
      const blobs = new Array<string>(AE_V4_BLOB_COUNT).fill('')
      ;(event.blobs ?? []).forEach((value, i) => {
        if (i < AE_V4_BLOB_COUNT) blobs[i] = value
      })
      pending.push({
        index1: event.indexes?.[0] ?? '',
        atMs: nowMs,
        blobs,
        doubles,
      })
    },
  }

  async function flush(): Promise<void> {
    if (pending.length === 0) return
    const rows = pending
    pending = []
    const columns = [
      'index1',
      `"timestamp"`,
      '_sample_interval',
      ...Array.from({ length: AE_V4_BLOB_COUNT }, (_, i) => `blob${i + 1}`),
      ...Array.from({ length: AE_V4_DOUBLE_COUNT }, (_, i) => `double${i + 1}`),
    ]
    const tuples = rows.map((row) => {
      const values = [
        quoteLiteral(row.index1),
        quoteLiteral(new Date(row.atMs).toISOString().replace('T', ' ').replace('Z', '')),
        '1.0',
        ...row.blobs.map(quoteLiteral),
        ...row.doubles.map(doubleLiteral),
      ]
      return `(${values.join(', ')})`
    })
    const sql = `INSERT INTO ${datasetName} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`
    await connection.run(sql)
  }

  const fakeFetch: typeof fetch = async (_input, init) => {
    await flush()
    const sql = typeof init?.body === 'string' ? init.body : ''
    try {
      const reader = await connection.runAndReadAll(sql)
      const data = reader.getRowObjectsJS().map((row) => normalizeForJsonV4(row)) as Array<
        Record<string, unknown>
      >
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { data, meta: [], rows: data.length },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    } catch (error) {
      return new Response(
        JSON.stringify({
          success: false,
          errors: [
            {
              message: error instanceof Error ? error.message : String(error),
            },
          ],
          messages: [],
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    }
  }

  const sqlConfig: CloudflareAnalyticsSqlConfig = {
    accountId: 'fake-account',
    apiToken: 'fake-token',
    dataset: datasetName,
    fetch: fakeFetch,
  }

  return {
    dataset,
    sqlConfig,
    setNow(atMs: number) {
      nowMs = atMs
    },
    async close() {
      connection.closeSync()
      instance.closeSync()
    },
  }
}
