import { assertEquals } from "@std/assert";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import { getDatabaseUrl } from "../../db-url.ts";
import { createDenoDb } from "../../db.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../authn/crypto.ts";
import { createSession } from "../authn/session-store.ts";
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../authn/secrets.ts";
import { attachDaemonStateToServer } from "../../daemon/authn/server-identity-db.ts";
import type { CommandEnvelope } from "../../lib/commands/envelope.ts";
import type { CommandQueue } from "../../lib/commands/queue.ts";
import {
  command,
  container,
  datacenter,
  environment,
  fabric,
  grant,
  ip,
  managed,
  network,
  organization,
  principal,
  project,
  replica,
  server,
  service,
  tls,
  user,
  workspace,
} from "../../lib/db/schema.ts";
import { postgresEngineSpec } from "../../lib/managed/postgres.ts";
import { createManagedPrincipal } from "../principals/store.ts";
import { ensureManagedContainerAllocation } from "../managed/allocate-managed-container.ts";
import { ORG_ID_HEADER } from "../org-context.ts";
import { registerDatacenterRoutes } from "./routes.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../../test-fixtures/secrets.ts";

const dbUrl = getDatabaseUrl();

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function reportedPrivateAddress(
  address: string,
  cidr: string,
): Record<string, unknown> {
  return {
    ips: [
      {
        address,
        version: 4,
        scope: "private",
        cidr,
      },
    ],
  };
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

async function createDatacenterRoutesTestApp(
  db: ReturnType<typeof createDenoDb>,
) {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDatacenterRoutes(app, { secrets, runtime: "deno", signupEnvOverride: undefined });
  return { app, secrets };
}

async function withDatacenterFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>;
    app: Hono<AppEnv>;
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>;
    userId: string;
    organizationId: string;
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping datacenter route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const { app, secrets } = await createDatacenterRoutesTestApp(db);

  const [org] = await db
    .insert(organization)
    .values({ name: "DC Route Fixture Org" })
    .returning({ id: organization.id });
  const organizationId = org!.id;

  const [u] = await db
    .insert(user)
    .values({
      email: `dc-fixture-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id });
  const userId = u!.id;

  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });

  try {
    await fn({ db, app, secrets, userId, organizationId });
  } finally {
    await db.delete(ip).where(eq(ip.organizationId, organizationId));
    await db.delete(fabric).where(eq(fabric.organizationId, organizationId));
    await db.delete(server).where(eq(server.organizationId, organizationId));
    await db.delete(network).where(eq(network.organizationId, organizationId));
    await db.delete(datacenter).where(
      eq(datacenter.organizationId, organizationId),
    );
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ));
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
}

test("GET /datacenters/name-suggestions uses unassigned server geo and ASN", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping datacenter route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDatacenterRoutes(app, { secrets, runtime: "deno", signupEnvOverride: undefined });

  const [org] = await db
    .insert(organization)
    .values({ name: "DC Suggestions Org" })
    .returning({ id: organization.id });
  const organizationId = org!.id;
  const [u] = await db
    .insert(user)
    .values({
      email: `dc-suggestions-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id });
  const userId = u!.id;

  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });
  const [assignedDatacenter] = await db
    .insert(datacenter)
    .values({ organizationId, name: "Existing DC" })
    .returning({ id: datacenter.id });
  const [assignedSiteNet] = await db
    .insert(network)
    .values({
      organizationId,
      datacenterId: assignedDatacenter!.id,
      kind: "datacenter",
      cidr: "10.0.0.0/24",
      name: "Existing LAN",
    })
    .returning({ id: network.id });
  const [unassignedServer] = await db
    .insert(server)
    .values({
      organizationId,
      metadata: {
        geo: {
          city: "Amsterdam",
          country: "NL",
          asn: 13335,
          asOrganization: "Cloudflare",
        },
      },
    })
    .returning({ id: server.id });
  const [assignedServer] = await db
    .insert(server)
    .values({
      organizationId,
      metadata: { geo: { city: "Dallas", regionCode: "TX", country: "US" } },
    })
    .returning({ id: server.id });
  await db.insert(ip).values({
    organizationId,
    datacenterId: assignedDatacenter!.id,
    networkId: assignedSiteNet!.id,
    serverId: assignedServer!.id,
    address: "10.0.0.10",
    allocation: "dedicated",
    scope: "datacenter",
  });

  const cookie = await sessionCookie(db, secrets, userId);
  const res = await app.request("/datacenters/name-suggestions", {
    headers: { cookie, [ORG_ID_HEADER]: organizationId },
  });

  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    suggestions: [{
      name: "Amsterdam NL - Cloudflare AS13335",
      serverCount: 1,
      serverIds: [unassignedServer!.id],
      serverLabels: [unassignedServer!.id],
      geo: {
        city: "Amsterdam",
        country: "NL",
        asn: 13335,
        asOrganization: "Cloudflare",
      },
    }],
  });

  await db.delete(ip).where(eq(ip.serverId, assignedServer!.id));
  await db.delete(server).where(eq(server.id, unassignedServer!.id));
  await db.delete(server).where(eq(server.id, assignedServer!.id));
  await db.delete(network).where(eq(network.id, assignedSiteNet!.id));
  await db.delete(datacenter).where(eq(datacenter.id, assignedDatacenter!.id));
  await db.delete(grant).where(eq(grant.actorId, userId));
  await db.delete(user).where(eq(user.id, userId));
  await db.delete(organization).where(eq(organization.id, organizationId));
});

