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
   PNGs in public/hamster/ (idle / waving / pointing / celebrating); swap
   those files to redesign the character.
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

/** What Nibbles suggests next after you finish answering a deck. */
function completionLines(ev: MascotEvent, first: string): Step {
  switch (ev.type) {
    case "study-done":
      return {
        mood: "celebrate",
        text:
          ev.knownPct >= 80
            ? `Great job, ${first}! You finished Study Mode and knew ${ev.knownPct}% of the cards 🎉 Now move to another study mode — try Exam Mode: 4 choices, instant score!`
            : `Nice work, ${first}! You went through the whole deck 🎉 Now move to another study mode — try Exam Mode, or review the missed cards once more!`,
      };
    case "scored-done": {
      const pctPart = ev.pct >= 50 ? `${ev.pct}% — amazing!` : `${ev.pct}% — practice makes perfect!`;
      const nextLine =
        ev.mode === "exam"
          ? "Now move to another study mode: try Identification and type the answers from memory!"
          : ev.mode === "identify"
            ? "Now move to another study mode: try Enumeration — list every item from memory!"
            : "Now move to another study mode: give Spaced Review a go — it resurfaces cards right before you forget them!";
      return {
        mood: "celebrate",
        text: `You did it, ${first}! ${pctPart} 🎉 ${nextLine}`,
      };
    }
    case "review-done":
      return {
        mood: "celebrate",
        text:
          ev.pct >= 70
            ? `Review round complete — ${ev.pct}% recalled! 🎉 Incredible memory, ${first}! Come back tomorrow to keep your streak going!`
            : `Review round done! 🎉 The tricky ones will come back sooner — that's the secret plan working. See you tomorrow, ${first}!`,
      };
    default:
      return { mood: "idle", text: "" };
  }
}

/** Random tips when you poke Nibbles. */
const TAP_TIPS: Step[] = [
  { mood: "point", text: "Psst — in Exam Mode you can press 1–4 on the keyboard to answer super fast! ⚡" },
  { mood: "point", text: "Warm up in Study Mode first, then test yourself in Exam Mode. That's how champions train! 💪" },
  { mood: "point", text: "Save your sets for offline in My Sets — then you can study on the bus with no signal! 📶" },
  { mood: "point", text: "Cards you review come back right before you'd forget them. Trust the schedule! 🧠" },
  { mood: "idle", text: "You can even build a deck by hand — Home → Create a Deck Manually ✍️" },
  { mood: "idle", text: "Squeak! 🐹 (That means: you're doing great.)" },
];

// ─── Little state machine ─────────────────────────────────────────────────

interface Step {
  text: string;
  mood: MascotMood;
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
const CHARS_PER_TICK = 2;
const TICK_MS = 32;

export function MascotHost({
  userName,
  userId,
}: {
  userName?: string | null;
  userId?: string | null;
}) {
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const [shown, setShown] = useState(0);
  const keySeq = useRef(0);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const show = useCallback((next: Omit<BubbleState, "key">) => {
    clearDismissTimer();
    keySeq.current += 1;
    setBubble({ ...next, key: keySeq.current });
  }, []);

  const showSingle = useCallback(
    (step: Step) => show({ kind: "single", steps: [step], index: 0 }),
    [show]
  );

  const close = useCallback(() => {
    clearDismissTimer();
    setBubble(null);
  }, []);

  // ── Greeting on login (and the first-time tutorial) ─────────────────────
  useEffect(() => {
    const id = userId ?? "anon";
    const first = firstName(userName);
    let cancelled = false;

    const timer = setTimeout(() => {
      if (cancelled) return;
      try {
        if (window.sessionStorage.getItem(greetKey(id))) return; // already greeted this visit
        window.sessionStorage.setItem(greetKey(id), "1");
        const onboarded = window.localStorage.getItem(onboardKey(id)) === "1";
        if (onboarded) {
          const line = WELCOME_BACK[Math.floor(Math.random() * WELCOME_BACK.length)]
            .replace("{first}", first);
          showSingle({ mood: "wave", text: line });
        } else {
          show({ kind: "tutorial", steps: tutorialSteps(first), index: 0 });
        }
      } catch {
        // Storage blocked — still greet, just without memory.
        showSingle({ mood: "wave", text: WELCOME_BACK[0].replace("{first}", first) });
      }
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
      // Tiny delay so the results screen lands a beat before Nibbles cheers.
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
    dismissTimer.current = setTimeout(() => setBubble(null), AUTO_DISMISS_MS);
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
    close();
  }, [userId, close]);

  /** Poke Nibbles: close the bubble, or get a random tip. */
  const poke = () => {
    if (bubble) {
      if (bubble.kind === "tutorial") finishTutorial();
      else close();
      return;
    }
    showSingle(TAP_TIPS[Math.floor(Math.random() * TAP_TIPS.length)]);
  };

  const nextTutorialStep = () => {
    if (!bubble) return;
    if (bubble.index >= bubble.steps.length - 1) return finishTutorial();
    setBubble({ ...bubble, index: bubble.index + 1 });
  };

  const mood: MascotMood = active?.mood ?? "idle";
  const isLastTutorialStep = bubble?.kind === "tutorial" && bubble.index >= bubble.steps.length - 1;

  return (
    <div className="mascot-wrap">
      {/* Preload every pose so the first celebration has no image flicker. */}
      <div style={{ display: "none" }} aria-hidden>
        {Object.values(MASCOT_IMAGES).map((src) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={src} src={src} alt="" />
        ))}
      </div>

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
              else close();
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
                <button
                  className="btn btn-ghost btn-sm mascot-skip"
                  onClick={finishTutorial}
                >
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
        className={`mascot-avatar${mood === "celebrate" && bubble ? " mascot-excited" : ""}`}
        onClick={poke}
        aria-label="Nibbles the hamster, your study buddy"
        title="Nibbles"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={MASCOT_IMAGES[mood]} alt="" draggable={false} />
      </button>
    </div>
  );
}
