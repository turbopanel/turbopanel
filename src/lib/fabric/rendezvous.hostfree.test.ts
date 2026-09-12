import { assertEquals } from "@std/assert";
import type { Db } from "../../db.ts";
import type { DaemonCellRegistry } from "../../daemon/cell/contracts.ts";
import {
  type EndpointAddressCaches,
  fabricPairCacheKey,
  planRelayPath,
  type RelayPathKind,
  type RelayRecord,
} from "../db/fabric-records.ts";
import {
  FABRIC_PATH_DEMOTE_STRIKES,
  FABRIC_PATH_PROMOTE_STRIKES,
  initialFabricPathState,
} from "./path-state.ts";
import {
  buildNatCandidateExchange,
  classifyNatMapping,
  collectFabricPathObservations,
  fabricNeedsRendezvous,
  hydrateFabricPathStates,
  type ObservedPeerPath,
  pathStatesFromRelayMetadata,
  rememberFabricPathStates,
  requestFabricPaths,
  resetFabricPathStateCacheForTests,
  runFabricRendezvousRound,
  setCollectFabricPathObservationsForTests,
} from "./rendezvous.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const KEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
const KEY_GW = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=";
const FABRIC_ID = "fab-rendezvous";

function paths(
  publicKey: string,
  endpoint: string,
  health: ObservedPeerPath["health"] = "healthy",
): ObservedPeerPath[] {
  return [{ publicKey, endpoint, health }];
}

test("classifyNatMapping is easy when the mapped port matches at two observers", () => {
  const observations = new Map([
    ["gw-1", paths(KEY_A, "203.0.113.50:48172")],
    ["gw-2", paths(KEY_A, "203.0.113.50:48172")],
  ]);
  assertEquals(classifyNatMapping(observations, KEY_A), "easy");
});

test("classifyNatMapping is hard when observers see different ports", () => {
  const observations = new Map([
    ["gw-1", paths(KEY_A, "203.0.113.50:48172")],
    ["gw-2", paths(KEY_A, "203.0.113.50:51200")],
  ]);
  assertEquals(classifyNatMapping(observations, KEY_A), "hard");
});

test("classifyNatMapping is unknown with a single observation point", () => {
  const observations = new Map([
    ["gw-1", paths(KEY_A, "203.0.113.50:48172")],
  ]);
  assertEquals(classifyNatMapping(observations, KEY_A), "unknown");
});

test("buildNatCandidateExchange hands each side the peer endpoint observers saw", () => {
  const observations = new Map([
    ["gw-1", [
      ...paths(KEY_A, "203.0.113.50:48172"),
      ...paths(KEY_B, "198.51.100.20:51820"),
    ]],
  ]);
  const exchange = buildNatCandidateExchange({
    relays: [
      { serverId: "srv-a", publicKey: KEY_A },
      { serverId: "srv-b", publicKey: KEY_B },
      { serverId: "gw-1", publicKey: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=" },
    ],
    observations,
    natClass: new Map([
      ["srv-a", "easy"],
      ["srv-b", "easy"],
    ]),
    pathStates: new Map(),
  });
  assertEquals(exchange.get("srv-a"), [
    { publicKey: KEY_B, endpoints: ["198.51.100.20:51820"] },
  ]);
  assertEquals(exchange.get("srv-b"), [
    { publicKey: KEY_A, endpoints: ["203.0.113.50:48172"] },
  ]);
});

test("buildNatCandidateExchange skips both-hard pairs", () => {
  const observations = new Map([
    ["gw-1", [
      ...paths(KEY_A, "203.0.113.50:48172"),
      ...paths(KEY_B, "198.51.100.20:51820"),
    ]],
  ]);
  const exchange = buildNatCandidateExchange({
    relays: [
      { serverId: "srv-a", publicKey: KEY_A },
      { serverId: "srv-b", publicKey: KEY_B },
    ],
    observations,
    natClass: new Map([
      ["srv-a", "hard"],
      ["srv-b", "hard"],
    ]),
    pathStates: new Map(),
  });
  assertEquals(exchange.size, 0);
});

test("buildNatCandidateExchange skips pairs already on a healthy direct path", () => {
  const observations = new Map([
    ["gw-1", [
      ...paths(KEY_A, "203.0.113.50:48172"),
      ...paths(KEY_B, "198.51.100.20:51820"),
    ]],
  ]);
  const ab = initialFabricPathState("srv-b");
  ab.selected = "direct_lan";
  const ba = initialFabricPathState("srv-a");
  ba.selected = "direct_public";
  const exchange = buildNatCandidateExchange({
    relays: [
      { serverId: "srv-a", publicKey: KEY_A },
      { serverId: "srv-b", publicKey: KEY_B },
    ],
    observations,
    natClass: new Map([
      ["srv-a", "easy"],
      ["srv-b", "easy"],
    ]),
    pathStates: new Map([
      ["srv-a>srv-b", ab],
      ["srv-b>srv-a", ba],
    ]),
  });
  assertEquals(exchange.size, 0);
});

test("fabricNeedsRendezvous is false for a single keyed relay", () => {
  assertEquals(
    fabricNeedsRendezvous([
      {
        id: "r1",
        fabricId: "fab",
        serverId: "srv-a",
        address: "10.250.0.1",
        role: "member",
        keepalive: null,
        endpointAddress: null,
        publicKey: KEY_A,
        prefix: "10.192.0.0/16",
        advertisedCidrs: [],
        metadata: {},
        allowRelay: null,
        preferredGatewayIds: [],
      },
    ]),
    false,
  );
});

function stampDb(): Db {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit: () => Promise.resolve([]),
              };
            },
          };
        },
      };
    },
  } as unknown as Db;
}

