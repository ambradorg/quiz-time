/**
 * Nibbles 🐹 — the QuizTime mascot event bus.
 *
 * Same sink pattern as showToast(): any component can fire a mascot event
 * from an event handler or async callback without prop-drilling; the
 * <MascotHost/> component (mounted once in the app shell) subscribes while
 * it is mounted and turns the event into a speech-bubble moment.
 */

export type MascotMood =
  | "idle"
  | "wave"
  | "point"
  | "celebrate"
  | "sleepy"
  | "sad"
  /** Munching a sunflower seed — the 90%+ score celebration. */
  | "nibble"
  /** Paw on chin while the AI generates flashcards. */
  | "thinking"
  /** Leaning in from the screen edge while you answer. */
  | "peek"
  /** Star-eyed amazement for hot streaks. */
  | "wow"
  /** Offering a little heart — encouragement after misses. */
  | "heart";

/** Pose artwork, one per mood (see public/hamster/). */
export const MASCOT_IMAGES: Record<MascotMood, string> = {
  idle: "/hamster/hamster-base.png",
  wave: "/hamster/hamster-wave.png",
  point: "/hamster/hamster-point.png",
  celebrate: "/hamster/hamster-celebrate.png",
  sleepy: "/hamster/hamster-sleepy.png",
  sad: "/hamster/hamster-sad.png",
  nibble: "/hamster/hamster-nibble.png",
  thinking: "/hamster/hamster-thinking.png",
  peek: "/hamster/hamster-peek.png",
  wow: "/hamster/hamster-wow.png",
  heart: "/hamster/hamster-heart.png",
};

/**
 * Structured events so the host can write the actual line (it knows the
 * user's first name) and all mascot copy lives in one place.
 */
export type MascotEvent =
  /** Study Mode run finished — knownPct = share of cards marked known. */
  | { type: "study-done"; knownPct: number }
  /** A scored run finished (exam / identification / enumeration). */
  | { type: "scored-done"; mode: "exam" | "identify" | "enumerate"; pct: number }
  /** A spaced-repetition round finished — pct = first-try recall. */
  | { type: "review-done"; pct: number }
  /** Mid-run hot streak — n correct answers in a row in a scored run. */
  | { type: "streak"; n: number }
  /** Three misses in a row mid-run — Nibbles turns coach, not judge. */
  | { type: "struggling" }
  /** The very first run on a brand-new deck. */
  | { type: "first-run" }
  /** The AI is generating flashcards — Nibbles thinks along until it lands. */
  | { type: "generating" }
  /** A scored/study run is active — Nibbles peeks in from the screen edge. */
  | { type: "peek"; active: boolean }
  /** Free-form line, for one-off moments. */
  | { type: "say"; text: string; mood?: MascotMood };

type MascotListener = (event: MascotEvent) => void;

/** Sink installed by <MascotHost/> while it is mounted (null otherwise). */
let listener: MascotListener | null = null;

/** Called by <MascotHost/> when it mounts/unmounts. */
export function registerMascotListener(next: MascotListener | null): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

/** Fire a mascot moment from anywhere in the app. */
export function mascotEvent(event: MascotEvent) {
  listener?.(event);
}

/** Convenience: make Nibbles say something free-form. */
export function mascotSay(text: string, mood: MascotMood = "idle") {
  mascotEvent({ type: "say", text, mood });
}
