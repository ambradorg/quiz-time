import type { Metadata } from "next";
import {
  ArrowRight,
  BookOpen,
  Check,
  CircleCheckBig,
  CircleX,
  ClipboardCheck,
  Flame,
  Lightbulb,
  ListOrdered,
  Sparkles,
  Star,
  Target,
  Trash,
  Type,
  X,
} from "lucide-react";
import { PresenceBar, PresenceList } from "@/components/owner-presence";
import { ONLINE_WINDOW_SECONDS } from "@/lib/presence";
import type { PresenceRoster } from "@/lib/use-presence";

export const metadata: Metadata = {
  title: "Clay Preview – QuizTime",
  description: "Soft-clay design system showcase (no sign-in needed).",
  robots: "noindex",
};

/**
 * Sample roster for the "who's online" section below. Plain serialisable data
 * (no functions), so this server component can hand it to the client
 * components without any auth or network round trip.
 */
const DEMO_ROSTER: PresenceRoster = {
  online: 3,
  total: 5,
  windowSeconds: ONLINE_WINDOW_SECONDS,
  users: [
    {
      id: "demo-owner",
      name: "You (the owner)",
      email: "owner@example.com",
      image: null,
      isOwner: true,
      online: true,
      lastSeenSecondsAgo: 4,
      activity: "Checking stats",
      device: "Chrome · macOS",
    },
    {
      id: "demo-ana",
      name: "Ana Reyes",
      email: "ana@example.com",
      image: null,
      isOwner: false,
      online: true,
      lastSeenSecondsAgo: 12,
      activity: "Studying “Cell Biology”",
      device: "Safari · iPhone",
    },
    {
      id: "demo-mark",
      name: "Mark Lim",
      email: "mark@example.com",
      image: null,
      isOwner: false,
      online: true,
      lastSeenSecondsAgo: 28,
      activity: "Reviewing due cards",
      device: "Chrome · Android",
    },
    {
      id: "demo-june",
      name: "June Park",
      email: "june@example.com",
      image: null,
      isOwner: false,
      online: false,
      lastSeenSecondsAgo: 60 * 12,
      activity: "Browsing my sets",
      device: "Firefox · Windows",
    },
    {
      id: "demo-new",
      name: null,
      email: "new.friend@example.com",
      image: null,
      isOwner: false,
      online: false,
      lastSeenSecondsAgo: null,
      activity: null,
      device: null,
    },
  ],
};

/**
 * No-sign-in showcase of the soft-clay design system, so the new look can be
 * reviewed in preview environments where Google OAuth can't complete.
 * Safe to delete before launch — nothing links here from the app.
 */
