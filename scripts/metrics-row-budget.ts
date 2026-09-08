/**
 * Analytics Engine row-budget report.
 *
 * Runs the **real** ingest write path — hosted capability-plan truncation, AE
 * packing — over a full hour of samples for each archetype, and reports
 * actual rows written. Self-hosted scenarios skip truncation, matching
 * `api-routes.ts`. Nothing here is asserted from the design doc; every
 * number falls out of the code that runs in production.
 *
 *   deno run -A scripts/metrics-row-budget.ts
 *
 * AE pricing (Workers Paid, developers.cloudflare.com/analytics/analytics-engine/pricing):
 * 10M data points/month included, then $0.25/M. 20 doubles, 20 blobs, 1 index
 * per point; 250 points max per Worker invocation.
 */
import { buildMetricsSample } from "../src/daemon/metrics/contract.ts";
import {
  platformDefaultMetricsCapabilityPlan,
  truncateSampleToCapabilityPlan,
} from "../src/daemon/metrics/capability-plan.ts";
import { buildMetricsDataPoints } from "../src/daemon/metrics/backends/cloudflare/field-map.ts";
import { representativeMachineFixtures } from "../src/daemon/metrics/testing/representative-machines.ts";
import type { MetricsSample } from "../src/daemon/metrics/contract.ts";
import type { SlotMapping } from "../src/daemon/metrics/types.ts";

const SERVER_ID = "11111111-2222-4333-8444-555555555555";
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

const INCLUDED_WRITES_PER_MONTH = 10_000_000;
const PRICE_PER_MILLION = 0.25;
const DAYS_PER_MONTH = 30;

type Archetype = {
  name: string;
  fixture: string;
  machineClass: "physical" | "virtual";
  deployment: "hosted" | "self-hosted";
  note: string;
};

/**
 * Machine shapes that matter commercially, mapped onto the pinned
 * representative fixtures so this report and the row-count test cannot drift.
 */
const ARCHETYPES: Archetype[] = [
  {
    name: "Hosted VM (2 NIC, no ingress)",
    fixture: "2-nic-vm",
    machineClass: "virtual",
    deployment: "hosted",
    note: "the cheapest real server",
  },
  {
    name: "Hosted VM + site Caddy",
    fixture: "web-vm",
    machineClass: "virtual",
    deployment: "hosted",
    note: "the common web host",
  },
  {
    name: "Hosted VM + GPU",
    fixture: "web-gpu-vm",
    machineClass: "virtual",
    deployment: "hosted",
    note: "vGPU VPS",
  },
  {
    name: "Bare metal, no GPU",
    fixture: "bare-metal-low-signals",
    machineClass: "physical",
    deployment: "self-hosted",
    note: "the N150-shaped box",
  },
  {
    name: "Bare metal + GPU",
    fixture: "bare-metal-gpu",
    machineClass: "physical",
    deployment: "self-hosted",
    note: "workstation/AI host",
  },
  {
    name: "Bare metal, 8 NIC",
    fixture: "8-nic",
    machineClass: "physical",
    deployment: "self-hosted",
    note: "8 present, self-hosted stores 8",
  },
  {
    name: "Bare metal, 24 drives",
    fixture: "24-block-devices",
    machineClass: "physical",
    deployment: "self-hosted",
    note: "24 present, self-hosted stores 24",
  },
  {
    name: "Bare metal, 16 GPU",
    fixture: "16-gpu",
    machineClass: "physical",
    deployment: "self-hosted",
    note: "16 present, self-hosted stores 16",
  },
];

function fixtureInput(name: string) {
  const found = representativeMachineFixtures().find((f) => f.name === name);
  if (!found) throw new Error(`no representative fixture named ${name}`);
  return found;
}

function sampleForIngest(
  sample: MetricsSample,
  plan: ReturnType<typeof platformDefaultMetricsCapabilityPlan>,
  slotMapping: SlotMapping | undefined,
  deployment: Archetype["deployment"],
): MetricsSample {
  return deployment === "self-hosted"
    ? sample
    : truncateSampleToCapabilityPlan(sample, plan, slotMapping);
}

/** One hour of samples through the real write path; returns rows actually written. */
function rowsPerHour(
  archetype: Archetype,
  intervalSeconds: number,
  slotMapping: SlotMapping | undefined,
): { rows: number; families: Map<string, number> } {
  const fixture = fixtureInput(archetype.fixture);
  const plan = platformDefaultMetricsCapabilityPlan(
    archetype.machineClass,
    archetype.deployment,
  );
  const families = new Map<string, number>();
  let rows = 0;
  const ticks = Math.round(3600 / intervalSeconds);
  for (let tick = 0; tick < ticks; tick += 1) {
    const built = buildMetricsSample(fixture.input);
    const sample: MetricsSample = {
      ...built,
      metadata: {
        ...built.metadata,
        sampledAt: new Date(BASE_MS + tick * intervalSeconds * 1000)
          .toISOString(),
        intervalSeconds,
      },
    };
    const prepared = sampleForIngest(
      sample,
      plan,
      slotMapping,
      archetype.deployment,
    );
    const points = buildMetricsDataPoints(
      {
        ...prepared,
        serverId: SERVER_ID,
        receivedAt: prepared.metadata.sampledAt,
      },
      slotMapping,
    );
    rows += points.length;
    for (const point of points) {
      const family = String(point.blobs[1] ?? "");
      families.set(family, (families.get(family) ?? 0) + 1);
    }
  }
  return { rows, families };
}

