import { assertEquals } from "@std/assert";
import type { ComposeDocument } from "../compose/types.ts";
import type { ServiceScheduleSpec } from "./interpret.ts";
import {
  type ExistingSlot,
  type FleetServer,
  localReplicaCounts,
  localServiceNames,
  type PlanEnvironmentInput,
  planEnvironmentSchedule,
  type PlannedService,
} from "./planner.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVER_A = "00000000-0000-4000-8000-00000000000a";
const SERVER_B = "00000000-0000-4000-8000-00000000000b";
const SERVER_C = "00000000-0000-4000-8000-00000000000c";
const SERVICE_WEB = "00000000-0000-4000-8000-0000000000aa";
const SERVICE_DB = "00000000-0000-4000-8000-0000000000bb";
const SERVICE_CACHE = "00000000-0000-4000-8000-0000000000cc";

function server(
  id: string,
  opts: Partial<FleetServer> = {},
): FleetServer {
  return {
    id,
    connected: true,
    labels: {},
    ...opts,
  };
}

function spec(
  composeServiceName: string,
  overrides: Partial<ServiceScheduleSpec> = {},
): ServiceScheduleSpec {
  return {
    composeServiceName,
    mode: "replicated",
    replicas: 1,
    constraints: [],
    spreadKeys: [],
    publishedHostPorts: [],
    colocateWith: [],
    maxReplicasPerNode: null,
    ...overrides,
  };
}

function planned(
  serviceId: string,
  composeServiceName: string,
  overrides: Partial<ServiceScheduleSpec> = {},
): PlannedService {
  return { serviceId, spec: spec(composeServiceName, overrides) };
}

/**
 * A merged document whose `networks:` block is exactly `entries`.
 *
 * The planner reads nothing else from the document: `driver: overlay` on a
 * top-level entry is the whole of the authored spanning signal.
 */
function composeDoc(data: Record<string, unknown>): ComposeDocument {
  return { version: 1, data, presentation: { keyOrder: [], comments: {} } };
}

function input(
  overrides: Partial<PlanEnvironmentInput> = {},
): PlanEnvironmentInput {
  return {
    pinServerId: null,
    defaultServerId: SERVER_A,
    fabricEnabled: false,
    servers: [server(SERVER_A), server(SERVER_B)],
    services: [planned(SERVICE_WEB, "web")],
    existingTasks: [],
    storagePins: new Map(),
    ...overrides,
  };
}

test("planEnvironmentSchedule returns the pin/default for empty services", () => {
  assertEquals(
    planEnvironmentSchedule(
      input({ services: [], defaultServerId: null, pinServerId: null }),
    ),
    { ok: true, slots: [], serverIds: [] },
  );
  assertEquals(
    planEnvironmentSchedule(input({ services: [], pinServerId: SERVER_A })),
    { ok: true, slots: [], serverIds: [SERVER_A] },
  );
  assertEquals(
    planEnvironmentSchedule(
      input({
        services: [],
        pinServerId: "missing",
        servers: [server(SERVER_A)],
      }),
    ).ok,
    false,
  );
});

test("planEnvironmentSchedule places a single replica on the preferred server", () => {
  const plan = planEnvironmentSchedule(input());
  assertEquals(plan, {
    ok: true,
    slots: [
      {
        serviceId: SERVICE_WEB,
        serverId: SERVER_A,
        slot: 0,
        desiredState: "running",
      },
    ],
    serverIds: [SERVER_A],
  });
});

test("planEnvironmentSchedule keeps sticky placements across re-plans", () => {
  const existing: ExistingSlot[] = [
    { serviceId: SERVICE_WEB, slot: 0, serverId: SERVER_B },
  ];
  const plan = planEnvironmentSchedule(
    input({
      existingTasks: existing,
      services: [planned(SERVICE_WEB, "web", { replicas: 1 })],
    }),
  );
  assertEquals(plan.ok && plan.slots[0]?.serverId, SERVER_B);
});

