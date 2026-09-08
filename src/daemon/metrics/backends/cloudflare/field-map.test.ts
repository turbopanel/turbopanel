import { assertEquals, assertThrows } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  buildMetricsSample,
  type HostCpuMetrics,
  type HostKernelMetrics,
  type HostMemoryMetrics,
  type HostNetworkMetrics,
  type HostStorageMetrics,
  type MetricsSampleInput,
} from "../../contract.ts";
import type { AuthenticatedMetricsSample } from "../../types.ts";
import {
  _internalFieldMap,
  AE_BLOB_CAPABILITY_PLAN_GENERATION_INDEX,
  AE_BLOB_COUNT,
  AE_BLOB_EVENT_ENTITY_ID_INDEX,
  AE_BLOB_EVENT_ID_INDEX,
  AE_BLOB_EVENT_PAYLOAD_INDEX,
  AE_BLOB_FAMILY_INDEX,
  AE_BLOB_KIND_INDEX,
  AE_BLOB_PAGE_INDEX,
  AE_BLOB_SAMPLED_AT_INDEX,
  AE_BLOB_SOURCE_OR_IDENTITY_INDEX,
  AE_BLOB_STATUS_OR_EVENT_REASON_INDEX,
  AE_DOUBLE_COUNT,
  AE_DOUBLE_INTERVAL_INDEX,
  AE_FAMILY_BLOCK,
  AE_FAMILY_FILESYSTEM,
  AE_FAMILY_GPU,
  AE_FAMILY_HARDWARE_PHYSICAL,
  AE_FAMILY_HOST_DIAGNOSTICS,
  AE_FAMILY_HOST_IO,
  AE_FAMILY_HOST_SYSTEM,
  AE_FAMILY_MANAGED_DOCKER,
  AE_FAMILY_MANAGED_ROUTER,
  AE_FAMILY_MANAGED_STORAGE,
  AE_FAMILY_NETWORK,
  AE_KIND_EVENT,
  AE_KIND_METRICS,
  AE_MAX_DATA_POINTS_PER_INVOCATION,
  AE_MISSING_METRIC_SENTINEL,
  type AnalyticsEngineDataPointLike,
  buildMetricsDataPoints,
  doubleIndexForHostField,
} from "./field-map.ts";

function zeroFields<T extends readonly string[]>(
  fields: T,
): { [K in T[number]]: number | null } {
  const out = {} as { [K in T[number]]: number | null };
  for (const field of fields) out[field as T[number]] = null;
  return out;
}

const HOST_CPU_FIELDS = [
  "busyPercent",
  "userPercent",
  "systemPercent",
  "iowaitPercent",
  "stealPercent",
  "softirqPercent",
  "pressureSomePercent",
  "saturatedCoreCount",
  "procsRunning",
  "procsBlocked",
  "processCount",
] as const satisfies readonly (keyof HostCpuMetrics)[];
const HOST_KERNEL_FIELDS = [
  "fileHandlesUsedPercent",
  "conntrackUsedPercent",
] as const satisfies readonly (keyof HostKernelMetrics)[];
const HOST_MEMORY_FIELDS = [
  "usedBytes",
  "cachedFilesBytes",
  "swapUsedBytes",
  "pressureSomePercent",
  "pressureFullPercent",
  "swapInBytesPerSecond",
  "swapOutBytesPerSecond",
  "majorPageFaultsPerSecond",
] as const satisfies readonly (keyof HostMemoryMetrics)[];
const HOST_STORAGE_FIELDS = [
  "ioPressureSomePercent",
  "ioPressureFullPercent",
  "diskReadBytesPerSecond",
  "diskWriteBytesPerSecond",
  "diskLatencyMs",
  "rootFilesystemAvailableBytes",
  "rootFilesystemFreeInodes",
] as const satisfies readonly (keyof HostStorageMetrics)[];
const HOST_NETWORK_FIELDS = [
  "tcpRetransmitPercent",
  "softnetDropsPerSecond",
] as const satisfies readonly (keyof HostNetworkMetrics)[];

