/**
 * Hand-curated canonical schema. Column order is intentional and maintained by
 * hand — do **not** re-introspect (`dev/scripts/introspect.sh`) over this file;
 * that reorders columns and clobbers the manual layout. Generate versioned SQL
 * via `pnpm generate --name <summary>`.
 *
 * Tables with a `metadata`/`options` pair use:
 *   id → created_at → updated_at → metadata → options → …remaining columns
 * If a table has one of those JSONB columns, it must have both — and both are
 * always nullable (`jsonb()`, never `.notNull()`).
 *
 * Primary keys are UUIDv7 (`DEFAULT uuidv7()`, PostgreSQL 18+) under a
 * primary/standby model with one writable primary; sharded/distributed SQL is
 * out of scope. Guarded by `primary-key.test.ts` — see AGENTS.md (Multi-node
 * PostgreSQL model) before changing key strategy.
 */

import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { cidr, inet } from './net-types.ts'

export const invitation = pgTable(
  'invitation',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    userId: uuid('user_id').notNull(),
    teamId: uuid('team_id').notNull(),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    email: varchar({ length: 255 }).notNull(),
    status: varchar({ length: 255 }).notNull(),
    /** Intended access grants materialized on accept — see `InvitationGrantSpec`. */
    grants: jsonb(),
  },
  (table) => [
    index('idx_invitation_email').using('btree', table.email.asc().nullsLast().op('text_ops')),
    index('idx_invitation_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    index('idx_invitation_team_id').using('btree', table.teamId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'invitation_user_id_user_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [team.id],
      name: 'invitation_team_id_team_id_fk',
    }).onDelete('cascade'),
  ]
)
export const organization = pgTable(
  'organization',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    name: varchar({ length: 255 }),
    slug: varchar({ length: 255 }),
  },
  (table) => [unique('organization_slug_unique').on(table.slug)]
)
/**
 * Organization TLS certificate library (upload / Let's Encrypt / self-signed).
 * Private keys are sealed `tpsecret` envelopes — never returned on client GET.
 * Hosting pins via `hosting.tls_id`; unset uses Caddy `tls internal` (self-signed).
 */
export const tls = pgTable(
  'tls',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar({ length: 255 }),
    /** `upload` | `lets_encrypt` | `self_signed` | `organization_ca` */
    source: text().notNull(),
    /** Leaf + intermediate chain PEM; null while LE `pending`. */
    certificatePem: text('certificate_pem'),
    /** Sealed `tpsecret` private key PEM; null while LE `pending` before keygen. */
    privateKeyPem: text('private_key_pem'),
    /** `ready` | `pending` | `expired` | `failed` | `revoked` */
    status: text().default('ready').notNull(),
    notAfter: timestamp('not_after', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    fingerprintSha256: text('fingerprint_sha256'),
    /**
     * Organization CA lifecycle: `active` | `retired` | `revoked`.
     * Null on non-CA library rows. `status` remains the row's own health.
     */
    caState: text('ca_state'),
    /** Monotonic per-org counter on Organization CA rows; null on non-CA rows. */
    caGeneration: integer('ca_generation'),
  },
  (table) => [
    index('idx_tls_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_tls_not_after').using(
      'btree',
      table.notAfter.asc().nullsLast().op('timestamptz_ops')
    ),
    uniqueIndex('uniq_tls_organization_fingerprint_sha256')
      .on(table.organizationId, table.fingerprintSha256)
      .where(sql`${table.fingerprintSha256} IS NOT NULL`),
    uniqueIndex('uniq_tls_organization_active_ca')
      .on(table.organizationId)
      .where(sql`${table.source} = 'organization_ca' AND ${table.caState} = 'active'`),
    index('idx_tls_organization_ca_generation')
      .on(table.organizationId, table.caGeneration)
      .where(sql`${table.source} = 'organization_ca'`),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'tls_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    check(
      'tls_source_check',
      sql`source IN ('upload', 'lets_encrypt', 'self_signed', 'organization_ca')`
    ),
    check(
      'tls_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
    check(
      'tls_ca_state_check',
      sql`ca_state IS NULL OR ca_state IN ('active', 'retired', 'revoked')`
    ),
    check(
      'tls_ca_lifecycle_source_check',
      sql`(source = 'organization_ca' AND ca_state IS NOT NULL) OR (source <> 'organization_ca' AND ca_state IS NULL AND ca_generation IS NULL)`
    ),
    check(
      'tls_ca_generation_source_check',
      sql`ca_generation IS NULL OR source = 'organization_ca'`
    ),
    check(
      'tls_ca_generation_required_check',
      sql`ca_state IS NULL OR ca_state = 'revoked' OR ca_generation IS NOT NULL`
    ),
  ]
)
/**
 * Durable Organization CA rotation journal (one in-flight rotation per org).
 */
export const changeover = pgTable(
  'changeover',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    fromCaGeneration: integer('from_ca_generation').default(0).notNull(),
    toCaGeneration: integer('to_ca_generation').default(0).notNull(),
    /** `in_progress` | `awaiting_retire` | `completed` | `failed` */
    state: text().notNull(),
    startedAt: timestamp('started_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** Per-server / per-cluster fan-out rows (`ingress` | `apply`). */
    results: jsonb().default([]),
  },
  (table) => [
    index('idx_changeover_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'changeover_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    uniqueIndex('uniq_changeover_inflight_organization')
      .on(table.organizationId)
      .where(sql`${table.state} = 'in_progress'`),
    check(
      'changeover_state_check',
      sql`${table.state} IN ('in_progress','awaiting_retire','completed','failed')`
    ),
  ]
)
export const passkey = pgTable(
  'passkey',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    userId: uuid('user_id').notNull(),
    aaguid: text(),
    name: varchar({ length: 255 }),
    publicKey: text('public_key').notNull(),
    credentialId: varchar('credential_id', { length: 255 }).notNull(),
    counter: integer().default(0).notNull(),
    deviceType: varchar('device_type', { length: 32 }).notNull(),
    isBackedUp: boolean('is_backed_up').notNull(),
    transports: text(),
  },
  (table) => [
    index('idx_passkey_credential_id').using(
      'btree',
      table.credentialId.asc().nullsLast().op('text_ops')
    ),
    index('idx_passkey_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'passkey_user_id_user_id_fk',
    }).onDelete('cascade'),
  ]
)
/**
 * Physical site grouping servers that share a private L2/L3 network; optional —
 * servers may have zero or many memberships via `ip` pins. `options` mirrors `organization.options` for
 * `defaultServerTimezone` / `enforceServerTimezone` (consumed by the next phase's
 * resolver). Must stay declared before `server` (same rule as `license`).
 */
export const datacenter = pgTable(
  'datacenter',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar({ length: 255 }),
    description: varchar('description', { length: 255 }),
  },
  (table) => [
    index('idx_datacenter_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'datacenter_organization_id_organization_id_fk',
    }).onDelete('cascade'),
  ]
)
/**
 * Enrolled host. Membership in datacenters is **not** a home FK here — a
 * server may pin into many sites via `ip` rows (`scope='datacenter'` +
 * `server_id` + `datacenter_id`).
 */
export const server = pgTable(
  'server',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id'),
    name: varchar({ length: 255 }),
    hostname: varchar('hostname', { length: 255 }),
    /**
     * Derived HMAC of the host machine-id (not the raw value, not a sealed
     * secret). Deterministic so it can be equality-matched and echoed into
     * signed enroll/auth payloads.
     */
    machineKey: text('machine_key'),
    /**
     * Daemon-reported OS from `/etc/os-release`. Raspberry Pi OS (including
     * 64-bit `ID=debian` + `/etc/rpi-issue`) is stored as
     * `os_id = raspberry-pi-os`.
     */
    osId: varchar('os_id', { length: 255 }),
    osFamily: varchar('os_family', { length: 32 }),
    osVersion: varchar('os_version', { length: 64 }),
    osCodename: varchar('os_codename', { length: 64 }),
    osPrettyName: varchar('os_pretty_name', { length: 255 }),
    osArchitecture: varchar('os_architecture', { length: 64 }),
    /**
     * Machine class for metrics capability-plan resolution (`physical` |
     * `virtual`). NULL means undeclared: ingest infers it from the recorded
     * topology each sample and writes back `physical` once the host proves
     * it by discovering hardware sensors — never `virtual`, which is only
     * absence of proof and would stop a sensor found by a later topology
     * generation from promoting the host. `PATCH /servers/:id` pins either
     * value (or clears the pin with null).
     */
    machineClass: text('machine_class'),
    /**
     * Daemon-reported host timezone (IANA). Operator override lives on
     * `server.options.timezone`.
     */
    timezone: varchar('timezone', { length: 64 }),
    isTimeSyncEnabled: boolean('is_time_sync_enabled'),
    /** jsonb array of `{ host, fallback? }`. */
    ntpServers: jsonb('ntp_servers'),
    ntpLastSyncedAt: timestamp('ntp_last_synced_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /**
     * Fleet liveness flag. Tri-state `online|offline|unknown` is derived from
     * `is_connected` + `status_changed_at` (never stored). API JSON still
     * serializes as `connected`.
     */
    isConnected: boolean('is_connected').default(false).notNull(),
    /**
     * Last status transition (`is_connected` flip). Feeds derived `connectedAt`
     * (when connected) / `offlineAt` (when not). `online|offline|unknown` is
     * derived, never stored.
     */
    statusChangedAt: timestamp('status_changed_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** Sparse `{ key, projection? }` — status lives in dedicated columns. */
    daemon: jsonb(),
  },
  (table) => [
    index('idx_server_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_server_machine_key').using(
      'btree',
      table.machineKey.asc().nullsLast().op('text_ops')
    ),
    index('idx_server_hostname').using('btree', table.hostname.asc().nullsLast().op('text_ops')),
    index('idx_server_connected')
      .on(table.id)
      .where(sql`${table.isConnected}`),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'server_organization_id_organization_id_fk',
    }).onDelete('restrict'),
    check('server_machine_class_check', sql`${table.machineClass} IN ('physical', 'virtual')`),
  ]
)
/**
 * Organization-scoped registration keys. Consumption latches on `server_id`
 * (one license per server). Defined after `server` so the FK can reference it.
 */