test("planEnvironmentSchedule requires TurboFabric for a multi-server overlay network", () => {
  // Preferred-server sticky placement keeps same-service replicas on one host;
  // distinct label constraints force two hosts. The document declares the
  // network both services join `driver: overlay`, so the spread is the author's
  // spanning request and the fabric gate answers it.
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: false,
      pinServerId: null,
      defaultServerId: null,
      document: composeDoc({
        services: { web: { networks: ["app"] }, db: { networks: ["app"] } },
        networks: { app: { driver: "overlay" } },
      }),
      services: [
        planned(SERVICE_WEB, "web", {
          constraints: [{ key: "role", op: "eq", value: "front" }],
        }),
        planned(SERVICE_DB, "db", {
          constraints: [{ key: "role", op: "eq", value: "data" }],
        }),
      ],
      servers: [
        server(SERVER_A, { labels: { role: "front" } }),
        server(SERVER_B, { labels: { role: "data" } }),
      ],
    }),
  );
  assertEquals(plan.ok, false);
  if (!plan.ok) {
    assertEquals(plan.error, "turbofabric_required");
  }
});

test("planEnvironmentSchedule spans servers without TurboFabric for a bridge/default document", () => {
  // Same two-host spread, but nothing in the document asked for a network that
  // reaches beyond one engine: `bridge` and the implicit `default` both compile
  // to an ordinary local bridge per host, so the fabric has nothing to do.
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: false,
      pinServerId: null,
      defaultServerId: null,
      document: composeDoc({
        services: { web: { networks: ["app"] }, db: {} },
        networks: { app: { driver: "bridge" } },
      }),
      services: [
        planned(SERVICE_WEB, "web", {
          constraints: [{ key: "role", op: "eq", value: "front" }],
        }),
        planned(SERVICE_DB, "db", {
          constraints: [{ key: "role", op: "eq", value: "data" }],
        }),
      ],
      servers: [
        server(SERVER_A, { labels: { role: "front" } }),
        server(SERVER_B, { labels: { role: "data" } }),
      ],
    }),
  );
  assertEquals(plan.ok, true);
  if (plan.ok) {
    assertEquals(plan.serverIds, [SERVER_A, SERVER_B]);
  }
});

test("planEnvironmentSchedule requires TurboFabric for an overlay-declared default network", () => {
  // `networks.default.driver: overlay` opts the implicit network in, so services
  // that declare no `networks:` at all still span.
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: false,
      pinServerId: null,
      defaultServerId: null,
      document: composeDoc({
        services: { web: {}, db: {} },
        networks: { default: { driver: "overlay" } },
      }),
      services: [
        planned(SERVICE_WEB, "web", {
          constraints: [{ key: "role", op: "eq", value: "front" }],
        }),
        planned(SERVICE_DB, "db", {
          constraints: [{ key: "role", op: "eq", value: "data" }],
        }),
      ],
      servers: [
        server(SERVER_A, { labels: { role: "front" } }),
        server(SERVER_B, { labels: { role: "data" } }),
      ],
    }),
  );
  assertEquals(plan.ok, false);
  if (!plan.ok) {
    assertEquals(plan.error, "turbofabric_required");
  }
});

test("planEnvironmentSchedule ignores an overlay network whose members share a host", () => {
  // The network is declared overlay but every service joining it landed on one
  // server, so nothing spans and the fabric is not required to deploy.
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: false,
      pinServerId: null,
      defaultServerId: null,
      document: composeDoc({
        services: { web: { networks: ["app"] }, db: { networks: ["other"] } },
        networks: { app: { driver: "overlay" }, other: { driver: "overlay" } },
      }),
      services: [
        planned(SERVICE_WEB, "web", {
          constraints: [{ key: "role", op: "eq", value: "front" }],
        }),
        planned(SERVICE_DB, "db", {
          constraints: [{ key: "role", op: "eq", value: "data" }],
        }),
      ],
      servers: [
        server(SERVER_A, { labels: { role: "front" } }),
        server(SERVER_B, { labels: { role: "data" } }),
      ],
    }),
  );
  assertEquals(plan.ok, true);
  if (plan.ok) {
    assertEquals(plan.serverIds, [SERVER_A, SERVER_B]);
  }
});

test("planEnvironmentSchedule allows multi-server when fabric is enabled", () => {
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      pinServerId: null,
      defaultServerId: null,
      services: [
        planned(SERVICE_WEB, "web", {
          constraints: [{ key: "role", op: "eq", value: "front" }],
        }),
        planned(SERVICE_DB, "db", {
          constraints: [{ key: "role", op: "eq", value: "data" }],
        }),
      ],
      servers: [
        server(SERVER_A, { labels: { role: "front" } }),
        server(SERVER_B, { labels: { role: "data" } }),
      ],
    }),
  );
  assertEquals(plan.ok, true);
  if (plan.ok) {
    assertEquals(plan.slots.length, 2);
    assertEquals(plan.serverIds.length, 2);
  }
});

