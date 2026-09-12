# Client API (`src/client`) — AGENTS.md

Route modules for the versioned client REST surface (`/api/client/v1/*`), one
directory per resource. Authz engine and permission catalog live in `authz/`
(engine docs: `../lib/db/AGENTS.md` → **Authz engine** / **Catalog**; authn
flows: `authn/AGENTS.md`). The tables below are the per-endpoint permission
contract — keep them current when adding or changing routes.

## Client API (authz integration)

| Method   | Path                                                            | Purpose                                                                                                                                              |
| -------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/client/v1/invitations/{id}/accept`                        | Accept a pending invitation; creates a `teammate` row, materializes `invitation.grants` into `grant` rows, updates session `organizationId`          |
| `GET`    | `/api/client/v1/permissions`                                    | Permission catalog — static, no DB query (any authenticated user)                                                                                    |
| `GET`    | `/api/client/v1/access?resourceId=<uuid>`                       | List access grants for a resource; returns `{ access: AccessRecord[] }` with `subjectKind`, `subjectId`, `resourceId`, `effect`, and `permissionKey` |
| `GET`    | `/api/client/v1/access/check?resourceId=<uuid>&permissionKey=…` | Check a single permission for the signed-in user; returns `{ allowed: boolean }`                                                                     |
| `GET`    | `/api/client/v1/access/resource-id?kind=<kind>&itemId=<uuid>`   | Resolve `resourceId` for an entity in the session org; returns `{ resourceId, kind, itemId }`                                                        |
| `POST`   | `/api/client/v1/access`                                         | Create an access grant; body: `{ subjectKind, subjectId, resourceId, effect, permissionKey }`                                                        |
| `DELETE` | `/api/client/v1/access/{id}`                                    | Revoke an access grant                                                                                                                               |

The full per-route table (100+ routes: method, path, permission, behavior) is
maintained in [`routes-contract.md`](./routes-contract.md) — **update it when
adding or changing a route.** The rules it encodes:

- List and get enforce visibility via `listVisible` / org-level grant checks
  **in SQL** — never client-side.
- Create, update, and delete require `organization:own` or `organization:manage`
  on the entity's org, via `can()`.
- All create/delete operations run entity insert/delete in a single transaction.

## Client surface feature notes

Per-feature behavior contracts for the client surface (moved from the root
`AGENTS.md` **API / WS surfaces** section). Keep current when endpoint behavior
changes.

- **Server timezone / NTP (client surface):** daemon hello + change-detected
  heartbeats persist `timeSync` onto `server.timezone` / `is_time_sync_enabled`
  / `ntp_servers` / `ntp_last_synced_at`, and nest addresses on
  `server.metadata.resources.ips` (legacy top-level `ips` still accepted).
  Hello-only host inventory is `server.metadata.resources.cpus[]` (per-socket
  `vendorId` / `cores` / `threads` / `cache` / clocks) and `gpus[]`; leftover
  `resources.cpu` is lifted on read. Docker CLI / Compose plugin versions
  project onto `server.metadata.docker` the same way, but **only when Docker is
  installed** (the key is omitted otherwise). `GET /api/client/v1/servers` and
  `GET /servers/:id` return those facts plus an **effective timezone** =
  `server.options.timezone` unless `organization.options.enforceServerTimezone`
  is true (then org `defaultServerTimezone` wins; otherwise the daemon-reported
  `server.timezone` column). Commands: `POST /servers/:id/timezone`
  (`server.timezone.set`, also persists the server override) and
  `POST /servers/:id/ntp` (`server.ntp.set`) — manage-gated, create-then-poll.
  Org record: `GET`/`PATCH /organizations/:id` — GET is access-gated (same
  visibility as the org list: team membership, owner/manager grant, or platform
  admin; missing or inaccessible → **404**); PATCH is manage-gated (`{ name }`
  required, any characters except control characters, ≤255, cannot clear; names
  are not unique). Returns `{ organization }` / `{ ok, organization }`. Org
  defaults: `GET`/`PUT /organizations/:id/default-timezone`. Picker source:
  `GET /timezones` (`listTimezones()` / `isAllowedTimezone()`). Detail rows use
  the `server-detail` cached read model (mirrors `servers-list`).
- **Host defaults (client surface):** org → datacenter → server cascade stored
  in existing `options` jsonb (`src/lib/host-defaults.ts`). Most specific
  configured value wins; SSH falls back to **22**. Keys: `sshPort` (1–65535),
  `ntp` (`enabled` / `servers` / `fallbackServers` — desired config, not
  observed `timeSync`), `defaultFabricEnabled` (**organization only**; a
  preference that does **not** create or tear down the mesh). Timezone stays on
  its own enforce resolver (`resolveEffectiveServerTimezone`) — do not add a
  soft timezone default into this cascade.
  `GET`/`PUT /organizations/:id/host-defaults` is manage-gated (jsonb `||`
  merge; JSON `null` clears a key). Datacenter `PATCH` **replaces** parsed
  `options` (UI must `mergeDatacenterOptions`). Server `PATCH options.sshPort` /
  `ntp` (`null` inherits). List/detail expose effective `sshPort` /
  `sshPortSource` / `ntpDefaults` / `ntpDefaultsSource`; detail also adds
  `datacenterDefaultTimezone` / `datacenterEnforceServerTimezone`. Saving
  defaults does **not** rewrite sshd or enqueue NTP/timezone commands. Multi-DC
  membership inherits from the first pin after sort by datacenter id (same as
  timezone).
- **Server labels (client surface):** `GET`/`PUT /servers/:id/labels` —
  read-gated GET and manage-gated PUT; PUT is replace-all
  (`{ labels: { key: value } }`, no per-key DELETE). `GET /servers/:id` includes
  `labels` from a primary-connection read (not the cached `server-detail` row).
  Keys use the Docker engine-label charset so `placement.constraints`
  `node.labels.*` parses cleanly.
- **TurboFabric (client surface):** `GET`/`PUT /organizations/:id/fabric` —
  manage-gated opt-in, plus `PATCH /organizations/:id/fabric/relays/:serverId`
  and `POST /organizations/:id/fabric/apply`. TurboFabric **is** the org
  WireGuard mesh (one per org, interface `tp0`); `relay` carries the mesh
  identity (address, gateway/member role, advertised LAN CIDRs plus
  `resolvedAdvertisedCidrs` for the effective IPv4 list, keepalive, endpoint
  override, write-only PSK). GET fabric returns diagnostics-only per-relay
  `paths[]` (`peerServerId`, `selected` path kind, optional `endpoint` /
  `viaServerId` / `lastHandshakeAt` / `latencyMs`, `degraded`) plus `allowRelay`
  / `effectiveAllowRelay` / `preferredGatewayIds` / `gatewayEligible`. Org PUT
  accepts `allowRelay` (tightening-only; default off). Relay PATCH accepts
  `allowRelay` (`null` inherits org) and `preferredGatewayIds`. Reconcile
  assigns derived CIDR ownership among public-keyed relays only. Default off
  (capable single-engine Docker standalone; no `tp0`). Enabling creates the org
  `fabric` row plus per-server `relay` rows and reconciles host interface `tp0`
  on enrolled servers. Spanning compose networks persist per-host `subnet` rows
  (compose-bridge CIDR, not a datacenter subnet). A deploy plan that would use
  two or more servers without TurboFabric returns **422**
  `turbofabric_required`. Multi-server deploys **wait for membership
  convergence** (every participating relay has a public key and an applied
  payload hash that includes peers) before enqueueing `environment.deploy`
  (`422 fabric_reconcile_failed` / `409 fabric_reconcile_pending`). PUT disable
  is a teardown (reclaims `network(kind='compose')` + `subnet`).
  Whole-environment `environment.server_id` pins never require it. User-facing
  copy is **TurboFabric**; backend identifiers stay `fabric` / `tp0` / `relay` /
  `subnet`. Never ask which WireGuard network a container should join. NAT
  rendezvous feeds `direct_nat` only from a probing peer's fresh healthy
  handshake (observer-mapped endpoints stay in candidate exchange). Path-state
  strike counters are process-local across reconcile rounds. `allowRelay` is
  reserved for a future relay slot and does not loosen gateway datacenter
  locality.
- **Compiled runtime compose:** users author project + optional environment
  ComposeDocuments. Deploy compiles **one** `compose.yaml` (`role: 'runtime'`)
  per participating server plus a project `.env` for non-secrets. Secret
  `{$KEY}` / `{$scope.KEY}` refs compile to Compose standalone `secrets:` files
  under `/run/turbopanel/deployments/<projectId>/<environmentId>/secrets/` (YAML
  holds paths only). Preview **Prepared** shows that snapshot (plus `servers[]`
  only when scheduled across more than one host), redacted `.env`, and
  `secretPlan[]`. Runtime YAML includes `x-turbopanel.placement.server_id` as
  compile-time audit metadata. Preview **Merged** stays the user-authored merge
  (including `{$…}`) plus the live pin for review.
  `POST /api/daemon/v1/deployments/secrets/rehydrate` reseals current registry
  values after daemon boot because `/run` is tmpfs.
- **Org server seat capacity:** `organization.options.maxServers`
  (`null`/omitted = unlimited). `GET`/`PUT /organizations/:id/server-capacity`;
  `POST /licenses` returns **409** `server_capacity_exceeded` when enrolled
  servers + unconsumed keys fill the cap. Optional create `name` (legacy
  `displayName` accepted on input) is omitted when blank and otherwise uses
  `normalizeDisplayName` / `isValidDisplayName` (**400** for control characters
  or over-length). `GET`/`DELETE /licenses` are owner-only; the UI **Pending
  keys** page lists unbound keys (OpenAPI `name`). Self-hosted operators set the
  cap. When billing is configured, `POST /licenses` also requires `tierId`
  (**400** `tier_required` / `tier_not_purchasable`) and answers **409**
  `no_free_seat` when the active licenses at that tier already fill its seats
  (net of outstanding seat releases); `DELETE /licenses/:id` runs the
  detach-first refusal, then the billing gate (`authn/license-lifecycle.ts`),
  which records a deferred `release-seat` intent under the org's quantity lease
  so the seat drops at the period boundary (**409**
  `billing_mutation_in_progress` while held).
- **Billing (client surface):** `src/client/billing/` — `GET /billing/catalog`
  (active tiers), `GET /billing/subscription` (projection summary: status,
  period end, per-tier `{ seats, licensesUsed, licensesFree }`, grace clock,
  schedule flag, pending changes — Postgres only), `POST /billing/checkout`
  (first purchase → hosted Checkout URL, **409** `subscription_exists` after),
  `POST /billing/portal` (invoices + payment methods), `POST /billing/preview`
  (proration quote with a pinned `prorationDate`), `POST /billing/seats`
  (increase → immediate invoice; decrease → deferred), `POST /billing/upgrade`
  and `POST /billing/downgrade` (one license, one tier move). Owner-only; every
  route is **503** `billing_not_configured` when customer billing is not
  operational (both Stripe secrets — `isCustomerBillingOperational`), so
  self-hosted and API-key-only instances have no billing surface;
  entitlement-raising routes are **409** `subscription_past_due` while
  delinquent; every mutation holds the org quantity lease
  (`409 billing_mutation_in_progress`). The three mutation bodies are
  `billing/mutations.ts` (`changeSeats`, `upgradeLicense`, `downgradeLicense`),
  context-free functions returning the status and body the route answers with,
  so the live test-clock harness drives the same gates. Rules and the ledger:
  `src/lib/billing/AGENTS.md`.
- **Org managed-database defaults:** `organization.options.managedDatabase`
  (`src/lib/managed/org-defaults.ts`).
  `GET`/`PUT
  /organizations/:id/managed-defaults` (manage-gated) — today only
  `sslMode`, the default client TLS policy inherited by managed SQL services
  that set no override; `null` clears it and services fall back to the platform
  `require`. These are **inheritance sources**, not applied configuration:
  saving one never overwrites a service that configured its own value, and the
  effective mode is resolved per read (`resolveManagedSslMode`) rather than
  stored. Canonical detail: `src/lib/managed/AGENTS.md` → **Client TLS (SSL
  mode)**.
- **Org default environment name:**
  `organization.options.defaultEnvironmentName` (unset = `Production`).
  `GET`/`PUT /organizations/:id/default-environment` (manage-gated) names the
  environment scaffolded by project create / configure. Matching for existing
  literal "production" catalog environments is unchanged.
- **Project default server:** `project.options.defaultServerId` (optional UUID).
  Environments without their own `server_id` inherit it at deploy / lifecycle /
  stop (`resolveEffectivePlacementServerId`). Overview Base shows an inline
  picker; env-level pins still override.
- **Environment lifecycle:** `POST /environments/:id/lifecycle` (`start` /
  `stop` / `restart`) is non-destructive (`environment.lifecycle`);
  `POST /environments/:id/stop` tears down compose including volumes
  (`environment.stop`). Canonical detail: `src/lib/commands/AGENTS.md`.
- **Containers list filters:** `GET /api/client/v1/containers` joins `service`,
  so every serialized row carries **`environmentId`** (denormalized
  `service.environmentId`). `?environmentId=` narrows already-visible rows to
  that environment; `?projectId=` narrows to every environment of a project, so
  a client scoping a whole project makes **one** call instead of one per
  environment. Both AND with `serviceId` / `serverId` / `status` and neither
  widens `listVisible`.
- **Datacenters (routing domains, many subnets):** There is no singular
  `server.datacenter_id`. Membership is an `ip` pin (`scope='datacenter'` +
  `serverId` + `datacenterId` + **required** `networkId`), unrestricted count
  per `(server, datacenter)`, deduped by address (`uniq_ip_org_address`;
  `ip_datacenter_member_network_check`). A server may hold pins in many
  datacenters. A datacenter owns **many** `network(kind='datacenter')` subnets
  (v5 and/or v6), unique per `(datacenter_id, cidr)` via
  **`uniq_network_datacenter_cidr`**; **all subnets in a datacenter are assumed
  mutually routable** — the datacenter _is_ the routing domain, there are no
  per-pair adjacency records. `POST /datacenters` body is
  `{ name?, description?, members: [{ serverId, address }],
  sourceServerId? }`
  — at least one member is required; addresses must be daemon-reported private
  IPs; the first subnet is **derived** from that seed member’s reported
  interface prefix (`ips[].cidr` where `scope='private'`, aligned network form)
  when present — operator `cidr` is ignored. Hello ingest maps current
  `resources.ips` (and legacy top-level `ips[]` / the pre-rename `addresses`
  object (`privateIpv4` / …)) so remotes that have not rebuilt yet still appear
  as members. When the daemon still reports `{ address, version, scope }`
  without a prefix, create infers a typical LAN (`/24` IPv4, `/64` IPv6).
  Missing reported private IP → **400** `address_cidr_unreported`. Extra members
  no longer have to fall inside one CIDR — a non-matching reported prefix
  **auto-creates** another subnet in the same txn (**409** `subnet_overlaps`
  when that range collides org-wide, including among auto-derived CIDRs in the
  same create or member-add request). Create writes site subnet(s) + member pins
  in one txn. `POST|DELETE /datacenters/:id/members` add/remove pins (member add
  auto-derives the same way; member delete removes **every** pin for that server
  in the datacenter). Manual subnet CRUD:
  `POST|PATCH|DELETE /datacenters/:id/subnets[/:networkId]` (manage-gated;
  `cidr` immutable on PATCH). Name suggestions
  (`GET /datacenters/name-suggestions`) group geo/ASN from servers with zero
  memberships. List/detail expose `privateCidrs` (one entry per subnet) plus
  detail `subnets[]` and `options.addressPreference`. Server list/detail expose
  `datacenters: { id, name }[]`. `DELETE /datacenters/:id` returns **409**
  `datacenter_has_members` while any membership pin remains; otherwise **every**
  `kind='datacenter'` network is deleted with the datacenter (**409**
  `datacenter_has_networks` only for leftover non-site / docker rows).
- **Membership pin is the single address authority (automatic repin):** a
  datacenter membership pin (`ip.scope='datacenter'` + `server_id`) is the
  only durable record of a server's private address in a site subnet.
  Binding-owned `variable` rows, ProxySQL backend addresses, compose
  `extra_hosts`, relay `endpoint_address` / gateway `advertisedCidrs`, and
  hosting `bindAddress` are **recomputed per deploy / reconcile from the pin**
  and must never be treated as an address record or written back to. When a
  daemon's reported `resources.ips` moves, `touchServerMetadata`
  (`src/server-registry.ts`) — the one change-detected write both the Deno
  WS hello and the Durable Object `#projectInbound` funnel through — runs
  `applyReportedAddressRepin` (`src/lib/net/repin-apply.ts`) best-effort,
  gated on `serverIpsEquals` so CPU / docker-only deltas never touch `ip`
  rows. The decision is pure (`decideRepinActions`, `src/lib/net/repin.ts`):
  address still reported → nothing (clears a `stale` flag); address gone with
  **exactly one** reported private address inside the pin's subnet that is
  not an `ip` row elsewhere in the org → `repin` (`ip.address` rewritten,
  `metadata.repin { at, from, pendingFanoutAt }`; re-validated through
  `validateMemberPinAddress`; a `uniq_ip_org_address` race downgrades to
  stale); zero or 2+ candidates → `metadata.stale { since, reason }`
  (`address_gone_no_candidate` / `address_gone_ambiguous`). At most one repin
  per `(server, network)` per pass. **Nothing enqueues on that path** — hello
  / DO handlers must not enqueue commands — so the routing fan-out is
  deferred: `runDatacenterRepinFanoutSweep`
  (`src/client/datacenters/repin-fanout.ts`) drains `pendingFanoutAt` from
  the shared maintenance tick (`runSystemReconcileSweepTick` in
  `deno-server.ts`; the `tlsRenewal`-gated block in
  `daemon/cell/offline-sweep.ts`), one `fanOutDatacenterRoutingChange`
  (`routing-fanout.ts`, the same core `PATCH /datacenters/:id` uses) per
  `(org, datacenter)` group plus the repinned servers' own clusters via
  `listManagedIdsForServer`; the marker is cleared only after success. Leaf
  SANs re-mint through the existing `managed.ingress.reconcile` /
  `pendingTlsLeafMetadata` rail — no issuance path here. Hosting
  `bindAddress` is frozen at deploy time, so `GET /environments/:id` returns a
  derived `needsRedeploy: { serverId, environmentId }[]`
  (`src/client/environments/repin-needs-redeploy.ts`, `metadata.repin.at`
  later than the last applied `deployment.finished_at`); **no automatic
  `environment.deploy`**, and no new columns — `stale` on `GET /ips[/:id]` and
  on `GET /datacenters/:id` `members[]` is read from `ip.metadata` via
  `parseIpPinMetadata`.
