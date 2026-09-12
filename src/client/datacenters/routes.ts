import { and, count, eq, inArray, isNotNull } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import { createSessionMiddleware } from "../authn/middleware.ts";
import { assertCanOr403, listVisible } from "../authz/index.ts";
import { resolveEntityOrganizationId } from "../authz/create-access-grant.ts";
import { type Db, getDb } from "../../db.ts";
import { datacenter, ip, network, server } from "../../lib/db/schema.ts";
import {
  type DatacenterPolicy,
  parseDatacenterOptions,
  resolveDatacenterPolicy,
} from "../../lib/datacenter-options.ts";
import { getCommandQueue } from "../../lib/commands/queue.ts";
import { isNoopCommandQueue } from "../../lib/commands/noop-command-queue.ts";
import { compatLogWarn } from "../../log-compat.ts";
import { fanOutDatacenterRoutingChange } from "./routing-fanout.ts";
import { suggestDatacenterNames } from "../../lib/datacenter-name-suggestions.ts";
import { alignedNetworkCidr, isValidCidr } from "../../lib/ip-address.ts";
import {
  assertCidrAvailable,
  assertCidrsAvailable,
} from "../../lib/net/cidr-collisions.ts";
import {
  loadDatacenterCidrs,
  loadDatacenterSubnets,
} from "../../lib/net/datacenter-networks.ts";
import {
  countUnassignedServersAmong,
  loadDatacenterMembershipsForDatacenter,
  type MemberPinSubnet,
  validateMemberPinAddress,
} from "../../lib/net/datacenter-membership.ts";
import { isIpAddressUniqueViolation } from "../ips/ip-create-validation.ts";
import { parseIpPinMetadata } from "../../lib/net/repin.ts";
import { cidrCollisionResponse } from "../networks/network-scope.ts";
import {
  assertCanCreateOr403,
  assertCanManageOr403,
  assertCanReadOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseDescription,
  parseName,
  parseJsonbObject,
  parseJsonBody,
} from "../shared.ts";
import {
  attachEffectivePolicy,
  attachPrivateCidrs,
  type CreateDatacenterInput,
  groupMembersByDerivedCidr,
  type ParsedMemberPin,
  parseMemberPins,
  parseNameSuggestionsQuery,
  parseOptionalUuid,
  resolveOrCreateSubnetForAddress,
  resolveSeededFields,
  type SelectedServerRow,
} from "./create-input.ts";

export {
  attachEffectivePolicy,
  attachPrivateCidrs,
  groupMembersByDerivedCidr,
  mergeDatacenterMetadata,
  parseMemberPins,
  parseNameSuggestionsQuery,
  parseOptionalUuid,
  parseRequiredCidr,
  resolveOrCreateSubnetForAddress,
  resolveSeededFields,
} from "./create-input.ts";

function datacenterPolicyChanged(
  before: DatacenterPolicy,
  after: DatacenterPolicy,
): boolean {
  return before.priority !== after.priority ||
    before.trusted !== after.trusted;
}

type DatacenterPatchFields = {
  name?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  options?: ReturnType<typeof parseDatacenterOptions> | null;
  updatedAt: string;
};

/**
 * Validate a PATCH /datacenters/:id body into the UPDATE column set, or
 * return the 400 response describing the first invalid field.
 */
function parseDatacenterPatchFields(
  c: Context,
  body: Record<string, unknown>,
): DatacenterPatchFields | Response {
  let patchFields: DatacenterPatchFields;
  try {
    patchFields = buildPatchUpdateFields(body);
  } catch {
    return c.json({ error: "Invalid request" }, 400);
  }

  const metadataResult = parseJsonbObject(c, body, "metadata");
  if (metadataResult instanceof Response) return metadataResult;
  if (metadataResult !== null) patchFields.metadata = metadataResult;

  // `options` is replace-all: `null` clears the stored blob so GET falls back
  // to the documented defaults (`priority` 100, `trusted` true, ...).
  if (body.options === null) {
    patchFields.options = null;
    return patchFields;
  }
  const optionsResult = parseJsonbObject(c, body, "options");
  if (optionsResult instanceof Response) return optionsResult;
  if (optionsResult !== null) {
    patchFields.options = parseDatacenterOptions(optionsResult);
  }
  return patchFields;
}