function baseInput(
  overrides: Partial<MetricsSampleInput> = {},
): MetricsSampleInput {
  return {
    metadata: {
      version: 6,
      sampledAt: "2026-01-01T00:00:00.000Z",
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: {
      cpu: zeroFields(HOST_CPU_FIELDS),
      kernel: zeroFields(HOST_KERNEL_FIELDS),
      memory: zeroFields(HOST_MEMORY_FIELDS),
      storage: zeroFields(HOST_STORAGE_FIELDS),
      network: zeroFields(HOST_NETWORK_FIELDS),
    },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
    ...overrides,
  };
}

function buildSample(
  overrides: Partial<MetricsSampleInput> = {},
  identity: { serverId?: string; receivedAt?: string } = {},
): AuthenticatedMetricsSample {
  const built = buildMetricsSample(baseInput(overrides));
  return {
    ...built,
    serverId: identity.serverId ?? "11111111-2222-4333-8444-555555555555",
    receivedAt: identity.receivedAt ?? "2026-01-01T00:00:01.000Z",
  };
}

function pointFor(
  points: AnalyticsEngineDataPointLike[],
  family: string,
  page = 0,
): AnalyticsEngineDataPointLike {
  const found = points.find(
    (point) =>
      point.blobs[AE_BLOB_FAMILY_INDEX] === family &&
      point.blobs[AE_BLOB_PAGE_INDEX] === String(page),
  );
  if (!found) {
    throw new Error(`no point found for family ${family} page ${page}`);
  }
  return found;
}

function mkNic(deviceId: string, seed = 0) {
  return {
    deviceId,
    receiveBytesPerSecond: seed + 1,
    transmitBytesPerSecond: seed + 2,
    receiveErrorsPerSecond: 0,
    transmitErrorsPerSecond: 0,
    receiveDropsPerSecond: 0,
    transmitDropsPerSecond: 0,
  };
}

function mkGpu(gpuId: string) {
  return {
    gpuId,
    utilizationPercent: 1,
    memoryUsedBytes: 1,
    memoryActivityPercent: 1,
    pcieReceiveBytesPerSecond: 1,
    pcieTransmitBytesPerSecond: 1,
    throttlePercent: 1,
  };
}

function mkFilesystem(filesystemId: string) {
  return { filesystemId, availableBytes: 1, freeInodes: 1 };
}

/** 1..19 in physical slot order: the 7 CPU fields, then the 12 memory fields. */
function mkDiagnostics(): MetricsSampleInput["diagnostics"] {
  return {
    cpu: {
      averageFrequencyMHz: 1,
      minimumFrequencyMHz: 2,
      maximumFrequencyMHz: 3,
      contextSwitchesPerSecond: 4,
      interruptsPerSecond: 5,
      forksPerSecond: 6,
      cpuIrqPercent: 7,
    },
    memory: {
      memoryFreeBytes: 8,
      cachedBytes: 9,
      anonPagesBytes: 10,
      slabReclaimableBytes: 11,
      slabUnreclaimableBytes: 12,
      dirtyBytes: 13,
      writebackBytes: 14,
      shmemBytes: 15,
      committedAsBytes: 16,
      pageScanDirectPerSecond: 17,
      pageScanKswapdPerSecond: 18,
      compactionStallsPerSecond: 19,
    },
  };
}

function mkBlock(deviceId: string) {
  return {
    deviceId,
    readBytesPerSecond: 1,
    writeBytesPerSecond: 1,
    readOpsPerSecond: 1,
    writeOpsPerSecond: 1,
    readLatencyMs: 1,
    writeLatencyMs: 1,
    utilizationPercent: 1,
    queueDepth: 1,
  };
}

function mkSignal(signalId: string, value: number) {
  return { signalId, kind: "temp", value };
}

// ---------------------------------------------------------------------------
// host.system / host.io exact positions
// ---------------------------------------------------------------------------

it("host.system doubles: exact field order double1..double19, double20 = interval", () => {
  const sample = buildSample({
    host: {
      cpu: {
        busyPercent: 1,
        userPercent: 2,
        systemPercent: 3,
        iowaitPercent: 4,
        stealPercent: 5,
        softirqPercent: 6,
        pressureSomePercent: 7,
        saturatedCoreCount: 8,
        procsRunning: 9,
        procsBlocked: 10,
        processCount: 11,
      },
      kernel: { fileHandlesUsedPercent: 98, conntrackUsedPercent: 99 },
      memory: {
        usedBytes: 12,
        cachedFilesBytes: 13,
        swapUsedBytes: 14,
        pressureSomePercent: 15,
        pressureFullPercent: 16,
        swapInBytesPerSecond: 17,
        swapOutBytesPerSecond: 18,
        majorPageFaultsPerSecond: 19,
      },
      storage: zeroFields(HOST_STORAGE_FIELDS),
      network: zeroFields(HOST_NETWORK_FIELDS),
    },
  });
  const point = pointFor(buildMetricsDataPoints(sample), AE_FAMILY_HOST_SYSTEM);
  // 19 slots exactly: all 11 host.cpu fields then all 8 host.memory fields.
  // v6 has no overflow — host.kernel (98/99 here) rides host.io instead.
  assertEquals(
    point.doubles.slice(0, 19),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  );
  assertEquals(point.doubles[AE_DOUBLE_INTERVAL_INDEX], 60);
  assertEquals(point.blobs[AE_BLOB_KIND_INDEX], AE_KIND_METRICS);
  assertEquals(point.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX], "");
});

it("host.io doubles: kernel + storage + spare + network + spare, then 6 NIC-embedded slots, then interval", () => {
  const sample = buildSample({
    host: {
      cpu: zeroFields(HOST_CPU_FIELDS),
      kernel: { fileHandlesUsedPercent: 21, conntrackUsedPercent: 22 },
      memory: zeroFields(HOST_MEMORY_FIELDS),
      storage: {
        ioPressureSomePercent: 1,
        ioPressureFullPercent: 2,
        diskReadBytesPerSecond: 3,
        diskWriteBytesPerSecond: 4,
        diskLatencyMs: 1.8,
        rootFilesystemAvailableBytes: 8,
        rootFilesystemFreeInodes: 9,
      },
      network: { tcpRetransmitPercent: 10, softnetDropsPerSecond: 11 },
    },
    networks: [
      {
        deviceId: "eth0",
        receiveBytesPerSecond: 100,
        transmitBytesPerSecond: 200,
        receiveErrorsPerSecond: 1,
        transmitErrorsPerSecond: 2,
        receiveDropsPerSecond: 3,
        transmitDropsPerSecond: 4,
      },
      {
        deviceId: "eth1",
        receiveBytesPerSecond: 300,
        transmitBytesPerSecond: 400,
        receiveErrorsPerSecond: 0,
        transmitErrorsPerSecond: 0,
        receiveDropsPerSecond: 0,
        transmitDropsPerSecond: 0,
      },
    ],
  });
  const point = pointFor(buildMetricsDataPoints(sample), AE_FAMILY_HOST_IO);
  // double1..double2: host.kernel.
  assertEquals(point.doubles.slice(0, 2), [21, 22]);
  // double3..double9: host.storage.
  assertEquals(point.doubles.slice(2, 9), [1, 2, 3, 4, 1.8, 8, 9]);
  // double10: reserved spare, left at the sentinel.
  assertEquals(point.doubles[9], AE_MISSING_METRIC_SENTINEL);
  // double11..double12: host.network.
  assertEquals(point.doubles.slice(10, 12), [10, 11]);
  // double13: reserved spare.
  assertEquals(point.doubles[12], AE_MISSING_METRIC_SENTINEL);
  // double14..double16 — NIC0: receive=100, transmit=200, problem=1+2+3+4=10.
  assertEquals(point.doubles.slice(13, 16), [100, 200, 10]);
  // double17..double19 — NIC1: receive=300, transmit=400, problem=0.
  assertEquals(point.doubles.slice(16, 19), [300, 400, 0]);
  assertEquals(point.doubles[AE_DOUBLE_INTERVAL_INDEX], 60);
});

