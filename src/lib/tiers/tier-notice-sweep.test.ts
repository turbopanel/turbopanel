import { assertEquals } from "@std/assert";
import { and, eq, isNull } from "drizzle-orm";
import type { ServerHostResources } from "../db/server-metadata.ts";
import type { TopologySnapshot } from "../../client/servers/topology-types.ts";
import { getDatabaseUrl } from "../../db-url.ts";
import { createDenoDb } from "../../db.ts";
import { license, organization, server, setting, tier } from "../db/schema.ts";
import { getTierByLabel, insertTier } from "../db/tier-records.ts";
import { evaluateTierPlacement } from "./tier-enforcement.ts";
import {
  classifyTierNotice,
  parseTierNoticeMarker,
  shouldSendTierNotice,
  takeTierNoticeSweepBatch,
  TIER_NOTICE_SWEEP_CURSOR_KEY,
  TIER_NOTICE_THROTTLE_MS,
  tierNoticeDigest,
} from "./tier-notice-sweep.ts";

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

function smallBox(): ServerHostResources {
  return {
    cpus: [{ cores: { total: 4 } }],
    memory: { totalBytes: 8 * GIBIBYTE },
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
      deviceType: "physical",
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

test("classifyTierNotice is exceeds when license rank is below recommended", () => {
  const placement = evaluateTierPlacement({
    resources: smallBox(),
    topologySnapshot: snapshotWithDrives(24),
    plan: PLAN,
    tierRank: 1,
    licenseLabel: "S1",
  });
  assertEquals(classifyTierNotice(placement), "exceeds");
  const digest = tierNoticeDigest("exceeds", placement);
  assertEquals(digest.includes("exceeds"), true);
  assertEquals(digest.includes("drive-03"), true);
});

test("classifyTierNotice is overprovisioned when recommended sits below the license", () => {
  const placement = evaluateTierPlacement({
    resources: smallBox(),
    topologySnapshot: snapshotWithDrives(1),
    plan: PLAN,
    tierRank: 5,
    licenseLabel: "S5",
  });
  assertEquals(classifyTierNotice(placement), "overprovisioned");
});

test("classifyTierNotice is null when ranks match, and the marker clears", () => {
  const placement = evaluateTierPlacement({
    resources: smallBox(),
    topologySnapshot: snapshotWithDrives(1),
    plan: PLAN,
    tierRank: 1,
    licenseLabel: "S1",
  });
  assertEquals(classifyTierNotice(placement), null);
});

test("shouldSendTierNotice throttles identical digests for 24h and fires on digest change", () => {
  const now = Date.parse("2026-09-07T12:00:00.000Z");
  const marker = parseTierNoticeMarker({
    tierNotice: {
      kind: "exceeds",
      digest: "same",
      lastNotifiedAt: "2026-09-07T11:00:00.000Z",
    },
  });
  assertEquals(
    shouldSendTierNotice({
      kind: "exceeds",
      digest: "same",
      marker,
      nowMs: now,
    }),
    false,
  );
  assertEquals(
    shouldSendTierNotice({
      kind: "exceeds",
      digest: "changed",
      marker,
      nowMs: now,
    }),
    true,
  );
  assertEquals(
    shouldSendTierNotice({
      kind: "exceeds",
      digest: "same",
      marker,
      nowMs: now + TIER_NOTICE_THROTTLE_MS,
    }),
    true,
  );
  assertEquals(
    parseTierNoticeMarker({ options: { ignored: true } }),
    undefined,
  );
});

const dbUrl = getDatabaseUrl();

async function withEligibleSweepFleet(
  count: number,
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>;
    serverIds: string[];
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping tier-notice sweep cursor tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const [existingCursor] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, TIER_NOTICE_SWEEP_CURSOR_KEY))
    .limit(1);
  const [orgRow] = await db
    .insert(organization)
    .values({ name: "Tier Notice Sweep Cursor Org" })
    .returning({ id: organization.id });
  const organizationId = orgRow!.id;
  // `tier.label` is unique: reuse the instance's S1 row when it exists and
  // create (then remove) one only when it does not.
  const existingTier = await getTierByLabel(db, "S1");
  const tierId = existingTier?.id ??
    (await insertTier(db, {
      label: "S1",
      providerProductId: null,
      priceCents: null,
      currency: null,
    })).id;
  const now = new Date().toISOString();
  // Eligibility is the derived assignment: a licensed server sitting on a tier.
  const insertedServers = await db
    .insert(server)
    .values(
      Array.from({ length: count }, (_, index) => ({
        organizationId,
        name: `Tier Notice Sweep Server ${index + 1}`,
        assignedTierId: tierId,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .returning({ id: server.id });
  const serverIds = insertedServers
    .map((row) => row.id)
    .sort((a, b) => a.localeCompare(b));
  await db.insert(license).values(
    serverIds.map((serverId) => ({
      organizationId,
      serverId,
      token: `tier-notice-sweep-${serverId}`,
    })),
  );

  try {
    await fn({ db, serverIds });
  } finally {
    await db.delete(license).where(eq(license.organizationId, organizationId));
    await db.delete(server).where(eq(server.organizationId, organizationId));
    if (!existingTier) await db.delete(tier).where(eq(tier.id, tierId));
    await db.delete(organization).where(eq(organization.id, organizationId));
    if (existingCursor) {
      await db
        .insert(setting)
        .values({
          key: TIER_NOTICE_SWEEP_CURSOR_KEY,
          value: existingCursor.value,
        })
        .onConflictDoUpdate({
          target: setting.key,
          set: {
            value: existingCursor.value,
            updatedAt: new Date().toISOString(),
          },
        });
    } else {
      await db
        .delete(setting)
        .where(eq(setting.key, TIER_NOTICE_SWEEP_CURSOR_KEY));
    }
  }
}

test("subsequent sweeps rotate past the first eligible page instead of starving later servers", async () => {
  await withEligibleSweepFleet(3, async ({ db, serverIds }) => {
    const eligibleBefore = await db
      .select({ id: server.id })
      .from(server)
      .innerJoin(
        license,
        and(eq(license.serverId, server.id), isNull(license.revokedAt)),
      )
      .innerJoin(tier, eq(tier.id, server.assignedTierId))
      .orderBy(server.id);
    const startIndex = eligibleBefore.findIndex((row) =>
      row.id === serverIds[0]
    );
    assertEquals(startIndex >= 0, true);
    const predecessorId = startIndex > 0
      ? eligibleBefore[startIndex - 1]!.id
      : null;
    await db
      .insert(setting)
      .values({
        key: TIER_NOTICE_SWEEP_CURSOR_KEY,
        value: { afterId: predecessorId },
      })
      .onConflictDoUpdate({
        target: setting.key,
        set: {
          value: { afterId: predecessorId },
          updatedAt: new Date().toISOString(),
        },
      });

    const firstPage = await takeTierNoticeSweepBatch(db, 2);
    const secondPage = await takeTierNoticeSweepBatch(db, 2);
    assertEquals(firstPage[0], serverIds[0]);
    assertEquals(firstPage.includes(serverIds[2]!), false);
    assertEquals(secondPage.includes(serverIds[2]!), true);
    assertEquals(firstPage.join(",") === secondPage.join(","), false);
  });
});
