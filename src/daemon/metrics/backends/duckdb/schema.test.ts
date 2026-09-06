import { assertEquals, assertThrows } from "@std/assert";
import { it } from "@std/testing/bdd";
import { buildMetricsSampleV4 } from "../../contract-v4.ts";
import {
  BLOCK_METRIC_FIELDS,
  BLOCK_SAMPLES_TABLE,
  buildSchemaStatements,
  CPU_CORE_LIVE_METRIC_FIELDS,
  CPU_CORE_SAMPLES_TABLE,
  CPU_HOTSPOT_METRIC_FIELDS,
  CPU_HOTSPOT_SAMPLES_TABLE,
  cpuCoreSamplesInsertColumns,
  cpuHotspotSamplesInsertColumns,
  DATABASE_PROXY_METRIC_FIELDS,
  DATABASE_PROXY_SAMPLES_TABLE,
  DUCKDB_SCHEMA_MARKER_VERSION,
  entityMetricColumnName,
  FILESYSTEM_METRIC_FIELDS,
  FILESYSTEM_SAMPLES_TABLE,
  GPU_METRIC_FIELDS,
  GPU_SAMPLES_TABLE,
  HARDWARE_SIGNAL_SAMPLES_TABLE,
  HOST_GLOBAL_CPU_DETAIL_FIELDS_LIST,
  HOST_METRIC_FIELD_REFS,
  HOST_SAMPLES_TABLE,
  hostMetricColumnName,
  hostSamplesInsertColumns,
  INGRESS_METRIC_FIELDS,
  INGRESS_SAMPLES_TABLE,
  MEMORY_DETAIL_METRIC_FIELDS,
  MEMORY_DETAIL_SAMPLES_TABLE,
  memoryDetailSamplesInsertColumns,
  METRIC_EVENTS_TABLE,
  NETWORK_METRIC_FIELDS,
  NETWORK_SAMPLES_TABLE,
  STATUS_EVENTS_TABLE,
} from "./schema.ts";

it("DuckDB schema marker is 6", () => {
  assertEquals(DUCKDB_SCHEMA_MARKER_VERSION, 6);
});

it("hostMetricColumnName prefixes by group, avoiding cross-group collisions", () => {
  assertEquals(
    hostMetricColumnName("cpu", "pressureSomePercent"),
    "cpu_pressure_some_percent",
  );
  assertEquals(
    hostMetricColumnName("memory", "pressureSomePercent"),
    "memory_pressure_some_percent",
  );
  assertEquals(hostMetricColumnName("cpu", "busyPercent"), "cpu_busy_percent");
  assertThrows(
    () => hostMetricColumnName("cpu", "nope"),
    TypeError,
    "unknown host metrics field",
  );
});

it("entityMetricColumnName maps camelCase fields to snake_case", () => {
  assertEquals(
    entityMetricColumnName("receiveBytesPerSecond"),
    "receive_bytes_per_second",
  );
  assertEquals(entityMetricColumnName("queueDepth"), "queue_depth");
});

it("HOST_METRIC_FIELD_REFS has exactly 31 entries covering every host group, no duplicates", () => {
  assertEquals(HOST_METRIC_FIELD_REFS.length, 31);
  const columns = HOST_METRIC_FIELD_REFS.map((ref) =>
    hostMetricColumnName(ref.group, ref.field)
  );
  assertEquals(new Set(columns).size, columns.length);
  for (const column of columns) {
    assertEquals(/^[a-z][a-z0-9_]*$/.test(column), true, column);
  }
});