/**
 * Re-converge everything that read the datacenter's routing policy after
 * `priority` / `trusted` changed — see `fanOutDatacenterRoutingChange`
 * (`routing-fanout.ts`) for what is recomputed. The same core is reused by
 * the automatic-repin sweep.
 *
 * Skipped with a warning when the queue or secrets are absent from the
 * context (unit-test app, Workers isolate without secrets). Failures are
 * logged, never surfaced — the policy save already succeeded.
 */
async function fanOutDatacenterPolicyChange(
  c: Context<AppEnv>,
  db: Db,
  params: Readonly<{
    datacenterId: string;
    organizationId: string;
    actorId: string;
  }>,
): Promise<void> {
  const commandQueue = getCommandQueue(c);
  const secretsConfig = c.get("secretsConfig");
  const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
  if (
    !commandQueue ||
    isNoopCommandQueue(commandQueue) ||
    !secretsConfig ||
    !dataEncryptionSecrets
  ) {
    compatLogWarn(
      "datacenters",
      `skipping routing-policy fan-out for datacenter ${params.datacenterId}: command queue or secrets unavailable`,
    );
    return;
  }

  try {
    await fanOutDatacenterRoutingChange(db, commandQueue, {
      datacenterId: params.datacenterId,
      organizationId: params.organizationId,
      actorType: "user",
      actorId: params.actorId,
      secretsConfig,
      dataEncryptionSecrets,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    compatLogWarn(
      "datacenters",
      `routing-policy fan-out failed for datacenter ${params.datacenterId}: ${message}`,
    );
  }
}

function parseCreateDatacenterInput(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): CreateDatacenterInput | Response {
  let name: string | null;
  let description: string | null;
  try {
    name = parseName(body);
    description = parseDescription(body);
  } catch {
    return c.json({ error: "Invalid request" }, 400);
  }

  const members = parseMemberPins(body.members);
  const sourceServerId = parseOptionalUuid(body.sourceServerId);
  if (!members.ok || !sourceServerId.ok) {
    return c.json({ error: "Invalid request" }, 400);
  }

  const metadata = parseJsonbObject(c, body, "metadata");
  if (metadata instanceof Response) return metadata;
  const rawOptions = parseJsonbObject(c, body, "options");
  if (rawOptions instanceof Response) return rawOptions;

  return {
    name,
    description,
    metadata,
    options: rawOptions === null ? null : parseDatacenterOptions(rawOptions),
    members: members.value,
    sourceServerId: sourceServerId.value,
  };
}

type MemberServersResult =
  | { ok: true; rows: SelectedServerRow[] }
  | { ok: false; status: 404 }
  | {
    ok: false;
    status: 400;
    error:
      | "invalid_address"
      | "invalid_cidr"
      | "address_not_in_cidr"
      | "address_not_reported"
      | "address_cidr_unreported"
      | "address_not_in_any_subnet";
    serverId?: string;
  };

async function loadVisibleMemberServerRows(
  db: Db,
  userId: string,
  organizationId: string,
  members: ParsedMemberPin[],
): Promise<
  | { ok: true; rows: SelectedServerRow[] }
  | { ok: false; status: 404 }
> {
  const uniqueServerIds = [...new Set(members.map((m) => m.serverId))];
  const visibleIds = await listVisible(db, {
    kind: "server",
    userId,
    organizationId,
  });
  if (uniqueServerIds.some((id) => !visibleIds.includes(id))) {
    return { ok: false, status: 404 };
  }

  const rows = await db
    .select({
      id: server.id,
      metadata: server.metadata,
    })
    .from(server)
    .where(
      and(
        inArray(server.id, uniqueServerIds),
        eq(server.organizationId, organizationId),
      ),
    );
  if (rows.length !== uniqueServerIds.length) {
    return { ok: false, status: 404 };
  }
  return { ok: true, rows };
}

function validateLoadedMemberPins(
  members: ParsedMemberPin[],
  rows: SelectedServerRow[],
  cidr: string,
): MemberServersResult {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const member of members) {
    const row = byId.get(member.serverId);
    if (!row) return { ok: false, status: 404 };
    const validated = validateMemberPinAddress(
      member.address,
      cidr,
      row.metadata,
    );
    if (!validated.ok) {
      return {
        ok: false,
        status: 400,
        error: validated.error,
        serverId: member.serverId,
      };
    }
  }
  return { ok: true, rows };
}

type ResolvedAddMember =
  | { member: ParsedMemberPin; networkId: string }
  | { member: ParsedMemberPin; cidr: string };

function resolveAddMemberPins(
  members: ParsedMemberPin[],
  rows: SelectedServerRow[],
  subnets: readonly MemberPinSubnet[],
):
  | { ok: true; pins: ResolvedAddMember[] }
  | Exclude<MemberServersResult, { ok: true }> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const working: MemberPinSubnet[] = [...subnets];
  const pins: ResolvedAddMember[] = [];
  for (const member of members) {
    const row = byId.get(member.serverId);
    if (!row) return { ok: false, status: 404 };
    const outcome = resolveOrCreateSubnetForAddress(
      member.address,
      row.metadata,
      working,
    );
    if (!outcome.ok) {
      return {
        ok: false,
        status: 400,
        error: "address_cidr_unreported",
        serverId: member.serverId,
      };
    }
    if (outcome.created) {
      const validated = validateMemberPinAddress(
        member.address,
        outcome.cidr,
        row.metadata,
      );
      if (!validated.ok) {
        return {
          ok: false,
          status: 400,
          error: validated.error,
          serverId: member.serverId,
        };
      }
      working.push({ networkId: "", cidr: outcome.cidr });
      pins.push({ member, cidr: outcome.cidr });
      continue;
    }
    const existing = working.filter((subnet) => subnet.networkId.length > 0);
    const validated = validateMemberPinAddress(
      member.address,
      existing,
      row.metadata,
    );
    if (!validated.ok) {
      return {
        ok: false,
        status: 400,
        error: validated.error,
        serverId: member.serverId,
      };
    }
    pins.push({ member, networkId: validated.networkId });
  }
  return { ok: true, pins };
}

