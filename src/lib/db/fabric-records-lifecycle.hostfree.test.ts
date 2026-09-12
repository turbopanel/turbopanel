/**
 * Host-free wave-4 coverage for TurboFabric lifecycle helpers (no Postgres).
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { Db } from "../../db.ts";
import { composeNetworkHostName } from "../fabric/cidr.ts";
import {
  clearRelayAppliedPayloadHash,
  disableOrganizationFabric,
  enableOrganizationFabric,
  ensureComposeNetworkRow,
  ensureFabricRelays,
  FabricAllocationError,
  FabricContainerPoolOverlapError,
  listEnvironmentComposeNetworks,
  purgeComposeNetworksCreatedAfter,
  purgeEnvironmentComposeNetworks,
  releaseSubnetsForServer,
  stampRelayPublicKey,
  stampRelayReconcileSuccess,
  updateFabricRelay,
  type FabricRecord,
} from "./fabric-records.ts";
import { fabric, network, relay, subnet, server } from "./schema.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORG = "org-1";
const ENV = "env-1";

function relayAddressUniqueViolation(): Error {
  return Object.assign(
    new Error(
      'duplicate key value violates unique constraint "uniq_relay_fabric_address"',
    ),
    { code: "23505" },
  );
}

function relayPrefixUniqueViolation(): Error {
  return Object.assign(
    new Error(
      'duplicate key value violates unique constraint "uniq_relay_fabric_prefix"',
    ),
    { code: "23505" },
  );
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

function matchesWhere(row: Record<string, unknown>, condition: unknown): boolean {
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

type ServerRow = { id: string; organizationId: string };
type FabricRow = {
  id: string;
  organizationId: string;
  cidr: string;
  options: unknown;
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
  updatedAt?: string;
};
type NetworkRow = {
  id: string;
  organizationId: string;
  environmentId: string;
  kind: string;
  name: string;
  cidr: string | null;
  options: Record<string, unknown>;
};
type SegmentRow = {
  id: string;
  networkId: string;
  serverId: string;
  cidr: string;
  options: unknown;
};

type LifecycleDb = Db & {
  fabrics: FabricRow[];
  relays: RelayRow[];
  networks: NetworkRow[];
  segments: SegmentRow[];
  relayInserts: number;
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
  if (filters.id !== undefined && row.id !== filters.id) return false;
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
  if (filters.environment_id !== undefined &&
    row.environmentId !== filters.environment_id) {
    return false;
  }
  if (filters.kind !== undefined && row.kind !== filters.kind) return false;
  return true;
}

function applyRelayUpdate(
  row: RelayRow,
  patch: Record<string, unknown>,
): void {
  if (patch.publicKey !== undefined) {
    row.publicKey = patch.publicKey as string | null;
  }
  if (patch.metadata !== undefined) row.metadata = patch.metadata;
  if (patch.role !== undefined) row.role = String(patch.role);
  if (patch.keepalive !== undefined) {
    row.keepalive = patch.keepalive as number | null;
  }
  if (patch.endpointAddress !== undefined) {
    row.endpointAddress = patch.endpointAddress as string | null;
  }
  if (patch.advertisedCidrs !== undefined) {
    row.advertisedCidrs = patch.advertisedCidrs as string[];
  }
  if (patch.presharedKey !== undefined) {
    row.presharedKey = patch.presharedKey as string | null;
  }
  if (patch.options !== undefined) {
    row.options = patch.options;
  }
  if (patch.updatedAt !== undefined) {
    row.updatedAt = String(patch.updatedAt);
  }
}

function relayUpdateResult(matches: RelayRow[]) {
  const rows = matches.map((row) => ({ ...row }));
  const promise = Promise.resolve(rows);
  return {
    returning: (_cols?: unknown) => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

function createLifecycleDb(opts: {
  servers?: ServerRow[];
  fabrics?: FabricRow[];
  relays?: RelayRow[];
  networks?: NetworkRow[];
  segments?: SegmentRow[];
  relayAddressInsertFailures?: number;
  relayPrefixInsertFailures?: number;
} = {}): LifecycleDb {
  const servers = [...(opts.servers ?? [])];
  const fabrics = [...(opts.fabrics ?? [])];
  const relays = [...(opts.relays ?? [])];
  const networks = [...(opts.networks ?? [])];
  const segments = [...(opts.segments ?? [])];
  let relayInserts = 0;
  let relayAddressInsertFailures = opts.relayAddressInsertFailures ?? 0;
  let relayPrefixInsertFailures = opts.relayPrefixInsertFailures ?? 0;
  let relaySeq = relays.length;
  let fabricSeq = fabrics.length;
  let networkSeq = networks.length;
  let segmentSeq = segments.length;

  const db = {
    fabrics,
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
          if (table === fabric) {
            return thenableRows(
              filterRows(fabrics, condition).map((row) => ({
                id: row.id,
                organizationId: row.organizationId,
                cidr: row.cidr,
                options: row.options,
              })),
            );
          }
          if (table === relay) {
            const rows = relays.map((row) => ({ ...row }));
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
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const rows = Array.isArray(values) ? values : [values];
        if (table === fabric) {
          const inserted = rows.map((row) => {
            fabricSeq += 1;
            const record: FabricRow = {
              id: `fab-${fabricSeq}`,
              organizationId: String(row.organizationId),
              cidr: String(row.cidr),
              options: row.options ?? null,
            };
            fabrics.push(record);
            return {
              id: record.id,
              organizationId: record.organizationId,
              cidr: record.cidr,
              options: record.options,
            };
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
        if (table === relay) {
          relayInserts += 1;
          if (relayPrefixInsertFailures > 0) {
            relayPrefixInsertFailures -= 1;
            throw relayPrefixUniqueViolation();
          }
          if (relayAddressInsertFailures > 0) {
            relayAddressInsertFailures -= 1;
            throw relayAddressUniqueViolation();
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
              cidr: row.cidr == null ? null : String(row.cidr),
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
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (condition?: unknown) => {
          if (table === relay) {
            const matches = relays.filter((row) => matchesWhere(row, condition));
            for (const row of matches) applyRelayUpdate(row, patch);
            return relayUpdateResult(matches);
          }
          if (table === network) {
            const matches = networks.filter((row) => matchesWhere(row, condition));
            for (const row of matches) {
              if (patch.options !== undefined) {
                row.options = {
                  ...row.options,
                  ...(patch.options as Record<string, unknown>),
                };
              }
            }
            return thenableRows([]);
          }
          if (table === fabric) {
            const matches = fabrics.filter((row) => matchesWhere(row, condition));
            for (const row of matches) {
              if (patch.options !== undefined) row.options = patch.options;
            }
            return thenableRows(
              matches.map((row) => ({
                id: row.id,
                organizationId: row.organizationId,
                cidr: row.cidr,
                options: row.options,
              })),
            );
          }
          return thenableRows([]);
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (condition?: unknown) => {
        if (table === fabric) {
          const next = fabrics.filter((row) => !matchesWhere(row, condition));
          fabrics.length = 0;
          fabrics.push(...next);
        }
        if (table === subnet) {
          const next = segments.filter((row) => !segmentMatchesDelete(row, condition));
          segments.length = 0;
          segments.push(...next);
        }
        if (table === network) {
          const next = networks.filter((row) => !networkMatchesDelete(row, condition));
          networks.length = 0;
          networks.push(...next);
        }
        return thenableRows([]);
      },
    }),
    /**
     * Snapshot every table, run `fn` against this same object, and restore
     * the snapshot when it throws — the rollback `enableOrganizationFabric`
     * relies on to leave no fabric row behind a refused pool.
     */
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      const snapshot = {
        fabrics: fabrics.map((row) => ({ ...row })),
        relays: relays.map((row) => ({ ...row })),
        networks: networks.map((row) => ({ ...row })),
        segments: segments.map((row) => ({ ...row })),
      };
      try {
        return await fn(db as unknown as Db);
      } catch (err) {
        fabrics.splice(0, fabrics.length, ...snapshot.fabrics);
        relays.splice(0, relays.length, ...snapshot.relays);
        networks.splice(0, networks.length, ...snapshot.networks);
        segments.splice(0, segments.length, ...snapshot.segments);
        throw err;
      }
    },
  };

  return db as unknown as LifecycleDb;
}

