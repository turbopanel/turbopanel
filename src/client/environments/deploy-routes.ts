import { eq, inArray } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import { createSessionMiddleware } from "../authn/middleware.ts";
import { resolveEntityOrganizationId } from "../authz/create-access-grant.ts";
import {
  createReleaseIdAllocator,
  type DeployPrepareError,
  type DeployRollbackRequest,
  type DeployScheduleSlice,
  type DeploySourceSelection,
  PREPARE_HONORS_SOURCE_SELECTION,
  type PreparedDeployCompose,
  prepareDeployCompose,
  type ReleaseIdAllocator,
} from "./deploy-prepare.ts";
import {
  definedFields,
  presentFields,
} from "../../lib/optional-fields.ts";
import type { DerivedSecretsConfig } from "../authn/secrets.ts";
import type { CommandEnvelope } from "../../lib/commands/envelope.ts";
import type {
  EnvironmentDeployComposeFile,
  EnvironmentDeployDockerNetwork,
  EnvironmentDeployFabricNetwork,
  EnvironmentDeployHosting,
  EnvironmentDeployIngressService,
  EnvironmentDeployNativeAppService,
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeployServiceHook,
  EnvironmentDeploySource,
  EnvironmentDeployStorageMaterial,
  EnvironmentDeployTlsMaterial,
  EnvironmentDeploySite,
  EnvironmentDeployVariableMaterial,
  EnvironmentLifecycleAction,
} from "../../lib/commands/schemas.ts";
import {
  buildDeployPreviewContainers,
  buildDeployPreviewServers,
  buildNativeAppServicesForDeploy,
  buildSitesForDeploy,
  composeProjectName,
  fabricGateErrorResponse,
  mapPrepareErrorResponse,
  parseDeployRequestFlags,
  parseLifecycleAction,
  type QueuedCommandRef,
  queuedCommandsResponseBody,
  scheduleErrorResponse,
} from "./deploy-routes-helpers.ts";
import { resolveTcpUdpIngressServices } from "./tcp-udp-ingress.ts";
import {
  type EnvironmentSiteRelease,
  resolveEnvironmentSiteReleases,
  resolveSourcedEnvironmentSiteReleases,
} from "./site-releases.ts";
import { isNoopCommandQueue } from "../../lib/commands/noop-command-queue.ts";
import {
  type CommandContextRelease,
  normalizeContextReleases,
  normalizeReplicaCounts,
} from "../../lib/commands/context.ts";
import {
  type CommandQueue,
  getCommandQueue,
} from "../../lib/commands/queue.ts";
import {
  createCommandRecord,
  transitionCommand,
} from "../../lib/db/command-records.ts";
import { bumpEnvironmentGeneration } from "../../lib/db/environment-generation.ts";
import {
  type DeploymentTargetInput,
  listEnvironmentDeploymentTargets,
  markDeploymentFailed,
  pruneDrainedDeployments,
  upsertDeploymentTargets,
} from "../../lib/db/deployment-records.ts";
import {
  type DesiredSlotInput,
  listEnvironmentSlots,
  replaceEnvironmentSlotsInTx,
} from "../../lib/db/slot-records.ts";
import {
  composeNetworkNamesByServer,
  type FabricSegmentMaterial,
  getOrganizationFabric,
  listEnvironmentComposeNetworks,
  listSubnetsForServers,
  materializeSpanningNetworks,
  purgeComposeNetworksCreatedAfter,
  purgeEnvironmentComposeNetworks,
  releaseSubnetsForServer,
} from "../../lib/db/fabric-records.ts";
import {
  awaitParticipatingFabricConvergence,
  isFabricEnqueueTypedError,
} from "../../lib/fabric/enqueue.ts";
import type { FabricGateOutcome } from "../../lib/fabric/gate.ts";
import {
  assignSlotAddresses,
  buildCompileAddressMaps,
  planEnvironmentDeploy,
  type PlannedDeploy,
} from "../../lib/schedule/index.ts";
import { enqueueManagedIngressReconcile } from "../managed/ingress-desired.ts";
import {
  loadManagedIngressPlatformAttachments,
  type ManagedIngressConsumer,
  reservedIngressHostsForServer,
} from "../managed/ingress-attachments.ts";
import type { ManagedIngressPorts } from "../../lib/managed/ingress-ports.ts";
import { ensureManagedIngressHierarchy } from "../system/hierarchy.ts";
import {
  composeServiceNetworkKeys,
  type PlatformAttachment,
} from "../../lib/fabric/spanning.ts";
import { environment, project, server } from "../../lib/db/schema.ts";
import { type Db, getDaemonCellRegistry, getDb } from "../../db.ts";
import {
  assertCanManageOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
} from "../shared.ts";
import {
  parseProjectOptions,
  resolveEffectivePlacementServerId,
} from "../../lib/project-options.ts";

type DeployHostingPayload = EnvironmentDeployHosting;

function responseForScheduleError(
  c: Context<AppEnv>,
  error: Parameters<typeof scheduleErrorResponse>[0],
  message: string,
): Response {
  const mapped = scheduleErrorResponse(error, message);
  return c.json(mapped.body, { status: mapped.status as 409 | 422 });
}

function serviceIdToNameMap(
  rows: ReadonlyArray<{ id: string; composeServiceName: string }>,
): Map<string, string> {
  return new Map(rows.map((row) => [row.id, row.composeServiceName]));
}

function scheduleSliceForServer(
  planned: PlannedDeploy,
  serverId: string,
  spanning: ReadonlyMap<string, string> | undefined,
  slots: readonly DesiredSlotInput[],
  compileMaps: ReturnType<typeof buildCompileAddressMaps> | undefined,
  fabricNetworks: readonly EnvironmentDeployFabricNetwork[] | undefined,
  managedIngressHostsByService?: ReadonlyMap<
    string,
    ReadonlyArray<{ name: string; address: string }>
  >,
): DeployScheduleSlice {
  return {
    serverId,
    slots,
    serviceIdToName: serviceIdToNameMap(planned.serviceRows),
    ...(spanning && spanning.size > 0 ? { spanningNetworks: spanning } : {}),
    ...(compileMaps && compileMaps.taskAddressesByService.size > 0
      ? { taskAddresses: compileMaps.taskAddressesByService }
      : {}),
    ...(compileMaps && compileMaps.spanningHostsByService.size > 0
      ? { spanningHosts: compileMaps.spanningHostsByService }
      : {}),
    ...(fabricNetworks && fabricNetworks.length > 0 ? { fabricNetworks } : {}),
    ...(managedIngressHostsByService && managedIngressHostsByService.size > 0
      ? { managedIngressHostsByService }
      : {}),
  };
}

async function loadSpanningNetworks(
  db: Db,
  planned: PlannedDeploy,
  organizationId: string,
  environmentId: string,
): Promise<{
  spanning: Map<string, string>;
  attachments: PlatformAttachment[];
  consumers: ManagedIngressConsumer[];
}> {
  const empty = {
    spanning: new Map<string, string>(),
    attachments: [],
    consumers: [],
  };
  if (!planned.plan.ok || !planned.fabricEnabled) {
    return empty;
  }
  const fabricRow = await getOrganizationFabric(db, organizationId);
  if (!fabricRow) return empty;
  const { attachments, consumers } =
    await loadManagedIngressPlatformAttachments(
      db,
      {
        environmentId,
        document: planned.merged,
        slots: planned.plan.slots,
        serviceRows: planned.serviceRows,
      },
    );
  const spanning = await materializeSpanningNetworks(db, {
    organizationId,
    environmentId,
    fabric: fabricRow,
    document: planned.merged,
    slots: planned.plan.slots,
    serviceRows: planned.serviceRows,
    platformAttachments: attachments,
  });
  return { spanning, attachments, consumers };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function networkServiceIdsForSpanning(
  planned: PlannedDeploy,
  spanningKeys: readonly string[],
): Map<string, Set<string>> {
  const nameToId = new Map(
    planned.serviceRows.map((row) => [row.composeServiceName, row.id]),
  );
  const services = isPlainObject(planned.merged.data.services)
    ? planned.merged.data.services
    : {};
  const out = new Map<string, Set<string>>();
  for (const composeKey of spanningKeys) {
    const ids = new Set<string>();
    for (const [name, body] of Object.entries(services)) {
      if (!composeServiceNetworkKeys(body).includes(composeKey)) continue;
      const serviceId = nameToId.get(name);
      if (serviceId) ids.add(serviceId);
    }
    out.set(composeKey, ids);
  }
  return out;
}

function networkSegmentsFromMaterial(
  spanning: ReadonlyMap<string, string>,
  segmentsByServer: Map<string, FabricSegmentMaterial[]>,
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [composeKey, hostName] of spanning) {
    const byServer = new Map<string, string>();
    for (const [serverId, segments] of segmentsByServer) {
      const match = segments.find((segment) => segment.name === hostName);
      if (match) byServer.set(serverId, match.subnet);
    }
    out.set(composeKey, byServer);
  }
  return out;
}