test("planEnvironmentSchedule honors whole-environment pins including offline hosts", () => {
  const plan = planEnvironmentSchedule(
    input({
      pinServerId: SERVER_C,
      servers: [
        server(SERVER_A),
        server(SERVER_C, { connected: false }),
      ],
      services: [planned(SERVICE_WEB, "web", { replicas: 1 })],
    }),
  );
  assertEquals(plan.ok && plan.slots[0]?.serverId, SERVER_C);
});

test("planEnvironmentSchedule fails constraints and colocation conflicts", () => {
  const constrained = planEnvironmentSchedule(
    input({
      services: [
        planned(SERVICE_WEB, "web", {
          constraints: [{ key: "zone", op: "eq", value: "west" }],
        }),
      ],
      servers: [server(SERVER_A, { labels: { zone: "east" } })],
    }),
  );
  assertEquals(constrained.ok, false);
  if (!constrained.ok) {
    assertEquals(constrained.error, "constraint_unsatisfiable");
  }

  const colocated = planEnvironmentSchedule(
    input({
      services: [
        planned(SERVICE_WEB, "web", {
          colocateWith: ["db"],
          constraints: [{ key: "tier", op: "eq", value: "front" }],
        }),
        planned(SERVICE_DB, "db", {
          constraints: [{ key: "tier", op: "eq", value: "data" }],
        }),
      ],
      servers: [
        server(SERVER_A, { labels: { tier: "front" } }),
        server(SERVER_B, { labels: { tier: "data" } }),
      ],
      fabricEnabled: true,
    }),
  );
  assertEquals(colocated.ok, false);
  if (!colocated.ok) {
    assertEquals(colocated.error, "colocation_conflict");
  }
});

test("planEnvironmentSchedule rejects host-port conflicts for multi-replica local publishes", () => {
  const plan = planEnvironmentSchedule(
    input({
      pinServerId: SERVER_A,
      services: [
        planned(SERVICE_WEB, "web", {
          replicas: 2,
          publishedHostPorts: [8080],
        }),
      ],
      servers: [server(SERVER_A)],
    }),
  );
  assertEquals(plan.ok, false);
  if (!plan.ok) {
    assertEquals(plan.error, "host_port_conflict");
  }
});

test("planEnvironmentSchedule spreads replicas across label values when fabric is on", () => {
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      defaultServerId: null,
      services: [
        planned(SERVICE_WEB, "web", {
          replicas: 2,
          spreadKeys: ["zone"],
        }),
      ],
      servers: [
        server(SERVER_A, { labels: { zone: "east" } }),
        server(SERVER_B, { labels: { zone: "west" } }),
      ],
    }),
  );
  assertEquals(plan.ok, true);
  if (plan.ok) {
    const zones = new Set(plan.slots.map((task) => task.serverId));
    assertEquals(zones.size, 2);
  }
});

test("planEnvironmentSchedule applies storage pins", () => {
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      storagePins: new Map([[SERVICE_DB, SERVER_B]]),
      services: [planned(SERVICE_DB, "db")],
    }),
  );
  assertEquals(plan.ok && plan.slots[0]?.serverId, SERVER_B);
});

test("planEnvironmentSchedule places global mode on every eligible server", () => {
  // Published host ports force requireEmptyHost so global replicas cannot stack.
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      defaultServerId: null,
      services: [
        planned(SERVICE_CACHE, "cache", {
          mode: "global",
          replicas: 1,
          publishedHostPorts: [9100],
        }),
      ],
      servers: [server(SERVER_A), server(SERVER_B)],
    }),
  );
  assertEquals(plan.ok, true);
  if (plan.ok) {
    assertEquals(plan.slots.length, 2);
    assertEquals(plan.serverIds, [SERVER_A, SERVER_B]);
  }
});