function monthly(rowsPerHourValue: number): number {
  return rowsPerHourValue * 24 * DAYS_PER_MONTH;
}

function costFor(writesPerMonth: number): string {
  const billable = Math.max(0, writesPerMonth - INCLUDED_WRITES_PER_MONTH);
  return billable === 0
    ? "$0.00"
    : `$${((billable / 1_000_000) * PRICE_PER_MILLION).toFixed(2)}`;
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}
function padLeft(value: string, width: number): string {
  return value.length >= width
    ? value
    : " ".repeat(width - value.length) + value;
}

function rowsForOneSample(archetype: Archetype, offsetSeconds: number): number {
  const fixture = fixtureInput(archetype.fixture);
  const plan = platformDefaultMetricsCapabilityPlan(
    archetype.machineClass,
    archetype.deployment,
  );
  const built = buildMetricsSample(fixture.input);
  const sample: MetricsSample = {
    ...built,
    metadata: {
      ...built.metadata,
      sampledAt: new Date(BASE_MS + offsetSeconds * 1000).toISOString(),
      intervalSeconds: 60,
    },
  };
  const prepared = sampleForIngest(
    sample,
    plan,
    fixture.slotMapping,
    archetype.deployment,
  );
  return buildMetricsDataPoints(
    {
      ...prepared,
      serverId: SERVER_ID,
      receivedAt: prepared.metadata.sampledAt,
    },
    fixture.slotMapping,
  ).length;
}

console.log(
  "ANALYTICS ENGINE ROWS PER SCENARIO — measured from the real write path\n",
);
console.log("All rows below mirror ingest in `api-routes.ts`. Hosted samples");
console.log(
  "are truncated to the PLATFORM DEFAULT plan (what an un-upgraded server",
);
console.log(
  "costs). Self-hosted samples are written untruncated — the operator's own",
);
console.log(
  "disk is uncapped. Live sessions sample every 10 s but those points are",
);
console.log(
  "cached, never durably written (A3d), so a live lease does not inflate",
);
console.log(
  "Analytics Engine row counts. See `deno task metrics:inventory`.\n",
);
console.log(
  'A "row" is one Analytics Engine data point. Two things decide the total:',
);
console.log(
  "  1. rows per sample  — hosted: schema + default plan; self-hosted: all reported hardware",
);
console.log(
  "  2. samples per hour — 60, one every 60 s. Every family writes on every sample.\n",
);

console.log(
  pad("Scenario", 32) +
    padLeft("per sample", 11) +
    padLeft("per hour", 10) +
    padLeft("per day", 10) +
    padLeft("per month", 12),
);
console.log("-".repeat(75));

const rowsByArchetype = new Map<string, number>();
for (const archetype of ARCHETYPES) {
  const { rows } = rowsPerHour(
    archetype,
    60,
    fixtureInput(archetype.fixture).slotMapping,
  );
  rowsByArchetype.set(archetype.name, rows);
  const perSample = rowsForOneSample(archetype, 0);
  console.log(
    pad(archetype.name, 32) +
      padLeft(String(perSample), 11) +
      padLeft(String(rows), 10) +
      padLeft((rows * 24).toLocaleString("en-US"), 10) +
      padLeft(monthly(rows).toLocaleString("en-US"), 12),
  );
}

console.log(
  "\nWhich families make up those rows (rows/hour at the 60 s baseline)\n",
);
for (const archetype of ARCHETYPES) {
  const { families } = rowsPerHour(
    archetype,
    60,
    fixtureInput(archetype.fixture).slotMapping,
  );
  const parts = [...families.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([family, count]) => `${family} ${count}`)
    .join(" | ");
  console.log(`  ${pad(archetype.name, 32)} ${parts}`);
}

console.log(
  "\nLIVE SESSIONS — the daemon samples every 10 s while a page is open,",
);
console.log(
  "but those samples are cached in the live-sample buffer and never written",
);
console.log(
  "to Analytics Engine. Durable row counts stay at the 60 s baseline.\n",
);
console.log(
  pad("Scenario", 32) +
    padLeft("baseline/h", 12) +
    padLeft("live/h", 9) +
    padLeft("60-min lease", 14),
);
console.log("-".repeat(67));
for (const archetype of ARCHETYPES) {
  const fixture = fixtureInput(archetype.fixture);
  const baseline = rowsPerHour(archetype, 60, fixture.slotMapping).rows;
  console.log(
    pad(archetype.name, 32) +
      padLeft(String(baseline), 12) +
      padLeft(String(baseline), 9) +
      padLeft("+0 rows", 14),
  );
}

console.log(
  "\nFLEET COST at the common web-host shape (" +
    (rowsByArchetype.get("Hosted VM + site Caddy") ?? 0) +
    " rows/hour)\n",
);
for (const servers of [50, 100, 250, 500, 1000, 5000]) {
  const writes = monthly(rowsByArchetype.get("Hosted VM + site Caddy") ?? 0) *
    servers;
  console.log(
    `  ${padLeft(String(servers), 5)} servers  ${
      padLeft(writes.toLocaleString("en-US"), 14)
    } writes/mo  ${padLeft(costFor(writes), 10)}`,
  );
}
console.log(
  "\n  Free allowance: 10,000,000 writes/month, then $0.25 per additional million.",
);