test("GET /datacenters/:id returns 404 for datacenter in another org", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping datacenter route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDatacenterRoutes(app, { secrets, runtime: "deno", signupEnvOverride: undefined });

  const [orgA] = await db
    .insert(organization)
    .values({ name: "DC Org A" })
    .returning({ id: organization.id });
  const [orgB] = await db
    .insert(organization)
    .values({ name: "DC Org B" })
    .returning({ id: organization.id });

  const [u] = await db
    .insert(user)
    .values({
      email: `dc-test-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id });
  const userId = u!.id;

  await db.insert(grant).values({
    entityType: "organization",
    entityId: orgA!.id,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });

  const now = new Date().toISOString();
  const [dcB] = await db
    .insert(datacenter)
    .values({
      organizationId: orgB!.id,
      name: "OtherDC",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: datacenter.id });

  const cookie = await sessionCookie(db, secrets, userId);
  const res = await app.request(`/datacenters/${dcB!.id}`, {
    headers: {
      cookie,
      [ORG_ID_HEADER]: orgA!.id,
    },
  });

  assertEquals(res.status, 404);

  await db.delete(datacenter).where(eq(datacenter.id, dcB!.id));
  await db.delete(grant).where(eq(grant.actorId, userId));
  await db.delete(user).where(eq(user.id, userId));
  await db.delete(organization).where(eq(organization.id, orgA!.id));
  await db.delete(organization).where(eq(organization.id, orgB!.id));
});

test("GET /datacenters returns 403 for org member without organization:manage", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping datacenter route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDatacenterRoutes(app, { secrets, runtime: "deno", signupEnvOverride: undefined });

  const [orgA] = await db
    .insert(organization)
    .values({ name: "DC List Org" })
    .returning({ id: organization.id });
  const organizationId = orgA!.id;

  const [u] = await db
    .insert(user)
    .values({
      email: `dc-list-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id });
  const userId = u!.id;

  const cookie = await sessionCookie(db, secrets, userId);
  const res = await app.request("/datacenters", {
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  });

  assertEquals(res.status, 403);

  await db.delete(user).where(eq(user.id, userId));
  await db.delete(organization).where(eq(organization.id, organizationId));
});

test("DELETE /datacenters/:id succeeds when no scoped networks exist", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping datacenter route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDatacenterRoutes(app, { secrets, runtime: "deno", signupEnvOverride: undefined });

  const [orgA] = await db
    .insert(organization)
    .values({ name: "DC Delete Org" })
    .returning({ id: organization.id });
  const organizationId = orgA!.id;

  const [u] = await db
    .insert(user)
    .values({
      email: `dc-del-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id });
  const userId = u!.id;

  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });

  const now = new Date().toISOString();
  const [dc] = await db
    .insert(datacenter)
    .values({
      organizationId,
      name: "EmptyDC",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: datacenter.id });

  const cookie = await sessionCookie(db, secrets, userId);
  const res = await app.request(`/datacenters/${dc!.id}`, {
    method: "DELETE",
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  });

  assertEquals(res.status, 200);
  const body = await res.json() as { ok: boolean };
  assertEquals(body.ok, true);

  const [remaining] = await db
    .select({ id: datacenter.id })
    .from(datacenter)
    .where(eq(datacenter.id, dc!.id))
    .limit(1);
  assertEquals(remaining, undefined);

  await db.delete(grant).where(eq(grant.actorId, userId));
  await db.delete(user).where(eq(user.id, userId));
  await db.delete(organization).where(eq(organization.id, organizationId));
});

test("DELETE /datacenters/:id returns 409 when members remain", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping datacenter route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDatacenterRoutes(app, { secrets, runtime: "deno", signupEnvOverride: undefined });

  const [orgA] = await db
    .insert(organization)
    .values({ name: "DC Network Org" })
    .returning({ id: organization.id });
  const organizationId = orgA!.id;

  const [u] = await db
    .insert(user)
    .values({
      email: `dc-net-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id });
  const userId = u!.id;

  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });

  const now = new Date().toISOString();
  const [dc] = await db
    .insert(datacenter)
    .values({
      organizationId,
      name: "NetworkedDC",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: datacenter.id });

  const [net] = await db
    .insert(network)
    .values({
      organizationId,
      datacenterId: dc!.id,
      kind: "datacenter",
      cidr: "10.10.0.0/24",
      name: "DC Net",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: network.id });

  const [srv] = await db
    .insert(server)
    .values({
      organizationId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id });
  await db.insert(ip).values({
    organizationId,
    datacenterId: dc!.id,
    networkId: net!.id,
    serverId: srv!.id,
    address: "10.10.0.10",
    allocation: "dedicated",
    scope: "datacenter",
  });

  const cookie = await sessionCookie(db, secrets, userId);
  const res = await app.request(`/datacenters/${dc!.id}`, {
    method: "DELETE",
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  });

  assertEquals(res.status, 409);
  const body = await res.json() as { error: string };
  assertEquals(body.error, "datacenter_has_members");

  const [stillThere] = await db
    .select({ id: datacenter.id })
    .from(datacenter)
    .where(eq(datacenter.id, dc!.id))
    .limit(1);
  assertEquals(stillThere?.id, dc!.id);

  await db.delete(ip).where(eq(ip.datacenterId, dc!.id));
  await db.delete(network).where(eq(network.id, net!.id));
  await db.delete(server).where(eq(server.id, srv!.id));
  await db.delete(datacenter).where(eq(datacenter.id, dc!.id));
  await db.delete(grant).where(eq(grant.actorId, userId));
  await db.delete(user).where(eq(user.id, userId));
  await db.delete(organization).where(eq(organization.id, organizationId));
});