function emptyPathCaches(): EndpointAddressCaches {
  return {
    publicAddressByServer: new Map(),
    reportedByServer: new Map(),
    datacenterMembershipsByServer: new Map(),
    policyByDatacenter: new Map(),
    natEndpointByPair: new Map(),
    failedPathKindsByPair: new Map(),
  };
}

function keyedRelay(params: {
  serverId: string;
  publicKey: string;
  role?: RelayRecord["role"];
  peer?: { serverId: string; selected: RelayPathKind };
}): RelayRecord {
  return {
    id: `r-${params.serverId}`,
    fabricId: FABRIC_ID,
    serverId: params.serverId,
    address: "10.250.0.1",
    role: params.role ?? "member",
    keepalive: null,
    endpointAddress: null,
    publicKey: params.publicKey,
    prefix: "10.192.0.0/16",
    advertisedCidrs: [],
    metadata: params.peer
      ? {
        paths: {
          at: "2026-01-01T00:00:00.000Z",
          entries: [{
            peerServerId: params.peer.serverId,
            selected: params.peer.selected,
            degraded: false,
          }],
        },
      }
      : {},
    allowRelay: null,
    preferredGatewayIds: [],
  };
}

function applySummaries(
  relays: RelayRecord[],
  summariesByServerId: Map<string, { peerServerId: string; selected: RelayPathKind; degraded: boolean }[]>,
): void {
  for (const relay of relays) {
    const entries = summariesByServerId.get(relay.serverId);
    if (!entries) continue;
    relay.metadata = {
      ...relay.metadata,
      paths: { at: "2026-08-18T00:00:00.000Z", entries },
    };
  }
}

test("runFabricRendezvousRound does not promote observer-only endpoints to direct_nat", async () => {
  const relays = [
    keyedRelay({ serverId: "srv-a", publicKey: KEY_A }),
    keyedRelay({ serverId: "srv-b", publicKey: KEY_B }),
    keyedRelay({ serverId: "gw-1", publicKey: KEY_GW }),
  ];
  setCollectFabricPathObservationsForTests((params) => {
    const out = new Map<string, ObservedPeerPath[]>();
    const isProbe = Boolean(params.candidatesByServerId?.size);
    if (!isProbe) {
      out.set("gw-1", [
        { publicKey: KEY_A, endpoint: "203.0.113.50:48172", health: "healthy" },
        { publicKey: KEY_B, endpoint: "198.51.100.20:51820", health: "healthy" },
      ]);
    }
    for (const relay of params.relays) {
      if (out.has(relay.serverId) || !relay.publicKey) continue;
      const paths: ObservedPeerPath[] = [];
      for (const other of params.relays) {
        if (other.serverId === relay.serverId || !other.publicKey) continue;
        paths.push({ publicKey: other.publicKey, health: "never" });
      }
      out.set(relay.serverId, paths);
    }
    return Promise.resolve(out);
  });
  resetFabricPathStateCacheForTests();
  try {
    const round = await runFabricRendezvousRound({
      db: stampDb(),
      registry: {} as DaemonCellRegistry,
      fabricId: FABRIC_ID,
      relays,
      orgAllowRelay: false,
    });
    if (!round) throw new TypeError("expected a rendezvous round");
    assertEquals(round.natEndpointByPair.size, 0);
    const caches = emptyPathCaches();
    caches.natEndpointByPair = round.natEndpointByPair;
    caches.failedPathKindsByPair = round.failedPathKindsByPair;
    const plan = planRelayPath({
      self: relays[0]!,
      other: relays[1]!,
      caches,
    });
    assertEquals(plan.selected.kind, "unreachable");
    assertEquals(
      round.pathStates.get(fabricPairCacheKey("srv-a", "srv-b"))?.selected,
      "unreachable",
    );
  } finally {
    setCollectFabricPathObservationsForTests(null);
    resetFabricPathStateCacheForTests();
  }
});

