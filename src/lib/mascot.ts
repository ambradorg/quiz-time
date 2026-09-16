/**
 * Nibbles 🐹 — the QuizTime mascot event bus.
 *
 * Same sink pattern as showToast(): any component can fire a mascot event
 * from an event handler or async callback without prop-drilling; the
 * <MascotHost/> component (mounted once in the app shell) subscribes while
 * it is mounted and turns the event into a speech-bubble moment.
 */

export type MascotMood = "idle" | "wave" | "point" | "celebrate" | "sleepy" | "sad";

/** Pose artwork, one per mood (see public/hamster/). */
export const MASCOT_IMAGES: Record<MascotMood, string> = {
  idle: "/hamster/hamster-base.png",
  wave: "/hamster/hamster-wave.png",
  point: "/hamster/hamster-point.png",
  celebrate: "/hamster/hamster-celebrate.png",
  sleepy: "/hamster/hamster-sleepy.png",
  sad: "/hamster/hamster-sad.png",
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