export const license = pgTable(
  'license',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    /** Set on first successful enroll — one-shot seat latch. */
    serverId: uuid('server_id'),
    name: varchar({ length: 255 }),
    /** Argon2id PHC hashed token — same format as account.password */
    token: text().notNull(),
    /** Soft-delete */
    revokedAt: timestamp('revoked_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('idx_license_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    // One license per server once consumed (revoked rows keep server_id for audit).
    uniqueIndex('uniq_license_server_id')
      .on(table.serverId)
      .where(sql`${table.serverId} IS NOT NULL`),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'license_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'license_server_id_server_id_fk',
    }).onDelete('set null'),
  ]
)
export const command = pgTable(
  'command',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    serverId: uuid('server_id').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    name: text().notNull(),
    status: text().notNull().default('queued'),
    attempts: integer().default(0).notNull(),
    /**
     * Small, non-secret identifier bag (`managedId`, `environmentId`,
     * `generation`, …) kept on the permanent row so UI/projection reads never
     * need the daemon execution payload. Never put secrets, compose YAML,
     * credentials, or TLS material here.
     */
    context: jsonb(),
    /** Bounded daemon result summary (was `result`). */
    resultSummary: jsonb('result_summary'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    queuedAt: timestamp('queued_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    dispatchStartedAt: timestamp('dispatch_started_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    sentAt: timestamp('sent_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    ackedAt: timestamp('acked_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    startedAt: timestamp('started_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    finishedAt: timestamp('finished_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('idx_command_server_id_created_at').using(
      'btree',
      table.serverId.asc(),
      table.createdAt.desc()
    ),
    index('idx_command_status').using('btree', table.status.asc()),
    /**
     * Backs the environment deploy-history read
     * (`GET /environments/:id/deployments`). Deploy history is sourced from
     * the append-only `command` table — one row per attempt — not from
     * `deployment`, which is an upsert-per-(environment, server) current-state
     * table. Partial + expression so it stays small: only
     * `environment.deploy` rows, keyed on the allowlisted
     * `context->>'environmentId'` rather than a denormalized column.
     */
    index('idx_command_deploy_environment_created')
      .using('btree', sql`((context ->> 'environmentId'))`, table.createdAt.desc())
      .where(sql`name = 'environment.deploy'`),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'command_server_id_server_id_fk',
    }).onDelete('cascade'),
  ]
)
/**
 * Daemon execution payload for a command (`dispatch`) — the only place
 * secret-bearing command input lives. Written in the same transaction as its `command` row,
 * read once by the consumer immediately before dispatch, deleted as soon as the
 * command succeeds, and retained ~24h (`expires_at`) after a terminal failure
 * for debugging. Expired rows are removed by the shared maintenance sweep.
 */
export const dispatch = pgTable(
  'dispatch',
  {
    commandId: uuid('command_id').primaryKey().notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    payload: jsonb().notNull(),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('idx_dispatch_expires_at').using('btree', table.expiresAt.asc()),
    foreignKey({
      columns: [table.commandId],
      foreignColumns: [command.id],
      name: 'dispatch_command_id_command_id_fk',
    }).onDelete('cascade'),
  ]
)
/**
 * Org-owned network registry: datacenter site CIDRs (`kind = 'datacenter'`;
 * a datacenter may own multiple CIDR rows), external Docker registrations
 * (`kind = 'docker'`, optional `server_id`), TurboFabric logical spanning
 * networks (`kind = 'compose'`), and the org-wide managed-engine network
 * (`kind = 'managed'`).
 *
 * `managed` is platform-allocated, never operator-created: at most one row per
 * organization (`uniq_network_organization_managed`), no datacenter/server/
 * environment scope and no CIDR — the Docker network name lives in
 * `options.dockerNetworkName` and is the row's own bare UUID.
 */
export const network = pgTable(
  'network',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    datacenterId: uuid('datacenter_id'),
    serverId: uuid('server_id'),
    /**
     * Optional pin for `kind = 'compose'` logical spanning networks
     * (null = org-shared). No FK here — `environment` is declared later;
     * compiler writes this id from a live environment row.
     */
    environmentId: uuid('environment_id'),
    kind: text().notNull(),
    cidr: cidr(),
    name: varchar({ length: 255 }),
  },
  (table) => [
    index('idx_network_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_network_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_network_datacenter_id').using(
      'btree',
      table.datacenterId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_network_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'network_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.datacenterId],
      foreignColumns: [datacenter.id],
      name: 'network_datacenter_id_datacenter_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'network_server_id_server_id_fk',
    }).onDelete('restrict'),
    check('network_kind_check', sql`kind IN ('datacenter', 'docker', 'compose', 'managed')`),
    check(
      'network_single_scope_check',
      sql`(
        (${table.kind} = 'datacenter' AND ${table.datacenterId} IS NOT NULL AND ${table.serverId} IS NULL AND ${table.environmentId} IS NULL AND ${table.cidr} IS NOT NULL) OR
        (${table.kind} = 'docker' AND ${table.datacenterId} IS NULL AND ${table.environmentId} IS NULL) OR
        (${table.kind} = 'compose' AND ${table.datacenterId} IS NULL AND ${table.serverId} IS NULL) OR
        (${table.kind} = 'managed' AND ${table.datacenterId} IS NULL AND ${table.serverId} IS NULL AND ${table.environmentId} IS NULL AND ${table.cidr} IS NULL)
      )`
    ),
    /** Unique CIDR per datacenter — a datacenter may own multiple CIDR rows. */
    uniqueIndex('uniq_network_datacenter_cidr')
      .on(table.datacenterId, table.cidr)
      .where(sql`${table.kind} = 'datacenter'`),
    /** At most one platform-allocated managed-engine network per organization. */
    uniqueIndex('uniq_network_organization_managed')
      .on(table.organizationId)
      .where(sql`${table.kind} = 'managed'`),
    check(
      'network_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
/** Org-scoped WireGuard mesh — owns its overlay CIDR directly (no `network` row). */
/**
 * Org TurboFabric mesh (host interface `tp0`). At most one row per
 * organization; **absence means TurboFabric is off**. Container-pool CIDR and
 * listen port live in `options`. Private keys never stored.
 */
export const fabric = pgTable(
  'fabric',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    /** Host fabric subnet for `tp0` addresses (e.g. `10.250.0.0/16`). */
    cidr: cidr().notNull(),
    name: varchar({ length: 255 }),
  },
  (table) => [
    uniqueIndex('uniq_fabric_organization_id').on(table.organizationId),
    index('idx_fabric_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'fabric_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    check(
      'fabric_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
/**
 * Single source of truth for every managed address. Two non-overlapping private
 * facts: **site CIDR** lives on `network(kind='datacenter', datacenter_id=…)`
 * (a datacenter may own multiple CIDR rows); **a server's private pin into a
 * datacenter** is `ip WHERE server_id AND datacenter_id AND scope = 'datacenter'`
 * (a server may hold multiple pins per datacenter — multi-subnet, dual-stack,
 * multi-NIC — and pins in many datacenters; each pin names its subnet via
 * `network_id`). Free-pool rows keep `datacenter_id` with null `server_id`.
 * Public VPS addresses carry no `network_id`. TurboFabric `tp0` addresses live
 * on `relay.address`, not here. Address family (`version`) is derived from
 * `address` in the API — not stored. Optional `description` is an operator
 * note (`varchar(255)`); IPs are not named.
 */
export const ip = pgTable(
  'ip',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    datacenterId: uuid('datacenter_id'),
    networkId: uuid('network_id'),
    serverId: uuid('server_id'),
    address: inet('address').notNull(),
    allocation: text().notNull(),
    scope: text().notNull(),
    /** Optional operator note — IPs are identified by `address`, not a name. */
    description: varchar('description', { length: 255 }),
  },
  (table) => [
    index('idx_ip_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_ip_datacenter_id').using(
      'btree',
      table.datacenterId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_ip_network_id').using('btree', table.networkId.asc().nullsLast().op('uuid_ops')),
    index('idx_ip_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_ip_scope_server_datacenter').using(
      'btree',
      table.scope.asc().nullsLast().op('text_ops'),
      table.serverId.asc().nullsLast().op('uuid_ops'),
      table.datacenterId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'ip_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.datacenterId],
      foreignColumns: [datacenter.id],
      name: 'ip_datacenter_id_datacenter_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.networkId],
      foreignColumns: [network.id],
      name: 'ip_network_id_network_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'ip_server_id_server_id_fk',
    }).onDelete('restrict'),
    check('ip_allocation_check', sql`allocation IN ('dedicated', 'shared')`),
    check('ip_scope_check', sql`scope IN ('public', 'datacenter')`),
    check(
      'ip_datacenter_scope_check',
      sql`(${table.scope} <> 'datacenter') OR (${table.datacenterId} IS NOT NULL)`
    ),
    /**
     * Free pool: datacenter_id only (no server / network). Membership pin:
     * server_id + datacenter_id (network_id required via
     * `ip_datacenter_member_network_check`).
     */
    check(
      'ip_datacenter_anchor_check',
      sql`(
        ${table.datacenterId} IS NULL OR
        (${table.serverId} IS NULL AND ${table.networkId} IS NULL) OR
        ${table.serverId} IS NOT NULL
      )`
    ),
    /**
     * A membership pin (`scope='datacenter'` + `server_id`) must name its
     * owning subnet. Free-pool rows (`datacenter_id` only) stay unconstrained
     * here.
     */
    check(
      'ip_datacenter_member_network_check',
      sql`(
        ${table.scope} <> 'datacenter' OR
        ${table.serverId} IS NULL OR
        ${table.networkId} IS NOT NULL
      )`
    ),
    uniqueIndex('uniq_ip_org_address').on(table.organizationId, table.address),
  ]
)
/**
 * One server in an org TurboFabric mesh (parallel to managed `node`). Private
 * key never stored; `public_key` stays null until the first successful
 * `server.fabric.reconcile`. `address` is the `tp0` host address; `prefix` is
 * that server's container aggregate, forwarded over `tp0`. Gateway LAN CIDRs
 * persist on `advertised_cidrs` (empty when `role = 'member'`).
 */
export const relay = pgTable(
  'relay',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    fabricId: uuid('fabric_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** `tp0` host address (rendered `/32` by `hostRoute32`). */
    address: inet('address').notNull(),
    /**
     * Mesh role — `gateway` advertises `advertised_cidrs` to remote peers;
     * `member` is host-route only (list must stay empty).
     */
    role: text().notNull().default('member'),
    keepalive: integer(),
    /** Operator pin; null = auto-derive from datacenter / public / reported addresses. */
    endpointAddress: inet('endpoint_address'),
    publicKey: text('public_key'),
    /** Container aggregate CIDR forwarded via this relay (e.g. `10.192.0.0/16`). */
    prefix: cidr().notNull(),
    /** Operator-configured LAN CIDRs advertised by gateway relays. */
    advertisedCidrs: jsonb('advertised_cidrs')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Sealed `tpsecret` envelope — write-only, same handling as `principal.password`. */
    presharedKey: text('preshared_key'),
  },
  (table) => [
    index('idx_relay_fabric_id').using('btree', table.fabricId.asc().nullsLast().op('uuid_ops')),
    index('idx_relay_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.fabricId],
      foreignColumns: [fabric.id],
      name: 'relay_fabric_id_fabric_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'relay_server_id_server_id_fk',
    }).onDelete('restrict'),
    unique('relay_fabric_server_unique').on(table.fabricId, table.serverId),
    unique('uniq_relay_fabric_address').on(table.fabricId, table.address),
    unique('uniq_relay_fabric_public_key').on(table.fabricId, table.publicKey),
    check('relay_role_check', sql`role IN ('gateway', 'member')`),
    check(
      'relay_keepalive_check',
      sql`${table.keepalive} IS NULL OR (${table.keepalive} BETWEEN 1 AND 65535)`
    ),
    check(
      'relay_member_advertised_cidrs_empty_check',
      sql`${table.role} <> 'member' OR ${table.advertisedCidrs} = '[]'::jsonb`
    ),
  ]
)
/**
 * Server-local realization of a `kind='compose'` spanning network (today a
 * Docker bridge subnet carved from that relay's prefix). Implementation may
 * change; the row is the logical network's per-server subnet.
 */
export const subnet = pgTable(
  'subnet',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    networkId: uuid('network_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** Server-local subnet for this network. */
    cidr: cidr().notNull(),
  },
  (table) => [
    index('idx_subnet_network_id').using('btree', table.networkId.asc().nullsLast().op('uuid_ops')),
    index('idx_subnet_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.networkId],
      foreignColumns: [network.id],
      name: 'subnet_network_id_network_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'subnet_server_id_server_id_fk',
    }).onDelete('restrict'),
    unique('subnet_network_server_unique').on(table.networkId, table.serverId),
  ]
)
export const workspace = pgTable(
  'workspace',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar({ length: 255 }),
    description: varchar('description', { length: 255 }),
    kind: varchar({ length: 32 }).notNull().default('user'),
  },
  (table) => [
    index('idx_workspace_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'workspace_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    check(
      'workspace_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
    check('workspace_kind_check', sql`kind IN ('user', 'turbopanel')`),
    uniqueIndex('uniq_workspace_organization_turbopanel')
      .on(table.organizationId)
      .where(sql`kind = 'turbopanel'`),
  ]
)
export const project = pgTable(
  'project',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    workspaceId: uuid('workspace_id').notNull(),
    /**
     * The one Git repository this project is. Null for a project that is not
     * repository-backed at all (a template, a managed engine, a hand-written
     * compose of images).
     *
     * **One repository, and it belongs to the project — not to a service.** A
     * repository-backed project *is* its repository: the checkout is what the
     * compose file, the site root, or the app process all come out of, and
     * several repositories in one project would mean several answers to "what
     * is deployed here". Services still carry their own
     * `x-turbopanel.source` block for the per-service half (`branch`,
     * `subdirectory`, `buildCommand`, …) — that is how a monorepo builds two
     * services out of one checkout — but every `sourceId` in the project's
     * compose has to name *this* row. The rule is enforced at the write
     * boundary (`lintComposeYaml`, `projectRepositoryId`), because the compose
     * parser is pure and has no database.
     *
     * A project with no binding yet **adopts** the first repository its compose
     * names, on the same save. That is what lets the create wizard seed a draft
     * and write the project in one act, and it is not a loophole: the adopting
     * save is exactly the one the single-repository rule is checked on.
     *
     * `restrict` rather than `cascade`: deleting the repository out from under
     * a project would leave compose naming an id that no longer resolves.
     * `DELETE /repositories/:id` checks this column alongside the compose
     * references and answers the same 409 `source_referenced_by_compose`
     * before Postgres ever has to raise the FK violation.
     */
    repositoryId: uuid('repository_id').references(
      // `AnyPgColumn` breaks a genuine type cycle — project → repository →
      // environment → project — that TypeScript cannot infer through. Declared
      // inline rather than in `foreignKey()` below for the same reason: the
      // annotation has to sit on the reference itself.
      (): AnyPgColumn => repository.id,
      { onDelete: 'restrict' }
    ),
    name: varchar({ length: 255 }),
    description: varchar('description', { length: 255 }),
  },
  (table) => [
    index('idx_project_workspace_id').using(
      'btree',
      table.workspaceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_project_repository_id').using(
      'btree',
      table.repositoryId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspace.id],
      name: 'project_workspace_id_workspace_id_fk',
    }).onDelete('restrict'),
    check(
      'project_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._/-]+$'::text))`
    ),
    /**
     * One project per system component per workspace (system hierarchy).
     * Partial — user projects omit `metadata.component`.
     */
    uniqueIndex('uniq_project_workspace_system_component')
      .on(table.workspaceId, sql`(metadata->>'component')`)
      .where(sql`(metadata->>'component') IS NOT NULL`),
  ]
)

export const environment = pgTable(
  'environment',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    projectId: uuid('project_id').notNull(),
    /** Whole-server placement pin — single source of truth (not compose / metadata). */
    serverId: uuid('server_id'),
    /**
     * Monotonic desired generation, bumped once per deploy and fanned into
     * `deployment.desired_generation`.
     */
    generation: integer().default(0).notNull(),
    name: varchar({ length: 255 }),
    description: varchar('description', { length: 255 }),
  },
  (table) => [
    index('idx_environment_project_id').using(
      'btree',
      table.projectId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_environment_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'environment_project_id_project_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'environment_server_id_server_id_fk',
    }).onDelete('restrict'),
    check(
      'environment_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._/-]+$'::text))`
    ),
  ]
)

