import { assert, assertEquals, assertExists } from "@std/assert";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { deriveSecretsConfig } from "../client/authn/secrets.ts";
import { deriveDaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import type { DaemonPublicJwk } from "./authn/daemon-jwt-keyring.ts";
import { encryptSecretForDaemon } from "../client/authn/data-encryption.ts";
import {
  COLOCATED_SERVER_DISPLAY_NAME,
  rotateColocatedLicenseCredentials,
} from "../client/authn/install-state.ts";
import {
  createLicense,
  invalidateLicense,
  revokeLicense,
} from "../client/authn/license.ts";
import {
  LICENSE_TIER_BELOW_REQUIRED_ERROR,
  LICENSE_TIER_UNASSIGNED_ERROR,
} from "../lib/tiers/tier-enforcement.ts";
import { getDatabaseUrl } from "../db-url.ts";
import { createDenoDb, endDbConnection } from "../db.ts";
import {
  container,
  environment,
  license,
  organization,
  payer,
  project,
  server,
  service,
  subscription,
  subscriptionItem,
  tier,
  workspace,
} from "../lib/db/schema.ts";
import { getTierByLabel, insertTier } from "../lib/db/tier-records.ts";
import { recomputeOrganizationAssignments } from "../lib/tiers/assignment-records.ts";
import {
  MAX_AUTH_CHALLENGE_BODY_BYTES,
  MAX_AUTH_SESSION_BODY_BYTES,
  MAX_ENROLL_BODY_BYTES,
  MAX_SECRETS_DECRYPT_BATCH,
  MAX_SECRETS_DECRYPT_BODY_BYTES,
  MAX_SECRETS_DECRYPT_CIPHERTEXT_CHARS,
  registerDaemonApiRoutes,
} from "./api-routes.ts";
import { MAX_METRICS_PAYLOAD_BYTES } from "./metrics/validation.ts";
import { METRICS_SCHEMA_VERSION } from "./metrics/contract.ts";
import type {
  DaemonCell,
  DaemonCellRegistry,
  DaemonCellSnapshot,
} from "./cell/contracts.ts";
import type { DaemonOutboundEnvelope } from "./cell/protocol.ts";
import { getLatestCapabilityPlanGeneration } from "../client/servers/capability-plan-records.ts";
import type {
  AuthenticatedMetricsSample,
  ServerMetricsStore,
  SlotMapping,
} from "./metrics/types.ts";
import { recordTopologyGeneration } from "../client/servers/server-topology-records.ts";
import {
  consumeChallenge,
  createStatelessChallengeStore,
  issueChallenge,
} from "./cell/stateless-challenge.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import {
  parseServerDaemonState,
  type ServerDaemonState,
} from "./authn/daemon-state.ts";
import { revokeDaemonKey } from "./authn/server-identity-db.ts";
import {
  buildAuthPayload,
  buildEnrollmentPayload,
  computePublicKeyFingerprint,
} from "./authn/server-key.ts";
import {
  type AnalyticsEngineDatasetLike,
  CloudflareAnalyticsEngineServerMetricsStore,
} from "./metrics/backends/cloudflare/store.ts";
import {
  AE_BLOB_FAMILY_INDEX,
  AE_BLOB_KIND_INDEX,
  AE_BLOB_SOURCE_OR_IDENTITY_INDEX,
  type AnalyticsEngineDataPointLike,
} from "./metrics/backends/cloudflare/field-map.ts";
import {
  createMetricsChartCache,
  resetDenoMetricsChartCacheForTests,
} from "./metrics/query/cache.ts";
import {
  markServerLiveSessionActive,
  readLiveSample,
} from "./metrics/query/live-session.ts";

const dbUrl = getDatabaseUrl();
const encoder = new TextEncoder();

/** Canonical 64-char lowercase hex HMAC shape used by real daemons. */
function randomMachineKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Raw `/etc/machine-id` shape — must be rejected, never stored as machineKey. */
const RAW_MACHINE_ID = "0123456789abcdef0123456789abcdef";

type KeyMaterial = {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  fingerprint: string;
};

type EnrollFixture = {
  db: ReturnType<typeof createDenoDb>;
  app: Hono<AppEnv>;
  organizationId: string;
  licenseId: string;
  licenseToken: string;
  serverId: string;
  keyId: string;
  enrollBody: { serverId: string; keyId: string };
  key: KeyMaterial;
  machineKey: string;
  hostname: string;
  /** Tier rows this fixture created (an existing row for the label is reused, never deleted). */
  extraTierIds: string[];
};

type EnrollFixtureOptions = {
  runtime?: "workers" | "deno";
  /** Hosted default buys one seat at rank 1 (S1). `null` buys nothing: no payer, no seats. */
  tierRank?: number | null;
  enroll?: boolean;
};

const GIBIBYTE = 1024 ** 3;

function hostResourcesPayload(cores: number, memoryGib: number) {
  return {
    cpus: [{ cores: { total: cores } }],
    memory: { totalBytes: memoryGib * GIBIBYTE },
  };
}

/**
 * The tier row for a ladder rank. `tier.label` / `tier.rank` are unique, so
 * the instance's own row is reused when present and created only otherwise;
 * a created id is pushed to `extraTierIds` for cleanup.
 */
async function ensureTestTier(
  db: ReturnType<typeof createDenoDb>,
  rank: number,
  extraTierIds: string[],
): Promise<string> {
  const label = rank >= 8 ? "SX" : `S${rank}`;
  const existing = await getTierByLabel(db, label);
  if (existing) return existing.id;
  const row = await insertTier(db, {
    label,
    providerProductId: label === "SX" ? null : `prod_test_${label.toLowerCase()}`,
    priceCents: null,
    currency: null,
  });
  extraTierIds.push(row.id);
  return row.id;
}

/**
 * What a projected purchase leaves behind: payer → subscription → one seat
 * row per tier at `quantity`, then the derived assignment recomputed the
 * way the entitlement sync does after every projection. A license carries
 * no tier; the servers it binds are covered by what the organization bought.
 */
async function purchaseTier(
  db: ReturnType<typeof createDenoDb>,
  fixture: { organizationId: string; extraTierIds: string[] },
  rank: number,
  quantity: number,
): Promise<string> {
  const tierId = await ensureTestTier(db, rank, fixture.extraTierIds);
  const now = new Date().toISOString();
  let [payerRow] = await db
    .select({ id: payer.id })
    .from(payer)
    .where(eq(payer.organizationId, fixture.organizationId))
    .limit(1);
  if (!payerRow) {
    [payerRow] = await db
      .insert(payer)
      .values({
        organizationId: fixture.organizationId,
        provider: "stripe",
        providerCustomerId: `cus_test_${crypto.randomUUID()}`,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: payer.id });
  }
  let [subscriptionRow] = await db
    .select({ id: subscription.id })
    .from(subscription)
    .where(eq(subscription.payerId, payerRow!.id))
    .limit(1);
  if (!subscriptionRow) {
    [subscriptionRow] = await db
      .insert(subscription)
      .values({
        payerId: payerRow!.id,
        providerSubscriptionId: `sub_test_${crypto.randomUUID()}`,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: subscription.id });
  }
  await db
    .insert(subscriptionItem)
    .values({
      subscriptionId: subscriptionRow!.id,
      tierId,
      providerItemId: `si_test_${crypto.randomUUID()}`,
      providerPriceId: `price_test_${rank}`,
      quantity,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [subscriptionItem.subscriptionId, subscriptionItem.tierId],
      set: { quantity, updatedAt: now },
    });
  await recomputeOrganizationAssignments(db, fixture.organizationId);
  return tierId;
}

/** Remove the purchase `purchaseTier` projected: seats → subscription → payer. */
async function deleteOrganizationPurchase(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
): Promise<void> {
  const payerRows = await db
    .select({ id: payer.id })
    .from(payer)
    .where(eq(payer.organizationId, organizationId));
  for (const payerRow of payerRows) {
    const subscriptionRows = await db
      .select({ id: subscription.id })
      .from(subscription)
      .where(eq(subscription.payerId, payerRow.id));
    for (const subscriptionRow of subscriptionRows) {
      await db
        .delete(subscriptionItem)
        .where(eq(subscriptionItem.subscriptionId, subscriptionRow.id));
    }
    await db.delete(subscription).where(eq(subscription.payerId, payerRow.id));
  }
  await db.delete(payer).where(eq(payer.organizationId, organizationId));
}

