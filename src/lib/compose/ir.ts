/**
 * The deploy compiler's intermediate representation — the four models a
 * document passes through between "what an operator wrote" and "what one
 * server is told to run".
 *
 * ### The frozen contract
 *
 * TurboPanel is a **Compose implementation**. Compose says *what the workload
 * wants*; `x-turbopanel` says *only what Compose cannot express*; the compiler
 * decides *how* it runs. Nothing here re-asks a question Compose already
 * answers, and nothing downstream is allowed to invent a second extension
 * namespace to answer one it does not.
 *
 * ### The chain
 *
 * ```
 * ComposeLayer[]  ──mergeComposeLayers──▶  Application
 *   (authored)                              (normalized, DB-free)
 *                          │
 *                          │ reconcile + schedule + allocate
 *                          ▼
 *                    ResolvedApplication
 *                          │
 *                          │ split host-native + compileRuntimeCompose
 *                          ▼
 *                    ServerDeployment   (one per participating server)
 * ```
 *
 * 1. **Authored** — `ComposeLayer[]` (`./layers.ts`). Project + environment +
 *    platform documents, each independently valid Compose, merged left-to-right
 *    by `mergeComposeLayers`. This module deliberately does *not* redeclare
 *    that type; the authored stage already has one.
 * 2. {@link Application} — the merged document read once into named parts:
 *    services with their kind, their `x-turbopanel` block, their interpreted
 *    `deploy:` schedule spec and their hosting declarations; the root's
 *    principal aliases; the top-level `networks` / `volumes` / `secrets` /
 *    `configs`. **A read view, not a new parse pass** — every field comes from
 *    the existing parsers in `./service-kind.ts`, `./hosting-extension.ts`,
 *    `./root-extension.ts` and `../schedule/interpret.ts`. Building it once and
 *    reading off it is the point: those parsers used to be called ad hoc, per
 *    call site, several times for the same service.
 * 3. {@link ResolvedApplication} — the same services after the control plane
 *    has answered the questions a document cannot: which `service.id` each
 *    compose key became, which `principal.id` each alias materialized into,
 *    which servers and slots hold the replicas, which containers were
 *    allocated, what the clamped resource ceiling is.
 * 4. {@link ServerDeployment} — everything one server is told to run: the
 *    compiled runtime document and its material, the host-native lanes, and the
 *    edge (hostings, TLS, shared ingress, listener ports). Its fields are the
 *    daemon-facing `EnvironmentDeploy*` wire types verbatim; naming the stage
 *    changes nothing a daemon receives.
 *
 * Nothing in this module reaches a database, and nothing in it decides
 * anything — `buildApplicationModel` and `buildResolvedApplication` are
 * projections over inputs the caller already computed, so adding a stage name
 * cannot change a deploy's behavior.
 */

import type { ComposeDocument } from './types.ts'
import type { ComposeHostingExtensionEntry } from './hosting-extension.ts'
import {
  type ComposeServiceKind,
  type ComposeServiceTurbopanelExtension,
  readServiceTurbopanelExtension,
} from './service-kind.ts'
import {
  type PrincipalAccess,
  parseRootExtension,
  principalAccessOf,
  type PrincipalSpec,
  TURBOPANEL_ROOT_EXTENSION_KEY,
} from './root-extension.ts'
import {
  interpretServiceSchedule,
  type ServiceScheduleSpec,
} from '../schedule/interpret.ts'
import type {
  EnvironmentDeployComposeFile,
  EnvironmentDeployDockerNetwork,
  EnvironmentDeployFabricNetwork,
  EnvironmentDeployHosting,
  EnvironmentDeployIngressService,
  EnvironmentDeployNativeAppService,
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeploySite,
  EnvironmentDeploySource,
  EnvironmentDeployStorageMaterial,
  EnvironmentDeployTlsMaterial,
  EnvironmentDeployVariableMaterial,
} from '../commands/schemas.ts'
import type { ManagedIngressPorts } from '../managed/ingress-ports.ts'

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mappingAt(
  data: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = data[key]
  return isPlainMapping(value) ? value : {}
}