export const managed = pgTable(
  'managed',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),

    /** Environment-scoped managed engine service (1:1 with environment). */
    environmentId: uuid('environment_id').notNull(),
    /**
     * Placement pin for the managed service host. Mirrors
     * `environment.server_id` at provision time so managed engines can move
     * independently of the environment's deploy placement later.
     */
    serverId: uuid('server_id'),
    name: varchar({ length: 255 }),
    /** Catalog engine code (e.g. `postgres`, `redis`). */
    engine: text(),
    /** `provisioning` | `applying` | `ready` | `stopped` | `failed` */
    status: text(),
  },
  (table) => [
    index('idx_managed_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_managed_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_managed_engine').using('btree', table.engine.asc().nullsLast().op('text_ops')),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'managed_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'managed_server_id_server_id_fk',
    }).onDelete('restrict'),
    uniqueIndex('managed_environment_id_unique').on(table.environmentId),
    check(
      'managed_name_format_check',
      sql`(${table.name} IS NULL) OR (((char_length((${table.name})::text) >= 1) AND (char_length((${table.name})::text) <= 255)) AND ((${table.name})::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
    check(
      'managed_status_check',
      sql`status IS NULL OR status IN ('provisioning','applying','ready','stopped','failed')`
    ),
  ]
)
/**
 * One server participation (replica) in a managed cluster (`managed`). Exactly
 * one `primary` per `managed_id` (partial unique); replicas use ordinals 2+.
 * Container fan-out uses `ordinal` on `(service_id, role='service', ordinal)`.
 */
export const replica = pgTable(
  'replica',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    managedId: uuid('managed_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** `primary` | `replica` */
    role: text().default('primary').notNull(),
    /**
     * Replica class: `failover` (same-datacenter, promotable) or `read`
     * (any org server). Null on primary; ignored when role is primary.
     */
    replicaClass: text('replica_class'),
    /** API JSON still serializes as `readEligible`. */
    isReadEligible: boolean('is_read_eligible').default(false).notNull(),
    /** 1-based member ordinal — mirrors the service-role container ordinal. */
    ordinal: integer().default(1).notNull(),
    /**
     * Resolved private path to the primary (`local` | `datacenter` | `fabric` | `public`).
     * Null when not yet resolved (or primary self).
     */
    replicationTransport: text('replication_transport'),
    /**
     * Host port published only on the member's private address for remote
     * replication + ProxySQL backend reachability. Null for single-member
     * clusters.
     */
    privatePort: integer('private_port'),
    /** Per-member observed status; same vocabulary as `managed.status` plus `needs_resync`. */
    status: text(),
  },
  (table) => [
    index('idx_replica_managed_id').using(
      'btree',
      table.managedId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_replica_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'replica_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'replica_server_id_server_id_fk',
    }).onDelete('restrict'),
    uniqueIndex('uniq_replica_primary')
      .on(table.managedId)
      .where(sql`${table.role} = 'primary'`),
    uniqueIndex('uniq_replica_server_private_port')
      .on(table.serverId, table.privatePort)
      .where(sql`${table.privatePort} IS NOT NULL`),
    unique('uniq_replica_managed_ordinal').on(table.managedId, table.ordinal),
    unique('uniq_replica_managed_server').on(table.managedId, table.serverId),
    check('replica_role_check', sql`${table.role} IN ('primary','replica')`),
    check(
      'replica_replica_class_check',
      sql`${table.replicaClass} IS NULL OR ${table.replicaClass} IN ('failover','read')`
    ),
    check('replica_ordinal_positive_check', sql`${table.ordinal} >= 1`),
    check(
      'replica_transport_check',
      sql`${table.replicationTransport} IS NULL OR ${table.replicationTransport} IN ('local','fabric','datacenter','public')`
    ),
    check(
      'replica_status_check',
      sql`status IS NULL OR status IN ('provisioning','applying','ready','stopped','failed','needs_resync')`
    ),
  ]
)
/**
 * Tracking row for Organization-CA-signed managed leaves (ProxySQL frontend
 * and per-replica engine). Re-issuance upserts rather than appending history
 * (partial uniques below). Declared after `replica` / `managed` / `server` so
 * those FKs resolve.
 */
export const leaf = pgTable(
  'leaf',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** `ingress` | `engine` */
    kind: text().notNull(),
    /** Engine leaves only — the managed cluster that owns the replica. */
    managedId: uuid('managed_id'),
    /** Engine leaves only — the cluster replica whose leaf this tracks. */
    replicaId: uuid('replica_id'),
    /** Signing Organization CA row (`tls.id`). */
    caId: uuid('ca_id').notNull(),
    caGeneration: integer('ca_generation').notNull(),
    notAfter: timestamp('not_after', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    issuedAt: timestamp('issued_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_leaf_not_after').using(
      'btree',
      table.notAfter.asc().nullsLast().op('timestamptz_ops')
    ),
    index('idx_leaf_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    uniqueIndex('uniq_leaf_ingress_server')
      .on(table.serverId)
      .where(sql`${table.kind} = 'ingress'`),
    uniqueIndex('uniq_leaf_engine_replica')
      .on(table.replicaId)
      .where(sql`${table.kind} = 'engine'`),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'leaf_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'leaf_server_id_server_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'leaf_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.replicaId],
      foreignColumns: [replica.id],
      name: 'leaf_replica_id_replica_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.caId],
      foreignColumns: [tls.id],
      name: 'leaf_ca_id_tls_id_fk',
    }).onDelete('cascade'),
    check('leaf_kind_check', sql`${table.kind} IN ('ingress','engine')`),
    check(
      'leaf_kind_keys_check',
      sql`(
        (${table.kind} = 'ingress' AND ${table.replicaId} IS NULL AND ${table.managedId} IS NULL)
        OR
        (${table.kind} = 'engine' AND ${table.replicaId} IS NOT NULL AND ${table.managedId} IS NOT NULL)
      )`
    ),
  ]
)
/**
 * Per-server ProxySQL backend monitor credential (control-plane minted).
 *
 * A **secret-bearing table**, deliberately separate from `server.options`:
 * `options` is operator-facing configuration that `GET /servers`,
 * `GET /servers/:id`, and the developer routes return verbatim, and that the
 * approved cached read models copy into Redis. A sealed password must never
 * ride along on any of those paths, so it lives here where nothing
 * client-facing selects it.
 *
 * One row per server (`uniq_monitor_server`): ProxySQL's monitor credential is
 * a single global per instance and one ProxySQL runs per host. Cascades with
 * the server so a deleted host leaves no orphaned secret behind.
 */
export const monitor = pgTable(
  'monitor',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    serverId: uuid('server_id').notNull(),
    /** Deterministic `tp_monitor_<serverId prefix>`; engine identifier limits apply. */
    username: varchar({ length: 64 }).notNull(),
    /**
     * Data-encryption sealed password (`ENVELOPE_PREFIX_SECRET`). Resealed to a
     * `tpdaemon` envelope per recipient at send time — never shipped as stored.
     */
    secretEnvelope: text('secret_envelope').notNull(),
  },
  (table) => [
    uniqueIndex('uniq_monitor_server').on(table.serverId),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'monitor_server_id_server_id_fk',
    }).onDelete('cascade'),
  ]
)

/**
 * Durable HA journal for one managed cluster. At most one in-flight recovery
 * per `managed_id` (partial unique on non-terminal states). Member ids are
 * stored without a node FK so deleting a member cannot block the journal.
 */
export const recovery = pgTable(
  'recovery',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    managedId: uuid('managed_id').notNull(),
    /** `automatic-failover` | `switchover` | `disaster-recovery` */
    kind: text().notNull(),
    sourcePrimaryMemberId: uuid('source_primary_member_id').notNull(),
    targetMemberId: uuid('target_member_id'),
    /**
     * `detecting` | `fencing` | `promoting` | `repointing` |
     * `reconciling-ingress` | `verifying` | `completed` | `failed` | `blocked`
     */
    state: text().notNull(),
    startedAt: timestamp('started_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('idx_recovery_managed_id').using(
      'btree',
      table.managedId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'recovery_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    uniqueIndex('uniq_recovery_inflight_managed')
      .on(table.managedId)
      .where(sql`${table.state} NOT IN ('completed','failed','blocked')`),
    check(
      'recovery_kind_check',
      sql`${table.kind} IN ('automatic-failover','switchover','disaster-recovery')`
    ),
    check(
      'recovery_state_check',
      sql`${table.state} IN ('detecting','fencing','promoting','repointing','reconciling-ingress','verifying','completed','failed','blocked')`
    ),
  ]
)
export const variable = pgTable(
  'variable',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id'),
    workspaceId: uuid('workspace_id'),
    projectId: uuid('project_id'),
    environmentId: uuid('environment_id'),
    serviceId: uuid('service_id'),
    hostingId: uuid('hosting_id'),
    serverId: uuid('server_id'),
    /**
     * When set, this row is system-owned by a binding (materialized credentials).
     * Client PATCH/DELETE is refused; variable rows cascade when the binding is deleted.
     */
    bindingId: uuid('binding_id'),
    key: varchar({ length: 255 }).notNull(),
    value: text().default('').notNull(),
    isSecret: boolean('is_secret').default(false).notNull(),
    isLiteral: boolean('is_literal').default(false).notNull(),
    /** API JSON still serializes as `forBuild`. */
    isForBuild: boolean('is_for_build').default(false).notNull(),
    /** API JSON still serializes as `forRuntime`. */
    isForRuntime: boolean('is_for_runtime').default(true).notNull(),
    description: varchar('description', { length: 255 }),
  },
  (table) => [
    index('idx_variable_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_variable_workspace_id').using(
      'btree',
      table.workspaceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_variable_project_id').using(
      'btree',
      table.projectId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_variable_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_variable_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_variable_hosting_id').using(
      'btree',
      table.hostingId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_variable_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_variable_binding_id').using(
      'btree',
      table.bindingId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'variable_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspace.id],
      name: 'variable_workspace_id_workspace_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'variable_project_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'variable_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'variable_service_id_service_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.hostingId],
      foreignColumns: [hosting.id],
      name: 'variable_hosting_id_hosting_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'variable_server_id_server_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.bindingId],
      foreignColumns: [binding.id],
      name: 'variable_binding_id_binding_id_fk',
    }).onDelete('cascade'),
    uniqueIndex('uniq_var_org')
      .on(table.key, table.organizationId)
      .where(sql`${table.organizationId} IS NOT NULL`),
    uniqueIndex('uniq_var_workspace')
      .on(table.key, table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    uniqueIndex('uniq_var_project')
      .on(table.key, table.projectId)
      .where(sql`${table.projectId} IS NOT NULL`),
    uniqueIndex('uniq_var_environment')
      .on(table.key, table.environmentId)
      .where(sql`${table.environmentId} IS NOT NULL`),
    uniqueIndex('uniq_var_service')
      .on(table.key, table.serviceId)
      .where(sql`${table.serviceId} IS NOT NULL`),
    uniqueIndex('uniq_var_hosting')
      .on(table.key, table.hostingId)
      .where(sql`${table.hostingId} IS NOT NULL`),
    uniqueIndex('uniq_var_server')
      .on(table.key, table.serverId)
      .where(sql`${table.serverId} IS NOT NULL`),
    check(
      'variable_exactly_one_parent_check',
      sql`((organization_id IS NOT NULL)::int +
        (workspace_id IS NOT NULL)::int +
        (project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int +
        (hosting_id IS NOT NULL)::int +
        (server_id IS NOT NULL)::int) = 1`
    ),
    check(
      'variable_key_format_check',
      sql`(char_length(key) >= 1) AND (char_length(key) <= 255) AND (key ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)`
    ),
  ]
)
export const service = pgTable(
  'service',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    environmentId: uuid('environment_id').notNull(),
    /**
     * User-facing label (Postgres column `name`, renamed from `display_name`).
     * Nullable and not unique. Client JSON field is `name`.
     */
    name: varchar({ length: 255 }),
    description: varchar('description', { length: 255 }),
    /**
     * Compose service key — derived from the compose document (project base +
     * environment overlay). Written only by reconcile (`reconcileServicesFromCompose`),
     * managed container allocation, and daemon-report container reconcile
     * (`ensureServicesForReportedContainers`) — never by a client request.
     * Unique per environment (`uniq_service_environment_compose_name`);
     * `name` itself is not unique and must not be assumed so.
     */
    composeServiceName: varchar('compose_service_name', { length: 255 }).notNull(),
  },
  (table) => [
    index('idx_service_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    /** Unique per environment. */
    uniqueIndex('uniq_service_environment_compose_name').on(
      table.environmentId,
      table.composeServiceName
    ),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'service_environment_id_environment_id_fk',
    }).onDelete('restrict'),
    check(
      'service_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
/**
 * One row per participating `(environment, server)` in a deploy. Unique on
 * that pair; `server_id` RESTRICT mirrors `container.server_id`.
 *
 * This is **current desired/applied state**, upserted on every redeploy — not
 * a history table. `finished_at` / `duration_ms` / `outcome` summarize only the
 * **last** apply attempt. Per-attempt history lives in the append-only
 * `command` table (`name = 'environment.deploy'`, scoped by
 * `context->>'environmentId'`).
 */
export const deployment = pgTable(
  'deployment',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    /** Last failure message / planner warnings. */
    metadata: jsonb(),
    options: jsonb(),
    environmentId: uuid('environment_id').notNull(),
    serverId: uuid('server_id').notNull(),
    desiredGeneration: integer('desired_generation').default(0).notNull(),
    appliedGeneration: integer('applied_generation'),
    /** sha256 of that server's compiled runtime `compose.yaml`. */
    desiredHash: text('desired_hash'),
    status: text().default('pending').notNull(),
    /**
     * Back-reference to the `command` row for the most recent apply attempt on
     * this `(environment, server)`. No FK — mirrors `command.actor_id`. This is
     * the join key from current state into the append-only command history.
     */
    lastCommandId: uuid('last_command_id'),
    /** When the last apply attempt reached a terminal state. */
    finishedAt: timestamp('finished_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** Wall-clock duration of the last apply attempt, in milliseconds. */
    durationMs: integer('duration_ms'),
    /** Terminal outcome of the last apply attempt; NULL until one finishes. */
    outcome: text(),
  },
  (table) => [
    unique('uniq_deployment_environment_server').on(table.environmentId, table.serverId),
    index('idx_deployment_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_deployment_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'deployment_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'deployment_server_id_server_id_fk',
    }).onDelete('restrict'),
    check(
      'deployment_status_check',
      sql`${table.status} IN ('pending','applying','applied','failed','draining')`
    ),
    check(
      'deployment_generation_check',
      sql`${table.desiredGeneration} >= 0 AND (${table.appliedGeneration} IS NULL OR ${table.appliedGeneration} >= 0)`
    ),
    check(
      'deployment_outcome_check',
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('applied','failed','timed_out')`
    ),
  ]
)
/**
 * One scheduled instance of a logical service. Never mint a `service` row per
 * replica — `slot` is 0-based (unlike `container.ordinal` / `replica.ordinal`,
 * which are 1-based). A slot is derived scheduling state: `service_id`
 * CASCADE so deleting a service drops its slots rather than blocking.
 */
