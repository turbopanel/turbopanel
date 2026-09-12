import type { Context } from "hono";
import {
  addressInCidr,
  isValidIpAddress,
  parseIpVersion,
} from "../../lib/ip-address.ts";
import { parseJsonbObject } from "../shared.ts";
import { parseIpPinMetadata } from "../../lib/net/repin.ts";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const IP_ALLOCATIONS = new Set(["dedicated", "shared"]);
export const IP_SCOPES = new Set(["public", "datacenter"]);

export type IpScopeFks = {
  datacenterId?: string | null;
  networkId?: string | null;
  serverId?: string | null;
};

export type IpPatchFields = {
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  options?: Record<string, unknown> | null;
  datacenterId?: string | null;
  networkId?: string | null;
  serverId?: string | null;
  updatedAt: string;
};

export type ExistingIpScope = {
  scope: string;
  serverId: string | null;
  datacenterId: string | null;
  networkId: string | null;
  address: string;
};

export type IpRow = {
  id: string;
  organizationId: string;
  datacenterId: string | null;
  networkId: string | null;
  serverId: string | null;
  address: string;
  allocation: string;
  scope: string;
  description: string | null;
  metadata: unknown;
  options: unknown;
  createdAt: string;
  updatedAt: string;
};

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null &&
    "code" in err && (err as { code: string }).code === "23505";
}

export function isIpAddressUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("uniq_ip_org_address");
}

export function parseCreateIpAddress(
  c: Context,
  body: Record<string, unknown>,
): { address: string } | Response {
  const addressRaw = body.address;
  if (typeof addressRaw !== "string" || !isValidIpAddress(addressRaw)) {
    return c.json({ error: "Invalid request" }, 400);
  }
  const address = addressRaw.trim();
  if (parseIpVersion(address) === null) {
    return c.json({ error: "Invalid request" }, 400);
  }

  if (body.version !== undefined) {
    return c.json({ error: "Invalid request" }, 400);
  }

  return { address };
}

export function assertIpScopeFkRules(
  c: Context,
  scope: string,
  scopeFks: IpScopeFks,
): Response | null {
  const hasServer = scopeFks.serverId !== undefined &&
    scopeFks.serverId !== null;
  const hasNetwork = scopeFks.networkId !== undefined &&
    scopeFks.networkId !== null;
  const hasDatacenter = scopeFks.datacenterId !== undefined &&
    scopeFks.datacenterId !== null;

  if (scope === "datacenter") {
    // Site membership pin or free pool — both require datacenterId.
    if (!hasDatacenter) {
      return c.json({ error: "Invalid request" }, 400);
    }
    // Free pool: datacenterId only. Membership pin: serverId requires networkId.
    if (!hasServer && hasNetwork) {
      return c.json({ error: "Invalid request" }, 400);
    }
    if (hasServer && !hasNetwork) {
      return c.json({ error: "Invalid request" }, 400);
    }
    return null;
  }

  if (hasDatacenter && (hasNetwork || hasServer)) {
    return c.json({ error: "Invalid request" }, 400);
  }

  return null;
}

export type SiteNetworkForMembership = {
  kind: string;
  datacenterId: string | null;
  cidr: string | null;
};

/**
 * A membership pin's `networkId` must be a `kind='datacenter'` subnet of the
 * same `datacenterId`, and `address` must fall inside that CIDR.
 */
export function assertDatacenterMembershipNetwork(
  c: Context,
  address: string,
  datacenterId: string,
  siteNetwork: SiteNetworkForMembership | null,
): Response | null {
  if (
    siteNetwork?.kind !== "datacenter" ||
    siteNetwork.datacenterId !== datacenterId
  ) {
    return c.json({ error: "Invalid request" }, 400);
  }
  if (!siteNetwork.cidr || !addressInCidr(address, siteNetwork.cidr)) {
    return c.json({ error: "address_not_in_any_subnet" }, 400);
  }
  return null;
}

/**
 * `stale` / `staleSince` / `staleReason` are derived from the
 * `ip.metadata.stale` marker the automatic repin pass writes when a
 * membership pin's address stopped being reported and no unambiguous
 * replacement existed (`src/lib/net/repin.ts`).
 */
export function serializeIpRow(row: IpRow) {
  const stale = parseIpPinMetadata(row.metadata).stale;
  return {
    ...row,
    version: parseIpVersion(row.address),
    stale: stale !== undefined,
    staleSince: stale?.since ?? null,
    staleReason: stale?.reason ?? null,
  };
}

export function parseCreateIpEnums(
  c: Context,
  body: Record<string, unknown>,
): { allocation: string; scope: string } | Response {
  const allocation = body.allocation;
  if (typeof allocation !== "string" || !IP_ALLOCATIONS.has(allocation)) {
    return c.json({ error: "Invalid request" }, 400);
  }

  const scope = body.scope;
  if (typeof scope !== "string" || !IP_SCOPES.has(scope)) {
    return c.json({ error: "Invalid request" }, 400);
  }

  return { allocation, scope };
}

export function rejectImmutableIpPatchFields(
  c: Context,
  body: Record<string, unknown>,
): Response | null {
  const immutable = [
    "address",
    "version",
    "allocation",
    "scope",
    "displayName",
    "name",
  ] as const;
  if (immutable.some((key) => body[key] !== undefined)) {
    return c.json({ error: "Invalid request" }, 400);
  }
  return null;
}

/** Final FK values = existing row plus incoming patch (undefined keeps prior). */
export function mergeIpScopeFks(
  existing: ExistingIpScope,
  scopeFks: IpScopeFks,
): IpScopeFks {
  return {
    serverId: scopeFks.serverId !== undefined
      ? scopeFks.serverId
      : existing.serverId,
    datacenterId: scopeFks.datacenterId !== undefined
      ? scopeFks.datacenterId
      : existing.datacenterId,
    networkId: scopeFks.networkId !== undefined
      ? scopeFks.networkId
      : existing.networkId,
  };
}

export function parseEnumQueryFilter(
  c: Context,
  queryKey: "scope" | "allocation",
  allowed: Set<string>,
): string | undefined | Response {
  const raw = c.req.query(queryKey)?.trim();
  if (!raw) return undefined;
  if (!allowed.has(raw)) return c.json({ error: "Invalid request" }, 400);
  return raw;
}

export type ScopeFkUuidParse =
  | { ok: true; value: string | null | undefined }
  | { ok: false };

export function parseScopeFkUuid(value: unknown): ScopeFkUuidParse {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    return { ok: false };
  }
  return { ok: true, value };
}

export function applyJsonbPatchFields(
  c: Context,
  body: Record<string, unknown>,
  patchFields: IpPatchFields,
): Response | null {
  for (const key of ["metadata", "options"] as const) {
    const result = parseJsonbObject(c, body, key);
    if (result instanceof Response) return result;
    if (result !== null) patchFields[key] = result;
  }
  return null;
}