// ---------------------------------------------------------------------------
// Stage 2 — Application
// ---------------------------------------------------------------------------

/**
 * One Compose service body, exactly as merged.
 *
 * Named rather than inlined so a reader can tell "the Compose half" from the
 * `x-turbopanel` half at a glance; it is still the untyped mapping Compose is.
 */
export type ComposeServiceNode = Record<string, unknown>

/** The project a document belongs to. Absent when read outside one (lint, preview). */
export type ApplicationProject = {
  /** `project.id`. */
  id?: string
  /** `project.repository_id` — the one Git repository this project is, or null. */
  repositoryId?: string | null
}

/**
 * One entry of the root `x-turbopanel.principals` map.
 *
 * An **alias**, not an account: what the alias becomes on a host is decided on
 * the `principal` row under `organization:manage`, never in YAML. See
 * `./root-extension.ts`.
 */
export type ApplicationPrincipal = {
  /** Document-local alias — the key services point at with `x-turbopanel.principal`. */
  alias: string
  /** Requested access, with the omitted case already resolved. */
  access: PrincipalAccess
  /** Operator-facing note. TurboPanel-only metadata; Docker never sees it. */
  description?: string
  /** The parsed entry as authored, for callers that need the raw spec. */
  spec: PrincipalSpec
}

/** One service of the merged document, read into its named parts. */
export type ApplicationService = {
  /** Compose service key, exactly as authored. */
  name: string
  /** `x-turbopanel.serviceKind`, with the omitted case resolved to `container`. */
  kind: ComposeServiceKind
  /** The Compose body — what the workload wants. */
  compose: ComposeServiceNode
  /**
   * The parsed `x-turbopanel` block. `{}` when the service declares none;
   * `null` when it declares something that is not a mapping (the validators,
   * not this read view, are what turn that into an operator-facing message).
   */
  turbopanel: ComposeServiceTurbopanelExtension | null
  /**
   * The interpreted `deploy:` block — mode, replicas, constraints, spread keys,
   * colocation, published host ports, per-node cap. From
   * `../schedule/interpret.ts`, the one interpreter the planner also uses.
   */
  deployment: ServiceScheduleSpec
  /** Parsed `x-turbopanel.hosting[]`; empty when the service declares none. */
  hosting: ComposeHostingExtensionEntry[]
  /** The principal alias this service runs as, when it names one. */
  principalAlias?: string
}

/**
 * The merged document, normalized. Post-merge and post-validate; pre-schedule,
 * pre-allocate, and pre-anything that needs a database.
 */
export type Application = {
  project: ApplicationProject
  /** Root-declared principal aliases, in stable alias order. */
  principals: ApplicationPrincipal[]
  /** Services in authored key order — the same order `services:` lists them. */
  services: ApplicationService[]
  /** Top-level `networks:` as authored. */
  networks: Record<string, unknown>
  /** Top-level `volumes:` as authored. */
  volumes: Record<string, unknown>
  /** Top-level `secrets:` as authored. */
  secrets: Record<string, unknown>
  /** Top-level `configs:` as authored. */
  configs: Record<string, unknown>
}

/**
 * Read a merged document into an {@link Application}.
 *
 * Pure and DB-free. Every service key under `services:` is represented —
 * including one whose body is not a mapping — so `services.map((s) => s.name)`
 * is the same list, in the same order, that `Object.keys(data.services)` gives.
 * A caller that wants only the ones Docker will run asks
 * {@link containerServiceNames}.
 *
 * `instancesByComposeName` supplies the `service.options.instances` fallback the
 * replica policy uses when `deploy.replicas` is absent; omit it and every
 * service falls back to 1, which is what a caller reading a document outside a
 * deploy (lint, preview, the visual editor) wants.
 */
