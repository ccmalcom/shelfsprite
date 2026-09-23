ALTER TABLE "profile_meta" ADD COLUMN "rebuild_reason" varchar;--> statement-breakpoint
ALTER TABLE "profile_meta" ADD COLUMN "rebuild_requested_at" timestamp;