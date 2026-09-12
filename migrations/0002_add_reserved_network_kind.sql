ALTER TABLE "network" DROP CONSTRAINT "network_kind_check";--> statement-breakpoint
ALTER TABLE "network" DROP CONSTRAINT "network_single_scope_check";--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_kind_check" CHECK (kind IN ('datacenter', 'docker', 'compose', 'managed', 'reserved'));--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_single_scope_check" CHECK ((
        ("network"."kind" = 'datacenter' AND "network"."datacenter_id" IS NOT NULL AND "network"."server_id" IS NULL AND "network"."environment_id" IS NULL AND "network"."cidr" IS NOT NULL) OR
        ("network"."kind" = 'docker' AND "network"."datacenter_id" IS NULL AND "network"."environment_id" IS NULL) OR
        ("network"."kind" = 'compose' AND "network"."datacenter_id" IS NULL AND "network"."server_id" IS NULL) OR
        ("network"."kind" = 'managed' AND "network"."datacenter_id" IS NULL AND "network"."server_id" IS NULL AND "network"."environment_id" IS NULL AND "network"."cidr" IS NULL) OR
        ("network"."kind" = 'reserved' AND "network"."datacenter_id" IS NULL AND "network"."server_id" IS NULL AND "network"."environment_id" IS NULL AND "network"."cidr" IS NOT NULL)
      ));