test("hydrateFabricPathStates preserves demote strikes across separate rendezvous rounds", async () => {
  const relays = [
    keyedRelay({
      serverId: "srv-a",
      publicKey: KEY_A,
      peer: { serverId: "srv-b", selected: "direct_public" },
    }),
    keyedRelay({
      serverId: "srv-b",
      publicKey: KEY_B,
      peer: { serverId: "srv-a", selected: "direct_public" },
    }),
  ];
  setCollectFabricPathObservationsForTests((params) => {
    const out = new Map<string, ObservedPeerPath[]>();
    for (const relay of params.relays) {
      if (!relay.publicKey) continue;
      const paths: ObservedPeerPath[] = [];
      for (const other of params.relays) {
        if (other.serverId === relay.serverId || !other.publicKey) continue;
        paths.push({ publicKey: other.publicKey, health: "never" });
      }
      out.set(relay.serverId, paths);
    }
    return Promise.resolve(out);
  });
  resetFabricPathStateCacheForTests();
  try {
    let selected = "direct_public";
    for (let roundIndex = 0; roundIndex < FABRIC_PATH_DEMOTE_STRIKES; roundIndex += 1) {
      const round = await runFabricRendezvousRound({
        db: stampDb(),
        registry: {} as DaemonCellRegistry,
        fabricId: FABRIC_ID,
        relays,
        pathStates: hydrateFabricPathStates(FABRIC_ID, relays),
        orgAllowRelay: false,
      });
      if (!round) throw new TypeError("expected a rendezvous round");
      applySummaries(relays, round.summariesByServerId);
      selected = round.pathStates.get(fabricPairCacheKey("srv-a", "srv-b"))
        ?.selected ?? selected;
    }
    assertEquals(selected, "unreachable");
  } finally {
    setCollectFabricPathObservationsForTests(null);
    resetFabricPathStateCacheForTests();
  }
});

test("hydrateFabricPathStates preserves promote strikes across separate rendezvous rounds", async () => {
  const relays = [
    keyedRelay({
      serverId: "srv-a",
      publicKey: KEY_A,
      peer: { serverId: "srv-b", selected: "gateway" },
    }),
    keyedRelay({
      serverId: "srv-b",
      publicKey: KEY_B,
      peer: { serverId: "srv-a", selected: "gateway" },
    }),
    keyedRelay({ serverId: "gw-1", publicKey: KEY_GW, role: "gateway" }),
  ];
  setCollectFabricPathObservationsForTests((params) => {
    const out = new Map<string, ObservedPeerPath[]>();
    const isProbe = Boolean(params.candidatesByServerId?.size);
    out.set("gw-1", [
      { publicKey: KEY_A, endpoint: "203.0.113.10:51820", health: "healthy" },
      { publicKey: KEY_B, endpoint: "203.0.113.50:48172", health: "healthy" },
    ]);
    if (isProbe) {
      out.set("srv-a", [{
        publicKey: KEY_B,
        endpoint: "203.0.113.50:48172",
        health: "healthy",
      }]);
      out.set("srv-b", [{
        publicKey: KEY_A,
        endpoint: "203.0.113.10:51820",
        health: "healthy",
      }]);
    } else {
      out.set("srv-a", []);
      out.set("srv-b", []);
    }
    return Promise.resolve(out);
  });
  resetFabricPathStateCacheForTests();
  try {
    let selected: RelayPathKind = "gateway";
    for (let roundIndex = 0; roundIndex < FABRIC_PATH_PROMOTE_STRIKES; roundIndex += 1) {
      const round = await runFabricRendezvousRound({
        db: stampDb(),
        registry: {} as DaemonCellRegistry,
        fabricId: FABRIC_ID,
        relays,
        pathStates: hydrateFabricPathStates(FABRIC_ID, relays),
        orgAllowRelay: false,
      });
      if (!round) throw new TypeError("expected a rendezvous round");
      applySummaries(relays, round.summariesByServerId);
      selected = round.pathStates.get(fabricPairCacheKey("srv-a", "srv-b"))
        ?.selected ?? selected;
    }
    assertEquals(selected, "direct_nat");
  } finally {
    setCollectFabricPathObservationsForTests(null);
    resetFabricPathStateCacheForTests();
  }
});