it("host.io NIC-embedded problem-packets is sentinel when any input NIC field is missing", () => {
  const sample = buildSample({
    networks: [
      {
        deviceId: "eth0",
        receiveBytesPerSecond: 1,
        transmitBytesPerSecond: 2,
        receiveErrorsPerSecond: null,
        transmitErrorsPerSecond: 0,
        receiveDropsPerSecond: 0,
        transmitDropsPerSecond: 0,
      },
    ],
  });
  const point = pointFor(buildMetricsDataPoints(sample), AE_FAMILY_HOST_IO);
  // NIC0's combined problem-packets slot (double16).
  assertEquals(point.doubles[15], AE_MISSING_METRIC_SENTINEL);
});

it("host.io with no networks: NIC-embedded slots are sentinel", () => {
  const sample = buildSample();
  const point = pointFor(buildMetricsDataPoints(sample), AE_FAMILY_HOST_IO);
  for (let i = 13; i <= 18; i++) {
    assertEquals(point.doubles[i], AE_MISSING_METRIC_SENTINEL);
  }
});

it("sentinel-fill: missing host metrics map to AE_MISSING_METRIC_SENTINEL, never 0", () => {
  const sample = buildSample();
  const points = buildMetricsDataPoints(sample);
  const hostSystem = pointFor(points, AE_FAMILY_HOST_SYSTEM);
  for (let i = 0; i < 19; i++) {
    assertEquals(hostSystem.doubles[i], AE_MISSING_METRIC_SENTINEL);
  }
});

// ---------------------------------------------------------------------------
// Presence gating — empty arrays emit nothing
// ---------------------------------------------------------------------------

it("presence-gated families emit no rows when their source array is empty", () => {
  const sample = buildSample();
  const points = buildMetricsDataPoints(sample);
  assertEquals(points.length, 2);
  assertEquals(
    points.map((p) => p.blobs[AE_BLOB_FAMILY_INDEX]),
    [AE_FAMILY_HOST_SYSTEM, AE_FAMILY_HOST_IO],
  );
});

// ---------------------------------------------------------------------------
// Page-count formulas for per-entity families
// ---------------------------------------------------------------------------

function countPointsOfFamily(
  points: AnalyticsEngineDataPointLike[],
  family: string,
): number {
  return points.filter((p) => p.blobs[AE_BLOB_FAMILY_INDEX] === family).length;
}

const PAGE_TEST_COUNTS = [0, 1, 2, 3, 4, 8, 16];

it("gpu page-count formula: ceil(count/3) pages (width 6, floor(19/6)=3/page)", () => {
  for (const count of PAGE_TEST_COUNTS) {
    const gpus = Array.from({ length: count }, (_, i) => mkGpu(`gpu${i}`));
    const sample = buildSample({ gpus });
    const points = buildMetricsDataPoints(sample);
    const expected = count === 0 ? 0 : Math.ceil(count / 3);
    assertEquals(
      countPointsOfFamily(points, AE_FAMILY_GPU),
      expected,
      `count=${count}`,
    );
  }
});

it("block page-count formula: ceil(count/2) pages (width 8, floor(19/8)=2/page)", () => {
  for (const count of PAGE_TEST_COUNTS) {
    const blockDevices = Array.from(
      { length: count },
      (_, i) => mkBlock(`sd${i}`),
    );
    const sample = buildSample({ blockDevices });
    const points = buildMetricsDataPoints(sample);
    const expected = count === 0 ? 0 : Math.ceil(count / 2);
    assertEquals(
      countPointsOfFamily(points, AE_FAMILY_BLOCK),
      expected,
      `count=${count}`,
    );
  }
});

it("filesystem page-count formula: ceil(count/9) pages (width 2, floor(19/2)=9/page)", () => {
  for (const count of PAGE_TEST_COUNTS) {
    const filesystems = Array.from(
      { length: count },
      (_, i) => mkFilesystem(`fs${i}`),
    );
    const sample = buildSample({ filesystems });
    const points = buildMetricsDataPoints(sample);
    const expected = count === 0 ? 0 : Math.ceil(count / 9);
    assertEquals(
      countPointsOfFamily(points, AE_FAMILY_FILESYSTEM),
      expected,
      `count=${count}`,
    );
  }
});

it("network page-count formula: extras beyond the first two embedded NICs, ceil(extra/3) pages", () => {
  for (const extra of PAGE_TEST_COUNTS) {
    const networks = [
      mkNic("eth0"),
      mkNic("eth1"),
      ...Array.from({ length: extra }, (_, i) => mkNic(`ethX${i}`)),
    ];
    const sample = buildSample({ networks });
    const points = buildMetricsDataPoints(sample);
    const expected = extra === 0 ? 0 : Math.ceil(extra / 3);
    assertEquals(
      countPointsOfFamily(points, AE_FAMILY_NETWORK),
      expected,
      `extra=${extra}`,
    );
  }
});

