/**
 * Tier model: what each capability-plan knob costs, and what a proposed tier
 * ladder costs per server.
 *
 *   deno task metrics:tiers
 *
 * Every number is measured by running the real hosted ingest write path
 * (plan truncation -> AE packing) over an hour of 60 s samples. Cadence is
 * not a plan knob (A7): every family writes on every sample. Live 10 s
 * samples are cached, never durably stored (A3d), so they are not in this
 * model. Self-hosted ingest skips truncation and is not priced here.
 */
import { buildMetricsSample } from "../src/daemon/metrics/contract.ts";
import {
  METRICS_BASELINE_INTERVAL_SECONDS,
  type MetricsCapabilityPlan,
  platformDefaultMetricsCapabilityPlan,
  truncateSampleToCapabilityPlan,
} from "../src/daemon/metrics/capability-plan.ts";
import { buildMetricsDataPoints } from "../src/daemon/metrics/backends/cloudflare/field-map.ts";
import type {
  MetricsSample,
  MetricsSampleInput,
} from "../src/daemon/metrics/contract.ts";
import type { SlotMapping } from "../src/daemon/metrics/types.ts";

const SERVER_ID = "11111111-2222-4333-8444-555555555555";
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const HOURS_PER_MONTH = 24 * 30;
const INCLUDED = 10_000_000;
const PRICE_PER_M = 0.25;

function pad(v: string, w: number) {
  return v.length >= w ? v : v + " ".repeat(w - v.length);
}
function padLeft(v: string, w: number) {
  return v.length >= w ? v : " ".repeat(w - v.length) + v;
}

// ---------------------------------------------------------------------------
// A maximally-equipped host: every family populated well beyond any tier, so
// the plan is the only thing deciding what gets stored.
// ---------------------------------------------------------------------------

