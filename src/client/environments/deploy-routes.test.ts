import { assertEquals } from "@std/assert";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import { getDatabaseUrl } from "../../db-url.ts";
import { createDenoDb } from "../../db.ts";
import type {
  DaemonCell,
  DaemonCellRegistry,
} from "../../daemon/cell/contracts.ts";
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
import { emptyComposeDocument } from "../../lib/compose/index.ts";
import { DEFAULT_MANAGED_INGRESS_PORTS } from "../../lib/managed/ingress-ports.ts";
import type { ComposeDocument } from "../../lib/compose/types.ts";
import type { PreparedDeployCompose } from "./deploy-prepare.ts";
import type { CommandEnvelope } from "../../lib/commands/envelope.ts";
import type { CommandQueue } from "../../lib/commands/queue.ts";
import {
  command,
  dispatch,
  container,
  deployment,
  environment,
  fabric,
  grant,
  hosting,
  network,
  organization,
  project,
  subnet,
  server,
  service,
  slot,
  user,
  workspace,
} from "../../lib/db/schema.ts";
import {
  getCommandMetadata,
  transitionCommand,
} from "../../lib/db/command-records.ts";
import {
  enableOrganizationFabric,
  getOrganizationFabric,
  listEnvironmentComposeNetworks,
  listFabricRelays,
  stampRelayPublicKey,
  stampRelayReconcileSuccess,
  updateFabricRelay,
} from "../../lib/db/fabric-records.ts";
import { setFabricConvergenceTimeoutMsForTests } from "../../lib/fabric/enqueue.ts";
import { ORG_ID_HEADER } from "../org-context.ts";
import {
  expandHostingsForComposeInstances,
  preferredListenPortsFromHostings,
  readHostingPorts,
  readHostingProtocol,
  readHostnames,
  readPathPrefix,
  readTargetPort,
  attachmentServerIds,
  deployParticipation,
  ingressServerIdsForDeploy,
  registerEnvironmentDeployPreviewRoutes,
  registerEnvironmentDeployRoutes,
  registerEnvironmentLifecycleRoutes,
  tcpUdpIngressServiceRefs,
  validateDeployMaterials,
} from "./deploy-routes.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../../test-fixtures/secrets.ts";
import { systemHierarchyProvision } from "../system/hierarchy.ts";

const dbUrl = getDatabaseUrl();

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("expandHostingsForComposeInstances fans hostings onto clone keys", () => {
  const expanded = expandHostingsForComposeInstances(
    [
      {
        hostingId: "h1",
        serviceId: "svc-web",
        composeServiceName: "web",
        hostnames: ["app.example.com"],
      },
      {
        hostingId: "h2",
        serviceId: "svc-api",
        composeServiceName: "api",
        hostnames: ["api.example.com"],
      },
    ],
    {
      web: ["web-1", "web-2"],
      api: ["api"],
    },
  );
  assertEquals(expanded.length, 3);
  assertEquals(
    expanded.map((entry) => entry.composeServiceName).sort((a, b) =>
      a.localeCompare(b)
    ),
    ["api", "web-1", "web-2"],
  );
  const webClones = expanded.filter((entry) => entry.hostingId === "h1");
  assertEquals(webClones.length, 2);
  assertEquals(webClones.every((entry) => entry.serviceId === "svc-web"), true);
});

test("expandHostingsForComposeInstances passes through when expansion is missing", () => {
  const hostings = [{
    hostingId: "h1",
    serviceId: "svc-api",
    composeServiceName: "api",
    hostnames: ["api.example.com"],
  }];
  const expanded = expandHostingsForComposeInstances(hostings, {});
  assertEquals(expanded.length, 1);
  assertEquals(expanded[0]?.composeServiceName, "api");
});

test("deployParticipation marks previous hosts not in the plan as drained", () => {
  const attachments = [{ serverId: "srv-attach", networkKeys: ["default"] }];
  const result = deployParticipation({
    planServerIds: ["srv-a"],
    attachments,
    previous: [{ serverId: "srv-a" }, { serverId: "srv-old" }],
  });
  assertEquals([...result.attachmentServers].sort((a, b) => a.localeCompare(b)), [
    "srv-attach",
  ]);
  assertEquals(
    [...result.participating].sort((a, b) => a.localeCompare(b)),
    ["srv-a", "srv-attach"],
  );
  assertEquals(result.drainedIds, ["srv-old"]);
  assertEquals(
    deployParticipation({
      planServerIds: ["srv-a"],
      attachments: [],
      previous: [],
    }).drainedIds,
    [],
  );
});

test("tcpUdpIngressServiceRefs and attachmentServerIds project ids", () => {
  assertEquals(
    tcpUdpIngressServiceRefs([{ serviceId: "svc-1" }, { serviceId: "svc-2" }]),
    [{ serviceId: "svc-1" }, { serviceId: "svc-2" }],
  );
  assertEquals(
    attachmentServerIds([
      { serverId: "srv-a", networkKeys: [] },
      { serverId: "srv-b", networkKeys: ["default"] },
    ]),
    ["srv-a", "srv-b"],
  );
});

function stubPreparedDeployCompose(
  managedNetworkServices: string[],
): PreparedDeployCompose {
  return {
    composeYaml: "",
    composeFiles: [],
    desiredHash: "",
    replicaCounts: {},
    hooks: [],
    variableMaterial: [],
    storageMaterial: [],
    principalMaterial: [],
    sites: [],
    nativeAppServices: [],
    sourceMaterial: [],
    dockerExternalNetworks: [],
    dockerNetworkAddressing: [],
    fabricNetworks: [],
    managedNetworkServices,
    containers: [],
    ingressServices: [],
    hostings: [],
    tlsMaterial: [],
    listenerPorts: DEFAULT_MANAGED_INGRESS_PORTS,
    composeServiceExpansion: {},
    volumes: [],
    warnings: [],
  };
}

