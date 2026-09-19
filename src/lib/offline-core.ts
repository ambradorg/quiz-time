/**
 * Offline mode — the pure half.
 *
 * QuizTime is a PWA, so "open my account offline and study my saved sets"
 * needs three things: the *identity* (a cached profile, so the app shell can
 * render offline), the *decks* (a snapshot of cards + progress + SRS state),
 * and the *writes* (a durable outbox that replays while you were studying on
 * a plane).
 *
 * This module holds only the parts that are deterministic — snapshot merging,
 * the offline review queue, outbox batching/draining and backoff — so they can
 * be unit-tested without a browser (`scripts/offline.test.mjs`). Everything
 * that touches IndexedDB, `navigator` or `fetch` lives in `src/lib/offline.ts`
 * (the app) and `public/sw.js` (background replay).
 *
 * ⚠️ Contract: `public/sw.js` reads the same IndexedDB stores to drain the
 * outbox while the app is closed. Store names, the queued-write shape and the
 * batching rules below are mirrored there on purpose — `scripts/offline.test.mjs`
 * asserts the two files still agree, so a rename can't silently break sync.
 *
 * Offline is for *studying*: decks are created/edited/generated online (AI
 * needs the network, and deck ids are assigned by Postgres). Saved sets, all
 * four study modes, review progress and the spaced-repetition schedule all
 * work offline and reconcile when the connection returns.
 */
import {
  NEW_CARDS_PER_DAY,
  dueLabel,
  scheduleCard,
  type ReviewGrade,
  type SrsState,
} from "./srs";

// ─── Storage contract (mirrored in public/sw.js) ─────────────────────────────
/** IndexedDB database shared by the page and the service worker. */
export const OFFLINE_DB_NAME = "quiztime-offline";
export const OFFLINE_DB_VERSION = 1;
/** `id` → OfflineProfile: who to render offline. */
export const STORE_PROFILE = "profile";
/** `id` → OfflineDeck: the deck snapshots. */
export const STORE_DECKS = "decks";
/** `cardId` → OfflineSrs: last known spaced-repetition schedule per card. */
export const STORE_SRS = "srs";
/** `seq` (autoIncrement) → QueuedWrite: the outbox. */
export const STORE_OUTBOX = "outbox";
/** `key` → value: small bookkeeping (stats cache, backoff, last sync…). */
export const STORE_META = "meta";

/** localStorage flag: "use the cached profile even if the session says no". */
export const OFFLINE_MODE_KEY = "quiztime:offline-mode";

/**
 * The outbox is a safety net, not a database: cap it so a device that has
 * been offline for months can't fill the storage quota. Oldest entries go
 * first (the newest answers are the ones a learner still cares about).
 */
export const MAX_OUTBOX_ITEMS = 500;
/** `/api/stats/results` and `/api/review` both reject batches over 100. */
export const MAX_BATCH = 100;
/** Retry backoff for a failed drain: 30 s, 1 min, 2 min … capped at 10 min. */
export const FLUSH_BACKOFF_BASE_MS = 30_000;
export const FLUSH_BACKOFF_MAX_MS = 10 * 60_000;

// ─── Types ───────────────────────────────────────────────────────────────────
/** The signed-in user, cached so the app can open offline. */
export interface OfflineProfile {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  /** When the profile was last confirmed by the server. */
  savedAt: string;
}

/** A flashcard as stored in a snapshot (server ids are kept verbatim). */
export interface OfflineCard {
  id: number;
  question: string;
  answer: string;
  hint: string | null;
  difficulty: string;
  orderIndex: number;
}

/** Per-card "know / don't know" progress, cached from the server. */
export interface OfflineProgress {
  cardId: number;
  isKnown: boolean;
  attempts: number;
}

/**
 * One deck, frozen for offline study. `pinned` distinguishes the decks the
 * learner explicitly downloaded from the ones that were merely cached while
 * they were browsing (only pinned decks survive a cache cleanup prompt in the
 * UI; both are usable offline).
 */
export interface OfflineDeck {
  id: number;
  title: string;
  summary: string | null;
  sourceType: string;
  createdAt: string;
  /** Subject folder the deck is filed under (null = All Sets only). */
  subjectId: number | null;
  cards: OfflineCard[];
  progress: OfflineProgress[];
  pinned: boolean;
  savedAt: string;
}