export function buildApplicationModel(
  merged: ComposeDocument,
  options?: {
    project?: ApplicationProject
    instancesByComposeName?: ReadonlyMap<string, number>
  },
): Application {
  const data = isPlainMapping(merged.data) ? merged.data : {}
  const services = mappingAt(data, 'services')
  const instances = options?.instancesByComposeName

  const root = parseRootExtension(data[TURBOPANEL_ROOT_EXTENSION_KEY])
  const principals: ApplicationPrincipal[] = Object.entries(
    root?.principals ?? {},
  )
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([alias, spec]) => ({
      alias,
      access: principalAccessOf(spec),
      ...(spec.description === undefined ? {} : { description: spec.description }),
      spec,
    }))

  const modeled: ApplicationService[] = []
  for (const [name, raw] of Object.entries(services)) {
    const compose: ComposeServiceNode = isPlainMapping(raw) ? raw : {}
    const turbopanel = isPlainMapping(raw)
      ? readServiceTurbopanelExtension(raw)
      : {}
    modeled.push({
      name,
      kind: turbopanel?.serviceKind ?? 'container',
      compose,
      turbopanel,
      deployment: interpretServiceSchedule(
        name,
        compose,
        instances?.get(name) ?? 1,
      ),
      hosting: turbopanel?.hosting ? [...turbopanel.hosting] : [],
      ...(turbopanel?.principal === undefined
        ? {}
        : { principalAlias: turbopanel.principal }),
    })
  }

  return {
    project: options?.project ?? {},
    principals,
    services: modeled,
    networks: mappingAt(data, 'networks'),
    volumes: mappingAt(data, 'volumes'),
    secrets: mappingAt(data, 'secrets'),
    configs: mappingAt(data, 'configs'),
  }
}

/** The service by compose key, or `undefined` when the document has none. */
export function applicationService(
  application: Application,
  composeServiceName: string,
): ApplicationService | undefined {
  return application.services.find((entry) => entry.name === composeServiceName)
}

/**
 * Kinds that never become Docker services — a site is served by a host engine
 * and a `node` app is supervised from a Git release. Mirrors
 * `isHostNativeServiceKind`, read off the model instead of re-parsing.
 */
export function hostNativeServiceNames(application: Application): string[] {
  return application.services
    .filter((entry) => entry.kind === 'site' || entry.kind === 'node')
    .map((entry) => entry.name)
}

/** Services that do become containers. The complement of {@link hostNativeServiceNames}. */
export function containerServiceNames(application: Application): string[] {
  return application.services
    .filter((entry) => entry.kind !== 'site' && entry.kind !== 'node')
    .map((entry) => entry.name)
}

/** Compose service name → the principal alias it names, for services that name one. */
export function principalAliasByServiceName(
  application: Application,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of application.services) {
    if (entry.principalAlias) out.set(entry.name, entry.principalAlias)
  }
  return out
}

// ---------------------------------------------------------------------------
// Stage 3 — ResolvedApplication
// ---------------------------------------------------------------------------

/** A `slot` row as this projection reads it. `DesiredSlotInput` satisfies it. */
export type ResolvedSlotInput = {
  serviceId: string
  serverId: string
  slot: number
  /** Spanning-network address allocated for the slot; `null` clears one. */
  address?: string | null
}

/** A container allocation as this projection reads it. `ContainerAllocation` satisfies it. */
export type ResolvedContainerInput = {
  serviceId: string
  composeServiceName: string
  cloneComposeServiceName: string
  containerRowId: string
  containerName: string
  ordinal: number
  serverId: string
}

/** The clamped, effective resource ceiling for one service. */
export type ResolvedResources = {
  cpus?: number
  memoryBytes?: number
  memoryReservationBytes?: number
}

