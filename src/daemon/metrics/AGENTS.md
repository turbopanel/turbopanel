# Server metrics — AGENTS.md

Host-metrics ingestion (`POST /api/daemon/v1/metrics`, never wakes the DO),
backend storage, and the query/caching API — **v4 contract** (`contract-v4.ts`,
schema version 4). v4 drops v3's flat `HOST_METRIC_KEYS` allowlist and its
`MetricPart` (`core`/`extended`/`sensors`/`traffic`) partitioning entirely:
metrics are grouped by **entity** (host, network device, filesystem, block
device, GPU, hardware signal, ingress source, database proxy) with a stable
logical id per entity, every leaf value is `number | null` (missing is always
`null`, never coerced to `0`), and no value's presence is inferred from
bitmask/part membership.

Root context: `../../../AGENTS.md`. Daemon cell: `../cell/AGENTS.md`. Operator
glossary (what each console chart means):
`../../../../website/docs/metrics/`. Human docs + AE cost model:
`../../../../website/docs/architecture/server-metrics.mdx`.

**v3 is fully retired.** The v3 contract (`contract.ts`, `validation.ts`,
`metric-descriptors.ts`, `disabled-store.ts`, `types.ts`,
`backends/cloudflare/{store,field-map,sql-api}.ts`,
`query/{series-response,
derived-metrics}.ts`) has been deleted, along with
their tests. `DuckDbParquetServerMetricsStore` implements only
`ServerMetricsStoreV4` now — its
`queryHostSeries`/`queryHostSummary`/`queryFleetHostSnapshot` accept only v4
canonical metric names, and the old `writeHostSample` compat method is gone.
`app.ts`/`db.ts`/`workers.ts` carry only the `serverMetricsStoreV4` binding —
there is no parallel v3 field. `do.ts`/`offline-sweep.ts`'s status sink and
offline-sweep's AE-direct liveness read both resolve through the v4
store/binding (`resolveServerMetricsStoreV4` / `SERVER_METRICS_V4`). The
active Analytics Engine binding is `SERVER_METRICS_V4` on dataset
`turbopanel_server_metrics_v4`. Genuinely shared, version-neutral pieces that
used to live in the v3 files (the HTTP/SQL transport primitives, the generic
`{timestamp, connected, reason}` status-row parser, the validation rate-limit
helpers, `MetricsBackendKind`/`ServerStatusEvent`/`StatusHistoryQuery`/
`StatusHistoryResult`) were relocated into their `-v4.ts` siblings
(`sql-api-v4.ts`, `validation-v4.ts`, `types-v4.ts`) rather than duplicated.

#### The v4 family catalog