test("ingressServerIdsForDeploy includes attachments, leftovers, and managed hosts", () => {
  const ids = ingressServerIdsForDeploy({
    planServerIds: ["srv-a", "srv-b"],
    preparedByServer: [
      {
        serverId: "srv-a",
        prepared: stubPreparedDeployCompose(["web"]),
      },
      {
        serverId: "srv-b",
        prepared: stubPreparedDeployCompose([]),
      },
    ],
    attachments: [{ serverId: "srv-attach", networkKeys: ["default"] }],
    consumers: [],
    spanning: new Map(),
    segmentsByServer: new Map(),
    listenerNames: new Map(),
    releasedListeners: ["srv-orphan"],
  });
  assertEquals(
    [...ids].sort((a, b) => a.localeCompare(b)),
    ["srv-a", "srv-attach", "srv-orphan"],
  );
});

test("readHosting helpers parse http and tcp/udp options", () => {
  assertEquals(readHostnames(null), []);
  assertEquals(readHostnames({ hostnames: ["a.example.com", "", 3] }), [
    "a.example.com",
  ]);
  assertEquals(readPathPrefix({ pathPrefix: "/api" }), "/api");
  assertEquals(readPathPrefix({}), undefined);
  assertEquals(readTargetPort({ targetPort: 8080 }), 8080);
  assertEquals(readTargetPort({ targetPort: Number.NaN }), undefined);
  assertEquals(readHostingProtocol({ protocol: "tcp" }), "tcp");
  assertEquals(readHostingProtocol({ protocol: "udp" }), "udp");
  assertEquals(readHostingProtocol({ protocol: "http" }), "http");
  assertEquals(readHostingProtocol({}), "http");
  assertEquals(
    readHostingPorts({
      ports: [
        { published: 5432, target: 5432 },
        { published: 0, target: 5432 },
        { published: 8443, target: "8080" },
        null,
      ],
    }),
    [{ published: 5432, target: 5432 }],
  );
});

test("preferredListenPortsFromHostings maps targetPort by compose service name", () => {
  const map = preferredListenPortsFromHostings([
    {
      hostingId: "h1",
      serviceId: "svc-web",
      composeServiceName: "web",
      hostnames: ["app.example.com"],
      targetPort: 3000,
    },
    {
      hostingId: "h2",
      serviceId: "svc-api",
      composeServiceName: "api",
      hostnames: ["api.example.com"],
    },
  ]);
  assertEquals(map.get("web"), 3000);
  assertEquals(map.has("api"), false);
});

test("validateDeployMaterials rejects tcp hosting without ports", () => {
  const validationError = validateDeployMaterials(
    [{
      hostingId: "h1",
      serviceId: "svc-db",
      composeServiceName: "db",
      hostnames: [],
      protocol: "tcp",
      ports: [],
    }],
    [],
  );
  if (!validationError) {
    throw new TypeError("expected a validation error");
  }
  assertEquals(validationError.error, "invalid_deploy_hosting");
});

function createRecordingCommandQueue(): CommandQueue & {
  envelopes: CommandEnvelope[];
} {
  const envelopes: CommandEnvelope[] = [];
  return {
    envelopes,
    enqueue: (envelope) => {
      envelopes.push(envelope);
      return Promise.resolve();
    },
  };
}