function assertKind(err: unknown, kind: string): void {
  if (!(err instanceof FabricAllocationError)) {
    throw new TypeError(`expected FabricAllocationError, got ${String(err)}`);
  }
  assertEquals(err.kind, kind);
}

test("enableOrganizationFabric inserts fabric avoiding occupied org CIDRs", async () => {
  const db = createLifecycleDb({
    servers: [{ id: "srv-a", organizationId: ORG }],
    networks: [{
      id: "net-dc",
      organizationId: ORG,
      environmentId: ENV,
      kind: "datacenter",
      name: "site",
      cidr: "10.250.0.0/16",
      options: {},
    }],
  });

  const record = await enableOrganizationFabric(db, ORG);

  assertEquals(record.organizationId, ORG);
  assertEquals(record.cidr, "10.251.0.0/16");
  assertEquals(db.fabrics.length, 1);
  assertEquals(db.relays.length, 1);
  assertEquals(db.relays[0]?.fabricId, record.id);
});

test("enableOrganizationFabric steps around an operator-reserved range (reverse direction)", async () => {
  // `occupiedCidrs` sweeps every `network.cidr` — a `kind='reserved'` row
  // constrains `pickDefaultFabricHostCidr` without any extra wiring, and the
  // relay prefix allocator honours it too.
  const db = createLifecycleDb({
    servers: [{ id: "srv-a", organizationId: ORG }],
    networks: [
      {
        id: "net-reserved",
        organizationId: ORG,
        environmentId: ENV,
        kind: "reserved",
        name: "Corp VPN — Chicago branch",
        cidr: "10.250.0.0/16",
        options: {},
      },
      {
        id: "net-reserved-2",
        organizationId: ORG,
        environmentId: ENV,
        kind: "reserved",
        name: "Transit",
        cidr: "10.251.128.0/17",
        options: {},
      },
      {
        id: "net-reserved-pool",
        organizationId: ORG,
        environmentId: ENV,
        kind: "reserved",
        name: "Lab",
        cidr: "10.192.0.0/16",
        options: {},
      },
    ],
  });

  const record = await enableOrganizationFabric(db, ORG);

  assertEquals(record.cidr, "10.252.0.0/16");
  assertEquals(db.relays.length, 1);
  assertEquals(db.relays[0]?.prefix, "10.193.0.0/16");
});

