/**
 * Complete row inventory: every family, how it pages, and what each backend
 * stores for the same sample.
 *
 *   deno task metrics:inventory
 *
 * Analytics Engine and DuckDB store the *same* sample very differently:
 *
 *   - AE packs N entities into one 19-double row (`entitiesPerPage`), because
 *     a data point is the billing unit. 24 drives at 2/page is 12 rows.
 *   - DuckDB writes one real row per entity into a per-family table with
 *     named nullable columns. 24 drives is 24 rows, and rows are free.
 *
 * Both are fed by the same ingest pipeline. Hosted ingest truncates to the
 * capability plan; self-hosted ingest skips truncation and writes the
 * operator's own disk uncapped — see the WARNING this report prints.
 */
import { buildMetricsSample } from "../src/daemon/metrics/contract.ts";
import {
  type MetricsDeploymentKind,
  platformDefaultMetricsCapabilityPlan,
  truncateSampleToCapabilityPlan,
} from "../src/daemon/metrics/capability-plan.ts";
import { buildMetricsDataPoints } from "../src/daemon/metrics/backends/cloudflare/field-map.ts";
import { representativeMachineFixtures } from "../src/daemon/metrics/testing/representative-machines.ts";
import type { MetricsSample } from "../src/daemon/metrics/contract.ts";
import type { SlotMapping } from "../src/daemon/metrics/types.ts";

const SERVER_ID = "11111111-2222-4333-8444-555555555555";
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

function pad(v: string, w: number) {
  return v.length >= w ? v : v + " ".repeat(w - v.length);
}
function padLeft(v: string, w: number) {
  return v.length >= w ? v : " ".repeat(w - v.length) + v;
}

// ---------------------------------------------------------------------------
// 1. Family catalog
// ---------------------------------------------------------------------------

type FamilyRow = {
  family: string;
  width: string;
  perPage: string;
  planCap: string;
  cadence: string;
  duckdbTable: string;
};

/** `floor(19 / width)` — AE gives 19 metric doubles per row, double20 is the interval. */
const AE_METRIC_SLOTS = 19;

const FAMILIES: FamilyRow[] = [
  {
    family: "host.system",
    width: "19 (fixed)",
    perPage: "1 row always",
    planCap: "none — mandatory",
    cadence: "every sample",
    duckdbTable: "server_host_samples",
  },
  {
    family: "host.io",
    width: "19 (fixed)",
    perPage: "1 row always",
    planCap: "none — mandatory",
    cadence: "every sample",
    duckdbTable: "server_host_samples (same row)",
  },
  {
    family: "network",
    width: "6/entity",
    perPage: `${Math.floor(AE_METRIC_SLOTS / 6)} NICs/row`,
    planCap: "normalNicSlots (2 hosted / 11 self-hosted)",
    cadence: "every sample",
    duckdbTable: "server_network_samples",
  },
  {
    family: "filesystem",
    width: "2/entity",
    perPage: `${Math.floor(AE_METRIC_SLOTS / 2)} mounts/row`,
    planCap: "extraFilesystemSlots (0)",
    cadence: "every sample",
    duckdbTable: "server_filesystem_samples",
  },
  {
    family: "block",
    width: "8/entity",
    perPage: `${Math.floor(AE_METRIC_SLOTS / 8)} drives/row`,
    planCap: "detailedBlockDeviceSlots (2)",
    cadence: "every sample",
    duckdbTable: "server_block_samples",
  },
  {
    family: "gpu",
    width: "6/entity",
    perPage: `${Math.floor(AE_METRIC_SLOTS / 6)} GPUs/row`,
    planCap: "gpuSlots (1)",
    cadence: "every sample",
    duckdbTable: "server_gpu_samples",
  },
  {
    family: "hardware.physical",
    width: "1/entity",
    perPage: `${AE_METRIC_SLOTS} sensors/row`,
    planCap: "physicalHardwareSignalSlots (19 physical / 0 VM)",
    cadence: "every sample",
    duckdbTable: "server_hardware_signal_samples",
  },
  {
    family: "managed.ingress",
    width: "17 (unpaged)",
    perPage: "1 row per source",
    planCap: "managedIngressEnabled (bool — no count cap)",
    cadence: "every sample",
    duckdbTable: "server_ingress_samples",
  },
  {
    family: "managed.database_proxy",
    width: "6 (unpaged)",
    perPage: "1 row per source",
    planCap: "databaseProxyMetricsEnabled (bool — no count cap)",
    cadence: "every sample",
    duckdbTable: "server_database_proxy_samples",
  },
  {
    family: "host.diagnostics",
    width: "19 (fixed: 7 cpu + 12 memory)",
    perPage: "1 row",
    planCap: "none — always on in v6",
    cadence: "every sample",
    duckdbTable:
      "server_host_samples (cpu_diagnostics_* columns) + server_memory_diagnostics_samples",
  },
  {
    family: "event",
    width: "n/a (blobs)",
    perPage: "1 row per event",
    planCap: "hardwareHealthEventsEnabled (kind filter)",
    cadence: "every sample",
    duckdbTable: "server_metric_events",
  },
];

