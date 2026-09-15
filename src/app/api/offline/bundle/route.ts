import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { cardProgress, cardReviews, flashcards, studySessions } from "@/db/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { requireUser } from "@/lib/auth-guard";

/**
 * GET /api/offline/bundle — everything a device needs to study offline, in one
 * request: the decks, their cards, the "know / don't know" progress and the
 * spaced-repetition schedules (`card_reviews`), which `GET /api/sessions/[id]`
 * deliberately leaves out.
 *
 * Query: `?sessionId=<id>` (optional) to bundle a single deck — that is what
 * "Save offline" on a deck row uses; the bare route powers "Download all".
 *
 * Deliberately *read-only* and capped: this endpoint exists so the client can
 * freeze a consistent snapshot in IndexedDB, not to become a sync API. Writes
 * keep flowing through the normal routes (`POST /api/review`,
 * `POST /api/stats/results`, `PATCH /api/sessions/[id]`), which the offline
 * outbox replays verbatim.
 *
 * Truncation is reported so the UI can say "some decks are too large to keep
 * offline" instead of silently saving half a library.
 */
export const dynamic = "force-dynamic";

/** Safety rails: an offline cache is not a backup of an unbounded library. */
const MAX_DECKS = 200;
const MAX_CARDS = 5000;

export async function GET(request: NextRequest) {
  try {
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;
    const userId = guard.user.id;

    const rawSessionId = request.nextUrl.searchParams.get("sessionId");
    const sessionId =
      rawSessionId && /^\d+$/.test(rawSessionId) ? parseInt(rawSessionId, 10) : null;

    const decks = await db
      .select({
        id: studySessions.id,
        title: studySessions.title,
        sourceType: studySessions.sourceType,
        summary: studySessions.summary,
        createdAt: studySessions.createdAt,
      })
      .from(studySessions)
      .where(
        sessionId
          ? and(eq(studySessions.userId, userId), eq(studySessions.id, sessionId))
          : eq(studySessions.userId, userId)
      )
      // Same order as the deck list, so the cache matches what the user sees.
      .orderBy(desc(studySessions.createdAt))
      .limit(MAX_DECKS);

    const deckIds = decks.map((deck) => deck.id);
    if (deckIds.length === 0) {
      return NextResponse.json({
        generatedAt: new Date().toISOString(),
        truncated: false,
        decks: [],
      });
    }

    const [cards, progress, reviews] = await Promise.all([
      db
        .select({
          id: flashcards.id,
          sessionId: flashcards.sessionId,
          question: flashcards.question,
          answer: flashcards.answer,
          hint: flashcards.hint,
          difficulty: flashcards.difficulty,
          orderIndex: flashcards.orderIndex,
        })
        .from(flashcards)
        .where(inArray(flashcards.sessionId, deckIds))
        .orderBy(asc(flashcards.orderIndex)),
      db
        .select({
          cardId: cardProgress.cardId,
          sessionId: cardProgress.sessionId,
          isKnown: cardProgress.isKnown,
          attempts: cardProgress.attempts,
        })
        .from(cardProgress)
        .where(inArray(cardProgress.sessionId, deckIds)),
      db
        .select({
          cardId: cardReviews.cardId,
          sessionId: cardReviews.sessionId,
          dueAt: cardReviews.dueAt,
          lastReviewedAt: cardReviews.lastReviewedAt,
          createdAt: cardReviews.createdAt,
          ease: cardReviews.ease,
          intervalDays: cardReviews.intervalDays,
          reps: cardReviews.reps,
          lapses: cardReviews.lapses,
          learningStep: cardReviews.learningStep,
          reviewCount: cardReviews.reviewCount,
          lastGrade: cardReviews.lastGrade,
        })
        .from(cardReviews)
        .where(and(eq(cardReviews.userId, userId), inArray(cardReviews.sessionId, deckIds))),
    ]);

    // Card budget: fill in deck order (newest first) and stop when it runs
    // out, so the newest sets — the ones a learner is actively studying — are
    // always the ones that make it.
    const cardCounts = new Map<number, number>();
    for (const card of cards) {
      cardCounts.set(card.sessionId, (cardCounts.get(card.sessionId) ?? 0) + 1);
    }
    const included = new Set<number>();
    let budget = MAX_CARDS;
    let truncated = decks.length >= MAX_DECKS;
    for (const deck of decks) {
      const count = cardCounts.get(deck.id) ?? 0;
      if (count > budget) {
        truncated = true;
        continue;
      }
      budget -= count;
      included.add(deck.id);
    }

    // Rows keep their `sessionId` (harmless extra field on the client) so the
    // payload can be handed to the client builders as-is.
    const keep = decks.filter((deck) => included.has(deck.id));
    const payload = keep.map((deck) => ({
      session: deck,
      cards: cards.filter((card) => card.sessionId === deck.id),
      progress: progress.filter((row) => row.sessionId === deck.id),
      reviews: reviews.filter((row) => row.sessionId === deck.id),
    }));

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      truncated,
      decks: payload,
    });
  } catch (error) {
    console.error("GET /api/offline/bundle error:", error);
    return NextResponse.json({ error: "Failed to prepare offline data" }, { status: 500 });
  }
}
