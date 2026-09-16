"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  MASCOT_IMAGES,
  registerMascotListener,
  type MascotEvent,
  type MascotMood,
} from "@/lib/mascot";

/* ════════════════════════════════════════════════════════════════════════
   Nibbles 🐹 — the QuizTime hamster mascot.

   All of Nibbles' lines live in the "SCRIPT" section below — edit the
   wording there to give him your own personality. The poses are plain
   PNGs in public/hamster/ (idle / waving / pointing / celebrating /
   sleeping / sad); swap those files to redesign the character.

   What he notices:
   • login            → "Hello, <name>!" tour for new users, or "Welcome
                        back, <name>!" for returning users
   • finishing a deck → a celebration unique to that mode (bounce / spin /
                        dance / card-flip), a ⭐ burst for 90%+ scores, or a
                        gentle pep talk for rough rounds
   • not studying for a few days → he dozes off right on the screen (Zzz…)
   • losing a streak  → a tearful little speech and a pep talk
   ════════════════════════════════════════════════════════════════════════ */

// ─── SCRIPT (customize Nibbles' lines here) ───────────────────────────────

function firstName(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0];
  return first || "friend";
}

/** First sign-in ever on this device → Nibbles introduces himself + tour. */
function tutorialSteps(first: string): Step[] {
  return [
    {
      mood: "wave",
      text: `Hello, ${first}! I'm Nibbles 🐹 — your study buddy here in QuizTime! Looks like it's your first time, so let me give you the grand tour…`,
    },
    {
      mood: "point",
      text: "Step one: tap Upload! I'll turn your notes, PDFs or photos into flashcards with a little AI magic ✨",
    },
    {
      mood: "point",
      text: "Then open your study set and pick a mode — Study flips cards, Exam gives you 4 choices, and Identification & Enumeration let you type answers from memory!",
    },
    {
      mood: "point",
      text: "Last secret: the Review tab brings cards back right before you forget them. Show up daily and your streak will grow 🔥",
    },
    {
      mood: "wave",
      text: `That's everything, ${first}! Now go make your first study set — I'll be right here cheering for you! 🎉`,
    },
  ];
}

/** Returning sign-in greetings (one is picked at random each visit). */
const WELCOME_BACK: string[] = [
  "Welcome back, {first}! 🐹 I missed you — ready to learn something today?",
  "{first}! You're back! 🎉 Your study sets kept the seat warm for you.",
  "Hi again, {first}! 🐹 A few minutes of reviewing a day keeps the forgetting away!",
];

/**
 * Every study-mode finish gets its OWN celebration animation, so it never
 * feels the same twice: flips for Study, spins for Exam, a dance for
 * Identification, hops for Enumeration & Review. 90%+ gets a ⭐ burst,
 * and a rough round gets a pep talk instead of confetti.
 */
const FINISH_ANIM: Record<string, CelebrateAnim> = {
  study: "flip",
  exam: "spin",
  identify: "dance",
  enumerate: "bounce",
  review: "bounce",
};