async function mergeServerResources(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
  resources: ReturnType<typeof hostResourcesPayload>,
): Promise<void> {
  await db
    .update(server)
    .set({
      metadata: sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
        JSON.stringify({ resources })
      }::jsonb`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(server.id, serverId));
}

async function postEnroll(
  app: Hono<AppEnv>,
  params: {
    licenseId: string;
    licenseToken: string;
    machineKey: string;
    hostname: string;
    key: KeyMaterial;
    serverId?: string;
  },
): Promise<Response> {
  const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(challengeResponse.status, 200);
  const challenge = (await challengeResponse.json()) as {
    challengeId: string;
    nonce: string;
  };
  const payload = buildEnrollmentPayload({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    licenseId: params.licenseId,
    machineKey: params.machineKey,
    hostname: params.hostname,
    publicKeyFingerprint: params.key.fingerprint,
  });
  const signature = await signPayload(params.key.privateKey, payload);
  return await app.request("/api/daemon/v1/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      licenseId: params.licenseId,
      licenseToken: params.licenseToken,
      machineKey: params.machineKey,
      hostname: params.hostname,
      publicJwk: params.key.publicJwk,
      challengeId: challenge.challengeId,
      signature,
      ...(params.serverId ? { serverId: params.serverId } : {}),
    }),
  });
}

async function postAuthSession(
  app: Hono<AppEnv>,
  params: {
    serverId: string;
    keyId: string;
    key: KeyMaterial;
    machineKey: string;
    hostname: string;
  },
): Promise<Response> {
  const challenge = await issueAuthChallenge(
    app,
    params.serverId,
    params.keyId,
  );
  const payload = buildAuthPayload({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    serverId: params.serverId,
    keyId: params.keyId,
    machineKey: params.machineKey,
    hostname: params.hostname,
  });
  const signature = await signPayload(params.key.privateKey, payload);
  return await app.request("/api/daemon/v1/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serverId: params.serverId,
      keyId: params.keyId,
      challengeId: challenge.challengeId,
      signature,
      machineKey: params.machineKey,
      hostname: params.hostname,
      at: new Date().toISOString(),
    }),
  });
}

async function createTestSecrets() {
  return await deriveDaemonJwtKeyring({
    versioned: [{ version: 1, value: "daemon_api_routes_test_secret_value" }],
  });
}

async function createTestChallengeSecrets() {
  return await deriveSecretsConfig(
    {
      versioned: [
        {
          version: 1,
          value: "daemon_api_routes_test_challenge_secret",
        },
      ],
    },
    "daemon-challenge-signing",
  );
}

function createTestSecretsConfig() {
  return {
    versioned: [
      {
        version: 1,
        value: "daemon_api_routes_test_data_encryption_secret",
      },
    ],
  };
}

async function generateKeyMaterial(): Promise<KeyMaterial> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const fingerprint = await computePublicKeyFingerprint(publicJwk);
  return {
    privateKey: pair.privateKey,
    publicJwk,
    fingerprint,
  };
}

function decodeJwtPayload(token: string): {
  sub: string;
  jti: string;
  kid: string;
  iat: number;
  exp: number;
  aud: string;
  typ: string;
} {
  const [, encodedPayload] = token.split(".");
  const padded = encodedPayload +
    "=".repeat((4 - (encodedPayload.length % 4)) % 4);
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(base64)) as {
    sub: string;
    jti: string;
    kid: string;
    iat: number;
    exp: number;
    aud: string;
    typ: string;
  };
}

async function signPayload(
  privateKey: CryptoKey,
  payload: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    encoder.encode(payload),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function readDaemonState(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
): Promise<ServerDaemonState | null> {
  const [row] = await db
    .select({ daemon: server.daemon })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1);
  return parseServerDaemonState(row?.daemon);
}

async function createTestApp(
  db: ReturnType<typeof createDenoDb>,
  runtime: "workers" | "deno" = "workers",
): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  const secrets = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  registerDaemonApiRoutes(app, {
    secrets,
    challengeSigningSecrets,
    secretsConfig,
    runtime,
  });
  return app;
}

function createSnapshotTrackingCell(serverId: string): {
  cell: DaemonCell;
  putSnapshotPatches: Partial<DaemonCellSnapshot>[];
} {
  const putSnapshotPatches: Partial<DaemonCellSnapshot>[] = [];
  const noopAsync = async () => {};
  const cell: DaemonCell = {
    attachDaemonSocket: async () => ({
      connectionId: "conn",
      lease: {
        holder: "conn",
        token: "conn",
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
    }),
    detachDaemonSocket: noopAsync,
    recordInbound: noopAsync,
    getSnapshot: async () => ({
      serverId,
      version: 0,
      updatedAt: new Date().toISOString(),
      connected: false,
    }),
    putSnapshot: async (patch) => {
      putSnapshotPatches.push(patch);
      return {
        serverId,
        version: putSnapshotPatches.length,
        updatedAt: new Date().toISOString(),
        connected: false,
        ...patch,
      };
    },
    enqueue: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "queued" as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    markSent: noopAsync,
    handleInbound: async () => null,
    getRequest: async () => null,
    listRequests: async () => [],
    waitForRequest: async () => null,
    createRequestAndWait: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "expired" as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    claimDeliveryLease: async () => null,
    renewDeliveryLease: async () => null,
    releaseDeliveryLease: noopAsync,
    readOutboxBatch: async () => [],
    ackOutbox: noopAsync,
    prune: async () => [],
    clearUpdateStatus: async () => ({ cleared: 0 }),
    purge: noopAsync,
  };
  return { cell, putSnapshotPatches };
}

async function createTestAppWithRegistry(
  db: ReturnType<typeof createDenoDb>,
  registry: DaemonCellRegistry,
  runtime: "workers" | "deno" = "workers",
): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("daemonCellRegistry", registry);
    return next();
  });
  const secrets = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  registerDaemonApiRoutes(app, {
    secrets,
    challengeSigningSecrets,
    secretsConfig,
    runtime,
  });
  return app;
}

function createEnqueueTrackingRegistry(): {
  registry: DaemonCellRegistry;
  enqueued: DaemonOutboundEnvelope[];
} {
  const enqueued: DaemonOutboundEnvelope[] = [];
  const tracking = createSnapshotTrackingCell("track");
  const cell: DaemonCell = {
    ...tracking.cell,
    enqueue: async (outbound) => {
      enqueued.push(outbound);
      return await tracking.cell.enqueue(outbound);
    },
  };
  return {
    enqueued,
    registry: {
      getCell: () => cell,
      listOnlineServerIds: async () => [],
      getSnapshots: async () => new Map(),
      purge: async () => {},
    },
  };
}

async function issueDaemonToken(
  serverId: string,
  keyId: string,
): Promise<string> {
  const secrets = await createTestSecrets();
  const issued = await issueDaemonJwt({ sub: serverId, kid: keyId }, secrets);
  return issued.token;
}

async function issueAuthChallenge(
  app: Hono<AppEnv>,
  serverId: string,
  keyId: string,
): Promise<{ challengeId: string; nonce: string }> {
  const response = await app.request("/api/daemon/v1/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, keyId }),
  });
  assertEquals(response.status, 200);
  const body = (await response.json()) as {
    challengeId: string;
    nonce: string;
  };
  return body;
}

async function withEnrollFixture(
  fn: (fixture: EnrollFixture) => Promise<void>,
  options: EnrollFixtureOptions = {},
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping daemon API route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const runtime = options.runtime ?? "workers";
  const enroll = options.enroll !== false;
  const tierRank = options.tierRank === undefined
    ? (runtime === "deno" ? null : 1)
    : options.tierRank;

  const db = createDenoDb();
  const app = await createTestApp(db, runtime);
  const machineKey = randomMachineKey();
  const hostname = `host-${crypto.randomUUID()}`;
  const extraTierIds: string[] = [];
  const [orgRow] = await db
    .insert(organization)
    .values({ name: "Daemon API Routes Test Org" })
    .returning({ id: organization.id });
  const organizationId = orgRow!.id;
  const { licenseId, licenseToken } = await createLicense(db, {
    organizationId,
    name: "Daemon API Routes Test License",
  });

  if (tierRank != null) {
    await purchaseTier(db, { organizationId, extraTierIds }, tierRank, 1);
  }

  const key = await generateKeyMaterial();
  let serverId = "";
  let keyId = "";
  let enrollBody = { serverId: "", keyId: "" };

  if (enroll) {
    const enrollResponse = await postEnroll(app, {
      licenseId,
      licenseToken,
      machineKey,
      hostname,
      key,
    });
    assertEquals(enrollResponse.status, 200);
    enrollBody = (await enrollResponse.json()) as {
      serverId: string;
      keyId: string;
    };
    serverId = enrollBody.serverId;
    keyId = enrollBody.keyId;
  }

  try {
    await fn({
      db,
      app,
      organizationId,
      licenseId,
      licenseToken,
      serverId,
      keyId,
      enrollBody,
      key,
      machineKey,
      hostname,
      extraTierIds,
    });
  } finally {
    try {
      const orgServers = await db
        .select({ id: server.id })
        .from(server)
        .where(eq(server.organizationId, organizationId));
      for (const row of orgServers) {
        await deleteOrganizationServerTree(db, organizationId, row.id);
      }
      await db.delete(license).where(eq(license.organizationId, organizationId));
      await deleteOrganizationPurchase(db, organizationId);
      for (const id of extraTierIds) {
        await db.delete(tier).where(eq(tier.id, id));
      }
      await db.delete(organization).where(eq(organization.id, organizationId));
    } finally {
      await endDbConnection(db);
    }
  }
}

/** Remove system hierarchy + server so ON DELETE RESTRICT FKs do not block cleanup. */
async function deleteOrganizationServerTree(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
  serverId: string,
): Promise<void> {
  const workspaceRows = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.organizationId, organizationId));
  for (const ws of workspaceRows) {
    const projectRows = await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.workspaceId, ws.id));
    for (const p of projectRows) {
      const envRows = await db
        .select({ id: environment.id })
        .from(environment)
        .where(eq(environment.projectId, p.id));
      for (const env of envRows) {
        const serviceRows = await db
          .select({ id: service.id })
          .from(service)
          .where(eq(service.environmentId, env.id));
        for (const svc of serviceRows) {
          await db.delete(container).where(eq(container.serviceId, svc.id));
        }
        await db.delete(service).where(eq(service.environmentId, env.id));
        await db.delete(environment).where(eq(environment.id, env.id));
      }
      await db.delete(project).where(eq(project.id, p.id));
    }
    await db.delete(workspace).where(eq(workspace.id, ws.id));
  }
  await db.delete(container).where(eq(container.serverId, serverId));
  await db.delete(license).where(eq(license.serverId, serverId));
  await db.delete(server).where(eq(server.id, serverId));
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("GET /jwks.json returns public OKP keys only", async () => {
  const app = new Hono<AppEnv>();
  const keyring = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  registerDaemonApiRoutes(app, {
    secrets: keyring,
    challengeSigningSecrets,
    secretsConfig,
  });

  const response = await app.request("/api/daemon/v1/jwks.json");
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Cache-Control"), "public, max-age=300");

  const bodyText = await response.text();
  assertEquals(bodyText.includes("daemon_api_routes_test_secret_value"), false);
  assertEquals(
    bodyText.includes("daemon_api_routes_test_challenge_secret"),
    false,
  );
  assertEquals(
    bodyText.includes("daemon_api_routes_test_data_encryption_secret"),
    false,
  );

  const body = JSON.parse(bodyText) as { keys: DaemonPublicJwk[] };
  assert(body.keys.length > 0);
  for (const key of body.keys) {
    assertEquals(key.kty, "OKP");
    assertEquals(key.crv, "Ed25519");
    assertEquals(key.alg, "EdDSA");
    assertEquals(key.use, "sig");
    assertEquals(typeof key.kid, "string");
    assertEquals(typeof key.x, "string");
    assertEquals("d" in key, false);
  }

  const issued = await issueDaemonJwt(
    { sub: crypto.randomUUID(), kid: crypto.randomUUID() },
    keyring,
  );
  const [encodedHeader, encodedPayload, encodedSig] = issued.token.split(".");
  const header = JSON.parse(
    new TextDecoder().decode(decodeBase64Url(encodedHeader)),
  ) as {
    kid?: string;
  };
  assertEquals(typeof header.kid, "string");

  const jwksEntry = body.keys.find((entry) => entry.kid === header.kid);
  assertExists(jwksEntry);

  const verifyKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: jwksEntry.kty,
      crv: jwksEntry.crv,
      x: jwksEntry.x,
    },
    { name: "Ed25519" },
    false,
    ["verify"],
  );

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    verifyKey,
    decodeBase64Url(encodedSig),
    encoder.encode(signingInput),
  );
  assertEquals(verified, true);
});

test("POST /enroll rejects a raw machine-id shaped machineKey", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping daemon API route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }
  const db = createDenoDb();
  try {
    const app = await createTestApp(db);
    const key = await generateKeyMaterial();
    const response = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId: crypto.randomUUID(),
        licenseToken: "dummy-token",
        machineKey: RAW_MACHINE_ID,
        hostname: "host-test",
        publicJwk: key.publicJwk,
        challengeId: crypto.randomUUID(),
        signature: "aa",
      }),
    });
    assertEquals(response.status, 400);
    const body = (await response.json()) as { error?: string };
    assertEquals(body.error, "Invalid machineKey");
  } finally {
    await endDbConnection(db);
  }
});

test("POST /enroll returns 400 for malformed tpchallenge id", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping daemon API route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }
  const db = createDenoDb();
  try {
    const app = await createTestApp(db);
    const key = await generateKeyMaterial();
    // Invalid base64url signature segment must not 500 — same invalid-challenge contract.
    const response = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId: crypto.randomUUID(),
        licenseToken: "dummy-token",
        machineKey: randomMachineKey(),
        hostname: "host-test",
        publicJwk: key.publicJwk,
        challengeId: "tpchallenge.v1.cGF5bG9hZA.%%%",
        signature: "aa",
      }),
    });
    assertEquals(response.status, 400);
    const body = (await response.json()) as { error?: string };
    assertEquals(body.error, "Invalid or expired challenge");
  } finally {
    await endDbConnection(db);
  }
});

test("POST /auth/session returns 400 for malformed tpchallenge id", async () => {
  await withEnrollFixture(
    async ({ app, serverId, keyId, hostname, machineKey }) => {
      const response = await app.request("/api/daemon/v1/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId,
          keyId,
          challengeId: "tpchallenge.v1.cGF5bG9hZA.%%%",
          signature: "aa",
          hostname,
          machineKey,
        }),
      });
      assertEquals(response.status, 400);
      const body = (await response.json()) as { error?: string };
      assertEquals(body.error, "Invalid or expired challenge");
    },
  );
});

test("POST /auth/session rejects a raw machine-id shaped machineKey", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId, hostname }) => {
    const response = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId: crypto.randomUUID(),
        signature: "aa",
        hostname,
        machineKey: RAW_MACHINE_ID,
      }),
    });
    assertEquals(response.status, 400);
    const body = (await response.json()) as { error?: string };
    assertEquals(body.error, "Invalid machineKey");
  });
});

test("POST /enroll rejects invalid license", async () => {
  await withEnrollFixture(async ({ app, licenseId, machineKey, hostname }) => {
    const challengeResponse = await app.request(
      "/api/daemon/v1/auth/challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assertEquals(challengeResponse.status, 200);
    const challenge = (await challengeResponse.json()) as {
      challengeId: string;
      nonce: string;
    };
    const key = await generateKeyMaterial();
    const payload = buildEnrollmentPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      licenseId,
      machineKey,
      hostname,
      publicKeyFingerprint: key.fingerprint,
    });
    const signature = await signPayload(key.privateKey, payload);

    const response = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId,
        licenseToken: "invalid-token",
        machineKey,
        hostname,
        publicJwk: key.publicJwk,
        challengeId: challenge.challengeId,
        signature,
      }),
    });
    assertEquals(response.status, 401);
  });
});

test("POST /enroll rejects request without licenseToken", async () => {
  await withEnrollFixture(async ({ app, licenseId, machineKey, hostname }) => {
    const challengeResponse = await app.request(
      "/api/daemon/v1/auth/challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assertEquals(challengeResponse.status, 200);
    const challenge = (await challengeResponse.json()) as {
      challengeId: string;
      nonce: string;
    };
    const key = await generateKeyMaterial();
    const payload = buildEnrollmentPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      licenseId,
      machineKey,
      hostname,
      publicKeyFingerprint: key.fingerprint,
    });
    const signature = await signPayload(key.privateKey, payload);

    const response = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId,
        machineKey,
        hostname,
        publicJwk: key.publicJwk,
        challengeId: challenge.challengeId,
        signature,
      }),
    });
    assertEquals(response.status, 401);
    const body = (await response.json()) as { error?: string };
    assertEquals(body.error, "Invalid license");
  });
});

test("POST /enroll rejects invalid signature", async () => {
  await withEnrollFixture(
    async ({ app, licenseId, licenseToken, machineKey, hostname }) => {
      const challengeResponse = await app.request(
        "/api/daemon/v1/auth/challenge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assertEquals(challengeResponse.status, 200);
      const challenge = (await challengeResponse.json()) as {
        challengeId: string;
        nonce: string;
      };
      const key = await generateKeyMaterial();

      const response = await app.request("/api/daemon/v1/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licenseId,
          licenseToken,
          machineKey,
          hostname,
          publicJwk: key.publicJwk,
          challengeId: challenge.challengeId,
          signature: "invalid-signature",
        }),
      });
      assertEquals(response.status, 403);
    },
  );
});

test("POST /enroll stores public key only after proof-of-possession", async () => {
  await withEnrollFixture(async ({ db, serverId, keyId, key }) => {
    const daemonState = await readDaemonState(db, serverId);
    assertExists(daemonState);
    assertEquals(daemonState.key.id, keyId);
    assertEquals(daemonState.key.fingerprint, key.fingerprint);
    assertExists(daemonState.key.publicJwk);
    assertEquals(daemonState.key.algorithm, "Ed25519");
  });
});

test("POST /enroll returns serverId and server.daemon.key.id", async () => {
  await withEnrollFixture(async ({ enrollBody, db }) => {
    assertExists(enrollBody.serverId);
    assertExists(enrollBody.keyId);
    const daemonState = await readDaemonState(db, enrollBody.serverId);
    assertEquals(daemonState?.key.id, enrollBody.keyId);
  });
});

test("POST /enroll re-enrollment replaces daemon key on server row", async () => {
  await withEnrollFixture(
    async (
      {
        db,
        app,
        licenseId,
        licenseToken,
        serverId,
        keyId,
        key,
        machineKey,
        hostname,
      },
    ) => {
      const challengeResponse = await app.request(
        "/api/daemon/v1/auth/challenge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assertEquals(challengeResponse.status, 200);
      const challenge = (await challengeResponse.json()) as {
        challengeId: string;
        nonce: string;
      };
      const newKey = await generateKeyMaterial();
      const payload = buildEnrollmentPayload({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        licenseId,
        machineKey,
        hostname,
        publicKeyFingerprint: newKey.fingerprint,
      });
      const signature = await signPayload(newKey.privateKey, payload);

      const enrollResponse = await app.request("/api/daemon/v1/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licenseId,
          licenseToken,
          serverId,
          machineKey,
          hostname,
          publicJwk: newKey.publicJwk,
          challengeId: challenge.challengeId,
          signature,
        }),
      });
      assertEquals(enrollResponse.status, 200);
      const body = (await enrollResponse.json()) as {
        serverId: string;
        keyId: string;
      };
      assertEquals(body.serverId, serverId);
      assertEquals(body.keyId !== keyId, true);

      const daemonState = await readDaemonState(db, serverId);
      assertExists(daemonState);
      assertEquals(daemonState.key.id, body.keyId);
      assertEquals(daemonState.key.fingerprint, newKey.fingerprint);
      assertEquals(daemonState.key.fingerprint !== key.fingerprint, true);
    },
  );
});

test("POST /enroll rejects a second host once the license is latched", async () => {
  await withEnrollFixture(
    async (
      { app, licenseId, licenseToken, serverId, machineKey, hostname },
    ) => {
      const challengeResponse = await app.request(
        "/api/daemon/v1/auth/challenge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assertEquals(challengeResponse.status, 200);
      const challenge = (await challengeResponse.json()) as {
        challengeId: string;
        nonce: string;
      };
      const otherKey = await generateKeyMaterial();
      const otherMachineKey = randomMachineKey();
      const payload = buildEnrollmentPayload({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        licenseId,
        machineKey: otherMachineKey,
        hostname: `other-${hostname}`,
        publicKeyFingerprint: otherKey.fingerprint,
      });
      const signature = await signPayload(otherKey.privateKey, payload);

      const enrollResponse = await app.request("/api/daemon/v1/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licenseId,
          licenseToken,
          machineKey: otherMachineKey,
          hostname: `other-${hostname}`,
          publicJwk: otherKey.publicJwk,
          challengeId: challenge.challengeId,
          signature,
        }),
      });
      assertEquals(enrollResponse.status, 400);
      const body = (await enrollResponse.json()) as { error?: string };
      assertEquals(body.error, "License already consumed or invalid");

      // Same license + persisted serverId still re-enrolls the latched server.
      const reChallengeResponse = await app.request(
        "/api/daemon/v1/auth/challenge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assertEquals(reChallengeResponse.status, 200);
      const reChallenge = (await reChallengeResponse.json()) as {
        challengeId: string;
        nonce: string;
      };
      const reKey = await generateKeyMaterial();
      const rePayload = buildEnrollmentPayload({
        challengeId: reChallenge.challengeId,
        nonce: reChallenge.nonce,
        licenseId,
        machineKey,
        hostname,
        publicKeyFingerprint: reKey.fingerprint,
      });
      const reSignature = await signPayload(reKey.privateKey, rePayload);
      const reEnroll = await app.request("/api/daemon/v1/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licenseId,
          licenseToken,
          serverId,
          machineKey,
          hostname,
          publicJwk: reKey.publicJwk,
          challengeId: reChallenge.challengeId,
          signature: reSignature,
        }),
      });
      assertEquals(reEnroll.status, 200);
      const reBody = (await reEnroll.json()) as { serverId: string };
      assertEquals(reBody.serverId, serverId);
    },
  );
});

test("POST /enroll with a fresh license creates a new server even on the same host", async () => {
  await withEnrollFixture(
    async (
      {
        db,
        app,
        organizationId,
        serverId,
        licenseId,
        machineKey,
        hostname,
        extraTierIds,
      },
    ) => {
      const { licenseId: freshLicenseId, licenseToken: freshLicenseToken } =
        await createLicense(
          db,
          {
            organizationId,
            name: "Fresh One-Shot License",
          },
        );
      // A second server needs a second purchased seat; the fixture bought one.
      await purchaseTier(db, { organizationId, extraTierIds }, 1, 2);

      const challengeResponse = await app.request(
        "/api/daemon/v1/auth/challenge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assertEquals(challengeResponse.status, 200);
      const challenge = (await challengeResponse.json()) as {
        challengeId: string;
        nonce: string;
      };
      const newKey = await generateKeyMaterial();
      const payload = buildEnrollmentPayload({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        licenseId: freshLicenseId,
        machineKey,
        hostname,
        publicKeyFingerprint: newKey.fingerprint,
      });
      const signature = await signPayload(newKey.privateKey, payload);

      const enrollResponse = await app.request("/api/daemon/v1/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licenseId: freshLicenseId,
          licenseToken: freshLicenseToken,
          machineKey,
          hostname,
          publicJwk: newKey.publicJwk,
          challengeId: challenge.challengeId,
          signature,
        }),
      });
      assertEquals(enrollResponse.status, 200);
      const body = (await enrollResponse.json()) as {
        serverId: string;
        keyId: string;
      };
      assertEquals(body.serverId !== serverId, true);

      const [original] = await db
        .select({ serverId: license.serverId })
        .from(license)
        .where(eq(license.id, licenseId));
      assertEquals(original?.serverId, serverId);

      await deleteOrganizationServerTree(db, organizationId, body.serverId);
      await db.delete(license).where(eq(license.id, freshLicenseId));
    },
  );
});

test("POST /enroll re-enrollment with same key clears revocation", async () => {
  await withEnrollFixture(
    async (
      {
        db,
        app,
        licenseId,
        licenseToken,
        serverId,
        keyId,
        key,
        machineKey,
        hostname,
      },
    ) => {
      await revokeDaemonKey(db, serverId);

      const challengeResponse = await app.request(
        "/api/daemon/v1/auth/challenge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assertEquals(challengeResponse.status, 200);
      const challenge = (await challengeResponse.json()) as {
        challengeId: string;
        nonce: string;
      };
      const payload = buildEnrollmentPayload({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        licenseId,
        machineKey,
        hostname,
        publicKeyFingerprint: key.fingerprint,
      });
      const signature = await signPayload(key.privateKey, payload);

      const enrollResponse = await app.request("/api/daemon/v1/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licenseId,
          licenseToken,
          serverId,
          machineKey,
          hostname,
          publicJwk: key.publicJwk,
          challengeId: challenge.challengeId,
          signature,
        }),
      });
      assertEquals(enrollResponse.status, 200);
      const body = (await enrollResponse.json()) as {
        serverId: string;
        keyId: string;
      };
      assertEquals(body.serverId, serverId);
      assertEquals(body.keyId !== keyId, true);

      const daemonState = await readDaemonState(db, serverId);
      assertExists(daemonState);
      assertEquals(daemonState.key.fingerprint, key.fingerprint);
      assertEquals(daemonState.key.revokedAt, null);

      const authChallengeResponse = await app.request(
        "/api/daemon/v1/auth/challenge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverId, keyId: body.keyId }),
        },
      );
      assertEquals(authChallengeResponse.status, 200);
    },
  );
});

test("POST /auth/session rejects malformed JSON", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    assertEquals(response.status, 400);
    const body = (await response.json()) as { error?: string };
    assertEquals(body.error, "Missing required session fields");
  });
});

test("POST /auth/session rejects missing required fields", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const response = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        keyId,
      }),
    });
    assertEquals(response.status, 400);
    const body = (await response.json()) as { error?: string };
    assertEquals(body.error, "Missing required session fields");
  });
});

test("POST /auth/challenge rejects unknown keyId", async () => {
  await withEnrollFixture(async ({ app, keyId }) => {
    const response = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: crypto.randomUUID(), keyId }),
    });
    assertEquals(response.status, 404);
  });
});

test("POST /auth/challenge rejects mismatched keyId", async () => {
  await withEnrollFixture(async ({ app, serverId }) => {
    const response = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, keyId: crypto.randomUUID() }),
    });
    assertEquals(response.status, 400);
    const body = (await response.json()) as { error?: string };
    assertEquals(body.error, "Server key mismatch");
  });
});

test("POST /auth/challenge rejects revoked daemon key", async () => {
  await withEnrollFixture(async ({ db, app, serverId, keyId }) => {
    await revokeDaemonKey(db, serverId);

    const response = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, keyId }),
    });
    assertEquals(response.status, 400);
    const body = (await response.json()) as { error?: string };
    assertEquals(body.error, "Server key is inactive");
  });
});

test("POST /auth/session rejects expired challenge", async () => {
  await withEnrollFixture(
    async ({ app, serverId, keyId, key, machineKey, hostname }) => {
      const challengeSecrets = await createTestChallengeSecrets();
      const challenge = await issueChallenge(
        challengeSecrets,
        { serverId, keyId },
        60_000,
        Date.now() - 120_000,
      );
      const payload = buildAuthPayload({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        serverId,
        keyId,
        machineKey,
        hostname,
      });
      const signature = await signPayload(key.privateKey, payload);

      const response = await app.request("/api/daemon/v1/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId,
          keyId,
          challengeId: challenge.id,
          signature,
          machineKey,
          hostname,
          at: new Date().toISOString(),
        }),
      });
      assertEquals(response.status, 400);
    },
  );
});

test("POST /auth/session rejects invalid signature", async () => {
  await withEnrollFixture(
    async ({ app, serverId, keyId, machineKey, hostname }) => {
      const challenge = await issueAuthChallenge(app, serverId, keyId);
      const response = await app.request("/api/daemon/v1/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId,
          keyId,
          challengeId: challenge.challengeId,
          signature: "invalid-signature",
          machineKey,
          hostname,
          at: new Date().toISOString(),
        }),
      });
      assertEquals(response.status, 403);
    },
  );
});

test("POST /auth/session returns a 15-minute JWT", async () => {
  await withEnrollFixture(
    async ({ db, serverId, keyId, key, machineKey, hostname }) => {
      const tracking = createSnapshotTrackingCell(serverId);
      const registry: DaemonCellRegistry = {
        getCell: () => tracking.cell,
        listOnlineServerIds: async () => [],
        getSnapshots: async () => new Map(),
        purge: async () => {},
      };
      const app = await createTestAppWithRegistry(db, registry);

      const challenge = await issueAuthChallenge(app, serverId, keyId);
      const payload = buildAuthPayload({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        serverId,
        keyId,
        machineKey,
        hostname,
      });
      const signature = await signPayload(key.privateKey, payload);
      const response = await app.request("/api/daemon/v1/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId,
          keyId,
          challengeId: challenge.challengeId,
          signature,
          machineKey,
          hostname,
          at: new Date().toISOString(),
        }),
      });
      assertEquals(response.status, 200);
      const body = (await response.json()) as { token: string };
      assertExists(body.token);
      const jwtPayload = decodeJwtPayload(body.token);
      assertEquals(jwtPayload.kid, keyId);
      assertEquals(jwtPayload.exp - jwtPayload.iat, 900);
      assert(typeof jwtPayload.jti === "string" && jwtPayload.jti.length > 0);
      assertEquals("sid" in jwtPayload, false);

      await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(tracking.putSnapshotPatches.length, 0);

      const [row] = await db
        .select({ daemon: server.daemon })
        .from(server)
        .where(eq(server.id, serverId))
        .limit(1);
      const daemonState = parseServerDaemonState(row?.daemon);
      assertExists(daemonState?.key.lastUsedAt);
    },
  );
});

test("invalidateLicense revokes daemon keys on bound servers", async () => {
  await withEnrollFixture(
    async ({ db, organizationId, licenseId, serverId }) => {
      const invalidated = await invalidateLicense(
        db,
        licenseId,
        organizationId,
        { force: true },
      );
      assertEquals(invalidated.ok, true);
      if (invalidated.ok) {
        assertEquals(invalidated.serverIds, [serverId]);
      }

      const [row] = await db
        .select({ daemon: server.daemon })
        .from(server)
        .where(eq(server.id, serverId))
        .limit(1);
      const daemonState = parseServerDaemonState(row?.daemon);
      assertExists(daemonState?.key.revokedAt);
    },
  );
});

test("re-enroll is refused when recorded hardware requires a higher tier", async () => {
  await withEnrollFixture(async (fixture) => {
    const original = await readDaemonState(fixture.db, fixture.serverId);
    assertExists(original);
    await mergeServerResources(
      fixture.db,
      fixture.serverId,
      hostResourcesPayload(8, 16),
    );
    const response = await postEnroll(fixture.app, fixture);
    assertEquals(response.status, 400);
    const body = (await response.json()) as { error: string };
    assertEquals(body.error, LICENSE_TIER_BELOW_REQUIRED_ERROR);

    const [licenseRow] = await fixture.db
      .select({ serverId: license.serverId })
      .from(license)
      .where(eq(license.id, fixture.licenseId))
      .limit(1);
    assertEquals(licenseRow?.serverId, fixture.serverId);
    const after = await readDaemonState(fixture.db, fixture.serverId);
    assertEquals(after?.key.id, original.key.id);
    assertEquals(after?.key.fingerprint, original.key.fingerprint);
  });
});

test("fresh enroll with no recorded hardware succeeds", async () => {
  await withEnrollFixture(async ({ enrollBody }) => {
    assertEquals(typeof enrollBody.serverId, "string");
    assertEquals(enrollBody.serverId.length > 0, true);
  });
});

test("hosted enroll is refused when nothing bought covers one more server", async () => {
  await withEnrollFixture(
    async (fixture) => {
      const response = await postEnroll(fixture.app, fixture);
      assertEquals(response.status, 400);
      const body = (await response.json()) as { error: string };
      assertEquals(body.error, LICENSE_TIER_UNASSIGNED_ERROR);
    },
    { tierRank: null, enroll: false },
  );
});

test("a hosted 400 tier refusal does not consume the license so a later retry without server.id can succeed", async () => {
  await withEnrollFixture(
    async (fixture) => {
      const refused = await postEnroll(fixture.app, {
        licenseId: fixture.licenseId,
        licenseToken: fixture.licenseToken,
        machineKey: fixture.machineKey,
        hostname: fixture.hostname,
        key: fixture.key,
      });
      assertEquals(refused.status, 400);
      const refusedBody = (await refused.json()) as { error: string };
      assertEquals(refusedBody.error, LICENSE_TIER_UNASSIGNED_ERROR);

      const [licenseRow] = await fixture.db
        .select({ serverId: license.serverId })
        .from(license)
        .where(eq(license.id, fixture.licenseId))
        .limit(1);
      assertEquals(licenseRow?.serverId, null);
      const orgServers = await fixture.db
        .select({ id: server.id, daemon: server.daemon })
        .from(server)
        .where(eq(server.organizationId, fixture.organizationId));
      assertEquals(orgServers.length, 0);

      // The purchase lands: one S1 seat now covers the newcomer.
      await purchaseTier(fixture.db, fixture, 1, 1);

      const recovered = await postEnroll(fixture.app, {
        licenseId: fixture.licenseId,
        licenseToken: fixture.licenseToken,
        machineKey: fixture.machineKey,
        hostname: fixture.hostname,
        key: fixture.key,
      });
      assertEquals(recovered.status, 200);
      const recoveredBody = (await recovered.json()) as {
        serverId: string;
        keyId: string;
      };
      assertEquals(typeof recoveredBody.serverId, "string");
      assertEquals(recoveredBody.serverId.length > 0, true);
      assertEquals(typeof recoveredBody.keyId, "string");
    },
    { tierRank: null, enroll: false },
  );
});

test("self-hosted enroll assigns SX and issues a session with nothing bought", async () => {
  await withEnrollFixture(
    async (fixture) => {
      assertEquals(typeof fixture.enrollBody.serverId, "string");
      assertEquals(fixture.enrollBody.serverId.length > 0, true);
      const session = await postAuthSession(fixture.app, fixture);
      assertEquals(session.status, 200);
      const [row] = await fixture.db
        .select({ assignedTierId: server.assignedTierId, label: tier.label })
        .from(server)
        .leftJoin(tier, eq(tier.id, server.assignedTierId))
        .where(eq(server.id, fixture.serverId))
        .limit(1);
      assertEquals(row?.label, "SX");
    },
    { runtime: "deno", tierRank: null },
  );
});

test("POST /auth/session refuses after a resize past the license band", async () => {
  await withEnrollFixture(async (fixture) => {
    const first = await postAuthSession(fixture.app, fixture);
    assertEquals(first.status, 200);

    await mergeServerResources(
      fixture.db,
      fixture.serverId,
      hostResourcesPayload(64, 256),
    );
    const refused = await postAuthSession(fixture.app, fixture);
    assertEquals(refused.status, 400);
    const refusedBody = (await refused.json()) as { error: string };
    assertEquals(refusedBody.error, LICENSE_TIER_BELOW_REQUIRED_ERROR);

    // Buying an S5 moves the server onto it (the projection's recompute).
    await purchaseTier(fixture.db, fixture, 5, 1);

    const recovered = await postAuthSession(fixture.app, fixture);
    assertEquals(recovered.status, 200);
  });
});

test("POST /auth/session recomputes a licensed server assigned nothing, and refuses it only when nothing bought covers it", async () => {
  await withEnrollFixture(async (fixture) => {
    // The one S1 given back: the recompute leaves the server on nothing.
    await purchaseTier(fixture.db, fixture, 1, 0);
    const refused = await postAuthSession(fixture.app, fixture);
    assertEquals(refused.status, 400);
    const refusedBody = (await refused.json()) as { error: string };
    assertEquals(refusedBody.error, LICENSE_TIER_BELOW_REQUIRED_ERROR);

    // Bought back — but the projection and this session raced, so the
    // derived column is still empty: the gate's one recompute places it.
    const tierId = await purchaseTier(fixture.db, fixture, 1, 1);
    await fixture.db
      .update(server)
      .set({ assignedTierId: null })
      .where(eq(server.id, fixture.serverId));
    const recovered = await postAuthSession(fixture.app, fixture);
    assertEquals(recovered.status, 200);
    const [row] = await fixture.db
      .select({ assignedTierId: server.assignedTierId })
      .from(server)
      .where(eq(server.id, fixture.serverId))
      .limit(1);
    assertEquals(row?.assignedTierId, tierId);
  });
});

test("a device-count shortfall does not block enroll or session", async () => {
  await withEnrollFixture(async (fixture) => {
    await mergeServerResources(
      fixture.db,
      fixture.serverId,
      hostResourcesPayload(4, 16),
    );
    const session = await postAuthSession(fixture.app, fixture);
    assertEquals(session.status, 200);
  });
});

test("POST /auth/session rejects inactive license", async () => {
  await withEnrollFixture(
    async (
      {
        db,
        app,
        organizationId,
        licenseId,
        serverId,
        keyId,
        key,
        machineKey,
        hostname,
      },
    ) => {
      await revokeLicense(db, licenseId, organizationId);

      const challenge = await issueAuthChallenge(app, serverId, keyId);
      const payload = buildAuthPayload({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        serverId,
        keyId,
        machineKey,
        hostname,
      });
      const signature = await signPayload(key.privateKey, payload);
      const response = await app.request("/api/daemon/v1/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId,
          keyId,
          challengeId: challenge.challengeId,
          signature,
          machineKey,
          hostname,
          at: new Date().toISOString(),
        }),
      });

      assertEquals(response.status, 400);
      const body = (await response.json()) as { error: string };
      assertEquals(body.error, "License is inactive");
    },
  );
});

test("POST /auth/session survives colocated disk-credential recovery for enrolled server", async () => {
  await withEnrollFixture(
    async (
      {
        db,
        app,
        organizationId,
        licenseId,
        serverId,
        keyId,
        key,
        machineKey,
        hostname,
      },
    ) => {
      // Disk-loss recovery path: rename to the colocated seat label, then rotate
      // credentials in place (preserves server_id + daemon key).
      await db
        .update(license)
        .set({
          name: COLOCATED_SERVER_DISPLAY_NAME,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(license.id, licenseId));

      const rotated = await rotateColocatedLicenseCredentials(
        db,
        organizationId,
      );
      assertEquals(rotated.licenseId, licenseId);

      const challenge = await issueAuthChallenge(app, serverId, keyId);
      const payload = buildAuthPayload({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        serverId,
        keyId,
        machineKey,
        hostname,
      });
      const signature = await signPayload(key.privateKey, payload);
      const response = await app.request("/api/daemon/v1/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId,
          keyId,
          challengeId: challenge.challengeId,
          signature,
          machineKey,
          hostname,
          at: new Date().toISOString(),
        }),
      });

      assertEquals(response.status, 200);
      const body = (await response.json()) as { token: string };
      assertExists(body.token);
    },
  );
});

test("Protected route rejects missing JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/commands/lease", {
      method: "POST",
    });
    assertEquals(response.status, 401);
  });
});

test("Protected route rejects invalid JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/commands/lease", {
      method: "POST",
      headers: {
        Authorization: "Bearer not-a-valid-jwt",
      },
    });
    assertEquals(response.status, 401);
  });
});

test("stateless challenge issue and consume round-trip", async () => {
  const secrets = await createTestChallengeSecrets();
  const store = createStatelessChallengeStore(secrets, 60_000);
  const issued = await store.issue({ serverId: "server-1", keyId: "key-1" });
  const consumed = await store.consume({
    challengeId: issued.id,
    serverId: "server-1",
    keyId: "key-1",
  });
  assertExists(consumed);
  assertEquals(consumed?.nonce, issued.nonce);
});

test("stateless challenge consume rejects wrong serverId", async () => {
  const secrets = await createTestChallengeSecrets();
  const store = createStatelessChallengeStore(secrets, 60_000);
  const issued = await store.issue({ serverId: "server-1", keyId: "key-1" });
  const consumed = await store.consume({
    challengeId: issued.id,
    serverId: "other-server",
    keyId: "key-1",
  });
  assertEquals(consumed, null);
});

test("stateless challenge consume rejects expired token", async () => {
  const secrets = await createTestChallengeSecrets();
  const issued = await issueChallenge(
    secrets,
    { serverId: "server-1", keyId: "key-1" },
    60_000,
    Date.now() - 120_000,
  );
  const consumed = await consumeChallenge(
    secrets,
    { challengeId: issued.id, serverId: "server-1", keyId: "key-1" },
    60_000,
  );
  assertEquals(consumed, null);
});

test("stateless challenge allows replay within TTL", async () => {
  // Not single-use: a valid token can be consumed repeatedly until it expires.
  // Security relies on the short TTL plus Ed25519 proof-of-possession at session time.
  const secrets = await createTestChallengeSecrets();
  const store = createStatelessChallengeStore(secrets, 60_000);
  const issued = await store.issue({ serverId: "server-1", keyId: "key-1" });
  const first = await store.consume({
    challengeId: issued.id,
    serverId: "server-1",
    keyId: "key-1",
  });
  const second = await store.consume({
    challengeId: issued.id,
    serverId: "server-1",
    keyId: "key-1",
  });
  assertExists(first);
  assertExists(second);
  assertEquals(second?.nonce, issued.nonce);
});

test("POST /commands/lease returns 401 without JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/commands/lease", {
      method: "POST",
    });
    assertEquals(response.status, 401);
  });
});

test("POST /commands/lease returns 200 with valid JWT", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/commands/lease", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
      },
    });
    assertEquals(response.status, 200);
    const body = (await response.json()) as { commands: unknown[] };
    assertEquals(body, { commands: [] });
  });
});

test("POST /auth/challenge returns 429 when restLimiter denies", async () => {
  const app = new Hono<AppEnv>();
  const secrets = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  registerDaemonApiRoutes(app, {
    secrets,
    challengeSigningSecrets,
    secretsConfig,
    restLimiter: {
      limit: async () => ({ success: false }),
    },
  });

  const response = await app.request("/api/daemon/v1/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serverId: "srv-rate-limit",
      keyId: "key-rate-limit",
    }),
  });
  assertEquals(response.status, 429);
  const body = (await response.json()) as { ok: boolean; error: string };
  assertEquals(body, { ok: false, error: "rate_limited" });
});

test("POST /auth/challenge enrollment path returns 429 when restLimiter denies", async () => {
  const app = new Hono<AppEnv>();
  const secrets = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  registerDaemonApiRoutes(app, {
    secrets,
    challengeSigningSecrets,
    secretsConfig,
    restLimiter: {
      limit: async () => ({ success: false }),
    },
  });

  const response = await app.request("/api/daemon/v1/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(response.status, 429);
  const body = (await response.json()) as { ok: boolean; error: string };
  assertEquals(body, { ok: false, error: "rate_limited" });
});

test("POST /commands/lease returns 429 when restLimiter denies with valid JWT", async () => {
  const app = new Hono<AppEnv>();
  const secrets = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  registerDaemonApiRoutes(app, {
    secrets,
    challengeSigningSecrets,
    secretsConfig,
    restLimiter: {
      limit: async () => ({ success: false }),
    },
  });

  const daemonToken = await issueDaemonToken("srv-lease-rl", "key-lease-rl");
  const response = await app.request("/api/daemon/v1/commands/lease", {
    method: "POST",
    headers: { Authorization: `Bearer ${daemonToken}` },
  });
  assertEquals(response.status, 429);
  const body = (await response.json()) as { ok: boolean; error: string };
  assertEquals(body, { ok: false, error: "rate_limited" });
});

test("POST /commands/lease proceeds when restLimiter allows", async () => {
  const app = new Hono<AppEnv>();
  const secrets = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  let seenKey: string | undefined;
  registerDaemonApiRoutes(app, {
    secrets,
    challengeSigningSecrets,
    secretsConfig,
    restLimiter: {
      limit: async ({ key }) => {
        seenKey = key;
        return { success: true };
      },
    },
  });

  const daemonToken = await issueDaemonToken("srv-lease-ok", "key-lease-ok");
  const response = await app.request("/api/daemon/v1/commands/lease", {
    method: "POST",
    headers: { Authorization: `Bearer ${daemonToken}` },
  });
  assertEquals(response.status, 200);
  assertEquals(seenKey, "daemon:rest:commands-lease:srv-lease-ok");
  const body = (await response.json()) as { commands: unknown[] };
  assertEquals(body, { commands: [] });
});
test("POST /secrets/decrypt returns 401 without JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/secrets/decrypt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ciphertexts: ["tpsecret.v1.x"] }),
    });
    assertEquals(response.status, 401);
  });
});

test("POST /secrets/decrypt returns 400 on malformed body", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);

    const missingArray = await app.request("/api/daemon/v1/secrets/decrypt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assertEquals(missingArray.status, 400);

    const emptyArray = await app.request("/api/daemon/v1/secrets/decrypt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ciphertexts: [] }),
    });
    assertEquals(emptyArray.status, 400);
  });
});

test("POST /secrets/decrypt round-trips batch with mixed valid/invalid", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const secretsConfig = createTestSecretsConfig();
    const sealed = await encryptSecretForDaemon(
      secretsConfig,
      { serverId, keyId },
      "daemon-secret-value",
    );
    const daemonToken = await issueDaemonToken(serverId, keyId);

    const response = await app.request("/api/daemon/v1/secrets/decrypt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ciphertexts: [sealed, "not-a-valid-envelope", sealed],
      }),
    });
    assertEquals(response.status, 200);
    const body = (await response.json()) as { plaintexts: (string | null)[] };
    assertEquals(body.plaintexts.length, 3);
    assertEquals(body.plaintexts[0], "daemon-secret-value");
    assertEquals(body.plaintexts[1], null);
    assertEquals(body.plaintexts[2], "daemon-secret-value");
  });
});

test("POST /secrets/decrypt rejects envelopes sealed for another daemon", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const secretsConfig = createTestSecretsConfig();
    const sealed = await encryptSecretForDaemon(
      secretsConfig,
      { serverId: "00000000-0000-4000-8000-000000000099", keyId: "other-key" },
      "other-daemon-secret",
    );
    const daemonToken = await issueDaemonToken(serverId, keyId);

    const response = await app.request("/api/daemon/v1/secrets/decrypt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ciphertexts: [sealed] }),
    });
    assertEquals(response.status, 200);
    const body = (await response.json()) as { plaintexts: (string | null)[] };
    assertEquals(body.plaintexts, [null]);
  });
});

test("POST /secrets/decrypt rejects global tpsecret envelopes (daemon-scoped only)", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/secrets/decrypt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ciphertexts: ["tpsecret.v1.x"] }),
    });
    assertEquals(response.status, 200);
    const body = (await response.json()) as { plaintexts: (string | null)[] };
    assertEquals(body.plaintexts, [null]);
  });
});

async function createDecryptTestApp(): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>();
  const secrets = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  registerDaemonApiRoutes(app, {
    secrets,
    challengeSigningSecrets,
    secretsConfig,
  });
  return app;
}

test("POST /secrets/decrypt rejects an oversized request body", async () => {
  const app = await createDecryptTestApp();
  const daemonToken = await issueDaemonToken("srv-decrypt-big", "key-big");
  // Body exceeds the byte budget; rejected before JSON parsing.
  const oversized = "x".repeat(MAX_SECRETS_DECRYPT_BODY_BYTES + 128);
  const response = await app.request("/api/daemon/v1/secrets/decrypt", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: oversized,
  });
  assertEquals(response.status, 413);
  const body = (await response.json()) as { ok: boolean; error: string };
  assertEquals(body.ok, false);
});

test("POST /secrets/decrypt rejects an oversized ciphertext string", async () => {
  const app = await createDecryptTestApp();
  const daemonToken = await issueDaemonToken("srv-decrypt-long", "key-long");
  const longCiphertext = "a".repeat(MAX_SECRETS_DECRYPT_CIPHERTEXT_CHARS + 1);
  const response = await app.request("/api/daemon/v1/secrets/decrypt", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ciphertexts: [longCiphertext] }),
  });
  assertEquals(response.status, 400);
  const body = (await response.json()) as { ok: boolean; error: string };
  assertEquals(body.ok, false);
  assert(body.error.includes(`${MAX_SECRETS_DECRYPT_CIPHERTEXT_CHARS}`));
});

test("POST /secrets/decrypt rejects a batch larger than the limit", async () => {
  const app = await createDecryptTestApp();
  const daemonToken = await issueDaemonToken("srv-decrypt-batch", "key-batch");
  const ciphertexts = new Array(MAX_SECRETS_DECRYPT_BATCH + 1).fill(
    "tpsecret.v1.x",
  );
  const response = await app.request("/api/daemon/v1/secrets/decrypt", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ciphertexts }),
  });
  assertEquals(response.status, 400);
  const body = (await response.json()) as { ok: boolean; error: string };
  assertEquals(body.ok, false);
});

test("POST /secrets/decrypt decrypts a normal TLS-sized daemon envelope", async () => {
  const app = await createDecryptTestApp();
  const serverId = "00000000-0000-4000-8000-0000000000aa";
  const keyId = "key-tls-sized";
  const secretsConfig = createTestSecretsConfig();
  // Simulate a TLS private-key PEM (~1.8 KiB) sealed as a daemon envelope.
  const pemBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj".repeat(45);
  const privateKeyPem =
    `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----\n`;
  const sealed = await encryptSecretForDaemon(secretsConfig, {
    serverId,
    keyId,
  }, privateKeyPem);
  assert(sealed.length <= MAX_SECRETS_DECRYPT_CIPHERTEXT_CHARS);
  const daemonToken = await issueDaemonToken(serverId, keyId);

  const response = await app.request("/api/daemon/v1/secrets/decrypt", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ciphertexts: [sealed] }),
  });
  assertEquals(response.status, 200);
  const body = (await response.json()) as { plaintexts: (string | null)[] };
  assertEquals(body.plaintexts.length, 1);
  assertEquals(body.plaintexts[0], privateKeyPem);
});

test("Enrolled daemon can auto-refresh JWT", async () => {
  await withEnrollFixture(
    async ({ app, serverId, keyId, key, machineKey, hostname }) => {
      const secrets = await createTestSecrets();
      const nearExpiryIssued = await issueDaemonJwt(
        { sub: serverId, kid: keyId },
        secrets,
        Date.now() - (15 * 60 * 1000 - 30_000),
      );
      const nearExpiryPayload = decodeJwtPayload(nearExpiryIssued.token);
      const nowBeforeRefresh = Math.floor(Date.now() / 1000);
      const nearExpiryRemaining = nearExpiryPayload.exp - nowBeforeRefresh;
      assert(
        nearExpiryRemaining <= 60,
        `expected near-expiry token to have <= 60s left, got ${nearExpiryRemaining}s`,
      );

      const challenge = await issueAuthChallenge(app, serverId, keyId);
      const payload = buildAuthPayload({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        serverId,
        keyId,
        machineKey,
        hostname,
      });
      const signature = await signPayload(key.privateKey, payload);
      const response = await app.request("/api/daemon/v1/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId,
          keyId,
          challengeId: challenge.challengeId,
          signature,
          machineKey,
          hostname,
          at: new Date().toISOString(),
        }),
      });
      assertEquals(response.status, 200);
      const body = (await response.json()) as { token: string };
      const refreshedPayload = decodeJwtPayload(body.token);
      const nowAfterRefresh = Math.floor(Date.now() / 1000);
      const refreshedRemaining = refreshedPayload.exp - nowAfterRefresh;
      assert(
        refreshedRemaining > 14 * 60,
        `expected refreshed token to have > 14 minutes left, got ${refreshedRemaining}s`,
      );
      assert(
        refreshedPayload.exp > nearExpiryPayload.exp + 10 * 60,
        "expected refresh token to meaningfully extend expiry over near-expiry token",
      );
      assert(
        refreshedPayload.iat >= nearExpiryPayload.iat,
        "expected refreshed token to be newly issued",
      );
    },
  );
});

/** Empty group — every numeric field absent, which the v5 validator treats as `null`. */
function emptyHostGroup(): Record<string, never> {
  return {};
}

function buildValidMetricsFrame(
  overrides: Record<string, unknown> & { metadata?: Record<string, unknown> } =
    {},
): Record<string, unknown> {
  const { metadata: metadataOverrides, ...topOverrides } = overrides;
  return {
    type: "metrics",
    metadata: {
      version: METRICS_SCHEMA_VERSION,
      sampledAt: new Date().toISOString(),
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 0,
      bootGeneration: 0,
      ...metadataOverrides,
    },
    host: {
      cpu: emptyHostGroup(),
      kernel: emptyHostGroup(),
      memory: emptyHostGroup(),
      storage: emptyHostGroup(),
      network: emptyHostGroup(),
    },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
    ...topOverrides,
  };
}

async function createMetricsTestApp(
  options: {
    runtime?: "workers" | "deno";
    restLimiter?: {
      limit: (input: { key: string }) => Promise<{ success: boolean }>;
    };
    metricsLimiter?: {
      limit: (input: { key: string }) => Promise<{ success: boolean }>;
    };
  } = {},
): Promise<{
  app: Hono<AppEnv>;
  writes: AuthenticatedMetricsSample[];
}> {
  if (options.runtime === "deno") {
    resetDenoMetricsChartCacheForTests();
  }
  const writes: AuthenticatedMetricsSample[] = [];
  const fakeStore: ServerMetricsStore = {
    writeSample(sample) {
      writes.push(sample);
    },
    writeStatusEvent() {
      // no-op
    },
  };

  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("serverMetricsStore", fakeStore);
    return next();
  });
  const secrets = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  registerDaemonApiRoutes(app, {
    secrets,
    challengeSigningSecrets,
    secretsConfig,
    runtime: options.runtime,
    restLimiter: options.restLimiter,
    metricsLimiter: options.metricsLimiter,
  });
  return { app, writes };
}

/**
 * Same shape as {@link createMetricsTestApp}, but wires a real
 * `CloudflareAnalyticsEngineServerMetricsStore` (the same class Workers
 * production wiring uses — see `workers.ts`) over a fake in-memory AE
 * dataset, instead of a hand-rolled fake `ServerMetricsStore`. Exercises the
 * ingest route's `store.writeSample(sample, slotMapping)` call all the way
 * through `buildMetricsDataPoints` so a regression that silently drops
 * entity families or `sample.events` (e.g. reintroducing a v3 projection
 * bridge in front of the real store) shows up as missing `points` here.
 */
async function createMetricsTestAppWithRealCloudflareStore(): Promise<{
  app: Hono<AppEnv>;
  points: AnalyticsEngineDataPointLike[];
}> {
  const points: AnalyticsEngineDataPointLike[] = [];
  const fakeDataset: AnalyticsEngineDatasetLike = {
    writeDataPoint(event) {
      points.push(event as AnalyticsEngineDataPointLike);
    },
  };
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fakeDataset);

  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("serverMetricsStore", store);
    return next();
  });
  const secrets = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  registerDaemonApiRoutes(app, {
    secrets,
    challengeSigningSecrets,
    secretsConfig,
  });
  return { app, points };
}

/**
 * Same shape as {@link createMetricsTestApp}, but with a real `db` in
 * context — `requireActiveDaemonKey` then performs its real DB-backed check
 * instead of short-circuiting, so this must be used with a server/key
 * enrolled via {@link withEnrollFixture} against the same `db`. Exercises the
 * ingest route's real capability-plan resolution and topology reconciliation
 * (`resolveIngestPlanAndReconcileTopology` in `api-routes.ts`) against actual
 * persisted state, rather than the always-default-plan path the db-less
 * `createMetricsTestApp` takes.
 */
async function createMetricsTestAppWithDb(
  db: ReturnType<typeof createDenoDb>,
  options: {
    registry?: DaemonCellRegistry;
    runtime?: "workers" | "deno";
  } = {},
): Promise<{
  app: Hono<AppEnv>;
  writes: AuthenticatedMetricsSample[];
  slotMappings: (SlotMapping | undefined)[];
}> {
  const writes: AuthenticatedMetricsSample[] = [];
  const slotMappings: (SlotMapping | undefined)[] = [];
  const fakeStore: ServerMetricsStore = {
    writeSample(sample, slotMapping) {
      writes.push(sample);
      slotMappings.push(slotMapping);
    },
    writeStatusEvent() {
      // no-op
    },
  };

  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("serverMetricsStore", fakeStore);
    if (options.registry) c.set("daemonCellRegistry", options.registry);
    return next();
  });
  const secrets = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  registerDaemonApiRoutes(app, {
    secrets,
    challengeSigningSecrets,
    secretsConfig,
    runtime: options.runtime,
  });
  return { app, writes, slotMappings };
}

/**
 * Polls `check` until it returns `true` or `timeoutMs` elapses — needed to
 * observe a fire-and-forget DB write (e.g. `topologyResyncRequestedAt`)
 * whose completion the request handler deliberately does not await.
 */
async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs = 2000,
  intervalMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return await check();
}

async function readServerMetadata(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1);
  const metadata = row?.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

test("POST /metrics accepts valid frame and writes sample", async () => {
  const { app, writes } = await createMetricsTestApp();
  const serverId = "srv-metrics-ok";
  const daemonToken = await issueDaemonToken(serverId, "key-metrics-ok");
  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildValidMetricsFrame()),
  });
  assertEquals(response.status, 202);
  assertEquals(await response.json(), { ok: true });
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.serverId, serverId);
});

test("POST /metrics accepts a non-empty current-shape host sample the daemon actually emits", async () => {
  const { app, writes } = await createMetricsTestApp();
  const serverId = "srv-metrics-v6-shape";
  const daemonToken = await issueDaemonToken(serverId, "key-metrics-v6-shape");
  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      buildValidMetricsFrame({
        host: {
          cpu: { saturatedCoreCount: 2 },
          kernel: emptyHostGroup(),
          memory: { usedBytes: 1_000_000, cachedFilesBytes: 250_000 },
          storage: { diskLatencyMs: 1.8 },
          network: emptyHostGroup(),
        },
      }),
    ),
  });
  assertEquals(response.status, 202);
  assertEquals(await response.json(), { ok: true });
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.serverId, serverId);
  assertEquals(writes[0]?.host.cpu.saturatedCoreCount, 2);
  assertEquals(writes[0]?.host.memory.usedBytes, 1_000_000);
  assertEquals(writes[0]?.host.memory.cachedFilesBytes, 250_000);
  assertEquals(writes[0]?.host.storage.diskLatencyMs, 1.8);
});

test("POST /metrics rejects invalid frame without writing", async () => {
  const { app, writes } = await createMetricsTestApp();
  const daemonToken = await issueDaemonToken(
    "srv-metrics-bad",
    "key-metrics-bad",
  );
  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildValidMetricsFrame({ metadata: { version: 99 } })),
  });
  assertEquals(response.status, 400);
  const body = (await response.json()) as { ok: boolean; error: string };
  assertEquals(body.ok, false);
  assertExists(body.error);
  assertEquals(writes.length, 0);
});

test("POST /metrics returns 401 without JWT", async () => {
  const { app, writes } = await createMetricsTestApp();
  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildValidMetricsFrame()),
  });
  assertEquals(response.status, 401);
  assertEquals(writes.length, 0);
});

test("POST /metrics returns 429 when metricsLimiter denies with valid JWT", async () => {
  const { app, writes } = await createMetricsTestApp({
    metricsLimiter: {
      limit: async () => ({ success: false }),
    },
  });
  const daemonToken = await issueDaemonToken(
    "srv-metrics-rl",
    "key-metrics-rl",
  );
  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildValidMetricsFrame()),
  });
  assertEquals(response.status, 429);
  assertEquals(await response.json(), { ok: false, error: "rate_limited" });
  assertEquals(writes.length, 0);
});

test("POST /metrics rejects an unrecognized top-level field (e.g. body-supplied serverId)", async () => {
  const { app, writes } = await createMetricsTestApp();
  const daemonToken = await issueDaemonToken(
    "srv-metrics-auth",
    "key-metrics-auth",
  );
  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildValidMetricsFrame({ serverId: "attacker" })),
  });
  assertEquals(response.status, 400);
  assertEquals(writes.length, 0);
});

test("POST /metrics truncates entity arrays to the resolved capability plan", async () => {
  const { app, writes } = await createMetricsTestApp();
  const serverId = "srv-metrics-plan";
  const daemonToken = await issueDaemonToken(serverId, "key-metrics-plan");
  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      buildValidMetricsFrame({
        // Default (virtual) plan: gpuSlots=1, detailedBlockDeviceSlots=1,
        // extraFilesystemSlots=0, physicalHardwareSignalSlots=0.
        gpus: [{ gpuId: "gpu0" }, { gpuId: "gpu1" }],
        blockDevices: [{ deviceId: "sda" }],
        filesystems: [{ filesystemId: "fs0" }],
        hardwareSignals: [{ signalId: "sig0", kind: "fan" }],
      }),
    ),
  });
  assertEquals(response.status, 202);
  assertEquals(writes.length, 1);
  const sample = writes[0];
  assertEquals(sample?.gpus.length, 1);
  assertEquals(sample?.gpus[0]?.gpuId, "gpu0");
  assertEquals(sample?.blockDevices.length, 1);
  assertEquals(sample?.blockDevices[0]?.deviceId, "sda");
  assertEquals(sample?.filesystems, []);
  assertEquals(sample?.hardwareSignals, []);
});

test("POST /metrics on self-hosted skips capability-plan truncation", async () => {
  const { app, writes } = await createMetricsTestApp({ runtime: "deno" });
  const serverId = "srv-metrics-self-hosted";
  const daemonToken = await issueDaemonToken(
    serverId,
    "key-metrics-self-hosted",
  );
  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      buildValidMetricsFrame({
        gpus: [{ gpuId: "gpu0" }, { gpuId: "gpu1" }],
        filesystems: [{ filesystemId: "fs0" }, { filesystemId: "fs1" }],
        hardwareSignals: [
          { signalId: "sig0", kind: "fan" },
          { signalId: "sig1", kind: "temp" },
        ],
      }),
    ),
  });
  assertEquals(response.status, 202);
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.gpus.length, 2);
  assertEquals(writes[0]?.filesystems.length, 2);
  assertEquals(writes[0]?.hardwareSignals.length, 2);
});

test("POST /metrics buffers a live-session sample instead of writing the store", async () => {
  const { app, writes } = await createMetricsTestApp({ runtime: "deno" });
  const serverId = "srv-metrics-live-buffer";
  const cache = createMetricsChartCache("deno");
  await markServerLiveSessionActive(cache, serverId, "lease-live-buffer", 3600);
  const daemonToken = await issueDaemonToken(
    serverId,
    "key-metrics-live-buffer",
  );
  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      buildValidMetricsFrame({
        metadata: { intervalSeconds: 10 },
        host: {
          cpu: { busyPercent: 81 },
          kernel: emptyHostGroup(),
          memory: emptyHostGroup(),
          storage: emptyHostGroup(),
          network: emptyHostGroup(),
        },
      }),
    ),
  });
  assertEquals(response.status, 202);
  assertEquals(writes.length, 0);
  const buffered = await readLiveSample(cache, serverId);
  assertEquals(buffered?.serverId, serverId);
  assertEquals(buffered?.host.cpu.busyPercent, 81);
});

test("POST /metrics refuses a 10 s sample without a live-session marker", async () => {
  const { app, writes } = await createMetricsTestApp();
  const serverId = "srv-metrics-unmarked-live";
  const daemonToken = await issueDaemonToken(
    serverId,
    "key-metrics-unmarked-live",
  );
  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      buildValidMetricsFrame({ metadata: { intervalSeconds: 10 } }),
    ),
  });
  assertEquals(response.status, 202);
  assertEquals(writes.length, 0);
});

test("POST /metrics still writes priming and baseline intervals without a live-session marker", async () => {
  const { app, writes } = await createMetricsTestApp();
  for (const intervalSeconds of [2, 60]) {
    const serverId = `srv-metrics-interval-${intervalSeconds}`;
    const daemonToken = await issueDaemonToken(
      serverId,
      `key-metrics-interval-${intervalSeconds}`,
    );
    const response = await app.request("/api/daemon/v1/metrics", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildValidMetricsFrame({ metadata: { intervalSeconds } }),
      ),
    });
    assertEquals(response.status, 202);
  }
  assertEquals(writes.length, 2);
});

test("POST /metrics through a real CloudflareAnalyticsEngineServerMetricsStore: entity families and events all land as AE rows, ingress sources keyed by sourceId", async () => {
  const { app, points } = await createMetricsTestAppWithRealCloudflareStore();
  const serverId = "srv-metrics-cf-real";
  const daemonToken = await issueDaemonToken(serverId, "key-metrics-cf-real");
  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      buildValidMetricsFrame({
        // Default hosted (virtual) plan: normalNicSlots=2 — with no recorded
        // topology the first two embed into host.io positionally and eth2 is
        // dropped by the plan before it reaches the store; gpuSlots=1,
        // managedIngress/databaseProxy/events enabled.
        networks: [{ deviceId: "eth0" }, { deviceId: "eth1" }, {
          deviceId: "eth2",
        }],
        gpus: [{ gpuId: "gpu0" }],
        ingressSources: [
          { sourceId: "caddy-1", sourceKind: "caddy" },
          { sourceId: "caddy-2", sourceKind: "caddy" },
        ],
        databaseProxies: [{ sourceId: "proxysql-1", sourceKind: "proxysql" }],
        events: [
          {
            eventId: "evt-1",
            at: new Date().toISOString(),
            kind: "nic_link_down",
            severity: "warning",
          },
        ],
      }),
    ),
  });
  assertEquals(response.status, 202);

  // A regression that bridges writeSample onto a v3 projection (dropping
  // every v5-only family) would produce none of these rows.
  const family = (kind: string) =>
    points.filter((p) => p.blobs[AE_BLOB_FAMILY_INDEX] === kind);
  assertEquals(family("host.system").length, 1);
  assertEquals(family("host.io").length, 1);
  assertEquals(family("network").length, 0); // eth0/eth1 embed; eth2 exceeds the 2-slot hosted plan
  assertEquals(family("gpu").length, 1);

  const ingressRows = family("managed.ingress");
  assertEquals(ingressRows.length, 2);
  const ingressIds = ingressRows.map((p) =>
    p.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX]
  ).sort();
  // Two sources sharing sourceKind "caddy" stay distinct rows keyed by sourceId.
  assertEquals(ingressIds, ["caddy-1", "caddy-2"]);

  const proxyRows = family("managed.database_proxy");
  assertEquals(proxyRows.length, 1);
  assertEquals(
    proxyRows[0]!.blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX],
    "proxysql-1",
  );

  const eventRows = points.filter((p) =>
    p.blobs[AE_BLOB_KIND_INDEX] === "event"
  );
  assertEquals(eventRows.length, 1);
});

test("POST /metrics does not await the store write before responding", async () => {
  const daemonToken = await issueDaemonToken(
    "srv-metrics-fire-and-forget",
    "key-metrics-fire-and-forget",
  );

  let releaseWrite: () => void = () => {};
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let writeSettled = false;
  const writes: AuthenticatedMetricsSample[] = [];
  const fakeStore: ServerMetricsStore = {
    async writeSample(sample) {
      await writeGate;
      writeSettled = true;
      writes.push(sample);
    },
    writeStatusEvent() {
      // no-op
    },
  };

  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("serverMetricsStore", fakeStore);
    return next();
  });
  registerDaemonApiRoutes(app, {
    secrets: await createTestSecrets(),
    challengeSigningSecrets: await createTestChallengeSecrets(),
    secretsConfig: createTestSecretsConfig(),
  });

  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildValidMetricsFrame()),
  });

  assertEquals(response.status, 202);
  assertEquals(
    writeSettled,
    false,
    "expected the response to resolve before the pending store write settled",
  );

  releaseWrite();
  await waitForCondition(() => Promise.resolve(writes.length === 1));
  assertEquals(writes.length, 1);
});

test("POST /metrics accepts a known topology generation without requesting a resync", async () => {
  await withEnrollFixture(async ({ db, serverId, keyId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 0,
      bootGeneration: 0,
      snapshot: { hardwareSignals: [] },
      appliedAt: new Date().toISOString(),
    });

    const { app, writes } = await createMetricsTestAppWithDb(db);
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/metrics", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      // Default frame reports metadata.topologyGeneration: 0 — matches the
      // generation just recorded above.
      body: JSON.stringify(buildValidMetricsFrame()),
    });
    assertEquals(response.status, 202);
    assertEquals(writes.length, 1);

    // Give any (unexpected) fire-and-forget marker write a chance to land,
    // then confirm a known generation never requested one.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const metadata = await readServerMetadata(db, serverId);
    assertEquals(metadata.topologyResyncRequestedAt, undefined);
  });
});

test("POST /metrics resolves a SlotMapping from a full recorded topology snapshot", async () => {
  await withEnrollFixture(async ({ db, serverId, keyId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 0,
      bootGeneration: 0,
      snapshot: {
        networks: [
          { deviceId: "eth0", kind: "uplink", name: "eth0", identity: {} },
          { deviceId: "eth1", kind: "uplink", name: "eth1", identity: {} },
          {
            deviceId: "fabric0",
            kind: "fabric",
            name: "fabric0",
            identity: {},
          },
        ],
        filesystems: [],
        blockDevices: [],
        gpus: [],
        hardwareSignals: [],
      },
      appliedAt: new Date().toISOString(),
    });

    const { app, writes, slotMappings } = await createMetricsTestAppWithDb(db);
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/metrics", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildValidMetricsFrame()),
    });
    assertEquals(response.status, 202);
    assertEquals(writes.length, 1);
    assertEquals(slotMappings.length, 1);
    // No operator list and no default-route flag: auto selection monitors
    // only the first uplink by sorted id — eth1 stays unmonitored.
    assertEquals(slotMappings[0], {
      normalNicSlots: ["eth0"],
      fabricDeviceIds: ["fabric0"],
      rootFilesystemId: null,
      gpuPageOrder: [],
      blockPageOrder: [],
      filesystemPageOrder: [],
      hardwareSignalPageOrder: [],
    });
  });
});

test("POST /metrics accepts an unknown topology generation and requests a resync", async () => {
  await withEnrollFixture(async ({ db, serverId, keyId }) => {
    // No topology generation ever recorded for this server — the daemon's
    // reported generation is unknown.
    const { app, writes } = await createMetricsTestAppWithDb(db);
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/metrics", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildValidMetricsFrame({
          metadata: { topologyGeneration: 7 },
        }),
      ),
    });
    assertEquals(response.status, 202);
    assertEquals(writes.length, 1);

    const requested = await waitForCondition(async () => {
      const metadata = await readServerMetadata(db, serverId);
      return typeof metadata.topologyResyncRequestedAt === "string";
    });
    assert(
      requested,
      "expected an unknown topology generation to stamp topologyResyncRequestedAt",
    );
  });
});

test("POST /metrics retains hardwareSignals for a server classified physical from its topology", async () => {
  await withEnrollFixture(async ({ db, serverId, keyId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 0,
      bootGeneration: 0,
      // Non-empty hardwareSignals is what infers the server physical while
      // `server.machine_class` is NULL — see `resolveServerMachineClass`.
      snapshot: { hardwareSignals: [{ signalId: "board-fan" }] },
      appliedAt: new Date().toISOString(),
    });

    const { app, writes } = await createMetricsTestAppWithDb(db);
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/metrics", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildValidMetricsFrame({
          hardwareSignals: [{ signalId: "sig0", kind: "fan" }],
        }),
      ),
    });
    assertEquals(response.status, 202);
    assertEquals(writes.length, 1);
    assertEquals(writes[0]?.hardwareSignals.length, 1);
    assertEquals(writes[0]?.hardwareSignals[0]?.signalId, "sig0");
  });
});

/** The `machine_class` write-back is fire-and-forget; poll briefly for it. */
async function readMachineClassSettled(
  db: Parameters<typeof recordTopologyGeneration>[0],
  serverId: string,
  expected: string | null,
): Promise<string | null> {
  let value: string | null = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const [row] = await db
      .select({ machineClass: server.machineClass })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1);
    value = row?.machineClass ?? null;
    if (value === expected) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return value;
}

test("POST /metrics writes machine_class=physical back once topology proves it, only while undeclared", async () => {
  await withEnrollFixture(async ({ db, serverId, keyId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 0,
      bootGeneration: 0,
      snapshot: { hardwareSignals: [{ signalId: "board-fan" }] },
      appliedAt: new Date().toISOString(),
    });
    const [before] = await db
      .select({ machineClass: server.machineClass })
      .from(server)
      .where(eq(server.id, serverId));
    assertEquals(before?.machineClass ?? null, null);

    const { app, writes } = await createMetricsTestAppWithDb(db);
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/metrics", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildValidMetricsFrame({
          hardwareSignals: [{ signalId: "sig0", kind: "fan" }],
        }),
      ),
    });
    assertEquals(response.status, 202);
    assertEquals(writes[0]?.hardwareSignals.length, 1);
    assertEquals(
      await readMachineClassSettled(db, serverId, "physical"),
      "physical",
    );
  });
});

test("POST /metrics never writes machine_class=virtual back — absence of sensors is not proof", async () => {
  await withEnrollFixture(async ({ db, serverId, keyId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 0,
      bootGeneration: 0,
      snapshot: { hardwareSignals: [] },
      appliedAt: new Date().toISOString(),
    });

    const { app, writes } = await createMetricsTestAppWithDb(db);
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/metrics", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildValidMetricsFrame({
          hardwareSignals: [{ signalId: "sig0", kind: "fan" }],
        }),
      ),
    });
    assertEquals(response.status, 202);
    // Inferred virtual → signals truncated, but the column stays NULL so a
    // later topology generation that discovers sensors can still promote it.
    assertEquals(writes[0]?.hardwareSignals, []);
    assertEquals(await readMachineClassSettled(db, serverId, "physical"), null);
  });
});

test("POST /metrics: a declared machine_class=virtual beats a topology that carries sensors", async () => {
  await withEnrollFixture(async ({ db, serverId, keyId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 0,
      bootGeneration: 0,
      snapshot: { hardwareSignals: [{ signalId: "bogus-thermal-zone" }] },
      appliedAt: new Date().toISOString(),
    });
    await db.update(server).set({ machineClass: "virtual" }).where(
      eq(server.id, serverId),
    );

    const { app, writes } = await createMetricsTestAppWithDb(db);
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/metrics", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildValidMetricsFrame({
          hardwareSignals: [{ signalId: "sig0", kind: "fan" }],
        }),
      ),
    });
    assertEquals(response.status, 202);
    assertEquals(writes[0]?.hardwareSignals, []);
    assertEquals(
      await readMachineClassSettled(db, serverId, "virtual"),
      "virtual",
    );
  });
});

test("POST /metrics: a declared machine_class=physical retains sensors with no topology recorded", async () => {
  await withEnrollFixture(async ({ db, serverId, keyId }) => {
    await db.update(server).set({ machineClass: "physical" }).where(
      eq(server.id, serverId),
    );

    const { app, writes } = await createMetricsTestAppWithDb(db);
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/metrics", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildValidMetricsFrame({ hardwareSignals: [] })),
    });
    assertEquals(response.status, 202);
    assertEquals(writes.length, 1);
    // No sample signals and no topology would infer virtual; the pin wins.
    assertEquals(
      await readMachineClassSettled(db, serverId, "physical"),
      "physical",
    );
  });
});

test("POST /metrics truncates hardwareSignals when the org overrides physicalHardwareSignalSlots to 0", async () => {
  await withEnrollFixture(async ({ db, organizationId, serverId, keyId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 0,
      bootGeneration: 0,
      snapshot: { hardwareSignals: [{ signalId: "board-fan" }] },
      appliedAt: new Date().toISOString(),
    });
    await db
      .update(organization)
      .set({
        options: { metricsCapabilityPlan: { physicalHardwareSignalSlots: 0 } },
      })
      .where(eq(organization.id, organizationId));

    const { app, writes } = await createMetricsTestAppWithDb(db);
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/metrics", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildValidMetricsFrame({
          hardwareSignals: [{ signalId: "sig0", kind: "fan" }],
        }),
      ),
    });
    assertEquals(response.status, 202);
    assertEquals(writes.length, 1);
    assertEquals(writes[0]?.hardwareSignals, []);
  });
});

test("POST /metrics truncates hardwareSignals when a server override wins over an org override", async () => {
  await withEnrollFixture(async ({ db, organizationId, serverId, keyId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 0,
      bootGeneration: 0,
      snapshot: { hardwareSignals: [{ signalId: "board-fan" }] },
      appliedAt: new Date().toISOString(),
    });
    // Org grants signals; the per-server override still wins and truncates.
    await db
      .update(organization)
      .set({
        options: { metricsCapabilityPlan: { physicalHardwareSignalSlots: 19 } },
      })
      .where(eq(organization.id, organizationId));
    await db
      .update(server)
      .set({
        options: { metricsCapabilityPlan: { physicalHardwareSignalSlots: 0 } },
      })
      .where(eq(server.id, serverId));

    const { app, writes } = await createMetricsTestAppWithDb(db);
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/metrics", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildValidMetricsFrame({
          hardwareSignals: [{ signalId: "sig0", kind: "fan" }],
        }),
      ),
    });
    assertEquals(response.status, 202);
    assertEquals(writes.length, 1);
    assertEquals(writes[0]?.hardwareSignals, []);
  });
});

test("POST /metrics enqueues capability-plan-update when hosted ingest bumps the plan generation", async () => {
  await withEnrollFixture(async ({ db, organizationId, serverId, keyId }) => {
    assertEquals(
      await waitForCondition(async () =>
        (await getLatestCapabilityPlanGeneration(db, serverId)) !== undefined
      ),
      true,
    );
    const primed = await getLatestCapabilityPlanGeneration(db, serverId);
    assertExists(primed);

    await db
      .update(organization)
      .set({
        options: { metricsCapabilityPlan: { extraFilesystemSlots: 3 } },
      })
      .where(eq(organization.id, organizationId));

    const { registry, enqueued } = createEnqueueTrackingRegistry();
    const { app } = await createMetricsTestAppWithDb(db, { registry });
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/metrics", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildValidMetricsFrame()),
    });
    assertEquals(response.status, 202);
    assertEquals(
      await waitForCondition(() =>
        Promise.resolve(
          enqueued.some((envelope) =>
            envelope.kind === "capability-plan-update"
          ),
        )
      ),
      true,
    );
    const update = enqueued.find((envelope) =>
      envelope.kind === "capability-plan-update"
    );
    if (update?.kind !== "capability-plan-update") {
      throw new TypeError("expected capability-plan-update envelope");
    }
    assertEquals(update.generation, primed.generation + 1);
    assertEquals(update.plan.extraFilesystemSlots, 3);
  });
});

test("POST /enroll and POST /metrics do not enqueue capability-plan-update for self-hosted", async () => {
  await withEnrollFixture(
    async ({ db, licenseId, licenseToken, machineKey, hostname, key }) => {
      const enrollTracking = createEnqueueTrackingRegistry();
      const enrollApp = await createTestAppWithRegistry(
        db,
        enrollTracking.registry,
        "deno",
      );
      const enrollResponse = await postEnroll(enrollApp, {
        licenseId,
        licenseToken,
        machineKey,
        hostname,
        key,
      });
      assertEquals(enrollResponse.status, 200);
      const enrollBody = (await enrollResponse.json()) as {
        serverId: string;
        keyId: string;
      };
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(
        enrollTracking.enqueued.some((envelope) =>
          envelope.kind === "capability-plan-update"
        ),
        false,
      );

      const ingestTracking = createEnqueueTrackingRegistry();
      const { app } = await createMetricsTestAppWithDb(db, {
        registry: ingestTracking.registry,
        runtime: "deno",
      });
      const daemonToken = await issueDaemonToken(
        enrollBody.serverId,
        enrollBody.keyId,
      );
      const response = await app.request("/api/daemon/v1/metrics", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${daemonToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildValidMetricsFrame()),
      });
      assertEquals(response.status, 202);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(
        ingestTracking.enqueued.some((envelope) =>
          envelope.kind === "capability-plan-update"
        ),
        false,
      );
      assertEquals(
        await getLatestCapabilityPlanGeneration(db, enrollBody.serverId),
        undefined,
      );
    },
    { runtime: "deno", enroll: false },
  );
});

test("POST /enroll primes capability-plan-update on hosted runtime", async () => {
  await withEnrollFixture(
    async ({ db, licenseId, licenseToken, machineKey, hostname, key }) => {
      const tracking = createEnqueueTrackingRegistry();
      const enrollApp = await createTestAppWithRegistry(db, tracking.registry);
      const enrollResponse = await postEnroll(enrollApp, {
        licenseId,
        licenseToken,
        machineKey,
        hostname,
        key,
      });
      assertEquals(enrollResponse.status, 200);
      const enrollBody = (await enrollResponse.json()) as { serverId: string };
      assertEquals(
        await waitForCondition(() =>
          Promise.resolve(
            tracking.enqueued.some((envelope) =>
              envelope.kind === "capability-plan-update"
            ),
          )
        ),
        true,
      );
      const primed = await getLatestCapabilityPlanGeneration(
        db,
        enrollBody.serverId,
      );
      assertExists(primed);
      assertEquals(typeof primed.generation, "number");
    },
    { enroll: false },
  );
});

test("POST /enroll still returns 200 when capability-plan prime fails", async () => {
  await withEnrollFixture(
    async ({ db, licenseId, licenseToken, machineKey, hostname, key }) => {
      const tracking = createEnqueueTrackingRegistry();
      const brokenRegistry: DaemonCellRegistry = {
        ...tracking.registry,
        getCell: () => {
          const cell = tracking.registry.getCell("track");
          return {
            ...cell,
            enqueue: () => Promise.reject(new TypeError("outbox down")),
          };
        },
      };
      const enrollApp = await createTestAppWithRegistry(db, brokenRegistry);
      const enrollResponse = await postEnroll(enrollApp, {
        licenseId,
        licenseToken,
        machineKey,
        hostname,
        key,
      });
      assertEquals(enrollResponse.status, 200);
      const enrollBody = (await enrollResponse.json()) as {
        serverId?: unknown;
        keyId?: unknown;
      };
      if (typeof enrollBody.serverId !== "string") {
        throw new TypeError("expected enroll serverId");
      }
      if (typeof enrollBody.keyId !== "string") {
        throw new TypeError("expected enroll keyId");
      }
    },
    { enroll: false },
  );
});

test("POST /metrics rejects an oversized request body", async () => {
  const { app, writes } = await createMetricsTestApp();
  const daemonToken = await issueDaemonToken(
    "srv-metrics-big",
    "key-metrics-big",
  );
  const oversized = "x".repeat(MAX_METRICS_PAYLOAD_BYTES + 64);
  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
      "Content-Length": String(oversized.length),
    },
    body: oversized,
  });
  assertEquals(response.status, 413);
  assertEquals(writes.length, 0);
});

test("POST /auth/challenge rejects an oversized request body", async () => {
  const app = await createDecryptTestApp();
  const oversized = "x".repeat(MAX_AUTH_CHALLENGE_BODY_BYTES + 64);
  const response = await app.request("/api/daemon/v1/auth/challenge", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(oversized.length),
    },
    body: oversized,
  });
  assertEquals(response.status, 413);
});

test("POST /enroll rejects an oversized request body", async () => {
  await withEnrollFixture(async ({ app }) => {
    const oversized = "x".repeat(MAX_ENROLL_BODY_BYTES + 64);
    const response = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(oversized.length),
      },
      body: oversized,
    });
    assertEquals(response.status, 413);
  });
});

test("POST /auth/session rejects an oversized request body", async () => {
  await withEnrollFixture(async ({ app }) => {
    const oversized = "x".repeat(MAX_AUTH_SESSION_BODY_BYTES + 64);
    const response = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(oversized.length),
      },
      body: oversized,
    });
    assertEquals(response.status, 413);
  });
});

/** Chunked body so Fetch does not attach a truthful Content-Length. */
function oversizedBodyStream(byteLength: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(Math.min(byteLength, 8192));
  chunk.fill(0x78);
  let remaining = byteLength;
  return new ReadableStream({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const n = Math.min(remaining, chunk.byteLength);
      controller.enqueue(chunk.subarray(0, n));
      remaining -= n;
    },
  });
}

test("POST /auth/challenge rejects an oversized body without Content-Length", async () => {
  const app = await createDecryptTestApp();
  const response = await app.request("/api/daemon/v1/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: oversizedBodyStream(MAX_AUTH_CHALLENGE_BODY_BYTES + 1),
  });
  assertEquals(response.status, 413);
});

test("POST /enroll rejects an oversized body without Content-Length", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBodyStream(MAX_ENROLL_BODY_BYTES + 1),
    });
    assertEquals(response.status, 413);
  });
});

test("POST /auth/session rejects an oversized body without Content-Length", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBodyStream(MAX_AUTH_SESSION_BODY_BYTES + 1),
    });
    assertEquals(response.status, 413);
  });
});

test("POST /metrics rejects an oversized body without Content-Length", async () => {
  const { app, writes } = await createMetricsTestApp();
  const daemonToken = await issueDaemonToken(
    "srv-metrics-stream",
    "key-metrics-stream",
  );
  const response = await app.request("/api/daemon/v1/metrics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemonToken}`,
      "Content-Type": "application/json",
    },
    body: oversizedBodyStream(MAX_METRICS_PAYLOAD_BYTES + 1),
  });
  assertEquals(response.status, 413);
  assertEquals(writes.length, 0);
});

