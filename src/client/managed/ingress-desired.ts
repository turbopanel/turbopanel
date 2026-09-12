/**
 * Build + enqueue `managed.ingress.reconcile` for a server's ProxySQL frontend.
 *
 * Desired state is derived from all managed members on the server (and their
 * full cluster peer sets). Co-resident engines are addressed by Docker
 * container name on the organization's managed network; remote backends dial
 * the member's **private listener** (published only on that member's private address at
 * `replica.private_port`) — the same path engine→engine replication
 * uses for cross-host streaming.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db.ts";
import {
  decryptSecret,
  ENVELOPE_PREFIX_SECRET,
  resealSecretForDaemon,
} from "../authn/data-encryption.ts";
import type { DerivedSecretsConfig, SecretsConfig } from "../authn/secrets.ts";
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from "../../daemon/authn/server-identity-db.ts";
import type { CommandEnvelope } from "../../lib/commands/envelope.ts";
import type { CommandQueue } from "../../lib/commands/queue.ts";
import { ensureServerMonitorCredential } from "./monitor-credential.ts";
import type {
  ManagedApplyOrgTlsMaterial,
  ManagedIngressReconcileBackend,
  ManagedIngressReconcileCluster,
  ManagedIngressReconcileCommandPayload,
  ManagedIngressReconcileUser,
} from "../../lib/commands/schemas.ts";
import {
  createCommandRecord,
  transitionCommand,
} from "../../lib/db/command-records.ts";
import {
  container,
  managed,
  replica,
  principal,
  server,
  service,
} from "../../lib/db/schema.ts";
import { getManagedEngineSpec } from "../../lib/managed/index.ts";
import type { ManagedIngressPorts } from "../../lib/managed/ingress-ports.ts";
import type { ManagedSqlAccessScope } from "../../lib/managed/access-scope.ts";
import type { ManagedSettings } from "../../lib/managed/settings.ts";
import type { ManagedSslMode } from "../../lib/managed/ssl.ts";
import type { ManagedEngineCode } from "../../lib/managed/types.ts";
import {
  isPrivateEndpointError,
  type PrivateEndpointError,
  type PrivateEndpointPurpose,
  resolvePrivateEndpoints,
} from "../../lib/net/private-endpoint.ts";
import {
  ensureOrganizationManagedNetwork,
  listServerSubnets,
} from "../../lib/db/fabric-records.ts";
import { loadListenerAttachedSubnetNames } from "./ingress-attachments.ts";
import {
  isManagedAccessAddressError,
  type ManagedAccessAddressError,
  resolveManagedBindAddress,
} from "./access-address.ts";
import { consumerServerIdsForManaged } from "../bindings/resolve-endpoint.ts";
import { loadBoundManagedIdsForServer } from "./ingress-bound-consumers.ts";
import { requestedExposureScope } from "./host-exposure.ts";
import { materializeBindingsForPrincipal } from "../bindings/materialize.ts";
import { compatLogWarn } from "../../log-compat.ts";
import {
  loadManagedIngressPorts,
  loadManagedOrgDefaults,
} from "./org-defaults.ts";
import {
  ensureManagedIngressHierarchy,
  findManagedIngressHierarchy,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
  SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
} from "../system/hierarchy.ts";
import {
  boundManagedConsumersExists,
  managedMembersExists,
  SYSTEM_RECONCILE_MIN_INTERVAL_MS,
} from "../system/reconcile.ts";
import { WORKSPACE_KIND_TURBOPANEL } from "../../lib/db/workspace-kind.ts";
import {
  ensureMemberPrivatePorts,
  isManagedPrivatePortExhaustedError,
  listManagedMembers,
  resolveMemberTransports,
  updateMemberReplicationTransport,
} from "./members.ts";
import {
  buildManagedOrgTlsMaterial,
  ensureActiveOrganizationCa,
} from "./apply-prepare.ts";
import {
  organizationCaLeafNotAfterIso,
  pendingTlsLeafMetadata,
  type UpsertTlsLeafTrackingParams,
} from "../tls/leaf-tracking.ts";
import {
  buildIngressUserRole,
  buildLocalOrMissingPortBackend,
  buildRemoteIngressBackend,
  clusterAutoReadSplit,
  clusterRequireTls,
  collectProxySqlListenerSans,
  decideIngressBindScopes,
  hostgroupsForClusterIndex,
  isAtRestSealedPassword,
  mergeHierarchyContainerSan,
  principalConnectionRole,
  principalDefaultDatabase,
  protocolListenerForEngine,
  shouldSkipIngressFrontendUser,
  sortManagedIds,
} from "./ingress-desired-pure.ts";
import { parseManagedRowOptions } from "./options.ts";
import { resolveManagedConnectionListener } from "./routes-helpers.ts";

export const MANAGED_INGRESS_RECONCILE_TTL_MS = 300_000;

export type ManagedIngressReconcilePrepareError =
  | { kind: "daemon_key_unavailable"; serverId: string }
  | { kind: "managed_credential_not_sealed" }
  | ManagedAccessAddressError
  | PrivateEndpointError;

export {
  collectProxySqlListenerSans,
  hostgroupsForClusterIndex,
  unionExposureScopes,
} from "./ingress-desired-pure.ts";

export { loadBoundManagedIdsForServer } from "./ingress-bound-consumers.ts";

type MemberClusterRow = {
  memberId: string;
  managedId: string;
  serverId: string;
  role: string;
  readEligible: boolean;
  ordinal: number;
  privatePort: number | null;
  engine: string | null;
  options: unknown;
  organizationId: string | null;
  environmentId: string;
  containerName: string | null;
};

type MemberSelectRow = Omit<MemberClusterRow, "containerName">;

async function attachContainerNames(
  db: Db,
  rows: readonly MemberSelectRow[],
): Promise<MemberClusterRow[]> {
  if (rows.length === 0) return [];

  const environmentIds = [...new Set(rows.map((row) => row.environmentId))];
  const containerRows = await db
    .select({
      environmentId: service.environmentId,
      serverId: container.serverId,
      ordinal: container.ordinal,
      containerName: container.containerName,
    })
    .from(container)
    .innerJoin(service, eq(container.serviceId, service.id))
    .where(
      and(
        inArray(service.environmentId, environmentIds),
        eq(container.role, "service"),
      ),
    );

  const containerByKey = new Map<string, string>();
  for (const row of containerRows) {
    if (!row.containerName) continue;
    containerByKey.set(
      `${row.environmentId}:${row.serverId}:${row.ordinal}`,
      row.containerName,
    );
  }

  return rows.map((row) => ({
    ...row,
    containerName: containerByKey.get(
      `${row.environmentId}:${row.serverId}:${row.ordinal}`,
    ) ?? null,
  }));
}

const MEMBER_SELECT = {
  memberId: replica.id,
  managedId: replica.managedId,
  serverId: replica.serverId,
  role: replica.role,
  readEligible: replica.isReadEligible,
  ordinal: replica.ordinal,
  privatePort: replica.privatePort,
  engine: managed.engine,
  options: managed.options,
  organizationId: server.organizationId,
  environmentId: managed.environmentId,
};

async function loadMembersOnServer(
  db: Db,
  serverId: string,
): Promise<MemberClusterRow[]> {
  const rows = await db
    .select(MEMBER_SELECT)
    .from(replica)
    .innerJoin(managed, eq(replica.managedId, managed.id))
    .innerJoin(server, eq(replica.serverId, server.id))
    .where(eq(replica.serverId, serverId));
  return attachContainerNames(db, rows);
}

async function loadClusterMembersForManagedIds(
  db: Db,
  managedIds: readonly string[],
): Promise<Map<string, MemberClusterRow[]>> {
  const byManaged = new Map<string, MemberClusterRow[]>();
  for (const managedId of managedIds) byManaged.set(managedId, []);
  if (managedIds.length === 0) return byManaged;

  const rows = await db
    .select(MEMBER_SELECT)
    .from(replica)
    .innerJoin(managed, eq(replica.managedId, managed.id))
    .innerJoin(server, eq(replica.serverId, server.id))
    .where(inArray(replica.managedId, [...managedIds]));

  const attached = await attachContainerNames(db, rows);
  for (const row of attached) {
    const list = byManaged.get(row.managedId) ?? [];
    list.push(row);
    byManaged.set(row.managedId, list);
  }
  return byManaged;
}

async function loadClusterUsersForManagedIds(
  db: Db,
  managedIds: readonly string[],
  params: {
    serverId: string;
    secretsConfig: SecretsConfig;
    dataEncryptionSecrets: DerivedSecretsConfig;
  },
): Promise<
  | Map<string, ManagedIngressReconcileUser[]>
  | ManagedIngressReconcilePrepareError
> {
  const byManaged = new Map<string, ManagedIngressReconcileUser[]>();
  for (const managedId of managedIds) byManaged.set(managedId, []);
  if (managedIds.length === 0) return byManaged;

  const daemonState = await getServerDaemonStateByServerId(db, params.serverId);
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: "daemon_key_unavailable", serverId: params.serverId };
  }

  const rows = await db
    .select({
      managedId: principal.managedId,
      id: principal.id,
      // Applied login — ProxySQL frontend usernames are what clients type.
      username: principal.appliedUsername,
      metadata: principal.metadata,
      password: principal.password,
    })
    .from(principal)
    .where(inArray(principal.managedId, [...managedIds]));

  for (const row of rows) {
    if (!row.managedId) continue;
    if (shouldSkipIngressFrontendUser(row.username, row.metadata)) continue;
    const sealed = row.password;
    if (!isAtRestSealedPassword(sealed, ENVELOPE_PREFIX_SECRET)) {
      return { kind: "managed_credential_not_sealed" };
    }
    const resealed = await resealSecretForDaemon(
      params.secretsConfig,
      params.dataEncryptionSecrets,
      { serverId: params.serverId, keyId: daemonState.key.id },
      sealed,
    );
    const user: ManagedIngressReconcileUser = {
      username: row.username,
      role: buildIngressUserRole(row.metadata),
      password: resealed,
    };
    const defaultDatabase = principalDefaultDatabase(row.metadata);
    if (defaultDatabase !== undefined) user.defaultDatabase = defaultDatabase;
    const connectionRole = principalConnectionRole(row.metadata);
    if (connectionRole !== undefined) user.connectionRole = connectionRole;
    const list = byManaged.get(row.managedId) ?? [];
    list.push(user);
    byManaged.set(row.managedId, list);
  }
  for (const [managedId, users] of byManaged) {
    users.sort((a, b) => a.username.localeCompare(b.username));
    byManaged.set(managedId, users);
  }
  return byManaged;
}

async function buildOrgTlsForServer(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  organizationId: string,
  serverId: string,
  listenerSans: {
    dnsNames: string[];
    ipAddresses: string[];
  },
): Promise<
  | { material: ManagedApplyOrgTlsMaterial; pendingTlsLeaf: UpsertTlsLeafTrackingParams }
  | ManagedIngressReconcilePrepareError
> {
  const daemonState = await getServerDaemonStateByServerId(db, serverId);
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: "daemon_key_unavailable", serverId };
  }

  const ca = await ensureActiveOrganizationCa(
    db,
    dataEncryptionSecrets,
    organizationId,
  );
  if ("kind" in ca) {
    // ensureActiveOrganizationCa prepare errors are a subset of ingress prepare errors
    return ca as ManagedIngressReconcilePrepareError;
  }

  const caPrivateKeyPem = await decryptSecret(
    dataEncryptionSecrets,
    ca.signer.privateKeyPemSealed,
  );
  const material = await buildManagedOrgTlsMaterial(
    secretsConfig,
    dataEncryptionSecrets,
    { serverId, keyId: daemonState.key.id },
    {
      certificatePem: ca.signer.certificatePem,
      privateKeyPem: caPrivateKeyPem,
      trustBundlePem: ca.trustBundlePem,
    },
    `ingress-${serverId}`,
    listenerSans.dnsNames,
    listenerSans.ipAddresses,
  );
  return {
    material,
    pendingTlsLeaf: {
      kind: "ingress",
      organizationId,
      serverId,
      caId: ca.signer.id,
      caGeneration: ca.signer.caGeneration,
      notAfter: organizationCaLeafNotAfterIso(),
    },
  };
}

function resolveClusterBackends(
  serverId: string,
  members: MemberClusterRow[],
  port: number,
  endpoints: Awaited<ReturnType<typeof resolvePrivateEndpoints>>,
): ManagedIngressReconcileBackend[] | ManagedIngressReconcilePrepareError {
  const backends: ManagedIngressReconcileBackend[] = [];
  for (const member of members) {
    const localOrMissing = buildLocalOrMissingPortBackend(
      serverId,
      member,
      port,
    );
    if (localOrMissing.kind === "ok") {
      backends.push(localOrMissing.backend);
      continue;
    }
    if (localOrMissing.kind === "private_path_unavailable") {
      return {
        kind: "private_path_unavailable",
        fromServerId: localOrMissing.fromServerId,
        toServerId: localOrMissing.toServerId,
      };
    }

    const resolved = endpoints.get(member.serverId);
    if (!resolved || isPrivateEndpointError(resolved)) {
      return resolved && isPrivateEndpointError(resolved) ? resolved : {
        kind: "private_path_unavailable",
        fromServerId: serverId,
        toServerId: member.serverId,
      };
    }

    const privatePort = member.privatePort;
    if (privatePort === null) {
      return {
        kind: "private_path_unavailable",
        fromServerId: serverId,
        toServerId: member.serverId,
      };
    }

    backends.push(buildRemoteIngressBackend({
      memberId: member.memberId,
      role: localOrMissing.role,
      readEligible: member.readEligible,
      address: resolved.address,
      privatePort,
      transport: resolved.transport,
    }));
  }
  backends.sort((a, b) => a.memberId.localeCompare(b.memberId));
  return backends;
}

/**
 * Build one cluster entry for `managedId`, recording its requested access scope
 * (`undefined` when exposure is off) onto `enabledScopes`. Returns `null` when
 * the cluster has no members or an unrecognized engine (nothing to reconcile).
 */