function completionLines(ev: MascotEvent, first: string): Step {
  switch (ev.type) {
    case "study-done": {
      const anim = FINISH_ANIM.study;
      if (ev.knownPct >= 90) {
        return {
          mood: "celebrate",
          anim,
          burst: true,
          text: `AMAZING, ${first}! You knew ${ev.knownPct}% of the deck — you own Study Mode 🎉 Now move to another mode: try Exam Mode, 4 choices and instant score!`,
        };
      }
      if (ev.knownPct >= 50) {
        return {
          mood: "celebrate",
          anim,
          text: `Great job, ${first}! You finished Study Mode with ${ev.knownPct}% known 🎉 Now move to another study mode — try Exam Mode!`,
        };
      }
      return {
        mood: "point",
        text: `Phew — a full round done, ${first}! ${ev.knownPct}% known this time, and that's okay 💪 Let's review the missed cards once more, then conquer Exam Mode together!`,
      };
    }
    case "scored-done": {
      const anim = FINISH_ANIM[ev.mode] ?? "bounce";
      const modeName =
        ev.mode === "exam" ? "Exam" : ev.mode === "identify" ? "Identification" : "Enumeration";
      const nextLine =
        ev.mode === "exam"
          ? "Now move to another study mode: try Identification and type the answers from memory!"
          : ev.mode === "identify"
            ? "Now move to another study mode: try Enumeration — list every item from memory!"
            : "Now move to another study mode: give Spaced Review a go — it resurfaces cards right before you forget them!";
      if (ev.pct >= 90) {
        return {
          mood: "celebrate",
          anim,
          burst: true,
          text: `WOW, ${first}! ${ev.pct}% on ${modeName} — superstar! 🎉⭐ ${nextLine}`,
        };
      }
      if (ev.pct >= 50) {
        return {
          mood: "celebrate",
          anim,
          text: `You did it, ${first}! ${ev.pct}% on ${modeName} 🎉 ${nextLine}`,
        };
      }
      return {
        mood: "point",
        text: `Tough round, ${first} — ${ev.pct}% this time. Every miss teaches you something! 🧠 Study the missed cards below, then come back and smash it!`,
      };
    }
    case "review-done":
      if (ev.pct >= 70) {
        return {
          mood: "celebrate",
          anim: FINISH_ANIM.review,
          burst: ev.pct >= 90,
          text: `Review round complete — ${ev.pct}% recalled! 🎉 Incredible memory, ${first}! Come back tomorrow to keep your streak going!`,
        };
      }
      return {
        mood: "celebrate",
        anim: FINISH_ANIM.review,
        text: `Review round done! 🎉 The tricky ones will come back sooner — that's the secret plan working. See you tomorrow, ${first}!`,
      };
    default:
      return { mood: "idle", text: "" };
  }
}

/** Inactivity: Nibbles literally falls asleep on screen. */
function sleepyStep(first: string, days: number | null): Step {
  return {
    mood: "sleepy",
    text:
      days === null
        ? `Hiii ${first}… the flashcards are still waiting for our very first round 😴 Wake me up with one tiny study session?`
        : `Yaaawn… we haven't studied in ${days} day${days === 1 ? "" : "s"}, ${first} 😴 My brain is full of cobwebs — one quick round to wake us up?`,
  };
}

/** A lost streak: teary speech, then motivation. */
function sadStep(first: string, lostStreak: number): Step {
  return {
    mood: "sad",
    text: `Oh no, ${first}… our ${lostStreak}-day streak slipped away 😢 It's okay — even champions need rest days! One tiny round and we start a brand-new streak?`,
  };
}

/** Random tips when you poke Nibbles while he's awake. */
const TAP_TIPS: Step[] = [
  { mood: "point", text: "Psst — in Exam Mode you can press 1–4 on the keyboard to answer super fast! ⚡" },
  { mood: "point", text: "Warm up in Study Mode first, then test yourself in Exam Mode. That's how champions train! 💪" },
  { mood: "point", text: "Save your sets for offline in My Sets — then you can study on the bus with no signal! 📶" },
  { mood: "point", text: "Cards you review come back right before you'd forget them. Trust the schedule! 🧠" },
  { mood: "idle", text: "You can even build a deck by hand — Home → Create a Deck Manually ✍️" },
  { mood: "idle", text: "Squeak! 🐹 (That means: you're doing great.)" },
];

/** What he mumbles when you poke him awake while he's dozing. */
const WAKE_LINES: Step[] = [
  { mood: "wave", text: "Yaaawn… I'm up, I'm up! 😴✨ One tiny round and I'll be wide awake — ready when you are!" },
  { mood: "wave", text: "Huh?! I wasn't sleeping! 🐹 …okay, maybe a little. Let's do a quick round together?" },
];

// ─── Habit tracking helpers ───────────────────────────────────────────────

type CelebrateAnim = "bounce" | "spin" | "dance" | "flip";

/** What the server knows about the account's study rhythm (/api/stats). */
interface HabitData {
  streak: number;
  lastStudiedAt: string | null;
  totalAnswers: number;
}

type HabitMoment = { kind: "sleepy"; days: number | null } | { kind: "sad"; lostStreak: number };

/** Per-account snapshot of the streak we saw last visit (mouth of truth for "missed a streak"). */
interface HabitSnapshot {
  streak: number;
  at: string;
}