function createMockCell(serverId: string): DaemonCell {
  const noopAsync = () => Promise.resolve();
  return {
    attachDaemonSocket: () =>
      Promise.resolve({
        connectionId: "conn",
        lease: {
          holder: "conn",
          token: "conn",
          expiresAt: new Date(Date.now() + 45_000).toISOString(),
        },
      }),
    detachDaemonSocket: noopAsync,
    recordInbound: noopAsync,
    getSnapshot: () =>
      Promise.resolve({
        serverId,
        version: 0,
        updatedAt: new Date().toISOString(),
        connected: false,
      }),
    putSnapshot: (patch) =>
      Promise.resolve({
        serverId,
        version: 1,
        updatedAt: new Date().toISOString(),
        connected: false,
        ...patch,
      }),
    enqueue: (outbound) =>
      Promise.resolve({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: "queued" as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    markSent: noopAsync,
    handleInbound: () => Promise.resolve(null),
    getRequest: () => Promise.resolve(null),
    listRequests: () => Promise.resolve([]),
    waitForRequest: () => Promise.resolve(null),
    createRequestAndWait: (outbound) =>
      Promise.resolve({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: "done" as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    claimDeliveryLease: () => Promise.resolve(null),
    renewDeliveryLease: () => Promise.resolve(null),
    releaseDeliveryLease: noopAsync,
    readOutboxBatch: () => Promise.resolve([]),
    ackOutbox: noopAsync,
    prune: () => Promise.resolve([]),
    clearUpdateStatus: () => Promise.resolve({ cleared: 0 }),
    purge: noopAsync,
  };
}

function createTrackingRegistry(): DaemonCellRegistry {
  const cells = new Map<string, DaemonCell>();
  return {
    getCell(serverId: string): DaemonCell {
      let cell = cells.get(serverId);
      if (!cell) {
        cell = createMockCell(serverId);
        cells.set(serverId, cell);
      }
      return cell;
    },
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  };
}

function composeWithEmptyServices(): ComposeDocument {
  return {
    version: 1,
    data: {
      services: {},
    },
    presentation: { keyOrder: ["services"], comments: {} },
  };
}

function composeWithWebService(): ComposeDocument {
  return {
    version: 1,
    data: {
      services: {
        web: { image: "nginx:alpine" },
      },
    },
    presentation: { keyOrder: ["services"], comments: {} },
  };
}

function composeWithNamedWebService(): ComposeDocument {
  return {
    version: 1,
    data: {
      services: {
        web: { image: "adminer:latest", container_name: "adminer" },
      },
    },
    presentation: { keyOrder: ["services"], comments: {} },
  };
}

function composeWithReplicatedWebService(): ComposeDocument {
  return {
    version: 1,
    data: {
      services: {
        web: {
          image: "nginx:alpine",
          ports: ["8080:80"],
          deploy: { replicas: 2 },
        },
      },
      networks: { default: { driver: "overlay" } },
    },
    presentation: { keyOrder: ["services", "networks"], comments: {} },
  };
}

async function createDeployRoutesTestApp(
  db: ReturnType<typeof createDenoDb>,
  options: {
    registry: DaemonCellRegistry;
    commandQueue: CommandQueue;
  },
) {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    "data-encryption",
  );
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("daemonCellRegistry", options.registry);
    c.set("commandQueue", options.commandQueue);
    c.set("dataEncryptionSecrets", dataEncryptionSecrets);
    return next();
  });
  const routeOpts = {
    secrets,
    runtime: "deno" as const,
    signupEnvOverride: undefined,
  };
  registerEnvironmentDeployPreviewRoutes(app, routeOpts);
  registerEnvironmentDeployRoutes(app, routeOpts);
  registerEnvironmentLifecycleRoutes(app, routeOpts);
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

async function withDeployFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>;
    app: Hono<AppEnv>;
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>;
    userId: string;
    organizationId: string;
    workspaceId: string;
    projectId: string;
    environmentId: string;
    serverId: string;
    commandQueue: ReturnType<typeof createRecordingCommandQueue>;
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping environment deploy route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const commandQueue = createRecordingCommandQueue();
  const registry = createTrackingRegistry();
  const { app, secrets } = await createDeployRoutesTestApp(db, {
    registry,
    commandQueue,
  });

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: "Deploy Route Test Org" })
    .returning({ id: organization.id });
  const organizationId = insertedOrg!.id;

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `deploy-route-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: "user",
    })
    .returning({ id: user.id });
  const userId = insertedUser!.id;

  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: "Deploy Route Workspace", organizationId })
    .returning({ id: workspace.id });
  const workspaceId = insertedWorkspace!.id;

  const now = new Date().toISOString();
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: "Deploy Route Server",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id });
  const serverId = insertedServer!.id;

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: "Deploy Route Project",
      workspaceId,
      options: { compose: emptyComposeDocument() },
    })
    .returning({ id: project.id });
  const projectId = insertedProject!.id;

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      name: "Deploy Route Env",
      projectId,
      options: { compose: emptyComposeDocument() },
    })
    .returning({ id: environment.id });
  const environmentId = insertedEnvironment!.id;

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      workspaceId,
      projectId,
      environmentId,
      serverId,
      commandQueue,
    });
  } finally {
    await db.delete(command).where(eq(command.serverId, serverId));
    await db.delete(container).where(eq(container.serverId, serverId));
    await db.delete(service).where(eq(service.environmentId, environmentId));
    await db.delete(environment).where(eq(environment.id, environmentId));
    await db.delete(project).where(eq(project.id, projectId));
    await db.delete(server).where(eq(server.id, serverId));
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ));
    await db.delete(workspace).where(eq(workspace.id, workspaceId));
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
}

test("GET /environments/:id/deploy-preview returns prepared yaml with warnings for empty compose", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    environmentId,
    serverId,
  }) => {
    await db
      .update(environment)
      .set({
        serverId,
        options: { compose: composeWithEmptyServices() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));
    await db
      .update(project)
      .set({
        options: { compose: emptyComposeDocument() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(project.id, projectId));

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(
      `/environments/${environmentId}/deploy-preview`,
      {
        method: "GET",
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      },
    );

    assertEquals(res.status, 200);
    const body = await res.json() as {
      ok: boolean;
      composeFiles: Array<{ filename: string; role: string; content: string }>;
      projectName: string;
      containers: unknown[];
      volumes: unknown[];
      warnings: Array<{ code: string }>;
    };
    assertEquals(body.ok, true);
    assertEquals(body.projectName, projectId);
    assertEquals(body.containers, []);
    assertEquals(body.volumes, []);
    assertEquals(body.warnings.some((w) => w.code === "empty_compose"), true);
    assertEquals(body.composeFiles?.[0]?.role, "runtime");
    assertEquals(body.composeFiles?.[0]?.filename, "compose.yaml");
  });
});

test("GET /environments/:id/deploy-preview returns containers for a service", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    environmentId,
    serverId,
  }) => {
    await db
      .update(environment)
      .set({
        serverId,
        options: { compose: emptyComposeDocument() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));
    await db
      .update(project)
      .set({
        options: { compose: composeWithWebService() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(project.id, projectId));

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(
      `/environments/${environmentId}/deploy-preview`,
      {
        method: "GET",
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      },
    );

    assertEquals(res.status, 200);
    const body = await res.json() as {
      ok: boolean;
      composeFiles: Array<{
        filename: string;
        role: string;
        source?: string;
        content: string;
      }>;
      projectName: string;
      containers: Array<{
        serviceId: string;
        composeServiceName: string;
        containerName: string;
        ordinal: number;
      }>;
      volumes: unknown[];
      warnings: unknown[];
    };
    assertEquals(body.ok, true);
    assertEquals(body.projectName, projectId);
    const runtimeYaml = body.composeFiles[0]?.content ?? "";
    assertEquals(runtimeYaml.includes("web:"), true);
    assertEquals(runtimeYaml.includes("x-turbopanel:"), true);
    assertEquals(runtimeYaml.includes(serverId), true);
    assertEquals(
      (body as { servers?: unknown }).servers,
      undefined,
    );
    assertEquals(body.containers.length >= 1, true);
    assertEquals(body.containers[0]!.composeServiceName, "web");
    assertEquals(body.containers[0]!.ordinal, 1);
    // uuid naming: docker container_name is the service UUID (obfuscated)
    assertEquals(
      body.containers[0]!.containerName,
      body.containers[0]!.serviceId,
    );
    assertEquals(
      runtimeYaml.includes(
        `container_name: ${body.containers[0]!.serviceId}`,
      ),
      true,
    );

    assertEquals(body.composeFiles.length, 1);
    assertEquals(body.composeFiles[0]!.role, "runtime");
    assertEquals(body.composeFiles[0]!.filename, "compose.yaml");
  });
});

test("GET /environments/:id/deploy-preview uses service UUID over authored container_name", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    environmentId,
    serverId,
  }) => {
    await db
      .update(environment)
      .set({
        serverId,
        options: { compose: emptyComposeDocument() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));
    await db
      .update(project)
      .set({
        options: { compose: composeWithNamedWebService() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(project.id, projectId));

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(
      `/environments/${environmentId}/deploy-preview`,
      {
        method: "GET",
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      },
    );

    assertEquals(res.status, 200);
    const body = await res.json() as {
      ok: boolean;
      composeFiles: Array<{ content: string }>;
      containers: Array<{
        serviceId: string;
        containerName: string;
      }>;
    };
    assertEquals(body.ok, true);
    assertEquals(body.containers.length >= 1, true);
    assertEquals(
      body.containers[0]!.containerName,
      body.containers[0]!.serviceId,
    );
    const runtimeYaml = body.composeFiles[0]?.content ?? "";
    assertEquals(
      runtimeYaml.includes(`container_name: ${body.containers[0]!.serviceId}`),
      true,
    );
    assertEquals(runtimeYaml.includes("container_name: adminer"), false);
  });
});

test("POST /environments/:id/deploy payload carries runtime composeFiles", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    await db
      .update(environment)
      .set({
        serverId,
        name: "Production",
        options: { compose: emptyComposeDocument() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));
    await db
      .update(project)
      .set({
        options: { compose: composeWithWebService() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(project.id, projectId));

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/environments/${environmentId}/deploy`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    assertEquals(res.status, 200);
    const body = await res.json() as { ok: boolean; commandId: string };
    assertEquals(body.ok, true);
    assertEquals(commandQueue.envelopes.length, 1);

    const [row] = await db
      .select({ payload: dispatch.payload })
      .from(dispatch)
      .where(eq(dispatch.commandId, body.commandId))
      .limit(1);
    const payload = row?.payload as {
      composeFiles: Array<{ filename: string; role: string; content: string }>;
    };
    assertEquals(Array.isArray(payload.composeFiles), true);
    assertEquals(payload.composeFiles.length, 1);
    assertEquals(payload.composeFiles[0]!.role, "runtime");
    assertEquals(payload.composeFiles[0]!.filename, "compose.yaml");
    assertEquals(payload.composeFiles[0]!.content.includes("web:"), true);
  });
});