console.log(
  "METRICS ROW INVENTORY — every family, measured and cross-checked\n",
);
console.log("=== 1. Family catalog ===\n");
console.log(
  pad("AE family", 24) +
    pad("doubles", 14) +
    pad("AE packing", 18) +
    pad("cadence", 14) +
    "capability-plan cap",
);
console.log("-".repeat(118));
for (const f of FAMILIES) {
  console.log(
    pad(f.family, 24) + pad(f.width, 14) + pad(f.perPage, 18) +
      pad(f.cadence, 14) + f.planCap,
  );
}
console.log(
  "\n  Every physical reading is a `hardware.physical` signal, never an entity\n" +
    "  field: per-GPU temperature/memory temperature/power (+3 signals per GPU)\n" +
    "  and per-service-drive temperature (+1 per drive) moved off the gpu/block\n" +
    "  rows. That is why gpu is 6 wide (3/row, was 9 and 2) and block is 8.\n" +
    "  A GPU- or drive-heavy bare-metal host therefore spends its growth in the\n" +
    "  hardware.physical page budget, capped by physicalHardwareSignalSlots.",
);

console.log("\n=== 2. DuckDB table per family (self-hosted backend) ===\n");
for (const f of FAMILIES) {
  console.log("  " + pad(f.family, 24) + "-> " + f.duckdbTable);
}
console.log(
  "\n  DuckDB writes ONE ROW PER ENTITY with named nullable columns — no paging,\n" +
    "  no positional slots, no sentinel. AE packing is a Cloudflare-only concern.",
);

// ---------------------------------------------------------------------------
// 2. The three cardinality cases
// ---------------------------------------------------------------------------

type Case = {
  name: string;
  fixture: string;
  entities: number;
  family: string;
  perPage: number;
};

const CASES: Case[] = [
  {
    name: "8 NICs",
    fixture: "8-nic",
    entities: 8,
    family: "network",
    perPage: 3,
  },
  {
    name: "24 drives",
    fixture: "24-block-devices",
    entities: 24,
    family: "block",
    perPage: 2,
  },
  {
    name: "16 GPUs",
    fixture: "16-gpu",
    entities: 16,
    family: "gpu",
    perPage: 3,
  },
];

/** The truncated sample's entity array for a case's family — `CASES` only covers these three. */
function plannedEntitiesFor(
  family: string,
  planned: MetricsSample,
): readonly unknown[] {
  if (family === "network") return planned.networks;
  if (family === "block") return planned.blockDevices;
  return planned.gpus;
}

function fixtureFor(name: string) {
  const f = representativeMachineFixtures().find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
}

/** Rows AE writes for one sample, with and without the capability plan applied. */
function aeRows(
  fixtureName: string,
  applyPlan: boolean,
  slotMapping?: SlotMapping,
) {
  const fixture = fixtureFor(fixtureName);
  const built = buildMetricsSample(fixture.input);
  const sample: MetricsSample = {
    ...built,
    metadata: {
      ...built.metadata,
      sampledAt: new Date(BASE_MS).toISOString(),
      intervalSeconds: 60,
    },
  };
  const planned = applyPlan
    ? truncateSampleToCapabilityPlan(sample, fixture.plan, slotMapping)
    : sample;
  const points = buildMetricsDataPoints(
    { ...planned, serverId: SERVER_ID, receivedAt: planned.metadata.sampledAt },
    slotMapping,
  );
  const byFamily = new Map<string, number>();
  for (const p of points) {
    const fam = String(p.blobs[1] ?? "");
    byFamily.set(fam, (byFamily.get(fam) ?? 0) + 1);
  }
  return { total: points.length, byFamily, sample: planned };
}

/**
 * What ingest actually stores for this sample. Hosted ingest truncates to the
 * capability plan; self-hosted ingest writes the operator's own disk uncapped
 * and hands the sample through untouched — see the file header.
 */
function sampleForIngest(
  sample: MetricsSample,
  plan: ReturnType<typeof platformDefaultMetricsCapabilityPlan>,
  slotMapping: SlotMapping | undefined,
  ingest: MetricsDeploymentKind,
): MetricsSample {
  if (ingest === "self-hosted") return sample;
  return truncateSampleToCapabilityPlan(sample, plan, slotMapping);
}

console.log("\n=== 3. High-cardinality handling ===\n");
console.log(
  "The same hardware produces very different row counts depending on",
);
console.log("whether ingest truncates. Three variants shown:");
console.log(
  "  hosted   = hosted ingest + platform default VM plan (2 NIC, 2 drives, 1 GPU)",
);
console.log(
  "  selfhost = self-hosted ingest, untruncated (operator disk is uncapped)",
);
console.log(
  "  granted  = hosted ingest entitled to the fixture's full hardware\n",
);