test("GET /datacenters lists datacenters with privateCidrs", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Listed DC",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    await db.insert(network).values({
      organizationId,
      datacenterId: dc!.id,
      kind: "datacenter",
      cidr: "10.10.0.0/24",
      name: "Site LAN",
      createdAt: now,
      updatedAt: now,
    });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });

    assertEquals(res.status, 200);
    const body = await res.json() as {
      datacenters: Array<
        { id: string; name: string; privateCidrs: string[] }
      >;
    };
    assertEquals(body.datacenters.length, 1);
    assertEquals(body.datacenters[0]?.id, dc!.id);
    assertEquals(body.datacenters[0]?.name, "Listed DC");
    assertEquals(body.datacenters[0]?.privateCidrs, ["10.10.0.0/24"]);
  });
});

test("GET /datacenters includes effective priority and trusted", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [defaults] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Defaults DC",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    const [pinned] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Pinned DC",
        options: { priority: 10, trusted: false },
        createdAt: new Date(Date.now() + 1000).toISOString(),
        updatedAt: now,
      })
      .returning({ id: datacenter.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });

    assertEquals(res.status, 200);
    const body = await res.json() as {
      datacenters: Array<
        { id: string; priority: number; trusted: boolean }
      >;
    };
    const byId = new Map(body.datacenters.map((row) => [row.id, row]));
    assertEquals(byId.get(defaults!.id)?.priority, 100);
    assertEquals(byId.get(defaults!.id)?.trusted, true);
    assertEquals(byId.get(pinned!.id)?.priority, 10);
    assertEquals(byId.get(pinned!.id)?.trusted, false);
  });
});

test("GET /datacenters returns empty list when org has no datacenters", async () => {
  await withDatacenterFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { datacenters: [] });
  });
});

test("GET /datacenters/name-suggestions returns 400 for invalid limit", async () => {
  await withDatacenterFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters/name-suggestions?limit=-1", {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });
    assertEquals(res.status, 400);
  });
});

test("GET /datacenters/name-suggestions returns empty when no servers exist", async () => {
  await withDatacenterFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters/name-suggestions", {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { suggestions: [] });
  });
});

test("GET /datacenters/:id returns datacenter detail with privateCidrs", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Detail DC",
        description: "Edge site",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    await db.insert(network).values({
      organizationId,
      datacenterId: dc!.id,
      kind: "datacenter",
      cidr: "10.20.0.0/24",
      name: "Detail LAN",
      createdAt: now,
      updatedAt: now,
    });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/datacenters/${dc!.id}`, {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });

    assertEquals(res.status, 200);
    const body = await res.json() as {
      datacenter: { id: string; name: string; privateCidrs: string[] };
    };
    assertEquals(body.datacenter.id, dc!.id);
    assertEquals(body.datacenter.name, "Detail DC");
    assertEquals(body.datacenter.privateCidrs, ["10.20.0.0/24"]);
  });
});

test("GET /datacenters/:id includes effective priority and trusted", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Policy DC",
        options: { addressPreference: "ipv4", priority: 25 },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/datacenters/${dc!.id}`, {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });

    assertEquals(res.status, 200);
    const body = await res.json() as {
      datacenter: {
        options: Record<string, unknown> | null;
        priority: number;
        trusted: boolean;
      };
    };
    assertEquals(body.datacenter.options, {
      addressPreference: "ipv4",
      priority: 25,
    });
    assertEquals(body.datacenter.priority, 25);
    assertEquals(body.datacenter.trusted, true);
  });
});

test("POST /datacenters creates site network and membership pins", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        metadata: {
          geo: {
            city: "Frankfurt",
            country: "DE",
            asn: 24940,
            asOrganization: "Hetzner",
          },
          ...reportedPrivateAddress("10.0.0.10", "10.0.0.10/24"),
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      method: "POST",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sourceServerId: srv!.id,
        members: [{ serverId: srv!.id, address: "10.0.0.10" }],
      }),
    });

    assertEquals(res.status, 200);
    const body = await res.json() as { ok: true; id: string };
    assertEquals(body.ok, true);

    const [dcRow] = await db
      .select({ name: datacenter.name })
      .from(datacenter)
      .where(eq(datacenter.id, body.id))
      .limit(1);
    assertEquals(dcRow?.name, "Frankfurt DE - Hetzner AS24940");

    const [siteNet] = await db
      .select({ cidr: network.cidr, kind: network.kind })
      .from(network)
      .where(eq(network.datacenterId, body.id))
      .limit(1);
    assertEquals(siteNet?.kind, "datacenter");
    assertEquals(siteNet?.cidr, "10.0.0.0/24");

    const [pin] = await db
      .select({
        serverId: ip.serverId,
        address: ip.address,
        scope: ip.scope,
      })
      .from(ip)
      .where(
        and(
          eq(ip.datacenterId, body.id),
          eq(ip.serverId, srv!.id),
          eq(ip.scope, "datacenter"),
        ),
      )
      .limit(1);
    assertEquals(pin?.serverId, srv!.id);
    assertEquals(String(pin?.address), "10.0.0.10");
  });
});

test("POST /datacenters derives CIDR from the reported prefix and ignores body.cidr", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        metadata: reportedPrivateAddress("10.0.0.10", "10.0.0.10/16"),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      method: "POST",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Derived CIDR",
        cidr: "10.0.0.0/24",
        members: [{ serverId: srv!.id, address: "10.0.0.10" }],
      }),
    });

    assertEquals(res.status, 200);
    const body = await res.json() as { ok: true; id: string };
    const [siteNet] = await db
      .select({ cidr: network.cidr })
      .from(network)
      .where(eq(network.datacenterId, body.id))
      .limit(1);
    assertEquals(siteNet?.cidr, "10.0.0.0/16");
  });
});