export default function ClayPreview() {
  return (
    <div style={{ maxWidth: 520, margin: "0 auto", padding: "20px 16px 40px" }}>
      <p style={{ fontSize: 12, fontWeight: 800, color: "var(--text-muted)", margin: "0 0 4px" }}>
        QUIZTIME · DESIGN SHOWCASE
      </p>
      <h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 4px" }}>
        Soft-clay <span className="gradient-text">makeover</span>
      </h1>
      <p style={{ fontSize: 14, color: "var(--text-muted)", fontWeight: 600, margin: "0 0 20px" }}>
        Chunky toy keys, puffy cards, pressed-in inputs. Everything below is static — tap around to
        feel the press physics.
      </p>

      {/* Hero */}
      <div className="clay-hero" style={{ padding: "24px 22px", marginBottom: 20 }}>
        <div className="animate-float" style={{ marginBottom: 8 }}>
          <Sparkles size={40} strokeWidth={1.5} aria-hidden />
        </div>
        <h2 style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 900 }}>Study time!</h2>
        <p style={{ margin: "0 0 16px", fontSize: 14, opacity: 0.92, lineHeight: 1.5 }}>
          The home hero is now a glossy clay slab with a white squeeze-me button.
        </p>
        <button className="btn btn-white-clay" type="button">
          <Sparkles />
          Start Studying
        </button>
      </div>

      {/* Buttons */}
      <h2 style={{ fontSize: 16, fontWeight: 900, margin: "0 0 12px" }}>Buttons</h2>
      <div className="glass-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
        <button className="btn btn-primary btn-lg" style={{ width: "100%" }} type="button">
          <Sparkles />
          Generate Flashcards
        </button>
        <div style={{ display: "flex", gap: 12 }}>
          <button className="btn btn-success" style={{ flex: 1 }} type="button">
            <Check />
            Got it!
          </button>
          <button className="btn btn-danger" style={{ flex: 1 }} type="button">
            <X />
            Still Learning
          </button>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <button className="btn btn-secondary" style={{ flex: 1 }} type="button">
            <BookOpen />
            Secondary
          </button>
          <button className="btn btn-ghost" style={{ flex: 1 }} type="button">
            <Trash />
            Ghost
          </button>
        </div>
        <button className="btn btn-primary" disabled style={{ width: "100%" }} type="button">
          Disabled state
        </button>
      </div>

      {/* Mode cards */}
      <h2 style={{ fontSize: 16, fontWeight: 900, margin: "0 0 12px" }}>Mode picker</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
        <button className="mode-card" type="button">
          <div className="mode-icon" style={{ background: "linear-gradient(135deg, #3b82f6, #6366f1)" }}>
            <BookOpen />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800 }}>Study Mode</p>
            <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Traditional flashcards — flip the card to reveal the answer.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {["Flip to reveal", "Self-check"].map((t) => (
                <span key={t} className="badge" style={{ background: "#eff6ff", color: "#1d4ed8" }}>{t}</span>
              ))}
            </div>
          </div>
        </button>
        <button className="mode-card" type="button" disabled>
          <div className="mode-icon" style={{ background: "linear-gradient(135deg, #f59e0b, #ea580c)" }}>
            <ListOrdered />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800 }}>Enumeration</p>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Disabled state — no list-style answers in this set.
            </p>
          </div>
        </button>
      </div>

      {/* Scoreboard */}
      <h2 style={{ fontSize: 16, fontWeight: 900, margin: "0 0 12px" }}>Scoreboard + progress</h2>
      <div className="glass-card" style={{ padding: 18, marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <span className="score-pill">
            <Star />
            120 pts
          </span>
          <span className="score-pill streak-hot">
            <Flame />
            4 streak
          </span>
          <span className="score-pill" style={{ marginLeft: "auto" }}>
            <Target />
            3/10
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13, color: "var(--text-muted)", fontWeight: 700 }}>
          <span>Card 3 of 10</span>
          <span className="badge badge-medium">medium</span>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: "30%" }} />
        </div>
      </div>

      {/* Exam choices */}
      <h2 style={{ fontSize: 16, fontWeight: 900, margin: "0 0 12px" }}>Exam choices</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
        <button className="choice" type="button">
          <span className="choice-letter">A</span>
          <span className="choice-text">Mitochondria — the powerhouse of the cell</span>
        </button>
        <button className="choice selected-correct" type="button" disabled>
          <span className="choice-letter">B</span>
          <span className="choice-text">Chloroplast — where photosynthesis happens</span>
          <CircleCheckBig size={18} aria-hidden style={{ marginLeft: "auto", flexShrink: 0, color: "#10b981" }} />
        </button>
        <button className="choice selected-wrong" type="button" disabled>
          <span className="choice-letter">C</span>
          <span className="choice-text">Nucleus — the control center</span>
          <CircleX size={18} aria-hidden style={{ marginLeft: "auto", flexShrink: 0, color: "#f43f5e" }} />
        </button>
        <div className="feedback feedback-correct">
          <CircleCheckBig size={20} aria-hidden style={{ flexShrink: 0 }} />
          <span><strong>Correct!</strong> +12 points</span>
        </div>
        <div className="feedback feedback-wrong">
          <CircleX size={20} aria-hidden style={{ flexShrink: 0 }} />
          <span><strong>Wrong!</strong> The correct answer is: Chloroplast</span>
        </div>
      </div>

      {/* Inputs */}
      <h2 style={{ fontSize: 16, fontWeight: 900, margin: "0 0 12px" }}>Pressed-in inputs</h2>
      <div className="glass-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
        <input className="type-input" placeholder="Type your answer here..." aria-label="Demo answer" />
        <input className="type-input correct" defaultValue="Mitochondria" aria-label="Demo correct answer" disabled />
        <input className="type-input wrong" defaultValue="Midichloria" aria-label="Demo wrong answer" disabled />
        <button className="btn btn-primary" style={{ width: "100%" }} type="button">
          <Check />
          Check Answer
        </button>
      </div>

      {/* Mode switch + upload */}
      <h2 style={{ fontSize: 16, fontWeight: 900, margin: "0 0 12px" }}>Switches + upload tray</h2>
      <div className="mode-switch" style={{ marginBottom: 12 }}>
        <button className="active" type="button">
          <BookOpen />
          Study
        </button>
        <button type="button">
          <ClipboardCheck />
          Exam
        </button>
        <button type="button">
          <Type />
          Identify
        </button>
        <button type="button">
          <ListOrdered />
          Enumerate
        </button>
      </div>
      <div className="clay-segment" style={{ marginBottom: 12 }}>
        <button className="clay-segment-btn active" type="button">Files / Photos</button>
        <button className="clay-segment-btn" type="button">Paste Text</button>
      </div>
      <div className="upload-zone" style={{ padding: "32px 20px", textAlign: "center", marginBottom: 20 }}>
        <div style={{ marginBottom: 10, color: "var(--accent-dark)" }}>
          <BookOpen size={44} strokeWidth={1.5} aria-hidden />
        </div>
        <p style={{ fontWeight: 800, fontSize: 16, margin: "0 0 6px" }}>Tap to upload or drag &amp; drop</p>
        <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>PDF, Word, PowerPoint, JPG, PNG, WEBP</p>
      </div>

      {/* Streak slab + ring */}
      <h2 style={{ fontSize: 16, fontWeight: 900, margin: "0 0 12px" }}>Streak slab + score ring</h2>
      <div className="glass-card clay-streak" style={{ padding: "18px 20px", display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
        <Flame size={42} strokeWidth={1.5} aria-hidden />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 26, fontWeight: 900, lineHeight: 1.1 }}>6 days</div>
          <div style={{ fontSize: 13, opacity: 0.9, fontWeight: 700 }}>study streak — keep it going!</div>
        </div>
      </div>
      <div className="glass-card" style={{ padding: 24, textAlign: "center", marginBottom: 20 }}>
        <div className="score-ring" style={{ background: "linear-gradient(165deg, #34d399, #1d4ed8)" }}>
          <span style={{ fontSize: 40, fontWeight: 900, lineHeight: 1 }}>92%</span>
          <span style={{ fontSize: 12, opacity: 0.9, fontWeight: 700 }}>accuracy</span>
        </div>
        <button className="btn btn-primary" type="button">
          Retake Exam
          <ArrowRight />
        </button>
      </div>

      {/* Who's online (owner roster) — static sample data, no network */}
      <h2 style={{ fontSize: 16, fontWeight: 900, margin: "0 0 12px" }}>Who&apos;s online (owner only)</h2>
      <div className="glass-card" style={{ padding: 18, marginBottom: 20 }}>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
          The owner&apos;s presence strip — it replaces nothing and only ever renders for the address in
          <code style={{ margin: "0 4px" }}>OWNER_EMAIL</code>. Everyone else sends the same heartbeats
          and never sees this.
        </p>
        <PresenceBar roster={DEMO_ROSTER} />
        <div style={{ marginTop: 14 }}>
          <PresenceList users={DEMO_ROSTER.users} ownerId="demo-owner" max={6} />
        </div>
        <p style={{ margin: "14px 0 0", fontSize: 11.5, color: "var(--text-muted)", fontWeight: 600 }}>
          Sample data — online = a heartbeat in the last 90 s.
        </p>
      </div>

      {/* Badges */}
      <h2 style={{ fontSize: 16, fontWeight: 900, margin: "0 0 12px" }}>Badges</h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
        <span className="badge badge-easy">
          <Lightbulb size={13} aria-hidden /> easy
        </span>
        <span className="badge badge-medium">medium</span>
        <span className="badge badge-hard">hard</span>
      </div>

      <p style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600, textAlign: "center", margin: 0 }}>
        Static showcase — nothing here is wired up. The bottom dock and top bar are the real app
        chrome, so open any tab to see them in clay.
      </p>
    </div>
  );
}