function memberValidationResponse(
  c: Context<AppEnv>,
  result: Exclude<MemberServersResult, { ok: true }>,
): Response {
  if (result.status === 404) return c.json({ error: "Not found" }, 404);
  return c.json(
    {
      error: result.error,
      ...(result.serverId ? { serverId: result.serverId } : {}),
    },
    400,
  );
}

type DatacenterSubnetView = {
  id: string;
  cidr: string;
  version: 4 | 6;
  name: string | null;
  description: null;
  memberCount: number;
};

async function loadDatacenterSubnetViews(
  db: Db,
  datacenterId: string,
): Promise<DatacenterSubnetView[]> {
  const byDc = await loadDatacenterSubnets(db, [datacenterId]);
  const subnets = byDc.get(datacenterId) ?? [];
  if (subnets.length === 0) return [];

  const countRows = await db
    .select({
      networkId: ip.networkId,
      memberCount: count(),
    })
    .from(ip)
    .where(
      and(
        eq(ip.scope, "datacenter"),
        eq(ip.datacenterId, datacenterId),
        isNotNull(ip.serverId),
      ),
    )
    .groupBy(ip.networkId);

  const counts = new Map<string, number>();
  for (const row of countRows) {
    if (!row.networkId) continue;
    counts.set(row.networkId, Number(row.memberCount));
  }

  return subnets
    .map((subnet) => ({
      id: subnet.networkId,
      cidr: subnet.cidr,
      version: subnet.version,
      name: subnet.name,
      description: null,
      memberCount: counts.get(subnet.networkId) ?? 0,
    }))
    .sort((a, b) => a.cidr.localeCompare(b.cidr));
}

function isFreshAddMemberPin(
  pin: ResolvedAddMember,
): pin is { member: ParsedMemberPin; cidr: string } {
  return "cidr" in pin;
}