test("hydrateFabricPathStates prunes pairs for removed relays", () => {
  resetFabricPathStateCacheForTests();
  try {
    rememberFabricPathStates(
      FABRIC_ID,
      new Map([
        [fabricPairCacheKey("srv-a", "srv-b"), {
          ...initialFabricPathState("srv-b"),
          selected: "direct_public",
          demoteStrikes: 1,
        }],
        [fabricPairCacheKey("srv-a", "srv-c"), {
          ...initialFabricPathState("srv-c"),
          selected: "direct_public",
          demoteStrikes: 2,
        }],
      ]),
    );
    const hydrated = hydrateFabricPathStates(FABRIC_ID, [
      keyedRelay({ serverId: "srv-a", publicKey: KEY_A }),
      keyedRelay({ serverId: "srv-b", publicKey: KEY_B }),
    ]);
    assertEquals(hydrated.has(fabricPairCacheKey("srv-a", "srv-c")), false);
    assertEquals(
      hydrated.get(fabricPairCacheKey("srv-a", "srv-b"))?.demoteStrikes,
      1,
    );
  } finally {
    resetFabricPathStateCacheForTests();
  }
});

function fakeRegistry(
  recordOrError: unknown,
): DaemonCellRegistry {
  return {
    getCell: () => ({
      createRequestAndWait: () => {
        if (recordOrError instanceof Error) return Promise.reject(recordOrError);
        if (typeof recordOrError === "string") {
          return Promise.reject(recordOrError);
        }
        return Promise.resolve(recordOrError);
      },
    }),
  } as unknown as DaemonCellRegistry;
}

type LiveStatusRow = { serverId: string; connected: boolean };

function thenableRows<T>(rows: T[]) {
  return {
    then(
      onFulfilled?: (value: T[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      return Promise.resolve(rows).then(onFulfilled, onRejected);
    },
    limit(n?: number) {
      return Promise.resolve(n === undefined ? rows : rows.slice(0, n));
    },
  };
}

/**
 * Host-free stand-in for the `loadServerStatusRecords` query fan-out
 * (`resolveFleetPresence` + colocated lookups + `readDaemonStatusesForServers`).
 * `where()` is both thenable (presence/status) and `.limit()`-capable (colocated).
 */
function loadServerStatusRecordsDb(statuses: readonly LiveStatusRow[]): Db {
  const rows = statuses.map((row) => ({
    id: row.serverId,
    daemon: {
      key: {
        id: `key-${row.serverId}`,
        algorithm: "Ed25519",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
        fingerprint: `fp-${row.serverId}`,
        createdAt: "2020-01-01T00:00:00.000Z",
      },
      projection: { hostname: `host-${row.serverId}` },
    },
    metadata: null,
    hostname: `host-${row.serverId}`,
    machineKey: null,
    osId: null,
    osFamily: null,
    osVersion: null,
    osCodename: null,
    osPrettyName: null,
    osArchitecture: null,
    timezone: null,
    isTimeSyncEnabled: null,
    ntpServers: null,
    ntpLastSyncedAt: null,
    connected: row.connected,
    statusChangedAt: row.connected ? "2020-01-01T00:00:00.000Z" : null,
  }));
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return thenableRows(rows);
            },
          };
        },
      };
    },
  } as unknown as Db;
}

type LiveCellRecord = {
  status: string;
  result?: unknown;
  error?: string;
};

type CapturedCellRequest = {
  serverId: string;
  fabricId: unknown;
  probeMs: unknown;
  candidates: unknown;
};

