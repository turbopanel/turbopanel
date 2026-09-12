/**
 * Organization-wide Docker addressing, stored under
 * `organization.options.docker`.
 *
 * Two knobs, both mirrored from dockerd's `daemon.json`:
 *
 * - `addressPools` — Docker's `default-address-pools`: the ranges dockerd
 *   carves user-defined bridge networks out of when a compose file (or
 *   `docker network create`) names no `--subnet`. Each entry is a
 *   `{ base, size }` pair — `base` is the pool CIDR, `size` the prefix length
 *   of every network carved from it.
 * - `defaultBridgeCidr` — Docker's `bip`: the host address + prefix of the
 *   default `docker0` bridge (`172.17.0.1/16` style — a **host** address, not
 *   a network CIDR).
 *
 * These are **host configuration**, not a per-network registration: the
 * daemon pulls them over `GET /api/daemon/v1/host/docker-networking` and the
 * `docker` Ansible role merges them into `/etc/docker/daemon.json`. Applying a
 * change restarts dockerd; networks that already exist keep their ranges —
 * pools only affect networks created afterwards.
 *
 * The pool bases **and** the network the default bridge occupies are part of
 * the org CIDR registry (`net/cidr-collisions.ts`, via
 * {@link dockerHostCidrs}): a site subnet, a reserved range or a docker
 * registration may not overlap either, and the fabric allocators never carve
 * a relay `/16` or a `tpn_*` `/24` inside one.
 */

import {
  alignedNetworkCidr,
  cidrsOverlap,
  ipToBigInt,
  parseCidr,
  stripInetPrefixSuffix,
} from "./ip-address.ts";

export type DockerAddressPool = {
  /** Pool network CIDR (`10.200.0.0/16`). */
  base: string;
  /** Prefix length of every network carved out of `base` (`24`). */
  size: number;
};

export type OrganizationDockerNetworking = {
  /** dockerd `default-address-pools`. Omitted → Docker's built-in pools. */
  addressPools?: DockerAddressPool[];
  /** dockerd `bip` (`172.17.0.1/16`). Omitted → Docker's built-in bridge. */
  defaultBridgeCidr?: string;
};

/** Upper bound on `addressPools` entries — dockerd itself has no cap. */
export const DOCKER_ADDRESS_POOLS_MAX = 16;

/**
 * Largest carve size per family: at least two usable host addresses per
 * network (`/30` IPv4, `/126` IPv6) — a `/31` bridge cannot hold a gateway
 * and a container.
 */
const MAX_POOL_SIZE_V4 = 30;
const MAX_POOL_SIZE_V6 = 126;

export type DockerAddressingRejection =
  | "address_pools_invalid"
  | "address_pools_too_many"
  | "address_pool_base_invalid"
  | "address_pool_size_invalid"
  | "address_pools_overlap"
  | "default_bridge_cidr_invalid";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maxPoolSize(version: 4 | 6): number {
  return version === 4 ? MAX_POOL_SIZE_V4 : MAX_POOL_SIZE_V6;
}

/**
 * Strict per-entry validation shared by the stored-read and PUT paths.
 * Returns the normalized pool (aligned base) or the rejection reason.
 */
function validateAddressPool(
  value: unknown,
): { ok: true; pool: DockerAddressPool } | {
  ok: false;
  reason: DockerAddressingRejection;
} {
  if (!isRecord(value)) {
    return { ok: false, reason: "address_pool_base_invalid" };
  }
  if (typeof value.base !== "string") {
    return { ok: false, reason: "address_pool_base_invalid" };
  }
  const parsed = parseCidr(value.base);
  const base = alignedNetworkCidr(value.base);
  if (!parsed || !base) {
    return { ok: false, reason: "address_pool_base_invalid" };
  }
  const size = value.size;
  if (
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < parsed.prefix ||
    size > maxPoolSize(parsed.version)
  ) {
    return { ok: false, reason: "address_pool_size_invalid" };
  }
  return { ok: true, pool: { base, size } };
}

/**
 * Validate a `addressPools` list as a whole: shape, length cap, per-entry
 * base/size, and pairwise non-overlap (two pools sharing addresses would make
 * dockerd hand the same subnet to two networks).
 */
export function validateDockerAddressPools(
  value: unknown,
): { ok: true; pools: DockerAddressPool[] } | {
  ok: false;
  reason: DockerAddressingRejection;
  index?: number;
} {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "address_pools_invalid" };
  }
  if (value.length > DOCKER_ADDRESS_POOLS_MAX) {
    return { ok: false, reason: "address_pools_too_many" };
  }
  const pools: DockerAddressPool[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = validateAddressPool(value[index]);
    if (!entry.ok) return { ok: false, reason: entry.reason, index };
    for (const existing of pools) {
      if (cidrsOverlap(existing.base, entry.pool.base)) {
        return { ok: false, reason: "address_pools_overlap", index };
      }
    }
    pools.push(entry.pool);
  }
  return { ok: true, pools };
}