test("localReplicaCounts and localServiceNames filter by server", () => {
  const slots = [
    {
      serviceId: SERVICE_WEB,
      serverId: SERVER_A,
      slot: 0,
      desiredState: "running" as const,
    },
    {
      serviceId: SERVICE_WEB,
      serverId: SERVER_A,
      slot: 1,
      desiredState: "running" as const,
    },
    {
      serviceId: SERVICE_DB,
      serverId: SERVER_B,
      slot: 0,
      desiredState: "running" as const,
    },
  ];
  const names = new Map([
    [SERVICE_WEB, "web"],
    [SERVICE_DB, "db"],
  ]);
  assertEquals(
    localReplicaCounts(slots, names, SERVER_A),
    new Map([["web", 2]]),
  );
  assertEquals(localServiceNames(slots, names, SERVER_B), new Set(["db"]));
  assertEquals(localServiceNames(slots, names, SERVER_C), new Set());
  assertEquals(
    localReplicaCounts(
      slots,
      new Map([[SERVICE_WEB, "web"]]),
      SERVER_B,
    ),
    new Map(),
  );
});

test("planEnvironmentSchedule honors neq placement constraints", () => {
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      defaultServerId: null,
      services: [
        planned(SERVICE_WEB, "web", {
          constraints: [{ key: "tier", op: "neq", value: "front" }],
        }),
      ],
      servers: [
        server(SERVER_A, { labels: { tier: "front" } }),
        server(SERVER_B, { labels: { tier: "data" } }),
      ],
    }),
  );
  assertEquals(plan.ok && plan.slots[0]?.serverId, SERVER_B);
});

test("planEnvironmentSchedule rejects zero-replica services", () => {
  const plan = planEnvironmentSchedule(
    input({
      services: [planned(SERVICE_WEB, "web", { replicas: 0 })],
    }),
  );
  assertEquals(plan.ok, false);
  if (!plan.ok) {
    assertEquals(plan.error, "no_eligible_server");
    assertEquals(plan.message.includes("web"), true);
  }
});

test("planEnvironmentSchedule includes a shared offline pin and default once", () => {
  const plan = planEnvironmentSchedule(
    input({
      pinServerId: SERVER_A,
      defaultServerId: SERVER_A,
      servers: [server(SERVER_A, { connected: false })],
      services: [planned(SERVICE_WEB, "web")],
    }),
  );
  assertEquals(plan.ok, true);
  if (plan.ok) {
    assertEquals(plan.slots[0]?.serverId, SERVER_A);
    assertEquals(plan.serverIds, [SERVER_A]);
  }
});

/**
 * `deploy.placement.max_replicas_per_node`.
 *
 * Without the cap, `pickServer` prefers the default server and packs every
 * replica onto it — which is exactly what an author writes the cap to prevent.
 * The three cases below are the whole contract: it spreads when it can, it
 * refuses with its own code when the arithmetic cannot work, and an absent cap
 * changes nothing.
 */
test("planEnvironmentSchedule spreads replicas to honour max_replicas_per_node", () => {
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      services: [
        planned(SERVICE_WEB, "web", { replicas: 4, maxReplicasPerNode: 2 }),
      ],
      servers: [server(SERVER_A), server(SERVER_B)],
    }),
  );
  assertEquals(plan.ok, true);
  if (!plan.ok) return;
  const perServer = new Map<string, number>();
  for (const slot of plan.slots) {
    perServer.set(slot.serverId, (perServer.get(slot.serverId) ?? 0) + 1);
  }
  assertEquals(plan.slots.length, 4);
  assertEquals([...perServer.values()].every((count) => count <= 2), true);
  assertEquals(perServer.size, 2);
});

test("planEnvironmentSchedule refuses a cap the fleet cannot satisfy", () => {
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      services: [
        planned(SERVICE_WEB, "web", { replicas: 5, maxReplicasPerNode: 2 }),
      ],
      servers: [server(SERVER_A), server(SERVER_B)],
    }),
  );
  assertEquals(plan.ok, false);
  if (plan.ok) return;
  // Its own code: every host is available and every port is free — it is the
  // arithmetic that fails, and `no_eligible_server` would send the operator
  // looking at labels and connectivity instead.
  assertEquals(plan.error, "max_replicas_per_node_exceeded");
  assertEquals(plan.message.includes("max_replicas_per_node"), true);
});

test("planEnvironmentSchedule keeps packing when no cap is authored", () => {
  const plan = planEnvironmentSchedule(
    input({
      services: [planned(SERVICE_WEB, "web", { replicas: 3 })],
      servers: [server(SERVER_A), server(SERVER_B)],
    }),
  );
  assertEquals(plan.ok, true);
  if (!plan.ok) return;
  assertEquals(plan.slots.every((slot) => slot.serverId === SERVER_A), true);
});

