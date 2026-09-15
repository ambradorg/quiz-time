import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { cardReviews, cardProgress, flashcards, studyResults, studySessions } from "@/db/schema";
import { and, asc, desc, eq, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { requireUser } from "@/lib/auth-guard";
import {
  NEW_CARDS_PER_DAY,
  REVIEW_GRADES,
  dueLabel,
  scheduleCard,
  type ReviewGrade,
  type SrsState,
} from "@/lib/srs";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_BATCH = 100;

/** Persisted scheduler columns (a `card_reviews` row). */
interface ReviewRow {
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  learningStep: number;
  reviewCount: number;
  lastGrade: string | null;
}

/** Turn a `card_reviews` row into the scheduler's pure state shape. */
function toSrsState(row: ReviewRow): SrsState {
  return {
    ease: row.ease,
    intervalDays: row.intervalDays,
    reps: row.reps,
    lapses: row.lapses,
    learningStep: row.learningStep,
    reviewCount: row.reviewCount,
    lastGrade: (row.lastGrade as ReviewGrade | null) ?? null,
  };
}

/** Grades come straight off the wire, so they are validated, never trusted. */
function isValidGrade(value: unknown): value is ReviewGrade {
  return typeof value === "string" && (REVIEW_GRADES as string[]).includes(value);
}

/**
 * GET /api/review — the spaced-repetition queue for the signed-in user.
 *
 * Query: `?sessionId=<id>` (optional, review one deck) and `?limit=<n>`
 * (1-100, default 20).
 *
 * Response:
 *   counts     – how much work is waiting (due / learning / new / tracked…)
 *   queue      – the cards to review now, overdue first, then new cards
 *   decks      – per-deck due counts for the "My Study Sets" badges
 *   nextDueAt  – when the *next* card becomes due (the "all caught up" state)
 *
 * Everything is scoped to the user id: a sessionId belonging to somebody else
 * simply returns an empty queue (never another user's cards).
 */
export async function GET(request: NextRequest) {
  try {
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;
    const userId = guard.user.id;

    const params = request.nextUrl.searchParams;
    const rawSessionId = params.get("sessionId");
    const sessionId =
      rawSessionId && /^\d+$/.test(rawSessionId) ? parseInt(rawSessionId, 10) : null;
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.parseInt(params.get("limit") ?? "", 10) || DEFAULT_LIMIT)
    );

    const scope = sessionId
      ? and(eq(studySessions.userId, userId), eq(studySessions.id, sessionId))
      : eq(studySessions.userId, userId);

    // Cards the user owns, joined with their schedule (null = never reviewed).
    // Built lazily because the same projection feeds two differently-filtered
    // queries (due cards and brand-new cards) — `.where()` can only be used
    // once per builder, so the extra condition is a parameter.
    const cardsQuery = (extra?: SQL) =>
      db
        .select({
          cardId: flashcards.id,
          sessionId: flashcards.sessionId,
          question: flashcards.question,
          answer: flashcards.answer,
          hint: flashcards.hint,
          difficulty: flashcards.difficulty,
          orderIndex: flashcards.orderIndex,
          deckTitle: studySessions.title,
          deckCreatedAt: studySessions.createdAt,
          reviewId: cardReviews.id,
          ease: cardReviews.ease,
          intervalDays: cardReviews.intervalDays,
          reps: cardReviews.reps,
          lapses: cardReviews.lapses,
          learningStep: cardReviews.learningStep,
          reviewCount: cardReviews.reviewCount,
          lastGrade: cardReviews.lastGrade,
          lastReviewedAt: cardReviews.lastReviewedAt,
          dueAt: cardReviews.dueAt,
        })
        .from(flashcards)
        .innerJoin(studySessions, eq(studySessions.id, flashcards.sessionId))
        .leftJoin(
          cardReviews,
          and(eq(cardReviews.cardId, flashcards.id), eq(cardReviews.userId, userId))
        )
        .where(extra ? and(scope, extra) : scope);

    const countsQuery = () =>
      db
        .select({
          tracked: sql<number>`count(${cardReviews.id})::int`,
          learning: sql<number>`count(*) filter (where ${cardReviews.intervalDays} = 0)::int`,
          due: sql<number>`count(*) filter (where ${cardReviews.dueAt} <= now())::int`,
        })
        .from(cardReviews)
        .where(
          and(
            eq(cardReviews.userId, userId),
            sessionId ? eq(cardReviews.sessionId, sessionId) : undefined
          )
        );

    const [introducedTodayRes, countsRes, decksRes, dueCards, newCards, nextDueRes] =
      await Promise.all([
        // A card_reviews row is created the first time a card is graded, so
        // "introduced today" = rows created today. Same server-side day
        // boundary the streak calculation uses.
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(cardReviews)
          .where(
            and(
              eq(cardReviews.userId, userId),
              sql`${cardReviews.createdAt} >= date_trunc('day', now())`
            )
          ),

        countsQuery(),

        // Per-deck rollup: one pass over the user's cards, so the deck list
        // badges need no extra request. `filter (where …)` keeps it cheap.
        db
          .select({
            sessionId: studySessions.id,
            title: studySessions.title,
            cardCount: sql<number>`count(${flashcards.id})::int`,
            trackedCount: sql<number>`count(${cardReviews.id})::int`,
            dueCount: sql<number>`count(*) filter (where ${cardReviews.dueAt} <= now())::int`,
            newCount: sql<number>`count(*) filter (where ${cardReviews.id} is null)::int`,
            nextDueAt: sql<Date | null>`min(${cardReviews.dueAt}) filter (where ${cardReviews.dueAt} > now())`,
          })
          .from(studySessions)
          .leftJoin(flashcards, eq(flashcards.sessionId, studySessions.id))
          .leftJoin(
            cardReviews,
            and(eq(cardReviews.cardId, flashcards.id), eq(cardReviews.userId, userId))
          )
          .where(scope)
          .groupBy(studySessions.id, studySessions.title)
          .orderBy(desc(studySessions.createdAt)),

        // Overdue first, then whatever else is already due.
        cardsQuery(and(sql`${cardReviews.id} is not null`, lte(cardReviews.dueAt, sql`now()`)))
          .orderBy(asc(cardReviews.dueAt), asc(flashcards.orderIndex))
          .limit(limit),

        // Never-reviewed cards come after the reviews the learner owes.
        cardsQuery(isNull(cardReviews.id))
          .orderBy(asc(studySessions.createdAt), asc(flashcards.orderIndex))
          .limit(limit),

        db
          .select({ nextDueAt: sql<Date | null>`min(${cardReviews.dueAt})` })
          .from(cardReviews)
          .where(
            and(
              eq(cardReviews.userId, userId),
              sql`${cardReviews.dueAt} > now()`,
              sessionId ? eq(cardReviews.sessionId, sessionId) : undefined
            )
          ),
      ]);

    const introducedToday = introducedTodayRes[0]?.count ?? 0;
    const newAllowance = Math.max(0, NEW_CARDS_PER_DAY - introducedToday);
    const counts = countsRes[0] ?? { tracked: 0, learning: 0, due: 0 };

    // The queue is capped overall, and new cards are throttled by the daily
    // allowance so a freshly generated 80-card deck isn't dumped in one go.
    const merged = [...dueCards, ...newCards.slice(0, newAllowance)].slice(0, limit);

    const now = new Date();
    const toIso = (value: Date | string | null | undefined) =>
      value === null || value === undefined ? null : new Date(value).toISOString();

    const queue = merged.map((row) => ({
      cardId: row.cardId,
      sessionId: row.sessionId,
      question: row.question,
      answer: row.answer,
      hint: row.hint,
      difficulty: row.difficulty,
      deckTitle: row.deckTitle,
      isNew: row.reviewId === null,
      dueAt: row.reviewId === null ? null : toIso(row.dueAt),
      // null = never reviewed: the scheduler treats it as a brand-new card
      // (1 min → 10 min → graduate to a day).
      state: row.reviewId === null ? null : toSrsState(row as ReviewRow),
    }));

    const totalNew = sessionId
      ? (decksRes.find((d) => d.sessionId === sessionId)?.newCount ?? 0)
      : decksRes.reduce((sum, d) => sum + d.newCount, 0);

    return NextResponse.json({
      now: now.toISOString(),
      sessionId,
      counts: {
        due: counts.due,
        learning: counts.learning,
        tracked: counts.tracked,
        newCards: totalNew,
        newRemainingToday: Math.min(newAllowance, totalNew),
        // How many brand-new cards were introduced today — the "5/20 new"
        // counter on the review screen (it is not just "allowance - left",
        // because a learner with only 3 cards never uses the whole budget).
        newIntroducedToday: introducedToday,
        newPerDay: NEW_CARDS_PER_DAY,
      },
      nextDueAt: toIso(nextDueRes[0]?.nextDueAt ?? null),
      decks: decksRes.map((d) => ({
        sessionId: d.sessionId,
        title: d.title,
        cardCount: d.cardCount,
        trackedCount: d.trackedCount,
        dueCount: d.dueCount,
        newCount: d.newCount,
        nextDueAt: toIso(d.nextDueAt),
        nextDueLabel: dueLabel(d.nextDueAt, now),
      })),
      queue,
    });
  } catch (error) {
    console.error("GET /api/review error:", error);
    return NextResponse.json({ error: "Failed to load the review queue" }, { status: 500 });
  }
}

