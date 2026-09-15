"use client";

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import { LoginPage } from "@/components/login-page";
import {
  extractPdfText,
  isPasswordProtectedPdf,
  PDF_TEXT_CHAR_LIMIT,
  PDF_MIN_TEXT_CHARS,
} from "@/lib/pdf-text";
import { extractDocxTextClient } from "@/lib/docx-client";
import { extractPptxTextClient } from "@/lib/pptx-client";
import {
  ArrowLeft,
  ArrowRight,
  BookBookmark,
  BookOpen,
  BookOpenCheck,
  Bot,
  Camera,
  ChartColumn,
  Check,
  CircleCheckBig,
  CircleQuestionMark,
  CircleX,
  ClipboardCheck,
  ClockArrowUp,
  Dumbbell,
  FaceSlightlyFrowning,
  FileText,
  Files,
  Flag,
  Flame,
  FolderOpen,
  Heart,
  House,
  Image as ImageIcon,
  Inbox,
  KeyRound,
  Keyboard,
  Layers,
  Library,
  Lightbulb,
  ListOrdered,
  Lock,
  Moon,
  Orbit,
  PartyPopper,
  PenLine,
  Presentation,
  RefreshCw,
  Save,
  Settings,
  Share,
  Shuffle,
  Sparkles,
  Sprout,
  Star,
  Target,
  Timer,
  Trash,
  TriangleAlert,
  Trophy,
  Type,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────
interface Flashcard {
  id?: number;
  question: string;
  answer: string;
  hint?: string | null;
  difficulty: string;
  orderIndex?: number;
}

interface CardProgress {
  cardId: number;
  isKnown: boolean;
  attempts: number;
}

interface StudySession {
  id: number;
  title: string;
  sourceType: string;
  createdAt: string;
  cardCount: number;
  knownCount?: number;
}

type Tab = "home" | "upload" | "quiz" | "sessions" | "stats";
type QuizMode = "select" | "study" | "exam" | "identify" | "enumerate";
/** The three scored modes share one run state machine (questions, score, streak). */
type ScoredMode = "exam" | "identify" | "enumerate";

/** One answered card, waiting to be (or already being) synced to the server. */
interface StudyOutcome {
  sessionId: number;
  cardId: number;
  correct: boolean;
  mode: "study" | "exam" | "identify" | "enumerate";
  answeredAt: string;
}

interface ExamQuestion {
  card: Flashcard;
  options: string[];
  correctIndex: number;
}

interface ExamAnswer {
  card: Flashcard;
  chosenIndex: number;
  chosenOption: string;
  correctIndex: number;
  isCorrect: boolean;
  points: number;
  /** Enumeration only: expected vs typed items, for the per-item review. */
  expectedItems?: string[];
  userItems?: string[];
}

interface IdentifySubmission {
  typed: string;
  isCorrect: boolean;
}

interface EnumSubmission {
  userItems: string[];
  hits: boolean[];
  userHits: boolean[];
  allCorrect: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const FALLBACK_OPTIONS = [
  "None of the above",
  "All of the above",
  "Not mentioned in the material",
  "It cannot be determined",
];

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Build multiple-choice questions: correct answer + 3 distractors taken from other cards. */
function buildExamQuestions(cards: Flashcard[]): ExamQuestion[] {
  return shuffle(cards).map((card) => {
    const correct = card.answer;
    const pool = cards
      .filter((c) => c !== card && normalize(c.answer) !== normalize(correct))
      .map((c) => c.answer);

    // Prefer distractors of a similar length to the correct answer so the
    // odd-one-out isn't obvious at a glance.
    pool.sort((a, b) => Math.abs(a.length - correct.length) - Math.abs(b.length - correct.length));

    const seen = new Set([normalize(correct)]);
    const distractors: string[] = [];
    for (const candidate of [...shuffle(pool.slice(0, 12)), ...FALLBACK_OPTIONS]) {
      if (distractors.length >= 3) break;
      const key = normalize(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      distractors.push(candidate);
    }

    const options = shuffle([correct, ...distractors]);
    return { card, options, correctIndex: options.indexOf(correct) };
  });
}

/** Points for a correct answer: 10 base + difficulty bonus. */
function pointsFor(card: Flashcard): number {
  const bonus = card.difficulty === "hard" ? 10 : card.difficulty === "medium" ? 5 : 0;
  return 10 + bonus;
}

function gradeFor(pct: number): {
  grade: string;
  message: string;
  icon: LucideIcon;
  color: string;
} {
  if (pct >= 95) return { grade: "A+", message: "Flawless! You nailed it!", icon: Trophy, color: "#10b981" };
  if (pct >= 90) return { grade: "A", message: "Excellent work!", icon: PartyPopper, color: "#22c55e" };
  if (pct >= 80) return { grade: "B", message: "Great job, keep it up!", icon: Star, color: "#3b82f6" };
  if (pct >= 70) return { grade: "C", message: "Good effort — review and retry!", icon: BookOpen, color: "#6366f1" };
  if (pct >= 60) return { grade: "D", message: "Keep studying, you'll get there!", icon: Orbit, color: "#f59e0b" };
  return { grade: "F", message: "Don't give up — study mode can help!", icon: Library, color: "#f43f5e" };
}

// ─── Typed-answer checking (Identification & Enumeration) ────────────────────
/**
 * Normalize a typed answer for comparison: lowercase, strip punctuation,
 * drop a leading article ("the mitochondria" == "mitochondria") and collapse
 * whitespace — so small formatting differences never mark a right answer wrong.
 */
function normalizeTyped(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/^(the|a|an)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Classic edit distance — the typo tolerance underneath typedMatches(). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Typo budget grows with answer length; tiny answers (symbols, numbers) must match exactly. */
function typoBudget(len: number): number {
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  if (len <= 10) return 2;
  return 3;
}

/** True when the typed text matches the expected answer (typo-tolerant). */
function typedMatches(user: string, expected: string): boolean {
  const u = normalizeTyped(user);
  if (!u) return false;
  const full = normalizeTyped(expected);
  // A parenthetical aside ("Mitochondria (powerhouse of the cell)") should
  // never be required typing — also accept the answer with asides removed.
  // (Stripped before normalizing, since normalizing erases the parentheses.)
  const noAsides = normalizeTyped(expected.replace(/\([^()]*\)/g, " "));
  const variants = noAsides && noAsides !== full ? [full, noAsides] : [full];
  return variants.some(
    (v) => v.length > 0 && (u === v || levenshtein(u, v) <= typoBudget(Math.max(u.length, v.length)))
  );
}

/**
 * Alternative phrasings in an answer are separated with "/" ("Paris / City of
 * Light") — typing any one of them counts. (";" is reserved for enumeration
 * lists, so it is never treated as an alternative here.)
 */
function splitAlternatives(answer: string): string[] {
  return answer
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True when the typed text matches any accepted phrasing of the answer. */
function typedMatchesAny(user: string, answer: string): boolean {
  return splitAlternatives(answer).some((alt) => typedMatches(user, alt));
}

// ─── Enumeration helpers ─────────────────────────────────────────────────────
const ENUM_SPLIT_PATTERN = /[;\n]+/;
const ENUM_ITEM_MAX_LEN = 50;
const ENUM_ITEM_MAX_COUNT = 15;

/** Remove a leading bullet/number ("1.", "-", "•") from one list item. */
function cleanEnumItem(s: string): string {
  return s.replace(/^\s*(?:\d{1,2}[.)]\s*|[•\-–—*]\s*)+/, "").trim();
}

/** Guards that keep prose answers from being mistaken for lists. */
function acceptEnumItems(items: string[], strictPair: boolean): string[] | null {
  const cleaned = items.map(cleanEnumItem).filter((s) => s.length > 0);
  if (cleaned.length < 2 || cleaned.length > ENUM_ITEM_MAX_COUNT) return null;
  if (cleaned.some((s) => s.length > ENUM_ITEM_MAX_LEN)) return null;
  // A single ";" or line break often joins two prose clauses ("...; however ..."),
  // so a 2-way split only counts as a list when the second item reads like one.
  if (strictPair && cleaned.length === 2 && !/^[\p{Lu}\p{N}]/u.test(cleaned[1])) return null;
  return cleaned;
}

/**
 * Split an answer into enumeration items. The AI writes list answers with
 * " ; " separators (see the scan prompt); numbered and bulleted lists are
 * handled too so older decks keep working. Returns a single-item array when
 * the answer is not a list.
 */
function getEnumItems(answer: string): string[] {
  const bySeparator = acceptEnumItems(answer.split(ENUM_SPLIT_PATTERN), true);
  if (bySeparator) return bySeparator;

  if (answer.includes("•")) {
    const byBullet = acceptEnumItems(answer.split("•"), false);
    if (byBullet) return byBullet;
  }

  // Numbered lists ("1. Mango 2. Banana") — only when the text actually reads
  // like a list, so "I have 2 apples" never becomes an enumeration.
  if (/^\s*\d{1,2}[.)]/.test(answer) && /\s\d{1,2}[.)]\s/.test(answer)) {
    const byNumber = acceptEnumItems(answer.split(/\s*\d{1,2}[.)]\s*/), false);
    if (byNumber) return byNumber;
  }

  return [answer.trim()];
}

/** True when the card's answer is a list suited to Enumeration mode. */
function isEnumCard(card: Flashcard): boolean {
  return getEnumItems(card.answer).length >= 2;
}

/**
 * Grade enumeration answers order-independently: each typed item claims the
 * first still-unclaimed expected item it matches, so duplicates can't score
 * twice and listing order never matters.
 */
function matchEnumItems(
  userItems: string[],
  expectedItems: string[]
): { hits: boolean[]; userHits: boolean[] } {
  const hits = expectedItems.map(() => false);
  const userHits = userItems.map(() => false);
  userItems.forEach((typed, i) => {
    if (!typed.trim()) return;
    const j = expectedItems.findIndex((exp, k) => !hits[k] && typedMatches(typed, exp));
    if (j !== -1) {
      hits[j] = true;
      userHits[i] = true;
    }
  });
  return { hits, userHits };
}

/**
 * Phone photos are often 3–10 MB (and sometimes arrive as HEIC or with an
 * empty mime type), which hosting platforms and the Gemini API both reject.
 * Downscale to a normal JPEG before uploading; if anything fails we just
 * send the original file.
 */
async function compressImage(file: File, maxDim = 1600, quality = 0.82): Promise<File> {
  try {
    if (!file.type.startsWith("image/") || file.size <= 600 * 1024) return file;

    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Lucide icon for a study set's source type. */
function SourceTypeIcon({ type, size }: { type: string; size: number }) {
  const Icon =
    type === "pdf"
      ? FileText
      : type === "image"
      ? ImageIcon
      : type === "docx"
      ? PenLine
      : type === "pptx"
      ? Presentation
      : type === "mixed"
      ? Files
      : Keyboard;
  return <Icon size={size} strokeWidth={1.75} aria-hidden />;
}

// ─── Confetti ────────────────────────────────────────────────────────────────
function launchConfetti() {
  const colors = ["#3b82f6", "#7c3aed", "#38bdf8", "#10b981", "#fbbf24", "#f43f5e"];
  for (let i = 0; i < 60; i++) {
    setTimeout(() => {
      const el = document.createElement("div");
      el.className = "confetti-piece";
      el.style.left = `${Math.random() * 100}vw`;
      el.style.top = "-10px";
      el.style.background = colors[Math.floor(Math.random() * colors.length)];
      el.style.width = `${6 + Math.random() * 8}px`;
      el.style.height = `${6 + Math.random() * 8}px`;
      el.style.borderRadius = Math.random() > 0.5 ? "50%" : "2px";
      el.style.animationDuration = `${2 + Math.random() * 2}s`;
      el.style.animationDelay = `${Math.random() * 0.5}s`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 4000);
    }, i * 30);
  }
}

// ─── Toast ───────────────────────────────────────────────────────────────────
/** Sink installed by <ToastHost/> while it is mounted (null otherwise). */
let pushToast: ((msg: string, icon: LucideIcon) => void) | null = null;

/**
 * Fire a toast from anywhere — event handlers, async callbacks, promise
 * rejections — without prop-drilling. The icon is a Lucide component so the
 * toast renders a real SVG instead of an emoji.
 */
function showToast(msg: string, icon: LucideIcon = Sparkles) {
  pushToast?.(msg, icon);
}

/**
 * Renders toasts inside React. Registered as the module-level sink above, so
 * showToast() keeps its call-site ergonomics while the markup stays in the tree.
 */
function ToastHost() {
  const [toast, setToast] = useState<{ msg: string; icon: LucideIcon; key: number } | null>(null);

  useEffect(() => {
    pushToast = (msg, icon) => setToast({ msg, icon, key: Date.now() });
    return () => {
      pushToast = null;
    };
  }, []);

  // The slide-in/hold/slide-out is a single CSS animation (see .toast in
  // globals.css), so no visibility state is needed. A new toast bumps `key`,
  // which remounts the node and restarts the animation.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3100);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;
  const Icon = toast.icon;
  return (
    <div className="toast" key={toast.key} role="status">
      <Icon aria-hidden />
      <span>{toast.msg}</span>
    </div>
  );
}

// ─── Study Mode: traditional flashcard (flip to reveal) ─────────────────────
function StudyCard({
  card,
  index,
  total,
  onKnow,
  onDontKnow,
  onNext,
  onPrev,
  progress,
}: {
  card: Flashcard;
  index: number;
  total: number;
  onKnow: () => void;
  onDontKnow: () => void;
  onNext: () => void;
  onPrev: () => void;
  progress: CardProgress | undefined;
}) {
  const [flipped, setFlipped] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [answering, setAnswering] = useState(false);

  const handleFlip = () => {
    if (!flipped) setFlipped(true);
  };

  const handleKnow = () => {
    setAnswering(true);
    setTimeout(() => {
      onKnow();
      setAnswering(false);
    }, 300);
  };

  const handleDontKnow = () => {
    setAnswering(true);
    setTimeout(() => {
      onDontKnow();
      setAnswering(false);
    }, 300);
  };

  const difficultyColor = {
    easy: "#10b981",
    medium: "#f59e0b",
    hard: "#f43f5e",
  }[card.difficulty] || "#6366f1";

  return (
    <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Progress */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="btn btn-ghost btn-sm" onClick={onPrev} disabled={index === 0} style={{ padding: "6px 10px", borderRadius: 12 }}>
          <ArrowLeft />
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13, color: "var(--text-muted)", fontWeight: 600 }}>
            <span>Card {index + 1} of {total}</span>
            <span className="badge" style={{ background: `${difficultyColor}20`, color: difficultyColor }}>
              {card.difficulty}
            </span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${((index + 1) / total) * 100}%` }} />
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onNext} disabled={index === total - 1} style={{ padding: "6px 10px", borderRadius: 12 }}>
          <ArrowRight />
        </button>
      </div>

      {/* Card */}
      <div
        className="card-container"
        style={{ height: 320, cursor: flipped ? "default" : "pointer" }}
        onClick={!flipped ? handleFlip : undefined}
      >
        <div className={`card-inner ${flipped ? "flipped" : ""}`}>
          {/* Front */}
          <div
            className="card-front glass-card clay-flash-front"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 28,
            }}
          >
            <div style={{ marginBottom: 12, color: "var(--accent-dark)" }}>
              <CircleQuestionMark size={36} strokeWidth={1.5} aria-hidden />
            </div>
            <p style={{ textAlign: "center", fontSize: 18, fontWeight: 700, color: "var(--text)", lineHeight: 1.4, margin: 0 }}>
              {card.question}
            </p>
            {!flipped && (
              <p style={{ marginTop: 20, fontSize: 13, color: "var(--text-muted)", fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                <Orbit size={14} aria-hidden />
                Tap to reveal answer
              </p>
            )}
          </div>

          {/* Back */}
          <div
            className="card-back glass-card clay-flash-back"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 28,
            }}
          >
            <div style={{ marginBottom: 10, color: "#f59e0b" }}>
              <Lightbulb size={32} strokeWidth={1.5} aria-hidden />
            </div>
            <p style={{ textAlign: "center", fontSize: 16, fontWeight: 600, color: "var(--text)", lineHeight: 1.5, margin: 0, overflowY: "auto", maxHeight: 200 }}>
              {card.answer}
            </p>
          </div>
        </div>
      </div>

      {/* Hint */}
      {card.hint && !flipped && (
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setShowHint(!showHint)}
          style={{ alignSelf: "center", color: "#f59e0b", gap: 6 }}
        >
          <Lightbulb />
          {showHint ? "Hide hint" : "Show hint"}
        </button>
      )}
      {showHint && card.hint && !flipped && (
        <div style={{
          background: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: 12,
          padding: "10px 16px",
          fontSize: 14,
          color: "#92400e",
          textAlign: "center",
          animation: "fadeIn 0.3s ease",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}>
          <Lightbulb size={16} aria-hidden />
          <span>{card.hint}</span>
        </div>
      )}

      {/* Action buttons */}
      {flipped && (
        <div className="animate-slide-up" style={{ display: "flex", gap: 12 }}>
          <button
            className="btn btn-danger"
            style={{ flex: 1, opacity: answering ? 0.7 : 1 }}
            onClick={handleDontKnow}
            disabled={answering}
          >
            <X />
            Still Learning
          </button>
          <button
            className="btn btn-success"
            style={{ flex: 1, opacity: answering ? 0.7 : 1 }}
            onClick={handleKnow}
            disabled={answering}
          >
            <Check />
            Got it!
          </button>
        </div>
      )}

      {/* Progress indicator */}
      {progress && (
        <div style={{ textAlign: "center", fontSize: 12, color: "var(--text-muted)" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            {progress.isKnown ? (
              <CircleCheckBig size={13} aria-hidden />
            ) : (
              <RefreshCw size={13} aria-hidden />
            )}
            {progress.isKnown ? "Marked as known" : "Still learning"}
          </span>
          {" · "}
          {progress.attempts} attempt{progress.attempts !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

// ─── Review Summary ───────────────────────────────────────────────────────────
function ReviewSummary({
  cards,
  progress,
  onRestart,
  onReviewWeak,
}: {
  cards: Flashcard[];
  progress: CardProgress[];
  onRestart: () => void;
  onReviewWeak: () => void;
}) {
  const known = progress.filter((p) => p.isKnown).length;
  const total = cards.length;
  const pct = Math.round((known / total) * 100);

  useEffect(() => {
    if (pct >= 80) launchConfetti();
  }, [pct]);

  const SummaryIcon = pct >= 90 ? Trophy : pct >= 70 ? Star : pct >= 50 ? Dumbbell : Library;
  const message =
    pct >= 90
      ? "Outstanding! You're a genius!"
      : pct >= 70
      ? "Great job! Keep it up!"
      : pct >= 50
      ? "Good progress! Review the ones you missed!"
      : "Keep studying! You've got this!";

  return (
    <div className="animate-fade-in" style={{ textAlign: "center", padding: "20px 0" }}>
      <div style={{ display: "flex", justifyContent: "center", color: "var(--accent-dark)" }}>
        <SummaryIcon size={80} strokeWidth={1.5} aria-hidden />
      </div>
      <h2 className="gradient-text" style={{ fontSize: 28, fontWeight: 800, margin: "8px 0 4px" }}>
        Session Complete!
      </h2>
      <p style={{ color: "var(--text-muted)", margin: "0 0 24px", fontSize: 15 }}>{message}</p>

      {/* Score circle */}
      <div
        style={{
          width: 140,
          height: 140,
          borderRadius: "50%",
          background: "linear-gradient(165deg, #5b9cff 0%, #4f6df5 55%, #7c3aed 100%)",
          border: "4px solid rgba(255,255,255,0.9)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 24px",
          boxShadow: "inset 0 4px 8px rgba(255,255,255,0.4), inset 0 -10px 18px rgba(0,0,0,0.22), 0 14px 30px rgba(43,80,180,0.35)",
        }}
      >
        <span style={{ fontSize: 40, fontWeight: 900, color: "white" }}>{pct}%</span>
        <span style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", fontWeight: 500 }}>Score</span>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 24 }}>
        {[
          { label: "Total", value: total, color: "#3b82f6", bg: "#eef2ff" },
          { label: "Known", value: known, color: "#10b981", bg: "#f0fff8" },
          { label: "Review", value: total - known, color: "#f43f5e", bg: "#eff6ff" },
        ].map((s) => (
          <div key={s.label} style={{ background: s.bg, borderRadius: 16, padding: "14px 8px" }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {total - known > 0 && (
          <button className="btn btn-primary btn-lg" onClick={onReviewWeak} style={{ width: "100%" }}>
            <RefreshCw />
            Review {total - known} Missed Cards
          </button>
        )}
        <button className="btn btn-secondary" onClick={onRestart} style={{ width: "100%" }}>
          <RefreshCw />
          Restart All Cards
        </button>
      </div>
    </div>
  );
}

// ─── Upload Page ──────────────────────────────────────────────────────────────
type PickedFile = {
  id: string;
  file: File;
  kind: "PDF" | "Image" | "Word" | "PowerPoint";
  previewUrl?: string;
};

const MAX_FILES = 8;
const MAX_TOTAL_MB = 50;
const MAX_UPLOAD_MB = 50;

// Serverless hosts (Vercel) reject request bodies over ~4.5 MB with a 413,
// so PDFs are parsed to text in the browser once this direct-upload budget
// is used up — only the extracted text (a few hundred KB) is sent instead.
// Images are exempt: they're compressed before upload and need Gemini's
// vision anyway.
const PDF_DIRECT_UPLOAD_BUDGET = 4 * 1024 * 1024;
// Same budget applies to Word (.docx) and PowerPoint (.pptx) files — large
// documents are extracted to text in the browser before upload.
const DOC_DIRECT_UPLOAD_BUDGET = PDF_DIRECT_UPLOAD_BUDGET;
// Absolute ceiling for sending raw file bytes; beyond this the request is
// guaranteed to 413, so prefer a clear error message over a doomed upload.
const DIRECT_UPLOAD_HARD_CAP = 4.4 * 1024 * 1024;

// When a document's extracted text exceeds this many characters, it is split
// into parts and uploaded in multiple sequential API calls. Each part stays
// well under the server's 100k-char text limit and Vercel's 4.5 MB body cap.
const TEXT_CHUNK_MAX_CHARS = 90_000;

/**
 * Split a long text into chunks at paragraph (or sentence) boundaries so each
 * part fits in a single API request. Used for multi-part uploads of large
 * documents that would otherwise exceed the serverless body limit.
 */
function splitTextIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    // Would adding this paragraph exceed the limit?
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }

    // A single paragraph larger than maxChars needs sentence-level splitting.
    if (para.length > maxChars) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if (current.length + sentence.length + 1 > maxChars && current.length > 0) {
          chunks.push(current.trim());
          current = "";
        }
        current += (current ? " " : "") + sentence;
      }
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function isPDFFile(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
}

function isWordFile(file: File): boolean {
  return (
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    file.type === "application/msword" ||
    /\.docx?$/i.test(file.name || "")
  );
}

function isPptxFile(file: File): boolean {
  const ty = (file.type || "").toLowerCase();
  return (
    ty === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    ty === "application/vnd.ms-powerpoint" ||
    ty === "application/vnd.openxmlformats-officedocument.presentationml.slideshow" ||
    /\.pptx?$/i.test(file.name || "")
  );
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || "");
}

function UploadPage({ onCardsReady }: { onCardsReady: (cards: Flashcard[], title: string, summary: string, sourceType: string) => void }) {
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [statusText, setStatusText] = useState("");
  const [textInput, setTextInput] = useState("");
  const [mode, setMode] = useState<"file" | "text">("file");
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickedRef = useRef<PickedFile[]>([]);

  useEffect(() => {
    pickedRef.current = picked;
  }, [picked]);

  // Release thumbnail URLs when the screen goes away
  useEffect(
    () => () => {
      pickedRef.current.forEach((item) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
    },
    []
  );

  const addFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return;

      const accepted: PickedFile[] = [];
      let rejected = 0;

      for (const file of incoming) {
        const pdf = isPDFFile(file);
        const image = isImageFile(file);
        const word = isWordFile(file);
        const pptx = isPptxFile(file);
        if (!pdf && !image && !word && !pptx) {
          rejected++;
          continue;
        }
        if (picked.some((item) => item.file.name === file.name && item.file.size === file.size)) {
          continue; // already added
        }
        accepted.push({
          id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          kind: pdf ? "PDF" : word ? "Word" : pptx ? "PowerPoint" : "Image",
          previewUrl: image ? URL.createObjectURL(file) : undefined,
        });
      }

      const room = Math.max(0, MAX_FILES - picked.length);
      const kept = accepted.slice(0, room);

      if (rejected > 0) {
        setError("Only PDF, Word (.docx), PowerPoint (.pptx) or image files (JPG, PNG, WEBP) are supported.");
      } else if (accepted.length > kept.length) {
        setError(`You can upload up to ${MAX_FILES} files at a time.`);
      } else {
        setError("");
      }

      if (kept.length > 0) {
        setPicked((prev) => [...prev, ...kept]);
      }
    },
    [picked]
  );

  const removeFile = (id: string) => {
    const target = picked.find((item) => item.id === id);
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    setPicked((prev) => prev.filter((item) => item.id !== id));
    setError("");
  };

  const clearFiles = () => {
    picked.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    setPicked([]);
    setError("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      addFiles(Array.from(e.dataTransfer.files || []));
    },
    [addFiles]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) addFiles(files);
    e.target.value = ""; // allow picking the same file again
  };

  const handleSubmit = async () => {
    setError("");
    setStatusText("");
    setLoading(true);

    try {
      type ScanResponse = {
        error?: string;
        cards?: Flashcard[];
        title?: string;
        summary?: string;
        /** Model that produced the cards (the server may have failed over). */
        model?: string;
        /** Provider that produced the cards: "gemini" or "openrouter". */
        provider?: string;
        /** Set when the server had to switch models (rate limit / unavailable). */
        notice?: string;
      };

      /** Send one FormData payload to /api/scan and parse the JSON response. */
      const sendScanRequest = async (formData: FormData): Promise<ScanResponse> => {
        const res = await fetch("/api/scan", { method: "POST", body: formData });

        // The body may not be JSON (e.g. a host-level 413 page), so parse
        // defensively instead of crashing with "not valid JSON".
        const raw = await res.text();
        let data: ScanResponse | null = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch { data = null; }
        }
        if (!res.ok || !data || data.error) {
          const sizeHint =
            res.status === 413
              ? " — that upload is too large for the server to accept. Remove a few files or use smaller ones."
              : "";
          throw new Error(
            data?.error || `The upload failed (HTTP ${res.status}${sizeHint || ""}). Please try again.`
          );
        }
        if (!data.cards) {
          throw new Error("No flashcards were generated from this content");
        }
        return data;
      };

      let sourceType = "text";

      if (mode === "file") {
        if (picked.length === 0) {
          setError("Please add at least one PDF, photo, Word or PowerPoint file");
          setLoading(false);
          return;
        }

        const totalBytes = picked.reduce((sum, item) => sum + item.file.size, 0);
        if (totalBytes > MAX_TOTAL_MB * 1024 * 1024) {
          setError(`That's ${formatSize(totalBytes)} in total — please keep it under ${MAX_TOTAL_MB} MB by removing a few files.`);
          setLoading(false);
          return;
        }
        for (const item of picked) {
          if (item.file.size > MAX_UPLOAD_MB * 1024 * 1024) {
            setError(`"${item.file.name}" is ${formatSize(item.file.size)} — please use files under ${MAX_UPLOAD_MB} MB.`);
            setLoading(false);
            return;
          }
        }

        // ── Phase 1: Extract text from large documents in the browser ──────
        // PDFs, Word docs and PowerPoints whose bytes no longer fit the
        // direct-upload budget (~4 MB) are parsed to text right here in the
        // browser; only the extracted text is sent to the server. Smaller
        // files still go as binary so Gemini can see diagrams and layout.
        let directBytes = 0;
        let truncatedText = false;
        const textChunks: string[] = [];
        // Binary files (images, small PDFs/docs) collected for the first
        // upload part — kept separate so multi-part uploads can attach them
        // only to the first request.
        const binaryFiles: File[] = [];

        for (const item of picked) {
          // ── Large PDF: extract text in the browser ───────────────────────
          const pdfNeedsText =
            item.kind === "PDF" && directBytes + item.file.size > PDF_DIRECT_UPLOAD_BUDGET;

          if (pdfNeedsText) {
            let text = "";
            try {
              text = await extractPdfText(item.file, (page, total) => {
                setStatusText(`Reading "${item.file.name}" — page ${page} of ${total}...`);
              });
            } catch (err) {
              if (isPasswordProtectedPdf(err)) {
                throw new Error(`"${item.file.name}" is password-protected. Remove the password and try again.`);
              }
              // Old browser or a pdf.js hiccup — if the file still fits under
              // the hard cap, upload it directly like before.
              if (directBytes + item.file.size <= DIRECT_UPLOAD_HARD_CAP) {
                binaryFiles.push(item.file);
                directBytes += item.file.size;
                continue;
              }
              throw new Error(
                `Couldn't read "${item.file.name}" (${formatSize(item.file.size)}) in this browser. Try a smaller PDF, or upload photos of the pages.`
              );
            }

            if (text.replace(/\s/g, "").length < PDF_MIN_TEXT_CHARS) {
              // No text layer: it's a scan/photo PDF. Vision can still read
              // it if the bytes fit; otherwise it simply can't be uploaded.
              if (directBytes + item.file.size <= DIRECT_UPLOAD_HARD_CAP) {
                binaryFiles.push(item.file);
                directBytes += item.file.size;
                continue;
              }
              throw new Error(
                `"${item.file.name}" looks like a scanned PDF (no selectable text) and at ${formatSize(
                  item.file.size
                )} it's too large to upload as-is. Split it into a smaller file, or upload photos of the key pages.`
              );
            }

            if (text.length > PDF_TEXT_CHAR_LIMIT) {
              text = text.slice(0, PDF_TEXT_CHAR_LIMIT);
              truncatedText = true;
            }
            textChunks.push(`--- PDF text: ${item.file.name} ---\n${text}`);
            continue;
          }

          // ── Large Word document: extract text in the browser ─────────────
          const docxNeedsText =
            item.kind === "Word" && directBytes + item.file.size > DOC_DIRECT_UPLOAD_BUDGET;

          if (docxNeedsText) {
            let text = "";
            try {
              setStatusText(`Reading "${item.file.name}" (${formatSize(item.file.size)})...`);
              text = await extractDocxTextClient(item.file);
            } catch (err) {
              // Extraction failed — if the file still fits under the hard
              // cap, let the server try (it has the same mammoth library).
              if (directBytes + item.file.size <= DIRECT_UPLOAD_HARD_CAP) {
                binaryFiles.push(item.file);
                directBytes += item.file.size;
                continue;
              }
              throw new Error(
                err instanceof Error
                  ? err.message
                  : `Couldn't read "${item.file.name}" (${formatSize(item.file.size)}) in this browser. Try a smaller file.`
              );
            }

            if (text.length > PDF_TEXT_CHAR_LIMIT) {
              text = text.slice(0, PDF_TEXT_CHAR_LIMIT);
              truncatedText = true;
            }
            textChunks.push(`--- Word document: ${item.file.name} ---\n${text}`);
            continue;
          }

          // ── Large PowerPoint: extract text in the browser ────────────────
          const pptxNeedsText =
            item.kind === "PowerPoint" && directBytes + item.file.size > DOC_DIRECT_UPLOAD_BUDGET;

          if (pptxNeedsText) {
            let text = "";
            try {
              text = await extractPptxTextClient(item.file, (slide, total) => {
                setStatusText(`Reading "${item.file.name}" — slide ${slide} of ${total}...`);
              });
            } catch (err) {
              // Extraction failed — if the file still fits under the hard
              // cap, let the server try (it has the same JSZip library).
              if (directBytes + item.file.size <= DIRECT_UPLOAD_HARD_CAP) {
                binaryFiles.push(item.file);
                directBytes += item.file.size;
                continue;
              }
              throw new Error(
                err instanceof Error
                  ? err.message
                  : `Couldn't read "${item.file.name}" (${formatSize(item.file.size)}) in this browser. Try a smaller file.`
              );
            }

            if (text.length > PDF_TEXT_CHAR_LIMIT) {
              text = text.slice(0, PDF_TEXT_CHAR_LIMIT);
              truncatedText = true;
            }
            textChunks.push(`--- PowerPoint presentation: ${item.file.name} ---\n${text}`);
            continue;
          }

          // ── Small file or image: send as binary ─────────────────────────
          const optimized = await compressImage(item.file);
          binaryFiles.push(optimized);
          directBytes += optimized.size;
        }

        // ── Phase 2: Prepare upload parts ───────────────────────────────────
        // Join all extracted text and split it into chunks that each fit
        // within the server's text limit. When there are multiple chunks,
        // the upload is sent in parts — binary files go with the first part,
        // and each subsequent part carries only its text chunk.
        let joinedText = "";
        if (textChunks.length > 0) {
          joinedText = textChunks.join("\n\n");
          if (joinedText.length > PDF_TEXT_CHAR_LIMIT) {
            joinedText = joinedText.slice(0, PDF_TEXT_CHAR_LIMIT);
            truncatedText = true;
          }
        }

        const uploadParts = joinedText
          ? splitTextIntoChunks(joinedText, TEXT_CHUNK_MAX_CHARS)
          : [];
        const isMultiPart = uploadParts.length > 1;

        if (isMultiPart) {
          setStatusText(
            `Large file detected! Uploading in ${uploadParts.length} parts (~4 MB each)...`
          );
        } else if (truncatedText) {
          setStatusText("Long document — using the first ~100k characters...");
        }

        // ── Phase 3: Upload (single or multi-part) ──────────────────────────
        const allResults: ScanResponse[] = [];

        if (!isMultiPart) {
          // ── Single upload (existing behavior) ────────────────────────────
          const formData = new FormData();
          binaryFiles.forEach((f) => formData.append("file", f));
          if (joinedText) formData.append("text", joinedText);

          const result = await sendScanRequest(formData);
          allResults.push(result);
        } else {
          // ── Multi-part upload ────────────────────────────────────────────
          // Part 1 includes binary files (images, small docs) alongside the
          // first text chunk. Parts 2+ carry only their text chunk.
          for (let i = 0; i < uploadParts.length; i++) {
            setStatusText(
              `Uploading part ${i + 1} of ${uploadParts.length}...`
            );

            const formData = new FormData();
            if (i === 0) {
              binaryFiles.forEach((f) => formData.append("file", f));
            }
            // Label each part so the AI knows it's reading a fragment of a
            // larger document — this helps it generate relevant flashcards
            // instead of treating each chunk as a standalone document.
            const partLabel =
              uploadParts.length > 1
                ? `[Part ${i + 1} of ${uploadParts.length} — generate flashcards for this section of the document]\n\n`
                : "";
            formData.append("text", partLabel + uploadParts[i]);

            const result = await sendScanRequest(formData);
            allResults.push(result);

            // Brief pause between parts to avoid hitting rate limits.
            if (i < uploadParts.length - 1) {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
        }

        // ── Phase 4: Merge results ──────────────────────────────────────────
        const mergedCards = allResults.flatMap((r) => r.cards || []);
        const mergedTitle = allResults[0].title || "Study Set";
        const mergedSummary = allResults[0].summary || "";
        const mergedNotice = allResults.map((r) => r.notice).filter(Boolean).join("; ");

        if (mergedCards.length === 0) {
          throw new Error("No flashcards were generated from this content");
        }

        const pdfs = picked.filter((item) => item.kind === "PDF").length;
        const words = picked.filter((item) => item.kind === "Word").length;
        const pptxs = picked.filter((item) => item.kind === "PowerPoint").length;
        const images = picked.filter((item) => item.kind === "Image").length;
        sourceType =
          picked.length === 1
            ? pdfs === 1
              ? "pdf"
              : words === 1
              ? "docx"
              : pptxs === 1
              ? "pptx"
              : "image"
            : images === picked.length
            ? "image"
            : "mixed";

        if (isMultiPart) {
          setStatusText("");
          showToast(
            `Generated ${mergedCards.length} flashcards from ${uploadParts.length} parts!`,
            PartyPopper
          );
        }

        onCardsReady(mergedCards, mergedTitle, mergedSummary, sourceType);
        // If the AI had to switch models (its rate limit was hit, or the model
        // isn't available) the server says so — that's worth showing instead of
        // the plain success toast.
        if (mergedNotice && !isMultiPart) {
          showToast(mergedNotice, TriangleAlert);
        } else if (!isMultiPart) {
          showToast(`Generated ${mergedCards.length} flashcards!`, PartyPopper);
        }
      } else {
        if (!textInput.trim()) { setError("Please enter some text to study"); setLoading(false); return; }
        const formData = new FormData();
        formData.append("text", textInput.trim());
        sourceType = "text";

        const result = await sendScanRequest(formData);
        onCardsReady(result.cards || [], result.title || "Study Set", result.summary || "", sourceType);
        if (result.notice) {
          showToast(result.notice, TriangleAlert);
        } else {
          showToast(`Generated ${(result.cards || []).length} flashcards!`, PartyPopper);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setStatusText("");
    }
  };

  const totalBytes = picked.reduce((sum, item) => sum + item.file.size, 0);
  const photos = picked.filter((item) => item.kind === "Image").length;

  return (
    <div className="animate-fade-in" style={{ padding: "20px 16px" }}>
      <h2 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 4px" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Upload size={20} aria-hidden />
          Upload Study Material
        </span>
      </h2>
      <p style={{ color: "var(--text-muted)", margin: "0 0 20px", fontSize: 14 }}>
        Upload PDFs, Word docs, PowerPoints or photos — large files are automatically split and uploaded in parts — or paste text!
      </p>

      {/* Mode toggle */}
      <div className="clay-segment" style={{ marginBottom: 20 }}>
        {[
          { id: "file" as const, label: "Files / Photos", Icon: FileText },
          { id: "text" as const, label: "Paste Text", Icon: Keyboard },
        ].map((m) => (
          <button
            key={m.id}
            className={"clay-segment-btn" + (mode === m.id ? " active" : "")}
            onClick={() => { setMode(m.id); setError(""); }}
          >
            <m.Icon size={15} aria-hidden />
            {m.label}
          </button>
        ))}
      </div>

      {mode === "file" ? (
        <>
          <div
            className={`upload-zone ${dragOver ? "drag-over" : ""}`}
            style={{ padding: picked.length ? "26px 20px" : "40px 20px", textAlign: "center", marginBottom: 16 }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.doc,.docx,.ppt,.pptx,image/*"
              multiple
              style={{ display: "none" }}
              onChange={handleFileChange}
            />
            <div style={{ marginBottom: 10, color: "var(--accent-dark)" }}>
              {picked.length ? (
                <ImageIcon size={48} strokeWidth={1.5} aria-hidden />
              ) : (
                <FolderOpen size={48} strokeWidth={1.5} aria-hidden />
              )}
            </div>
            <p style={{ fontWeight: 700, fontSize: 16, margin: "0 0 6px" }}>
              {picked.length ? "Add more files" : "Tap to upload or drag & drop"}
            </p>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
              {picked.length
                ? `${picked.length} of ${MAX_FILES} added · ${formatSize(totalBytes)}`
                : `PDF, Word, PowerPoint, JPG, PNG, WEBP · up to ${MAX_FILES} files`}
            </p>
          </div>

          {/* Selected files */}
          {picked.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>
                  {picked.length} file{picked.length === 1 ? "" : "s"} selected · {formatSize(totalBytes)}
                </p>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ padding: "4px 10px", fontSize: 12 }}
                  onClick={(e) => { e.stopPropagation(); clearFiles(); }}
                >
                  Clear all
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                {picked.map((item) => (
                  <div
                    key={item.id}
                    className="clay-thumb"
                    style={{
                      position: "relative",
                      aspectRatio: "1 / 1",
                      borderRadius: 14,
                      overflow: "hidden",
                      border: "2px solid #dbeafe",
                      background: "white",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {item.previewUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={item.previewUrl}
                        alt={item.file.name}
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : (
                      <div style={{ color: "var(--accent-dark)" }}>
                        {item.kind === "Word" ? (
                          <PenLine size={34} strokeWidth={1.5} aria-hidden />
                        ) : item.kind === "PowerPoint" ? (
                          <Presentation size={34} strokeWidth={1.5} aria-hidden />
                        ) : (
                          <FileText size={34} strokeWidth={1.5} aria-hidden />
                        )}
                      </div>
                    )}
                    <button
                      className="remove-btn"
                      onClick={(e) => { e.stopPropagation(); removeFile(item.id); }}
                      aria-label={`Remove ${item.file.name}`}
                    >
                      <X />
                    </button>
                    <span
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: 0,
                        padding: "12px 6px 5px",
                        background: "linear-gradient(transparent, rgba(15,35,63,0.85))",
                        color: "white",
                        fontSize: 10,
                        textAlign: "center",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {item.file.name}
                    </span>
                  </div>
                ))}
              </div>

              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "10px 0 0", textAlign: "center" }}>
                {picked.length > 1
                  ? `All ${picked.length} files (${photos} photo${photos === 1 ? "" : "s"}) are combined into one study set`
                  : "Ready to generate"}
              </p>
            </div>
          )}

          {/* Quick options for mobile */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
            <button
              className="btn btn-secondary"
              onClick={() => {
                if (fileRef.current) {
                  fileRef.current.accept = "image/*";
                  fileRef.current.setAttribute("capture", "environment");
                  fileRef.current.click();
                }
              }}
            >
              <ImageIcon />
              Camera
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                if (fileRef.current) {
                  fileRef.current.accept = ".pdf,.doc,.docx,.ppt,.pptx,image/*";
                  fileRef.current.removeAttribute("capture");
                  fileRef.current.click();
                }
              }}
            >
              <FileText />
              Gallery / Files
            </button>
          </div>
        </>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <textarea
            className="clay-textarea"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Paste your notes, book excerpt, or any study text here... The AI will turn it into flashcards!"
            style={{
              width: "100%",
              minHeight: 200,
              padding: "16px",
              borderRadius: 16,
              border: "2px solid #ffffff",
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.6,
              resize: "vertical",
              fontFamily: "inherit",
              outline: "none",
              color: "var(--text)",
              background: "#e9efff",
              transition: "border-color 0.2s, box-shadow 0.2s, background 0.2s",
            }}
            onFocus={(e) => { e.target.style.borderColor = "var(--blue)"; e.target.style.background = "white"; }}
            onBlur={(e) => { e.target.style.borderColor = "#ffffff"; e.target.style.background = "#e9efff"; }}
          />
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0", textAlign: "right" }}>
            {textInput.length} characters
          </p>
        </div>
      )}

      {error && (
        <div
          className="feedback feedback-wrong"
          style={{
            marginBottom: 16,
          }}
        >
          <TriangleAlert size={17} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}

      <button
        className="btn btn-primary btn-lg"
        style={{ width: "100%", position: "relative" }}
        onClick={handleSubmit}
        disabled={loading}
      >
        {loading ? (
          <>
            <div className="spinner" style={{ width: 22, height: 22, borderWidth: 2.5, borderColor: "rgba(255,255,255,0.4)", borderTopColor: "white" }} />
            {statusText
              ? statusText
              : mode === "file" && picked.length > 1
              ? `Reading ${picked.length} files...`
              : "Generating Flashcards..."}
          </>
        ) : (
          <>
            <Sparkles />
            {mode === "file" && picked.length > 1
              ? `Generate from ${picked.length} files`
              : "Generate Flashcards with AI"}
          </>
        )}
      </button>

      {loading && !statusText && (
        <p style={{ textAlign: "center", fontSize: 13, color: "var(--text-muted)", marginTop: 12 }}>
          <Bot size={15} className="icon-inline" aria-hidden /> AI is reading your material... This may take a moment!
        </p>
      )}
      {loading && statusText && statusText.includes("part") && (
        <div style={{
          textAlign: "center",
          marginTop: 12,
          padding: "10px 16px",
          background: "linear-gradient(135deg, #eff6ff, #eef2ff)",
          border: "1.5px solid #bfdbfe",
          borderRadius: 14,
          fontSize: 13,
          color: "#1d4ed8",
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}>
          <Layers size={15} aria-hidden />
          <span>{statusText}</span>
        </div>
      )}
    </div>
  );
}