test("POST /environments/:id/deploy stamps hostingIngress for HTTP hostnames", async () => {
  const traefikServiceId = "00000000-0000-4000-8000-0000000000aa";
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    const originalEnsure = systemHierarchyProvision.ensure;
    systemHierarchyProvision.ensure = () =>
      Promise.resolve({
        workspaceId: "00000000-0000-4000-8000-0000000000bb",
        projectId: "00000000-0000-4000-8000-0000000000cc",
        environmentId: "00000000-0000-4000-8000-0000000000dd",
        serviceId: traefikServiceId,
        containerRowId: "00000000-0000-4000-8000-0000000000ee",
        containerName: `${traefikServiceId}-in`,
      });
    let hostingServiceId: string | undefined;
    try {
      await db
        .update(environment)
        .set({
          serverId,
          name: "Production",
          options: { compose: emptyComposeDocument() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId));
      await db
        .update(project)
        .set({
          options: { compose: composeWithWebService() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(project.id, projectId));

      const [svc] = await db
        .insert(service)
        .values({
          environmentId,
          name: "web",
          composeServiceName: "web",
        })
        .returning({ id: service.id });
      hostingServiceId = svc!.id;
      await db.insert(hosting).values({
        serviceId: svc!.id,
        options: { hostnames: ["adminer.example.test"] },
      });

      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          "Content-Type": "application/json",
        },
        body: "{}",
      });

      assertEquals(res.status, 200);
      const body = await res.json() as { ok: boolean; commandId: string };
      assertEquals(body.ok, true);
      assertEquals(commandQueue.envelopes.length, 1);

      const [row] = await db
        .select({ payload: dispatch.payload })
        .from(dispatch)
        .where(eq(dispatch.commandId, body.commandId))
        .limit(1);
      const payload = row?.payload as {
        hostingIngress?: {
          serviceId: string;
          composeServiceName: string;
          containerName: string;
        };
        hostingIngressNetwork?: string;
      };
      assertEquals(payload.hostingIngress, {
        serviceId: traefikServiceId,
        composeServiceName: "traefik",
        containerName: `${traefikServiceId}-in`,
      });
      // The shared ingress Docker network is that same component serviceId —
      // the daemon must never reconstruct it from a literal.
      assertEquals(payload.hostingIngressNetwork, traefikServiceId);
    } finally {
      if (hostingServiceId) {
        await db.delete(hosting).where(eq(hosting.serviceId, hostingServiceId));
      }
      systemHierarchyProvision.ensure = originalEnsure;
    }
  });
});