/** Spaced-repetition state for one card, as last seen from the server. */
export interface OfflineSrs {
  cardId: number;
  sessionId: number;
  dueAt: string;
  lastReviewedAt: string | null;
  /** When the card entered the schedule — used for the daily new-card budget. */
  introducedAt: string;
  state: SrsState;
}

export type OfflineWriteKind = "review" | "stats" | "progress";

/** One queued write, replayed verbatim once the network is back. */
export interface QueuedWrite {
  seq?: number;
  url: string;
  method: string;
  kind: OfflineWriteKind;
  body: unknown;
  createdAt: string;
  attempts: number;
}

/** The minimal slice of the Cache/IDB APIs the pure code depends on. */
export interface OfflineBackend {
  getAll<T>(store: string): Promise<T[]>;
  get<T>(store: string, key: string | number): Promise<T | undefined>;
  put(store: string, value: unknown): Promise<void>;
  delete(store: string, key: string | number): Promise<void>;
  clear(store: string): Promise<void>;
}

/** Enough of the Web Storage API to unit-test the offline-mode flag. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The subset of a `Response` the flush needs (so tests can stub it). */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<FetchLikeResponse>;

// ─── Small helpers ───────────────────────────────────────────────────────────
export const nowIso = (now: Date = new Date()): string => now.toISOString();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** "Saved 2 h ago" / "Saved just now" — for the offline badges. */
export function formatSavedAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "not saved yet";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "not saved yet";
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// ─── Identity ────────────────────────────────────────────────────────────────
/** Build the cacheable profile from an Auth.js session user. */
export function profileFromUser(
  user: { id?: string | null; name?: string | null; email?: string | null; image?: string | null },
  now: Date = new Date()
): OfflineProfile | null {
  if (!user?.id) return null;
  return {
    id: user.id,
    name: user.name ?? null,
    email: user.email ?? null,
    image: user.image ?? null,
    savedAt: nowIso(now),
  };
}