export const slot = pgTable(
  'slot',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    environmentId: uuid('environment_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /**
     * Cross-host address on a spanning compose network. One per slot — a
     * service typically joins one spanning network per environment.
     */
    address: inet('address'),
    /** 0-based replica slot (not 1-based like `container.ordinal`). */
    slot: integer().notNull(),
    generation: integer().default(0).notNull(),
    desiredState: text('desired_state').default('running').notNull(),
  },
  (table) => [
    unique('uniq_slot_service_slot').on(table.serviceId, table.slot),
    index('idx_slot_environment_generation').using(
      'btree',
      table.environmentId.asc(),
      table.generation.asc()
    ),
    index('idx_slot_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'slot_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'slot_service_id_service_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'slot_server_id_server_id_fk',
    }).onDelete('restrict'),
    check('slot_slot_nonnegative_check', sql`${table.slot} >= 0`),
    check(
      'slot_desired_state_check',
      sql`${table.desiredState} IN ('running','stopped','removed')`
    ),
  ]
)
/**
 * Cron-style scheduled command on a service. No execution columns (no
 * `last_run_at` / result) and no run-history table this phase.
 */
export const task = pgTable(
  'task',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    serviceId: uuid('service_id').notNull(),
    name: varchar({ length: 255 }).notNull(),
    /** Cron expression. */
    schedule: text().notNull(),
    command: text().notNull(),
    timezone: text(),
    isEnabled: boolean('is_enabled').default(true).notNull(),
    /** `allow` | `forbid` | `replace` */
    concurrencyPolicy: text('concurrency_policy').default('forbid').notNull(),
    timeoutSeconds: integer('timeout_seconds'),
  },
  (table) => [
    unique('uniq_task_service_name').on(table.serviceId, table.name),
    index('idx_task_service_id').using('btree', table.serviceId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'task_service_id_service_id_fk',
    }).onDelete('cascade'),
    check(
      'task_concurrency_policy_check',
      sql`${table.concurrencyPolicy} IN ('allow','forbid','replace')`
    ),
  ]
)
/**
 * Server label source for `placement.constraints` (`node.labels.*`). Org is
 * derived through `server` — no `organization_id`, matching `container`.
 */
