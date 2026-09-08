import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  type DuckDbConnectionLike,
  type DuckDbHandle,
  openDuckDb,
  resolveDuckDbPaths,
} from './database.ts'
import {
  cleanupTmpParquetFiles,
  listPartitionFilesInRange,
  MS_PER_DAY,
  parquetFamily,
  partitionFileForDay,
  pruneExpiredPartitions,
  sealDayToParquet,
  timestampLiteralFromMs,
  utcDayStartMs,
} from './parquet.ts'
import { HOST_SAMPLES_TABLE, METRIC_EVENTS_TABLE, STATUS_EVENTS_TABLE } from './schema.ts'

const SERVER_ID = '11111111-2222-4333-8444-555555555555'
const DAY_START = Date.UTC(2026, 5, 1) // 2026-06-01T00:00:00Z
const HOST_FAMILY = parquetFamily('host')
const EVENTS_FAMILY = parquetFamily('events')

async function withTempDb(
  run: (handle: DuckDbHandle, paths: ReturnType<typeof resolveDuckDbPaths>) => Promise<void>
): Promise<void> {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-parquet-' })
  const paths = resolveDuckDbPaths(metricsDir)
  const handle = await openDuckDb({ paths })
  try {
    await run(handle, paths)
  } finally {
    handle.close()
    await Deno.remove(metricsDir, { recursive: true })
  }
}

async function insertHostSample(
  connection: DuckDbConnectionLike,
  atMs: number,
  cpuBusyPercent: number | null = 10
): Promise<void> {
  await connection.run(
    `INSERT INTO ${HOST_SAMPLES_TABLE} ` +
      `(server_id, sampled_at, received_at, interval_seconds, ` +
      `sequence, topology_generation, boot_generation, cpu_busy_percent) ` +
      `VALUES (CAST(? AS UUID), ${timestampLiteralFromMs(atMs)}, ${timestampLiteralFromMs(
        atMs
      )}, 60, 1, 1, 1, ?)`,
    [SERVER_ID, cpuBusyPercent]
  )
}

async function insertMetricEvent(
  connection: DuckDbConnectionLike,
  atMs: number,
  eventId: string
): Promise<void> {
  await connection.run(
    `INSERT INTO ${METRIC_EVENTS_TABLE} ` +
      `(server_id, event_id, "at", received_at, kind, severity, topology_generation) ` +
      `VALUES (CAST(? AS UUID), ?, ${timestampLiteralFromMs(atMs)}, ${timestampLiteralFromMs(
        atMs
      )}, 'oom_kill', 'critical', 1)`,
    [SERVER_ID, eventId]
  )
}

async function hotRowCount(connection: DuckDbConnectionLike, table: string): Promise<number> {
  const reader = await connection.runAndReadAll(
    `SELECT CAST(count(*) AS DOUBLE) AS n FROM ${table}`
  )
  return Number(reader.getRowObjectsJS()[0]?.n ?? Number.NaN)
}

it('utcDayStartMs floors to the UTC day boundary', () => {
  assertEquals(utcDayStartMs(DAY_START), DAY_START)
  assertEquals(utcDayStartMs(DAY_START + 12 * 3600_000 + 123), DAY_START)
})

it('partitionFileForDay builds a per-family year=/month=/day= tree path', () => {
  assertEquals(
    partitionFileForDay('/x/parquet', 'host', DAY_START),
    '/x/parquet/host/year=2026/month=06/day=01/metrics.parquet'
  )
  assertEquals(
    partitionFileForDay('/x/parquet', 'events', DAY_START),
    '/x/parquet/events/year=2026/month=06/day=01/metrics.parquet'
  )
})

it('timestampLiteralFromMs renders a UTC TIMESTAMP literal', () => {
  assertEquals(timestampLiteralFromMs(DAY_START), "TIMESTAMP '2026-06-01 00:00:00.000'")
})

it('parquetFamily resolves every declared key and throws on an unknown one', () => {
  assertEquals(parquetFamily('host').table, HOST_SAMPLES_TABLE)
  assertEquals(parquetFamily('events').timestampColumn, `"at"`)
  let threw = false
  try {
    // deno-lint-ignore no-explicit-any
    parquetFamily('nope' as any)
  } catch {
    threw = true
  }
  assertEquals(threw, true)
})

