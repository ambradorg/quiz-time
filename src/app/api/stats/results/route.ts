import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { studySessions, flashcards, studyResults } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { requireUser } from "@/lib/auth-guard";

const MAX_BATCH = 100;
// "review" is written server-side by POST /api/review (spaced repetition),
// but it is accepted here too so a queued client batch is never rejected.
const VALID_MODES = ["study", "exam", "identify", "enumerate", "review"];

/**
 * POST /api/stats/results — record card-level study outcomes.
 *
 * Every answered card (Study mode self-check, Exam mode multiple choice,
 * Identification typing and Enumeration listing) produces one row: which
 * deck, which card, right/wrong, when. This per-card signal feeds the
 * Stats tab *and* the spaced-repetition scheduler (src/lib/srs.ts), so it is
 * stored durably server-side, scoped to the signed-in user.
 *
 * Body: { results: [{ sessionId, cardId, correct, mode?, answeredAt? }] }
 * Invalid entries are skipped and reported back — a card that doesn't
 * belong to the user's deck can never be written, even in a mixed batch.
 */
export async function POST(request: NextRequest) {
  try {
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;

    const body = await request.json().catch(() => null);
    const results = body?.results;
    if (!Array.isArray(results) || results.length === 0) {
      return NextResponse.json(
        { error: "results (non-empty array) is required" },
        { status: 400 }
      );
    }
    if (results.length > MAX_BATCH) {
      return NextResponse.json(
        { error: `Too many results — please send at most ${MAX_BATCH} per request` },
        { status: 400 }
      );
    }

    // ── Shape validation ───────────────────────────────────────────────────
    type Pending = {
      sessionId: number;
      cardId: number;
      correct: boolean;
      mode: string;
      answeredAt: Date;
    };
    const candidates: Pending[] = [];
    const invalid: { index: number; reason: string }[] = [];

    results.forEach((raw, index) => {
      const r = raw as {
        sessionId?: unknown;
        cardId?: unknown;
        correct?: unknown;
        mode?: unknown;
        answeredAt?: unknown;
      };
      if (!Number.isInteger(r?.sessionId) || !Number.isInteger(r?.cardId)) {
        invalid.push({ index, reason: "sessionId and cardId (integers) are required" });
        return;
      }
      if (typeof r.correct !== "boolean") {
        invalid.push({ index, reason: "correct (boolean) is required" });
        return;
      }
      const mode = typeof r.mode === "string" ? r.mode.trim().toLowerCase() : "study";

      // Client clocks are unreliable — only accept timestamps within a sane
      // window, otherwise fall back to the server's "now".
      let answeredAt = new Date();
      if (typeof r.answeredAt === "string" || typeof r.answeredAt === "number") {
        const parsed = new Date(r.answeredAt);
        const drift = parsed.getTime() - Date.now();
        if (!Number.isNaN(parsed.getTime()) && Math.abs(drift) <= 24 * 60 * 60 * 1000) {
          answeredAt = parsed;
        }
      }

      candidates.push({
        sessionId: r.sessionId as number,
        cardId: r.cardId as number,
        correct: r.correct,
        mode: VALID_MODES.includes(mode) ? mode : "study",
        answeredAt,
      });
    });

    // ── Ownership: the deck AND the card must belong to the signed-in user ──
    // (loadOwnedSession semantics, batched). Cards are checked against both
    // the session id in the payload and the deck owner, so a guessed id can
    // never write into someone else's data.
    const sessionIds = [...new Set(candidates.map((c) => c.sessionId))];
    const cardIds = [...new Set(candidates.map((c) => c.cardId))];

    const [ownedSessions, ownedCards] = await Promise.all([
      sessionIds.length
        ? db
            .select({ id: studySessions.id })
            .from(studySessions)
            .where(and(inArray(studySessions.id, sessionIds), eq(studySessions.userId, guard.user.id)))
        : Promise.resolve([]),
      cardIds.length
        ? db
            .select({ id: flashcards.id, sessionId: flashcards.sessionId })
            .from(flashcards)
            .where(inArray(flashcards.id, cardIds))
        : Promise.resolve([]),
    ]);

    const ownedSessionIds = new Set(ownedSessions.map((s) => s.id));
    const cardSession = new Map(ownedCards.map((c) => [c.id, c.sessionId]));

    const rows = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (!ownedSessionIds.has(c.sessionId)) {
        invalid.push({ index: i, reason: "Session not found" });
        continue;
      }
      if (cardSession.get(c.cardId) !== c.sessionId) {
        invalid.push({ index: i, reason: "Card not found in this session" });
        continue;
      }
      rows.push({
        userId: guard.user.id,
        sessionId: c.sessionId,
        cardId: c.cardId,
        correct: c.correct,
        mode: c.mode,
        answeredAt: c.answeredAt,
      });
    }

    if (rows.length > 0) {
      await db.insert(studyResults).values(rows);
    }

    return NextResponse.json({ success: true, recorded: rows.length, invalid });
  } catch (error) {
    console.error("POST /api/stats/results error:", error);
    return NextResponse.json({ error: "Failed to record study results" }, { status: 500 });
  }
}