export function isOfflineModeEnabled(storage: KeyValueStore | null | undefined): boolean {
  try {
    return storage?.getItem(OFFLINE_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOfflineMode(
  storage: KeyValueStore | null | undefined,
  enabled: boolean
): void {
  try {
    if (enabled) storage?.setItem(OFFLINE_MODE_KEY, "1");
    else storage?.removeItem(OFFLINE_MODE_KEY);
  } catch {
    // Private mode / storage disabled — the app simply stays online-only.
  }
}

// ─── Deck snapshots ──────────────────────────────────────────────────────────
/** The session half of `GET /api/sessions/[id]`. */
export interface SessionPayload {
  id: number;
  title: string;
  sourceType: string;
  summary?: string | null;
  createdAt: string | Date;
  /** Subject folder the deck is filed under (null/absent = All Sets only). */
  subjectId?: number | null;
}

const toIsoString = (value: string | Date | null | undefined, fallback: string): string => {
  if (value === null || value === undefined) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
};

/**
 * Freeze an API deck (`{session, cards, progress}`) into a snapshot. Cards are
 * sorted by `orderIndex` so offline study keeps the author's order even if the
 * response ever arrives unordered.
 */
export function buildOfflineDeck(input: {
  session: SessionPayload;
  cards: OfflineCard[];
  progress?: OfflineProgress[];
  pinned?: boolean;
  savedAt?: string | Date;
  now?: Date;
}): OfflineDeck {
  const now = input.now ?? new Date();
  return {
    id: input.session.id,
    title: input.session.title,
    summary: input.session.summary ?? null,
    sourceType: input.session.sourceType ?? "text",
    createdAt: toIsoString(input.session.createdAt, nowIso(now)),
    subjectId: input.session.subjectId ?? null,
    cards: [...(input.cards ?? [])]
      .map((card) => ({
        id: card.id,
        question: card.question,
        answer: card.answer,
        hint: card.hint ?? null,
        difficulty: card.difficulty ?? "medium",
        orderIndex: card.orderIndex ?? 0,
      }))
      .sort((a, b) => a.orderIndex - b.orderIndex),
    progress: (input.progress ?? []).map((p) => ({
      cardId: p.cardId,
      isKnown: Boolean(p.isKnown),
      attempts: p.attempts ?? 0,
    })),
    pinned: Boolean(input.pinned),
    savedAt: toIsoString(input.savedAt ?? now, nowIso(input.now ?? now)),
  };
}

/** Snapshot + fresh data: the newcomer wins, `pinned` is sticky on true. */
export function mergeDeckSnapshot(
  existing: OfflineDeck | undefined,
  incoming: OfflineDeck
): OfflineDeck {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    pinned: existing.pinned || incoming.pinned,
    // A deck that is offline-edited keeps the progress the learner already
    // earned locally when the server copy is older than the snapshot.
    progress:
      incoming.progress.length >= existing.progress.length
        ? incoming.progress
        : existing.progress,
  };
}

/** Upsert one card's "know / don't know" state (used while offline). */
export function applyProgressToDeck(
  deck: OfflineDeck,
  update: { cardId: number; isKnown: boolean }
): OfflineDeck {
  const existing = deck.progress.find((p) => p.cardId === update.cardId);
  const progress = existing
    ? deck.progress.map((p) =>
        p.cardId === update.cardId
          ? { ...p, isKnown: update.isKnown, attempts: p.attempts + 1 }
          : p
      )
    : [...deck.progress, { cardId: update.cardId, isKnown: update.isKnown, attempts: 1 }];
  return { ...deck, progress };
}

/** Deck snapshot → a row shaped like `GET /api/sessions` (for the list UI). */
export interface OfflineSessionRow {
  id: number;
  title: string;
  sourceType: string;
  sourceText: null;
  summary: string | null;
  createdAt: string;
  subjectId: number | null;
  cardCount: number;
  knownCount: number;
  dueCount: number;
  trackedCount: number;
}

const tracked = (srs: OfflineSrs[]): OfflineSrs[] => srs;

/**
 * Rebuild the "My Study Sets" list from snapshots: card/known counts come from
 * the snapshot, due/tracked counts from the cached SRS schedule — exactly the
 * numbers the online list shows.
 */
export function buildOfflineSessionRows(
  decks: OfflineDeck[],
  srs: OfflineSrs[],
  now: Date = new Date()
): OfflineSessionRow[] {
  const byCard = new Map(tracked(srs).map((row) => [row.cardId, row]));
  return [...decks]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((deck) => {
      const rows = deck.cards
        .map((card) => byCard.get(card.id))
        .filter((row): row is OfflineSrs => Boolean(row));
      return {
        id: deck.id,
        title: deck.title,
        sourceType: deck.sourceType,
        sourceText: null,
        summary: deck.summary,
        createdAt: deck.createdAt,
        subjectId: deck.subjectId ?? null,
        cardCount: deck.cards.length,
        knownCount: deck.progress.filter((p) => p.isKnown).length,
        dueCount: rows.filter((row) => new Date(row.dueAt).getTime() <= now.getTime()).length,
        trackedCount: rows.length,
      };
    });
}

// ─── Spaced repetition, offline ──────────────────────────────────────────────
/** Store one graded card's fresh schedule (mirrors what the server persists). */
export function applyGradeToSrs(
  records: OfflineSrs[],
  input: { cardId: number; sessionId: number; grade: ReviewGrade },
  now: Date = new Date()
): OfflineSrs[] {
  const previous = records.find((row) => row.cardId === input.cardId);
  const next = scheduleCard(previous?.state ?? null, input.grade, now);
  const record: OfflineSrs = {
    cardId: input.cardId,
    sessionId: input.sessionId,
    dueAt: next.dueAt.toISOString(),
    lastReviewedAt: now.toISOString(),
    introducedAt: previous?.introducedAt ?? now.toISOString(),
    // `scheduleCard` returns the timestamps too; the persisted state is the
    // SrsState half (see card_reviews in src/db/schema.ts).
    state: {
      ease: next.ease,
      intervalDays: next.intervalDays,
      reps: next.reps,
      lapses: next.lapses,
      learningStep: next.learningStep,
      reviewCount: next.reviewCount,
      lastGrade: next.lastGrade,
    },
  };
  return previous
    ? records.map((row) => (row.cardId === input.cardId ? record : row))
    : [...records, record];
}

/** `{cardId, sessionId, state, dueAt, lastReviewedAt}` rows from `card_reviews`. */
export interface SrsApiRow {
  cardId: number;
  sessionId: number;
  dueAt: string | Date | null;
  lastReviewedAt?: string | Date | null;
  createdAt?: string | Date | null;
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  learningStep: number;
  reviewCount: number;
  lastGrade: string | null;
}

export function srsRowToOffline(row: SrsApiRow, now: Date = new Date()): OfflineSrs {
  return {
    cardId: row.cardId,
    sessionId: row.sessionId,
    dueAt: toIsoString(row.dueAt, nowIso(now)),
    lastReviewedAt: row.lastReviewedAt ? toIsoString(row.lastReviewedAt, "") : null,
    introducedAt: toIsoString(row.createdAt, nowIso(now)),
    state: {
      ease: row.ease,
      intervalDays: row.intervalDays,
      reps: row.reps,
      lapses: row.lapses,
      learningStep: row.learningStep,
      reviewCount: row.reviewCount,
      lastGrade: (row.lastGrade as ReviewGrade | null) ?? null,
    },
  };
}

/** A card waiting in the offline review queue — the API's `DueCard` shape. */
export interface OfflineDueCard {
  cardId: number;
  sessionId: number;
  question: string;
  answer: string;
  hint: string | null;
  difficulty: string;
  deckTitle: string;
  isNew: boolean;
  dueAt: string | null;
  state: SrsState | null;
}

export interface OfflineReviewDeckStat {
  sessionId: number;
  title: string;
  cardCount: number;
  trackedCount: number;
  dueCount: number;
  newCount: number;
  nextDueAt: string | null;
  nextDueLabel: string;
}

/** Same shape as `GET /api/review`, so the Review UI needs no offline branch. */
export interface OfflineReviewData {
  now: string;
  sessionId: number | null;
  counts: {
    due: number;
    learning: number;
    tracked: number;
    newCards: number;
    newRemainingToday: number;
    newIntroducedToday: number;
    newPerDay: number;
  };
  nextDueAt: string | null;
  decks: OfflineReviewDeckStat[];
  queue: OfflineDueCard[];
}

const isSameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * The offline twin of `GET /api/review`.
 *
 * Same rules as the server: already-due cards first (oldest due date wins,
 * then author order), then never-reviewed cards from the oldest deck, capped
 * by the overall `limit` and by the daily new-card allowance. The allowance is
 * derived from the cached schedules (a card whose schedule was created today
 * and has been graded at most once counts as "introduced today"), which is an
 * approximation — it self-corrects on the next online sync, and the server
 * stays the source of truth when replaying the grades.
 */
export function buildOfflineReviewData(input: {
  decks: OfflineDeck[];
  srs: OfflineSrs[];
  sessionId?: number | null;
  limit?: number;
  now?: Date;
  newPerDay?: number;
}): OfflineReviewData {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(100, input.limit ?? 50));
  const newPerDay = input.newPerDay ?? NEW_CARDS_PER_DAY;
  const decks = input.sessionId
    ? input.decks.filter((deck) => deck.id === input.sessionId)
    : [...input.decks];

  const srsByCard = new Map(input.srs.map((row) => [row.cardId, row]));
  const deckById = new Map(decks.map((deck) => [deck.id, deck]));
  const isDueNow = (row: OfflineSrs) => new Date(row.dueAt).getTime() <= now.getTime();

  // Every card of every in-scope deck, in author order (the sort below breaks
  // ties by `orderIndex`, like the API's `order by order_index`).
  const scopedRows = decks.flatMap((deck) => deck.cards.map((card) => ({ deck, card })));

  const dueCards = scopedRows
    .map(({ deck, card }) => ({ deck, card, row: srsByCard.get(card.id) }))
    .filter((entry): entry is { deck: OfflineDeck; card: OfflineCard; row: OfflineSrs } =>
      Boolean(entry.row && isDueNow(entry.row))
    )
    .sort(
      (a, b) =>
        new Date(a.row.dueAt).getTime() - new Date(b.row.dueAt).getTime() ||
        a.card.orderIndex - b.card.orderIndex
    );

  const newCards = scopedRows
    .filter(({ card }) => !srsByCard.has(card.id))
    .sort(
      (a, b) =>
        new Date(a.deck.createdAt).getTime() - new Date(b.deck.createdAt).getTime() ||
        a.card.orderIndex - b.card.orderIndex
    );

  const scopedSrs = input.srs.filter((row) => deckById.has(row.sessionId));
  const dueCount = scopedSrs.filter(isDueNow).length;
  // Same definition as the API's `counts.learning` — sub-day cards, due or not.
  const learning = scopedSrs.filter((row) => row.state.intervalDays === 0).length;
  const introducedToday = scopedSrs.filter(
    (row) =>
      row.state.reviewCount <= 1 &&
      row.lastReviewedAt &&
      isSameDay(new Date(row.lastReviewedAt), now)
  ).length;
  const newAllowance = Math.max(0, newPerDay - introducedToday);

  const toDueCard = (entry: {
    deck: OfflineDeck;
    card: OfflineCard;
    row?: OfflineSrs;
  }): OfflineDueCard => ({
    cardId: entry.card.id,
    sessionId: entry.deck.id,
    question: entry.card.question,
    answer: entry.card.answer,
    hint: entry.card.hint,
    difficulty: entry.card.difficulty,
    deckTitle: entry.deck.title,
    isNew: !entry.row,
    dueAt: entry.row ? entry.row.dueAt : null,
    state: entry.row ? entry.row.state : null,
  });

  const merged = [
    ...dueCards.map((entry) => toDueCard(entry)),
    ...newCards.slice(0, newAllowance).map((entry) => toDueCard(entry)),
  ].slice(0, limit);

  const nextDueAt = scopedSrs
    .filter((row) => !isDueNow(row))
    .map((row) => row.dueAt)
    .sort()[0] ?? null;

  const deckStats: OfflineReviewDeckStat[] = decks.map((deck) => {
    const deckRows = deck.cards
      .map((card) => srsByCard.get(card.id))
      .filter((row): row is OfflineSrs => Boolean(row));
    const nextForDeck = deckRows
      .filter((row) => !isDueNow(row))
      .map((row) => row.dueAt)
      .sort()[0] ?? null;
    return {
      sessionId: deck.id,
      title: deck.title,
      cardCount: deck.cards.length,
      trackedCount: deckRows.length,
      dueCount: deckRows.filter(isDueNow).length,
      newCount: deck.cards.filter((card) => !srsByCard.has(card.id)).length,
      nextDueAt: nextForDeck,
      nextDueLabel: dueLabel(nextForDeck, now),
    };
  });

  return {
    now: nowIso(now),
    sessionId: input.sessionId ?? null,
    counts: {
      due: dueCount,
      learning,
      tracked: scopedSrs.length,
      newCards: scopedRows.filter(({ card }) => !srsByCard.has(card.id)).length,
      newRemainingToday: Math.min(newAllowance, newCards.length),
      newIntroducedToday: introducedToday,
      newPerDay,
    },
    nextDueAt,
    decks: deckStats.sort(
      (a, b) =>
        new Date(deckById.get(b.sessionId)?.createdAt ?? 0).getTime() -
        new Date(deckById.get(a.sessionId)?.createdAt ?? 0).getTime()
    ),
    queue: merged,
  };
}

/** Local "due today" badge count (the nav badge) when the API is unreachable. */
export function countDueNow(srs: OfflineSrs[], now: Date = new Date()): number {
  return srs.filter((row) => new Date(row.dueAt).getTime() <= now.getTime()).length;
}

// ─── Outbox: what can be queued ──────────────────────────────────────────────
export interface QueueableWrite {
  kind: OfflineWriteKind;
  /** Max entries per request for the batched kinds. */
  maxBatch: number;
}

/**
 * Which requests may be queued for replay. Deliberately narrow: only the
 * writes that are safe to apply *later* are queued. Creating decks (`POST
 * /api/sessions`), editing cards, deleting a deck and anything under
 * `/api/auth/*` all need the network — the UI explains that instead of
 * pretending the write succeeded.
 *
 * Mirrored in `public/sw.js` (which cannot import TypeScript).
 */
export function describeQueueableWrite(
  url: string,
  method: string,
  body?: unknown
): QueueableWrite | null {
  const verb = method.toUpperCase();
  let pathname: string;
  try {
    pathname = new URL(url, "https://offline.local").pathname;
  } catch {
    return null;
  }
  if (verb === "POST" && pathname === "/api/stats/results") {
    return { kind: "stats", maxBatch: MAX_BATCH };
  }
  if (verb === "POST" && pathname === "/api/review") {
    return { kind: "review", maxBatch: MAX_BATCH };
  }
  // Card progress ("Got it" / "Still learning") — one card per request, and
  // only when the payload really is the progress path (a title/summary edit
  // on the same route is *not* queueable: last-write-wins would eat edits).
  if (verb === "PATCH" && /^\/api\/sessions\/\d+$/.test(pathname)) {
    if (isRecord(body) && Number.isInteger(body.cardId) && typeof body.isKnown === "boolean") {
      return { kind: "progress", maxBatch: 1 };
    }
  }
  return null;
}

/** Append a write to the outbox, dropping the oldest entries past the cap. */
export function enqueueWrite(
  queue: QueuedWrite[],
  item: Omit<QueuedWrite, "createdAt" | "attempts"> & Partial<Pick<QueuedWrite, "createdAt" | "attempts">>,
  now: Date = new Date()
): QueuedWrite[] {
  const next: QueuedWrite = {
    ...item,
    createdAt: item.createdAt ?? nowIso(now),
    attempts: item.attempts ?? 0,
  };
  return [...queue, next].slice(-MAX_OUTBOX_ITEMS);
}

/**
 * The number of writes waiting, ignoring pure bookkeeping. Used for the
 * "N answers waiting to sync" chip.
 */
export function outboxSize(queue: QueuedWrite[]): number {
  return queue.reduce((total, item) => {
    if (isRecord(item.body)) {
      if (Array.isArray(item.body.reviews)) return total + item.body.reviews.length;
      if (Array.isArray(item.body.results)) return total + item.body.results.length;
    }
    return total + 1;
  }, 0);
}

// ─── Outbox: draining ────────────────────────────────────────────────────────
/** One HTTP request built from one or more queued writes. */
export interface FlushPlan {
  url: string;
  method: string;
  kind: OfflineWriteKind;
  body: unknown;
  /** `seq`s (or array indices when unsaved) covered by this request. */
  keys: (number | string)[];
  entryCount: number;
}

/** Stable key for a queued write: its IDB key when it has one. */
export function queueKey(item: QueuedWrite, index: number): number | string {
  return typeof item.seq === "number" ? item.seq : `i${index}`;
}

const progressKey = (body: unknown): string => {
  if (!isRecord(body)) return "unknown";
  return `${String(body.sessionId ?? "")}:${String(body.cardId ?? "")}`;
};

/**
 * Turn the outbox into as few requests as the API allows:
 *   - `review`  → one `{reviews:[…]}` per 100 grades,
 *   - `stats`   → one `{results:[…]}` per 100 outcomes,
 *   - `progress`→ one PATCH per card (later writes for the same card collapse
 *                 into the newest one — last write wins, on purpose).
 * Plans keep the outbox's chronological order so grades replay in the order
 * they were answered.
 */
export function planFlush(queue: QueuedWrite[]): FlushPlan[] {
  interface Group {
    /** Index of the last outbox item merged into this plan (adjacency gate). */
    lastIndex: number;
    plan: FlushPlan;
  }
  const groups: Group[] = [];
  const progressGroups = new Map<string, Group>();

  queue.forEach((item, index) => {
    const key = queueKey(item, index);

    if (item.kind === "progress") {
      const dedupe = progressKey(item.body);
      const existing = progressGroups.get(dedupe);
      if (existing) {
        // Keep the newest payload (and its key), preserve the original
        // position so the overall order still matches the learner's session.
        existing.plan.body = item.body;
        existing.plan.keys = [key];
        existing.lastIndex = index;
        return;
      }
      const group: Group = {
        lastIndex: index,
        plan: {
          url: item.url,
          method: item.method,
          kind: item.kind,
          body: item.body,
          keys: [key],
          entryCount: 1,
        },
      };
      progressGroups.set(dedupe, group);
      groups.push(group);
      return;
    }

    const listKey = item.kind === "review" ? "reviews" : "results";
    const entries = isRecord(item.body) && Array.isArray(item.body[listKey])
      ? (item.body[listKey] as unknown[])
      : [];
    if (entries.length === 0) return;

    const last = groups[groups.length - 1];
    // Only merge *adjacent* entries: a batch that was already sent (and
    // failed) must not be reordered ahead of newer answers.
    const canExtend =
      last &&
      last.plan.kind === item.kind &&
      last.plan.url === item.url &&
      last.lastIndex === index - 1 &&
      (last.plan.body as Record<string, unknown[]>)[listKey].length + entries.length <=
        MAX_BATCH;

    if (canExtend && last) {
      (last.plan.body as Record<string, unknown[]>)[listKey].push(...entries);
      last.plan.keys.push(key);
      last.plan.entryCount += 1;
      last.lastIndex = index;
      return;
    }

    groups.push({
      lastIndex: index,
      plan: {
        url: item.url,
        method: item.method,
        kind: item.kind,
        body: item.kind === "review" ? { reviews: [...entries] } : { results: [...entries] },
        keys: [key],
        entryCount: 1,
      },
    });
  });

  return groups.map((group) => group.plan);
}

export interface FlushResult {
  /** Writes the server accepted (safe to delete from the outbox). */
  syncedKeys: (number | string)[];
  syncedEntries: number;
  /** Writes the server rejected permanently (dropped so they can't poison). */
  droppedKeys: (number | string)[];
  /** True when the network failed — the rest of the queue is kept intact. */
  networkFailed: boolean;
  /** True when the session expired — re-authenticating is the fix, not retrying. */
  authFailed: boolean;
}

/**
 * Drain the outbox through `fetchImpl`.
 *
 * Failure handling is the whole point of this function:
 *   - network error / 5xx / 429 → stop and keep everything (try again later),
 *   - 401/403 → stop and keep everything (the user must sign in again),
 *   - other 4xx → drop those entries (they can never succeed; a poison entry
 *     would otherwise block every later sync),
 *   - 2xx → delete.
 */
export async function flushQueue(input: {
  queue: QueuedWrite[];
  fetchImpl: FetchLike;
  onPlanSuccess?: (plan: FlushPlan) => void;
}): Promise<FlushResult> {
  const result: FlushResult = {
    syncedKeys: [],
    syncedEntries: 0,
    droppedKeys: [],
    networkFailed: false,
    authFailed: false,
  };

  for (const plan of planFlush(input.queue)) {
    let response: FetchLikeResponse;
    try {
      response = await input.fetchImpl(plan.url, {
        method: plan.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(plan.body),
      });
    } catch {
      result.networkFailed = true;
      break;
    }

    if (response.ok) {
      result.syncedKeys.push(...plan.keys);
      result.syncedEntries += plan.entryCount;
      input.onPlanSuccess?.(plan);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      result.authFailed = true;
      break;
    }
    if (response.status >= 500 || response.status === 429) break; // transient
    // 400/404/409/422: invalid or no-longer-existing data.
    result.droppedKeys.push(...plan.keys);
  }

  return result;
}

/** Exponential backoff for a failed drain (0 → retry immediately). */
export function flushBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(FLUSH_BACKOFF_MAX_MS, FLUSH_BACKOFF_BASE_MS * 2 ** (attempts - 1));
}

/** Should the app even try to drain the outbox right now? */
export function canAttemptFlush(
  meta: { lastFailureAt?: string | null; attempts?: number },
  now: Date = new Date()
): boolean {
  if (!meta.lastFailureAt) return true;
  const failedAt = new Date(meta.lastFailureAt).getTime();
  if (Number.isNaN(failedAt)) return true;
  return now.getTime() - failedAt >= flushBackoffMs(meta.attempts ?? 1);
}

/** Did this fetch failure look like "no network" rather than a server error? */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true; // fetch rejects with TypeError
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return /failed to fetch|network|load failed|offline|econnrefused|fetch failed/.test(message);
}
