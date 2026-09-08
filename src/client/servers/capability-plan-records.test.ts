import { assertEquals, assertNotEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { getDatabaseUrl } from "../../db-url.ts";
import { createDenoDb, endDbConnection } from "../../db.ts";
import {
  capabilityPlanGeneration,
  organization,
  server,
} from "../../lib/db/schema.ts";
import {
  getLatestCapabilityPlanGeneration,
  recordCapabilityPlanGenerationIfChanged,
} from "./capability-plan-records.ts";
import {
  computeMetricsCapabilityPlanHash,
  metricsCapabilityPlanFromTierEntitlements,
  PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
} from "../../daemon/metrics/capability-plan.ts";

const dbUrl = getDatabaseUrl();

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function withServerFixture(
  fn: (
    ctx: { db: ReturnType<typeof createDenoDb>; serverId: string },
  ) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping capability plan records tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: "Capability Plan Records Org" })
    .returning({ id: organization.id });
  const organizationId = insertedOrg!.id;

  const now = new Date().toISOString();
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: "Capability Plan Records Server",
      isConnected: true,
      statusChangedAt: now,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id });
  const serverId = insertedServer!.id;

  try {
    await fn({ db, serverId });
  } finally {
    await db.delete(capabilityPlanGeneration).where(
      eq(capabilityPlanGeneration.serverId, serverId),
    );
    await db.delete(server).where(eq(server.id, serverId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
}

test("recordCapabilityPlanGenerationIfChanged creates generation 0 on first resolution", async () => {
  await withServerFixture(async ({ db, serverId }) => {
    const generation = await recordCapabilityPlanGenerationIfChanged(
      db,
      serverId,
      PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    );
    assertEquals(generation, { generation: 0, changed: true });

    const latest = await getLatestCapabilityPlanGeneration(db, serverId);
    assertEquals(latest?.generation, 0);
    assertEquals(latest?.plan, PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN);
  });
});

test("recordCapabilityPlanGenerationIfChanged is a no-op for an unchanged plan", async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordCapabilityPlanGenerationIfChanged(
      db,
      serverId,
      PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    );
    const generation = await recordCapabilityPlanGenerationIfChanged(
      db,
      serverId,
      PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    );
    assertEquals(generation, { generation: 0, changed: false });

    const rows = await db
      .select()
      .from(capabilityPlanGeneration)
      .where(eq(capabilityPlanGeneration.serverId, serverId));
    assertEquals(rows.length, 1);
  });
});

test("recordCapabilityPlanGenerationIfChanged bumps generation when the plan changes", async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordCapabilityPlanGenerationIfChanged(
      db,
      serverId,
      PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    );
    const changedPlan = {
      ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      gpuSlots: 4,
    };
    const generation = await recordCapabilityPlanGenerationIfChanged(
      db,
      serverId,
      changedPlan,
    );
    assertEquals(generation, { generation: 1, changed: true });

    const latest = await getLatestCapabilityPlanGeneration(db, serverId);
    assertEquals(latest?.generation, 1);
    assertEquals(latest?.plan, changedPlan);
    assertNotEquals(latest?.planHash, undefined);

    const rows = await db
      .select()
      .from(capabilityPlanGeneration)
      .where(eq(capabilityPlanGeneration.serverId, serverId));
    assertEquals(rows.length, 2);
  });
});

test("getLatestCapabilityPlanGeneration returns undefined when nothing was recorded yet", async () => {
  await withServerFixture(async ({ db, serverId }) => {
    const latest = await getLatestCapabilityPlanGeneration(db, serverId);
    assertEquals(latest, undefined);
  });
});

test("recordCapabilityPlanGenerationIfChanged bumps when tier entitlements change the plan hash", async () => {
  await withServerFixture(async ({ db, serverId }) => {
    const entryPlan = metricsCapabilityPlanFromTierEntitlements(
      {
        nicSlots: 2,
        driveSlots: 2,
        gpuSlots: 1,
        filesystemSlots: 0,
        isEntryTier: true,
      },
      "physical",
      "hosted",
    );
    const nextPlan = metricsCapabilityPlanFromTierEntitlements(
      {
        nicSlots: 5,
        driveSlots: 4,
        gpuSlots: 2,
        filesystemSlots: 3,
        isEntryTier: false,
      },
      "physical",
      "hosted",
    );
    const entryHash = await computeMetricsCapabilityPlanHash(entryPlan);
    const nextHash = await computeMetricsCapabilityPlanHash(nextPlan);
    assertNotEquals(entryHash, nextHash);

    await recordCapabilityPlanGenerationIfChanged(db, serverId, entryPlan);
    const generation = await recordCapabilityPlanGenerationIfChanged(
      db,
      serverId,
      nextPlan,
    );
    assertEquals(generation, { generation: 1, changed: true });

    const latest = await getLatestCapabilityPlanGeneration(db, serverId);
    assertEquals(latest?.generation, 1);
    assertEquals(latest?.planHash, nextHash);
  });
});

test("recordCapabilityPlanGenerationIfChanged serializes concurrent changed plans for one server", async () => {
  await withServerFixture(async ({ serverId }) => {
    if (!dbUrl) return;

    // Two independent connections, so the two calls genuinely race at the
    // database rather than serializing on a shared client's connection pool.
    const dbA = createDenoDb();
    const dbB = createDenoDb();
    try {
      const planA = {
        ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
        gpuSlots: 4,
      };
      const planB = {
        ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
        gpuSlots: 8,
      };

      const [generationA, generationB] = await Promise.all([
        recordCapabilityPlanGenerationIfChanged(dbA, serverId, planA),
        recordCapabilityPlanGenerationIfChanged(dbB, serverId, planB),
      ]);

      // Racing with different resolved plans must never collapse onto the
      // same generation number — that's exactly the corruption this test
      // guards against.
      assertNotEquals(generationA.generation, generationB.generation);
      assertEquals(generationA.changed, true);
      assertEquals(generationB.changed, true);

      const hashA = await computeMetricsCapabilityPlanHash(planA);
      const hashB = await computeMetricsCapabilityPlanHash(planB);

      const rows = await dbA
        .select()
        .from(capabilityPlanGeneration)
        .where(eq(capabilityPlanGeneration.serverId, serverId));
      const rowA = rows.find((row) =>
        row.generation === generationA.generation
      );
      const rowB = rows.find((row) =>
        row.generation === generationB.generation
      );

      // Each returned generation must resolve to the plan snapshot its own
      // caller actually persisted, not to whichever write happened to win a
      // conflicting insert.
      assertEquals(rowA?.planHash, hashA);
      assertEquals(rowA?.plan, planA);
      assertEquals(rowB?.planHash, hashB);
      assertEquals(rowB?.plan, planB);
    } finally {
      await endDbConnection(dbA);
      await endDbConnection(dbB);
    }
  });
});
