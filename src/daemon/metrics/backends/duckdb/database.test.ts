import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { DUCKDB_SCHEMA_MARKER_VERSION, HOST_SAMPLES_TABLE } from "./schema.ts";
import {
  openDuckDb,
  readSchemaMarker,
  resolveDuckDbPaths,
  schemaMarkerPath,
  writeSchemaMarker,
} from "./database.ts";

it("readSchemaMarker returns null when no marker file exists", async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: "tp-duckdb-marker-" });
  try {
    const paths = resolveDuckDbPaths(metricsDir);
    assertEquals(await readSchemaMarker(paths), null);
  } finally {
    await Deno.remove(metricsDir, { recursive: true });
  }
});

it("writeSchemaMarker + readSchemaMarker round trip the current version", async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: "tp-duckdb-marker-" });
  try {
    const paths = resolveDuckDbPaths(metricsDir);
    await writeSchemaMarker(paths);
    assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION);
    assertEquals(
      (await Deno.readTextFile(schemaMarkerPath(paths))).trim(),
      String(DUCKDB_SCHEMA_MARKER_VERSION),
    );
  } finally {
    await Deno.remove(metricsDir, { recursive: true });
  }
});

it("readSchemaMarker treats a corrupt marker file as absent", async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: "tp-duckdb-marker-" });
  try {
    const paths = resolveDuckDbPaths(metricsDir);
    await Deno.writeTextFile(schemaMarkerPath(paths), "not-a-number");
    assertEquals(await readSchemaMarker(paths), null);
  } finally {
    await Deno.remove(metricsDir, { recursive: true });
  }
});

it("openDuckDb writes the marker and creates the current host columns", async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: "tp-duckdb-open-" });
  try {
    const paths = resolveDuckDbPaths(metricsDir);
    const handle = await openDuckDb({ paths });
    try {
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION);
      const columnsReader = await handle.connection.runAndReadAll(
        `SELECT column_name FROM information_schema.columns ` +
          `WHERE table_name = '${HOST_SAMPLES_TABLE}' AND column_name = 'cpu_process_count'`,
      );
      assertEquals(columnsReader.getRowObjectsJS().length, 1);
    } finally {
      handle.close();
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true });
  }
});

async function fileExistsForTest(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

it("openDuckDb discards a missing marker and leftover parquet before creating the current store", async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: "tp-duckdb-open-missing-marker-",
  });
  try {
    const paths = resolveDuckDbPaths(metricsDir);
    const first = await openDuckDb({ paths });
    first.close();
    await Deno.remove(schemaMarkerPath(paths));
    const extraDir = `${paths.parquetRoot}/server-metrics/year=2025`;
    await Deno.mkdir(extraDir, { recursive: true });
    await Deno.writeTextFile(`${extraDir}/metrics.parquet`, "sealed partition");

    const second = await openDuckDb({ paths });
    try {
      assertEquals(
        await fileExistsForTest(`${extraDir}/metrics.parquet`),
        false,
      );
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION);
    } finally {
      second.close();
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true });
  }
});

it("openDuckDb discards an orphan parquet tree when the marker is missing", async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: "tp-duckdb-open-orphan-parquet-",
  });
  try {
    const paths = resolveDuckDbPaths(metricsDir);
    const leftoverDir = `${paths.parquetRoot}/server-metrics/year=2025`;
    await Deno.mkdir(leftoverDir, { recursive: true });
    await Deno.writeTextFile(
      `${leftoverDir}/metrics.parquet`,
      "orphaned partition",
    );

    const handle = await openDuckDb({ paths });
    try {
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION);
      assertEquals(
        await fileExistsForTest(`${leftoverDir}/metrics.parquet`),
        false,
      );
    } finally {
      handle.close();
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true });
  }
});

it("openDuckDb discards a corrupt marker and existing files before creating the current store", async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: "tp-duckdb-open-corrupt-marker-",
  });
  try {
    const paths = resolveDuckDbPaths(metricsDir);
    await Deno.writeTextFile(schemaMarkerPath(paths), "not-a-number");
    const leftoverDir = `${paths.parquetRoot}/server-metrics/year=2025`;
    await Deno.mkdir(leftoverDir, { recursive: true });
    await Deno.writeTextFile(
      `${leftoverDir}/metrics.parquet`,
      "stale partition",
    );

    const handle = await openDuckDb({ paths });
    try {
      assertEquals(
        await fileExistsForTest(`${leftoverDir}/metrics.parquet`),
        false,
      );
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION);
    } finally {
      handle.close();
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true });
  }
});

it("openDuckDb discards a stale marker (5) and parquet before creating schema 6", async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: "tp-duckdb-open-stale-marker-",
  });
  try {
    const paths = resolveDuckDbPaths(metricsDir);
    const first = await openDuckDb({ paths });
    first.close();
    await Deno.writeTextFile(schemaMarkerPath(paths), "5");
    const extraDir = `${paths.parquetRoot}/server-metrics/year=2025`;
    await Deno.mkdir(extraDir, { recursive: true });
    await Deno.writeTextFile(`${extraDir}/metrics.parquet`, "pre-v6 partition");

    const second = await openDuckDb({ paths });
    try {
      assertEquals(
        await fileExistsForTest(`${extraDir}/metrics.parquet`),
        false,
      );
      assertEquals(await readSchemaMarker(paths), 6);
    } finally {
      second.close();
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true });
  }
});

it("openDuckDb keeps parquet when the current marker (6) is already present", async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: "tp-duckdb-open-current-marker-",
  });
  try {
    const paths = resolveDuckDbPaths(metricsDir);
    const first = await openDuckDb({ paths });
    first.close();
    const extraDir = `${paths.parquetRoot}/server_host_samples/year=2026`;
    await Deno.mkdir(extraDir, { recursive: true });
    await Deno.writeTextFile(
      `${extraDir}/metrics.parquet`,
      "current partition",
    );

    const second = await openDuckDb({ paths });
    try {
      assertEquals(
        await fileExistsForTest(`${extraDir}/metrics.parquet`),
        true,
      );
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION);
    } finally {
      second.close();
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true });
  }
});
