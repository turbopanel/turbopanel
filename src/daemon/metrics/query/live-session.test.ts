import { assertEquals } from "@std/assert";
import { METRICS_SCHEMA_VERSION } from "../contract.ts";
import type { AuthenticatedMetricsSample } from "../types.ts";
import {
  createMetricsChartCache,
  METRICS_LIVE_SESSION_CACHE_PREFIX,
  resetDenoMetricsChartCacheForTests,
} from "./cache.ts";
import {
  cacheLiveSample,
  clearServerLiveSession,
  hostValuesFromSample,
  isServerLiveSessionActive,
  LIVE_SAMPLE_CACHE_TTL_SECONDS,
  markServerLiveSessionActive,
  mergeLiveSampleIntoEntitySeries,
  mergeLiveSampleIntoHostSeries,
  mergeLiveSampleIntoHostSummary,
  metricsRangeTailIsNow,
  readLiveSample,
} from "./live-session.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function authenticatedSample(input: {
  serverId?: string;
  sampledAt: string;
  intervalSeconds?: number;
  topologyGeneration?: number;
  busyPercent?: number;
  gpu?: { gpuId: string; utilizationPercent: number };
}): AuthenticatedMetricsSample {
  const sampledAt = input.sampledAt;
  return {
    type: "metrics",
    serverId: input.serverId ?? "srv-live",
    receivedAt: sampledAt,
    metadata: {
      version: METRICS_SCHEMA_VERSION,
      sampledAt,
      intervalSeconds: input.intervalSeconds ?? 10,
      sequence: 1,
      topologyGeneration: input.topologyGeneration ?? 1,
      bootGeneration: 0,
    },
    host: {
      cpu: {
        busyPercent: input.busyPercent ?? 42,
        userPercent: null,
        systemPercent: null,
        iowaitPercent: null,
        stealPercent: null,
        softirqPercent: null,
        pressureSomePercent: null,
        saturatedCoreCount: null,
        procsRunning: null,
        procsBlocked: null,
        processCount: null,
      },
      kernel: { fileHandlesUsedPercent: null, conntrackUsedPercent: null },
      memory: {
        usedBytes: null,
        cachedFilesBytes: null,
        swapUsedBytes: null,
        pressureSomePercent: null,
        pressureFullPercent: null,
        swapInBytesPerSecond: null,
        swapOutBytesPerSecond: null,
        majorPageFaultsPerSecond: null,
      },
      storage: {
        ioPressureSomePercent: null,
        ioPressureFullPercent: null,
        diskReadBytesPerSecond: null,
        diskWriteBytesPerSecond: null,
        diskLatencyMs: null,
        rootFilesystemAvailableBytes: null,
        rootFilesystemFreeInodes: null,
      },
      network: { tcpRetransmitPercent: null, softnetDropsPerSecond: null },
    },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: input.gpu
      ? [{
        gpuId: input.gpu.gpuId,
        utilizationPercent: input.gpu.utilizationPercent,
        memoryUsedBytes: null,
        memoryActivityPercent: null,
        pcieReceiveBytesPerSecond: null,
        pcieTransmitBytesPerSecond: null,
        throttlePercent: null,
      }]
      : [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
  };
}

test("live-session marker is set, read, and cleared on the Deno cache", async () => {
  resetDenoMetricsChartCacheForTests();
  const cache = createMetricsChartCache("deno");
  assertEquals(await isServerLiveSessionActive(cache, "srv-1"), false);
  await markServerLiveSessionActive(cache, "srv-1", "lease-a", 60);
  assertEquals(await isServerLiveSessionActive(cache, "srv-1"), true);
  await clearServerLiveSession(cache, "srv-1", "lease-a");
  assertEquals(await isServerLiveSessionActive(cache, "srv-1"), false);
});

test("concurrent live leases keep the marker until the last stop", async () => {
  resetDenoMetricsChartCacheForTests();
  const cache = createMetricsChartCache("deno");
  await markServerLiveSessionActive(cache, "srv-1", "lease-a", 60);
  await markServerLiveSessionActive(cache, "srv-1", "lease-b", 60);
  assertEquals(await isServerLiveSessionActive(cache, "srv-1"), true);

  const sample = authenticatedSample({
    serverId: "srv-1",
    sampledAt: "2026-01-01T00:00:10.000Z",
    busyPercent: 64,
  });
  await cacheLiveSample(cache, sample);
  await clearServerLiveSession(cache, "srv-1", "lease-a");
  assertEquals(await isServerLiveSessionActive(cache, "srv-1"), true);
  assertEquals(
    (await readLiveSample(cache, sample.serverId))?.host.cpu.busyPercent,
    64,
  );

  await clearServerLiveSession(cache, "srv-1", "lease-b");
  assertEquals(await isServerLiveSessionActive(cache, "srv-1"), false);
  assertEquals(await readLiveSample(cache, sample.serverId), null);
});

test("live-sample buffer stores and returns the authenticated sample", async () => {
  resetDenoMetricsChartCacheForTests();
  const cache = createMetricsChartCache("deno");
  await markServerLiveSessionActive(cache, "srv-live", "lease-a", 60);
  const sample = authenticatedSample({
    sampledAt: "2026-01-01T00:00:10.000Z",
    busyPercent: 88,
  });
  await cacheLiveSample(cache, sample);
  const buffered = await readLiveSample(cache, sample.serverId);
  assertEquals(buffered?.host.cpu.busyPercent, 88);
  assertEquals(LIVE_SAMPLE_CACHE_TTL_SECONDS, 15);
});

test("stopping the last live lease drops the buffered sample immediately", async () => {
  resetDenoMetricsChartCacheForTests();
  const cache = createMetricsChartCache("deno");
  await markServerLiveSessionActive(cache, "srv-live", "lease-a", 60);
  const sample = authenticatedSample({
    sampledAt: "2026-01-01T00:00:10.000Z",
    busyPercent: 88,
  });
  await cacheLiveSample(cache, sample);
  await clearServerLiveSession(cache, "srv-live", "lease-a");
  assertEquals(await readLiveSample(cache, sample.serverId), null);
});

test("an expired live-session marker does not overlay a still-cached sample", async () => {
  resetDenoMetricsChartCacheForTests();
  const cache = createMetricsChartCache("deno");
  await markServerLiveSessionActive(cache, "srv-live", "lease-a", 60);
  const sample = authenticatedSample({
    sampledAt: "2026-01-01T00:00:10.000Z",
    busyPercent: 88,
  });
  await cacheLiveSample(cache, sample);
  await cache.set(
    `${METRICS_LIVE_SESSION_CACHE_PREFIX}${sample.serverId}`,
    { leases: [{ id: "lease-a", expiresAtMs: Date.now() - 1 }] },
    60,
  );
  assertEquals(await isServerLiveSessionActive(cache, sample.serverId), false);
  assertEquals(await readLiveSample(cache, sample.serverId), null);
});

test("metricsRangeTailIsNow is true when to is within one live window of now", () => {
  const nowMs = Date.parse("2026-01-01T01:00:00.000Z");
  assertEquals(metricsRangeTailIsNow(nowMs, nowMs, 10), true);
  assertEquals(metricsRangeTailIsNow(nowMs - 10_000, nowMs, 10), true);
  assertEquals(metricsRangeTailIsNow(nowMs - 10_001, nowMs, 10), false);
  assertEquals(metricsRangeTailIsNow(nowMs - 60_000, nowMs, 60), true);
});

test("hostValuesFromSample reads canonical host.cpu fields", () => {
  const sample = authenticatedSample({
    sampledAt: "2026-01-01T00:00:10.000Z",
    busyPercent: 33,
  });
  assertEquals(hostValuesFromSample(sample, ["host.cpu.busyPercent"]), {
    "host.cpu.busyPercent": 33,
  });
});

test("mergeLiveSampleIntoHostSeries appends a newer bucket and replaces the same bucket", () => {
  const sample = authenticatedSample({
    sampledAt: "2026-01-01T00:00:20.000Z",
    busyPercent: 70,
    topologyGeneration: 3,
  });
  const empty = mergeLiveSampleIntoHostSeries(
    {
      kind: "duckdb",
      available: true,
      serverId: "srv-live",
      metrics: ["host.cpu.busyPercent"],
      points: [],
      resolutionSeconds: 10,
      gapCount: 0,
      sampleCount: 0,
    },
    sample,
    10,
  );
  assertEquals(empty.points.length, 1);
  assertEquals(empty.points[0]?.values["host.cpu.busyPercent"], 70);
  assertEquals(empty.sampleCount, 1);
  assertEquals(empty.topologyGenerations, [3]);

  const replaced = mergeLiveSampleIntoHostSeries(empty, sample, 10);
  assertEquals(replaced.points.length, 1);
  assertEquals(replaced.sampleCount, 1);

  const older = mergeLiveSampleIntoHostSeries(
    empty,
    authenticatedSample({
      sampledAt: "2026-01-01T00:00:00.000Z",
      busyPercent: 1,
    }),
    10,
  );
  assertEquals(older.points, empty.points);
});

test("mergeLiveSampleIntoEntitySeries overlays a matching gpu entity", () => {
  const sample = authenticatedSample({
    sampledAt: "2026-01-01T00:00:20.000Z",
    gpu: { gpuId: "gpu0", utilizationPercent: 91 },
  });
  const merged = mergeLiveSampleIntoEntitySeries(
    {
      kind: "duckdb",
      available: true,
      serverId: "srv-live",
      family: "gpu",
      metrics: ["utilizationPercent"],
      resolutionSeconds: 10,
      entities: [
        {
          entityId: "gpu0",
          points: [],
          sampleCount: 0,
          gapCount: 0,
        },
      ],
    },
    sample,
    10,
  );
  assertEquals(merged.entities[0]?.points.length, 1);
  assertEquals(merged.entities[0]?.points[0]?.values.utilizationPercent, 91);
  assertEquals(merged.entities[0]?.sampleCount, 1);
});

test("mergeLiveSampleIntoHostSummary advances latestAt when the live sample is newer", () => {
  const sample = authenticatedSample({ sampledAt: "2026-01-01T00:01:00.000Z" });
  const updated = mergeLiveSampleIntoHostSummary(
    {
      kind: "duckdb",
      available: true,
      serverId: "srv-live",
      sampleCount: 4,
      latestAt: "2026-01-01T00:00:50.000Z",
    },
    sample,
  );
  assertEquals(updated.latestAt, "2026-01-01T00:01:00.000Z");
  assertEquals(updated.sampleCount, 5);

  const skipped = mergeLiveSampleIntoHostSummary(updated, sample);
  assertEquals(skipped.sampleCount, 5);
});
