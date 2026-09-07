/**
 * Host-free wave-5 coverage for TurboFabric reconcile snapshot/payload helpers
 * and membership / org compose-network purge (no Postgres).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import type { Db } from "../../db.ts";
import { composeNetworkHostName } from "../fabric/cidr.ts";
import {
  buildFabricReconcilePayload,
  buildFabricReconcilePayloadFromSnapshot,
  composeNetworkNamesByServer,
  deleteServerFabricMembership,
  type FabricReconcileSnapshot,
  type FabricRecord,
  hashFabricReconcileDesired,
  listEnvironmentComposeNetworks,
  loadFabricReconcileSnapshot,
  purgeOrganizationComposeNetworks,
  type RelayRecord,
} from "./fabric-records.ts";
import { ip, network, relay, subnet, server } from "./schema.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORG = "org-1";
const ENV = "env-1";
const FABRIC: FabricRecord = {
  id: "fab-1",
  organizationId: ORG,
  cidr: "10.250.0.0/16",
  options: { listenPort: 51830, mtu: 1420 },
};

const WG_KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const WG_KEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
const WG_KEY_C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=";

function emptyCaches(): FabricReconcileSnapshot["caches"] {
  return {
    publicAddressByServer: new Map(),
    reportedByServer: new Map(),
    datacenterMembershipsByServer: new Map(),
    addressPreferenceByDatacenter: new Map(),
    natEndpointByPair: new Map(),
    failedPathKindsByPair: new Map(),
  };
}

function relayRecord(
  overrides: Partial<RelayRecord> & Pick<
    RelayRecord,
    "id" | "serverId" | "address" | "publicKey" | "prefix"
  >,
): RelayRecord {
  return {
    fabricId: FABRIC.id,
    role: "member",
    keepalive: null,
    endpointAddress: null,
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
    ...overrides,
  };
}

function membershipPin(
  serverId: string,
  datacenterId: string,
  address: string,
) {
  return {
    ipId: `ip-${serverId}-${datacenterId}`,
    serverId,
    datacenterId,
    networkId: `net-${datacenterId}`,
    address,
    family: 4 as const,
  };
}

function thenableRows<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  return {
    limit: (n?: number) =>
      Promise.resolve(typeof n === "number" ? rows.slice(0, n) : rows),
    orderBy: () => thenableRows(rows),
    returning: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

const COLUMN_TO_FIELD: Record<string, string> = {
  fabric_id: "fabricId",
  server_id: "serverId",
  network_id: "networkId",
  organization_id: "organizationId",
  environment_id: "environmentId",
  datacenter_id: "datacenterId",
  id: "id",
  kind: "kind",
};

function extractWhereFilters(condition: unknown): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if ("encoder" in obj && "value" in obj) {
      const encoder = obj.encoder as { name?: string } | undefined;
      if (encoder?.name !== undefined) {
        filters[encoder.name] = obj.value;
      }
    }
    if ("queryChunks" in obj && Array.isArray(obj.queryChunks)) {
      let pendingColumn: string | undefined;
      for (const chunk of obj.queryChunks) {
        if (
          chunk && typeof chunk === "object" && "name" in chunk &&
          typeof (chunk as { name: unknown }).name === "string" &&
          "table" in chunk
        ) {
          pendingColumn = (chunk as { name: string }).name;
          continue;
        }
        if (pendingColumn && Array.isArray(chunk)) {
          const values = chunk
            .map((item) =>
              item && typeof item === "object" && "value" in item
                ? (item as { value: unknown }).value
                : item
            )
            .filter((value) => value !== undefined);
          if (values.length > 0) {
            filters[pendingColumn] = values.length === 1 ? values[0] : values;
          }
          pendingColumn = undefined;
        }
        visit(chunk);
      }
      return;
    }
    if ("value" in obj && Array.isArray(obj.value)) {
      for (const item of obj.value) visit(item);
    }
  };
  visit(condition);
  return filters;
}

function matchesWhere(
  row: Record<string, unknown>,
  condition: unknown,
): boolean {
  const filters = extractWhereFilters(condition);
  for (const [column, expected] of Object.entries(filters)) {
    const field = COLUMN_TO_FIELD[column] ?? column;
    const actual = row[field];
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function filterRows<T extends Record<string, unknown>>(
  rows: T[],
  condition: unknown,
): T[] {
  if (condition === undefined) return rows;
  return rows.filter((row) => matchesWhere(row, condition));
}

type ServerRow = {
  id: string;
  organizationId: string;
  metadata?: unknown;
};
type RelayRow = {
  id: string;
  fabricId: string;
  serverId: string;
  address: string;
  role: string;
  keepalive: number | null;
  endpointAddress: string | null;
  publicKey: string | null;
  prefix: string;
  advertisedCidrs: string[];
  metadata: unknown;
  options?: unknown;
  presharedKey?: string | null;
};
type NetworkRow = {
  id: string;
  organizationId: string;
  environmentId: string;
  kind: string;
  name: string;
  cidr: string | null;
  datacenterId?: string | null;
  options: Record<string, unknown>;
};
type SegmentRow = {
  id: string;
  networkId: string;
  serverId: string;
  cidr: string;
  options: unknown;
};
type IpRow = {
  ipId?: string;
  serverId: string;
  address: string;
  scope: string;
  createdAt: string;
  datacenterId?: string | null;
  networkId?: string | null;
};

type ReconcileDb = Db & {
  relays: RelayRow[];
  networks: NetworkRow[];
  segments: SegmentRow[];
  servers: ServerRow[];
  ips: IpRow[];
};

function segmentMatchesDelete(row: SegmentRow, condition: unknown): boolean {
  const filters = extractWhereFilters(condition);
  if (Object.keys(filters).length === 0) return true;
  if (filters.server_id !== undefined && row.serverId !== filters.server_id) {
    return false;
  }
  if (filters.network_id !== undefined) {
    const networkFilter = filters.network_id;
    if (Array.isArray(networkFilter)) {
      return networkFilter.includes(row.networkId);
    }
    return row.networkId === networkFilter;
  }
  return true;
}

function relayMatchesDelete(row: RelayRow, condition: unknown): boolean {
  const filters = extractWhereFilters(condition);
  if (Object.keys(filters).length === 0) return true;
  if (filters.server_id !== undefined && row.serverId !== filters.server_id) {
    return false;
  }
  return true;
}

function networkMatchesDelete(row: NetworkRow, condition: unknown): boolean {
  const filters = extractWhereFilters(condition);
  if (Object.keys(filters).length === 0) return true;
  if (filters.id !== undefined) {
    const idFilter = filters.id;
    if (Array.isArray(idFilter)) return idFilter.includes(row.id);
    return row.id === idFilter;
  }
  return true;
}

function createReconcileDb(opts: {
  servers?: ServerRow[];
  relays?: RelayRow[];
  networks?: NetworkRow[];
  segments?: SegmentRow[];
  ips?: IpRow[];
} = {}): ReconcileDb {
  const servers = [...(opts.servers ?? [])];
  const relays = [...(opts.relays ?? [])];
  const networks = [...(opts.networks ?? [])];
  const segments = [...(opts.segments ?? [])];
  const ips = [...(opts.ips ?? [])];

  const db = {
    servers,
    relays,
    networks,
    segments,
    ips,
    select: (fields: Record<string, unknown>) => {
      const keys = Object.keys(fields).sort((a, b) => a.localeCompare(b));
      const keySet = new Set(keys);

      if (keySet.has("presharedKey") && keySet.has("id") && keys.length === 2) {
        return {
          from: (table: unknown) => ({
            where: (condition?: unknown) => {
              if (table !== relay) return thenableRows([]);
              const ids = extractWhereFilters(condition).id;
              const idList = Array.isArray(ids) ? ids : ids ? [ids] : [];
              const rows = relays
                .filter((row) => idList.length === 0 || idList.includes(row.id))
                .map((row) => ({
                  id: row.id,
                  presharedKey: row.presharedKey ?? null,
                }));
              return thenableRows(rows);
            },
          }),
        };
      }

      if (keySet.has("ipId") && keySet.has("datacenterId")) {
        return {
          from: (table: unknown) => ({
            where: (condition?: unknown) => {
              if (table !== ip) return thenableRows([]);
              return thenableRows(
                filterRows(ips, condition).map((row) => ({
                  ipId: row.ipId ?? `ip-${row.serverId}`,
                  serverId: row.serverId,
                  datacenterId: row.datacenterId ?? null,
                  networkId: row.networkId ?? null,
                  address: row.address,
                })),
              );
            },
          }),
        };
      }

      if (
        keySet.has("serverId") && keySet.has("address") &&
        keySet.has("scope") && keySet.has("createdAt")
      ) {
        return {
          from: (table: unknown) => ({
            where: (condition?: unknown) => {
              if (table !== ip) return thenableRows([]);
              const filtered = filterRows(ips, condition);
              const sorted = [...filtered].sort((a, b) =>
                a.createdAt.localeCompare(b.createdAt)
              );
              return thenableRows(sorted);
            },
          }),
        };
      }

      if (
        keys.length === 2 && keySet.has("metadata") && keySet.has("id")
      ) {
        return {
          from: (table: unknown) => ({
            where: (condition?: unknown) => {
              if (table !== server) return thenableRows([]);
              return thenableRows(
                filterRows(servers, condition).map((row) => ({
                  id: row.id,
                  metadata: row.metadata ?? null,
                })),
              );
            },
          }),
        };
      }

      return {
        from: (table: unknown) => ({
          where: (condition?: unknown) => {
            if (table === relay) {
              return thenableRows(
                filterRows(relays, condition).map((row) => ({ ...row })),
              );
            }
            if (table === network) {
              if (keys.length === 1 && keys[0] === "id") {
                return thenableRows(
                  filterRows(networks, condition).map((row) => ({
                    id: row.id,
                  })),
                );
              }
              return thenableRows(filterRows(networks, condition));
            }
            if (table === subnet) {
              return thenableRows(filterRows(segments, condition));
            }
            if (table === server) {
              return thenableRows(filterRows(servers, condition));
            }
            return thenableRows([]);
          },
          leftJoin: (_segmentTable: unknown, _on: unknown) => ({
            where: (condition?: unknown) => {
              const filtered = filterRows(networks, condition);
              const rows: Array<{
                networkId: string;
                serverId: string | null;
                subnet: string | null;
              }> = [];
              for (const net of filtered) {
                const segs = segments.filter((seg) => seg.networkId === net.id);
                if (segs.length === 0) {
                  rows.push({
                    networkId: net.id,
                    serverId: null,
                    subnet: null,
                  });
                } else {
                  for (const seg of segs) {
                    rows.push({
                      networkId: net.id,
                      serverId: seg.serverId,
                      subnet: seg.cidr,
                    });
                  }
                }
              }
              return thenableRows(rows);
            },
          }),
        }),
      };
    },
    delete: (table: unknown) => ({
      where: (condition?: unknown) => {
        if (table === subnet) {
          const next = segments.filter((row) =>
            !segmentMatchesDelete(row, condition)
          );
          segments.length = 0;
          segments.push(...next);
        }
        if (table === relay) {
          const next = relays.filter((row) =>
            !relayMatchesDelete(row, condition)
          );
          relays.length = 0;
          relays.push(...next);
        }
        if (table === network) {
          const next = networks.filter((row) =>
            !networkMatchesDelete(row, condition)
          );
          networks.length = 0;
          networks.push(...next);
        }
        return thenableRows([]);
      },
    }),
  };

  return db as unknown as ReconcileDb;
}

function sampleRelays(): RelayRow[] {
  return [
    {
      id: "r1",
      fabricId: FABRIC.id,
      serverId: "srv-1",
      address: "10.250.0.1",
      role: "member",
      keepalive: 25,
      endpointAddress: "203.0.113.10",
      publicKey: WG_KEY_A,
      prefix: "10.192.0.0/16",
      advertisedCidrs: [],
      metadata: {},
      presharedKey: "seal-a",
    },
    {
      id: "r2",
      fabricId: FABRIC.id,
      serverId: "srv-2",
      address: "10.250.0.2",
      role: "gateway",
      keepalive: null,
      endpointAddress: "203.0.113.11",
      publicKey: WG_KEY_B,
      prefix: "10.193.0.0/16",
      advertisedCidrs: ["10.200.0.0/16"],
      metadata: {},
      presharedKey: null,
    },
    {
      id: "r3",
      fabricId: FABRIC.id,
      serverId: "srv-3",
      address: "10.250.0.3",
      role: "member",
      keepalive: null,
      endpointAddress: "203.0.113.12",
      publicKey: null,
      prefix: "10.194.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    },
  ];
}

test("loadFabricReconcileSnapshot batches relays PSK envelopes segments and caches", async () => {
  const db = createReconcileDb({
    relays: sampleRelays(),
    servers: [
      {
        id: "srv-1",
        organizationId: ORG,
        metadata: {
          ips: [{ address: "198.51.100.1", version: 4, scope: "public" }],
        },
      },
      { id: "srv-2", organizationId: ORG },
    ],
    ips: [{
      serverId: "srv-2",
      address: "203.0.113.99",
      scope: "public",
      createdAt: "2020-01-01T00:00:00.000Z",
    }],
    segments: [{
      id: "seg-1",
      networkId: "net-compose-a",
      serverId: "srv-1",
      cidr: "10.192.10.0/24",
      options: { gateway: "10.192.10.1" },
    }],
  });

  const snapshot = await loadFabricReconcileSnapshot(db, FABRIC);

  assertEquals(snapshot.fabric.id, FABRIC.id);
  assertEquals(snapshot.relays.length, 3);
  assertEquals(snapshot.sealedPresharedKeyByRelayId.get("r1"), "seal-a");
  assertEquals(snapshot.sealedPresharedKeyByRelayId.get("r2"), null);
  assertEquals(snapshot.segmentsByServer.get("srv-1")?.length, 1);
  assertEquals(
    snapshot.segmentsByServer.get("srv-1")?.[0]?.name,
    "tpn_net-compose-a",
  );
  assertEquals(
    snapshot.segmentsByServer.get("srv-1")?.[0]?.gateway,
    "10.192.10.1",
  );
  assertEquals(snapshot.segmentsByServer.get("srv-2")?.length, 0);
  assertEquals(
    snapshot.caches.publicAddressByServer.get("srv-2"),
    "203.0.113.99",
  );
  assertEquals(snapshot.caches.datacenterMembershipsByServer.size, 0);
  assertEquals(snapshot.caches.addressPreferenceByDatacenter.size, 0);
  assertEquals(
    snapshot.caches.reportedByServer.get("srv-1")?.map((ip) => ip.address),
    ["198.51.100.1"],
  );
  assertEquals(snapshot.derivedAdvertisedCidrsByRelayId.get("r1"), []);
  assertEquals(snapshot.derivedAdvertisedCidrsByRelayId.get("r2"), [
    "10.200.0.0/16",
  ]);
  assertEquals(snapshot.derivedAdvertisedCidrsByRelayId.has("r3"), false);
  assertEquals(snapshot.policy, { allowRelay: false });
  assertEquals(snapshot.relays[0]?.allowRelay, null);
  assertEquals(snapshot.relays[0]?.preferredGatewayIds, []);
});

test("loadFabricReconcileSnapshot returns empty maps when fabric has no relays", async () => {
  const db = createReconcileDb();
  const snapshot = await loadFabricReconcileSnapshot(db, FABRIC);
  assertEquals(snapshot.relays, []);
  assertEquals(snapshot.sealedPresharedKeyByRelayId.size, 0);
  assertEquals(snapshot.segmentsByServer.size, 0);
  assertEquals(snapshot.derivedAdvertisedCidrsByRelayId.size, 0);
});

test("buildFabricReconcilePayloadFromSnapshot returns null for unknown server", async () => {
  const snapshot: FabricReconcileSnapshot = {
    fabric: FABRIC,
    relays: [],
    caches: emptyCaches(),
    sealedPresharedKeyByRelayId: new Map(),
    segmentsByServer: new Map(),
    derivedAdvertisedCidrsByRelayId: new Map(),
    policy: { allowRelay: false },
  };
  const built = await buildFabricReconcilePayloadFromSnapshot(snapshot, {
    serverId: "missing",
  });
  assertEquals(built, null);
});

test("buildFabricReconcilePayloadFromSnapshot returns null when relay address is invalid", async () => {
  const relays: RelayRecord[] = [{
    id: "r-bad",
    fabricId: FABRIC.id,
    serverId: "srv-bad",
    address: "not-an-ip",
    role: "member",
    keepalive: null,
    endpointAddress: "203.0.113.10",
    publicKey: WG_KEY_A,
    prefix: "10.192.0.0/16",
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
  }];
  const snapshot: FabricReconcileSnapshot = {
    fabric: FABRIC,
    relays,
    caches: emptyCaches(),
    sealedPresharedKeyByRelayId: new Map(),
    segmentsByServer: new Map([["srv-bad", []]]),
    derivedAdvertisedCidrsByRelayId: new Map(),
    policy: { allowRelay: false },
  };
  const built = await buildFabricReconcilePayloadFromSnapshot(snapshot, {
    serverId: "srv-bad",
  });
  assertEquals(built, null);
});

test("buildFabricReconcilePayloadFromSnapshot includes compose networks and mtu override", async () => {
  const relays: RelayRecord[] = [{
    id: "r1",
    fabricId: FABRIC.id,
    serverId: "srv-1",
    address: "10.250.0.1",
    role: "member",
    keepalive: null,
    endpointAddress: "203.0.113.10",
    publicKey: WG_KEY_A,
    prefix: "10.192.0.0/16",
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
  }];
  const snapshot: FabricReconcileSnapshot = {
    fabric: FABRIC,
    relays,
    caches: emptyCaches(),
    sealedPresharedKeyByRelayId: new Map([["r1", null]]),
    segmentsByServer: new Map([
      ["srv-1", [{
        name: "tpn_net-a",
        subnet: "10.192.5.0/24",
        mtu: 1500,
      }]],
    ]),
    derivedAdvertisedCidrsByRelayId: new Map(),
    policy: { allowRelay: false },
  };
  const built = await buildFabricReconcilePayloadFromSnapshot(snapshot, {
    serverId: "srv-1",
    mtu: 1400,
  });
  if (!built?.payload.enabled) throw new TypeError("expected enabled payload");
  assertEquals(built.payload.mtu, 1400);
  assertEquals(built.payload.listenPort, 51830);
  assertEquals(built.payload.address, "10.250.0.1/32");
  assertEquals(built.payload.networks?.length, 1);
  assertEquals(built.payload.networks?.[0]?.subnet, "10.192.5.0/24");
  assertEquals(built.payload.peers.length, 0);
  assertEquals(built.desiredHash.length > 0, true);
});

test("buildFabricReconcilePayloadFromSnapshot omits networks and skips peers without publicKey", async () => {
  const relays: RelayRecord[] = [
    {
      id: "r1",
      fabricId: FABRIC.id,
      serverId: "srv-1",
      address: "10.250.0.1",
      role: "member",
      keepalive: null,
      endpointAddress: "203.0.113.10",
      publicKey: WG_KEY_A,
      prefix: "10.192.0.0/16",
      advertisedCidrs: [],
      metadata: {},
      allowRelay: null,
      preferredGatewayIds: [],
    },
    {
      id: "r2",
      fabricId: FABRIC.id,
      serverId: "srv-2",
      address: "10.250.0.2",
      role: "member",
      keepalive: null,
      endpointAddress: "203.0.113.11",
      publicKey: null,
      prefix: "10.193.0.0/16",
      advertisedCidrs: [],
      metadata: {},
      allowRelay: null,
      preferredGatewayIds: [],
    },
  ];
  const snapshot: FabricReconcileSnapshot = {
    fabric: { ...FABRIC, options: null },
    relays,
    caches: emptyCaches(),
    sealedPresharedKeyByRelayId: new Map([["r1", null], ["r2", null]]),
    segmentsByServer: new Map([["srv-1", []], ["srv-2", []]]),
    derivedAdvertisedCidrsByRelayId: new Map(),
    policy: { allowRelay: false },
  };
  const built = await buildFabricReconcilePayloadFromSnapshot(snapshot, {
    serverId: "srv-1",
  });
  if (!built?.payload.enabled) throw new TypeError("expected enabled payload");
  assertEquals("networks" in built.payload, false);
  assertEquals(built.payload.peers.length, 0);
  assertEquals(built.payload.listenPort, 51821);
  assertEquals(built.payload.mtu, 1420);
});

test("buildFabricReconcilePayloadFromSnapshot hash reflects peer keepalive", async () => {
  const baseRelay: RelayRecord = {
    id: "r2",
    fabricId: FABRIC.id,
    serverId: "srv-2",
    address: "10.250.0.2",
    role: "member",
    keepalive: null,
    endpointAddress: "203.0.113.11",
    publicKey: WG_KEY_B,
    prefix: "10.193.0.0/16",
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
  };
  const selfRelay: RelayRecord = {
    id: "r1",
    fabricId: FABRIC.id,
    serverId: "srv-1",
    address: "10.250.0.1",
    role: "member",
    keepalive: null,
    endpointAddress: "203.0.113.10",
    publicKey: WG_KEY_A,
    prefix: "10.192.0.0/16",
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
  };
  const caches = emptyCaches();
  const withKeepalive = await buildFabricReconcilePayloadFromSnapshot({
    fabric: FABRIC,
    relays: [selfRelay, { ...baseRelay, keepalive: 25 }],
    caches,
    sealedPresharedKeyByRelayId: new Map([["r1", null], ["r2", null]]),
    segmentsByServer: new Map([["srv-1", []], ["srv-2", []]]),
    derivedAdvertisedCidrsByRelayId: new Map(),
    policy: { allowRelay: false },
  }, { serverId: "srv-1" });
  const withoutKeepalive = await buildFabricReconcilePayloadFromSnapshot({
    fabric: FABRIC,
    relays: [selfRelay, baseRelay],
    caches,
    sealedPresharedKeyByRelayId: new Map([["r1", null], ["r2", null]]),
    segmentsByServer: new Map([["srv-1", []], ["srv-2", []]]),
    derivedAdvertisedCidrsByRelayId: new Map(),
    policy: { allowRelay: false },
  }, { serverId: "srv-1" });
  if (!withKeepalive || !withoutKeepalive) {
    throw new TypeError("expected reconcile payloads");
  }
  assertNotEquals(withKeepalive.desiredHash, withoutKeepalive.desiredHash);
  if (!withKeepalive.payload.enabled) throw new TypeError("expected enabled");
  assertEquals(withKeepalive.payload.peers[0]?.keepalive, 25);
});

test("buildFabricReconcilePayloadFromSnapshot omits unreachable peers and still builds", async () => {
  const selfRelay: RelayRecord = {
    id: "r1",
    fabricId: FABRIC.id,
    serverId: "srv-1",
    address: "10.250.0.1",
    role: "member",
    keepalive: null,
    endpointAddress: "203.0.113.10",
    publicKey: WG_KEY_A,
    prefix: "10.192.0.0/16",
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
  };
  const reachable: RelayRecord = {
    id: "r2",
    fabricId: FABRIC.id,
    serverId: "srv-2",
    address: "10.250.0.2",
    role: "member",
    keepalive: null,
    endpointAddress: "203.0.113.11",
    publicKey: WG_KEY_B,
    prefix: "10.193.0.0/16",
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
  };
  const unreachable: RelayRecord = {
    id: "r3",
    fabricId: FABRIC.id,
    serverId: "srv-3",
    address: "10.250.0.3",
    role: "member",
    keepalive: null,
    endpointAddress: null,
    publicKey: WG_KEY_C,
    prefix: "10.194.0.0/16",
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
  };
  const built = await buildFabricReconcilePayloadFromSnapshot({
    fabric: FABRIC,
    relays: [selfRelay, reachable, unreachable],
    caches: emptyCaches(),
    sealedPresharedKeyByRelayId: new Map([
      ["r1", null],
      ["r2", null],
      ["r3", null],
    ]),
    segmentsByServer: new Map([
      ["srv-1", []],
      ["srv-2", []],
      ["srv-3", []],
    ]),
    derivedAdvertisedCidrsByRelayId: new Map(),
    policy: { allowRelay: false },
  }, { serverId: "srv-1" });
  if (!built?.payload.enabled) throw new TypeError("expected enabled payload");
  assertEquals(built.payload.peers.length, 1);
  assertEquals(built.payload.peers[0]?.publicKey, WG_KEY_B);
  assertEquals(built.unreachablePeers, [{ serverId: "srv-3" }]);
});

test("buildFabricReconcilePayloadFromSnapshot hash reflects peer pathKind", async () => {
  const selfRelay: RelayRecord = {
    id: "r1",
    fabricId: FABRIC.id,
    serverId: "srv-1",
    address: "10.250.0.1",
    role: "member",
    keepalive: null,
    endpointAddress: "203.0.113.10",
    publicKey: WG_KEY_A,
    prefix: "10.192.0.0/16",
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
  };
  const other: RelayRecord = {
    id: "r2",
    fabricId: FABRIC.id,
    serverId: "srv-2",
    address: "10.250.0.2",
    role: "member",
    keepalive: null,
    endpointAddress: null,
    publicKey: WG_KEY_B,
    prefix: "10.193.0.0/16",
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
  };
  const lanCaches = emptyCaches();
  lanCaches.datacenterMembershipsByServer.set("srv-1", [{
    ipId: "ip-1",
    serverId: "srv-1",
    datacenterId: "dc-a",
    networkId: "net-a",
    address: "10.0.0.1",
    family: 4,
  }]);
  lanCaches.datacenterMembershipsByServer.set("srv-2", [{
    ipId: "ip-2",
    serverId: "srv-2",
    datacenterId: "dc-a",
    networkId: "net-a",
    address: "203.0.113.11",
    family: 4,
  }]);
  lanCaches.addressPreferenceByDatacenter.set("dc-a", "ipv4");
  lanCaches.publicAddressByServer.set("srv-2", "198.51.100.11");
  const publicCaches = emptyCaches();
  publicCaches.publicAddressByServer.set("srv-2", "203.0.113.11");
  const snapshotBase = {
    fabric: FABRIC,
    relays: [selfRelay, other],
    sealedPresharedKeyByRelayId: new Map([["r1", null], ["r2", null]]),
    segmentsByServer: new Map([["srv-1", []], ["srv-2", []]]),
    derivedAdvertisedCidrsByRelayId: new Map(),
    policy: { allowRelay: false },
  };
  const lanBuilt = await buildFabricReconcilePayloadFromSnapshot({
    ...snapshotBase,
    caches: lanCaches,
  }, { serverId: "srv-1" });
  const publicBuilt = await buildFabricReconcilePayloadFromSnapshot({
    ...snapshotBase,
    caches: publicCaches,
  }, { serverId: "srv-1" });
  if (!lanBuilt?.payload.enabled || !publicBuilt?.payload.enabled) {
    throw new TypeError("expected enabled payloads");
  }
  assertEquals(lanBuilt.payload.peers[0]?.endpoint, "203.0.113.11:51830");
  assertEquals(publicBuilt.payload.peers[0]?.endpoint, "203.0.113.11:51830");
  assertNotEquals(lanBuilt.desiredHash, publicBuilt.desiredHash);
});

test("buildFabricReconcilePayloadFromSnapshot omits a reported private IPv4 as a public path", async () => {
  const selfRelay: RelayRecord = {
    id: "r1",
    fabricId: FABRIC.id,
    serverId: "srv-1",
    address: "10.250.0.1",
    role: "member",
    keepalive: null,
    endpointAddress: "203.0.113.10",
    publicKey: WG_KEY_A,
    prefix: "10.192.0.0/16",
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
  };
  const other: RelayRecord = {
    id: "r2",
    fabricId: FABRIC.id,
    serverId: "srv-2",
    address: "10.250.0.2",
    role: "member",
    keepalive: null,
    endpointAddress: null,
    publicKey: WG_KEY_B,
    prefix: "10.193.0.0/16",
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
  };
  const caches = emptyCaches();
  caches.datacenterMembershipsByServer.set("srv-1", [{
    ipId: "ip-1",
    serverId: "srv-1",
    datacenterId: "dc-a",
    networkId: "net-a",
    address: "10.0.0.1",
    family: 4,
  }]);
  caches.datacenterMembershipsByServer.set("srv-2", [{
    ipId: "ip-2",
    serverId: "srv-2",
    datacenterId: "dc-b",
    networkId: "net-b",
    address: "10.8.0.5",
    family: 4,
  }]);
  caches.reportedByServer.set("srv-2", [
    { address: "10.8.0.5", version: 4, scope: "private" },
  ]);
  const snapshotBase = {
    fabric: FABRIC,
    relays: [selfRelay, other],
    sealedPresharedKeyByRelayId: new Map([["r1", null], ["r2", null]]),
    segmentsByServer: new Map([["srv-1", []], ["srv-2", []]]),
    derivedAdvertisedCidrsByRelayId: new Map(),
    policy: { allowRelay: false },
  };
  const privateOnly = await buildFabricReconcilePayloadFromSnapshot({
    ...snapshotBase,
    caches,
  }, { serverId: "srv-1" });
  if (!privateOnly?.payload.enabled) {
    throw new TypeError("expected enabled payload");
  }
  assertEquals(privateOnly.payload.peers, []);
  assertEquals(privateOnly.unreachablePeers, [{ serverId: "srv-2" }]);

  caches.reportedByServer.set("srv-2", [
    { address: "10.8.0.5", version: 4, scope: "private" },
    { address: "203.0.113.9", version: 4, scope: "public" },
  ]);
  const withPublic = await buildFabricReconcilePayloadFromSnapshot({
    ...snapshotBase,
    caches,
  }, { serverId: "srv-1" });
  if (!withPublic?.payload.enabled) {
    throw new TypeError("expected enabled payload");
  }
  assertEquals(withPublic.payload.peers.length, 1);
  assertEquals(withPublic.payload.peers[0]?.endpoint, "203.0.113.9:51830");
  assertEquals(withPublic.unreachablePeers, []);
});

test("buildFabricReconcilePayload loads snapshot from db", async () => {
  const db = createReconcileDb({
    relays: sampleRelays().slice(0, 2),
    segments: [],
  });
  const built = await buildFabricReconcilePayload(db, {
    fabric: FABRIC,
    serverId: "srv-1",
    resealPresharedKey: (sealed) => Promise.resolve(`plain:${sealed}`),
  });
  if (!built?.payload.enabled) throw new TypeError("expected enabled payload");
  assertEquals(built.payload.peers.length, 1);
  assertEquals(built.payload.peers[0]?.publicKey, WG_KEY_B);
  assertEquals(built.payload.peers[0]?.presharedKeyEnvelope, "plain:seal-a");
});

test("loadFabricReconcileSnapshot derives gateway IPv4 subnets into peer allowedIPs", async () => {
  const relays: RelayRow[] = [
    {
      id: "r1",
      fabricId: FABRIC.id,
      serverId: "srv-1",
      address: "10.250.0.1",
      role: "member",
      keepalive: null,
      endpointAddress: "203.0.113.10",
      publicKey: WG_KEY_A,
      prefix: "10.192.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    },
    {
      id: "r2",
      fabricId: FABRIC.id,
      serverId: "srv-2",
      address: "10.250.0.2",
      role: "gateway",
      keepalive: null,
      endpointAddress: "203.0.113.11",
      publicKey: WG_KEY_B,
      prefix: "10.193.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    },
  ];
  const db = createReconcileDb({
    relays,
    ips: [{
      ipId: "ip-gw",
      serverId: "srv-2",
      address: "203.0.113.11",
      scope: "datacenter",
      createdAt: "2020-01-01T00:00:00.000Z",
      datacenterId: "dc-a",
      networkId: "net-v5-a",
    }],
    networks: [
      {
        id: "net-v5-a",
        organizationId: ORG,
        environmentId: ENV,
        kind: "datacenter",
        name: "site-a",
        cidr: "203.0.113.0/24",
        datacenterId: "dc-a",
        options: {},
      },
      {
        id: "net-v5-b",
        organizationId: ORG,
        environmentId: ENV,
        kind: "datacenter",
        name: "site-b",
        cidr: "198.51.100.0/24",
        datacenterId: "dc-a",
        options: {},
      },
      {
        id: "net-v6",
        organizationId: ORG,
        environmentId: ENV,
        kind: "datacenter",
        name: "site-v6",
        cidr: "2001:db8::/32",
        datacenterId: "dc-a",
        options: {},
      },
    ],
  });

  const snapshot = await loadFabricReconcileSnapshot(db, FABRIC);
  assertEquals(snapshot.derivedAdvertisedCidrsByRelayId.get("r1"), []);
  assertEquals(snapshot.derivedAdvertisedCidrsByRelayId.get("r2"), [
    "198.51.100.0/24",
    "203.0.113.0/24",
  ]);

  const built = await buildFabricReconcilePayloadFromSnapshot(snapshot, {
    serverId: "srv-1",
  });
  if (!built?.payload.enabled) throw new TypeError("expected enabled payload");
  const allowedIPs = built.payload.peers[0]?.allowedIPs ?? [];
  assertEquals(allowedIPs.includes("198.51.100.0/24"), true);
  assertEquals(allowedIPs.includes("203.0.113.0/24"), true);
  assertEquals(allowedIPs.includes("2001:db8::/32"), false);

  db.networks.push({
    id: "net-v5-c",
    organizationId: ORG,
    environmentId: ENV,
    kind: "datacenter",
    name: "site-c",
    cidr: "192.0.2.0/24",
    datacenterId: "dc-a",
    options: {},
  });
  const nextSnapshot = await loadFabricReconcileSnapshot(db, FABRIC);
  const nextBuilt = await buildFabricReconcilePayloadFromSnapshot(
    nextSnapshot,
    { serverId: "srv-1" },
  );
  if (!nextBuilt) {
    throw new TypeError("expected reconcile payload after subnet add");
  }
  assertNotEquals(built.desiredHash, nextBuilt.desiredHash);
  if (!nextBuilt.payload.enabled) {
    throw new TypeError("expected enabled payload after subnet add");
  }
  assertEquals(
    nextBuilt.payload.peers[0]?.allowedIPs.includes("192.0.2.0/24"),
    true,
  );
});

test("loadFabricReconcileSnapshot assigns a shared subnet to the public-keyed gateway when the smaller relay id has no publicKey", async () => {
  const relays: RelayRow[] = [
    {
      id: "r-mem",
      fabricId: FABRIC.id,
      serverId: "srv-mem",
      address: "10.250.0.1",
      role: "member",
      keepalive: null,
      endpointAddress: "203.0.113.10",
      publicKey: WG_KEY_A,
      prefix: "10.192.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    },
    {
      id: "r-aaa",
      fabricId: FABRIC.id,
      serverId: "srv-aaa",
      address: "10.250.0.2",
      role: "gateway",
      keepalive: null,
      endpointAddress: "203.0.113.11",
      publicKey: null,
      prefix: "10.193.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    },
    {
      id: "r-zzz",
      fabricId: FABRIC.id,
      serverId: "srv-zzz",
      address: "10.250.0.3",
      role: "gateway",
      keepalive: null,
      endpointAddress: "203.0.113.12",
      publicKey: WG_KEY_B,
      prefix: "10.194.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    },
  ];
  const db = createReconcileDb({
    relays,
    ips: [
      {
        ipId: "ip-aaa",
        serverId: "srv-aaa",
        address: "203.0.113.11",
        scope: "datacenter",
        createdAt: "2020-01-01T00:00:00.000Z",
        datacenterId: "dc-a",
        networkId: "net-v5",
      },
      {
        ipId: "ip-zzz",
        serverId: "srv-zzz",
        address: "203.0.113.12",
        scope: "datacenter",
        createdAt: "2020-01-01T00:00:00.000Z",
        datacenterId: "dc-a",
        networkId: "net-v5",
      },
    ],
    networks: [{
      id: "net-v5",
      organizationId: ORG,
      environmentId: ENV,
      kind: "datacenter",
      name: "site-a",
      cidr: "203.0.113.0/24",
      datacenterId: "dc-a",
      options: {},
    }],
  });

  const snapshot = await loadFabricReconcileSnapshot(db, FABRIC);
  assertEquals(snapshot.derivedAdvertisedCidrsByRelayId.has("r-aaa"), false);
  assertEquals(snapshot.derivedAdvertisedCidrsByRelayId.get("r-zzz"), [
    "203.0.113.0/24",
  ]);

  const built = await buildFabricReconcilePayloadFromSnapshot(snapshot, {
    serverId: "srv-mem",
  });
  if (!built?.payload.enabled) throw new TypeError("expected enabled payload");
  const keyedPeer = built.payload.peers.find((peer) =>
    peer.publicKey === WG_KEY_B
  );
  if (!keyedPeer) throw new TypeError("expected public-keyed gateway peer");
  assertEquals(keyedPeer.allowedIPs.includes("203.0.113.0/24"), true);
});

test("buildFabricReconcilePayloadFromSnapshot routes a destination through one gateway stanza", async () => {
  const selfRelay = relayRecord({
    id: "r1",
    serverId: "srv-1",
    address: "10.250.0.1",
    endpointAddress: "203.0.113.10",
    publicKey: WG_KEY_A,
    prefix: "10.192.0.0/16",
  });
  const gateway = relayRecord({
    id: "r-gw",
    serverId: "srv-gw",
    address: "10.250.0.10",
    role: "gateway",
    publicKey: WG_KEY_B,
    prefix: "10.200.0.0/16",
  });
  const routed = relayRecord({
    id: "r2",
    serverId: "srv-2",
    address: "10.250.0.2",
    publicKey: WG_KEY_C,
    prefix: "10.193.0.0/16",
  });
  const caches = emptyCaches();
  caches.datacenterMembershipsByServer.set("srv-1", [
    membershipPin("srv-1", "dc-src", "10.0.0.1"),
  ]);
  caches.datacenterMembershipsByServer.set("srv-gw", [
    membershipPin("srv-gw", "dc-dst", "10.0.1.2"),
  ]);
  caches.datacenterMembershipsByServer.set("srv-2", [
    membershipPin("srv-2", "dc-dst", "10.0.1.1"),
  ]);
  caches.addressPreferenceByDatacenter.set("dc-src", "ipv4");
  caches.addressPreferenceByDatacenter.set("dc-dst", "ipv4");
  caches.publicAddressByServer.set("srv-gw", "203.0.113.20");
  const built = await buildFabricReconcilePayloadFromSnapshot({
    fabric: FABRIC,
    relays: [selfRelay, gateway, routed],
    caches,
    sealedPresharedKeyByRelayId: new Map([
      ["r1", null],
      ["r-gw", null],
      ["r2", null],
    ]),
    segmentsByServer: new Map([
      ["srv-1", []],
      ["srv-gw", []],
      ["srv-2", []],
    ]),
    derivedAdvertisedCidrsByRelayId: new Map(),
    policy: { allowRelay: false },
  }, { serverId: "srv-1" });
  if (!built?.payload.enabled) throw new TypeError("expected enabled payload");
  assertEquals(built.payload.peers.length, 1);
  assertEquals(built.payload.peers[0]?.publicKey, WG_KEY_B);
  assertEquals(built.payload.peers[0]?.pathKind, "gateway");
  assertEquals(built.payload.peers[0]?.viaServerId, "srv-gw");
  const allowed = built.payload.peers[0]?.allowedIPs ?? [];
  assertEquals(allowed.includes("10.250.0.10/32"), true);
  assertEquals(allowed.includes("10.200.0.0/16"), true);
  assertEquals(allowed.includes("10.250.0.2/32"), true);
  assertEquals(allowed.includes("10.193.0.0/16"), true);
  const owned = new Set<string>();
  for (const peer of built.payload.peers) {
    for (const cidr of peer.allowedIPs) {
      assertEquals(owned.has(cidr), false);
      owned.add(cidr);
    }
  }
  assertEquals(built.gatewayRoutedPeers, [{
    serverId: "srv-2",
    viaServerId: "srv-gw",
  }]);
  assertEquals(built.unreachablePeers, []);
  assertEquals("gateway" in built.payload, false);
});

test("buildFabricReconcilePayloadFromSnapshot hash changes when the next hop changes", async () => {
  const selfRelay = relayRecord({
    id: "r1",
    serverId: "srv-1",
    address: "10.250.0.1",
    endpointAddress: "203.0.113.10",
    publicKey: WG_KEY_A,
    prefix: "10.192.0.0/16",
  });
  const gwFirst = relayRecord({
    id: "r-aaa",
    serverId: "srv-gw-a",
    address: "10.250.0.10",
    role: "gateway",
    publicKey: WG_KEY_B,
    prefix: "10.200.0.0/16",
  });
  const gwPreferred = relayRecord({
    id: "r-zzz",
    serverId: "srv-gw-z",
    address: "10.250.0.11",
    role: "gateway",
    publicKey: WG_KEY_C,
    prefix: "10.201.0.0/16",
  });
  const routed = relayRecord({
    id: "r2",
    serverId: "srv-2",
    address: "10.250.0.2",
    publicKey: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=",
    prefix: "10.193.0.0/16",
  });
  const caches = emptyCaches();
  caches.datacenterMembershipsByServer.set("srv-1", [
    membershipPin("srv-1", "dc-src", "10.0.0.1"),
  ]);
  caches.datacenterMembershipsByServer.set("srv-gw-a", [
    membershipPin("srv-gw-a", "dc-dst", "10.0.1.2"),
  ]);
  caches.datacenterMembershipsByServer.set("srv-gw-z", [
    membershipPin("srv-gw-z", "dc-dst", "10.0.1.3"),
  ]);
  caches.datacenterMembershipsByServer.set("srv-2", [
    membershipPin("srv-2", "dc-dst", "10.0.1.1"),
  ]);
  caches.addressPreferenceByDatacenter.set("dc-src", "ipv4");
  caches.addressPreferenceByDatacenter.set("dc-dst", "ipv4");
  caches.publicAddressByServer.set("srv-gw-a", "203.0.113.20");
  caches.publicAddressByServer.set("srv-gw-z", "203.0.113.21");
  const snapshotBase = {
    fabric: FABRIC,
    relays: [selfRelay, gwFirst, gwPreferred, routed],
    caches,
    sealedPresharedKeyByRelayId: new Map([
      ["r1", null],
      ["r-aaa", null],
      ["r-zzz", null],
      ["r2", null],
    ]),
    segmentsByServer: new Map([
      ["srv-1", []],
      ["srv-gw-a", []],
      ["srv-gw-z", []],
      ["srv-2", []],
    ]),
    derivedAdvertisedCidrsByRelayId: new Map(),
    policy: { allowRelay: false },
  };
  const defaultHop = await buildFabricReconcilePayloadFromSnapshot(
    snapshotBase,
    { serverId: "srv-1" },
  );
  const preferredHop = await buildFabricReconcilePayloadFromSnapshot({
    ...snapshotBase,
    relays: [
      { ...selfRelay, preferredGatewayIds: ["srv-gw-z"] },
      gwFirst,
      gwPreferred,
      routed,
    ],
  }, { serverId: "srv-1" });
  if (!defaultHop?.payload.enabled || !preferredHop?.payload.enabled) {
    throw new TypeError("expected enabled payloads");
  }
  const defaultVia = defaultHop.payload.peers.find((peer) =>
    peer.pathKind === "gateway"
  )?.viaServerId;
  const preferredVia = preferredHop.payload.peers.find((peer) =>
    peer.pathKind === "gateway"
  )?.viaServerId;
  assertEquals(defaultVia, "srv-gw-a");
  assertEquals(preferredVia, "srv-gw-z");
  assertNotEquals(defaultHop.desiredHash, preferredHop.desiredHash);
});

test("buildFabricReconcilePayloadFromSnapshot still builds when one pair is unreachable", async () => {
  const selfRelay = relayRecord({
    id: "r1",
    serverId: "srv-1",
    address: "10.250.0.1",
    endpointAddress: "203.0.113.10",
    publicKey: WG_KEY_A,
    prefix: "10.192.0.0/16",
  });
  const reachable = relayRecord({
    id: "r2",
    serverId: "srv-2",
    address: "10.250.0.2",
    endpointAddress: "203.0.113.11",
    publicKey: WG_KEY_B,
    prefix: "10.193.0.0/16",
  });
  const unreachable = relayRecord({
    id: "r3",
    serverId: "srv-3",
    address: "10.250.0.3",
    publicKey: WG_KEY_C,
    prefix: "10.194.0.0/16",
  });
  const built = await buildFabricReconcilePayloadFromSnapshot({
    fabric: FABRIC,
    relays: [selfRelay, reachable, unreachable],
    caches: emptyCaches(),
    sealedPresharedKeyByRelayId: new Map([
      ["r1", null],
      ["r2", null],
      ["r3", null],
    ]),
    segmentsByServer: new Map([
      ["srv-1", []],
      ["srv-2", []],
      ["srv-3", []],
    ]),
    derivedAdvertisedCidrsByRelayId: new Map(),
    policy: { allowRelay: false },
  }, { serverId: "srv-1" });
  if (!built?.payload.enabled) throw new TypeError("expected enabled payload");
  assertEquals(built.payload.peers.length, 1);
  assertEquals(built.payload.peers[0]?.publicKey, WG_KEY_B);
  assertEquals(built.unreachablePeers, [{ serverId: "srv-3" }]);
  assertEquals(built.gatewayRoutedPeers, []);
});

test("hashFabricReconcileDesired differs for distinct peer lists", async () => {
  const base = {
    enabled: true,
    fabricId: "fab-1",
    listenPort: 51821,
    mtu: 1420,
    address: "10.250.0.1/32",
    prefix: "10.192.0.0/16",
  };
  const a = await hashFabricReconcileDesired({
    ...base,
    peers: [{
      publicKey: "pk-a",
      allowedIPs: ["10.0.0.1/32"],
      endpoint: "1.2.3.4:51821",
    }],
  });
  const b = await hashFabricReconcileDesired({
    ...base,
    peers: [{
      publicKey: "pk-b",
      allowedIPs: ["10.0.0.1/32"],
      endpoint: "1.2.3.4:51821",
    }],
  });
  assertNotEquals(a, b);
});

test("deleteServerFabricMembership removes relay and segments for one server", async () => {
  const db = createReconcileDb({
    relays: sampleRelays(),
    segments: [
      {
        id: "seg-1",
        networkId: "net-a",
        serverId: "srv-1",
        cidr: "10.192.0.0/24",
        options: null,
      },
      {
        id: "seg-2",
        networkId: "net-a",
        serverId: "srv-2",
        cidr: "10.192.1.0/24",
        options: null,
      },
    ],
  });

  await deleteServerFabricMembership(db, "srv-1");

  assertEquals(db.relays.map((row) => row.serverId).sort(), ["srv-2", "srv-3"]);
  assertEquals(db.segments.map((row) => row.serverId), ["srv-2"]);
});

test("purgeOrganizationComposeNetworks removes compose rows and segments only for the org", async () => {
  const db = createReconcileDb({
    networks: [
      {
        id: "net-compose-org",
        organizationId: ORG,
        environmentId: ENV,
        kind: "compose",
        name: "frontend",
        cidr: null,
        options: { composeKey: "web" },
      },
      {
        id: "net-dc-org",
        organizationId: ORG,
        environmentId: ENV,
        kind: "datacenter",
        name: "site",
        cidr: "10.250.0.0/16",
        options: {},
      },
      {
        id: "net-compose-other",
        organizationId: "org-2",
        environmentId: "env-2",
        kind: "compose",
        name: "other",
        cidr: null,
        options: {},
      },
    ],
    segments: [
      {
        id: "seg-1",
        networkId: "net-compose-org",
        serverId: "srv-1",
        cidr: "10.192.0.0/24",
        options: null,
      },
      {
        id: "seg-2",
        networkId: "net-compose-other",
        serverId: "srv-9",
        cidr: "10.193.0.0/24",
        options: null,
      },
    ],
  });

  await purgeOrganizationComposeNetworks(db, ORG);

  assertEquals(db.networks.map((row) => row.id).sort(), [
    "net-compose-other",
    "net-dc-org",
  ]);
  assertEquals(db.segments.map((row) => row.id), ["seg-2"]);
});

test("listEnvironmentComposeNetworks sorts by hostName and includes segmentless rows", async () => {
  const db = createReconcileDb({
    networks: [
      {
        id: "net-z",
        organizationId: ORG,
        environmentId: ENV,
        kind: "compose",
        name: "z",
        cidr: null,
        options: { composeKey: "z" },
      },
      {
        id: "net-a",
        organizationId: ORG,
        environmentId: ENV,
        kind: "compose",
        name: "a",
        cidr: null,
        options: { composeKey: "a" },
      },
      {
        id: "net-dc",
        organizationId: ORG,
        environmentId: ENV,
        kind: "datacenter",
        name: "site",
        cidr: "10.0.0.0/16",
        options: {},
      },
    ],
    segments: [{
      id: "seg-a",
      networkId: "net-a",
      serverId: "srv-1",
      cidr: "10.192.0.0/24",
      options: null,
    }],
  });

  const rows = await listEnvironmentComposeNetworks(db, ENV);

  assertEquals(rows.length, 2);
  assertEquals(rows[0]?.hostName, composeNetworkHostName("net-a"));
  assertEquals(rows[0]?.segments, [{
    serverId: "srv-1",
    subnet: "10.192.0.0/24",
  }]);
  assertEquals(rows[1]?.hostName, composeNetworkHostName("net-z"));
  assertEquals(rows[1]?.segments, []);
});

test("composeNetworkNamesByServer ignores networks with no segments", () => {
  const map = composeNetworkNamesByServer([
    {
      networkId: "net-empty",
      hostName: "tpn_net-empty",
      segments: [],
    },
    {
      networkId: "net-live",
      hostName: "tpn_net-live",
      segments: [{ serverId: "srv-1", subnet: "10.192.0.0/24" }],
    },
  ]);
  assertEquals(map.get("srv-1"), ["tpn_net-live"]);
  assertEquals(map.has("srv-empty"), false);
});