function buildIngressClusterFromLoaded(
  managedId: string,
  members: MemberClusterRow[],
  index: number,
  enabledScopes: Array<ManagedSqlAccessScope | undefined>,
  backends: ManagedIngressReconcileBackend[],
  users: ManagedIngressReconcileUser[],
  orgDefaults: IngressOrgDefaults,
): ManagedIngressReconcileCluster | null {
  if (members.length === 0) return null;

  const sample = members[0]!;
  const engineCode = (sample.engine ?? "postgres") as ManagedEngineCode;
  const spec = getManagedEngineSpec(engineCode);
  if (!spec) return null;

  const parsed = parseManagedRowOptions(spec, sample.options);
  const settings: ManagedSettings = parsed?.settings ??
    { ...spec.defaultSettings };
  // One entry per cluster, `undefined` when it wants no host publish. The
  // union of these is the host's published scope set — the same derivation the
  // connection surface uses (`./host-exposure.ts`), so what an operator is told
  // is dialable is exactly what gets published.
  enabledScopes.push(requestedExposureScope(settings.exposure));

  const hostgroups = hostgroupsForClusterIndex(index);
  const listener = protocolListenerForEngine(
    engineCode,
    spec.defaultPort,
    orgDefaults.listenerPorts,
  );

  const cluster: ManagedIngressReconcileCluster = {
    managedId,
    engine: engineCode,
    protocolPort: listener.protocolPort,
    // Explicit: once ports are org-configurable the daemon can no longer infer
    // the protocol module from the port number.
    family: listener.family,
    writerHostgroup: hostgroups.writerHostgroup,
    readerHostgroup: hostgroups.readerHostgroup,
    backends,
    users,
  };
  if (clusterAutoReadSplit(settings.routing)) cluster.autoReadSplit = true;
  if (clusterRequireTls(settings.ssl.mode, orgDefaults.sslMode)) {
    cluster.requireTls = true;
  }
  return cluster;
}

