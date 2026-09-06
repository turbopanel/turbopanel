CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp(3) with time zone,
	"refresh_token_expires_at" timestamp(3) with time zone,
	"scope" text,
	"password" text
);
--> statement-breakpoint
CREATE TABLE "binding" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"principal_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"database_name" varchar(255) NOT NULL,
	"key_prefix" varchar(64) DEFAULT 'DATABASE' NOT NULL,
	"is_emit_engine_defaults" boolean DEFAULT true NOT NULL,
	CONSTRAINT "uniq_binding_service_prefix" UNIQUE("service_id","key_prefix"),
	CONSTRAINT "binding_key_prefix_format_check" CHECK ((char_length((key_prefix)::text) >= 1) AND (char_length((key_prefix)::text) <= 64) AND ((key_prefix)::text ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)),
	CONSTRAINT "binding_database_name_format_check" CHECK ((char_length((database_name)::text) >= 1) AND (char_length((database_name)::text) <= 63) AND ((database_name)::text ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text))
);
--> statement-breakpoint
CREATE TABLE "capability" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"plan_hash" text NOT NULL,
	"plan" jsonb,
	"applied_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "uniq_capability_server_generation" UNIQUE("server_id","generation")
);
--> statement-breakpoint
CREATE TABLE "changeover" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"from_ca_generation" integer DEFAULT 0 NOT NULL,
	"to_ca_generation" integer DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp(3) with time zone,
	"results" jsonb DEFAULT '[]'::jsonb,
	CONSTRAINT "changeover_state_check" CHECK ("changeover"."state" IN ('in_progress','awaiting_retire','completed','failed'))
);
--> statement-breakpoint
CREATE TABLE "command" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"server_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"context" jsonb,
	"result_summary" jsonb,
	"error_code" text,
	"error_message" text,
	"queued_at" timestamp(3) with time zone,
	"dispatch_started_at" timestamp(3) with time zone,
	"sent_at" timestamp(3) with time zone,
	"acked_at" timestamp(3) with time zone,
	"started_at" timestamp(3) with time zone,
	"finished_at" timestamp(3) with time zone,
	"expires_at" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE TABLE "container" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"service_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"container_id" text,
	"container_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"role" text DEFAULT 'service' NOT NULL,
	"compose_service_name" text NOT NULL,
	"ordinal" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "container_ordinal_positive_check" CHECK (ordinal >= 1),
	CONSTRAINT "container_role_check" CHECK (role IN ('service', 'ingress', 'turbopanel'))
);
--> statement-breakpoint
CREATE TABLE "datacenter" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"name" varchar(255),
	"description" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "deployment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"environment_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"desired_generation" integer DEFAULT 0 NOT NULL,
	"applied_generation" integer,
	"desired_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_command_id" uuid,
	"finished_at" timestamp(3) with time zone,
	"duration_ms" integer,
	"outcome" text,
	CONSTRAINT "uniq_deployment_environment_server" UNIQUE("environment_id","server_id"),
	CONSTRAINT "deployment_status_check" CHECK ("deployment"."status" IN ('pending','applying','applied','failed','draining')),
	CONSTRAINT "deployment_generation_check" CHECK ("deployment"."desired_generation" >= 0 AND ("deployment"."applied_generation" IS NULL OR "deployment"."applied_generation" >= 0)),
	CONSTRAINT "deployment_outcome_check" CHECK ("deployment"."outcome" IS NULL OR "deployment"."outcome" IN ('applied','failed','timed_out'))
);
--> statement-breakpoint
CREATE TABLE "dispatch" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE TABLE "entitlement" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"principal_id" uuid NOT NULL,
	"runtime" text NOT NULL,
	"series" text NOT NULL,
	"granted_by" text DEFAULT 'operator' NOT NULL,
	CONSTRAINT "entitlement_unique" UNIQUE("principal_id","runtime","series"),
	CONSTRAINT "entitlement_runtime_check" CHECK ("entitlement"."runtime" IN ('php', 'node')),
	CONSTRAINT "entitlement_series_check" CHECK ("entitlement"."series" ~ '^[0-9]{1,3}([.][0-9]{1,3})?$'),
	CONSTRAINT "entitlement_granted_by_check" CHECK ("entitlement"."granted_by" IN ('operator', 'deploy'))
);
--> statement-breakpoint
CREATE TABLE "environment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"project_id" uuid NOT NULL,
	"server_id" uuid,
	"generation" integer DEFAULT 0 NOT NULL,
	"name" varchar(255),
	"description" varchar(255),
	CONSTRAINT "environment_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._/-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "fabric" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"cidr" "cidr" NOT NULL,
	"name" varchar(255),
	CONSTRAINT "fabric_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "forge" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid,
	"provider" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"base_url" text NOT NULL,
	"api_url" text,
	"external_app_id" text NOT NULL,
	"app_slug" varchar(255),
	"client_id" text,
	"redirect_uri" text,
	"webhook_origin" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"custom_git_user" varchar(64),
	"custom_git_port" integer,
	"synced_at" timestamp(3) with time zone,
	"envelopes" jsonb NOT NULL,
	"webhook_ref" varchar(64) NOT NULL,
	"webhook_token_hash" text,
	CONSTRAINT "uniq_forge_webhook_ref" UNIQUE("webhook_ref"),
	CONSTRAINT "uniq_forge_provider_base_external" UNIQUE("provider","base_url","external_app_id"),
	CONSTRAINT "uniq_forge_webhook_token_hash" UNIQUE("webhook_token_hash"),
	CONSTRAINT "forge_provider_check" CHECK (provider IN ('github', 'gitlab'))
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"forge_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_installation_id" text NOT NULL,
	"account_login" varchar(255),
	"account_type" text,
	"suspended_at" timestamp(3) with time zone,
	"oauth_envelope" jsonb,
	CONSTRAINT "uniq_connection_organization_forge_external" UNIQUE("organization_id","forge_id","external_installation_id"),
	CONSTRAINT "connection_provider_check" CHECK (provider IN ('github', 'gitlab'))
);
--> statement-breakpoint
CREATE TABLE "grant" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "grant_unique" UNIQUE("entity_type","entity_id","actor_type","actor_id","permission")
);
--> statement-breakpoint
CREATE TABLE "hosting" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"service_id" uuid NOT NULL,
	"tls_id" uuid,
	"ip_id" uuid,
	"name" varchar(255),
	"description" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"email" varchar(255) NOT NULL,
	"status" varchar(255) NOT NULL,
	"grants" jsonb
);
--> statement-breakpoint
CREATE TABLE "ip" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"datacenter_id" uuid,
	"network_id" uuid,
	"server_id" uuid,
	"address" "inet" NOT NULL,
	"allocation" text NOT NULL,
	"scope" text NOT NULL,
	"description" varchar(255),
	CONSTRAINT "ip_allocation_check" CHECK (allocation IN ('dedicated', 'shared')),
	CONSTRAINT "ip_scope_check" CHECK (scope IN ('public', 'datacenter')),
	CONSTRAINT "ip_datacenter_scope_check" CHECK (("ip"."scope" <> 'datacenter') OR ("ip"."datacenter_id" IS NOT NULL)),
	CONSTRAINT "ip_datacenter_anchor_check" CHECK ((
        "ip"."datacenter_id" IS NULL OR
        ("ip"."server_id" IS NULL AND "ip"."network_id" IS NULL) OR
        "ip"."server_id" IS NOT NULL
      )),
	CONSTRAINT "ip_datacenter_member_network_check" CHECK ((
        "ip"."scope" <> 'datacenter' OR
        "ip"."server_id" IS NULL OR
        "ip"."network_id" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "label" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" varchar(255) DEFAULT '' NOT NULL,
	CONSTRAINT "uniq_label_server_key" UNIQUE("server_id","key"),
	CONSTRAINT "label_key_format_check" CHECK ((char_length(("label"."key")::text) >= 1) AND (char_length(("label"."key")::text) <= 255) AND (("label"."key")::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'::text))
);
--> statement-breakpoint
CREATE TABLE "leaf" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"managed_id" uuid,
	"replica_id" uuid,
	"ca_id" uuid NOT NULL,
	"ca_generation" integer NOT NULL,
	"not_after" timestamp(3) with time zone NOT NULL,
	"issued_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leaf_kind_check" CHECK ("leaf"."kind" IN ('ingress','engine')),
	CONSTRAINT "leaf_kind_keys_check" CHECK ((
        ("leaf"."kind" = 'ingress' AND "leaf"."replica_id" IS NULL AND "leaf"."managed_id" IS NULL)
        OR
        ("leaf"."kind" = 'engine' AND "leaf"."replica_id" IS NOT NULL AND "leaf"."managed_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "license" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid,
	"name" varchar(255),
	"token" text NOT NULL,
	"revoked_at" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE TABLE "managed" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"environment_id" uuid NOT NULL,
	"server_id" uuid,
	"name" varchar(255),
	"engine" text,
	"status" text,
	CONSTRAINT "managed_name_format_check" CHECK (("managed"."name" IS NULL) OR (((char_length(("managed"."name")::text) >= 1) AND (char_length(("managed"."name")::text) <= 255)) AND (("managed"."name")::text ~ '^[A-Za-z0-9 ._-]+$'::text))),
	CONSTRAINT "managed_status_check" CHECK (status IS NULL OR status IN ('provisioning','applying','ready','stopped','failed'))
);
--> statement-breakpoint
CREATE TABLE "marker" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tag_id" uuid NOT NULL,
	"server_id" uuid,
	"workspace_id" uuid,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"datacenter_id" uuid,
	"storage_id" uuid,
	CONSTRAINT "marker_exactly_one_parent_check" CHECK (((server_id IS NOT NULL)::int +
        (workspace_id IS NOT NULL)::int +
        (project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int +
        (datacenter_id IS NOT NULL)::int +
        (storage_id IS NOT NULL)::int) = 1)
);
--> statement-breakpoint
CREATE TABLE "monitor" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"username" varchar(64) NOT NULL,
	"secret_envelope" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mount" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"storage_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"destination_path" text NOT NULL,
	"subpath" text,
	"is_read_only" boolean DEFAULT false NOT NULL,
	CONSTRAINT "uniq_mount_service_destination" UNIQUE("service_id","destination_path")
);
--> statement-breakpoint
CREATE TABLE "network" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"datacenter_id" uuid,
	"server_id" uuid,
	"environment_id" uuid,
	"kind" text NOT NULL,
	"cidr" "cidr",
	"name" varchar(255),
	CONSTRAINT "network_kind_check" CHECK (kind IN ('datacenter', 'docker', 'compose', 'managed')),
	CONSTRAINT "network_single_scope_check" CHECK ((
        ("network"."kind" = 'datacenter' AND "network"."datacenter_id" IS NOT NULL AND "network"."server_id" IS NULL AND "network"."environment_id" IS NULL AND "network"."cidr" IS NOT NULL) OR
        ("network"."kind" = 'docker' AND "network"."datacenter_id" IS NULL AND "network"."environment_id" IS NULL) OR
        ("network"."kind" = 'compose' AND "network"."datacenter_id" IS NULL AND "network"."server_id" IS NULL) OR
        ("network"."kind" = 'managed' AND "network"."datacenter_id" IS NULL AND "network"."server_id" IS NULL AND "network"."environment_id" IS NULL AND "network"."cidr" IS NULL)
      )),
	CONSTRAINT "network_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"name" varchar(255),
	"slug" varchar(255),
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"aaguid" text,
	"name" varchar(255),
	"public_key" text NOT NULL,
	"credential_id" varchar(255) NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"device_type" varchar(32) NOT NULL,
	"is_backed_up" boolean NOT NULL,
	"transports" text
);
--> statement-breakpoint
CREATE TABLE "principal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"username" varchar(255) NOT NULL,
	"applied_username" varchar(255) NOT NULL,
	"password" text,
	"project_id" uuid,
	"managed_id" uuid,
	CONSTRAINT "principal_kind_check" CHECK (kind IN ('system', 'database')),
	CONSTRAINT "principal_provider_check" CHECK (provider IN ('server', 'postgres', 'mysql', 'redis', 'clickhouse')),
	CONSTRAINT "principal_username_format_check" CHECK ((char_length((username)::text) >= 1) AND (char_length((username)::text) <= 255) AND ((username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text)),
	CONSTRAINT "principal_applied_username_format_check" CHECK ((char_length((applied_username)::text) >= 1) AND (char_length((applied_username)::text) <= 255) AND ((applied_username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text))
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"workspace_id" uuid NOT NULL,
	"repository_id" uuid,
	"name" varchar(255),
	"description" varchar(255),
	CONSTRAINT "project_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._/-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "recovery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"managed_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_primary_member_id" uuid NOT NULL,
	"target_member_id" uuid,
	"state" text NOT NULL,
	"started_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp(3) with time zone,
	CONSTRAINT "recovery_kind_check" CHECK ("recovery"."kind" IN ('automatic-failover','switchover','disaster-recovery')),
	CONSTRAINT "recovery_state_check" CHECK ("recovery"."state" IN ('detecting','fencing','promoting','repointing','reconciling-ingress','verifying','completed','failed','blocked'))
);
--> statement-breakpoint
CREATE TABLE "relay" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"fabric_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"address" "inet" NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"keepalive" integer,
	"endpoint_address" "inet",
	"public_key" text,
	"prefix" "cidr" NOT NULL,
	"advertised_cidrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preshared_key" text,
	CONSTRAINT "relay_fabric_server_unique" UNIQUE("fabric_id","server_id"),
	CONSTRAINT "uniq_relay_fabric_address" UNIQUE("fabric_id","address"),
	CONSTRAINT "uniq_relay_fabric_public_key" UNIQUE("fabric_id","public_key"),
	CONSTRAINT "relay_role_check" CHECK (role IN ('gateway', 'member')),
	CONSTRAINT "relay_keepalive_check" CHECK ("relay"."keepalive" IS NULL OR ("relay"."keepalive" BETWEEN 1 AND 65535)),
	CONSTRAINT "relay_member_advertised_cidrs_empty_check" CHECK ("relay"."role" <> 'member' OR "relay"."advertised_cidrs" = '[]'::jsonb)
);
--> statement-breakpoint
CREATE TABLE "replica" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"managed_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL,
	"replica_class" text,
	"is_read_eligible" boolean DEFAULT false NOT NULL,
	"ordinal" integer DEFAULT 1 NOT NULL,
	"replication_transport" text,
	"private_port" integer,
	"status" text,
	CONSTRAINT "uniq_replica_managed_ordinal" UNIQUE("managed_id","ordinal"),
	CONSTRAINT "uniq_replica_managed_server" UNIQUE("managed_id","server_id"),
	CONSTRAINT "replica_role_check" CHECK ("replica"."role" IN ('primary','replica')),
	CONSTRAINT "replica_replica_class_check" CHECK ("replica"."replica_class" IS NULL OR "replica"."replica_class" IN ('failover','read')),
	CONSTRAINT "replica_ordinal_positive_check" CHECK ("replica"."ordinal" >= 1),
	CONSTRAINT "replica_transport_check" CHECK ("replica"."replication_transport" IS NULL OR "replica"."replication_transport" IN ('local','fabric','datacenter','public')),
	CONSTRAINT "replica_status_check" CHECK (status IS NULL OR status IN ('provisioning','applying','ready','stopped','failed','needs_resync'))
);
--> statement-breakpoint
CREATE TABLE "repository" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid,
	"secret_id" uuid,
	"provider" text NOT NULL,
	"repository_url" text NOT NULL,
	"repository_external_id" text,
	"default_branch" varchar(255),
	"subdirectory" text,
	"auto_deploy" text DEFAULT 'disabled' NOT NULL,
	"detected_default_branch" varchar(255),
	"default_branch_checked_at" timestamp(3) with time zone,
	"last_inspected_at" timestamp(3) with time zone,
	"last_inspected_commit_sha" text,
	CONSTRAINT "uniq_repository_organization_url" UNIQUE("organization_id","repository_url"),
	CONSTRAINT "uniq_repository_organization_connection_repository" UNIQUE("organization_id","connection_id","repository_external_id"),
	CONSTRAINT "repository_provider_check" CHECK (provider IN ('github', 'gitlab', 'git')),
	CONSTRAINT "repository_auto_deploy_check" CHECK (auto_deploy IN ('immediate', 'checks_passed', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "secret" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"principal_id" uuid,
	"provider" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"secret_envelope" text NOT NULL,
	CONSTRAINT "secret_provider_check" CHECK (provider IN ('s3', 's3_compatible', 'nfs', 'cifs', 'sftp', 'ftp', 'webdav',
        'git_deploy_key'))
);
--> statement-breakpoint
CREATE TABLE "server" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid,
	"name" varchar(255),
	"hostname" varchar(255),
	"machine_key" text,
	"os_id" varchar(255),
	"os_family" varchar(32),
	"os_version" varchar(64),
	"os_codename" varchar(64),
	"os_pretty_name" varchar(255),
	"os_architecture" varchar(64),
	"timezone" varchar(64),
	"is_time_sync_enabled" boolean,
	"ntp_servers" jsonb,
	"ntp_last_synced_at" timestamp(3) with time zone,
	"is_connected" boolean DEFAULT false NOT NULL,
	"status_changed_at" timestamp(3) with time zone,
	"daemon" jsonb
);
--> statement-breakpoint
CREATE TABLE "service" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"environment_id" uuid NOT NULL,
	"name" varchar(255),
	"description" varchar(255),
	"compose_service_name" varchar(255) NOT NULL,
	CONSTRAINT "service_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"token" varchar(255) NOT NULL,
	"ip_address" varchar(45),
	"user_agent" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "setting" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "setting_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "slot" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"environment_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"address" "inet",
	"slot" integer NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"desired_state" text DEFAULT 'running' NOT NULL,
	CONSTRAINT "uniq_slot_service_slot" UNIQUE("service_id","slot"),
	CONSTRAINT "slot_slot_nonnegative_check" CHECK ("slot"."slot" >= 0),
	CONSTRAINT "slot_desired_state_check" CHECK ("slot"."desired_state" IN ('running','stopped','removed'))
);
--> statement-breakpoint
CREATE TABLE "ssh" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"principal_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"key_type" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"comment" text,
	"user_id" uuid,
	"bits" integer,
	CONSTRAINT "ssh_fingerprint_unique" UNIQUE("principal_id","fingerprint"),
	CONSTRAINT "ssh_type_check" CHECK ("ssh"."key_type" IN ('ssh-ed25519', 'sk-ssh-ed25519@openssh.com', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ecdsa-sha2-nistp256@openssh.com', 'ssh-rsa')),
	CONSTRAINT "ssh_fingerprint_check" CHECK ("ssh"."fingerprint" ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
	CONSTRAINT "ssh_public_key_check" CHECK ("ssh"."public_key" ~ '^[A-Za-z0-9@.-]+ [A-Za-z0-9+/]+={0,2}$'),
	CONSTRAINT "ssh_name_check" CHECK (char_length("ssh"."name") >= 1)
);
--> statement-breakpoint
CREATE TABLE "storage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"kind" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"access_mode" text DEFAULT 'single_writer' NOT NULL,
	"retention" text DEFAULT 'retain' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"principal_id" uuid,
	"content_envelope" text,
	CONSTRAINT "storage_kind_check" CHECK (kind IN ('volume', 'directory', 'file', 'object')),
	CONSTRAINT "storage_access_mode_check" CHECK (access_mode IN ('single_writer', 'multi_reader', 'multi_writer')),
	CONSTRAINT "storage_retention_check" CHECK (retention IN ('retain', 'delete')),
	CONSTRAINT "storage_at_most_one_parent_check" CHECK (((workspace_id IS NOT NULL)::int +
        (project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int) <= 1)
);
--> statement-breakpoint
CREATE TABLE "copy" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"storage_id" uuid NOT NULL,
	"server_id" uuid,
	"secret_id" uuid,
	"provider" text NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"path" text,
	"endpoint" text,
	"generation" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "copy_provider_check" CHECK (provider IN ('docker', 'path', 'block', 'nfs', 'cifs', 's3', 's3_compatible', 'sftp', 'ftp', 'webdav')),
	CONSTRAINT "copy_role_check" CHECK (role IN ('primary', 'replica', 'scratch', 'archive')),
	CONSTRAINT "copy_state_check" CHECK (state IN ('pending', 'materializing', 'ready', 'syncing', 'stale', 'failed', 'retiring'))
);
--> statement-breakpoint
CREATE TABLE "subnet" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"network_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"cidr" "cidr" NOT NULL,
	CONSTRAINT "subnet_network_server_unique" UNIQUE("network_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" varchar(255),
	"color" varchar(32)
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"service_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"schedule" text NOT NULL,
	"command" text NOT NULL,
	"timezone" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"concurrency_policy" text DEFAULT 'forbid' NOT NULL,
	"timeout_seconds" integer,
	CONSTRAINT "uniq_task_service_name" UNIQUE("service_id","name"),
	CONSTRAINT "task_concurrency_policy_check" CHECK ("task"."concurrency_policy" IN ('allow','forbid','replace'))
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"name" varchar(255),
	CONSTRAINT "team_name_format_check" CHECK ((name IS NULL) OR ((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)))
);
--> statement-breakpoint
CREATE TABLE "teammate" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "teammate_team_user_unique" UNIQUE("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tenancy" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"principal_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	CONSTRAINT "tenancy_principal_service_unique" UNIQUE("principal_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "tls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"name" varchar(255),
	"source" text NOT NULL,
	"certificate_pem" text,
	"private_key_pem" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"not_after" timestamp(3) with time zone,
	"fingerprint_sha256" text,
	"ca_state" text,
	"ca_generation" integer,
	CONSTRAINT "tls_source_check" CHECK (source IN ('upload', 'lets_encrypt', 'self_signed', 'organization_ca')),
	CONSTRAINT "tls_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))),
	CONSTRAINT "tls_ca_state_check" CHECK (ca_state IS NULL OR ca_state IN ('active', 'retired', 'revoked')),
	CONSTRAINT "tls_ca_lifecycle_source_check" CHECK ((source = 'organization_ca' AND ca_state IS NOT NULL) OR (source <> 'organization_ca' AND ca_state IS NULL AND ca_generation IS NULL)),
	CONSTRAINT "tls_ca_generation_source_check" CHECK (ca_generation IS NULL OR source = 'organization_ca'),
	CONSTRAINT "tls_ca_generation_required_check" CHECK (ca_state IS NULL OR ca_state = 'revoked' OR ca_generation IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "generation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"boot_generation" integer NOT NULL,
	"snapshot" jsonb,
	"applied_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "uniq_generation_server_generation" UNIQUE("server_id","generation")
);
--> statement-breakpoint
CREATE TABLE "2fa" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" varchar(255) NOT NULL,
	"is_verified" boolean DEFAULT true,
	"backup_codes" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"name" varchar(255),
	"email" varchar(255) NOT NULL,
	"is_email_verified" boolean DEFAULT false NOT NULL,
	"is_2fa_enabled" boolean DEFAULT false NOT NULL,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_name_format_check" CHECK ((name IS NULL) OR ((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)))
);
--> statement-breakpoint
CREATE TABLE "variable" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"workspace_id" uuid,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"hosting_id" uuid,
	"server_id" uuid,
	"binding_id" uuid,
	"key" varchar(255) NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"is_literal" boolean DEFAULT false NOT NULL,
	"is_for_build" boolean DEFAULT false NOT NULL,
	"is_for_runtime" boolean DEFAULT true NOT NULL,
	"description" varchar(255),
	CONSTRAINT "variable_exactly_one_parent_check" CHECK (((organization_id IS NOT NULL)::int +
        (workspace_id IS NOT NULL)::int +
        (project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int +
        (hosting_id IS NOT NULL)::int +
        (server_id IS NOT NULL)::int) = 1),
	CONSTRAINT "variable_key_format_check" CHECK ((char_length(key) >= 1) AND (char_length(key) <= 255) AND (key ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text))
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"identifier" varchar(255) NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "verification_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "delivery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"external_delivery_id" text NOT NULL,
	"event" text,
	CONSTRAINT "uniq_delivery_provider_external" UNIQUE("provider","external_delivery_id"),
	CONSTRAINT "delivery_provider_check" CHECK (provider IN ('github', 'gitlab'))
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(255),
	"description" varchar(255),
	"kind" varchar(32) DEFAULT 'user' NOT NULL,
	CONSTRAINT "workspace_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))),
	CONSTRAINT "workspace_kind_check" CHECK (kind IN ('user', 'turbopanel'))
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding" ADD CONSTRAINT "binding_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding" ADD CONSTRAINT "binding_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability" ADD CONSTRAINT "capability_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changeover" ADD CONSTRAINT "changeover_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command" ADD CONSTRAINT "command_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container" ADD CONSTRAINT "container_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container" ADD CONSTRAINT "container_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datacenter" ADD CONSTRAINT "datacenter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_command_id_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."command"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fabric" ADD CONSTRAINT "fabric_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge" ADD CONSTRAINT "forge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_forge_id_forge_id_fk" FOREIGN KEY ("forge_id") REFERENCES "public"."forge"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_tls_id_tls_id_fk" FOREIGN KEY ("tls_id") REFERENCES "public"."tls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_ip_id_ip_id_fk" FOREIGN KEY ("ip_id") REFERENCES "public"."ip"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_network_id_network_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."network"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label" ADD CONSTRAINT "label_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_replica_id_replica_id_fk" FOREIGN KEY ("replica_id") REFERENCES "public"."replica"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_ca_id_tls_id_fk" FOREIGN KEY ("ca_id") REFERENCES "public"."tls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_storage_id_storage_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mount" ADD CONSTRAINT "mount_storage_id_storage_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mount" ADD CONSTRAINT "mount_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery" ADD CONSTRAINT "recovery_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay" ADD CONSTRAINT "relay_fabric_id_fabric_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."fabric"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay" ADD CONSTRAINT "relay_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replica" ADD CONSTRAINT "replica_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replica" ADD CONSTRAINT "replica_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot" ADD CONSTRAINT "slot_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot" ADD CONSTRAINT "slot_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot" ADD CONSTRAINT "slot_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh" ADD CONSTRAINT "ssh_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh" ADD CONSTRAINT "ssh_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy" ADD CONSTRAINT "copy_storage_id_storage_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy" ADD CONSTRAINT "copy_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy" ADD CONSTRAINT "copy_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subnet" ADD CONSTRAINT "subnet_network_id_network_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."network"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subnet" ADD CONSTRAINT "subnet_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate" ADD CONSTRAINT "teammate_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate" ADD CONSTRAINT "teammate_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy" ADD CONSTRAINT "tenancy_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy" ADD CONSTRAINT "tenancy_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls" ADD CONSTRAINT "tls_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation" ADD CONSTRAINT "generation_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "2fa" ADD CONSTRAINT "2fa_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_hosting_id_hosting_id_fk" FOREIGN KEY ("hosting_id") REFERENCES "public"."hosting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_binding_id_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."binding"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_user_id" ON "account" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_binding_principal_id" ON "binding" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_binding_service_id" ON "binding" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_binding_service_engine_defaults" ON "binding" USING btree ("service_id") WHERE "binding"."is_emit_engine_defaults";--> statement-breakpoint
CREATE INDEX "idx_capability_server_generation" ON "capability" USING btree ("server_id","generation" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_changeover_organization_id" ON "changeover" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_changeover_inflight_organization" ON "changeover" USING btree ("organization_id") WHERE "changeover"."state" = 'in_progress';--> statement-breakpoint
CREATE INDEX "idx_command_server_id_created_at" ON "command" USING btree ("server_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_command_status" ON "command" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_command_deploy_environment_created" ON "command" USING btree (((context ->> 'environmentId')),"created_at" DESC NULLS LAST) WHERE name = 'environment.deploy';--> statement-breakpoint
CREATE INDEX "idx_container_service_id" ON "container" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_container_server_id" ON "container" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_container_status" ON "container" USING btree ("status" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_container_server_container_id" ON "container" USING btree ("server_id","container_id") WHERE container_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_container_service_role_ordinal" ON "container" USING btree ("service_id","role","ordinal");--> statement-breakpoint
CREATE INDEX "idx_datacenter_organization_id" ON "datacenter" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_deployment_environment_id" ON "deployment" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_deployment_server_id" ON "deployment" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_dispatch_expires_at" ON "dispatch" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_entitlement_principal_id" ON "entitlement" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_environment_project_id" ON "environment" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_environment_server_id" ON "environment" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fabric_organization_id" ON "fabric" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_fabric_organization_id" ON "fabric" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_forge_organization_id" ON "forge" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_forge_provider" ON "forge" USING btree ("provider" text_ops);--> statement-breakpoint
CREATE INDEX "idx_connection_organization_id" ON "connection" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_connection_forge_id" ON "connection" USING btree ("forge_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_grant_entity" ON "grant" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_grant_actor" ON "grant" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "idx_hosting_service_id" ON "hosting" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_hosting_tls_id" ON "hosting" USING btree ("tls_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_hosting_ip_id" ON "hosting" USING btree ("ip_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_invitation_email" ON "invitation" USING btree ("email" text_ops);--> statement-breakpoint
CREATE INDEX "idx_invitation_user_id" ON "invitation" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_invitation_team_id" ON "invitation" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_organization_id" ON "ip" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_datacenter_id" ON "ip" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_network_id" ON "ip" USING btree ("network_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_server_id" ON "ip" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_scope_server_datacenter" ON "ip" USING btree ("scope" text_ops,"server_id" uuid_ops,"datacenter_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ip_org_address" ON "ip" USING btree ("organization_id","address");--> statement-breakpoint
CREATE INDEX "idx_label_server_id" ON "label" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_leaf_not_after" ON "leaf" USING btree ("not_after" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_leaf_organization_id" ON "leaf" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_leaf_ingress_server" ON "leaf" USING btree ("server_id") WHERE "leaf"."kind" = 'ingress';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_leaf_engine_replica" ON "leaf" USING btree ("replica_id") WHERE "leaf"."kind" = 'engine';--> statement-breakpoint
CREATE INDEX "idx_license_organization_id" ON "license" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_license_server_id" ON "license" USING btree ("server_id") WHERE "license"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_managed_environment_id" ON "managed" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_managed_server_id" ON "managed" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_managed_engine" ON "managed" USING btree ("engine" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "managed_environment_id_unique" ON "managed" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "idx_marker_tag_id" ON "marker" USING btree ("tag_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_server_id" ON "marker" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_workspace_id" ON "marker" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_project_id" ON "marker" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_environment_id" ON "marker" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_service_id" ON "marker" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_datacenter_id" ON "marker" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_storage_id" ON "marker" USING btree ("storage_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_server" ON "marker" USING btree ("tag_id","server_id") WHERE "marker"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_workspace" ON "marker" USING btree ("tag_id","workspace_id") WHERE "marker"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_project" ON "marker" USING btree ("tag_id","project_id") WHERE "marker"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_environment" ON "marker" USING btree ("tag_id","environment_id") WHERE "marker"."environment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_service" ON "marker" USING btree ("tag_id","service_id") WHERE "marker"."service_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_datacenter" ON "marker" USING btree ("tag_id","datacenter_id") WHERE "marker"."datacenter_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_storage" ON "marker" USING btree ("tag_id","storage_id") WHERE "marker"."storage_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_monitor_server" ON "monitor" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_mount_storage_id" ON "mount" USING btree ("storage_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_mount_service_id" ON "mount" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_server_id" ON "network" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_organization_id" ON "network" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_datacenter_id" ON "network" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_environment_id" ON "network" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_network_datacenter_cidr" ON "network" USING btree ("datacenter_id","cidr") WHERE "network"."kind" = 'datacenter';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_network_organization_managed" ON "network" USING btree ("organization_id") WHERE "network"."kind" = 'managed';--> statement-breakpoint
CREATE INDEX "idx_passkey_credential_id" ON "passkey" USING btree ("credential_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_passkey_user_id" ON "passkey" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_principal_project_id" ON "principal" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_principal_managed_id" ON "principal" USING btree ("managed_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_project_workspace_id" ON "project" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_project_repository_id" ON "project" USING btree ("repository_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_workspace_system_component" ON "project" USING btree ("workspace_id",(metadata->>'component')) WHERE (metadata->>'component') IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_recovery_managed_id" ON "recovery" USING btree ("managed_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_recovery_inflight_managed" ON "recovery" USING btree ("managed_id") WHERE "recovery"."state" NOT IN ('completed','failed','blocked');--> statement-breakpoint
CREATE INDEX "idx_relay_fabric_id" ON "relay" USING btree ("fabric_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_relay_server_id" ON "relay" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_replica_managed_id" ON "replica" USING btree ("managed_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_replica_server_id" ON "replica" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_replica_primary" ON "replica" USING btree ("managed_id") WHERE "replica"."role" = 'primary';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_replica_server_private_port" ON "replica" USING btree ("server_id","private_port") WHERE "replica"."private_port" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_repository_organization_id" ON "repository" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_repository_connection_id" ON "repository" USING btree ("connection_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_repository_secret_id" ON "repository" USING btree ("secret_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_secret_organization_id" ON "secret" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_secret_principal_id" ON "secret" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_server_organization_id" ON "server" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_server_machine_key" ON "server" USING btree ("machine_key" text_ops);--> statement-breakpoint
CREATE INDEX "idx_server_hostname" ON "server" USING btree ("hostname" text_ops);--> statement-breakpoint
CREATE INDEX "idx_server_connected" ON "server" USING btree ("id") WHERE "server"."is_connected";--> statement-breakpoint
CREATE INDEX "idx_service_environment_id" ON "service" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_service_environment_compose_name" ON "service" USING btree ("environment_id","compose_service_name");--> statement-breakpoint
CREATE INDEX "idx_session_user_id" ON "session" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_slot_environment_generation" ON "slot" USING btree ("environment_id","generation");--> statement-breakpoint
CREATE INDEX "idx_slot_server_id" ON "slot" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ssh_principal_id" ON "ssh" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ssh_fingerprint" ON "ssh" USING btree ("fingerprint" text_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_organization_id" ON "storage" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_workspace_id" ON "storage" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_project_id" ON "storage" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_environment_id" ON "storage" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_service_id" ON "storage" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_storage_environment_compose_volume_key" ON "storage" USING btree ("environment_id" uuid_ops,("metadata" ->> 'composeVolumeKey')) WHERE kind = 'volume'
          AND environment_id IS NOT NULL
          AND COALESCE(metadata->>'composeVolumeKey', '') <> '';--> statement-breakpoint
CREATE INDEX "idx_copy_storage_id" ON "copy" USING btree ("storage_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_copy_server_id" ON "copy" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_copy_secret_id" ON "copy" USING btree ("secret_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_copy_storage_primary" ON "copy" USING btree ("storage_id") WHERE "copy"."role" = 'primary';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_copy_storage_server_provider" ON "copy" USING btree ("storage_id","server_id","provider") WHERE "copy"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_subnet_network_id" ON "subnet" USING btree ("network_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_subnet_server_id" ON "subnet" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tag_organization_id" ON "tag" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tag_organization_name" ON "tag" USING btree ("organization_id",lower(btrim(("name")::text)));--> statement-breakpoint
CREATE INDEX "idx_task_service_id" ON "task" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_team_organization_id" ON "team" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_teammate_team_id" ON "teammate" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_teammate_user_id" ON "teammate" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tenancy_principal_id" ON "tenancy" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tenancy_service_id" ON "tenancy" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tls_organization_id" ON "tls" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tls_not_after" ON "tls" USING btree ("not_after" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tls_organization_fingerprint_sha256" ON "tls" USING btree ("organization_id","fingerprint_sha256") WHERE "tls"."fingerprint_sha256" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tls_organization_active_ca" ON "tls" USING btree ("organization_id") WHERE "tls"."source" = 'organization_ca' AND "tls"."ca_state" = 'active';--> statement-breakpoint
CREATE INDEX "idx_tls_organization_ca_generation" ON "tls" USING btree ("organization_id","ca_generation") WHERE "tls"."source" = 'organization_ca';--> statement-breakpoint
CREATE INDEX "idx_generation_server_generation" ON "generation" USING btree ("server_id","generation" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_2fa_user_id" ON "2fa" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_organization_id" ON "variable" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_workspace_id" ON "variable" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_project_id" ON "variable" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_environment_id" ON "variable" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_service_id" ON "variable" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_hosting_id" ON "variable" USING btree ("hosting_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_server_id" ON "variable" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_binding_id" ON "variable" USING btree ("binding_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_org" ON "variable" USING btree ("key","organization_id") WHERE "variable"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_workspace" ON "variable" USING btree ("key","workspace_id") WHERE "variable"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_project" ON "variable" USING btree ("key","project_id") WHERE "variable"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_environment" ON "variable" USING btree ("key","environment_id") WHERE "variable"."environment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_service" ON "variable" USING btree ("key","service_id") WHERE "variable"."service_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_hosting" ON "variable" USING btree ("key","hosting_id") WHERE "variable"."hosting_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_server" ON "variable" USING btree ("key","server_id") WHERE "variable"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_delivery_created_at" ON "delivery" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_workspace_organization_id" ON "workspace" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_workspace_organization_turbopanel" ON "workspace" USING btree ("organization_id") WHERE kind = 'turbopanel';