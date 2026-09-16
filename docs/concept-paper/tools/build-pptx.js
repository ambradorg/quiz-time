/**
 * Builds QuizTime-Concept-Presentation.pptx — a ~14-slide defense deck.
 * Usage: node build-pptx.js
 */
const PptxGenJS = require("pptxgenjs");
const fs = require("fs");
const path = require("path");

const BASE = path.resolve(__dirname, "..");
const REPO = path.resolve(BASE, "..", "..");
const IMG = path.join(require("os").tmpdir(), "quiztime-docs-img");
const OUT = path.join(BASE, "QuizTime-Concept-Presentation.pptx");
const LOGO = path.join(REPO, "public", "logo.png");
const HAMSTER = path.join(REPO, "public", "hamster");

const W = 13.333, H = 7.5;
const NAVY = "10233F";
const MUTED = "5B7192";
const BLUE = "3B82F6";
const BLUE_DK = "1D4ED8";
const INDIGO = "6366F1";
const VIOLET = "7C3AED";
const CYAN = "06B6D4";
const GREEN = "10B981";
const YELLOW = "FBBF24";
const RED = "F43F5E";
const FONT = "Calibri";

const pptx = new PptxGenJS();
pptx.defineLayout({ name: "W16x9", width: W, height: H });
pptx.layout = "W16x9";
pptx.author = "QuizTime Project";
pptx.title = "QuizTime — Concept Paper Presentation";
pptx.subject = "An AI-Assisted Flashcard and Quiz Generator for Active Recall and Spaced Repetition Study";

/* ------------------------------------------------------------- templates */
function page(title, kicker, { accent = BLUE } = {}) {
  const s = pptx.addSlide();
  s.background = { color: "EEF4FF" };
  // header band
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 1.28, fill: { color: "FFFFFF" } });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 1.28, w: W, h: 0.06, fill: { color: accent } });
  s.addShape(pptx.ShapeType.rect, { x: 0.5, y: 0.3, w: 0.11, h: 0.72, fill: { color: accent } });
  s.addText(title, {
    x: 0.75, y: 0.22, w: 10.5, h: 0.5, fontFace: FONT, fontSize: 27, bold: true, color: NAVY, valign: "middle",
  });
  if (kicker) {
    s.addText(kicker, {
      x: 0.77, y: 0.72, w: 11.2, h: 0.42, fontFace: FONT, fontSize: 14, color: MUTED, valign: "middle",
    });
  }
  // slide number
  s.addText(String(pptx.slides.length), {
    x: W - 1.35, y: H - 0.62, w: 0.85, h: 0.36, fontFace: FONT, fontSize: 12, color: MUTED, align: "right",
  });
  s.addText("QuizTime · Concept Paper", {
    x: 0.5, y: H - 0.62, w: 4.5, h: 0.36, fontFace: FONT, fontSize: 11, color: MUTED,
  });
  return s;
}

function card(s, x, y, w, h, { fill = "FFFFFF", line = "D7E3F8", radius = 0.12, shadow = true } = {}) {
  s.addShape(radius >= h / 2 ? pptx.ShapeType.roundRect : pptx.ShapeType.roundRect, {
    x, y, w, h, rectRadius: Math.min(radius, h / 2),
    fill: { color: fill }, line: { color: line, width: 1 },
    shadow: shadow ? { type: "outer", color: "2B50B4", opacity: 0.16, blur: 8, offset: 3, angle: 90 } : undefined,
  });
}

function pill(s, x, y, w, h, label, color, { size = 12, textColor = "FFFFFF", fill } = {}) {
  s.addShape(pptx.ShapeType.roundRect, {
    x, y, w, h, rectRadius: h / 2, fill: { color: fill || color }, line: { color: fill || color, width: 0 },
  });
  s.addText(label, {
    x, y, w, h, fontFace: FONT, fontSize: size, bold: true, color: textColor, align: "center", valign: "middle",
  });
}

/** Place an image inside a box, preserving its aspect ratio and centring it. */
function fitImg(s, file, ar, box) {
  const scale = Math.min(box.w / ar, box.h);           // ar = width / height
  const w = ar * scale, h = scale;
  s.addImage({ path: path.join(IMG, file), x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h });
}

function statCard(s, x, y, w, h, value, label, color) {
  card(s, x, y, w, h);
  s.addShape(pptx.ShapeType.rect, { x, y, w, h: 0.1, fill: { color } });
  s.addText(value, { x, y: y + 0.16, w, h: 0.66, fontFace: FONT, fontSize: 34, bold: true, color, align: "center" });
  s.addText(label, { x: x + 0.12, y: y + 0.82, w: w - 0.24, h: h - 0.94, fontFace: FONT, fontSize: 12, color: MUTED, align: "center" });
}

/* =====================================================================
   1 — TITLE
   ===================================================================== */
