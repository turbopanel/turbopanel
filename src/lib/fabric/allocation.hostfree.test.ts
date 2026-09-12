import { assertEquals, assertThrows } from "@std/assert";
import {
  buildFabricReconcilePayloadFromSnapshot,
  buildPeerMaterial,
  type EndpointAddressCaches,
  FabricAllocationError,
  type FabricReconcileSnapshot,
  hashFabricReconcileDesired,
  listFabricRelays,
  loadRelayAddressesForServers,
  nthSubnetCidr,
  planRelayPath,
  fabricPairCacheKey,
  type RelayPathPlan,
  type RelayRecord,
  requireRelayHostAddress,
  requireRelayPrefix,
  requireSubnetCidr,
  resolveRelayGlobalEndpointAddress,
  selectPairPresharedEnvelope,
} from "../db/fabric-records.ts";
import { DEFAULT_FABRIC_CONTAINER_POOL } from "./cidr.ts";
import type { DatacenterMembershipRow } from "../net/datacenter-membership.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function emptyCaches(): EndpointAddressCaches {
  return {
    publicAddressByServer: new Map(),
    reportedByServer: new Map(),
    datacenterMembershipsByServer: new Map(),
    policyByDatacenter: new Map(),
    natEndpointByPair: new Map(),
    failedPathKindsByPair: new Map(),
  };
}

function membershipPin(
  serverId: string,
  datacenterId: string,
  address: string,
): DatacenterMembershipRow {
  return {
    ipId: `ip-${serverId}-${datacenterId}`,
    serverId,
    datacenterId,
    networkId: `net-${datacenterId}`,
    address,
    family: 4,
  };
}

function requireMaterial(
  material: Awaited<ReturnType<typeof buildPeerMaterial>>,
): NonNullable<Awaited<ReturnType<typeof buildPeerMaterial>>> {
  if (!material) throw new TypeError("expected peer material");
  return material;
}

function unimplementedPathFields(): Pick<
  RelayPathPlan,
  "directNat" | "gateway" | "relay"
> {
  return { directNat: null, gateway: null, relay: null };
}

const VIEWER = { serverId: "viewer" };

test("requireRelayHostAddress picks the lowest free host and reuses a gap", () => {
  assertEquals(requireRelayHostAddress("10.250.0.0/16", []), "10.250.0.1");
  assertEquals(
    requireRelayHostAddress("10.250.0.0/16", ["10.250.0.1", "10.250.0.3"]),
    "10.250.0.2",
  );
});

test("requireRelayHostAddress raises fabric_address_pool_exhausted", () => {
  const occupied = ["10.250.0.1", "10.250.0.2"];
  assertThrows(
    () => requireRelayHostAddress("10.250.0.0/30", occupied),
    FabricAllocationError,
    "TurboFabric address pool exhausted",
  );
});

test("requireRelayPrefix picks the lowest free /16 and reuses a gap", () => {
  assertEquals(
    requireRelayPrefix(DEFAULT_FABRIC_CONTAINER_POOL, []),
    "10.192.0.0/16",
  );
  assertEquals(
    requireRelayPrefix(DEFAULT_FABRIC_CONTAINER_POOL, [
      "10.192.0.0/16",
      "10.194.0.0/16",
    ]),
    "10.193.0.0/16",
  );
});

test("requireRelayPrefix raises fabric_prefix_pool_exhausted", () => {
  const occupied: string[] = [];
  for (let i = 0; i < 16; i++) {
    occupied.push(`10.${String(192 + i)}.0.0/16`);
  }
  assertThrows(
    () => requireRelayPrefix(DEFAULT_FABRIC_CONTAINER_POOL, occupied),
    FabricAllocationError,
    "TurboFabric prefix address pool exhausted",
  );
});

test("requireRelayPrefix steps around exclusion ranges (reserved rows, site subnets)", () => {
  assertEquals(
    requireRelayPrefix(DEFAULT_FABRIC_CONTAINER_POOL, [], ["10.192.0.0/16"]),
    "10.193.0.0/16",
  );
  assertEquals(
    requireRelayPrefix(
      DEFAULT_FABRIC_CONTAINER_POOL,
      ["10.192.0.0/16"],
      ["10.193.10.0/24", "10.194.0.0/15"],
    ),
    "10.196.0.0/16",
  );
});

test("requireRelayPrefix raises fabric_prefix_pool_exhausted when exclusions cover the pool", () => {
  assertThrows(
    () =>
      requireRelayPrefix(DEFAULT_FABRIC_CONTAINER_POOL, [], ["10.192.0.0/12"]),
    FabricAllocationError,
    "TurboFabric prefix address pool exhausted",
  );
});

test("requireSubnetCidr is scoped to the owning relay prefix", () => {
  assertEquals(requireSubnetCidr("10.192.0.0/16", []), "10.192.0.0/24");
  assertEquals(
    requireSubnetCidr("10.192.0.0/16", [
      "10.192.0.0/24",
      "10.193.0.0/24",
      "10.192.2.0/24",
    ]),
    "10.192.1.0/24",
  );
});