function richHost(
  ingressCount = 2,
  dbProxyCount = 1,
  eventCount = 0,
): MetricsSampleInput {
  const n = <T>(count: number, make: (i: number) => T): T[] =>
    Array.from({ length: count }, (_, i) => make(i));
  const zeroHost = {
    cpu: {
      busyPercent: 10,
      userPercent: 5,
      systemPercent: 3,
      iowaitPercent: 1,
      stealPercent: 0,
      softirqPercent: 1,
      pressureSomePercent: 2,
      saturatedCoreCount: 1,
      procsRunning: 2,
      procsBlocked: 0,
      processCount: 300,
    },
    kernel: { fileHandlesUsedPercent: 5, conntrackUsedPercent: 5 },
    memory: {
      usedBytes: 1,
      cachedFilesBytes: 1,
      swapUsedBytes: 0,
      pressureSomePercent: 0,
      pressureFullPercent: 0,
      swapInBytesPerSecond: 0,
      swapOutBytesPerSecond: 0,
      majorPageFaultsPerSecond: 0,
    },
    storage: {
      ioPressureSomePercent: 1,
      ioPressureFullPercent: 0,
      diskReadBytesPerSecond: 1,
      diskWriteBytesPerSecond: 1,
      diskLatencyMs: 1,
      rootFilesystemAvailableBytes: 1,
      rootFilesystemFreeInodes: 1,
    },
    network: { tcpRetransmitPercent: 0, softnetDropsPerSecond: 0 },
  };
  return {
    metadata: {
      version: 6,
      sampledAt: new Date(BASE_MS).toISOString(),
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: zeroHost,
    networks: n(16, (i) => ({
      deviceId: `eth${i}`,
      receiveBytesPerSecond: 1,
      transmitBytesPerSecond: 1,
      receiveErrorsPerSecond: 0,
      transmitErrorsPerSecond: 0,
      receiveDropsPerSecond: 0,
      transmitDropsPerSecond: 0,
    })),
    filesystems: n(
      24,
      (i) => ({ filesystemId: `fs${i}`, availableBytes: 1, freeInodes: 1 }),
    ),
    blockDevices: n(24, (i) => ({
      deviceId: `blk${i}`,
      readBytesPerSecond: 1,
      writeBytesPerSecond: 1,
      readOpsPerSecond: 1,
      writeOpsPerSecond: 1,
      readLatencyMs: 1,
      writeLatencyMs: 1,
      utilizationPercent: 1,
      queueDepth: 0.01,
    })),
    gpus: n(8, (i) => ({
      gpuId: `gpu${i}`,
      utilizationPercent: 1,
      memoryUsedBytes: 1,
      memoryActivityPercent: 1,
      pcieReceiveBytesPerSecond: 1,
      pcieTransmitBytesPerSecond: 1,
      throttlePercent: 0,
    })),
    // GPU temperature/memory temperature/power and drive temperature are
    // `hardware.physical` signals now, not `gpus`/`blockDevices` fields — a
    // real host of this shape would report 19 board/CPU sensors *plus* 3 per
    // GPU and 1 per service drive. The plan caps this family at
    // `physicalHardwareSignalSlots` (19 in BASE), so the extra signals are
    // modelled arithmetically in section 7 rather than reported here.
    hardwareSignals: n(19, (i) => ({
      signalId: `signal:chip:s${i}`,
      kind: "temperature",
      value: 40,
    })),
    // Realistic: the daemon has one ingress adapter (site Caddy) per site and
    // one database-proxy adapter (ProxySQL). The hosting Traefik is no longer
    // an ingress source — it reports as the singleton `router` below, one row
    // regardless of `ingressCount`.
    ingressSources: n(ingressCount, (i) => ({
      sourceId: `ing${i}`,
      sourceKind: "caddy",
      requests: 1,
      responses2xx: 1,
      responses3xx: 0,
      responses4xx: 0,
      responses5xx: 0,
      requestErrors: null,
      requestBytes: 1,
      responseBytes: 1,
      requestDurationSecondsSum: 0.1,
      bucket10ms: 1,
      bucket50ms: 1,
      bucket100ms: 1,
      bucket500ms: 1,
      bucket1s: 1,
      bucket5s: 1,
      requestsInFlight: 0,
      upstreamsHealthy: 1,
      upstreamsTotal: 1,
      retries: null,
    })),
    databaseProxies: n(dbProxyCount, (i) => ({
      sourceId: `db${i}`,
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
    })),
    events: n(eventCount, (i) => ({
      eventId: `evt${i}`,
      at: new Date(BASE_MS).toISOString(),
      kind: "oom_kill" as const,
      severity: "warning" as const,
    })),
    diagnostics: {
      cpu: {
        averageFrequencyMHz: 2000,
        minimumFrequencyMHz: 1000,
        maximumFrequencyMHz: 3000,
        contextSwitchesPerSecond: 1,
        interruptsPerSecond: 1,
        forksPerSecond: 1,
        cpuIrqPercent: 1,
      },
      memory: {
        memoryFreeBytes: 1,
        cachedBytes: 1,
        anonPagesBytes: 1,
        slabReclaimableBytes: 1,
        slabUnreclaimableBytes: 1,
        dirtyBytes: 1,
        writebackBytes: 1,
        shmemBytes: 1,
        committedAsBytes: 1,
        pageScanDirectPerSecond: 1,
        pageScanKswapdPerSecond: 1,
        compactionStallsPerSecond: 1,
      },
    },
    // Host-wide singleton: exactly one `managed.router` row per sample on any
    // host running the shared hosting ingress, never scaled by a count.
    router: {
      backendsUp: 1,
      backendsTotal: 1,
      servicesTotal: 1,
      routersTotal: 1,
      retries: 0,
      backendErrors5xx: 0,
      backendLatencyMsAvg: 3,
      backendRequests: 1,
      httpOpenConnections: 1,
      configReloads: 0,
      configLastReloadAgeSeconds: 60,
      tlsCertSoonestExpiryDays: 45,
    },
  };
}

const RICH = richHost();

function slotMappingFor(plan: MetricsCapabilityPlan): SlotMapping {
  return {
    normalNicSlots: Array.from(
      { length: plan.normalNicSlots },
      (_, i) => `eth${i}`,
    ),
    fabricDeviceIds: [],
    rootFilesystemId: null,
    gpuPageOrder: [],
    filesystemPageOrder: [],
    blockPageOrder: [],
    hardwareSignalPageOrder: [],
  };
}

/** Rows written in one hour under `plan`, at the shipped 60 s baseline. */
function rowsPerHour(
  plan: MetricsCapabilityPlan,
  host: MetricsSampleInput = RICH,
): number {
  const slotMapping = slotMappingFor(plan);
  const interval = METRICS_BASELINE_INTERVAL_SECONDS;
  const ticks = Math.round(3600 / interval);
  let rows = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    const built = buildMetricsSample(host);
    const sample: MetricsSample = {
      ...built,
      metadata: {
        ...built.metadata,
        sampledAt: new Date(BASE_MS + tick * interval * 1000).toISOString(),
        intervalSeconds: interval,
      },
    };
    const planned = truncateSampleToCapabilityPlan(sample, plan, slotMapping);
    rows += buildMetricsDataPoints(
      {
        ...planned,
        serverId: SERVER_ID,
        receivedAt: planned.metadata.sampledAt,
      },
      slotMapping,
    ).length;
  }
  return rows;
}