- **CIDR collision authority (`src/lib/net/cidr-collisions.ts`):** every CIDR
  write — `POST`/`PATCH /networks`, `POST /datacenters`,
  `POST /datacenters/:id/subnets`, the auto-derive path of
  `POST /datacenters/:id/members` — calls `assertCidrAvailable` /
  `assertCidrsAvailable` before touching `network`; do **not** add a local
  overlap scan to a route. Every pair is a hard **409** with its own code,
  returned as `{ error, cidr, conflictingCidr, networkId?, datacenterId? }`
  via `cidrCollisionResponse` (`src/client/networks/network-scope.ts`):
  `cidr_overlaps_fabric` (org `fabric.cidr`, `tp0`),
  `cidr_overlaps_fabric_pool` (`fabric.options.containerPool`, default
  `10.192.0.0/12`), `subnet_overlaps` (any site subnet in the org — the
  org-wide default is kept, not relaxed), `cidr_overlaps_gateway_advertised`
  (a site subnet in **another** datacenter when both datacenters have a
  gateway-role relay — resolved through `resolveDerivedAdvertisedCidrsByRelay`,
  so IPv6 subnets and operator overrides behave as on the wire; this is the
  case that actually breaks `AllowedIPs`), `cidr_overlaps_reserved`
  (`network(kind='reserved')`), `cidr_overlaps_docker_network`
  (`kind='docker'` / `kind='managed'` rows with a CIDR). `PATCH` passes
  `excludeNetworkId` so a row never collides with itself. **`kind='reserved'`**
  is the operator's "never allocate from here" registry (org-only scope, CIDR
  required, `name` carries the label — "Corp VPN — Chicago branch"); unlike
  `managed`, reserved rows are operator data: rename and re-range are allowed,
  `cidr: null` is **400** `network_cidr_required`. The reverse direction is
  automatic: `occupiedCidrs` (fabric-records) sweeps every `network.cidr`, so
  reserved rows constrain `pickDefaultFabricHostCidr`, and the allocators
  (`requireRelayPrefix` / `requireSubnetCidr`, `nextFreeSubnet` /
  `nextFreeSubnetCidr`) take an **exclusion list** from
  `loadCidrAllocationExclusions` so a relay `/16` or a `tpn_*` `/24` never
  lands inside a reserved range or a site subnet (exhaustion keeps the
  existing `FabricAllocationError` codes). **Org Docker host addressing**
  (`organization.options.docker`, `src/lib/docker-address-pools.ts`,
  `GET`/`PUT /organizations/:id/docker-networking`) — every pool base
  **and** the aligned network of `defaultBridgeCidr` (dockerd `bip`, the
  docker0 subnet on every host), together `dockerHostCidrs()` — is part of
  the registry (`dockerHostCidrs`, same rung / code as `kind='docker'` rows
  — `cidr_overlaps_docker_network`) **and** of the exclusion list, so a
  later reserved range, site subnet, docker row or fabric allocation can
  never land inside a pool or the bridge. The PUT first refuses a submitted
  bridge that overlaps a submitted pool (`findDockerBridgePoolOverlap`, 409
  `cidr_overlaps_docker_network`), then checks each new range with
  `excludeDockerHostCidrs` so a replace never collides with the config it
  overwrites. They are host configuration, not a
  registration: the daemon pulls them over
  `GET /api/daemon/v1/host/docker-networking` and the `docker` Ansible role
  merges them into `/etc/docker/daemon.json` (restarts dockerd; existing
  networks keep their ranges). **Per-network `kind='docker'` addressing:**
  rows may carry `options.subnet` / `ipRange` / `gateway` / `mtu`
  (`docker-network-name.ts`); `network.cidr` is the registry-visible range
  and `POST`/`PATCH /networks` keep it in agreement with `options.subnet`
  (`reconcileDockerNetworkAddressing` — either may be sent, a disagreeing pair
  is **400** `docker_network_subnet_mismatch`, `cidr: null` is refused while
  `ipRange` / `gateway` remain). The addressing rides `environment.deploy` as
  the additive `dockerNetworkAddressing[]` sibling of `dockerExternalNetworks`
  (resolved by `resolveRegisteredExternalDockerNetworks` from the same rows
  the registration check loads) and is applied only when the daemon *creates*
  the network. **`fabric.options.containerPool` is operator-settable** via
  `PUT /organizations/:id/fabric` (`containerPool`, IPv4, prefix ≤ `/16`):
  validated through the same authority with the current pool excluded, and
  **409** `fabric_container_pool_in_use` when an allocated relay prefix would
  fall outside it — changing the pool never renumbers existing relays. The
  policy is handed to `enableOrganizationFabric` and written **before** relay
  allocation, in one transaction with the fabric row, so a first-time enable
  carves every relay `/16` from the requested pool; a pool too small for the
  org's servers (**409** `fabric_prefix_pool_exhausted`) or one the
  auto-picked host range lands in (**409** `cidr_overlaps_fabric`) rolls back
  and leaves TurboFabric disabled.
  `src/lib/net/private-endpoint.ts` resolves reachability (`local` →
  `datacenter` → `fabric` → `public`) in an **address-family aware** way: it
  intersects the source and target pin families in each trusted shared
  datacenter (priority order — see the routing-policy bullet below) and orders
  candidates by `datacenter.options.addressPreference` (default **IPv6**, RFC
  6724), never returning a family the source does not hold; a trusted shared
  datacenter with no common family is **422** `private_family_mismatch`. Fabric
  dials over `tp0`.
  Shared membership + **at least one** subnet gate managed-cluster private
  placement (`assertDatacenterHasCidr` / `assertServerDatacenterReady` in
  `src/lib/net/datacenter-networks.ts`). New error codes: **400** `invalid_cidr`
  / `address_not_in_any_subnet`, **409** `address_in_use` / `subnet_overlaps` /
  `subnet_has_members`, **422** `private_family_mismatch` (alongside existing
  `datacenter_has_members` / `datacenter_has_networks`).