it("every leaf metric of a real v4 sample maps to a known host column", () => {
  const sample = buildMetricsSampleV4({
    metadata: {
      version: 4,
      sampledAt: new Date().toISOString(),
      intervalSeconds: 60,
      sequence: 1,
      collectionMode: "baseline",
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: {
      cpu: {
        busyPercent: 1,
        userPercent: 1,
        systemPercent: 1,
        iowaitPercent: 1,
        stealPercent: 1,
        softirqPercent: 1,
        pressureSomePercent: 1,
        maxCoreBusyPercent: 1,
        procsRunning: 1,
        procsBlocked: 1,
        processCount: 1,
      },
      kernel: { fileHandlesUsedPercent: 1, conntrackUsedPercent: 1 },
      memory: {
        availableBytes: 1,
        swapUsedBytes: 1,
        pressureSomePercent: 1,
        pressureFullPercent: 1,
        swapInBytesPerSecond: 1,
        swapOutBytesPerSecond: 1,
        majorPageFaultsPerSecond: 1,
      },
      storage: {
        ioPressureSomePercent: 1,
        ioPressureFullPercent: 1,
        diskReadBytesPerSecond: 1,
        diskWriteBytesPerSecond: 1,
        diskReadLatencyMs: 1,
        diskWriteLatencyMs: 1,
        maxBlockDeviceUtilPercent: 1,
        rootFilesystemAvailableBytes: 1,
        rootFilesystemFreeInodes: 1,
      },
      network: { tcpRetransmitPercent: 1, softnetDropsPerSecond: 1 },
    },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
  });
  const columnSet = new Set(hostSamplesInsertColumns());
  for (
    const group of ["cpu", "kernel", "memory", "storage", "network"] as const
  ) {
    for (const field of Object.keys(sample.host[group])) {
      assertEquals(
        columnSet.has(hostMetricColumnName(group, field)),
        true,
        `${group}.${field}`,
      );
    }
  }
});

it("buildSchemaStatements emits idempotent DDL for every v4 table", () => {
  const statements = buildSchemaStatements();
  const joined = statements.join("\n");
  assertEquals(
    statements.every(
      (sql) =>
        sql.startsWith("CREATE TABLE IF NOT EXISTS") ||
        sql.startsWith("CREATE INDEX IF NOT EXISTS"),
    ),
    true,
  );
  for (
    const table of [
      HOST_SAMPLES_TABLE,
      NETWORK_SAMPLES_TABLE,
      FILESYSTEM_SAMPLES_TABLE,
      BLOCK_SAMPLES_TABLE,
      GPU_SAMPLES_TABLE,
      CPU_HOTSPOT_SAMPLES_TABLE,
      CPU_CORE_SAMPLES_TABLE,
      MEMORY_DETAIL_SAMPLES_TABLE,
      HARDWARE_SIGNAL_SAMPLES_TABLE,
      INGRESS_SAMPLES_TABLE,
      DATABASE_PROXY_SAMPLES_TABLE,
      METRIC_EVENTS_TABLE,
      STATUS_EVENTS_TABLE,
    ]
  ) {
    assertEquals(
      joined.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
      true,
      table,
    );
    assertEquals(joined.includes(`ON ${table} (server_id, `), true, table);
  }
  // No positional AE layout ever leaks into DuckDB.
  assertEquals(/\bdouble\d+\b/.test(joined), false);
  assertEquals(/\bblob\d+\b/.test(joined), false);
  assertEquals(joined.includes("index1"), false);
  // No v3 marker columns survive the cutover.
  assertEquals(joined.includes(" parts "), false);
  assertEquals(joined.includes("hardware_profile_generation"), false);
  // v4-only common metadata columns present on every family table.
  assertEquals(joined.includes("topology_generation INTEGER NOT NULL"), true);
  assertEquals(joined.includes("boot_generation INTEGER NOT NULL"), true);
  assertEquals(joined.includes("sequence BIGINT NOT NULL"), true);
  // Per-entity index shape.
  assertEquals(
    joined.includes(
      `ON ${NETWORK_SAMPLES_TABLE} (server_id, device_id, sampled_at)`,
    ),
    true,
  );
  assertEquals(
    joined.includes(`ON ${GPU_SAMPLES_TABLE} (server_id, gpu_id, sampled_at)`),
    true,
  );
  assertEquals(
    joined.includes(
      `ON ${CPU_HOTSPOT_SAMPLES_TABLE} (server_id, core_id, sampled_at)`,
    ),
    true,
  );
  assertEquals(
    joined.includes(
      `ON ${CPU_CORE_SAMPLES_TABLE} (server_id, core_id, sampled_at)`,
    ),
    true,
  );
  assertEquals(
    joined.includes(`ON ${METRIC_EVENTS_TABLE} (server_id, "at")`),
    true,
  );
  assertEquals(
    joined.includes(`ON ${STATUS_EVENTS_TABLE} (server_id, "at")`),
    true,
  );
  // Every host metric key gets a nullable DOUBLE column.
  for (const ref of HOST_METRIC_FIELD_REFS) {
    assertEquals(
      joined.includes(`${hostMetricColumnName(ref.group, ref.field)} DOUBLE`),
      true,
      `${ref.group}.${ref.field}`,
    );
  }
  // Long-form hardware-signal table: kind + value, not one column per signal kind.
  assertEquals(joined.includes("kind VARCHAR NOT NULL"), true);
  assertEquals(joined.includes("value DOUBLE"), true);
  // Hand-declared cpuDetail host-global columns land on server_host_samples.
  assertEquals(
    joined.includes("cpu_detail_average_frequency_m_hz DOUBLE"),
    true,
  );
  assertEquals(joined.includes("cpu_detail_cpu_irq_percent DOUBLE"), true);
  // cpu.detail's embedded hotspots and cpu.core.live share one entity shape.
  for (const field of CPU_HOTSPOT_METRIC_FIELDS) {
    assertEquals(
      joined.includes(`${entityMetricColumnName(field)} DOUBLE`),
      true,
      `cpuHotspot.${field}`,
    );
  }
  for (const field of MEMORY_DETAIL_METRIC_FIELDS) {
    assertEquals(
      joined.includes(`${entityMetricColumnName(field)} DOUBLE`),
      true,
      `memoryDetail.${field}`,
    );
  }
});

it("cpuHotspotSamplesInsertColumns / cpuCoreSamplesInsertColumns share the same 3-field shape, keyed on core_id", () => {
  assertEquals(CPU_HOTSPOT_METRIC_FIELDS, CPU_CORE_LIVE_METRIC_FIELDS);
  const hotspotColumns = cpuHotspotSamplesInsertColumns();
  const coreColumns = cpuCoreSamplesInsertColumns();
  assertEquals(hotspotColumns.slice(0, 8).includes("server_id"), true);
  assertEquals(hotspotColumns.includes("core_id"), true);
  assertEquals(coreColumns.includes("core_id"), true);
  assertEquals(hotspotColumns.length, 8 + 1 + CPU_HOTSPOT_METRIC_FIELDS.length);
  assertEquals(coreColumns.length, 8 + 1 + CPU_CORE_LIVE_METRIC_FIELDS.length);
});

it("memoryDetailSamplesInsertColumns is a singleton (no entity id column), 19 fields", () => {
  const columns = memoryDetailSamplesInsertColumns();
  assertEquals(MEMORY_DETAIL_METRIC_FIELDS.length, 19);
  assertEquals(columns.length, 8 + MEMORY_DETAIL_METRIC_FIELDS.length);
  assertEquals(columns.includes("core_id"), false);
  assertEquals(columns.includes("memory_free_bytes"), true);
  assertEquals(columns.includes("compaction_stalls_per_second"), true);
});

it("hostSamplesInsertColumns lists common metadata then every host metric column plus the hand-declared cpuDetail host-global columns", () => {
  const columns = hostSamplesInsertColumns();
  assertEquals(
    columns.length,
    8 + HOST_METRIC_FIELD_REFS.length +
      HOST_GLOBAL_CPU_DETAIL_FIELDS_LIST.length,
  );
  assertEquals(columns.slice(0, 8), [
    "server_id",
    "sampled_at",
    "received_at",
    "interval_seconds",
    "collection_mode",
    "sequence",
    "topology_generation",
    "boot_generation",
  ]);
  assertEquals(columns.includes("cpu_busy_percent"), true);
  assertEquals(columns.includes("cpu_process_count"), true);
  assertEquals(columns.includes("memory_pressure_some_percent"), true);
  assertEquals(columns.includes("cpu_detail_average_frequency_m_hz"), true);
  assertEquals(columns.includes("cpu_detail_cpu_irq_percent"), true);
});

it("every entity family declares a non-empty, unique field list", () => {
  for (
    const fields of [
      NETWORK_METRIC_FIELDS,
      FILESYSTEM_METRIC_FIELDS,
      BLOCK_METRIC_FIELDS,
      GPU_METRIC_FIELDS,
      INGRESS_METRIC_FIELDS,
      DATABASE_PROXY_METRIC_FIELDS,
    ]
  ) {
    assertEquals(fields.length > 0, true);
    assertEquals(new Set(fields).size, fields.length);
  }
});