/**
 * Points emitted by a single sample — every family writes on every tick, so
 * the peak equals the typical sample. This is what has to clear Analytics
 * Engine's 250-points-per-invocation ceiling.
 */
function peakPointsPerSample(
  plan: MetricsCapabilityPlan,
  host: MetricsSampleInput = RICH,
): number {
  const slotMapping = slotMappingFor(plan);
  const built = buildMetricsSample(host);
  const sample: MetricsSample = {
    ...built,
    metadata: {
      ...built.metadata,
      sampledAt: new Date(BASE_MS).toISOString(),
      intervalSeconds: METRICS_BASELINE_INTERVAL_SECONDS,
    },
  };
  const planned = truncateSampleToCapabilityPlan(sample, plan, slotMapping);
  return buildMetricsDataPoints(
    { ...planned, serverId: SERVER_ID, receivedAt: planned.metadata.sampledAt },
    slotMapping,
  ).length;
}

const BASE: MetricsCapabilityPlan = {
  ...platformDefaultMetricsCapabilityPlan("physical", "hosted"),
  normalNicSlots: 2,
  detailedBlockDeviceSlots: 2,
  // The AE gpu row packs 3 GPUs per page (6 fields each, since the thermals
  // moved to `hardware.physical`), so GPUs 1-3 cost the same one row. The
  // base tier stays at 2 as a ladder decision; the first GPU step that
  // actually adds a row is the 4th.
  gpuSlots: 2,
  extraFilesystemSlots: 0,
  physicalHardwareSignalSlots: 19,
};

console.log(
  "METRICS TIER MODEL — every number measured from the real write path\n",
);
console.log(
  "Baseline: 2 NICs, 2 drives, 2 GPUs, sensors on. `host.diagnostics` is",
);
console.log(
  "always on in v6, so it is inside BASE rather than a knob priced below.",
);
console.log(
  "The synthetic host carries a GPU, 2 drives, 19 sensors and all three",
);
console.log(
  "traffic adapters, so its row rate is well above the ~180 rows/h a plain",
);
console.log(
  "web VM costs in `metrics:budget` — that machine has none of those.\n",
);
console.log(
  "Cadence is fixed at 60 s (A7) and live 10 s samples are not stored (A3d).",
);
console.log(
  "The knobs below are entitlement cardinality only — not interval.\n",
);

// ---------------------------------------------------------------------------
// 1. What each knob costs
// ---------------------------------------------------------------------------

const KNOBS: { label: string; plan: MetricsCapabilityPlan }[] = [
  {
    label: "+2 drives (4 total)",
    plan: { ...BASE, detailedBlockDeviceSlots: 4 },
  },
  {
    label: "+2 drives again (6)",
    plan: { ...BASE, detailedBlockDeviceSlots: 6 },
  },
  { label: "+1 GPU (3 total)", plan: { ...BASE, gpuSlots: 3 } },
  { label: "+2 GPUs (4 total)", plan: { ...BASE, gpuSlots: 4 } },
  { label: "+2 NICs (4 total)", plan: { ...BASE, normalNicSlots: 4 } },
  { label: "+6 NICs (8 total)", plan: { ...BASE, normalNicSlots: 8 } },
  { label: "+9 extra filesystems", plan: { ...BASE, extraFilesystemSlots: 9 } },
  {
    label: "+18 extra filesystems",
    plan: { ...BASE, extraFilesystemSlots: 18 },
  },

  {
    label: "sensors off (VM)",
    plan: { ...BASE, physicalHardwareSignalSlots: 0 },
  },
  {
    label: "ingress off (2 sources)",
    plan: { ...BASE, managedIngressEnabled: false },
  },
  {
    label: "db proxy off (1 source)",
    plan: { ...BASE, databaseProxyMetricsEnabled: false },
  },
  {
    label: "both traffic families off",
    plan: {
      ...BASE,
      managedIngressEnabled: false,
      databaseProxyMetricsEnabled: false,
    },
  },
];