export const label = pgTable(
  'label',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    serverId: uuid('server_id').notNull(),
    key: varchar({ length: 255 }).notNull(),
    value: varchar({ length: 255 }).default('').notNull(),
  },
  (table) => [
    unique('uniq_label_server_key').on(table.serverId, table.key),
    index('idx_label_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'label_server_id_server_id_fk',
    }).onDelete('cascade'),
    check(
      'label_key_format_check',
      sql`(char_length((${table.key})::text) >= 1) AND (char_length((${table.key})::text) <= 255) AND ((${table.key})::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'::text)`
    ),
  ]
)
export const hosting = pgTable(
  'hosting',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    serviceId: uuid('service_id').notNull(),
    /** Optional pin into the org TLS library; null = Caddy tls internal (self-signed). */
    tlsId: uuid('tls_id'),
    /** Optional pin to a managed `ip` row for ingress addressing. */
    ipId: uuid('ip_id'),
    name: varchar({ length: 255 }),
    description: varchar('description', { length: 255 }),
  },
  (table) => [
    index('idx_hosting_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_hosting_tls_id').using('btree', table.tlsId.asc().nullsLast().op('uuid_ops')),
    index('idx_hosting_ip_id').using('btree', table.ipId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'hosting_service_id_service_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tlsId],
      foreignColumns: [tls.id],
      name: 'hosting_tls_id_tls_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.ipId],
      foreignColumns: [ip.id],
      name: 'hosting_ip_id_ip_id_fk',
    }).onDelete('set null'),
  ]
)
export const container = pgTable(
  'container',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    serviceId: uuid('service_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /**
     * Docker container id reported by the daemon after deploy. Null between
     * pre-allocation and the daemon's post-`compose up` report.
     */
    containerId: text('container_id'),
    containerName: text('container_name').notNull(),
    status: text('status').default('pending').notNull(),
    /**
     * `role='ingress'` rows always use `ordinal = 1` and are named
     * `<service.id>-in` via `ingressContainerNameFromService` — both the
     * per-service Traefik frontend and the shared per-server ProxySQL
     * managed-ingress frontend. `role='turbopanel'` is the platform
     * `turbopanel-system` compose stack (`database` / `queue`)
     * plus Orchestrator (`-ha`). `role='service'` is the ordinary
     * workload/engine replica. A service may hold N service replicas plus
     * exactly one ingress row.
     */
    role: text().default('service').notNull(),
    composeServiceName: text('compose_service_name').notNull(),
    /**
     * 1-based instance index of this container within its service; managed
     * engines always carry an ordinal. Unique with `service_id` so placement
     * changes re-home the same allocation rather than minting a second row.
     */
    ordinal: integer('ordinal').default(1).notNull(),
  },
  (table) => [
    index('idx_container_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_container_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_container_status').using('btree', table.status.asc().nullsLast().op('text_ops')),
    uniqueIndex('uniq_container_server_container_id')
      .on(table.serverId, table.containerId)
      .where(sql`container_id IS NOT NULL`),
    uniqueIndex('uniq_container_service_role_ordinal').on(
      table.serviceId,
      table.role,
      table.ordinal
    ),
    check('container_ordinal_positive_check', sql`ordinal >= 1`),
    check('container_role_check', sql`role IN ('service', 'ingress', 'turbopanel')`),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'container_service_id_service_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'container_server_id_server_id_fk',
    }).onDelete('restrict'),
  ]
)
/**
 * A principal is an account identity that can be attached to services — a
 * Linux (server) host account or a database engine user. Org is derived through
 * `steward` → `service` (or `project` → `workspace` for project principals);
 * there is deliberately no `organization_id` column here. Host-account username
 * uniqueness is app-enforced per organization (trim + case-insensitive).
 */
export const principal = pgTable(
  'principal',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    /**
     * Holds `home` (`/srv/users/<username>`) plus a mirror of an optional
     * operator `uid`/`gid` override when set — never an instance-allocated id.
     */
    metadata: jsonb(),
    options: jsonb(),

    /** `system` (Linux/server host account) | `database` (engine account) */
    kind: text().notNull(),
    /** `server` | `postgres` | `mysql` | `redis` | `clickhouse` */
    provider: text().notNull(),
    /**
     * Account name. Allowlist mirrors POSIX/database account naming: starts
     * with a letter or underscore, then letters/digits/underscore/hyphen
     * (`^[A-Za-z_][A-Za-z0-9_-]*$`), 1–255 chars. Server principals additionally
     * enforce ≤ 32 at the API layer (daemon username limit).
     */
    username: varchar({ length: 255 }).notNull(),
    /**
     * Login actually applied on the target system (Linux account / engine
     * role). Equal to `username`, or `username` plus a random `_<11 chars>`
     * suffix when the owning organization's randomized-usernames default is
     * on (or the principal is a managed root, which is always suffixed).
     * Decided once at create — toggling the org default never renames
     * existing principals. `username` stays the short internal identity.
     */
    appliedUsername: varchar('applied_username', { length: 255 }).notNull(),
    /**
     * Write-only credential. Stored as a `tpsecret.v<version>.…` envelope (instance
     * at-rest seal). Never returned on GET; delivery re-seals to `tpdaemon`
     * for the target daemon.
     */
    password: text(),
    /** Optional project scope for hosting principals. */
    projectId: uuid('project_id'),
    /** Optional managed-engine scope (cascade-deletes with the managed row). */
    managedId: uuid('managed_id'),
  },
  (table) => [
    index('idx_principal_project_id').using(
      'btree',
      table.projectId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_principal_managed_id').using(
      'btree',
      table.managedId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'principal_project_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'principal_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    check('principal_kind_check', sql`kind IN ('system', 'database')`),
    check(
      'principal_provider_check',
      sql`provider IN ('server', 'postgres', 'mysql', 'redis', 'clickhouse')`
    ),
    check(
      'principal_username_format_check',
      sql`(char_length((username)::text) >= 1) AND (char_length((username)::text) <= 255) AND ((username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text)`
    ),
    check(
      'principal_applied_username_format_check',
      sql`(char_length((applied_username)::text) >= 1) AND (char_length((applied_username)::text) <= 255) AND ((applied_username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text)`
    ),
    // No global unique on `username`: the same account name (e.g. `postgres`,
    // `www-data`) legitimately recurs across different systems/services.
    // Server-provider host accounts are uniqueness-checked per org in app code
    // (both the short `username` and the `applied_username` namespaces).
  ]
)
/**
 * Which runtime series a principal may **execute** on the host.
 *
 * A row here becomes a unix group membership (`tpphp84`, `tpnode24`), because
 * that is the only form the kernel enforces at `execve` — anything derived only
 * into a generated systemd unit or an FPM pool is invisible to a shell session
 * or a cron job, both of which run as the principal.
 *
 * A table rather than `principal.options` jsonb for three reasons:
 * `parsePrincipalOptions` is drop-on-invalid, which is the wrong posture for a
 * security grant; "which principals still hold php 8.1?" has to be answerable
 * before a series can be retired; and per-row provenance is the audit trail.
 *
 * `grantedBy` distinguishes an operator's explicit grant from one deploy-prepare
 * inserted because a service declared the runtime. Both are real grants and both
 * are revocable — the distinction exists so the UI can say why a principal has
 * something, not to make one of them implicit.
 *
 * No `organization_id`: derived through `principal`, matching that table.
 */
export const entitlement = pgTable(
  'entitlement',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    principalId: uuid('principal_id').notNull(),
    runtime: text().notNull(),
    /** Exec boundary (`8.4`, `24`), never a patch pin. */
    series: text().notNull(),
    grantedBy: text('granted_by').default('operator').notNull(),
  },
  (table) => [
    index('idx_entitlement_principal_id').using(
      'btree',
      table.principalId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'entitlement_principal_id_principal_id_fk',
    }).onDelete('cascade'),
    unique('entitlement_unique').on(table.principalId, table.runtime, table.series),
    check('entitlement_runtime_check', sql`${table.runtime} IN ('php', 'node')`),
    check(
      'entitlement_series_check',
      // `[.]` not `\.`: a template literal eats the backslash, and a bare dot
      // would match any character. A character class keeps it literal.
      sql`${table.series} ~ '^[0-9]{1,3}([.][0-9]{1,3})?$'`
    ),
    check('entitlement_granted_by_check', sql`${table.grantedBy} IN ('operator', 'deploy')`),
  ]
)

/**
 * A public key that may authenticate as this principal over SSH.
 *
 * A table rather than `principal.options` jsonb, for the reasons
 * `entitlement` already lists — `parsePrincipalOptions` is
 * drop-on-invalid, which is the wrong posture for a credential — plus one
 * specific to keys: **"which principals does this fingerprint reach?" has to be
 * answerable in one query.** When a laptop is lost the operator has a
 * fingerprint and needs every account it opens, across every project and every
 * server. A blob per principal cannot answer that.
 *
 * `publicKey` holds the **re-rendered** `<type> <base64>` from
 * `parseSshPublicKey`, never the pasted line: an `authorized_keys` entry may
 * legally carry a leading options field (`command="…",no-pty`), and neither
 * honouring nor silently stripping one is acceptable. The comment is split into
 * its own column so the stored key has exactly two fields and cannot grow a
 * third.
 *
 * `fingerprint` is `SHA256:<base64 unpadded>` over the decoded blob — byte
 * identical to `ssh-keygen -lf`, so an operator can compare what the panel
 * shows against what their agent shows.
 *
 * `userId` is **provenance, not ownership**: which org member added the key, so
 * "revoke everything Alice can reach" is one query without inventing a
 * user↔principal join table. Ownership stays with the principal, because
 * `authorized_keys` is a per-account file and the daemon has to render it
 * without resolving org membership. `set null` on user delete — losing who
 * added a key must never silently delete the key.
 *
 * No `organization_id`: derived through `principal`, matching that table.
 */