// ─── Mode Select ─────────────────────────────────────────────────────────────
function ModeSelect({
  cardCount,
  cards,
  onSelect,
}: {
  cardCount: number;
  cards: Flashcard[];
  onSelect: (mode: "study" | "exam" | "identify" | "enumerate") => void;
}) {
  const enumerateCount = cards.filter(isEnumCard).length;
  const identifyCount = cardCount - enumerateCount;
  return (
    <div className="animate-fade-in" style={{ padding: "4px 0" }}>
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div className="animate-float" style={{ marginBottom: 6, color: "var(--accent-dark)" }}>
          <Target size={44} strokeWidth={1.5} aria-hidden />
        </div>
        <h2 style={{ margin: "0 0 6px", fontSize: 21, fontWeight: 800 }}>How do you want to study?</h2>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>
          {cardCount} card{cardCount === 1 ? "" : "s"} ready · pick a mode to begin
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Study mode */}
        <button className="mode-card" onClick={() => onSelect("study")}>
          <div className="mode-icon" style={{ background: "linear-gradient(135deg, #3b82f6, #6366f1)" }}>
            <BookOpen />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800 }}>Study Mode</p>
            <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Traditional flashcards — see the question, then flip the card to reveal the answer.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {["Flip to reveal", "Self-check", "Track progress"].map((t) => (
                <span key={t} className="badge" style={{ background: "#eff6ff", color: "#1d4ed8" }}>{t}</span>
              ))}
            </div>
          </div>
        </button>

        {/* Exam mode */}
        <button className="mode-card" onClick={() => onSelect("exam")}>
          <div className="mode-icon" style={{ background: "linear-gradient(135deg, #1d4ed8, #7c3aed)" }}>
            <ClipboardCheck />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800 }}>Exam Mode</p>
            <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Multiple choice — 4 options per question, instant Correct / Wrong feedback and a score.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {["4 choices", "Instant feedback", "Scored"].map((t) => (
                <span key={t} className="badge" style={{ background: "#eef2ff", color: "#6d28d9" }}>{t}</span>
              ))}
            </div>
          </div>
        </button>

        {/* Identification mode */}
        <button className="mode-card" onClick={() => onSelect("identify")} disabled={identifyCount === 0}>
          <div className="mode-icon" style={{ background: "linear-gradient(135deg, #10b981, #0d9488)" }}>
            <Type />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800 }}>Identification</p>
            <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {identifyCount === 0
                ? "Every card in this set is a list \u2014 nothing to identify here."
                : `Type the answer from memory \u2014 ${identifyCount} question${identifyCount === 1 ? "" : "s"}, spelling-friendly checking.`}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {["Type to answer", "Typo-tolerant", "Scored"].map((t) => (
                <span key={t} className="badge" style={{ background: "#ecfdf5", color: "#047857" }}>{t}</span>
              ))}
            </div>
          </div>
        </button>

        {/* Enumeration mode */}
        <button className="mode-card" onClick={() => onSelect("enumerate")} disabled={enumerateCount === 0}>
          <div className="mode-icon" style={{ background: "linear-gradient(135deg, #f59e0b, #ea580c)" }}>
            <ListOrdered />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800 }}>Enumeration</p>
            <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {enumerateCount === 0
                ? "No list-style answers in this set \u2014 generate from material with lists to unlock this."
                : `List every item from memory \u2014 ${enumerateCount} question${enumerateCount === 1 ? "" : "s"}, any order accepted.`}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {["List all items", "Any order", "Scored"].map((t) => (
                <span key={t} className="badge" style={{ background: "#fffbeb", color: "#b45309" }}>{t}</span>
              ))}
            </div>
          </div>
        </button>
      </div>

      <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-muted)", marginTop: 18 }}>
        Tip: warm up in <strong>Study Mode</strong>, then test yourself in <strong>Exam</strong>, <strong>Identification</strong> or <strong>Enumeration</strong>
      </p>
    </div>
  );
}