function fabricNetworksForServer(
  segments: readonly FabricSegmentMaterial[] | undefined,
  spanningHostNames: ReadonlySet<string>,
): EnvironmentDeployFabricNetwork[] {
  if (!segments || spanningHostNames.size === 0) return [];
  return segments
    .filter((segment) => spanningHostNames.has(segment.name))
    .map((segment) => ({
      name: segment.name,
      subnet: segment.subnet,
      ...(segment.mtu !== undefined ? { mtu: segment.mtu } : {}),
      ...(segment.gateway !== undefined ? { gateway: segment.gateway } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function enrichPlannedTaskAddresses(
  db: Db,
  planned: PlannedDeploy,
  spanning: ReadonlyMap<string, string>,
  environmentId: string,
  extraServerIds: readonly string[] = [],
): Promise<{
  slots: DesiredSlotInput[];
  segmentsByServer: Map<string, FabricSegmentMaterial[]>;
  networkServiceIds: Map<string, Set<string>>;
}> {
  const baseTasks = planned.plan.ok ? planned.plan.slots : [];
  if (!planned.plan.ok) {
    return {
      slots: baseTasks,
      segmentsByServer: new Map(),
      networkServiceIds: new Map(),
    };
  }
  const networkServiceIds = spanning.size === 0
    ? new Map<string, Set<string>>()
    : networkServiceIdsForSpanning(planned, [...spanning.keys()]);
  if (spanning.size === 0) {
    return {
      slots: assignSlotAddresses({
        slots: baseTasks,
        existing: [],
        networkSegments: new Map(),
        networkServiceIds: new Map(),
      }),
      segmentsByServer: new Map(),
      networkServiceIds,
    };
  }
  const existing = await listEnvironmentSlots(db, environmentId);
  const segmentServerIds = [
    ...new Set([...planned.plan.serverIds, ...extraServerIds]),
  ];
  const segmentsByServer = await listSubnetsForServers(
    db,
    segmentServerIds,
  );
  const slots = assignSlotAddresses({
    slots: baseTasks,
    existing,
    networkSegments: networkSegmentsFromMaterial(spanning, segmentsByServer),
    networkServiceIds,
  });
  return { slots, segmentsByServer, networkServiceIds };
}

async function listenerNamesForAttachments(
  db: Db,
  organizationId: string,
  attachments: readonly PlatformAttachment[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const uniqueIds = [...new Set(attachments.map((row) => row.serverId))];
  for (const serverId of uniqueIds) {
    const hierarchy = await ensureManagedIngressHierarchy(db, {
      organizationId,
      serverId,
    });
    names.set(serverId, hierarchy.containerName);
  }
  return names;
}

function assertDispatchInfrastructure(
  c: Context<AppEnv>,
): CommandQueue | Response {
  const registry = getDaemonCellRegistry(c);
  if (!registry) {
    return c.json({ error: "Daemon cell registry unavailable" }, 503);
  }

  const commandQueue = getCommandQueue(c);
  if (!commandQueue || isNoopCommandQueue(commandQueue)) {
    return c.json({ error: "Command queue unavailable" }, 503);
  }

  return commandQueue;
}

function responseForPrepareError(
  c: Context<AppEnv>,
  prepared: DeployPrepareError,
): Response {
  const mapped = mapPrepareErrorResponse(prepared);
  return c.json(mapped.body, { status: mapped.status as 400 | 409 | 422 });
}

function responseForFabricGate(
  c: Context<AppEnv>,
  outcome: Exclude<FabricGateOutcome, { kind: "ready" }>,
): Response {
  const mapped = fabricGateErrorResponse(outcome);
  return c.json(mapped.body, { status: mapped.status as 409 | 422 });
}

/**
 * Shared manage-gate for deploy-preview / stop / lifecycle (no deploy body flags).
 * Exported for host-free unit coverage of thin authz branches.
 */
export async function authorizeEnvironmentManage(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
): Promise<{ userId: string; organizationId: string } | Response> {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const orgResult = await getOrgId(c, session.userId);
  if (orgResult instanceof Response) return orgResult;

  const entityOrgId = await resolveEntityOrganizationId(
    db,
    "environment",
    environmentId,
  );
  if (!entityOrgId || entityOrgId !== orgResult) {
    return c.json({ error: "Not found" }, 404);
  }

  const denied = await assertCanManageOr403(c, "environment", environmentId);
  if (denied) return denied;

  const immutable = await assertNotSystemOwnedOr403(
    c,
    "environment",
    environmentId,
  );
  if (immutable) return immutable;

  return {
    userId: session.userId,
    organizationId: orgResult,
  };
}

/**
 * Who a deploy is attributed to.
 *
 * A deploy is no longer always a person pressing a button: the GitHub webhook
 * surface (`src/webhook/git/github.ts`) drives the *same*
 * pipeline with `actorType: 'system'` and the triggering `source.id` as the
 * actor. Carrying the pair explicitly — rather than a bare `userId` — is what
 * lets the two entry points share one enqueue path, so the generation-supersede
 * guarantee holds for webhook-driven deploys exactly as it does for manual ones.
 */
export type DeployActor = {
  actorType: "user" | "system";
  actorId: string;
};

/**
 * Which commit a deploy should build — defined next to
 * {@link prepareDeployCompose}, which is where source resolution reads it, and
 * re-exported here because the deploy route and the webhook trigger are what
 * populate it.
 *
 * This route records the selection on the deploy command's `metadata` *and*
 * hands it to the prepare layer, which now turns compose-declared sources into
 * `sourceMaterial[]` and honors a supplied `commitSha` — but only for the
 * binding whose `sourceId` the selection names, so a push to one repository
 * never pins the other repositories in the same environment. What it still does
 * not honor is an explicit `ref`: `PREPARE_HONORS_SOURCE_SELECTION` is `false`,
 * so such a request is refused rather than quietly deployed as the declared
 * branch.
 */
export type { DeploySourceSelection };

/**
 * Deploy-only authz: {@link authorizeEnvironmentManage} plus deploy request flags.
 * Exported for host-free unit coverage without full orchestration.
 */
export async function authorizeDeployRequest(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
): Promise<
  {
    actorType: "user";
    actorId: string;
    organizationId: string;
    acknowledgeHealthCheckWarnings: boolean;
    noCache: boolean;
    selection: DeploySourceSelection;
  } | Response
> {
  const auth = await authorizeEnvironmentManage(c, db, environmentId);
  if (auth instanceof Response) return auth;

  const body = await parseJsonBody(c);
  if (body instanceof Response) return body;

  const flags = parseDeployRequestFlags(body);
  if (flags === "invalid") {
    return c.json({ error: "Invalid request" }, 400);
  }

  return {
    actorType: "user",
    actorId: auth.userId,
    organizationId: auth.organizationId,
    acknowledgeHealthCheckWarnings: flags.acknowledgeHealthCheckWarnings,
    noCache: flags.noCache,
    // A session deploy names no single source: it is "deploy this environment",
    // not "deploy this repository's commit". `sourceId` stays `null`, so no
    // source binding is pinned to a caller-supplied SHA.
    selection: { ref: flags.ref, commitSha: null, sourceId: null },
  };
}

type DeployCommandCreateParams = DeployActor & {
  serverId: string;
  environmentId: string;
  projectId: string;
  organizationId: string;
  projectName: string;
  composeFiles: EnvironmentDeployComposeFile[];
  hostings: DeployHostingPayload[];
  sites: EnvironmentDeploySite[];
  nativeAppServices: EnvironmentDeployNativeAppService[];
  sourceMaterial: EnvironmentDeploySource[];
  ingressServices: EnvironmentDeployIngressService[];
  hostingIngress?: EnvironmentDeployIngressService;
  /** Set only when `hostings` is non-empty (see prepare). */
  hostingIngressNetwork?: string;
  tlsMaterial: EnvironmentDeployTlsMaterial[];
  variableMaterial: EnvironmentDeployVariableMaterial[];
  storageMaterial: EnvironmentDeployStorageMaterial[];
  principalMaterial: EnvironmentDeployPrincipalMaterial[];
  serviceHooks: EnvironmentDeployServiceHook[];
  dockerExternalNetworks: string[];
  dockerNetworkAddressing: EnvironmentDeployDockerNetwork[];
  fabricNetworks: EnvironmentDeployFabricNetwork[];
  managedNetworkServices: string[];
  /** Set only when `managedNetworkServices` is non-empty (see prepare). */
  managedNetwork?: string;
  noCache: boolean;
  generation: number;
  desiredHash: string;
  replicaCounts: Record<string, number>;
  listenerPorts: ManagedIngressPorts;
  selection: DeploySourceSelection;
};

type CreatedDeployCommand = QueuedCommandRef & { queuedAt: string };

/**
 * One compiled server deployment, tagged with the host it is for.
 *
 * Nothing but the pair: `prepared` is the compiler's `ServerDeployment` (plus
 * control-plane bookkeeping) and already carries every daemon-facing field,
 * hostings and TLS material included. This layer enqueues it; it does not
 * finish building it.
 */
type PreparedServerDeploy = {
  serverId: string;
  prepared: PreparedDeployCompose;
};

/**
 * The requested ref / pre-resolved SHA, as durable command metadata.
 *
 * This rides on `metadata` in addition to the payload's `sourceMaterial[]`:
 * the payload is deleted once the command reaches a terminal state, but the
 * attribution has to stay durable so a webhook-driven deploy can be traced back
 * to the commit that caused it. `undefined` when the request named nothing —
 * there is no attribution to keep.
 */
function deploySelectionMetadata(
  selection: DeploySourceSelection,
): {
  sourceSelection: { ref?: string; commitSha?: string; sourceId?: string };
} | undefined {
  const sourceSelection = definedFields({
    ref: selection.ref ?? undefined,
    commitSha: selection.commitSha ?? undefined,
    // Which source the commit came from — without it the attribution cannot
    // say *what* was deployed when the environment binds more than one
    // repository.
    sourceId: selection.sourceId ?? undefined,
  });
  if (Object.keys(sourceSelection).length === 0) return undefined;
  return { sourceSelection };
}

/** One `sourceMaterial[]` entry as the durable `command.context` records it. */
function contextReleaseFromSource(
  entry: EnvironmentDeploySource,
): CommandContextRelease {
  return definedFields({
    composeServiceName: entry.composeServiceName,
    releaseId: entry.releaseId,
    sourceId: entry.sourceId,
    commitSha: entry.commitSha,
    // Display metadata rides the durable row alongside the SHA: the payload
    // that carries it is deleted at terminal state, and re-resolving a commit
    // message months later would need a provider round trip (and a credential)
    // the read path does not have.
    commitMessage: entry.commitMessage,
    commitAuthor: entry.commitAuthor,
    rollbackToReleaseId: entry.rollbackToReleaseId,
  }) satisfies CommandContextRelease;
}

async function createDeployCommand(
  db: Db,
  params: DeployCommandCreateParams,
): Promise<CreatedDeployCommand> {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const replicaCounts = normalizeReplicaCounts(params.replicaCounts);
  const releases = normalizeContextReleases(
    params.sourceMaterial.map(contextReleaseFromSource),
  );
  const metadata = deploySelectionMetadata(params.selection);
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: params.actorType,
    actorId: params.actorId,
    ...(metadata === undefined ? {} : { metadata }),
    type: "environment.deploy",
    payload: {
      environmentId: params.environmentId,
      projectId: params.projectId,
      organizationId: params.organizationId,
      projectName: params.projectName,
      composeFiles: params.composeFiles,
      generation: params.generation,
      desiredHash: params.desiredHash,
      serverId: params.serverId,
      replicaCounts: params.replicaCounts,
      hostings: params.hostings,
      // Every list below is omitted when empty — the daemon reads an absent
      // key and an empty array the same way, and the queued row is smaller.
      ...presentFields({
        sites: params.sites,
        nativeAppServices: params.nativeAppServices,
        sourceMaterial: params.sourceMaterial,
        ingressServices: params.ingressServices,
        hostingIngress: params.hostingIngress,
        hostingIngressNetwork: params.hostingIngressNetwork,
        tlsMaterial: params.tlsMaterial,
        variableMaterial: params.variableMaterial,
        storageMaterial: params.storageMaterial,
        principalMaterial: params.principalMaterial,
        serviceHooks: params.serviceHooks,
        dockerExternalNetworks: params.dockerExternalNetworks,
        dockerNetworkAddressing: params.dockerNetworkAddressing,
        fabricNetworks: params.fabricNetworks,
        managedNetworkServices: params.managedNetworkServices,
        managedNetwork: params.managedNetwork,
        noCache: params.noCache ? true : undefined,
      }),
      listenerPorts: params.listenerPorts,
    },
    // Durable, non-secret read model for deploy history *and* for the release
    // list. `dispatch.payload` is deleted once the command reaches a terminal
    // state, and the `deployment` row is overwritten by the next redeploy, so
    // the per-service replica counts and release ids a past deploy produced
    // only survive if they are written onto the permanent `command.context`
    // here.
    //
    // The Git-backed releases go with them for the same reason: this row is the
    // only durable record of which release ids exist for a service — which is
    // exactly the list a rollback picks from. See `db/releases.ts`.
    context: definedFields({
      environmentId: params.environmentId,
      projectId: params.projectId,
      serverId: params.serverId,
      generation: params.generation,
      desiredHash: params.desiredHash,
      replicaCounts: replicaCounts ?? undefined,
      releases: releases ?? undefined,
    }),
    expiresAt,
  });

  return {
    commandId: record.id,
    serverId: params.serverId,
    status: "queued",
    queuedAt: record.queuedAt ?? record.createdAt,
  };
}

async function deliverDeployCommand(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    commandId: string;
    serverId: string;
    environmentId: string;
    queuedAt: string;
  },
): Promise<QueuedCommandRef | Response> {
  const envelope: CommandEnvelope = {
    commandId: params.commandId,
    serverId: params.serverId,
    type: "environment.deploy",
    attempt: 1,
    queuedAt: params.queuedAt,
  };

  try {
    await commandQueue.enqueue(envelope);
  } catch {
    await transitionCommand(db, params.commandId, {
      status: "failed",
      error: "Command queue unavailable",
    });
    await markDeploymentFailed(db, {
      environmentId: params.environmentId,
      serverId: params.serverId,
      error: "Command queue unavailable",
      commandId: params.commandId,
    });
    return Response.json({ error: "Command queue unavailable" }, {
      status: 503,
    });
  }

  return {
    commandId: params.commandId,
    serverId: params.serverId,
    status: "queued",
  };
}

function createParamsForPreparedServer(
  row: PreparedServerDeploy,
  params: DeployActor & {
    environmentId: string;
    projectId: string;
    organizationId: string;
    projectName: string;
    generation: number;
    noCache: boolean;
    selection: DeploySourceSelection;
  },
): DeployCommandCreateParams {
  // One loopback-port ledger for both host-native lanes: site vhosts
  // and native `node` apps are both reverse-proxied on 127.0.0.1, so allocating
  // them separately could hand the same port to a site and an app.
  const usedListenPorts = new Set<number>();
  return {
    serverId: row.serverId,
    actorType: params.actorType,
    actorId: params.actorId,
    selection: params.selection,
    environmentId: params.environmentId,
    projectId: params.projectId,
    organizationId: params.organizationId,
    projectName: params.projectName,
    composeFiles: row.prepared.composeFiles,
    hostings: row.prepared.hostings,
    sites: buildSitesForDeploy(
      row.prepared.sites,
      row.prepared.hostings,
      usedListenPorts,
    ),
    nativeAppServices: buildNativeAppServicesForDeploy(
      row.prepared.nativeAppServices,
      row.prepared.hostings,
      row.prepared.ingressServices,
      usedListenPorts,
    ),
    sourceMaterial: row.prepared.sourceMaterial,
    ingressServices: row.prepared.ingressServices,
    ...(row.prepared.hostingIngress
      ? { hostingIngress: row.prepared.hostingIngress }
      : {}),
    ...(row.prepared.hostingIngressNetwork
      ? { hostingIngressNetwork: row.prepared.hostingIngressNetwork }
      : {}),
    tlsMaterial: row.prepared.tlsMaterial,
    variableMaterial: row.prepared.variableMaterial,
    storageMaterial: row.prepared.storageMaterial,
    principalMaterial: row.prepared.principalMaterial,
    serviceHooks: row.prepared.hooks,
    dockerExternalNetworks: row.prepared.dockerExternalNetworks,
    dockerNetworkAddressing: row.prepared.dockerNetworkAddressing,
    fabricNetworks: row.prepared.fabricNetworks,
    managedNetworkServices: row.prepared.managedNetworkServices,
    ...(row.prepared.managedNetwork === undefined
      ? {}
      : { managedNetwork: row.prepared.managedNetwork }),
    noCache: params.noCache,
    generation: params.generation,
    desiredHash: row.prepared.desiredHash,
    replicaCounts: row.prepared.replicaCounts,
    listenerPorts: row.prepared.listenerPorts,
  };
}

/**
 * `deployment.options` is the control plane's durable record of what a deploy
 * put on each host, and `siteReleases` is the part that outlives the compose:
 * once a Git-backed service is removed, nothing derivable from the current
 * document names its `<principalHome>/sites/<serviceId>` tree any more, so a
 * later stop or delete would leave it behind. See `site-releases.ts`.
 */
function deploymentTargetsForFanOut(
  params: {
    preparedByServer: readonly PreparedServerDeploy[];
    planServerIds: readonly string[];
    drainedIds: readonly string[];
    generation: number;
    created: readonly CreatedDeployCommand[];
    /** Release trees the current compose declares, recorded per target. */
    siteReleases: readonly EnvironmentSiteRelease[];
  },
): DeploymentTargetInput[] {
  const preparedByServerId = new Map(
    params.preparedByServer.map((row) => [row.serverId, row]),
  );
  const commandByServer = new Map(
    params.created.map((row) => [row.serverId, row.commandId]),
  );
  return [
    ...params.planServerIds.map((serverId) => {
      const prepared = preparedByServerId.get(serverId)?.prepared;
      return {
        serverId,
        desiredGeneration: params.generation,
        desiredHash: prepared?.desiredHash ?? null,
        status: "applying" as const,
        lastCommandId: commandByServer.get(serverId) ?? null,
        options: {
          secretPlan: prepared?.secretPlan ?? [],
          siteReleases: params.siteReleases,
        },
      };
    }),
    ...params.drainedIds.map((serverId) => ({
      serverId,
      desiredGeneration: params.generation,
      status: "draining" as const,
    })),
  ];
}

/**
 * Atomically bump generation, replace slots, create deploy commands, and
 * persist deployment targets. Returns command refs only after commit.
 * Queue delivery stays outside. Callers must treat spanning networks as
 * committed once this returns.
 */
async function persistDeployFanOut(
  db: Db,
  params: DeployActor & {
    preparedByServer: readonly PreparedServerDeploy[];
    planServerIds: readonly string[];
    drainedIds: readonly string[];
    environmentId: string;
    projectId: string;
    organizationId: string;
    projectName: string;
    slots: readonly DesiredSlotInput[];
    noCache: boolean;
    selection: DeploySourceSelection;
    /** Release trees to record on each target — see `deploymentTargetsForFanOut`. */
    siteReleases: readonly EnvironmentSiteRelease[];
  },
): Promise<CreatedDeployCommand[]> {
  return await db.transaction(async (tx) => {
    const generation = await bumpEnvironmentGeneration(tx, params.environmentId);
    await replaceEnvironmentSlotsInTx(tx, {
      environmentId: params.environmentId,
      generation,
      slots: params.slots,
    });

    const created: CreatedDeployCommand[] = [];
    for (const row of params.preparedByServer) {
      created.push(
        await createDeployCommand(
          tx,
          createParamsForPreparedServer(row, {
            actorType: params.actorType,
            actorId: params.actorId,
            environmentId: params.environmentId,
            projectId: params.projectId,
            organizationId: params.organizationId,
            projectName: params.projectName,
            generation,
            noCache: params.noCache,
            selection: params.selection,
          }),
        ),
      );
    }

    await upsertDeploymentTargets(tx, {
      environmentId: params.environmentId,
      targets: deploymentTargetsForFanOut({
        preparedByServer: params.preparedByServer,
        planServerIds: params.planServerIds,
        drainedIds: params.drainedIds,
        generation,
        created,
        siteReleases: params.siteReleases,
      }),
    });
    return created;
  });
}

/**
 * Deliver persisted deploy commands. Queue failures mark that server's
 * command/target failed and continue so a partial fan-out stays consistent
 * with rows already written.
 */
async function deliverDeployFanOut(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    created: readonly CreatedDeployCommand[];
    environmentId: string;
  },
): Promise<{ queued: QueuedCommandRef[]; enqueueError: Response | null }> {
  const queued: QueuedCommandRef[] = [];
  let enqueueError: Response | null = null;
  for (const ref of params.created) {
    const delivered = await deliverDeployCommand(db, commandQueue, {
      commandId: ref.commandId,
      serverId: ref.serverId,
      environmentId: params.environmentId,
      queuedAt: ref.queuedAt,
    });
    if (delivered instanceof Response) {
      enqueueError ??= delivered;
      continue;
    }
    queued.push(delivered);
  }
  return { queued, enqueueError };
}

export {
  buildNativeAppServicesForDeploy,
  buildSitesForDeploy,
  deployMaterialsErrorResponse,
  expandHostingsForComposeInstances,
  preferredListenPortsFromHostings,
  queuedCommandsResponseBody,
  readHostingPorts,
  readHostingProtocol,
  readHostnames,
  readPathPrefix,
  readTargetPort,
  scheduleErrorResponse,
  validateDeployMaterials,
} from "./deploy-routes-helpers.ts";

/** One Git-backed release a preview reports the deploy would publish. */
type DeployPreviewSource = {
  composeServiceName: string;
  sourceId: string;
  provider: string;
  cloneUrl: string;
  ref: string;
  commitSha: string;
  releaseId: string;
  subdirectory?: string;
};

/**
 * Preview prepare for every scheduled server, sharing one release-id allocator.
 *
 * Shared for the same reason the deploy fan-out shares one: a service scheduled
 * onto several servers is one release, so the preview must not show it as
 * several. The ids themselves are throwaway — preview publishes nothing — but
 * the *shape* it reports has to be the shape a deploy produces.
 */
async function preparePreviewByServer(
  c: Context<AppEnv>,
  db: Db,
  args: {
    environmentId: string;
    organizationId: string;
    planned: SuccessfulPlannedDeploy;
    networks: Awaited<ReturnType<typeof loadSpanningNetworks>>;
    enriched: Awaited<ReturnType<typeof enrichPlannedTaskAddresses>>;
    serviceIdToName: ReturnType<typeof serviceIdToNameMap>;
    listenerNames: Awaited<ReturnType<typeof listenerNamesForAttachments>>;
  },
): Promise<
  Array<{ serverId: string; prepared: PreparedDeployCompose }> | Response
> {
  const { planned, enriched } = args;
  const { spanning, attachments, consumers } = args.networks;
  const spanningHostNames = new Set(spanning.values());
  const releaseIds = createReleaseIdAllocator();
  const preparedByServer: Array<{
    serverId: string;
    prepared: PreparedDeployCompose;
  }> = [];
  for (const serverId of planned.plan.serverIds) {
    const prepared = await prepareDeployCompose(c, db, {
      environmentId: args.environmentId,
      serverId,
      organizationId: args.organizationId,
      mode: "preview",
      composeValidated: planned.composeValidated,
      releaseIds,
      schedule: scheduleSliceForServer(
        planned,
        serverId,
        spanning,
        enriched.slots,
        buildCompileAddressMaps({
          slots: enriched.slots,
          serviceIdToName: args.serviceIdToName,
          serverId,
          networkServiceIds: enriched.networkServiceIds,
        }),
        fabricNetworksForServer(
          enriched.segmentsByServer.get(serverId),
          spanningHostNames,
        ),
        reservedIngressHostsForServer({
          thisServerId: serverId,
          attachments,
          consumers,
          spanning,
          segmentsByServer: enriched.segmentsByServer,
          listenerNameByServer: args.listenerNames,
        }),
      ),
    });
    if (prepared instanceof Response) return prepared;
    if ("kind" in prepared) return responseForPrepareError(c, prepared);
    preparedByServer.push({ serverId, prepared });
  }
  return preparedByServer;
}

/**
 * What each Git-backed service *would* build, from the already-resolved
 * `sourceMaterial[]`.
 *
 * Preview never mints a token or seals a credential (see `deploy-sources.ts`),
 * so this is shape only — and the fields here are precisely the non-secret
 * ones: which source, which ref, which commit, and the release id the deploy
 * would publish under.
 *
 * One row per release, not per (release, server): a service placed on three
 * hosts is one release, and listing it three times would suggest three builds
 * are about to run.
 */
function deployPreviewSources(
  preparedByServer: ReadonlyArray<{ prepared: PreparedDeployCompose }>,
): DeployPreviewSource[] {
  const byRelease = new Map<string, DeployPreviewSource>();
  for (const row of preparedByServer) {
    for (const entry of row.prepared.sourceMaterial) {
      const key = `${entry.composeServiceName} ${entry.releaseId}`;
      if (byRelease.has(key)) continue;
      byRelease.set(
        key,
        definedFields({
          composeServiceName: entry.composeServiceName,
          sourceId: entry.sourceId,
          provider: entry.provider,
          cloneUrl: entry.cloneUrl,
          ref: entry.ref,
          commitSha: entry.commitSha,
          releaseId: entry.releaseId,
          subdirectory: entry.subdirectory,
        }),
      );
    }
  }
  return [...byRelease.values()];
}

/**
 * GET /environments/:id/deploy-preview — exact compose YAML the daemon would
 * receive (same `prepareDeployCompose` path), with secrets redacted.
 *
 * Allocation (`(service, ordinal)`) and volume registration
 * (`(environment, composeVolumeKey)`) are idempotent, so preview may perform
 * them; deploy reuses the same rows and the previewed UUIDs stay truthful.
 * Sealing / daemon-key steps are skipped so an online daemon is not required.
 */
export function registerEnvironmentDeployPreviewRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError(
      "session secrets are required for environment deploy-preview routes",
    );
  }
  router.use(
    "/environments/:id/deploy-preview",
    createSessionMiddleware(opts.secrets),
  );

  router.get("/environments/:id/deploy-preview", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const environmentId = c.req.param("id");
    const auth = await authorizeEnvironmentManage(c, db, environmentId);
    if (auth instanceof Response) return auth;

    const planned = await resolveSuccessfulPlan(
      c,
      db,
      environmentId,
      auth.organizationId,
    );
    if (planned instanceof Response) return planned;

    const networks = await loadSpanningNetworks(
      db,
      planned,
      auth.organizationId,
      environmentId,
    );
    const enriched = await enrichPlannedTaskAddresses(
      db,
      planned,
      networks.spanning,
      environmentId,
      networks.attachments.map((row) => row.serverId),
    );
    const preparedByServer = await preparePreviewByServer(c, db, {
      environmentId,
      organizationId: auth.organizationId,
      planned,
      networks,
      enriched,
      serviceIdToName: serviceIdToNameMap(planned.serviceRows),
      listenerNames: await listenerNamesForAttachments(
        db,
        auth.organizationId,
        networks.attachments,
      ),
    });
    if (preparedByServer instanceof Response) return preparedByServer;

    const first = preparedByServer[0];
    const serverRows = planned.plan.serverIds.length === 0 ? [] : await db
      .select({ id: server.id, name: server.name, hostname: server.hostname })
      .from(server)
      .where(inArray(server.id, planned.plan.serverIds));
    const labelById = new Map(
      serverRows.map((row) => [row.id, { name: row.name, hostname: row.hostname }]),
    );
    const projectName = composeProjectName(planned.projectId);
    const ingress = preparedByServer.flatMap((row) =>
      row.prepared.ingressServices
    );
    const appContainers = first?.prepared.containers ?? [];
    const servers = buildDeployPreviewServers(preparedByServer, labelById);
    const sources = deployPreviewSources(preparedByServer);

    return c.json({
      ok: true as const,
      composeFiles: first?.prepared.composeFiles ?? [],
      projectName,
      ...presentFields({ servers, sources }),
      containers: buildDeployPreviewContainers({
        appContainers,
        ingressServices: ingress,
      }),
      volumes: (first?.prepared.volumes ?? []).map((row) => ({
        storageId: row.storageId,
        composeKey: row.composeKey,
        volumeName: row.volumeName,
      })),
      warnings: preparedByServer.flatMap((row) => row.prepared.warnings),
      envFile: first?.prepared.envFile ?? "",
      secretPlan: first?.prepared.secretPlan ?? [],
    });
  });
}

