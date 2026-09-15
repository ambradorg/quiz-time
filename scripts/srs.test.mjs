#!/usr/bin/env node
/**
 * Tests for the spaced-repetition scheduler (src/lib/srs.ts) — the SM-2
 * descendant behind the Review tab, `/api/review` and the `card_reviews`
 * table.
 *
 * No database and no network: the scheduler is pure (`now` is injected), so
 * every scenario below is deterministic. The cases encode the *product*
 * promises of the algorithm:
 *
 *   - a new card walks 1 min → 10 min, then graduates to 1 day
 *   - "Again" sends a graduated card back to a 10-minute relearning step and
 *     lowers its ease factor (but never below 1.3)
 *   - intervals grow by the ease factor on Good, less on Hard, more on Easy
 *   - nothing is ever scheduled beyond a year
 *   - grades are clamped/validated at the API boundary
 *
 * Usage:
 *   npm run test:srs
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";

const {
  DEFAULT_EASE,
  EASY_GRADUATING_INTERVAL_DAYS,
  GRADE_LABELS,
  LEARNING_STEPS_MINUTES,
  MAX_EASE,
  MAX_INTERVAL_DAYS,
  MIN_EASE,
  NEW_CARDS_PER_DAY,
  RELEARN_STEP_MINUTES,
  REVIEW_GRADES,
  dueLabel,
  formatSpan,
  initialState,
  isDue,
  isLearning,
  overdueLabel,
  previewIntervals,
  scheduleCard,
} = await import("../src/lib/srs.ts");

const NOW = new Date("2026-09-15T08:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** Minutes between two dates. */
const minutesBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / 60000);

/** Grade a card through a sequence of grades, returning the final state. */
const walk = (grades, start = null) =>
  grades.reduce((state, grade) => scheduleCard(state, grade, NOW), start);

describe("srs: learning steps", () => {
  test("a brand-new card is due immediately and starts at the first step", () => {
    const fresh = initialState();
    assert.equal(fresh.ease, DEFAULT_EASE);
    assert.equal(fresh.intervalDays, 0);
    assert.equal(fresh.reviewCount, 0);
    assert.equal(isLearning(fresh), true);
    assert.equal(isDue(null, NOW), true, "a card with no schedule is due");
  });

  test("Good walks the steps (10 min) and then graduates to 1 day", () => {
    // Good advances to the *next* learning step (Anki semantics): a brand-new
    // card first lands on the 10-minute step, then graduates.
    const first = scheduleCard(null, "good", NOW);
    assert.equal(minutesBetween(NOW, first.dueAt), LEARNING_STEPS_MINUTES[1]);
    assert.equal(first.learningStep, 1);
    assert.equal(first.intervalDays, 0);
    assert.equal(first.reps, 0, "still learning — not a repetition yet");

    const graduated = scheduleCard(first, "good", NOW);
    assert.equal(graduated.intervalDays, 1, "graduates to a 1-day interval");
    assert.equal(graduated.dueAt.getTime() - NOW.getTime(), DAY);
    assert.equal(graduated.reps, 1);
    assert.equal(graduated.learningStep, 0);
    assert.equal(graduated.reviewCount, 2);
  });

  test("Easy graduates a new card immediately to 4 days and raises its ease", () => {
    const easy = scheduleCard(null, "easy", NOW);
    assert.equal(easy.intervalDays, EASY_GRADUATING_INTERVAL_DAYS);
    assert.equal(easy.dueAt.getTime() - NOW.getTime(), EASY_GRADUATING_INTERVAL_DAYS * DAY);
    assert.ok(easy.ease > DEFAULT_EASE, "easy nudges the ease factor up");
    assert.equal(easy.reps, 1);
  });

  test("Again resets a learning card to the first step (and does not punish ease)", () => {
    const learning = scheduleCard(null, "good", NOW); // on the 10-minute step
    const reset = scheduleCard(learning, "again", NOW);
    assert.equal(reset.learningStep, 0);
    assert.equal(minutesBetween(NOW, reset.dueAt), LEARNING_STEPS_MINUTES[0]);
    assert.equal(reset.ease, learning.ease, "learning failures don't lower ease");
    assert.equal(reset.lapses, 0, "a lapse only counts after graduating");
    assert.equal(reset.reps, 0);
    assert.equal(reset.lastGrade, "again");
  });

  test("Hard keeps a learning card on its step, 50% later, with a small ease penalty", () => {
    const hard = scheduleCard(null, "hard", NOW);
    assert.equal(hard.learningStep, 0);
    assert.equal(minutesBetween(NOW, hard.dueAt), Math.round(LEARNING_STEPS_MINUTES[0] * 1.5));
    assert.ok(hard.ease < DEFAULT_EASE);
  });
});