(() => {
  const s = pptx.addSlide();
  s.background = { color: "EEF4FF" };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: H, fill: { color: "EEF4FF" } });
  s.addShape(pptx.ShapeType.ellipse, { x: W - 3.4, y: -1.9, w: 5.6, h: 5.6, fill: { color: "DCE9FF" } });
  s.addShape(pptx.ShapeType.ellipse, { x: W - 1.7, y: 4.7, w: 3.4, h: 3.4, fill: { color: "E6F0FF" } });

  s.addImage({ path: LOGO, x: 0.85, y: 0.75, w: 3.5, h: 1.95 });
  s.addShape(pptx.ShapeType.rect, { x: 0.9, y: 2.95, w: 7.7, h: 0.07, fill: { color: BLUE } });

  s.addText("An AI-Assisted Flashcard and Quiz Generator for Active Recall and Spaced Repetition Study", {
    x: 0.9, y: 3.15, w: 8.2, h: 1.5, fontFace: FONT, fontSize: 27, bold: true, color: NAVY, lineSpacingMultiple: 1.05,
  });
  s.addText("A Concept Paper", {
    x: 0.9, y: 4.62, w: 5, h: 0.4, fontFace: FONT, fontSize: 17, italic: true, color: MUTED,
  });
  s.addText("Presented by the QuizTime Project Team", {
    x: 0.9, y: 5.06, w: 6, h: 0.36, fontFace: FONT, fontSize: 14, color: BLUE_DK, bold: true,
  });
  s.addText("September 2026", {
    x: 0.9, y: 5.4, w: 6, h: 0.34, fontFace: FONT, fontSize: 13, color: MUTED,
  });

  // feature pills
  const pills = [["AI-generated decks", BLUE], ["Four study modes", INDIGO], ["Spaced repetition", VIOLET], ["Works offline", GREEN]];
  pills.forEach(([t, c], i) => pill(s, 0.9 + i * 2.24, 6.02, 2.06, 0.5, t, c, { size: 12 }));

  // mascot
  s.addImage({ path: path.join(HAMSTER, "hamster-wave.png"), x: 10.55, y: 3.35, w: 1.95, h: 2.56 });
})();

/* =====================================================================
   2 — THE PROBLEM
   ===================================================================== */