test("enableOrganizationFabric reuses existing fabric and ensures relays", async () => {
  const existing: FabricRecord = {
    id: "fab-existing",
    organizationId: ORG,
    cidr: "10.252.0.0/16",
    options: null,
  };
  const db = createLifecycleDb({
    servers: [
      { id: "srv-a", organizationId: ORG },
      { id: "srv-b", organizationId: ORG },
    ],
    fabrics: [{
      id: existing.id,
      organizationId: ORG,
      cidr: existing.cidr,
      options: null,
    }],
    relays: [{
      id: "relay-a",
      fabricId: existing.id,
      serverId: "srv-a",
      address: "10.252.0.1",
      role: "member",
      keepalive: null,
      endpointAddress: null,
      publicKey: null,
      prefix: "10.192.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    }],
  });

  const record = await enableOrganizationFabric(db, ORG);

  assertEquals(record.id, existing.id);
  assertEquals(db.fabrics.length, 1);
  assertEquals(db.relays.length, 2);
  assertEquals(db.relayInserts, 1);
});

test("enableOrganizationFabric throws when no free host CIDR remains", async () => {
  const db = createLifecycleDb({
    networks: [
      {
        id: "n1",
        organizationId: ORG,
        environmentId: ENV,
        kind: "datacenter",
        name: "a",
        cidr: "10.250.0.0/16",
        options: {},
      },
      {
        id: "n2",
        organizationId: ORG,
        environmentId: ENV,
        kind: "datacenter",
        name: "b",
        cidr: "10.251.0.0/16",
        options: {},
      },
      {
        id: "n3",
        organizationId: ORG,
        environmentId: ENV,
        kind: "datacenter",
        name: "c",
        cidr: "10.252.0.0/16",
        options: {},
      },
      {
        id: "n4",
        organizationId: ORG,
        environmentId: ENV,
        kind: "datacenter",
        name: "d",
        cidr: "10.253.0.0/16",
        options: {},
      },
    ],
  });

  await assertRejects(
    () => enableOrganizationFabric(db, ORG),
    Error,
    "No free CIDR for TurboFabric",
  );
});

test("enableOrganizationFabric carves every first-time relay from the requested containerPool", async () => {
  const db = createLifecycleDb({
    servers: [
      { id: "srv-a", organizationId: ORG },
      { id: "srv-b", organizationId: ORG },
    ],
  });

  const record = await enableOrganizationFabric(db, ORG, {
    containerPool: "10.64.0.0/15",
    allowRelay: true,
  });

  assertEquals(record.cidr, "10.250.0.0/16");
  assertEquals(record.options, {
    containerPool: "10.64.0.0/15",
    listenPort: 51821,
    mtu: 1420,
    allowRelay: true,
  });
  assertEquals(db.fabrics.length, 1);
  assertEquals(
    db.relays.map((row) => row.prefix).sort((a, b) => a.localeCompare(b)),
    ["10.64.0.0/16", "10.65.0.0/16"],
  );
});

test("enableOrganizationFabric rolls back the fabric row when the requested pool is too small", async () => {
  // Two servers need two relay /16s; a /16 pool fits exactly one.
  const db = createLifecycleDb({
    servers: [
      { id: "srv-a", organizationId: ORG },
      { id: "srv-b", organizationId: ORG },
    ],
  });

  const err = await assertRejects(() =>
    enableOrganizationFabric(db, ORG, { containerPool: "10.64.0.0/16" })
  );
  assertKind(err, "fabric_prefix_pool_exhausted");
  assertEquals(db.fabrics, []);
  assertEquals(db.relays, []);
});

test("enableOrganizationFabric refuses a pool the auto-picked host range lands in without writing", async () => {
  const db = createLifecycleDb({
    servers: [{ id: "srv-a", organizationId: ORG }],
  });

  const err = await assertRejects(
    () => enableOrganizationFabric(db, ORG, { containerPool: "10.250.0.0/16" }),
    FabricContainerPoolOverlapError,
  );
  assertEquals(err.containerPool, "10.250.0.0/16");
  assertEquals(err.fabricCidr, "10.250.0.0/16");
  assertEquals(db.fabrics, []);
  assertEquals(db.relays, []);
});

test("enableOrganizationFabric applies the policy before allocating relays for new servers", async () => {
  const existing: FabricRecord = {
    id: "fab-existing",
    organizationId: ORG,
    cidr: "10.252.0.0/16",
    options: null,
  };
  const db = createLifecycleDb({
    servers: [
      { id: "srv-a", organizationId: ORG },
      { id: "srv-b", organizationId: ORG },
    ],
    fabrics: [{
      id: existing.id,
      organizationId: ORG,
      cidr: existing.cidr,
      options: null,
    }],
    relays: [{
      id: "relay-a",
      fabricId: existing.id,
      serverId: "srv-a",
      address: "10.252.0.1",
      role: "member",
      keepalive: null,
      endpointAddress: null,
      publicKey: null,
      prefix: "10.64.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    }],
  });

  const record = await enableOrganizationFabric(db, ORG, {
    containerPool: "10.64.0.0/15",
  });

  assertEquals(record.id, existing.id);
  assertEquals(
    (record.options as { containerPool: string }).containerPool,
    "10.64.0.0/15",
  );
  assertEquals(db.relays.length, 2);
  assertEquals(db.relays[1]?.serverId, "srv-b");
  assertEquals(db.relays[1]?.prefix, "10.65.0.0/16");
});

test("enableOrganizationFabric rolls back a policy write when the new relay cannot be allocated", async () => {
  const existing: FabricRecord = {
    id: "fab-existing",
    organizationId: ORG,
    cidr: "10.252.0.0/16",
    options: { containerPool: "10.64.0.0/15" },
  };
  const db = createLifecycleDb({
    servers: [
      { id: "srv-a", organizationId: ORG },
      { id: "srv-b", organizationId: ORG },
    ],
    fabrics: [{
      id: existing.id,
      organizationId: ORG,
      cidr: existing.cidr,
      options: existing.options,
    }],
    relays: [{
      id: "relay-a",
      fabricId: existing.id,
      serverId: "srv-a",
      address: "10.252.0.1",
      role: "member",
      keepalive: null,
      endpointAddress: null,
      publicKey: null,
      prefix: "10.64.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    }],
  });

  const err = await assertRejects(() =>
    enableOrganizationFabric(db, ORG, { containerPool: "10.64.0.0/16" })
  );
  assertKind(err, "fabric_prefix_pool_exhausted");
  assertEquals(db.fabrics[0]?.options, { containerPool: "10.64.0.0/15" });
  assertEquals(db.relays.length, 1);
});

test("disableOrganizationFabric no-ops when fabric is absent", async () => {
  const db = createLifecycleDb();
  const serverIds = await disableOrganizationFabric(db, ORG);
  assertEquals(serverIds, []);
  assertEquals(db.fabrics.length, 0);
});

test("disableOrganizationFabric deletes fabric and returns relay server ids", async () => {
  const db = createLifecycleDb({
    fabrics: [{
      id: "fab-1",
      organizationId: ORG,
      cidr: "10.250.0.0/16",
      options: null,
    }],
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
        role: "gateway",
        keepalive: 25,
        endpointAddress: null,
        publicKey: "pk-b",
        prefix: "10.193.0.0/16",
        advertisedCidrs: ["10.0.0.0/8"],
        metadata: {},
      },
    ],
  });

  const serverIds = await disableOrganizationFabric(db, ORG);

  assertEquals(serverIds.sort(), ["srv-a", "srv-b"]);
  assertEquals(db.fabrics.length, 0);
});

test("ensureComposeNetworkRow reuses existing row by composeKey", async () => {
  const db = createLifecycleDb({
    networks: [{
      id: "net-existing",
      organizationId: ORG,
      environmentId: ENV,
      kind: "compose",
      name: "frontend",
      cidr: null,
      options: {
        composeKey: "frontend",
        dockerNetworkName: "tpn_custom_name",
      },
    }],
  });

  const first = await ensureComposeNetworkRow(db, {
    organizationId: ORG,
    environmentId: ENV,
    composeKey: "frontend",
  });
  const second = await ensureComposeNetworkRow(db, {
    organizationId: ORG,
    environmentId: ENV,
    composeKey: "frontend",
  });

  assertEquals(first.id, "net-existing");
  assertEquals(first.hostName, "tpn_custom_name");
  assertEquals(second, first);
  assertEquals(db.networks.length, 1);
});

test("ensureComposeNetworkRow inserts row and stamps dockerNetworkName", async () => {
  const db = createLifecycleDb();

  const row = await ensureComposeNetworkRow(db, {
    organizationId: ORG,
    environmentId: ENV,
    composeKey: "backend",
  });

  assertEquals(db.networks.length, 1);
  assertEquals(row.hostName, composeNetworkHostName(row.id));
  assertEquals(db.networks[0]?.options.composeKey, "backend");
  assertEquals(db.networks[0]?.options.dockerNetworkName, row.hostName);
});

test("stampRelayPublicKey returns false when relay is missing", async () => {
  const db = createLifecycleDb();
  const filled = await stampRelayPublicKey(db, {
    fabricId: "fab-1",
    serverId: "srv-a",
    publicKey: "pk-new",
  });
  assertEquals(filled, false);
});

test("stampRelayPublicKey reports first-time key fill only", async () => {
  const db = createLifecycleDb({
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

  const first = await stampRelayPublicKey(db, {
    fabricId: "fab-1",
    serverId: "srv-a",
    publicKey: "pk-first",
  });
  const second = await stampRelayPublicKey(db, {
    fabricId: "fab-1",
    serverId: "srv-a",
    publicKey: "pk-second",
  });

  assertEquals(first, true);
  assertEquals(second, false);
  assertEquals(db.relays[0]?.publicKey, "pk-second");
});

test("stampRelayReconcileSuccess merges metadata on the relay row", async () => {
  const db = createLifecycleDb({
    relays: [{
      id: "relay-a",
      fabricId: "fab-1",
      serverId: "srv-a",
      address: "10.250.0.1",
      role: "member",
      keepalive: null,
      endpointAddress: null,
      publicKey: "pk-a",
      prefix: "10.192.0.0/16",
      advertisedCidrs: [],
      metadata: { appliedPayloadHash: "old-hash" },
    }],
  });

  await stampRelayReconcileSuccess(db, {
    fabricId: "fab-1",
    serverId: "srv-a",
    appliedPayloadHash: "new-hash",
    observedPeers: [{ publicKey: "pk-b" }],
  });

  const metadata = db.relays[0]?.metadata as {
    appliedPayloadHash?: string;
    appliedAt?: string;
    observed?: { peers: unknown[] };
  };
  assertEquals(metadata.appliedPayloadHash, "new-hash");
  assertEquals(typeof metadata.appliedAt, "string");
  assertEquals(metadata.observed?.peers.length, 1);
});

test("clearRelayAppliedPayloadHash removes hash for all server relays", async () => {
  const db = createLifecycleDb({
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
        metadata: { appliedPayloadHash: "hash-a", appliedAt: "t1" },
      },
      {
        id: "relay-b",
        fabricId: "fab-2",
        serverId: "srv-a",
        address: "10.251.0.1",
        role: "member",
        keepalive: null,
        endpointAddress: null,
        publicKey: null,
        prefix: "10.193.0.0/16",
        advertisedCidrs: [],
        metadata: { appliedPayloadHash: "hash-b" },
      },
    ],
  });

  await clearRelayAppliedPayloadHash(db, { serverId: "srv-a" });

  const metaA = db.relays[0]?.metadata as Record<string, unknown>;
  const metaB = db.relays[1]?.metadata as Record<string, unknown>;
  assertEquals("appliedPayloadHash" in metaA, false);
  assertEquals(metaA.appliedAt, "t1");
  assertEquals("appliedPayloadHash" in metaB, false);
});

test("clearRelayAppliedPayloadHash scopes by fabricId when provided", async () => {
  const db = createLifecycleDb({
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
        metadata: { appliedPayloadHash: "hash-a" },
      },
      {
        id: "relay-b",
        fabricId: "fab-2",
        serverId: "srv-a",
        address: "10.251.0.1",
        role: "member",
        keepalive: null,
        endpointAddress: null,
        publicKey: null,
        prefix: "10.193.0.0/16",
        advertisedCidrs: [],
        metadata: { appliedPayloadHash: "hash-b" },
      },
    ],
  });

  await clearRelayAppliedPayloadHash(db, {
    serverId: "srv-a",
    fabricId: "fab-1",
  });

  const metaA = db.relays[0]?.metadata as Record<string, unknown>;
  const metaB = db.relays[1]?.metadata as Record<string, unknown>;
  assertEquals("appliedPayloadHash" in metaA, false);
  assertEquals(metaB.appliedPayloadHash, "hash-b");
});

test("updateFabricRelay patches gateway fields and returns the relay", async () => {
  const db = createLifecycleDb({
    relays: [{
      id: "relay-a",
      fabricId: "fab-1",
      serverId: "srv-a",
      address: "10.250.0.1",
      role: "member",
      keepalive: null,
      endpointAddress: null,
      publicKey: "pk-a",
      prefix: "10.192.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    }],
  });

  const updated = await updateFabricRelay(db, {
    fabricId: "fab-1",
    serverId: "srv-a",
    role: "gateway",
    keepalive: 25,
    endpointAddress: "203.0.113.10",
    advertisedCidrs: ["10.0.0.0/8"],
    presharedKey: "sealed-secret",
  });

  assertEquals(updated?.role, "gateway");
  assertEquals(updated?.keepalive, 25);
  assertEquals(updated?.endpointAddress, "203.0.113.10");
  assertEquals(updated?.advertisedCidrs, ["10.0.0.0/8"]);
  assertEquals(db.relays[0]?.presharedKey, "sealed-secret");
});

test("updateFabricRelay returns null when relay is missing", async () => {
  const db = createLifecycleDb();
  const updated = await updateFabricRelay(db, {
    fabricId: "fab-1",
    serverId: "srv-a",
    role: "gateway",
  });
  assertEquals(updated, null);
});

test("ensureFabricRelays retries relay insert after prefix unique violation", async () => {
  const db = createLifecycleDb({
    servers: [{ id: "srv-a", organizationId: ORG }],
    relayPrefixInsertFailures: 1,
  });

  const relays = await ensureFabricRelays(db, {
    fabric: {
      id: "fab-1",
      organizationId: ORG,
      cidr: "10.250.0.0/16",
      options: null,
    },
    organizationId: ORG,
  });

  assertEquals(relays.length, 1);
  assertEquals(relays[0]?.serverId, "srv-a");
  assertEquals(db.relayInserts, 2);
});

test("ensureFabricRelays maps repeated prefix unique violations to pool exhausted", async () => {
  const db = createLifecycleDb({
    servers: [{ id: "srv-a", organizationId: ORG }],
    relayPrefixInsertFailures: 2,
  });

  const err = await assertRejects(
    () =>
      ensureFabricRelays(db, {
        fabric: {
          id: "fab-1",
          organizationId: ORG,
          cidr: "10.250.0.0/16",
          options: null,
        },
        organizationId: ORG,
      }),
    FabricAllocationError,
  );
  assertKind(err, "fabric_prefix_pool_exhausted");
  assertEquals(db.relayInserts, 2);
});

test("purgeEnvironmentComposeNetworks deletes compose networks and segments", async () => {
  const db = createLifecycleDb({
    networks: [
      {
        id: "net-compose",
        organizationId: ORG,
        environmentId: ENV,
        kind: "compose",
        name: "frontend",
        cidr: null,
        options: { composeKey: "frontend" },
      },
      {
        id: "net-dc",
        organizationId: ORG,
        environmentId: ENV,
        kind: "datacenter",
        name: "site",
        cidr: "10.0.0.0/24",
        options: {},
      },
    ],
    segments: [{
      id: "seg-1",
      networkId: "net-compose",
      serverId: "srv-a",
      cidr: "10.192.0.0/24",
      options: null,
    }],
  });

  await purgeEnvironmentComposeNetworks(db, ENV);

  assertEquals(db.networks.map((row) => row.id), ["net-dc"]);
  assertEquals(db.segments.length, 0);
});

test("releaseSubnetsForServer removes segments and orphan compose networks", async () => {
  const db = createLifecycleDb({
    networks: [
      {
        id: "net-compose-a",
        organizationId: ORG,
        environmentId: ENV,
        kind: "compose",
        name: "frontend",
        cidr: null,
        options: { composeKey: "frontend" },
      },
      {
        id: "net-compose-b",
        organizationId: ORG,
        environmentId: ENV,
        kind: "compose",
        name: "backend",
        cidr: null,
        options: { composeKey: "backend" },
      },
    ],
    segments: [
      {
        id: "seg-a",
        networkId: "net-compose-a",
        serverId: "srv-a",
        cidr: "10.192.0.0/24",
        options: null,
      },
      {
        id: "seg-b",
        networkId: "net-compose-b",
        serverId: "srv-b",
        cidr: "10.193.0.0/24",
        options: null,
      },
    ],
  });

  await releaseSubnetsForServer(db, {
    environmentId: ENV,
    serverId: "srv-a",
  });

  assertEquals(db.segments.map((row) => row.id), ["seg-b"]);
  assertEquals(db.networks.map((row) => row.id), ["net-compose-b"]);
});

test("purgeComposeNetworksCreatedAfter removes new networks and extra segments", async () => {
  const db = createLifecycleDb({
    networks: [{
      id: "net-old",
      organizationId: ORG,
      environmentId: ENV,
      kind: "compose",
      name: "frontend",
      cidr: null,
      options: { composeKey: "frontend" },
    }],
    segments: [{
      id: "seg-old-a",
      networkId: "net-old",
      serverId: "srv-a",
      cidr: "10.192.0.0/24",
      options: null,
    }],
  });

  const prior = await listEnvironmentComposeNetworks(db, ENV);

  db.networks.push({
    id: "net-new",
    organizationId: ORG,
    environmentId: ENV,
    kind: "compose",
    name: "backend",
    cidr: null,
    options: { composeKey: "backend" },
  });
  db.segments.push({
    id: "seg-old-b",
    networkId: "net-old",
    serverId: "srv-b",
    cidr: "10.192.1.0/24",
    options: null,
  });

  await purgeComposeNetworksCreatedAfter(db, ENV, prior);

  assertEquals(db.networks.map((row) => row.id), ["net-old"]);
  assertEquals(
    db.segments.map((row) => row.serverId).sort(),
    ["srv-a"],
  );
});