/**
 * POST /api/review — grade cards (SM-2) and advance their schedule.
 *
 * Body: `{ reviews: [{ cardId, sessionId, grade, reviewedAt? }] }`
 * (grade ∈ again | hard | good | easy, max 100 entries per request.)
 *
 * Each accepted entry is applied by `scheduleCard()` **on the server** — the
 * client's optimistic preview and the stored state therefore can't drift —
 * and produces:
 *   1. an upsert of `card_reviews` (the schedule),
 *   2. a `study_results` row with mode 'review', so reviews count towards the
 *      streak, accuracy and per-deck stats exactly like the other modes,
 *   3. a `card_progress` touch (the "Got it / Still learning" badge).
 *
 * Deck *and* card ownership are verified per entry; entries pointing at
 * somebody else's data are skipped and reported in `skipped`.
 */
export async function POST(request: NextRequest) {
  try {
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;
    const userId = guard.user.id;

    const body = await request.json().catch(() => null);
    const reviews = body?.reviews;
    if (!Array.isArray(reviews) || reviews.length === 0) {
      return NextResponse.json({ error: "reviews (non-empty array) is required" }, { status: 400 });
    }
    if (reviews.length > MAX_BATCH) {
      return NextResponse.json(
        { error: `Too many reviews — please send at most ${MAX_BATCH} per request` },
        { status: 400 }
      );
    }

    type Pending = { cardId: number; sessionId: number; grade: ReviewGrade; reviewedAt: Date };
    const candidates: Pending[] = [];
    const skipped: { index: number; reason: string }[] = [];

    reviews.forEach((raw, index) => {
      const r = raw as {
        cardId?: unknown;
        sessionId?: unknown;
        grade?: unknown;
        reviewedAt?: unknown;
      };
      if (!Number.isInteger(r?.cardId) || !Number.isInteger(r?.sessionId)) {
        skipped.push({ index, reason: "cardId and sessionId (integers) are required" });
        return;
      }
      if (!isValidGrade(r?.grade)) {
        skipped.push({ index, reason: "grade must be again, hard, good or easy" });
        return;
      }
      // Client clocks drift — anything more than a day out is ignored in
      // favour of the server's "now" (same rule as POST /api/stats/results).
      let reviewedAt = new Date();
      if (typeof r.reviewedAt === "string" || typeof r.reviewedAt === "number") {
        const parsed = new Date(r.reviewedAt);
        if (
          !Number.isNaN(parsed.getTime()) &&
          Math.abs(parsed.getTime() - Date.now()) <= 24 * 60 * 60 * 1000
        ) {
          reviewedAt = parsed;
        }
      }
      candidates.push({
        cardId: r.cardId as number,
        sessionId: r.sessionId as number,
        grade: r.grade,
        reviewedAt,
      });
    });

    // ── Ownership: the deck AND the card must belong to the signed-in user ──
    const sessionIds = [...new Set(candidates.map((c) => c.sessionId))];
    const cardIds = [...new Set(candidates.map((c) => c.cardId))];

    const [ownedSessions, ownedCards, existing] = await Promise.all([
      sessionIds.length
        ? db
            .select({ id: studySessions.id })
            .from(studySessions)
            .where(and(inArray(studySessions.id, sessionIds), eq(studySessions.userId, userId)))
        : Promise.resolve([] as { id: number }[]),
      cardIds.length
        ? db
            .select({ id: flashcards.id, sessionId: flashcards.sessionId })
            .from(flashcards)
            .where(inArray(flashcards.id, cardIds))
        : Promise.resolve([] as { id: number; sessionId: number }[]),
      cardIds.length
        ? db
            .select()
            .from(cardReviews)
            .where(and(eq(cardReviews.userId, userId), inArray(cardReviews.cardId, cardIds)))
        : Promise.resolve([] as (typeof cardReviews.$inferSelect)[]),
    ]);

    const ownedSessionIds = new Set(ownedSessions.map((s) => s.id));
    const cardSession = new Map(ownedCards.map((c) => [c.id, c.sessionId]));
    const stateByCard = new Map(existing.map((row) => [row.cardId, toSrsState(row)]));

    // Grades are applied in order per card, so two entries for the same card
    // in one batch (rare, but legal) walk the schedule twice instead of the
    // second one silently overwriting the first.
    const applied: {
      cardId: number;
      sessionId: number;
      grade: ReviewGrade;
      reviewedAt: Date;
      next: ReturnType<typeof scheduleCard>;
    }[] = [];

    candidates.forEach((c, index) => {
      if (!ownedSessionIds.has(c.sessionId)) {
        skipped.push({ index, reason: "Session not found" });
        return;
      }
      if (cardSession.get(c.cardId) !== c.sessionId) {
        skipped.push({ index, reason: "Card not found in this session" });
        return;
      }
      const next = scheduleCard(stateByCard.get(c.cardId) ?? null, c.grade, c.reviewedAt);
      stateByCard.set(c.cardId, next);
      applied.push({ ...c, next });
    });

    if (applied.length === 0) {
      return NextResponse.json({ success: true, recorded: 0, skipped, results: [] });
    }

    await db.transaction(async (tx) => {
      for (const entry of applied) {
        const { next, grade, cardId, sessionId, reviewedAt } = entry;

        await tx
          .insert(cardReviews)
          .values({
            userId,
            sessionId,
            cardId,
            ease: next.ease,
            intervalDays: next.intervalDays,
            reps: next.reps,
            lapses: next.lapses,
            learningStep: next.learningStep,
            reviewCount: next.reviewCount,
            lastGrade: grade,
            lastReviewedAt: reviewedAt,
            dueAt: next.dueAt,
          })
          .onConflictDoUpdate({
            target: [cardReviews.userId, cardReviews.cardId],
            set: {
              sessionId,
              ease: next.ease,
              intervalDays: next.intervalDays,
              reps: next.reps,
              lapses: next.lapses,
              learningStep: next.learningStep,
              reviewCount: next.reviewCount,
              lastGrade: grade,
              lastReviewedAt: reviewedAt,
              dueAt: next.dueAt,
            },
          });

        // A review is a study outcome too: "again" is a miss, everything
        // else is a successful recall.
        await tx.insert(studyResults).values({
          userId,
          sessionId,
          cardId,
          correct: grade !== "again",
          mode: "review",
          answeredAt: reviewedAt,
        });

        await tx
          .insert(cardProgress)
          .values({
            cardId,
            sessionId,
            isKnown: grade !== "again",
            attempts: 1,
            lastReviewedAt: reviewedAt,
          })
          .onConflictDoUpdate({
            target: [cardProgress.cardId, cardProgress.sessionId],
            set: {
              isKnown: grade !== "again",
              attempts: sql`${cardProgress.attempts} + 1`,
              lastReviewedAt: reviewedAt,
            },
          });
      }
    });

    const now = new Date();
    return NextResponse.json({
      success: true,
      recorded: applied.length,
      skipped,
      results: applied.map((entry) => ({
        cardId: entry.cardId,
        sessionId: entry.sessionId,
        grade: entry.grade,
        intervalDays: entry.next.intervalDays,
        dueAt: entry.next.dueAt.toISOString(),
        dueLabel: dueLabel(entry.next.dueAt, now),
        state: {
          ease: entry.next.ease,
          intervalDays: entry.next.intervalDays,
          reps: entry.next.reps,
          lapses: entry.next.lapses,
          learningStep: entry.next.learningStep,
          reviewCount: entry.next.reviewCount,
          lastGrade: entry.grade,
        } satisfies SrsState,
      })),
    });
  } catch (error) {
    console.error("POST /api/review error:", error);
    return NextResponse.json({ error: "Failed to record reviews" }, { status: 500 });
  }
}
