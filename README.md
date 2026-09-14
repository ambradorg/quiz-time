# QuizTime – Flashcard Quiz Maker

Upload PDFs, Word documents, photos (several at once), or pasted text and
QuizTime turns them into flashcards, then lets you review them four ways:

- **Study Mode** – traditional flashcards: read the question, tap to flip the
  card and reveal the answer, with optional hints and self-checking.
- **Exam Mode** – multiple choice: 4 options per question, instant
  Correct / Wrong feedback, and a scoring system (points, accuracy, letter
  grade, streaks).
- **Identification** – type the answer from memory. Checking is
  spelling-friendly (case, punctuation and small typos are forgiven, and any
  `/`-separated alternative phrasing counts), with the same scoring as Exam
  Mode.
- **Enumeration** – list every item from memory in any order. Cards whose
  answer is a list (the AI writes these as items separated by ` ; `, e.g.
  "Mango ; Banana ; Orange") become "name them all" questions with per-item
  feedback.

## Uploading

Pick up to **8 files at a time** (photos, screenshots, PDFs and/or Word
`.docx` files) from the upload screen — drag & drop, Gallery/Files or Camera all
work. Every file you select is sent to the AI together and combined into **one
study set** covering all of them.

- Photos are downscaled in the browser before upload (max ~1600px JPEG).
- PDFs and images are sent to Gemini directly; **Word files are converted to
  text on the server** (`mammoth`) because Gemini can't read `.docx` binaries.
  Old binary `.doc` files aren't supported — re-save them as `.docx` or export
  to PDF.
- Limits: 15 MB per file, 24 MB total, 8 files.

## Requirements

