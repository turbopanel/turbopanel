import { assertEquals } from "@std/assert";
import {
  DOCKER_ADDRESS_POOLS_MAX,
  dockerAddressPoolCidrs,
  dockerDefaultBridgeNetworkCidr,
  dockerHostCidrs,
  findDockerBridgePoolOverlap,
  isValidDefaultBridgeCidr,
  parseOrganizationDockerNetworking,
  resolveOrganizationDockerNetworking,
  validateDockerAddressPools,
} from "./docker-address-pools.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("validateDockerAddressPools accepts aligned pools with a carve size inside the base", () => {
  assertEquals(
    validateDockerAddressPools([
      { base: "10.200.0.0/16", size: 24 },
      { base: "10.201.0.5/16", size: 16 },
    ]),
    {
      ok: true,
      pools: [
        { base: "10.200.0.0/16", size: 24 },
        { base: "10.201.0.0/16", size: 16 },
      ],
    },
  );
  assertEquals(validateDockerAddressPools([]), { ok: true, pools: [] });
});

test("validateDockerAddressPools rejects a bad base, a bad size and non-list shapes", () => {
  assertEquals(validateDockerAddressPools("10.0.0.0/8"), {
    ok: false,
    reason: "address_pools_invalid",
  });
  assertEquals(validateDockerAddressPools([{ base: "nope", size: 24 }]), {
    ok: false,
    reason: "address_pool_base_invalid",
    index: 0,
  });
  assertEquals(validateDockerAddressPools([{ base: "10.0.0.0/8", size: 7 }]), {
    ok: false,
    reason: "address_pool_size_invalid",
    index: 0,
  });
  assertEquals(validateDockerAddressPools([{ base: "10.0.0.0/8", size: 31 }]), {
    ok: false,
    reason: "address_pool_size_invalid",
    index: 0,
  });
  assertEquals(
    validateDockerAddressPools([{ base: "10.0.0.0/8", size: 24.5 }]),
    {
      ok: false,
      reason: "address_pool_size_invalid",
      index: 0,
    },
  );
  assertEquals(validateDockerAddressPools([{ base: "fd00::/48", size: 127 }]), {
    ok: false,
    reason: "address_pool_size_invalid",
    index: 0,
  });
  assertEquals(
    validateDockerAddressPools([{ base: "fd00::/48", size: 64 }]),
    { ok: true, pools: [{ base: "fd00::/48", size: 64 }] },
  );
});

test("validateDockerAddressPools rejects overlapping bases and an oversized list", () => {
  assertEquals(
    validateDockerAddressPools([
      { base: "10.0.0.0/8", size: 24 },
      { base: "10.200.0.0/16", size: 24 },
    ]),
    { ok: false, reason: "address_pools_overlap", index: 1 },
  );
  const tooMany = Array.from(
    { length: DOCKER_ADDRESS_POOLS_MAX + 1 },
    (_, i) => ({
      base: `10.${i}.0.0/16`,
      size: 24,
    }),
  );
  assertEquals(validateDockerAddressPools(tooMany), {
    ok: false,
    reason: "address_pools_too_many",
  });
});

test("isValidDefaultBridgeCidr wants a host address with prefix, not a network", () => {
  assertEquals(isValidDefaultBridgeCidr("172.17.0.1/16"), true);
  assertEquals(isValidDefaultBridgeCidr("  172.26.0.1/24 "), true);
  assertEquals(isValidDefaultBridgeCidr("172.17.0.0/16"), false);
  assertEquals(isValidDefaultBridgeCidr("172.17.0.1"), false);
  assertEquals(isValidDefaultBridgeCidr("10.0.0.1/31"), true);
  assertEquals(isValidDefaultBridgeCidr(17), false);
  assertEquals(isValidDefaultBridgeCidr("fd00::/64"), false);
  assertEquals(isValidDefaultBridgeCidr("fd00::1/64"), true);
});

