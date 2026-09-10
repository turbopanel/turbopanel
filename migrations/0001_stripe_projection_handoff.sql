ALTER TABLE "delivery" ADD COLUMN "object_id" text;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "object_type" text;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "projected_at" timestamp(3) with time zone;--> statement-breakpoint
CREATE INDEX "idx_delivery_stripe_pending" ON "delivery" USING btree ("created_at") WHERE "delivery"."provider" = 'stripe' AND "delivery"."projected_at" IS NULL;