test("POST /datacenters infers a typical LAN CIDR when the seed IP has no prefix", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        metadata: {
          ips: [
            { address: "10.0.0.10", version: 4, scope: "private" },
          ],
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      method: "POST",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        members: [{ serverId: srv!.id, address: "10.0.0.10" }],
      }),
    });

    assertEquals(res.status, 200);
    const body = await res.json() as { ok: true; id: string };
    const [siteNet] = await db
      .select({ cidr: network.cidr })
      .from(network)
      .where(eq(network.datacenterId, body.id))
      .limit(1);
    assertEquals(siteNet?.cidr, "10.0.0.0/24");
  });
});

test("DELETE /datacenters/:id removes an empty datacenter including its site network", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Empty with LAN",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    await db.insert(network).values({
      organizationId,
      datacenterId: dc!.id,
      kind: "datacenter",
      cidr: "10.10.0.0/24",
      name: "Site LAN",
      createdAt: now,
      updatedAt: now,
    });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/datacenters/${dc!.id}`, {
      method: "DELETE",
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });
    assertEquals(res.status, 200);

    const leftoverDc = await db
      .select({ id: datacenter.id })
      .from(datacenter)
      .where(eq(datacenter.id, dc!.id));
    assertEquals(leftoverDc.length, 0);
    const leftoverNet = await db
      .select({ id: network.id })
      .from(network)
      .where(eq(network.datacenterId, dc!.id));
    assertEquals(leftoverNet.length, 0);
  });
});

test("POST /datacenters/:id/members allows a second address and rejects duplicates", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [existingDc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Existing",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    const [siteNet] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: existingDc!.id,
        kind: "datacenter",
        cidr: "10.0.0.0/24",
        name: "Existing LAN",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id });
    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        metadata: {
          ips: [
            {
              address: "10.0.0.10",
              version: 4,
              scope: "private",
              cidr: "10.0.0.0/24",
            },
            {
              address: "2001:db8::10",
              version: 6,
              scope: "private",
              cidr: "2001:db8::/64",
            },
          ],
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });
    await db.insert(ip).values({
      organizationId,
      datacenterId: existingDc!.id,
      networkId: siteNet!.id,
      serverId: srv!.id,
      address: "10.0.0.10",
      allocation: "dedicated",
      scope: "datacenter",
    });

    const cookie = await sessionCookie(db, secrets, userId);
    const headers = {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      "content-type": "application/json",
    };
    const secondFamily = await app.request(
      `/datacenters/${existingDc!.id}/members`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          members: [{ serverId: srv!.id, address: "2001:db8::10" }],
        }),
      },
    );
    assertEquals(secondFamily.status, 200);
    const secondBody = await secondFamily.json() as { ok: true };
    assertEquals(secondBody.ok, true);

    const pinsAfterSecond = await db
      .select({ address: ip.address })
      .from(ip)
      .where(
        and(
          eq(ip.datacenterId, existingDc!.id),
          eq(ip.serverId, srv!.id),
          eq(ip.scope, "datacenter"),
        ),
      );
    assertEquals(pinsAfterSecond.length, 2);

    const duplicate = await app.request(
      `/datacenters/${existingDc!.id}/members`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          members: [{ serverId: srv!.id, address: "10.0.0.10" }],
        }),
      },
    );
    assertEquals(duplicate.status, 409);
    const duplicateBody = await duplicate.json() as { error: string };
    assertEquals(duplicateBody.error, "address_in_use");

    const removed = await app.request(
      `/datacenters/${existingDc!.id}/members/${srv!.id}`,
      {
        method: "DELETE",
        headers: { cookie, [ORG_ID_HEADER]: organizationId },
      },
    );
    assertEquals(removed.status, 200);
    const removedBody = await removed.json() as { ok: true; removed: number };
    assertEquals(removedBody.ok, true);
    assertEquals(removedBody.removed, 2);

    const leftover = await db
      .select({ id: ip.id })
      .from(ip)
      .where(
        and(
          eq(ip.datacenterId, existingDc!.id),
          eq(ip.serverId, srv!.id),
        ),
      );
    assertEquals(leftover.length, 0);
  });
});

test("POST /datacenters/:id/members returns 409 when a derived CIDR overlaps another datacenter", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [otherDc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Other DC",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    await db.insert(network).values({
      organizationId,
      datacenterId: otherDc!.id,
      kind: "datacenter",
      cidr: "10.0.0.0/24",
      name: "Other LAN",
      createdAt: now,
      updatedAt: now,
    });

    const [targetDc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Target DC",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    await db.insert(network).values({
      organizationId,
      datacenterId: targetDc!.id,
      kind: "datacenter",
      cidr: "192.168.1.0/24",
      name: "Target LAN",
      createdAt: now,
      updatedAt: now,
    });

    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        metadata: reportedPrivateAddress("10.0.0.50", "10.0.0.0/16"),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/datacenters/${targetDc!.id}/members`, {
      method: "POST",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        members: [{ serverId: srv!.id, address: "10.0.0.50" }],
      }),
    });

    assertEquals(res.status, 409);
    const body = await res.json() as { error: string };
    assertEquals(body.error, "subnet_overlaps");
  });
});