const habitKey = (id: string) => `quiztime-mascot-habit:${id}`;

async function loadHabitData(): Promise<HabitData | null> {
  try {
    const res = await fetch("/api/stats");
    if (!res.ok) return null;
    const data = await res.json();
    return {
      streak: data?.overall?.streak ?? 0,
      lastStudiedAt: data?.overall?.lastStudiedAt ?? null,
      totalAnswers: data?.overall?.totalAnswers ?? 0,
    };
  } catch {
    return null; // offline — Nibbles just skips the habit check
  }
}

/**
 * Decide if this visit deserves a habit moment. A streak only counts as
 * *missed* when the last study day was ≥2 days ago (studied yesterday → the
 * streak is still alive today, so no false tears). Sleepiness kicks in
 * after 3 inactive days, or when the account has literally never studied.
 */
function decideHabitMoment(habit: HabitData, snap: HabitSnapshot | null): HabitMoment | null {
  const daysSince = habit.lastStudiedAt
    ? (Date.now() - Date.parse(habit.lastStudiedAt)) / 86_400_000
    : null;

  if (habit.streak === 0 && snap && snap.streak >= 2 && daysSince !== null && daysSince >= 2) {
    return { kind: "sad", lostStreak: snap.streak };
  }
  if (daysSince === null) {
    return habit.totalAnswers === 0 ? { kind: "sleepy", days: null } : null;
  }
  if (daysSince >= 3) return { kind: "sleepy", days: Math.floor(daysSince) };
  return null;
}