function liveCollectRegistry(
  byServerId: ReadonlyMap<string, LiveCellRecord | Error | string>,
  captured: CapturedCellRequest[] = [],
): DaemonCellRegistry {
  return {
    getCell: (serverId: string) => ({
      createRequestAndWait: (envelope: {
        fabricId?: unknown;
        probeMs?: unknown;
        candidates?: unknown;
      }) => {
        captured.push({
          serverId,
          fabricId: envelope.fabricId,
          probeMs: envelope.probeMs,
          candidates: envelope.candidates,
        });
        const recordOrError = byServerId.get(serverId);
        if (recordOrError === undefined) {
          return Promise.reject(
            new Error(`unexpected cell request for ${serverId}`),
          );
        }
        if (recordOrError instanceof Error) return Promise.reject(recordOrError);
        if (typeof recordOrError === "string") {
          return Promise.reject(recordOrError);
        }
        return Promise.resolve(recordOrError);
      },
    }),
  } as unknown as DaemonCellRegistry;
}

function donePaths(peerPaths: ObservedPeerPath[]): LiveCellRecord {
  return { status: "done", result: { paths: peerPaths } };
}

test("requestFabricPaths returns parsed paths and skips malformed rows", async () => {
  const result = await requestFabricPaths(
    fakeRegistry({
      status: "done",
      result: {
        paths: [
          {
            publicKey: KEY_A,
            health: "healthy",
            endpoint: "203.0.113.10:51820",
            lastHandshakeAt: "2026-01-01T00:00:00.000Z",
            latencyMs: 12,
          },
          { publicKey: KEY_B, health: "stale" },
          { publicKey: KEY_GW, health: "never" },
          { publicKey: 1 },
          null,
          { publicKey: KEY_B, health: "unknown" },
          ["not-an-object"],
        ],
      },
    }),
    "srv-a",
    {
      fabricId: FABRIC_ID,
      probeMs: 100,
      candidates: [{ publicKey: KEY_B, endpoints: ["203.0.113.20:51820"] }],
    },
  );
  if (!result.ok) throw new TypeError("expected ok");
  assertEquals(result.paths, [
    {
      publicKey: KEY_A,
      health: "healthy",
      endpoint: "203.0.113.10:51820",
      lastHandshakeAt: "2026-01-01T00:00:00.000Z",
      latencyMs: 12,
    },
    { publicKey: KEY_B, health: "stale" },
    { publicKey: KEY_GW, health: "never" },
  ]);
});

test("requestFabricPaths maps expired, failed, malformed, and thrown results", async () => {
  const expired = await requestFabricPaths(
    fakeRegistry({ status: "expired" }),
    "srv-a",
    { fabricId: FABRIC_ID, probeMs: 0, candidates: [] },
  );
  assertEquals(expired, {
    ok: false,
    error: "timeout waiting for fabric paths",
    status: "expired",
  });

  const failed = await requestFabricPaths(
    fakeRegistry({ status: "failed", error: "compose unavailable" }),
    "srv-a",
    { fabricId: FABRIC_ID, probeMs: 0, candidates: [] },
  );
  assertEquals(failed, {
    ok: false,
    error: "compose unavailable",
    status: "failed",
  });

  const failedDefault = await requestFabricPaths(
    fakeRegistry({ status: "failed" }),
    "srv-a",
    { fabricId: FABRIC_ID, probeMs: 0, candidates: [] },
  );
  assertEquals(failedDefault, {
    ok: false,
    error: "failed to collect fabric paths",
    status: "failed",
  });

  const malformed = await requestFabricPaths(
    fakeRegistry({ status: "done", result: { paths: "nope" } }),
    "srv-a",
    { fabricId: FABRIC_ID, probeMs: 0, candidates: [] },
  );
  assertEquals(malformed, {
    ok: false,
    error: "invalid fabric paths result",
    status: "malformed",
  });

  const notObject = await requestFabricPaths(
    fakeRegistry({ status: "done", result: 12 }),
    "srv-a",
    { fabricId: FABRIC_ID, probeMs: 0, candidates: [] },
  );
  assertEquals(notObject, {
    ok: false,
    error: "invalid fabric paths result",
    status: "malformed",
  });

  const thrown = await requestFabricPaths(
    fakeRegistry(new Error("cell down")),
    "srv-a",
    { fabricId: FABRIC_ID, probeMs: 0, candidates: [] },
  );
  assertEquals(thrown, {
    ok: false,
    error: "cell down",
    status: "failed",
  });

  const thrownString = await requestFabricPaths(
    fakeRegistry("boom"),
    "srv-a",
    { fabricId: FABRIC_ID, probeMs: 0, candidates: [] },
  );
  assertEquals(thrownString, {
    ok: false,
    error: "boom",
    status: "failed",
  });
});

