import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import { createSessionMiddleware } from "../authn/middleware.ts";
import { createOrganizationForUser } from "../authn/install-state.ts";
import { assertOrgOwnerOr403 } from "../authz/index.ts";
import {
  canAccessOrganization,
  listAccessibleOrganizations,
} from "../org-context.ts";
import {
  assertCanManageOr403,
  parseJsonBody,
} from "../shared.ts";
import { type Db, getDb } from "../../db.ts";
import { organization } from "../../lib/db/schema.ts";
import {
  parseOrganizationOptions,
  resolveRandomizedPrincipalUsernames,
} from "../../lib/organization-options.ts";
import { loadOrgServerCapacity } from "../../lib/server-capacity.ts";
import { listTimezones } from "../../lib/timezones.ts";
import { assertCidrAvailable } from "../../lib/net/cidr-collisions.ts";
import { alignedNetworkCidr } from "../../lib/ip-address.ts";
import { findDockerBridgePoolOverlap } from "../../lib/docker-address-pools.ts";
import { cidrCollisionResponse } from "../networks/network-scope.ts";
import {
  applyManagedDefaultsPatch,
  defaultEnvironmentGetResponse,
  dockerNetworkingGetResponse,
  dockerNetworkingPutResponse,
  defaultEnvironmentPutResponse,
  defaultTimezoneGetResponse,
  defaultTimezonePutResponse,
  hostDefaultsGetResponse,
  hostDefaultsPutResponse,
  managedDefaultsGetResponse,
  managedDefaultsPutResponse,
  parseDefaultEnvironmentPutBody,
  parseDefaultTimezonePatch,
  parseDockerNetworkingPatch,
  parseHostDefaultsPatch,
  parseManagedDefaultsPatch,
  parseOrganizationCreateDisplayName,
  parseOrganizationPatchDisplayName,
  parseServerCapacityPutBody,
  parseTemperatureUnitPatch,
  temperatureUnitGetResponse,
  temperatureUnitPutResponse,
  toOrganizationRecord,
  validateManagedDefaults,
} from "./routes-helpers.ts";
import { registerOrganizationFabricRoutes } from "./fabric-routes.ts";

async function loadOrganizationRecord(db: Db, id: string) {
  const [orgRow] = await db
    .select({
      id: organization.id,
      name: organization.name,
      createdAt: organization.createdAt,
    })
    .from(organization)
    .where(eq(organization.id, id))
    .limit(1);
  return orgRow ?? null;
}