/**
 * Every host address the shared ProxySQL frontend publishes on — never let an
 * ambiguous `undefined` mean two different things.
 *
 * Pure scope decision lives in {@link decideIngressBindScopes}. The result is a
 * set because one frontend serves every cluster on the host and two clusters
 * may legitimately want two different interfaces; an unresolvable scope fails
 * the whole reconcile rather than publishing a surprise address.
 *
 * An empty result (no cluster on the host asked for a publish) is the whole
 * enforcement of the exposure toggle: the daemon publishes no `ports:` at all
 * and the engines are reachable only over the organization's managed Docker
 * network. It must never be widened to "publish on every interface anyway".
 *
 * The converse is a real limitation, not an oversight: one exposed cluster
 * publishes the listener for **every** cluster on the host, because ProxySQL
 * serves them all on one port and has no per-user source ACL. Splitting that
 * needs a per-cluster published port or a host firewall keyed on
 * `settings.exposure`. Until then `resolveManagedEffectiveExposure` reports the
 * co-residency instead of pretending the neighbour is unreachable.
 */
async function resolveIngressBindAddresses(
  db: Db,
  serverId: string,
  enabledScopes: Array<ManagedSqlAccessScope | undefined>,
): Promise<string[] | ManagedIngressReconcilePrepareError> {
  const decision = decideIngressBindScopes(enabledScopes);
  if (decision.kind === "omit") return [];
  if (decision.kind === "public_all_interfaces") {
    return [...decision.addresses];
  }

  const addresses: string[] = [];
  for (const scope of decision.scopes) {
    const resolved = await resolveManagedBindAddress(db, { serverId, scope });
    if (isManagedAccessAddressError(resolved)) return resolved;
    // Distinct scopes can resolve to the same address (a single-homed host);
    // compose would reject the duplicate published mapping.
    if (!addresses.includes(resolved)) addresses.push(resolved);
  }
  return addresses;
}