// ─── Exam Mode: multiple choice question card ────────────────────────────────
function ExamCard({
  question,
  index,
  total,
  chosen,
  earnedPoints,
  onChoose,
  onNext,
  isLast,
}: {
  question: ExamQuestion;
  index: number;
  total: number;
  chosen: number | null;
  earnedPoints: number;
  onChoose: (optionIndex: number) => void;
  onNext: () => void;
  isLast: boolean;
}) {
  const { card, options, correctIndex } = question;
  const answered = chosen !== null;
  const isCorrect = chosen === correctIndex;

  const difficultyColor = {
    easy: "#10b981",
    medium: "#f59e0b",
    hard: "#f43f5e",
  }[card.difficulty] || "#6366f1";

  // Keyboard: 1-4 to answer, Enter / Space to continue
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!answered) {
        const n = Number(e.key);
        if (n >= 1 && n <= options.length) onChoose(n - 1);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answered, options.length, onChoose, onNext]);

  return (
    <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Progress */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, fontSize: 13, color: "var(--text-muted)", fontWeight: 600 }}>
          <span>Question {index + 1} of {total}</span>
          <span className="badge" style={{ background: `${difficultyColor}20`, color: difficultyColor }}>
            {card.difficulty}
          </span>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${((index + 1) / total) * 100}%` }} />
        </div>
      </div>

      {/* Question */}
      <div
        className="glass-card"
        style={{
          padding: 22,
          borderLeft: "5px solid var(--accent-dark)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          minHeight: 130,
        }}
      >
        <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: "var(--accent-dark)", textTransform: "uppercase" }}>
          Choose the best answer
        </p>
        <p style={{ margin: 0, fontSize: 18, fontWeight: 700, lineHeight: 1.45 }}>
          {card.question}
        </p>
      </div>

      {/* Choices */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {options.map((opt, i) => {
          let cls = "choice";
          let mark: ReactNode = null;
          if (answered) {
            if (i === correctIndex) {
              cls += " reveal-correct";
              mark = (
                <CircleCheckBig
                  size={18}
                  aria-hidden
                  style={{ marginLeft: "auto", flexShrink: 0, color: "#10b981" }}
                />
              );
            } else if (i === chosen) {
              cls += " selected-wrong";
              mark = (
                <CircleX
                  size={18}
                  aria-hidden
                  style={{ marginLeft: "auto", flexShrink: 0, color: "#f43f5e" }}
                />
              );
            } else {
              cls += " dimmed";
            }
          }
          return (
            <button
              key={`${index}-${i}`}
              className={cls}
              disabled={answered}
              onClick={() => onChoose(i)}
            >
              <span className="choice-letter">{String.fromCharCode(65 + i)}</span>
              <span className="choice-text">{opt}</span>
              {mark}
            </button>
          );
        })}
      </div>

      {/* Feedback */}
      {answered && (
        <>
          <div className={`feedback ${isCorrect ? "feedback-correct" : "feedback-wrong"}`}>
            {isCorrect ? (
              <PartyPopper size={20} aria-hidden style={{ flexShrink: 0 }} />
            ) : (
              <FaceSlightlyFrowning size={20} aria-hidden style={{ flexShrink: 0 }} />
            )}
            <span>
              <strong>{isCorrect ? "Correct!" : "Wrong!"}</strong>
              {isCorrect
                ? earnedPoints > 0
                  ? ` +${earnedPoints} point${earnedPoints === 1 ? "" : "s"}`
                  : ""
                : ` The correct answer is: ${card.answer}`}
            </span>
          </div>

          <button className="btn btn-primary btn-lg" style={{ width: "100%" }} onClick={onNext}>
            {isLast ? "See Results" : "Next Question"}
            {isLast ? <Flag /> : <ArrowRight />}
          </button>
        </>
      )}

      {!answered && (
        <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-muted)", margin: "2px 0 0" }}>
          Tip: press <strong>1–4</strong> to answer quickly
        </p>
      )}
    </div>
  );
}

// ─── Identification Mode: type the answer ────────────────────────────────────
function IdentifyCard({
  card,
  index,
  total,
  submitted,
  earnedPoints,
  onSubmit,
  onNext,
  isLast,
}: {
  card: Flashcard;
  index: number;
  total: number;
  submitted: IdentifySubmission | null;
  earnedPoints: number;
  onSubmit: (typed: string, isCorrect: boolean) => void;
  onNext: () => void;
  isLast: boolean;
}) {
  const [value, setValue] = useState(submitted?.typed ?? "");
  const [showHint, setShowHint] = useState(false);
  const answered = submitted !== null;

  const difficultyColor = {
    easy: "#10b981",
    medium: "#f59e0b",
    hard: "#f43f5e",
  }[card.difficulty] || "#6366f1";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // After answering, Enter advances instead of re-submitting.
    if (answered) {
      onNext();
      return;
    }
    const typed = value.trim();
    if (!typed) return;
    onSubmit(typed, typedMatchesAny(typed, card.answer));
  };

  return (
    <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Progress */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, fontSize: 13, color: "var(--text-muted)", fontWeight: 600 }}>
          <span>Question {index + 1} of {total}</span>
          <span className="badge" style={{ background: `${difficultyColor}20`, color: difficultyColor }}>
            {card.difficulty}
          </span>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${((index + 1) / total) * 100}%` }} />
        </div>
      </div>

      {/* Question */}
      <div
        className="glass-card"
        style={{
          padding: 22,
          borderLeft: "5px solid #10b981",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          minHeight: 130,
        }}
      >
        <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: "#047857", textTransform: "uppercase" }}>
          Type the answer
        </p>
        <p style={{ margin: 0, fontSize: 18, fontWeight: 700, lineHeight: 1.45 }}>
          {card.question}
        </p>
      </div>

      {/* Answer input */}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          className={`type-input${answered ? (submitted.isCorrect ? " correct" : " wrong") : ""}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={answered}
          placeholder="Type your answer here..."
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          aria-label="Your answer"
        />
        {!answered && (
          <button type="submit" className="btn btn-primary btn-lg" style={{ width: "100%" }} disabled={!value.trim()}>
            <Check />
            Check Answer
          </button>
        )}
      </form>

      {/* Hint */}
      {card.hint && !answered && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setShowHint(!showHint)}
          style={{ alignSelf: "center", color: "#f59e0b", gap: 6 }}
        >
          <Lightbulb />
          {showHint ? "Hide hint" : "Show hint"}
        </button>
      )}
      {showHint && card.hint && !answered && (
        <div style={{
          background: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: 12,
          padding: "10px 16px",
          fontSize: 14,
          color: "#92400e",
          textAlign: "center",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}>
          <Lightbulb size={16} aria-hidden />
          <span>{card.hint}</span>
        </div>
      )}

      {/* Feedback */}
      {answered && submitted && (
        <>
          <div className={`feedback ${submitted.isCorrect ? "feedback-correct" : "feedback-wrong"}`}>
            {submitted.isCorrect ? (
              <PartyPopper size={20} aria-hidden style={{ flexShrink: 0 }} />
            ) : (
              <FaceSlightlyFrowning size={20} aria-hidden style={{ flexShrink: 0 }} />
            )}
            <span>
              <strong>{submitted.isCorrect ? "Correct!" : "Wrong!"}</strong>
              {submitted.isCorrect
                ? earnedPoints > 0
                  ? ` +${earnedPoints} point${earnedPoints === 1 ? "" : "s"}`
                  : ""
                : ` The correct answer is: ${card.answer}`}
            </span>
          </div>

          <button type="button" className="btn btn-primary btn-lg" style={{ width: "100%" }} onClick={onNext}>
            {isLast ? "See Results" : "Next Question"}
            {isLast ? <Flag /> : <ArrowRight />}
          </button>
        </>
      )}

      {!answered && (
        <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-muted)", margin: "2px 0 0" }}>
          Tip: press <strong>Enter</strong> to check — small typos are forgiven
        </p>
      )}
    </div>
  );
}

// ─── Enumeration Mode: list every item ───────────────────────────────────────
function EnumerateCard({
  card,
  items,
  index,
  total,
  submitted,
  earnedPoints,
  onSubmit,
  onNext,
  isLast,
}: {
  card: Flashcard;
  items: string[];
  index: number;
  total: number;
  submitted: EnumSubmission | null;
  earnedPoints: number;
  onSubmit: (userItems: string[], hits: boolean[], userHits: boolean[], allCorrect: boolean) => void;
  onNext: () => void;
  isLast: boolean;
}) {
  const [values, setValues] = useState<string[]>(
    submitted?.userItems ?? new Array<string>(items.length).fill("")
  );
  const [showHint, setShowHint] = useState(false);
  const answered = submitted !== null;
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const difficultyColor = {
    easy: "#10b981",
    medium: "#f59e0b",
    hard: "#f43f5e",
  }[card.difficulty] || "#6366f1";

  const setValue = (i: number, v: string) =>
    setValues((prev) => prev.map((p, j) => (j === i ? v : p)));

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    // After answering, Enter advances instead of re-submitting.
    if (answered) {
      onNext();
      return;
    }
    const cleaned = values.map((v) => v.trim());
    if (cleaned.every((v) => !v)) return;
    const { hits, userHits } = matchEnumItems(cleaned, items);
    onSubmit(cleaned, hits, userHits, hits.every(Boolean));
  };

  const gotCount = submitted?.hits.filter(Boolean).length ?? 0;
  const missing = items.filter((_, j) => submitted && !submitted.hits[j]);

  return (
    <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Progress */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, fontSize: 13, color: "var(--text-muted)", fontWeight: 600 }}>
          <span>Question {index + 1} of {total}</span>
          <span className="badge" style={{ background: `${difficultyColor}20`, color: difficultyColor }}>
            {card.difficulty}
          </span>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${((index + 1) / total) * 100}%` }} />
        </div>
      </div>

      {/* Question */}
      <div
        className="glass-card"
        style={{
          padding: 22,
          borderLeft: "5px solid #f59e0b",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          minHeight: 130,
        }}
      >
        <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: "#b45309", textTransform: "uppercase" }}>
          List all {items.length} items — any order
        </p>
        <p style={{ margin: 0, fontSize: 18, fontWeight: 700, lineHeight: 1.45 }}>
          {card.question}
        </p>
      </div>

      {/* Item inputs */}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((_, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="choice-letter" style={{ background: "#fffbeb", color: "#b45309" }}>{i + 1}</span>
            <input
              ref={(el) => {
                inputRefs.current[i] = el;
              }}
              className={`type-input${answered ? (submitted.userHits[i] ? " correct" : " wrong") : ""}`}
              value={values[i] ?? ""}
              onChange={(e) => setValue(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (i < items.length - 1) inputRefs.current[i + 1]?.focus();
                  else handleSubmit();
                }
              }}
              disabled={answered}
              placeholder={`Item ${i + 1}`}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus={i === 0}
              aria-label={`Item ${i + 1}`}
            />
          </div>
        ))}
        {!answered && (
          <button type="submit" className="btn btn-primary btn-lg" style={{ width: "100%" }} disabled={values.every((v) => !v.trim())}>
            <Check />
            Check Answers
          </button>
        )}
      </form>

      {/* Hint */}
      {card.hint && !answered && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setShowHint(!showHint)}
          style={{ alignSelf: "center", color: "#f59e0b", gap: 6 }}
        >
          <Lightbulb />
          {showHint ? "Hide hint" : "Show hint"}
        </button>
      )}
      {showHint && card.hint && !answered && (
        <div style={{
          background: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: 12,
          padding: "10px 16px",
          fontSize: 14,
          color: "#92400e",
          textAlign: "center",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}>
          <Lightbulb size={16} aria-hidden />
          <span>{card.hint}</span>
        </div>
      )}

      {/* Feedback */}
      {answered && submitted && (
        <>
          <div className={`feedback ${submitted.allCorrect ? "feedback-correct" : "feedback-wrong"}`}>
            {submitted.allCorrect ? (
              <PartyPopper size={20} aria-hidden style={{ flexShrink: 0 }} />
            ) : (
              <FaceSlightlyFrowning size={20} aria-hidden style={{ flexShrink: 0 }} />
            )}
            <span>
              <strong>{submitted.allCorrect ? "Perfect!" : `You got ${gotCount} of ${items.length}`}</strong>
              {submitted.allCorrect
                ? earnedPoints > 0
                  ? ` +${earnedPoints} point${earnedPoints === 1 ? "" : "s"}`
                  : ""
                : missing.length > 0
                  ? ` — missing: ${missing.join("; ")}`
                  : ""}
            </span>
          </div>

          <button type="button" className="btn btn-primary btn-lg" style={{ width: "100%" }} onClick={onNext}>
            {isLast ? "See Results" : "Next Question"}
            {isLast ? <Flag /> : <ArrowRight />}
          </button>
        </>
      )}

      {!answered && (
        <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-muted)", margin: "2px 0 0" }}>
          Tip: <strong>Enter</strong> jumps to the next item — order doesn&apos;t matter
        </p>
      )}
    </div>
  );
}

