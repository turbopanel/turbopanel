import { assertEquals } from "@std/assert";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import { getDatabaseUrl } from "../../db-url.ts";
import { createDenoDb } from "../../db.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../authn/crypto.ts";
import { createSession } from "../authn/session-store.ts";
import { deriveSecretsConfig, parseSecretsEnv } from "../authn/secrets.ts";
import { fabric, grant, network, organization, user } from "../../lib/db/schema.ts";
import { registerOrganizationRoutes } from "./routes.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../../test-fixtures/secrets.ts";

const dbUrl = getDatabaseUrl();

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function createOrgRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerOrganizationRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return { app, secrets };
}

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {});
  const signed = await buildSignedCookie(token, secrets);
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
}

async function withOrgFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>;
    app: Hono<AppEnv>;
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>;
    userId: string;
    organizationId: string;
  }) => Promise<void>,
  opts?: { withManageGrant?: boolean },
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping organization route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const withManageGrant = opts?.withManageGrant !== false;
  const db = createDenoDb();
  const { app, secrets } = await createOrgRoutesTestApp(db);

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: "Org Route Test Org" })
    .returning({ id: organization.id });
  const organizationId = insertedOrg!.id;

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `org-route-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: "user",
    })
    .returning({ id: user.id });
  const userId = insertedUser!.id;

  if (withManageGrant) {
    await db.insert(grant).values({
      entityType: "organization",
      entityId: organizationId,
      actorType: "user",
      actorId: userId,
      permission: "organization:manage",
    });
  }

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
    });
  } finally {
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ));
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
}

test("GET /organizations/:id/default-environment returns null before write", async () => {
  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(
        `/organizations/${organizationId}/default-environment`,
        { headers: { Cookie: cookie } },
      );
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { defaultEnvironmentName: null });
    },
  );
});

test("PUT /organizations/:id/default-environment stores and GET echoes", async () => {
  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const putRes = await app.request(
        `/organizations/${organizationId}/default-environment`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ defaultEnvironmentName: "Staging" }),
        },
      );
      assertEquals(putRes.status, 200);
      assertEquals(await putRes.json(), {
        ok: true,
        defaultEnvironmentName: "Staging",
      });

      const getRes = await app.request(
        `/organizations/${organizationId}/default-environment`,
        { headers: { Cookie: cookie } },
      );
      assertEquals(getRes.status, 200);
      assertEquals(await getRes.json(), { defaultEnvironmentName: "Staging" });
    },
  );
});

test("PUT /organizations/:id/default-environment rejects invalid names", async () => {
  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);

      await app.request(
        `/organizations/${organizationId}/default-environment`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ defaultEnvironmentName: "Staging" }),
        },
      );

      const illegal = await app.request(
        `/organizations/${organizationId}/default-environment`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ defaultEnvironmentName: "bad\nname" }),
        },
      );
      assertEquals(illegal.status, 400);

      const blank = await app.request(
        `/organizations/${organizationId}/default-environment`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ defaultEnvironmentName: "   " }),
        },
      );
      assertEquals(blank.status, 400);

      const empty = await app.request(
        `/organizations/${organizationId}/default-environment`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ defaultEnvironmentName: "" }),
        },
      );
      assertEquals(empty.status, 400);

      const tooLong = await app.request(
        `/organizations/${organizationId}/default-environment`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ defaultEnvironmentName: "a".repeat(256) }),
        },
      );
      assertEquals(tooLong.status, 400);

      const getRes = await app.request(
        `/organizations/${organizationId}/default-environment`,
        { headers: { Cookie: cookie } },
      );
      assertEquals(await getRes.json(), { defaultEnvironmentName: "Staging" });
    },
  );
});

test("PUT /organizations/:id/default-environment null resets to null", async () => {
  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);

      await app.request(
        `/organizations/${organizationId}/default-environment`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ defaultEnvironmentName: "Staging" }),
        },
      );

      const reset = await app.request(
        `/organizations/${organizationId}/default-environment`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ defaultEnvironmentName: null }),
        },
      );
      assertEquals(reset.status, 200);
      assertEquals(await reset.json(), {
        ok: true,
        defaultEnvironmentName: null,
      });

      const getRes = await app.request(
        `/organizations/${organizationId}/default-environment`,
        { headers: { Cookie: cookie } },
      );
      assertEquals(await getRes.json(), { defaultEnvironmentName: null });
    },
  );
});

test("PUT /organizations/:id/default-environment forbids non-managers", async () => {
  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(
        `/organizations/${organizationId}/default-environment`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ defaultEnvironmentName: "Staging" }),
        },
      );
      assertEquals(res.status, 403);
    },
    { withManageGrant: false },
  );
});

test("POST /organizations creates an org owned by the signed-in user", async () => {
  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request("/organizations", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Second Organization" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json() as { ok: true; id: string };
      assertEquals(body.ok, true);
      assertEquals(typeof body.id, "string");

      const listRes = await app.request("/organizations", {
        headers: { Cookie: cookie },
      });
      assertEquals(listRes.status, 200);
      const listBody = await listRes.json() as {
        organizations: Array<{ id: string; name: string | null }>;
      };
      const ids = listBody.organizations.map((org) => org.id);
      assertEquals(ids.includes(organizationId), true);
      assertEquals(ids.includes(body.id), true);

      const ownerGrant = await db
        .select({ id: grant.id })
        .from(grant)
        .where(
          and(
            eq(grant.entityType, "organization"),
            eq(grant.entityId, body.id),
            eq(grant.actorType, "user"),
            eq(grant.actorId, userId),
            eq(grant.permission, "organization:own"),
          ),
        )
        .limit(1);
      assertEquals(ownerGrant.length, 1);
    },
  );
});

test("GET /organizations/:id returns the accessible organization", async () => {
  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(`/organizations/${organizationId}`, {
        headers: { Cookie: cookie },
      });
      assertEquals(res.status, 200);
      const body = await res.json() as {
        organization: {
          id: string;
          name: string | null;
          createdAt: string;
        };
      };
      assertEquals(body.organization.id, organizationId);
      assertEquals(body.organization.name, "Org Route Test Org");
      assertEquals(typeof body.organization.createdAt, "string");

      const missing = await app.request(
        `/organizations/${crypto.randomUUID()}`,
        { headers: { Cookie: cookie } },
      );
      assertEquals(missing.status, 404);
    },
  );
});

test("GET /organizations/:id returns 404 when the org is inaccessible", async () => {
  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(`/organizations/${organizationId}`, {
        headers: { Cookie: cookie },
      });
      assertEquals(res.status, 404);
    },
    { withManageGrant: false },
  );
});

test("PATCH /organizations/:id renames the organization", async () => {
  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(`/organizations/${organizationId}`, {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "O'Reilly" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json() as {
        ok: true;
        organization: { id: string; name: string | null };
      };
      assertEquals(body.ok, true);
      assertEquals(body.organization.id, organizationId);
      assertEquals(body.organization.name, "O'Reilly");

      const getRes = await app.request(`/organizations/${organizationId}`, {
        headers: { Cookie: cookie },
      });
      assertEquals(getRes.status, 200);
      const getBody = await getRes.json() as {
        organization: { name: string | null };
      };
      assertEquals(getBody.organization.name, "O'Reilly");
    },
  );
});

test("PATCH /organizations/:id rejects invalid names and non-managers", async () => {
  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const invalid = await app.request(`/organizations/${organizationId}`, {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "bad\nname" }),
      });
      assertEquals(invalid.status, 400);
    },
  );

  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const denied = await app.request(`/organizations/${organizationId}`, {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Renamed Org" }),
      });
      assertEquals(denied.status, 403);
    },
    { withManageGrant: false },
  );
});

test("PUT /organizations/:id/docker-networking replaces, echoes, clears, and 409s on a colliding pool", async () => {
  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const headers = { Cookie: cookie, "Content-Type": "application/json" };
      const path = `/organizations/${organizationId}/docker-networking`;
      const now = new Date().toISOString();
      const [reserved] = await db
        .insert(network)
        .values({
          organizationId,
          kind: "reserved",
          cidr: "10.100.0.0/16",
          name: "Corp VPN",
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: network.id });
      try {
        const putRes = await app.request(path, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            addressPools: [
              { base: "10.201.0.0/16", size: 24 },
              { base: "10.200.0.5/16", size: 24 },
            ],
            defaultBridgeCidr: "172.17.0.1/16",
          }),
        });
        assertEquals(putRes.status, 200);
        assertEquals(await putRes.json(), {
          ok: true,
          addressPools: [
            { base: "10.201.0.0/16", size: 24 },
            { base: "10.200.0.0/16", size: 24 },
          ],
          defaultBridgeCidr: "172.17.0.1/16",
        });

        const getRes = await app.request(path, { headers: { Cookie: cookie } });
        assertEquals(await getRes.json(), {
          addressPools: [
            { base: "10.201.0.0/16", size: 24 },
            { base: "10.200.0.0/16", size: 24 },
          ],
          defaultBridgeCidr: "172.17.0.1/16",
        });

        // A pool overlapping a reserved range is refused by the collision
        // authority with its usual shape; the stored pools stay untouched.
        const collide = await app.request(path, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            addressPools: [{ base: "10.100.8.0/24", size: 28 }],
          }),
        });
        assertEquals(collide.status, 409);
        assertEquals(await collide.json(), {
          error: "cidr_overlaps_reserved",
          cidr: "10.100.8.0/24",
          conflictingCidr: "10.100.0.0/16",
          networkId: reserved!.id,
        });

        // `bip` goes through the same authority: a bridge whose network
        // overlaps the reserved range is refused and nothing is written.
        const bridgeInReserved = await app.request(path, {
          method: "PUT",
          headers,
          body: JSON.stringify({ defaultBridgeCidr: "10.100.0.1/16" }),
        });
        assertEquals(bridgeInReserved.status, 409);
        assertEquals(await bridgeInReserved.json(), {
          error: "cidr_overlaps_reserved",
          cidr: "10.100.0.0/16",
          conflictingCidr: "10.100.0.0/16",
          networkId: reserved!.id,
        });

        // … and one inside the fabric host range or container pool likewise.
        await db.insert(fabric).values({
          organizationId,
          cidr: "10.250.0.0/16",
          options: { containerPool: "10.192.0.0/12" },
        });
        const bridgeInFabric = await app.request(path, {
          method: "PUT",
          headers,
          body: JSON.stringify({ defaultBridgeCidr: "10.250.0.1/16" }),
        });
        assertEquals(bridgeInFabric.status, 409);
        assertEquals(await bridgeInFabric.json(), {
          error: "cidr_overlaps_fabric",
          cidr: "10.250.0.0/16",
          conflictingCidr: "10.250.0.0/16",
        });
        const bridgeInPool = await app.request(path, {
          method: "PUT",
          headers,
          body: JSON.stringify({ defaultBridgeCidr: "10.200.0.1/16" }),
        });
        assertEquals(bridgeInPool.status, 409);
        assertEquals(await bridgeInPool.json(), {
          error: "cidr_overlaps_fabric_pool",
          cidr: "10.200.0.0/16",
          conflictingCidr: "10.192.0.0/12",
        });
        await db.delete(fabric).where(eq(fabric.organizationId, organizationId));

        // The stored pools are now part of the registry in the other
        // direction: a reserved range inside one is refused. None of the
        // refused PUTs above touched `organization.options.docker`.
        const [orgRow] = await db
          .select({ options: organization.options })
          .from(organization)
          .where(eq(organization.id, organizationId))
          .limit(1);
        assertEquals(
          (orgRow?.options as { docker?: unknown }).docker,
          {
            addressPools: [
              { base: "10.201.0.0/16", size: 24 },
              { base: "10.200.0.0/16", size: 24 },
            ],
            defaultBridgeCidr: "172.17.0.1/16",
          },
        );

        // Replace-all: a narrowed re-statement of a stored pool never
        // collides with the list it overwrites.
        const narrowed = await app.request(path, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            addressPools: [{ base: "10.200.0.0/17", size: 24 }],
          }),
        });
        assertEquals(narrowed.status, 200);
        assertEquals(await narrowed.json(), {
          ok: true,
          addressPools: [{ base: "10.200.0.0/17", size: 24 }],
          defaultBridgeCidr: null,
        });

        // `null` on every key clears the stored object.
        const cleared = await app.request(path, {
          method: "PUT",
          headers,
          body: JSON.stringify({ addressPools: null, defaultBridgeCidr: null }),
        });
        assertEquals(cleared.status, 200);
        assertEquals(await cleared.json(), {
          ok: true,
          addressPools: [],
          defaultBridgeCidr: null,
        });
        const afterClear = await app.request(path, { headers: { Cookie: cookie } });
        assertEquals(await afterClear.json(), {
          addressPools: [],
          defaultBridgeCidr: null,
        });
      } finally {
        await db.delete(fabric).where(eq(fabric.organizationId, organizationId));
        await db.delete(network).where(eq(network.organizationId, organizationId));
      }
    },
  );
});

test("PUT /organizations/:id/docker-networking forbids non-managers", async () => {
  await withOrgFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(
        `/organizations/${organizationId}/docker-networking`,
        {
          method: "PUT",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ addressPools: [] }),
        },
      );
      assertEquals(res.status, 403);
    },
    { withManageGrant: false },
  );
});