function readHabitSnapshot(id: string): HabitSnapshot | null {
  try {
    const raw = window.localStorage.getItem(habitKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HabitSnapshot;
    return typeof parsed?.streak === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function writeHabitSnapshot(id: string, snapshot: HabitSnapshot) {
  try {
    window.localStorage.setItem(habitKey(id), JSON.stringify(snapshot));
  } catch {
    // Storage blocked — Nibbles just has a shorter memory.
  }
}

// ─── Little state machine ─────────────────────────────────────────────────

interface Step {
  text: string;
  mood: MascotMood;
  /** Celebration animation to loop while this bubble is up. */
  anim?: CelebrateAnim;
  /** ⭐ burst particles for 90%+ finishes. */
  burst?: boolean;
}

interface BubbleState {
  /** Remount key — each new message restarts the entrance animation. */
  key: number;
  kind: "single" | "tutorial";
  steps: Step[];
  index: number;
}

/** Per-account localStorage key: has this user already had the tour? */
const onboardKey = (id: string) => `quiztime-mascot-onboarded:${id}`;
/** Per-tab-session key: greet once per visit, not on every render. */
const greetKey = (id: string) => `quiztime-mascot-greeted:${id}`;

const AUTO_DISMISS_MS = 9000;
const CHAIN_DELAY_MS = 900;
const CHARS_PER_TICK = 2;
const TICK_MS = 32;

export function MascotHost({
  userName,
  userId,
  demoHabit,
}: {
  userName?: string | null;
  userId?: string | null;
  /** Playground only (/hamster-preview): force a habit moment, skip /api/stats. */
  demoHabit?: "sleepy" | "sad" | null;
}) {
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const [shown, setShown] = useState(0);
  /** Ambient pose between bubbles — turns sleepy when you've been away. */
  const [ambient, setAmbient] = useState<"idle" | "sleepy">("idle");
  /** Synchronous "is a bubble on screen" check for the async habit chain. */
  const bubbleVisible = useRef(false);
  const keySeq = useRef(0);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A queued follow-up bubble (habit moments ride behind the greeting). */
  const queuedStep = useRef<Step | null>(null);
  const reduceMotion = useRef(false);

  useEffect(() => {
    reduceMotion.current =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const clearDismissTimer = () => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  };
  const clearChainTimer = () => {
    if (chainTimer.current) {
      clearTimeout(chainTimer.current);
      chainTimer.current = null;
    }
  };

  const show = useCallback((next: Omit<BubbleState, "key">) => {
    clearDismissTimer();
    clearChainTimer();
    keySeq.current += 1;
    bubbleVisible.current = true;
    setBubble({ ...next, key: keySeq.current });
  }, []);

  const showSingle = useCallback(
    (step: Step) => show({ kind: "single", steps: [step], index: 0 }),
    [show]
  );

  /**
   * Close the bubble — and if something is queued behind it (the sleepy/sad
   * moment after the welcome-back greeting), bring it up after a beat.
   */
  const closeBubble = useCallback(() => {
    clearDismissTimer();
    bubbleVisible.current = false;
    setBubble(null);
    const queued = queuedStep.current;
    if (queued) {
      queuedStep.current = null;
      clearChainTimer();
      chainTimer.current = setTimeout(() => {
        if (queued.mood === "sleepy") setAmbient("sleepy");
        showSingle(queued);
      }, CHAIN_DELAY_MS);
    }
  }, [showSingle]);

  // ── Greeting on login (+ habit check: sleepy / missed-streak) ───────────
  useEffect(() => {
    const id = userId ?? "anon";
    const first = firstName(userName);
    let cancelled = false;

    const timer = setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        let greet;
        let onboarded;
        try {
          if (window.sessionStorage.getItem(greetKey(id))) return; // already greeted this visit
          window.sessionStorage.setItem(greetKey(id), "1");
          greet = true;
          onboarded = window.localStorage.getItem(onboardKey(id)) === "1";
        } catch {
          greet = true;
          onboarded = true; // storage blocked → short-term Nibbles: greet, no tour
        }
        if (!greet || cancelled) return;

        // New users: tutorial first, habit baseline set quietly in the background.
        if (onboarded) {
          const line = WELCOME_BACK[Math.floor(Math.random() * WELCOME_BACK.length)].replace(
            "{first}",
            first
          );
          showSingle({ mood: "wave", text: line });
        } else {
          show({ kind: "tutorial", steps: tutorialSteps(first), index: 0 });
        }

        // Habit moment: rides in after the greeting closes (see closeBubble).
        const snap = readHabitSnapshot(id);
        let moment: HabitMoment | null = null;
        if (demoHabit) {
          moment =
            demoHabit === "sleepy"
              ? { kind: "sleepy", days: 4 }
              : { kind: "sad", lostStreak: Math.max(snap?.streak ?? 5, 2) };
        } else {
          const habit = await loadHabitData();
          if (cancelled) return;
          if (habit) {
            if (onboarded) moment = decideHabitMoment(habit, snap);
            writeHabitSnapshot(id, { streak: habit.streak, at: new Date().toISOString() });
          }
        }
        if (cancelled || !moment) return;
        queuedStep.current =
          moment.kind === "sleepy" ? sleepyStep(first, moment.days) : sadStep(first, moment.lostStreak);
        // If the greeting is somehow already gone, chain immediately.
        if (!bubbleVisible.current) closeBubble();
      })();
    }, 1200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Events from the rest of the app (finishing a deck, etc.) ────────────
  useEffect(() => {
    const first = firstName(userName);
    return registerMascotListener((ev: MascotEvent) => {
      if (ev.type === "say") {
        showSingle({ text: ev.text, mood: ev.mood ?? "idle" });
        return;
      }
      // Finishing a run wakes him up, then he cheers a beat after the
      // results screen lands.
      setAmbient("idle");
      queuedStep.current = null;
      setTimeout(() => showSingle(completionLines(ev, first)), 600);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userName]);

  // ── Typewriter ──────────────────────────────────────────────────────────
  const active = bubble ? bubble.steps[bubble.index] : null;
  const fullText = active?.text ?? "";
  const typingDone = shown >= fullText.length;

  useEffect(() => {
    if (!bubble) return;
    if (reduceMotion.current) {
      setShown(fullText.length);
      return;
    }
    setShown(0);
    const interval = setInterval(() => {
      setShown((n) => {
        if (n >= fullText.length) {
          clearInterval(interval);
          return n;
        }
        return Math.min(n + CHARS_PER_TICK, fullText.length);
      });
    }, TICK_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bubble?.key, bubble?.index, fullText]);

  // ── Auto-dismiss single messages once the line is fully typed ───────────
  useEffect(() => {
    if (!bubble || bubble.kind !== "single" || !typingDone) return;
    clearDismissTimer();
    dismissTimer.current = setTimeout(() => closeBubble(), AUTO_DISMISS_MS);
    return clearDismissTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bubble?.key, typingDone]);

  /** Finish the tutorial (or bail out of it) and remember that we did. */
  const finishTutorial = useCallback(() => {
    try {
      window.localStorage.setItem(onboardKey(userId ?? "anon"), "1");
    } catch {
      // Non-fatal — Nibbles will just re-offer the tour next time.
    }
    closeBubble();
  }, [userId, closeBubble]);

  /** Poke Nibbles: dismiss the bubble, wake him up, or get a random tip. */
  const poke = () => {
    if (bubble) {
      if (bubble.kind === "tutorial") finishTutorial();
      else closeBubble();
      return;
    }
    if (ambient === "sleepy") {
      setAmbient("idle");
      showSingle(WAKE_LINES[Math.floor(Math.random() * WAKE_LINES.length)]);
      return;
    }
    showSingle(TAP_TIPS[Math.floor(Math.random() * TAP_TIPS.length)]);
  };

  const nextTutorialStep = () => {
    if (!bubble) return;
    if (bubble.index >= bubble.steps.length - 1) return finishTutorial();
    setBubble({ ...bubble, index: bubble.index + 1 });
  };

  const mood: MascotMood = bubble && active ? active.mood : ambient;
  const celebrating = Boolean(bubble && active?.mood === "celebrate");
  const anim: CelebrateAnim = active?.anim ?? "bounce";
  const dozing = !bubble && ambient === "sleepy";
  const isLastTutorialStep = bubble?.kind === "tutorial" && bubble.index >= bubble.steps.length - 1;

  return (
    <div className="mascot-wrap">
      {/* Preload every pose so a mood swap never flickers. */}
      <div style={{ display: "none" }} aria-hidden>
        {Object.values(MASCOT_IMAGES).map((src) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={src} src={src} alt="" />
        ))}
      </div>

      {/* ⭐ burst for 90%+ finishes */}
      {bubble && active?.burst && (
        <div className="mascot-burst" aria-hidden>
          {["⭐", "✨", "🎉", "⭐", "✨", "🎊", "⭐"].map((piece, i) => (
            <span
              key={i}
              style={{
                left: `${-20 + ((i * 37) % 150)}px`,
                animationDelay: `${(i * 0.23) % 1.4}s`,
                fontSize: `${12 + ((i * 5) % 10)}px`,
              }}
            >
              {piece}
            </span>
          ))}
        </div>
      )}

      {bubble && active && (
        <div
          key={bubble.key}
          className="mascot-bubble"
          role="status"
          aria-live="polite"
          onClick={() => {
            // Tap to finish typing instantly.
            if (!typingDone) setShown(fullText.length);
          }}
        >
          <button
            className="mascot-close"
            onClick={(e) => {
              e.stopPropagation();
              if (bubble.kind === "tutorial") finishTutorial();
              else closeBubble();
            }}
            aria-label="Dismiss Nibbles"
          >
            <X size={12} />
          </button>

          <p className="mascot-text">
            {fullText.slice(0, shown)}
            {!typingDone && <span className="mascot-caret" aria-hidden />}
          </p>

          {bubble.kind === "tutorial" && typingDone && (
            <div className="mascot-actions">
              {!isLastTutorialStep && (
                <button className="btn btn-ghost btn-sm mascot-skip" onClick={finishTutorial}>
                  Skip tour
                </button>
              )}
              <button className="btn btn-primary btn-sm" onClick={nextTutorialStep}>
                {isLastTutorialStep ? "Let's go! 🎉" : "Next →"}
              </button>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        className={[
          "mascot-avatar",
          celebrating ? `mascot-anim-${anim}` : "",
          dozing ? "mascot-sleepy" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={poke}
        aria-label="Nibbles the hamster, your study buddy"
        title="Nibbles"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={MASCOT_IMAGES[mood]} alt="" draggable={false} />
        {dozing && (
          <span className="mascot-zzz" aria-hidden>
            <span>z</span>
            <span>z</span>
            <span>Z</span>
          </span>
        )}
      </button>
    </div>
  );
}
