import { assertEquals } from "@std/assert";
import type { ServerHostResources } from "../db/server-metadata.ts";
import {
  MAX_NIC_SLOTS,
  type SlotMapping,
} from "../../client/servers/topology-types.ts";
import {
  cpuBand,
  driveBand,
  gpuBand,
  monitoredEntityCountsFromSlotMapping,
  nicBand,
  ramBand,
  resolveRecommendedTier,
  resolveRequiredTier,
  TIER_CPU_CORE_THRESHOLDS,
  TIER_DRIVE_SLOT_THRESHOLDS,
  TIER_GPU_SLOT_THRESHOLDS,
  TIER_NIC_SLOT_THRESHOLDS,
  TIER_RAM_BYTE_THRESHOLDS,
  totalPhysicalCores,
} from "./tier-placement.ts";
import { ladderEntitlements, PRICED_LADDER } from "./ladder.ts";
import {
  metricsCapabilityTierEntitlementsForLabel,
  metricsCapabilityTierEntitlementsForRank,
} from "./tier-entitlements.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const GIBIBYTE = 1024 ** 3;

function resources(input: {
  cores?: number;
  threads?: number;
  memoryGib?: number;
}): ServerHostResources {
  const cores = input.cores;
  const threads = input.threads;
  return {
    cpus: cores === undefined && threads === undefined ? undefined : [{
      cores: cores === undefined ? undefined : { total: cores },
      threads: threads === undefined ? undefined : { total: threads },
    }],
    memory: input.memoryGib === undefined
      ? undefined
      : { totalBytes: input.memoryGib * GIBIBYTE },
  };
}

test("totalPhysicalCores sums cores.total across sockets and ignores threads", () => {
  assertEquals(
    totalPhysicalCores({
      cpus: [
        { cores: { total: 8 }, threads: { total: 16 } },
        { cores: { total: 8 }, threads: { total: 16 } },
      ],
    }),
    16,
  );
  assertEquals(totalPhysicalCores({}), 0);
});

test("an 8c/16t Xeon lands on the core-count band; hyperthreading never promotes", () => {
  const xeon = resources({ cores: 8, threads: 16, memoryGib: 16 });
  assertEquals(totalPhysicalCores(xeon), 8);
  assertEquals(cpuBand(8).label, "S2");
  assertEquals(cpuBand(16).label, "S3");
  assertEquals(resolveRequiredTier(xeon).label, "S2");
});

test("a 4-vCPU VM with cores.total === 4 and no split lands S1", () => {
  const vm = resources({ cores: 4, memoryGib: 8 });
  assertEquals(resolveRequiredTier(vm), { rank: 1, label: "S1" });
});

test("cpuBand / ramBand pin every band edge, including SX above S7", () => {
  assertEquals(cpuBand(4).label, "S1");
  assertEquals(cpuBand(5).label, "S2");
  assertEquals(cpuBand(10).label, "S2");
  assertEquals(cpuBand(11).label, "S3");
  assertEquals(cpuBand(16).label, "S3");
  assertEquals(cpuBand(32).label, "S4");
  assertEquals(cpuBand(64).label, "S5");
  assertEquals(cpuBand(128).label, "S6");
  assertEquals(cpuBand(256).label, "S7");
  assertEquals(cpuBand(257).label, "SX");

  assertEquals(ramBand(TIER_RAM_BYTE_THRESHOLDS[0]!).label, "S1");
  assertEquals(ramBand(TIER_RAM_BYTE_THRESHOLDS[0]! + 1).label, "S2");
  assertEquals(ramBand(TIER_RAM_BYTE_THRESHOLDS[6]!).label, "S7");
  assertEquals(ramBand(TIER_RAM_BYTE_THRESHOLDS[6]! + 1).label, "SX");
});

test("every placement threshold list is read from the priced ladder, one entry per rank S1…S7", () => {
  assertEquals(PRICED_LADDER.map((entry) => entry.label), [
    "S1",
    "S2",
    "S3",
    "S4",
    "S5",
    "S6",
    "S7",
  ]);
  assertEquals(
    TIER_CPU_CORE_THRESHOLDS,
    PRICED_LADDER.map((entry) => entry.maxCores),
  );
  assertEquals(
    TIER_RAM_BYTE_THRESHOLDS,
    PRICED_LADDER.map((entry) => entry.maxMemoryBytes),
  );
  assertEquals(
    TIER_NIC_SLOT_THRESHOLDS,
    PRICED_LADDER.map((entry) => entry.nicSlots),
  );
  assertEquals(
    TIER_DRIVE_SLOT_THRESHOLDS,
    PRICED_LADDER.map((entry) => entry.driveSlots),
  );
  // GPU counts repeat across neighbouring rungs; the band is the first rank selling each count.
  assertEquals(TIER_GPU_SLOT_THRESHOLDS, [2, 4, 6, 8]);
  assertEquals(TIER_CPU_CORE_THRESHOLDS, [4, 10, 16, 32, 64, 128, 256]);
});