test("collectFabricPathObservations returns empty when no relay is keyed", async () => {
  setCollectFabricPathObservationsForTests(null);
  const map = await collectFabricPathObservations({
    db: stampDb(),
    registry: fakeRegistry({ status: "done", result: { paths: [] } }),
    relays: [{ ...keyedRelay({ serverId: "srv-a", publicKey: KEY_A }), publicKey: null }],
    fabricId: FABRIC_ID,
  });
  assertEquals(map.size, 0);
});

test("collectFabricPathObservations skips keyed relays that are offline or missing presence", async () => {
  setCollectFabricPathObservationsForTests(null);
  const captured: CapturedCellRequest[] = [];
  const registry = liveCollectRegistry(new Map(), captured);

  const offline = await collectFabricPathObservations({
    db: loadServerStatusRecordsDb([
      { serverId: "srv-a", connected: false },
      { serverId: "srv-b", connected: false },
    ]),
    registry,
    relays: [
      keyedRelay({ serverId: "srv-a", publicKey: KEY_A }),
      keyedRelay({ serverId: "srv-b", publicKey: KEY_B }),
    ],
    fabricId: FABRIC_ID,
  });
  assertEquals(offline.size, 0);

  const missing = await collectFabricPathObservations({
    db: loadServerStatusRecordsDb([]),
    registry,
    relays: [
      keyedRelay({ serverId: "srv-a", publicKey: KEY_A }),
      keyedRelay({ serverId: "srv-b", publicKey: KEY_B }),
    ],
    fabricId: FABRIC_ID,
  });
  assertEquals(missing.size, 0);
  assertEquals(captured, []);
});

test("collectFabricPathObservations probes only live relays and records successful paths", async () => {
  setCollectFabricPathObservationsForTests(null);
  const captured: CapturedCellRequest[] = [];
  const aPaths = paths(KEY_B, "203.0.113.20:51820");
  const registry = liveCollectRegistry(
    new Map<string, LiveCellRecord | Error | string>([
      ["srv-a", donePaths(aPaths)],
      ["srv-offline", donePaths(paths(KEY_A, "203.0.113.10:51820"))],
    ]),
    captured,
  );
  const candidates = [{ publicKey: KEY_B, endpoints: ["203.0.113.20:51820"] }];
  const map = await collectFabricPathObservations({
    db: loadServerStatusRecordsDb([
      { serverId: "srv-a", connected: true },
      { serverId: "srv-offline", connected: false },
    ]),
    registry,
    relays: [
      keyedRelay({ serverId: "srv-a", publicKey: KEY_A }),
      keyedRelay({ serverId: "srv-offline", publicKey: KEY_B }),
    ],
    fabricId: FABRIC_ID,
    probeMs: 250,
    candidatesByServerId: new Map([["srv-a", candidates]]),
  });
  assertEquals([...map.keys()], ["srv-a"]);
  assertEquals(map.get("srv-a"), aPaths);
  assertEquals(captured.length, 1);
  assertEquals(captured[0]?.serverId, "srv-a");
  assertEquals(captured[0]?.fabricId, FABRIC_ID);
  assertEquals(captured[0]?.probeMs, 250);
  assertEquals(captured[0]?.candidates, candidates);
});

