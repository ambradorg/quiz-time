-- Spaced repetition (P4): one scheduling row per (user, card).
--
-- Idempotent: safe to run on a fresh database, on a database that already has
-- the table, and on production (Supabase) where it is pasted into the SQL
-- editor by hand — see the "Spaced Repetition" section of the README.
--
-- `study_results` keeps the history of what happened; `card_reviews` keeps
-- when each card should come back. The numbers are written by src/lib/srs.ts
-- (SM-2 descendant, four grades: again / hard / good / easy) — nothing else
-- computes them.
CREATE TABLE IF NOT EXISTS "card_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" integer NOT NULL,
	"card_id" integer NOT NULL,
	"ease" real DEFAULT 2.5 NOT NULL,
	"interval_days" integer DEFAULT 0 NOT NULL,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"learning_step" integer DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"last_grade" text,
	"last_reviewed_at" timestamp,
	"due_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
    ALTER TABLE "card_reviews" ADD CONSTRAINT "card_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    ALTER TABLE "card_reviews" ADD CONSTRAINT "card_reviews_session_id_study_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."study_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    ALTER TABLE "card_reviews" ADD CONSTRAINT "card_reviews_card_id_flashcards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."flashcards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "card_reviews_user_card_key" ON "card_reviews" USING btree ("user_id","card_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_reviews_user_due_idx" ON "card_reviews" USING btree ("user_id","due_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_reviews_user_session_idx" ON "card_reviews" USING btree ("user_id","session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_reviews_card_id_idx" ON "card_reviews" USING btree ("card_id");