it("network with fewer than 2 total NICs never emits a network page", () => {
  for (const networks of [[], [mkNic("eth0")]]) {
    const sample = buildSample({ networks });
    const points = buildMetricsDataPoints(sample);
    assertEquals(countPointsOfFamily(points, AE_FAMILY_NETWORK), 0);
  }
});

// ---------------------------------------------------------------------------
// hardware.physical — blob10 signal-id round-trip
// ---------------------------------------------------------------------------

it("hardware.physical: blob10 carries comma-joined signalIds in positional order, one page for <=19 signals", () => {
  const signals = Array.from({ length: 5 }, (_, i) => mkSignal(`sig${i}`, i));
  const sample = buildSample({ hardwareSignals: signals });
  const points = buildMetricsDataPoints(sample);
  const page0 = pointFor(points, AE_FAMILY_HARDWARE_PHYSICAL, 0);
  assertEquals(
    page0.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX],
    "sig0,sig1,sig2,sig3,sig4",
  );
  assertEquals(page0.doubles.slice(0, 5), [0, 1, 2, 3, 4]);
});

it("hardware.physical: 20 signals span two pages (19/page), each page's ids match its doubles", () => {
  const signals = Array.from({ length: 20 }, (_, i) => mkSignal(`sig${i}`, i));
  const sample = buildSample({ hardwareSignals: signals });
  const points = buildMetricsDataPoints(sample);
  assertEquals(countPointsOfFamily(points, AE_FAMILY_HARDWARE_PHYSICAL), 2);
  const page0 = pointFor(points, AE_FAMILY_HARDWARE_PHYSICAL, 0);
  const page1 = pointFor(points, AE_FAMILY_HARDWARE_PHYSICAL, 1);
  assertEquals(
    page0.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX].split(",").length,
    19,
  );
  assertEquals(page1.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX], "sig19");
  assertEquals(page1.doubles[0], 19);
});

// ---------------------------------------------------------------------------
// Shape assertion
// ---------------------------------------------------------------------------

it("every produced point has exactly AE_DOUBLE_COUNT doubles and AE_BLOB_COUNT blobs", () => {
  const sample = buildSample({
    networks: [mkNic("eth0"), mkNic("eth1"), mkNic("eth2")],
    gpus: [mkGpu("gpu0")],
    filesystems: [mkFilesystem("fs0")],
    blockDevices: [mkBlock("sd0")],
    hardwareSignals: [mkSignal("sig0", 1)],
    ingressSources: [
      {
        sourceId: "caddy0",
        sourceKind: "caddy",
        requests: 1,
        responses2xx: 1,
        responses3xx: 0,
        responses4xx: 0,
        responses5xx: 0,
        requestErrors: 0,
        requestBytes: 1,
        responseBytes: 1,
        requestDurationSecondsSum: 0.1,
        bucket10ms: 1,
        bucket50ms: 1,
        bucket100ms: 1,
        bucket500ms: 1,
        bucket1s: 1,
        bucket5s: 1,
        requestsInFlight: 1,
        upstreamsHealthy: 1,
        upstreamsTotal: 1,
        retries: 0,
      },
    ],
    databaseProxies: [
      {
        sourceId: "proxysql0",
        sourceKind: "proxysql",
        queries: 1,
        slowQueries: 0,
        queryLatencyMsAvg: 0,
        backendLatencyMsAvg: 0,
        activeTransactions: 0,
        clientConnections: 1,
        clientConnectionsCreated: 1,
        clientConnectionsAborted: 0,
        connectionsRejectedMaxConns: 0,
        backendConnections: 1,
        backendConnectionsCreated: 1,
        backendConnectionsAborted: 0,
        connectionErrors: 0,
        backendsUp: 1,
        backendsTotal: 1,
        bytesFromBackends: 1,
        bytesToBackends: 1,
      },
    ],
    events: [
      {
        eventId: "evt1",
        at: "2026-01-01T00:00:00.500Z",
        kind: "nic_link_down",
        severity: "warning",
        entityId: "eth0",
        source: "daemon",
        payload: { reason: "carrier lost" },
      },
    ],
  });
  const points = buildMetricsDataPoints(sample);
  for (const point of points) {
    assertEquals(point.doubles.length, AE_DOUBLE_COUNT);
    assertEquals(point.blobs.length, AE_BLOB_COUNT);
    assertEquals(point.indexes, [sample.serverId]);
  }
});

