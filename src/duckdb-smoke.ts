/**
 * `duckdb-smoke` subcommand of the production instance entry ({@link ./deno.ts})
 * — the in-binary half of `deno task duckdb:smoke`
 * (scripts/duckdb-compile-smoke.ts). Running it through the real compiled
 * artifact (`deno task compile` → `dist/turbopanel-instance`) proves the
 * `@duckdb/node-api` native addon survives TurboPanel's actual build and
 * permission shape, against the real v5 metrics schema (not a throwaway
 * `smoke` table) before the metrics-store write path is wired up. Modes:
 *
 *   write   — create/open `<metricsDir>/smoke.duckdb`, run the real v5 DDL,
 *             insert one `server_host_samples` row and one
 *             `server_network_samples` row
 *   verify  — fresh process: assert both rows persisted (restart durability)
 *   parquet — `COPY (SELECT * FROM server_host_samples) TO (FORMAT PARQUET)`
 *             and read the file back
 */
import { DuckDBInstance } from '@duckdb/node-api'
import { resolveMetricsDir } from './server-paths.ts'
import {
  buildSchemaStatements,
  HOST_SAMPLES_TABLE,
  NETWORK_SAMPLES_TABLE,
} from './daemon/metrics/backends/duckdb/schema.ts'

const SMOKE_SERVER_ID = '11111111-2222-4333-8444-555555555555'

export async function runDuckdbSmoke(mode: string): Promise<void> {
  const metricsDir = resolveMetricsDir()
  await Deno.mkdir(metricsDir, { recursive: true })
  const dbPath = `${metricsDir}/smoke.duckdb`
  const parquetPath = `${metricsDir}/smoke-export.parquet`

  const instance = await DuckDBInstance.create(dbPath)
  const connection = await instance.connect()

  try {
    for (const statement of buildSchemaStatements()) {
      await connection.run(statement)
    }

    switch (mode) {
      case 'write': {
        await connection.run(
          `INSERT INTO ${HOST_SAMPLES_TABLE} ` +
            `(server_id, sampled_at, received_at, interval_seconds, ` +
            `sequence, topology_generation, boot_generation, cpu_busy_percent) ` +
            `VALUES (CAST('${SMOKE_SERVER_ID}' AS UUID), now(), now(), 60, 1, 1, 1, 42.0)`
        )
        await connection.run(
          `INSERT INTO ${NETWORK_SAMPLES_TABLE} ` +
            `(server_id, sampled_at, received_at, interval_seconds, ` +
            `sequence, topology_generation, boot_generation, device_id, receive_bytes_per_second) ` +
            `VALUES (CAST('${SMOKE_SERVER_ID}' AS UUID), now(), now(), 60, 1, 1, 1, 'eth0', 1000.0)`
        )
        const hostReader = await connection.runAndReadAll(
          `SELECT count(*) AS n FROM ${HOST_SAMPLES_TABLE}`
        )
        const networkReader = await connection.runAndReadAll(
          `SELECT count(*) AS n FROM ${NETWORK_SAMPLES_TABLE}`
        )
        console.log(
          `smoke:write host_rows=${hostReader.getRows()[0][0]} network_rows=${
            networkReader.getRows()[0][0]
          }`
        )
        break
      }
      case 'verify': {
        const hostReader = await connection.runAndReadAll(
          `SELECT count(*) AS n FROM ${HOST_SAMPLES_TABLE}`
        )
        const networkReader = await connection.runAndReadAll(
          `SELECT count(*) AS n FROM ${NETWORK_SAMPLES_TABLE}`
        )
        const hostRows = Number(hostReader.getRows()[0][0])
        const networkRows = Number(networkReader.getRows()[0][0])
        if (hostRows < 1) {
          throw new Error(`host rows did not persist across restart: ${hostRows}`)
        }
        if (networkRows < 1) {
          throw new Error(`network rows did not persist across restart: ${networkRows}`)
        }
        console.log(`smoke:verify host_rows=${hostRows} network_rows=${networkRows}`)
        break
      }
      case 'parquet': {
        await connection.run(
          `COPY (SELECT * FROM ${HOST_SAMPLES_TABLE}) TO '${parquetPath}' (FORMAT PARQUET)`
        )
        const reader = await connection.runAndReadAll(
          `SELECT count(*) AS n FROM read_parquet('${parquetPath}')`
        )
        const rows = Number(reader.getRows()[0][0])
        if (rows < 1) throw new Error(`parquet round-trip lost rows: ${rows}`)
        console.log(`smoke:parquet rows=${rows}`)
        break
      }
      default:
        throw new TypeError(`unknown smoke mode: ${mode}`)
    }
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
  console.log(`smoke:ok ${mode}`)
}