- **Datacenter routing policy (`options.priority` / `options.trusted`):** a
  datacenter is a **logical routing domain**, not a building — a server may
  belong to several. Two `datacenter.options` jsonb fields (parsed by
  `src/lib/datacenter-options.ts`, no migration) describe how the ladder should
  treat each membership:
  - `priority` — integer `0`–`1000`, **lower wins**; absent = **`100`**
    (`DEFAULT_DATACENTER_PRIORITY`). Out-of-range or non-integer values are
    dropped by the parser, never clamped.
  - `trusted` — boolean; absent = **`true`** (`DEFAULT_DATACENTER_TRUSTED`).
    `false` marks a datacenter whose L2 is **not** under the operator's control
    (shared or provider-owned segments).

  `PATCH /datacenters/:id` accepts both under the same **replace-all `options`**
  semantics as `addressPreference` (send the merged object). `GET /datacenters`
  and `GET /datacenters/:id` return the raw `options` **and** the effective
  top-level `priority` / `trusted` with defaults applied
  (`resolveDatacenterPolicy` / `attachEffectivePolicy`), so clients never
  re-derive them. The ladder **reads both**: `loadDatacenterPolicies`
  (`src/lib/net/datacenter-networks.ts`) loads the effective
  `{ addressPreference, priority, trusted }` per datacenter and
  `partitionSharedDatacenters` (`src/lib/net/private-endpoint.ts`) splits the
  datacenters a pair shares into trusted / untrusted lists ordered
  `(priority asc, id asc)` — the id tiebreak is what keeps the choice
  deterministic. The datacenter rung walks **only the trusted list**, for
  every purpose; an untrusted datacenter can neither win nor raise
  `private_family_mismatch`. `read-replication` / `client-backend` then fall
  through to fabric → public as before. `failover-replication` never leaves
  the LAN: an untrusted-only pair is **422**
  `failover_requires_trusted_datacenter` (replica create, member class patch,
  managed apply prepare — never collapsed into
  `failover_replica_requires_datacenter_transport`), no shared datacenter at
  all stays `private_path_unavailable`. TurboFabric path planning
  (`lanPathCandidate` in `src/lib/db/fabric-records.ts`) consumes the same
  partition through `EndpointAddressCaches.policyByDatacenter`, so a
  `direct_lan` WireGuard endpoint is never emitted on a segment the managed
  ladder refused; gateway locality ranking deliberately stays trust-blind
  (it only orders next hops — the hop itself is trust-filtered).
  `PATCH /datacenters/:id` compares the effective policy before/after the
  UPDATE and, only when `priority` or `trusted` actually changed, re-converges:
  every managed cluster with a member pinned into the datacenter goes through
  `fanOutManagedIngressReconcile` (recompute `replica.replication_transport`,
  re-materialize bindings, enqueue `managed.ingress.reconcile` on members and
  bound consumers), then `reconcileFabricMembership` re-plans the org fabric
  and enqueues `server.fabric.reconcile` only where the desired payload hash
  moved. The fan-out needs the command queue and both secrets on the context;
  without them (unit-test app, secretless isolate) it logs and skips, and a
  fan-out failure never turns the successful save into a 5xx. CIDR overlap /
  containment for datacenter subnets (IPv4 **or** IPv6) must go through the
  dual-family authority `cidrsOverlap` / `cidrContains` in
  `src/lib/ip-address.ts`; `src/lib/fabric/cidr.ts` keeps only IPv4 pool
  arithmetic and delegates its overlap helpers there.

