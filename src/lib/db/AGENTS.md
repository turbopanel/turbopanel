# Database

Schema changes are versioned in **`migrations/`**. After editing `schema.ts`,
run `pnpm drizzle-kit generate --name <summary>` to create SQL files (always
pass `--name` — see below). Apply pending migrations with
`TURBOPANEL_DATABASE_URL=… pnpm migrate`; Workers deploy runs the same command.
`pnpm migrate` first runs `scripts/check-postgres-compat.mjs`, which refuses to
proceed unless the target server has the built-in `uuidv7()` (PostgreSQL 18
minimum — the baseline defaults every surrogate primary key to it). Applied
migration versions are recorded in **`public.migration`** (configured in
`drizzle.config.mjs`; see “Documented exception: `public.migration`” below).

**`0000_init.sql` is the squashed baseline for a fresh database, and nothing
else.** Do not edit it to carry a schema change: a provisioned instance has
already recorded `0000_init` in `public.migration` and will never replay it, so
an edit there reaches new installs only and leaves every upgraded instance
querying relations that were never created. Schema changes land as **additive
forward migrations** — `pnpm drizzle-kit generate --name <summary>` writes the
next `NNNN_*.sql` plus its `migrations/meta/NNNN_snapshot.json` and appends the
journal entry; commit all three and leave `0000_init.sql` untouched.

The baseline has been regenerated while pre-MVP (no installed instances, no
production data) — first for the `gitapp` table and `installation.app_id`, then
the schema-cutover squash, then to fold the `monitor` table into `0000_init.sql`
(replacing `0001_add_monitor_credential_table`), then again to fold org-level
repository uniqueness into `0000_init.sql` (replacing
`0001_repository_org_level_dedupe`, which also dropped the leftover
`repository.service_id` / `environment_id` parent columns), then again to fold
repository inspection columns into `0000_init.sql` (replacing
`0001_add_repository_inspection_columns`), then again to fold the `generation`
(server topology) and `capability` (metrics capability-plan) tables into
`0000_init.sql` (replacing `0001_add_server_topology_generation` and
`0002_add_capability_plan_generation`), then again to fold the product-tier
reshape into `0000_init.sql` (replacing `0001_product_tiers`: no `tier_id` on
`license`, derived `server.assigned_tier_id`, provider product + display
currency on `tier`, entitlements in code), then again to fold dropping
`project_name_format_check` into `0000_init.sql` (replacing
`0001_drop_project_name_format_check`). Each of those is a deliberate
pre-MVP exception, **not** a precedent: the policy above is what holds going
forward.
Additive forward migrations, `0000_init.sql` is the squashed baseline and
nothing else, and applying a regenerated baseline requires wiping the database
because `public.migration` replay follows the migration journal timestamps/order
(`migrations/meta/_journal.json`). Once a real instance exists, regenerating
stops being an option at all.

Physical boolean columns use an `is_` prefix (`is_connected`,
`is_read_eligible`, `is_for_build`, `is_for_runtime`, `is_emit_engine_defaults`,
`is_read_only`). Public API JSON still uses `connected`, `readEligible`,
`forBuild`, `forRuntime`, `emitEngineDefaults`, and `readOnly`.

The co-located dev server has live data — treat every database change as
production-adjacent.

**Server metrics is never stored in Postgres.** Host metrics live in Analytics
Engine (Workers) or DuckDB (Deno) only — see instance `AGENTS.md` (Server
metrics). Do not add metrics tables or columns here; there are no per-minute
Postgres projection writes for metrics.

## Multi-node PostgreSQL model

"Multi-node PostgreSQL" for the instance database means **primary/standby
replication with exactly one writable primary** — physical (streaming)
replication for HA/failover, logical replication for read replicas or DR. Every
writer (Workers, the Deno instance, `pnpm migrate`) connects to the single
current primary; migrations require PostgreSQL 18+ (built-in `uuidv7()`),
preflighted by `scripts/check-postgres-compat.mjs` before `drizzle-kit migrate`
runs.

**Sharded / distributed SQL is explicitly out of scope for this schema.** UUIDv7
primary keys (`uuid … DEFAULT uuidv7()`) buy exactly three things:
collision-free ids across writers and restores without sequence coordination, no
serial/identity hotspot to renumber on failover, and time-ordered index
locality. They do **not** make the schema distributed-SQL ready: no distribution
key has been chosen, no reference/global table classification exists, and every
foreign key and unique constraint assumes one coherent node. Targeting a sharded
or distributed engine (Citus, CockroachDB, YugabyteDB, …) would require a
dedicated design pass over `schema.ts` — choose a distribution key, classify
reference tables, and rework primary keys, foreign keys, and unique constraints
together — never piecemeal per-table edits.

Guard: `primary-key.test.ts` — every `CREATE TABLE` in committed migration SQL
under `migrations/` has a `PRIMARY KEY`; application primary keys are
`uuid … DEFAULT uuidv7()` or the single allowlisted natural key
`dispatch.command_id`; `serial` / identity columns / `nextval()` defaults are
rejected in application tables.

### Documented exception: `public.migration` (drizzle bookkeeping)

`pnpm migrate` (drizzle-kit → drizzle-orm `PgDialect.migrate`) creates its
bookkeeping table — verified against the vendored
`drizzle-orm/pg-core/dialect.js` and pinned by `primary-key.test.ts` — as:

```sql
CREATE TABLE IF NOT EXISTS "public"."migration" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
)
```

Audit: it **has** a primary key, but the key is sequence-backed (`SERIAL`). That
cannot meet the application-table invariant, and it doesn't need to: the table
is written only while migrations apply — an operator-controlled,
**single-writer, coordinator-local** operation against the primary
(`pnpm migrate`, Workers deploy, `bootstrap-dev-db.sh`) — never at request time
and never from concurrent writers. It is exempt from the UUID primary-key guard
(it is created by the migrator, not by SQL under `migrations/`); do not model
application tables on it. A drizzle-orm upgrade that changes this DDL fails
`primary-key.test.ts` and re-opens this audit.

## Schema sync directions

> **Fresh database:** versioned `pnpm migrate` is the only bootstrap path.
> Co-located dev converge runs `./scripts/bootstrap-dev-db.sh` via Ansible
> (`pnpm migrate`). Manual bootstrap: `./scripts/bootstrap-dev-db.sh` from the
> instance repo root. An unmigrated database is an operational failure (missing
> relations propagate); it must not be treated as install mode / `needsInstall`.

| Direction                                     | You changed                  | Command                                      | drizzle-kit  |
| --------------------------------------------- | ---------------------------- | -------------------------------------------- | ------------ |
| **Pull** (DB → code)                          | Live Postgres (Studio / SQL) | `dev/scripts/introspect.sh`                  | `introspect` |
| **Push** (code → DB, Deno dev only)           | `schema.ts`                  | `dev/scripts/sync.sh`                        | `push`       |
| **Generate migration**                        | `schema.ts`                  | `pnpm drizzle-kit generate --name <summary>` | `generate`   |
| **Apply migration** (Workers deploy + manual) | pending SQL in `migrations/` | `TURBOPANEL_DATABASE_URL=… pnpm migrate`     | `migrate`    |

Pick one source of truth per change — do not edit both sides and blindly run
both scripts.

### Pull: database → `schema.ts` (`dev/scripts/introspect.sh`)

Use when you designed in **Drizzle Studio** or applied DDL directly.

1. Change tables in Studio (`/developer/database` → **Start API & open
   studio**).
2. From the dev checkout, run `./scripts/introspect.sh` (resolves the instance
   repo via `TURBOPANEL_INSTANCE_REPO` / `$HOME/turbopanel`).
3. Review `schema.ts` (style, dropped tables).

`dev/scripts/introspect.sh`: loads `TURBOPANEL_DATABASE_URL` from env or
`turbopanel-instance` → introspect → copy to `schema.ts` → delete ephemeral
`drizzle/` output → `deno check`.

### Push: `schema.ts` → database (`dev/scripts/sync.sh`)

Use when you edited **`schema.ts` first** and need the live dev DB to catch up
without committing migration files (Deno dev convenience only).

1. Edit `src/lib/db/schema.ts`.
2. From the dev checkout, run `./scripts/sync.sh`.
3. Confirm drizzle-kit prompts (`--strict` by default). Use
   `./scripts/sync.sh --force` only when you accept possible **data loss** on
   dev.

`dev/scripts/sync.sh`: `deno check` → `drizzle-kit push` (no SQL files
committed). Flags: `--verbose`, `--force`.

Override connection for either script:
`TURBOPANEL_DATABASE_URL=postgresql://… ./scripts/introspect.sh` or
`./scripts/sync.sh` (from dev).

### Generate + apply migrations (Workers path)

Use when schema changes should ship as versioned SQL (required for Workers
deploy).

1. Edit `src/lib/db/schema.ts`.
2. Run `pnpm drizzle-kit generate --name <short_snake_case_summary>` — writes
   SQL under `migrations/` (e.g. `0002_add_command_table.sql`). **Always pass
   `--name`**; bare `generate` picks random names like `tan_silver_centurion`
   that are useless in review.