test("collectFabricPathObservations omits live relays whose cell request is not ok", async () => {
  setCollectFabricPathObservationsForTests(null);
  const captured: CapturedCellRequest[] = [];
  const okPaths = paths(KEY_B, "203.0.113.20:51820");
  const map = await collectFabricPathObservations({
    db: loadServerStatusRecordsDb([
      { serverId: "srv-a", connected: true },
      { serverId: "srv-expired", connected: true },
      { serverId: "srv-failed", connected: true },
      { serverId: "srv-malformed", connected: true },
    ]),
    registry: liveCollectRegistry(
      new Map<string, LiveCellRecord | Error | string>([
        ["srv-a", donePaths(okPaths)],
        ["srv-expired", { status: "expired" }],
        ["srv-failed", { status: "failed", error: "compose unavailable" }],
        ["srv-malformed", { status: "done", result: { paths: "nope" } }],
      ]),
      captured,
    ),
    relays: [
      keyedRelay({ serverId: "srv-a", publicKey: KEY_A }),
      keyedRelay({ serverId: "srv-expired", publicKey: KEY_B }),
      keyedRelay({ serverId: "srv-failed", publicKey: KEY_GW }),
      keyedRelay({
        serverId: "srv-malformed",
        publicKey: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=",
      }),
    ],
    fabricId: FABRIC_ID,
  });
  assertEquals([...map.keys()], ["srv-a"]);
  assertEquals(map.get("srv-a"), okPaths);
  assertEquals(
    captured.map((row) => row.serverId).sort((a, b) => a.localeCompare(b)),
    ["srv-a", "srv-expired", "srv-failed", "srv-malformed"],
  );
  assertEquals(captured.every((row) => row.probeMs === 0), true);
});

test("collectFabricPathObservations fans out past the mapPool worker cap", async () => {
  setCollectFabricPathObservationsForTests(null);
  const captured: CapturedCellRequest[] = [];
  const live = Array.from({ length: 9 }, (_, index) => ({
    serverId: `srv-pool-${index}`,
    publicKey: `pool-${index}`,
    paths: paths(KEY_A, `203.0.113.${10 + index}:51820`),
  }));
  const map = await collectFabricPathObservations({
    db: loadServerStatusRecordsDb(
      live.map((row) => ({ serverId: row.serverId, connected: true })),
    ),
    registry: liveCollectRegistry(
      new Map(live.map((row) => [row.serverId, donePaths(row.paths)])),
      captured,
    ),
    relays: live.map((row) =>
      keyedRelay({ serverId: row.serverId, publicKey: row.publicKey })
    ),
    fabricId: FABRIC_ID,
  });
  assertEquals(map.size, 9);
  assertEquals(captured.length, 9);
  for (const row of live) {
    assertEquals(map.get(row.serverId), row.paths);
  }
});

test("classifyNatMapping ignores endpoints without a port", () => {
  const observations = new Map([
    ["gw-1", paths(KEY_A, "203.0.113.50")],
    ["gw-2", paths(KEY_A, "203.0.113.50")],
  ]);
  assertEquals(classifyNatMapping(observations, KEY_A), "unknown");
});

test("runFabricRendezvousRound is null without two keyed relays or observations", async () => {
  setCollectFabricPathObservationsForTests(null);
  assertEquals(
    await runFabricRendezvousRound({
      db: stampDb(),
      registry: fakeRegistry({ status: "done", result: { paths: [] } }),
      fabricId: FABRIC_ID,
      relays: [keyedRelay({ serverId: "srv-a", publicKey: KEY_A })],
      orgAllowRelay: false,
    }),
    null,
  );

  setCollectFabricPathObservationsForTests(() => Promise.resolve(new Map()));
  try {
    assertEquals(
      await runFabricRendezvousRound({
        db: stampDb(),
        registry: {} as DaemonCellRegistry,
        fabricId: FABRIC_ID,
        relays: [
          keyedRelay({ serverId: "srv-a", publicKey: KEY_A }),
          keyedRelay({ serverId: "srv-b", publicKey: KEY_B }),
        ],
        orgAllowRelay: false,
      }),
      null,
    );
  } finally {
    setCollectFabricPathObservationsForTests(null);
  }
});

