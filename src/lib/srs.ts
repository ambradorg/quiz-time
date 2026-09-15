/**
 * Spaced repetition scheduler (P4).
 *
 * Pure, dependency-free and isomorphic: the server (`/api/review`) is the
 * single source of truth and persists whatever this module returns, while the
 * client imports the very same functions to preview "Again · 1 min",
 * "Good · 3 days" on the grade buttons and to keep the review queue in sync
 * while a request is in flight. Because there is no I/O — and no randomness —
 * in here, every decision is unit-testable (`scripts/srs.test.mjs`).
 *
 * The algorithm is an SM-2 descendant (SuperMemo 2 via the four-button
 * "Again / Hard / Good / Easy" variant popularised by Anki):
 *
 * - A **new** card starts in a short *learning* phase measured in minutes
 *   (`LEARNING_STEPS_MINUTES`). Answering Good walks up the steps and then
 *   graduates the card to a 1-day interval; Easy graduates immediately to
 *   4 days.
 * - A **review** card (interval ≥ 1 day) multiplies its interval by its
 *   *ease factor* on Good, by a smaller 1.2× on Hard and by ease × 1.3 on
 *   Easy. Hard/Easy nudge the ease factor down/up, and only Again (a *lapse*)
 *   sends a card back to a 10-minute relearning step.
 * - Intervals are clamped to `[1 day, MAX_INTERVAL_DAYS]` and the ease factor
 *   to `[MIN_EASE, MAX_EASE]`, so no card can drift into a 10-year interval
 *   or become impossible to fix.
 */

/** The four answers a learner can give after revealing a card. */
export type ReviewGrade = "again" | "hard" | "good" | "easy";

/** Grade order as rendered in the UI (worst → best). */
export const REVIEW_GRADES: ReviewGrade[] = ["again", "hard", "good", "easy"];

export const GRADE_LABELS: Record<ReviewGrade, string> = {
  again: "Again",
  hard: "Hard",
  good: "Good",
  easy: "Easy",
};

/** Keyboard shortcuts for the grade buttons (1-4). */
export const GRADE_SHORTCUTS: Record<ReviewGrade, string> = {
  again: "1",
  hard: "2",
  good: "3",
  easy: "4",
};

/** Sub-day learning steps (minutes) a brand-new card walks through. */
export const LEARNING_STEPS_MINUTES = [1, 10];

/** Relearning step (minutes) a lapsed review card comes back after. */
export const RELEARN_STEP_MINUTES = 10;

/** Ease factor new cards start at (SM-2's classic 2.5). */
export const DEFAULT_EASE = 2.5;
export const MIN_EASE = 1.3;
export const MAX_EASE = 2.8;

/** Interval a learning card graduates to on "Good". */
export const GRADUATING_INTERVAL_DAYS = 1;
/** Interval a learning card graduates to on "Easy". */
export const EASY_GRADUATING_INTERVAL_DAYS = 4;

/** Interval multipliers for review cards. */
export const HARD_MULTIPLIER = 1.2;
export const EASY_BONUS = 1.3;

/** Ease-factor deltas per grade. */
export const EASE_DELTA: Record<ReviewGrade, number> = {
  again: -0.2,
  hard: -0.15,
  good: 0,
  easy: 0.15,
};

/** Hard keeps a learning card on its current step, 50% later. */
export const LEARNING_HARD_MULTIPLIER = 1.5;

/** Nothing is ever scheduled further out than this (a year). */
export const MAX_INTERVAL_DAYS = 365;

/** How many *brand-new* cards a learner is handed per day (Anki-style cap). */
export const NEW_CARDS_PER_DAY = 20;

/**
 * How many times a card answered "Again" is pushed back into the current
 * queue, so a forgotten card is seen again before the session ends without
 * letting one card trap the learner in an endless loop.
 */
export const MAX_REQUEUES_PER_CARD = 2;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * The persisted half of a card's repetition state (see `card_reviews` in
 * src/db/schema.ts). `dueAt`/`lastReviewedAt` live alongside it in the row.
 */