/** How a knob's row-count delta reads in the table's verdict column. */
function costVerdict(delta: number): string {
  if (delta === 0) return "free";
  const magnitude = Math.abs(delta);
  if (magnitude < METRICS_BASELINE_INTERVAL_SECONDS) return "cheap";
  if (magnitude >= METRICS_BASELINE_INTERVAL_SECONDS * 2) return "EXPENSIVE";
  return "moderate";
}

/** How a tier's remaining points-per-sample budget reads in the table. */
function headroomLabel(headroom: number): string {
  if (headroom < 0) return "OVER — sheds";
  if (headroom < 40) return "TIGHT";
  return "ok";
}

const baseRows = rowsPerHour(BASE);
console.log("=== 1. Marginal cost of each knob ===\n");
console.log(
  pad("Change from base", 28) +
    padLeft("rows/h", 9) +
    padLeft("delta", 9) +
    padLeft("/mo delta", 12) +
    "  verdict",
);
console.log("-".repeat(76));
console.log(
  pad("BASE (2 NIC/2 drive/1 GPU)", 28) +
    padLeft(String(baseRows), 9) +
    padLeft("—", 9) +
    padLeft("—", 12),
);
for (const knob of KNOBS) {
  const rows = rowsPerHour(knob.plan);
  const delta = rows - baseRows;
  const monthly = delta * HOURS_PER_MONTH;
  const verdict = costVerdict(delta);
  console.log(
    pad(knob.label, 28) +
      padLeft(String(rows), 9) +
      padLeft((delta >= 0 ? "+" : "") + delta, 9) +
      padLeft((monthly >= 0 ? "+" : "") + monthly.toLocaleString("en-US"), 12) +
      "  " +
      verdict,
  );
}

// ---------------------------------------------------------------------------
// 2. Proposed ladder
//
// The commercial ladder is priced on MACHINE SIZE (cores/RAM), not on a feature
// bundle. So metrics entitlements are sized to what a machine of that size can
// physically have: a 4-core/16 GB VPS cannot hold 24 drives, and a 256-core box
// should not be told it may only watch 2. Every family writes on every 60 s
// sample (A7); live 10 s frames stay off the store (A3d). Depth (sensors,
// filesystems, diagnostics) is on at every tier because doubles inside a row
// are free — what scales with price is entity cardinality.
//
// Only three dimensions are tiered: NICs, drives, GPUs. Ingress/db-proxy
// cardinality is FIXED at the collector source ids, so there is nothing there
// to sell. There is no NUMA family.
// ---------------------------------------------------------------------------

type Tier = {
  name: string;
  shape: string;
  price: number;
  plan: MetricsCapabilityPlan;
};

// Depth is on at every tier (A7 — no slow-tier discount). Sensors are not a
// boolean; they are governed by `physicalHardwareSignalSlots` (19, inherited
// from BASE) and by `machineClass`, so a VM gets none at any price.
const DEPTH = {} as const;