test("POST /datacenters returns 409 when a derived CIDR overlaps another datacenter", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [otherDc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Existing LAN DC",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    await db.insert(network).values({
      organizationId,
      datacenterId: otherDc!.id,
      kind: "datacenter",
      cidr: "10.0.0.0/24",
      name: "Existing LAN",
      createdAt: now,
      updatedAt: now,
    });

    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        metadata: reportedPrivateAddress("10.0.0.50", "10.0.0.0/24"),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      method: "POST",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        members: [{ serverId: srv!.id, address: "10.0.0.50" }],
      }),
    });

    assertEquals(res.status, 409);
    const body = await res.json() as { error: string };
    assertEquals(body.error, "subnet_overlaps");
  });
});

test("POST /datacenters/:id/members returns 409 when auto-derived prefixes in one request overlap", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [targetDc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Target DC",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    await db.insert(network).values({
      organizationId,
      datacenterId: targetDc!.id,
      kind: "datacenter",
      cidr: "192.168.1.0/24",
      name: "Target LAN",
      createdAt: now,
      updatedAt: now,
    });

    const [srvSlash24] = await db
      .insert(server)
      .values({
        organizationId,
        metadata: reportedPrivateAddress("10.0.0.10", "10.0.0.0/24"),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });
    const [srvSlash16] = await db
      .insert(server)
      .values({
        organizationId,
        metadata: reportedPrivateAddress("10.0.1.20", "10.0.0.0/16"),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/datacenters/${targetDc!.id}/members`, {
      method: "POST",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        members: [
          { serverId: srvSlash24!.id, address: "10.0.0.10" },
          { serverId: srvSlash16!.id, address: "10.0.1.20" },
        ],
      }),
    });

    assertEquals(res.status, 409);
    const body = await res.json() as { error: string };
    assertEquals(body.error, "subnet_overlaps");
  });
});

test("DELETE /datacenters/:id/members/:serverId removes every pin for that server", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Unpin DC",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    const [v4Net] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: "datacenter",
        cidr: "10.0.0.0/24",
        name: "Unpin LAN",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id });
    const [v6Net] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: "datacenter",
        cidr: "2001:db8::/64",
        name: "Unpin v6",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id });
    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });
    await db.insert(ip).values([
      {
        organizationId,
        datacenterId: dc!.id,
        networkId: v4Net!.id,
        serverId: srv!.id,
        address: "10.0.0.11",
        allocation: "dedicated",
        scope: "datacenter",
      },
      {
        organizationId,
        datacenterId: dc!.id,
        networkId: v6Net!.id,
        serverId: srv!.id,
        address: "2001:db8::11",
        allocation: "dedicated",
        scope: "datacenter",
      },
    ]);

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(
      `/datacenters/${dc!.id}/members/${srv!.id}`,
      {
        method: "DELETE",
        headers: { cookie, [ORG_ID_HEADER]: organizationId },
      },
    );
    assertEquals(res.status, 200);
    const body = await res.json() as { ok: true; removed: number };
    assertEquals(body.ok, true);
    assertEquals(body.removed, 2);

    const leftover = await db
      .select({ id: ip.id })
      .from(ip)
      .where(
        and(
          eq(ip.datacenterId, dc!.id),
          eq(ip.serverId, srv!.id),
        ),
      );
    assertEquals(leftover.length, 0);
  });
});

test("POST /datacenters returns 404 for server in another org", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: "Other DC Org" })
      .returning({ id: organization.id });
    const now = new Date().toISOString();
    const [otherSrv] = await db
      .insert(server)
      .values({
        organizationId: otherOrg!.id,
        metadata: {
          ips: [
            { address: "10.0.0.10", version: 4, scope: "private" },
          ],
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      method: "POST",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Cross Org DC",
        cidr: "10.0.0.0/24",
        members: [{ serverId: otherSrv!.id, address: "10.0.0.10" }],
      }),
    });

    assertEquals(res.status, 404);

    await db.delete(server).where(eq(server.id, otherSrv!.id));
    await db.delete(organization).where(eq(organization.id, otherOrg!.id));
  });
});

test("POST /datacenters returns 400 for invalid members", async () => {
  await withDatacenterFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      method: "POST",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Bad DC",
        cidr: "10.0.0.0/24",
        members: [{ serverId: "not-a-uuid", address: "10.0.0.10" }],
      }),
    });
    assertEquals(res.status, 400);
  });
});

test("PATCH /datacenters/:id updates name and description", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Before",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/datacenters/${dc!.id}`, {
      method: "PATCH",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "After",
        description: "Updated site",
        metadata: { region: "eu-west" },
      }),
    });

    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });

    const [row] = await db
      .select({
        name: datacenter.name,
        description: datacenter.description,
        metadata: datacenter.metadata,
      })
      .from(datacenter)
      .where(eq(datacenter.id, dc!.id))
      .limit(1);
    assertEquals(row?.name, "After");
    assertEquals(row?.description, "Updated site");
    assertEquals(row?.metadata, { region: "eu-west" });
  });
});