3. Commit the new migration files (developer only — after reviewing SQL).
4. Apply: `TURBOPANEL_DATABASE_URL=… pnpm migrate` (local or CI; **developer
   only**). Workers deploy runs `pnpm migrate` automatically.

Applied versions are tracked in **`public.migration`** (`drizzle.config.ts` sets
`migrations: { table: 'migration', schema: 'public' }`).

### Drizzle Studio (dev UI)

- **Test connection** — `GET /api/developer/v1/database/status`
- **Reset dev instance** — `POST /api/developer/v1/system/reset-dev` (superadmin
  session only): `DROP SCHEMA public CASCADE`, `drizzle-kit migrate`, restart
  instance. UI: Database section → **Reset Dev Instance**.
- **Studio** — `POST /api/developer/v1/database/studio` starts
  `drizzle-kit studio` on **loopback only** (**127.0.0.1:4983** / `::1`;
  `TURBOPANEL_DRIZZLE_STUDIO_HOST` must be `localhost`, `127.0.0.1`, or `::1` —
  non-loopback values are rejected without spawning). Open
  **`https://local.drizzle.studio?host=localhost&port=4983`** (hosted UI).
  Safari/Brave may block localhost — see
  [Drizzle docs](https://orm.drizzle.team/docs/drizzle-kit-studio#safari-and-brave-support).
- Studio applies DDL **directly** to the DB — follow with
  `dev/scripts/introspect.sh` to pull into code.

## Current policy (what not to run)

- Use `pnpm drizzle-kit generate --name …` + `pnpm migrate` for Workers-bound
  schema changes; `dev/scripts/sync.sh` (`push`) remains for Deno dev
  convenience only.
- **No ad-hoc push** — use `dev/scripts/sync.sh` only (after editing
  `schema.ts`), not raw `drizzle-kit push` in one-off commands.
- **No production DDL** from agents without explicit approval.

### Agent policy: generate yes, apply/commit no

Agents **may** edit `schema.ts` and run **`pnpm drizzle-kit generate --name …`**
when a task needs versioned SQL — but **must not apply migrations or commit
them**. Apply and commit stay with the developer so they can review the SQL
before it hits git or the local dev database.

**Generate with a meaningful `--name`.** Drizzle assigns random tags when
`--name` is omitted (e.g. `0001_tan_silver_centurion`). Always pass a short
snake_case summary of the change:

```bash
pnpm drizzle-kit generate --name add_command_table
pnpm drizzle-kit generate --name drop_member_role_columns
pnpm drizzle-kit generate --name server_license_fk_restrict
```

Pick a name that answers “what is this migration doing?” — table/column added or
dropped, constraint changed, index added. One logical change per migration when
possible.

Do **not** run (or offer to run):

- `pnpm migrate` / `drizzle-kit migrate`
- `dev/scripts/sync.sh` / `drizzle-kit push`
- `dev/scripts/introspect.sh` / `drizzle-kit introspect`
- `./scripts/bootstrap-dev-db.sh`
- Raw DDL against Postgres (Studio, `psql`, etc.)
- Bare `pnpm drizzle-kit generate` without `--name`

After generating, tell the developer to **review** the new SQL under
`migrations/`, then **apply locally** (`TURBOPANEL_DATABASE_URL=… pnpm migrate`)
and **commit** when satisfied. Do **not** commit files under `migrations/`
unless the developer explicitly asks.

Destructive changes (drop column/table, type narrowing) can lose dev rows.
`dev/scripts/sync.sh` prompts via `--strict`; `--force` skips those guardrails.

## Schema (ported from old trunk `apps/api`)

`schema.ts` mirrors the old monorepo database layout (Better Auth–compatible
tables, no auth runtime yet). Grouped by concern — see **Table groupings** below
(post-cutover names).

**Column order:** tables that carry `metadata` / `options` declare them
immediately after timestamps — `id` → `created_at` → `updated_at` → `metadata` →
`options` → remaining columns. If a table has one of those JSONB columns, it
must have both, and both are always nullable.

## Schema cutover (executed — see ledger archive)

The phase-1 cutover ledger — the full table/column/constraint inventory, locked
renames, and per-item keep/rename/drop adjudications with reasons — is archived
in [`schema-cutover-ledger.md`](./schema-cutover-ledger.md). Phase 2 executed
it: `schema.ts` and the squashed `migrations/0000_init.sql` use the post-cutover
names below, and the retired names are rejected by `table-naming.test.ts`.
Consult the ledger only for the historical **why** behind a kept or dropped
item.

## Table groupings

| Group             | Tables                                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity**      | `user`, `account`, `session`, `verification`, `passkey`, `2fa`                                                                                                                                 |
| **Organizations** | `organization`, `team`, `teammate` (org membership SoT), `invitation` (no `organization_id`; `team_id NOT NULL`), `tls`, `changeover`, `leaf`                                                   |
| **Billing**       | `tier` (platform-global priced offerings), `license`, `payer`, `subscription`, `seat` (export `subscriptionItem`)                                                                              |
| **Networking**    | `datacenter`, `network` (kinds `datacenter` / `docker` / `compose` / `managed`), `ip` (scopes `public` / `datacenter`), `fabric` (0–1 per org; TurboFabric on when present), `relay`, `subnet` |
| **Resource tree** | `workspace`, `project`, `environment`, `service`, `hosting`, `container`, `managed`, `replica`, `recovery`, `variable`, `principal`, `tenancy`, `binding`                                      |
| **Storage**       | `storage`, `copy` (export `storageCopy`), `mount`, `secret`                                                                                                                                    |
| **Git**           | `forge`, `connection`, `repository`; `delivery` is the webhook ledger for every kind (git *and* Stripe)                                                                                        |
| **Authorization** | `grant`                                                                                                                                                                                        |
| **Config**        | `setting` (`value` is `jsonb`)                                                                                                                                                                 |
| **Runtime**       | `server`, `monitor` (per-server sealed ProxySQL monitor credential), `command`, `dispatch`, `deployment`, `slot`, `task`, `label`                                                              |
| **Tagging**       | `tag`, `marker`                                                                                                                                                                                |

### Secrets never live on `server.options`

`server.options` is operator-facing configuration: `GET /servers`,
`GET /servers/:id` and the developer routes return the jsonb verbatim, and the
approved cached read models copy it into Redis. Anything written there is
therefore published to every reader of the server and cached outside Postgres.

The per-server ProxySQL monitor password (`tp_monitor_<serverId prefix>`) used
to live at `server.options.managedMonitor`; it now has its own **`monitor`**
table (one row per server, `secret_envelope` sealed with the data-encryption
key, `ON DELETE CASCADE` from `server`) — see
`src/client/managed/monitor-credential.ts`. Two guards keep it that way:
`REDACTED_SERVER_OPTION_KEYS` / `redactServerOptions` in `server-metadata.ts`
strip the legacy key at every read-model and response boundary, and
`parseServerOptions` is an allowlist. A new server-scoped secret gets its own
table; it does not get added to the redaction list.

## Physical table naming rule

Every physical `CREATE TABLE` name is **one standalone lower-case word** —
letter-first alphanumeric token, **no underscores**. Guarded by
`src/lib/db/table-naming.test.ts`, which scans every migration SQL file under
`migrations/`.

| Physical name  | Drizzle export    | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invitation`   | `invitation`      | Pending org/team invite (`grants` jsonb materialized on accept). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `organization` | `organization`    | Tenant org. Unchanged. **`slug`** stays NULL/reserved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tls`          | `tls`             | Org TLS library + Organization CA row. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `changeover`   | `changeover`      | Organization CA rotation journal (fan-out progress; partial unique in-flight per org). Was `rotation`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `passkey`      | `passkey`         | Better Auth–compat WebAuthn table. Unchanged; unused by first-party code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `datacenter`   | `datacenter`      | Routing domain of mutually routable site subnets. Unchanged. **`datacenter_name_format_check` dropped.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `server`       | `server`          | Enrolled host. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `monitor`      | `monitor`         | Per-server sealed ProxySQL backend monitor credential (`uniq_monitor_server`; `ON DELETE CASCADE` from `server`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `license`      | `license`         | One-shot registration key. Optional `tier_id` FK → `tier.id` (`ON DELETE RESTRICT`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tier`         | `tier`            | Platform-global billed offering (`generation` / `rank` / `label`). No `organization_id`. Rows are deactivated, never deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `command`      | `command`         | Typed command row (lifecycle columns, no payload). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dispatch`     | `dispatch`        | One-shot daemon execution payload for a `command` (deleted on success, ~24h retention on failure). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `network`      | `network`         | Org network registry (`datacenter` / `docker` / `compose` / `managed`). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `fabric`       | `fabric`          | Org TurboFabric mesh (0–1 per org; on when present). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ip`           | `ip`              | Canonical managed addresses (`public` / `datacenter`). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `relay`        | `relay`           | One server in the org TurboFabric mesh — `tp0` address, role, container prefix, advertised CIDRs, PSK. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `subnet`       | `subnet`          | Server-local Docker bridge for a `kind='compose'` spanning network. Was `segment`. SQL-adjacent — double-quote in raw `sql` tagged templates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `workspace`    | `workspace`       | Resource-tree root (`project.workspace_id` → `workspace.id`). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `project`      | `project`         | Docker Compose / catalog / managed project. Unchanged. **`project_name_format_check` dropped.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `environment`  | `environment`     | Staging/production/etc. within a project; optional `server_id` pin. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `managed`      | `managed`         | Environment-scoped managed engine cluster. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `replica`      | `replica`         | One server’s participation in a managed cluster (primary / replica). Was `node`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `leaf`         | `leaf`            | Organization-CA-signed managed leaf tracking (`ingress` / `engine`; upsert on re-issue). Engine unique is `uniq_leaf_engine_replica` on `replica_id`. Unchanged physical name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `recovery`     | `recovery`        | Managed HA journal (automatic failover / switchover / disaster recovery). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `variable`     | `variable`        | Scoped config/secret. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `service`      | `service`         | Deployable unit within an environment. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `deployment`   | `deployment`      | Current apply state per `(environment, server)`. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `slot`         | `slot`            | Scheduled replica instance of a logical service (0-based `slot` column). Was `task` (replica-slot meaning).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `label`        | `label`           | Server Docker-engine labels. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `hosting`      | `hosting`         | Public routing for a service. Unchanged. **`hosting_name_format_check` dropped.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `container`    | `container`       | Deployed Docker container pin. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `principal`    | `principal`       | Linux/system or managed-engine user. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `entitlement`  | `entitlement`     | Runtime series a principal may execute (one row = one unix group). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ssh`          | `sshKey`          | Public key that may authenticate as a principal. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tenancy`      | `tenancy`         | Linux/system principal that runs as / owns a service. Was `steward`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `binding`      | `binding`         | Managed-DB principal → compose service inject. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `secret`       | `secret`          | Sealed provider secrets (NFS/S3/rclone + Git deploy keys). Was `credential`. **`expires_at` dropped.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `storage`      | `storage`         | Logical dataset identity (volume / directory / file / object). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `copy`         | `storageCopy`     | One physical copy of a storage identity. Was `location`. SQL-adjacent — double-quote in raw `sql` tagged templates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `mount`        | `mount`           | Service attachment of a storage identity. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `forge`        | `forge`           | Registered GitHub App / GitLab OAuth application (`organization_id` NULL = instance-wide). Was `gitapp`. **`envelopes`** was `credentials`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `connection`   | `gitConnection`   | Git provider App installation granted to one org. Was `installation` (export `gitConnection`). **`forge_id`** FK → `forge`. **`provider`** kept as a denormalized filter column. **`external_installation_id`** is the provider-side id. No token columns — installation access tokens are minted on demand in `src/lib/git/github-app-token.ts`.                                                                                                                                                                                                                                                                                                                                                                              |
| `repository`   | `repository`      | Git repository connected to an organization — **one row per repo per org**, deduped by `UNIQUE (organization_id, repository_url)` over the canonicalized clone URL (`canonicalizeRepositoryUrl`: lower-cased host, `.git` suffix). Was `source`. No `service_id` / `environment_id` parent columns — attachment is `project.repository_id` plus compose `services.<name>.x-turbopanel.source.sourceId` references. **`connection_id`** SET NULL; optional `secret_id` SET NULL. Provider-observed facts (`detected_default_branch`, `default_branch_checked_at`, `last_inspected_at`, `last_inspected_commit_sha`) are real columns, refreshed by `POST /repositories/:id/refresh`. CRUD: `src/client/repositories/routes.ts`. |
| `delivery`     | `webhookDelivery` | Inbound provider-webhook delivery ledger — replay protection only. Org-agnostic on purpose: the delivery id arrives before the payload is matched to a connection. `provider` CHECK `github` / `gitlab` / `stripe` — not git-only; unique `(provider, external_delivery_id)`; `created_at` is the received time and the sweep cursor. Holds no payload and no secret. Claimed by `claimWebhookDelivery`, pruned after `WEBHOOK_DELIVERY_RETENTION_MS` (`src/lib/db/webhook-delivery-records.ts`).                                                                                                                                                                                                                                                                   |
| `payer`        | `payer`           | Billing projection — who pays. Polymorphic over its subject: `organization_id` **or** `user_id`, exactly one (`payer_subject_check`: `(organization_id IS NULL) <> (user_id IS NULL)`), so an in-app subscription tied to a person stays expressible without rewriting every FK that points at billing. Columns are `provider_*`, never `stripe_*` (`payer_provider_check`: `stripe` / `apple`). Unique `(provider, provider_customer_id)` is the webhook upsert target; partial uniques give one payer per provider per subject. Written only by `src/lib/db/billing-records.ts` from the Stripe webhook — **Stripe owns money, Postgres owns entitlement** (`src/lib/billing/AGENTS.md`). |
| `subscription` | `subscription`    | One provider subscription per `payer` (cascade). Unique `provider_subscription_id` is the upsert target. **No CHECK on `status`** — Stripe adds statuses, and a CHECK would turn a product change into a webhook that 500s; narrowed in code (`parseSubscriptionStatus`). `past_due_since` latches on the first delinquent status (`past_due` / `unpaid`) and `grace_expires_at` latches beside it as `past_due_since + BILLING_GRACE_WINDOW_MS` (cleared together on recovery); the grace clock (`src/lib/billing/grace-clock.ts`) cancels what is still delinquent after it. `schedule_id` is the provider schedule a deferred change (downgrade / seat release) is parked on; `null` when none. |
| `seat`         | `subscriptionItem` | One line of a subscription: `quantity` seats at one `tier`. Physical name `seat` because `subscription_item` breaks the one-word rule and a row *is* N seats at one tier (reads correctly beside `license`); the export keeps the provider's vocabulary. Unique `provider_item_id` (upsert target) **and** unique `(subscription_id, tier_id)` — the reconciliation invariant compares seats to licenses per tier, so two rows for one tier must be impossible. `tier_id` is `ON DELETE RESTRICT`. `provider_price_id` is the item's own price (what a mutation restates when it rewrites `items[]` or a schedule phase); nullable only so it could be added under existing rows. Projection is delete-then-insert per subscription (`replaceSubscriptionItems`), in that order, because a replaced item at the same tier would otherwise trip the per-tier unique. Items map to tiers by **product** (`item.price.product` → `tier.provider_product_id`); an item whose product maps to no tier is logged and skipped, never inserted with a null tier, and two items on one tier are summed under the first item's id. |
| `grant`        | `grant`           | Authz grant row. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session`      | `session`         | Opaque DB-backed user session. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `setting`      | `setting`         | Instance settings (`value` is `jsonb`). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `account`      | `account`         | Credential / (reserved) OAuth account. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `teammate`     | `teammate`        | User ↔ team; org membership is derived through `team.organization_id`. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `team`         | `team`            | Org team. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `user`         | `user`            | Instance user (email identity). Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `2fa`          | `twoFactor`       | Better Auth–compat two-factor table; digit-leading name exception. Unchanged; unused by first-party code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `verification` | `verification`    | Email / OTP verification tokens. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tag`          | `tag`             | Org-owned tag definition. App-enforced trim + case-insensitive uniqueness backed by `uniq_tag_organization_name`. SQL-adjacent — double-quote in raw `sql` tagged templates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `marker`       | `marker`          | Join edge: one tag on exactly one parent (`marker_exactly_one_parent_check`); seven partial uniques (`uniq_marker_server` … `uniq_marker_storage`). Org derived through `tag.organization_id`. No `metadata`/`options` pair (follows `tenancy` / `label`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `task`         | `task`            | Cron-style scheduled command on a service. `uniq_task_service_name`; `task_concurrency_policy_check` (`allow` \| `forbid` \| `replace`). No execution columns (`last_run_at` / result) and no run-history table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Better Auth:** do not reintroduce a physical `member` or `membership` table.
Org membership is `teammate` → `team.organization_id`. Platform authority stays
on `user.role` (`superadmin` / `admin` / `user`), separate from org grants.

**Retired names:** `vpn` / `peer` / `tlsleaf` / `tlsrotation` /
`principal_entitlement` / `principal_ssh_key` / `gitapp` / `installation` /
`source` / `steward` / `location` / `credential` / `node` / `segment` /
`rotation` are retired physical table names, guarded by `table-naming.test.ts`
(same reject list as `member` / `bridge` / `managed_member`). Do not reintroduce
them. Do **not** retire `task`: the replica-slot table is `slot`; `task` is the
cron scheduled-command table.

**Naming exceptions** (external compatibility only — listed in the guard test
and here):

| Name  | Why                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------- |
| `2fa` | Better Auth two-factor model; digit-leading name. Keep the exception documented when the table remains. |

## Resource hierarchy

**Legacy resource tree** (workspace → project → … → hosting/container):
organization scope is derived via parent FK joins — not stored on those child
rows (except `workspace`, which roots the tree with `organization_id`).

**Ownership vs placement:** ownership fields live only at the nearest canonical
parent and are otherwise derived by ancestry join. Do not denormalize
`organization_id`, `workspace.kind`, or similar ownership facts onto `project` /
`environment` / `service` / `container`. Fields that express a _different_ fact
may legitimately repeat a reference at multiple levels — e.g.
`environment.server_id` (desired placement) vs `container.server_id` (observed
placement) — and are not ownership duplication. **`storage`**, **`network`**,
**`ip`**, and **`datacenter`** carrying direct `organization_id` are an
intentional exception (org-owned registries) and must not be used as precedent
for adding `organization_id` / `is_system` (or any ownership column) to the
workspace → project → environment → service → container tree.

**Org-owned networking tables** (`datacenter`, `network`, `ip`) persist
**`organization_id` directly** on each row. Authz and domain logic for those
entities should use that column (alongside optional `datacenter_id` /
`server_id` / `network_id` links), not only join-derived ancestry from the
compose tree. Overlay `tp0` addresses live on **`relay.address`**, not in the
`ip` registry — the trade-off (fabric addresses no longer appear on the org
Addresses page) was deliberate, taken to drop `ip.vpn_id` / `ip.fabric_id` and
three constraints per mesh member.

Canonical ancestry order and the dense per-resource detail (semantics of every
table in the tree, storage model, principals, managed runtimes, …) live in
[`resource-hierarchy.md`](./resource-hierarchy.md).

## Resource naming contract

Generated names and principal paths live in **`src/lib/naming.ts`** — the single
source of truth for container names (`containerNameFromService` /
`managedContainerName` / `ingressContainerNameFromService` → `<service.id>-in`
for per-service Traefik **and** shared ProxySQL `managed-ingress` — suffix
contract in the repo-root `AGENTS.md` → **Container name suffix contract**; all
keyed off the **service** UUID, not the container row), Docker volume names
(`dockerVolumeNameFromStorageId` / `resolveDockerVolumeName` / legacy-only
`legacyNamespacedDockerVolumeName`), principal home/SSH/volume paths under
`/srv/users/<username>` (keyed on the operator-chosen username, not the
principal UUID), the reserved-only DNS shape (`serviceDnsName`), and the
reserved `TURBOPANEL_*` deploy variable keys (`RESERVED_DEPLOY_VARIABLE_KEYS`).
Option parsers (`project-options.ts` `containerNaming`, `service-options.ts`
`instances`, `principal-options.ts` `shell` + optional `uid`/`gid` override)
feed those helpers; deploy-prepare owns allocation (`uuid` mode ignores authored
compose `container_name`; `custom` still reads them), multi-instance expansion,
compose-volume registration, and compose emission via `apply-service-options.ts`
(sole writer of allocated `container_name` values).

Native Postgres **`inet`** and **`cidr`** columns are defined in `net-types.ts`
via Drizzle `customType` — no regex CHECK constraints belong on those types.

**Names** (`name` column, API `name`) on organization, workspace, project,
environment, service, hosting, datacenter, network, fabric, tls, team, managed,
server, license, storage, and secret are labels, not identifiers. Dropped
charset CHECKs (they contradicted app-side `display-name-format.ts`):
`hosting_name_format_check`, `datacenter_name_format_check`,
`project_name_format_check`. Every other name-format CHECK remains:
`tls_name_format_check`, `workspace_name_format_check`,
`environment_name_format_check`, `service_name_format_check`,
`network_name_format_check`, `fabric_name_format_check`,
`team_name_format_check`, `managed_name_format_check`, `user_name_format_check`,
and `binding_database_name_format_check`. The preferred app-side rule for labels
(and the rule that replaces the dropped CHECKs) is
`src/lib/display-name-format.ts` (`normalizeDisplayName` + `isValidDisplayName`)
— trim, Unicode NFC, apostrophe-fold, no control characters, and a code-point
length cap (`DISPLAY_NAME_MAX_LENGTH` / `DESCRIPTION_MAX_LENGTH`, currently
255). Changing the cap is a code change, not a migration. The same length-only
rule applies to `description` columns and Docker **label values**
(`label.value`; the **key** CHECK stays). Typographic apostrophes still fold to
ASCII `'` so iOS/macOS input matches uniqueness compares.

**Identifiers vs labels.** Identifier charsets stay strict (interpolated into
SQL / Docker / Traefik / shell). Do not relax these:

| Guard                                                                   | Where                                                                                                      | Why it stays                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `service.compose_service_name`                                          | `isValidComposeServiceName` in `src/lib/commands/schemas.ts`                                               | Compose YAML key + `-p` project scoping               |
| `principal_username_format_check`                                       | schema + `src/client/principals/store.ts`                                                                  | `useradd` / SQL `CREATE ROLE`                         |
| `variable_key_format_check`                                             | schema                                                                                                     | Shell env-var name                                    |
| `binding_key_prefix_format_check`, `binding_database_name_format_check` | schema                                                                                                     | SQL identifier / env prefix                           |
| `label_key_format_check`                                                | schema, `ui/src/lib/server-labels.ts`                                                                      | Docker engine label key → `node.labels.*` constraints |
| Hostnames                                                               | `turbopaneld` `src/instance/commands/hostname.ts`, `src/deploy/compose-labels.ts`, `src/deploy/ingress.ts` | Traefik router rules, DNS                             |
| `DEPLOY_INGRESS_COMPOSE_NAME_RE` / `CONTAINER_NAME_RE`                  | `turbopaneld` `src/instance/commands/contracts.ts`, `src/deploy/ingress-identity.ts`                       | Docker CLI args, on-disk file ids                     |

The daemon never receives display labels on a path that interpolates them.

**Project cascade delete** (`deleteProjectCascade` in `project-delete.ts`):
after all tenant `role='service'` containers under the project are non-active
(`exited`/`dead`/`removing`), `DELETE /projects/:id` runs
`applyStorageRetentionOnParentDelete` (clear `mount`s first — `service_id` is
RESTRICT — then drop `retention='delete'` storage; `retain` rows stay org-owned
via SET NULL), then deletes in order `container` → `hosting` → `tenancy` →
`binding` → `service` → `environment` → `project` (variables/`managed` /
`principal` cascade via FK). `tenancy.service_id` and `binding.service_id` are
RESTRICT (a direct service delete must not leave a dangling run-as or inject
edge), so the project cascade drops those rows first. Active **service**
containers return **409** `project_has_running_services` — stop stacks first via
`environment.stop`. Running `ingress` / `turbopanel` rows (ProxySQL, per-service
Traefik, Orchestrator) do not gate delete; their lifecycle is server-scoped
(destroy fan-out + orphan sweep). The cascade itself is Postgres-only; the route
wraps it with `planEnvironmentsTeardown` / `reclaimDeletedEnvironmentHosts`
(`client/environments/teardown.ts`) so the host's deployment dir, hosting Caddy
site, per-service tcp/udp Traefik and `tpn_*` bridges are reclaimed even when
the environment was stopped with `environment.lifecycle` (which leaves them in
place) rather than `environment.stop`. Restrictive FKs stay in place as a safety
net. Workspace / environment / service delete paths use the same retention
helper.

Authorization ancestry and `listVisible()` resolve organization through this
chain in SQL (`evaluator.ts`, `create-access-grant.ts`). **`variable`** and
**`managed`** are in `RESOURCE_KINDS`, `GRANT_ENTITY_TYPES`, and `ENTITY_TYPES`
(`catalog.ts`); `resolveEntityById()` and `can()` resolve their org via parent
joins (same paths as `create-access-grant.ts`) — **`managed`** ancestry resolves
via `environment → project → workspace`. **`principal`** is in `RESOURCE_KINDS`
and `ENTITY_TYPES` but **not** `GRANT_ENTITY_TYPES` — org is derived via
`tenancy → service → environment → project → workspace` (returns null when
unassigned); `tenancy` itself is not a grantable authz entity.

**Where `principal` / `tenancy` rows come from at deploy time.** A compose
document names an account by **alias** — a document-local key under the root
`x-turbopanel.principals` — never by Linux username, because everything that
decides what the account _is_ on a host (uid, gid, home, shell, keys, password)
is a privilege decision gated by `organization:manage` on the `principal` row.
`reconcilePrincipalsFromCompose` (`../../client/principals/tenancies.ts`) runs
inside deploy-prepare and turns each declared alias into a `principal` row plus
the `tenancy` edge that says which `service` runs as it. The alias →
`principal.id` map it returns is carried through the compiler as
**`ResolvedApplication.principals[]`** (`{ logicalAlias, principalId }`) — see
the four-model IR in `../compose/AGENTS.md` and `../compose/ir.ts`. That mapping
is the _only_ bridge between the document's aliases and these rows: nothing
downstream re-derives an account from a compose key, and a service whose alias
never became a row is refused (`principal_alias_unknown`) rather than run as
nobody. **`GET /access/check`** accepts any resolvable entity UUID (including
`variable` and `managed`). **`GET /access/resource-id`** accepts only
`organization` and `team` kinds (grant-management UI). Access grants still
target org/team entities only.

> Permissions are **static code constants** defined in
> `../../client/authz/catalog.ts` (`PERMISSIONS`, `ENTITY_TYPES`,
> `SUBJECT_TYPES`) — not DB rows. There are no `role`, `permission`, or `permit`
> tables. The Drizzle table export is **`grant`** (not `accessGrant`).

Drizzle relations are defined for future Better Auth adapter use.
`IS_SIGNUP_ENABLED_CONFIG_KEY` is the `setting.key` for self-service signup.
`setting.value` is `jsonb`. The `SYSTEM_EMAIL` key stores all email settings as
a single JSON object (self-hosted mode only; env vars take precedence and leave
this table empty).

**Organizations:** a user is in an org iff they are a `teammate` of any `team`
in that org. Org owner/manager roles come from `grant` (`organization:own` /
`organization:manage`) on the user or a team — not from binding users directly
to organizations. `user.role` (`superadmin` / `admin` / `user`) is instance
authority, separate from org access. **`invitation.grants`** (JSONB) stores the
intended access grants (`InvitationGrantSpec[]` in
`src/client/authn/invitation-grants.ts`); they are materialized into `grant`
rows on accept. When `grants` is null, accept applies a default
`organization:manage` grant on the org. **`organization.options.maxServers`**
caps enrolled servers + unconsumed registration keys (`null`/omitted =
unlimited). Self-hosted operators set it via
`GET`/`PUT /organizations/:id/server-capacity`; `POST /licenses` returns **409**
`server_capacity_exceeded` when the org is at capacity. Workers/Stripe billing
will write the same field later.

**Host defaults cascade** (no schema migration — stored in existing `options`
jsonb): organization → datacenter → server, most specific wins. SSH (`sshPort`,
1–65535) falls back to **22**. Desired NTP (`ntp`: `enabled` / `servers` /
`fallbackServers`) is separate from daemon-reported `timeSync` columns.
`defaultFabricEnabled` is organization-only and never enables the mesh by itself
(`PUT …/fabric` remains the enable path). Timezone keeps its enforce/override
resolver — do not treat org/DC timezone as a soft default. `null` on PUT/PATCH
clears that layer so the parent inherits. Canonical parsers/resolvers:
`src/lib/host-defaults.ts`.

**Uniqueness:** `teammate(team_id, user_id)` prevents duplicate team membership
rows on concurrent invite acceptance/retries.

**Install (Deno):** A fresh DB has no org or superadmin.
`src/client/authn/install-state.ts` `isInstanceInstalled()` is false until
`completeInstanceInstall` creates org → **TurboPanel workspace
(`kind='turbopanel'`)** → team → superadmin → grants → **Default Workspace**
(`kind='user'`) → colocated license. **"TurboPanel"** is therefore a reserved
workspace name from first boot (**409** `workspace_name_in_use`).
**`organization.slug`** stays **NULL** (reserved for a future feature). Org
extras (e.g. logo URL) belong in **`organization.metadata`** — there is no
`logo` column. Install sets **`email`** and **`role`** (on `user`) only —
optional user `name` stays **NULL** until the user chooses it. The Postgres
column is `name` while the client JSON field is `name`.

**Install sentinel invariant:** `completeInstanceInstall` is race-safe. The very
first write inside its transaction is a **unique install sentinel** — a
`setting` row with `key = INSTANCE_INSTALL_SENTINEL_KEY`
(`'INSTANCE_INSTALL_SENTINEL'`), inserted with
`ON CONFLICT (key) DO NOTHING ... RETURNING`. Concurrent install transactions
block on the `setting_key_unique` constraint until the first commits, then
observe the conflict (no returned row) and abort with
`INSTANCE_ALREADY_CONFIGURED_ERROR`. After acquiring the sentinel the
transaction re-checks `isInstanceInstalled(tx)` (guards pre-sentinel installs
where org+superadmin already exist) and then performs every root setup insert
(org, **TurboPanel workspace**, team, superadmin user + credential account,
teammate, grants, Default Workspace, colocated license) in the same transaction.
This reuses the existing `setting` table (no schema migration) — only one
superadmin/organization bootstrap can ever be created, even under concurrent
requests across isolates.

## Client API (authz integration)

The client REST endpoint inventory — access/permission endpoints and the full
resource-tree CRUD table with per-route permission contracts — moved to
`../../client/AGENTS.md`. The rules in short: list/get enforce visibility via
`listVisible` / org-level grant checks **in SQL** (never client-side);
create/update/delete require `organization:own` or `organization:manage` on the
entity's org via `can()`; create/delete run entity insert/delete in a single
transaction.

## Catalog

Permissions are **static code constants** in `../../client/authz/catalog.ts` —
there is nothing to seed. Seven permissions exist: `organization:own`,
`organization:manage`, `team:own`, `team:manage`, `system:read`,
`system:operate`, and `system:manage`. `system:manage` is **not grantable**
(superadmin-only). Never edit permissions in Studio — they do not exist as DB
rows. **`ENTITY_TYPES`** and **`SUBJECT_TYPES`** (`user`, `team`,
`organization`) are also exported from `catalog.ts` for route/body validation
(`isEntityType`, `isSubjectType`). Organization-wide subject grants apply to
every teammate of a team in that organization.

## `tier` table

Platform-global billed offerings: a ladder label bound to a payment-provider
**product**. Everything a tier *entitles* lives in code —
`src/lib/tiers/ladder.ts`, keyed by `label` (cores / RAM ceilings, NIC /
drive / GPU / filesystem slots, list price) — so the row holds only what the
code cannot know: which provider product the label bills against, plus a
cached display price. There is no `organization_id` — every org sees the
same catalogue. Rows are chosen from the provider's product list under
Admin → Tiers and verified before they are written; nothing seeds them.

| Column                | Notes                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`               | `"S1"`…`"S7"`, `"SX"` — the key into the ladder. Unique (`uniq_tier_label`).                                                                             |
| `rank`                | Copied from the ladder on insert, never from a request. Unique (`uniq_tier_rank`): rank orders tiers, decides upgrade-versus-downgrade direction and the greedy assignment. |
| `provider`            | `stripe` today, `apple` reserved — `tier_provider_check` matches `payer_provider_check`.                                                                 |
| `provider_product_id` | The provider's Product. **Null** on the custom / SX row, which is therefore never purchasable. Unique with `provider` where not null (`uniq_tier_provider_product`): the projection's product→tier map is keyed on it. |
| `price_cents`         | Display cache of the product's default price, written on verify and refreshed by the provider's `product.updated` / `price.updated` webhooks. Nothing does arithmetic on it. |
| `currency`            | Display cache beside `price_cents`; lower-case ISO code.                                                                                                 |
| `is_custom`           | Copied from the ladder (true for SX).                                                                                                                    |
| `is_active`           | Tiers are deactivated, never deleted — `is_active = false` hides a row from new purchases without breaking the seats that count against it.             |

No `metadata` / `options` pair. `seat.tier_id` and `server.assigned_tier_id`
reference it (`RESTRICT` and `SET NULL` respectively). A re-price is a new
default price on the product in the provider's Dashboard; no row changes.

## `license` table

Organization-scoped API tokens for server registration. Each row belongs to an
`organization` (`organization_id`, cascade delete). `name` is optional. `token`
stores an Argon2id PHC hash in the same `$argon2id$…` format as
`account.password`. Soft-delete via `revoked_at` — revoked licenses remain in
the table for audit; application code should treat non-null `revoked_at` as
inactive.

**One-shot latch:** `license.server_id` (nullable FK → `server.id`,
`ON DELETE SET NULL`) is set on first successful enroll. Partial unique index
`uniq_license_server_id` on `license(server_id) WHERE server_id IS NOT NULL`
enforces one license per server. Unconsumed seats have `server_id IS NULL`.
Revoked rows may keep `server_id` until the server is deleted (SET NULL).

**No tier on a license.** A license is the key that ties one server to
this instance and nothing more. Which purchased tier the server sits on is
derived per organization (`server.assigned_tier_id`, below), so a mint never
names a tier: on hosted, `POST /licenses` is gated only on
`purchased − releasing − held > 0` (`summarizeLicenses` in
`src/client/billing/routes-helpers.ts`, read under the quantity lease), and a
revoke never calls the provider — what was bought stays bought until the
billing page reduces it. The one case billing revokes licenses is an ended
subscription (`revokeAllLicensesForOrganization`, bound ones included).

**Colocated control-plane license:** install and Deno boot recovery mint a
license with `name = 'this server'` (`COLOCATED_SERVER_DISPLAY_NAME`).
`POST /api/client/v1/licenses` rejects that reserved display name so user-minted
registration keys cannot collide. Uniqueness of active colocated seats is
application-level (disk rotate revokes then mints one) — there is no
display-name unique index.

**Colocated license credentials on disk:** plaintext tokens are written once at
install to `/var/lib/turbopanel/license.id` + `license.token` (+ `server.id` for
the pre-provisioned colocated seat) via `TURBOPANEL_DAEMON_STATE_DIR` /
`TURBOPANEL_STATE_DIR` and are unrecoverable from the DB hash. Missing files
after install are fail-fast — Deno boot does **not** silently rotate/recreate
seats. Operator recovery uses `rotateColocatedLicenseCredentials` +
`persistColocatedLicenseCredentials` deliberately (in-place token rotate when an
active bound `this server` seat latches a server; otherwise revoke unbound
seats, mint one, optionally rebind). Never appends a second active orphan
silently.

## `server` table

Each physical server node gets a row in `server` (`id` uuidv7). On daemon
connect the instance resolves `serverId` (reuse by persisted id, `machine_key`,
or `hostname` columns), tracks presence in the **Daemon Cell**, and returns
`serverId` in enrollment responses. The daemon persists it at
`/var/lib/turbopanel/daemon/state/server.id` (production: owned by **`tp:tp`**;
co-located dev: dev-user-owned under the same FHS path). See the canonical
[Production UID/GID allocation](../../../AGENTS.md#production-uidgid-allocation)
table in the repo root `AGENTS.md`. Server rows are hard-deleted — there is no
soft-delete column. `name` and `organization_id` match the old trunk shape;
daemon registration stores `machine_key` / `hostname` on dedicated columns (not
in `metadata` — see `server-metadata.ts`). Which registration key enrolled the
server is on `license.server_id` (not a column on `server`). `organization_id`
FK uses `ON DELETE RESTRICT` — Postgres blocks deleting an organization that
still has referencing server rows. `network.server_id` → `server.id` is
`ON DELETE RESTRICT` — server deletion is blocked while network rows exist.
Deleting a server clears `license.server_id` via `ON DELETE SET NULL`; the app
soft-revokes the bound license after delete.

**`machine_key`** (`text`, nullable) is a deterministic HMAC-SHA256 digest of
the host machine-id (`src/lib/machine-key.ts` → `deriveMachineKey`) — never the
raw machine-id, and not a sealed secret (it is non-reversible and safe to
index/equality-match). It is echoed into signed enroll/auth payloads and used
for reconnect/reuse matching alongside `hostname`.

Canonical column order: `id`, `created_at`, `updated_at`, `metadata`, `options`,
`organization_id`, `name`, `hostname`, `machine_key`, `os_id`, `os_family`,
`os_version`, `os_codename`, `os_pretty_name`, `os_architecture`, `timezone`,
`is_time_sync_enabled`, `ntp_servers`, `ntp_last_synced_at`, `is_connected`,
`status_changed_at`, `daemon` (shared `metadata`/`options` pair immediately
after timestamps — remaining columns follow). **No `datacenter_id`** —
membership is via `ip` pins only. Indexes: `idx_server_organization_id`,
`idx_server_machine_key`, `idx_server_hostname`, and partial
`idx_server_connected` on `(id) WHERE is_connected`. There is no `daemon_status`
column or CHECK constraint — liveness is a single boolean plus a transition
timestamp (see "Fleet status columns" below). `organization_id` FK uses
`ON DELETE RESTRICT`. `network.server_id` → `server.id` is `ON DELETE RESTRICT`
— server deletion is blocked while network rows reference it (same for
`ip.server_id` and `relay.server_id`). Deleting a server clears
`license.server_id` via `ON DELETE SET NULL`; the app soft-revokes the bound
license after delete.

**Derived tier:** `server.assigned_tier_id` (nullable FK → `tier.id`,
`ON DELETE SET NULL`, `idx_server_assigned_tier_id`) is the tier this server
sits on — **computed, never chosen**. `src/lib/tiers/assignment.ts` takes
the organization's committed `seat` quantities and its licensed servers in
bind order (`created_at`), gives each the smallest purchased tier whose rank
covers its hardware requirement (`tier-placement`; unknown hardware needs the
entry rank), and leaves the newest uncovered when nothing fits.
`assignment-records.ts` writes the column after every seat projection and
mutation, after the self-hosted grant is synced, on every hardware report
(`touchServerMetadata`), on enroll, on server delete and on license revoke.
Ingest, the capability plan, placement and the notice sweep read this column;
nothing on those paths recomputes. Null on an unlicensed server and on a
licensed server nothing entitled covers — the daemon's next session is then
refused with `License tier below required`. Self-hosted is entitled by the
SX grant (`self-hosted-grant.ts`), so the column is populated there too.

**Cell metadata fields** (stored in `server.metadata` and/or `server.options`
JSONB):

| Field              | Column                                                | Purpose                                                             |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------- |
| `cellLocationHint` | `options` (preferred) or `metadata.cell.locationHint` | Cloudflare Durable Object `locationHint` chosen at enrollment time. |

`options` takes precedence over `metadata` when both define a value (see
`src/daemon/cell/location.ts`). Residual `metadata` holds nested `resources`
(cpu / memory / swap **and** `ips`), `geo`, `docker`, and `cell` — not hostname
/ machineKey / OS / observed timezone / NTP (those are dedicated columns).
Leftover `os` / `timeSync` / top-level `ips` keys may still exist in old jsonb
and are read as fallbacks only.

**Host OS columns:** `os_id`, `os_family`, `os_version`, `os_codename`,
`os_pretty_name`, `os_architecture`. Raspberry Pi OS 64-bit (`ID=debian` +
`/etc/rpi-issue`) is stored as `os_id = raspberry-pi-os`. The API still composes
a nested `os` object (with `variant: raspberry-pi-os` when that id is set).

**Host time-sync columns:** `timezone` is the **daemon-reported** IANA zone
(operator override stays on `server.options.timezone`). `is_time_sync_enabled`
is the NTP client enabled flag. `ntp_servers` is a jsonb array of
`{ host, fallback? }` (Debian often has empty `NTP=` and real servers on
`FallbackNTP=`). `ntp_last_synced_at` is the last successful sync; it is
**never** rewritten to `now()` on every heartbeat — only when the daemon reports
a stamp, the host becomes unsynced (`null`), or the first synced observation
arrives while the column is still null.

**Daemon identity (`server.daemon` jsonb):** sparse `{ key, projection? }` only.
Fleet liveness lives on dedicated columns (below). No separate `serverkey` table
exists for MVP.

```json
{
  "key": {
    "id": "uuid",
    "algorithm": "Ed25519",
    "publicJwk": {},
    "fingerprint": "sha256-public-jwk-fingerprint",
    "createdAt": "iso timestamp",
    "revokedAt": "iso timestamp or null"
  },
  "projection": {
    "hostname": "host.example",
    "machineKey": "hmac-derived-machine-key",
    "remoteAddress": "203.0.113.1",
    "keyId": "uuid",
    "daemonBuild": {
      "commit": "abc",
      "buildId": "build-1",
      "builtAt": "iso",
      "channel": "trunk"
    }
  }
}
```

| Field             | Purpose                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `key.id`          | Logical key identifier returned to the daemon as `keyId` on enrollment                                        |
| `key.publicJwk`   | Raw Ed25519 public JWK `{ crv, kty, x }`                                                                      |
| `key.fingerprint` | SHA-256 hex over the canonical public JWK — duplicate-checked at enrollment (no DB unique constraint for MVP) |
| `key.revokedAt`   | Non-null blocks new JWT issuance; existing JWTs remain valid until their 15-minute expiry                     |

**`server.daemon.projection` (sparse identity summary):** optional `hostname` /
`machineKey` (also mirrored onto dedicated columns), `remoteAddress`, `keyId`,
optional `daemonBuild` (`commit`/`buildId`/`builtAt`/`channel`), optional
`update`. Updated on identity changes and daemon build identity changes (via
`control-plane-monitor.ts` outside the DO hot path on Workers). No monitor
health counts or resource graph are stored. Projection is not path-queried for
reconnect dedup — use `hostname` / `machine_key` columns.

**Fleet status columns (liveness projection):** just two columns —
`is_connected` (`boolean NOT NULL DEFAULT false`) and `status_changed_at` (last
`is_connected` flip, set on every online **and** offline transition). There is
no `daemon_status`, `last_seen_at`, `connected_at`, or `disconnected_at` column;
the old tri-state `online|offline|unknown` and the separate timestamp columns
were collapsed into this pair. `connectedAt` is **derived**, not stored:
`src/daemon/cell/server-status.ts` returns `statusChangedAt` as `connectedAt`
only while `is_connected` is true (otherwise `null`), and treats `!is_connected`
as offline-since-`statusChangedAt`. Written by `postgres-projection.ts` only on
connect/disconnect transitions and on meaningful heartbeats (daemon
build-identity change, or new `timeSync` / `resources.ips` / `docker` facts) —
never on a bare elapsed-time debounce (there is no periodic "touch
`last_seen_at` every N seconds" write path anymore). Identity columns `hostname`
/ `machine_key` are written on enroll/hello/identity projection.

**Status read model:** the two status columns above are the Postgres-projected
liveness read model. UI and API status reads go through
`src/daemon/cell/server-status.ts` (`resolveFleetPresence`) for coarse presence,
plus `src/client/servers/update-status.ts` (`loadServerStatusRecords` /
`buildServerStatusRecord`) for the `ServerStatusRecord` DTO shape (`serverId`,
`connected`, `daemonStatus`, `connectedAt`, `statusChangedAt`, `hostname`,
`remoteAddress`, `geo`, `colocatedWithInstance`). Do not read status columns
directly from routes. The tri-state `daemonStatus` (`online` \| `offline` \|
`unknown`) still exists as an **API-layer derived value** —
`src/daemon/authn/daemon-state.ts` (`mapServerDaemonStatusFromColumns`) computes
it from the `is_connected` + `status_changed_at` columns at read time (`unknown`
only when `statusChangedAt` is null, i.e. the server has never transitioned) —
it is never stored as a column or CHECK constraint. The `/servers/status` and
`/servers/:id/status` endpoints serve this read model; reads are Postgres-only
and do not call the DO/Redis cell by default; both runtimes share the same
response shape. A separate, independent **status event history** in Analytics
Engine/DuckDB (`src/daemon/metrics/AGENTS.md`) exists for historical
uptime/downtime charts — it is history-only and never authoritative for current
liveness. See `src/daemon/cell/AGENTS.md` for cost/parity rules.

**Key use tracking:** `server.daemon.key.lastUsedAt` is updated on JWT session
issuance via `touchDaemonKeyLastUsed()` (Postgres only — no cell wake).
`lastInboundAt` remains cell-only (Redis/DO snapshot), coalesced on connect and
inbound WS activity.

The `key` field is always preserved on write (read-modify-write via
`parseServerDaemonState` + merge). Status is never written into `server.daemon`
jsonb.

Re-enrollment with a valid license token replaces `server.daemon` atomically
(and resets status columns). No historical key rows are kept for MVP. To revoke
daemon auth, set `server.daemon.key.revokedAt` (via `revokeDaemonKey` helper).

## `command` table

Canonical command/job history — source of truth for UI status and history. Do
not read command history from the Daemon Cell — the cell holds only hot
pending-request correlation state. The `command` table is the canonical record.

| Column                | Type                            | Notes                                                                           |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `id`                  | uuid (uuidv7)                   | Primary key                                                                     |
| `created_at`          | timestamptz(3) NOT NULL `now()` | Real column; index/order source                                                 |
| `updated_at`          | timestamptz(3) NOT NULL `now()` | Bumped by `transitionCommand`                                                   |
| `metadata`            | jsonb nullable                  | Follow-up-chain blob only (`getCommandMetadata`)                                |
| `options`             | jsonb nullable                  | Reserved (pair with `metadata`; unused today)                                   |
| `server_id`           | uuid NOT NULL                   | FK → `server.id`, `ON DELETE CASCADE` (org derived from server)                 |
| `actor_type`          | text NOT NULL                   | Open set — e.g. `'user'`; no FK                                                 |
| `actor_id`            | uuid NOT NULL                   | ID of the acting entity; no FK                                                  |
| `name`                | text NOT NULL                   | Command type (e.g. `daemon.ping`)                                               |
| `status`              | text NOT NULL `'queued'`        | See status values                                                               |
| `attempts`            | integer NOT NULL `0`            | Dispatch retry count                                                            |
| `context`             | jsonb nullable                  | Small non-secret identifier bag (`managedId`, `environmentId`, `generation`, …) |
| `result_summary`      | jsonb nullable                  | Typed command output (small, bounded)                                           |
| `error_code`          | text nullable                   | Machine-readable terminal error code                                            |
| `error_message`       | text nullable                   | Terminal error message                                                          |
| `queued_at`           | timestamptz(3) nullable         | Set when status → `queued`                                                      |
| `dispatch_started_at` | timestamptz(3) nullable         | Set when status → `dispatching`                                                 |
| `sent_at`             | timestamptz(3) nullable         | Set when status → `sent`                                                        |
| `acked_at`            | timestamptz(3) nullable         | Set when status → `acked`                                                       |
| `started_at`          | timestamptz(3) nullable         | Set when status → `running`                                                     |
| `finished_at`         | timestamptz(3) nullable         | Set when status → terminal                                                      |
| `expires_at`          | timestamptz(3) nullable         | Optional command TTL                                                            |

There is **no `payload` column on `command`** — the daemon execution payload
lives in the `dispatch` side table (below) and is deleted shortly after the
command reaches a terminal state, so the permanent history row is secret-free.

**JSONB usage:** `context` stores allowlisted identifiers only (extracted by
`src/lib/commands/context.ts` — never secrets, compose YAML, credential
envelopes, or TLS material); `result_summary` stores typed command output.
`metadata` is now only the follow-up-chain blob (`pendingStandbyApplies`,
`managedDestroyGate`, `followUpPromote`, `pendingTlsLeaf`, `desiredHash`, …)
read through `getCommandMetadata`. It is also where a fan-out takes a one-shot
claim: `claimCommandMetadataFlag` merges a key with a conditional UPDATE, so
sibling commands finishing at once elect exactly one follow-up enqueuer.
**`options` is unused today** and is kept solely for the schema
`metadata`/`options` pairing rule (see `schema-cutover-ledger.md` Step 3).
**Never store logs, streaming output, or large blobs in these columns.**

**Status values:**

| Status        | Meaning                                     |
| ------------- | ------------------------------------------- |
| `queued`      | Accepted by API; waiting for queue consumer |
| `dispatching` | Consumer picked up the job                  |
| `sent`        | Enqueued to daemon cell outbox              |
| `acked`       | Daemon acknowledged receipt                 |
| `running`     | Daemon executing                            |
| `succeeded`   | Completed successfully (terminal)           |
| `failed`      | Completed with error (terminal)             |
| `timed_out`   | Expired without completion (terminal)       |
| `cancelled`   | Cancelled before completion (terminal)      |

**Indexes:**

- `idx_command_server_id_created_at` — btree on `(server_id, created_at DESC)` —
  backs `listServerCommands` ordering
- `idx_command_status` — btree on `status` — supports status-filtered queries

Only FK is `server_id → server.id` (`ON DELETE CASCADE`). Organization is
derived from the server — no `organization_id` column on `command`.

**Lifecycle timestamps are real columns.** `status`, `created_at`, `updated_at`,
`attempts`, `name`, `result_summary`, every granular timestamp
(`queued_at`…`finished_at`, `expires_at`) and both error fields (`error_code` /
`error_message`) are physical columns — `transitionCommand` `.set()`s them
directly; nothing merges into `metadata` any more. `serializeCommandRecord` in
`command-records.ts` maps those columns onto the stable `CommandRecord` type
(`result` ← `result_summary`, `error` ← `error_message`) and normalizes
postgres.js timestamptz strings (`YYYY-MM-DD
HH:mm:ss+00`) to ISO-8601; it never
exposes a dispatch payload.

Server delete cascades to command rows (`ON DELETE CASCADE` on `server_id`).

## `dispatch` table

One-shot daemon execution payload for a `command` — the only place
secret-bearing command input is stored.

| Column       | Type                            | Notes                                                       |
| ------------ | ------------------------------- | ----------------------------------------------------------- |
| `command_id` | uuid PK                         | FK → `command.id`, `ON DELETE CASCADE`                      |
| `created_at` | timestamptz(3) NOT NULL `now()` | Written with the command row                                |
| `payload`    | jsonb NOT NULL                  | Typed daemon command input (small, bounded)                 |
| `expires_at` | timestamptz(3) nullable         | Failure-retention deadline; `NULL` until a terminal failure |

**Lifecycle / cleanup ownership:**

1. `createCommandRecord` inserts the `command` row and its `dispatch` row in
   **one transaction** — a command never exists without its payload.
2. The consumer reads it **once**, via `getCommandDispatchPayload`, right before
   building the daemon dispatch envelope, and keeps it in memory for the rest of
   that processing attempt. A missing payload fails the command
   (`dispatch_payload_missing`) instead of dispatching an empty envelope.
3. `transitionCommand` finalizes it on **any** terminal transition (consumer
   outcome, enqueue failure, expiry): `succeeded` deletes the row immediately;
   `failed` / `timed_out` / `cancelled` stamp
   `expires_at =
   now + COMMAND_DISPATCH_FAILURE_RETENTION_MS` (24h) for
   debugging. Cleanup is best effort and never fails the transition.
4. Expired rows are removed by `sweepExpiredCommandDispatch` on the **shared
   maintenance tick** — the Workers offline-sweep cron (reusing that cron's
   already-open Hyperdrive db) and the Deno `DAEMON_CELL_MAINTAIN_MS` timer.
   Bounded per tick (`COMMAND_DISPATCH_SWEEP_LIMIT`); no new independent timer,
   no second db client.

Index: `idx_dispatch_expires_at` (btree on `expires_at`) backs the sweep. Like
`command`, there is no `organization_id` — ancestry is `command → server`.
Server delete cascades through `command` to `dispatch`.

**Execution logs are not in Postgres.** Command transcripts (daemon
stdout/stderr) live only in the execution-log store — R2 on Workers, filesystem
or S3 on Deno. There is no transcript table, no transcript column, and no
`has_log` flag: the batched status route resolves `hasLog` by asking the store
(`ExecutionLogStore.exists`) under the existing 100-id batch cap. Do not add a
column to cache it. See `src/lib/execution-logs/AGENTS.md`.

## Layout

| File                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`                               | Drizzle table definitions — sync with dev DB via `dev/scripts/introspect.sh` or `dev/scripts/sync.sh`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `deployment-records.ts`                   | Deployment target helpers (`upsertDeploymentTargets`, apply/fail transitions, prune draining)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `deployment-history.ts`                   | Environment deploy **history** reads from `command` (`listEnvironmentDeploymentHistory`, `getEnvironmentDeploymentDetail`) — `deployment` holds current state only. The list is keyset-paginated; the detail's same-generation fan-out is deliberately **unpaginated** so every participating host is enumerable. Replica counts (`replicaCounts` / `totalReplicas`) are historical, read from each attempt's `command.context`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `slot-records.ts`                         | Scheduled-instance helpers for the **`slot`** table (file name unchanged until phase 2; `replaceEnvironmentSlots` sticky re-plan, list by environment/server); persists nullable `slot.address` so spanning `ipv4_address` / `extra_hosts` stay stable across re-plans                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `task-records.ts`                         | Cron-style scheduled-command helpers (`listTasksForService` / `listTasksForServices`, `createTask` / `updateTask` / `deleteTask`, `parseTaskNameInput`, `isTaskUniqueViolation`). Configuration only — nothing is enqueued.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `repository-records.ts`                   | Git **`repository`** helpers (file name unchanged until a later phase; table was `source`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `label-records.ts`                        | Server label helpers (`parseServerLabelInput`, `setServerLabels` replace-all, fleet `listServerLabelsForServers`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `fabric-records.ts`                       | TurboFabric helpers (`enableOrganizationFabric` / `disableOrganizationFabric`, `ensureFabricRelays`, `loadFabricReconcileSnapshot` + `buildFabricReconcilePayloadFromSnapshot` / `buildFabricReconcilePayload`, `stampRelayPublicKey`, `materializeSpanningNetworks`, compose-network reclaim: `listEnvironmentComposeNetworks` / `purgeEnvironmentComposeNetworks` / `purgeEnvironmentsComposeNetworks` / `purgeComposeNetworksCreatedAfter` / `releaseSubnetsForServer` — `network.environment_id` has no FK). One snapshot per fabric apply loads relays, endpoint caches, PSK envelopes, subnets, datacenter memberships, and address-family preferences once. Pair PSKs are canonical: both peer stanzas use the envelope owned by the lexicographically smaller relay id (`selectPairPresharedEnvelope`). Derived gateway advertised CIDRs are owned among **public-keyed** relays only (the same set `buildReconcilePeerLists` emits as peers); GET fabric still shows planned defaults for keyless gateways. Relay `address` allocates the lowest-free host in `fabric.cidr`; `endpoint_address` is an operator override over pair-aware `planRelayPath` (`direct_lan` via shared datacenter family intersection, else `direct_public`). An unplannable pair is omitted from that server's peer list and recorded on `unreachablePeers` (the rest of the mesh still builds). GET fabric `resolvedEndpoint` stays destination-only (no viewer/`self`). |
| `table-naming.test.ts`                    | Guard: every `CREATE TABLE` across migration SQL files under `migrations/` is one lower-case word (no underscores); exception list for external-compat names; retired-name reject list (phase 2 adds `gitapp` / `installation` / `source` / `steward` / `location` / `credential` / `node` / `segment` / `rotation`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `primary-key.test.ts`                     | Guard: every `CREATE TABLE` across migration SQL files under `migrations/` has a `PRIMARY KEY`; application PKs are `uuid … DEFAULT uuidv7()` or the allowlisted natural key `dispatch.command_id`; rejects `serial` / identity / `nextval()`; pins the drizzle-orm `public.migration` bookkeeping DDL (see Multi-node PostgreSQL model)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `../../db.ts`                             | Connection factories (`createDenoDb`, `createToolingDb`, `createWorkersDb`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `../../drizzle.config.mjs`                | drizzle-kit config (`TURBOPANEL_DATABASE_URL`; introspect, push, generate, migrate, studio)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `../../scripts/bootstrap-dev-db.sh`       | Dev DB bootstrap: `pnpm migrate` (includes the PostgreSQL 18 / `uuidv7()` preflight)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `../../scripts/check-postgres-compat.mjs` | Pre-migration gate run by `pnpm migrate`: verifies the target server has `uuidv7()` (PostgreSQL 18 minimum) before `drizzle-kit migrate` touches it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `~/dev/scripts/introspect.sh`             | Pull DB → `schema.ts` (lives in dev repo)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `~/dev/scripts/sync.sh`                   | Push `schema.ts` → DB (Deno dev only; no migration files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `../../scripts/db-connect.sh`             | Resolves `TURBOPANEL_DATABASE_URL` from env or `turbopanel-instance` for drizzle-kit scripts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `../../migrations/`                       | Versioned SQL migration files (committed); applied by `pnpm migrate`; tracked in `public.migration`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `../../drizzle/`                          | Ephemeral introspect scratch dir — `dev/scripts/introspect.sh` deletes after adopt; never committed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Authz engine

Runtime authorization lives in `../../client/authz/` (pure TypeScript, safe for
both Deno and Workers — no Deno-only imports). Permissions are static code
constants in `catalog.ts`. The modules below evaluate access at request time
against `grant`.

| File                              | Purpose                                                                                                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../../client/authz/catalog.ts`   | Static `PERMISSIONS`, `GRANTABLE_PERMISSIONS` (excludes `system:manage`), `ENTITY_TYPES`, `SUBJECT_TYPES` (`user` / `team` / `organization`), `isPermissionKey`, `isGrantablePermissionKey`, `isEntityType`, `isSubjectType`, `getPermissionCatalog` — no DB access |
| `../../client/authz/service.ts`   | `isPlatformAdmin`, `isSuperAdmin`, `canManageOrganization`, `canOwnOrganization`, `canManageTeam`, `canOwnTeam`, `canInviteToOrganization`, `canInviteToTeam`, `assertNotLastOrgOwner` — higher-level org/team management checks built on `can()`                   |
| `../../client/authz/evaluator.ts` | `getSubjects`, `can`, `assertCan`, `listVisible`, `ForbiddenError` — org-level grant checks via domain-FK ancestry; superadmin and admin bypass in SQL                                                                                                              |
| `../../client/authz/http.ts`      | `assertCanOr403` / `assertOrgOwnerOr403` Hono helpers; `assertNotSystemOwnedOr403` secondary guard (`403` `system_resource_immutable`) via `resolveWorkspaceKindForEntity`                                                                                          |

`can()` resolves org-level access in a **single CTE query** (`subjectset` →
`ancestry` → org grant `hits`) — one round-trip. **Organization permission
evaluation respects the requested permission:** an `organization:own` check
requires an `organization:own` grant (owner only — a manager grant is NOT
sufficient), while an `organization:manage` check accepts either an
`organization:own` or `organization:manage` grant (owner or manager). A
platform-admin bypass (`EXISTS … WHERE role IN ('superadmin', 'admin')`) is OR'd
into the final result. Superadmin-only platform operations (e.g. developer
reset-dev) remain gated separately by `user.role === 'superadmin'`.
`listVisible()` returns all leaf ids in the org when the user has org-level
access (owner or manager) — **never rely on client-side filtering** for
visibility.

**Owner-only vs broad org access:** owner-only routes (access-grant management,
license lifecycle) use the exact owner-only guard `assertOrgOwnerOr403`
(`../../client/authz/http.ts`) which checks `organization:own`. Broad "owner or
manager" resource read/create/update/delete routes use `assertCanManageOr403` /
`assertCanReadOr403` / `assertCanCreateOr403` (`../../client/shared.ts`), which
check `organization:manage`. Never use `organization:own` as a broad org-access
check — it is exact owner-only.

**Install (Deno):** `completeInstanceInstall` inserts the **TurboPanel**
workspace (`kind='turbopanel'`) first, then exactly one `organization:own` grant
on the org, one `team:own` grant on the default team, and a **Default
Workspace** (`kind='user'`) for the superadmin user. Workers sign-up
(`createOrganizationForUser`) still creates only the Default Workspace when
provisioning an org — the TurboPanel workspace is ensured lazily on first server
enroll for those orgs. Self-hosted install names the org **Root Organization**;
Workers / user-created first orgs default to **My Organization**, and
`POST /organizations` defaults to **New Organization**.

**Completed:** Resource ancestry is computed directly from real domain tables
(`organization → workspace → project → environment → service/hosting`,
`organization → server`); the generic `resource` shadow table has been dropped.
The `grant` table is allow-only — every persisted row is a positive capability
grant (no deny column).

## Connection (self-hosted dev)

Self-hosted instance boot and all database tooling require
**`TURBOPANEL_DATABASE_URL`**. Unix socket connections use the libpq-style
`?host=` query param (e.g.
`postgresql://turbopanel@/turbopanel?host=/var/run/turbopanel/postgres` —
credentials live only in the env, never in git). Postgres in Docker always
publishes the socket under `/var/run/turbopanel/postgres`; TCP port exposure
(`postgres_expose_port`) is optional and unused by the instance. See repo root
`AGENTS.md` for env var details.

## Sanity check

```bash
docker exec turbopanel-database psql -U turbopanel -d turbopanel -c '\dt'
```

Restart the instance only when **application code** changed — schema sync alone
does not require a restart.