Every family is a row-kind (`"metrics"`) with a `hostedFamily`
(`metric-descriptors-v4.ts`'s `HostedFamilyV4`) discriminator. Two are the
**universal baseline** — present on every sample regardless of hardware — the
rest are **presence-gated** (the entity/subsystem must actually exist on the
machine) or **capability-gated** (the org/server's `MetricsCapabilityPlan` must
allow it, see below), or both.

| Family                   | Shape                                                                                                               | Gating                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `host.system`            | single row: `cpu` + `kernel` + `memory` fields (except `host.cpu.processCount`)                                      | universal baseline — always emitted                                                                                                                                                                                      |
| `host.io`                | single row: `storage` + `network` fields, plus embedded primary NIC(s) when `SlotMapping` resolves them, plus `host.cpu.processCount` in the first reserved double (host.system's 19 slots are full) | universal baseline — always emitted                                                                                                                                                                                      |
| `network`                | one row per unaccounted-for network device                                                                          | presence-gated (only devices not embedded in `host.io` and not a fabric device page)                                                                                                                                     |
| `filesystem`             | one row per filesystem beyond the root filesystem                                                                   | presence-gated + capability-gated (`extraFilesystemSlots`)                                                                                                                                                               |
| `block`                  | one row per block device (per-disk detail)                                                                          | presence-gated + capability-gated (`detailedBlockDeviceSlots`, default 1 — same "base entitlement" pattern as `gpuSlots`; collector emits `isServiceDevice` devices only)                                                |
| `gpu`                    | one row per GPU (2 GPUs/row, `gpuRows = ceil(gpus/2)`)                                                              | presence-gated + capability-gated (`gpuSlots`, default 1 — "the base entitlement includes one GPU slot; the GPU family is presence-gated": a plan can _entitle_ GPU reporting without a machine _emitting_ any GPU rows) |
| `hardware.physical`      | one row per physical sensor signal (temp/power, never fan RPM/GPU)                                                  | presence-gated + capability-gated (`physicalHardwareSignalSlots`; virtual machines default to 0)                                                                                                                         |
| `managed.ingress`        | one row per ingress source (Caddy/Traefik)                                                                          | presence-gated + capability-gated (`managedIngressEnabled`)                                                                                                                                                              |
| `managed.database_proxy` | one row per database-proxy source (ProxySQL)                                                                        | presence-gated + capability-gated (`databaseProxyMetricsEnabled`)                                                                                                                                                        |
| `cpu.detail`             | single row: busiest-core hotspots + freq/sched counters                                                             | capability-gated (`cpuDetailEnabled`)                                                                                                                                                                                    |
| `memory.detail`          | single row: slab/dirty/writeback/reclaim breakdown                                                                  | capability-gated (`memoryDetailEnabled`)                                                                                                                                                                                 |
| `cpu.core.live`          | one row per online logical core                                                                                     | capability-gated (`cpuLiveCoreSlots`), live sessions only                                                                                                                                                                |

`numaNodes` (`NumaNodeSampleV4`) is a fully-shaped reserved family — wired into
`MetricsSampleV4.numaNodes?` and `numaNodeSlots` in the capability plan, not yet
populated by any collector.

**Entitlement vs. emission**, restated: a capability-plan slot count (e.g.
`gpuSlots: 1`) is what a server is _allowed_ to report; whether it actually
emits that family's rows depends entirely on whether the daemon detected the
hardware. `truncateSampleToCapabilityPlanV4` (`capability-plan.ts`) enforces the
ceiling at ingest time (truncates the sample to at most `N` entries per
capability-gated array); it can only shrink what the daemon already reports,
never fabricate rows for absent hardware.

**Representative row-count matrix** (`testing/representative-machines.ts` — 16
fixed machine shapes, pinned by
`backends/cloudflare/representative-row-counts.test.ts`): `1-nic-vm` = 2,
`2-nic-vm` = 2, `2-nic-fabric-vm` = 2, `1-gpu-vm` = 3, `web-vm` = 3,
`web-gpu-vm` = 4, `db-only-vm` = 2, `db-proxysql-vm` = 3,
`bare-metal-low-signals` = 3, `bare-metal-gpu` = 4, `4-nic` = 3, `8-nic` = 4,
`16-gpu` = 10, `24-block-devices` = 14, `12-extra-filesystems` = 4,
`large-cpu-ram` = 4. Every machine writes at least the 2-row baseline
(`host.system` + `host.io`); additional rows are `ceil(count / entitiesPerPage)`
per presence-gated family actually populated on that shape (e.g. `16-gpu`: 2
baseline + `ceil(16/2)` = 8 GPU rows = 10 total).

#### Ingest write path

The **only** write path is the authenticated `POST /api/daemon/v1/metrics` HTTP
route (`api-routes.ts`), handled on the normal Worker isolate (Analytics Engine)
/ Deno process (DuckDB) — **never** waking the Durable Object. Pipeline:
`validateMetricsSampleV4` (`validation-v4.ts`) →
`resolveEffectiveMetricsCapabilityPlan` (`server-metadata.ts`) →
`truncateSampleToCapabilityPlanV4` (`capability-plan.ts`) → fire-and-forget
`ServerMetricsStoreV4.writeSample(sample, slotMapping)` via
`getServerMetricsStoreV4(c)`, where `slotMapping` is the caller-resolved
`(topology generation) -> SlotMapping`
(`client/servers/topology-slot-mapping.ts`), computed once by the ingest route
(it already does that work for capability planning) and threaded straight into
the store — never re-derived by the store itself. WebSocket
`{ type: "metrics" }` frames are **not** accepted — ingestion is HTTP-only.

Store selection: `resolveServerMetricsStoreV4` (`store-selection.ts` /
`store-selection-workers.ts`) — always on, no enable/disable gate; a backend
that cannot be constructed falls back to `UnavailableServerMetricsStoreV4`
(reads reject with `metrics_backend_unavailable`, writes stay silent no-ops),
and a genuinely unconfigured Workers binding falls back to
`DisabledServerMetricsStoreV4` (`available: false`, never a 503).

#### Server metrics (Workers Analytics Engine)

Wiring: `SERVER_METRICS_V4` binding →
`CloudflareAnalyticsEngineServerMetricsStoreV4`
(`src/daemon/metrics/backends/cloudflare/store-v4.ts`, `field-map-v4.ts`,
`sql-api-v4.ts`). Deno uses DuckDB + Parquet (`DuckDbParquetServerMetricsStore`,
below).

| Binding / config | Value                                                                                                                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrangler binding | `SERVER_METRICS_V4` (`analytics_engine_datasets`)                                                                                                                                                                                                                                                           |
| Dataset name     | `turbopanel_server_metrics_v4` (`AE_V4_DATASET_NAME`, `field-map-v4.ts`)                                                                                                                                                                                                                                  |
| Write API        | `writeDataPoint({ indexes, doubles, blobs })` — sync, non-blocking; one call per family row actually emitted (2 baseline + 0..N presence-gated), full 20/20 doubles/blobs shape on every row                                                                                                                |
| SQL API          | `POST .../analytics_engine/sql` with `Authorization: Bearer <token>`; response envelope rows under `result.data`                                                                                                                                                                                            |
| Max range        | Default `AE_DEFAULT_MAX_RANGE_SECONDS` = 90 days; override via `TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS`                                                                                                                                                                                             |

**Envelope (every row kind: `"metrics"` / `"event"` / `"status"`)** —
`AE_V4_BLOB_*_INDEX` constants in `field-map-v4.ts`:

| Slot           | Content                                                                                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index1`       | authenticated `serverId` UUID only                                                                                                                                                                                                 |
| `blob1`        | row-kind discriminator: `"metrics"` / `"event"` / `"status"`                                                                                                                                                                       |
| `blob2`        | `"metrics"` rows: the `HostedFamilyV4`; `"event"` rows: `MetricEventKindV4`; empty on `"status"` rows                                                                                                                              |
| `blob3`        | schema version (stringified `4`)                                                                                                                                                                                                   |
| `blob4`        | collection mode (`"baseline"` / `"live"`); empty on `"status"` rows                                                                                                                                                                |
| `blob5`        | sample/event timestamp; empty on `"status"` rows (AE stamps its own ingestion timestamp there)                                                                                                                                     |
| `blob6`        | sample sequence (stringified integer); empty on `"status"` rows                                                                                                                                                                    |
| `blob7`        | `metadata.topologyGeneration` (stringified integer); empty on `"status"` rows — v4's replacement for v3's `hardwareProfileGeneration`                                                                                              |
| `blob8`        | reserved for a future capability-plan-generation hash (always `""` today)                                                                                                                                                          |
| `blob9`        | page index within a paged per-entity family (`"0"` for unpaged rows) — **backend-private**, never referenced outside `backends/cloudflare/`                                                                                        |
| `blob10`       | family-conditional: `sourceId` (`managed.*`), comma-joined per-page entity ids (`gpu`/`network`/`filesystem`/`block`/`hardware.physical`), `event.source` (`"event"` rows), empty on `host.system`/`host.io` — **backend-private** |
| `blob11`–`13`  | `"event"` rows only: `entityId`, JSON `payload`, `eventId`                                                                                                                                                                         |
| `blob14`–`16`  | reserved empty                                                                                                                                                                                                                     |
| `blob17`       | `"status"` rows: transition reason; `"event"` rows: severity; empty on `"metrics"` rows                                                                                                                                            |
| `blob18`–`20`  | reserved empty                                                                                                                                                                                                                     |
| `double1`–`19` | `"metrics"` rows: the family's field values in field-map-declared order (test-pinned against `metric-descriptors-v4.ts`); `"status"` rows: `double1` = connected (1/0)                                                             |
| `double20`     | `"metrics"`/`"event"` rows: `intervalSeconds` (the weighting term for aggregation)                                                                                                                                                 |

The paged-entity "page identity" symbols (`AE_V4_BLOB_PAGE_INDEX`,
`AE_V4_BLOB_SOURCE_OR_IDENTITY_INDEX`, `entityIdInPageIdentityPredicateV4`,
`splitPageIdentityV4`) are backend-private per `field-map-v4.ts` and
`sql-api-v4.ts`'s own doc comments — never inline positional literals or
reference these symbols outside `backends/cloudflare/`;
`scripts/check-v4-boundaries.mjs` enforces this at CI (see below).

**Identity-addressed slotting:** when a `SlotMapping` is available (resolved
from the sample's `metadata.topologyGeneration` via `topology-slot-mapping.ts`'s
`computeSlotMapping`), `host.io`'s otherwise- unused `double12`..`double17`
embed the first two monitored NIC slots (`slotMapping.normalNicSlots[0..1]`)
directly — so the common 1-NIC/2-NIC host never writes a `network` page at all —
slots 3+ (self-hosted / higher-tier operators) page as `network` rows in slot
order, and TurboFabric mesh devices (`slotMapping.fabricDeviceIds`) never page as
`network` rows. `normalNicSlots` is an ordered array (slot 1 first, at most
`MAX_NIC_SLOTS` = 8, mirrored from the daemon in `topology-types.ts`): the
operator's `hardwareProfile.nicSlotDeviceIds` list wins outright, otherwise
exactly the uplink the daemon flagged `defaultRoute` (the gateway NIC; first
sorted uplink as fallback). `PUT /servers/:id/metrics/hardware-profile`
validates every listed id as an `uplink` in the last recorded topology and
rejects a list longer than the server's effective `normalNicSlots`
(`nicSlotLimit` on `/series` and `/summary` tells the UI that limit). `gpu`/`network`/`filesystem`/`block` pages order entities
by the matching `*PageOrder` list (new-since-recorded-generation entities append
in sample order). No recorded generation yet (first sample, resync pending)
degrades gracefully to pre-topology positional packing — never a dropped sample.

**Missing metrics:** same `-1e308` sentinel idiom as v3
(`AE_V4_MISSING_METRIC_SENTINEL`), never coerced to `0`; all host metrics are ≥
0 so no collision. Query aggregates exclude it the same way v3's did
(`weightedAvgExpressionForMetric`/`sumExpressionForMetric` analogues in
`sql-api-v4.ts`).

#### Metrics events (`blob1 = "event"`)

A closed catalog of discrete state-change/fault signals distinct from the
continuous numeric families — `METRIC_EVENT_KINDS_V4` in `contract-v4.ts` (OOM
kills, hung tasks, conntrack exhaustion, filesystem state changes,
SMART/NVMe/RAID faults, NIC link state, TurboFabric mesh state, fan/thermal/
PSU/voltage/ECC faults, GPU faults, clock-sync state, topology/boot generation
bumps). `isHardwareHealthEventKindV4` classifies each kind as a
physical-hardware-health signal or not (`HARDWARE_HEALTH_EVENT_KIND_V4`, a
`Record` so an unclassified new kind fails to compile rather than silently
defaulting); `hardwareHealthEventsEnabled` on the capability plan gates only the
hardware-health half — OS/kernel/filesystem/fabric/clock/generation events are
always allowed regardless of plan. No v3 equivalent — v3 has no discrete event
stream. Exposed via `GET /api/client/v1/servers/:id/metrics/events`
(`ServerMetricsStoreV4.queryMetricEvents`, optional-on-interface —
`available: false`, never a 503, when the resolved store doesn't implement it).

#### Status event stream (`blob1 = "status"`)

Every genuine `connected` flip on the `server` row also fires a fire-and-forget
status event — on AE into the v4 dataset (discriminated by `blob1`); on
Deno/DuckDB into its own typed `server_status_events` table. Source:
`emitServerStatusEvent` (`status-events.ts`), called from `projectServerDaemon`
(`src/daemon/cell/postgres-projection.ts`), registered per-runtime via
`setServerStatusEventSink`/`getServerStatusEventSink` (no shared request context
across the request isolate, DO isolate, cron-only offline-sweep isolate, and
Deno process).

`queryStatusHistory` is **optional-on-interface** on `ServerMetricsStoreV4` —
`CloudflareAnalyticsEngineServerMetricsStoreV4` is the one store that implements
it (via `queryStatusHistoryViaSqlApiV4`); `DisabledServerMetricsStoreV4` does
not. `client/servers/metrics-routes.ts`'s `/connection` route checks
`storeV4?.queryStatusHistory` and falls back to an inline `available: false`
result — **not** to the v3 store — when absent. Resolves `{ from, to }` into
prior-state + in-range-transitions reads, fed through the shared backend-neutral
`computeStatusUptime` (`query/uptime.ts`) for
`uptimeSeconds`/`downtimeSeconds`/`unknownSeconds`/`uptimePercent` parity across
backends. Exposed via `GET /api/client/v1/servers/:id/metrics/connection`.

**History-only — never authoritative for liveness.** This stream (and everything
derived from it) is asynchronous, best-effort, sampled/disposable metrics
history and **must never** be read to determine whether a server is currently
online. Postgres `server.is_connected`/`server.status_changed_at`
(`src/daemon/cell/server-status.ts`) is the sole source of truth for current
liveness — see `src/lib/db/AGENTS.md` and `src/daemon/cell/AGENTS.md`. Do not
add a code path that gates any online/offline decision on AE/DuckDB status
history.

#### Server metrics (DuckDB + Parquet — self-hosted Deno)

`DuckDbParquetServerMetricsStore` (`backends/duckdb/`) over the embedded
`@duckdb/node-api` engine — no external service, no credentials. State root:
`resolveMetricsDir()` (`TURBOPANEL_METRICS_DIR`, default `<stateDir>/metrics`)
holding `metrics.duckdb`, `parquet/`, `tmp/`, `schema-version`. Writes are
batched in-process (default 10 rows / 5 s age) into one transaction; queries
force-flush pending batches.

**One real typed table per entity family — no positional layout, no sentinel,
arbitrary cardinality** (`schema.ts`, `DUCKDB_SCHEMA_MARKER_VERSION` currently
`6`):

| Table                            | Family                                      |
| -------------------------------- | ------------------------------------------- |
| `server_host_samples`            | `host.system` + `host.io` (single wide row) |
| `server_network_samples`         | `network`                                   |
| `server_filesystem_samples`      | `filesystem`                                |
| `server_block_samples`           | `block`                                     |
| `server_gpu_samples`             | `gpu`                                       |
| `server_hardware_signal_samples` | `hardware.physical`                         |
| `server_ingress_samples`         | `managed.ingress`                           |
| `server_database_proxy_samples`  | `managed.database_proxy`                    |
| `server_cpu_hotspot_samples`     | `cpu.detail` (hotspot rows)                 |
| `server_cpu_core_samples`        | `cpu.core.live`                             |
| `server_memory_detail_samples`   | `memory.detail`                             |
| `server_metric_events`           | metrics events (`MetricEventV4`)            |
| `server_status_events`           | connection-status transitions               |

Every metric column is real, independently-nullable `DOUBLE` (or typed identity
column) — missing is a real SQL `NULL`, never a sentinel or a part-membership
flag. Entity tables carry arbitrary cardinality per sample (one row per reported
entity), unlike v3's fixed-width part tables.

**Schema on open** (`database.ts`): `CREATE TABLE IF NOT EXISTS` /
`CREATE INDEX IF NOT EXISTS` for the current layout (schema marker **6**).
A missing, corrupt, or non-6 sidecar marker discards `metrics.duckdb`,
`parquet/`, `tmp/`, and `schema-version` before the current store is created
— there is no in-place migration and no supported path for older DuckDB
files. Configured retention still prunes expired points
(`TURBOPANEL_SERVER_METRICS_RETENTION_DAYS`, default 90). Analytics Engine
has no SQL `DELETE`; hosted points age out after Cloudflare's ~3-month
retention. The sidecar marker is written after a successful open.

**Daily Parquet archive**, partitioned per family
(`parquet/<family-table>/year=YYYY/month=MM/day=DD/*.parquet`; timer armed by
`deno-server.ts`'s `startDailyArchiveTimer()`): each completed UTC day is sealed
out of the hot tables — export to `tmp/`, validate row count by re-reading,
atomic rename, then delete hot rows. Interrupted exports (`tmp/*.parquet`) are
swept on the next tick. Reads union the hot tables with overlapping partitions.
Retention (`TURBOPANEL_SERVER_METRICS_RETENTION_DAYS`, default 90) prunes
expired partitions plus any hot rows past the cutoff.

**Cross-backend regression net:** `representative-machines.ts` (16 machine
shapes) feeds `representative-row-counts.test.ts` (exact AE row count + family
order per shape), `cross-backend-parity.test.ts` (AE vs. DuckDB agree on the
same logical sample), `topology-generation-guard.test.ts` (re-interpreting a
sample under a stale topology generation never corrupts identity-addressed
slots), `orphan-row-semantics.test.ts`, and `counter-reset-end-to-end.test.ts`
(storage/query never fabricates a value in place of a daemon-emitted `null`
after a monotonic counter reset — daemon half of the battery lives in
`turbopaneld/src/metrics/collector/baseline-reset-battery.test.ts`). **New
metrics `*.test.ts` files must be claimed** in `scripts/test-coverage.sh` (Deno
`@std/assert` suites) or `vitest.config.ts` `test.include` (`validation-v4.test.ts`
is the Workers-pool exception) — then `pnpm check:test-inventory`. Unclaimed
suites fail `test:hook` / CI and never reach Sonar LCOV. Root `AGENTS.md` →
**Adding tests (inventory)**. The
AE/v4-boundary guard (`scripts/check-v4-boundaries.mjs` here, mirrored into
`turbopaneld/scripts/check-metrics-legacy.ts`) enforces: (1) AE positional
tokens (`doubleN`/`blobN` literals, the `-1e308` sentinel) stay confined to
`backends/cloudflare/`; (2) v3-only symbols (`MetricPart`, `HOST_METRIC_KEYS`,
the v3 `parts` field) never appear as real code anywhere in the metrics tree or
in the metrics-contract-facing surfaces outside it (`src/daemon/openapi/`,
`src/client/servers/metrics-routes*.ts`, `server-topology-records.ts`,
`topology-*.ts`) — those surfaces must stay backend-agnostic; (3)
backend-private page-identifier symbols never leak outside
`backends/cloudflare/`.

#### Server metrics — query API & caching

Endpoints (`src/client/servers/metrics-routes.ts`), all v4-only:

| Method | Path                                            | Notes                                                                                       |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET`  | `/api/client/v1/servers/:id/metrics/series`     | per-entity selectors (`parseSeriesMetricSelectorsV4`) grouped by family                     |
| `GET`  | `/api/client/v1/servers/:id/metrics/summary`    | host summary + `cpuLimits`/`temperatureUnit` envelope                                       |
| `GET`  | `/api/client/v1/servers/:id/metrics/connection` | status-event history (uptime/downtime)                                                      |
| `GET`  | `/api/client/v1/servers/:id/metrics/events`     | v4-only metrics-event history; `available: false` (never 503) when unsupported by the store |
| `GET`  | `/api/client/v1/servers/metrics/latest`         | one fleet snapshot per org server — never N per-server chart calls                          |

Never authorize by bare UUID possession — session middleware + resource read
grant required. Fleet latest never accepts client-supplied serverIds.

**Backend-neutral entity-scoped query/cache layer:** `resolveStoreBackendKindV4`
(`metrics-routes-helpers.ts`) classifies the resolved `ServerMetricsStoreV4`
instance (`disabled` / `analytics-engine` / `duckdb`) purely by instance type

- runtime, never by config presence — every route builds its cache key from
  `backend` so an AE-shaped and a DuckDB-shaped cache entry for the same
  server/range can never collide. **Chart cache** (`query/cache.ts`): key =
  `tp:metrics:chart:` + kind + authorized `serverId` + bucket-rounded range +
  sorted metrics + resolution + backend + `v{schemaVersion}` (callers pass
  `schemaVersion: 4` explicitly, required) + `tg{topologyGeneration}` when a
  caller scopes to one topology generation. TTL: live 45 s / historical 300 s.
  Workers: Cloudflare Cache API; Deno: bounded in-process `Map` (256 entries).

**Resolution ladder** (`query/resolution.ts`): range ≤10 min → 10 s; ≤1 h → 60
s; ≤6 h → 300 s; ≤24 h → 900 s; ≤7 d → 3600 s; ≤30 d → 21600 s; else 43200 s.
`MAX_METRICS_POINTS` = 1500; range ≤90 days.

**MetricsCapabilityPlan enforcement point:** the capability plan is resolved and
enforced **once**, at ingest (`resolveEffectiveMetricsCapabilityPlan` →
`truncateSampleToCapabilityPlanV4`, both before the sample ever reaches a store)
— query routes never re-check capability, they only ever see already-truncated
data (the hardware-profile PUT re-resolves it only to reject an over-limit
`nicSlotDeviceIds` list up front). `networks` truncation keeps the slot-mapped
NICs within `normalNicSlots` (slot order) plus fabric devices when
`turboFabricEnabled`; without a resolved mapping the first `normalNicSlots`
entries survive positionally. `normalNicSlots` defaults by **deployment**
(`MetricsDeploymentKind`, from the runtime passed to `registerDaemonApiRoutes` /
`registerServerMetricsRoutes` — never inferred from `typeof Deno`): 2 on the
hosted platform (Workers; more will need a licensing tier later), `MAX_NIC_SLOTS`
(8) self-hosted (Deno); org/server overrides are clamped to 8.
`MetricsCapabilityPlanV4` fields: baseline/live interval seconds,
`normalNicSlots`, `turboFabricEnabled`, `extraFilesystemSlots`,
`detailedBlockDeviceSlots`, `gpuSlots`, `gpuInterconnectEnabled`,
`physicalHardwareSignalSlots`, `cpuDetailEnabled`, `cpuLiveCoreSlots`,
`memoryDetailEnabled`, `numaNodeSlots`, `managedIngressEnabled`,
`databaseProxyMetricsEnabled`, `hardwareHealthEventsEnabled` — deliberately no
pricing-tier names/literals, only slot counts and toggles. Resolution order:
platform default → org (`organization.options.metricsCapabilityPlan`) → server
(`server.options.metricsCapabilityPlan`), mirroring
`resolveEffectiveCpuThermalLimits`.

UI charts: **`../ui/AGENTS.md`** (Server metrics). Operator glossary:
**`../website/docs/metrics/`**. Human docs + AE cost model:
**`../website/docs/architecture/server-metrics.mdx`**.

## Durable invariants

1. Every sample writes at least the 2-row universal baseline (`host.system` +
   `host.io`) — never fewer, regardless of capability plan or hardware.
2. A capability-plan slot count is an _entitlement_; a presence-gated family's
   row count reflects _emission_ (actual detected hardware), truncated down to
   (never up to) the entitlement.
3. Missing metric values are `null` (contract) / SQL `NULL` (DuckDB) / `-1e308`
   sentinel (AE) — never coerced to `0`, on any backend.
4. AE positional tokens (`doubleN`/`blobN` literals, `-1e308`) never appear
   outside `backends/cloudflare/` — always go through `field-map-v4.ts`.
5. The v4 page-identifier symbols (`AE_V4_BLOB_PAGE_INDEX`,
   `AE_V4_BLOB_SOURCE_OR_IDENTITY_INDEX`, `entityIdInPageIdentityPredicateV4`)
   never appear outside `backends/cloudflare/`.
6. v3-only symbols (`MetricPart`, `HOST_METRIC_KEYS`, the v3 `parts` field)
   never appear as real code anywhere in the metrics tree or in a
   metrics-contract surface outside it — enforced by `check-v4-boundaries.mjs`.
   The v3 contract is fully deleted; this guard exists to keep it from creeping
   back in.
7. `DuckDbParquetServerMetricsStore` is the single Deno store instance — never
   two independently constructed instances opening two DuckDB handles on one
   database file.
8. `queryStatusHistory` is optional-on-interface on `ServerMetricsStoreV4`; an
   absent implementation degrades to an inline `available: false` result, never
   to a v3 store read.
9. AE/DuckDB status history is never authoritative for current liveness — only
   Postgres `server.is_connected` is.
10. `slotMapping` is resolved once by the ingest route and threaded through to
    the store — stores never re-derive it themselves.
11. An unresolved topology generation (no recorded `SlotMapping` yet) degrades
    gracefully to positional packing — never a dropped sample.
12. `HARDWARE_HEALTH_EVENT_KIND_V4` is a `Record` over every `MetricEventKindV4`
    — a new event kind that isn't classified fails to compile, never silently
    defaults either way.
13. `hardwareHealthEventsEnabled` gates only hardware-health events;
    OS/kernel/filesystem/fabric/clock/generation events are always allowed.
14. A backend that fails to construct returns `UnavailableServerMetricsStoreV4`
    (reads reject, 503) — never silently degrades to the disabled store's
    `available: false`, which is reserved for a genuinely unconfigured binding.
15. Cache keys always include the authorized `serverId`, the resolved `backend`,
    and `schemaVersion` — a v3-shaped and v4-shaped entry for the same
    server/range can never collide.
16. `truncateSampleToCapabilityPlanV4` runs once, at ingest, before the sample
    reaches any store — query routes never re-check capability.
17. DuckDB missing-column reads are real SQL `NULL`s; bucket aggregation honors
    each metric's declared aggregation policy (`weighted-average` / `last` /
    `max` / `sum`) identically on AE and DuckDB.
18. Both AE and DuckDB honor the canonical half-open `[from, to)` range — upper
    bounds are exclusive so adjacent ranges never double-count.
19. A late-arriving sample for an already-sealed Parquet day is merged on the
    next archive tick, never dropped — `sealDayToParquet` rebuilds from the
    union of the sealed file and the day's hot rows.
20. The v3 contract is gone. `app.ts`/`db.ts`/`workers.ts`/`do.ts`/
    `offline-sweep.ts`/`store-selection*.ts` carry only the v4 store/binding —
    never reintroduce a `serverMetricsStore` (non-V4) field, a
    `resolveServerMetricsStore` (non-V4) function, or a `SERVER_METRICS`
    (non-V4) binding as a shortcut for a "v3-shaped" caller.