export const sshKey = pgTable(
  'ssh',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    principalId: uuid('principal_id').notNull(),
    /** Operator-facing label. Not the key comment — that is `comment`. */
    name: varchar({ length: 255 }).notNull(),
    keyType: text('key_type').notNull(),
    /** Canonical `<type> <base64>`, re-rendered from the decoded blob. */
    publicKey: text('public_key').notNull(),
    /** `SHA256:…`, as `ssh-keygen -lf` prints it. */
    fingerprint: text().notNull(),
    /** Sanitized display comment from the pasted line, when it had one. */
    comment: text(),
    /** Org member who added it — audit provenance, not ownership. */
    userId: uuid('user_id'),
    /** RSA modulus size; null for the fixed-size key types. */
    bits: integer(),
  },
  (table) => [
    index('idx_ssh_principal_id').using(
      'btree',
      table.principalId.asc().nullsLast().op('uuid_ops')
    ),
    // The lost-laptop query: every account one fingerprint opens.
    index('idx_ssh_fingerprint').using('btree', table.fingerprint.asc().nullsLast().op('text_ops')),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'ssh_principal_id_principal_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'ssh_user_id_user_id_fk',
    }).onDelete('set null'),
    // Keyed on the fingerprint rather than the key text: the fingerprint is
    // over the decoded bytes, so two spellings of one key collide here as they
    // should.
    unique('ssh_fingerprint_unique').on(table.principalId, table.fingerprint),
    check(
      'ssh_type_check',
      sql`${table.keyType} IN ('ssh-ed25519', 'sk-ssh-ed25519@openssh.com', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ecdsa-sha2-nistp256@openssh.com', 'ssh-rsa')`
    ),
    check('ssh_fingerprint_check', sql`${table.fingerprint} ~ '^SHA256:[A-Za-z0-9+/]{43}$'`),
    // A newline in the stored key would be a second authorized_keys entry. The
    // application parser already refuses one; this is the backstop that makes a
    // bug there unable to reach the file.
    check(
      'ssh_public_key_check',
      sql`${table.publicKey} ~ '^[A-Za-z0-9@.-]+ [A-Za-z0-9+/]+={0,2}$'`
    ),
    check('ssh_name_check', sql`char_length(${table.name}) >= 1`),
  ]
)

/**
 * Join edge: the Linux/system principal that runs as / owns a service (the
 * site tree). Deleting a principal removes its edges (cascade); a service
 * still referenced by principals cannot be deleted (restrict), mirroring
 * `container`'s restrict on `service`. Distinct from `binding`, which injects
 * managed-database credentials into a consumer service.
 */
export const tenancy = pgTable(
  'tenancy',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    principalId: uuid('principal_id').notNull(),
    serviceId: uuid('service_id').notNull(),
  },
  (table) => [
    index('idx_tenancy_principal_id').using(
      'btree',
      table.principalId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_tenancy_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'tenancy_principal_id_principal_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'tenancy_service_id_service_id_fk',
    }).onDelete('restrict'),
    unique('tenancy_principal_service_unique').on(table.principalId, table.serviceId),
  ]
)
/**
 * Join edge: managed-database principal ↔ consuming compose service.
 * Materializes system-owned `variable` rows (marked via `variable.binding_id`)
 * so DB credentials ride the existing deploy injection rail.
 *
 * FK direction: principal CASCADE (user/db gone → drop bindings); service
 * RESTRICT (a service still referenced by bindings cannot be deleted).
 */
export const binding = pgTable(
  'binding',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    principalId: uuid('principal_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    databaseName: varchar('database_name', { length: 255 }).notNull(),
    keyPrefix: varchar('key_prefix', { length: 64 }).default('DATABASE').notNull(),
    /** When true, also emit the unprefixed conventional engine keys (PG* / MYSQL_*). API JSON still serializes as `emitEngineDefaults`. */
    isEmitEngineDefaults: boolean('is_emit_engine_defaults').default(true).notNull(),
  },
  (table) => [
    index('idx_binding_principal_id').using(
      'btree',
      table.principalId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_binding_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'binding_principal_id_principal_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'binding_service_id_service_id_fk',
    }).onDelete('restrict'),
    unique('uniq_binding_service_prefix').on(table.serviceId, table.keyPrefix),
    uniqueIndex('uniq_binding_service_engine_defaults')
      .on(table.serviceId)
      .where(sql`${table.isEmitEngineDefaults}`),
    check(
      'binding_key_prefix_format_check',
      sql`(char_length((key_prefix)::text) >= 1) AND (char_length((key_prefix)::text) <= 64) AND ((key_prefix)::text ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)`
    ),
    check(
      'binding_database_name_format_check',
      sql`(char_length((database_name)::text) >= 1) AND (char_length((database_name)::text) <= 63) AND ((database_name)::text ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)`
    ),
  ]
)
/**
 * Org-owned sealed secret for storage (and later other) providers.
 * `secret_envelope` is one `tpsecret` payload of provider-specific JSON.
 * Transfer / NFS / S3 public CRUD is not in this slice.
 *
 * `git_deploy_key` is the exception to the JSON rule: its sealed plaintext is
 * the OpenSSH private key **verbatim**, because deploy-prep reseals the
 * envelope for the daemon without opening it and the daemon writes what it
 * decrypts straight to a `0600` identity file. Wrapping it in JSON would mean
 * one of the two sides had to parse it, and neither does.
 */
export const secret = pgTable(
  'secret',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    principalId: uuid('principal_id'),
    provider: text().notNull(),
    name: varchar({ length: 255 }).notNull(),
    secretEnvelope: text('secret_envelope').notNull(),
  },
  (table) => [
    index('idx_secret_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_secret_principal_id').using(
      'btree',
      table.principalId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'secret_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'secret_principal_id_principal_id_fk',
    }).onDelete('restrict'),
    check(
      'secret_provider_check',
      sql`provider IN ('s3', 's3_compatible', 'nfs', 'cifs', 'sftp', 'ftp', 'webdav',
        'git_deploy_key')`
    ),
  ]
)
/**
 * Logical identity of persistent data. Physical copies live on `copy`;
 * service attachments live on `mount`. Scope is at most one of workspace /
 * project / environment / service (zero = organization-wide).
 */
export const storage = pgTable(
  'storage',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    workspaceId: uuid('workspace_id'),
    projectId: uuid('project_id'),
    environmentId: uuid('environment_id'),
    serviceId: uuid('service_id'),
    kind: text().notNull(),
    name: varchar({ length: 255 }).notNull(),
    accessMode: text('access_mode').default('single_writer').notNull(),
    retention: text().default('retain').notNull(),
    generation: integer().default(0).notNull(),
    principalId: uuid('principal_id'),
    /** Sealed file content (`tpsecret` or `tpdaemon`) for `kind=file` entries. */
    contentEnvelope: text('content_envelope'),
  },
  (table) => [
    index('idx_storage_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_storage_workspace_id').using(
      'btree',
      table.workspaceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_storage_project_id').using(
      'btree',
      table.projectId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_storage_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_storage_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'storage_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspace.id],
      name: 'storage_workspace_id_workspace_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'storage_project_id_project_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'storage_environment_id_environment_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'storage_service_id_service_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'storage_principal_id_principal_id_fk',
    }).onDelete('restrict'),
    check('storage_kind_check', sql`kind IN ('volume', 'directory', 'file', 'object')`),
    check(
      'storage_access_mode_check',
      sql`access_mode IN ('single_writer', 'multi_reader', 'multi_writer')`
    ),
    check('storage_retention_check', sql`retention IN ('retain', 'delete')`),
    check(
      'storage_at_most_one_parent_check',
      sql`((workspace_id IS NOT NULL)::int +
        (project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int) <= 1`
    ),
    /**
     * Compose auto-register idempotency: one `volume` row per
     * `(environment_id, metadata.composeVolumeKey)` when the key is stamped.
     */
    uniqueIndex('uniq_storage_environment_compose_volume_key')
      .using(
        'btree',
        table.environmentId.asc().nullsLast().op('uuid_ops'),
        sql`(${table.metadata} ->> 'composeVolumeKey')`
      )
      .where(
        sql`kind = 'volume'
          AND environment_id IS NOT NULL
          AND COALESCE(metadata->>'composeVolumeKey', '') <> ''`
      ),
  ]
)
/**
 * One physical copy / materialization of a storage identity. Local docker/path
 * copies pin `server_id`; remote/shared copies leave it null.
 */
export const storageCopy = pgTable(
  'copy',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    storageId: uuid('storage_id').notNull(),
    serverId: uuid('server_id'),
    secretId: uuid('secret_id'),
    provider: text().notNull(),
    role: text().default('primary').notNull(),
    state: text().default('pending').notNull(),
    path: text(),
    endpoint: text(),
    generation: integer().default(0).notNull(),
  },
  (table) => [
    index('idx_copy_storage_id').using('btree', table.storageId.asc().nullsLast().op('uuid_ops')),
    index('idx_copy_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_copy_secret_id').using('btree', table.secretId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.storageId],
      foreignColumns: [storage.id],
      name: 'copy_storage_id_storage_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'copy_server_id_server_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.secretId],
      foreignColumns: [secret.id],
      name: 'copy_secret_id_secret_id_fk',
    }).onDelete('restrict'),
    uniqueIndex('uniq_copy_storage_primary')
      .on(table.storageId)
      .where(sql`${table.role} = 'primary'`),
    uniqueIndex('uniq_copy_storage_server_provider')
      .on(table.storageId, table.serverId, table.provider)
      .where(sql`${table.serverId} IS NOT NULL`),
    check(
      'copy_provider_check',
      sql`provider IN ('docker', 'path', 'block', 'nfs', 'cifs', 's3', 's3_compatible', 'sftp', 'ftp', 'webdav')`
    ),
    check('copy_role_check', sql`role IN ('primary', 'replica', 'scratch', 'archive')`),
    check(
      'copy_state_check',
      sql`state IN ('pending', 'materializing', 'ready', 'syncing', 'stale', 'failed', 'retiring')`
    ),
  ]
)
/**
 * Service attachment of a storage identity at a container destination path.
 */
export const mount = pgTable(
  'mount',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    storageId: uuid('storage_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    destinationPath: text('destination_path').notNull(),
    subpath: text(),
    /** API JSON still serializes as `readOnly`. */
    isReadOnly: boolean('is_read_only').default(false).notNull(),
  },
  (table) => [
    index('idx_mount_storage_id').using('btree', table.storageId.asc().nullsLast().op('uuid_ops')),
    index('idx_mount_service_id').using('btree', table.serviceId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.storageId],
      foreignColumns: [storage.id],
      name: 'mount_storage_id_storage_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'mount_service_id_service_id_fk',
    }).onDelete('restrict'),
    unique('uniq_mount_service_destination').on(table.serviceId, table.destinationPath),
  ]
)
/**
 * Org-owned tag definition. Names are labels (app-enforced uniqueness via the
 * per-org normalized unique index); no DB name-format CHECK.
 */