test("requireSubnetCidr raises fabric_segment_pool_exhausted", () => {
  assertThrows(
    () => requireSubnetCidr("10.192.0.0/24", ["10.192.0.0/24"]),
    FabricAllocationError,
    "TurboFabric segment address pool exhausted",
  );
});

test("requireSubnetCidr stays scoped to the relay prefix and ignores foreign CIDRs", () => {
  assertEquals(
    requireSubnetCidr("10.192.0.0/16", [
      "10.193.0.0/24",
      "10.194.0.0/24",
    ]),
    "10.192.0.0/24",
  );
});

test("requireSubnetCidr steps around exclusion ranges inside the relay prefix", () => {
  assertEquals(
    requireSubnetCidr("10.192.0.0/16", [], ["10.192.0.0/23"]),
    "10.192.2.0/24",
  );
  assertEquals(
    requireSubnetCidr("10.192.0.0/16", ["10.192.2.0/24"], ["10.192.0.0/23"]),
    "10.192.3.0/24",
  );
  // Exclusions outside the prefix are irrelevant.
  assertEquals(
    requireSubnetCidr("10.192.0.0/16", [], ["10.250.0.0/16", "10.193.0.0/24"]),
    "10.192.0.0/24",
  );
});

test("requireSubnetCidr raises fabric_segment_pool_exhausted when an exclusion covers the prefix", () => {
  assertThrows(
    () => requireSubnetCidr("10.192.0.0/16", [], ["10.192.0.0/16"]),
    FabricAllocationError,
    "TurboFabric segment address pool exhausted",
  );
});

test("requireSubnetCidr reuses the lowest gap inside a /16 relay prefix", () => {
  const taken: string[] = [];
  for (let octet = 0; octet < 256; octet += 1) {
    taken.push(`10.192.${String(octet)}.0/24`);
  }
  taken.splice(42, 1);
  assertEquals(
    requireSubnetCidr("10.192.0.0/16", taken),
    "10.192.42.0/24",
  );
});

test("nthSubnetCidr indexes /24 slices inside a relay prefix", () => {
  assertEquals(nthSubnetCidr("10.192.0.0/16", 0), "10.192.0.0/24");
  assertEquals(nthSubnetCidr("10.192.0.0/16", 1), "10.192.1.0/24");
  assertEquals(nthSubnetCidr("10.192.0.0/16", 255), "10.192.255.0/24");
  assertEquals(nthSubnetCidr("10.192.0.0/16", 256), null);
});

test("loadRelayAddressesForServers returns empty map for no ids and dedupes input", async () => {
  assertEquals(await loadRelayAddressesForServers({} as never, []), new Map());

  const rows = [
    { serverId: "srv-1", address: "10.250.0.1/32" },
    { serverId: "srv-2", address: "10.250.0.2" },
  ];
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return thenable(rows);
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof loadRelayAddressesForServers>[0];

  const map = await loadRelayAddressesForServers(db, [
    "srv-1",
    "srv-1",
    "srv-2",
  ]);
  assertEquals(map.get("srv-1"), "10.250.0.1");
  assertEquals(map.get("srv-2"), "10.250.0.2");
  assertEquals(map.size, 2);
});

test("FabricAllocationError carries each kind discriminant", () => {
  assertEquals(
    new FabricAllocationError("relay_missing").kind,
    "relay_missing",
  );
  assertEquals(
    new FabricAllocationError("relay_endpoint_unavailable").kind,
    "relay_endpoint_unavailable",
  );
});

test("resolveRelayGlobalEndpointAddress prefers operator pin then public ip then reported public IPv4", () => {
  const caches = emptyCaches();
  caches.publicAddressByServer.set("srv-1", "203.0.113.5");
  caches.reportedByServer.set("srv-1", [
    { address: "10.1.0.5", version: 4, scope: "private" },
    { address: "198.51.100.5", version: 4, scope: "public" },
  ]);

  assertEquals(
    resolveRelayGlobalEndpointAddress(
      { serverId: "srv-1", endpointAddress: "192.0.2.5" },
      caches,
    ),
    "192.0.2.5",
  );
  assertEquals(
    resolveRelayGlobalEndpointAddress(
      { serverId: "srv-1", endpointAddress: null },
      caches,
    ),
    "203.0.113.5",
  );

  caches.publicAddressByServer.delete("srv-1");
  assertEquals(
    resolveRelayGlobalEndpointAddress(
      { serverId: "srv-1", endpointAddress: null },
      caches,
    ),
    "198.51.100.5",
  );
});

test("resolveRelayGlobalEndpointAddress never falls back to a private address", () => {
  const caches = emptyCaches();
  // A datacenter pin (only reachable through `datacenterMembershipsByServer`,
  // which requires *shared* membership) and a reported private IPv4 are both
  // routable only inside that LAN; a viewer-less display value claims neither.
  caches.datacenterMembershipsByServer.set("srv-1", [
    membershipPin("srv-1", "dc-a", "10.0.0.5"),
  ]);
  caches.reportedByServer.set("srv-1", [
    { address: "10.1.0.5", version: 4, scope: "private" },
  ]);

  assertEquals(
    resolveRelayGlobalEndpointAddress(
      { serverId: "srv-1", endpointAddress: null },
      caches,
    ),
    null,
  );
});

