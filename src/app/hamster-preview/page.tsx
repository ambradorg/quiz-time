"use client";

/**
 * Mascot playground (/hamster-preview) — demo every Nibbles moment without
 * needing to sign in. Not linked anywhere in the app; safe to delete before
 * production, or keep it as a playground.
 */
import { useState } from "react";
import { MascotHost } from "@/components/hamster-mascot";
import { mascotEvent, mascotSay } from "@/lib/mascot";

const PREVIEW_ID = "preview";
type DemoHabit = "sleepy" | "sad" | null;

export default function HamsterPreview() {
  const [mountKey, setMountKey] = useState(0);
  const [name, setName] = useState("Alex");
  const [demoHabit, setDemoHabit] = useState<DemoHabit>(null);
  const [peek, setPeek] = useState(false);

  /** Reset the mascot's memory and remount him so the greeting re-runs. */
  const replayGreeting = (asNewUser: boolean, habit: DemoHabit = null) => {
    try {
      if (asNewUser) window.localStorage.removeItem(`quiztime-mascot-onboarded:${PREVIEW_ID}`);
      else window.localStorage.setItem(`quiztime-mascot-onboarded:${PREVIEW_ID}`, "1");
      window.sessionStorage.removeItem(`quiztime-mascot-greeted:${PREVIEW_ID}`);
    } catch {
      // Storage blocked — the greeting still plays, just without memory.
    }
    setDemoHabit(habit);
    setMountKey((k) => k + 1);
  };

  const demos: { label: string; run: () => void; hint?: string }[] = [
    { label: "👋 New-user greeting + tour", run: () => replayGreeting(true), hint: "Hello, <name>! + tutorial" },
    { label: "🔁 Welcome back", run: () => replayGreeting(false), hint: "Welcome back, <name>!" },
    {
      label: "😴 Inactive for days (sleepy)",
      run: () => replayGreeting(false, "sleepy"),
      hint: "greeting, then he falls asleep with floating Zzz's — poke him to wake him",
    },
    {
      label: "😢 Lost streak (sad)",
      run: () => replayGreeting(false, "sad"),
      hint: "greeting, then a tearful streak speech",
    },
    { label: "📖 Study finished · 92%", run: () => mascotEvent({ type: "study-done", knownPct: 92 }), hint: "card-FLIP + seed nibble + ⭐ burst" },
    { label: "📖 Study finished · 40%", run: () => mascotEvent({ type: "study-done", knownPct: 40 }), hint: "gentle pep talk" },
    { label: "📝 Exam · 96%", run: () => mascotEvent({ type: "scored-done", mode: "exam", pct: 96 }), hint: "SPIN + seed nibble + ⭐ burst" },
    { label: "📝 Exam · 70%", run: () => mascotEvent({ type: "scored-done", mode: "exam", pct: 70 }), hint: "spin" },
    { label: "⌨️ Identification · 65%", run: () => mascotEvent({ type: "scored-done", mode: "identify", pct: 65 }), hint: "happy DANCE" },
    { label: "🔢 Enumeration · 100%", run: () => mascotEvent({ type: "scored-done", mode: "enumerate", pct: 100 }), hint: "hops + seed nibble + ⭐ burst" },
    { label: "📉 Rough round · 35%", run: () => mascotEvent({ type: "scored-done", mode: "exam", pct: 35 }), hint: "encouragement, no confetti" },
    { label: "🧠 Review round · 80%", run: () => mascotEvent({ type: "review-done", pct: 80 }), hint: "hops" },
    { label: "🌱 First run on a fresh deck", run: () => mascotEvent({ type: "first-run" }), hint: "wave / hop cheer for a brand-new deck" },
    { label: "🔥 5-in-a-row streak", run: () => mascotEvent({ type: "streak", n: 5 }), hint: "mid-run hop cheer (3 / 5 / 10+ in the real app)" },
    { label: "🤗 3 misses in a row", run: () => mascotEvent({ type: "struggling" }), hint: "gentle coach, no confetti" },
    {
      label: "🤔 AI generating flashcards",
      run: () => mascotEvent({ type: "generating" }),
      hint: "thinking pose + floating 💭 — fire any other moment to end it",
    },
    {
      label: peek ? "🙈 Stop peeking" : "👀 Peek while answering",
      run: () => {
        const next = !peek;
        setPeek(next);
        mascotEvent({ type: "peek", active: next });
      },
      hint: "he tucks half behind the screen edge like he's watching you answer — then try a streak button",
    },
    { label: "💬 Custom line", run: () => mascotSay("You can make Nibbles say anything, from anywhere in the app!", "point") },
  ];

  return (
    <div className="preview-shell">
      <h1 className="preview-title">Nibbles 🐹 playground</h1>
      <p className="preview-lede">
        This page previews every mascot moment without signing in. Tap a button and watch the
        bottom-right corner — every study-mode finish has its own victory animation, and 90%+
        makes him nibble a sunflower seed under a ⭐ burst. He also cheers mid-run streaks,
        coaches rough stretches, and thinks along while the AI generates cards. Poke him while
        he dozes to wake him up.
      </p>

      <label className="preview-label" htmlFor="preview-name">
        Name used in greetings
      </label>
      <input
        id="preview-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your first name"
        className="preview-name-input"
      />

      <div className="preview-demos">
        {demos.map((demo) => (
          <button key={demo.label} className="btn btn-secondary demo-btn" onClick={demo.run}>
            <span className="demo-btn-copy">
              <span className="demo-btn-title">{demo.label}</span>
              {demo.hint && <span className="demo-btn-hint">{demo.hint}</span>}
            </span>
          </button>
        ))}
      </div>

      <MascotHost key={`${mountKey}-${demoHabit ?? "none"}`} userName={name} userId={PREVIEW_ID} demoHabit={demoHabit} />
    </div>
  );
}