type SuccessfulPlannedDeploy = PlannedDeploy & {
  plan: Extract<PlannedDeploy["plan"], { ok: true }>;
};

/**
 * Everything {@link runEnvironmentDeploy} needs that is *not* derivable from
 * the environment itself. Written out rather than inferred from
 * {@link authorizeDeployRequest} because the session path always yields
 * `actorType: 'user'`, while the webhook path
 * ({@link runEnvironmentDeployForActor}) supplies `'system'`.
 */
export type DeployRequestAuth = DeployActor & {
  organizationId: string;
  acknowledgeHealthCheckWarnings: boolean;
  noCache: boolean;
  selection: DeploySourceSelection;
  /**
   * Present only for `POST /environments/:id/rollback`.
   *
   * A rollback deliberately reuses this whole pipeline rather than forking a
   * second enqueue path: that is where `environment.generation` is bumped, and
   * the daemon's newer-generation supersede rule only covers commands that went
   * through it. All the field changes is which releases the prepare layer pins
   * into `sourceMaterial[]` (see `deploy-sources.ts`).
   */
  rollback?: DeployRollbackRequest;
};

type EnrichedTaskAddresses = Awaited<
  ReturnType<typeof enrichPlannedTaskAddresses>
>;

type DeploySpanningContext = {
  spanning: Map<string, string>;
  attachments: PlatformAttachment[];
  consumers: ManagedIngressConsumer[];
  enriched: EnrichedTaskAddresses;
  listenerNames: Map<string, string>;
};