test("PATCH /datacenters/:id persists valid priority and trusted and drops invalid values", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Policy Patch DC",
        options: { addressPreference: "ipv4", priority: 500 },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const headers = {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      "content-type": "application/json",
    };

    const valid = await app.request(`/datacenters/${dc!.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ options: { priority: 7, trusted: false } }),
    });
    assertEquals(valid.status, 200);
    assertEquals(await valid.json(), { ok: true });

    const [afterValid] = await db
      .select({ options: datacenter.options })
      .from(datacenter)
      .where(eq(datacenter.id, dc!.id))
      .limit(1);
    // Replace-all: the previous addressPreference is gone.
    assertEquals(afterValid?.options, { priority: 7, trusted: false });

    const detail = await app.request(`/datacenters/${dc!.id}`, {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });
    assertEquals(detail.status, 200);
    const detailBody = await detail.json() as {
      datacenter: { priority: number; trusted: boolean };
    };
    assertEquals(detailBody.datacenter.priority, 7);
    assertEquals(detailBody.datacenter.trusted, false);

    const invalid = await app.request(`/datacenters/${dc!.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        options: { addressPreference: "ipv6", priority: -1, trusted: "no" },
      }),
    });
    assertEquals(invalid.status, 200);

    const [afterInvalid] = await db
      .select({ options: datacenter.options })
      .from(datacenter)
      .where(eq(datacenter.id, dc!.id))
      .limit(1);
    assertEquals(afterInvalid?.options, { addressPreference: "ipv6" });

    const list = await app.request("/datacenters", {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });
    const listBody = await list.json() as {
      datacenters: Array<{ id: string; priority: number; trusted: boolean }>;
    };
    const row = listBody.datacenters.find((item) => item.id === dc!.id);
    assertEquals(row?.priority, 100);
    assertEquals(row?.trusted, true);
  });
});

test("PATCH /datacenters/:id with options null clears the stored blob", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Reset DC",
        options: { priority: 1, trusted: false },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/datacenters/${dc!.id}`, {
      method: "PATCH",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ options: null }),
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });

    const [row] = await db
      .select({ options: datacenter.options })
      .from(datacenter)
      .where(eq(datacenter.id, dc!.id))
      .limit(1);
    assertEquals(row?.options, null);

    const detail = await app.request(`/datacenters/${dc!.id}`, {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });
    assertEquals(detail.status, 200);
    const body = await detail.json() as {
      datacenter: { options: unknown; priority: number; trusted: boolean };
    };
    assertEquals(body.datacenter.options, null);
    assertEquals(body.datacenter.priority, 100);
    assertEquals(body.datacenter.trusted, true);
  });
});

test("PATCH /datacenters/:id returns 404 for datacenter in another org", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: "Patch Other Org" })
      .returning({ id: organization.id });
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId: otherOrg!.id,
        name: "Foreign",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/datacenters/${dc!.id}`, {
      method: "PATCH",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Nope" }),
    });

    assertEquals(res.status, 404);

    await db.delete(datacenter).where(eq(datacenter.id, dc!.id));
    await db.delete(organization).where(eq(organization.id, otherOrg!.id));
  });
});

test("POST /datacenters returns 409 cidr_overlaps_reserved when the derived CIDR hits a reserved range", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [reserved] = await db
      .insert(network)
      .values({
        organizationId,
        kind: "reserved",
        cidr: "10.0.0.0/8",
        name: "Corp VPN - Chicago branch",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id });

    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        metadata: reportedPrivateAddress("10.0.0.50", "10.0.0.0/24"),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      method: "POST",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        members: [{ serverId: srv!.id, address: "10.0.0.50" }],
      }),
    });

    assertEquals(res.status, 409);
    assertEquals(await res.json(), {
      error: "cidr_overlaps_reserved",
      cidr: "10.0.0.0/24",
      conflictingCidr: "10.0.0.0/8",
      networkId: reserved!.id,
    });

    // Nothing was written.
    const [dcRow] = await db
      .select({ id: datacenter.id })
      .from(datacenter)
      .where(eq(datacenter.organizationId, organizationId))
      .limit(1);
    assertEquals(dcRow, undefined);
  });
});

test("POST /datacenters/:id/subnets reports each collision code from the authority", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: "Site", createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id });
    const [otherDc] = await db
      .insert(datacenter)
      .values({ organizationId, name: "Other", createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id });
    await db.insert(fabric).values({
      organizationId,
      cidr: "10.250.0.0/16",
      options: { containerPool: "10.192.0.0/12" },
    });
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
    const [bridge] = await db
      .insert(network)
      .values({
        organizationId,
        kind: "docker",
        cidr: "172.18.0.0/16",
        options: { dockerNetworkName: "bridge-shared" },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id });
    const [otherSite] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: otherDc!.id,
        kind: "datacenter",
        cidr: "10.20.0.0/24",
        name: "other-lan",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id });
    const [ownSite] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: "datacenter",
        cidr: "10.10.0.0/24",
        name: "lan",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const post = (cidr: string) =>
      app.request(`/datacenters/${dc!.id}/subnets`, {
        method: "POST",
        headers: {
          cookie,
          [ORG_ID_HEADER]: organizationId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ cidr }),
      });

    const expectations: Array<[string, Record<string, unknown>]> = [
      ["10.250.3.0/24", {
        error: "cidr_overlaps_fabric",
        cidr: "10.250.3.0/24",
        conflictingCidr: "10.250.0.0/16",
      }],
      ["10.199.0.0/24", {
        error: "cidr_overlaps_fabric_pool",
        cidr: "10.199.0.0/24",
        conflictingCidr: "10.192.0.0/12",
      }],
      ["10.100.9.0/24", {
        error: "cidr_overlaps_reserved",
        cidr: "10.100.9.0/24",
        conflictingCidr: "10.100.0.0/16",
        networkId: reserved!.id,
      }],
      ["172.18.4.0/24", {
        error: "cidr_overlaps_docker_network",
        cidr: "172.18.4.0/24",
        conflictingCidr: "172.18.0.0/16",
        networkId: bridge!.id,
      }],
      ["10.20.0.0/25", {
        error: "subnet_overlaps",
        cidr: "10.20.0.0/25",
        conflictingCidr: "10.20.0.0/24",
        networkId: otherSite!.id,
        datacenterId: otherDc!.id,
      }],
      ["10.10.0.128/25", {
        error: "subnet_overlaps",
        cidr: "10.10.0.128/25",
        conflictingCidr: "10.10.0.0/24",
        networkId: ownSite!.id,
        datacenterId: dc!.id,
      }],
    ];
    for (const [cidr, expected] of expectations) {
      const res = await post(cidr);
      assertEquals(res.status, 409, cidr);
      assertEquals(await res.json(), expected);
    }

    const free = await post("10.30.0.0/24");
    assertEquals(free.status, 200);
  });
});