it("managed.ingress / managed.database_proxy: one unpaged row per entry, blob10 = sourceId", () => {
  const sample = buildSample({
    ingressSources: [
      {
        sourceId: "caddy0",
        sourceKind: "caddy",
        requests: 5,
        responses2xx: 4,
        responses3xx: 0,
        responses4xx: 0,
        responses5xx: 0,
        requestErrors: 0,
        requestBytes: 1,
        responseBytes: 1,
        requestDurationSecondsSum: 0.1,
        bucket10ms: 1,
        bucket50ms: 1,
        bucket100ms: 1,
        bucket500ms: 1,
        bucket1s: 1,
        bucket5s: 1,
        requestsInFlight: 1,
        upstreamsHealthy: 1,
        upstreamsTotal: 1,
        retries: 0,
      },
    ],
    databaseProxies: [
      {
        sourceId: "proxysql0",
        sourceKind: "proxysql",
        queries: 7,
        slowQueries: 0,
        queryLatencyMsAvg: 0,
        backendLatencyMsAvg: 0,
        activeTransactions: 0,
        clientConnections: 1,
        clientConnectionsCreated: 1,
        clientConnectionsAborted: 0,
        connectionsRejectedMaxConns: 0,
        backendConnections: 1,
        backendConnectionsCreated: 1,
        backendConnectionsAborted: 0,
        connectionErrors: 0,
        backendsUp: 1,
        backendsTotal: 1,
        bytesFromBackends: 1,
        bytesToBackends: 1,
      },
    ],
  });
  const points = buildMetricsDataPoints(sample);
  const ingress = pointFor(points, "managed.ingress", 0);
  assertEquals(ingress.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX], "caddy0");
  assertEquals(ingress.doubles[0], 5);
  const dbProxy = pointFor(points, "managed.database_proxy", 0);
  assertEquals(dbProxy.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX], "proxysql0");
  assertEquals(dbProxy.doubles[0], 7);
});

it("managed.ingress: two sources sharing sourceKind stay distinct rows keyed by sourceId", () => {
  const sample = buildSample({
    ingressSources: [
      {
        sourceId: "caddy-1",
        sourceKind: "caddy",
        requests: 5,
        responses2xx: 4,
        responses3xx: 0,
        responses4xx: 0,
        responses5xx: 0,
        requestErrors: 0,
        requestBytes: 1,
        responseBytes: 1,
        requestDurationSecondsSum: 0.1,
        bucket10ms: 1,
        bucket50ms: 1,
        bucket100ms: 1,
        bucket500ms: 1,
        bucket1s: 1,
        bucket5s: 1,
        requestsInFlight: 1,
        upstreamsHealthy: 1,
        upstreamsTotal: 1,
        retries: 0,
      },
      {
        sourceId: "caddy-2",
        sourceKind: "caddy",
        requests: 15,
        responses2xx: 4,
        responses3xx: 0,
        responses4xx: 0,
        responses5xx: 0,
        requestErrors: 0,
        requestBytes: 1,
        responseBytes: 1,
        requestDurationSecondsSum: 0.1,
        bucket10ms: 1,
        bucket50ms: 1,
        bucket100ms: 1,
        bucket500ms: 1,
        bucket1s: 1,
        bucket5s: 1,
        requestsInFlight: 1,
        upstreamsHealthy: 1,
        upstreamsTotal: 1,
        retries: 0,
      },
    ],
  });
  const points = buildMetricsDataPoints(sample);
  const ingressPoints = points.filter(
    (point) => point.blobs[AE_BLOB_FAMILY_INDEX] === "managed.ingress",
  );
  assertEquals(ingressPoints.length, 2);
  const ids = ingressPoints.map((point) =>
    point.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX]
  ).sort();
  assertEquals(ids, ["caddy-1", "caddy-2"]);
});

it("events: one event-kind row per entry, entityId/payload/severity carried", () => {
  const sample = buildSample({
    events: [
      {
        eventId: "evt1",
        at: "2026-01-01T00:00:00.500Z",
        kind: "nic_link_down",
        severity: "warning",
        entityId: "eth0",
        source: "daemon",
        payload: { reason: "carrier lost" },
      },
    ],
  });
  const points = buildMetricsDataPoints(sample);
  const event = points.find((p) => p.blobs[AE_BLOB_KIND_INDEX] === "event")!;
  assertEquals(event.blobs[AE_BLOB_FAMILY_INDEX], "nic_link_down");
  assertEquals(
    event.blobs[AE_BLOB_SAMPLED_AT_INDEX],
    "2026-01-01T00:00:00.500Z",
  );
  assertEquals(event.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX], "daemon");
  assertEquals(event.blobs[AE_BLOB_EVENT_ENTITY_ID_INDEX], "eth0");
  assertEquals(event.blobs[AE_BLOB_EVENT_ID_INDEX], "evt1");
  assertEquals(JSON.parse(event.blobs[AE_BLOB_EVENT_PAYLOAD_INDEX]), {
    reason: "carrier lost",
  });
  assertEquals(event.blobs[AE_BLOB_STATUS_OR_EVENT_REASON_INDEX], "warning");
  // Every metric slot stays sentinel — an event row carries no measurements —
  // but double20 carries the interval weight like every other row. v4 left it
  // at the sentinel, contradicting its own documented invariant.
  assertEquals(event.doubles[AE_DOUBLE_INTERVAL_INDEX], 60);
  for (const value of event.doubles.slice(0, AE_DOUBLE_INTERVAL_INDEX)) {
    assertEquals(value, AE_MISSING_METRIC_SENTINEL);
  }
});

// ---------------------------------------------------------------------------
// host.diagnostics
// ---------------------------------------------------------------------------

it("host.diagnostics is absent from a sample with no diagnostics set", () => {
  const sample = buildSample();
  const points = buildMetricsDataPoints(sample);
  assertEquals(countPointsOfFamily(points, AE_FAMILY_HOST_DIAGNOSTICS), 0);
});

it("host.diagnostics present: +1 row, 7 CPU fields then 12 memory fields, filling double1..double19", () => {
  const sample = buildSample({ diagnostics: mkDiagnostics() });
  const points = buildMetricsDataPoints(sample);
  assertEquals(countPointsOfFamily(points, AE_FAMILY_HOST_DIAGNOSTICS), 1);
  const point = pointFor(points, AE_FAMILY_HOST_DIAGNOSTICS);
  assertEquals(
    point.doubles.slice(0, 19),
    Array.from({ length: 19 }, (_, i) => i + 1),
  );
  assertEquals(point.doubles[AE_DOUBLE_INTERVAL_INDEX], 60);
  // Host-scoped: no entity identity on blob10.
  assertEquals(point.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX], "");
});

