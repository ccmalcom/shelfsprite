-- Hand-edited: the guard below was added to the generated statements.
-- Turns RLS on for every table in the exposed "public" schema with no policies, which shuts the
-- Supabase Data API (anon and authenticated roles) out entirely. The app is unaffected because it
-- reaches Postgres only through DATABASE_URL as the tables' owner, and owners bypass RLS unless it
-- is FORCEd. The guard aborts the migration if this connection's role neither owns every table nor
-- has BYPASSRLS, since RLS would then lock the app out of its own data.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)
     AND EXISTS (
       SELECT 1
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND NOT pg_has_role(current_user, c.relowner, 'USAGE')
     )
  THEN
    RAISE EXCEPTION 'enable_rls: role % does not own every public table and lacks BYPASSRLS', current_user;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "alembic_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "books" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enrich_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enrichment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback_prompt_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invite_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_meta" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rate_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reader_archetypes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reading_goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recommendations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "taste_signal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "taste_traits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "title_enrichment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "title_recommendations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "titles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_directive" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_settings" ENABLE ROW LEVEL SECURITY;