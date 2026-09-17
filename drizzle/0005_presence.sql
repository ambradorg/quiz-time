-- Who's online (presence): one heartbeat row per user, overwritten in place.
--
-- Idempotent: safe to run on a fresh database, on a database that already has
-- the table, and on production (Supabase) where it is pasted into the SQL
-- editor by hand — see the "Who's online (owner roster)" section of the README.
--
-- A heartbeat is a single `INSERT … ON CONFLICT (user_id) DO UPDATE`, so this
-- table stays one row per account no matter how long somebody studies. A user
-- counts as *online* while `last_seen_at` is younger than the window defined in
-- src/lib/presence.ts (90 s, with heartbeats every 30 s). Rows are never
-- deleted on sign-out: how long ago somebody was last seen is exactly what the
-- owner's roster shows.
CREATE TABLE IF NOT EXISTS "user_presence" (
	"user_id" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"activity" text,
	"device" text
);
--> statement-breakpoint
DO $$
BEGIN
    ALTER TABLE "user_presence" ADD CONSTRAINT "user_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_presence_last_seen_idx" ON "user_presence" USING btree ("last_seen_at");
