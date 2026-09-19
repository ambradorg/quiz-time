"use client";

import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import { LoginPage } from "@/components/login-page";
import { OwnerPresenceBar } from "@/components/owner-presence";
import {
  extractPdfText,
  isPasswordProtectedPdf,
  PDF_TEXT_CHAR_LIMIT,
  PDF_MIN_TEXT_CHARS,
} from "@/lib/pdf-text";
import { extractDocxTextClient } from "@/lib/docx-client";
import { extractPptxTextClient } from "@/lib/pptx-client";
import {
  applyLocalGrades,
  bindConnectivityListeners,
  bumpOutbox,
  cacheDeckBundle,
  cacheStatsSnapshot,
  countDueNow,
  fetchJson,
  forgetDeckOffline,
  formatSavedAgo,
  HttpError,
  isProbablyOnline,
  OfflineError,
  loadDeckDueCount,
  loadDeckForStudy,
  loadOfflineSessionList,
  loadReviewData,
  purgeOfflineData,
  probeConnection,
  readDecks,
  readOfflineReadiness,
  readSrsRecords,
  readStatsSnapshot,
  saveProgressLocally,
  sendOrQueueWrite,
} from "@/lib/offline";
import { useOfflineIdentity, useOnlineStatus, useOutbox } from "@/lib/use-offline";
import { usePresenceHeartbeat } from "@/lib/use-presence";
import { MascotHost } from "@/components/hamster-mascot";
import { CoursePickerModal } from "@/components/course-picker";
import { mascotEvent, mascotSay } from "@/lib/mascot";
import {
  OfflineBadge,
  OfflineChip,
  OfflineNotice,
  OfflinePinButton,
  OfflineReadyCard,
  OfflineRetryButton,
} from "@/components/offline-ui";
import {
  GRADE_LABELS,
  GRADE_SHORTCUTS,
  MAX_REQUEUES_PER_CARD,
  REVIEW_GRADES,
  dueLabel,
  overdueLabel,
  previewIntervals,
  scheduleCard,
  type ReviewGrade,
  type SrsState,
} from "@/lib/srs";
import {
  ArrowLeft,
  ArrowRight,
  BookBookmark,
  Brain,
  CalendarClock,
  Hourglass,
  Info,
  Play,
  RotateCcw,
  Zap,
  BookOpen,
  BookOpenCheck,
  Bot,
  Camera,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronUp,
  CloudDownload,
  CloudOff,
  CloudUpload,
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
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GraduationCap,
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
  Pencil,
  PenLine,
  Plus,
  Presentation,
  RefreshCw,
  Save,
  Search,
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
  /** Subject folder this set is filed under (null/absent = All Sets only). */
  subjectId?: number | null;
  cardCount: number;
  knownCount?: number;
  /** Cards waiting in the spaced-repetition queue right now. */
  dueCount?: number;
  /** Cards with a review schedule at all. */
  trackedCount?: number;
}

/** A subject folder (see /api/subjects) — an optional grouping above sets. */
interface Subject {
  id: number;
  name: string;
  createdAt: string;
  /** How many study sets are filed inside (from the API's grouped count). */
  setCount: number;
}

type Tab = "home" | "upload" | "quiz" | "sessions" | "stats" | "review";
type QuizMode = "select" | "study" | "exam" | "identify" | "enumerate" | "review";
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
      : type === "manual"
      ? Layers
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

function UploadPage({
  course,
  onCardsReady,
}: {
  /** The profile course, used to pre-fill the per-upload "tailor for" field. */
  course: string | null;
  onCardsReady: (cards: Flashcard[], title: string, summary: string, sourceType: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [statusText, setStatusText] = useState("");
  const [textInput, setTextInput] = useState("");
  const [mode, setMode] = useState<"file" | "text">("file");
  const [picked, setPicked] = useState<PickedFile[]>([]);
  // Per-upload override: pre-filled from the profile, editable for this one
  // set, and cleared (→ generic AI prompt) if the user empties it.
  const [tailorFor, setTailorFor] = useState(course ?? "");
  const fileRef = useRef<HTMLInputElement>(null);
  const pickedRef = useRef<PickedFile[]>([]);

  useEffect(() => {
    pickedRef.current = picked;
  }, [picked]);

  // Keep the field in step with the profile (e.g. right after they save a
  // new course from the modal while this tab is open). Deferred one frame —
  // a synchronous setState in the effect body would cascade renders.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setTailorFor(course ?? ""));
    return () => cancelAnimationFrame(frame);
  }, [course]);

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
        // Attach the course so the server can frame the flashcards for this
        // student's program (empty → the server uses the generic prompt).
        const courseValue = tailorFor.trim();
        if (courseValue) formData.append("course", courseValue);
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

        //  Nibbles thinks along while the AI chews the upload into cards.
        mascotEvent({ type: "generating" });
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
        mascotSay("Ta-da! Your flashcards are ready — open your new study set and let's go! 🎉", "wave");
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
        mascotEvent({ type: "generating" });
        const formData = new FormData();
        formData.append("text", textInput.trim());
        sourceType = "text";

        const result = await sendScanRequest(formData);
        onCardsReady(result.cards || [], result.title || "Study Set", result.summary || "", sourceType);
        mascotSay("Ta-da! Your flashcards are ready — open your new study set and let's go! 🎉", "wave");
        if (result.notice) {
          showToast(result.notice, TriangleAlert);
        } else {
          showToast(`Generated ${(result.cards || []).length} flashcards!`, PartyPopper);
        }
      }
    } catch (err) {
      setError((err as Error).message);
      mascotSay("Oh crumbs, that didn't work 😅 Shake it off — let's try again!", "sad");
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

      {/* Tailor-for field: pre-filled from the profile course, editable for
          this one set. Clear it to generate with the generic prompt. */}
      <div
        className="glass-card"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          marginBottom: 16,
          border: "1.5px solid #bfdbfe",
          background: "linear-gradient(135deg, #eff6ff, #eef2ff)",
        }}
      >
        <GraduationCap size={19} aria-hidden style={{ color: "#1d4ed8", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <label
            htmlFor="tailor-for-course"
            style={{ display: "block", fontSize: 11, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 2 }}
          >
            Tailor flashcards for
          </label>
          <input
            id="tailor-for-course"
            value={tailorFor}
            onChange={(e) => setTailorFor(e.target.value)}
            placeholder="Your course (e.g. BS Pharmacy)"
            maxLength={80}
            autoComplete="off"
            style={{
              width: "100%",
              border: "none",
              outline: "none",
              background: "transparent",
              font: "inherit",
              fontSize: 14.5,
              fontWeight: 700,
              color: "var(--text)",
              padding: 0,
            }}
          />
        </div>
      </div>

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
  dueCount,
  canReview,
  onSelect,
}: {
  cardCount: number;
  cards: Flashcard[];
  /** Cards of this deck waiting in the spaced-repetition queue (null = still loading). */
  dueCount: number | null;
  /** Spaced repetition needs server-side card ids, so unsaved decks can't review. */
  canReview: boolean;
  onSelect: (mode: "study" | "exam" | "identify" | "enumerate" | "review") => void;
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
        {/* Spaced repetition (P4) */}
        <button className="mode-card" onClick={() => onSelect("review")} disabled={!canReview}>
          <div className="mode-icon" style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)" }}>
            <Brain />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800 }}>
              Spaced Review
              {canReview && dueCount !== null && dueCount > 0 && (
                <span className="badge" style={{ background: "#ffe4e6", color: "#9f1239", marginLeft: 8, verticalAlign: "middle" }}>
                  {dueCount} due
                </span>
              )}
            </p>
            <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {!canReview
                ? "Save this study set first \u2014 spaced repetition keeps its schedule on your account."
                : dueCount === 0
                  ? "Nothing due right now. Cards come back right before you'd forget them."
                  : `Review the ${dueCount} card${dueCount === 1 ? "" : "s"} due today \u2014 grade each one and it is rescheduled automatically.`}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {["Due cards only", "Again/Hard/Good/Easy", "Reschedules itself"].map((t) => (
                <span key={t} className="badge" style={{ background: "#f3e8ff", color: "#6d28d9" }}>{t}</span>
              ))}
            </div>
          </div>
        </button>

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

// ─── Spaced Repetition (P4) ───────────────────────────────────────────────────
/**
 * The Review tab is Anki's day-to-day loop: the server decides *which* cards
 * are due (`GET /api/review`) and *when they come back* `POST /api/review` →
 * `src/lib/srs.ts`), while this screen does the two things a learner actually
 * feels — a card to recall, and four buttons that say how it went.
 *
 * The client imports the very same scheduler the server uses, so the
 * intervals printed on the buttons ("Good · 3 days") are exactly what will be
 * stored, and a card answered "Again" can be pushed back into the running
 * queue without waiting for a round trip.
 */

/** One card from `GET /api/review`. */
interface DueCard {
  cardId: number;
  sessionId: number;
  question: string;
  answer: string;
  hint: string | null;
  difficulty: string;
  deckTitle: string;
  isNew: boolean;
  dueAt: string | null;
  state: SrsState | null;
}

/** Per-deck rollup that powers the deck chips and the list badges. */
interface ReviewDeckStat {
  sessionId: number;
  title: string;
  cardCount: number;
  trackedCount: number;
  dueCount: number;
  newCount: number;
  nextDueAt: string | null;
  nextDueLabel: string;
}

interface ReviewQueueData {
  now: string;
  counts: {
    due: number;
    learning: number;
    tracked: number;
    newCards: number;
    newRemainingToday: number;
    newIntroducedToday?: number;
    newPerDay: number;
  };
  nextDueAt: string | null;
  decks: ReviewDeckStat[];
  queue: DueCard[];
}

/** One graded card in the current run (feeds the end-of-session summary). */
interface GradedCard {
  cardId: number;
  grade: ReviewGrade;
  intervalDays: number;
  label: string;
  dueAt: string;
  deckTitle: string;
}

const GRADE_STYLE: Record<ReviewGrade, { color: string; bg: string; icon: LucideIcon }> = {
  again: { color: "#be123c", bg: "linear-gradient(180deg, #fff1f2, #fecdd3)", icon: RotateCcw },
  hard: { color: "#b45309", bg: "linear-gradient(180deg, #fffbeb, #fde68a)", icon: Dumbbell },
  good: { color: "#047857", bg: "linear-gradient(180deg, #ecfdf5, #a7f3d0)", icon: Check },
  easy: { color: "#1d4ed8", bg: "linear-gradient(180deg, #eff6ff, #bfdbfe)", icon: Zap },
};

/** "New" / "Due" / "Overdue by 2 days" chip for the card header. */
function DueChip({ card }: { card: DueCard }) {
  if (card.isNew) {
    return (
      <span className="badge" style={{ background: "#ede9fe", color: "#6d28d9" }}>
        New
      </span>
    );
  }
  const late = overdueLabel(card.dueAt);
  return (
    <span
      className="badge"
      style={late ? { background: "#ffe4e6", color: "#9f1239" } : { background: "#dbeafe", color: "#1d4ed8" }}
    >
      {late ?? "Due"}
    </span>
  );
}