async function resolveSuccessfulPlan(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
  organizationId: string,
): Promise<SuccessfulPlannedDeploy | Response> {
  const planned = await planEnvironmentDeploy(db, {
    environmentId,
    organizationId,
  });
  if ("kind" in planned) {
    if (planned.kind === "not_found") {
      return c.json({ error: "Not found" }, 404);
    }
    // The merged document was refused before planning wrote anything. Answer
    // with the prepare-error body, so the diagnosis does not depend on which
    // stage of the deploy noticed first.
    if (planned.kind === "compose_rejected") {
      return responseForPrepareError(c, planned.error);
    }
    return c.json({ error: "Invalid compose document" }, 400);
  }
  const { plan } = planned;
  if (!plan.ok) {
    return responseForScheduleError(c, plan.error, plan.message);
  }
  return { ...planned, plan };
}

export function attachmentServerIds(
  attachments: readonly PlatformAttachment[],
): string[] {
  return attachments.map((row) => row.serverId);
}

export function tcpUdpIngressServiceRefs(
  services: ReadonlyArray<{ serviceId: string }>,
): Array<{ serviceId: string }> {
  return services.map((svc) => ({ serviceId: svc.serviceId }));
}

export function deployParticipation(params: {
  planServerIds: readonly string[];
  attachments: readonly PlatformAttachment[];
  previous: ReadonlyArray<{ serverId: string }>;
}): {
  attachmentServers: Set<string>;
  participating: Set<string>;
  drainedIds: string[];
} {
  const attachmentServers = new Set(attachmentServerIds(params.attachments));
  const participating = new Set([
    ...params.planServerIds,
    ...attachmentServers,
  ]);
  const activeDeployIds = new Set(params.planServerIds);
  const drainedIds: string[] = [];
  for (const row of params.previous) {
    if (!activeDeployIds.has(row.serverId)) drainedIds.push(row.serverId);
  }
  return { attachmentServers, participating, drainedIds };
}