test("POST /metrics rejects JWT after license invalidation", async () => {
  await withEnrollFixture(
    async ({ app, db, organizationId, licenseId, serverId, keyId }) => {
      const daemonToken = await issueDaemonToken(serverId, keyId);
      const before = await app.request("/api/daemon/v1/metrics", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${daemonToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildValidMetricsFrame()),
      });
      assertEquals(before.status, 202);

      const invalidated = await invalidateLicense(
        db,
        licenseId,
        organizationId,
        { force: true },
      );
      assertEquals(invalidated.ok, true);

      const after = await app.request("/api/daemon/v1/metrics", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${daemonToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildValidMetricsFrame()),
      });
      assertEquals(after.status, 401);
    },
  );
});

test("POST /secrets/decrypt rejects JWT after license invalidation", async () => {
  await withEnrollFixture(
    async ({ app, db, organizationId, licenseId, serverId, keyId }) => {
      const secretsConfig = createTestSecretsConfig();
      const sealed = await encryptSecretForDaemon(
        secretsConfig,
        { serverId, keyId },
        "post-revoke-secret",
      );
      const daemonToken = await issueDaemonToken(serverId, keyId);

      const before = await app.request("/api/daemon/v1/secrets/decrypt", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${daemonToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ciphertexts: [sealed] }),
      });
      assertEquals(before.status, 200);

      await invalidateLicense(db, licenseId, organizationId, { force: true });

      const after = await app.request("/api/daemon/v1/secrets/decrypt", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${daemonToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ciphertexts: [sealed] }),
      });
      assertEquals(after.status, 401);
    },
  );
});

test("GET /host/docker-networking returns 401 without JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/host/docker-networking");
    assertEquals(response.status, 401);
  });
});

test("GET /host/docker-networking returns the owner org's pools (empty when unconfigured)", async () => {
  await withEnrollFixture(async ({ app, db, serverId, keyId, organizationId }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const headers = { Authorization: `Bearer ${daemonToken}` };

    const unconfigured = await app.request(
      "/api/daemon/v1/host/docker-networking",
      { headers },
    );
    assertEquals(unconfigured.status, 200);
    assertEquals(await unconfigured.json(), {
      ok: true,
      addressPools: [],
      defaultBridgeCidr: null,
    });

    await db.update(organization).set({
      options: {
        docker: {
          addressPools: [{ base: "10.200.0.0/16", size: 24 }],
          defaultBridgeCidr: "172.17.0.1/16",
        },
      },
    }).where(eq(organization.id, organizationId));

    const configured = await app.request(
      "/api/daemon/v1/host/docker-networking",
      { headers },
    );
    assertEquals(configured.status, 200);
    assertEquals(await configured.json(), {
      ok: true,
      addressPools: [{ base: "10.200.0.0/16", size: 24 }],
      defaultBridgeCidr: "172.17.0.1/16",
    });
  });
});
