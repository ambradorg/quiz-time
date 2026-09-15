import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { studySessions, flashcards } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { requireUser } from "@/lib/auth-guard";

const MAX_CARDS = 200;
const VALID_DIFFICULTIES = ["easy", "medium", "hard"];

interface CardInput {
  id?: number;
  question: string;
  answer: string;
  hint?: string | null;
  difficulty?: string;
}

/**
 * PUT /api/sessions/[id]/cards — bulk-save a deck's card list.
 *
 * The deck editor edits locally (add / edit / delete / reorder) and sends the
 * whole list in one request; the array order IS the new order. The server
 * diffs it against what's stored:
 *
 *   - cards whose id is missing from the payload are deleted (cascading to
 *     progress, review schedules and study results),
 *   - cards with a known id are updated in place (so study history, spaced
 *     repetition state and stats keep pointing at the same row),
 *   - cards without an id are inserted.
 *
 * Everything happens in one transaction, so a failure halfway can never
 * leave the deck half-edited.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;

    const { id } = await params;
    const sessionId = parseInt(id, 10);

    // Ownership: a foreign deck is indistinguishable from a nonexistent one.
    const [session] = await db
      .select({ id: studySessions.id, userId: studySessions.userId })
      .from(studySessions)
      .where(eq(studySessions.id, sessionId));
    if (!session || session.userId !== guard.user.id) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const body = await request.json();
    const cards = body?.cards as CardInput[] | undefined;

    if (!Array.isArray(cards) || cards.length === 0) {
      return NextResponse.json(
        { error: "At least one card is required" },
        { status: 400 }
      );
    }
    if (cards.length > MAX_CARDS) {
      return NextResponse.json(
        { error: `That's ${cards.length} cards — please keep it under ${MAX_CARDS}.` },
        { status: 400 }
      );
    }

    const seenIds = new Set<number>();
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (
        typeof card?.question !== "string" || !card.question.trim() ||
        typeof card?.answer !== "string" || !card.answer.trim()
      ) {
        return NextResponse.json(
          { error: `Card ${i + 1} is missing a question or answer` },
          { status: 400 }
        );
      }
      if (card.id !== undefined && card.id !== null) {
        if (!Number.isInteger(card.id)) {
          return NextResponse.json(
            { error: `Card ${i + 1} has an invalid id` },
            { status: 400 }
          );
        }
        if (seenIds.has(card.id)) {
          return NextResponse.json(
            { error: `Card id ${card.id} appears twice in the list` },
            { status: 400 }
          );
        }
        seenIds.add(card.id);
      }
    }

    // Every submitted id must belong to this deck — otherwise a payload could
    // hijack (or delete) another deck's cards just by guessing ids.
    const existing = await db
      .select({ id: flashcards.id })
      .from(flashcards)
      .where(eq(flashcards.sessionId, sessionId));
    const existingIds = new Set(existing.map((c) => c.id));
    for (const cardId of seenIds) {
      if (!existingIds.has(cardId)) {
        return NextResponse.json(
          { error: "Card not found in this session" },
          { status: 404 }
        );
      }
    }

    const toDelete = existing.filter((c) => !seenIds.has(c.id)).map((c) => c.id);

    const normalize = (card: CardInput, orderIndex: number) => {
      const difficulty = String(card.difficulty ?? "")
        .trim()
        .toLowerCase();
      return {
        question: card.question.trim(),
        answer: card.answer.trim(),
        hint:
          typeof card.hint === "string" && card.hint.trim() ? card.hint.trim() : null,
        difficulty: VALID_DIFFICULTIES.includes(difficulty) ? difficulty : "medium",
        orderIndex,
      };
    };

    await db.transaction(async (tx) => {
      if (toDelete.length > 0) {
        // Cascades clean up card_progress, card_reviews and study_results.
        await tx.delete(flashcards).where(inArray(flashcards.id, toDelete));
      }
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        if (card.id !== undefined && card.id !== null) {
          await tx
            .update(flashcards)
            .set(normalize(card, i))
            .where(eq(flashcards.id, card.id));
        }
      }
      const toInsertValues = cards
        .map((card, i) => ({ card, i }))
        .filter(({ card }) => card.id === undefined || card.id === null)
        .map(({ card, i }) => ({ sessionId, ...normalize(card, i) }));
      if (toInsertValues.length > 0) {
        await tx.insert(flashcards).values(toInsertValues);
      }
    });

    const savedCards = await db
      .select()
      .from(flashcards)
      .where(eq(flashcards.sessionId, sessionId))
      .orderBy(flashcards.orderIndex);

    return NextResponse.json({ success: true, cards: savedCards });
  } catch (error) {
    console.error("PUT /api/sessions/[id]/cards error:", error);
    return NextResponse.json({ error: "Failed to save cards" }, { status: 500 });
  }
}