async function awaitDeployFabricGate(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    planned: SuccessfulPlannedDeploy;
    auth: DeployRequestAuth;
    attachments: readonly PlatformAttachment[];
    dataEncryptionSecrets: DerivedSecretsConfig;
  },
): Promise<Response | null> {
  const fabricServerIds = [
    ...new Set([
      ...params.planned.plan.serverIds,
      ...attachmentServerIds(params.attachments),
    ]),
  ];
  if (!params.planned.fabricEnabled || fabricServerIds.length <= 1) {
    return null;
  }
  const fabricRow = await getOrganizationFabric(db, params.auth.organizationId);
  if (!fabricRow) return null;

  const secretsConfig = c.get("secretsConfig");
  const fabricGate = await awaitParticipatingFabricConvergence({
    db,
    commandQueue,
    actorType: params.auth.actorType,
    actorId: params.auth.actorId,
    fabric: fabricRow,
    serverIds: fabricServerIds,
    ...(secretsConfig ? { secretsConfig } : {}),
    dataEncryptionSecrets: params.dataEncryptionSecrets,
  });
  if (fabricGate.kind === "ready") return null;
  if (
    fabricGate.kind === "failed" &&
    fabricGate.error &&
    isFabricEnqueueTypedError(fabricGate.error)
  ) {
    return c.json({ error: fabricGate.error }, 422);
  }
  return responseForFabricGate(c, fabricGate);
}