- **Compose hosting projection (client surface):** `x-turbopanel.hosting[]` is
  the _declaration_; `hosting` rows are the _record_. `reconcile-hostings.ts`
  runs inside deploy-prepare, before anything reads a route, and materializes
  one row per declared entry (`ComposeHostingError` on an unresolvable
  certificate / managed address, an unsupported `tls.mode`, or a route a
  panel-authored row already claims — a hard refusal, never a silent downgrade).
  Everything downstream — `buildHostingsForService`, the daemon's ingress and
  TLS lanes — reads **rows**, never the compose block, so the projection is
  one-way and the row is the only thing a route is served from. Declaration
  shape and messages: `../lib/compose/hosting-extension.ts`; the compiler stage
  that carries the declarations is `Application.services[].hosting` in
  `../lib/compose/ir.ts`.
- **`docker run` importer (client surface):** `POST /docker-run/import` —
  session-gated, create-gated when a `projectId` is supplied. **Pure compute: it
  writes nothing.** It parses a pasted `docker container run` command into a
  one-service `ComposeDocument`, lints it, and returns the fragment plus
  `riskFlags` describing how the imported container's blast radius widens.
  Merging that fragment into a project or environment draft goes through the
  ordinary compose PATCH routes, where the write-boundary validation already
  lives — a second way into `options.compose` would mean two sets of rules.
  Nothing is emitted under `x-turbopanel`: the importer speaks plain Compose,
  per rule 1 of the frozen contract in `../lib/compose/AGENTS.md`. Parser and
  option registry: `../lib/docker-run/AGENTS.md`.