// ─── The review runner ────────────────────────────────────────────────────────
function ReviewSession({
  cards,
  deckTitle,
  onExit,
  onFinished,
}: {
  cards: DueCard[];
  deckTitle?: string;
  onExit: () => void;
  onFinished: () => void;
}) {
  const [queue, setQueue] = useState<DueCard[]>(cards);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [graded, setGraded] = useState<GradedCard[]>([]);
  const [finished, setFinished] = useState(false);
  const [syncState, setSyncState] = useState<"idle" | "saving" | "queued" | "error">("idle");

  // Cards answered "Again"/"Hard" are still in learning; they come back once
  // or twice more before the session ends (bounded so a single card can't
  // trap the learner in a loop).
  const requeues = useRef<Record<number, number>>({});
  // Grades waiting to be persisted — serialized so two flushes can't race.
  const pending = useRef<{ cardId: number; sessionId: number; grade: ReviewGrade; reviewedAt: string }[]>([]);
  const flushChain = useRef<Promise<boolean>>(Promise.resolve(true));

  const doFlush = useCallback(async (beacon = false): Promise<boolean> => {
    if (pending.current.length === 0) return true;
    const batch = pending.current;
    pending.current = [];

    // Leaving the page mid-session: hand the batch to the browser so a grade
    // isn't lost on navigation (same trick the study-outcome sync uses). Only
    // when there's a network — offline the outbox below is the durable path.
    if (
      beacon &&
      isProbablyOnline() &&
      typeof navigator !== "undefined" &&
      navigator.sendBeacon
    ) {
      const sent = navigator.sendBeacon(
        "/api/review",
        new Blob([JSON.stringify({ reviews: batch })], { type: "application/json" })
      );
      if (sent) return true;
    }

    setSyncState("saving");
    const outcome = await sendOrQueueWrite("/api/review", "POST", { reviews: batch });
    if (outcome === "rejected") {
      // The server refused the batch — keep it in memory and offer a retry.
      pending.current = [...batch, ...pending.current];
      setSyncState("error");
      return false;
    }
    // "queued" means the outbox now owns these grades; holding a second copy
    // in memory would apply them twice when the network returns.
    setSyncState(outcome === "queued" ? "queued" : "idle");
    return true;
  }, []);

  const flush = useCallback(
    (beacon = false) => {
      const run = flushChain.current.then(() => doFlush(beacon)).catch(() => false);
      flushChain.current = run;
      return run;
    },
    [doFlush]
  );

  // Best-effort beacon flush if the user navigates away mid-session.
  useEffect(() => () => void flush(true), [flush]);

  const card = queue[index];

  const handleGrade = useCallback(
    (grade: ReviewGrade) => {
      const current = queue[index];
      if (!current) return;

      const now = new Date();
      const preview = previewIntervals(current.state, now)[grade];
      const next = scheduleCard(current.state, grade, now);

      setGraded((prev) => [
        ...prev,
        {
          cardId: current.cardId,
          grade,
          intervalDays: next.intervalDays,
          label: preview.label,
          dueAt: next.dueAt.toISOString(),
          deckTitle: current.deckTitle,
        },
      ]);

      // Keep the local schedule in step with what the screen just previewed,
      // so an offline queue (and the "due" counts) stay truthful even if the
      // grade only reaches the server later.
      void applyLocalGrades([
        { cardId: current.cardId, sessionId: current.sessionId, grade },
      ]);

      pending.current = [
        ...pending.current,
        { cardId: current.cardId, sessionId: current.sessionId, grade, reviewedAt: now.toISOString() },
      ];
      void flush();

      const seen = requeues.current[current.cardId] ?? 0;
      const requeue = next.intervalDays === 0 && seen < MAX_REQUEUES_PER_CARD;
      if (requeue) {
        requeues.current[current.cardId] = seen + 1;
        setQueue((prev) => [
          ...prev,
          { ...current, state: next, isNew: false, dueAt: next.dueAt.toISOString() },
        ]);
      }

      const nextLength = queue.length + (requeue ? 1 : 0);
      if (index + 1 >= nextLength) {
        setFinished(true);
        void flush();
        return;
      }
      setIndex((i) => i + 1);
      setFlipped(false);
    },
    [queue, index, flush]
  );

  // Space/Enter reveals, 1-4 grade — the muscle memory of every flashcard app.
  useEffect(() => {
    if (finished) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        setFlipped(true);
        return;
      }
      if (!flipped) return;
      const match = REVIEW_GRADES.find((g) => GRADE_SHORTCUTS[g] === event.key);
      if (match) {
        event.preventDefault();
        handleGrade(match);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flipped, finished, handleGrade]);

  // 🐹 Nibbles celebrates the end of a review round.
  useEffect(() => {
    if (!finished) return;
    const recalled = graded.filter((item) => item.grade !== "again").length;
    const pct = graded.length > 0 ? Math.round((recalled / graded.length) * 100) : 0;
    mascotEvent({ type: "review-done", pct });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  const difficultyColor =
    { easy: "#10b981", medium: "#f59e0b", hard: "#f43f5e" }[card?.difficulty ?? "medium"] ?? "#6366f1";

  // ── Session summary ───────────────────────────────────────────────────────
  if (finished) {
    const counts = REVIEW_GRADES.map((g) => ({
      grade: g,
      label: GRADE_LABELS[g],
      value: graded.filter((item) => item.grade === g).length,
      ...GRADE_STYLE[g],
    }));
    const recalled = graded.filter((item) => item.grade !== "again").length;
    const pct = graded.length > 0 ? Math.round((recalled / graded.length) * 100) : 0;
    const nextDue = graded.reduce<string | null>(
      (earliest, item) => (!earliest || item.dueAt < earliest ? item.dueAt : earliest),
      null
    );

    return (
      <div className="animate-fade-in" style={{ textAlign: "center", padding: "24px 4px" }}>
        <div style={{ display: "flex", justifyContent: "center", color: "var(--accent-dark)" }}>
          {pct >= 80 ? <Trophy size={68} strokeWidth={1.5} aria-hidden /> : <Dumbbell size={68} strokeWidth={1.5} aria-hidden />}
        </div>
        <h2 className="gradient-text" style={{ fontSize: 26, fontWeight: 800, margin: "8px 0 4px" }}>
          Review complete!
        </h2>
        <p style={{ color: "var(--text-muted)", margin: "0 0 20px", fontSize: 15 }}>
          {graded.length} card{graded.length === 1 ? "" : "s"} reviewed · {pct}% recalled first try
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 18 }}>
          {counts.map((c) => (
            <div key={c.grade} style={{ background: c.bg, borderRadius: 16, padding: "12px 6px" }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: c.color }}>{c.value}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>{c.label}</div>
            </div>
          ))}
        </div>

        <div className="glass-card" style={{ padding: "14px 16px", marginBottom: 18, textAlign: "left" }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 8 }}>
            <Hourglass size={16} aria-hidden style={{ color: "#7c3aed", flexShrink: 0 }} />
            <span>
              Next card comes back <strong>{dueLabel(nextDue)}</strong>. Cards you found hard return sooner than
              the ones you aced — that&apos;s the schedule doing its job.
            </span>
          </p>
          {syncState === "queued" && (
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "#4338ca", display: "flex", alignItems: "center", gap: 6 }}>
              <CloudUpload size={14} aria-hidden />
              You&apos;re offline — these grades are saved on this device and sync automatically.
            </p>
          )}
          {syncState === "error" && (
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "#9f1239", display: "flex", alignItems: "center", gap: 6 }}>
              <CircleX size={14} aria-hidden />
              Some grades couldn&apos;t be saved.
              <button className="btn btn-ghost btn-sm" style={{ padding: "2px 8px" }} onClick={() => void flush()}>
                Retry
              </button>
            </p>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button className="btn btn-primary btn-lg" style={{ width: "100%" }} onClick={onFinished}>
            <CalendarClock />
            Back to the review list
          </button>
          <button className="btn btn-ghost" style={{ width: "100%" }} onClick={onExit}>
            <ArrowLeft />
            Study this deck
          </button>
        </div>
      </div>
    );
  }

  if (!card) return null;

  const previews = previewIntervals(card.state, new Date());
  const remaining = queue.length - index;

  return (
    <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={onExit} style={{ padding: "6px 10px", borderRadius: 12 }} aria-label="Leave review">
          <ArrowLeft />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {deckTitle ?? "Daily review"}
          </p>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
            {remaining} card{remaining === 1 ? "" : "s"} left in this round
          </p>
        </div>
        <span className="score-pill" aria-label={`Card ${index + 1} of ${queue.length}`}>
          <Layers />
          {index + 1}/{queue.length}
        </span>
      </div>

      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${(index / queue.length) * 100}%` }} />
      </div>

      {/* The card itself — same flip mechanic as Study Mode. */}
      <div
        className="card-container"
        style={{ height: 320, cursor: flipped ? "default" : "pointer" }}
        onClick={!flipped ? () => setFlipped(true) : undefined}
      >
        <div className={`card-inner ${flipped ? "flipped" : ""}`}>
          <div
            className="card-front glass-card clay-flash-front"
            style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 26 }}
          >
            <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", justifyContent: "center" }}>
              <DueChip card={card} />
              <span className="badge" style={{ background: `${difficultyColor}20`, color: difficultyColor }}>
                {card.difficulty}
              </span>
              {!deckTitle && (
                <span className="badge" style={{ background: "#e0f2fe", color: "#0369a1", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {card.deckTitle}
                </span>
              )}
            </div>
            <div style={{ marginBottom: 10, color: "var(--accent-dark)" }}>
              <CircleQuestionMark size={34} strokeWidth={1.5} aria-hidden />
            </div>
            <p style={{ textAlign: "center", fontSize: 18, fontWeight: 700, lineHeight: 1.4, margin: 0 }}>
              {card.question}
            </p>
            {!flipped && (
              <p style={{ marginTop: 18, fontSize: 13, color: "var(--text-muted)", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                <Orbit size={14} aria-hidden />
                Tap to reveal
              </p>
            )}
          </div>

          <div
            className="card-back glass-card clay-flash-back"
            style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 26 }}
          >
            <div style={{ marginBottom: 10, color: "#f59e0b" }}>
              <Lightbulb size={30} strokeWidth={1.5} aria-hidden />
            </div>
            <p style={{ textAlign: "center", fontSize: 16, fontWeight: 600, lineHeight: 1.5, margin: 0, overflowY: "auto", maxHeight: 200 }}>
              {card.answer}
            </p>
            {card.hint && (
              <p style={{ marginTop: 12, fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
                Hint: {card.hint}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Grade buttons */}
      {flipped ? (
        <div className="animate-slide-up">
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--text-muted)", fontWeight: 700, textAlign: "center" }}>
            How well did you remember it?
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {REVIEW_GRADES.map((g) => {
              const style = GRADE_STYLE[g];
              const Icon = style.icon;
              return (
                <button
                  key={g}
                  className="review-grade"
                  style={{ background: style.bg, color: style.color }}
                  onClick={() => handleGrade(g)}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 15, fontWeight: 800 }}>
                    <Icon size={17} aria-hidden />
                    {GRADE_LABELS[g]}
                  </span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, opacity: 0.75 }}>{previews[g].label}</span>
                </button>
              );
            })}
          </div>
          <p style={{ margin: "10px 0 0", fontSize: 11.5, color: "var(--text-muted)", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Keyboard size={13} aria-hidden />
            Space reveals · 1 Again · 2 Hard · 3 Good · 4 Easy
          </p>
        </div>
      ) : (
        <button className="btn btn-primary btn-lg" style={{ width: "100%" }} onClick={() => setFlipped(true)}>
          <Orbit />
          Show answer
        </button>
      )}

      {syncState === "saving" && (
        <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-muted)", textAlign: "center" }}>Saving…</p>
      )}
      {syncState === "error" && (
        <p style={{ margin: 0, fontSize: 11.5, color: "#9f1239", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <CircleX size={13} aria-hidden />
          Offline — grades are queued
          <button className="btn btn-ghost btn-sm" style={{ padding: "2px 8px" }} onClick={() => void flush()}>
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

// ─── The Review tab ───────────────────────────────────────────────────────────
function ReviewPage({
  deckId,
  online,
  syncToken,
  onClearDeckFilter,
  onOpenDeck,
}: {
  deckId: number | null;
  online: boolean;
  /** Bumped after a background sync so the queue refetches. */
  syncToken: number;
  onClearDeckFilter: () => void;
  onOpenDeck: (id: number) => void;
}) {
  const [data, setData] = useState<ReviewQueueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  /** The queue was rebuilt from this device's cache rather than the API. */
  const [fromCache, setFromCache] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        // `loadReviewData` is offline-aware: the API when reachable, the
        // cached schedules (same scheduling rules) otherwise.
        const payload = await loadReviewData(deckId, 50);
        if (signal?.aborted) return;
        setData(payload as ReviewQueueData);
        setFromCache(payload.offline);
      } catch (error) {
        if (signal?.aborted) return;
        showToast(
          error instanceof OfflineError
            ? "Nothing saved for offline review yet"
            : "Failed to load your review queue",
          CircleX
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [deckId]
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      await load(controller.signal);
    })();
    return () => controller.abort();
  }, [load, syncToken]);

  const finishSession = () => {
    setRunning(false);
    void load();
  };

  if (running && data && data.queue.length > 0) {
    return (
      <ReviewSession
        cards={data.queue}
        deckTitle={deckId ? data.decks.find((d) => d.sessionId === deckId)?.title : undefined}
        onExit={finishSession}
        onFinished={finishSession}
      />
    );
  }

  if (loading && !data) {
    return (
      <div style={{ padding: "20px 16px" }}>
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 16px", display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Brain size={21} aria-hidden />
          Daily Review
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="shimmer" style={{ height: i === 1 ? 130 : 72, borderRadius: 18 }} />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: "20px 16px", textAlign: "center" }}>
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 16px", display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Brain size={21} aria-hidden />
          Daily Review
        </h2>
        <div style={{ marginBottom: 10, color: "var(--text-muted)" }}>
          <Moon size={48} strokeWidth={1.5} aria-hidden />
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 16px" }}>
          Couldn&apos;t load your review queue right now.
        </p>
        <button className="btn btn-secondary" onClick={() => void load()}>
          <RefreshCw />
          Try again
        </button>
      </div>
    );
  }

  const { counts, decks, queue } = data;
  const activeDeck = deckId ? decks.find((d) => d.sessionId === deckId) : undefined;
  const startable = queue.length;

  return (
    <div className="animate-fade-in" style={{ padding: "20px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0, display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Brain size={21} aria-hidden />
          Daily Review
        </h2>
        <button className="btn btn-ghost btn-sm" onClick={() => void load()} style={{ padding: "6px 10px" }} aria-label="Refresh the review queue">
          <RefreshCw />
        </button>
      </div>

      {fromCache && (
        <OfflineNotice
          title="Offline — reviewing the schedule saved on this device"
          tone="warn"
          action={
            <OfflineRetryButton
              label="Check"
              onRetry={() => void probeConnection().then(() => load())}
            />
          }
        >
          Grades are queued here and applied to your schedule as soon as you
          reconnect.
        </OfflineNotice>
      )}

      {/* Today's workload */}
      <div className="glass-card clay-streak" style={{ color: "white", padding: "18px 20px", display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
        <div style={{ lineHeight: 1, flexShrink: 0 }}>
          {counts.due > 0 ? <Brain size={42} strokeWidth={1.5} aria-hidden /> : <PartyPopper size={42} strokeWidth={1.5} aria-hidden />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 26, fontWeight: 900, lineHeight: 1.1 }}>
            {counts.due} card{counts.due === 1 ? "" : "s"} due
          </div>
          <div style={{ fontSize: 13, opacity: 0.92, fontWeight: 600 }}>
            {counts.due === 0
              ? `All caught up — next card ${dueLabel(data.nextDueAt)}`
              : counts.learning > 0
                ? `${counts.learning} still in learning · ${counts.tracked} in rotation`
                : `${counts.tracked} card${counts.tracked === 1 ? "" : "s"} in rotation`}
          </div>
        </div>
        <div style={{ textAlign: "right", fontSize: 12, opacity: 0.92, flexShrink: 0 }}>
          <div style={{ fontWeight: 700 }}>New today</div>
          <div>
            {counts.newIntroducedToday ?? 0}/{counts.newPerDay}
          </div>
        </div>
      </div>

      {/* Deck filter */}
      <div className="review-chips">
        <button
          className={`review-chip ${deckId === null ? "active" : ""}`}
          onClick={onClearDeckFilter}
        >
          All decks
        </button>
        {decks.map((deck) => (
          <button
            key={deck.sessionId}
            className={`review-chip ${deckId === deck.sessionId ? "active" : ""}`}
            onClick={() => onOpenDeck(deck.sessionId)}
            title={deck.dueCount > 0 ? `${deck.dueCount} due now` : `Next ${deck.nextDueLabel}`}
          >
            {deck.title}
            {deck.dueCount > 0 && <span className="review-chip-count">{deck.dueCount}</span>}
          </button>
        ))}
      </div>

      {startable > 0 ? (
        <button className="btn btn-primary btn-lg" style={{ width: "100%", margin: "16px 0 10px" }} onClick={() => setRunning(true)}>
          <Play />
          {activeDeck ? `Review ${activeDeck.title}` : "Start review"} · {startable} card{startable === 1 ? "" : "s"}
        </button>
      ) : (
        <div className="glass-card" style={{ textAlign: "center", padding: "26px 20px", margin: "16px 0 10px" }}>
          <div style={{ marginBottom: 8, color: "#7c3aed" }}>
            <CircleCheckBig size={42} strokeWidth={1.5} aria-hidden />
          </div>
          <p style={{ margin: 0, fontWeight: 800, fontSize: 16 }}>Nothing due right now</p>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
            {counts.tracked === 0
              ? "Review a deck once and it enters the rotation — you'll see the cards again right before you'd forget them."
              : `Your next card comes back ${dueLabel(data.nextDueAt)}. Come back then, or keep studying in the meantime.`}
          </p>
        </div>
      )}

      {/* Where the numbers come from */}
      <div
        style={{
          background: "linear-gradient(135deg, #eff6ff, #ecfeff)",
          border: "1.5px solid #bfdbfe",
          borderRadius: 18,
          padding: "16px 16px",
          marginBottom: 16,
        }}
      >
        <h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 800, display: "flex", alignItems: "center", gap: 7 }}>
          <Info size={16} aria-hidden />
          How spaced repetition works
        </h3>
        {[
          "Answer a card, then say how it felt: Again, Hard, Good or Easy.",
          "Good multiplies the wait by the card's ease factor — each success pushes the next review further out.",
          "Again brings the card back in ten minutes and lowers its ease, so trouble spots return often.",
          "Cards you nail end up months apart: you study right before forgetting, not every day.",
        ].map((line, i) => (
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
            <Star size={14} aria-hidden style={{ flexShrink: 0, marginTop: 3, color: "#f59e0b" }} />
            <span>{line}</span>
          </div>
        ))}
      </div>

      {/* Upcoming per deck */}
      {decks.length > 0 && (
        <>
          <h3 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 12px", display: "flex", alignItems: "center", gap: 7 }}>
            <Layers size={17} aria-hidden />
            Deck schedules
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {decks.map((deck) => {
              const trackedPct = deck.cardCount > 0 ? Math.round((deck.trackedCount / deck.cardCount) * 100) : 0;
              return (
                <button
                  key={deck.sessionId}
                  className="glass-card"
                  style={{ padding: "14px 16px", textAlign: "left", border: "none", cursor: "pointer", font: "inherit", background: "var(--card)", color: "var(--text)" }}
                  onClick={() => onOpenDeck(deck.sessionId)}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {deck.title}
                      </p>
                      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
                        {deck.trackedCount}/{deck.cardCount} cards in rotation
                        {deck.newCount > 0 ? ` · ${deck.newCount} new` : ""}
                      </p>
                    </div>
                    <span
                      className="badge"
                      style={
                        deck.dueCount > 0
                          ? { background: "#ffe4e6", color: "#9f1239", fontWeight: 800, flexShrink: 0 }
                          : { background: "#d1fae5", color: "#047857", fontWeight: 800, flexShrink: 0 }
                      }
                    >
                      {deck.dueCount > 0 ? `${deck.dueCount} due` : `Next ${deck.nextDueLabel}`}
                    </span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${trackedPct}%` }} />
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}

      <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-muted)", marginTop: 18 }}>
        Reviews are saved to your account — stop any time and pick the queue back up on another device.
      </p>
    </div>
  );
}