/**
 * Organization-resolved managed-database policy that applies to every cluster
 * on one ProxySQL: the effective client TLS default and the listener ports.
 */
type IngressOrgDefaults = {
  sslMode: ManagedSslMode | undefined;
  listenerPorts: ManagedIngressPorts;
};

/** Build every cluster entry for `managedIds`, short-circuiting on the first error. */
async function buildIngressClusters(
  db: Db,
  serverId: string,
  managedIds: readonly string[],
  enabledScopes: Array<ManagedSqlAccessScope | undefined>,
  reseal: {
    secretsConfig: SecretsConfig;
    dataEncryptionSecrets: DerivedSecretsConfig;
  },
  orgDefaults: IngressOrgDefaults,
): Promise<
  ManagedIngressReconcileCluster[] | ManagedIngressReconcilePrepareError
> {
  const membersByManaged = await loadClusterMembersForManagedIds(
    db,
    managedIds,
  );
  const allMembers = [...membersByManaged.values()].flat();
  const remoteIds = [
    ...new Set(
      allMembers
        .filter((member) => member.serverId !== serverId)
        .map((member) => member.serverId),
    ),
  ];
  const endpoints = await resolvePrivateEndpoints(db, {
    fromServerId: serverId,
    toServerIds: remoteIds,
    purpose: "client-backend",
  });
  const usersByManaged = await loadClusterUsersForManagedIds(db, managedIds, {
    serverId,
    secretsConfig: reseal.secretsConfig,
    dataEncryptionSecrets: reseal.dataEncryptionSecrets,
  });
  if ("kind" in usersByManaged) return usersByManaged;

  const clusters: ManagedIngressReconcileCluster[] = [];
  for (let index = 0; index < managedIds.length; index++) {
    const managedId = managedIds[index]!;
    const members = membersByManaged.get(managedId) ?? [];
    if (members.length === 0) continue;
    const sample = members[0]!;
    const engineCode = (sample.engine ?? "postgres") as ManagedEngineCode;
    const spec = getManagedEngineSpec(engineCode);
    if (!spec) continue;
    const backends = resolveClusterBackends(
      serverId,
      members,
      spec.defaultPort,
      endpoints,
    );
    if ("kind" in backends) return backends;
    const cluster = buildIngressClusterFromLoaded(
      managedId,
      members,
      index,
      enabledScopes,
      backends,
      usersByManaged.get(managedId) ?? [],
      orgDefaults,
    );
    if (cluster === null) continue;
    clusters.push(cluster);
  }
  return clusters;
}

