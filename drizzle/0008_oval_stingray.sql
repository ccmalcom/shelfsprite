CREATE TABLE "title_enrichment" (
	"id" serial PRIMARY KEY NOT NULL,
	"title_id" integer NOT NULL,
	"wikidata_qid" varchar,
	"tvmaze_id" integer,
	"wikipedia_page" varchar,
	"genres" json,
	"directors" json,
	"creators" json,
	"writers" json,
	"countries" json,
	"original_language" varchar,
	"based_on" json,
	"main_subjects" json,
	"series" json,
	"production_companies" json,
	"sitelinks" integer,
	"description" text,
	"description_source" varchar,
	"description_url" varchar,
	"image_url" varchar,
	"resolution_confidence" double precision NOT NULL,
	"confidence_label" varchar,
	"match_method" varchar,
	"identity_source" varchar DEFAULT 'auto' NOT NULL,
	"duplicate_of_title_id" integer,
	"raw_response" json,
	"resolved_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "title_recommendations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"run_id" varchar NOT NULL,
	"rank" integer NOT NULL,
	"media_type" varchar NOT NULL,
	"media_filter" varchar NOT NULL,
	"title" varchar NOT NULL,
	"year" integer,
	"wikidata_qid" varchar,
	"tvmaze_id" integer,
	"image_url" varchar,
	"genres" json,
	"description" text,
	"retrieval_pool" varchar,
	"seed_reason" varchar,
	"score" double precision NOT NULL,
	"rationale" text,
	"grounded_trait_ids" json,
	"grounded_book_ids" json,
	"grounded_title_ids" json,
	"status" varchar NOT NULL,
	"user_note" text,
	"reject_reasons" json,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "titles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"media_type" varchar NOT NULL,
	"title" varchar NOT NULL,
	"year" integer,
	"status" varchar NOT NULL,
	"letterboxd_rating" numeric(2, 1),
	"app_rating" numeric(2, 1),
	"letterboxd_review" text,
	"app_review" text,
	"last_watched_on" date,
	"letterboxd_uri" varchar,
	"wikidata_qid" varchar,
	"tvmaze_id" integer,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"exclude_from_profile" boolean DEFAULT false NOT NULL,
	"feedback_updated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp,
	CONSTRAINT "ck_titles_media_type" CHECK ("titles"."media_type" in ('movie', 'tv')),
	CONSTRAINT "ck_titles_status" CHECK ("titles"."status" in ('watched', 'watching', 'dropped', 'want')),
	CONSTRAINT "ck_titles_letterboxd_rating_half_step" CHECK ("titles"."letterboxd_rating" is null or ("titles"."letterboxd_rating" >= 0.5 and "titles"."letterboxd_rating" <= 5.0 and ("titles"."letterboxd_rating" * 2) % 1 = 0)),
	CONSTRAINT "ck_titles_app_rating_half_step" CHECK ("titles"."app_rating" is null or ("titles"."app_rating" >= 0.5 and "titles"."app_rating" <= 5.0 and ("titles"."app_rating" * 2) % 1 = 0))
);
--> statement-breakpoint
DROP INDEX "uq_enrich_jobs_active_user";--> statement-breakpoint
ALTER TABLE "enrich_jobs" ADD COLUMN "kind" varchar DEFAULT 'books' NOT NULL;--> statement-breakpoint
ALTER TABLE "taste_signal" ADD COLUMN "target_title_id" integer;--> statement-breakpoint
ALTER TABLE "taste_traits" ADD COLUMN "exhibit_title_ids" json;--> statement-breakpoint
ALTER TABLE "taste_traits" ADD COLUMN "contrast_title_ids" json;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "screen_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "screen_toggled_at" timestamp;--> statement-breakpoint
ALTER TABLE "title_enrichment" ADD CONSTRAINT "title_enrichment_title_id_fkey" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ix_title_enrichment_title_id" ON "title_enrichment" USING btree ("title_id" int4_ops);--> statement-breakpoint
CREATE INDEX "ix_title_recommendations_user_id" ON "title_recommendations" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_title_recommendations_run_id" ON "title_recommendations" USING btree ("run_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_titles_user_id" ON "titles" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_titles_user_letterboxd_uri" ON "titles" USING btree ("user_id","letterboxd_uri") WHERE "titles"."letterboxd_uri" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_titles_user_wikidata_qid" ON "titles" USING btree ("user_id","wikidata_qid") WHERE "titles"."wikidata_qid" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_titles_user_tvmaze_id" ON "titles" USING btree ("user_id","tvmaze_id") WHERE "titles"."tvmaze_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_enrich_jobs_active_user_kind" ON "enrich_jobs" USING btree ("user_id","kind") WHERE "enrich_jobs"."status" in ('pending', 'running');