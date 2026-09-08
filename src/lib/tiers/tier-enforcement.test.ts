import { assertEquals } from "@std/assert";
import type { ServerHostResources } from "../db/server-metadata.ts";
import type {
  TopologyOverrides,
  TopologySnapshot,
} from "../../client/servers/topology-types.ts";
import {
  evaluateTierFloor,
  evaluateTierPlacement,
} from "./tier-enforcement.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const GIBIBYTE = 1024 ** 3;

const PLAN = {
  normalNicSlots: 2,
  detailedBlockDeviceSlots: 2,
  gpuSlots: 1,
};

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

function snapshotWithDrives(count: number): TopologySnapshot {
  return {
    generation: 1,
    bootGeneration: 1,
    networks: [],
    filesystems: [],
    blockDevices: Array.from({ length: count }, (_, index) => ({
      deviceId: `drive-${String(index + 1).padStart(2, "0")}`,
      kernelName: `nvme${index}n1`,
      deviceType: "physical" as const,
      isServiceDevice: true,
    })),
    gpus: [],
    hardwareSignals: [],
    cpu: { sockets: 1, coresPerSocket: 4, threadsPerSocket: 4, model: null },
    numaNodes: [],
    memoryTotalBytes: null,
    swapTotalBytes: null,
  };
}

function snapshotWithUplinks(
  nics: ReadonlyArray<{ deviceId: string; defaultRoute?: boolean }>,
): TopologySnapshot {
  return {
    generation: 1,
    bootGeneration: 1,
    networks: nics.map((nic) => ({
      deviceId: nic.deviceId,
      kind: "uplink" as const,
      name: nic.deviceId,
      identity: {},
      ...(nic.defaultRoute ? { defaultRoute: true } : {}),
    })),
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    cpu: { sockets: 1, coresPerSocket: 4, threadsPerSocket: 4, model: null },
    numaNodes: [],
    memoryTotalBytes: null,
    swapTotalBytes: null,
  };
}

test("an 8c/16t Xeon lands on rank 2 and passes an S2 license", () => {
  const xeon = resources({ cores: 8, threads: 16, memoryGib: 16 });
  const floor = evaluateTierFloor({ resources: xeon, tierRank: 2 });
  assertEquals(floor.requiredRank, 2);
  assertEquals(floor.requiredLabel, "S2");
  assertEquals(floor.satisfied, true);
  assertEquals(
    evaluateTierFloor({ resources: xeon, tierRank: 1 }).satisfied,
    false,
  );
});

test("a 64-core box fails an S1 license", () => {
  const box = resources({ cores: 64, memoryGib: 256 });
  const floor = evaluateTierFloor({ resources: box, tierRank: 1 });
  assertEquals(floor.satisfied, false);
  assertEquals(floor.requiredRank > 1, true);
});

test("a 4-core box with 24 drives passes — soft dimensions never block", () => {
  const small = resources({ cores: 4, memoryGib: 8 });
  const floor = evaluateTierFloor({ resources: small, tierRank: 1 });
  assertEquals(floor.satisfied, true);
  const placement = evaluateTierPlacement({
    resources: small,
    topologySnapshot: snapshotWithDrives(24),
    plan: PLAN,
    tierRank: 1,
    licenseLabel: "S1",
  });
  assertEquals(placement.satisfied, true);
  assertEquals(placement.unwatched.drives.length, 22);
  assertEquals(placement.recommendedRank > placement.requiredRank, true);
});

test("absent resources never block the floor", () => {
  assertEquals(
    evaluateTierFloor({ resources: undefined, tierRank: 1 }).satisfied,
    true,
  );
  assertEquals(
    evaluateTierFloor({
      resources: { cpus: [{ cores: { total: 0 } }], memory: { totalBytes: 0 } },
      tierRank: 1,
    }).satisfied,
    true,
  );
});

test("unwatched NICs follow the default-route uplink, not lexicographic first-N", () => {
  const placement = evaluateTierPlacement({
    resources: resources({ cores: 4, memoryGib: 8 }),
    topologySnapshot: snapshotWithUplinks([
      { deviceId: "nic-aaa" },
      { deviceId: "nic-zzz", defaultRoute: true },
    ]),
    plan: PLAN,
    tierRank: 1,
    licenseLabel: "S1",
  });
  assertEquals(placement.unwatched.nics, ["nic-aaa"]);
});