function scheduleSliceForPreparedServer(
  params: {
    planned: SuccessfulPlannedDeploy;
    spanning: Map<string, string>;
    enriched: EnrichedTaskAddresses;
    attachments: PlatformAttachment[];
    consumers: ManagedIngressConsumer[];
    listenerNames: Map<string, string>;
    spanningHostNames: Set<string>;
    serverId: string;
  },
): ReturnType<typeof scheduleSliceForServer> {
  return scheduleSliceForServer(
    params.planned,
    params.serverId,
    params.spanning,
    params.enriched.slots,
    buildCompileAddressMaps({
      slots: params.enriched.slots,
      serviceIdToName: serviceIdToNameMap(params.planned.serviceRows),
      serverId: params.serverId,
      networkServiceIds: params.enriched.networkServiceIds,
    }),
    fabricNetworksForServer(
      params.enriched.segmentsByServer.get(params.serverId),
      params.spanningHostNames,
    ),
    reservedIngressHostsForServer({
      thisServerId: params.serverId,
      attachments: params.attachments,
      consumers: params.consumers,
      spanning: params.spanning,
      segmentsByServer: params.enriched.segmentsByServer,
      listenerNameByServer: params.listenerNames,
    }),
  );
}

/**
 * Compile one server's deployment.
 *
 * Everything a daemon is sent comes back on `prepared` — compose, material,
 * host-native lanes, hostings, TLS, ingress, listener ports. This layer decides
 * *which* server and *which* schedule slice, then enqueues; it assembles no part
 * of the payload itself. See `ServerDeployment` in `lib/compose/ir.ts`.
 */
async function prepareOneServerDeploy(
  c: Context<AppEnv>,
  db: Db,
  params: {
    planned: SuccessfulPlannedDeploy;
    environmentId: string;
    auth: DeployRequestAuth;
    spanning: Map<string, string>;
    attachments: PlatformAttachment[];
    consumers: ManagedIngressConsumer[];
    enriched: EnrichedTaskAddresses;
    listenerNames: Map<string, string>;
    spanningHostNames: Set<string>;
    serverId: string;
    /** Commit this deploy was asked to build; `prepareDeployCompose` consumes it. */
    selection: DeploySourceSelection;
    /**
     * Release ids for this deploy, allocated once for the whole fan-out. Every
     * server's prepare gets the *same* allocator, which is what makes one
     * release id describe one release of the environment rather than one per
     * host — see {@link ReleaseIdAllocator}.
     */
    releaseIds: ReleaseIdAllocator;
  },
): Promise<PreparedServerDeploy | Response> {
  const prepared = await prepareDeployCompose(c, db, {
    environmentId: params.environmentId,
    serverId: params.serverId,
    organizationId: params.auth.organizationId,
    acknowledgeHealthCheckWarnings: params.auth.acknowledgeHealthCheckWarnings,
    composeValidated: params.planned.composeValidated,
    schedule: scheduleSliceForPreparedServer(params),
    sourceSelection: params.selection,
    releaseIds: params.releaseIds,
    ...(params.auth.rollback === undefined
      ? {}
      : { rollback: params.auth.rollback }),
  });
  if (prepared instanceof Response) return prepared;
  if ("kind" in prepared) return responseForPrepareError(c, prepared);

  return { serverId: params.serverId, prepared };
}

async function prepareAllServerDeploys(
  c: Context<AppEnv>,
  db: Db,
  params: {
    planned: SuccessfulPlannedDeploy;
    environmentId: string;
    auth: DeployRequestAuth;
    dataEncryptionSecrets: DerivedSecretsConfig;
    selection: DeploySourceSelection;
  } & DeploySpanningContext,
): Promise<PreparedServerDeploy[] | Response> {
  const spanningHostNames = new Set(params.spanning.values());
  // One allocator for the whole fan-out, created *before* the loop: every
  // server below resolves the same compose services, and each of them must come
  // out carrying the same release id for a given service. Creating it per
  // iteration (or letting the resolver mint ids on its own) is precisely the bug
  // that makes an environment release un-rollbackable — see
  // {@link ReleaseIdAllocator}.
  const releaseIds = createReleaseIdAllocator();
  const preparedByServer: PreparedServerDeploy[] = [];
  for (const serverId of params.planned.plan.serverIds) {
    const row = await prepareOneServerDeploy(c, db, {
      ...params,
      spanningHostNames,
      serverId,
      releaseIds,
    });
    if (row instanceof Response) return row;
    preparedByServer.push(row);
  }
  return preparedByServer;
}

async function stopDrainedDeployments(
  db: Db,
  commandQueue: CommandQueue,
  params: DeployActor & {
    drainedIds: readonly string[];
    attachmentServers: ReadonlySet<string>;
    environmentId: string;
    projectId: string;
    projectName: string;
  },
): Promise<Response | null> {
  if (params.drainedIds.length === 0) return null;

  const tcpUdpServices = await resolveTcpUdpIngressServices(
    db,
    params.environmentId,
  );
  const composeNetworks = await listEnvironmentComposeNetworks(
    db,
    params.environmentId,
  );
  const namesByServer = composeNetworkNamesByServer(composeNetworks);
  const ingressServices = tcpUdpIngressServiceRefs(tcpUdpServices);
  // A drained server no longer runs this environment, so its release trees go
  // with the rest of the stack — the rows still describe them because the
  // environment lives on elsewhere.
  const siteReleases = await resolveEnvironmentSiteReleases(
    db,
    params.environmentId,
  );
  for (const serverId of params.drainedIds) {
    const stopped = await enqueueStopCommand(db, commandQueue, {
      serverId,
      actorType: params.actorType,
      actorId: params.actorId,
      environmentId: params.environmentId,
      projectId: params.projectId,
      projectName: params.projectName,
      ingressServices,
      fabricNetworks: namesByServer.get(serverId) ?? [],
      siteReleases,
    });
    if (stopped instanceof Response) return stopped;
    if (!params.attachmentServers.has(serverId)) {
      await releaseSubnetsForServer(db, {
        environmentId: params.environmentId,
        serverId,
      });
    }
  }
  await pruneDrainedDeployments(db, {
    environmentId: params.environmentId,
    serverIds: params.drainedIds,
  });
  return null;
}

async function releaseOrphanedComposeNetworks(
  db: Db,
  environmentId: string,
  participating: ReadonlySet<string>,
): Promise<string[]> {
  const leftoverNetworks = await listEnvironmentComposeNetworks(
    db,
    environmentId,
  );
  const leftoverByServer = composeNetworkNamesByServer(leftoverNetworks);
  const releasedListeners: string[] = [];
  for (const serverId of leftoverByServer.keys()) {
    if (!participating.has(serverId)) {
      await releaseSubnetsForServer(db, { environmentId, serverId });
      releasedListeners.push(serverId);
    }
  }
  return releasedListeners;
}

