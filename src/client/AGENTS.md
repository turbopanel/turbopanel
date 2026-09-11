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
  `src/lib/net/private-endpoint.ts` resolves reachability (`local` → `fabric` →
  `datacenter`) in an **address-family aware** way: it intersects the source and
  target pin families in the shared datacenter and orders candidates by
  `datacenter.options.addressPreference` (default **IPv6**, RFC 6724), never
  returning a family the source does not hold; a shared datacenter with no
  common family is **422** `private_family_mismatch`. Fabric dials over `tp0`.
  Shared membership + **at least one** subnet gate managed-cluster private
  placement (`assertDatacenterHasCidr` / `assertServerDatacenterReady` in
  `src/lib/net/datacenter-networks.ts`). New error codes: **400** `invalid_cidr`
  / `address_not_in_any_subnet`, **409** `address_in_use` / `subnet_overlaps` /
  `subnet_has_members`, **422** `private_family_mismatch` (alongside existing
  `datacenter_has_members` / `datacenter_has_networks`).

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
