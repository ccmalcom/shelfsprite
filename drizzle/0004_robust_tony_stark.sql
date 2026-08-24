CREATE TABLE "invite_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar NOT NULL,
	"status" varchar NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"reviewed_at" timestamp,
	"reviewed_by" varchar
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_invite_requests_email" ON "invite_requests" USING btree ("email" text_ops);