function serverNeedsIngressReconcile(
  serverId: string,
  params: {
    preparedByServer: readonly PreparedServerDeploy[];
    attachments: readonly PlatformAttachment[];
    consumers: readonly ManagedIngressConsumer[];
    spanning: ReadonlyMap<string, string>;
    segmentsByServer: Map<string, FabricSegmentMaterial[]>;
    listenerNames: Map<string, string>;
  },
): boolean {
  const prepared = params.preparedByServer.find((row) =>
    row.serverId === serverId
  );
  const hosts = reservedIngressHostsForServer({
    thisServerId: serverId,
    attachments: params.attachments,
    consumers: params.consumers,
    spanning: params.spanning,
    segmentsByServer: params.segmentsByServer,
    listenerNameByServer: params.listenerNames,
  });
  const managedCount = prepared?.prepared.managedNetworkServices.length ?? 0;
  return managedCount > 0 || hosts.size > 0;
}

export function ingressServerIdsForDeploy(params: {
  planServerIds: readonly string[];
  preparedByServer: readonly PreparedServerDeploy[];
  attachments: readonly PlatformAttachment[];
  consumers: readonly ManagedIngressConsumer[];
  spanning: ReadonlyMap<string, string>;
  segmentsByServer: Map<string, FabricSegmentMaterial[]>;
  listenerNames: Map<string, string>;
  releasedListeners: readonly string[];
}): Set<string> {
  const ingressServerIds = new Set<string>([
    ...attachmentServerIds(params.attachments),
    ...params.releasedListeners,
  ]);
  for (const serverId of params.planServerIds) {
    if (serverNeedsIngressReconcile(serverId, params)) {
      ingressServerIds.add(serverId);
    }
  }
  return ingressServerIds;
}

async function enqueueIngressReconcileAfterDeploy(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    auth: DeployRequestAuth;
    dataEncryptionSecrets: DerivedSecretsConfig;
    planServerIds: readonly string[];
    preparedByServer: readonly PreparedServerDeploy[];
    releasedListeners: readonly string[];
  } & DeploySpanningContext,
): Promise<void> {
  const secretsConfig = c.get("secretsConfig");
  if (!secretsConfig) return;

  const ingressServerIds = ingressServerIdsForDeploy({
    planServerIds: params.planServerIds,
    preparedByServer: params.preparedByServer,
    attachments: params.attachments,
    consumers: params.consumers,
    spanning: params.spanning,
    segmentsByServer: params.enriched.segmentsByServer,
    listenerNames: params.listenerNames,
    releasedListeners: params.releasedListeners,
  });
  for (const serverId of ingressServerIds) {
    await enqueueManagedIngressReconcile(db, commandQueue, {
      serverId,
      actorType: params.auth.actorType,
      actorId: params.auth.actorId,
      secretsConfig,
      dataEncryptionSecrets: params.dataEncryptionSecrets,
    });
  }
}

async function loadDeploySpanningContext(
  db: Db,
  planned: SuccessfulPlannedDeploy,
  organizationId: string,
  environmentId: string,
): Promise<DeploySpanningContext> {
  const { spanning, attachments, consumers } = await loadSpanningNetworks(
    db,
    planned,
    organizationId,
    environmentId,
  );
  const enriched = await enrichPlannedTaskAddresses(
    db,
    planned,
    spanning,
    environmentId,
    attachmentServerIds(attachments),
  );
  const listenerNames = await listenerNamesForAttachments(
    db,
    organizationId,
    attachments,
  );
  return { spanning, attachments, consumers, enriched, listenerNames };
}

async function runEnvironmentDeploy(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  environmentId: string,
  auth: DeployRequestAuth,
): Promise<Response> {
  const planned = await resolveSuccessfulPlan(
    c,
    db,
    environmentId,
    auth.organizationId,
  );
  if (planned instanceof Response) return planned;

  const priorNetworks = await listEnvironmentComposeNetworks(
    db,
    environmentId,
  );
  let spanningCommitted = false;
  try {
    const spanningCtx = await loadDeploySpanningContext(
      db,
      planned,
      auth.organizationId,
      environmentId,
    );
    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    if (!dataEncryptionSecrets) {
      return c.json({ error: "Encryption unavailable" }, 503);
    }

    const fabricGateError = await awaitDeployFabricGate(c, db, commandQueue, {
      planned,
      auth,
      attachments: spanningCtx.attachments,
      dataEncryptionSecrets,
    });
    if (fabricGateError) return fabricGateError;

    const preparedByServer = await prepareAllServerDeploys(c, db, {
      planned,
      environmentId,
      auth,
      selection: auth.selection,
      dataEncryptionSecrets,
      ...spanningCtx,
    });
    if (preparedByServer instanceof Response) return preparedByServer;

    const previous = await listEnvironmentDeploymentTargets(
      db,
      environmentId,
    );
    const { attachmentServers, participating, drainedIds } =
      deployParticipation(
      {
        planServerIds: planned.plan.serverIds,
        attachments: spanningCtx.attachments,
        previous,
      },
      );
    const projectName = composeProjectName(planned.projectId);
    // Recorded, not consumed, here: the current compose still names these, so
    // this is the snapshot a later stop/delete falls back to once it does not.
    const siteReleases = await resolveSourcedEnvironmentSiteReleases(
      db,
      environmentId,
    );
    const created = await persistDeployFanOut(db, {
      preparedByServer,
      planServerIds: planned.plan.serverIds,
      drainedIds,
      actorType: auth.actorType,
      actorId: auth.actorId,
      environmentId,
      projectId: planned.projectId,
      organizationId: auth.organizationId,
      projectName,
      slots: spanningCtx.enriched.slots,
      noCache: auth.noCache,
      selection: auth.selection,
      siteReleases,
    });
    spanningCommitted = true;
    const { queued, enqueueError } = await deliverDeployFanOut(
      db,
      commandQueue,
      { created, environmentId },
    );
    if (queued.length === 0 && enqueueError) return enqueueError;

    const drainedError = await stopDrainedDeployments(db, commandQueue, {
      drainedIds,
      attachmentServers,
      actorType: auth.actorType,
      actorId: auth.actorId,
      environmentId,
      projectId: planned.projectId,
      projectName,
    });
    if (drainedError) return drainedError;

    const releasedListeners = await releaseOrphanedComposeNetworks(
      db,
      environmentId,
      participating,
    );
    await enqueueIngressReconcileAfterDeploy(c, db, commandQueue, {
      auth,
      dataEncryptionSecrets,
      planServerIds: planned.plan.serverIds,
      preparedByServer,
      releasedListeners,
      ...spanningCtx,
    });

    return Response.json(queuedCommandsResponseBody(queued));
  } finally {
    if (!spanningCommitted) {
      await purgeComposeNetworksCreatedAfter(
        db,
        environmentId,
        priorNetworks,
      );
    }
  }
}

/**
 * Run a deploy for an already-authorized, non-session actor.
 *
 * The GitHub webhook path has no session, no `getOrgId`, and no manage grant to
 * evaluate — its authority is the HMAC signature plus the `source` row's own
 * organization. It must nevertheless land in exactly the same pipeline
 * (`persistDeployFanOut` → `deliverDeployFanOut`), because that is where
 * `environment.generation` is bumped and where the daemon's newer-generation
 * supersede rule gets its guarantee. Forking a second enqueue path would
 * silently opt webhook deploys out of it.
 *
 * Callers are responsible for authorization: this function performs none.
 */
export async function runEnvironmentDeployForActor(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  environmentId: string,
  auth: DeployRequestAuth,
): Promise<Response> {
  return await runEnvironmentDeploy(c, db, commandQueue, environmentId, auth);
}

/** Shared with the webhook trigger so it fails the same way on missing infra. */
export function assertDeployDispatchInfrastructure(
  c: Context<AppEnv>,
): CommandQueue | Response {
  return assertDispatchInfrastructure(c);
}