test("resolveRelayGlobalEndpointAddress returns null when nothing global resolves", () => {
  assertEquals(
    resolveRelayGlobalEndpointAddress(
      { serverId: "srv-missing", endpointAddress: null },
      emptyCaches(),
    ),
    null,
  );
});

test("planRelayPath prefers operator pin over shared datacenter LAN", () => {
  const caches = emptyCaches();
  caches.datacenterMembershipsByServer.set("self", [
    membershipPin("self", "dc-a", "10.0.0.1"),
  ]);
  caches.datacenterMembershipsByServer.set("other", [
    membershipPin("other", "dc-a", "10.0.0.5"),
  ]);
  caches.publicAddressByServer.set("other", "203.0.113.5");
  assertEquals(
    planRelayPath({
      self: { serverId: "self" },
      other: { serverId: "other", endpointAddress: "192.0.2.5" },
      caches,
    }),
    {
      candidates: [
        { kind: "direct_lan", address: "10.0.0.5", datacenterId: "dc-a" },
        { kind: "direct_public", address: "192.0.2.5" },
      ],
      selected: { kind: "direct_public", endpoint: "192.0.2.5" },
      ...unimplementedPathFields(),
    },
  );
});

test("planRelayPath picks shared-datacenter LAN before public", () => {
  const caches = emptyCaches();
  caches.datacenterMembershipsByServer.set("self", [
    membershipPin("self", "dc-a", "10.0.0.1"),
  ]);
  caches.datacenterMembershipsByServer.set("other", [
    membershipPin("other", "dc-a", "10.0.0.5"),
  ]);
  caches.policyByDatacenter.set("dc-a", { addressPreference: "ipv6", priority: 100, trusted: true });
  caches.publicAddressByServer.set("other", "203.0.113.5");
  assertEquals(
    planRelayPath({
      self: { serverId: "self" },
      other: { serverId: "other", endpointAddress: null },
      caches,
    }),
    {
      candidates: [
        { kind: "direct_lan", address: "10.0.0.5", datacenterId: "dc-a" },
        { kind: "direct_public", address: "203.0.113.5" },
      ],
      selected: {
        kind: "direct_lan",
        endpoint: "10.0.0.5",
        datacenterId: "dc-a",
      },
      ...unimplementedPathFields(),
    },
  );
});

test("planRelayPath omits direct_lan for an untrusted shared datacenter and falls to public", () => {
  const caches = emptyCaches();
  caches.datacenterMembershipsByServer.set("self", [
    membershipPin("self", "dc-shared", "10.0.0.1"),
  ]);
  caches.datacenterMembershipsByServer.set("other", [
    membershipPin("other", "dc-shared", "10.0.0.5"),
  ]);
  caches.policyByDatacenter.set("dc-shared", {
    addressPreference: "ipv4",
    priority: 0,
    trusted: false,
  });
  caches.publicAddressByServer.set("other", "203.0.113.5");
  assertEquals(
    planRelayPath({
      self: { serverId: "self" },
      other: { serverId: "other", endpointAddress: null },
      caches,
    }),
    {
      candidates: [{ kind: "direct_public", address: "203.0.113.5" }],
      selected: { kind: "direct_public", endpoint: "203.0.113.5" },
      ...unimplementedPathFields(),
    },
  );
});

test("planRelayPath picks the lower-priority-number shared datacenter's pin", () => {
  const caches = emptyCaches();
  caches.datacenterMembershipsByServer.set("self", [
    membershipPin("self", "dc-a", "10.0.0.1"),
    membershipPin("self", "dc-b", "10.1.0.1"),
  ]);
  caches.datacenterMembershipsByServer.set("other", [
    membershipPin("other", "dc-a", "10.0.0.5"),
    membershipPin("other", "dc-b", "10.1.0.5"),
  ]);
  // Without policy `dc-a` would win on id order; priority inverts that.
  caches.policyByDatacenter.set("dc-a", {
    addressPreference: "ipv4",
    priority: 200,
    trusted: true,
  });
  caches.policyByDatacenter.set("dc-b", {
    addressPreference: "ipv4",
    priority: 10,
    trusted: true,
  });
  assertEquals(
    planRelayPath({
      self: { serverId: "self" },
      other: { serverId: "other", endpointAddress: null },
      caches,
    }),
    {
      candidates: [
        { kind: "direct_lan", address: "10.1.0.5", datacenterId: "dc-b" },
      ],
      selected: {
        kind: "direct_lan",
        endpoint: "10.1.0.5",
        datacenterId: "dc-b",
      },
      ...unimplementedPathFields(),
    },
  );

  // A trusted datacenter beats an untrusted one regardless of priority.
  caches.policyByDatacenter.set("dc-b", {
    addressPreference: "ipv4",
    priority: 10,
    trusted: false,
  });
  assertEquals(
    planRelayPath({
      self: { serverId: "self" },
      other: { serverId: "other", endpointAddress: null },
      caches,
    }).selected,
    { kind: "direct_lan", endpoint: "10.0.0.5", datacenterId: "dc-a" },
  );
});