function createRecordingCommandQueue(): CommandQueue & {
  envelopes: CommandEnvelope[];
} {
  const envelopes: CommandEnvelope[] = [];
  return {
    envelopes,
    enqueue: (envelope: CommandEnvelope) => {
      envelopes.push(envelope);
      return Promise.resolve();
    },
  };
}

/**
 * Datacenter route app wired with the command queue and secrets the
 * routing-policy fan-out needs (the plain fixture app above leaves them
 * unset, which exercises the skip-with-warning branch).
 */
async function createDatacenterRoutesTestAppWithQueue(
  db: ReturnType<typeof createDenoDb>,
) {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    "data-encryption",
  );
  const commandQueue = createRecordingCommandQueue();
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("secretsConfig", secretsConfig);
    c.set("dataEncryptionSecrets", dataEncryptionSecrets);
    c.set("commandQueue", commandQueue);
    return next();
  });
  registerDatacenterRoutes(app, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  return { app, secrets, commandQueue, dataEncryptionSecrets };
}

/**
 * Two connected servers hosting one managed Postgres cluster (primary on
 * `primaryServerId`, failover replica on `replicaServerId`), both pinned into
 * two datacenters (`dcA`, `dcB`). The replica's stored transport starts as a
 * stale `public` so a recompute is observable.
 */