/** A card that just graduated: two Goods from new → due in 1 day. */
const justGraduated = () => walk(["good", "good"]);

describe("srs: graduated (review) cards", () => {
  const graduated = justGraduated();

  test("Good multiplies the interval by the ease factor", () => {
    assert.equal(graduated.intervalDays, 1, "fixture graduated to a day");
    const next = scheduleCard(graduated, "good", NOW);
    assert.equal(next.intervalDays, Math.round(graduated.intervalDays * graduated.ease));
    assert.equal(next.reviewCount, graduated.reviewCount + 1);
    assert.equal(next.ease, graduated.ease, "Good leaves ease untouched");
  });

  test("intervals compound over a good streak", () => {
    let state = graduated;
    const intervals = [];
    for (let i = 0; i < 5; i++) {
      state = scheduleCard(state, "good", NOW);
      intervals.push(state.intervalDays);
    }
    // 1 → 3 → 8 → 20 → 50 days at the default ease of 2.5: always growing.
    for (let i = 1; i < intervals.length; i++) {
      assert.ok(intervals[i] > intervals[i - 1], `interval grew: ${intervals.join(", ")}`);
    }
    assert.ok(state.intervalDays >= 50);
  });

  test("Hard grows the interval slowly, lowers ease, and never goes below a day", () => {
    const hard = scheduleCard(graduated, "hard", NOW);
    assert.equal(hard.intervalDays, Math.round(graduated.intervalDays * 1.2));
    assert.ok(hard.ease < graduated.ease);
    assert.ok(hard.intervalDays >= 1);

    // Even on a 1-day interval, Hard stays at 1 day instead of rounding to 0.
    const tiny = scheduleCard({ ...graduated, intervalDays: 1 }, "hard", NOW);
    assert.equal(tiny.intervalDays, 1);
  });

  test("Easy multiplies by ease × 1.3 and raises ease (capped at 2.8)", () => {
    const easy = scheduleCard(graduated, "easy", NOW);
    assert.equal(easy.intervalDays, Math.round(graduated.intervalDays * (graduated.ease + 0.15) * 1.3));
    assert.ok(easy.ease > graduated.ease);

    const maxed = scheduleCard({ ...graduated, ease: MAX_EASE }, "easy", NOW);
    assert.equal(maxed.ease, MAX_EASE, "ease is clamped to MAX_EASE");
  });

  test("Again is a lapse: relearn in 10 minutes, ease drops, interval resets", () => {
    const lapsed = scheduleCard(graduated, "again", NOW);
    assert.equal(lapsed.intervalDays, 0, "back to learning");
    assert.equal(lapsed.lapses, graduated.lapses + 1);
    assert.equal(lapsed.reps, 0);
    assert.equal(minutesBetween(NOW, lapsed.dueAt), RELEARN_STEP_MINUTES);
    assert.equal(lapsed.ease, Math.round((graduated.ease - 0.2) * 100) / 100);
    assert.equal(lapsed.lastReviewedAt.getTime(), NOW.getTime());
  });

  test("relearning walks a single 10-minute step, then graduates to 1 day again", () => {
    const lapsed = scheduleCard(graduated, "again", NOW);
    assert.equal(isLearning(lapsed), true);

    const graduation = scheduleCard(lapsed, "good", NOW);
    assert.equal(graduation.intervalDays, 1);
    assert.equal(graduation.reps, 1);
    assert.equal(graduation.lapses, lapsed.lapses, "lapses is a lifetime counter");
  });

  test("ease never falls below MIN_EASE however often a card is forgotten", () => {
    let state = graduated;
    for (let i = 0; i < 20; i++) {
      state = scheduleCard(state, "again", NOW);
      assert.ok(state.ease >= MIN_EASE, `ease stayed above the floor (${state.ease})`);
      state = scheduleCard(state, "good", NOW); // graduate again → 1 day
    }
    assert.equal(state.ease, MIN_EASE);
    assert.ok(state.lapses >= 20);
  });

  test("intervals are clamped to MAX_INTERVAL_DAYS (a year)", () => {
    const ancient = { ...graduated, intervalDays: MAX_INTERVAL_DAYS, ease: MAX_EASE };
    const next = scheduleCard(ancient, "easy", NOW);
    assert.equal(next.intervalDays, MAX_INTERVAL_DAYS);
    assert.equal(next.dueAt.getTime() - NOW.getTime(), MAX_INTERVAL_DAYS * DAY);
  });
});