/** One replica of one service, placed. */
export type ResolvedSlot = {
  /** `slot.slot` — the replica ordinal within the service. */
  ordinal: number
  serverId: string
  /** The spanning-network address allocated for this slot, when it has one. */
  address?: string
  /** True when this replica lands on the server this slice compiles for. */
  local: boolean
}

/** One service after the control plane answered what the document could not. */
export type ResolvedService = {
  /** `service.id` — the row the compose key reconciled into. */
  serviceId: string
  /** The authored compose key. */
  composeServiceName: string
  kind: ComposeServiceKind
  /** `principal.id` the service's alias materialized into, when it names one. */
  principalId?: string
  /** Clone compose keys after multi-instance expansion (`web`, `web-2`, …). */
  clones: string[]
  /** Placed replicas, across every participating server. */
  slots: ResolvedSlot[]
  /** Pre-allocated container rows for this service on this server. */
  containers: ResolvedContainerInput[]
  /** Effective ceiling after org / server clamping, when one applies. */
  resources?: ResolvedResources
  /** Declared ingress for this service, carried through from the {@link Application}. */
  hostings: ComposeHostingExtensionEntry[]
}

/** One materialized principal alias. */
export type ResolvedPrincipal = {
  /** The document-local alias. */
  logicalAlias: string
  /** The `principal.id` it materialized into. */
  principalId: string
}

/**
 * The application after reconcile → schedule → allocate, for one server's
 * slice of the deploy.
 */
export type ResolvedApplication = {
  /** The server this slice compiles for. */
  serverId: string
  /**
   * Whether a scheduler plan decided placement.
   *
   * Distinct from "has slots": a plan that placed nothing on any server is
   * still a plan, and the answer to "what runs here" is then *nothing* — not
   * the unscheduled path's *everything*. Conflating the two is how an empty
   * slice would silently deploy the whole environment onto one host.
   */
  scheduled: boolean
  principals: ResolvedPrincipal[]
  services: ResolvedService[]
}

/**
 * Project the already-computed reconcile / schedule / allocate outputs into a
 * {@link ResolvedApplication}.
 *
 * Every input is something the caller holds: `service` rows from
 * `reconcileServicesFromCompose`, the alias map from
 * `reconcilePrincipalsFromCompose`, slots from the scheduler plan, containers
 * from `allocateEnvironmentContainers`, the expansion map from
 * `expandComposeServiceInstances`. Nothing is re-derived and nothing is
 * decided here.
 *
 * `slots` is the **environment-wide** slot list (every server), not this
 * server's — the model records where every replica landed and marks the local
 * ones, because a compile that only saw its own host cannot emit the sibling
 * `extra_hosts` a spanning network needs. Omit it entirely for the unscheduled
 * path, where placement is "all of it, here".
 */