export const tag = pgTable(
  'tag',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar({ length: 255 }).notNull(),
    description: varchar('description', { length: 255 }),
    color: varchar({ length: 32 }),
  },
  (table) => [
    index('idx_tag_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    uniqueIndex('uniq_tag_organization_name').on(
      table.organizationId,
      sql`lower(btrim((${table.name})::text))`
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'tag_organization_id_organization_id_fk',
    }).onDelete('cascade'),
  ]
)
/**
 * Join edge: one tag applied to exactly one taggable parent. Org is derived
 * through `tag.organization_id` — no `organization_id` column.
 */
export const marker = pgTable(
  'marker',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    tagId: uuid('tag_id').notNull(),
    serverId: uuid('server_id'),
    workspaceId: uuid('workspace_id'),
    projectId: uuid('project_id'),
    environmentId: uuid('environment_id'),
    serviceId: uuid('service_id'),
    datacenterId: uuid('datacenter_id'),
    storageId: uuid('storage_id'),
  },
  (table) => [
    index('idx_marker_tag_id').using('btree', table.tagId.asc().nullsLast().op('uuid_ops')),
    index('idx_marker_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_marker_workspace_id').using(
      'btree',
      table.workspaceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_marker_project_id').using('btree', table.projectId.asc().nullsLast().op('uuid_ops')),
    index('idx_marker_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_marker_service_id').using('btree', table.serviceId.asc().nullsLast().op('uuid_ops')),
    index('idx_marker_datacenter_id').using(
      'btree',
      table.datacenterId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_marker_storage_id').using('btree', table.storageId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.tagId],
      foreignColumns: [tag.id],
      name: 'marker_tag_id_tag_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'marker_server_id_server_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspace.id],
      name: 'marker_workspace_id_workspace_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'marker_project_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'marker_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'marker_service_id_service_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.datacenterId],
      foreignColumns: [datacenter.id],
      name: 'marker_datacenter_id_datacenter_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.storageId],
      foreignColumns: [storage.id],
      name: 'marker_storage_id_storage_id_fk',
    }).onDelete('cascade'),
    uniqueIndex('uniq_marker_server')
      .on(table.tagId, table.serverId)
      .where(sql`${table.serverId} IS NOT NULL`),
    uniqueIndex('uniq_marker_workspace')
      .on(table.tagId, table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    uniqueIndex('uniq_marker_project')
      .on(table.tagId, table.projectId)
      .where(sql`${table.projectId} IS NOT NULL`),
    uniqueIndex('uniq_marker_environment')
      .on(table.tagId, table.environmentId)
      .where(sql`${table.environmentId} IS NOT NULL`),
    uniqueIndex('uniq_marker_service')
      .on(table.tagId, table.serviceId)
      .where(sql`${table.serviceId} IS NOT NULL`),
    uniqueIndex('uniq_marker_datacenter')
      .on(table.tagId, table.datacenterId)
      .where(sql`${table.datacenterId} IS NOT NULL`),
    uniqueIndex('uniq_marker_storage')
      .on(table.tagId, table.storageId)
      .where(sql`${table.storageId} IS NOT NULL`),
    check(
      'marker_exactly_one_parent_check',
      sql`((server_id IS NOT NULL)::int +
        (workspace_id IS NOT NULL)::int +
        (project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int +
        (datacenter_id IS NOT NULL)::int +
        (storage_id IS NOT NULL)::int) = 1`
    ),
  ]
)
/**
 * A registered Git provider application — a GitHub App, or a GitLab OAuth
 * application.
 *
 * Physical table name is the single lower-case word `forge` (repo rule — see
 * `src/lib/db/table-naming.test.ts`); the exported binding is `forge`.
 *
 * **`organization_id` is the scope switch.** `NULL` means instance-wide: an
 * operator registered it once and every organization may connect through it.
 * A non-null value means the row belongs to that organization alone. This is
 * one table rather than a global settings row plus a per-org table, so every
 * resolution site has exactly one place to look.
 *
 * **`webhook_ref` is how a delivery finds its way back here.** Each app is
 * handed its own webhook URL ending in this token, so an inbound delivery names
 * its app before any secret is consulted — see `src/lib/git/resolve-webhook-app.ts`.
 * It is a routing key, not a credential: HMAC (GitHub) or the token compare
 * (GitLab) still authenticates. Being unguessable only keeps the surface from
 * being enumerable.
 *
 * **`base_url` participates in the unique key** because a GitHub App id is
 * unique per origin, not globally — the same numeric id may exist on github.com
 * and on a GitHub Enterprise Server instance. Holding it per app is also what
 * lets one TurboPanel instance talk to several GitLab origins at once.
 *
 * **All sealed material lives in `envelopes`** as `tpsecret` envelopes
 * (`privateKeyEnvelope`, `clientSecretEnvelope`, `webhookSecretEnvelope`),
 * the same shape `connection.oauth_envelope` uses. Nothing sealed is ever
 * returned over the API; summaries report presence only.
 */
export const forge = pgTable(
  'forge',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    /** NULL = instance-wide (any organization may use it); set = owned by that org. */
    organizationId: uuid('organization_id'),
    provider: text().notNull(),
    name: varchar({ length: 255 }).notNull(),
    /** Origin the app lives on; part of the unique key, so never null. */
    baseUrl: text('base_url').notNull(),
    /** Explicit API origin for GitHub Enterprise Server; derived when null. */
    apiUrl: text('api_url'),
    /**
     * Provider-side application id. For GitHub this is the numeric App id that
     * arrives as `X-GitHub-Hook-Installation-Target-ID`; for GitLab it is the
     * OAuth application id.
     */
    externalAppId: text('external_app_id').notNull(),
    /** GitHub App slug, used to build the install URL. */
    appSlug: varchar('app_slug', { length: 255 }),
    clientId: text('client_id'),
    /** GitLab OAuth redirect URI. */
    redirectUri: text('redirect_uri'),
    /**
     * The public origin this app's deliveries were registered against.
     *
     * An instance may publish several URLs, and the provider stores whichever
     * one it was given at registration — GitHub bakes it into
     * `hook_attributes.url` and nothing revisits it. Picking "the first public
     * origin" at read time, as every other consumer does, would show an
     * operator a URL the provider is not actually using. Null on an app
     * registered before the operator was offered the choice.
     */
    webhookOrigin: text('webhook_origin'),
    /**
     * Whether the provider was told this app is publicly installable.
     *
     * Tracks the instance-wide toggle: a **private** GitHub App can only be
     * installed on the account that owns it, so an app meant to serve several
     * organizations has to be public. Recorded because it is decided once, at
     * creation, and can only be changed on the provider's own settings page.
     */
    isPublic: boolean('is_public').default(false).notNull(),
    /**
     * SSH clone identity for a self-hosted host on a non-standard port.
     *
     * Unused by GitHub App sources, which clone over HTTPS with a minted token;
     * these only shape the `ssh://user@host:port/...` URL for the deploy-key and
     * generic-git lanes.
     */
    customGitUser: varchar('custom_git_user', { length: 64 }),
    customGitPort: integer('custom_git_port'),
    /** Last successful reconcile against the provider's own record of the app. */
    syncedAt: timestamp('synced_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /**
     * Sealed material: `{ privateKeyEnvelope?, clientSecretEnvelope?,
     * webhookSecretEnvelope? }`, each a `tpsecret` string.
     */
    envelopes: jsonb().notNull(),
    /** Opaque routing token that appears in this app's webhook URL. */
    webhookRef: varchar('webhook_ref', { length: 64 }).notNull(),
    /**
     * GitLab only: HMAC of the webhook token, so a delivery that arrives on the
     * unscoped path resolves in one indexed lookup instead of a scan.
     */
    webhookTokenHash: text('webhook_token_hash'),
  },
  (table) => [
    index('idx_forge_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_forge_provider').using('btree', table.provider.asc().nullsLast().op('text_ops')),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'forge_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    check('forge_provider_check', sql`provider IN ('github', 'gitlab')`),
    unique('uniq_forge_webhook_ref').on(table.webhookRef),
    unique('uniq_forge_provider_base_external').on(
      table.provider,
      table.baseUrl,
      table.externalAppId
    ),
    unique('uniq_forge_webhook_token_hash').on(table.webhookTokenHash),
  ]
)
/**
 * A Git provider connection granted to one organization.
 *
 * Physical table name is the single lower-case word `connection` (repo rule —
 * see `src/lib/db/table-naming.test.ts`); the exported binding is
 * `gitConnection`.
 *
 * **What "installation" means depends on the provider.** For GitHub it is an
 * App installation and `external_installation_id` is GitHub's numeric id. For
 * GitLab there is no per-repository install: the operator connects one account
 * or group over OAuth, and the id is that account/group's GitLab id.
 *
 * **`forge_id` names the application the grant was made through**, and is what
 * makes a webhook delivery resolvable to exactly one row: an App id alone is
 * shared by every installation of that App, and a GitLab delivery names no
 * connection at all. Without it the only discriminators are provider and
 * external id, which collide across organizations.
 *
 * **No GitHub token columns.** Installation access tokens are minted on demand
 * from the sealed envelopes of the `forge` row this one points at
 * (`src/lib/git/github-app-token.ts`) and are never persisted.
 *
 * **GitLab is the exception, and `oauth_envelope` is why.** OAuth hands out an
 * access + refresh pair and rotates the refresh half on every use, so the pair
 * must be stored or the connection dies at the next deploy. It is held here as
 * jsonb of `tpsecret` envelopes (never plaintext), scoped to
 * `provider = 'gitlab'` — see `src/lib/git/gitlab-oauth-token.ts`.
 */
export const gitConnection = pgTable(
  'connection',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    /** The registered application this connection was granted through. */
    forgeId: uuid('forge_id').notNull(),
    provider: text().notNull(),
    /** Provider-side id: a GitHub App installation, or a GitLab account/group. */
    externalInstallationId: text('external_installation_id').notNull(),
    accountLogin: varchar('account_login', { length: 255 }),
    accountType: text('account_type'),
    /** Set while the provider reports the installation as suspended. */
    suspendedAt: timestamp('suspended_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /**
     * Sealed OAuth token pair for `provider = 'gitlab'` (null for GitHub).
     *
     * `{ accessTokenEnvelope, refreshTokenEnvelope, expiresAt, scope }`, where
     * both envelopes are `tpsecret` strings.
     */
    oauthEnvelope: jsonb('oauth_envelope'),
  },
  (table) => [
    index('idx_connection_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_connection_forge_id').using('btree', table.forgeId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'connection_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.forgeId],
      foreignColumns: [forge.id],
      name: 'connection_forge_id_forge_id_fk',
    }).onDelete('cascade'),
    check('connection_provider_check', sql`provider IN ('github', 'gitlab')`),
    unique('uniq_connection_organization_forge_external').on(
      table.organizationId,
      table.forgeId,
      table.externalInstallationId
    ),
  ]
)
/**
 * A Git repository connected to an organization — exactly one row per
 * repository per organization.
 *
 * The row is a pure org-level registry entry: what attaches it to workloads is
 * `project.repository_id` and the compose `x-turbopanel.source.sourceId`
 * references, never a column here. (It once carried `service_id` /
 * `environment_id` parent columns mirroring `storage`; nothing modern wrote
 * them, and they made a repository look scoped to a workload it merely
 * predated. Dropped rather than deprecated — pre-MVP.)
 *
 * `repository_url` is stored **canonicalized** (`canonicalizeRepositoryUrl` in
 * `src/lib/git/clone-url.ts`: lower-cased host, `.git` suffix, no trailing
 * slash) so the per-organization unique below actually deduplicates spellings
 * of the same repository.
 *
 * `detected_default_branch` / `default_branch_checked_at` /
 * `last_inspected_at` / `last_inspected_commit_sha` are provider-observed
 * facts the instance refreshes over time — real columns rather than
 * `metadata` because every row carries them, not sparse per-repo extras.
 * `metadata` remains for anything genuinely sparse; `options` holds operator
 * policy and trigger state.
 */