export interface SrsState {
  /** SM-2 ease factor. */
  ease: number;
  /** Days until the next review; `0` means "still learning" (see dueAt). */
  intervalDays: number;
  /** Consecutive successful reviews — resets to 0 on a lapse. */
  reps: number;
  /** Times the card was forgotten after graduating to review. */
  lapses: number;
  /** Position in the learning/relearning steps while intervalDays === 0. */
  learningStep: number;
  /** Total times the card has been graded. */
  reviewCount: number;
  /** The most recent grade, for the UI's "last answer" hints. */
  lastGrade: ReviewGrade | null;
}

/** A state plus the timestamps it implies. */
export interface ScheduledState extends SrsState {
  dueAt: Date;
  lastReviewedAt: Date;
}

/** A fresh state for a card that has never been reviewed. */
export function initialState(): SrsState {
  return {
    ease: DEFAULT_EASE,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    learningStep: 0,
    reviewCount: 0,
    lastGrade: null,
  };
}

const clampEase = (ease: number) =>
  Math.min(MAX_EASE, Math.max(MIN_EASE, Math.round(ease * 100) / 100));

const clampDays = (days: number) =>
  Math.min(MAX_INTERVAL_DAYS, Math.max(GRADUATING_INTERVAL_DAYS, Math.round(days)));

/** True while the card is on a sub-day learning/relearning step. */
export function isLearning(state: Pick<SrsState, "intervalDays">): boolean {
  return state.intervalDays < 1;
}

/**
 * Apply one grade to a card's state and return the next state (plus its due
 * date). `state` may be `null` for a card that has never been reviewed.
 *
 * Pure: same input → same output, `now` is injected (never read from the
 * clock) so behaviour is reproducible in tests and on both server and client.
 */
export function scheduleCard(
  state: SrsState | null,
  grade: ReviewGrade,
  now: Date = new Date()
): ScheduledState {
  const prev = state ?? initialState();
  const lastReviewedAt = now;

  // A card is "in learning" while it has never graduated (intervalDays 0).
  if (isLearning(prev)) {
    const relearning = prev.lapses > 0 || prev.reps > 0;
    const steps = relearning ? [RELEARN_STEP_MINUTES] : LEARNING_STEPS_MINUTES;
    const step = Math.min(Math.max(prev.learningStep, 0), steps.length - 1);
    const stepMinutes = steps[step];

    const finish = (
      minutes: number,
      patch: Partial<SrsState>
    ): ScheduledState => ({
      ...prev,
      ...patch,
      reviewCount: prev.reviewCount + 1,
      lastGrade: grade,
      dueAt: new Date(now.getTime() + minutes * MINUTE_MS),
      lastReviewedAt,
    });

    const graduate = (days: number, easeDelta: number): ScheduledState => ({
      ...prev,
      ease: clampEase(prev.ease + easeDelta),
      intervalDays: clampDays(days),
      reps: Math.max(1, prev.reps + 1),
      learningStep: 0,
      reviewCount: prev.reviewCount + 1,
      lastGrade: grade,
      dueAt: new Date(now.getTime() + days * DAY_MS),
      lastReviewedAt,
    });

    switch (grade) {
      case "again":
        // Back to the first step of learning/relearning — ease is untouched
        // here (a lapse that deserves an ease penalty can only happen to a
        // graduated card, and it is applied in the branch below).
        return finish(steps[0], { learningStep: 0, reps: 0 });
      case "hard":
        return finish(stepMinutes * LEARNING_HARD_MULTIPLIER, {
          ease: clampEase(prev.ease + EASE_DELTA.hard),
          learningStep: step,
        });
      case "good":
        // Walk the steps; past the last one the card graduates.
        if (step + 1 < steps.length) {
          return finish(steps[step + 1], { learningStep: step + 1, reps: 0 });
        }
        return graduate(GRADUATING_INTERVAL_DAYS, EASE_DELTA.good);
      case "easy":
        return graduate(EASY_GRADUATING_INTERVAL_DAYS, EASE_DELTA.easy);
    }
  }

  // ── Graduated card: interval math, in days ────────────────────────────────
  const ease = clampEase(prev.ease + EASE_DELTA[grade]);
  let intervalDays: number;

  switch (grade) {
    case "again": {
      // Lapse: forget the interval, relearn from scratch, and pay for it with
      // a lower ease factor (min 1.3).
      return {
        ...prev,
        ease,
        intervalDays: 0,
        reps: 0,
        lapses: prev.lapses + 1,
        learningStep: 0,
        reviewCount: prev.reviewCount + 1,
        lastGrade: grade,
        dueAt: new Date(now.getTime() + RELEARN_STEP_MINUTES * MINUTE_MS),
        lastReviewedAt,
      };
    }
    case "hard":
      intervalDays = clampDays(prev.intervalDays * HARD_MULTIPLIER);
      break;
    case "good":
      intervalDays = clampDays(prev.intervalDays * ease);
      break;
    case "easy":
      intervalDays = clampDays(prev.intervalDays * ease * EASY_BONUS);
      break;
  }

  return {
    ...prev,
    ease,
    intervalDays,
    reps: prev.reps + 1,
    reviewCount: prev.reviewCount + 1,
    lastGrade: grade,
    dueAt: new Date(now.getTime() + intervalDays * DAY_MS),
    lastReviewedAt,
  };
}