it("v5 emitted two detail rows where v6 emits one merged diagnostics row", () => {
  const points = buildMetricsDataPoints(
    buildSample({ diagnostics: mkDiagnostics() }),
  );
  assertEquals(points.length, 3);
});

// ---------------------------------------------------------------------------
// managed.router
// ---------------------------------------------------------------------------

/** The 12 real router fields, valued 1..12 in declared slot order. */
function mkRouter() {
  return {
    backendsUp: 1,
    backendsTotal: 2,
    servicesTotal: 3,
    routersTotal: 4,
    retries: 5,
    backendErrors5xx: 6,
    backendLatencyMsAvg: 7,
    backendRequests: 8,
    httpOpenConnections: 9,
    configReloads: 10,
    configLastReloadAgeSeconds: 11,
    tlsCertSoonestExpiryDays: 12,
  };
}

it("managed.router is absent from a sample with no router set", () => {
  const points = buildMetricsDataPoints(buildSample());
  assertEquals(countPointsOfFamily(points, AE_FAMILY_MANAGED_ROUTER), 0);
});

it("managed.router present: +1 unpaged row, fields at their declared slots with spares left sentinel", () => {
  const sample = buildSample({ router: mkRouter() });
  const points = buildMetricsDataPoints(sample);
  assertEquals(countPointsOfFamily(points, AE_FAMILY_MANAGED_ROUTER), 1);
  const point = pointFor(points, AE_FAMILY_MANAGED_ROUTER);

  // Slots 1..8 are the traffic group, contiguous.
  assertEquals(point.doubles.slice(0, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
  // double9 is a reserved spare — it must stay at the sentinel, not shift the
  // next field up.
  assertEquals(point.doubles[8], AE_MISSING_METRIC_SENTINEL);
  assertEquals(point.doubles[9], 9);
  // double11..double12 spare.
  assertEquals(point.doubles[10], AE_MISSING_METRIC_SENTINEL);
  assertEquals(point.doubles[11], AE_MISSING_METRIC_SENTINEL);
  assertEquals(point.doubles.slice(12, 15), [10, 11, 12]);
  // double16..double19 trail as spares.
  assertEquals(
    point.doubles.slice(15, 19),
    Array.from({ length: 4 }, () => AE_MISSING_METRIC_SENTINEL),
  );
  assertEquals(point.doubles[AE_DOUBLE_INTERVAL_INDEX], 60);
  // Host-wide: no entity identity on blob10, exactly like host.diagnostics.
  assertEquals(point.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX], "");
});

it("managed.router: a null field stays sentinel rather than becoming 0", () => {
  const sample = buildSample({
    router: { ...mkRouter(), tlsCertSoonestExpiryDays: null },
  });
  const point = pointFor(
    buildMetricsDataPoints(sample),
    AE_FAMILY_MANAGED_ROUTER,
  );
  assertEquals(point.doubles[14], AE_MISSING_METRIC_SENTINEL);
});

it("managed.router fields resolve to their physical double index through doubleIndexForHostField", () => {
  // The router is host-wide, so the read path resolves it the same way
  // host.diagnostics does — by family + double index, never by sourceId.
  assertEquals(doubleIndexForHostField("router", "backendsUp"), {
    family: "managed.router",
    doubleIndex: 0,
  });
  // Past the double9 spare.
  assertEquals(doubleIndexForHostField("router", "httpOpenConnections"), {
    family: "managed.router",
    doubleIndex: 9,
  });
  // Past the double11/12 spares.
  assertEquals(doubleIndexForHostField("router", "tlsCertSoonestExpiryDays"), {
    family: "managed.router",
    doubleIndex: 14,
  });
  assertThrows(
    () => doubleIndexForHostField("router", "notARealRouterField"),
    TypeError,
    "no AE v6 host double slot",
  );
});

// ---------------------------------------------------------------------------
// managed.storage / managed.docker
// ---------------------------------------------------------------------------

/**
 * The 19 storage slots valued 1..19 in declared order: the 7 flat fields,
 * then each engine's 4 census readings. Every value is distinct so a slot
 * swap between two engines cannot pass.
 */
function mkStorage() {
  const engine = (base: number) => ({
    instancesRunning: base,
    instancesHealthy: base + 1,
    connectionsUsed: base + 2,
    connectionsMax: base + 3,
  });
  return {
    hostingUsedBytes: 1,
    backupUsedBytes: 2,
    dockerUsedBytes: 3,
    logsUsedBytes: 4,
    hostingFreeBytes: 5,
    backupFreeBytes: 6,
    logsFreeBytes: 7,
    postgres: engine(8),
    mysql: engine(12),
    mariadb: engine(16),
  };
}

/** The 10 real Docker breakdown fields, valued 1..10 in declared slot order. */
function mkDockerUsage() {
  return {
    layersBytes: 1,
    imagesCount: 2,
    imagesReclaimableBytes: 3,
    containersBytes: 4,
    containersCount: 5,
    volumesBytes: 6,
    volumesCount: 7,
    volumesReclaimableBytes: 8,
    buildCacheBytes: 9,
    buildCacheReclaimableBytes: 10,
  };
}

it("managed.storage and managed.docker are absent from a sample carrying neither", () => {
  const points = buildMetricsDataPoints(buildSample());
  assertEquals(countPointsOfFamily(points, AE_FAMILY_MANAGED_STORAGE), 0);
  assertEquals(countPointsOfFamily(points, AE_FAMILY_MANAGED_DOCKER), 0);
});

it("managed.storage present: +1 unpaged row filling all 19 slots with no spares", () => {
  const sample = buildSample({ storage: mkStorage() });
  const points = buildMetricsDataPoints(sample);
  assertEquals(countPointsOfFamily(points, AE_FAMILY_MANAGED_STORAGE), 1);
  const point = pointFor(points, AE_FAMILY_MANAGED_STORAGE);

  // The nested per-engine groups flatten into contiguous slots after the 7
  // flat fields — postgres at double8..11, mysql at double12..15, mariadb at
  // double16..19.
  assertEquals(
    point.doubles.slice(0, 19),
    Array.from({ length: 19 }, (_, i) => i + 1),
  );
  assertEquals(point.doubles[AE_DOUBLE_INTERVAL_INDEX], 60);
  // Host-wide: no entity identity on blob10.
  assertEquals(point.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX], "");
});