it("listPartitionFilesInRange returns only day partitions overlapping the range, scoped to one family's subdir", async () => {
  const root = await Deno.makeTempDir({ prefix: 'tp-duckdb-partitions-' })
  try {
    for (const dayOffset of [0, 1, 2]) {
      const file = partitionFileForDay(root, 'host', DAY_START + dayOffset * MS_PER_DAY)
      await Deno.mkdir(file.slice(0, file.lastIndexOf('/')), {
        recursive: true,
      })
      await Deno.writeTextFile(file, '')
    }
    // Day dir without a metrics.parquet file must be skipped.
    const emptyDayFile = partitionFileForDay(root, 'host', DAY_START + 3 * MS_PER_DAY)
    await Deno.mkdir(emptyDayFile.slice(0, emptyDayFile.lastIndexOf('/')), {
      recursive: true,
    })

    const all = await listPartitionFilesInRange(root, 'host', DAY_START, DAY_START + 4 * MS_PER_DAY)
    assertEquals(all.length, 3)
    const middle = await listPartitionFilesInRange(
      root,
      'host',
      DAY_START + MS_PER_DAY,
      DAY_START + MS_PER_DAY + 3600_000
    )
    assertEquals(middle.length, 1)
    assertStringIncludes(middle[0]!, 'day=02')
    // Half-open right edge: a range ending exactly at a day's start must not
    // scan that day's partition.
    const upToBoundary = await listPartitionFilesInRange(
      root,
      'host',
      DAY_START,
      DAY_START + MS_PER_DAY
    )
    assertEquals(upToBoundary.length, 1)
    assertStringIncludes(upToBoundary[0]!, 'day=01')
    // A different family's subdir sees none of these files.
    assertEquals(
      await listPartitionFilesInRange(root, 'events', DAY_START, DAY_START + 4 * MS_PER_DAY),
      []
    )
    assertEquals(await listPartitionFilesInRange('/nonexistent-root', 'host', 0, Date.now()), [])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

it('cleanupTmpParquetFiles removes only leftover .parquet files, shared across every family', async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-tmp-' })
  try {
    await Deno.writeTextFile(`${tmpDir}/host-x.parquet`, 'stray')
    await Deno.writeTextFile(`${tmpDir}/events-y.parquet`, 'stray')
    await Deno.writeTextFile(`${tmpDir}/keep.txt`, 'keep')
    await cleanupTmpParquetFiles(tmpDir)
    const names: string[] = []
    for await (const entry of Deno.readDir(tmpDir)) names.push(entry.name)
    assertEquals(names, ['keep.txt'])
    // Missing directory is a no-op.
    await cleanupTmpParquetFiles(`${tmpDir}/missing`)
  } finally {
    await Deno.remove(tmpDir, { recursive: true })
  }
})

it('sealDayToParquet exports, validates, renames, then deletes hot rows for one family', async () => {
  await withTempDb(async (handle, paths) => {
    await insertHostSample(handle.connection, DAY_START + 60_000, 10)
    await insertHostSample(handle.connection, DAY_START + 120_000, null)
    await insertHostSample(handle.connection, DAY_START + MS_PER_DAY + 60_000, 30)

    const result = await sealDayToParquet(handle.connection, {
      family: HOST_FAMILY,
      dayStartMs: DAY_START,
      dayEndMs: DAY_START + MS_PER_DAY,
      parquetRoot: paths.parquetRoot,
      tmpDir: paths.tmpDir,
    })
    assertEquals(result.rowCount, 2)
    assertEquals(result.parquetPath, partitionFileForDay(paths.parquetRoot, 'host', DAY_START))

    // Sealed rows left the hot table; the next day's row stayed.
    assertEquals(await hotRowCount(handle.connection, HOST_SAMPLES_TABLE), 1)

    // The sealed file re-reads with genuine NULLs (no sentinel).
    const reader = await handle.connection.runAndReadAll(
      `SELECT cpu_busy_percent FROM read_parquet('${result.parquetPath}') ` + `ORDER BY sampled_at`
    )
    const values = reader.getRowObjectsJS().map((row) => row.cpu_busy_percent)
    assertEquals(values, [10, null])

    // No leftover tmp exports.
    const tmpNames: string[] = []
    for await (const entry of Deno.readDir(paths.tmpDir)) {
      if (entry.name.endsWith('.parquet')) tmpNames.push(entry.name)
    }
    assertEquals(tmpNames, [])
  })
})

it('sealDayToParquet works for the events family, quoting its "at" timestamp column', async () => {
  await withTempDb(async (handle, paths) => {
    await insertMetricEvent(handle.connection, DAY_START + 60_000, 'evt-1')
    await insertMetricEvent(handle.connection, DAY_START + 120_000, 'evt-2')

    const result = await sealDayToParquet(handle.connection, {
      family: EVENTS_FAMILY,
      dayStartMs: DAY_START,
      dayEndMs: DAY_START + MS_PER_DAY,
      parquetRoot: paths.parquetRoot,
      tmpDir: paths.tmpDir,
    })
    assertEquals(result.rowCount, 2)
    assertEquals(await hotRowCount(handle.connection, METRIC_EVENTS_TABLE), 0)

    const reader = await handle.connection.runAndReadAll(
      `SELECT event_id FROM read_parquet('${result.parquetPath}') ORDER BY event_id`
    )
    assertEquals(
      reader.getRowObjectsJS().map((row) => row.event_id),
      ['evt-1', 'evt-2']
    )
  })
})

it('resealing an already archived day merges late hot rows into the partition', async () => {
  await withTempDb(async (handle, paths) => {
    await insertHostSample(handle.connection, DAY_START + 60_000, 10)
    const first = await sealDayToParquet(handle.connection, {
      family: HOST_FAMILY,
      dayStartMs: DAY_START,
      dayEndMs: DAY_START + MS_PER_DAY,
      parquetRoot: paths.parquetRoot,
      tmpDir: paths.tmpDir,
    })
    assertEquals(first.rowCount, 1)

    // Late arrival for the already sealed day, then a second seal pass.
    await insertHostSample(handle.connection, DAY_START + 120_000, 20)
    const second = await sealDayToParquet(handle.connection, {
      family: HOST_FAMILY,
      dayStartMs: DAY_START,
      dayEndMs: DAY_START + MS_PER_DAY,
      parquetRoot: paths.parquetRoot,
      tmpDir: paths.tmpDir,
    })
    assertEquals(second.rowCount, 1)
    assertEquals(second.parquetPath, first.parquetPath)

    // The late hot row left the hot table; the partition holds both rows.
    assertEquals(await hotRowCount(handle.connection, HOST_SAMPLES_TABLE), 0)
    const reader = await handle.connection.runAndReadAll(
      `SELECT cpu_busy_percent FROM read_parquet('${second.parquetPath}') ` + `ORDER BY sampled_at`
    )
    assertEquals(
      reader.getRowObjectsJS().map((row) => row.cpu_busy_percent),
      [10, 20]
    )
  })
})

it('sealDayToParquet with no rows writes nothing', async () => {
  await withTempDb(async (handle, paths) => {
    const result = await sealDayToParquet(handle.connection, {
      family: HOST_FAMILY,
      dayStartMs: DAY_START,
      dayEndMs: DAY_START + MS_PER_DAY,
      parquetRoot: paths.parquetRoot,
      tmpDir: paths.tmpDir,
    })
    assertEquals(result, { rowCount: 0, parquetPath: null })
    assertEquals(await listPartitionFilesInRange(paths.parquetRoot, 'host', 0, Date.now()), [])
  })
})

it('seal validation failure keeps hot rows and never installs the partition', async () => {
  await withTempDb(async (handle, paths) => {
    await insertHostSample(handle.connection, DAY_START + 60_000, 10)

    // Wrap the real connection so the read-back validation sees a mismatch.
    const lying: DuckDbConnectionLike = {
      run: (sql, values) => handle.connection.run(sql, values),
      runAndReadAll: async (sql, values) => {
        if (sql.includes('read_parquet')) {
          return {
            getRowObjectsJS: () => [{ n: 999 }],
          }
        }
        return await handle.connection.runAndReadAll(sql, values)
      },
      closeSync: () => {},
    }

    await assertRejects(
      () =>
        sealDayToParquet(lying, {
          family: HOST_FAMILY,
          dayStartMs: DAY_START,
          dayEndMs: DAY_START + MS_PER_DAY,
          parquetRoot: paths.parquetRoot,
          tmpDir: paths.tmpDir,
        }),
      Error,
      'parquet seal validation failed'
    )

    // Hot rows untouched, no sealed partition, tmp file removed.
    assertEquals(await hotRowCount(handle.connection, HOST_SAMPLES_TABLE), 1)
    assertEquals(await listPartitionFilesInRange(paths.parquetRoot, 'host', 0, Date.now()), [])
    for await (const entry of Deno.readDir(paths.tmpDir)) {
      assertEquals(entry.name.endsWith('.parquet'), false, entry.name)
    }
  })
})

it('a crash after the partition rename but before the hot-row delete does not duplicate rows on the next seal', async () => {
  await withTempDb(async (handle, paths) => {
    await insertHostSample(handle.connection, DAY_START + 60_000, 10)
    await insertHostSample(handle.connection, DAY_START + 120_000, 20)
    const finalPath = partitionFileForDay(paths.parquetRoot, 'host', DAY_START)

    // Wrap the real connection so the hot-row DELETE throws — simulating a
    // crash after Deno.rename() installed the partition but before the
    // delete ran.
    const crashesAfterRename: DuckDbConnectionLike = {
      run: async (sql, values) => {
        if (sql.startsWith('DELETE FROM')) {
          throw new Error('simulated crash after rename')
        }
        return await handle.connection.run(sql, values)
      },
      runAndReadAll: (sql, values) => handle.connection.runAndReadAll(sql, values),
      closeSync: () => {},
    }

    await assertRejects(
      () =>
        sealDayToParquet(crashesAfterRename, {
          family: HOST_FAMILY,
          dayStartMs: DAY_START,
          dayEndMs: DAY_START + MS_PER_DAY,
          parquetRoot: paths.parquetRoot,
          tmpDir: paths.tmpDir,
        }),
      Error,
      'simulated crash after rename'
    )

    // Partition was installed; hot rows are still present (delete never ran).
    assertEquals(await hotRowCount(handle.connection, HOST_SAMPLES_TABLE), 2)
    const installedReader = await handle.connection.runAndReadAll(
      `SELECT count(*) AS n FROM read_parquet('${finalPath}')`
    )
    assertEquals(Number(installedReader.getRowObjectsJS()[0]?.n), 2)

    // Next archive pass resumes the pending delete instead of re-exporting —
    // no duplicated rows in the partition, hot rows finally cleared.
    const result = await sealDayToParquet(handle.connection, {
      family: HOST_FAMILY,
      dayStartMs: DAY_START,
      dayEndMs: DAY_START + MS_PER_DAY,
      parquetRoot: paths.parquetRoot,
      tmpDir: paths.tmpDir,
    })
    assertEquals(result.rowCount, 2)
    assertEquals(result.parquetPath, finalPath)
    assertEquals(await hotRowCount(handle.connection, HOST_SAMPLES_TABLE), 0)

    const reader = await handle.connection.runAndReadAll(
      `SELECT cpu_busy_percent FROM read_parquet('${finalPath}') ORDER BY sampled_at`
    )
    assertEquals(
      reader.getRowObjectsJS().map((row) => row.cpu_busy_percent),
      [10, 20]
    )
  })
})

it('pruneExpiredPartitions drops old partitions and hot rows across every family plus status events', async () => {
  await withTempDb(async (handle, paths) => {
    const nowMs = DAY_START + 10 * MS_PER_DAY
    // Sealed host partition 10 days old (outside retention 2).
    await insertHostSample(handle.connection, DAY_START + 60_000, 10)
    await sealDayToParquet(handle.connection, {
      family: HOST_FAMILY,
      dayStartMs: DAY_START,
      dayEndMs: DAY_START + MS_PER_DAY,
      parquetRoot: paths.parquetRoot,
      tmpDir: paths.tmpDir,
    })
    // Un-sealed old hot row (missed archive) + recent hot row, both host.
    await insertHostSample(handle.connection, DAY_START + MS_PER_DAY + 60_000, 20)
    await insertHostSample(handle.connection, nowMs - 3600_000, 30)
    // An old, never-sealed event row — proves the events family is pruned too.
    await insertMetricEvent(handle.connection, DAY_START + 60_000, 'evt-old')
    await handle.connection.run(
      `INSERT INTO ${STATUS_EVENTS_TABLE} (server_id, "at", connected, reason) ` +
        `VALUES (CAST('${SERVER_ID}' AS UUID), ${timestampLiteralFromMs(
          DAY_START
        )}, true, 'connect')`
    )

    await pruneExpiredPartitions(handle.connection, {
      retentionDays: 2,
      parquetRoot: paths.parquetRoot,
      nowMs,
    })

    assertEquals(await listPartitionFilesInRange(paths.parquetRoot, 'host', 0, nowMs), [])
    assertEquals(await hotRowCount(handle.connection, HOST_SAMPLES_TABLE), 1)
    assertEquals(await hotRowCount(handle.connection, METRIC_EVENTS_TABLE), 0)
    assertEquals(await hotRowCount(handle.connection, STATUS_EVENTS_TABLE), 0)
  })
})