/**
 * Prefer the same host clients see (connection panel / binding resolver):
 * the first cluster whose exposure listener resolves a host wins.
 */
async function resolveAdvertisedHost(
  db: Db,
  serverId: string,
  fallbackHost: string | null,
  clusters: readonly ManagedIngressReconcileCluster[],
): Promise<string | null> {
  if (clusters.length === 0) return fallbackHost;
  const rows = await db
    .select({
      id: managed.id,
      options: managed.options,
      engine: managed.engine,
    })
    .from(managed)
    .where(inArray(managed.id, clusters.map((cluster) => cluster.managedId)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const cluster of clusters) {
    const sample = byId.get(cluster.managedId);
    if (!sample) continue;
    const engineCode = (sample.engine ?? "postgres") as ManagedEngineCode;
    const spec = getManagedEngineSpec(engineCode);
    if (!spec) continue;
    const parsed = parseManagedRowOptions(spec, sample.options);
    const settings = parsed?.settings ?? { ...spec.defaultSettings };
    const listener = await resolveManagedConnectionListener(db, {
      serverId,
      engineCode,
      engineDefaultPort: spec.defaultPort,
      exposure: settings.exposure,
    });
    if (listener?.host) return listener.host;
  }
  return fallbackHost;
}

type BuiltManagedIngressReconcile = {
  payload: ManagedIngressReconcileCommandPayload;
  pendingTlsLeaf?: UpsertTlsLeafTrackingParams;
};

/** Internal: payload plus minted ingress leaf that is not yet deployed. */
async function buildManagedIngressReconcileDesired(
  db: Db,
  params: {
    serverId: string;
    secretsConfig: SecretsConfig;
    dataEncryptionSecrets: DerivedSecretsConfig;
  },
): Promise<
  | BuiltManagedIngressReconcile
  | null
  | ManagedIngressReconcilePrepareError
> {
  const localMembers = await loadMembersOnServer(db, params.serverId);

  const [serverRow] = await db
    .select({
      organizationId: server.organizationId,
      hostname: server.hostname,
    })
    .from(server)
    .where(eq(server.id, params.serverId))
    .limit(1);
  if (!serverRow) return null;

  const organizationId = localMembers[0]?.organizationId ??
    serverRow.organizationId;
  if (!organizationId) return null;

  // Server-owner org, not a member's org: one ProxySQL frontend per host joins
  // exactly one managed network, the same scope the listener ports use below.
  // The network row itself is allocated lazily, only on the branches that
  // actually emit a payload — a reconcile that finds nothing to do must not
  // leave a `managed` network behind for an org that never used one.
  const serverOwnerOrganizationId = serverRow.organizationId ?? organizationId;

  const boundManagedIds = await loadBoundManagedIdsForServer(
    db,
    params.serverId,
    organizationId,
  );

  const managedIdSet = new Set<string>([
    ...localMembers.map((row) => row.managedId),
    ...boundManagedIds,
  ]);
  if (managedIdSet.size === 0) {
    const existing = await findManagedIngressHierarchy(db, {
      serverId: params.serverId,
    });
    if (!existing) return null;
    const teardownNetwork = await ensureOrganizationManagedNetwork(db, {
      organizationId: serverOwnerOrganizationId,
    });
    return {
      payload: {
        serverId: params.serverId,
        managedNetwork: teardownNetwork.hostName,
        clusters: [],
      },
    };
  }

  const hierarchy = await ensureManagedIngressHierarchy(db, {
    organizationId,
    serverId: params.serverId,
  });

  const managedIds = sortManagedIds(managedIdSet);

  const orgDefaults = await loadManagedOrgDefaults(db, organizationId);
  // TLS mode is a property of the org that owns the managed service, but the
  // listener ports are a property of the host: one ProxySQL frontend binds one
  // pair of ports for every cluster it fronts. Reading them from a member's org
  // would make the bind flap when a grant places two orgs' members on one
  // server, so they come from the server owner.
  const listenerPorts = await loadManagedIngressPorts(
    db,
    serverOwnerOrganizationId,
  );

  const enabledScopes: Array<ManagedSqlAccessScope | undefined> = [];
  const clusters = await buildIngressClusters(
    db,
    params.serverId,
    managedIds,
    enabledScopes,
    {
      secretsConfig: params.secretsConfig,
      dataEncryptionSecrets: params.dataEncryptionSecrets,
    },
    { sslMode: orgDefaults.sslMode, listenerPorts },
  );
  if ("kind" in clusters) return clusters;
  if (clusters.length === 0) return null;

  const bindAddresses = await resolveIngressBindAddresses(
    db,
    params.serverId,
    enabledScopes,
  );
  if (!Array.isArray(bindAddresses)) return bindAddresses;

  const advertisedHost = await resolveAdvertisedHost(
    db,
    params.serverId,
    serverRow.hostname,
    clusters,
  );

  const backendAddresses = clusters.flatMap((c) =>
    c.backends.map((b) => b.address)
  );
  const listenerSans = collectProxySqlListenerSans({
    hostname: advertisedHost,
    bindAddresses,
    backendAddresses,
  });
  // Bindings (`resolveBindingEndpoint`) always dial ProxySQL by this
  // container's own Docker name over the organization's managed network,
  // regardless of the public `bindAddress` — the leaf cert must carry it as a
  // SAN or `sslmode=verify-full` binding connections fail hostname
  // verification even though the TCP path is reachable.
  const listenerSansWithHierarchy = mergeHierarchyContainerSan(
    listenerSans,
    hierarchy.containerName,
  );

  const orgTlsMaterial = await buildOrgTlsForServer(
    db,
    params.secretsConfig,
    params.dataEncryptionSecrets,
    organizationId,
    params.serverId,
    listenerSansWithHierarchy,
  );
  if ("kind" in orgTlsMaterial) return orgTlsMaterial;

  const managedNetwork = await ensureOrganizationManagedNetwork(db, {
    organizationId: serverOwnerOrganizationId,
  });

  const payload: ManagedIngressReconcileCommandPayload = {
    serverId: params.serverId,
    managedNetwork: managedNetwork.hostName,
    orgTlsMaterial: orgTlsMaterial.material,
    // Always both listeners: ProxySQL configures them in one file, so sending
    // only the families present today would unbind the other on the next apply.
    listenerPorts,
    clusters,
    identity: {
      serviceId: hierarchy.serviceId,
      composeServiceName: SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
      containerName: hierarchy.containerName,
    },
  };

  if (bindAddresses.length > 0) {
    payload.bindAddresses = bindAddresses;
  }

  // This server's own monitor credential: the daemon sets ProxySQL's global
  // monitor user/password from it and rewrites host `monitor.cnf`. Engines
  // learn every fronting server's credential via `managed.apply` monitorUsers.
  {
    const monitorCred = await ensureServerMonitorCredential(
      db,
      params.dataEncryptionSecrets,
      params.serverId,
    );
    const daemonState = await getServerDaemonStateByServerId(
      db,
      params.serverId,
    );
    if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
      return { kind: "daemon_key_unavailable", serverId: params.serverId };
    }
    payload.monitor = {
      username: monitorCred.username,
      password: await resealSecretForDaemon(
        params.secretsConfig,
        params.dataEncryptionSecrets,
        { serverId: params.serverId, keyId: daemonState.key.id },
        monitorCred.passwordSealed,
      ),
    };
  }

  const attachedNames = new Set(
    await loadListenerAttachedSubnetNames(db, params.serverId),
  );
  if (attachedNames.size > 0) {
    const segments = (await listServerSubnets(db, params.serverId))
      .filter((row) => attachedNames.has(row.name))
      .map((row) => ({ name: row.name, subnet: row.subnet }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (segments.length > 0) payload.segments = segments;
  }

  return { payload, pendingTlsLeaf: orgTlsMaterial.pendingTlsLeaf };
}

/**
 * Build the full `managed.ingress.reconcile` payload for a server.
 *
 * The ProxySQL stack exists on a server **iff** it hosts a managed `replica` row
 * or a bound consumer (`loadBoundManagedIdsForServer`) — never on every org
 * server. Returns `null` when neither is true **and** no prior hierarchy
 * exists. When a prior hierarchy exists but the set is empty, returns a
 * teardown payload `{ serverId, managedNetwork, clusters: [] }` — the
 * organization's managed network is carried on every payload, teardown
 * included — with no bindAddress / TLS.
 */
export async function buildManagedIngressReconcilePayload(
  db: Db,
  params: {
    serverId: string;
    secretsConfig: SecretsConfig;
    dataEncryptionSecrets: DerivedSecretsConfig;
  },
): Promise<
  | ManagedIngressReconcileCommandPayload
  | null
  | ManagedIngressReconcilePrepareError
> {
  const built = await buildManagedIngressReconcileDesired(db, params);
  if (built === null || "kind" in built) return built;
  return built.payload;
}

export type EnqueueManagedIngressReconcileResult =
  | { ok: true; commandId: string; serverId: string }
  | { ok: false; reason: "not_needed" | "enqueue_failed" | "prepare_failed" };

/**
 * Create + enqueue one `managed.ingress.reconcile` for the server.
 * Compensates the command row to `failed` when the queue rejects.
 * Callers own per-request server-id dedup (`Set`).
 */
export async function enqueueManagedIngressReconcile(
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{
    serverId: string;
    actorType: "user" | "system";
    actorId: string;
    secretsConfig: SecretsConfig;
    dataEncryptionSecrets: DerivedSecretsConfig;
  }>,
): Promise<EnqueueManagedIngressReconcileResult> {
  const built = await buildManagedIngressReconcileDesired(db, {
    serverId: params.serverId,
    secretsConfig: params.secretsConfig,
    dataEncryptionSecrets: params.dataEncryptionSecrets,
  });
  if (built === null) return { ok: false, reason: "not_needed" };
  if ("kind" in built) return { ok: false, reason: "prepare_failed" };

  const expiresAt = new Date(
    Date.now() + MANAGED_INGRESS_RECONCILE_TTL_MS,
  ).toISOString();
  const metadata = built.pendingTlsLeaf
    ? pendingTlsLeafMetadata(built.pendingTlsLeaf)
    : undefined;

  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: params.actorType,
    actorId: params.actorId,
    type: "managed.ingress.reconcile",
    payload: built.payload,
    expiresAt,
    ...(metadata ? { metadata } : {}),
  });

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: params.serverId,
    type: "managed.ingress.reconcile",
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
    return { ok: false, reason: "enqueue_failed" };
  }

  return { ok: true, commandId: record.id, serverId: params.serverId };
}