test("POST /environments/:id/deploy uses project defaultServerId when env pin is unset", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    await db
      .update(project)
      .set({
        options: {
          compose: composeWithWebService(),
          defaultServerId: serverId,
        },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(project.id, projectId));
    await db
      .update(environment)
      .set({
        serverId: null,
        options: { compose: composeWithWebService() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/environments/${environmentId}/deploy`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    assertEquals(res.status, 200);
    assertEquals(commandQueue.envelopes.length, 1);
    assertEquals(commandQueue.envelopes[0]!.serverId, serverId);
  });
});

test("POST /environments/:id/deploy rejects empty compose", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    await db
      .update(environment)
      .set({
        serverId,
        options: { compose: composeWithEmptyServices() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));
    await db
      .update(project)
      .set({
        options: { compose: emptyComposeDocument() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(project.id, projectId));

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/environments/${environmentId}/deploy`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    assertEquals(res.status, 400);
    assertEquals(await res.json(), { error: "compose_empty" });
    assertEquals(commandQueue.envelopes.length, 0);
  });
});

test("POST /environments/:id/deploy pinned auto-resolves without body serverId", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    await db
      .update(environment)
      .set({
        serverId,
        options: { compose: composeWithWebService() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/environments/${environmentId}/deploy`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    assertEquals(res.status, 200);
    const body = await res.json() as {
      ok: boolean;
      commandId: string;
      status: string;
    };
    assertEquals(body.ok, true);
    assertEquals(body.status, "queued");
    assertEquals(commandQueue.envelopes.length, 1);
    assertEquals(commandQueue.envelopes[0]!.serverId, serverId);
    assertEquals(commandQueue.envelopes[0]!.type, "environment.deploy");

    const [envRow] = await db
      .select({
        serverId: environment.serverId,
        metadata: environment.metadata,
      })
      .from(environment)
      .where(eq(environment.id, environmentId))
      .limit(1);
    assertEquals(envRow?.serverId, serverId);
    const metadata = envRow?.metadata as { serverId?: string } | null;
    assertEquals(metadata?.serverId, undefined);
  });
});

test("POST /environments/:id/deploy ignores body serverId and uses environment.server_id", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    const now = new Date().toISOString();
    const [otherServer] = await db
      .insert(server)
      .values({
        organizationId,
        name: "Deploy Route Other Server",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });
    const otherServerId = otherServer!.id;

    try {
      await db
        .update(environment)
        .set({
          serverId,
          options: { compose: composeWithWebService() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId));

      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ serverId: otherServerId }),
      });

      assertEquals(res.status, 200);
      assertEquals(commandQueue.envelopes.length, 1);
      assertEquals(commandQueue.envelopes[0]!.serverId, serverId);
    } finally {
      await db.delete(command).where(eq(command.serverId, otherServerId));
      await db.delete(command).where(eq(command.serverId, serverId));
      await db.delete(server).where(eq(server.id, otherServerId));
    }
  });
});

test("POST /environments/:id/deploy requires persisted environment.server_id", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    await db
      .update(environment)
      .set({
        serverId: null,
        options: { compose: composeWithWebService() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));

    const cookie = await sessionCookie(db, secrets, userId);

    const bodyServerIdRes = await app.request(
      `/environments/${environmentId}/deploy`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ serverId }),
      },
    );
    assertEquals(bodyServerIdRes.status, 409);
    assertEquals(await bodyServerIdRes.json(), {
      error: "server_placement_required",
    });
    assertEquals(commandQueue.envelopes.length, 0);

    const missingRes = await app.request(
      `/environments/${environmentId}/deploy`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    assertEquals(missingRes.status, 409);
    assertEquals(await missingRes.json(), {
      error: "server_placement_required",
    });
    assertEquals(commandQueue.envelopes.length, 0);
  });
});

test("POST /environments/:id/deploy stale environment pin returns 409", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    commandQueue,
  }) => {
    const now = new Date().toISOString();
    const [foreignOrg] = await db
      .insert(organization)
      .values({ name: "Deploy Route Foreign Org" })
      .returning({ id: organization.id });
    const foreignOrgId = foreignOrg!.id;
    const [foreignServer] = await db
      .insert(server)
      .values({
        organizationId: foreignOrgId,
        name: "Foreign Server",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });
    const foreignServerId = foreignServer!.id;

    try {
      await db
        .update(environment)
        .set({
          serverId: foreignServerId,
          options: { compose: composeWithWebService() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId));

      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          "Content-Type": "application/json",
        },
        body: "{}",
      });

      assertEquals(res.status, 409);
      assertEquals(await res.json(), { error: "server_placement_required" });
      assertEquals(commandQueue.envelopes.length, 0);
    } finally {
      await db
        .update(environment)
        .set({ serverId: null, updatedAt: new Date().toISOString() })
        .where(eq(environment.id, environmentId));
      await db.delete(server).where(eq(server.id, foreignServerId));
      await db.delete(organization).where(eq(organization.id, foreignOrgId));
    }
  });
});

test("POST /environments/:id/deploy rejects stored compose placement", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    // Stored compose placement must fail deploy — placement lives on environment.server_id.
    await db
      .update(project)
      .set({
        options: {
          compose: {
            version: 1,
            data: {
              services: { web: { image: "nginx:alpine" } },
              "x-turbopanel": { placement: { server_id: crypto.randomUUID() } },
            },
            presentation: {
              keyOrder: ["services", "x-turbopanel"],
              comments: {},
            },
          },
        },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(project.id, projectId));
    await db
      .update(environment)
      .set({
        serverId,
        options: composeWithWebService(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/environments/${environmentId}/deploy`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assertEquals(res.status, 400);
    assertEquals(await res.json(), { error: "Invalid compose document" });
    assertEquals(commandQueue.envelopes.length, 0);
  });
});

test("POST /environments/:id/deploy rejects environment overlay compose placement", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    await db
      .update(environment)
      .set({
        serverId,
        options: {
          compose: {
            version: 1,
            data: {
              services: { web: { image: "nginx:alpine" } },
              "x-turbopanel": { placement: { server_id: crypto.randomUUID() } },
            },
            presentation: {
              keyOrder: ["services", "x-turbopanel"],
              comments: {},
            },
          },
        },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/environments/${environmentId}/deploy`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assertEquals(res.status, 400);
    assertEquals(await res.json(), { error: "Invalid compose document" });
    assertEquals(commandQueue.envelopes.length, 0);
  });
});

test("POST /environments/:id/lifecycle enqueues environment.lifecycle", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    await db
      .update(environment)
      .set({
        serverId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/environments/${environmentId}/lifecycle`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "stop" }),
    });
    assertEquals(res.status, 200);
    const body = await res.json() as {
      ok: boolean;
      commandId: string;
      status: string;
      serverId: string;
    };
    assertEquals(body.ok, true);
    assertEquals(body.status, "queued");
    assertEquals(body.serverId, serverId);
    assertEquals(commandQueue.envelopes.length, 1);
    assertEquals(commandQueue.envelopes[0]!.type, "environment.lifecycle");
    assertEquals(commandQueue.envelopes[0]!.serverId, serverId);
  });
});

