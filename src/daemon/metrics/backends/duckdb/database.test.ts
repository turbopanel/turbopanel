import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { DUCKDB_SCHEMA_MARKER_VERSION, HOST_SAMPLES_TABLE } from './schema.ts'
import {
  openDuckDb,
  readSchemaMarker,
  resolveDuckDbPaths,
  schemaIsCurrentFromColumns,
  schemaMarkerPath,
  shouldWipeStaleStore,
  wipeStaleStore,
  writeSchemaMarker,
} from './database.ts'

it('shouldWipeStaleStore: no database file only wipes when leftover parquet data survives', () => {
  assertEquals(
    shouldWipeStaleStore({
      databaseExists: false,
      schemaIsCurrent: true,
      parquetHasData: false,
    }),
    false
  )
  // A pre-v4 parquet/ tree surviving a deleted metrics.duckdb must still be
  // treated as stale — otherwise queryHostSeries() unions it right back in.
  assertEquals(
    shouldWipeStaleStore({
      databaseExists: false,
      schemaIsCurrent: true,
      parquetHasData: true,
    }),
    true
  )
})

it('shouldWipeStaleStore: an existing database wipes only when the probed schema is not current', () => {
  assertEquals(
    shouldWipeStaleStore({
      databaseExists: true,
      schemaIsCurrent: false,
      parquetHasData: false,
    }),
    true
  )
})

it('shouldWipeStaleStore: an existing database with a current schema opens untouched, marker or not', () => {
  assertEquals(
    shouldWipeStaleStore({
      databaseExists: true,
      schemaIsCurrent: true,
      parquetHasData: false,
    }),
    false
  )
})

it('schemaIsCurrentFromColumns: an absent table (empty column list) is stale', () => {
  // A real v3 database never has `server_host_samples` at all (its wide
  // table was `server_metric_samples`) — an empty probe must not be mistaken
  // for "current".
  assertEquals(schemaIsCurrentFromColumns([]), false)
})

it('schemaIsCurrentFromColumns: missing either v4 marker column is stale', () => {
  assertEquals(schemaIsCurrentFromColumns(['server_id', 'sampled_at', 'cpu_busy_percent']), false)
  assertEquals(
    schemaIsCurrentFromColumns(['server_id', 'topology_generation', 'cpu_busy_percent']),
    false
  )
  assertEquals(
    schemaIsCurrentFromColumns(['server_id', 'boot_generation', 'cpu_busy_percent']),
    false
  )
})

it('schemaIsCurrentFromColumns: both v4 marker columns present is current', () => {
  assertEquals(
    schemaIsCurrentFromColumns([
      'server_id',
      'topology_generation',
      'boot_generation',
      'cpu_busy_percent',
    ]),
    true
  )
})