test("a 4-core NAS with 12 monitored drives is required S1 / recommended S5", () => {
  const nas = resources({ cores: 4, memoryGib: 16 });
  assertEquals(resolveRequiredTier(nas).label, "S1");
  assertEquals(resolveRecommendedTier(nas, 1, 12, 0).label, "S5");
  assertEquals(driveBand(12).label, "S5");
});

test("anything above S7 on any dimension resolves SX", () => {
  assertEquals(cpuBand(512).label, "SX");
  assertEquals(ramBand(2 * 1024 * GIBIBYTE).label, "SX");
  assertEquals(nicBand(12).label, "SX");
  assertEquals(driveBand(21).label, "SX");
  assertEquals(gpuBand(9).label, "SX");
  assertEquals(
    resolveRequiredTier(resources({ cores: 512, memoryGib: 16 })).label,
    "SX",
  );
});

test("reducing monitored counts lowers recommended but never required", () => {
  const host = resources({ cores: 4, memoryGib: 16 });
  const required = resolveRequiredTier(host);
  assertEquals(required.label, "S1");
  const high = resolveRecommendedTier(host, 12, 21, 9);
  const low = resolveRecommendedTier(host, 1, 1, 0);
  assertEquals(high.label, "SX");
  assertEquals(low.label, "S1");
  assertEquals(resolveRequiredTier(host).label, required.label);
});

test("nicBand recommends the lowest tier whose NIC entitlement covers the count; the top band is the daemon ceiling", () => {
  assertEquals(nicBand(0).label, "S1");
  assertEquals(nicBand(2).label, "S1");
  assertEquals(nicBand(3).label, "S3");
  assertEquals(nicBand(5).label, "S3");
  assertEquals(nicBand(6).label, "S5");
  assertEquals(nicBand(8).label, "S5");
  assertEquals(nicBand(9).label, "S7");
  assertEquals(nicBand(11).label, "S7");
  assertEquals(nicBand(12).label, "SX");
  assertEquals(
    TIER_NIC_SLOT_THRESHOLDS.length,
    TIER_DRIVE_SLOT_THRESHOLDS.length,
  );
  assertEquals(TIER_NIC_SLOT_THRESHOLDS.at(-1), MAX_NIC_SLOTS);
});

test("gpuBand caps at SX after its last listed threshold", () => {
  assertEquals(gpuBand(2).label, "S1");
  assertEquals(gpuBand(4).label, "S2");
  assertEquals(gpuBand(6).label, "S3");
  assertEquals(gpuBand(8).label, "S4");
});

test("monitoredEntityCountsFromSlotMapping reads SlotMapping lengths", () => {
  const mapping: SlotMapping = {
    normalNicSlots: ["eth0", "eth1"],
    fabricDeviceIds: ["wg0"],
    rootFilesystemId: null,
    gpuPageOrder: ["gpu0"],
    blockPageOrder: ["sda", "sdb", "sdc"],
    filesystemPageOrder: [],
    hardwareSignalPageOrder: [],
  };
  assertEquals(monitoredEntityCountsFromSlotMapping(mapping), {
    monitoredNicCount: 2,
    monitoredDriveCount: 3,
    monitoredGpuCount: 1,
  });
});

test("metricsCapabilityTierEntitlementsForRank reads the ladder by rank and treats rank 1 as the entry tier", () => {
  assertEquals(metricsCapabilityTierEntitlementsForRank(1), {
    nicSlots: 2,
    driveSlots: 2,
    gpuSlots: 2,
    filesystemSlots: 9,
    isEntryTier: true,
  });
  assertEquals(metricsCapabilityTierEntitlementsForRank(1), ladderEntitlements("S1"));
  assertEquals(metricsCapabilityTierEntitlementsForRank(2)?.isEntryTier, false);
  assertEquals(metricsCapabilityTierEntitlementsForRank(2), ladderEntitlements("S2"));
  // SX is the last rung: every slot the daemon can monitor.
  assertEquals(metricsCapabilityTierEntitlementsForRank(8)?.nicSlots, MAX_NIC_SLOTS);
  // No rank, or a rank off the ladder, is "no tier": the platform default plan.
  assertEquals(metricsCapabilityTierEntitlementsForRank(null), undefined);
  assertEquals(metricsCapabilityTierEntitlementsForRank(undefined), undefined);
  assertEquals(metricsCapabilityTierEntitlementsForRank(0), undefined);
  assertEquals(metricsCapabilityTierEntitlementsForRank(99), undefined);
});

test("metricsCapabilityTierEntitlementsForLabel is the ladder lookup by label", () => {
  assertEquals(metricsCapabilityTierEntitlementsForLabel("S3"), ladderEntitlements("S3"));
  assertEquals(metricsCapabilityTierEntitlementsForLabel("S3")?.isEntryTier, false);
  assertEquals(metricsCapabilityTierEntitlementsForLabel("S9"), undefined);
  assertEquals(metricsCapabilityTierEntitlementsForLabel(null), undefined);
});