describe("srs: due dates, previews and labels", () => {
  test("isDue compares the schedule against the injected clock", () => {
    const next = scheduleCard(null, "good", NOW); // now due in 10 minutes
    assert.equal(isDue(next, NOW), false);
    assert.equal(isDue(next, new Date(NOW.getTime() + 9 * 60_000)), false);
    assert.equal(isDue(next, new Date(NOW.getTime() + 11 * 60_000)), true);
  });

  test("previewIntervals labels every grade button", () => {
    const preview = previewIntervals(null, NOW);
    assert.deepEqual(Object.keys(preview), REVIEW_GRADES);
    assert.equal(preview.again.label, "1 min");
    assert.equal(preview.hard.label, "2 min"); // 1 min × 1.5, rounded
    assert.equal(preview.good.label, "10 min");
    assert.equal(preview.easy.label, "4 days");
    assert.equal(preview.easy.intervalDays, 4);

    // On a graduated card the previews match what POST /api/review will store.
    const graduated = justGraduated();
    const reviewPreview = previewIntervals(graduated, NOW);
    for (const grade of REVIEW_GRADES) {
      const stored = scheduleCard(graduated, grade, NOW);
      assert.equal(reviewPreview[grade].dueAt.getTime(), stored.dueAt.getTime());
      assert.equal(reviewPreview[grade].intervalDays, stored.intervalDays);
    }
  });

  test("formatSpan covers minutes, hours, days, months and years", () => {
    assert.equal(formatSpan(60_000), "1 min");
    assert.equal(formatSpan(45 * 60_000), "45 min");
    assert.equal(formatSpan(2 * 60 * 60_000), "2 h");
    assert.equal(formatSpan(DAY), "1 day");
    assert.equal(formatSpan(3 * DAY), "3 days");
    assert.equal(formatSpan(60 * DAY), "2 mo");
    assert.equal(formatSpan(400 * DAY), "1 y");
  });

  test("dueLabel reads naturally for waiting, imminent and overdue cards", () => {
    assert.equal(dueLabel(null, NOW), "due now");
    assert.equal(dueLabel(new Date(NOW.getTime() - 60_000), NOW), "due now");
    assert.equal(dueLabel(new Date(NOW.getTime() + 30_000), NOW), "in a minute");
    assert.equal(dueLabel(new Date(NOW.getTime() + 10 * 60_000), NOW), "in 10 min");
    assert.equal(dueLabel(new Date(NOW.getTime() + DAY), NOW), "tomorrow");
    assert.equal(dueLabel(new Date(NOW.getTime() + 3 * DAY), NOW), "in 3 days");
    assert.equal(dueLabel(new Date(NOW.getTime() + 90 * DAY), NOW), "in 3 mo");
  });

  test("overdueLabel only complains once a card is genuinely late", () => {
    assert.equal(overdueLabel(new Date(NOW.getTime() - 30_000), NOW), null);
    assert.equal(overdueLabel(new Date(NOW.getTime() - 3 * 60_000), NOW), "overdue by 3 min");
    assert.equal(overdueLabel(new Date(NOW.getTime() - 2 * DAY), NOW), "overdue by 2 days");
  });

  test("the queue constants stay sane (guards against accidental edits)", () => {
    assert.deepEqual(LEARNING_STEPS_MINUTES, [1, 10]);
    assert.equal(RELEARN_STEP_MINUTES, 10);
    assert.equal(MAX_INTERVAL_DAYS, 365);
    assert.equal(MIN_EASE, 1.3);
    assert.ok(MAX_EASE > DEFAULT_EASE);
    assert.ok(NEW_CARDS_PER_DAY > 0);
    assert.deepEqual(
      REVIEW_GRADES.map((g) => GRADE_LABELS[g]),
      ["Again", "Hard", "Good", "Easy"]
    );
  });

  test("scheduling is pure: the input state is never mutated", () => {
    const state = justGraduated();
    const snapshot = JSON.stringify(state);
    scheduleCard(state, "again", NOW);
    scheduleCard(state, "easy", NOW);
    previewIntervals(state, NOW);
    assert.equal(JSON.stringify(state), snapshot);
  });

  test("a state survives the database round-trip (numbers stay numbers)", () => {
    // card_reviews stores ease as `real`, which pg returns as a number; the
    // scheduler must not care whether it is a string or a number either.
    const state = walk(["good", "good", "easy"]); // graduated, then easy
    const reparsed = JSON.parse(JSON.stringify(state));
    const next = scheduleCard(reparsed, "good", NOW);
    assert.equal(next.intervalDays, scheduleCard(state, "good", NOW).intervalDays);
    assert.equal(typeof next.ease, "number");
  });
});
