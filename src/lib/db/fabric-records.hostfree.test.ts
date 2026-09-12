/**
 * Host-free coverage for TurboFabric relay/subnet DB helpers (no Postgres).
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { Db } from "../../db.ts";
import type { ComposeDocument } from "../compose/types.ts";
import {
  ensureFabricRelays,
  FabricAllocationError,
  materializeSpanningNetworks,
  type FabricRecord,
} from "./fabric-records.ts";
import { network, relay, subnet, server } from "./schema.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const FABRIC: FabricRecord = {
  id: "fab-1",
  organizationId: "org-1",
  cidr: "10.250.0.0/16",
  options: null,
};

function relayUniqueViolation(): Error {
  return Object.assign(
    new Error(
      'duplicate key value violates unique constraint "uniq_relay_fabric_address"',
    ),
    { code: "23505" },
  );
}

function thenableRows<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  return {
    limit: (n?: number) => Promise.resolve(typeof n === "number" ? rows.slice(0, n) : rows),
    orderBy: () => thenableRows(rows),
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
      for (const chunk of obj.queryChunks) visit(chunk);
    }
    if ("value" in obj && Array.isArray(obj.value)) {
      for (const item of obj.value) visit(item);
    }
  };
  visit(condition);
  return filters;
}

function matchesWhere(row: Record<string, unknown>, condition: unknown): boolean {
  const filters = extractWhereFilters(condition);
  for (const [column, expected] of Object.entries(filters)) {
    const field = COLUMN_TO_FIELD[column] ?? column;
    if (row[field] !== expected) return false;
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

type ServerRow = { id: string; organizationId: string };
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
};
type NetworkRow = {
  id: string;
  organizationId: string;
  environmentId: string;
  kind: string;
  name: string;
  cidr?: string | null;
  options: Record<string, unknown>;
};
type SegmentRow = {
  id: string;
  networkId: string;
  serverId: string;
  cidr: string;
  options: unknown;
};

type FabricDb = Db & {
  relays: RelayRow[];
  networks: NetworkRow[];
  segments: SegmentRow[];
  relayInserts: number;
};

function createFabricDb(opts: {
  servers?: ServerRow[];
  relays?: RelayRow[];
  networks?: NetworkRow[];
  segments?: SegmentRow[];
  relayInsertFailures?: number;
  relayInsertError?: Error;
}): FabricDb {
  const servers = [...(opts.servers ?? [])];
  const relays = [...(opts.relays ?? [])];
  const networks = [...(opts.networks ?? [])];
  const segments = [...(opts.segments ?? [])];
  let relayInserts = 0;
  let relayInsertFailures = opts.relayInsertFailures ?? 0;
  let relaySeq = relays.length;
  let networkSeq = networks.length;
  let segmentSeq = segments.length;

  const db = {
    relays,
    networks,
    segments,
    get relayInserts() {
      return relayInserts;
    },
    select: (_cols?: unknown) => ({
      from: (table: unknown) => ({
        where: (condition?: unknown) => {
          if (table === server) {
            return thenableRows(filterRows(servers, condition));
          }
          if (table === relay) {
            const rows = relays.map((row) => ({
              id: row.id,
              fabricId: row.fabricId,
              serverId: row.serverId,
              address: row.address,
              role: row.role,
              keepalive: row.keepalive,
              endpointAddress: row.endpointAddress,
              publicKey: row.publicKey,
              prefix: row.prefix,
              advertisedCidrs: row.advertisedCidrs,
              metadata: row.metadata,
            }));
            return thenableRows(filterRows(rows, condition));
          }
          if (table === network) {
            return thenableRows(filterRows(networks, condition));
          }
          if (table === subnet) {
            return thenableRows(filterRows(segments, condition));
          }
          return thenableRows([]);
        },
        leftJoin: () => ({
          where: () => thenableRows([]),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const rows = Array.isArray(values) ? values : [values];
        if (table === relay) {
          relayInserts += 1;
          if (opts.relayInsertError) {
            throw opts.relayInsertError;
          }
          if (relayInsertFailures > 0) {
            relayInsertFailures -= 1;
            throw relayUniqueViolation();
          }
          for (const row of rows) {
            relaySeq += 1;
            relays.push({
              id: `relay-${relaySeq}`,
              fabricId: String(row.fabricId),
              serverId: String(row.serverId),
              address: String(row.address),
              role: "member",
              keepalive: null,
              endpointAddress: null,
              publicKey: null,
              prefix: String(row.prefix),
              advertisedCidrs: [],
              metadata: {},
            });
          }
          return {
            returning: () => Promise.resolve([]),
            onConflictDoNothing: () => Promise.resolve(undefined),
            then: (
              resolve: (value: undefined) => unknown,
              reject?: (error: unknown) => unknown,
            ) => Promise.resolve(undefined).then(resolve, reject),
          };
        }
        if (table === network) {
          const inserted = rows.map((row) => {
            networkSeq += 1;
            const record: NetworkRow = {
              id: `net-${networkSeq}`,
              organizationId: String(row.organizationId),
              environmentId: String(row.environmentId),
              kind: String(row.kind),
              name: String(row.name ?? ""),
              options: (row.options as Record<string, unknown>) ?? {},
            };
            networks.push(record);
            return { id: record.id };
          });
          return {
            returning: () => Promise.resolve(inserted),
            onConflictDoNothing: () => Promise.resolve(undefined),
            then: (
              resolve: (value: undefined) => unknown,
              reject?: (error: unknown) => unknown,
            ) => Promise.resolve(undefined).then(resolve, reject),
          };
        }
        if (table === subnet) {
          const insertSegmentRows = () => {
            for (const row of rows) {
              const networkId = String(row.networkId);
              const serverId = String(row.serverId);
              const exists = segments.some(
                (entry) =>
                  entry.networkId === networkId && entry.serverId === serverId,
              );
              if (exists) continue;
              segmentSeq += 1;
              segments.push({
                id: `seg-${segmentSeq}`,
                networkId,
                serverId,
                cidr: String(row.cidr),
                options: row.options ?? null,
              });
            }
          };
          return {
            onConflictDoNothing: () => {
              insertSegmentRows();
              return Promise.resolve(undefined);
            },
            returning: () => Promise.resolve([]),
            then: (
              resolve: (value: undefined) => unknown,
              reject?: (error: unknown) => unknown,
            ) => {
              insertSegmentRows();
              return Promise.resolve(undefined).then(resolve, reject);
            },
          };
        }
        return {
          returning: () => Promise.resolve([]),
          onConflictDoNothing: () => Promise.resolve(undefined),
          then: (
            resolve: (value: undefined) => unknown,
            reject?: (error: unknown) => unknown,
          ) => Promise.resolve(undefined).then(resolve, reject),
        };
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          if (patch.options && networks.length > 0) {
            const last = networks.at(-1);
            if (last) {
              last.options = {
                ...last.options,
                ...(patch.options as Record<string, unknown>),
              };
            }
          }
          return thenableRows([]);
        },
      }),
    }),
    delete: () => ({
      where: () => thenableRows([]),
    }),
  };

  return db as unknown as FabricDb;
}

function assertKind(err: unknown, kind: string): void {
  if (!(err instanceof FabricAllocationError)) {
    throw new TypeError(`expected FabricAllocationError, got ${String(err)}`);
  }
  assertEquals(err.kind, kind);
}

function composeDoc(data: Record<string, unknown>): ComposeDocument {
  return {
    version: 1,
    data,
    presentation: { keyOrder: Object.keys(data), comments: {} },
  };
}

test("ensureFabricRelays inserts relays for org servers that lack one", async () => {
  const db = createFabricDb({
    servers: [
      { id: "srv-a", organizationId: "org-1" },
      { id: "srv-b", organizationId: "org-1" },
    ],
  });

  const relays = await ensureFabricRelays(db, {
    fabric: FABRIC,
    organizationId: "org-1",
  });

  assertEquals(relays.length, 2);
  assertEquals(relays.map((row) => row.serverId).sort(), ["srv-a", "srv-b"]);
  assertEquals(relays[0]?.address, "10.250.0.1");
  assertEquals(relays[1]?.address, "10.250.0.2");
  assertEquals(relays[0]?.prefix, "10.192.0.0/16");
  assertEquals(relays[1]?.prefix, "10.193.0.0/16");
  assertEquals(db.relayInserts, 2);
});

test("ensureFabricRelays never carves a relay prefix out of a reserved range or site subnet", async () => {
  const db = createFabricDb({
    servers: [
      { id: "srv-a", organizationId: "org-1" },
      { id: "srv-b", organizationId: "org-1" },
    ],
    networks: [
      {
        id: "net-reserved",
        organizationId: "org-1",
        environmentId: "",
        kind: "reserved",
        name: "Corp VPN — Chicago branch",
        cidr: "10.192.0.0/16",
        options: {},
      },
      {
        id: "net-site",
        organizationId: "org-1",
        environmentId: "",
        kind: "datacenter",
        name: "lan",
        cidr: "10.193.40.0/24",
        options: {},
      },
    ],
  });

  const relays = await ensureFabricRelays(db, {
    fabric: FABRIC,
    organizationId: "org-1",
  });

  assertEquals(relays.map((row) => row.prefix), [
    "10.194.0.0/16",
    "10.195.0.0/16",
  ]);
});

test("ensureFabricRelays skips servers that already have relays", async () => {
  const db = createFabricDb({
    servers: [
      { id: "srv-a", organizationId: "org-1" },
      { id: "srv-b", organizationId: "org-1" },
    ],
    relays: [{
      id: "relay-existing",
      fabricId: "fab-1",
      serverId: "srv-a",
      address: "10.250.0.9",
      role: "member",
      keepalive: null,
      endpointAddress: null,
      publicKey: null,
      prefix: "10.194.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    }],
  });

  const relays = await ensureFabricRelays(db, {
    fabric: FABRIC,
    organizationId: "org-1",
  });

  assertEquals(relays.length, 2);
  assertEquals(
    relays.find((row) => row.serverId === "srv-a")?.address,
    "10.250.0.9",
  );
  assertEquals(
    relays.find((row) => row.serverId === "srv-b")?.address,
    "10.250.0.1",
  );
  assertEquals(db.relayInserts, 1);
});

test("ensureFabricRelays retries relay insert after address unique violation", async () => {
  const db = createFabricDb({
    servers: [{ id: "srv-a", organizationId: "org-1" }],
    relayInsertFailures: 1,
  });

  const relays = await ensureFabricRelays(db, {
    fabric: FABRIC,
    organizationId: "org-1",
  });

  assertEquals(relays.length, 1);
  assertEquals(relays[0]?.serverId, "srv-a");
  assertEquals(db.relayInserts, 2);
});

test("ensureFabricRelays maps repeated address unique violations to pool exhausted", async () => {
  const db = createFabricDb({
    servers: [{ id: "srv-a", organizationId: "org-1" }],
    relayInsertFailures: 2,
  });

  const err = await assertRejects(
    () =>
      ensureFabricRelays(db, {
        fabric: FABRIC,
        organizationId: "org-1",
      }),
    FabricAllocationError,
  );
  assertKind(err, "fabric_address_pool_exhausted");
  assertEquals(db.relayInserts, 2);
});

test("ensureFabricRelays rethrows non-unique insert errors", async () => {
  const db = createFabricDb({
    servers: [{ id: "srv-a", organizationId: "org-1" }],
    relayInsertError: new Error("disk full"),
  });

  await assertRejects(
    () =>
      ensureFabricRelays(db, {
        fabric: FABRIC,
        organizationId: "org-1",
      }),
    Error,
    "disk full",
  );
});

test("materializeSpanningNetworks returns empty map when nothing spans hosts", async () => {
  const db = createFabricDb({
    servers: [{ id: "srv-a", organizationId: "org-1" }],
  });

  const spanning = await materializeSpanningNetworks(db, {
    organizationId: "org-1",
    environmentId: "env-1",
    fabric: FABRIC,
    document: composeDoc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
        api: { image: "api", networks: ["frontend"] },
      },
      networks: { frontend: { driver: "overlay" } },
    }),
    slots: [
      { serviceId: "svc-web", serverId: "srv-a" },
      { serviceId: "svc-api", serverId: "srv-a" },
    ],
    serviceRows: [
      { id: "svc-web", composeServiceName: "web" },
      { id: "svc-api", composeServiceName: "api" },
    ],
  });

  assertEquals(spanning.size, 0);
  assertEquals(db.networks.length, 0);
  assertEquals(db.segments.length, 0);
});

test("materializeSpanningNetworks creates compose networks and per-server segments", async () => {
  const db = createFabricDb({
    servers: [
      { id: "srv-a", organizationId: "org-1" },
      { id: "srv-b", organizationId: "org-1" },
    ],
    relays: [
      {
        id: "relay-a",
        fabricId: "fab-1",
        serverId: "srv-a",
        address: "10.250.0.1",
        role: "member",
        keepalive: null,
        endpointAddress: null,
        publicKey: null,
        prefix: "10.192.0.0/16",
        advertisedCidrs: [],
        metadata: {},
      },
      {
        id: "relay-b",
        fabricId: "fab-1",
        serverId: "srv-b",
        address: "10.250.0.2",
        role: "member",
        keepalive: null,
        endpointAddress: null,
        publicKey: null,
        prefix: "10.193.0.0/16",
        advertisedCidrs: [],
        metadata: {},
      },
    ],
  });

  const spanning = await materializeSpanningNetworks(db, {
    organizationId: "org-1",
    environmentId: "env-1",
    fabric: FABRIC,
    document: composeDoc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
        api: { image: "api", networks: ["frontend"] },
      },
      networks: { frontend: { driver: "overlay" } },
    }),
    slots: [
      { serviceId: "svc-web", serverId: "srv-a" },
      { serviceId: "svc-api", serverId: "srv-b" },
    ],
    serviceRows: [
      { id: "svc-web", composeServiceName: "web" },
      { id: "svc-api", composeServiceName: "api" },
    ],
  });

  assertEquals(spanning.get("frontend")?.startsWith("tpn_"), true);
  assertEquals(db.networks.length, 1);
  assertEquals(db.networks[0]?.options.composeKey, "frontend");
  assertEquals(db.segments.length, 2);
  assertEquals(
    db.segments.map((row) => row.serverId).sort(),
    ["srv-a", "srv-b"],
  );
  assertEquals(db.segments[0]?.cidr.startsWith("10.192."), true);
  assertEquals(db.segments[1]?.cidr.startsWith("10.193."), true);
});

test("materializeSpanningNetworks never carves a segment out of a reserved range", async () => {
  const db = createFabricDb({
    servers: [
      { id: "srv-a", organizationId: "org-1" },
      { id: "srv-b", organizationId: "org-1" },
    ],
    relays: [
      {
        id: "relay-a",
        fabricId: "fab-1",
        serverId: "srv-a",
        address: "10.250.0.1",
        role: "member",
        keepalive: null,
        endpointAddress: null,
        publicKey: null,
        prefix: "10.192.0.0/16",
        advertisedCidrs: [],
        metadata: {},
      },
      {
        id: "relay-b",
        fabricId: "fab-1",
        serverId: "srv-b",
        address: "10.250.0.2",
        role: "member",
        keepalive: null,
        endpointAddress: null,
        publicKey: null,
        prefix: "10.193.0.0/16",
        advertisedCidrs: [],
        metadata: {},
      },
    ],
    networks: [{
      id: "net-reserved",
      organizationId: "org-1",
      environmentId: "",
      kind: "reserved",
      name: "legacy-lab",
      cidr: "10.192.0.0/23",
      options: {},
    }],
  });

  await materializeSpanningNetworks(db, {
    organizationId: "org-1",
    environmentId: "env-1",
    fabric: FABRIC,
    document: composeDoc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
        api: { image: "api", networks: ["frontend"] },
      },
      networks: { frontend: { driver: "overlay" } },
    }),
    slots: [
      { serviceId: "svc-web", serverId: "srv-a" },
      { serviceId: "svc-api", serverId: "srv-b" },
    ],
    serviceRows: [
      { id: "svc-web", composeServiceName: "web" },
      { id: "svc-api", composeServiceName: "api" },
    ],
  });

  const byServer = new Map(db.segments.map((row) => [row.serverId, row.cidr]));
  // srv-a's first two /24s sit inside the reserved /23 → lowest free is .2.0/24.
  assertEquals(byServer.get("srv-a"), "10.192.2.0/24");
  // srv-b's prefix is untouched by the exclusion.
  assertEquals(byServer.get("srv-b"), "10.193.0.0/24");
});

test("materializeSpanningNetworks ignores a shared network not declared overlay", async () => {
  // Same two-host topology as above, with the one difference that decides it:
  // the author wrote `driver: bridge`. Landing on two servers is a scheduling
  // outcome, not a request for a routed bridge, so nothing is materialized and
  // each host gets its own local `frontend`.
  const db = createFabricDb({
    servers: [
      { id: "srv-a", organizationId: "org-1" },
      { id: "srv-b", organizationId: "org-1" },
    ],
    relays: [
      {
        id: "relay-a",
        fabricId: "fab-1",
        serverId: "srv-a",
        address: "10.250.0.1",
        role: "member",
        keepalive: null,
        endpointAddress: null,
        publicKey: null,
        prefix: "10.192.0.0/16",
        advertisedCidrs: [],
        metadata: {},
      },
      {
        id: "relay-b",
        fabricId: "fab-1",
        serverId: "srv-b",
        address: "10.250.0.2",
        role: "member",
        keepalive: null,
        endpointAddress: null,
        publicKey: null,
        prefix: "10.193.0.0/16",
        advertisedCidrs: [],
        metadata: {},
      },
    ],
  });

  const spanning = await materializeSpanningNetworks(db, {
    organizationId: "org-1",
    environmentId: "env-1",
    fabric: FABRIC,
    document: composeDoc({
      services: {
        web: { image: "nginx", networks: ["frontend"] },
        api: { image: "api", networks: ["frontend"] },
      },
      networks: { frontend: { driver: "bridge" } },
    }),
    slots: [
      { serviceId: "svc-web", serverId: "srv-a" },
      { serviceId: "svc-api", serverId: "srv-b" },
    ],
    serviceRows: [
      { id: "svc-web", composeServiceName: "web" },
      { id: "svc-api", composeServiceName: "api" },
    ],
  });

  assertEquals(spanning.size, 0);
  assertEquals(db.networks.length, 0);
  assertEquals(db.segments.length, 0);
});

test("materializeSpanningNetworks throws relay_missing for participating servers without relays", async () => {
  const db = createFabricDb({
    servers: [{ id: "srv-a", organizationId: "org-1" }],
    relays: [{
      id: "relay-a",
      fabricId: "fab-1",
      serverId: "srv-a",
      address: "10.250.0.1",
      role: "member",
      keepalive: null,
      endpointAddress: null,
      publicKey: null,
      prefix: "10.192.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    }],
  });

  const err = await assertRejects(
    () =>
      materializeSpanningNetworks(db, {
        organizationId: "org-1",
        environmentId: "env-1",
        fabric: FABRIC,
        document: composeDoc({
          services: {
            web: { image: "nginx", networks: ["frontend"] },
            api: { image: "api", networks: ["frontend"] },
          },
          networks: { frontend: { driver: "overlay" } },
        }),
        slots: [
          { serviceId: "svc-web", serverId: "srv-a" },
          { serviceId: "svc-api", serverId: "srv-b" },
        ],
        serviceRows: [
          { id: "svc-web", composeServiceName: "web" },
          { id: "svc-api", composeServiceName: "api" },
        ],
      }),
    FabricAllocationError,
  );
  assertKind(err, "relay_missing");
});

test("materializeSpanningNetworks throws fabric_segment_pool_exhausted when relay prefix is full", async () => {
  const db = createFabricDb({
    servers: [
      { id: "srv-a", organizationId: "org-1" },
      { id: "srv-b", organizationId: "org-1" },
    ],
    relays: [
      {
        id: "relay-a",
        fabricId: "fab-1",
        serverId: "srv-a",
        address: "10.250.0.1",
        role: "member",
        keepalive: null,
        endpointAddress: null,
        publicKey: null,
        prefix: "10.192.0.0/16",
        advertisedCidrs: [],
        metadata: {},
      },
      {
        id: "relay-b",
        fabricId: "fab-1",
        serverId: "srv-b",
        address: "10.250.0.2",
        role: "member",
        keepalive: null,
        endpointAddress: null,
        publicKey: null,
        prefix: "10.193.0.0/24",
        advertisedCidrs: [],
        metadata: {},
      },
    ],
    segments: [{
      id: "seg-existing",
      networkId: "other-net",
      serverId: "srv-b",
      cidr: "10.193.0.0/24",
      options: null,
    }],
  });

  const err = await assertRejects(
    () =>
      materializeSpanningNetworks(db, {
        organizationId: "org-1",
        environmentId: "env-1",
        fabric: FABRIC,
        document: composeDoc({
          services: {
            web: { image: "nginx", networks: ["frontend"] },
            api: { image: "api", networks: ["frontend"] },
          },
          networks: { frontend: { driver: "overlay" } },
        }),
        slots: [
          { serviceId: "svc-web", serverId: "srv-a" },
          { serviceId: "svc-api", serverId: "srv-b" },
        ],
        serviceRows: [
          { id: "svc-web", composeServiceName: "web" },
          { id: "svc-api", composeServiceName: "api" },
        ],
      }),
    FabricAllocationError,
  );
  assertKind(err, "fabric_segment_pool_exhausted");
});