it('readSchemaMarker returns null when no marker file exists', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-marker-' })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    assertEquals(await readSchemaMarker(paths), null)
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('writeSchemaMarker + readSchemaMarker round trip the current version', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-marker-' })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    await writeSchemaMarker(paths)
    assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION)
    assertEquals(
      (await Deno.readTextFile(schemaMarkerPath(paths))).trim(),
      String(DUCKDB_SCHEMA_MARKER_VERSION)
    )
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('readSchemaMarker treats a corrupt marker file as absent', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-marker-' })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    await Deno.writeTextFile(schemaMarkerPath(paths), 'not-a-number')
    assertEquals(await readSchemaMarker(paths), null)
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('wipeStaleStore deletes the database file, its WAL, and the entire parquet tree', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-wipe-' })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    await Deno.writeTextFile(paths.databasePath, 'stale db')
    await Deno.writeTextFile(`${paths.databasePath}.wal`, 'stale wal')
    await Deno.mkdir(`${paths.parquetRoot}/server-metrics/year=2025`, {
      recursive: true,
    })
    await Deno.writeTextFile(
      `${paths.parquetRoot}/server-metrics/year=2025/metrics.parquet`,
      'stale partition'
    )

    await wipeStaleStore(paths)

    for (const path of [paths.databasePath, `${paths.databasePath}.wal`, paths.parquetRoot]) {
      let exists = true
      try {
        await Deno.stat(path)
      } catch {
        exists = false
      }
      assertEquals(exists, false, path)
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('wipeStaleStore is a no-op when nothing stale exists yet', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-wipe-' })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    // Nothing on disk beyond the empty metrics dir — must not throw.
    await wipeStaleStore(paths)
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('openDuckDb writes the marker on a fresh install and never wipes', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-open-' })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    const handle = await openDuckDb({ paths })
    try {
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION)
    } finally {
      handle.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

async function fileExistsForTest(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

it('openDuckDb preserves a current-schema store when the marker is missing', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-duckdb-open-missing-marker-',
  })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    // First boot: a current v4 store, current marker.
    const first = await openDuckDb({ paths })
    first.close()
    // Marker sidecar goes missing (e.g. lost/corrupted independently of the
    // database file) while the on-disk schema is still fully current.
    await Deno.remove(schemaMarkerPath(paths))
    const survivingPartitionDir = `${paths.parquetRoot}/server-metrics/year=2025`
    await Deno.mkdir(survivingPartitionDir, { recursive: true })
    await Deno.writeTextFile(
      `${survivingPartitionDir}/metrics.parquet`,
      'current-schema sealed partition'
    )

    const second = await openDuckDb({ paths })
    try {
      // A missing marker alone must not destroy a current store.
      assertEquals(await fileExistsForTest(`${survivingPartitionDir}/metrics.parquet`), true)
      // The fast path re-derives and rewrites the marker on this open.
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION)
    } finally {
      second.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('openDuckDb wipes a genuinely stale database (pre-v4 columns) even with no marker on disk', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-duckdb-open-stale-schema-',
  })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    await Deno.mkdir(paths.metricsDir, { recursive: true })

    // Fabricate a pre-v4 database: the table exists but lacks the
    // and `hardware_profile_generation` marker columns.
    const { DuckDBInstance } = await import('@duckdb/node-api')
    const legacyInstance = await DuckDBInstance.create(paths.databasePath)
    const legacyConnection = await legacyInstance.connect()
    await legacyConnection.run(
      `CREATE TABLE ${HOST_SAMPLES_TABLE} (server_id UUID, sampled_at TIMESTAMP)`
    )
    legacyConnection.closeSync()
    legacyInstance.closeSync()

    const stalePartitionDir = `${paths.parquetRoot}/server-metrics/year=2025`
    await Deno.mkdir(stalePartitionDir, { recursive: true })
    await Deno.writeTextFile(`${stalePartitionDir}/metrics.parquet`, 'stale pre-v4 partition')

    const handle = await openDuckDb({ paths })
    try {
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION)
      assertEquals(await fileExistsForTest(`${stalePartitionDir}/metrics.parquet`), false)
      // The reopened store is fully usable — schema DDL rebuilt it as v4.
      const reader = await handle.connection.runAndReadAll(
        `SELECT count(*) AS n FROM ${HOST_SAMPLES_TABLE}`
      )
      assertEquals(Number(reader.getRowObjectsJS()[0]?.n), 0)
    } finally {
      handle.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('openDuckDb wipes a real v3 database (single wide server_metric_samples table, no server_host_samples) and rebuilds the v4 schema', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-duckdb-open-real-v3-',
  })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    await Deno.mkdir(paths.metricsDir, { recursive: true })

    // Fabricate the actual v3 layout: the old single wide table, real v3
    // column shape (no `server_host_samples` at all — the exact real-world
    // false negative this probe must catch, not a fabricated legacy
    // `server_host_samples` table).
    const { DuckDBInstance } = await import('@duckdb/node-api')
    const legacyInstance = await DuckDBInstance.create(paths.databasePath)
    const legacyConnection = await legacyInstance.connect()
    await legacyConnection.run(
      `CREATE TABLE server_metric_samples (` +
        `server_id UUID, sampled_at TIMESTAMP, received_at TIMESTAMP, ` +
        `interval_seconds SMALLINT, collection_mode VARCHAR, ` +
        `hardware_profile_generation INTEGER, parts VARCHAR, ` +
        `cpu_user_percent DOUBLE)`
    )
    await legacyConnection.run(
      `INSERT INTO server_metric_samples VALUES (` +
        `'00000000-0000-0000-0000-000000000001', now(), now(), 60, ` +
        `'baseline', 1, 'core', 12.5)`
    )
    legacyConnection.closeSync()
    legacyInstance.closeSync()

    // Real v3 partition layout: a single "server-metrics" subdir, not
    // per-family subdirs.
    const stalePartitionDir = `${paths.parquetRoot}/server-metrics/year=2025`
    await Deno.mkdir(stalePartitionDir, { recursive: true })
    await Deno.writeTextFile(`${stalePartitionDir}/metrics.parquet`, 'real v3 sealed partition')

    const handle = await openDuckDb({ paths })
    try {
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION)
      // Old parquet tree wiped.
      assertEquals(await fileExistsForTest(`${stalePartitionDir}/metrics.parquet`), false)
      // Old wide table gone; v4 host table rebuilt and empty.
      const tablesReader = await handle.connection.runAndReadAll(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_name = 'server_metric_samples'`
      )
      assertEquals(tablesReader.getRowObjectsJS().length, 0)
      const reader = await handle.connection.runAndReadAll(
        `SELECT count(*) AS n FROM ${HOST_SAMPLES_TABLE}`
      )
      assertEquals(Number(reader.getRowObjectsJS()[0]?.n), 0)
    } finally {
      handle.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('openDuckDb wipes a leftover pre-v4 parquet tree when metrics.duckdb is absent', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-duckdb-open-orphan-parquet-',
  })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    // No metrics.duckdb at all — but a sealed pre-v4 partition survives,
    // exactly the false-negative case shouldWipeStaleStore() must catch.
    const stalePartitionDir = `${paths.parquetRoot}/server-metrics/year=2025`
    await Deno.mkdir(stalePartitionDir, { recursive: true })
    await Deno.writeTextFile(`${stalePartitionDir}/metrics.parquet`, 'orphaned pre-v4 partition')

    const handle = await openDuckDb({ paths })
    try {
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION)
      assertEquals(await fileExistsForTest(`${stalePartitionDir}/metrics.parquet`), false)
    } finally {
      handle.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})