// ─── Empty scored run (the mode has no suitable cards) ───────────────────────
function EmptyRun({
  icon: Icon,
  color,
  title,
  message,
  onBackToModes,
}: {
  icon: LucideIcon;
  color: string;
  title: string;
  message: string;
  onBackToModes: () => void;
}) {
  return (
    <div className="animate-fade-in" style={{ textAlign: "center", padding: "40px 20px" }}>
      <div style={{ marginBottom: 12, color }}>
        <Icon size={56} strokeWidth={1.5} aria-hidden />
      </div>
      <h3 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 8px" }}>{title}</h3>
      <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 20px", lineHeight: 1.6 }}>{message}</p>
      <button className="btn btn-secondary" onClick={onBackToModes}>
        <ArrowLeft />
        Back to Modes
      </button>
    </div>
  );
}

// ─── Scored-mode results screen (exam / identification / enumeration) ────────
// ─── Enumeration missed-review detail ────────────────────────────────────────
function EnumMissedDetail({
  expectedItems,
  userItems,
}: {
  expectedItems: string[];
  userItems: string[];
}) {
  const { hits } = matchEnumItems(userItems, expectedItems);
  const got = expectedItems.filter((_, j) => hits[j]);
  const missed = expectedItems.filter((_, j) => !hits[j]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {got.length > 0 && (
        <p style={{ margin: 0, fontSize: 13, display: "flex", gap: 6 }}>
          <CircleCheckBig size={15} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: "#10b981" }} />
          <span style={{ color: "#065f46" }}>You got: {got.join("; ")}</span>
        </p>
      )}
      <p style={{ margin: 0, fontSize: 13, display: "flex", gap: 6 }}>
        <CircleX size={15} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: "#f43f5e" }} />
        <span style={{ color: "#9f1239" }}>Missing: {missed.join("; ")}</span>
      </p>
    </div>
  );
}