test("planRelayPath does not use a datacenter the source is not a member of", () => {
  const caches = emptyCaches();
  caches.datacenterMembershipsByServer.set("self", [
    membershipPin("self", "dc-a", "10.0.0.1"),
  ]);
  caches.datacenterMembershipsByServer.set("other", [
    membershipPin("other", "dc-b", "10.8.0.5"),
  ]);
  caches.publicAddressByServer.set("other", "198.51.100.5");
  assertEquals(
    planRelayPath({
      self: { serverId: "self" },
      other: { serverId: "other", endpointAddress: null },
      caches,
    }),
    {
      candidates: [{ kind: "direct_public", address: "198.51.100.5" }],
      selected: { kind: "direct_public", endpoint: "198.51.100.5" },
      ...unimplementedPathFields(),
    },
  );

  caches.publicAddressByServer.delete("other");
  assertEquals(
    planRelayPath({
      self: { serverId: "self" },
      other: { serverId: "other", endpointAddress: null },
      caches,
    }),
    {
      candidates: [],
      selected: { kind: "unreachable" },
      ...unimplementedPathFields(),
    },
  );
});

test("planRelayPath does not emit a reported private IPv4 as direct_public", () => {
  const caches = emptyCaches();
  caches.datacenterMembershipsByServer.set("self", [
    membershipPin("self", "dc-a", "10.0.0.1"),
  ]);
  caches.datacenterMembershipsByServer.set("other", [
    membershipPin("other", "dc-b", "10.8.0.5"),
  ]);
  caches.reportedByServer.set("other", [
    { address: "10.8.0.5", version: 4, scope: "private" },
  ]);
  assertEquals(
    planRelayPath({
      self: { serverId: "self" },
      other: { serverId: "other", endpointAddress: null },
      caches,
    }),
    {
      candidates: [],
      selected: { kind: "unreachable" },
      ...unimplementedPathFields(),
    },
  );

  caches.reportedByServer.set("other", [
    { address: "10.8.0.5", version: 4, scope: "private" },
    { address: "203.0.113.9", version: 4, scope: "public" },
  ]);
  assertEquals(
    planRelayPath({
      self: { serverId: "self" },
      other: { serverId: "other", endpointAddress: null },
      caches,
    }),
    {
      candidates: [{ kind: "direct_public", address: "203.0.113.9" }],
      selected: { kind: "direct_public", endpoint: "203.0.113.9" },
      ...unimplementedPathFields(),
    },
  );
});

test("planRelayPath returns unreachable when no path exists", () => {
  assertEquals(
    planRelayPath({
      self: { serverId: "self" },
      other: { serverId: "other", endpointAddress: null },
      caches: emptyCaches(),
    }),
    {
      candidates: [],
      selected: { kind: "unreachable" },
      ...unimplementedPathFields(),
    },
  );
});

function relayFixture(overrides: Partial<RelayRecord> = {}): RelayRecord {
  return {
    id: "relay-1",
    fabricId: "fab-1",
    serverId: "srv-1",
    address: "10.250.0.1",
    role: "member",
    keepalive: null,
    endpointAddress: "203.0.113.1",
    publicKey: "pk",
    prefix: "10.192.0.0/16",
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
    ...overrides,
  };
}

function materialArgs(
  other: RelayRecord,
  caches: EndpointAddressCaches = emptyCaches(),
  extra?: {
    extraAllowedIPs?: readonly string[];
    advertisedCidrs?: readonly string[];
    sealedPresharedKey?: string | null;
    resealPresharedKey?: (sealed: string) => Promise<string | null>;
  },
): Parameters<typeof buildPeerMaterial>[0] {
  return {
    self: VIEWER,
    other,
    listenPort: 51821,
    caches,
    sealedPresharedKey: extra?.sealedPresharedKey ?? null,
    plan: planRelayPath({ self: VIEWER, other, caches }),
    ...(extra?.extraAllowedIPs ? { extraAllowedIPs: extra.extraAllowedIPs } : {}),
    ...(extra?.advertisedCidrs ? { advertisedCidrs: extra.advertisedCidrs } : {}),
    ...(extra?.resealPresharedKey
      ? { resealPresharedKey: extra.resealPresharedKey }
      : {}),
  };
}