export const repository = pgTable(
  'repository',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    /** Provider connection that authorizes clones; null for deploy-key sources. */
    connectionId: uuid('connection_id'),
    /** Deploy key for generic-SSH and deploy-key-authorized GitLab sources. */
    secretId: uuid('secret_id'),
    provider: text().notNull(),
    repositoryUrl: text('repository_url').notNull(),
    /** Provider-side repository/project id (numeric, as text) for webhook matching. */
    repositoryExternalId: text('repository_external_id'),
    defaultBranch: varchar('default_branch', { length: 255 }),
    /** Relative checkout subdirectory; same rule as compose `x-turbopanel.root`. */
    subdirectory: text(),
    autoDeploy: text('auto_deploy').default('disabled').notNull(),
    /** Provider-reported default branch from the most recent refresh/inspect. */
    detectedDefaultBranch: varchar('detected_default_branch', { length: 255 }),
    defaultBranchCheckedAt: timestamp('default_branch_checked_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    lastInspectedAt: timestamp('last_inspected_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    lastInspectedCommitSha: text('last_inspected_commit_sha'),
  },
  (table) => [
    index('idx_repository_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_repository_connection_id').using(
      'btree',
      table.connectionId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_repository_secret_id').using(
      'btree',
      table.secretId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'repository_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [gitConnection.id],
      name: 'repository_connection_id_connection_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.secretId],
      foreignColumns: [secret.id],
      name: 'repository_secret_id_secret_id_fk',
    }).onDelete('set null'),
    /**
     * One repository binds once per organization.
     *
     * `repository_url` is canonicalized before every write, so this holds for
     * every lane — provider-attached and deploy-key/generic-git alike. (The
     * connection-keyed unique below cannot cover the key lanes: their
     * `connection_id` is null and Postgres treats nulls as distinct.) It is
     * also what makes the find-or-create in `POST /repositories` and
     * `POST /repositories/attach` atomic rather than a check-then-insert race.
     */
    unique('uniq_repository_organization_url').on(table.organizationId, table.repositoryUrl),
    /**
     * Same guarantee keyed the way webhooks match: the provider-side repo id
     * survives renames and transfers, which change `repository_url`.
     */
    unique('uniq_repository_organization_connection_repository').on(
      table.organizationId,
      table.connectionId,
      table.repositoryExternalId
    ),
    check('repository_provider_check', sql`provider IN ('github', 'gitlab', 'git')`),
    check(
      'repository_auto_deploy_check',
      sql`auto_deploy IN ('immediate', 'checks_passed', 'disabled')`
    ),
  ]
)
/**
 * Inbound provider-webhook delivery ledger — replay protection only.
 *
 * Physical table name is the single lower-case word `delivery` (repo rule —
 * see `src/lib/db/table-naming.test.ts`); the exported binding keeps the
 * fully-qualified `webhookDelivery` name used across the codebase.
 *
 * **Deliberately org-agnostic.** A delivery id arrives in the request headers
 * before the signature has been checked and long before the payload has been
 * matched to an installation, so there is no organization to scope the row to.
 * The row holds no payload, no secret, and nothing user-visible: it is the
 * provider's delivery id plus the moment it was accepted (`createdAt`), so a
 * redelivered webhook can be answered without re-running its side effects.
 *
 * Rows are pruned by the shared maintenance sweep after
 * `WEBHOOK_DELIVERY_RETENTION_MS` (see `src/lib/db/webhook-delivery-records.ts`)
 * — GitHub retries a failed delivery for hours, not weeks.
 */
export const webhookDelivery = pgTable(
  'delivery',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    /** Moment the delivery was accepted; doubles as the sweep's age cursor. */
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    provider: text().notNull(),
    /** Provider-side delivery id (GitHub `X-GitHub-Delivery`; GitLab's event
     * UUID, else a digest of the body — see `src/lib/git/gitlab-webhook.ts`). */
    externalDeliveryId: text('external_delivery_id').notNull(),
    /** Provider event name (`push`, `check_suite`, …) — tracing only. */
    event: text(),
  },
  (table) => [
    index('idx_delivery_created_at').using('btree', table.createdAt.asc()),
    check('delivery_provider_check', sql`provider IN ('github', 'gitlab')`),
    unique('uniq_delivery_provider_external').on(table.provider, table.externalDeliveryId),
  ]
)
export const grant = pgTable(
  'grant',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    permission: text().notNull(),
  },
  (table) => [
    unique('grant_unique').on(
      table.entityType,
      table.entityId,
      table.actorType,
      table.actorId,
      table.permission
    ),
    index('idx_grant_entity').on(table.entityType, table.entityId),
    index('idx_grant_actor').on(table.actorType, table.actorId),
  ]
)
export const session = pgTable(
  'session',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    userId: uuid('user_id').notNull(),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    token: varchar({ length: 255 }).notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
  },
  (table) => [
    index('idx_session_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'session_user_id_user_id_fk',
    }).onDelete('cascade'),
    unique('session_token_unique').on(table.token),
  ]
)
export const setting = pgTable(
  'setting',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    key: text().notNull(),
    value: jsonb().notNull(),
  },
  (table) => [unique('setting_key_unique').on(table.key)]
)
export const account = pgTable(
  'account',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    userId: uuid('user_id').notNull(),
    providerId: text('provider_id').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    scope: text(),
    password: text(),
  },
  (table) => [
    index('idx_account_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'account_user_id_user_id_fk',
    }).onDelete('cascade'),
  ]
)
export const teammate = pgTable(
  'teammate',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
  },
  (table) => [
    index('idx_teammate_team_id').using('btree', table.teamId.asc().nullsLast().op('uuid_ops')),
    index('idx_teammate_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [team.id],
      name: 'teammate_team_id_team_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'teammate_user_id_user_id_fk',
    }).onDelete('cascade'),
    unique('teammate_team_user_unique').on(table.teamId, table.userId),
  ]
)
export const team = pgTable(
  'team',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar({ length: 255 }),
  },
  (table) => [
    index('idx_team_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'team_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    check(
      'team_name_format_check',
      sql`(name IS NULL) OR ((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255))`
    ),
  ]
)
export const user = pgTable(
  'user',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    name: varchar({ length: 255 }),
    email: varchar({ length: 255 }).notNull(),
    isEmailVerified: boolean('is_email_verified').default(false).notNull(),
    is2FaEnabled: boolean('is_2fa_enabled').default(false).notNull(),
    isDisabled: boolean('is_disabled').default(false).notNull(),
    role: text().default('user').notNull(),
  },
  (table) => [
    unique('user_email_unique').on(table.email),
    check(
      'user_name_format_check',
      sql`(name IS NULL) OR ((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255))`
    ),
  ]
)
export const twoFactor = pgTable(
  '2fa',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    userId: uuid('user_id').notNull(),
    secret: varchar({ length: 255 }).notNull(),
    isVerified: boolean('is_verified').default(true),
    backupCodes: text('backup_codes').notNull(),
  },
  (table) => [
    index('idx_2fa_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: '2fa_user_id_user_id_fk',
    }).onDelete('cascade'),
  ]
)
export const verification = pgTable(
  'verification',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    identifier: varchar({ length: 255 }).notNull(),
    value: text().notNull(),
  },
  (table) => [unique('verification_identifier_unique').on(table.identifier)]
)
/**
 * Append-only history of every topology generation a server has ever
 * reported (stable device/filesystem/GPU/signal identity + a generation
 * counter, pushed by the daemon over the `topology-report` cell message).
 * One row per (server, generation) — never updated in place, so later
 * "resolve historical generation N" query-reconstruction work can replay
 * exactly what the daemon saw at that generation.
 *
 * `snapshot` is the full topology snapshot as reported by the daemon, minus
 * daemon-internal-only fields. jsonb, so no migration for its shape.
 *
 * No pruning/retention logic yet — this table has no partner `options`
 * column (that jsonb-pairing convention only applies to columns literally
 * named `metadata`/`options`; ours is `snapshot`). Future concern: add a
 * retention sweep once history size/growth is understood.
 */
export const topologyGeneration = pgTable(
  'generation',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    serverId: uuid('server_id').notNull(),
    generation: integer().notNull(),
    bootGeneration: integer('boot_generation').notNull(),
    snapshot: jsonb(),
    appliedAt: timestamp('applied_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => [
    unique('uniq_generation_server_generation').on(table.serverId, table.generation),
    index('idx_generation_server_generation').using(
      'btree',
      table.serverId.asc(),
      table.generation.desc()
    ),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'generation_server_id_server_id_fk',
    }).onDelete('cascade'),
  ]
)

/**
 * Append-only history of resolved v5 metrics-capability-plan generations
 * (see `../../daemon/metrics/capability-plan.ts`) — one row per
 * `(server, generation)`, written only when the *resolved* plan for a server
 * actually changes (`plan_hash` differs from the last recorded row), never
 * on every sample. Mirrors `topologyGeneration`'s shape/spirit, scoped to
 * capability-plan config instead of daemon-reported topology.
 *
 * `plan` is the full resolved `MetricsCapabilityPlanV5` snapshot, stored for
 * audit/debugging; `plan_hash` is the cheap "did it change" comparison key.
 * jsonb, so no migration for the plan shape.
 *
 * No pruning/retention logic yet — same future concern as `topologyGeneration`.
 */
export const capabilityPlanGeneration = pgTable(
  'capability',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    serverId: uuid('server_id').notNull(),
    generation: integer().notNull(),
    planHash: text('plan_hash').notNull(),
    plan: jsonb(),
    appliedAt: timestamp('applied_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => [
    unique('uniq_capability_server_generation').on(table.serverId, table.generation),
    index('idx_capability_server_generation').using(
      'btree',
      table.serverId.asc(),
      table.generation.desc()
    ),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'capability_server_id_server_id_fk',
    }).onDelete('cascade'),
  ]
)