it("managed.storage: a null per-engine field stays sentinel rather than becoming 0", () => {
  const storage = mkStorage();
  const sample = buildSample({
    storage: { ...storage, mysql: { ...storage.mysql, connectionsMax: null } },
  });
  const point = pointFor(
    buildMetricsDataPoints(sample),
    AE_FAMILY_MANAGED_STORAGE,
  );
  assertEquals(point.doubles[14], AE_MISSING_METRIC_SENTINEL);
});

it("managed.docker present: +1 unpaged row, 10 fields then 9 sentinel spares", () => {
  const sample = buildSample({ dockerUsage: mkDockerUsage() });
  const points = buildMetricsDataPoints(sample);
  assertEquals(countPointsOfFamily(points, AE_FAMILY_MANAGED_DOCKER), 1);
  const point = pointFor(points, AE_FAMILY_MANAGED_DOCKER);

  assertEquals(
    point.doubles.slice(0, 10),
    Array.from({ length: 10 }, (_, i) => i + 1),
  );
  assertEquals(
    point.doubles.slice(10, 19),
    Array.from({ length: 9 }, () => AE_MISSING_METRIC_SENTINEL),
  );
  assertEquals(point.doubles[AE_DOUBLE_INTERVAL_INDEX], 60);
  assertEquals(point.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX], "");
});

it("the two storage families resolve to their physical double index through doubleIndexForHostField", () => {
  assertEquals(doubleIndexForHostField("storage", "hostingUsedBytes"), {
    family: "managed.storage",
    doubleIndex: 0,
  });
  // Flattened per-engine names, never the bare nested field name.
  assertEquals(doubleIndexForHostField("storage", "postgresInstancesRunning"), {
    family: "managed.storage",
    doubleIndex: 7,
  });
  assertEquals(doubleIndexForHostField("storage", "mariadbConnectionsMax"), {
    family: "managed.storage",
    doubleIndex: 18,
  });
  assertThrows(
    () => doubleIndexForHostField("storage", "instancesRunning"),
    TypeError,
    "no AE v6 host double slot",
  );
  assertEquals(doubleIndexForHostField("dockerUsage", "layersBytes"), {
    family: "managed.docker",
    doubleIndex: 0,
  });
  assertEquals(
    doubleIndexForHostField("dockerUsage", "buildCacheReclaimableBytes"),
    {
      family: "managed.docker",
      doubleIndex: 9,
    },
  );
});

it("emission order puts the two storage families after managed.router and before host.diagnostics", () => {
  const sample = buildSample({
    router: mkRouter(),
    storage: mkStorage(),
    dockerUsage: mkDockerUsage(),
    diagnostics: mkDiagnostics(),
  });
  const families = buildMetricsDataPoints(sample).map(
    (point) => point.blobs[AE_BLOB_FAMILY_INDEX],
  );
  assertEquals(families, [
    "host.system",
    "host.io",
    AE_FAMILY_MANAGED_ROUTER,
    AE_FAMILY_MANAGED_STORAGE,
    AE_FAMILY_MANAGED_DOCKER,
    "host.diagnostics",
  ]);
});

// ---------------------------------------------------------------------------
// Module-load invariant failure cases
// ---------------------------------------------------------------------------

it("assertFieldOrderMatchesDescriptors throws on an unknown field", () => {
  assertThrows(
    () =>
      _internalFieldMap.assertFieldOrderMatchesDescriptors("test", "gpu", [
        "utilizationPercent",
        "notARealGpuField",
      ]),
    TypeError,
    "unknown field",
  );
});

it("assertFieldOrderMatchesDescriptors throws when a descriptor field is missing", () => {
  assertThrows(
    () =>
      _internalFieldMap.assertFieldOrderMatchesDescriptors(
        "test",
        "filesystem",
        [
          "availableBytes",
        ],
      ),
    TypeError,
    "missing descriptor field",
  );
});

it("assertFieldOrderMatchesDescriptors throws on a duplicate field", () => {
  assertThrows(
    () =>
      _internalFieldMap.assertFieldOrderMatchesDescriptors(
        "test",
        "filesystem",
        [
          "availableBytes",
          "availableBytes",
        ],
      ),
    TypeError,
    "duplicate",
  );
});

it("assertWithinPageBudget throws when a field-order array exceeds the 19-slot page budget", () => {
  assertThrows(
    () => _internalFieldMap.assertWithinPageBudget("test family", 20),
    TypeError,
    "exceeding the 19-slot",
  );
});

// ---------------------------------------------------------------------------
// Analytics Engine invocation limit
// ---------------------------------------------------------------------------

