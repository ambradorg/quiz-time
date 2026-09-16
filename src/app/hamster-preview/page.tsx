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

export default function HamsterPreview() {
  const [mountKey, setMountKey] = useState(0);
  const [name, setName] = useState("Alex");

  /** Reset the mascot's memory and remount him so the greeting re-runs. */
  const replayGreeting = (asNewUser: boolean) => {
    try {
      if (asNewUser) window.localStorage.removeItem(`quiztime-mascot-onboarded:${PREVIEW_ID}`);
      else window.localStorage.setItem(`quiztime-mascot-onboarded:${PREVIEW_ID}`, "1");
      window.sessionStorage.removeItem(`quiztime-mascot-greeted:${PREVIEW_ID}`);
    } catch {
      // Storage blocked — the greeting still plays, just without memory.
    }
    setMountKey((k) => k + 1);
  };

  const demos: { label: string; run: () => void }[] = [
    { label: "👋 New-user greeting + tour", run: () => replayGreeting(true) },
    { label: "🔁 Welcome back", run: () => replayGreeting(false) },
    { label: "📖 Study Mode finished", run: () => mascotEvent({ type: "study-done", knownPct: 92 }) },
    { label: "📝 Exam finished", run: () => mascotEvent({ type: "scored-done", mode: "exam", pct: 85 }) },
    { label: "⌨️ Identification finished", run: () => mascotEvent({ type: "scored-done", mode: "identify", pct: 70 }) },
    { label: "🔢 Enumeration finished", run: () => mascotEvent({ type: "scored-done", mode: "enumerate", pct: 100 }) },
    { label: "🧠 Review round finished", run: () => mascotEvent({ type: "review-done", pct: 80 }) },
    { label: "💬 Custom line", run: () => mascotSay("You can make Nibbles say anything, from anywhere in the app!", "point") },
  ];

  return (
    <div style={{ padding: "28px 16px", maxWidth: 520, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 4px" }}>Nibbles 🐹 playground</h1>
      <p style={{ fontSize: 13.5, color: "var(--text-muted)", margin: "0 0 16px", lineHeight: 1.55 }}>
        This page previews every mascot moment without signing in. Tap a button and watch the
        bottom-right corner — or poke Nibbles himself for a random tip.
      </p>

      <label style={{ display: "block", fontSize: 12, fontWeight: 800, color: "var(--text-muted)", marginBottom: 6 }}>
        Name used in greetings
      </label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your first name"
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 14,
          border: "2px solid #ffffff",
          background: "#e9efff",
          fontSize: 14,
          fontWeight: 600,
          fontFamily: "inherit",
          color: "var(--text)",
          outline: "none",
          marginBottom: 16,
        }}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {demos.map((demo) => (
          <button key={demo.label} className="btn btn-secondary" style={{ justifyContent: "flex-start" }} onClick={demo.run}>
            {demo.label}
          </button>
        ))}
      </div>

      <MascotHost key={mountKey} userName={name} userId={PREVIEW_ID} />
    </div>
  );
}