const TIERS: Tier[] = [
  {
    name: "S1",
    shape: "<=4c / 16 GB",
    price: 5,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 2,
      detailedBlockDeviceSlots: 2,
      gpuSlots: 2,
      extraFilesystemSlots: 9,
    },
  },
  {
    name: "S2",
    shape: "<=10c / 32 GB",
    price: 7.5,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 2,
      detailedBlockDeviceSlots: 4,
      gpuSlots: 2,
      extraFilesystemSlots: 9,
    },
  },
  {
    name: "S3",
    shape: "<=16c / 64 GB",
    price: 10,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 5,
      detailedBlockDeviceSlots: 6,
      gpuSlots: 2,
      extraFilesystemSlots: 9,
    },
  },
  {
    name: "S4",
    shape: "<=32c / 128 GB",
    price: 15,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 5,
      detailedBlockDeviceSlots: 8,
      gpuSlots: 4,
      extraFilesystemSlots: 9,
    },
  },
  {
    name: "S5",
    shape: "<=64c / 256 GB",
    price: 20,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 8,
      detailedBlockDeviceSlots: 12,
      gpuSlots: 4,
      extraFilesystemSlots: 18,
    },
  },
  {
    name: "S6",
    shape: "<=128c / 512 GB",
    price: 35,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 8,
      detailedBlockDeviceSlots: 16,
      gpuSlots: 6,
      extraFilesystemSlots: 18,
    },
  },
  {
    name: "S7",
    shape: "<=256c / 1 TB",
    price: 50,
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 11,
      detailedBlockDeviceSlots: 20,
      gpuSlots: 8,
      extraFilesystemSlots: 18,
    },
  },
  {
    name: "SX",
    shape: ">256c / >1 TB",
    price: 0, // contact-us tier — no list price
    plan: {
      ...BASE,
      ...DEPTH,
      normalNicSlots: 11,
      detailedBlockDeviceSlots: 24,
      gpuSlots: 8,
      extraFilesystemSlots: 18,
    },
  },
];

console.log("\n=== 2. Entitlements per price tier (measured) ===\n");
console.log(
  pad("Tier", 6) +
    pad("machine", 17) +
    padLeft("$/mo", 7) +
    pad("  NIC/drv/GPU/fs", 20) +
    padLeft("rows/h", 8) +
    padLeft("writes/mo", 12),
);
console.log("-".repeat(72));
for (const tier of TIERS) {
  // Price the sources the tier grants, not the fixture's 2+1 — otherwise the
  // ladder undercounts exactly the dimension it is meant to gate.
  const rows = rowsPerHour(tier.plan, RICH);
  const shape =
    `${tier.plan.normalNicSlots}/${tier.plan.detailedBlockDeviceSlots}/${tier.plan.gpuSlots}/${tier.plan.extraFilesystemSlots}`;
  console.log(
    pad(tier.name, 6) +
      pad(tier.shape, 17) +
      padLeft("$" + tier.price.toFixed(2), 7) +
      pad("  " + shape, 20) +
      padLeft(String(rows), 8) +
      padLeft((rows * HOURS_PER_MONTH).toLocaleString("en-US"), 12),
  );
}

// ---------------------------------------------------------------------------
// 3. What metrics cost us as a share of what the tier charges
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2b. What a VM saves: `machineClass: 'virtual'` zeroes physicalHardwareSignalSlots,
//     so the whole `hardware.physical` family disappears.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2a. Arithmetic packing note: ingress + database-proxy + router are separate
// families today, so they cost one row each per 60 s sample. Packing them
// into one page would save 2 rows/sample; that family does not exist yet.
// ---------------------------------------------------------------------------

const TRAFFIC_ROWS_SAVED_PER_SAMPLE = 2;
const SAMPLES_PER_HOUR = 3600 / METRICS_BASELINE_INTERVAL_SECONDS;

console.log("\n=== 2a. Projection: one traffic row instead of three ===\n");
console.log(
  pad("Tier", 6) +
    padLeft("v5 rows/h", 11) +
    padLeft("v6 rows/h", 11) +
    padLeft("saved/h", 9) +
    padLeft("v6 writes/mo", 14) +
    padLeft("cut", 7),
);
console.log("-".repeat(58));
for (const tier of TIERS) {
  const v5 = rowsPerHour(tier.plan);
  const savedPerHour = TRAFFIC_ROWS_SAVED_PER_SAMPLE * SAMPLES_PER_HOUR;
  const v6 = v5 - savedPerHour;
  console.log(
    pad(tier.name, 6) +
      padLeft(String(v5), 11) +
      padLeft(String(v6), 11) +
      padLeft(String(savedPerHour), 9) +
      padLeft((v6 * HOURS_PER_MONTH).toLocaleString("en-US"), 14) +
      padLeft(((savedPerHour / v5) * 100).toFixed(0) + "%", 7),
  );
}
console.log(
  "\n  Every family already writes on every 60 s sample (A7). The saving",
);
console.log(
  "  comes from packing 3 sources into 1 row, not from writing less often.",
);