export function buildResolvedApplication(input: {
  serverId: string
  application: Application
  /** `service` rows for this environment. */
  serviceRows: readonly { id: string; composeServiceName: string }[]
  slots?: readonly ResolvedSlotInput[]
  containers?: readonly ResolvedContainerInput[]
  /** Compose service key → clone keys after multi-instance expansion. */
  expansion?: ReadonlyMap<string, readonly string[]>
  principals?: {
    principalIdByAlias: ReadonlyMap<string, string>
    aliasByComposeServiceName: ReadonlyMap<string, string>
  }
  /** Effective, clamped ceiling per compose service name. */
  resourcesByComposeServiceName?: ReadonlyMap<string, ResolvedResources>
}): ResolvedApplication {
  const { serverId, application, serviceRows } = input

  const slotsByServiceId = new Map<string, ResolvedSlot[]>()
  for (const row of input.slots ?? []) {
    const list = slotsByServiceId.get(row.serviceId) ?? []
    list.push({
      ordinal: row.slot,
      serverId: row.serverId,
      ...(typeof row.address === 'string' ? { address: row.address } : {}),
      local: row.serverId === serverId,
    })
    slotsByServiceId.set(row.serviceId, list)
  }

  const containersByServiceId = new Map<string, ResolvedContainerInput[]>()
  for (const row of input.containers ?? []) {
    const list = containersByServiceId.get(row.serviceId) ?? []
    list.push(row)
    containersByServiceId.set(row.serviceId, list)
  }

  const kindByName = new Map(
    application.services.map((entry) => [entry.name, entry.kind] as const),
  )
  const hostingByName = new Map(
    application.services.map((entry) => [entry.name, entry.hosting] as const),
  )
  const aliasByName = input.principals?.aliasByComposeServiceName ??
    principalAliasByServiceName(application)

  const services: ResolvedService[] = serviceRows.map((row) => {
    const name = row.composeServiceName
    const alias = aliasByName.get(name)
    const principalId = alias === undefined
      ? undefined
      : input.principals?.principalIdByAlias.get(alias)
    const resources = input.resourcesByComposeServiceName?.get(name)
    return {
      serviceId: row.id,
      composeServiceName: name,
      kind: kindByName.get(name) ?? 'container',
      ...(principalId === undefined ? {} : { principalId }),
      clones: [...(input.expansion?.get(name) ?? [name])],
      slots: slotsByServiceId.get(row.id) ?? [],
      containers: containersByServiceId.get(row.id) ?? [],
      ...(resources === undefined ? {} : { resources }),
      hostings: hostingByName.get(name) ?? [],
    }
  })

  const principals: ResolvedPrincipal[] = [
    ...(input.principals?.principalIdByAlias ?? new Map<string, string>()),
  ]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([logicalAlias, principalId]) => ({ logicalAlias, principalId }))

  return { serverId, scheduled: input.slots !== undefined, principals, services }
}

/**
 * Every `service.id` with work on this slice's server.
 *
 * The unscheduled path — no plan at all — means "everything runs here", which
 * is why an absent slot list is answered with every service rather than none.
 * A plan that placed nothing here answers with nothing; see
 * {@link ResolvedApplication.scheduled}.
 */
export function serviceIdsOnServer(
  resolved: ResolvedApplication,
): string[] {
  if (!resolved.scheduled) {
    return resolved.services.map((entry) => entry.serviceId)
  }
  return resolved.services
    .filter((entry) => entry.slots.some((slot) => slot.local))
    .map((entry) => entry.serviceId)
}

/** Compose keys (clones included) with a replica on this slice's server. */
export function localComposeServiceNames(
  resolved: ResolvedApplication,
): string[] {
  const names: string[] = []
  for (const entry of resolved.services) {
    if (resolved.scheduled && !entry.slots.some((slot) => slot.local)) continue
    names.push(...entry.clones)
  }
  return names
}

// ---------------------------------------------------------------------------
// Stage 4 — ServerDeployment
// ---------------------------------------------------------------------------

/**
 * A native app row before its release-tree `serviceId` is resolved.
 *
 * `serviceId` is deliberately absent: the release-tree segment is resolved from
 * `hostings[]` / `ingressServices[]` at payload-assembly time with the same
 * precedence the daemon's `resolveReleaseServiceId` uses — deriving it twice
 * from different inputs would let a unit's `WorkingDirectory` point at a tree
 * the release engine never published.
 */
export type PreparedNativeAppService = Omit<
  EnvironmentDeployNativeAppService,
  'serviceId'
>

/**
 * What one server is told to run — the fourth and last model.
 *
 * Every field is daemon-facing and every daemon-facing field is here: this is
 * the *whole* per-server deployment, not the compose half of one. Runtime
 * material (the compiled document, its material, the host-native lanes) and
 * edge material (hostings, their TLS, the shared ingress identity, the
 * listener ports) are one deployment to the host that receives them, and the
 * boundary this model freezes only holds if the compiler is where both are
 * decided. The route that enqueues a deploy assembles nothing: it hands this
 * object to `createDeployCommand` and is done.
 *
 * The field *types* are the `EnvironmentDeploy*` wire types verbatim — the
 * contract in `../commands/schemas.ts` is untouched by naming the stage. The
 * prepare phase's `PreparedDeployCompose` extends this with control-plane-only
 * bookkeeping (hooks, warnings, allocations) that never reaches a daemon.
 */