(() => {
  const s = page("The problem", "Students have the material. They lack the time to turn it into practice.", { accent: RED });
  const cards = [
    ["Rereading feels productive", "Re-reading and highlighting rank among the least effective study techniques, yet they are the ones students use most.", RED],
    ["Testing beats restudying", "Learners who self-test retain far more a week later than learners who reread for the same amount of time — but almost nobody does it.", YELLOW],
    ["Spacing is the hard part", "Reviewing each card exactly when it is about to be forgotten is what makes recall permanent, and it is impossible to do by hand.", VIOLET],
  ];
  cards.forEach(([t, d, c], i) => {
    const x = 0.62 + i * 4.07;
    card(s, x, 1.72, 3.75, 3.35);
    s.addShape(pptx.ShapeType.rect, { x, y: 1.72, w: 3.75, h: 0.12, fill: { color: c } });
    s.addShape(pptx.ShapeType.ellipse, { x: x + 0.3, y: 2.06, w: 0.62, h: 0.62, fill: { color: c } });
    s.addText(String(i + 1), { x: x + 0.3, y: 2.06, w: 0.62, h: 0.62, fontFace: FONT, fontSize: 20, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
    s.addText(t, { x: x + 0.3, y: 2.82, w: 3.15, h: 0.62, fontFace: FONT, fontSize: 17, bold: true, color: NAVY });
    s.addText(d, { x: x + 0.3, y: 3.46, w: 3.15, h: 1.45, fontFace: FONT, fontSize: 12.5, color: "3B4E6B", lineSpacingMultiple: 1.12 });
  });

  card(s, 0.62, 5.28, 12.09, 1.08, { fill: "FFF8E7", line: "F7D57E" });
  s.addText("In short:", { x: 0.95, y: 5.44, w: 1.3, h: 0.76, fontFace: FONT, fontSize: 15, bold: true, color: "8A6100", valign: "middle" });
  s.addText("Students already hold thousands of pages of digital material, but nothing turns it into retrieval practice — or tells them what to review today.", {
    x: 2.0, y: 5.44, w: 10.4, h: 0.76, fontFace: FONT, fontSize: 15, color: "5C4708", valign: "middle",
  });
})();

/* =====================================================================
   3 — THE OPPORTUNITY
   ===================================================================== */
(() => {
  const s = page("The opportunity", "Two technologies matured at the right moment.", { accent: GREEN });
  const cols = [
    ["Generative AI can read your material", GREEN, ["A 40-page lecture can be summarised into key concepts, definitions and enumerations in seconds.", "That is exactly the tedious part of building flashcards — and the part learners skip."]],
    ["Web apps can now work offline", CYAN, ["A browser-installed app can cache itself, its data and its logic.", "Study sessions no longer have to depend on a stable connection."]],
  ];
  cols.forEach(([t, c, pts], i) => {
    const x = 0.62 + i * 6.28;
    card(s, x, 1.72, 5.81, 2.6);
    s.addShape(pptx.ShapeType.rect, { x, y: 1.72, w: 0.13, h: 2.6, fill: { color: c } });
    s.addText(t, { x: x + 0.38, y: 1.94, w: 5.2, h: 0.6, fontFace: FONT, fontSize: 19, bold: true, color: NAVY });
    pts.forEach((p, j) => {
      s.addShape(pptx.ShapeType.ellipse, { x: x + 0.42, y: 2.76 + j * 0.72 + 0.09, w: 0.16, h: 0.16, fill: { color: c } });
      s.addText(p, { x: x + 0.72, y: 2.66 + j * 0.72, w: 4.85, h: 0.7, fontFace: FONT, fontSize: 12.5, color: "3B4E6B", lineSpacingMultiple: 1.1 });
    });
  });

  card(s, 0.62, 4.52, 12.09, 1.86, { fill: "FFFFFF" });
  s.addText("The gap this project fills", { x: 0.95, y: 4.7, w: 6, h: 0.44, fontFace: FONT, fontSize: 18, bold: true, color: NAVY });
  s.addText("Existing flashcard apps make you type every card by hand. AI study tools generate cards but rarely schedule them properly, and many assume a constant connection.", {
    x: 0.95, y: 5.12, w: 11.4, h: 0.5, fontFace: FONT, fontSize: 13.5, color: "3B4E6B",
  });
  s.addText("QuizTime joins all three: AI generation, evidence-based scheduling, and offline study — from the learner's own documents.", {
    x: 0.95, y: 5.68, w: 11.4, h: 0.5, fontFace: FONT, fontSize: 13.5, bold: true, color: BLUE_DK,
  });
})();

/* =====================================================================
   4 — OBJECTIVES
   ===================================================================== */
(() => {
  const s = page("Objectives of the study", "General objective, then seven specific objectives.", { accent: BLUE_DK });
  card(s, 0.62, 1.68, 12.09, 1.02, { fill: "E4EDFD", line: "C7D7F5" });
  s.addText([
    { text: "General objective:  ", options: { bold: true, color: BLUE_DK } },
    { text: "to design and develop QuizTime — an AI-assisted, offline-capable flashcard and quiz generator that turns a learner's own documents into active-recall practice — and to evaluate its functionality, reliability and acceptability.", options: { color: NAVY } },
  ], { x: 0.95, y: 1.8, w: 11.4, h: 0.8, fontFace: FONT, fontSize: 14, valign: "middle", lineSpacingMultiple: 1.05 });

  const objs = [
    ["Build the generation pipeline", "8 files or 100k characters → 8–20 cards with hint and difficulty"],
    ["Implement four study modes", "Study · Exam · Identification · Enumeration, with scoring"],
    ["Implement spaced repetition", "Grade Again / Hard / Good / Easy → a daily review queue"],
    ["Record progress analytics", "Accuracy, mastery, streaks and review health per deck"],
    ["Make it work offline", "Service worker, snapshots, queued answers that sync later"],
    ["Keep it reliable and private", "AI failover, rate limits, per-account data isolation"],
    ["Validate the system", "156 automated checks plus an acceptability evaluation"],
  ];
  objs.forEach(([t, d], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 0.62 + col * 6.28, y = 2.92 + row * 1.06;
    const w = i === 6 ? 12.09 : 5.81;
    card(s, x, y, w, 0.92);
    s.addShape(pptx.ShapeType.ellipse, { x: x + 0.22, y: y + 0.22, w: 0.48, h: 0.48, fill: { color: BLUE } });
    s.addText(String(i + 1), { x: x + 0.22, y: y + 0.22, w: 0.48, h: 0.48, fontFace: FONT, fontSize: 15, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
    s.addText(t, { x: x + 0.84, y: y + 0.08, w: w - 1.0, h: 0.38, fontFace: FONT, fontSize: 14, bold: true, color: NAVY, valign: "middle" });
    s.addText(d, { x: x + 0.84, y: y + 0.44, w: w - 1.0, h: 0.4, fontFace: FONT, fontSize: 11.5, color: MUTED, valign: "middle" });
  });
})();

/* =====================================================================
   5 — CONCEPTUAL FRAMEWORK (diagram)
   ===================================================================== */
(() => {
  const s = page("Conceptual framework", "Inputs are the learner's own material; the process turns study into a feedback loop.", { accent: INDIGO });
  fitImg(s, "ipo-body.png", 2.146, { x: 0.5, y: 1.6, w: 12.33, h: 5.35 });
})();

/* =====================================================================
   6 — HOW IT WORKS (diagram)
   ===================================================================== */
(() => {
  const s = page("How it works", "From an uploaded file to a scheduled study habit.", { accent: CYAN });
  fitImg(s, "pipeline-body.png", 3.277, { x: 0.5, y: 2.95, w: 12.33, h: 3.95 });
  // top row: the essentials
  const facts = [
    ["Upload", "PDF · Word · PowerPoint · photos · pasted text — up to 8 files at once", BLUE],
    ["Generate", "8–20 cards with question, answer, hint and difficulty", INDIGO],
    ["Curate", "Edit, reorder or delete — progress survives every edit", VIOLET],
  ];
  facts.forEach(([t, d, c], i) => {
    const x = 0.62 + i * 4.07;
    card(s, x, 1.7, 3.75, 1.1);
    s.addShape(pptx.ShapeType.rect, { x, y: 1.7, w: 0.11, h: 1.1, fill: { color: c } });
    s.addText(t, { x: x + 0.26, y: 1.78, w: 3.35, h: 0.34, fontFace: FONT, fontSize: 15, bold: true, color: NAVY, valign: "middle" });
    s.addText(d, { x: x + 0.26, y: 2.12, w: 3.35, h: 0.6, fontFace: FONT, fontSize: 11.5, color: MUTED, valign: "top" });
  });
})();

/* =====================================================================
   7 — FOUR STUDY MODES
   ===================================================================== */
(() => {
  const s = page("Four ways to be tested", "Each mode exercises recall differently and feeds the same progress record.", { accent: INDIGO });
  const modes = [
    ["Study", BLUE, "Flashcards", ["Read, flip, reveal the answer and an optional hint.", "Self-check: “Got it” or “Still learning”.", "Missed cards come back in the same session."]],
    ["Exam", INDIGO, "Multiple choice", ["Four options per question with instant feedback.", "10 points a card, +5 medium, +10 hard.", "Streak bonus +2, capped at +10."]],
    ["Identification", CYAN, "Type the answer", ["Recall from memory, no options to lean on.", "Forgives case, punctuation and small typos.", "Supports “/”-separated alternative answers."]],
    ["Enumeration", VIOLET, "List them all", ["Type every item of a list answer, in any order.", "Per-item feedback as you go.", "Complete only when every item is named."]],
  ];
  modes.forEach(([t, c, sub, pts], i) => {
    const x = 0.62 + i * 3.09;
    card(s, x, 1.7, 2.86, 3.55);
    s.addShape(pptx.ShapeType.rect, { x, y: 1.7, w: 2.86, h: 0.86, fill: { color: c } });
    s.addText(t, { x: x + 0.18, y: 1.78, w: 2.5, h: 0.42, fontFace: FONT, fontSize: 16, bold: true, color: "FFFFFF", valign: "middle" });
    s.addText(sub, { x: x + 0.18, y: 2.16, w: 2.5, h: 0.34, fontFace: FONT, fontSize: 11.5, color: "EAF2FF", valign: "middle" });
    pts.forEach((p, j) => {
      s.addShape(pptx.ShapeType.ellipse, { x: x + 0.2, y: 2.78 + j * 0.78 + 0.07, w: 0.14, h: 0.14, fill: { color: c } });
      s.addText(p, { x: x + 0.44, y: 2.66 + j * 0.78, w: 2.24, h: 0.74, fontFace: FONT, fontSize: 11, color: "3B4E6B", lineSpacingMultiple: 1.08 });
    });
  });
  card(s, 0.62, 5.42, 12.09, 0.96, { fill: "FFFFFF" });
  s.addText("Every completed session ends with a results screen: accuracy, letter grade, points against the maximum, best streak, elapsed time, and the questions that were missed — which can be sent straight into Study Mode.", {
    x: 0.95, y: 5.52, w: 11.4, h: 0.76, fontFace: FONT, fontSize: 13, color: "3B4E6B", valign: "middle",
  });
})();

/* =====================================================================
   8 — SPACED REPETITION (diagram)
   ===================================================================== */
(() => {
  const s = page("Spaced repetition", "The app decides what you should study today — an SM-2 descendant with four grades.", { accent: VIOLET });
  fitImg(s, "curve-body.png", 2.419, { x: 0.4, y: 1.6, w: 7.6, h: 3.3 });

  card(s, 8.25, 1.6, 4.58, 3.3, { fill: "FFFFFF" });
  s.addText("How each grade reschedules a card", { x: 8.5, y: 1.72, w: 4.1, h: 0.42, fontFace: FONT, fontSize: 15, bold: true, color: NAVY });
  const grades = [
    ["Again", "back in 10 minutes, ease −0.20", RED],
    ["Hard", "interval × 1.2, ease −0.15", YELLOW],
    ["Good", "interval × the ease factor", BLUE],
    ["Easy", "interval × ease × 1.3, ease +0.15", GREEN],
  ];
  grades.forEach(([g, d, c], i) => {
    const y = 2.22 + i * 0.62;
    pill(s, 8.5, y, 1.1, 0.44, g, c, { size: 11.5 });
    s.addText(d, { x: 9.72, y, w: 2.95, h: 0.44, fontFace: FONT, fontSize: 10.5, color: "3B4E6B", valign: "middle" });
  });
  s.addText("Each button previews its own result (\u201cGood \u00b7 3 days\u201d): the client and the server run the same scheduler.", {
    x: 8.5, y: 4.5, w: 4.1, h: 0.34, fontFace: FONT, fontSize: 9.5, italic: true, color: MUTED,
  });

  card(s, 0.62, 5.08, 6.05, 1.72, { fill: "FFFFFF" });
  s.addShape(pptx.ShapeType.rect, { x: 0.62, y: 5.08, w: 6.05, h: 0.5, fill: { color: VIOLET } });
  s.addText("What the scheduler guarantees", { x: 0.88, y: 5.08, w: 5.6, h: 0.5, fontFace: FONT, fontSize: 13.5, bold: true, color: "FFFFFF", valign: "middle" });
  [
    "New cards start in minute-long learning steps; Easy skips to 4 days",
    "A forgotten card relearns from 10 minutes and returns sooner",
    "Intervals are clamped to 1–365 days, ease to 1.3–2.8",
    "At most 20 new cards a day — what you owe comes first",
  ].forEach((t, i) => {
    const y = 5.7 + i * 0.27;
    s.addShape(pptx.ShapeType.ellipse, { x: 0.9, y: y + 0.04, w: 0.11, h: 0.11, fill: { color: VIOLET } });
    s.addText(t, { x: 1.1, y, w: 5.4, h: 0.25, fontFace: FONT, fontSize: 10.5, color: "3B4E6B", valign: "middle" });
  });

  card(s, 6.82, 5.08, 6.01, 1.72, { fill: "FFFFFF" });
  s.addShape(pptx.ShapeType.rect, { x: 6.82, y: 5.08, w: 6.01, h: 0.5, fill: { color: INDIGO } });
  s.addText("Where it shows up in the app", { x: 7.08, y: 5.08, w: 5.6, h: 0.5, fontFace: FONT, fontSize: 13.5, bold: true, color: "FFFFFF", valign: "middle" });
  [
    "A Review tab with today's queue, split into due and new",
    "A due badge on every deck and on the navigation item",
    "A banner on Home when something is waiting",
    "Due-now, learning and mature tiles on the Stats tab",
  ].forEach((t, i) => {
    const y = 5.7 + i * 0.27;
    s.addShape(pptx.ShapeType.ellipse, { x: 7.1, y: y + 0.04, w: 0.11, h: 0.11, fill: { color: INDIGO } });
    s.addText(t, { x: 7.3, y, w: 5.4, h: 0.25, fontFace: FONT, fontSize: 10.5, color: "3B4E6B", valign: "middle" });
  });
})();

/* =====================================================================
   9 — OFFLINE (diagram)
   ===================================================================== */
(() => {
  const s = page("Works with no signal", "Offline-first design: the review queue lives on the device, not just online.", { accent: GREEN });
  fitImg(s, "offline-body.png", 2.322, { x: 0.5, y: 1.6, w: 12.33, h: 5.4 });
})();

/* =====================================================================
   10 — ARCHITECTURE (diagram)
   ===================================================================== */
(() => {
  const s = page("System architecture", "Three tiers, plus an offline tier that lives inside the browser.", { accent: BLUE_DK });
  fitImg(s, "architecture-body.png", 2.202, { x: 0.5, y: 1.6, w: 12.33, h: 5.4 });
})();

/* =====================================================================
   11 — SCOPE & DELIMITATION
   ===================================================================== */
(() => {
  const s = page("Scope and delimitation", "What the project covers — and what it deliberately does not.", { accent: CYAN });
  card(s, 0.62, 1.68, 6.28, 4.7, { fill: "FFFFFF" });
  s.addShape(pptx.ShapeType.rect, { x: 0.62, y: 1.68, w: 6.28, h: 0.62, fill: { color: GREEN } });
  s.addText("IN SCOPE", { x: 0.92, y: 1.68, w: 5.6, h: 0.62, fontFace: FONT, fontSize: 15, bold: true, color: "FFFFFF", valign: "middle" });
  const ins = [
    "Uploads: 8 files — PDF, DOCX, PPTX, JPG, PNG, WEBP, HEIC — or 100k characters of text",
    "AI generation with automatic failover across models and providers",
    "Four study modes with scoring, grades and session review",
    "SM-2 descendant scheduling with a daily review queue",
    "Deck management: manual decks, rename, card CRUD and reorder",
    "Progress analytics: accuracy, mastery, streak, review health",
    "Offline study with queued answers that sync automatically",
    "Google sign-in with strict per-account data isolation",
  ];
  ins.forEach((t, i) => {
    const y = 2.46 + i * 0.48;
    s.addShape(pptx.ShapeType.ellipse, { x: 0.94, y: y + 0.08, w: 0.15, h: 0.15, fill: { color: GREEN } });
    s.addText(t, { x: 1.2, y, w: 5.5, h: 0.44, fontFace: FONT, fontSize: 11.5, color: "3B4E6B", valign: "middle" });
  });

  card(s, 7.06, 1.68, 5.65, 4.7, { fill: "FFFFFF" });
  s.addShape(pptx.ShapeType.rect, { x: 7.06, y: 1.68, w: 5.65, h: 0.62, fill: { color: RED } });
  s.addText("OUT OF SCOPE", { x: 7.36, y: 1.68, w: 5.0, h: 0.62, fontFace: FONT, fontSize: 15, bold: true, color: "FFFFFF", valign: "middle" });
  const outs = [
    "No LMS features — rosters, gradebooks or teacher dashboards",
    "No sharing, public decks, comments or leaderboards",
    "No handwriting or image-only OCR; scanned PDFs without text are rejected",
    "No semantic grading of essay or free-form answers",
    "AI output is a draft — the learner verifies the content",
    "No native app, payments or institutional single sign-on",
  ];
  outs.forEach((t, i) => {
    const y = 2.46 + i * 0.48;
    s.addShape(pptx.ShapeType.ellipse, { x: 7.38, y: y + 0.08, w: 0.15, h: 0.15, fill: { color: RED } });
    s.addText(t, { x: 7.64, y, w: 4.9, h: 0.44, fontFace: FONT, fontSize: 11.5, color: "3B4E6B", valign: "middle" });
  });
  s.addText("Everything in the left column is implemented and covered by automated tests; the right column defines the honest boundary of the claim.", {
    x: 0.62, y: 6.5, w: 12.09, h: 0.4, fontFace: FONT, fontSize: 12, italic: true, color: MUTED,
  });
})();

/* =====================================================================
   12 — METHODOLOGY + TIMELINE
   ===================================================================== */
(() => {
  const s = page("Methodology and work plan", "Design-and-development research, delivered in five incremental releases over 24 weeks.", { accent: INDIGO });
  card(s, 0.62, 1.6, 5.9, 1.56, { fill: "FFFFFF" });
  s.addText("Approach", { x: 0.86, y: 1.7, w: 3.0, h: 0.34, fontFace: FONT, fontSize: 14, bold: true, color: NAVY, valign: "middle" });
  ["Design and development research (Richey & Klein).",
   "Four phases: analysis, design, development, evaluation.",
   "Requirements from a learner survey, the literature, course material.",
   "Each increment ships only when its automated tests pass."].forEach((t, i) => {
    const y = 2.08 + i * 0.25;
    s.addShape(pptx.ShapeType.ellipse, { x: 0.88, y: y + 0.05, w: 0.11, h: 0.11, fill: { color: INDIGO } });
    s.addText(t, { x: 1.08, y, w: 5.3, h: 0.24, fontFace: FONT, fontSize: 10.5, color: "3B4E6B", valign: "middle" });
  });

  card(s, 6.82, 1.6, 6.01, 1.56, { fill: "FFFFFF" });
  s.addText("Releases", { x: 7.06, y: 1.68, w: 3.0, h: 0.32, fontFace: FONT, fontSize: 14, bold: true, color: NAVY, valign: "middle" });
  const rel = [
    ["P1", "Upload, parsing, generation, Study Mode", BLUE],
    ["P2", "Exam Mode, scoring, statistics", CYAN],
    ["P3", "Sign-in, data isolation, rate limits", INDIGO],
    ["P4", "Scheduler, Review queue, offline grading", VIOLET],
    ["P5", "Service worker, snapshots, AI failover", GREEN],
  ];
  rel.forEach(([tag, d, c], i) => {
    const y = 2.08 + i * 0.22;
    pill(s, 7.06, y, 0.56, 0.2, tag, c, { size: 10 });
    s.addText(d, { x: 7.74, y, w: 5.0, h: 0.2, fontFace: FONT, fontSize: 10.5, color: "3B4E6B", valign: "middle" });
  });

  fitImg(s, "timeline-body.png", 3.16, { x: 1.0, y: 3.34, w: 11.33, h: 3.58 });
})();

/* =====================================================================
   13 — TESTING & EVALUATION
   ===================================================================== */
(() => {
  const s = page("Testing and evaluation", "Verification by automated suites, validation by users.", { accent: GREEN });
  const stats = [
    ["194", "automated checks in total", BLUE],
    ["146", "re-run for this paper — all passing", INDIGO],
    ["9", "test files across 8 npm suites", CYAN],
    ["8", "cross-account isolation checks", RED],
  ];
  stats.forEach(([v, l, c], i) => statCard(s, 0.62 + i * 3.11, 1.68, 2.88, 1.66, v, l, c));

  card(s, 0.62, 3.52, 6.28, 3.28, { fill: "FFFFFF" });
  s.addShape(pptx.ShapeType.rect, { x: 0.62, y: 3.52, w: 6.28, h: 0.58, fill: { color: BLUE } });
  s.addText("What is verified automatically", { x: 0.9, y: 3.52, w: 5.8, h: 0.58, fontFace: FONT, fontSize: 14.5, bold: true, color: "FFFFFF", valign: "middle" });
  [
    "AI failover engine under simulated rate limits and outages",
    "Spaced-repetition steps, graduations, lapses and interval clamping",
    "Offline round trip against a real server and database",
    "One account cannot read, grade or delete another's data",
    "Deck edits preserve card identity, progress and schedules",
    "Preferences, health endpoint and service-worker contract",
  ].forEach((t, i) => {
    const y = 4.24 + i * 0.42;
    s.addShape(pptx.ShapeType.ellipse, { x: 0.94, y: y + 0.07, w: 0.14, h: 0.14, fill: { color: BLUE } });
    s.addText(t, { x: 1.18, y, w: 5.5, h: 0.4, fontFace: FONT, fontSize: 11.5, color: "3B4E6B", valign: "middle" });
  });

  card(s, 7.06, 3.52, 5.65, 3.28, { fill: "FFFFFF" });
  s.addShape(pptx.ShapeType.rect, { x: 7.06, y: 3.52, w: 5.65, h: 0.58, fill: { color: INDIGO } });
  s.addText("How users will evaluate it", { x: 7.34, y: 3.52, w: 5.2, h: 0.58, fontFace: FONT, fontSize: 14.5, bold: true, color: "FFFFFF", valign: "middle" });
  [
    "Scripted usability walkthrough of all primary tasks",
    "ISO/IEC 25010-based acceptability questionnaire",
    "Student respondents, 5-point Likert scale",
    "Descriptive statistics with an adjectival rating scale",
    "Debrief interview on study-habit change",
  ].forEach((t, i) => {
    const y = 4.28 + i * 0.5;
    s.addShape(pptx.ShapeType.ellipse, { x: 7.38, y: y + 0.08, w: 0.14, h: 0.14, fill: { color: INDIGO } });
    s.addText(t, { x: 7.62, y, w: 4.9, h: 0.46, fontFace: FONT, fontSize: 11.5, color: "3B4E6B", valign: "middle" });
  });
})();

/* =====================================================================
   14 — SIGNIFICANCE + COST
   ===================================================================== */
(() => {
  const s = page("Significance and cost", "Who benefits, and what the project actually costs to run.", { accent: YELLOW });
  const who = [
    ["Students", "Deck-building and scheduling stop being the reason they don't self-test.", BLUE],
    ["Teachers", "Course material becomes practice material with almost no preparation.", INDIGO],
    ["Board reviewees", "Eight sources merge into one deck, and the scheduler decides what is urgent.", VIOLET],
    ["Low-connectivity learners", "Spaced repetition keeps working on a phone with no signal.", GREEN],
  ];
  who.forEach(([t, d, c], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 0.62 + col * 4.55, y = 1.68 + row * 1.36;
    card(s, x, y, 4.3, 1.2);
    s.addShape(pptx.ShapeType.rect, { x, y, w: 0.11, h: 1.2, fill: { color: c } });
    s.addText(t, { x: x + 0.26, y: y + 0.12, w: 3.9, h: 0.36, fontFace: FONT, fontSize: 14, bold: true, color: NAVY, valign: "middle" });
    s.addText(d, { x: x + 0.26, y: y + 0.5, w: 3.9, h: 0.6, fontFace: FONT, fontSize: 11, color: MUTED, valign: "top" });
  });

  card(s, 9.85, 1.68, 2.86, 5.12, { fill: "FFF8E7", line: "F7D57E" });
  s.addText("Cost to run", { x: 10.05, y: 1.84, w: 2.5, h: 0.4, fontFace: FONT, fontSize: 16, bold: true, color: "8A6100" });
  const costs = [["Domain", "₱700 / year"], ["Hosting", "free tier"], ["Database", "free tier"], ["AI quota", "free + ₱600"], ["Printing", "₱1,200"]];
  costs.forEach(([k, v], i) => {
    const y = 2.34 + i * 0.5;
    s.addText(k, { x: 10.05, y, w: 1.2, h: 0.42, fontFace: FONT, fontSize: 11, color: "5C4708", valign: "middle" });
    s.addText(v, { x: 11.15, y, w: 1.4, h: 0.42, fontFace: FONT, fontSize: 11, bold: true, color: "8A6100", align: "right", valign: "middle" });
  });
  s.addShape(pptx.ShapeType.line, { x: 10.05, y: 4.94, w: 2.5, h: 0, line: { color: "E3B23C", width: 1 } });
  s.addText("₱2,500 – ₱10,000", { x: 10.05, y: 5.02, w: 2.5, h: 0.5, fontFace: FONT, fontSize: 15, bold: true, color: "8A6100", align: "center" });
  s.addText("for the whole semester, mostly optional upgrades", { x: 10.05, y: 5.5, w: 2.5, h: 1.1, fontFace: FONT, fontSize: 10.5, color: "7A6220", align: "center" });

  card(s, 0.62, 4.5, 8.85, 2.3, { fill: "FFFFFF" });
  s.addText("Expected outcomes", { x: 0.88, y: 4.62, w: 5, h: 0.42, fontFace: FONT, fontSize: 17, bold: true, color: NAVY });
  [
    "A deployed, installable study app that turns a learner's own files into editable flashcards.",
    "A working spaced-repetition scheduler with a daily queue and visible progress analytics.",
    "Offline study that keeps working without a connection and syncs afterwards.",
    "Generation that survives a model or provider going down — and says so honestly.",
    "Verified quality, documented patterns, and a foundation other researchers can extend.",
  ].forEach((t, i) => {
    const y = 5.06 + i * 0.34;
    s.addShape(pptx.ShapeType.ellipse, { x: 0.94, y: y + 0.05, w: 0.13, h: 0.13, fill: { color: GREEN } });
    s.addText(t, { x: 1.18, y, w: 8.1, h: 0.32, fontFace: FONT, fontSize: 11.5, color: "3B4E6B", valign: "middle" });
  });
})();

/* =====================================================================
   15 — CLOSING
   ===================================================================== */
(() => {
  const s = pptx.addSlide();
  s.background = { color: "10233F" };
  s.addShape(pptx.ShapeType.ellipse, { x: -1.6, y: 4.4, w: 5.2, h: 5.2, fill: { color: "17325B" } });
  s.addShape(pptx.ShapeType.ellipse, { x: W - 3.2, y: -1.6, w: 4.6, h: 4.6, fill: { color: "17325B" } });

  s.addText("Learners remember what they retrieve.", {
    x: 1.0, y: 1.5, w: 9.2, h: 0.72, fontFace: FONT, fontSize: 30, bold: true, color: "FFFFFF",
  });
  s.addText("QuizTime removes the labour of applying that — by using AI to prepare the material a learner already has, and a scheduler to decide when each card should return.", {
    x: 1.0, y: 2.35, w: 9.4, h: 1.1, fontFace: FONT, fontSize: 16, color: "C7D7F5", lineSpacingMultiple: 1.15,
  });
  s.addShape(pptx.ShapeType.rect, { x: 1.0, y: 3.62, w: 3.2, h: 0.06, fill: { color: BLUE } });
  s.addText("Thank you — questions and suggestions are welcome.", {
    x: 1.0, y: 3.86, w: 9.4, h: 0.5, fontFace: FONT, fontSize: 17, bold: true, color: "FFFFFF",
  });
  s.addText("QuizTime · Flashcard Quiz Maker  ·  Concept Paper Presentation", {
    x: 1.0, y: 4.44, w: 9.4, h: 0.4, fontFace: FONT, fontSize: 12.5, color: "8FA9D6",
  });
  s.addImage({ path: path.join(HAMSTER, "hamster-celebrate.png"), x: 10.75, y: 3.6, w: 1.9, h: 2.5 });
  s.addImage({ path: LOGO, x: 10.35, y: 0.85, w: 2.7, h: 1.5 });
})();


/* =====================================================================
   Speaker notes (added after every slide exists, in order)
   ===================================================================== */
const NOTES = [
`OPENING (about 30 seconds)
Good day. Our concept paper is titled "An AI-Assisted Flashcard and Quiz Generator for Active Recall and Spaced Repetition Study" — the system is called QuizTime.

One sentence to hold on to: QuizTime turns the documents a student already has into flashcards, and then decides what that student should review today.`,
`THE PROBLEM (about 1 minute)
Start with what students actually do. They reread, they highlight — and the learning-science evidence says those are among the weakest techniques available, even though they feel productive.

The two techniques that clearly work are practice testing and distributed practice. Both have one practical obstacle: they take time. Writing cards by hand and scheduling reviews by hand is tedious, so learners skip it.

Say the punchline on the slide: students already hold thousands of pages of material; nothing turns it into retrieval practice.`,
`THE OPPORTUNITY (about 1 minute)
Two things matured at the same time.

First, generative AI can read a lecture and pull out its key concepts, definitions and enumerations in seconds. That is exactly the tedious part of making flashcards.

Second, web apps can now install themselves on a phone and keep working with no connection, so studying no longer has to depend on a stable signal.

The gap: existing flashcard apps make you type everything; AI study tools generate cards but rarely schedule them well; most assume you are always online. QuizTime joins all three.`,
`OBJECTIVES (about 1 minute)
State the general objective, then group the specific ones rather than reading all seven: build the generation pipeline; implement the four study modes; implement the scheduler; record progress; make it work offline; keep it reliable and private; and validate it.

Note that the last objective matters for the defense panel — we commit to a documented evaluation, not just a working demo.`,
`CONCEPTUAL FRAMEWORK (about 1 minute)
Use the diagram, left to right. Inputs are the learner's own material plus everything the system records. The process is: ingest, generate, let the learner curate, practise, schedule, and sync.

The important part is the dashed loop at the bottom: recorded outcomes are not just reported, they decide what comes back next. Correct recalls push a card further out; a lapse pulls it back in.`,
`HOW IT WORKS (about 1 minute)
Walk the five steps quickly. Then point at the amber strip: the chain of models. If the primary model is rate-limited or unavailable, generation moves to the next one instead of failing, the model that was skipped is remembered for a cooldown, and the learner is told which model produced the cards.

If a panelist asks "what if the AI is wrong?" — this is the right moment: generated cards are editable precisely because the learner must verify content.`,
`FOUR MODES (about 1 minute)
Each mode tests recall differently. Study Mode is the classic flip card with self-checking. Exam Mode is four-option multiple choice with points and streak bonuses. Identification Mode makes you type the answer and forgives case, punctuation and small typos. Enumeration Mode asks for a whole list and gives per-item feedback.

Every finished session ends with a results screen: accuracy, grade, points, best streak, time, and the questions that were missed — which can be sent straight into Study Mode.`,
`SPACED REPETITION (about 1 to 1.5 minutes)
This is the heart of the system. Point at the curve: one review lands before the memory fades, and each review lifts the curve higher.

Each card is graded Again, Hard, Good or Easy, and that grade sets the next interval using an SM-2 descendant — the four-button variant used by modern flashcard apps. Again brings the card back in ten minutes and lowers its ease; Good multiplies the interval by the ease factor; Easy adds a bonus.

Two details worth saying: the buttons print what they will do before you press them, because the client and server run the same scheduler; and new cards are capped at twenty a day, so what you owe comes first.`,
`OFFLINE (about 1 minute)
Many learners study on a commute or on unreliable Wi-Fi, so the app is offline-first.

The device keeps its own copy: the app shell, a cached session so you stay signed in, a snapshot of decks, cards and schedules, and an outbox. All four study modes, progress, and the review queue keep working with no signal, and answers replay when the connection returns.

Be honest about the limitation: new material still needs the network — the AI and the database live on the server.`,
`ARCHITECTURE (about 45 seconds)
Three tiers — the React and Next.js interface, the route handlers, and PostgreSQL — plus an offline tier that lives inside the browser.

Do not read every box. Highlight the safeguards instead: every query is scoped to the signed-in user, generation is rate-limited, models cool down after a limit, and there is a health check and a maintenance mode.`,
`SCOPE AND DELIMITATION (about 1 minute)
This slide usually draws questions, so be deliberate. The left column is what the system does, and every item there is covered by automated tests. The right column is what we deliberately did not build: no LMS features, no gradebook or teacher dashboard, no public decks, no handwriting recognition, no semantic grading of essay answers, no native app or payments.

The strongest statement here: AI output is a draft, and the learner remains responsible for verifying it.`,
`METHODOLOGY (about 1 minute)
We use design-and-development research: building the artifact and studying that process are equally important. Requirements came from a learner survey, the literature, and real course material.

Development is iterative in five releases, from upload and generation, through scoring and accounts, to the scheduler and finally offline capability. The timeline shows the eight phases across 24 weeks, ending with evaluation, documentation and this defense.`,
`TESTING AND EVALUATION (about 1 minute)
Verification is automated: 194 checks across nine test files. For this paper we re-ran the 146 that need no database or API key — all passed. Eight of them deliberately try to read and grade another account's data; they are rejected, as they should be. There is also an offline round trip that checks the database after answers were recorded with the network switched off.

Validation is with users: a scripted usability walkthrough and an acceptability questionnaire based on ISO/IEC 25010, answered on a five-point Likert scale and interpreted with descriptive statistics.`,
`SIGNIFICANCE AND COST (about 45 seconds)
The beneficiaries are students, teachers converting existing material, board reviewees consolidating many sources, and learners with poor connectivity.

On cost: the system is designed to run on free tiers, with the fallback chain as the safety net when a free quota runs out. We estimate 2,500 to 10,000 pesos for the semester, most of it optional upgrades.`,
`CLOSING (about 30 seconds)
Close on the claim: learners remember what they retrieve, and the barrier has never been the science but the labour of applying it. QuizTime removes that labour.

Thank the panel and invite questions.`,
];
pptx.slides.forEach((slide, i) => {
  if (NOTES[i]) slide.addNotes(NOTES[i]);
});

pptx.writeFile({ fileName: OUT }).then(() => {
  console.log("Wrote", OUT, (fs.statSync(OUT).size / 1024).toFixed(1) + " KB");
});