// ─── Quiz Page ────────────────────────────────────────────────────────────────
function QuizPage({
  sessionId,
  cards,
  title,
  summary,
  online,
  offlineDeck,
  onSave,
  onBack,
  onEditDeck,
}: {
  sessionId?: number;
  cards: Flashcard[];
  title: string;
  summary: string;
  online: boolean;
  /** This deck was loaded from the device cache rather than the server. */
  offlineDeck?: boolean;
  onSave?: (title: string) => Promise<void>;
  onBack: () => void;
  /** Open the deck editor for this saved deck (rename / add / edit / reorder cards). */
  onEditDeck?: () => void;
}) {
  const [mode, setMode] = useState<QuizMode>("select");
  /** One "you're offline" toast per deck visit, not one per answer. */
  const queuedNotice = useRef(false);
  /** Consecutive misses inside the current scored run (Nibbles' pep talk). */
  const missRunRef = useRef(0);

  const noteQueued = useCallback(() => {
    if (queuedNotice.current) return;
    queuedNotice.current = true;
    showToast("Offline — your progress is saved here and syncs later", CloudUpload);
  }, []);

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

  // Load progress from server if we have a sessionId; the snapshot saved on
  // this device answers when there's no network.
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void (async () => {
      try {
        const data = await fetchJson<{ progress?: CardProgress[] }>(
          `/api/sessions/${sessionId}`
        );
        if (alive && data.progress) setProgress(data.progress);
      } catch {
        const deck = await readDecks().then((all) => all.find((d) => d.id === sessionId));
        if (alive && deck) {
          setProgress(
            deck.progress.map((p) => ({
              cardId: p.cardId,
              isKnown: p.isKnown,
              attempts: p.attempts,
            }))
          );
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId]);

  // ── Spaced repetition (P4) ────────────────────────────────────────────────
  // How many cards of this deck are due, surfaced on the mode card. One tiny
  // request per opened deck (it only needs the counts, hence limit=1).
  const [dueCount, setDueCount] = useState<number | null>(null);
  const [reviewCards, setReviewCards] = useState<DueCard[] | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewOffline, setReviewOffline] = useState(false);

  const refreshDueCount = useCallback(async () => {
    if (!sessionId) {
      setDueCount(null);
      return;
    }
    // Offline this falls back to the cached schedule, so the badge still
    // tells the truth about what's waiting.
    const { due } = await loadDeckDueCount(sessionId);
    setDueCount(due);
  }, [sessionId]);

  useEffect(() => {
    void (async () => {
      await refreshDueCount();
    })();
  }, [refreshDueCount]);

  /** Nibbles cheers the very first run on a brand-new deck (once per deck). */
  const cheerIfFreshDeck = () => {
    if (!sessionId) return;
    const key = `quiztime-mascot-firstrun:${sessionId}`;
    try {
      if (window.localStorage.getItem(key) === "1") return;
      // This deck already has history → not brand-new, no cheer.
      if (progress.some((p) => p.attempts > 0 || p.isKnown)) return;
      window.localStorage.setItem(key, "1");
    } catch {
      return; // storage blocked — skip the cheer rather than risk spam
    }
    mascotEvent({ type: "first-run" });
  };

  /** Fetch this deck's due queue, then hand over to the review runner. */
  const startReview = async () => {
    if (!sessionId) return;
    cheerIfFreshDeck();
    setReviewLoading(true);
    try {
      const data = await loadReviewData(sessionId, 50);
      setReviewCards(data.queue as DueCard[]);
      setReviewOffline(data.offline);
      setMode("review");
      if (data.offline) {
        showToast("Offline review — grades are saved and sync later", CloudUpload);
      }
    } catch (error) {
      showToast(
        error instanceof OfflineError
          ? "This set isn't saved on this device yet"
          : "Couldn't load your review queue",
        CircleX
      );
    } finally {
      setReviewLoading(false);
    }
  };

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
      // Sent now when possible, queued durably in the outbox when not. Either
      // way the UI never waits for the network.
      void (async () => {
        const outcome = await sendOrQueueWrite(`/api/sessions/${sessionId}`, "PATCH", {
          cardId,
          isKnown,
        });
        if (outcome === "queued") noteQueued();
        // Keep the offline snapshot's "known" count honest too.
        if (outcome !== "rejected") await saveProgressLocally(sessionId, cardId, isKnown);
      })();
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
    missRunRef.current = 0;
    cheerIfFreshDeck();
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

    // 🐹 In-run reactions: hot streaks cheer, three misses get a pep talk.
    if (isCorrect) {
      missRunRef.current = 0;
      if (
        newStreak === 3 ||
        newStreak === 5 ||
        newStreak === 10 ||
        (newStreak > 10 && newStreak % 5 === 0)
      ) {
        mascotEvent({ type: "streak", n: newStreak });
      }
    } else {
      missRunRef.current += 1;
      if (missRunRef.current === 3) mascotEvent({ type: "struggling" });
    }

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
  const switchMode = (m: "study" | ScoredMode | "review") => {
    if (m === "study") {
      // Respect the shuffle / unknown-only toggles if they're on.
      setActiveCards(buildStudyDeck(shuffleStudy, unknownOnly));
      setCurrentIndex(0);
      setDone(false);
      cheerIfFreshDeck();
      setMode("study");
    } else if (m === "review") {
      void startReview();
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
    } catch (error) {
      // Offline, the save handler explains that a connection is needed
      // ("your cards are kept as a draft") — pass that message through.
      showToast(
        error instanceof Error && error.message ? error.message : "Failed to save",
        CircleX
      );
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

  // 🐹 Nibbles cheers at the finish line — and nudges you to the next mode.
  useEffect(() => {
    if (!done || cards.length === 0) return;
    const known = progress.filter((p) => p.isKnown).length;
    mascotEvent({ type: "study-done", knownPct: Math.round((known / cards.length) * 100) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  useEffect(() => {
    if (!examDone) return;
    if (mode !== "exam" && mode !== "identify" && mode !== "enumerate") return;
    const correct = answers.filter((a) => a.isCorrect).length;
    const pct = answers.length ? Math.round((correct / answers.length) * 100) : 0;
    mascotEvent({ type: "scored-done", mode, pct });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examDone]);

  // 🐹 While a run is answering, Nibbles peeks in from the screen's edge.
  useEffect(() => {
    const active =
      (mode === "study" && !done) ||
      ((mode === "exam" || mode === "identify" || mode === "enumerate") && !examDone) ||
      mode === "review";
    mascotEvent({ type: "peek", active });
  }, [mode, done, examDone]);

  // Leaving the deck always ends the peek.
  useEffect(() => () => mascotEvent({ type: "peek", active: false }), []);

  return (
    <div style={{ padding: "16px" }}>
      {/* Offline: the deck (and every mode) came from this device's cache. */}
      {offlineDeck && (
        <OfflineNotice title="Offline study — saved on this device">
          All four modes work. Progress, scores and review grades are kept here
          and sync the moment you&apos;re back online.
        </OfflineNotice>
      )}
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
        {onEditDeck && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={onEditDeck}
            style={{ padding: "6px 10px", borderRadius: 12, flexShrink: 0 }}
            aria-label="Edit deck"
            title="Edit deck — rename, add, edit, reorder or delete cards"
          >
            <Pencil />
          </button>
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
            <button
              className={mode === "review" ? "active" : ""}
              onClick={() => switchMode("review")}
              disabled={!sessionId}
              title={sessionId ? "Spaced repetition review" : "Save this set to use spaced review"}
            >
              <Brain />
              Review
              {dueCount !== null && dueCount > 0 && (
                <span className="nav-badge" style={{ position: "static", transform: "none", marginLeft: 4 }}>
                  {dueCount}
                </span>
              )}
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
        <ModeSelect
          cardCount={cards.length}
          cards={cards}
          dueCount={dueCount}
          canReview={Boolean(sessionId) && !reviewLoading}
          onSelect={switchMode}
        />
      )}

      {mode === "review" && reviewCards && reviewCards.length > 0 && (
        <ReviewSession
          cards={reviewCards}
          deckTitle={title}
          onExit={() => setMode("select")}
          onFinished={() => {
            setMode("select");
            void refreshDueCount();
          }}
        />
      )}

      {mode === "review" && reviewCards && reviewCards.length === 0 && (
        <EmptyRun
          icon={CalendarClock}
          color="#7c3aed"
          title="Nothing due in this deck"
          message="Every scheduled card is still resting. Cards you find hard come back sooner — come back later, or study the deck in another mode in the meantime."
          onBackToModes={() => setMode("select")}
        />
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

// ─── Subjects (folders) + shared deck row ────────────────────────────────────

/** "Just now / 3h ago / Yesterday / Jun 4" — used by every list row. */
function formatRelativeDate(d: string) {
  const date = new Date(d);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const hours = diff / 3600000;
  if (hours < 1) return "Just now";
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  if (hours < 48) return "Yesterday";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Last-known subject list, so the folders still render on an offline boot. */
const SUBJECTS_CACHE_KEY = "quiztime:subjects";

function cacheSubjectsLocally(subjects: Subject[]) {
  try {
    window.localStorage.setItem(SUBJECTS_CACHE_KEY, JSON.stringify(subjects));
  } catch {
    /* storage blocked — subjects just won't render offline */
  }
}

async function readCachedSubjects(): Promise<Subject[]> {
  try {
    const raw = window.localStorage.getItem(SUBJECTS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Subject[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Folder-icon tints, cycled by subject id so folders feel colour-coded. */
const SUBJECT_FOLDER_TINTS = [
  { bg: "linear-gradient(135deg, #dbeafe, #e0e7ff)", color: "#1d4ed8" },
  { bg: "linear-gradient(135deg, #ede9fe, #f3e8ff)", color: "#6d28d9" },
  { bg: "linear-gradient(135deg, #d1fae5, #ecfdf5)", color: "#047857" },
  { bg: "linear-gradient(135deg, #ffe4e6, #fff1f2)", color: "#be123c" },
  { bg: "linear-gradient(135deg, #fef9c3, #fef3c7)", color: "#a16207" },
  { bg: "linear-gradient(135deg, #cffafe, #e0f2fe)", color: "#0e7490" },
];

const subjectTint = (id: number) => SUBJECT_FOLDER_TINTS[Math.abs(id) % SUBJECT_FOLDER_TINTS.length];

/**
 * A small clay dialog that asks for a name — used by "New Subject" and
 * "Rename subject". Enter submits; the confirm button shows a spinner while
 * the request is in flight.
 */
function NameModal({
  title,
  label,
  placeholder,
  confirmLabel,
  initial = "",
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  label: string;
  placeholder?: string;
  confirmLabel: string;
  initial?: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const name = value.trim();
    if (name && !busy) onConfirm(name);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        background: "rgba(16,35,63,0.45)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="glass-card animate-slide-up"
        style={{ width: "100%", maxWidth: 360, padding: "20px 18px" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h3 style={{ margin: "0 0 4px", fontSize: 17, fontWeight: 800, display: "flex", alignItems: "center", gap: 8 }}>
          <FolderPlus size={18} aria-hidden style={{ color: "#1d4ed8" }} />
          {title}
        </h3>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-muted)" }}>
          {label}
        </p>
        <input
          ref={inputRef}
          className="type-input"
          value={value}
          maxLength={60}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
          aria-label={label}
          style={{ marginBottom: 14 }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy || !value.trim()}>
            {busy ? "..." : (
              <>
                <FolderPlus />
                {confirmLabel}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The "Move to Subject" bottom sheet: file a study set into a folder (or
 * unfile it). Subjects are listed with their live set counts; creating a new
 * subject inline files the set straight into it.
 */
function MoveSheet({
  session,
  online,
  onClose,
  onMoved,
}: {
  session: StudySession;
  online: boolean;
  onClose: () => void;
  /** Called after a successful move (the parent refreshes its lists). */
  onMoved: (subjectId: number | null) => void;
}) {
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [selected, setSelected] = useState<number | null>(session.subjectId ?? null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const data = await fetchJson<{ subjects: Subject[] }>("/api/subjects", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setSubjects(data.subjects ?? []);
      } catch {
        if (!controller.signal.aborted) {
          showToast("Couldn't load your subjects", CircleX);
          setSubjects([]);
        }
      }
    })();
    return () => controller.abort();
  }, []);

  const applyMove = async (targetSubjectId: number | null, label: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId: targetSubjectId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to move set");
      showToast(label, FolderInput);
      onMoved(targetSubjectId);
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : "Failed to move set", CircleX);
    } finally {
      setBusy(false);
    }
  };

  /** Create a subject inline and select it immediately. */
  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await fetch("/api/subjects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create subject");
      const subject = data.subject as Subject;
      setSubjects((prev) => [...(prev ?? []), subject]);
      setSelected(subject.id);
      setCreating(false);
      setNewName("");
      showToast(`Subject “${subject.name}” created`, FolderPlus);
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : "Failed to create subject", CircleX);
    } finally {
      setBusy(false);
    }
  };

  const unchanged = selected === (session.subjectId ?? null);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(16,35,63,0.45)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="animate-slide-up"
        style={{
          width: "100%",
          maxWidth: 520,
          maxHeight: "80vh",
          overflowY: "auto",
          background: "var(--card)",
          borderRadius: "26px 26px 0 0",
          padding: "12px 18px calc(20px + env(safe-area-inset-bottom))",
          boxShadow: "0 -12px 30px rgba(43,80,180,0.25)",
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${session.title} to a subject`}
      >
        <div style={{ width: 40, height: 5, borderRadius: 999, background: "#dbe4f2", margin: "2px auto 14px" }} aria-hidden />
        <h3 style={{ margin: "0 0 14px", fontSize: 17, fontWeight: 800, textAlign: "center" }}>
          Move <span style={{ color: "#1d4ed8" }}>“{session.title}”</span> to…
        </h3>

        {subjects === null ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="shimmer" style={{ height: 56, borderRadius: 16 }} />
            ))}
          </div>
        ) : subjects.length === 0 && !creating ? (
          <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-muted)", textAlign: "center" }}>
            You have no subject folders yet — create your first one below.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            {subjects.map((subject) => {
              const tint = subjectTint(subject.id);
              const isSelected = selected === subject.id;
              const isCurrent = (session.subjectId ?? null) === subject.id;
              return (
                <button
                  key={subject.id}
                  onClick={() => setSelected(subject.id)}
                  className="glass-card"
                  style={{
                    padding: "12px 14px",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    width: "100%",
                    font: "inherit",
                    color: "var(--text)",
                    textAlign: "left",
                    cursor: "pointer",
                    border: isSelected ? "2px solid var(--blue)" : "2px solid transparent",
                    background: isSelected ? "#eff6ff" : undefined,
                  }}
                  aria-pressed={isSelected}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 11,
                      background: tint.bg,
                      color: tint.color,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <Folder size={20} strokeWidth={1.8} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {subject.name}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {subject.setCount} set{subject.setCount === 1 ? "" : "s"}
                      {isCurrent ? " · current" : ""}
                    </span>
                  </span>
                  {isSelected && (
                    <span aria-hidden style={{ color: "#1d4ed8", display: "flex", flexShrink: 0 }}>
                      <CircleCheckBig size={20} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {creating ? (
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <input
              className="type-input"
              autoFocus
              value={newName}
              maxLength={60}
              placeholder="New subject name"
              aria-label="New subject name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              style={{ flex: 1, padding: "10px 14px", fontSize: 14 }}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void handleCreate()}
              disabled={busy || !newName.trim()}
              style={{ flexShrink: 0 }}
            >
              {busy ? "..." : "Add"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setCreating(false)} disabled={busy} style={{ flexShrink: 0 }}>
              <X />
            </button>
          </div>
        ) : (
          <button
            className="glass-card"
            onClick={() => setCreating(true)}
            style={{
              width: "100%",
              padding: "12px 14px",
              marginBottom: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              font: "inherit",
              color: "#1d4ed8",
              fontWeight: 700,
              fontSize: 14,
              background: "#eff6ff",
              border: "2px dashed #93c5fd",
              cursor: "pointer",
            }}
          >
            <FolderPlus size={18} aria-hidden />
            Create new subject
          </button>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          {(session.subjectId ?? null) !== null && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void applyMove(null, "Removed from subject")}
              disabled={busy || !online}
              style={{ flex: 1, color: "#f43f5e" }}
            >
              <FolderOpen />
              Unfile
            </button>
          )}
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              const target = subjects?.find((s) => s.id === selected);
              void applyMove(selected, target ? `Moved to “${target.name}”` : "Set moved");
            }}
            disabled={busy || !online || unchanged || selected === null}
            style={{ flex: 2 }}
          >
            {busy ? "..." : (
              <>
                <FolderInput />
                Move here
              </>
            )}
          </button>
        </div>
        {!online && (
          <p style={{ margin: "10px 0 0", fontSize: 12, color: "#9f1239", textAlign: "center", fontWeight: 600 }}>
            You&apos;re offline — moving sets needs a connection.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * One study-set row — the exact card used by "My Study Sets" and the subject
 * pages, so both lists always look and behave the same. Tap to study; the
 * side buttons pin offline, jump to review, edit, move to a subject, delete.
 */
function DeckRow({
  session,
  index,
  online,
  deleting,
  offlineBusy,
  offlineDecks,
  onOpen,
  onReviewDeck,
  onEditDeck,
  onDelete,
  onToggleOffline,
  onMove,
}: {
  session: StudySession;
  index: number;
  online: boolean;
  /** Deck currently being deleted (spinner in the trash button). */
  deleting: number | null;
  offlineBusy: boolean;
  offlineDecks: Map<number, string>;
  onOpen: (id: number) => void;
  onReviewDeck: (id: number) => void;
  onEditDeck: (id: number) => void;
  onDelete: (id: number, e: React.MouseEvent) => void;
  onToggleOffline: (id: number, saved: boolean) => void;
  /** Open the "Move to subject" sheet — the little folder button. */
  onMove: (session: StudySession) => void;
}) {
  return (
    <div
      className="glass-card animate-fade-in"
      style={{
        padding: "16px",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 14,
        animationDelay: `${index * 0.05}s`,
        transition: "transform 0.15s",
      }}
      onClick={() =>
        offlineDecks.has(session.id) || online
          ? onOpen(session.id)
          : showToast("This set isn't saved on this device yet", CloudOff)
      }
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
            {session.cardCount} card{session.cardCount === 1 ? "" : "s"} · {formatRelativeDate(session.createdAt)}
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
          {typeof session.dueCount === "number" && session.dueCount > 0 && (
            <span className="badge" style={{ background: "#ffe4e6", color: "#9f1239" }}>
              {session.dueCount} due
            </span>
          )}
          {offlineDecks.has(session.id) && (
            <OfflineBadge savedAt={offlineDecks.get(session.id)} />
          )}
        </p>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <OfflinePinButton
          title={session.title}
          saved={offlineDecks.has(session.id)}
          busy={offlineBusy}
          onToggle={() =>
            onToggleOffline(session.id, offlineDecks.has(session.id))
          }
        />
        {Boolean(session.dueCount) && (
          <button
            className="btn btn-primary btn-sm"
            style={{ padding: "6px 10px" }}
            onClick={(e) => {
              e.stopPropagation();
              onReviewDeck(session.id);
            }}
            aria-label={`Review ${session.dueCount} due cards in ${session.title}`}
          >
            <Brain />
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm"
          style={{ padding: "6px", color: "#1d4ed8" }}
          onClick={(e) => {
            e.stopPropagation();
            onMove(session);
          }}
          aria-label={`Move ${session.title} to a subject`}
          title="Move to subject"
        >
          <FolderInput />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          style={{ padding: "6px", opacity: online ? 1 : 0.5 }}
          onClick={(e) => {
            e.stopPropagation();
            onEditDeck(session.id);
          }}
          aria-label={`Edit ${session.title}`}
        >
          <Pencil />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          style={{ padding: "6px", color: "#f43f5e", opacity: deleting === session.id ? 0.5 : 1 }}
          onClick={(e) => onDelete(session.id, e)}
          disabled={deleting === session.id}
          aria-label={`Delete ${session.title}`}
        >
          <Trash />
        </button>
        <ArrowRight aria-hidden />
      </div>
    </div>
  );
}

// ─── Subject Page (the sets inside one subject folder) ───────────────────────
function SubjectPage({
  subject,
  online,
  syncToken,
  offlineBusy,
  onToggleOffline,
  onOfflineChanged,
  onOpen,
  onReviewDeck,
  onEditDeck,
  onCreateSet,
  onBack,
  onRenamed,
}: {
  subject: { id: number; name: string };
  online: boolean;
  syncToken: number;
  offlineBusy: boolean;
  onToggleOffline: (id: number, saved: boolean) => void;
  onOfflineChanged: () => void;
  onOpen: (id: number) => void;
  onReviewDeck: (id: number) => void;
  onEditDeck: (id: number) => void;
  /** Open the deck editor pre-filed into this subject. */
  onCreateSet: () => void;
  onBack: () => void;
  /** The subject was renamed — the parent updates its header state. */
  onRenamed: (name: string) => void;
}) {
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [deletingSubject, setDeletingSubject] = useState(false);
  const [offlineDecks, setOfflineDecks] = useState<Map<number, string>>(new Map());
  const [fromCache, setFromCache] = useState(false);
  const [moveSheet, setMoveSheet] = useState<StudySession | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const refreshOfflineDecks = useCallback(async () => {
    const decks = await readDecks();
    setOfflineDecks(new Map(decks.map((deck) => [deck.id, deck.savedAt])));
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const data = await fetchJson<{ sessions: StudySession[] }>(
          "/api/sessions",
          signal ? { signal } : undefined
        );
        if (signal?.aborted) return;
        setSessions((data.sessions || []).filter((s) => s.subjectId === subject.id));
        setFromCache(false);
        void refreshOfflineDecks();
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof HttpError) {
          showToast("Failed to load this subject's sets", CircleX);
          return;
        }
        const rows = await loadOfflineSessionList();
        if (signal?.aborted) return;
        setSessions(rows.filter((s) => s.subjectId === subject.id));
        setFromCache(true);
        await refreshOfflineDecks();
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [refreshOfflineDecks, subject.id]
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      await load(controller.signal);
    })();
    return () => controller.abort();
  }, [load, syncToken]);

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!online) {
      showToast("Deleting needs a connection", CloudOff);
      return;
    }
    if (!confirm("Delete this study set?")) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await forgetDeckOffline(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      showToast("Deleted!", Trash);
      onOfflineChanged();
    } catch {
      showToast("Failed to delete", CircleX);
    } finally {
      setDeleting(null);
    }
  };

  const handleEdit = (id: number) => {
    if (!online) {
      showToast("Editing sets needs a connection", CloudOff);
      return;
    }
    onEditDeck(id);
  };

  const handleOpen = (id: number) => {
    if (offlineDecks.has(id) || online) {
      onOpen(id);
    } else {
      showToast("This set isn't saved on this device yet", CloudOff);
    }
  };

  /** Rename the folder itself (the sets inside are untouched). */
  const handleRename = async (name: string) => {
    setRenaming(true);
    try {
      const res = await fetch(`/api/subjects/${subject.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to rename subject");
      setRenameOpen(false);
      onRenamed(data.subject.name);
      showToast("Subject renamed", CircleCheckBig);
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : "Failed to rename subject", CircleX);
    } finally {
      setRenaming(false);
    }
  };

  /** Delete the folder — the sets fall back to "All Sets", never deleted. */
  const handleDeleteSubject = async () => {
    if (!online) {
      showToast("Deleting needs a connection", CloudOff);
      return;
    }
    const n = sessions.length;
    const warning =
      n > 0
        ? `Delete the “${subject.name}” subject?\n\nIts ${n} study set${n === 1 ? "" : "s"} will NOT be deleted — they'll go back to All Sets.`
        : `Delete the “${subject.name}” subject?`;
    if (!confirm(warning)) return;
    setDeletingSubject(true);
    try {
      const res = await fetch(`/api/subjects/${subject.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete subject");
      }
      showToast("Subject deleted — its sets are in All Sets", FolderOpen);
      onOfflineChanged();
      onBack();
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : "Failed to delete subject", CircleX);
    } finally {
      setDeletingSubject(false);
    }
  };

  const openMoveSheet = (session: StudySession) => {
    if (!online) {
      showToast("Moving sets needs a connection", CloudOff);
      return;
    }
    setMoveSheet(session);
  };

  const tint = subjectTint(subject.id);

  return (
    <div style={{ padding: "20px 16px" }}>
      {/* Header: back, folder identity, rename/delete, and the "+ New Set"
          creator that files straight into this subject. */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={onBack}
          style={{ padding: "6px 10px", borderRadius: 12 }}
          aria-label="Back to My Study Sets"
        >
          <ArrowLeft />
        </button>
        <span
          aria-hidden
          style={{
            width: 46,
            height: 46,
            borderRadius: 13,
            background: tint.bg,
            color: tint.color,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Folder size={24} strokeWidth={1.8} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {subject.name}
          </h2>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>
            {loading ? "…" : `${sessions.length} set${sessions.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            if (!online) {
              showToast("Renaming needs a connection", CloudOff);
              return;
            }
            setRenameOpen(true);
          }}
          style={{ padding: "6px" }}
          aria-label={`Rename ${subject.name}`}
          title="Rename subject"
        >
          <Pencil />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => void handleDeleteSubject()}
          disabled={deletingSubject}
          style={{ padding: "6px", color: "#f43f5e" }}
          aria-label={`Delete ${subject.name}`}
          title="Delete subject (sets are kept)"
        >
          <Trash />
        </button>
        <button className="btn btn-primary btn-sm" onClick={onCreateSet} style={{ padding: "6px 12px", flexShrink: 0 }}>
          <Plus />
          New Set
        </button>
      </div>

      {fromCache && (
        <OfflineNotice
          title="Offline — showing the sets saved on this device"
          action={<OfflineRetryButton onRetry={() => void load()} busy={false} />}
        >
          Every study mode works here. Answers sync the moment you&apos;re back online.
        </OfflineNotice>
      )}

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="shimmer" style={{ height: 80, borderRadius: 16 }} />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 20px" }}>
          <div style={{ marginBottom: 16, color: "var(--text-muted)" }}>
            <Inbox size={64} strokeWidth={1.5} aria-hidden />
          </div>
          <h3 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>Nothing in “{subject.name}” yet</h3>
          <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 16px" }}>
            Create a set straight into this subject — or move one in from All Sets with the folder button.
          </p>
          <button className="btn btn-primary btn-sm" onClick={onCreateSet}>
            <Plus />
            New Set
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {sessions.map((session, i) => (
            <DeckRow
              key={session.id}
              session={session}
              index={i}
              online={online}
              deleting={deleting}
              offlineBusy={offlineBusy}
              offlineDecks={offlineDecks}
              onOpen={handleOpen}
              onReviewDeck={onReviewDeck}
              onEditDeck={handleEdit}
              onDelete={handleDelete}
              onToggleOffline={onToggleOffline}
              onMove={openMoveSheet}
            />
          ))}

          {/* Always-visible manual creator at the end of the list. */}
          <button
            onClick={onCreateSet}
            style={{
              width: "100%",
              padding: "14px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              font: "inherit",
              color: "#1d4ed8",
              fontWeight: 700,
              fontSize: 14,
              background: "#eff6ff",
              border: "2px dashed #93c5fd",
              borderRadius: 20,
              cursor: "pointer",
            }}
          >
            <Plus size={18} aria-hidden />
            Add set manually
          </button>
        </div>
      )}

      {moveSheet && (
        <MoveSheet
          session={moveSheet}
          online={online}
          onClose={() => setMoveSheet(null)}
          onMoved={() => {
            setMoveSheet(null);
            onOfflineChanged();
          }}
        />
      )}

      {renameOpen && (
        <NameModal
          title="Rename Subject"
          label="Give this subject folder a new name."
          placeholder="Subject name"
          confirmLabel="Save Name"
          initial={subject.name}
          busy={renaming}
          onClose={() => setRenameOpen(false)}
          onConfirm={handleRename}
        />
      )}
    </div>
  );
}

// ─── Sessions Page ────────────────────────────────────────────────────────────
function SessionsPage({
  online,
  syncToken,
  offlineBusy,
  onDownloadAll,
  onToggleOffline,
  onOfflineChanged,
  onOpen,
  onReviewDeck,
  onEditDeck,
  onOpenSubject,
}: {
  online: boolean;
  /** Bumped after a background sync so the list refreshes its numbers. */
  syncToken: number;
  offlineBusy: boolean;
  /** Freeze every set on this device ("Download all"). */
  onDownloadAll: () => void;
  /** Save/remove one deck in offline storage (`saved` = already stored). */
  onToggleOffline: (id: number, saved: boolean) => void;
  /** Tell the app the offline storage changed (badges, Home card). */
  onOfflineChanged: () => void;
  onOpen: (id: number) => void;
  /** Jump straight into the spaced-repetition queue for one deck. */
  onReviewDeck: (id: number) => void;
  /** Open the deck editor — a deck id to edit, or null for a new manual deck. */
  onEditDeck: (id: number | null) => void;
  /** Drill into a subject folder's page. */
  onOpenSubject: (subject: { id: number; name: string }) => void;
}) {
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<number | null>(null);
  /** deck id → when its offline snapshot was taken (drives the badge/pin). */
  const [offlineDecks, setOfflineDecks] = useState<Map<number, string>>(new Map());
  /** True when the list below came from the device cache, not the server. */
  const [fromCache, setFromCache] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  // ── Subject folders + search ──────────────────────────────────────────────
  const [subjects, setSubjects] = useState<Subject[]>([]);
  /** Search box text — filters subjects AND sets (empty = show everything). */
  const [query, setQuery] = useState("");
  /** The "Move to subject" bottom sheet: the set being filed, if any. */
  const [moveSheet, setMoveSheet] = useState<StudySession | null>(null);
  /** The "name your new subject" dialog. */
  const [newSubjectOpen, setNewSubjectOpen] = useState(false);
  const [creatingSubject, setCreatingSubject] = useState(false);

  const refreshOfflineDecks = useCallback(async () => {
    const decks = await readDecks();
    setOfflineDecks(new Map(decks.map((deck) => [deck.id, deck.savedAt])));
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        // Sessions (with per-subject filing) and the subject folders come
        // from two endpoints; a failure of either shouldn't blank the page,
        // so the subjects fetch degrades to the last cached copy.
        const [data, subjectsResult] = await Promise.all([
          fetchJson<{ sessions: StudySession[] }>("/api/sessions", signal ? { signal } : undefined),
          fetchJson<{ subjects: Subject[] }>("/api/subjects", signal ? { signal } : undefined)
            .then((res) => res.subjects ?? [])
            .catch(() => null),
        ]);
        if (signal?.aborted) return;
        setSessions(data.sessions || []);
        setFromCache(false);
        if (subjectsResult) {
          setSubjects(subjectsResult);
          cacheSubjectsLocally(subjectsResult);
        }
        void refreshOfflineDecks();
      } catch (error) {
        if (signal?.aborted) return;
        // The server answered but refused — that's not an offline situation.
        if (error instanceof HttpError) {
          showToast("Failed to load sessions", CircleX);
          return;
        }
        // No network: rebuild the list from this device's snapshots.
        const rows = await loadOfflineSessionList();
        if (signal?.aborted) return;
        setSessions(rows);
        setFromCache(true);
        // Subject names aren't in the deck snapshots — use the cached copy.
        setSubjects(await readCachedSubjects());
        await refreshOfflineDecks();
        if (rows.length === 0) {
          showToast("No sets saved on this device yet", CloudOff);
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [refreshOfflineDecks]
  );

  // Load on mount. The request is kicked off from an async IIFE so the effect
  // body never calls setState synchronously, and the fetch is aborted if the
  // screen unmounts before it settles. `syncToken` re-runs it after a
  // background sync so counts stay current.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      await load(controller.signal);
    })();
    return () => controller.abort();
  }, [load, syncToken]);

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!online) {
      showToast("Deleting needs a connection", CloudOff);
      return;
    }
    if (!confirm("Delete this study set?")) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // The deck is gone server-side — drop this device's copy too, so it
      // can't come back from the dead offline.
      await forgetDeckOffline(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      showToast("Deleted!", Trash);
      onOfflineChanged();
    } catch {
      showToast("Failed to delete", CircleX);
    } finally {
      setDeleting(null);
    }
  };

  const handleEdit = (id: number | null) => {
    if (!online) {
      showToast("Editing sets needs a connection", CloudOff);
      return;
    }
    onEditDeck(id);
  };

  const handleReconnect = async () => {
    setReconnecting(true);
    try {
      const back = await probeConnection();
      await load();
      showToast(back ? "Back online!" : "Still offline — nothing to worry about", back ? CircleCheckBig : CloudOff);
    } finally {
      setReconnecting(false);
    }
  };

  // ── Search: filter subjects by name and sets by title (case-insensitive).
  const q = query.trim().toLowerCase();
  const filteredSubjects = q
    ? subjects.filter((s) => s.name.toLowerCase().includes(q))
    : subjects;
  const filteredSessions = q
    ? sessions.filter((s) => s.title.toLowerCase().includes(q))
    : sessions;

  /** "Move to subject" sheet opener — passed down to every deck row. */
  const openMoveSheet = (session: StudySession) => {
    if (!online) {
      showToast("Moving sets needs a connection", CloudOff);
      return;
    }
    setMoveSheet(session);
  };

  /** Create a subject folder from the "+ New Subject" dialog. */
  const handleCreateSubject = async (name: string) => {
    setCreatingSubject(true);
    try {
      const res = await fetch("/api/subjects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create subject");
      setSubjects((prev) => {
        const next = [...prev, data.subject as Subject];
        cacheSubjectsLocally(next);
        return next;
      });
      setNewSubjectOpen(false);
      showToast(`Subject “${data.subject.name}” created`, FolderPlus);
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : "Failed to create subject", CircleX);
    } finally {
      setCreatingSubject(false);
    }
  };

  return (
    <div style={{ padding: "20px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0, display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Library size={21} aria-hidden />
          My Study Sets
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            className="btn btn-white-clay btn-sm"
            onClick={onDownloadAll}
            disabled={!online || offlineBusy}
            style={{ padding: "6px 10px" }}
            aria-label="Save every set for offline study"
            title={online ? "Save every set for offline study" : "Connect to save sets offline"}
          >
            {offlineBusy ? (
              <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2, margin: 0 }} aria-hidden />
            ) : (
              <CloudDownload />
            )}
          </button>
          {/* A hand-built set that starts OUTSIDE any subject folder. */}
          <button
            className="btn btn-white-clay btn-sm"
            onClick={() => handleEdit(null)}
            style={{ padding: "6px 10px" }}
            aria-label="Create a study set manually"
            title="Create a study set manually"
          >
            <Plus />
            Set
          </button>
          {/* The subject creator — folders are the top-level organiser. */}
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              if (!online) {
                showToast("Creating subjects needs a connection", CloudOff);
                return;
              }
              setNewSubjectOpen(true);
            }}
            style={{ padding: "6px 12px" }}
          >
            <FolderPlus />
            New Subject
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => load()} style={{ padding: "6px 10px" }} aria-label="Refresh study sets">
            <RefreshCw />
          </button>
        </div>
      </div>

      {/* Search — filters both the subject folders and the sets below, so a
          big library never needs endless scrolling. */}
      <div style={{ position: "relative", marginBottom: 16 }}>
        <Search
          size={17}
          aria-hidden
          style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "#9db4d0", pointerEvents: "none" }}
        />
        <input
          className="type-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search subjects or sets"
          aria-label="Search subjects or study sets"
          style={{ padding: "11px 38px 11px 42px", fontSize: 14 }}
        />
        {query && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setQuery("")}
            style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", padding: "6px", color: "var(--text-muted)" }}
            aria-label="Clear search"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {fromCache && (
        <OfflineNotice
          title="Offline — showing the sets saved on this device"
          action={<OfflineRetryButton onRetry={() => void handleReconnect()} busy={reconnecting} />}
        >
          Every study mode works here. Answers, grades and progress are kept on this
          device and sync the moment you&apos;re back online.
        </OfflineNotice>
      )}

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="shimmer" style={{ height: 80, borderRadius: 16 }} />
          ))}
        </div>
      ) : sessions.length === 0 && subjects.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ marginBottom: 16, color: "var(--text-muted)" }}>
            <Inbox size={64} strokeWidth={1.5} aria-hidden />
          </div>
          <h3 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>No study sets yet!</h3>
          <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 16px" }}>
            Upload a PDF or image to create your first flashcard set — or build one yourself, card by card.
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => handleEdit(null)}>
            <PenLine />
            Create manually
          </button>
        </div>
      ) : (
        <>
          {/* ── Subjects: full-width folder rows, one per subject ───────── */}
          {(subjects.length > 0 || filteredSubjects.length > 0) && (
            <section style={{ marginBottom: 22 }}>
              <h3 style={{ fontSize: 15, fontWeight: 800, margin: "0 0 10px", display: "flex", alignItems: "center", gap: 7, color: "var(--text)" }}>
                <Folder size={16} aria-hidden style={{ color: "#1d4ed8" }} />
                Subjects
                {q && (
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)" }}>
                    {filteredSubjects.length} match{filteredSubjects.length === 1 ? "" : "es"}
                  </span>
                )}
              </h3>
              {filteredSubjects.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {filteredSubjects.map((subject, i) => {
                    const tint = subjectTint(subject.id);
                    return (
                      <button
                        key={subject.id}
                        className="glass-card animate-fade-in"
                        onClick={() => onOpenSubject(subject)}
                        style={{
                          padding: "16px",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: 14,
                          width: "100%",
                          font: "inherit",
                          color: "var(--text)",
                          textAlign: "left",
                          animationDelay: `${i * 0.05}s`,
                          transition: "transform 0.15s",
                        }}
                        onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.98)")}
                        onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
                        onTouchStart={(e) => (e.currentTarget.style.transform = "scale(0.98)")}
                        onTouchEnd={(e) => (e.currentTarget.style.transform = "scale(1)")}
                      >
                        <span
                          aria-hidden
                          style={{
                            width: 52,
                            height: 52,
                            borderRadius: 14,
                            background: tint.bg,
                            color: tint.color,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <Folder size={26} strokeWidth={1.8} />
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "block", margin: "0 0 3px", fontWeight: 700, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {subject.name}
                          </span>
                          <span style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
                            {subject.setCount} set{subject.setCount === 1 ? "" : "s"}
                          </span>
                        </span>
                        <ArrowRight aria-hidden style={{ color: "var(--text-muted)", flexShrink: 0 }} size={20} />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
                  No subjects match “{query}”.
                </p>
              )}
            </section>
          )}

          {/* ── All Sets: every study set, filed or not ─────────────────── */}
          <section>
            <h3 style={{ fontSize: 15, fontWeight: 800, margin: "0 0 10px", display: "flex", alignItems: "center", gap: 7, color: "var(--text)" }}>
              <Layers size={16} aria-hidden style={{ color: "#1d4ed8" }} />
              All Sets
              {q && (
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)" }}>
                  {filteredSessions.length} match{filteredSessions.length === 1 ? "" : "es"}
                </span>
              )}
            </h3>
            {filteredSessions.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {filteredSessions.map((session, i) => (
                  <DeckRow
                    key={session.id}
                    session={session}
                    index={i}
                    online={online}
                    deleting={deleting}
                    offlineBusy={offlineBusy}
                    offlineDecks={offlineDecks}
                    onOpen={onOpen}
                    onReviewDeck={onReviewDeck}
                    onEditDeck={handleEdit}
                    onDelete={handleDelete}
                    onToggleOffline={onToggleOffline}
                    onMove={openMoveSheet}
                  />
                ))}
              </div>
            ) : q ? (
              <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
                No sets match “{query}”.
              </p>
            ) : (
              <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
                No sets here yet — tap <strong>Set</strong> to build one manually, or create a subject above.
              </p>
            )}
          </section>
        </>
      )}

      {/* Move a set into a subject folder (bottom sheet). */}
      {moveSheet && (
        <MoveSheet
          session={moveSheet}
          online={online}
          onClose={() => setMoveSheet(null)}
          onMoved={() => {
            setMoveSheet(null);
            onOfflineChanged();
          }}
        />
      )}

      {/* Name-your-subject dialog for the "+ New Subject" button. */}
      {newSubjectOpen && (
        <NameModal
          title="New Subject"
          label="Subject name"
          placeholder="e.g. Biology, Pharmacology…"
          confirmLabel="Create Subject"
          busy={creatingSubject}
          onClose={() => setNewSubjectOpen(false)}
          onConfirm={handleCreateSubject}
        />
      )}
    </div>
  );
}