/** A sample at the contract's own array caps — the largest thing the wire can carry. */
function maxCardinalitySample() {
  const n = <T>(count: number, make: (i: number) => T): T[] =>
    Array.from({ length: count }, (_, i) => make(i));
  return buildSample({
    networks: n(64, (i) => ({
      deviceId: `eth${i}`,
      receiveBytesPerSecond: 1,
      transmitBytesPerSecond: 1,
      receiveErrorsPerSecond: 0,
      transmitErrorsPerSecond: 0,
      receiveDropsPerSecond: 0,
      transmitDropsPerSecond: 0,
    })),
    filesystems: n(
      64,
      (i) => ({ filesystemId: `fs${i}`, availableBytes: 1, freeInodes: 1 }),
    ),
    blockDevices: n(64, (i) => ({
      deviceId: `blk${i}`,
      readBytesPerSecond: 1,
      writeBytesPerSecond: 1,
      readOpsPerSecond: 1,
      writeOpsPerSecond: 1,
      readLatencyMs: 1,
      writeLatencyMs: 1,
      utilizationPercent: 1,
      queueDepth: 1,
    })),
    gpus: n(64, (i) => ({
      gpuId: `gpu${i}`,
      utilizationPercent: 1,
      memoryUsedBytes: 1,
      memoryActivityPercent: 1,
      pcieReceiveBytesPerSecond: 1,
      pcieTransmitBytesPerSecond: 1,
      throttlePercent: 1,
    })),
    hardwareSignals: n(
      64,
      (i) => ({ signalId: `sig${i}`, kind: "temperature", value: 1 }),
    ),
    // Cardinality here is scrape-derived and gated only by a boolean in the
    // capability plan, which is what makes the limit reachable in practice.
    ingressSources: n(64, (i) => ({
      sourceId: `ing${i}`,
      sourceKind: "caddy",
      requests: 1,
      responses2xx: 1,
      responses3xx: 1,
      responses4xx: 1,
      responses5xx: 1,
      requestErrors: null,
      requestBytes: 1,
      responseBytes: 1,
      requestDurationSecondsSum: 1,
      bucket10ms: 1,
      bucket50ms: 1,
      bucket100ms: 1,
      bucket500ms: 1,
      bucket1s: 1,
      bucket5s: 1,
      requestsInFlight: 1,
      upstreamsHealthy: 1,
      upstreamsTotal: 1,
      retries: null,
    })),
    databaseProxies: n(64, (i) => ({
      sourceId: `db${i}`,
      sourceKind: "proxysql",
      queries: 1,
      slowQueries: 1,
      queryLatencyMsAvg: 1,
      backendLatencyMsAvg: 1,
      activeTransactions: 1,
      clientConnections: 1,
      clientConnectionsCreated: 1,
      clientConnectionsAborted: 1,
      connectionsRejectedMaxConns: 1,
      backendConnections: 1,
      backendConnectionsCreated: 1,
      backendConnectionsAborted: 1,
      connectionErrors: 1,
      backendsUp: 1,
      backendsTotal: 1,
      bytesFromBackends: 1,
      bytesToBackends: 1,
    })),
    events: n(128, (i) => ({
      eventId: `e${i}`,
      at: "2026-01-01T00:00:00.000Z",
      kind: "oom_kill" as const,
      severity: "warning" as const,
    })),
  });
}

it("never emits more data points than Analytics Engine accepts per invocation", () => {
  // Exceeding the limit rejects the *whole* invocation, so this has to be a
  // structural guarantee rather than something the capability plan happens to
  // keep us under. At the contract's own caps an unguarded sample produces 355.
  const points = buildMetricsDataPoints(maxCardinalitySample());
  assertEquals(points.length, AE_MAX_DATA_POINTS_PER_INVOCATION);
});

it("keeps the mandatory host rows when shedding for the invocation limit", () => {
  const points = buildMetricsDataPoints(maxCardinalitySample());
  assertEquals(countPointsOfFamily(points, AE_FAMILY_HOST_SYSTEM), 1);
  assertEquals(countPointsOfFamily(points, AE_FAMILY_HOST_IO), 1);
});

it("keeps every event row when shedding, since a dropped transition is lost forever", () => {
  // An entity row is one missing point in a continuous series; an event is a
  // discrete state change nothing re-reports.
  const points = buildMetricsDataPoints(maxCardinalitySample());
  const events = points.filter((point) =>
    point.blobs[AE_BLOB_KIND_INDEX] === AE_KIND_EVENT
  );
  assertEquals(events.length, 128);
});

it("leaves a normally-sized sample completely untouched", () => {
  const sample = buildSample({ networks: [mkNic("eth0")] });
  const points = buildMetricsDataPoints(sample);
  assertEquals(points.length < AE_MAX_DATA_POINTS_PER_INVOCATION, true);
  assertEquals(points.length, 2);
});

it("leaves blob8 empty when capabilityPlanGeneration is unset", () => {
  const points = buildMetricsDataPoints(
    buildSample({ networks: [mkNic("eth0")] }),
  );
  assertEquals(points.length > 0, true);
  for (const point of points) {
    assertEquals(point.blobs[AE_BLOB_CAPABILITY_PLAN_GENERATION_INDEX], "");
  }
});

it("stamps blob8 from capabilityPlanGeneration", () => {
  const sample = {
    ...buildSample({ networks: [mkNic("eth0")] }),
    capabilityPlanGeneration: 7,
  };
  const points = buildMetricsDataPoints(sample);
  assertEquals(points.length > 0, true);
  for (const point of points) {
    assertEquals(point.blobs[AE_BLOB_CAPABILITY_PLAN_GENERATION_INDEX], "7");
  }
});