async function withManagedPolicyFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>;
    app: Hono<AppEnv>;
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>;
    commandQueue: CommandQueue & { envelopes: CommandEnvelope[] };
    userId: string;
    organizationId: string;
    primaryServerId: string;
    replicaServerId: string;
    replicaMemberId: string;
    dcA: string;
    dcB: string;
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping datacenter route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const { app, secrets, commandQueue, dataEncryptionSecrets } =
    await createDatacenterRoutesTestAppWithQueue(db);

  const [org] = await db
    .insert(organization)
    .values({ name: "DC Policy Fan-out Org" })
    .returning({ id: organization.id });
  const organizationId = org!.id;

  const [u] = await db
    .insert(user)
    .values({
      email: `dc-policy-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id });
  const userId = u!.id;
  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });

  const now = new Date().toISOString();
  const insertServer = async (name: string): Promise<string> => {
    const [row] = await db
      .insert(server)
      .values({
        organizationId,
        name,
        createdAt: now,
        updatedAt: now,
        isConnected: true,
        statusChangedAt: now,
      })
      .returning({ id: server.id });
    await attachDaemonStateToServer(db, row!.id, {
      publicJwk: { kty: "OKP", crv: "Ed25519", x: `dc-policy-key-${row!.id}` },
      fingerprint: `dc-policy-fp-${row!.id}`,
    });
    return row!.id;
  };
  const primaryServerId = await insertServer("DC Policy Primary");
  const replicaServerId = await insertServer("DC Policy Replica");

  const insertDatacenter = async (
    name: string,
    cidr: string,
    options: Record<string, unknown>,
  ): Promise<string> => {
    const [row] = await db
      .insert(datacenter)
      .values({ organizationId, name, options, createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id });
    const [net] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: row!.id,
        kind: "datacenter",
        cidr,
        name: `${name} LAN`,
      })
      .returning({ id: network.id });
    const prefix = cidr.slice(0, cidr.lastIndexOf("."));
    for (const [serverId, host] of [[primaryServerId, 1], [replicaServerId, 2]] as const) {
      await db.insert(ip).values({
        organizationId,
        serverId,
        datacenterId: row!.id,
        networkId: net!.id,
        scope: "datacenter",
        allocation: "dedicated",
        address: `${prefix}.${host}`,
      });
    }
    return row!.id;
  };
  const dcA = await insertDatacenter("Policy DC A", "10.1.0.0/24", {});
  const dcB = await insertDatacenter("Policy DC B", "10.2.0.0/24", {});

  const [ws] = await db
    .insert(workspace)
    .values({ name: "DC Policy Workspace", organizationId })
    .returning({ id: workspace.id });
  const workspaceId = ws!.id;
  const [proj] = await db
    .insert(project)
    .values({
      name: "DC Policy Project",
      workspaceId,
      metadata: { type: "managed", code: "postgres" },
    })
    .returning({ id: project.id });
  const projectId = proj!.id;
  const [env] = await db
    .insert(environment)
    .values({ name: "Production", projectId, serverId: primaryServerId })
    .returning({ id: environment.id });
  const environmentId = env!.id;

  const settings = postgresEngineSpec.parseSettings({});
  const [managedRow] = await db
    .insert(managed)
    .values({
      environmentId,
      serverId: primaryServerId,
      name: "Postgres",
      engine: "postgres",
      status: "ready",
      options: { settings, databases: ["postgres"] },
    })
    .returning({ id: managed.id });
  const managedId = managedRow!.id;

  await db.insert(replica).values({
    managedId,
    serverId: primaryServerId,
    role: "primary",
    isReadEligible: false,
    ordinal: 1,
    replicationTransport: "local",
  });
  const [replicaMember] = await db
    .insert(replica)
    .values({
      managedId,
      serverId: replicaServerId,
      role: "replica",
      replicaClass: "failover",
      isReadEligible: false,
      ordinal: 2,
      replicationTransport: "public",
    })
    .returning({ id: replica.id });
  const replicaMemberId = replicaMember!.id;

  const allocations = [
    await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId: primaryServerId,
      composeServiceName: "postgres",
      ordinal: 1,
      memberOrdinals: [1, 2],
    }),
    await ensureManagedContainerAllocation(db, {
      environmentId,
      serverId: replicaServerId,
      composeServiceName: "postgres",
      ordinal: 2,
      memberOrdinals: [1, 2],
    }),
  ];
  await createManagedPrincipal(db, dataEncryptionSecrets, {
    managedId,
    provider: "postgres",
    username: "postgres",
    metadata: { managedRoot: true, databases: ["postgres"] },
  });

  const serverIds = [primaryServerId, replicaServerId];
  try {
    await fn({
      db,
      app,
      secrets,
      commandQueue,
      userId,
      organizationId,
      primaryServerId,
      replicaServerId,
      replicaMemberId,
      dcA,
      dcB,
    });
  } finally {
    await db.delete(principal).where(eq(principal.managedId, managedId));
    await db.delete(replica).where(eq(replica.managedId, managedId));
    await db.delete(container).where(
      inArray(container.id, allocations.map((row) => row.containerRowId)),
    );
    await db.delete(service).where(
      inArray(service.id, [...new Set(allocations.map((row) => row.serviceId))]),
    );
    await db.delete(managed).where(eq(managed.id, managedId));
    await db.delete(environment).where(eq(environment.id, environmentId));
    await db.delete(project).where(eq(project.id, projectId));
    await db.delete(command).where(inArray(command.serverId, serverIds));
    await db.delete(ip).where(eq(ip.organizationId, organizationId));
    await db.delete(network).where(eq(network.organizationId, organizationId));
    await db.delete(datacenter).where(
      eq(datacenter.organizationId, organizationId),
    );

    // The ingress fan-out self-heals a system (managed-ingress) hierarchy per
    // server — sweep every workspace under the org so RESTRICT FKs never block
    // the server delete.
    await db.delete(container).where(inArray(container.serverId, serverIds));
    const workspaceIds = (
      await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.organizationId, organizationId))
    ).map((row) => row.id);
    if (workspaceIds.length > 0) {
      const projectIds = (
        await db
          .select({ id: project.id })
          .from(project)
          .where(inArray(project.workspaceId, workspaceIds))
      ).map((row) => row.id);
      if (projectIds.length > 0) {
        const environmentIds = (
          await db
            .select({ id: environment.id })
            .from(environment)
            .where(inArray(environment.projectId, projectIds))
        ).map((row) => row.id);
        if (environmentIds.length > 0) {
          await db.delete(service).where(
            inArray(service.environmentId, environmentIds),
          );
          await db.delete(managed).where(
            inArray(managed.environmentId, environmentIds),
          );
          await db.delete(environment).where(
            inArray(environment.id, environmentIds),
          );
        }
        await db.delete(project).where(inArray(project.id, projectIds));
      }
    }
    await db.delete(server).where(inArray(server.id, serverIds));
    if (workspaceIds.length > 0) {
      await db.delete(workspace).where(inArray(workspace.id, workspaceIds));
    }
    await db.delete(tls).where(eq(tls.organizationId, organizationId));
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ));
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
}

test("PATCH /datacenters/:id priority change recomputes member transports and fans out managed.ingress.reconcile", async () => {
  await withManagedPolicyFixtures(async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    primaryServerId,
    replicaServerId,
    replicaMemberId,
    dcB,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId);
    const response = await app.request(`/datacenters/${dcB}`, {
      method: "PATCH",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ options: { priority: 10 } }),
    });
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { ok: true });

    const [member] = await db
      .select({ transport: replica.replicationTransport })
      .from(replica)
      .where(eq(replica.id, replicaMemberId))
      .limit(1);
    // Stale `public` is rewritten from the live ladder (shared trusted LAN).
    assertEquals(member?.transport, "datacenter");

    const reconciles = commandQueue.envelopes.filter((envelope) =>
      envelope.type === "managed.ingress.reconcile"
    );
    assertEquals(
      new Set(reconciles.map((envelope) => envelope.serverId)),
      new Set([primaryServerId, replicaServerId]),
    );
  });
});

test("PATCH /datacenters/:id name-only edit enqueues nothing and leaves transports alone", async () => {
  await withManagedPolicyFixtures(async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    replicaMemberId,
    dcA,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId);
    const headers = {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      "content-type": "application/json",
    };
    const renamed = await app.request(`/datacenters/${dcA}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Policy DC A (renamed)" }),
    });
    assertEquals(renamed.status, 200);

    // Re-sending the same effective policy is not a change either.
    const samePolicy = await app.request(`/datacenters/${dcA}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ options: { priority: 100, trusted: true } }),
    });
    assertEquals(samePolicy.status, 200);

    assertEquals(commandQueue.envelopes.length, 0);
    const [member] = await db
      .select({ transport: replica.replicationTransport })
      .from(replica)
      .where(eq(replica.id, replicaMemberId))
      .limit(1);
    assertEquals(member?.transport, "public");
  });
});

test("PATCH /datacenters/:id policy change without a command queue still saves", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Queueless Policy DC",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    const cookie = await sessionCookie(db, secrets, userId);
    const response = await app.request(`/datacenters/${dc!.id}`, {
      method: "PATCH",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ options: { trusted: false } }),
    });
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { ok: true });
    const [after] = await db
      .select({ options: datacenter.options })
      .from(datacenter)
      .where(eq(datacenter.id, dc!.id))
      .limit(1);
    assertEquals(after?.options, { trusted: false });
  });
});