export function registerOrganizationRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError("session secrets are required for organization routes");
  }
  const secrets = opts.secrets;

  router.use("/organizations", createSessionMiddleware(secrets));
  router.use("/organizations/:id", createSessionMiddleware(secrets));
  router.use(
    "/organizations/:id/default-timezone",
    createSessionMiddleware(secrets),
  );
  router.use(
    "/organizations/:id/temperature-unit",
    createSessionMiddleware(secrets),
  );
  router.use(
    "/organizations/:id/host-defaults",
    createSessionMiddleware(secrets),
  );
  router.use(
    "/organizations/:id/default-environment",
    createSessionMiddleware(secrets),
  );
  router.use(
    "/organizations/:id/server-capacity",
    createSessionMiddleware(secrets),
  );
  router.use(
    "/organizations/:id/managed-defaults",
    createSessionMiddleware(secrets),
  );
  router.use(
    "/organizations/:id/principal-defaults",
    createSessionMiddleware(secrets),
  );
  router.use(
    "/organizations/:id/docker-networking",
    createSessionMiddleware(secrets),
  );
  router.use("/timezones", createSessionMiddleware(secrets));
  registerOrganizationFabricRoutes(router, opts);

  router.get("/organizations", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const organizations = await listAccessibleOrganizations(db, session.userId);
    return c.json({ organizations });
  });

  router.post("/organizations", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsedDisplayName = parseOrganizationCreateDisplayName(body);
    if (!parsedDisplayName.ok) {
      return c.json(
        { error: parsedDisplayName.error },
        parsedDisplayName.status,
      );
    }

    const { organizationId } = await createOrganizationForUser(
      db,
      session.userId,
      parsedDisplayName.name,
    );

    return c.json({ ok: true as const, id: organizationId });
  });

  router.get("/organizations/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    const allowed = await canAccessOrganization(db, session.userId, id);
    if (!allowed) return c.json({ error: "Not found" }, 404);

    const orgRow = await loadOrganizationRecord(db, id);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    return c.json({ organization: toOrganizationRecord(orgRow) });
  });

  router.patch("/organizations/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsed = parseOrganizationPatchDisplayName(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }

    const orgRow = await loadOrganizationRecord(db, id);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    await db.update(organization).set({
      name: parsed.name,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    const updated = await loadOrganizationRecord(db, id);
    if (!updated) return c.json({ error: "Not found" }, 404);

    return c.json({
      ok: true as const,
      organization: toOrganizationRecord(updated),
    });
  });

  router.get("/organizations/:id/default-timezone", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    const options = parseOrganizationOptions(orgRow.options);
    return c.json(defaultTimezoneGetResponse(options));
  });

  router.put("/organizations/:id/default-timezone", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsedPatch = parseDefaultTimezonePatch(body);
    if (!parsedPatch.ok) {
      return c.json({ error: parsedPatch.error }, parsedPatch.status);
    }
    const patch = parsedPatch.patch;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify(patch)
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    const [updated] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    const options = parseOrganizationOptions(updated?.options);

    return c.json(defaultTimezonePutResponse(options));
  });

  router.get("/organizations/:id/temperature-unit", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    const options = parseOrganizationOptions(orgRow.options);
    return c.json(temperatureUnitGetResponse(options));
  });

  router.put("/organizations/:id/temperature-unit", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsedPatch = parseTemperatureUnitPatch(body);
    if (!parsedPatch.ok) {
      return c.json({ error: parsedPatch.error }, parsedPatch.status);
    }
    const patch = parsedPatch.patch;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify(patch)
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    const [updated] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    const options = parseOrganizationOptions(updated?.options);

    return c.json(temperatureUnitPutResponse(options));
  });

  router.get("/organizations/:id/host-defaults", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    const options = parseOrganizationOptions(orgRow.options);
    return c.json(hostDefaultsGetResponse(options));
  });

  router.put("/organizations/:id/host-defaults", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsedPatch = parseHostDefaultsPatch(body);
    if (!parsedPatch.ok) {
      return c.json({ error: parsedPatch.error }, parsedPatch.status);
    }
    const patch = parsedPatch.patch;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify(patch)
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    const [updated] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    const options = parseOrganizationOptions(updated?.options);

    return c.json(hostDefaultsPutResponse(options));
  });

  router.get("/organizations/:id/default-environment", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    const options = parseOrganizationOptions(orgRow.options);
    return c.json(defaultEnvironmentGetResponse(options));
  });

  router.put("/organizations/:id/default-environment", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsed = parseDefaultEnvironmentPutBody(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify({
          defaultEnvironmentName: parsed.defaultEnvironmentName,
        })
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    const [updated] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    const options = parseOrganizationOptions(updated?.options);

    return c.json(defaultEnvironmentPutResponse(options));
  });

  router.get("/organizations/:id/server-capacity", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const capacity = await loadOrgServerCapacity(db, id);
    if (!capacity) return c.json({ error: "Not found" }, 404);

    return c.json(capacity);
  });

  router.put("/organizations/:id/server-capacity", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertOrgOwnerOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsed = parseServerCapacityPutBody(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify({ maxServers: parsed.maxServers })
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    const capacity = await loadOrgServerCapacity(db, id);
    if (!capacity) return c.json({ error: "Not found" }, 404);

    return c.json({ ok: true as const, ...capacity });
  });

  router.get("/organizations/:id/managed-defaults", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    const options = parseOrganizationOptions(orgRow.options);
    return c.json(managedDefaultsGetResponse(options.managedDatabase ?? {}));
  });

  router.put("/organizations/:id/managed-defaults", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsedPatch = parseManagedDefaultsPatch(body);
    if (!parsedPatch.ok) {
      return c.json({ error: parsedPatch.error }, parsedPatch.status);
    }

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    // Nested object: merge in app code, then write the whole `managedDatabase`
    // value — jsonb `||` is shallow and would drop sibling keys.
    const next = applyManagedDefaultsPatch(
      parseOrganizationOptions(orgRow.options).managedDatabase ?? {},
      parsedPatch.patch,
    );

    // Collisions only exist post-merge: one family's override can land on the
    // other family's still-inherited default.
    const invalid = validateManagedDefaults(next);
    if (invalid) return c.json({ error: invalid.error }, invalid.status);

    await db.update(organization).set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify({ managedDatabase: next })
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    return c.json(managedDefaultsPutResponse(next));
  });

  router.get("/organizations/:id/principal-defaults", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    const options = parseOrganizationOptions(orgRow.options);
    return c.json({
      randomizedUsernames: options.randomizedPrincipalUsernames ?? null,
      effectiveRandomizedUsernames: resolveRandomizedPrincipalUsernames(
        options,
      ),
    });
  });

  router.put("/organizations/:id/principal-defaults", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    // `null` clears the override back to the platform default (on); only
    // affects principals created after the change — nothing is renamed.
    const value = (body as Record<string, unknown>).randomizedUsernames;
    if (value !== null && typeof value !== "boolean") {
      return c.json({ error: "Invalid request" }, 400);
    }

    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    const patch = value === null
      ? sql`COALESCE(${organization.options}, '{}'::jsonb) - 'randomizedPrincipalUsernames'`
      : sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify({ randomizedPrincipalUsernames: value })
      }::jsonb`;
    await db.update(organization).set({
      options: patch,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    return c.json({
      ok: true as const,
      randomizedUsernames: value,
      effectiveRandomizedUsernames: value ?? true,
    });
  });

  router.get("/organizations/:id/docker-networking", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    const options = parseOrganizationOptions(orgRow.options);
    return c.json(dockerNetworkingGetResponse(options.docker ?? {}));
  });

  router.put("/organizations/:id/docker-networking", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const id = c.req.param("id");
    const denied = await assertCanManageOr403(c, "organization", id);
    if (denied) return denied;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const parsed = parseDockerNetworkingPatch(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (!orgRow) return c.json({ error: "Not found" }, 404);

    // The body is replace-all, so the submitted bridge and the submitted
    // pools are checked against each other here — the authority below
    // excludes the *stored* docker addressing and would never see this pair.
    const next = parsed.value;
    const bridgeVsPool = findDockerBridgePoolOverlap(next);
    if (bridgeVsPool) {
      return cidrCollisionResponse(c, {
        code: "cidr_overlaps_docker_network",
        cidr: bridgeVsPool.bridgeCidr,
        conflictingCidr: bridgeVsPool.pool.base,
        networkId: null,
        datacenterId: null,
      });
    }

    // Every pool base goes through the one CIDR collision authority: dockerd
    // will carve bridge networks out of it on every host, so it must not
    // overlap the fabric, a reserved hole, a site subnet or a registered
    // docker network. The stored pools and bridge are excluded — this PUT
    // replaces them, and the body's own entries were already checked against
    // each other.
    for (const pool of next?.addressPools ?? []) {
      const collision = await assertCidrAvailable(db, {
        organizationId: id,
        cidr: pool.base,
        intent: "docker",
        excludeDockerHostCidrs: true,
      });
      if (collision) return cidrCollisionResponse(c, collision);
    }

    // `bip` is the docker0 bridge's own address + prefix on every host; the
    // network it names is a docker network like any other and must clear the
    // same authority (reserved holes, site subnets, the fabric host range
    // and container pool, registered docker rows). Once stored it joins the
    // registry through `dockerHostCidrs`, so later writes stay clear of it.
    // The stored pools and bridge are excluded for the same reason as above.
    if (next?.defaultBridgeCidr) {
      // Already syntactically valid (`parseDockerNetworkingPatch`), so the
      // aligned network form always resolves.
      const collision = await assertCidrAvailable(db, {
        organizationId: id,
        cidr: alignedNetworkCidr(next.defaultBridgeCidr) ??
          next.defaultBridgeCidr,
        intent: "docker",
        excludeDockerHostCidrs: true,
      });
      if (collision) return cidrCollisionResponse(c, collision);
    }

    // Top-level jsonb merge replaces the whole `docker` object, which is the
    // correct replace-all semantics for a list; an all-cleared body removes
    // the key.
    const patch = next === null
      ? sql`COALESCE(${organization.options}, '{}'::jsonb) - 'docker'`
      : sql`COALESCE(${organization.options}, '{}'::jsonb) || ${
        JSON.stringify({ docker: next })
      }::jsonb`;
    await db.update(organization).set({
      options: patch,
      updatedAt: new Date().toISOString(),
    }).where(eq(organization.id, id));

    return c.json(dockerNetworkingPutResponse(next ?? {}));
  });

  router.get("/timezones", (c) => {
    return c.json({ timezones: listTimezones() });
  });
}