export type ServerDeployment = {
  /**
   * The server this deployment compiles for.
   *
   * Optional because the empty-compose short-circuit builds one before any
   * server is in hand; every real prepare sets it.
   */
  serverId?: string
  /** Required runtime snapshot: exactly one `role: 'runtime'` `compose.yaml`. */
  composeFiles: EnvironmentDeployComposeFile[]
  /** SHA-256 hex of the compiled runtime body, before daemon overlay. */
  desiredHash: string
  /** Local replica counts keyed by logical compose service name. */
  replicaCounts: Record<string, number>
  variableMaterial: EnvironmentDeployVariableMaterial[]
  storageMaterial: EnvironmentDeployStorageMaterial[]
  principalMaterial: EnvironmentDeployPrincipalMaterial[]
  sites: EnvironmentDeploySite[]
  /** Host-supervised native apps (`serviceKind: node`) scheduled on this server. */
  nativeAppServices: PreparedNativeAppService[]
  /** Git-backed releases resolved from `x-turbopanel.source`. */
  sourceMaterial: EnvironmentDeploySource[]
  /** Operator-registered external Docker networks this document names. */
  dockerExternalNetworks: string[]
  /**
   * Addressing for the `dockerExternalNetworks` entries whose registration
   * carries any (`network.cidr` / `options.subnet|ipRange|gateway|mtu`).
   * Additive on the wire — a name absent here is created bare.
   */
  dockerNetworkAddressing: EnvironmentDeployDockerNetwork[]
  /** Platform-owned `tpn_*` routed bridges. Disjoint from `dockerExternalNetworks`. */
  fabricNetworks: EnvironmentDeployFabricNetwork[]
  /** Compose services that must join the org's managed network. */
  managedNetworkServices: string[]
  /** Docker network name of that managed network; absent when nothing joins it. */
  managedNetwork?: string
  /** Per-service tcp/udp Traefik ingress allocations (`<service.id>-in`). */
  ingressServices: EnvironmentDeployIngressService[]
  /**
   * Resolved edge routes for the services on this server — hostnames, path
   * prefix, target port, bind address, resolved certificate, web/PHP metadata
   * for `http`; published/target port pairs for `tcp` / `udp`.
   *
   * Fanned out across clone compose keys, so a multi-instance service routes to
   * every replica rather than only the key the operator authored.
   */
  hostings: EnvironmentDeployHosting[]
  /**
   * Certificate + **daemon-sealed** private key for every `tlsId` the hostings
   * above name, resealed to this server's active daemon key.
   *
   * Per-server by construction: an envelope sealed for one host is unreadable
   * on another, which is why this belongs to a *server* deployment rather than
   * to the environment.
   */
  tlsMaterial: EnvironmentDeployTlsMaterial[]
  /**
   * The organization's effective managed-database listener ports, resolved from
   * the **server's owner** rather than the requesting org — the ProxySQL
   * frontend a joining service dials belongs to whoever owns the host.
   */
  listenerPorts: ManagedIngressPorts
  /**
   * Shared HTTP proxy identity for this server's hostings. Absent when nothing
   * on this slice needs HTTP routing (a tcp/udp-only deploy has none).
   */
  hostingIngress?: EnvironmentDeployIngressService
  /**
   * Docker network of the shared hosting-ingress component — the same
   * `hosting-ingress` `serviceId`, never a literal. Set whenever this slice
   * carries hostings at all, including the tcp/udp-only case whose per-service
   * Traefik still joins it.
   */
  hostingIngressNetwork?: string
}