/**
 * dockerd `bip` is the bridge's own address with its prefix
 * (`172.17.0.1/16`), so the address must be a host inside the range — the
 * network address itself is not assignable to the bridge interface.
 */
export function isValidDefaultBridgeCidr(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const parsed = parseCidr(trimmed);
  if (!parsed) return false;
  const address = ipToBigInt(stripInetPrefixSuffix(trimmed));
  if (address === null) return false;
  // `/31` and `/32` (or the IPv6 equivalents) have no distinct network
  // address to exclude; everything wider must not name the network itself.
  const bitWidth = parsed.version === 4 ? 32 : 128;
  if (parsed.prefix >= bitWidth - 1) return true;
  return address !== parsed.base;
}

/**
 * Parse `organization.options.docker` as stored. Malformed keys are dropped
 * rather than rejected — this is a read path over jsonb, and one bad key must
 * not make the org's networking surface unreadable. Request bodies are
 * validated strictly by the PUT route ({@link validateDockerAddressPools} /
 * {@link isValidDefaultBridgeCidr}).
 */
export function parseOrganizationDockerNetworking(
  value: unknown,
): OrganizationDockerNetworking {
  if (!isRecord(value)) return {};
  const out: OrganizationDockerNetworking = {};
  const pools = validateDockerAddressPools(value.addressPools);
  if (pools.ok && pools.pools.length > 0) out.addressPools = pools.pools;
  if (isValidDefaultBridgeCidr(value.defaultBridgeCidr)) {
    out.defaultBridgeCidr = value.defaultBridgeCidr.trim();
  }
  return out;
}

/** Effective org Docker addressing: the stored object, or empty (absent). */
export function resolveOrganizationDockerNetworking(
  options: { docker?: OrganizationDockerNetworking } | null | undefined,
): OrganizationDockerNetworking {
  const docker = options?.docker;
  if (!docker) return {};
  const out: OrganizationDockerNetworking = {};
  if (docker.addressPools && docker.addressPools.length > 0) {
    out.addressPools = docker.addressPools.map((pool) => ({ ...pool }));
  }
  if (docker.defaultBridgeCidr) {
    out.defaultBridgeCidr = docker.defaultBridgeCidr;
  }
  return out;
}

/** Just the pool base CIDRs. */
export function dockerAddressPoolCidrs(
  cfg: OrganizationDockerNetworking | null | undefined,
): string[] {
  return (cfg?.addressPools ?? []).map((pool) => pool.base);
}

/**
 * The network CIDR `bip` puts docker0 on, or `null` when no bridge is
 * configured. `bip` names the bridge's *host* address (`172.17.0.1/16`); the
 * aligned network (`172.17.0.0/16`) is what the bridge actually occupies and
 * what every other range has to stay clear of.
 */
export function dockerDefaultBridgeNetworkCidr(
  cfg: OrganizationDockerNetworking | null | undefined,
): string | null {
  if (!cfg?.defaultBridgeCidr) return null;
  return alignedNetworkCidr(cfg.defaultBridgeCidr);
}

/**
 * Every CIDR the org's Docker host addressing claims on each enrolled host:
 * the pool bases plus the default bridge's network. This — not just the
 * pools — is what the collision authority registers and the fabric
 * allocators exclude, so a later reserved range, site subnet, docker
 * registration or fabric allocation can never land inside docker0.
 */
export function dockerHostCidrs(
  cfg: OrganizationDockerNetworking | null | undefined,
): string[] {
  const out = dockerAddressPoolCidrs(cfg);
  const bridge = dockerDefaultBridgeNetworkCidr(cfg);
  if (bridge) out.push(bridge);
  return out;
}

/**
 * The pool whose base overlaps the configured default bridge network, if
 * any. The `PUT` replaces both at once, so the collision authority (which
 * excludes the *stored* docker addressing) cannot see this pair — the route
 * checks it here before writing. `null` when they are disjoint or either is
 * absent.
 */
export function findDockerBridgePoolOverlap(
  cfg: OrganizationDockerNetworking | null | undefined,
): { bridgeCidr: string; pool: DockerAddressPool } | null {
  const bridgeCidr = dockerDefaultBridgeNetworkCidr(cfg);
  if (!bridgeCidr) return null;
  for (const pool of cfg?.addressPools ?? []) {
    if (cidrsOverlap(bridgeCidr, pool.base)) return { bridgeCidr, pool };
  }
  return null;
}