test("POST /environments/:id/lifecycle rejects unknown action", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    await db
      .update(environment)
      .set({
        serverId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/environments/${environmentId}/lifecycle`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "down" }),
    });
    assertEquals(res.status, 400);
    assertEquals(await res.json(), { error: "Invalid request" });
    assertEquals(commandQueue.envelopes.length, 0);
  });
});

test("POST /environments/:id/lifecycle requires persisted environment.server_id", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    commandQueue,
  }) => {
    await db
      .update(environment)
      .set({
        serverId: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/environments/${environmentId}/lifecycle`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "start" }),
    });
    assertEquals(res.status, 409);
    assertEquals(await res.json(), { error: "server_placement_required" });
    assertEquals(commandQueue.envelopes.length, 0);
  });
});

test("POST /environments/:id/lifecycle returns 403 for non-manager", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    await db
      .update(environment)
      .set({
        serverId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ));

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/environments/${environmentId}/lifecycle`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "start" }),
    });
    assertEquals(res.status, 403);
    assertEquals(commandQueue.envelopes.length, 0);
  });
});

test("POST /environments/:id/lifecycle returns 404 for cross-org environment", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    commandQueue,
  }) => {
    const [foreignOrg] = await db
      .insert(organization)
      .values({ name: "Lifecycle Foreign Org" })
      .returning({ id: organization.id });
    const foreignOrgId = foreignOrg!.id;
    const [foreignWorkspace] = await db
      .insert(workspace)
      .values({ name: "Foreign Workspace", organizationId: foreignOrgId })
      .returning({ id: workspace.id });
    const [foreignProject] = await db
      .insert(project)
      .values({
        name: "Foreign Project",
        workspaceId: foreignWorkspace!.id,
        options: { compose: emptyComposeDocument() },
      })
      .returning({ id: project.id });
    const [foreignEnvironment] = await db
      .insert(environment)
      .values({
        name: "Foreign Env",
        projectId: foreignProject!.id,
        serverId,
        options: { compose: emptyComposeDocument() },
      })
      .returning({ id: environment.id });

    try {
      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(
        `/environments/${foreignEnvironment!.id}/lifecycle`,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action: "start" }),
        },
      );
      assertEquals(res.status, 404);
      assertEquals(commandQueue.envelopes.length, 0);
    } finally {
      await db.delete(environment).where(
        eq(environment.id, foreignEnvironment!.id),
      );
      await db.delete(project).where(eq(project.id, foreignProject!.id));
      await db.delete(workspace).where(eq(workspace.id, foreignWorkspace!.id));
      await db.delete(organization).where(eq(organization.id, foreignOrgId));
    }
  });
});

const WG_PUBKEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const WG_PUBKEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";

async function cleanupMultiServerFabricDeploy(
  db: ReturnType<typeof createDenoDb>,
  params: {
    environmentId: string;
    organizationId: string;
    serverIds: readonly string[];
    extraServerId: string;
  },
): Promise<void> {
  const serverIds = [...params.serverIds];
  await db.delete(command).where(inArray(command.serverId, serverIds));
  await db.delete(container).where(inArray(container.serverId, serverIds));
  await db.delete(deployment).where(
    eq(deployment.environmentId, params.environmentId),
  );
  await db.delete(slot).where(eq(slot.environmentId, params.environmentId));
  await db.delete(subnet).where(inArray(subnet.serverId, serverIds));
  await db.delete(network).where(
    and(
      eq(network.organizationId, params.organizationId),
      eq(network.kind, "compose"),
    ),
  );
  await db.delete(fabric).where(
    eq(fabric.organizationId, params.organizationId),
  );
  await db.delete(server).where(eq(server.id, params.extraServerId));
}

async function settleFabricReconcileEnqueue(
  db: ReturnType<typeof createDenoDb>,
  params: {
    organizationId: string;
    envelope: CommandEnvelope;
    settleStatus: "succeeded" | "failed" | "queued";
  },
): Promise<void> {
  if (params.envelope.type !== "server.fabric.reconcile") return;
  if (params.settleStatus === "queued") return;
  await transitionCommand(db, params.envelope.commandId, {
    status: params.settleStatus,
    ...(params.settleStatus === "failed" ? { error: "apply failed" } : {}),
  });
  if (params.settleStatus !== "succeeded") return;
  const metadata = await getCommandMetadata(db, params.envelope.commandId);
  const desiredHash = typeof metadata?.desiredHash === "string"
    ? metadata.desiredHash
    : null;
  const fabricRow = await getOrganizationFabric(db, params.organizationId);
  if (!desiredHash || !fabricRow) return;
  await stampRelayReconcileSuccess(db, {
    fabricId: fabricRow.id,
    serverId: params.envelope.serverId,
    appliedPayloadHash: desiredHash,
  });
}

async function prepareMultiServerFabricDeploy(
  db: ReturnType<typeof createDenoDb>,
  params: {
    organizationId: string;
    environmentId: string;
    serverId: string;
    commandQueue: ReturnType<typeof createRecordingCommandQueue>;
    settleStatus: "succeeded" | "failed" | "queued";
  },
): Promise<string> {
  const now = new Date().toISOString();
  await db
    .update(server)
    .set({ isConnected: true, updatedAt: now })
    .where(eq(server.id, params.serverId));
  const [extraServer] = await db
    .insert(server)
    .values({
      organizationId: params.organizationId,
      name: "Deploy Route Fabric Peer",
      isConnected: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id });
  const extraServerId = extraServer!.id;

  const fabricRow = await enableOrganizationFabric(db, params.organizationId);
  const relays = await listFabricRelays(db, fabricRow.id);
  const keys = [WG_PUBKEY_A, WG_PUBKEY_B];
  for (const [index, row] of relays.entries()) {
    await stampRelayPublicKey(db, {
      fabricId: fabricRow.id,
      serverId: row.serverId,
      publicKey: keys[index] ?? WG_PUBKEY_A,
    });
    await updateFabricRelay(db, {
      fabricId: fabricRow.id,
      serverId: row.serverId,
      endpointAddress: `203.0.113.${10 + index}`,
    });
  }

  await db
    .update(environment)
    .set({
      serverId: null,
      options: { compose: composeWithReplicatedWebService() },
      updatedAt: now,
    })
    .where(eq(environment.id, params.environmentId));

  const originalEnqueue = params.commandQueue.enqueue.bind(params.commandQueue);
  params.commandQueue.enqueue = async (envelope) => {
    await originalEnqueue(envelope);
    await settleFabricReconcileEnqueue(db, {
      organizationId: params.organizationId,
      envelope,
      settleStatus: params.settleStatus,
    });
  };

  return extraServerId;
}

test("POST /environments/:id/deploy waits for fabric reconcile before environment.deploy", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    const extraServerId = await prepareMultiServerFabricDeploy(db, {
      organizationId,
      environmentId,
      serverId,
      commandQueue,
      settleStatus: "succeeded",
    });
    try {
      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assertEquals(res.status, 200);
      const types = commandQueue.envelopes.map((envelope) => envelope.type);
      const lastFabric = types.lastIndexOf("server.fabric.reconcile");
      const firstDeploy = types.indexOf("environment.deploy");
      assertEquals(
        types.filter((type) => type === "server.fabric.reconcile").length >= 1,
        true,
      );
      assertEquals(
        types.filter((type) => type === "environment.deploy").length,
        2,
      );
      assertEquals(lastFabric >= 0 && firstDeploy > lastFabric, true);
    } finally {
      await cleanupMultiServerFabricDeploy(db, {
        environmentId,
        organizationId,
        serverIds: [serverId, extraServerId],
        extraServerId,
      });
    }
  });
});

test("POST /environments/:id/deploy returns 422 when fabric reconcile fails without mutating generation", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    const extraServerId = await prepareMultiServerFabricDeploy(db, {
      organizationId,
      environmentId,
      serverId,
      commandQueue,
      settleStatus: "failed",
    });
    try {
      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assertEquals(res.status, 422);
      const body = await res.json() as { error?: string };
      assertEquals(body.error, "fabric_reconcile_failed");
      assertEquals(
        commandQueue.envelopes.some((envelope) =>
          envelope.type === "environment.deploy"
        ),
        false,
      );
      const [envRow] = await db
        .select({ generation: environment.generation })
        .from(environment)
        .where(eq(environment.id, environmentId))
        .limit(1);
      assertEquals(envRow?.generation, 0);
      const deployments = await db
        .select({ id: deployment.id })
        .from(deployment)
        .where(eq(deployment.environmentId, environmentId));
      assertEquals(deployments.length, 0);
      const leftover = await listEnvironmentComposeNetworks(db, environmentId);
      assertEquals(leftover.length, 0);
      assertEquals(
        leftover.reduce((count, row) => count + row.segments.length, 0),
        0,
      );
    } finally {
      await cleanupMultiServerFabricDeploy(db, {
        environmentId,
        organizationId,
        serverIds: [serverId, extraServerId],
        extraServerId,
      });
    }
  });
});

test("POST /environments/:id/deploy purges spanning networks when fabric gate times out", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    setFabricConvergenceTimeoutMsForTests(0);
    const extraServerId = await prepareMultiServerFabricDeploy(db, {
      organizationId,
      environmentId,
      serverId,
      commandQueue,
      settleStatus: "queued",
    });
    try {
      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assertEquals(res.status, 409);
      const body = await res.json() as { error?: string };
      assertEquals(body.error, "fabric_reconcile_pending");
      assertEquals(
        commandQueue.envelopes.some((envelope) =>
          envelope.type === "environment.deploy"
        ),
        false,
      );
      const leftoverAfterTimeout = await listEnvironmentComposeNetworks(
        db,
        environmentId,
      );
      assertEquals(leftoverAfterTimeout.length, 0);
    } finally {
      setFabricConvergenceTimeoutMsForTests(undefined);
      await cleanupMultiServerFabricDeploy(db, {
        environmentId,
        organizationId,
        serverIds: [serverId, extraServerId],
        extraServerId,
      });
    }
  });
});

test("POST /environments/:id/deploy purges spanning networks when prepare fails", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    const extraServerId = await prepareMultiServerFabricDeploy(db, {
      organizationId,
      environmentId,
      serverId,
      commandQueue,
      settleStatus: "succeeded",
    });
    await db
      .update(environment)
      .set({
        options: {
          compose: {
            version: 1,
            data: {
              services: {
                web: {
                  image: "nginx:alpine",
                  environment: { MISSING: "{$project.does_not_exist}" },
                  deploy: { replicas: 2 },
                },
              },
            },
            presentation: { keyOrder: ["services"], comments: {} },
          },
        },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId));
    try {
      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assertEquals(res.status, 422);
      const body = await res.json() as { error?: string };
      assertEquals(body.error, "variable_unresolved");
      assertEquals(
        commandQueue.envelopes.some((envelope) =>
          envelope.type === "environment.deploy"
        ),
        false,
      );
      const leftoverAfterPrepare = await listEnvironmentComposeNetworks(
        db,
        environmentId,
      );
      assertEquals(leftoverAfterPrepare.length, 0);
    } finally {
      await cleanupMultiServerFabricDeploy(db, {
        environmentId,
        organizationId,
        serverIds: [serverId, extraServerId],
        extraServerId,
      });
    }
  });
});

test("POST /environments/:id/deploy records per-server failures when queue delivery fails mid fan-out", async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    const extraServerId = await prepareMultiServerFabricDeploy(db, {
      organizationId,
      environmentId,
      serverId,
      commandQueue,
      settleStatus: "succeeded",
    });
    const innerEnqueue = commandQueue.enqueue.bind(commandQueue);
    let deployEnqueues = 0;
    commandQueue.enqueue = async (envelope) => {
      if (envelope.type === "environment.deploy") {
        deployEnqueues += 1;
        if (deployEnqueues >= 2) {
          throw new Error("queue down");
        }
      }
      await innerEnqueue(envelope);
    };
    try {
      const cookie = await sessionCookie(db, secrets, userId);
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assertEquals(res.status, 200);
      const body = await res.json() as {
        commands?: Array<{ serverId: string; status: string }>;
      };
      assertEquals(body.commands?.length, 1);
      assertEquals(body.commands?.[0]?.status, "queued");

      const targets = await db
        .select({
          serverId: deployment.serverId,
          status: deployment.status,
          lastCommandId: deployment.lastCommandId,
        })
        .from(deployment)
        .where(eq(deployment.environmentId, environmentId));
      const statuses = targets
        .map((row) => row.status)
        .sort((a, b) => a.localeCompare(b));
      assertEquals(targets.length, 2);
      assertEquals(statuses, ["applying", "failed"]);
      assertEquals(targets.every((row) => row.lastCommandId != null), true);
      const applying = targets.find((row) => row.status === "applying");
      assertEquals(body.commands?.[0]?.serverId, applying?.serverId);

      const deployCommands = await db
        .select({
          id: command.id,
          status: command.status,
        })
        .from(command)
        .where(
          and(
            eq(command.name, "environment.deploy"),
            inArray(command.serverId, [serverId, extraServerId]),
          ),
        );
      const commandStatuses = deployCommands
        .map((row) => row.status)
        .sort((a, b) => a.localeCompare(b));
      assertEquals(deployCommands.length, 2);
      assertEquals(commandStatuses, ["failed", "queued"]);

      // Spanning compose networks only materialize when the plan places
      // replicas on more than one server (see `collectSpanningComposeNetworkKeys`);
      // pin that precondition down explicitly so a placement regression fails
      // here with a clear signal instead of surfacing as an empty `leftover`
      // below with no indication of why.
      const placement = await db
        .select({ serverId: slot.serverId })
        .from(slot)
        .where(eq(slot.environmentId, environmentId));
      assertEquals(
        [...new Set(placement.map((row) => row.serverId))].sort().length,
        2,
      );

      const leftover = await listEnvironmentComposeNetworks(db, environmentId);
      assertEquals(leftover.length > 0, true);
      assertEquals(leftover.some((row) => row.segments.length > 0), true);
    } finally {
      await cleanupMultiServerFabricDeploy(db, {
        environmentId,
        organizationId,
        serverIds: [serverId, extraServerId],
        extraServerId,
      });
    }
  });
});