console.log("\n=== 2b. Physical vs virtual (same tier, same hardware) ===\n");
console.log(
  pad("Tier", 6) +
    padLeft("physical/h", 12) +
    padLeft("virtual/h", 11) +
    padLeft("saved/h", 9) +
    padLeft("rows/sample", 13),
);
console.log("-".repeat(52));
for (const tier of TIERS) {
  const phys = rowsPerHour(tier.plan);
  const virt = rowsPerHour({ ...tier.plan, physicalHardwareSignalSlots: 0 });
  const saved = phys - virt;
  console.log(
    pad(tier.name, 6) +
      padLeft(String(phys), 12) +
      padLeft(String(virt), 11) +
      padLeft(String(saved), 9) +
      padLeft(`${saved / SAMPLES_PER_HOUR} /sample`, 13),
  );
}
console.log(
  "\n  A VM has no fan/voltage/PSU/temperature sensors, so `hardware.physical`",
);
console.log(
  "  is never emitted. All 19 signals pack into one page, so the saving is",
);
console.log(
  "  exactly one row per 60 s sample (A7 — there is no slow tier).",
);

console.log("\n=== 3. AE cost vs revenue, per server ===\n");
console.log(
  pad("Tier", 6) +
    padLeft("$/mo", 8) +
    padLeft("writes/mo", 12) +
    padLeft("AE cost", 10) +
    padLeft("% of price", 12) +
    padLeft("free until", 12),
);
console.log("-".repeat(60));
for (const tier of TIERS) {
  const monthly = rowsPerHour(tier.plan, RICH) * HOURS_PER_MONTH;
  // Marginal cost: past the 10M free allowance every write bills, so the honest
  // per-server figure for a fleet of any real size is the unsubsidised rate.
  const cost = (monthly / 1_000_000) * PRICE_PER_M;
  console.log(
    pad(tier.name, 6) +
      padLeft("$" + tier.price.toFixed(2), 8) +
      padLeft(monthly.toLocaleString("en-US"), 12) +
      padLeft("$" + cost.toFixed(3), 10) +
      padLeft(((cost / tier.price) * 100).toFixed(2) + "%", 12) +
      padLeft(Math.floor(INCLUDED / monthly) + " srv", 12),
  );
}

// ---------------------------------------------------------------------------
// 4. The hard limit that actually binds: 250 data points per Worker invocation
// ---------------------------------------------------------------------------

console.log(
  "\n=== 4. Worst single sample vs the 250-point invocation limit ===\n",
);
console.log(
  pad("Tier", 6) +
    padLeft("hardware", 10) +
    padLeft("+ sources", 11) +
    padLeft("+ 128 evt", 11) +
    padLeft("headroom", 10) +
    "  status",
);
console.log("-".repeat(62));
for (const tier of TIERS) {
  const hardwareOnly = peakPointsPerSample(tier.plan, richHost(0, 0, 0));
  const withSources = peakPointsPerSample(tier.plan, RICH);
  const worst = peakPointsPerSample(tier.plan, richHost(2, 1, 128));
  const headroom = 250 - worst;
  console.log(
    pad(tier.name, 6) +
      padLeft(String(hardwareOnly), 10) +
      padLeft(String(withSources), 11) +
      padLeft(String(worst), 11) +
      padLeft(String(headroom), 10) +
      "  " +
      headroomLabel(headroom),
  );
}
console.log(
  "\n  Peak = a typical sample: every family writes on every 60 s tick (A7).",
);
console.log(
  '  "+ sources" adds the three fixed traffic rows (caddy, traefik, proxysql);',
);
console.log(
  '  "+ 128 evt" adds a full event burst on top. Every tier keeps >90 points of',
);
console.log(
  "  headroom, so the 250-point invocation ceiling does not constrain the ladder.",
);