/**
 * Re-resolve and persist `replica.replication_transport` for every member
 * relative to the current primary. Runs after a promote and after a
 * datacenter routing-policy change (`priority` / `trusted`), so stored
 * transports always reflect the live ladder.
 */
async function recomputeManagedMemberTransports(
  db: Db,
  managedId: string,
): Promise<void> {
  const members = await listManagedMembers(db, managedId);
  const withPorts = await ensureMemberPrivatePorts(db, members);
  if (isManagedPrivatePortExhaustedError(withPorts)) {
    compatLogWarn(
      "managed-ingress",
      `private port exhausted during promote fan-out managedId=${managedId} serverId=${withPorts.serverId}`,
    );
    return;
  }

  const failoverSubset = withPorts.filter((member) =>
    member.role === "primary" || member.replicaClass !== "read"
  );
  const readSubset = withPorts.filter((member) =>
    member.role === "primary" || member.replicaClass === "read"
  );

  const persist = async (
    subset: typeof withPorts,
    purpose: PrivateEndpointPurpose,
  ): Promise<void> => {
    if (subset.length === 0) return;
    const transports = await resolveMemberTransports(db, subset, purpose);
    if (isPrivateEndpointError(transports)) {
      compatLogWarn(
        "managed-ingress",
        `transport recompute failed during promote fan-out managedId=${managedId} kind=${transports.kind}`,
      );
      return;
    }
    for (const member of subset) {
      const transport = transports.get(member.id) ?? null;
      await updateMemberReplicationTransport(db, member.id, transport);
    }
  };

  await persist(failoverSubset, "failover-replication");
  const hasReadReplica = readSubset.some((member) =>
    member.replicaClass === "read"
  );
  if (hasReadReplica) {
    await persist(readSubset, "read-replication");
  }
}