function keptFor(
  c: Case,
  plan: ReturnType<typeof platformDefaultMetricsCapabilityPlan> | undefined,
  ingest: MetricsDeploymentKind,
) {
  const fixture = fixtureFor(c.fixture);
  const built = buildMetricsSample(fixture.input);
  const sample: MetricsSample = {
    ...built,
    metadata: {
      ...built.metadata,
      sampledAt: new Date(BASE_MS).toISOString(),
      intervalSeconds: 60,
    },
  };
  const effective = plan ?? fixture.plan;
  const planned = sampleForIngest(
    sample,
    effective,
    fixture.slotMapping,
    ingest,
  );
  const points = buildMetricsDataPoints(
    { ...planned, serverId: SERVER_ID, receivedAt: planned.metadata.sampledAt },
    fixture.slotMapping,
  );
  const byFamily = new Map<string, number>();
  for (const p of points) {
    const fam = String(p.blobs[1] ?? "");
    byFamily.set(fam, (byFamily.get(fam) ?? 0) + 1);
  }
  const arr = plannedEntitiesFor(c.family, planned);
  return {
    kept: arr.length,
    aeFamilyRows: byFamily.get(c.family) ?? 0,
    aeTotal: points.length,
  };
}

console.log(
  pad("Case", 12) +
    pad("plan", 10) +
    padLeft("kept", 6) +
    padLeft("AE fam", 8) +
    padLeft("AE total", 10) +
    padLeft("DuckDB", 8) +
    "  arithmetic",
);
console.log("-".repeat(92));
for (const c of CASES) {
  const variants: {
    label: string;
    plan: ReturnType<typeof platformDefaultMetricsCapabilityPlan> | undefined;
    ingest: MetricsDeploymentKind;
  }[] = [
    {
      label: "hosted",
      plan: platformDefaultMetricsCapabilityPlan("virtual", "hosted"),
      ingest: "hosted",
    },
    {
      label: "selfhost",
      plan: platformDefaultMetricsCapabilityPlan("physical", "self-hosted"),
      ingest: "self-hosted",
    },
    // `undefined` plan = the fixture's own entitlement, so nothing is capped
    // away even though hosted ingest still runs truncation.
    { label: "granted", plan: undefined, ingest: "hosted" },
  ];
  for (const { label, plan, ingest } of variants) {
    const { kept, aeFamilyRows, aeTotal } = keptFor(c, plan, ingest);
    const paged = c.family === "network" ? Math.max(0, kept - 2) : kept;
    const expected = paged === 0 ? 0 : Math.ceil(paged / c.perPage);
    const ok = aeFamilyRows === expected ? "ok" : `MISMATCH exp ${expected}`;
    console.log(
      pad(label === "hosted" ? c.name : "", 12) +
        pad(label, 10) +
        padLeft(String(kept), 6) +
        padLeft(String(aeFamilyRows), 8) +
        padLeft(String(aeTotal), 10) +
        padLeft(String(kept), 8) +
        `  ${c.entities} reported -> ceil(${paged}/${c.perPage}) = ${expected} [${ok}]`,
    );
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// 3. Backend divergence
// ---------------------------------------------------------------------------

console.log("\n=== 4. Same sample, both backends ===\n");
for (const c of CASES) {
  const fixture = fixtureFor(c.fixture);
  const measured = aeRows(c.fixture, false, fixture.slotMapping);
  const duck = [...measured.byFamily.entries()].reduce((total, [fam, rows]) => {
    // AE pages entities; DuckDB does not. Recover per-entity counts.
    if (fam === "network") return total + measured.sample.networks.length;
    if (fam === "block") return total + measured.sample.blockDevices.length;
    if (fam === "gpu") return total + measured.sample.gpus.length;
    if (fam === "hardware.physical") {
      return total + measured.sample.hardwareSignals.length;
    }
    if (fam === "filesystem") return total + measured.sample.filesystems.length;
    return total + rows;
  }, 0);
  console.log(
    `  ${pad(c.name, 12)} AE ${
      padLeft(String(measured.total), 3)
    } data points   DuckDB ${padLeft(String(duck), 3)} table rows`,
  );
}

console.log("\n=== 5. Cadence ===\n");
console.log(
  "  Every family writes on every 60 s sample (A7). There is no per-family",
);
console.log("  cadence and no ingest decimation step. Live (10 s) samples are");
console.log("  cached, never durably stored (A3d).");

console.log(
  "\nWARNING: hosted ingest truncates to the capability plan before packing.\n" +
    "Self-hosted ingest skips truncation and writes the operator's own disk\n" +
    "uncapped (slotMapping is still resolved for identity-addressed packing).\n" +
    "The selfhost column above is untruncated; hosted/granted still apply the\n" +
    "plan. See api-routes.ts.",
);