test("fabricNeedsRendezvous is true until every pair is a healthy direct path", () => {
  const missingPaths = keyedRelay({ serverId: "srv-a", publicKey: KEY_A });
  const peer = keyedRelay({
    serverId: "srv-b",
    publicKey: KEY_B,
    peer: { serverId: "srv-a", selected: "direct_lan" },
  });
  assertEquals(fabricNeedsRendezvous([missingPaths, peer]), true);

  const unreachable = keyedRelay({
    serverId: "srv-a",
    publicKey: KEY_A,
    peer: { serverId: "srv-b", selected: "unreachable" },
  });
  assertEquals(fabricNeedsRendezvous([unreachable, peer]), true);

  const gateway = keyedRelay({
    serverId: "srv-a",
    publicKey: KEY_A,
    peer: { serverId: "srv-b", selected: "gateway" },
  });
  assertEquals(fabricNeedsRendezvous([gateway, peer]), true);

  const healthyA = keyedRelay({
    serverId: "srv-a",
    publicKey: KEY_A,
    peer: { serverId: "srv-b", selected: "direct_lan" },
  });
  const healthyB = keyedRelay({
    serverId: "srv-b",
    publicKey: KEY_B,
    peer: { serverId: "srv-a", selected: "direct_public" },
  });
  assertEquals(fabricNeedsRendezvous([healthyA, healthyB]), false);

  healthyA.metadata = {
    paths: {
      at: "2026-01-01T00:00:00.000Z",
      entries: [{
        peerServerId: "srv-b",
        selected: "direct_lan",
        degraded: true,
      }],
    },
  };
  assertEquals(fabricNeedsRendezvous([healthyA, healthyB]), true);
});

test("pathStatesFromRelayMetadata copies optional diagnostics fields", () => {
  const states = pathStatesFromRelayMetadata([
    {
      ...keyedRelay({ serverId: "srv-a", publicKey: KEY_A }),
      metadata: {
        paths: {
          at: "2026-01-01T00:00:00.000Z",
          entries: [{
            peerServerId: "srv-b",
            selected: "direct_nat",
            degraded: false,
            endpoint: "203.0.113.50:48172",
            viaServerId: "gw-1",
            lastHandshakeAt: "2026-01-01T00:00:00.000Z",
            latencyMs: 8,
          }],
        },
      },
    },
  ]);
  assertEquals(states.get(fabricPairCacheKey("srv-a", "srv-b")), {
    peerServerId: "srv-b",
    selected: "direct_nat",
    degraded: false,
    demoteStrikes: 0,
    promoteStrikes: 0,
    endpoint: "203.0.113.50:48172",
    viaServerId: "gw-1",
    lastHandshakeAt: "2026-01-01T00:00:00.000Z",
    latencyMs: 8,
  });
});

test("hydrateFabricPathStates keeps cache-only pairs and overlays metadata", () => {
  resetFabricPathStateCacheForTests();
  try {
    rememberFabricPathStates(
      FABRIC_ID,
      new Map([
        [fabricPairCacheKey("srv-a", "srv-b"), {
          ...initialFabricPathState("srv-b"),
          selected: "gateway",
          demoteStrikes: 3,
          promoteStrikes: 1,
          endpoint: "203.0.113.9:51820",
        }],
        [fabricPairCacheKey("srv-b", "srv-a"), {
          ...initialFabricPathState("srv-a"),
          selected: "gateway",
          demoteStrikes: 2,
        }],
      ]),
    );
    const hydrated = hydrateFabricPathStates(FABRIC_ID, [
      keyedRelay({
        serverId: "srv-a",
        publicKey: KEY_A,
        peer: { serverId: "srv-b", selected: "direct_public" },
      }),
      keyedRelay({ serverId: "srv-b", publicKey: KEY_B }),
    ]);
    const state = hydrated.get(fabricPairCacheKey("srv-a", "srv-b"));
    assertEquals(state?.selected, "direct_public");
    assertEquals(state?.demoteStrikes, 3);
    assertEquals(state?.promoteStrikes, 1);
    assertEquals(state?.endpoint, undefined);
    assertEquals(
      hydrated.get(fabricPairCacheKey("srv-b", "srv-a"))?.demoteStrikes,
      2,
    );
  } finally {
    resetFabricPathStateCacheForTests();
  }
});

test("buildNatCandidateExchange skips relays without a public key", () => {
  const exchange = buildNatCandidateExchange({
    relays: [
      { serverId: "srv-a", publicKey: KEY_A },
      { serverId: "srv-blank", publicKey: "" },
      { serverId: "srv-b", publicKey: KEY_B },
    ],
    observations: new Map([
      ["gw-1", [
        ...paths(KEY_A, "203.0.113.50:48172"),
        ...paths(KEY_B, "198.51.100.20:51820"),
      ]],
    ]),
    natClass: new Map([
      ["srv-a", "easy"],
      ["srv-b", "easy"],
    ]),
    pathStates: new Map(),
  });
  assertEquals(exchange.get("srv-a"), [
    { publicKey: KEY_B, endpoints: ["198.51.100.20:51820"] },
  ]);
});