test("a cap overrides stickiness rather than being quietly violated", () => {
  // Both slots were on SERVER_A last deploy; the document now caps one per
  // node. A cap that sticky placements could ignore is not a cap.
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      existingTasks: [
        { serviceId: SERVICE_WEB, slot: 0, serverId: SERVER_A },
        { serviceId: SERVICE_WEB, slot: 1, serverId: SERVER_A },
      ],
      services: [
        planned(SERVICE_WEB, "web", { replicas: 2, maxReplicasPerNode: 1 }),
      ],
      servers: [server(SERVER_A), server(SERVER_B)],
    }),
  );
  assertEquals(plan.ok, true);
  if (!plan.ok) return;
  assertEquals(
    [...new Set(plan.slots.map((slot) => slot.serverId))].sort(),
    [SERVER_A, SERVER_B].sort(),
  );
});

test("a cap and a published host port are both enforced at once", () => {
  // The port allows one replica per host and the cap allows two; the port is
  // the tighter of the two, and three replicas on two hosts still cannot fit.
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      services: [
        planned(SERVICE_WEB, "web", {
          replicas: 3,
          maxReplicasPerNode: 2,
          publishedHostPorts: [8080],
        }),
      ],
      servers: [server(SERVER_A), server(SERVER_B)],
    }),
  );
  assertEquals(plan.ok, false);
  if (plan.ok) return;
  assertEquals(plan.error, "host_port_conflict");
});

/**
 * `placement.preferences` versus the project default server.
 *
 * `defaultServerId` is a preference, not a restriction — it breaks a tie once
 * the spread score has been computed. The regression this pins is the earlier
 * shape, where `pickServer` returned the default server before it ever looked
 * at `spreadKeys`, so authored spread preferences were inert in every project
 * that had one (which is most of them).
 */
test("spread preferences beat the default server rather than being skipped", () => {
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      // Deliberately kept set — clearing it is what the old code needed for
      // spread to work at all.
      defaultServerId: SERVER_A,
      services: [
        planned(SERVICE_WEB, "web", { replicas: 2, spreadKeys: ["zone"] }),
      ],
      servers: [
        server(SERVER_A, { labels: { zone: "east" } }),
        server(SERVER_B, { labels: { zone: "west" } }),
      ],
    }),
  );
  assertEquals(plan.ok, true);
  if (!plan.ok) return;
  assertEquals(plan.slots.length, 2);
  assertEquals(
    [...new Set(plan.slots.map((slot) => slot.serverId))].sort(),
    [SERVER_A, SERVER_B].sort(),
  );
});

test("the default server still wins a tie when nothing asks to spread", () => {
  // The tie-break is the whole of what `defaultServerId` does now, and it has
  // to keep doing it: an unconstrained service belongs on the project default.
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: true,
      defaultServerId: SERVER_B,
      services: [planned(SERVICE_WEB, "web", { replicas: 3 })],
      servers: [server(SERVER_A), server(SERVER_B)],
    }),
  );
  assertEquals(plan.ok, true);
  if (!plan.ok) return;
  assertEquals(plan.slots.every((slot) => slot.serverId === SERVER_B), true);
});

test("planEnvironmentSchedule allows a multi-server spread when no compose document is present", () => {
  // Authored overlay intent is what requires TurboFabric. Without a document
  // the planner cannot see a spanning network, so two hosts stay ordinary
  // standalone placement rather than a 422.
  const plan = planEnvironmentSchedule(
    input({
      fabricEnabled: false,
      pinServerId: null,
      defaultServerId: null,
      services: [
        planned(SERVICE_WEB, "web", {
          constraints: [{ key: "role", op: "eq", value: "front" }],
        }),
        planned(SERVICE_DB, "db", {
          constraints: [{ key: "role", op: "eq", value: "data" }],
        }),
      ],
      servers: [
        server(SERVER_A, { labels: { role: "front" } }),
        server(SERVER_B, { labels: { role: "data" } }),
      ],
    }),
  );
  assertEquals(plan.ok, true);
  if (!plan.ok) throw new TypeError("expected a successful multi-server plan");
  assertEquals(plan.serverIds, [SERVER_A, SERVER_B]);
});