function ExamSummary({
  answers,
  score,
  maxScore,
  bestStreak,
  elapsed,
  onRetry,
  onStudyMissed,
  onBackToModes,
  completeTitle = "Exam Complete!",
  retryLabel = "Retake Exam (New Order)",
}: {
  answers: ExamAnswer[];
  score: number;
  maxScore: number;
  bestStreak: number;
  elapsed: number;
  onRetry: () => void;
  onStudyMissed: () => void;
  onBackToModes: () => void;
  completeTitle?: string;
  retryLabel?: string;
}) {
  const total = answers.length;
  const correct = answers.filter((a) => a.isCorrect).length;
  const wrong = total - correct;
  const pct = total ? Math.round((correct / total) * 100) : 0;
  const { grade, message, icon: GradeIcon, color } = gradeFor(pct);
  const missed = answers.filter((a) => !a.isCorrect);

  useEffect(() => {
    if (pct >= 80) launchConfetti();
  }, [pct]);

  return (
    <div className="animate-fade-in" style={{ textAlign: "center", padding: "10px 0" }}>
      <div style={{ display: "flex", justifyContent: "center", color }}>
        <GradeIcon size={72} strokeWidth={1.5} aria-hidden />
      </div>
      <h2 className="gradient-text" style={{ fontSize: 27, fontWeight: 800, margin: "6px 0 4px" }}>
        Exam Complete!
      </h2>
      <p style={{ color: "var(--text-muted)", margin: "0 0 22px", fontSize: 15 }}>{message}</p>

      {/* Score ring */}
      <div
        className="score-ring"
        style={{ background: `linear-gradient(135deg, ${color}, #1d4ed8)` }}
      >
        <span style={{ fontSize: 40, fontWeight: 900, lineHeight: 1 }}>{pct}%</span>
        <span style={{ fontSize: 12, opacity: 0.9, fontWeight: 600 }}>accuracy</span>
      </div>

      {/* Grade + score */}
      <div style={{ display: "flex", justifyContent: "center", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <span className="badge" style={{ background: `${color}1a`, color, fontSize: 14, padding: "6px 14px" }}>
          Grade: {grade}
        </span>
        <span className="badge" style={{ background: "#eef2ff", color: "#4338ca", fontSize: 14, padding: "6px 14px" }}>
          <Star size={14} className="icon-inline" aria-hidden /> {score} / {maxScore} pts
        </span>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
        {[
          { label: "Correct", value: correct, color: "#10b981", bg: "#ecfdf5" },
          { label: "Wrong", value: wrong, color: "#f43f5e", bg: "#fff1f2" },
          { label: "Questions", value: total, color: "#3b82f6", bg: "#eff6ff" },
        ].map((s) => (
          <div key={s.label} style={{ background: s.bg, borderRadius: 16, padding: "14px 8px" }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 22 }}>
        <div style={{ background: "white", borderRadius: 16, padding: "12px 8px", boxShadow: "0 4px 16px rgba(29,78,216,0.08)" }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#ea580c", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Flame size={18} aria-hidden />
            {bestStreak}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>Best streak</div>
        </div>
        <div style={{ background: "white", borderRadius: 16, padding: "12px 8px", boxShadow: "0 4px 16px rgba(29,78,216,0.08)" }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#1d4ed8", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Timer size={18} aria-hidden />
            {formatTime(elapsed)}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>Time taken</div>
        </div>
      </div>

      {/* Missed questions */}
      {missed.length > 0 && (
        <div style={{ textAlign: "left", marginBottom: 22 }}>
          <h3 style={{ fontSize: 15, fontWeight: 800, margin: "0 0 10px" }}>
            <BookBookmark size={16} className="icon-inline" aria-hidden /> Review missed questions ({missed.length})
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {missed.map((a, i) => (
              <div
                key={i}
                style={{
                  background: "white",
                  border: "1.5px solid #fecdd3",
                  borderRadius: 16,
                  padding: "12px 14px",
                }}
              >
                <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 700, lineHeight: 1.45 }}>
                  {a.card.question}
                </p>
                {a.expectedItems && a.expectedItems.length > 0 ? (
                  <EnumMissedDetail expectedItems={a.expectedItems} userItems={a.userItems ?? []} />
                ) : (
                  <>
                    <p style={{ margin: "0 0 4px", fontSize: 13, display: "flex", gap: 6 }}>
                      <CircleX size={15} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: "#f43f5e" }} />
                      <span style={{ color: "#9f1239" }}>Your answer: {a.chosenOption}</span>
                    </p>
                    <p style={{ margin: 0, fontSize: 13, display: "flex", gap: 6 }}>
                      <CircleCheckBig size={15} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: "#10b981" }} />
                      <span style={{ color: "#065f46", fontWeight: 600 }}>{a.card.answer}</span>
                    </p>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {missed.length > 0 && (
          <button className="btn btn-primary btn-lg" style={{ width: "100%" }} onClick={onStudyMissed}>
            <BookOpen />
            Study {missed.length} Missed Card{missed.length === 1 ? "" : "s"}
          </button>
        )}
        <button className="btn btn-secondary" style={{ width: "100%" }} onClick={onRetry}>
          <Shuffle />
          Retake Exam (New Order)
        </button>
        <button className="btn btn-ghost" style={{ width: "100%" }} onClick={onBackToModes}>
          <ArrowLeft />
          Back to Modes
        </button>
      </div>
    </div>
  );
}

// ─── Quiz Page ────────────────────────────────────────────────────────────────
function QuizPage({
  sessionId,
  cards,
  title,
  summary,
  onSave,
  onBack,
}: {
  sessionId?: number;
  cards: Flashcard[];
  title: string;
  summary: string;
  onSave?: (title: string) => Promise<void>;
  onBack: () => void;
}) {
  const [mode, setMode] = useState<QuizMode>("select");

  // Shared
  const [progress, setProgress] = useState<CardProgress[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(!!sessionId);

  // Study mode
  const [activeCards, setActiveCards] = useState(cards);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [done, setDone] = useState(false);
  const [shuffleStudy, setShuffleStudy] = useState(false);
  const [unknownOnly, setUnknownOnly] = useState(false);

  // Exam mode
  const [examQuestions, setExamQuestions] = useState<ExamQuestion[]>([]);
  const [examIndex, setExamIndex] = useState(0);
  const [answers, setAnswers] = useState<ExamAnswer[]>([]);
  const [score, setScore] = useState(0);
  const [maxScore, setMaxScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [examDone, setExamDone] = useState(false);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);

  // Load progress from server if we have a sessionId
  useEffect(() => {
    if (sessionId) {
      fetch(`/api/sessions/${sessionId}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.progress) setProgress(data.progress);
        })
        .catch(() => {});
    }
  }, [sessionId]);

  const currentCard = activeCards[currentIndex];
  const currentProgress = currentCard?.id
    ? progress.find((p) => p.cardId === currentCard.id)
    : undefined;

  const updateProgress = async (
    cardId: number | undefined,
    isKnown: boolean,
    outcomeMode?: StudyOutcome["mode"]
  ) => {
    if (sessionId && cardId) {
      fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId, isKnown }),
      }).catch(() => {});
    }
    if (cardId) {
      setProgress((prev) => {
        const existing = prev.find((p) => p.cardId === cardId);
        if (existing) {
          return prev.map((p) => p.cardId === cardId ? { ...p, isKnown, attempts: p.attempts + 1 } : p);
        }
        return [...prev, { cardId, isKnown, attempts: 1 }];
      });
    }
    // P2: also record the per-card right/wrong outcome for the Stats page
    // (and later P4 spaced repetition). Unsaved decks have no server-side
    // card ids yet, so they're skipped — outcomes start flowing once saved.
    recordOutcome(
      cardId,
      isKnown,
      outcomeMode ?? (mode === "exam" || mode === "identify" || mode === "enumerate" ? mode : "study")
    );
  };

  // ── Study outcome sync (database-backed, localStorage as draft cache) ────
  const outcomeQueue = useRef<StudyOutcome[]>([]);
  const syncingOutcomes = useRef(false);

  const flushOutcomes = useCallback(async (useBeacon = false) => {
    if (outcomeQueue.current.length === 0 || syncingOutcomes.current) return;
    const batch = outcomeQueue.current;
    outcomeQueue.current = [];
    if (useBeacon) {
      writeOutcomeCache(await syncOutcomes(batch, true));
      return;
    }
    syncingOutcomes.current = true;
    try {
      const leftover = await syncOutcomes(batch);
      if (leftover.length > 0) {
        // Failed (offline?) — keep them queued and cached for the next sync.
        outcomeQueue.current = [...leftover, ...outcomeQueue.current].slice(-OUTCOME_CACHE_LIMIT);
        writeOutcomeCache(outcomeQueue.current);
      }
    } finally {
      syncingOutcomes.current = false;
    }
  }, []);

  const recordOutcome = useCallback(
    (cardId: number | undefined, correct: boolean, outcomeMode: StudyOutcome["mode"]) => {
      if (!sessionId || !cardId) return;
      const outcome: StudyOutcome = {
        sessionId,
        cardId,
        correct,
        mode: outcomeMode,
        answeredAt: new Date().toISOString(),
      };
      outcomeQueue.current = [...outcomeQueue.current, outcome].slice(-OUTCOME_CACHE_LIMIT);
      writeOutcomeCache(outcomeQueue.current);
      void flushOutcomes();
    },
    [sessionId, flushOutcomes]
  );

  // On mount: sync anything left over from a previous visit (e.g. answers
  // recorded while offline). On unmount: best-effort beacon flush so a batch
  // is not lost when the user navigates away mid-session.
  useEffect(() => {
    const cached = readOutcomeCache();
    if (cached.length > 0) {
      outcomeQueue.current = [...cached, ...outcomeQueue.current].slice(-OUTCOME_CACHE_LIMIT);
      writeOutcomeCache(outcomeQueue.current);
      void flushOutcomes();
    }
    return () => {
      void flushOutcomes(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Study mode ────────────────────────────────────────────────────────────
  const handleKnow = async () => {
    await updateProgress(currentCard?.id, true, "study");
    if (currentIndex >= activeCards.length - 1) {
      setDone(true);
    } else {
      setCurrentIndex((i) => i + 1);
    }
  };

  const handleDontKnow = async () => {
    await updateProgress(currentCard?.id, false, "study");
    if (currentIndex >= activeCards.length - 1) {
      setDone(true);
    } else {
      setCurrentIndex((i) => i + 1);
    }
  };

  const handleRestart = () => {
    setActiveCards(cards);
    setCurrentIndex(0);
    setDone(false);
  };

  const handleReviewWeak = () => {
    const knownIds = new Set(progress.filter((p) => p.isKnown).map((p) => p.cardId));
    const weak = cards.filter((c) => !c.id || !knownIds.has(c.id));
    if (weak.length === 0) return handleRestart();
    setActiveCards(weak);
    setCurrentIndex(0);
    setDone(false);
  };

  /** Rebuild the study deck, honoring the shuffle + "unknown only" toggles. */
  const buildStudyDeck = (useShuffle: boolean, useUnknownOnly: boolean) => {
    let base = cards;
    if (useUnknownOnly) {
      const knownIds = new Set(progress.filter((p) => p.isKnown).map((p) => p.cardId));
      base = base.filter((c) => !(c.id && knownIds.has(c.id)));
    }
    return useShuffle ? shuffle(base) : base;
  };

  const toggleShuffle = () => {
    const next = !shuffleStudy;
    setShuffleStudy(next);
    setActiveCards(buildStudyDeck(next, unknownOnly));
    setCurrentIndex(0);
    setDone(false);
  };

  const toggleUnknownOnly = () => {
    const next = !unknownOnly;
    setUnknownOnly(next);
    setActiveCards(buildStudyDeck(shuffleStudy, next));
    setCurrentIndex(0);
    setDone(false);
  };

  const showAllCards = () => {
    setUnknownOnly(false);
    setActiveCards(buildStudyDeck(shuffleStudy, false));
    setCurrentIndex(0);
    setDone(false);
  };

  // ── Scored modes (exam / identification / enumeration) ──────────────────────
  /** Start a scored run — each mode only gets the cards that suit it. */
  const startScoredRun = (kind: ScoredMode, questionCards?: Flashcard[]) => {
    const pool = questionCards ?? cards;
    const suited =
      kind === "enumerate"
        ? pool.filter(isEnumCard)
        : kind === "identify"
          ? pool.filter((c) => !isEnumCard(c))
          : pool;
    const qs = buildExamQuestions(suited);
    setExamQuestions(qs);
    setExamIndex(0);
    setAnswers([]);
    setScore(0);
    setMaxScore(
      qs.reduce((sum, q, i) => sum + pointsFor(q.card) + (i === 0 ? 0 : Math.min(i * 2, 10)), 0)
    );
    setStreak(0);
    setBestStreak(0);
    setExamDone(false);
    setStartedAt(Date.now());
    setElapsed(0);
    setMode(kind);
  };

  /** Record one graded answer — shared by exam, identification and enumeration. */
  const recordScoredAnswer = async (
    card: Flashcard,
    isCorrect: boolean,
    chosenOption: string,
    outcomeMode: StudyOutcome["mode"],
    extras?: { chosenIndex?: number; correctIndex?: number; expectedItems?: string[]; userItems?: string[] }
  ) => {
    const newStreak = isCorrect ? streak + 1 : 0;
    const streakBonus = isCorrect ? Math.min(streak * 2, 10) : 0;
    const points = isCorrect ? pointsFor(card) + streakBonus : 0;

    setAnswers((prev) => [
      ...prev,
      {
        card,
        chosenIndex: extras?.chosenIndex ?? -1,
        chosenOption,
        correctIndex: extras?.correctIndex ?? -1,
        isCorrect,
        points,
        ...(extras?.expectedItems ? { expectedItems: extras.expectedItems } : {}),
        ...(extras?.userItems ? { userItems: extras.userItems } : {}),
      },
    ]);
    setScore((s) => s + points);
    setStreak(newStreak);
    setBestStreak((b) => Math.max(b, newStreak));
    await updateProgress(card.id, isCorrect, outcomeMode);
  };

  const handleChoose = async (optionIndex: number) => {
    const q = examQuestions[examIndex];
    if (!q || answers.length > examIndex) return; // ignore clicks after answering

    const isCorrect = optionIndex === q.correctIndex;
    await recordScoredAnswer(q.card, isCorrect, q.options[optionIndex], "exam", {
      chosenIndex: optionIndex,
      correctIndex: q.correctIndex,
    });
  };

  /** Typed answer from Identification or Enumeration mode. */
  const handleTypedSubmit = async (
    summary: string,
    isCorrect: boolean,
    outcomeMode: "identify" | "enumerate",
    extras?: { expectedItems?: string[]; userItems?: string[] }
  ) => {
    const q = examQuestions[examIndex];
    if (!q || answers.length > examIndex) return; // ignore submits after answering
    await recordScoredAnswer(q.card, isCorrect, summary, outcomeMode, extras);
  };

  const handleExamNext = () => {
    if (examIndex >= examQuestions.length - 1) {
      setElapsed(Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
      setExamDone(true);
    } else {
      setExamIndex((i) => i + 1);
    }
  };

  const handleStudyMissed = () => {
    const missed = answers.filter((a) => !a.isCorrect).map((a) => a.card);
    if (missed.length === 0) return;
    setActiveCards(missed);
    setCurrentIndex(0);
    setDone(false);
    setMode("study");
  };

  // ── Mode switching ────────────────────────────────────────────────────────
  const switchMode = (m: "study" | ScoredMode) => {
    if (m === "study") {
      // Respect the shuffle / unknown-only toggles if they're on.
      setActiveCards(buildStudyDeck(shuffleStudy, unknownOnly));
      setCurrentIndex(0);
      setDone(false);
      setMode("study");
    } else {
      startScoredRun(m);
    }
  };

  const handleSave = async () => {
    if (!onSave || saved) return;
    setSaving(true);
    try {
      await onSave(title);
      setSaved(true);
      showToast("Study set saved!", CircleCheckBig);
    } catch {
      showToast("Failed to save", CircleX);
    } finally {
      setSaving(false);
    }
  };

  const examQuestion = examQuestions[examIndex];
  const lastAnswer = answers[answers.length - 1];
  const earnedPoints =
    lastAnswer && examQuestion && lastAnswer.card === examQuestion.card ? lastAnswer.points : 0;

  // Submitted state for the typed modes, derived from the recorded answer so
  // the cards stay consistent with the run (same pattern as ExamCard's `chosen`).
  const currentAnswer = answers.length > examIndex ? answers[examIndex] : null;
  const identifySubmitted: IdentifySubmission | null = currentAnswer
    ? { typed: currentAnswer.chosenOption, isCorrect: currentAnswer.isCorrect }
    : null;
  const enumExpected = examQuestion ? getEnumItems(examQuestion.card.answer) : [];
  const enumMatch =
    currentAnswer && examQuestion
      ? matchEnumItems(
          currentAnswer.userItems ?? [],
          currentAnswer.expectedItems ?? enumExpected
        )
      : null;
  const enumSubmitted: EnumSubmission | null =
    currentAnswer && enumMatch
      ? {
          userItems: currentAnswer.userItems ?? [],
          hits: enumMatch.hits,
          userHits: enumMatch.userHits,
          allCorrect: currentAnswer.isCorrect,
        }
      : null;

  return (
    <div style={{ padding: "16px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ padding: "6px 10px", borderRadius: 12 }}>
          <ArrowLeft />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {title}
          </h2>
          {summary && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {summary}
            </p>
          )}
        </div>
        {onSave && !saved && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleSave}
            disabled={saving}
            style={{ flexShrink: 0 }}
          >
            {saving ? "..." : (
              <>
                <Save />
                Save
              </>
            )}
          </button>
        )}
        {saved && (
          <span style={{ fontSize: 12, color: "#10b981", fontWeight: 700, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}>
            <CircleCheckBig size={14} aria-hidden />
            Saved
          </span>
        )}
      </div>

      {/* Mode switch */}
      {mode !== "select" && (
        <div style={{ marginBottom: 14 }}>
          <div className="mode-switch">
            <button
              className={mode === "study" ? "active" : ""}
              onClick={() => switchMode("study")}
            >
              <BookOpen />
              Study
            </button>
            <button
              className={mode === "exam" ? "active" : ""}
              onClick={() => switchMode("exam")}
            >
              <ClipboardCheck />
              Exam
            </button>
            <button
              className={mode === "identify" ? "active" : ""}
              onClick={() => switchMode("identify")}
            >
              <Type />
              Identify
            </button>
            <button
              className={mode === "enumerate" ? "active" : ""}
              onClick={() => switchMode("enumerate")}
            >
              <ListOrdered />
              Enumerate
            </button>
          </div>

          {/* Study-mode toggles */}
          {mode === "study" && !done && (
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button
                className={`btn btn-sm ${shuffleStudy ? "btn-primary" : "btn-secondary"}`}
                onClick={toggleShuffle}
                style={{ flex: 1, gap: 6 }}
              >
                <Shuffle />
                Shuffle {shuffleStudy ? "On" : "Off"}
              </button>
              <button
                className={`btn btn-sm ${unknownOnly ? "btn-primary" : "btn-secondary"}`}
                onClick={toggleUnknownOnly}
                style={{ flex: 1, gap: 6 }}
              >
                <BookOpenCheck />
                Unknown only {unknownOnly ? "On" : "Off"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Live exam scoreboard */}
      {mode === "exam" && !examDone && examQuestion && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <span className="score-pill">
            <Star />
            {score} pts
          </span>
          <span className={`score-pill ${streak >= 3 ? "streak-hot" : "streak"}`}>
            <Flame />
            {streak} streak
          </span>
          <span className="score-pill" style={{ marginLeft: "auto" }}>
            <Target />
            {answers.length}/{examQuestions.length}
          </span>
        </div>
      )}

      {/* Content */}
      {mode === "select" && (
        <ModeSelect cardCount={cards.length} cards={cards} onSelect={switchMode} />
      )}

      {mode === "study" && !done && currentCard && (
        <StudyCard
          key={currentIndex}
          card={currentCard}
          index={currentIndex}
          total={activeCards.length}
          onKnow={handleKnow}
          onDontKnow={handleDontKnow}
          onNext={() => setCurrentIndex((i) => Math.min(i + 1, activeCards.length - 1))}
          onPrev={() => setCurrentIndex((i) => Math.max(i - 1, 0))}
          progress={currentProgress}
        />
      )}

      {mode === "study" && !done && !currentCard && (
        <div style={{ textAlign: "center", padding: "40px 20px" }}>
          <div style={{ marginBottom: 12, color: "var(--accent-dark)" }}>
            {unknownOnly ? (
              <PartyPopper size={56} strokeWidth={1.5} aria-hidden />
            ) : (
              <Inbox size={56} strokeWidth={1.5} aria-hidden />
            )}
          </div>
          <h3 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 8px" }}>
            {unknownOnly ? "No unknown cards left!" : "No cards to study"}
          </h3>
          <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 20px" }}>
            {unknownOnly
              ? "You've marked every card in this set as known. Great work!"
              : "This set has no cards."}
          </p>
          {unknownOnly && (
            <button className="btn btn-primary" onClick={showAllCards}>
              <RefreshCw />
              Show all {cards.length} cards
            </button>
          )}
        </div>
      )}

      {mode === "study" && done && (
        <ReviewSummary
          cards={cards}
          progress={progress}
          onRestart={handleRestart}
          onReviewWeak={handleReviewWeak}
        />
      )}

      {mode === "exam" && !examDone && examQuestion && (
        <ExamCard
          key={`${examIndex}-${examQuestions.length}`}
          question={examQuestion}
          index={examIndex}
          total={examQuestions.length}
          chosen={answers.length > examIndex ? answers[examIndex].chosenIndex : null}
          earnedPoints={earnedPoints}
          onChoose={handleChoose}
          onNext={handleExamNext}
          isLast={examIndex === examQuestions.length - 1}
        />
      )}

      {mode === "identify" && !examDone && examQuestion && (
        <IdentifyCard
          key={`identify-${examIndex}-${examQuestions.length}`}
          card={examQuestion.card}
          index={examIndex}
          total={examQuestions.length}
          submitted={identifySubmitted}
          earnedPoints={earnedPoints}
          onSubmit={(typed, isCorrect) => void handleTypedSubmit(typed, isCorrect, "identify")}
          onNext={handleExamNext}
          isLast={examIndex === examQuestions.length - 1}
        />
      )}

      {mode === "enumerate" && !examDone && examQuestion && (
        <EnumerateCard
          key={`enumerate-${examIndex}-${examQuestions.length}`}
          card={examQuestion.card}
          items={enumExpected}
          index={examIndex}
          total={examQuestions.length}
          submitted={enumSubmitted}
          earnedPoints={earnedPoints}
          onSubmit={(userItems, hits, userHits, allCorrect) =>
            void handleTypedSubmit(
              userItems.filter(Boolean).join("; ") || "(no answer)",
              allCorrect,
              "enumerate",
              { expectedItems: enumExpected, userItems }
            )
          }
          onNext={handleExamNext}
          isLast={examIndex === examQuestions.length - 1}
        />
      )}

      {(mode === "identify" || mode === "enumerate") && !examDone && examQuestions.length === 0 && (
        <EmptyRun
          icon={mode === "identify" ? Type : ListOrdered}
          color={mode === "identify" ? "#059669" : "#d97706"}
          title={mode === "identify" ? "Nothing to identify here" : "No enumeration questions here"}
          message={
            mode === "identify"
              ? "Every card in this set has a list-style answer, so they all live in Enumeration mode. Try another mode!"
              : "Enumeration needs answers that are lists. Generate a set from material with lists (types, steps, examples) — or try another mode!"
          }
          onBackToModes={() => setMode("select")}
        />
      )}

      {mode === "exam" && examDone && (
        <ExamSummary
          answers={answers}
          score={score}
          maxScore={maxScore}
          bestStreak={bestStreak}
          elapsed={elapsed}
          onRetry={() => startScoredRun("exam")}
          onStudyMissed={handleStudyMissed}
          onBackToModes={() => setMode("select")}
        />
      )}

      {mode === "identify" && examDone && (
        <ExamSummary
          answers={answers}
          score={score}
          maxScore={maxScore}
          bestStreak={bestStreak}
          elapsed={elapsed}
          completeTitle="Identification Complete!"
          retryLabel="Retry Identification"
          onRetry={() => startScoredRun("identify")}
          onStudyMissed={handleStudyMissed}
          onBackToModes={() => setMode("select")}
        />
      )}

      {mode === "enumerate" && examDone && (
        <ExamSummary
          answers={answers}
          score={score}
          maxScore={maxScore}
          bestStreak={bestStreak}
          elapsed={elapsed}
          completeTitle="Enumeration Complete!"
          retryLabel="Retry Enumeration"
          onRetry={() => startScoredRun("enumerate")}
          onStudyMissed={handleStudyMissed}
          onBackToModes={() => setMode("select")}
        />
      )}
    </div>
  );
}

// ─── Sessions Page ────────────────────────────────────────────────────────────
function SessionsPage({ onOpen }: { onOpen: (id: number) => void }) {
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<number | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch("/api/sessions", signal ? { signal } : undefined);
      const data = await res.json();
      if (signal?.aborted) return;
      setSessions(data.sessions || []);
    } catch {
      if (signal?.aborted) return;
      showToast("Failed to load sessions", CircleX);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  // Load on mount. The request is kicked off from an async IIFE so the effect
  // body never calls setState synchronously, and the fetch is aborted if the
  // screen unmounts before it settles.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      await load(controller.signal);
    })();
    return () => controller.abort();
  }, [load]);

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this study set?")) return;
    setDeleting(id);
    try {
      await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      showToast("Deleted!", Trash);
    } catch {
      showToast("Failed to delete", CircleX);
    } finally {
      setDeleting(null);
    }
  };

  const formatDate = (d: string) => {
    const date = new Date(d);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = diff / 3600000;
    if (hours < 1) return "Just now";
    if (hours < 24) return `${Math.floor(hours)}h ago`;
    if (hours < 48) return "Yesterday";
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0, display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Library size={21} aria-hidden />
          My Study Sets
        </h2>
        <button className="btn btn-ghost btn-sm" onClick={() => load()} style={{ padding: "6px 10px" }}>
          <RefreshCw />
        </button>
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="shimmer" style={{ height: 80, borderRadius: 16 }} />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ marginBottom: 16, color: "var(--text-muted)" }}>
            <Inbox size={64} strokeWidth={1.5} aria-hidden />
          </div>
          <h3 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>No study sets yet!</h3>
          <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
            Upload a PDF or image to create your first flashcard set
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {sessions.map((session, i) => (
            <div
              key={session.id}
              className="glass-card animate-fade-in"
              style={{
                padding: "16px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 14,
                animationDelay: `${i * 0.05}s`,
                transition: "transform 0.15s",
              }}
              onClick={() => onOpen(session.id)}
              onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.98)")}
              onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
              onTouchStart={(e) => (e.currentTarget.style.transform = "scale(0.98)")}
              onTouchEnd={(e) => (e.currentTarget.style.transform = "scale(1)")}
            >
              <div style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                background: "linear-gradient(135deg, #e0f2fe, #eef2ff)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 26,
                flexShrink: 0,
              }}>
                <SourceTypeIcon type={session.sourceType} size={26} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: "0 0 3px", fontWeight: 700, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {session.title}
                </p>
                <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span>
                    {session.cardCount} card{session.cardCount === 1 ? "" : "s"} · {formatDate(session.createdAt)}
                  </span>
                  {typeof session.knownCount === "number" && (
                    <span
                      className="badge"
                      style={{
                        background: session.knownCount >= session.cardCount && session.cardCount > 0 ? "#d1fae5" : "#dbeafe",
                        color: session.knownCount >= session.cardCount && session.cardCount > 0 ? "#047857" : "#1d4ed8",
                      }}
                    >
                      {session.knownCount >= session.cardCount && session.cardCount > 0
                        ? "All known"
                        : `${session.knownCount}/${session.cardCount} known`}
                    </span>
                  )}
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ padding: "6px", color: "#f43f5e", opacity: deleting === session.id ? 0.5 : 1 }}
                  onClick={(e) => handleDelete(session.id, e)}
                  disabled={deleting === session.id}
                >
                  <Trash />
                </button>
                <ArrowRight />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Stats Page ───────────────────────────────────────────────────────────────
interface DeckStat {
  sessionId: number;
  title: string;
  sourceType: string;
  cardCount: number;
  studiedCount: number;
  answerCount: number;
  correctCount: number;
  lastStudiedAt: string | null;
  accuracy: number | null;
  mastery: number;
}

interface ActivityItem {
  id: number;
  sessionId: number;
  cardId: number;
  correct: boolean;
  mode: string;
  answeredAt: string;
  deckTitle: string;
  question: string;
}

interface StatsData {
  overall: {
    totalAnswers: number;
    correctAnswers: number;
    incorrectAnswers: number;
    cardsStudied: number;
    studySessions: number;
    streak: number;
    accuracy: number | null;
    lastStudiedAt: string | null;
  };
  decks: DeckStat[];
  recent: ActivityItem[];
}

function statsDateLabel(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const hours = diff / 3600000;
  if (hours < 1) return "Just now";
  if (hours < 24) return `${Math.max(1, Math.floor(hours))}h ago`;
  if (hours < 48) return "Yesterday";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function modeLabel(mode: string): string {
  return (
    {
      study: "Study",
      exam: "Exam",
      identify: "Identification",
      enumerate: "Enumeration",
    }[mode] ?? "Study"
  );
}

function masteryColor(pct: number): string {
  if (pct >= 80) return "#10b981";
  if (pct >= 50) return "#f59e0b";
  return "#6366f1";
}

function StatsPage({ onOpenDeck }: { onOpenDeck: (id: number) => void }) {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch("/api/stats", signal ? { signal } : undefined);
      const data = await res.json();
      if (signal?.aborted) return;
      if (!res.ok) throw new Error(data.error || "Failed to load stats");
      setStats(data as StatsData);
    } catch {
      if (signal?.aborted) return;
      showToast("Failed to load stats", CircleX);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  // Same aborted-IIFE pattern as SessionsPage: no synchronous setState in the
  // effect body, and the request is cancelled if the tab unmounts.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      await load(controller.signal);
    })();
    return () => controller.abort();
  }, [load]);

  if (loading && !stats) {
    return (
      <div style={{ padding: "20px 16px" }}>
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 16px", display: "inline-flex", alignItems: "center", gap: 8 }}>
          <ChartColumn size={21} aria-hidden />
          Study Stats
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="shimmer" style={{ height: i === 1 ? 120 : 80, borderRadius: 16 }} />
          ))}
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div style={{ padding: "20px 16px", textAlign: "center" }}>
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 16px", display: "inline-flex", alignItems: "center", gap: 8 }}>
          <ChartColumn size={21} aria-hidden />
          Study Stats
        </h2>
        <div style={{ marginBottom: 10, color: "var(--text-muted)" }}>
          <Moon size={48} strokeWidth={1.5} aria-hidden />
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 16px" }}>
          Couldn&apos;t load your stats right now.
        </p>
        <button className="btn btn-secondary" onClick={() => load()}>
          <RefreshCw />
          Try again
        </button>
      </div>
    );
  }

  const { overall, decks, recent } = stats;
  const studiedDecks = decks.filter((d) => d.answerCount > 0);
  const freshDecks = decks.filter((d) => d.answerCount === 0);

  const overallTiles: {
    label: string;
    value: ReactNode;
    icon: LucideIcon;
    color: string;
    bg: string;
  }[] = [
    { label: "Cards studied", value: overall.cardsStudied, icon: Layers, color: "#3b82f6", bg: "#eff6ff" },
    { label: "Study sessions", value: overall.studySessions, icon: Library, color: "#7c3aed", bg: "#f3e8ff" },
    {
      label: "Answers",
      value: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {overall.correctAnswers}
          <CircleCheckBig size={15} aria-hidden style={{ color: "#10b981" }} />
          {overall.incorrectAnswers}
          <CircleX size={15} aria-hidden style={{ color: "#f43f5e" }} />
        </span>
      ),
      icon: Target,
      color: "#10b981",
      bg: "#ecfdf5",
    },
    {
      label: "Accuracy",
      value: overall.accuracy === null ? "—" : `${overall.accuracy}%`,
      icon: Star,
      color: "#f59e0b",
      bg: "#fffbeb",
    },
  ];

  return (
    <div className="animate-fade-in" style={{ padding: "20px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0, display: "inline-flex", alignItems: "center", gap: 8 }}>
          <ChartColumn size={21} aria-hidden />
          Study Stats
        </h2>
        <button className="btn btn-ghost btn-sm" onClick={() => load()} style={{ padding: "6px 10px" }} aria-label="Refresh stats">
          <RefreshCw />
        </button>
      </div>

      {/* Streak hero */}
      <div
        className="glass-card clay-streak"
        style={{
          color: "white",
          padding: "18px 20px",
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 14,
        }}
      >
        <div style={{ lineHeight: 1, flexShrink: 0 }}>
          {overall.streak > 0 ? (
            <Flame size={42} strokeWidth={1.5} aria-hidden />
          ) : (
            <Moon size={42} strokeWidth={1.5} aria-hidden />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 26, fontWeight: 900, lineHeight: 1.1 }}>
            {overall.streak} day{overall.streak === 1 ? "" : "s"}
          </div>
          <div style={{ fontSize: 13, opacity: 0.9, fontWeight: 600 }}>
            {overall.streak === 0
              ? "Study today to start a streak!"
              : "study streak — keep it going!"}
          </div>
        </div>
        <div style={{ textAlign: "right", fontSize: 12, opacity: 0.9 }}>
          <div style={{ fontWeight: 700 }}>Last studied</div>
          <div>{statsDateLabel(overall.lastStudiedAt)}</div>
        </div>
      </div>

      {/* Overall tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 22 }}>
        {overallTiles.map((t) => (
          <div key={t.label} className="glass-card" style={{ background: t.bg, borderRadius: 16, padding: "14px 12px" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: t.color, display: "flex", alignItems: "center", gap: 7 }}>
              <t.icon size={19} aria-hidden />
              {t.value}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600, marginTop: 2 }}>{t.label}</div>
          </div>
        ))}
      </div>

      {/* Per-deck progress */}
      <h3 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 12px", display: "flex", alignItems: "center", gap: 7 }}>
        <Library size={17} aria-hidden />
        Deck progress
      </h3>
      {decks.length === 0 ? (
        <div className="glass-card" style={{ textAlign: "center", padding: "32px 20px", marginBottom: 22 }}>
          <div style={{ marginBottom: 8, color: "var(--text-muted)" }}>
            <Inbox size={44} strokeWidth={1.5} aria-hidden />
          </div>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>No study sets yet</p>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
            Create your first deck and your progress will show up here!
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 22 }}>
          {studiedDecks.map((deck) => {
            const color = masteryColor(deck.mastery);
            const incorrect = deck.answerCount - deck.correctCount;
            return (
              <div
                key={deck.sessionId}
                className="glass-card"
                style={{ padding: "14px 16px", cursor: "pointer" }}
                onClick={() => onOpenDeck(deck.sessionId)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <span style={{ color: "var(--accent-dark)", display: "flex", flexShrink: 0 }}>
                    <SourceTypeIcon type={deck.sourceType} size={20} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {deck.title}
                    </p>
                    <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
                      Last studied {statsDateLabel(deck.lastStudiedAt)}
                    </p>
                  </div>
                  <span className="badge" style={{ background: `${color}1a`, color, fontWeight: 800, flexShrink: 0 }}>
                    {deck.mastery}% mastered
                  </span>
                </div>
                <div className="progress-bar" style={{ marginBottom: 8 }}>
                  <div className="progress-fill" style={{ width: `${deck.mastery}%`, background: color }} />
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <Layers size={13} aria-hidden />
                    {deck.studiedCount}/{deck.cardCount} cards studied
                  </span>
                  <span>·</span>
                  <span style={{ color: "#10b981" }}>{deck.correctCount} correct</span>
                  <span style={{ color: "#f43f5e" }}>{incorrect} incorrect</span>
                  {deck.accuracy !== null && (
                    <>
                      <span>·</span>
                      <span>{deck.accuracy}% accuracy</span>
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {freshDecks.length > 0 && (
            <div
              className="glass-card"
              style={{
                padding: "14px 16px",
                background: "linear-gradient(135deg, #eff6ff, #eef2ff)",
                border: "1.5px dashed #bfdbfe",
              }}
            >
              <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700, color: "#1d4ed8" }}>
                <Sprout size={14} className="icon-inline" aria-hidden /> Not studied yet ({freshDecks.length})
              </p>
              {freshDecks.slice(0, 3).map((deck) => (
                <div
                  key={deck.sessionId}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", cursor: "pointer" }}
                  onClick={() => onOpenDeck(deck.sessionId)}
                >
                  <span style={{ color: "var(--accent-dark)", display: "flex", flexShrink: 0 }}>
                    <SourceTypeIcon type={deck.sourceType} size={16} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {deck.title}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, flexShrink: 0 }}>
                    {deck.cardCount} card{deck.cardCount === 1 ? "" : "s"} · 0% mastered
                  </span>
                </div>
              ))}
              {freshDecks.length > 3 && (
                <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                  +{freshDecks.length - 3} more — open a deck and answer cards to see stats!
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Recent activity */}
      <h3 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 12px", display: "flex", alignItems: "center", gap: 7 }}>
        <ClockArrowUp size={17} aria-hidden />
        Recent activity
      </h3>
      {recent.length === 0 ? (
        <div className="glass-card" style={{ textAlign: "center", padding: "28px 20px" }}>
          <div style={{ marginBottom: 8, color: "var(--text-muted)" }}>
            <Sprout size={40} strokeWidth={1.5} aria-hidden />
          </div>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>Nothing here yet</p>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
            Answer cards in Study, Exam, Identification or Enumeration mode and your activity will appear here.
          </p>
        </div>
      ) : (
        <div className="glass-card" style={{ padding: "6px 14px" }}>
          {recent.slice(0, 12).map((item) => (
            <div
              key={item.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 0",
                borderBottom: "1px solid rgba(147,197,253,0.25)",
              }}
            >
              <span style={{ flexShrink: 0, display: "flex", color: item.correct ? "#10b981" : "#f43f5e" }}>
                {item.correct ? (
                  <CircleCheckBig size={17} aria-hidden />
                ) : (
                  <CircleX size={17} aria-hidden />
                )}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item.question}
                </p>
                <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>
                  {item.deckTitle} · {modeLabel(item.mode)}
                </p>
              </div>
              <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, flexShrink: 0 }}>
                {statsDateLabel(item.answeredAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Home Page ────────────────────────────────────────────────────────────────
function HomePage({ onUpload, onSessions }: { onUpload: () => void; onSessions: () => void }) {
  return (
    <div style={{ padding: "20px 16px" }}>
      {/* Hero */}
      <div
        className="clay-hero"
        style={{
          padding: "28px 24px",
          marginBottom: 24,
        }}
      >
        <div style={{
          position: "absolute",
          top: -20,
          right: -20,
          width: 120,
          height: 120,
          background: "rgba(255,255,255,0.1)",
          borderRadius: "50%",
        }} />
        <div style={{
          position: "absolute",
          bottom: -30,
          right: 30,
          width: 80,
          height: 80,
          background: "rgba(255,255,255,0.08)",
          borderRadius: "50%",
        }} />
        <div className="animate-heartbeat" style={{ marginBottom: 12 }}>
          <Heart size={48} strokeWidth={1.5} aria-hidden />
        </div>
        <h1 style={{ margin: "0 0 6px", fontSize: 26, fontWeight: 900, lineHeight: 1.2 }}>
          QuizTime
        </h1>
        <p style={{ margin: "0 0 20px", fontSize: 14, opacity: 0.9, lineHeight: 1.5 }}>
          Upload your study material and I&apos;ll turn it into fun flashcards — then review them with Study, Exam, Identification or Enumeration mode!
        </p>
        <button
          className="btn btn-white-clay"
          style={{ fontWeight: 800, fontSize: 15 }}
          onClick={onUpload}
        >
          <Sparkles />
          Start Studying
        </button>
      </div>

      {/* Features */}
      <h3 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 14px", display: "flex", alignItems: "center", gap: 7 }}>
        <Lightbulb size={17} aria-hidden />
        How it works
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
        {[
          { icon: FileText, title: "Upload PDF", desc: "Upload any PDF document" },
          { icon: Camera, title: "Take Photo", desc: "Snap a photo of your notes" },
          { icon: BookOpen, title: "Study Mode", desc: "Flip the card to reveal the answer" },
          { icon: ClipboardCheck, title: "Exam Mode", desc: "4 choices, instant score" },
          { icon: Type, title: "Identification", desc: "Type the answer from memory" },
          { icon: ListOrdered, title: "Enumeration", desc: "List every item from memory" },
        ].map((f, i) => (
          <div
            key={i}
            className="glass-card animate-fade-in"
            style={{ padding: "16px 14px", animationDelay: `${i * 0.1}s` }}
          >
            <div style={{ marginBottom: 8, color: "var(--accent-dark)" }}>
              <f.icon size={28} strokeWidth={1.75} aria-hidden />
            </div>
            <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 14 }}>{f.title}</p>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{f.desc}</p>
          </div>
        ))}
      </div>

      {/* Tips */}
      <div style={{
        background: "linear-gradient(135deg, #eff6ff, #ecfeff)",
        border: "1.5px solid #bfdbfe",
        borderRadius: 18,
        padding: "18px 16px",
        marginBottom: 16,
      }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 800, display: "flex", alignItems: "center", gap: 7 }}>
          <Heart size={16} aria-hidden />
          Study Tips
        </h3>
        {[
          "Review cards daily for best retention!",
          "Focus on 'Still Learning' cards more.",
          "Study first, then test yourself with Exam, Identification or Enumeration.",
          "Explain answers in your own words.",
        ].map((tip, i) => (
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 13, color: "var(--text-muted)" }}>
            <Star size={14} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: "#f59e0b" }} />
            <span>{tip}</span>
          </div>
        ))}
      </div>

      <button
        className="btn btn-secondary"
        style={{ width: "100%" }}
        onClick={onSessions}
      >
        <Library />
        View My Study Sets
      </button>
    </div>
  );
}

// ─── Setup Page ───────────────────────────────────────────────────────────────
function SetupPage() {
  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{
        background: "#fffbeb",
        border: "2px solid #fde68a",
        borderRadius: 20,
        padding: "24px 20px",
        marginBottom: 20,
      }}>
        <div style={{ marginBottom: 12, textAlign: "center", color: "#f59e0b" }}>
          <KeyRound size={48} strokeWidth={1.5} aria-hidden />
        </div>
        <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 800, textAlign: "center" }}>
          Setup Required
        </h2>
        <p style={{ margin: "0 0 16px", fontSize: 14, color: "#92400e", textAlign: "center", lineHeight: 1.6 }}>
          To use the AI flashcard generator, you need a free <strong>Google Gemini API key</strong>.
        </p>
        <div style={{ background: "white", borderRadius: 12, padding: "14px 16px", fontSize: 13, color: "#1e1b4b", lineHeight: 1.7 }}>
          <strong>Steps:</strong>
          <ol style={{ margin: "8px 0 0 0", paddingLeft: 20 }}>
            <li>Go to <strong>aistudio.google.com</strong></li>
            <li>Sign in with Google</li>
            <li>Click &quot;Get API Key&quot;</li>
            <li>Copy the key</li>
            <li>Add to your <code style={{ background: "#dbeafe", padding: "1px 6px", borderRadius: 4 }}>.env</code> file:</li>
          </ol>
          <div style={{ background: "#1e1b4b", color: "#a5f3fc", borderRadius: 8, padding: "10px 14px", marginTop: 10, fontSize: 12, fontFamily: "monospace" }}>
            GEMINI_API_KEY=your_key_here
          </div>
        </div>
      </div>
      <p style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center" }}>
        The Gemini API has a generous free tier — no credit card needed!
      </p>
    </div>
  );
}

// ─── Sign-in Prompt ─────────────────────────────────────────────────────────
function SignInPrompt({ feature }: { feature: string }) {
  return (
    <div className="animate-fade-in" style={{ padding: "48px 24px", textAlign: "center" }}>
      <div style={{ marginBottom: 12, color: "var(--accent-dark)" }}>
        <Lock size={56} strokeWidth={1.5} aria-hidden />
      </div>
      <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 800 }}>Sign in to {feature}</h2>
      <p style={{ margin: "0 auto 24px", color: "var(--text-muted)", fontSize: 14, lineHeight: 1.6, maxWidth: 320 }}>
        Your study sets are saved to your account — so you can sync them
        across devices and pick up right where you left off.
      </p>
      <button
        className="btn btn-primary btn-lg"
        style={{ width: "100%", gap: 10 }}
        onClick={() => void signIn("google", { callbackUrl: window.location.href })}
      >
        {/* Google "G" */}
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
        </svg>
        Continue with Google
      </button>
      <p style={{ marginTop: 14, fontSize: 12, color: "var(--text-muted)" }}>
        Free · no password to remember · your data stays in your account
      </p>
    </div>
  );
}

// ─── Draft deck persistence ──────────────────────────────────────────────────
/** A generated study set that the user hasn't saved to the database yet. */
interface PendingDeck {
  cards: Flashcard[];
  title: string;
  summary: string;
  sourceType: string;
}

const DRAFT_KEY = "quiztime:pending-deck";

function loadDraft(): PendingDeck | null {
  if (typeof window === "undefined") return null; // SSR
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (
      d &&
      Array.isArray(d.cards) &&
      d.cards.length > 0 &&
      typeof d.title === "string" &&
      d.title
    ) {
      return d as PendingDeck;
    }
  } catch {
    // Corrupted draft — ignore it.
  }
  return null;
}

function persistDraft(draft: PendingDeck | null) {
  try {
    if (draft) window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage full or blocked — non-fatal, the deck just won't survive reloads.
  }
}

// ─── Study outcome queue (P2 stats sync) ─────────────────────────────────────
/**
 * Card-level right/wrong outcomes live in the database (study_results), tied
 * to the account — progress follows the user across devices. The queue below
 * batches answers in memory and flushes them to POST /api/stats/results;
 * localStorage is only a draft cache so outcomes survive a refresh or a
 * failed request until the next successful sync.
 */
const OUTCOME_KEY = "quiztime:pending-outcomes";
const OUTCOME_CACHE_LIMIT = 200;

function readOutcomeCache(): StudyOutcome[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(OUTCOME_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StudyOutcome[]) : [];
  } catch {
    return []; // Corrupted cache — nothing we can do, drop it.
  }
}

function writeOutcomeCache(outcomes: StudyOutcome[]) {
  if (typeof window === "undefined") return;
  try {
    if (outcomes.length === 0) window.localStorage.removeItem(OUTCOME_KEY);
    else window.localStorage.setItem(OUTCOME_KEY, JSON.stringify(outcomes.slice(-OUTCOME_CACHE_LIMIT)));
  } catch {
    // Storage full or blocked — non-fatal, the server copy is what counts.
  }
}

/**
 * Flush queued outcomes to the server. Outcomes recorded during this call are
 * kept for the next flush; only what the server accepted is dropped.
 * `useBeacon` switches to navigator.sendBeacon so the batch survives the
 * page being hidden/closed mid-flight.
 */
async function syncOutcomes(outcomes: StudyOutcome[], useBeacon = false): Promise<StudyOutcome[]> {
  if (outcomes.length === 0) return outcomes;
  const body = JSON.stringify({ results: outcomes });
  try {
    if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
      const sent = navigator.sendBeacon(
        "/api/stats/results",
        new Blob([body], { type: "application/json" })
      );
      // Beacon accepted for delivery → optimistically clear the cache.
      return sent ? [] : outcomes;
    }
    const res = await fetch("/api/stats/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return res.ok ? [] : outcomes;
  } catch {
    return outcomes; // Offline / network error — keep the cache, retry later.
  }
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function IOSInstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [installEvent, setInstallEvent] = useState<Event | null>(null);
  const [isAndroid, setIsAndroid] = useState(false);

  useEffect(() => {
    // iOS Safari does not support beforeinstallprompt, so it needs manual
    // Add to Home Screen instructions. Android Chrome can offer a native
    // install dialog through this event.
    const standalone = window.matchMedia("(display-mode: standalone)").matches ||
      ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const android = /Android/i.test(navigator.userAgent);
    const dismissed = window.localStorage.getItem("quiztime-install-dismissed");

    setIsAndroid(android);
    if (!standalone && !dismissed && isIOS) setVisible(true);

    const handleBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event);
      if (!standalone && !dismissed && android) setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
  }, []);

  if (!visible) return null;

  const install = async () => {
    if (installEvent && "prompt" in installEvent) {
      await (installEvent as Event & { prompt: () => Promise<void> }).prompt();
      setVisible(false);
    } else {
      window.localStorage.setItem("quiztime-install-dismissed", "1");
      setVisible(false);
    }
  };

  return (
    <div className="ios-install-banner" role="status">
      <div className="ios-install-icon" aria-hidden><Share size={20} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>Install QuizTime</strong>
        {isAndroid && installEvent ? (
          <span>Add QuizTime to your home screen for quick access</span>
        ) : isAndroid ? (
          <span>Tap <strong>⋮</strong>, then “Add to Home screen”</span>
        ) : (
          <span>Tap <Share size={14} aria-hidden /> Share, then “Add to Home Screen”</span>
        )}
      </div>
      {isAndroid && installEvent && (
        <button type="button" className="btn btn-sm ios-install-action" onClick={() => void install()}>
          Install
        </button>
      )}
      <button
        type="button"
        className="ios-install-close"
        aria-label="Dismiss install instructions"
        onClick={() => {
          window.localStorage.setItem("quiztime-install-dismissed", "1");
          setVisible(false);
        }}
      >
        <X size={18} />
      </button>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [pendingCards, setPendingCards] = useState<Flashcard[] | null>(null);
  const [pendingTitle, setPendingTitle] = useState("");
  const [pendingSummary, setPendingSummary] = useState("");
  const [pendingSourceType, setPendingSourceType] = useState("text");
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [activeSessionCards, setActiveSessionCards] = useState<Flashcard[] | null>(null);
  const [activeSessionTitle, setActiveSessionTitle] = useState("");
  const [activeSessionSummary, setActiveSessionSummary] = useState("");
  const [hasApiKey, setHasApiKey] = useState(true);
  const [deckKey, setDeckKey] = useState(0);

  // Sign-in state (Auth.js). `data` is null while unauthenticated.
  const { data: session, status } = useSession();
  const user = session?.user;
  const signedIn = Boolean(user?.id);

  // Check if the AI key is configured via the lightweight /api/config
  // endpoint. (The old probe — an empty POST to /api/scan — always got
  // rejected as "No file or text provided" before the route ever looked
  // at the key, which is why the setup screen was unreachable.)
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => setHasApiKey(Boolean(data.hasApiKey)))
      .catch(() => {});
  }, []);

  // ── Draft deck (generated but not saved yet) ──────────────────────────────
  // Lazy initializer: restored from localStorage on first client render.
  const [draft, setDraft] = useState<PendingDeck | null>(() => loadDraft());

  const handleCardsReady = (cards: Flashcard[], title: string, summary: string, sourceType: string) => {
    setPendingCards(cards);
    setPendingTitle(title);
    setPendingSummary(summary);
    setPendingSourceType(sourceType);
    setActiveSessionId(null);
    setDeckKey((k) => k + 1);
    setTab("quiz");

    // Keep the deck safe if the user leaves before tapping Save.
    const deck: PendingDeck = { cards, title, summary, sourceType };
    setDraft(deck);
    persistDraft(deck);
  };

  const resumeDraft = () => {
    if (!draft) return;
    setPendingCards(draft.cards);
    setPendingTitle(draft.title);
    setPendingSummary(draft.summary);
    setPendingSourceType(draft.sourceType);
    setActiveSessionId(null);
    setDeckKey((k) => k + 1);
    setTab("quiz");
  };

  const discardDraft = () => {
    setDraft(null);
    persistDraft(null);
    showToast("Draft discarded", Trash);
  };

  const handleSaveSession = async (title: string) => {
    if (!pendingCards) return;
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        sourceType: pendingSourceType,
        cards: pendingCards,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setActiveSessionId(data.session.id);
    setPendingCards(data.cards);
    // Deck is in the database now — the draft has served its purpose.
    setDraft(null);
    persistDraft(null);
  };

  const handleOpenSession = async (id: number) => {
    try {
      const res = await fetch(`/api/sessions/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setActiveSessionId(id);
      setActiveSessionCards(data.cards);
      setActiveSessionTitle(data.session.title);
      setActiveSessionSummary("");
      setPendingCards(null);
      setDeckKey((k) => k + 1);
      setTab("quiz");
    } catch {
      showToast("Failed to load session", CircleX);
    }
  };

  // First-visit gate: unsigned visitors (and the session-loading splash)
  // see the login page with the large logo — never the rest of the app.
  if (status === "loading" || !signedIn) {
    return <LoginPage loading={status === "loading"} />;
  }

  const isViewingSession = activeSessionCards !== null && activeSessionId !== null && !pendingCards;

  const renderContent = () => {
    if (tab === "quiz") {
      const cards = isViewingSession ? activeSessionCards! : pendingCards!;
      const title = isViewingSession ? activeSessionTitle : pendingTitle;
      const summary = isViewingSession ? activeSessionSummary : pendingSummary;

      return (
        <QuizPage
          key={deckKey}
          sessionId={activeSessionId ?? undefined}
          cards={cards}
          title={title}
          summary={summary}
          onSave={!isViewingSession ? handleSaveSession : undefined}
          onBack={() => {
            setTab(isViewingSession ? "sessions" : "upload");
            if (isViewingSession) setActiveSessionCards(null);
            else setPendingCards(null);
          }}
        />
      );
    }

    if (tab === "home") return <HomePage onUpload={() => setTab("upload")} onSessions={() => setTab("sessions")} />;
    if (tab === "upload") {
      if (!signedIn) return <SignInPrompt feature="create study sets" />;
      if (!hasApiKey) return <SetupPage />;
      return (
        <>
          {draft && !pendingCards && (
            <div
              className="animate-fade-in"
              style={{
                margin: "12px 16px 0",
                background: "#fffbeb",
                border: "1.5px solid #fde68a",
                borderRadius: 16,
                padding: "12px 14px",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span style={{ color: "#92400e", display: "flex", flexShrink: 0 }}>
                <Save size={22} aria-hidden />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  Unsaved study set: {draft.title}
                </p>
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
                  {draft.cards.length} cards kept safe — resume or discard
                </p>
              </div>
              <button className="btn btn-primary btn-sm" onClick={resumeDraft} style={{ flexShrink: 0 }}>
                Resume
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={discardDraft}
                style={{ flexShrink: 0, color: "#f43f5e", padding: "6px" }}
                aria-label="Discard draft"
              >
                <Trash />
              </button>
            </div>
          )}
          <UploadPage onCardsReady={handleCardsReady} />
        </>
      );
    }
    if (tab === "sessions") {
      if (!signedIn) return <SignInPrompt feature="see your study sets" />;
      return <SessionsPage onOpen={handleOpenSession} />;
    }
    if (tab === "stats") {
      if (!signedIn) return <SignInPrompt feature="see your study stats" />;
      return <StatsPage onOpenDeck={handleOpenSession} />;
    }
    return null;
  };

  const navItems = [
    { id: "home" as Tab, label: "Home", Icon: House },
    { id: "upload" as Tab, label: "Upload", Icon: Upload },
    { id: "sessions" as Tab, label: "My Sets", Icon: Library },
    { id: "stats" as Tab, label: "Stats", Icon: ChartColumn },
  ];

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", position: "relative" }}>
      <IOSInstallPrompt />
      {/* Top bar */}
      <div className="clay-topbar" style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/logo.png" alt="QuizTime" style={{ width: 36, height: 36, borderRadius: 10, objectFit: "cover" }} />
        <div>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 900 }} className="gradient-text">
            QuizTime
          </h1>
          <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>Your AI Study Partner</p>
          <p className="app-developer">Developed by: John Lloyd Ambrad</p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {!hasApiKey && signedIn && (
            <span style={{ fontSize: 12, background: "#fef3c7", color: "#92400e", padding: "4px 10px", borderRadius: 999, fontWeight: 600 }}>
              <Settings size={12} className="icon-inline" aria-hidden /> Setup
            </span>
          )}
          {user ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, maxWidth: 210 }}>
              {user.image ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={user.image}
                  alt=""
                  style={{ width: 30, height: 30, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
                />
              ) : (
                <div style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  background: "linear-gradient(135deg, #3b82f6, #7c3aed)",
                  color: "white",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  fontWeight: 800,
                  flexShrink: 0,
                }}>
                  {(user.name ?? "?").charAt(0).toUpperCase()}
                </div>
              )}
              <span style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {user.name?.split(" ")[0] ?? "Signed in"}
              </span>
              {/* Full reload on sign-out clears all in-memory deck state. */}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void signOut({ callbackUrl: "/login" })}
                style={{ padding: "4px 8px", fontSize: 11, flexShrink: 0 }}
                aria-label="Sign out"
              >
                Sign out
              </button>
            </div>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void signIn("google", { callbackUrl: window.location.href })}
            >
              Sign in
            </button>
          )}
        </div>
      </div>

      {/* Page content */}
      <div className="page-content">
        {renderContent()}
      </div>

      {/* Bottom nav */}
      <nav className="nav-bottom">
        {navItems.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`nav-item ${tab === id ? "active" : ""}`}
            onClick={() => {
              setTab(id);
              setPendingCards(null);
              setActiveSessionCards(null);
            }}
          >
            <Icon />
            {label}
          </button>
        ))}
      </nav>

      <ToastHost />
    </div>
  );
}
