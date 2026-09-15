import { NextResponse } from "next/server";
import { db } from "@/db";
import { studySessions, flashcards, studyResults, cardReviews } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth-guard";

const RECENT_LIMIT = 50;

/**
 * GET /api/stats — study statistics for the signed-in user.
 *
 * Every query is filtered by user id: a user can only ever see their own
 * decks and outcomes. Decks that predate this feature simply have no
 * study_results rows and come back as zeros (the UI renders a friendly
 * empty state rather than breaking).
 */
export async function GET() {
  try {
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;

    const userId = guard.user.id;

    // Streak = consecutive calendar days with at least one recorded answer,
    // counted back from today. Studying yesterday but not yet today keeps
    // the streak alive; a missed day resets it to 0. The gaps-and-islands
    // trick (day - row_number) groups consecutive days; only the island
    // that reaches today/yesterday is the live streak.
    const streakQuery = sql<{ streak: number }>`
      select coalesce((
        select (max(day) - min(day) + 1)::int
        from (
          select day,
                 day - (row_number() over (order by day))::int * interval '1 day' as grp
          from (
            select distinct date_trunc('day', answered_at)::date as day
            from study_results
            where user_id = ${userId}
          ) days
        ) grouped
        group by grp
        having max(day) >= current_date - 1
        order by max(day) desc
        limit 1
      ), 0)::int as streak`;

    const [overallRows, deckRows, recentRows, streakRes, reviewRows, reviewDeckRows] =
      await Promise.all([
      db
        .select({
          // ::int everywhere — pg returns bigint for count(*) as a string,
          // which breaks Drizzle's number typing and client-side math.
          totalAnswers: sql<number>`count(*)::int`,
          correctAnswers: sql<number>`count(*) filter (where ${studyResults.correct})::int`,
          cardsStudied: sql<number>`count(distinct ${studyResults.cardId})::int`,
          studySessions: sql<number>`count(distinct ${studyResults.sessionId})::int`,
          lastStudiedAt: sql<Date | null>`max(${studyResults.answeredAt})`,
        })
        .from(studyResults)
        .where(eq(studyResults.userId, userId)),

      // One row per deck the user owns — including decks with zero results
      // (left joins), so pre-existing decks show up with a friendly "not
      // studied yet" state instead of disappearing.
      db
        .select({
          sessionId: studySessions.id,
          title: studySessions.title,
          sourceType: studySessions.sourceType,
          cardCount: sql<number>`count(distinct ${flashcards.id})::int`,
          studiedCount: sql<number>`count(distinct ${studyResults.cardId})::int`,
          answerCount: sql<number>`count(${studyResults.id})::int`,
          correctCount: sql<number>`count(*) filter (where ${studyResults.correct})::int`,
          lastStudiedAt: sql<Date | null>`max(${studyResults.answeredAt})`,
        })
        .from(studySessions)
        .where(eq(studySessions.userId, userId))
        .leftJoin(flashcards, eq(flashcards.sessionId, studySessions.id))
        .leftJoin(
          studyResults,
          and(
            eq(studyResults.sessionId, studySessions.id),
            eq(studyResults.cardId, flashcards.id),
            eq(studyResults.userId, userId)
          )
        )
        .groupBy(studySessions.id)
        .orderBy(desc(studySessions.createdAt)),

      // Recent activity feed: the last answers with just enough context
      // (deck title + question) to be useful. Text is truncated server-side.
      db
        .select({
          id: studyResults.id,
          sessionId: studyResults.sessionId,
          cardId: studyResults.cardId,
          correct: studyResults.correct,
          mode: studyResults.mode,
          answeredAt: studyResults.answeredAt,
          deckTitle: studySessions.title,
          question: sql<string>`left(${flashcards.question}, 90)`,
        })
        .from(studyResults)
        .innerJoin(studySessions, eq(studySessions.id, studyResults.sessionId))
        .innerJoin(flashcards, eq(flashcards.id, studyResults.cardId))
        .where(eq(studyResults.userId, userId))
        .orderBy(desc(studyResults.answeredAt), desc(studyResults.id))
        .limit(RECENT_LIMIT),

        // Standalone expression (no FROM) — always returns exactly one row,
        // even for a brand-new user with zero results.
        db.execute(streakQuery),

        // Spaced repetition (P4). Kept out of the deck query on purpose:
        // joining study_results *and* card_reviews would multiply rows and
        // inflate every count. One row per user, one row per deck.
        db
          .select({
            tracked: sql<number>`count(*)::int`,
            dueNow: sql<number>`count(*) filter (where ${cardReviews.dueAt} <= now())::int`,
            learning: sql<number>`count(*) filter (where ${cardReviews.intervalDays} = 0)::int`,
            mature: sql<number>`count(*) filter (where ${cardReviews.intervalDays} >= 21)::int`,
            lapses: sql<number>`coalesce(sum(${cardReviews.lapses}), 0)::int`,
            reviewedToday: sql<number>`count(*) filter (where ${cardReviews.lastReviewedAt} >= date_trunc('day', now()))::int`,
            nextDueAt: sql<Date | null>`min(${cardReviews.dueAt}) filter (where ${cardReviews.dueAt} > now())`,
          })
          .from(cardReviews)
          .where(eq(cardReviews.userId, userId)),

        db
          .select({
            sessionId: cardReviews.sessionId,
            tracked: sql<number>`count(*)::int`,
            dueNow: sql<number>`count(*) filter (where ${cardReviews.dueAt} <= now())::int`,
            mature: sql<number>`count(*) filter (where ${cardReviews.intervalDays} >= 21)::int`,
            nextDueAt: sql<Date | null>`min(${cardReviews.dueAt}) filter (where ${cardReviews.dueAt} > now())`,
          })
          .from(cardReviews)
          .where(eq(cardReviews.userId, userId))
          .groupBy(cardReviews.sessionId),
      ]);

    const totals = overallRows[0] ?? {
      totalAnswers: 0,
      correctAnswers: 0,
      cardsStudied: 0,
      studySessions: 0,
      lastStudiedAt: null,
    };
    const streak = Number(streakRes.rows?.[0]?.streak ?? 0);

    // max() over a raw sql fragment comes back as pg's text representation
    // ("2026-09-12 07:53:55.315446") instead of a Date — normalize to ISO so
    // every client parses it identically. (timestamp columns are UTC-naive
    // and the server reads them as UTC, so the round-trip is lossless.)
    const toIso = (value: Date | string | null): string | null =>
      value === null || value === undefined ? null : new Date(value).toISOString();

    const reviewByDeck = new Map(reviewDeckRows.map((r) => [r.sessionId, r]));

    const decks = deckRows.map((d) => {
      const accuracy = d.answerCount > 0 ? Math.round((d.correctCount / d.answerCount) * 100) : null;
      const mastery = d.cardCount > 0 ? Math.round((d.studiedCount / d.cardCount) * 100) : 0;
      const review = reviewByDeck.get(d.sessionId);
      const tracked = review?.tracked ?? 0;
      return {
        ...d,
        accuracy,
        mastery,
        lastStudiedAt: toIso(d.lastStudiedAt),
        // Spaced repetition rollup for this deck.
        trackedCount: tracked,
        dueCount: review?.dueNow ?? 0,
        matureCount: review?.mature ?? 0,
        newCount: Math.max(0, d.cardCount - tracked),
        nextDueAt: toIso(review?.nextDueAt ?? null),
      };
    });

    const reviews = reviewRows[0] ?? {
      tracked: 0,
      dueNow: 0,
      learning: 0,
      mature: 0,
      lapses: 0,
      reviewedToday: 0,
      nextDueAt: null as Date | null,
    };

    return NextResponse.json({
      overall: {
        totalAnswers: totals.totalAnswers,
        correctAnswers: totals.correctAnswers,
        incorrectAnswers: totals.totalAnswers - totals.correctAnswers,
        cardsStudied: totals.cardsStudied,
        studySessions: totals.studySessions,
        streak,
        accuracy:
          totals.totalAnswers > 0
            ? Math.round((totals.correctAnswers / totals.totalAnswers) * 100)
            : null,
        lastStudiedAt: toIso(totals.lastStudiedAt),
        // Cards in the spaced-repetition rotation and how many are waiting.
        reviewsTracked: reviews.tracked,
        dueNow: reviews.dueNow,
        learning: reviews.learning,
        mature: reviews.mature,
        lapses: reviews.lapses,
        reviewedToday: reviews.reviewedToday,
        nextDueAt: toIso(reviews.nextDueAt),
      },
      decks,
      recent: recentRows,
    });
  } catch (error) {
    console.error("GET /api/stats error:", error);
    return NextResponse.json({ error: "Failed to load stats" }, { status: 500 });
  }
}
