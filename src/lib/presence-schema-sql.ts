/**
 * The presence table's DDL, as statements.
 *
 * These are the statements from `drizzle/0005_presence.sql`, kept here so the
 * app can create its own table when a database turns out not to have it (see
 * src/lib/presence-schema.ts). Split from the runner on purpose: this module is
 * pure — no `pg`, no `process.env` — so scripts/db-errors.test.mjs can assert
 * it still matches the committed migration without a database.
 *
 * Every statement is idempotent, which is what makes running them from a
 * request path safe:
 *   CREATE TABLE IF NOT EXISTS  → no-op once the table is there
 *   DO $$ … duplicate_object    → the FK is only added if it isn't already
 *   CREATE INDEX IF NOT EXISTS  → no-op once the index is there
 */
export const PRESENCE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "user_presence" (
\t"user_id" text PRIMARY KEY NOT NULL,
\t"last_seen_at" timestamp DEFAULT now() NOT NULL,
\t"activity" text,
\t"device" text
)`,
  `DO $$
BEGIN
    ALTER TABLE "user_presence" ADD CONSTRAINT "user_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$`,
  `CREATE INDEX IF NOT EXISTS "user_presence_last_seen_idx" ON "user_presence" USING btree ("last_seen_at")`,
];