function thenable<T>(value: T) {
  return {
    then(resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

test("buildPeerMaterial appends gateway advertised CIDRs to allowedIPs", async () => {
  const material = requireMaterial(
    await buildPeerMaterial(materialArgs(
      relayFixture({
        role: "gateway",
        advertisedCidrs: ["10.0.0.0/24", "10.1.0.0/24", "10.250.0.1/32"],
      }),
    )),
  );
  assertEquals(material.allowedIPs, [
    "10.250.0.1/32",
    "10.192.0.0/16",
    "10.0.0.0/24",
    "10.1.0.0/24",
  ]);
  assertEquals(material.endpoint, "203.0.113.1:51821");
  assertEquals(material.pathKind, "direct_public");
});

test("buildPeerMaterial forwards keepalive and reseals pair PSK when provided", async () => {
  const material = requireMaterial(
    await buildPeerMaterial(materialArgs(relayFixture({ keepalive: 25 }), emptyCaches(), {
      sealedPresharedKey: "sealed-psk",
      resealPresharedKey: (sealed) => Promise.resolve(`plain:${sealed}`),
    })),
  );
  assertEquals(material.keepalive, 25);
  assertEquals(material.presharedKey, "plain:sealed-psk");
});

test("buildPeerMaterial honors advertisedCidrs override and falls back when omitted", async () => {
  const gateway = relayFixture({
    role: "gateway",
    advertisedCidrs: ["203.0.113.0/24"],
  });
  const overridden = requireMaterial(
    await buildPeerMaterial(materialArgs(gateway, emptyCaches(), {
      advertisedCidrs: ["198.51.100.0/24"],
    })),
  );
  assertEquals(overridden.allowedIPs, [
    "10.250.0.1/32",
    "10.192.0.0/16",
    "198.51.100.0/24",
  ]);

  const fallback = requireMaterial(
    await buildPeerMaterial(materialArgs(gateway)),
  );
  assertEquals(fallback.allowedIPs, [
    "10.250.0.1/32",
    "10.192.0.0/16",
    "203.0.113.0/24",
  ]);
});

test("buildPeerMaterial keeps member advertised CIDRs out of allowedIPs", async () => {
  const material = requireMaterial(
    await buildPeerMaterial(materialArgs(relayFixture({
      role: "member",
      advertisedCidrs: ["10.0.0.0/24"],
    }))),
  );
  assertEquals(material.allowedIPs, ["10.250.0.1/32", "10.192.0.0/16"]);
});

test("buildPeerMaterial returns null when the pair is unreachable", async () => {
  const material = await buildPeerMaterial(
    materialArgs(relayFixture({ endpointAddress: null })),
  );
  assertEquals(material, null);
});

test("listFabricRelays serializes gateway advertised CIDRs and empties members", async () => {
  const rows = [
    {
      id: "r-gw",
      fabricId: "fab-1",
      serverId: "srv-gw",
      address: "10.250.0.1",
      role: "gateway",
      keepalive: null,
      endpointAddress: null,
      publicKey: null,
      prefix: "10.192.0.0/16",
      advertisedCidrs: ["10.0.0.0/24"],
    },
    {
      id: "r-mem",
      fabricId: "fab-1",
      serverId: "srv-mem",
      address: "10.250.0.2",
      role: "member",
      keepalive: null,
      endpointAddress: null,
      publicKey: null,
      prefix: "10.193.0.0/16",
      advertisedCidrs: ["10.9.0.0/24"],
    },
  ];
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return thenable(rows);
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof listFabricRelays>[0];

  const relays = await listFabricRelays(db, "fab-1");
  assertEquals(relays[0]?.advertisedCidrs, ["10.0.0.0/24"]);
  assertEquals(relays[1]?.advertisedCidrs, []);
  assertEquals(relays[1]?.role, "member");
});

test("selectPairPresharedEnvelope uses the lexicographically smaller relay id", () => {
  const sealed = new Map<string, string | null>([
    ["r1", "seal-a"],
    ["r2", "seal-b"],
  ]);
  assertEquals(selectPairPresharedEnvelope("r1", "r2", sealed), "seal-a");
  assertEquals(selectPairPresharedEnvelope("r2", "r1", sealed), "seal-a");
});

test("selectPairPresharedEnvelope falls back when the owner has no envelope", () => {
  const sealed = new Map<string, string | null>([
    ["r1", null],
    ["r2", "seal-b"],
  ]);
  assertEquals(selectPairPresharedEnvelope("r1", "r2", sealed), "seal-b");
});

test("selectPairPresharedEnvelope returns null when neither relay stores an envelope", () => {
  const sealed = new Map<string, string | null>([
    ["r1", null],
    ["r2", null],
  ]);
  assertEquals(selectPairPresharedEnvelope("r1", "r2", sealed), null);
});

test("both relay payloads use the same canonical pair PSK when stored envelopes differ", async () => {
  const relays: RelayRecord[] = [
    relayFixture({
      id: "r1",
      serverId: "srv-1",
      address: "10.250.0.1",
      endpointAddress: "203.0.113.10",
      publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      prefix: "10.192.0.0/16",
    }),
    relayFixture({
      id: "r2",
      serverId: "srv-2",
      address: "10.250.0.2",
      endpointAddress: "203.0.113.11",
      publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
      prefix: "10.193.0.0/16",
    }),
  ];
  const snapshot: FabricReconcileSnapshot = {
    fabric: {
      id: "fab-1",
      organizationId: "org-1",
      cidr: "10.250.0.0/16",
      options: null,
    },
    relays,
    caches: emptyCaches(),
    sealedPresharedKeyByRelayId: new Map([
      ["r1", "seal-owner"],
      ["r2", "seal-other"],
    ]),
    segmentsByServer: new Map([
      ["srv-1", []],
      ["srv-2", []],
    ]),
    derivedAdvertisedCidrsByRelayId: new Map(),
    policy: { allowRelay: false },
  };
  const reseal = (sealed: string) => Promise.resolve(sealed);
  const built1 = await buildFabricReconcilePayloadFromSnapshot(snapshot, {
    serverId: "srv-1",
    resealPresharedKey: reseal,
  });
  const built2 = await buildFabricReconcilePayloadFromSnapshot(snapshot, {
    serverId: "srv-2",
    resealPresharedKey: reseal,
  });
  if (!built1?.payload.enabled || !built2?.payload.enabled) {
    throw new TypeError("expected enabled fabric payloads");
  }
  assertEquals(built1.payload.peers[0]?.presharedKeyEnvelope, "seal-owner");
  assertEquals(built2.payload.peers[0]?.presharedKeyEnvelope, "seal-owner");
});

test("hashFabricReconcileDesired is stable regardless of object key order", async () => {
  const a = await hashFabricReconcileDesired({
    enabled: true,
    peers: [{ endpoint: "203.0.113.1:51821", publicKey: "pk" }],
    listenPort: 51821,
  });
  const b = await hashFabricReconcileDesired({
    listenPort: 51821,
    enabled: true,
    peers: [{ publicKey: "pk", endpoint: "203.0.113.1:51821" }],
  });
  assertEquals(a, b);
  assertEquals(a.length > 0, true);
});

test("hashFabricReconcileDesired differs when pathKind changes", async () => {
  const shared = {
    publicKey: "pk",
    allowedIPs: ["10.250.0.2/32"],
    endpoint: "203.0.113.10:51821",
    keepalive: 25,
  };
  const lan = await hashFabricReconcileDesired({
    peers: [{ ...shared, pathKind: "direct_lan" }],
  });
  const pub = await hashFabricReconcileDesired({
    peers: [{ ...shared, pathKind: "direct_public" }],
  });
  assertEquals(lan === pub, false);
  const viaA = await hashFabricReconcileDesired({
    peers: [{ ...shared, pathKind: "gateway", viaServerId: "srv-gw-a" }],
  });
  const viaB = await hashFabricReconcileDesired({
    peers: [{ ...shared, pathKind: "gateway", viaServerId: "srv-gw-b" }],
  });
  assertEquals(viaA === viaB, false);
});

function pin(
  serverId: string,
  datacenterId: string,
  address: string,
): DatacenterMembershipRow {
  return membershipPin(serverId, datacenterId, address);
}

function gatewayCaches(params: {
  memberships: Array<[string, DatacenterMembershipRow[]]>;
  publicAddresses?: Array<[string, string]>;
}): EndpointAddressCaches {
  const caches = emptyCaches();
  for (const [serverId, rows] of params.memberships) {
    caches.datacenterMembershipsByServer.set(serverId, rows);
    for (const row of rows) {
      if (!caches.policyByDatacenter.has(row.datacenterId)) {
        caches.policyByDatacenter.set(row.datacenterId, {
          addressPreference: "ipv4",
          priority: 100,
          trusted: true,
        });
      }
    }
  }
  for (const [serverId, address] of params.publicAddresses ?? []) {
    caches.publicAddressByServer.set(serverId, address);
  }
  return caches;
}

test("planRelayPath prefers a destination-datacenter gateway over a source-datacenter gateway", () => {
  const leafA = relayFixture({ id: "r-a", serverId: "srv-a", endpointAddress: null });
  const leafB = relayFixture({
    id: "r-b",
    serverId: "srv-b",
    address: "10.250.0.2",
    endpointAddress: null,
  });
  const gwDest = relayFixture({
    id: "r-gwd",
    serverId: "srv-gwd",
    role: "gateway",
    publicKey: "pk-gwd",
    endpointAddress: null,
  });
  const gwSrc = relayFixture({
    id: "r-gws",
    serverId: "srv-gws",
    role: "gateway",
    publicKey: "pk-gws",
    endpointAddress: null,
  });
  const caches = gatewayCaches({
    memberships: [
      ["srv-a", [pin("srv-a", "dc-src", "10.0.0.1")]],
      ["srv-b", [pin("srv-b", "dc-dst", "10.0.1.1")]],
      ["srv-gwd", [pin("srv-gwd", "dc-dst", "10.0.1.2")]],
      ["srv-gws", [pin("srv-gws", "dc-src", "10.0.0.2")]],
    ],
    publicAddresses: [
      ["srv-gwd", "203.0.113.10"],
      ["srv-gws", "203.0.113.11"],
    ],
  });
  const plan = planRelayPath({
    self: leafA,
    other: leafB,
    caches,
    gateways: [gwSrc, gwDest],
  });
  assertEquals(plan.selected.kind, "gateway");
  assertEquals(plan.selected.viaServerId, "srv-gwd");
  assertEquals(plan.selected.viaRelayId, "r-gwd");
  assertEquals(plan.gateway?.viaServerId, "srv-gwd");
});

test("planRelayPath uses preferredGatewayIds within the same locality tier", () => {
  const leafA = relayFixture({ id: "r-a", serverId: "srv-a", endpointAddress: null });
  const leafB = relayFixture({
    id: "r-b",
    serverId: "srv-b",
    endpointAddress: null,
  });
  const gwFirst = relayFixture({
    id: "r-gw-aaa",
    serverId: "srv-gw-first",
    role: "gateway",
    publicKey: "pk-1",
    endpointAddress: null,
  });
  const gwPreferred = relayFixture({
    id: "r-gw-zzz",
    serverId: "srv-gw-pref",
    role: "gateway",
    publicKey: "pk-2",
    endpointAddress: null,
  });
  const caches = gatewayCaches({
    memberships: [
      ["srv-a", [pin("srv-a", "dc-src", "10.0.0.1")]],
      ["srv-b", [pin("srv-b", "dc-dst", "10.0.1.1")]],
      ["srv-gw-first", [pin("srv-gw-first", "dc-dst", "10.0.1.2")]],
      ["srv-gw-pref", [pin("srv-gw-pref", "dc-dst", "10.0.1.3")]],
    ],
    publicAddresses: [
      ["srv-gw-first", "203.0.113.10"],
      ["srv-gw-pref", "203.0.113.11"],
    ],
  });
  const byId = planRelayPath({
    self: leafA,
    other: leafB,
    caches,
    gateways: [gwPreferred, gwFirst],
  });
  assertEquals(byId.selected.viaRelayId, "r-gw-aaa");
  const preferred = planRelayPath({
    self: leafA,
    other: leafB,
    caches,
    gateways: [gwPreferred, gwFirst],
    preferredGatewayIds: ["srv-gw-pref"],
  });
  assertEquals(preferred.selected.viaServerId, "srv-gw-pref");
});

test("planRelayPath never selects a keyless gateway", () => {
  const leafA = relayFixture({ id: "r-a", serverId: "srv-a", endpointAddress: null });
  const leafB = relayFixture({
    id: "r-b",
    serverId: "srv-b",
    endpointAddress: null,
  });
  const keyless = relayFixture({
    id: "r-keyless",
    serverId: "srv-keyless",
    role: "gateway",
    publicKey: null,
    endpointAddress: null,
  });
  const keyed = relayFixture({
    id: "r-keyed",
    serverId: "srv-keyed",
    role: "gateway",
    publicKey: "pk-keyed",
    endpointAddress: null,
  });
  const caches = gatewayCaches({
    memberships: [
      ["srv-a", [pin("srv-a", "dc-src", "10.0.0.1")]],
      ["srv-b", [pin("srv-b", "dc-dst", "10.0.1.1")]],
      ["srv-keyless", [pin("srv-keyless", "dc-dst", "10.0.1.2")]],
      ["srv-keyed", [pin("srv-keyed", "dc-dst", "10.0.1.3")]],
    ],
    publicAddresses: [
      ["srv-keyless", "203.0.113.10"],
      ["srv-keyed", "203.0.113.11"],
    ],
  });
  const plan = planRelayPath({
    self: leafA,
    other: leafB,
    caches,
    gateways: [keyless, keyed],
  });
  assertEquals(plan.selected.viaServerId, "srv-keyed");
});

test("planRelayPath finds a two-gateway inter-datacenter path", () => {
  const leafA = relayFixture({ id: "r-a", serverId: "srv-a", endpointAddress: null });
  const leafB = relayFixture({
    id: "r-b",
    serverId: "srv-b",
    endpointAddress: null,
  });
  const gwA = relayFixture({
    id: "r-gwa",
    serverId: "srv-gwa",
    role: "gateway",
    publicKey: "pk-gwa",
    endpointAddress: null,
  });
  const gwB = relayFixture({
    id: "r-gwb",
    serverId: "srv-gwb",
    role: "gateway",
    publicKey: "pk-gwb",
    endpointAddress: null,
  });
  const caches = gatewayCaches({
    memberships: [
      ["srv-a", [pin("srv-a", "dc-a", "10.0.0.1")]],
      ["srv-gwa", [
        pin("srv-gwa", "dc-a", "10.0.0.2"),
        pin("srv-gwa", "dc-mid", "10.0.9.1"),
      ]],
      ["srv-b", [pin("srv-b", "dc-b", "10.0.1.1")]],
      ["srv-gwb", [
        pin("srv-gwb", "dc-b", "10.0.1.2"),
        pin("srv-gwb", "dc-mid", "10.0.9.2"),
      ]],
    ],
  });
  const plan = planRelayPath({
    self: leafA,
    other: leafB,
    caches,
    gateways: [gwA, gwB],
  });
  assertEquals(plan.selected.kind, "gateway");
  assertEquals(plan.selected.viaServerId, "srv-gwa");
});

test("planRelayPath rejects an unrelated third-datacenter gateway even when allowRelay is true", () => {
  const leafA = relayFixture({ id: "r-a", serverId: "srv-a", endpointAddress: null });
  const leafB = relayFixture({
    id: "r-b",
    serverId: "srv-b",
    endpointAddress: null,
  });
  const gwOther = relayFixture({
    id: "r-gwo",
    serverId: "srv-gwo",
    role: "gateway",
    publicKey: "pk-gwo",
    endpointAddress: null,
  });
  const caches = gatewayCaches({
    memberships: [
      ["srv-a", [pin("srv-a", "dc-a", "10.0.0.1")]],
      ["srv-b", [pin("srv-b", "dc-b", "10.0.1.1")]],
      ["srv-gwd", [
        pin("srv-gwd", "dc-b", "10.0.1.2"),
        pin("srv-gwd", "dc-mid", "10.0.9.1"),
      ]],
      ["srv-gwo", [
        pin("srv-gwo", "dc-c", "10.0.2.1"),
        pin("srv-gwo", "dc-mid", "10.0.9.2"),
      ]],
    ],
    publicAddresses: [
      ["srv-gwo", "203.0.113.10"],
    ],
  });
  const destGw = relayFixture({
    id: "r-gwd",
    serverId: "srv-gwd",
    role: "gateway",
    publicKey: "pk-gwd",
    endpointAddress: null,
  });
  const denied = planRelayPath({
    self: leafA,
    other: leafB,
    caches,
    gateways: [destGw, gwOther],
  });
  assertEquals(denied.selected.kind, "unreachable");
  assertEquals(denied.gateway, null);
  const allowed = planRelayPath({
    self: leafA,
    other: leafB,
    caches,
    gateways: [destGw, gwOther],
    allowRelay: true,
  });
  assertEquals(allowed.selected.kind, "unreachable");
  assertEquals(allowed.gateway, null);
});

test("planRelayPath stays unreachable when source, dest, and a public gateway are in three datacenters", () => {
  const leafA = relayFixture({ id: "r-a", serverId: "srv-a", endpointAddress: null });
  const leafB = relayFixture({
    id: "r-b",
    serverId: "srv-b",
    endpointAddress: null,
  });
  const gwOther = relayFixture({
    id: "r-gwo",
    serverId: "srv-gwo",
    role: "gateway",
    publicKey: "pk-gwo",
    endpointAddress: null,
  });
  const caches = gatewayCaches({
    memberships: [
      ["srv-a", [pin("srv-a", "dc-a", "10.0.0.1")]],
      ["srv-b", [pin("srv-b", "dc-b", "10.0.1.1")]],
      ["srv-gwo", [pin("srv-gwo", "dc-c", "10.0.2.1")]],
    ],
    publicAddresses: [
      ["srv-gwo", "203.0.113.10"],
    ],
  });
  const plan = planRelayPath({
    self: leafA,
    other: leafB,
    caches,
    gateways: [gwOther],
    allowRelay: true,
  });
  assertEquals(plan.selected.kind, "unreachable");
  assertEquals(plan.gateway, null);
});

test("planRelayPath stays unreachable when allowRelay is true but no gateway exists", () => {
  const leafA = relayFixture({ id: "r-a", serverId: "srv-a", endpointAddress: null });
  const leafB = relayFixture({
    id: "r-b",
    serverId: "srv-b",
    endpointAddress: null,
  });
  const plan = planRelayPath({
    self: leafA,
    other: leafB,
    caches: emptyCaches(),
    gateways: [],
    allowRelay: true,
  });
  assertEquals(plan.selected.kind, "unreachable");
  assertEquals(plan.gateway, null);
  assertEquals(plan.relay, null);
});

test("planRelayPath selects runtime NAT endpoint and emits keepalive 25", async () => {
  const caches = emptyCaches();
  caches.natEndpointByPair.set(
    fabricPairCacheKey("viewer", "srv-1"),
    "203.0.113.50:48172",
  );
  const other = relayFixture({ endpointAddress: null, keepalive: null });
  const plan = planRelayPath({ self: VIEWER, other, caches });
  assertEquals(plan.selected, {
    kind: "direct_nat",
    endpoint: "203.0.113.50:48172",
  });
  assertEquals(plan.directNat, {
    kind: "direct_nat",
    address: "203.0.113.50:48172",
  });
  const material = requireMaterial(
    await buildPeerMaterial(materialArgs(other, caches)),
  );
  assertEquals(material.endpoint, "203.0.113.50:48172");
  assertEquals(material.keepalive, 25);
  assertEquals(material.pathKind, "direct_nat");
});

test("planRelayPath falls through a failed direct_public to direct_nat", () => {
  const caches = emptyCaches();
  caches.publicAddressByServer.set("srv-1", "203.0.113.9");
  caches.natEndpointByPair.set(
    fabricPairCacheKey("viewer", "srv-1"),
    "203.0.113.50:48172",
  );
  caches.failedPathKindsByPair.set(
    fabricPairCacheKey("viewer", "srv-1"),
    new Set(["direct_public"]),
  );
  const plan = planRelayPath({
    self: VIEWER,
    other: relayFixture({ endpointAddress: null }),
    caches,
  });
  assertEquals(plan.selected.kind, "direct_nat");
  assertEquals(plan.selected.endpoint, "203.0.113.50:48172");
  assertEquals(
    plan.candidates.some((row) => row.kind === "direct_public"),
    false,
  );
});

test("hashFabricReconcileDesired changes when NAT promotion adds keepalive", async () => {
  const shared = {
    publicKey: "pk",
    allowedIPs: ["10.250.0.2/32"],
    endpoint: "203.0.113.50:48172",
  };
  const pub = await hashFabricReconcileDesired({
    peers: [{ ...shared, pathKind: "direct_public" }],
  });
  const nat = await hashFabricReconcileDesired({
    peers: [{ ...shared, pathKind: "direct_nat", keepalive: 25 }],
  });
  assertEquals(pub === nat, false);
});

