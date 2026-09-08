import { assertEquals } from "@std/assert";
import type {
  DaemonCell,
  DaemonCellRegistry,
} from "../../daemon/cell/contracts.ts";
import type { DaemonOutboundEnvelope } from "../../daemon/cell/protocol.ts";
import { PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN } from "../../daemon/metrics/capability-plan.ts";
import {
  buildCapabilityPlanUpdateEnvelope,
  enqueueCapabilityPlanUpdate,
  enqueueLatestRecordedCapabilityPlan,
} from "./capability-plan-push.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function fakeRegistry(
  enqueue: DaemonCell["enqueue"],
): DaemonCellRegistry {
  return {
    getCell: (_serverId: string) =>
      ({
        enqueue,
      }) as unknown as DaemonCell,
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  };
}

test("buildCapabilityPlanUpdateEnvelope carries plan and generation", () => {
  const envelope = buildCapabilityPlanUpdateEnvelope(
    PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    3,
  );
  assertEquals(envelope.kind, "capability-plan-update");
  assertEquals(envelope.plan, PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN);
  assertEquals(envelope.generation, 3);
  assertEquals(typeof envelope.requestId, "string");
  assertEquals(typeof envelope.deliveryId, "string");
  assertEquals(typeof envelope.at, "string");
});

test("enqueueCapabilityPlanUpdate is a no-op without a registry", async () => {
  assertEquals(
    await enqueueCapabilityPlanUpdate(
      undefined,
      "server-1",
      PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      0,
    ),
    false,
  );
});

test("enqueueCapabilityPlanUpdate enqueues the outbound envelope", async () => {
  const enqueued: DaemonOutboundEnvelope[] = [];
  const registry = fakeRegistry((envelope: DaemonOutboundEnvelope) => {
    enqueued.push(envelope);
    return Promise.resolve({} as never);
  });
  assertEquals(
    await enqueueCapabilityPlanUpdate(
      registry,
      "server-1",
      PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      2,
    ),
    true,
  );
  assertEquals(enqueued.length, 1);
  assertEquals(enqueued[0]?.kind, "capability-plan-update");
  if (enqueued[0]?.kind !== "capability-plan-update") {
    throw new TypeError("expected capability-plan-update envelope");
  }
  assertEquals(enqueued[0].generation, 2);
  assertEquals(enqueued[0].plan, PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN);
});

test("enqueueCapabilityPlanUpdate swallows enqueue failures", async () => {
  const registry = fakeRegistry(() => Promise.reject(new Error("cell down")));
  assertEquals(
    await enqueueCapabilityPlanUpdate(
      registry,
      "server-1",
      PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      1,
    ),
    false,
  );
});

test("enqueueLatestRecordedCapabilityPlan skips when nothing is recorded", async () => {
  const enqueued: DaemonOutboundEnvelope[] = [];
  await enqueueLatestRecordedCapabilityPlan(
    {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    } as never,
    "server-1",
    (envelope) => {
      enqueued.push(envelope);
    },
  );
  assertEquals(enqueued, []);
});

test("enqueueLatestRecordedCapabilityPlan enqueues the recorded plan", async () => {
  const enqueued: DaemonOutboundEnvelope[] = [];
  await enqueueLatestRecordedCapabilityPlan(
    {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    generation: 5,
                    planHash: "hash",
                    plan: PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
                    appliedAt: "2026-01-01T00:00:00.000Z",
                    serverId: "server-1",
                  },
                ]),
            }),
          }),
        }),
      }),
    } as never,
    "server-1",
    (envelope) => {
      enqueued.push(envelope);
    },
  );
  assertEquals(enqueued.length, 1);
  assertEquals(enqueued[0]?.kind, "capability-plan-update");
  if (enqueued[0]?.kind !== "capability-plan-update") {
    throw new TypeError("expected capability-plan-update envelope");
  }
  assertEquals(enqueued[0].generation, 5);
  assertEquals(enqueued[0].plan, PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN);
});

test("enqueueLatestRecordedCapabilityPlan is a no-op for self-hosted even when a plan is recorded", async () => {
  const enqueued: DaemonOutboundEnvelope[] = [];
  await enqueueLatestRecordedCapabilityPlan(
    {
      select: () => {
        throw new TypeError("self-hosted replay must not read a recorded plan");
      },
    } as never,
    "server-1",
    (envelope) => {
      enqueued.push(envelope);
    },
    "self-hosted",
  );
  assertEquals(enqueued, []);
});