// ---------------------------------------------------------------------------
// 5. Cadence is not a cost lever (A3d / A7).
//
// A7 deleted per-family cadence and ingest decimation: every family writes on
// every 60 s sample. A3d keeps live (10 s) samples in the live-sample buffer,
// never Analytics Engine, so a live lease does not multiply writes. Slowing
// the baseline or demoting families to a 300 s tier is not current behaviour.
// Entitlement cardinality is the remaining hosted cost control.
// ---------------------------------------------------------------------------

console.log("\n=== 5. Cadence is not a cost lever ===\n");
console.log(
  "  A7: every family writes on every 60 s sample; there is no slow tier.",
);
console.log(
  "  A3d: live 10 s samples are cached, never written, so a live lease adds",
);
console.log(
  "  +0 durable rows. Hypothetical 30 s / 120 s / 300 s cadence tiers are",
);
console.log("  omitted — they are not wired.\n");
console.log(
  "  What a REAL S1-shaped machine costs (from metrics:budget):",
);
for (
  const [label, rows] of [
    ["plain VM, no ingress", 120],
    ["VM + site Caddy", 180],
    ["VM + GPU", 240],
  ] as const
) {
  const monthly = rows * HOURS_PER_MONTH;
  const cost = (monthly / 1_000_000) * PRICE_PER_M;
  console.log(
    "    " +
      pad(label, 26) +
      padLeft(String(rows), 6) +
      " rows/h  " +
      padLeft("$" + cost.toFixed(3), 8) +
      padLeft(((cost / 5) * 100).toFixed(2) + "% of $5", 14),
  );
}

// ---------------------------------------------------------------------------
// 6. Keeping all three traffic rows: what full ingress + database detail costs.
// ---------------------------------------------------------------------------

console.log("\n=== 6. Cost of KEEPING three traffic rows (no merge) ===\n");
console.log(
  pad("Tier", 6) +
    padLeft("$/mo", 7) +
    padLeft("3 rows/h", 10) +
    padLeft("1 row/h", 9) +
    padLeft("writes/mo", 12) +
    padLeft("AE cost", 10) +
    padLeft("% price", 9) +
    padLeft("merge saves", 12),
);
console.log("-".repeat(76));
for (const tier of TIERS) {
  const keep = rowsPerHour(tier.plan);
  const merged = keep - TRAFFIC_ROWS_SAVED_PER_SAMPLE * SAMPLES_PER_HOUR;
  const monthly = keep * HOURS_PER_MONTH;
  const cost = (monthly / 1_000_000) * PRICE_PER_M;
  const saving = ((keep - merged) * HOURS_PER_MONTH * PRICE_PER_M) / 1_000_000;
  console.log(
    pad(tier.name, 6) +
      padLeft("$" + tier.price.toFixed(2), 7) +
      padLeft(String(keep), 10) +
      padLeft(String(merged), 9) +
      padLeft(monthly.toLocaleString("en-US"), 12) +
      padLeft("$" + cost.toFixed(3), 10) +
      padLeft(((cost / tier.price) * 100).toFixed(2) + "%", 9) +
      padLeft("$" + saving.toFixed(3), 12),
  );
}
console.log(
  "\n  Keeping all three rows costs a flat +120 rows/hour at every tier —",
);
console.log("  86,400 extra writes/month, $0.0216 per server per month.");

// ---------------------------------------------------------------------------
// 7. Hosted ladder, physical vs virtual.
//
// Measured through the real write path with NO cadence decimation (every family
// on every 60 s sample), then adjusted arithmetically for projected
// hardware.physical entitlement growth:
//   • +1 signal per drive, +3 per GPU (the readings already ride
//     `hardware.physical`; what is projected here is the slot growth, since
//     `physicalHardwareSignalSlots` still truncates at the 19 baseline)
//   • virtual machines emit no hardware.physical rows at all
// ---------------------------------------------------------------------------