test("unwatched NICs follow nicSlotDeviceIds overrides rather than sorted uplinks", () => {
  const overrides: TopologyOverrides = {
    nicSlotDeviceIds: ["nic-ccc"],
    hostingFilesystemId: null,
    drivetempEnabled: false,
  };
  const placement = evaluateTierPlacement({
    resources: resources({ cores: 4, memoryGib: 8 }),
    topologySnapshot: snapshotWithUplinks([
      { deviceId: "nic-aaa" },
      { deviceId: "nic-bbb" },
      { deviceId: "nic-ccc" },
    ]),
    plan: PLAN,
    tierRank: 1,
    licenseLabel: "S1",
    topologyOverrides: overrides,
  });
  assertEquals(placement.unwatched.nics, ["nic-aaa", "nic-bbb"]);
});

test("the NIC recommendation follows the monitored set: six uplinks watching one need no NIC-driven upgrade", () => {
  const placement = evaluateTierPlacement({
    resources: resources({ cores: 4, memoryGib: 8 }),
    topologySnapshot: snapshotWithUplinks([
      { deviceId: "nic-1", defaultRoute: true },
      { deviceId: "nic-2" },
      { deviceId: "nic-3" },
      { deviceId: "nic-4" },
      { deviceId: "nic-5" },
      { deviceId: "nic-6" },
    ]),
    plan: PLAN,
    tierRank: 1,
    licenseLabel: "S1",
  });
  // Discovery alone would recommend S5 (six NICs); the monitored set is one.
  assertEquals(placement.recommendedLabel, "S1");
  assertEquals(placement.recommendedRank, placement.requiredRank);
  // The five unmonitored uplinks are still named, so the operator can pin them.
  assertEquals(placement.unwatched.nics, [
    "nic-2",
    "nic-3",
    "nic-4",
    "nic-5",
    "nic-6",
  ]);
});

test("pinning more NIC slots than the plan stores raises the recommendation and reports the truncated slots as unwatched", () => {
  const overrides: TopologyOverrides = {
    nicSlotDeviceIds: ["nic-6", "nic-5", "nic-4", "nic-3", "nic-2", "nic-1"],
    hostingFilesystemId: null,
    drivetempEnabled: false,
  };
  const snapshot = snapshotWithUplinks([
    { deviceId: "nic-1", defaultRoute: true },
    { deviceId: "nic-2" },
    { deviceId: "nic-3" },
    { deviceId: "nic-4" },
    { deviceId: "nic-5" },
    { deviceId: "nic-6" },
    { deviceId: "nic-7" },
  ]);
  const onS1 = evaluateTierPlacement({
    resources: resources({ cores: 4, memoryGib: 8 }),
    topologySnapshot: snapshot,
    plan: PLAN,
    tierRank: 1,
    licenseLabel: "S1",
    topologyOverrides: overrides,
  });
  // Six monitored NICs land on S5 — the lowest tier whose NIC column covers six.
  assertEquals(onS1.recommendedLabel, "S5");
  // S1 stores the first two pinned slots (in slot order); the rest of the
  // pinned list and the unpinned uplink are unwatched. Sorted by id.
  assertEquals(onS1.unwatched.nics, [
    "nic-1",
    "nic-2",
    "nic-3",
    "nic-4",
    "nic-7",
  ]);

  // Once the plan covers the pinned list, only the unpinned uplink is unwatched
  // and the recommendation is unchanged.
  const onS5 = evaluateTierPlacement({
    resources: resources({ cores: 4, memoryGib: 8 }),
    topologySnapshot: snapshot,
    plan: { ...PLAN, normalNicSlots: 8 },
    tierRank: 5,
    licenseLabel: "S5",
    topologyOverrides: overrides,
  });
  assertEquals(onS5.recommendedLabel, "S5");
  assertEquals(onS5.unwatched.nics, ["nic-7"]);
});

test("a plan with no NIC slots leaves every discovered uplink unwatched, including the monitored one", () => {
  const placement = evaluateTierPlacement({
    resources: resources({ cores: 4, memoryGib: 8 }),
    topologySnapshot: snapshotWithUplinks([{
      deviceId: "nic-1",
      defaultRoute: true,
    }]),
    plan: { ...PLAN, normalNicSlots: 0 },
    tierRank: 1,
    licenseLabel: "S1",
  });
  assertEquals(placement.unwatched.nics, ["nic-1"]);
});