test("parseOrganizationDockerNetworking drops invalid keys and omits empties", () => {
  assertEquals(parseOrganizationDockerNetworking(null), {});
  assertEquals(parseOrganizationDockerNetworking({}), {});
  assertEquals(parseOrganizationDockerNetworking({ addressPools: [] }), {});
  assertEquals(
    parseOrganizationDockerNetworking({
      addressPools: [{ base: "10.200.0.0/16", size: 24 }],
      defaultBridgeCidr: "172.17.0.1/16",
    }),
    {
      addressPools: [{ base: "10.200.0.0/16", size: 24 }],
      defaultBridgeCidr: "172.17.0.1/16",
    },
  );
  // One bad pool poisons the list (dockerd would reject the whole file), the
  // bip survives on its own.
  assertEquals(
    parseOrganizationDockerNetworking({
      addressPools: [{ base: "10.200.0.0/16", size: 12 }],
      defaultBridgeCidr: "172.17.0.1/16",
    }),
    { defaultBridgeCidr: "172.17.0.1/16" },
  );
  assertEquals(
    parseOrganizationDockerNetworking({ defaultBridgeCidr: "172.17.0.0/16" }),
    {},
  );
});

test("resolveOrganizationDockerNetworking is empty-is-absent and copies the pools", () => {
  assertEquals(resolveOrganizationDockerNetworking(undefined), {});
  assertEquals(resolveOrganizationDockerNetworking({}), {});
  assertEquals(
    resolveOrganizationDockerNetworking({ docker: { addressPools: [] } }),
    {},
  );
  const pools = [{ base: "10.200.0.0/16", size: 24 }];
  const resolved = resolveOrganizationDockerNetworking({
    docker: { addressPools: pools },
  });
  assertEquals(resolved, { addressPools: pools });
  assertEquals(resolved.addressPools === pools, false);
});

test("dockerHostCidrs adds the aligned default bridge network to the pool bases", () => {
  assertEquals(dockerHostCidrs(undefined), []);
  assertEquals(dockerHostCidrs({}), []);
  assertEquals(dockerDefaultBridgeNetworkCidr({}), null);
  assertEquals(
    dockerDefaultBridgeNetworkCidr({ defaultBridgeCidr: "172.26.0.1/16" }),
    "172.26.0.0/16",
  );
  assertEquals(
    dockerHostCidrs({
      addressPools: [{ base: "10.200.0.0/16", size: 24 }],
      defaultBridgeCidr: "172.26.0.1/16",
    }),
    ["10.200.0.0/16", "172.26.0.0/16"],
  );
  assertEquals(
    dockerHostCidrs({ defaultBridgeCidr: "fd00:dead::1/64" }),
    ["fd00:dead::/64"],
  );
});

test("findDockerBridgePoolOverlap reports a bridge landing inside a submitted pool", () => {
  assertEquals(findDockerBridgePoolOverlap(null), null);
  assertEquals(
    findDockerBridgePoolOverlap({
      addressPools: [{ base: "10.200.0.0/16", size: 24 }],
    }),
    null,
  );
  assertEquals(
    findDockerBridgePoolOverlap({
      addressPools: [{ base: "10.200.0.0/16", size: 24 }],
      defaultBridgeCidr: "172.26.0.1/16",
    }),
    null,
  );
  assertEquals(
    findDockerBridgePoolOverlap({
      addressPools: [
        { base: "10.200.0.0/16", size: 24 },
        { base: "172.26.0.0/16", size: 24 },
      ],
      defaultBridgeCidr: "172.26.4.1/24",
    }),
    {
      bridgeCidr: "172.26.4.0/24",
      pool: { base: "172.26.0.0/16", size: 24 },
    },
  );
});

test("dockerAddressPoolCidrs returns just the bases", () => {
  assertEquals(dockerAddressPoolCidrs(undefined), []);
  assertEquals(
    dockerAddressPoolCidrs({
      addressPools: [
        { base: "10.200.0.0/16", size: 24 },
        { base: "10.201.0.0/16", size: 24 },
      ],
    }),
    ["10.200.0.0/16", "10.201.0.0/16"],
  );
});