// ─── Deck Editor (rename, manual decks, card add/edit/delete/reorder) ───────
/** A card being edited locally; `id` is set once the card exists on the server. */
interface EditorCard {
  /** Stable local identity for React (server ids are absent on new cards). */
  key: number;
  id?: number;
  question: string;
  answer: string;
  hint: string;
  difficulty: string;
}

const EDITOR_FIELD_STYLE: React.CSSProperties = {
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
  transition: "border-color 0.2s, box-shadow 0.2s, background 0.2s",
};

/** Pressed-in clay focus treatment, shared by every editor field. */
const editorFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
  e.target.style.borderColor = "var(--blue)";
  e.target.style.background = "white";
};
const editorBlur = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
  e.target.style.borderColor = "#ffffff";
  e.target.style.background = "#e9efff";
};

function DeckEditorPage({
  sessionId,
  subject,
  onExit,
}: {
  /** null → create a brand-new manual deck; a number → edit that deck. */
  sessionId: number | null;
  /** Pre-files a NEW deck into this subject folder (from a subject page). */
  subject?: { id: number; name: string } | null;
  /** Leave the editor. `savedId` is the deck id when changes were saved. */
  onExit: (savedId: number | null) => void;
}) {
  const [loading, setLoading] = useState(sessionId !== null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [cards, setCards] = useState<EditorCard[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const keySeq = useRef(0);
  const nextKey = () => ++keySeq.current;

  // Load the deck (edit mode only). New manual decks start empty.
  useEffect(() => {
    if (sessionId === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`, { signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setTitle(data.session?.title ?? "");
        setSummary(data.session?.summary ?? "");
        setCards(
          (data.cards ?? []).map((c: { id: number; question: string; answer: string; hint?: string | null; difficulty?: string }) => ({
            key: nextKey(),
            id: c.id,
            question: c.question ?? "",
            answer: c.answer ?? "",
            hint: c.hint ?? "",
            difficulty: c.difficulty ?? "medium",
          }))
        );
      } catch {
        if (controller.signal.aborted) return;
        setLoadFailed(true);
        showToast("Failed to load deck", CircleX);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [sessionId]);

  const updateCard = (key: number, patch: Partial<EditorCard>) => {
    setCards((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
    setDirty(true);
  };

  const addCard = () => {
    setCards((prev) => [
      ...prev,
      { key: nextKey(), question: "", answer: "", hint: "", difficulty: "medium" },
    ]);
    setDirty(true);
  };

  const removeCard = (key: number) => {
    setCards((prev) => prev.filter((c) => c.key !== key));
    setDirty(true);
  };

  /** Swap a card with its neighbour — the reorder control (works on touch too). */
  const moveCard = (index: number, dir: -1 | 1) => {
    setCards((prev) => {
      const j = index + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
    setDirty(true);
  };

  const handleBack = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    onExit(null);
  };

  const handleSave = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      showToast("Give your deck a title first", TriangleAlert);
      return;
    }
    if (cards.length === 0) {
      showToast("Add at least one card", TriangleAlert);
      return;
    }
    for (let i = 0; i < cards.length; i++) {
      if (!cards[i].question.trim() || !cards[i].answer.trim()) {
        showToast(`Card ${i + 1} needs a question and an answer`, TriangleAlert);
        return;
      }
    }

    setSaving(true);
    try {
      const payload = cards.map((c) => ({
        ...(c.id !== undefined ? { id: c.id } : {}),
        question: c.question.trim(),
        answer: c.answer.trim(),
        hint: c.hint.trim() || null,
        difficulty: c.difficulty,
      }));

      let savedId: number;
      if (sessionId === null) {
        // Brand-new manual deck — the plain create endpoint does it all.
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: trimmedTitle,
            sourceType: "manual",
            summary: summary.trim() || undefined,
            // Created from inside a subject folder → file it there directly.
            subjectId: subject?.id,
            cards: payload,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to create deck");
        savedId = data.session.id;
      } else {
        savedId = sessionId;
        // Rename / summary first, then the bulk card save.
        const metaRes = await fetch(`/api/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmedTitle, summary: summary.trim() }),
        });
        const metaData = await metaRes.json();
        if (!metaRes.ok) throw new Error(metaData.error || "Failed to rename deck");

        const cardsRes = await fetch(`/api/sessions/${sessionId}/cards`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cards: payload }),
        });
        const cardsData = await cardsRes.json();
        if (!cardsRes.ok) throw new Error(cardsData.error || "Failed to save cards");
      }

      setDirty(false);
      showToast(sessionId === null ? "Study set created!" : "Changes saved!", CircleCheckBig);
      onExit(savedId);
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : "Failed to save", CircleX);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: "20px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="shimmer" style={{ height: 44, borderRadius: 16 }} />
        <div className="shimmer" style={{ height: 120, borderRadius: 16 }} />
        <div className="shimmer" style={{ height: 160, borderRadius: 16 }} />
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div style={{ padding: "20px 16px", textAlign: "center" }}>
        <div style={{ marginBottom: 12, color: "var(--text-muted)" }}>
          <CircleX size={56} strokeWidth={1.5} aria-hidden />
        </div>
        <h3 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 12px" }}>Couldn&apos;t load this deck</h3>
        <button className="btn btn-secondary btn-sm" onClick={() => onExit(null)}>
          <ArrowLeft />
          Back
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: "16px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button className="btn btn-ghost btn-sm" onClick={handleBack} style={{ padding: "6px 10px", borderRadius: 12 }} aria-label="Back">
          <ArrowLeft />
        </button>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {sessionId === null ? "New Study Set" : "Edit Study Set"}
        </h2>
        {subject && (
          <span
            title={`This set will be filed under the “${subject.name}” subject`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              background: "#dbeafe",
              color: "#1d4ed8",
              fontSize: 12,
              fontWeight: 700,
              padding: "4px 10px",
              borderRadius: 999,
              maxWidth: 130,
              flexShrink: 0,
            }}
          >
            <Folder size={13} aria-hidden style={{ flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subject.name}</span>
          </span>
        )}
        <button
          className="btn btn-primary btn-sm"
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
      </div>

      {/* Deck details (rename) */}
      <div className="glass-card" style={{ padding: 14, marginBottom: 14 }}>
        <label style={{ display: "block", fontSize: 12, fontWeight: 800, color: "var(--text-muted)", marginBottom: 6 }}>
          Title
        </label>
        <input
          value={title}
          onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
          onFocus={editorFocus}
          onBlur={editorBlur}
          placeholder="e.g. Biology Chapter 3"
          maxLength={120}
          style={{ ...EDITOR_FIELD_STYLE, fontSize: 15, fontWeight: 700, marginBottom: 12 }}
          aria-label="Deck title"
        />
        <label style={{ display: "block", fontSize: 12, fontWeight: 800, color: "var(--text-muted)", marginBottom: 6 }}>
          Description <span style={{ fontWeight: 600 }}>(optional)</span>
        </label>
        <input
          value={summary}
          onChange={(e) => { setSummary(e.target.value); setDirty(true); }}
          onFocus={editorFocus}
          onBlur={editorBlur}
          placeholder="A short description of this deck"
          maxLength={500}
          style={EDITOR_FIELD_STYLE}
          aria-label="Deck description"
        />
      </div>

      {/* Cards */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 2px 10px" }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, display: "inline-flex", alignItems: "center", gap: 7 }}>
          <Layers size={16} aria-hidden />
          Cards
          <span className="badge" style={{ background: "#dbeafe", color: "#1d4ed8" }}>{cards.length}</span>
        </h3>
        <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>
          Order matters — use the arrows
        </span>
      </div>

      {cards.length === 0 && (
        <div className="glass-card" style={{ padding: "28px 16px", textAlign: "center", marginBottom: 12 }}>
          <div style={{ marginBottom: 10, color: "var(--text-muted)" }}>
            <Inbox size={44} strokeWidth={1.5} aria-hidden />
          </div>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
            No cards yet — add your first one below.
          </p>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 14 }}>
        {cards.map((card, i) => (
          <div key={card.key} className="glass-card animate-fade-in" style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span className="badge" style={{ background: "#eef2ff", color: "#4338ca", flexShrink: 0 }}>
                Card {i + 1}
              </span>
              <select
                value={card.difficulty}
                onChange={(e) => updateCard(card.key, { difficulty: e.target.value })}
                onFocus={editorFocus}
                onBlur={editorBlur}
                aria-label={`Difficulty for card ${i + 1}`}
                style={{ ...EDITOR_FIELD_STYLE, width: "auto", padding: "5px 8px", fontSize: 12, borderRadius: 10 }}
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ padding: 5 }}
                  onClick={() => moveCard(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move card ${i + 1} up`}
                >
                  <ChevronUp />
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ padding: 5 }}
                  onClick={() => moveCard(i, 1)}
                  disabled={i === cards.length - 1}
                  aria-label={`Move card ${i + 1} down`}
                >
                  <ChevronDown />
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ padding: 5, color: "#f43f5e" }}
                  onClick={() => removeCard(card.key)}
                  aria-label={`Delete card ${i + 1}`}
                >
                  <Trash />
                </button>
              </div>
            </div>

            <textarea
              className="clay-textarea"
              value={card.question}
              onChange={(e) => updateCard(card.key, { question: e.target.value })}
              onFocus={editorFocus}
              onBlur={editorBlur}
              placeholder="Question"
              rows={2}
              aria-label={`Question for card ${i + 1}`}
              style={{ ...EDITOR_FIELD_STYLE, minHeight: 56, resize: "vertical", lineHeight: 1.5, marginBottom: 8 }}
            />
            <textarea
              className="clay-textarea"
              value={card.answer}
              onChange={(e) => updateCard(card.key, { answer: e.target.value })}
              onFocus={editorFocus}
              onBlur={editorBlur}
              placeholder="Answer"
              rows={2}
              aria-label={`Answer for card ${i + 1}`}
              style={{ ...EDITOR_FIELD_STYLE, minHeight: 56, resize: "vertical", lineHeight: 1.5, marginBottom: 8 }}
            />
            <input
              value={card.hint}
              onChange={(e) => updateCard(card.key, { hint: e.target.value })}
              onFocus={editorFocus}
              onBlur={editorBlur}
              placeholder="Hint (optional)"
              aria-label={`Hint for card ${i + 1}`}
              style={{ ...EDITOR_FIELD_STYLE, fontSize: 13, padding: "8px 12px" }}
            />
          </div>
        ))}
      </div>

      <button className="btn btn-secondary" style={{ width: "100%", marginBottom: 24 }} onClick={addCard}>
        <Plus />
        Add Card
      </button>
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
  /** Spaced repetition (P4) rollup for this deck. */
  trackedCount?: number;
  dueCount?: number;
  matureCount?: number;
  newCount?: number;
  nextDueAt?: string | null;
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
    /** Spaced repetition (P4). */
    reviewsTracked?: number;
    dueNow?: number;
    learning?: number;
    mature?: number;
    lapses?: number;
    reviewedToday?: number;
    nextDueAt?: string | null;
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
      review: "Spaced review",
    }[mode] ?? "Study"
  );
}

function masteryColor(pct: number): string {
  if (pct >= 80) return "#10b981";
  if (pct >= 50) return "#f59e0b";
  return "#6366f1";
}

function StatsPage({
  onOpenDeck,
  online,
  syncToken,
}: {
  onOpenDeck: (id: number) => void;
  online: boolean;
  /** Bumped after a background sync so freshly recorded answers show up. */
  syncToken: number;
}) {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  /** When the last synced copy was taken — stats are server-side aggregates. */
  const [cachedAt, setCachedAt] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const data = await fetchJson<StatsData>("/api/stats", signal ? { signal } : undefined);
      if (signal?.aborted) return;
      setStats(data);
      setCachedAt(null);
      // Keep the numbers for the next offline visit (they are aggregates the
      // client can't recompute without the whole history).
      void cacheStatsSnapshot(data);
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof HttpError) {
        showToast("Failed to load stats", CircleX);
        return;
      }
      const snapshot = await readStatsSnapshot();
      if (signal?.aborted) return;
      if (snapshot) {
        setStats(snapshot.data as StatsData);
        setCachedAt(snapshot.savedAt);
      } else {
        showToast("Failed to load stats", CircleX);
      }
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
  }, [load, syncToken]);

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
    {
      label: "Due now (spaced review)",
      value: overall.dueNow ?? 0,
      icon: Brain,
      color: "#7c3aed",
      bg: "#f3e8ff",
    },
    {
      label: `In rotation${overall.mature ? ` · ${overall.mature} mature` : ""}`,
      value: overall.reviewsTracked ?? 0,
      icon: Hourglass,
      color: "#0891b2",
      bg: "#ecfeff",
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

      {cachedAt && (
        <OfflineNotice
          title={online ? "Couldn't reach the server" : "Offline — last synced stats"}
          action={
            <OfflineRetryButton
              label={online ? "Retry" : "Check"}
              onRetry={() => void probeConnection().then(() => load())}
            />
          }
        >
          These numbers were synced {formatSavedAgo(cachedAt)}. Answers recorded
          since then are safe on this device and appear after the next sync.
        </OfflineNotice>
      )}

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
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                    <span className="badge" style={{ background: `${color}1a`, color, fontWeight: 800 }}>
                      {deck.mastery}% mastered
                    </span>
                    {Boolean(deck.dueCount) && (
                      <span className="badge" style={{ background: "#ffe4e6", color: "#9f1239" }}>
                        {deck.dueCount} due
                      </span>
                    )}
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
            Answer cards in Study, Exam, Identification, Enumeration or a spaced review and your activity will appear here.
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
function HomePage({
  onUpload,
  onSessions,
  onReview,
  onCreateManual,
  dueCount,
  online,
  offlineDeckCount,
  offlineCardCount,
  offlineSavedAt,
  offlineBusy,
  onDownloadAll,
  course,
  onEditCourse,
}: {
  onUpload: () => void;
  onSessions: () => void;
  onReview: () => void;
  /** Open the deck editor with a blank, hand-built deck. */
  onCreateManual: () => void;
  dueCount: number;
  online: boolean;
  offlineDeckCount: number;
  offlineCardCount: number;
  offlineSavedAt: string | null;
  offlineBusy: boolean;
  onDownloadAll: () => void;
  /** The user's saved course (null = not chosen yet). */
  course: string | null;
  /** Open the course picker in edit mode. */
  onEditCourse: () => void;
}) {
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
          Upload your study material and I&apos;ll turn it into fun flashcards — then review them with Study, Exam, Identification or Enumeration mode, and let spaced repetition tell you what to review today.
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

      {/* Course card: the profile course at a glance, tap to change. This is
          the "be specific for the user course" surface the picker feeds. */}
      <button
        className="glass-card animate-fade-in"
        onClick={onEditCourse}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 16px",
          marginBottom: 16,
          border: course ? "2px solid #bfdbfe" : "2px dashed #93c5fd",
          background: "linear-gradient(135deg, #eff6ff, #eef2ff)",
          cursor: "pointer",
          font: "inherit",
          color: "var(--text)",
          textAlign: "left",
        }}
      >
        <span style={{ color: "#1d4ed8", display: "flex", flexShrink: 0 }}>
          <GraduationCap size={26} aria-hidden />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 14, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {course ? course : "Choose your course"}
          </span>
          <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)" }}>
            {course
              ? "Your flashcards are tailored to this course — tap to change"
              : "Tell QuizTime your course and the AI will tailor your flashcards"}
          </span>
        </span>
        <Pencil size={16} aria-hidden style={{ color: "var(--text-muted)", flexShrink: 0 }} />
      </button>

      {/* Offline study: what's on this device, and the one-tap download. */}
      <OfflineReadyCard
        deckCount={offlineDeckCount}
        cardCount={offlineCardCount}
        savedAt={offlineSavedAt}
        online={online}
        busy={offlineBusy}
        onDownloadAll={onDownloadAll}
        onOpenSets={onSessions}
      />

      {/* Spaced repetition nudge — only when there is actually work waiting. */}
      {dueCount > 0 && (
        <button
          className="glass-card animate-fade-in"
          onClick={onReview}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "14px 16px",
            marginBottom: 24,
            border: "2px solid #ddd6fe",
            background: "linear-gradient(135deg, #f5f3ff, #eef2ff)",
            cursor: "pointer",
            font: "inherit",
            color: "var(--text)",
            textAlign: "left",
          }}
        >
          <span style={{ color: "#6d28d9", display: "flex", flexShrink: 0 }}>
            <Brain size={26} aria-hidden />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 14, fontWeight: 800 }}>
              {dueCount} card{dueCount === 1 ? "" : "s"} due for review
            </span>
            <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)" }}>
              Spaced repetition picked the cards you&apos;re about to forget
            </span>
          </span>
          <ArrowRight size={18} aria-hidden />
        </button>
      )}

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
          { icon: Brain, title: "Spaced Review", desc: "Due cards only — scheduled by SM-2" },
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
        className="btn btn-primary"
        style={{ width: "100%", marginBottom: 10 }}
        onClick={onCreateManual}
      >
        <PenLine />
        Create a Deck Manually
      </button>
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
  const payload = { results: outcomes };

  // Leaving the page: hand the batch to the browser so it survives navigation.
  // Only worth it when there *is* a network — offline the outbox below is the
  // durable path (a beacon that can't be delivered is simply lost).
  if (
    useBeacon &&
    isProbablyOnline() &&
    typeof navigator !== "undefined" &&
    navigator.sendBeacon
  ) {
    const sent = navigator.sendBeacon(
      "/api/stats/results",
      new Blob([JSON.stringify(payload)], { type: "application/json" })
    );
    // Beacon accepted for delivery → optimistically clear the cache.
    if (sent) return [];
  }

  // Sent, queued in the outbox, or (rarely) refused. Only a refusal keeps the
  // localStorage copy, so nothing is ever silently dropped.
  const outcome = await sendOrQueueWrite("/api/stats/results", "POST", payload);
  return outcome === "rejected" ? outcomes : [];
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function IOSInstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [installEvent, setInstallEvent] = useState<Event | null>(null);
  // Lazy (not set from the effect): the banner renders nothing until `visible`
  // flips, so deriving this during the first client render is both correct and
  // free of a needless cascading render.
  const [isAndroid] = useState(
    () => typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)
  );

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

    // Shown one frame after mount: the first render must stay empty so it
    // matches the server's HTML, and defers the state update out of the effect
    // body (a synchronous setState here would cascade renders).
    const frame = requestAnimationFrame(() => {
      if (!standalone && !dismissed && isIOS) setVisible(true);
    });

    const handleBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event);
      if (!standalone && !dismissed && android) setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
    };
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

  // Deck editor overlay: { sessionId: null } creates a new manual deck,
  // a number edits that saved deck. `origin` decides where "save" lands.
  // `subject` pre-files a newly created deck into a subject folder (the
  // "+ New Set" button inside a subject page sets it).
  const [deckEditor, setDeckEditor] = useState<{
    sessionId: number | null;
    origin: Tab;
    subject?: { id: number; name: string } | null;
  } | null>(null);

  // Subject folders: which subject page is open inside the My Sets tab
  // (null = the normal My Study Sets list). Cleared when the tab changes.
  const [subjectView, setSubjectView] = useState<{ id: number; name: string } | null>(null);

  // Spaced repetition (P4): which deck the Review tab is filtered to, and how
  // many cards are due right now (the number on the nav badge).
  const [reviewDeckId, setReviewDeckId] = useState<number | null>(null);
  const [dueCount, setDueCount] = useState(0);

  // Sign-in state (Auth.js). `data` is null while unauthenticated — and also
  // while offline, which is why the identity falls back to the cached profile
  // (`useOfflineIdentity`) so "open my account offline" works.
  const { data: session, status } = useSession();
  const online = useOnlineStatus();
  const identity = useOfflineIdentity({ user: session?.user ?? null, status });
  const user = identity.user;
  const signedIn = Boolean(user?.id);

  // ── Course (course-tailored flashcards) ────────────────────────────────────
  // The student's course ("BS Pharmacy", or anything they typed). `undefined`
  // = not loaded yet, `null` = not chosen. A localStorage copy keeps it
  // visible on offline boots and drives the one-time "asked" flag.
  const [course, setCourse] = useState<string | null | undefined>(undefined);
  const [courseModalOpen, setCourseModalOpen] = useState(false);
  const [courseSaving, setCourseSaving] = useState(false);

  // All state updates happen inside the async callback (never in the effect
  // body itself — see the IOSInstallPrompt rAF pattern for why).
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    void (async () => {
      let asked = false;
      try {
        asked = window.localStorage.getItem("quiztime:course-asked") === "1";
      } catch {
        /* storage blocked — treat as not asked */
      }
      // First-login picker: open it once when the user has no course yet and
      // has never skipped ("Maybe later" sets the asked flag, so it doesn't
      // nag). Decided right here where the answer is known.
      const openPicker = (value: string | null) => {
        if (value === null && !asked) setCourseModalOpen(true);
      };
      try {
        const res = await fetch("/api/profile", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const value =
          typeof data.course === "string" && data.course ? data.course : null;
        if (!alive) return;
        setCourse(value);
        openPicker(value);
        try {
          window.localStorage.setItem("quiztime:course", value ?? "");
        } catch {
          /* non-fatal */
        }
      } catch {
        // Offline or API hiccup — fall back to this device's cached copy so
        // the Home card and the upload pre-fill still know the course.
        let cached: string | null = null;
        try {
          const raw = window.localStorage.getItem("quiztime:course");
          cached = raw ? raw : null;
        } catch {
          /* ignore */
        }
        if (!alive) return;
        setCourse(cached);
        openPicker(cached);
      }
    })();
    return () => {
      alive = false;
    };
  }, [signedIn]);

  const handleSaveCourse = async (value: string) => {
    if (!online) {
      showToast("Saving your course needs a connection", CloudOff);
      return;
    }
    setCourseSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ course: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      setCourse(value);
      try {
        window.localStorage.setItem("quiztime:course", value);
      } catch {
        /* non-fatal */
      }
      setCourseModalOpen(false);
      showToast("Course saved — your flashcards will match it", CircleCheckBig);
    } catch (err) {
      showToast(
        err instanceof Error && err.message ? err.message : "Failed to save",
        CircleX
      );
    } finally {
      setCourseSaving(false);
    }
  };

  const handleSkipCourse = () => {
    try {
      window.localStorage.setItem("quiztime:course-asked", "1");
    } catch {
      /* non-fatal */
    }
    setCourseModalOpen(false);
  };

  const outbox = useOutbox();

  // Does this session belong to the app owner (OWNER_EMAIL)? The flag comes
  // from the session callback in src/auth.ts, so it is decided server-side;
  // it only ever controls UI — /api/presence re-checks it on every request.
  const isOwner = Boolean(session?.user?.isOwner);

  // The open deck, if any — computed up here because the presence heartbeat
  // below needs it, and hooks must run before the sign-in gate's early return.
  const isViewingSession = activeSessionCards !== null && activeSessionId !== null && !pendingCards;

  // What the owner's roster shows next to this user ("Studying “Cell Biology”").
  // Short and human on purpose: it is a hint about what someone is up to, not a
  // log of what they did.
  const presenceActivity = useMemo(() => {
    if (deckEditor) return "Editing a set";
    if (tab === "quiz") {
      if (isViewingSession) {
        return activeSessionTitle ? `Studying “${activeSessionTitle}”` : "Studying";
      }
      return pendingCards ? "Reviewing new cards" : "Studying";
    }
    if (tab === "upload") return "Creating a set";
    if (tab === "sessions") return "Browsing my sets";
    if (tab === "review") return "Reviewing due cards";
    if (tab === "stats") return "Checking stats";
    return "On the home screen";
  }, [
    deckEditor,
    tab,
    isViewingSession,
    activeSessionTitle,
    pendingCards,
  ]);

  // "Who's online": every signed-in browser checks in every 30 s (offline we
  // skip it — beating into a dead connection just wastes battery). Only the
  // owner sees the roster the beats feed.
  usePresenceHeartbeat({ enabled: signedIn && online, activity: presenceActivity });

  // Whether the open deck came from this device's cache (drives the notice and
  // keeps the user from wondering why edits are disabled).
  const [activeSessionOffline, setActiveSessionOffline] = useState(false);

  // What this device can do with no signal: how many sets/cards are cached and
  // how fresh that copy is.
  const [offlineInfo, setOfflineInfo] = useState<{
    deckCount: number;
    cardCount: number;
    savedAt: string | null;
  }>({ deckCount: 0, cardCount: 0, savedAt: null });
  const [offlineBusy, setOfflineBusy] = useState(false);

  const refreshOfflineInfo = useCallback(async () => {
    const { deckCount, cardCount, savedAt } = await readOfflineReadiness();
    setOfflineInfo({ deckCount, cardCount, savedAt });
  }, []);

  // Keep the "due today" badge honest: refetch on mount, on every sign-in and
  // whenever the user lands on another tab (it is a single lightweight query).
  // Offline, the same number is recomputed from the cached schedules.
  const refreshDueCount = useCallback(async () => {
    try {
      const data = await fetchJson<{ counts?: { due?: number } }>("/api/review?limit=1");
      setDueCount(data.counts?.due ?? 0);
    } catch {
      const rows = await readSrsRecords();
      setDueCount(countDueNow(rows));
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    void (async () => {
      await refreshDueCount();
      await refreshOfflineInfo();
    })();
  }, [refreshDueCount, refreshOfflineInfo, signedIn, tab]);

  // ── Offline plumbing ──────────────────────────────────────────────────────
  // `syncToken` bumps after a drain so open lists can refetch their data
  // without remounting the quiz (which would lose a session in progress).
  const [syncToken, setSyncToken] = useState(0);

  useEffect(() => {
    bindConnectivityListeners();
  }, []);

  // Held in a ref so the drain effect can depend on `online` alone (depending
  // on the callback would re-run it every time the pending count changes).
  const flushRef = useRef(outbox.flush);
  useEffect(() => {
    flushRef.current = outbox.flush;
  }, [outbox.flush]);

  // Drain queued writes whenever the connection comes back.
  useEffect(() => {
    if (!signedIn || !online) return;
    void (async () => {
      const result = await flushRef.current();
      if (result.syncedEntries > 0) {
        showToast(
          `Synced ${result.syncedEntries} offline answer${result.syncedEntries === 1 ? "" : "s"}`,
          CloudUpload
        );
        setSyncToken((token) => token + 1);
        void refreshDueCount();
        void refreshOfflineInfo();
      }
    })();
  }, [online, signedIn, refreshDueCount, refreshOfflineInfo]);

  // The service worker keeps syncing while the app is closed; when it reports
  // back (or queues a write it intercepted), refresh what the UI shows.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; synced?: number } | null;
      if (!data) return;
      if (data.type === "OUTBOX_QUEUED") bumpOutbox();
      if (data.type === "OUTBOX_SYNCED") {
        bumpOutbox();
        const synced = data.synced ?? 0;
        if (synced > 0) {
          showToast(
            `Synced ${synced} offline answer${synced === 1 ? "" : "s"}`,
            CloudUpload
          );
          setSyncToken((token) => token + 1);
          void refreshDueCount();
          void refreshOfflineInfo();
        }
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [refreshDueCount, refreshOfflineInfo]);

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
  // Hydration-safe: reading localStorage during the first client render would
  // differ from the server's HTML ("hydration failed" warnings). Restored one
  // frame after mount instead — the same pattern IOSInstallPrompt documents:
  // first client render matches the server, then the banner fades in.
  const [draft, setDraft] = useState<PendingDeck | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const restored = loadDraft();
      if (restored) setDraft(restored);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

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
    // Creating a set is a server-side operation (AI + Postgres ids): offline we
    // say so plainly instead of pretending. The draft itself is already safe in
    // localStorage, so nothing is lost.
    if (!online) {
      throw new Error("Saving needs a connection — your cards are kept as a draft.");
    }
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
      // Network first; the snapshot saved on this device is the offline answer.
      const data = await loadDeckForStudy(id);
      setActiveSessionId(id);
      setActiveSessionCards(data.cards);
      setActiveSessionTitle(data.session.title);
      setActiveSessionSummary(data.session.summary ?? "");
      setActiveSessionOffline(data.offline);
      setPendingCards(null);
      setDeckKey((k) => k + 1);
      setTab("quiz");
      if (data.offline) {
        showToast("Offline — studying the copy saved on this device", CloudDownload);
      }
      void refreshOfflineInfo();
    } catch {
      showToast("Failed to load session", CircleX);
    }
  };

  /** One tap: freeze every set (cards, progress, schedules) on this device. */
  const handleDownloadAll = useCallback(async () => {
    if (!online) {
      showToast("Connect to the internet to save your sets", CloudOff);
      return;
    }
    setOfflineBusy(true);
    try {
      const result = await cacheDeckBundle(undefined, { pinned: true });
      await refreshOfflineInfo();
      const sets = `${result.deckCount} set${result.deckCount === 1 ? "" : "s"}`;
      const cards = `${result.cardCount} card${result.cardCount === 1 ? "" : "s"}`;
      showToast(
        `${sets} · ${cards} ready offline${result.truncated ? " (some were too big to save)" : ""}`,
        CloudDownload
      );
    } catch {
      showToast("Couldn't download your sets", CircleX);
    } finally {
      setOfflineBusy(false);
    }
  }, [online, refreshOfflineInfo]);

  /** Per-deck offline toggle used by the "My Sets" rows. */
  const handleToggleDeckOffline = useCallback(
    async (deckId: number, saved: boolean) => {
      setOfflineBusy(true);
      try {
        if (saved) {
          await forgetDeckOffline(deckId);
          showToast("Removed from offline storage", CloudOff);
        } else {
          if (!online) {
            showToast("Saving for offline needs a connection", CloudOff);
            return;
          }
          const result = await cacheDeckBundle(deckId, { pinned: true });
          showToast(
            `Saved ${result.cardCount} card${result.cardCount === 1 ? "" : "s"} for offline`,
            CloudDownload
          );
        }
        await refreshOfflineInfo();
        setSyncToken((token) => token + 1);
      } catch {
        showToast("Couldn't update offline storage", CircleX);
      } finally {
        setOfflineBusy(false);
      }
    },
    [online, refreshOfflineInfo]
  );

  /**
   * Sign out wipes this device's offline copy first (decks, queued answers and
   * the cached session), then ends the session server-side when reachable. With
   * no network the local copy is what matters — the reload lands on /login.
   */
  const handleSignOut = async () => {
    await purgeOfflineData();
    if (online) {
      await signOut({ callbackUrl: "/login" });
    } else {
      window.location.replace("/login");
    }
  };

  /** Leaving the deck editor — saved decks reopen or refresh the list. */
  const handleEditorExit = (savedId: number | null) => {
    const origin = deckEditor?.origin;
    setDeckEditor(null);
    if (savedId === null) return; // cancelled — stay wherever we were
    if (origin === "quiz") {
      // Was studying this deck: reopen it so the quiz reflects the edits.
      void handleOpenSession(savedId);
    } else {
      setTab("sessions");
    }
  };

  // First-visit gate: unsigned visitors (and the session-loading splash) see
  // the login page with the large logo — never the rest of the app. Offline
  // starts resolve through the cached profile, so a saved account boots
  // straight into the app; the login page itself offers "Continue offline"
  // for the case where the user has to ask for it.
  if (!identity.ready || !signedIn) {
    return <LoginPage loading={!identity.ready || status === "loading"} />;
  }

  const renderContent = () => {
    // The deck editor takes over the whole screen while open.
    if (deckEditor) {
      return (
        <DeckEditorPage
          key={deckEditor.sessionId ?? "new"}
          sessionId={deckEditor.sessionId}
          subject={deckEditor.subject ?? null}
          onExit={handleEditorExit}
        />
      );
    }

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
          online={online}
          offlineDeck={activeSessionOffline}
          onSave={!isViewingSession ? handleSaveSession : undefined}
          onEditDeck={
            isViewingSession && activeSessionId !== null
              ? () => {
                  // Editing a deck is a server-side operation.
                  if (!online) {
                    showToast("Editing sets needs a connection", CloudOff);
                    return;
                  }
                  setDeckEditor({ sessionId: activeSessionId, origin: "quiz" });
                }
              : undefined
          }
          onBack={() => {
            setTab(isViewingSession ? "sessions" : "upload");
            if (isViewingSession) setActiveSessionCards(null);
            else setPendingCards(null);
          }}
        />
      );
    }

    if (tab === "home") {
      return (
        <HomePage
          onUpload={() => setTab("upload")}
          onSessions={() => setTab("sessions")}
          onReview={() => setTab("review")}
          onCreateManual={() => setDeckEditor({ sessionId: null, origin: "home" })}
          dueCount={dueCount}
          online={online}
          offlineDeckCount={offlineInfo.deckCount}
          offlineCardCount={offlineInfo.cardCount}
          offlineSavedAt={offlineInfo.savedAt}
          offlineBusy={offlineBusy}
          onDownloadAll={handleDownloadAll}
          course={course ?? null}
          onEditCourse={() => setCourseModalOpen(true)}
        />
      );
    }
    if (tab === "upload") {
      if (!signedIn) return <SignInPrompt feature="create study sets" />;
      if (!hasApiKey) return <SetupPage />;
      return (
        <>
          {!online && (
            <div style={{ padding: "14px 16px 0" }}>
              <OfflineNotice title="You're offline">
                Generating new sets needs a connection. Your saved sets are still
                available under <strong>My Sets</strong>.
              </OfflineNotice>
            </div>
          )}
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
          <UploadPage course={course ?? null} onCardsReady={handleCardsReady} />
        </>
      );
    }
    if (tab === "sessions") {
      if (!signedIn) return <SignInPrompt feature="see your study sets" />;
      if (subjectView) {
        return (
          <SubjectPage
            key={subjectView.id}
            subject={subjectView}
            online={online}
            syncToken={syncToken}
            offlineBusy={offlineBusy}
            onToggleOffline={handleToggleDeckOffline}
            onOfflineChanged={() => setSyncToken((token) => token + 1)}
            onOpen={handleOpenSession}
            onReviewDeck={(id) => {
              setReviewDeckId(id);
              setTab("review");
            }}
            onEditDeck={(id) => setDeckEditor({ sessionId: id, origin: "sessions" })}
            onCreateSet={() => {
              if (!online) {
                showToast("Creating sets needs a connection", CloudOff);
                return;
              }
              setDeckEditor({ sessionId: null, origin: "sessions", subject: subjectView });
            }}
            onBack={() => setSubjectView(null)}
            onRenamed={(name) => setSubjectView({ id: subjectView.id, name })}
          />
        );
      }
      return (
        <SessionsPage
          online={online}
          syncToken={syncToken}
          offlineBusy={offlineBusy}
          onDownloadAll={handleDownloadAll}
          onToggleOffline={handleToggleDeckOffline}
          onOfflineChanged={() => setSyncToken((token) => token + 1)}
          onOpen={handleOpenSession}
          onReviewDeck={(id) => {
            setReviewDeckId(id);
            setTab("review");
          }}
          onEditDeck={(id) => setDeckEditor({ sessionId: id, origin: "sessions" })}
          onOpenSubject={(subject) => setSubjectView({ id: subject.id, name: subject.name })}
        />
      );
    }
    if (tab === "stats") {
      if (!signedIn) return <SignInPrompt feature="see your study stats" />;
      return <StatsPage onOpenDeck={handleOpenSession} online={online} syncToken={syncToken} />;
    }
    if (tab === "review") {
      if (!signedIn) return <SignInPrompt feature="review your cards" />;
      return (
        <ReviewPage
          deckId={reviewDeckId}
          online={online}
          syncToken={syncToken}
          onClearDeckFilter={() => setReviewDeckId(null)}
          onOpenDeck={(id) => setReviewDeckId((current) => (current === id ? null : id))}
        />
      );
    }
    return null;
  };

  const navItems = [
    { id: "home" as Tab, label: "Home", Icon: House },
    { id: "upload" as Tab, label: "Upload", Icon: Upload },
    { id: "sessions" as Tab, label: "My Sets", Icon: Library },
    { id: "review" as Tab, label: "Review", Icon: Brain, badge: dueCount },
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
          <p className="app-developer">Developed by: FBC BSIT 3</p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {/* Offline badge + "N answers waiting to sync" (tap to sync now). */}
          <OfflineChip
            online={online}
            pending={outbox.count}
            syncing={outbox.syncing}
            onSync={() => void outbox.flush()}
          />
          {!hasApiKey && signedIn && online && (
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
              {/* Full reload on sign-out clears all in-memory deck state, and
                  the handler wipes this device's offline copy first. */}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void handleSignOut()}
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

      {/* Owner only: "Who's online" — a live presence roster fed by the
          heartbeats every signed-in browser sends (see src/lib/presence.ts).
          Renders nothing for normal users; the API 403s them anyway. */}
      {isOwner && <OwnerPresenceBar />}

      {/* Page content */}
      <div className="page-content">
        {renderContent()}
      </div>

      {/* Bottom nav */}
      <nav className="nav-bottom">
        {navItems.map(({ id, label, Icon, badge }) => (
          <button
            key={id}
            className={`nav-item ${tab === id ? "active" : ""}`}
            onClick={() => {
              setTab(id);
              setPendingCards(null);
              setActiveSessionCards(null);
              setDeckEditor(null);
              setSubjectView(null);
              if (id !== "review") setReviewDeckId(null);
            }}
            aria-label={badge ? `${label} — ${badge} card${badge === 1 ? "" : "s"} due` : label}
          >
            <Icon />
            {label}
            {typeof badge === "number" && badge > 0 && <span className="nav-badge">{badge}</span>}
          </button>
        ))}
      </nav>

      {/* Course picker: opens on first login (until answered or "Maybe
          later"), and any time after that from the Home course card. */}
      {courseModalOpen && (
        <CoursePickerModal
          initialCourse={course ?? null}
          busy={courseSaving}
          canSkip={course === null}
          onSave={(value) => void handleSaveCourse(value)}
          onSkip={handleSkipCourse}
        />
      )}

      <ToastHost />
      {/* Nibbles 🐹 — floating study buddy (greets on login, tours first-timers,
          cheers when a deck run finishes). */}
      <MascotHost
        userName={user?.name ?? null}
        userId={user?.id != null ? String(user.id) : null}
      />
    </div>
  );
}
