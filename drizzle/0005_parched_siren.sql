CREATE TABLE "reading_goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"year" integer NOT NULL,
	"kind" varchar NOT NULL,
	"subject" varchar,
	"target" integer NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "uq_reading_goal" UNIQUE("user_id","year","kind","subject"),
	CONSTRAINT "ck_reading_goals_target_positive" CHECK ("reading_goals"."target" > 0),
	CONSTRAINT "ck_reading_goals_kind" CHECK ("reading_goals"."kind" in ('books', 'genre', 'new_authors', 'pages')),
	CONSTRAINT "ck_reading_goals_subject" CHECK (("reading_goals"."kind" = 'genre') = ("reading_goals"."subject" is not null))
);
--> statement-breakpoint
CREATE INDEX "ix_reading_goals_user_id" ON "reading_goals" USING btree ("user_id" text_ops);