- Node.js 20+
- PostgreSQL database
- Google Gemini API key ([aistudio.google.com](https://aistudio.google.com))
- Google OAuth client + Auth.js secret (for sign-in — see [Accounts](#accounts--sign-in-with-google))

## Local setup

```bash
npm install
cp .env.example .env.local   # then fill in the values (see below)
npm run db:migrate           # create the database tables (idempotent)
npm run dev
```

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. **Required at build time** – `src/db/index.ts` throws if it's missing. |
| `GEMINI_API_KEY` | for generating cards | Without it the app shows a setup screen instead of the upload form. |
| `GEMINI_MODEL` | no | Overrides the main model. Default main model is `gemini-3.6-flash`, which falls back to `gemini-2.5-flash` → `gemini-2.0-flash` → `gemini-1.5-flash` if it isn't available for your key. |
| `AUTH_SECRET` | for sign-in | Auth.js secret. Generate: `openssl rand -base64 32`. |
| `AUTH_GOOGLE_ID` | for sign-in | Google OAuth client ID. |
| `AUTH_GOOGLE_SECRET` | for sign-in | Google OAuth client secret. |
| `MAINTENANCE_MODE` | no | `1`/`true`/`yes`/`on` enables [maintenance mode](#maintenance-mode): signed-out visitors get a maintenance page, signed-in users get a banner and keep full access. |

> ⚠️ Never commit `.env`. It is listed in `.gitignore`; if it was ever pushed,
> rotate the API key.

## Database setup

Migrations are committed under `drizzle/`. Apply them with:

```bash
npm run db:migrate
```

The initial migration is **idempotent** — safe to re-run, and safe on
databases that were already created with the old hand-pasted SQL (it adds the
`summary` column, the `card_progress` unique constraint, and the indexes).

To make schema changes later:

```bash
# edit src/db/schema.ts, then:
npm run db:generate   # writes a new SQL file into drizzle/
npm run db:migrate    # applies it
```

## Accounts & Sign-in with Google

Visitors see a **login page first** (large QuizTime logo + Continue with
Google). After sign-in they land in the app. Decks are private to each
account: uploading, generating, studying and deleting study sets all require
a session, and every query is scoped to the signed-in user (there is no
anonymous data, so nobody can read or delete somebody else's decks by
guessing an id).

### 1. Create the Google OAuth client

1. Go to [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
2. **Create credentials → OAuth client ID → Web application**
3. Authorized JavaScript origins: `https://<your-domain>`
   (locally: `http://localhost:3000`)
4. Authorized redirect URIs: `https://<your-domain>/api/auth/callback/google`
   (locally: `http://localhost:3000/api/auth/callback/google`)
5. Copy the client ID and secret into `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`

### 2. Set the Auth.js secret

```bash
openssl rand -base64 32   # → AUTH_SECRET
```

### How it works

- **Auth.js v5 (JWT sessions)** — stateless, serverless-friendly. On first
  sign-in the profile is upserted into the `users` table and the user id is
  pinned into the session token.
- `study_sessions.user_id` links every deck to its owner (`ON DELETE
  CASCADE`, `ON UPDATE CASCADE`). The column is nullable so the migration is
  safe on databases created before accounts; decks created before sign-in
  existed are orphaned (they belong to no account).
- The Gemini-generating endpoint is also sign-in-only, and the rate limit is
  now bucketed per user.

## Study Stats & Progress (P2)

Every card answered in **Study mode** ("Got it / Still learning") and **Exam
mode** (multiple choice) is recorded as one row in the `study_results` table:
which deck, which card, right/wrong, which mode, and when. Results live in the
database tied to the account — progress follows the user across devices
(`localStorage` is only a small offline draft cache: answers recorded while a
sync fails are retried on the next flush).

The **Stats tab** (signed-in only) shows:

- **Overall** — total cards studied, study sessions, correct/incorrect,
  accuracy, and a 🔥 **daily streak** (consecutive days with at least one
  answer; studying yesterday but not yet today keeps the streak alive).
- **Per deck** — cards studied, correct/incorrect, mastery % (studied cards ÷
  deck size), accuracy %, and last studied date. Decks that predate this
  feature (or were never studied) render as friendly zeros, not errors.
- **Recent activity** — the last answers with deck, question and mode.

### API

| Route | Purpose |
| --- | --- |
| `POST /api/stats/results` | Record outcomes: `{ results: [{ sessionId, cardId, correct, mode?, answeredAt? }] }` (max 100/batch). Deck **and** card ownership are verified per entry — entries pointing at another user's data are skipped and reported in `invalid`, never written. |
| `GET /api/stats` | `{ overall, decks, recent }` for the signed-in user only. All counts are cast `::int` (pg returns `bigint` strings for `count(*)`). |

> The per-card right/wrong history in `study_results` is the foundation the
> planned spaced-repetition scheduler (P4) will consume.

### Production migration (Supabase)

Migration `drizzle/0002_study_results.sql` is idempotent. To apply it in
production, paste this into the Supabase SQL editor and run it once:

```sql
CREATE TABLE IF NOT EXISTS "study_results" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "session_id" integer NOT NULL,
  "card_id" integer NOT NULL,
  "correct" boolean NOT NULL,
  "mode" text DEFAULT 'study' NOT NULL,
  "answered_at" timestamp DEFAULT now() NOT NULL
);

DO $$
BEGIN
    ALTER TABLE "study_results" ADD CONSTRAINT "study_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "study_results" ADD CONSTRAINT "study_results_session_id_study_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."study_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "study_results" ADD CONSTRAINT "study_results_card_id_flashcards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."flashcards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "study_results_user_id_idx" ON "study_results" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "study_results_session_id_idx" ON "study_results" USING btree ("session_id");
CREATE INDEX IF NOT EXISTS "study_results_card_id_idx" ON "study_results" USING btree ("card_id");
CREATE INDEX IF NOT EXISTS "study_results_user_answered_idx" ON "study_results" USING btree ("user_id","answered_at");
```

It is safe to run twice, and safe on a database where the table already
exists. Deleting a deck or an account cascades to its results.

Migration `drizzle/0003_cute_susan_delgado.sql` switches the two user FKs to
`ON UPDATE cascade` so that when a sign-in re-keys a `users` row (same email
arriving under a new Google `sub` — see "Accounts" in `src/auth.ts`), the
user's decks and study results follow the id. It is idempotent too:

```sql
DO $$
BEGIN
    ALTER TABLE "study_sessions" DROP CONSTRAINT IF EXISTS "study_sessions_user_id_users_id_fk";
    ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "study_results" DROP CONSTRAINT IF EXISTS "study_results_user_id_users_id_fk";
    ALTER TABLE "study_results" ADD CONSTRAINT "study_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

## E2E tests (offline-friendly)

The sandbox/dev environment can't complete a real Google OAuth flow, so
`scripts/auth-e2e.mjs` mints Auth.js session JWTs directly with
`next-auth/jwt`'s `encode()` (salt `authjs.session-token`) and exercises the
API over HTTP. It verifies, among other things, that **user A can neither
read nor write user B's decks or study results**.

```bash
# 1. point DATABASE_URL/AUTH_SECRET at a test database (see .env.local)
node scripts/setup-test-db.mjs          # creates db + applies all migrations (idempotent)
npm run build && npm run start          # or: npm run dev
# 2. in another shell (reuses a running server, or spawns its own):
BASE_URL=http://127.0.0.1:3000 npm run test:e2e
```

`scripts/seed-demo-stats.mjs` seeds a demo user with decks + study history
and prints a session cookie you can paste into the browser console to view
the Stats tab in a preview environment where Google sign-in can't complete.

## Maintenance mode

Set `MAINTENANCE_MODE=1` (also accepts `true`/`yes`/`on`) and restart the
server to put the site into maintenance:

- **Signed-out visitors** get a server-rendered “We’ll be right back” page
  instead of the app (with a sign-in button so you can still get in).
- **Signed-in users** see the normal app with an amber banner explaining that
  maintenance mode is on, and keep full access to their decks.
- `GET /api/health` reports the current state in a `maintenance` field.

The toggle is read from the environment **per request** and the page tree is
forced dynamic, so turning it on/off only needs a restart — no rebuild. On
Vercel, change the env var and redeploy/restart the functions.

## Deploying to Vercel

1. Push the repo to GitHub and **Import Project** in Vercel (framework preset:
   Next.js — no config needed).
2. In **Project Settings → Environment Variables**, add:
   - `DATABASE_URL` (e.g. Vercel Postgres / Neon connection string)
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL` (optional)
   - `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` (see Accounts)
   - `MAINTENANCE_MODE` (optional, see Maintenance mode)
3. Create the tables: run `npm run db:migrate` once against that database
   (locally, with `DATABASE_URL` pointing at it).
4. Deploy. If the build fails with `DATABASE_URL is required`, the variable
   wasn't set before the build started.

### Installed apps & updates (service worker)

The app is installable (`public/manifest.json`, `"id": "/"` keeps the install
identity stable), and `public/sw.js` keeps installed home-screen apps in sync
with every deploy — each deploy replaces content-hashed assets, so stale HTML
would 404 its CSS/JS and open unstyled. Strategy (registered in production only
by `src/components/register-sw.tsx`):

- **Navigations (HTML): network-first.** Every launch fetches fresh HTML; the
  cache is only an offline fallback (`caches.match("/")`).
- **Immutable assets (`/_next/static/*`, `/images/*`): cache-first**, filled on
  first fetch.
- **`/api/*` and non-GET requests: never cached.**
- **`/sw.js` itself is served with `Cache-Control: no-cache, no-store,
  must-revalidate`** plus `Service-Worker-Allowed: /` (see `next.config.ts`),
  so browsers detect new versions immediately.
- **`skipWaiting()` + `clients.claim()`** activate a new worker right away, and
  activation purges every cache that isn't the current one.
- To force-invalidate all cached content, **bump `VERSION` in `public/sw.js`**
  (e.g. `quiztime-v2`) — the cache namespace changes and old caches are deleted
  on activation.

### Upload sizes on Vercel

Vercel caps request bodies at **4.5 MB** (`413 FUNCTION_PAYLOAD_TOO_LARGE`).
The app handles this in `src/app/page.tsx`: once the direct-upload budget
(~4 MB) is used up, PDFs are parsed to plain text **in the browser** with
pdf.js (`src/lib/pdf-text.ts`) and only the text is sent to `/api/scan` —
so multi-MB lecture PDFs still work. Scanned (image-only) PDFs have no text
layer, so oversized scans are rejected with a clear message instead of a
cryptic one; small scans still go to Gemini as files.

## Scripts

```bash
npm run dev         # dev server
npm run build       # production build
npm run start       # serve the production build
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run db:generate # generate a new migration from src/db/schema.ts
npm run db:migrate  # apply committed migrations to DATABASE_URL
npm run db:setup-test # create/reset the local test db + apply migrations
npm run test:e2e    # auth/stats e2e suite (minted JWTs, real HTTP)
```

## Notes

- **AI generation is sign-in-only** and rate-limited to 10 requests per 10
  minutes per user on `/api/scan` (soft limit, per server instance) so nobody
  can burn your Gemini free tier.
- `GET /api/config` tells the frontend whether `GEMINI_API_KEY` is set, so the
  app shows the setup screen instead of a broken upload form.
- `GET /api/health` also pings the database (returns 503 when the DB is down)
  and reports whether maintenance mode is on.
- Generated-but-unsaved decks are kept in `localStorage`; the Upload tab shows
  a banner to resume or discard them.

## Scoring in Exam Mode

| Event | Points |
| --- | --- |
| Correct answer | 10 |
| Medium card | +5 |
| Hard card | +10 |
| Streak bonus | +2 per consecutive correct answer (capped at +10) |

The results screen shows accuracy %, letter grade, points out of the maximum,
best streak, elapsed time, and a review of the questions you missed (which can
be sent straight into Study Mode).
