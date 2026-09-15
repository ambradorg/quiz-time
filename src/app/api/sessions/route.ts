import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { studySessions, flashcards, cardProgress, cardReviews } from "@/db/schema";
import { desc, eq, and, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth-guard";

export async function GET() {
  try {
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;

    // One query instead of one per session: card counts come from the
    // left joins, "known" counts from joining only known progress rows
    // (safe because card_progress has a unique (card_id, session_id) key),
    // and "due now" from the spaced-repetition schedule
    // (card_reviews.user_due_idx). Scoped to the signed-in user's decks.
    const sessions = await db
      .select({
        id: studySessions.id,
        title: studySessions.title,
        sourceType: studySessions.sourceType,
        sourceText: studySessions.sourceText,
        summary: studySessions.summary,
        createdAt: studySessions.createdAt,
        // ::int — pg returns bigint as strings, which breaks numeric
        // comparisons client-side ("9" >= "10" is true as strings).
        cardCount: sql<number>`count(${flashcards.id})::int`,
        knownCount: sql<number>`count(${cardProgress.id})::int`,
        // Spaced repetition: how many cards of this deck are waiting today,
        // so the deck list can badge them without a second request.
        dueCount: sql<number>`count(${cardReviews.id}) filter (where ${cardReviews.dueAt} <= now())::int`,
        trackedCount: sql<number>`count(${cardReviews.id})::int`,
      })
      .from(studySessions)
      .where(eq(studySessions.userId, guard.user.id))
      .leftJoin(flashcards, eq(flashcards.sessionId, studySessions.id))
      .leftJoin(
        cardProgress,
        and(
          eq(cardProgress.sessionId, studySessions.id),
          eq(cardProgress.cardId, flashcards.id),
          eq(cardProgress.isKnown, true)
        )
      )
      .leftJoin(
        cardReviews,
        and(
          eq(cardReviews.sessionId, studySessions.id),
          eq(cardReviews.cardId, flashcards.id),
          eq(cardReviews.userId, guard.user.id)
        )
      )
      .groupBy(studySessions.id)
      .orderBy(desc(studySessions.createdAt));

    return NextResponse.json({ sessions });
  } catch (error) {
    console.error("GET /api/sessions error:", error);
    return NextResponse.json({ error: "Failed to load sessions" }, { status: 500 });
  }
}

const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 500;
const MAX_CARDS = 200;
const VALID_DIFFICULTIES = ["easy", "medium", "hard"];

export async function POST(request: NextRequest) {
  try {
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;

    const body = await request.json();
    const { title, sourceType, sourceText, summary, cards } = body;

    if (typeof title !== "string" || !title.trim()) {
      return NextResponse.json({ error: "A deck title is required" }, { status: 400 });
    }
    if (!cards || !Array.isArray(cards) || cards.length === 0) {
      return NextResponse.json({ error: "At least one card is required" }, { status: 400 });
    }
    if (cards.length > MAX_CARDS) {
      return NextResponse.json(
        { error: `That's ${cards.length} cards — please keep it under ${MAX_CARDS}.` },
        { status: 400 }
      );
    }
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i] as { question?: unknown; answer?: unknown };
      if (typeof card?.question !== "string" || !card.question.trim() ||
          typeof card?.answer !== "string" || !card.answer.trim()) {
        return NextResponse.json(
          { error: `Card ${i + 1} is missing a question or answer` },
          { status: 400 }
        );
      }
    }

    const [session] = await db
      .insert(studySessions)
      .values({
        title: title.trim().slice(0, MAX_TITLE_CHARS),
        sourceType: typeof sourceType === "string" && sourceType.trim() ? sourceType.trim() : "text",
        sourceText: typeof sourceText === "string" ? sourceText : null,
        summary:
          typeof summary === "string" && summary.trim()
            ? summary.trim().slice(0, MAX_SUMMARY_CHARS)
            : null,
        userId: guard.user.id,
      })
      .returning();

    const cardValues = cards.map(
      (card: { question: string; answer: string; hint?: unknown; difficulty?: unknown }, idx: number) => {
        const difficulty = String(card.difficulty ?? "")
          .trim()
          .toLowerCase();
        return {
          sessionId: session.id,
          question: card.question.trim(),
          answer: card.answer.trim(),
          hint: typeof card.hint === "string" && card.hint.trim() ? card.hint.trim() : null,
          difficulty: VALID_DIFFICULTIES.includes(difficulty) ? difficulty : "medium",
          orderIndex: idx,
        };
      }
    );

    const insertedCards = await db
      .insert(flashcards)
      .values(cardValues)
      .returning();

    return NextResponse.json({
      success: true,
      session: { ...session, cardCount: insertedCards.length },
      cards: insertedCards,
    });
  } catch (error) {
    console.error("POST /api/sessions error:", error);
    return NextResponse.json({ error: "Failed to save session" }, { status: 500 });
  }
}