export function registerEnvironmentDeployRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError(
      "session secrets are required for environment deploy routes",
    );
  }
  router.use("/environments/:id/deploy", createSessionMiddleware(opts.secrets));

  router.post("/environments/:id/deploy", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const environmentId = c.req.param("id");
    const auth = await authorizeDeployRequest(c, db, environmentId);
    if (auth instanceof Response) return auth;

    // Prepare pins each service to its compose-declared branch, not to a ref
    // named on the request. Accepting one would answer `queued` to "deploy
    // release/1.4" and build the declared branch instead — the one outcome a
    // caller reaching for this field cannot detect. Refuse loudly.
    if (!PREPARE_HONORS_SOURCE_SELECTION && auth.selection.ref !== null) {
      return c.json({
        error: "source_ref_unsupported",
        message:
          "Deploying an explicit ref is not supported yet; omit `ref` to deploy " +
          "the environment's current state.",
        ref: auth.selection.ref,
      }, 501);
    }

    const commandQueue = assertDispatchInfrastructure(c);
    if (commandQueue instanceof Response) return commandQueue;

    return runEnvironmentDeploy(c, db, commandQueue, environmentId, auth);
  });
}

async function loadLifecycleTargets(
  db: Db,
  environmentId: string,
): Promise<
  | {
    projectId: string;
    projectName: string;
    serverIds: string[];
  }
  | Response
> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      serverId: environment.serverId,
    })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1);
  if (!envRow) return Response.json({ error: "Not found" }, { status: 404 });

  const [projectRow] = await db
    .select({
      id: project.id,
      options: project.options,
    })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1);
  if (!projectRow) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const deployments = await listEnvironmentDeploymentTargets(db, environmentId);
  const fromDeployments = [
    ...new Set(
      deployments
        .filter((row) => row.status !== "draining")
        .map((row) => row.serverId),
    ),
  ].sort((a, b) => a.localeCompare(b));
  if (fromDeployments.length > 0) {
    return {
      projectId: projectRow.id,
      projectName: composeProjectName(projectRow.id),
      serverIds: fromDeployments,
    };
  }

  const pin = resolveEffectivePlacementServerId(
    envRow.serverId,
    parseProjectOptions(projectRow.options),
  );
  if (!pin) {
    return Response.json({ error: "server_placement_required" }, {
      status: 409,
    });
  }
  return {
    projectId: projectRow.id,
    projectName: composeProjectName(projectRow.id),
    serverIds: [pin],
  };
}

async function enqueueStopCommand(
  db: Db,
  commandQueue: CommandQueue,
  params: DeployActor & {
    serverId: string;
    environmentId: string;
    projectId: string;
    projectName: string;
    ingressServices: Array<{ serviceId: string }>;
    fabricNetworks: string[];
    /** Per-service release trees to reclaim (generic, not site only). */
    siteReleases: EnvironmentSiteRelease[];
  },
): Promise<QueuedCommandRef | Response> {
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: params.actorType,
    actorId: params.actorId,
    type: "environment.stop",
    payload: {
      environmentId: params.environmentId,
      projectId: params.projectId,
      projectName: params.projectName,
      ...(params.ingressServices.length > 0
        ? { ingressServices: params.ingressServices }
        : {}),
      ...(params.fabricNetworks.length > 0
        ? { fabricNetworks: params.fabricNetworks }
        : {}),
      ...(params.siteReleases.length > 0
        ? { siteReleases: params.siteReleases }
        : {}),
    },
    expiresAt,
  });

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: params.serverId,
    type: "environment.stop",
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  };

  try {
    await commandQueue.enqueue(envelope);
  } catch {
    await transitionCommand(db, record.id, {
      status: "failed",
      error: "Command queue unavailable",
    });
    return Response.json({ error: "Command queue unavailable" }, {
      status: 503,
    });
  }

  return {
    commandId: record.id,
    serverId: params.serverId,
    status: "queued",
  };
}

/**
 * Register `POST /environments/:id/stop` — compose down (+ volumes) teardown.
 * Status is polled via existing `GET /servers/:serverId/commands/:commandId`.
 */
export function registerEnvironmentStopRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError(
      "session secrets are required for environment stop routes",
    );
  }
  router.use("/environments/:id/stop", createSessionMiddleware(opts.secrets));

  router.post("/environments/:id/stop", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const environmentId = c.req.param("id");
    const auth = await authorizeEnvironmentManage(c, db, environmentId);
    if (auth instanceof Response) return auth;

    const commandQueue = assertDispatchInfrastructure(c);
    if (commandQueue instanceof Response) return commandQueue;

    const loaded = await loadLifecycleTargets(db, environmentId);
    if (loaded instanceof Response) return loaded;

    const tcpUdpServices = await resolveTcpUdpIngressServices(
      db,
      environmentId,
    );
    const composeNetworks = await listEnvironmentComposeNetworks(
      db,
      environmentId,
    );
    const namesByServer = composeNetworkNamesByServer(composeNetworks);
    // Captured before the daemon runs: an explicit stop leaves the rows in
    // place, but this is the same set delete teardown has to snapshot, so both
    // paths resolve it the same way.
    const siteReleases = await resolveEnvironmentSiteReleases(
      db,
      environmentId,
    );
    const queued: QueuedCommandRef[] = [];
    for (const serverId of loaded.serverIds) {
      const enqueued = await enqueueStopCommand(db, commandQueue, {
        serverId,
        actorType: "user",
        actorId: auth.userId,
        environmentId,
        projectId: loaded.projectId,
        projectName: loaded.projectName,
        ingressServices: tcpUdpServices.map((svc) => ({
          serviceId: svc.serviceId,
        })),
        fabricNetworks: namesByServer.get(serverId) ?? [],
        siteReleases,
      });
      if (enqueued instanceof Response) return enqueued;
      queued.push(enqueued);
    }
    await purgeEnvironmentComposeNetworks(db, environmentId);
    const secretsConfig = c.get("secretsConfig");
    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    if (secretsConfig && dataEncryptionSecrets) {
      const ingressServerIds = new Set<string>([
        ...loaded.serverIds,
        ...namesByServer.keys(),
      ]);
      for (const serverId of ingressServerIds) {
        await enqueueManagedIngressReconcile(db, commandQueue, {
          serverId,
          actorType: "user",
          actorId: auth.userId,
          secretsConfig,
          dataEncryptionSecrets,
        });
      }
    }
    return Response.json(queuedCommandsResponseBody(queued));
  });
}

async function enqueueLifecycleCommand(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    serverId: string;
    userId: string;
    environmentId: string;
    projectId: string;
    projectName: string;
    action: EnvironmentLifecycleAction;
  },
): Promise<QueuedCommandRef | Response> {
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: "user",
    actorId: params.userId,
    type: "environment.lifecycle",
    payload: {
      environmentId: params.environmentId,
      projectId: params.projectId,
      projectName: params.projectName,
      action: params.action,
    },
    expiresAt,
  });

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: params.serverId,
    type: "environment.lifecycle",
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  };

  try {
    await commandQueue.enqueue(envelope);
  } catch {
    await transitionCommand(db, record.id, {
      status: "failed",
      error: "Command queue unavailable",
    });
    return Response.json({ error: "Command queue unavailable" }, {
      status: 503,
    });
  }

  return {
    commandId: record.id,
    serverId: params.serverId,
    status: "queued",
  };
}

/**
 * Register `POST /environments/:id/lifecycle` — non-destructive compose
 * start|stop|restart. Status is polled via existing command GET.
 */
export function registerEnvironmentLifecycleRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError(
      "session secrets are required for environment lifecycle routes",
    );
  }
  router.use(
    "/environments/:id/lifecycle",
    createSessionMiddleware(opts.secrets),
  );

  router.post("/environments/:id/lifecycle", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const environmentId = c.req.param("id");
    const auth = await authorizeEnvironmentManage(c, db, environmentId);
    if (auth instanceof Response) return auth;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const action = parseLifecycleAction(body);
    if (action === "invalid") {
      return c.json({ error: "Invalid request" }, 400);
    }

    const commandQueue = assertDispatchInfrastructure(c);
    if (commandQueue instanceof Response) return commandQueue;

    const loaded = await loadLifecycleTargets(db, environmentId);
    if (loaded instanceof Response) return loaded;

    const queued: QueuedCommandRef[] = [];
    for (const serverId of loaded.serverIds) {
      const enqueued = await enqueueLifecycleCommand(db, commandQueue, {
        serverId,
        userId: auth.userId,
        environmentId,
        projectId: loaded.projectId,
        projectName: loaded.projectName,
        action,
      });
      if (enqueued instanceof Response) return enqueued;
      queued.push(enqueued);
    }
    return Response.json(queuedCommandsResponseBody(queued));
  });
}