async function loadSiteNetworkRow(
  db: Db,
  organizationId: string,
  datacenterId: string,
  networkId: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: network.id })
    .from(network)
    .where(
      and(
        eq(network.id, networkId),
        eq(network.datacenterId, datacenterId),
        eq(network.organizationId, organizationId),
        eq(network.kind, "datacenter"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function registerDatacenterRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError("session secrets are required for datacenter routes");
  }
  const secrets = opts.secrets;

  router.use("/datacenters", createSessionMiddleware(secrets));
  router.use("/datacenters/:id", createSessionMiddleware(secrets));
  router.use("/datacenters/:id/members", createSessionMiddleware(secrets));
  router.use(
    "/datacenters/:id/members/:serverId",
    createSessionMiddleware(secrets),
  );
  router.use("/datacenters/:id/subnets", createSessionMiddleware(secrets));
  router.use(
    "/datacenters/:id/subnets/:networkId",
    createSessionMiddleware(secrets),
  );

  router.get("/datacenters", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const manageDenied = await assertCanManageOr403(
      c,
      "organization",
      organizationId,
    );
    if (manageDenied) return manageDenied;

    const visibleIds = await listVisible(db, {
      kind: "datacenter",
      userId: session.userId,
      organizationId,
    });

    if (visibleIds.length === 0) {
      return c.json({ datacenters: [] });
    }

    const rows = await db
      .select({
        id: datacenter.id,
        name: datacenter.name,
        description: datacenter.description,
        organizationId: datacenter.organizationId,
        metadata: datacenter.metadata,
        options: datacenter.options,
        createdAt: datacenter.createdAt,
        updatedAt: datacenter.updatedAt,
      })
      .from(datacenter)
      .where(
        and(
          inArray(datacenter.id, visibleIds),
          eq(datacenter.organizationId, organizationId),
        ),
      )
      .orderBy(datacenter.createdAt);

    const cidrsByDc = await loadDatacenterCidrs(
      db,
      rows.map((row) => row.id),
    );

    return c.json({
      datacenters: attachEffectivePolicy(attachPrivateCidrs(rows, cidrsByDc)),
    });
  });

  router.get("/datacenters/name-suggestions", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const manageDenied = await assertCanManageOr403(
      c,
      "organization",
      organizationId,
    );
    if (manageDenied) return manageDenied;

    const query = parseNameSuggestionsQuery(
      c.req.query("unassignedOnly"),
      c.req.query("limit"),
    );
    if (query === "invalid") {
      return c.json({ error: "Invalid request" }, 400);
    }
    const { unassignedOnly, limit } = query;

    const visibleIds = await listVisible(db, {
      kind: "server",
      userId: session.userId,
      organizationId,
    });
    if (visibleIds.length === 0) {
      return c.json({ suggestions: [] });
    }

    const rows = await db
      .select({
        id: server.id,
        name: server.name,
        metadata: server.metadata,
      })
      .from(server)
      .where(
        and(
          inArray(server.id, visibleIds),
          eq(server.organizationId, organizationId),
        ),
      );

    const { memberServerIds } = await countUnassignedServersAmong(
      db,
      rows.map((row) => row.id),
    );

    const suggestions = suggestDatacenterNames(
      rows.map((row) => {
        const meta =
          typeof row.metadata === "object" && row.metadata !== null &&
            !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : null;
        const hostname =
          typeof meta?.hostname === "string" && meta.hostname.trim()
            ? meta.hostname.trim()
            : null;
        return {
          id: row.id,
          name: row.name,
          hostname,
          // Name suggestions treat "unassigned" as zero memberships.
          hasMembership: memberServerIds.has(row.id),
          metadata: row.metadata,
        };
      }),
      { limit, unassignedOnly },
    );

    return c.json({ suggestions });
  });

  router.get("/datacenters/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const entityOrgId = await resolveEntityOrganizationId(db, "datacenter", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanReadOr403(c, "datacenter", id);
    if (denied) return denied;

    const [row] = await db
      .select({
        id: datacenter.id,
        name: datacenter.name,
        description: datacenter.description,
        organizationId: datacenter.organizationId,
        metadata: datacenter.metadata,
        options: datacenter.options,
        createdAt: datacenter.createdAt,
        updatedAt: datacenter.updatedAt,
      })
      .from(datacenter)
      .where(eq(datacenter.id, id))
      .limit(1);

    if (!row) return c.json({ error: "Not found" }, 404);

    const subnets = await loadDatacenterSubnetViews(db, row.id);
    const [withCidrs] = attachEffectivePolicy(attachPrivateCidrs(
      [row],
      new Map([[row.id, subnets.map((subnet) => subnet.cidr)]]),
    ));
    const members = await loadDatacenterMembershipsForDatacenter(db, row.id);

    return c.json({
      datacenter: { ...withCidrs, subnets },
      members: members.map((m) => ({
        serverId: m.serverId,
        address: m.address,
        ipId: m.ipId,
        networkId: m.networkId,
        stale: parseIpPinMetadata(m.metadata).stale !== undefined,
      })),
    });
  });

  router.post("/datacenters", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const denied = await assertCanCreateOr403(
      c,
      "organization",
      organizationId,
    );
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const input = parseCreateDatacenterInput(c, body);
    if (input instanceof Response) return input;

    const loaded = await loadVisibleMemberServerRows(
      db,
      session.userId,
      organizationId,
      input.members,
    );
    if (!loaded.ok) {
      return memberValidationResponse(c, loaded);
    }

    const grouped = groupMembersByDerivedCidr(input.members, loaded.rows);
    if (!grouped.ok) {
      return memberValidationResponse(c, grouped);
    }

    for (const group of grouped.groups) {
      const memberServers = validateLoadedMemberPins(
        group.members,
        loaded.rows,
        group.cidr,
      );
      if (!memberServers.ok) {
        return memberValidationResponse(c, memberServers);
      }
    }

    // Derived site subnets go through the one collision authority: against
    // each other, the fabric, reserved ranges, docker registrations and every
    // other site subnet in the organization. The datacenter does not exist yet,
    // so no gateway can be advertising for it — the org-wide `subnet_overlaps`
    // default applies to any site-subnet overlap.
    const collision = await assertCidrsAvailable(db, {
      organizationId,
      cidrs: grouped.groups.map((group) => group.cidr),
      intent: "datacenter",
    });
    if (collision) return cidrCollisionResponse(c, collision);

    const seeded = resolveSeededFields(input, loaded.rows);

    try {
      const id = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(datacenter)
          .values({
            organizationId,
            name: seeded.name,
            description: input.description,
            ...(seeded.metadata !== null ? { metadata: seeded.metadata } : {}),
            ...(input.options !== null ? { options: input.options } : {}),
          })
          .returning({ id: datacenter.id });

        for (const group of grouped.groups) {
          const [siteNetwork] = await tx
            .insert(network)
            .values({
              organizationId,
              datacenterId: inserted.id,
              kind: "datacenter",
              cidr: group.cidr,
              name: seeded.name,
            })
            .returning({ id: network.id });

          for (const member of group.members) {
            await tx.insert(ip).values({
              organizationId,
              datacenterId: inserted.id,
              networkId: siteNetwork.id,
              serverId: member.serverId,
              address: member.address,
              allocation: "dedicated",
              scope: "datacenter",
            });
          }
        }

        return inserted.id;
      });

      return c.json({ ok: true as const, id });
    } catch (err) {
      if (isIpAddressUniqueViolation(err)) {
        return c.json({ error: "address_in_use" }, 409);
      }
      throw err;
    }
  });

  router.post("/datacenters/:id/members", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const entityOrgId = await resolveEntityOrganizationId(db, "datacenter", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanOr403(
      c,
      "organization:manage",
      "datacenter",
      id,
    );
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const members = parseMemberPins(body.members ?? [body]);
    if (!members.ok) return c.json({ error: "Invalid request" }, 400);

    const loaded = await loadVisibleMemberServerRows(
      db,
      session.userId,
      organizationId,
      members.value,
    );
    if (!loaded.ok) {
      return memberValidationResponse(c, loaded);
    }

    const subnetsByDc = await loadDatacenterSubnets(db, [id]);
    const existing = (subnetsByDc.get(id) ?? []).map((subnet) => ({
      networkId: subnet.networkId,
      cidr: subnet.cidr,
    }));
    const resolved = resolveAddMemberPins(members.value, loaded.rows, existing);
    if (!resolved.ok) {
      return memberValidationResponse(c, resolved);
    }

    // Auto-derived subnets for fresh pins go through the collision authority
    // scoped to this datacenter, so a gateway in another datacenter already
    // advertising the range reports `cidr_overlaps_gateway_advertised`.
    const collision = await assertCidrsAvailable(db, {
      organizationId,
      cidrs: resolved.pins.filter(isFreshAddMemberPin).map((pin) => pin.cidr),
      intent: "datacenter",
      datacenterId: id,
    });
    if (collision) return cidrCollisionResponse(c, collision);

    try {
      await db.transaction(async (tx) => {
        const networkIdByCidr = new Map<string, string>();
        for (const pin of resolved.pins) {
          let networkId: string;
          if ("networkId" in pin) {
            networkId = pin.networkId;
          } else {
            const reused = networkIdByCidr.get(pin.cidr);
            if (reused) {
              networkId = reused;
            } else {
              const [created] = await tx
                .insert(network)
                .values({
                  organizationId,
                  datacenterId: id,
                  kind: "datacenter",
                  cidr: pin.cidr,
                })
                .returning({ id: network.id });
              networkId = created.id;
              networkIdByCidr.set(pin.cidr, networkId);
            }
          }
          await tx.insert(ip).values({
            organizationId,
            datacenterId: id,
            networkId,
            serverId: pin.member.serverId,
            address: pin.member.address,
            allocation: "dedicated",
            scope: "datacenter",
          });
        }
      });
      return c.json({ ok: true as const });
    } catch (err) {
      if (isIpAddressUniqueViolation(err)) {
        return c.json({ error: "address_in_use" }, 409);
      }
      throw err;
    }
  });

  router.delete("/datacenters/:id/members/:serverId", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const serverId = c.req.param("serverId");
    const entityOrgId = await resolveEntityOrganizationId(db, "datacenter", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanOr403(
      c,
      "organization:manage",
      "datacenter",
      id,
    );
    if (denied) return denied;

    const deleted = await db
      .delete(ip)
      .where(
        and(
          eq(ip.scope, "datacenter"),
          eq(ip.datacenterId, id),
          eq(ip.serverId, serverId),
        ),
      )
      .returning({ id: ip.id });

    if (deleted.length === 0) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json({ ok: true as const, removed: deleted.length });
  });

  router.post("/datacenters/:id/subnets", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const entityOrgId = await resolveEntityOrganizationId(db, "datacenter", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanOr403(
      c,
      "organization:manage",
      "datacenter",
      id,
    );
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    if (typeof body.cidr !== "string" || !isValidCidr(body.cidr.trim())) {
      return c.json({ error: "invalid_cidr" }, 400);
    }
    const cidr = alignedNetworkCidr(body.cidr.trim());
    if (!cidr) {
      return c.json({ error: "invalid_cidr" }, 400);
    }

    let name: string | null;
    try {
      name = parseName(body);
      parseDescription(body);
    } catch {
      return c.json({ error: "Invalid request" }, 400);
    }

    const collision = await assertCidrAvailable(db, {
      organizationId,
      cidr,
      intent: "datacenter",
      datacenterId: id,
    });
    if (collision) return cidrCollisionResponse(c, collision);

    const [inserted] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: id,
        kind: "datacenter",
        cidr,
        ...(name !== null ? { name } : {}),
      })
      .returning({ id: network.id });

    return c.json({ ok: true as const, id: inserted.id });
  });

  router.patch("/datacenters/:id/subnets/:networkId", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const networkId = c.req.param("networkId");
    const entityOrgId = await resolveEntityOrganizationId(db, "datacenter", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanOr403(
      c,
      "organization:manage",
      "datacenter",
      id,
    );
    if (denied) return denied;

    const site = await loadSiteNetworkRow(db, organizationId, id, networkId);
    if (!site) return c.json({ error: "Not found" }, 404);

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;
    if (body.cidr !== undefined) {
      return c.json({ error: "Invalid request" }, 400);
    }

    let name: string | null | undefined;
    try {
      if (body.name !== undefined) {
        name = parseName(body);
      }
      if (body.description !== undefined) {
        parseDescription(body);
      }
    } catch {
      return c.json({ error: "Invalid request" }, 400);
    }

    await db
      .update(network)
      .set({
        updatedAt: new Date().toISOString(),
        ...(name !== undefined ? { name } : {}),
      })
      .where(eq(network.id, networkId));

    return c.json({ ok: true as const });
  });

  router.delete("/datacenters/:id/subnets/:networkId", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const networkId = c.req.param("networkId");
    const entityOrgId = await resolveEntityOrganizationId(db, "datacenter", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanOr403(
      c,
      "organization:manage",
      "datacenter",
      id,
    );
    if (denied) return denied;

    const site = await loadSiteNetworkRow(db, organizationId, id, networkId);
    if (!site) return c.json({ error: "Not found" }, 404);

    const [pin] = await db
      .select({ id: ip.id })
      .from(ip)
      .where(eq(ip.networkId, networkId))
      .limit(1);
    if (pin) {
      return c.json({ error: "subnet_has_members" }, 409);
    }

    await db.delete(network).where(eq(network.id, networkId));
    return c.json({ ok: true as const });
  });

  router.patch("/datacenters/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const entityOrgId = await resolveEntityOrganizationId(db, "datacenter", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanOr403(
      c,
      "organization:manage",
      "datacenter",
      id,
    );
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const patchFields = parseDatacenterPatchFields(c, body);
    if (patchFields instanceof Response) return patchFields;

    const [current] = await db
      .select({ options: datacenter.options })
      .from(datacenter)
      .where(eq(datacenter.id, id))
      .limit(1);
    if (!current) return c.json({ error: "Not found" }, 404);
    const policyBefore = resolveDatacenterPolicy(current.options);

    await db.update(datacenter).set(patchFields).where(eq(datacenter.id, id));

    // A name/description edit stays a single UPDATE; only a `priority` /
    // `trusted` change re-converges stored transports and fabric payloads.
    // The fan-out runs after the UPDATE so recomputation reads the new policy.
    const policyAfter = "options" in patchFields
      ? resolveDatacenterPolicy(patchFields.options ?? null)
      : policyBefore;
    if (datacenterPolicyChanged(policyBefore, policyAfter)) {
      await fanOutDatacenterPolicyChange(c, db, {
        datacenterId: id,
        organizationId,
        actorId: session.userId,
      });
    }

    return c.json({ ok: true as const });
  });

  router.delete("/datacenters/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const orgResult = await getOrgId(c, session.userId);
    if (orgResult instanceof Response) return orgResult;
    const organizationId = orgResult;

    const id = c.req.param("id");
    const entityOrgId = await resolveEntityOrganizationId(db, "datacenter", id);
    if (entityOrgId !== organizationId) {
      return c.json({ error: "Not found" }, 404);
    }

    const denied = await assertCanOr403(
      c,
      "organization:manage",
      "datacenter",
      id,
    );
    if (denied) return denied;

    const members = await loadDatacenterMembershipsForDatacenter(db, id);
    if (members.length > 0) {
      return c.json({ error: "datacenter_has_members" }, 409);
    }

    const scopedNetworks = await db
      .select({ id: network.id, kind: network.kind })
      .from(network)
      .where(eq(network.datacenterId, id));
    if (scopedNetworks.some((row) => row.kind !== "datacenter")) {
      return c.json({ error: "datacenter_has_networks" }, 409);
    }

    await db.transaction(async (tx) => {
      // Deletes every site subnet (`kind='datacenter'`), not just one row.
      await tx
        .delete(network)
        .where(
          and(
            eq(network.datacenterId, id),
            eq(network.kind, "datacenter"),
          ),
        );
      await tx.delete(datacenter).where(eq(datacenter.id, id));
    });

    return c.json({ ok: true as const });
  });
}