function v6RowsPerHour(
  plan: MetricsCapabilityPlan,
  virtual: boolean,
): number {
  const slotMapping = slotMappingFor(plan);
  const interval = METRICS_BASELINE_INTERVAL_SECONDS;
  const ticks = Math.round(3600 / interval);
  let rows = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    const built = buildMetricsSample(RICH);
    const sample: MetricsSample = {
      ...built,
      metadata: {
        ...built.metadata,
        sampledAt: new Date(BASE_MS + tick * interval * 1000).toISOString(),
        intervalSeconds: interval,
      },
    };
    const planned = truncateSampleToCapabilityPlan(
      virtual ? { ...sample, hardwareSignals: [] } : sample,
      virtual ? { ...plan, physicalHardwareSignalSlots: 0 } : plan,
      slotMapping,
    );
    // v6: no decimation — every family every sample
    rows += buildMetricsDataPoints(
      {
        ...planned,
        serverId: SERVER_ID,
        receivedAt: planned.metadata.sampledAt,
      },
      slotMapping,
    ).length;
  }
  const perSample = 3600 / interval;
  const gpus = Math.min(plan.gpuSlots, 8);
  const drives = Math.min(plan.detailedBlockDeviceSlots, 24);
  // No manual host-wide-family adjustment. This carried `+2 * perSample` from
  // v5, standing in for its two separately-gated `cpu.detail`/`memory.detail`
  // rows, which the fixture did not carry. v6 merged those into one always-on
  // `host.diagnostics` row and added `managed.router`; `RICH` now carries both,
  // so the measured `buildMetricsDataPoints` run above already counts them and
  // the old adjustment would double-count.
  // Projected hardware.physical entitlement growth (physical only): the
  // measured run above packs exactly one signal page, because the plan caps
  // the family at `physicalHardwareSignalSlots`. Price what a host entitled
  // to its drive/GPU thermals as well would actually write.
  if (!virtual) {
    const signals = plan.physicalHardwareSignalSlots + drives + 3 * gpus;
    rows += (Math.ceil(signals / 19) - 1) * perSample;
  }
  return rows;
}

console.log(
  "\n=== 7. v6 ladder — physical vs virtual (every family at 60 s) ===\n",
);
console.log(
  pad("Tier", 6) +
    padLeft("$/mo", 7) +
    padLeft("phys/h", 8) +
    padLeft("writes", 11) +
    padLeft("cost", 8) +
    padLeft("%", 7) +
    padLeft("vm/h", 8) +
    padLeft("writes", 11) +
    padLeft("cost", 8) +
    padLeft("%", 7),
);
console.log("-".repeat(81));
for (const tier of TIERS) {
  const ph = v6RowsPerHour(tier.plan, false);
  const vm = v6RowsPerHour(tier.plan, true);
  const fmt = (r: number) => {
    const m = r * HOURS_PER_MONTH;
    const c = (m / 1_000_000) * PRICE_PER_M;
    const pct = tier.price > 0
      ? ((c / tier.price) * 100).toFixed(2) + "%"
      : "custom";
    return (
      padLeft(String(r), 8) +
      padLeft(m.toLocaleString("en-US"), 11) +
      padLeft("$" + c.toFixed(3), 8) +
      padLeft(pct, 7)
    );
  };
  console.log(
    pad(tier.name, 6) +
      padLeft(tier.price > 0 ? "$" + tier.price.toFixed(2) : "custom", 7) +
      fmt(ph) +
      fmt(vm),
  );
}
console.log(
  "\n  Typical machines (v6) — host.system + host.io + diagnostics ×2 + databases + storage = 6 rows,",
);
console.log(
  "  then +1 per ingress adapter, +1 for the shared hosting router (singleton,",
);
console.log(
  "  never scaled by site count), +1 per GPU page, block page, sensor page:",
);
for (
  const [label, rows] of [
    ["Plain VM, no ingress", 360],
    ["VM + site Caddy + hosting router", 480],
    ["VM + GPU + Caddy + hosting router", 540],
    ["Bare-metal mini PC, 2 drives, sensors, Caddy + router", 600],
  ] as const
) {
  const m = rows * HOURS_PER_MONTH;
  const c = (m / 1_000_000) * PRICE_PER_M;
  console.log(
    "    " +
      pad(label, 54) +
      padLeft(String(rows), 5) +
      " rows/h " +
      padLeft("$" + c.toFixed(3), 8) +
      padLeft(((c / 5) * 100).toFixed(2) + "% of $5", 14),
  );
}