/** A state row as it comes back from the API/`card_reviews`. */
export interface ReviewRecord extends SrsState {
  dueAt: string | Date;
  lastReviewedAt?: string | Date | null;
}

/**
 * What each grade would do to this card, for the button previews
 * ("Good · 3 days"). Cheap: four pure calls, no I/O.
 */
export function previewIntervals(
  state: SrsState | null,
  now: Date = new Date()
): Record<ReviewGrade, { dueAt: Date; label: string; intervalDays: number }> {
  const out = {} as Record<ReviewGrade, { dueAt: Date; label: string; intervalDays: number }>;
  for (const grade of REVIEW_GRADES) {
    const next = scheduleCard(state, grade, now);
    out[grade] = {
      dueAt: next.dueAt,
      label: formatSpan(next.dueAt.getTime() - now.getTime()),
      intervalDays: next.intervalDays,
    };
  }
  return out;
}

/** Is the card due for review right now? (No state ⇒ never seen ⇒ due.) */
export function isDue(state: Pick<SrsState, "intervalDays"> & { dueAt: string | Date } | null, now: Date = new Date()): boolean {
  if (!state) return true;
  return new Date(state.dueAt).getTime() <= now.getTime();
}

/**
 * Compact duration for grade previews: "1 min", "10 min", "45 min",
 * "2 h", "3 days", "2 mo", "1 y".
 */
export function formatSpan(ms: number): string {
  const minutes = ms / MINUTE_MS;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = ms / DAY_MS;
  if (days < 30) return `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`;
  if (days < 365) return `${Math.max(1, Math.round(days / 30))} mo`;
  return `${Math.max(1, Math.round(days / 365))} y`;
}

/**
 * Human "when is this due" label for lists: "due now", "in 10 min",
 * "in 3 days", "tomorrow", or "overdue by 2 days".
 */
export function dueLabel(dueAt: string | Date | null, now: Date = new Date()): string {
  if (!dueAt) return "due now";
  const diff = new Date(dueAt).getTime() - now.getTime();
  if (diff <= 0) return "due now";
  if (diff < 90_000) return "in a minute";
  // Count in *rounded* days so a card due in 23 h 59 m (a 1-day interval seen
  // a moment after grading) still reads "tomorrow" rather than "in 24 h".
  const days = Math.round(diff / DAY_MS);
  if (days === 0) return `in ${formatSpan(diff)}`;
  if (days === 1) return "tomorrow";
  if (days < 30) return `in ${days} days`;
  return `in ${formatSpan(diff)}`;
}

/** How overdue a card is (for the "12 overdue" hints). */
export function overdueLabel(dueAt: string | Date | null, now: Date = new Date()): string | null {
  if (!dueAt) return "due now";
  const diff = now.getTime() - new Date(dueAt).getTime();
  // A card that fell due seconds ago isn't "overdue" — only say so once it
  // has genuinely been waiting.
  if (diff < MINUTE_MS) return null;
  const days = Math.floor(diff / DAY_MS);
  if (days >= 2) return `overdue by ${days} days`;
  if (days === 1) return "overdue by a day";
  return `overdue by ${formatSpan(diff)}`;
}

/**
 * Rough mastery signal for a deck: the share of the *tracked* cards whose
 * interval has reached `days`. Used by the review page's deck chips.
 */
export function matureShare(
  states: Pick<SrsState, "intervalDays">[],
  days = 21
): number {
  if (states.length === 0) return 0;
  return states.filter((s) => s.intervalDays >= days).length / states.length;
}