async function rematerializeManagedBindings(
  db: Db,
  managedId: string,
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<void> {
  const principals = await db
    .select({ id: principal.id })
    .from(principal)
    .where(eq(principal.managedId, managedId));
  for (const row of principals) {
    const result = await materializeBindingsForPrincipal(
      db,
      dataEncryptionSecrets,
      row.id,
    );
    if (!("ok" in result)) {
      compatLogWarn(
        "managed-ingress",
        `binding rematerialize failed during promote fan-out managedId=${managedId} principalId=${row.id} kind=${result.kind}`,
      );
    }
  }
}

/**
 * Ordered promote-pipeline tail: recompute member transports relative to the
 * new primary, re-materialize binding-owned HOST/PORT/URL variables, then
 * enqueue `managed.ingress.reconcile` on every member and consuming server.
 * Also the re-convergence step `PATCH /datacenters/:id` runs when a
 * datacenter's `priority` / `trusted` policy changes.
 *
 * Non-goals: no automatic failover (promote stays operator-triggered), no
 * ProxySQL→ProxySQL chaining, no DNS / floating-IP primary discovery.
 */
export async function fanOutManagedIngressReconcile(
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{
    managedId: string;
    actorType: "user" | "system";
    actorId: string;
    secretsConfig: SecretsConfig;
    dataEncryptionSecrets: DerivedSecretsConfig;
    extraServerIds?: readonly string[];
  }>,
): Promise<void> {
  await recomputeManagedMemberTransports(db, params.managedId);
  await rematerializeManagedBindings(
    db,
    params.managedId,
    params.dataEncryptionSecrets,
  );

  const memberIds = await db
    .select({ serverId: replica.serverId })
    .from(replica)
    .where(eq(replica.managedId, params.managedId));
  const consumerIds = await consumerServerIdsForManaged(db, params.managedId);
  const serverIds = new Set<string>([
    ...memberIds.map((row) => row.serverId),
    ...consumerIds,
    ...(params.extraServerIds ?? []),
  ]);

  for (const serverId of serverIds) {
    await enqueueManagedIngressReconcile(db, commandQueue, {
      serverId,
      actorType: params.actorType,
      actorId: params.actorId,
      secretsConfig: params.secretsConfig,
      dataEncryptionSecrets: params.dataEncryptionSecrets,
    });
  }
}

/** Bounded batch for one orphaned-frontend sweep tick. */
const MANAGED_INGRESS_ORPHAN_SWEEP_CAP = 25;

/**
 * Tear down orphaned ProxySQL frontends that the deletion fan-outs missed.
 *
 * Bring-up is demand-driven, so tear-down has to be too: daemon-side
 * `system.reconcile` treats `desired: 'absent'` as report-only (it re-stamps
 * the observed container as `running`), and `runSystemReconcileSweep` only
 * considers servers that still have managed members or bound consumers. When a
 * cascade delete (project / environment / service / principal) removes the
 * last demand rows without enqueuing `managed.ingress.reconcile`, the stack
 * would stay resident forever.
 *
 * This sweep selects connected servers whose managed-ingress container row is
 * still observed (`running` or id-stamped) while neither demand predicate
 * holds, and enqueues the standard reconcile:
 * `buildManagedIngressReconcileDesired` re-derives the empty set and emits the
 * `{ clusters: [] }` teardown payload. A successful teardown resets the
 * container row (`exited`, `container_id` NULL), which ends candidacy.
 */
export async function runManagedIngressOrphanSweep(
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{
    secretsConfig: SecretsConfig;
    dataEncryptionSecrets: DerivedSecretsConfig;
    budget?: number;
  }>,
): Promise<{ enqueued: number }> {
  const budget = Math.min(
    Math.max(1, params.budget ?? MANAGED_INGRESS_ORPHAN_SWEEP_CAP),
    MANAGED_INGRESS_ORPHAN_SWEEP_CAP,
  );
  const throttleCutoff = new Date(
    Date.now() - SYSTEM_RECONCILE_MIN_INTERVAL_MS,
  ).toISOString();

  const candidates = await db.execute<{ server_id: string }>(sql`
    SELECT DISTINCT srv.id AS server_id
    FROM server srv
    JOIN environment e ON e.server_id = srv.id
    JOIN project p ON p.id = e.project_id
    JOIN workspace w ON w.id = p.workspace_id
    JOIN service s ON s.environment_id = e.id
    JOIN container c ON c.service_id = s.id AND c.ordinal = 1
    WHERE w.kind = ${WORKSPACE_KIND_TURBOPANEL}
      AND srv.is_connected = true
      AND p.metadata->>'component' = ${SYSTEM_MANAGED_INGRESS_COMPONENT}
      AND s.name = ${SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME}
      AND c.role = 'ingress'
      AND (c.status = 'running' OR c.container_id IS NOT NULL)
      AND NOT ${managedMembersExists(sql`srv.id`)}
      AND NOT ${boundManagedConsumersExists(
        sql`srv.id`,
        sql`srv.organization_id`,
      )}
      AND NOT EXISTS (
        SELECT 1
        FROM command cmd
        WHERE cmd.server_id = srv.id
          AND cmd.name = 'managed.ingress.reconcile'
          AND cmd.created_at >= ${throttleCutoff}::timestamptz
      )
    ORDER BY srv.id
    LIMIT ${budget}
  `);

  let enqueued = 0;
  for (const row of candidates) {
    const result = await enqueueManagedIngressReconcile(db, commandQueue, {
      serverId: row.server_id,
      actorType: "system",
      actorId: row.server_id,
      secretsConfig: params.secretsConfig,
      dataEncryptionSecrets: params.dataEncryptionSecrets,
    });
    if (result.ok) enqueued += 1;
  }
  return { enqueued };
}
