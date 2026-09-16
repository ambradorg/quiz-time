/**
 * Renders the diagram images used by the QuizTime concept-paper deck.
 * Usage: node diagrams.js
 */
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const OUT = path.join(require("os").tmpdir(), "quiztime-docs-img");
fs.mkdirSync(OUT, { recursive: true });

const NAVY = "#10233F";
const MUTED = "#5B7192";
const BLUE = "#3B82F6";
const BLUE_DK = "#1D4ED8";
const SKY = "#38BDF8";
const INDIGO = "#6366F1";
const VIOLET = "#7C3AED";
const CYAN = "#06B6D4";
const GREEN = "#10B981";
const YELLOW = "#FBBF24";
const RED = "#F43F5E";
const F = "DejaVu Sans, sans-serif";

const shadow = `
<defs>
  <filter id="sh" x="-20%" y="-20%" width="140%" height="150%">
    <feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#2B50B4" flood-opacity="0.22"/>
  </filter>
  <filter id="shs" x="-20%" y="-20%" width="140%" height="150%">
    <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#2B50B4" flood-opacity="0.18"/>
  </filter>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="${BLUE}"/>
  </marker>
  <marker id="arrowG" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="${GREEN}"/>
  </marker>
</defs>`;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function card(x, y, w, h, { fill = "#FFFFFF", rx = 26, stroke = "#C7D7F5", sw = 2, filter = "sh" } = {}) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" filter="url(#${filter})"/>`;
}

function text(x, y, s, { size = 22, fill = NAVY, weight = "normal", anchor = "start", opacity = 1, spacing = 0 } = {}) {
  return `<text x="${x}" y="${y}" font-family="${F}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" opacity="${opacity}" letter-spacing="${spacing}">${esc(s)}</text>`;
}

function wrapText(x, y, s, { size = 20, fill = MUTED, weight = "normal", anchor = "start", width = 40, lh = 27 } = {}) {
  const words = s.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) { lines.push(line.trim()); line = w; }
    else line += " " + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l, i) => text(x, y + i * lh, l, { size, fill, weight, anchor })).join("");
}

function pill(x, y, w, h, label, color, { size = 19, fill = "#FFFFFF" } = {}) {
  return card(x, y, w, h, { fill: color, rx: h / 2, stroke: color, sw: 0, filter: "shs" }) +
    text(x + w / 2, y + h / 2 + size * 0.36, label, { size, fill, weight: "bold", anchor: "middle" });
}

async function render(name, w, h, body, bg = "#EEF4FF") {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${shadow}
  <rect width="${w}" height="${h}" fill="${bg}"/>
  ${body}
</svg>`;
  const file = path.join(OUT, `${name}.png`);
  await sharp(Buffer.from(svg)).png().toFile(file);
  console.log("  ", name, `${w}x${h}`);
}

/* ------------------------------------------------------------------ IPO */
async function ipo() {
  const W = 1700, H = 960;
  const colW = 440, colH = 470, y = 200;
  const cols = [
    { x: 60, title: "INPUT", color: BLUE, items: ["Learner's own material — PDF, DOCX, PPTX, photos, pasted text", "Account and study history", "Every right / wrong answer recorded", "Scheduling state — ease, interval, due date", "System configuration — models, limits"] },
    { x: 630, title: "PROCESS", color: INDIGO, items: ["Ingest and prepare the material", "Generate 8–20 cards with AI failover", "Learner curates and edits the deck", "Practise in four study modes", "Schedule each card and record results", "Sync offline answers back to the server"] },
    { x: 1200, title: "OUTPUT", color: GREEN, items: ["A reusable, editable study set", "Measurable recall — accuracy and mastery", "A daily review queue that adapts", "Study that keeps working offline"] },
  ];
  let s = "";
  cols.forEach((c) => {
    s += card(c.x, y, colW, colH);
    s += `<rect x="${c.x}" y="${y}" width="${colW}" height="76" rx="26" fill="${c.color}"/>`;
    s += `<rect x="${c.x}" y="${y + 50}" width="${colW}" height="26" fill="${c.color}"/>`;
    s += text(c.x + colW / 2, y + 50, c.title, { size: 30, fill: "#FFFFFF", weight: "bold", anchor: "middle", spacing: 3 });
    c.items.forEach((it, i) => {
      const iy = y + 116 + i * 62;
      s += `<circle cx="${c.x + 34}" cy="${iy - 6}" r="6" fill="${c.color}"/>`;
      s += wrapText(c.x + 56, iy, it, { size: 19, fill: "#22304A", width: 46, lh: 24 });
    });
  });
  // arrows
  const midY = y + colH / 2;
  s += `<line x1="${60 + colW + 16}" y1="${midY}" x2="${630 - 18}" y2="${midY}" stroke="${BLUE}" stroke-width="6" marker-end="url(#arrow)"/>`;
  s += `<line x1="${630 + colW + 16}" y1="${midY}" x2="${1200 - 18}" y2="${midY}" stroke="${BLUE}" stroke-width="6" marker-end="url(#arrow)"/>`;
  // feedback loop
  const fbY = y + colH + 88;
  s += `<path d="M ${1200 + colW / 2} ${y + colH} L ${1200 + colW / 2} ${fbY} L ${60 + colW / 2} ${fbY} L ${60 + colW / 2} ${y + colH + 10}" fill="none" stroke="${GREEN}" stroke-width="5" stroke-dasharray="14 10" marker-end="url(#arrowG)"/>`;
  s += text(910, fbY - 26, "Feedback loop — every recorded answer reshapes what the learner sees next", { size: 20, fill: "#0F766E", weight: "bold", anchor: "middle" });
  s += text(60, 92, "Input – Process – Output", { size: 34, fill: NAVY, weight: "bold" });
  s += text(60, 134, "How QuizTime turns a learner's own documents into scheduled retrieval practice", { size: 21, fill: MUTED });
  await render("ipo", W, H, s);
}

/* -------------------------------------------------------------- PIPELINE */
async function pipeline() {
  const W = 1940, H = 760;
  const stages = [
    { n: "1", t: "Bring your material", c: BLUE, l: ["Up to 8 files at once —", "PDF · Word · PowerPoint ·", "photos · pasted text"] },
    { n: "2", t: "Prepare it", c: SKY, l: ["Photos downscaled in the", "browser; large documents", "converted to text in parts"] },
    { n: "3", t: "AI writes the cards", c: INDIGO, l: ["8–20 cards with question,", "answer, hint and difficulty", "plus a title and summary"] },
    { n: "4", t: "You curate", c: VIOLET, l: ["Edit, reorder, add or delete", "— edits keep your existing", "progress and schedule"] },
    { n: "5", t: "Study and review", c: GREEN, l: ["Four practice modes now,", "plus a scheduled queue", "of what to review today"] },
  ];
  const cw = 316, gap = 60, y = 240, ch = 330;
  let s = text(60, 92, "From a file to a study habit", { size: 36, fill: NAVY, weight: "bold" });
  s += text(60, 132, "The generation pipeline, and the failover that keeps it running", { size: 22, fill: MUTED });
  stages.forEach((st, i) => {
    const x = 60 + i * (cw + gap);
    s += card(x, y, cw, ch);
    s += `<rect x="${x}" y="${y}" width="${cw}" height="10" rx="5" fill="${st.c}"/>`;
    s += `<circle cx="${x + 44}" cy="${y + 62}" r="26" fill="${st.c}"/>`;
    s += text(x + 44, y + 72, st.n, { size: 26, fill: "#FFFFFF", weight: "bold", anchor: "middle" });
    s += text(x + 30, y + 132, st.t, { size: 23, fill: NAVY, weight: "bold" });
    st.l.forEach((ln, j) => {
      s += text(x + 30, y + 176 + j * 30, ln, { size: 18, fill: "#3B4E6B" });
    });
    if (i < stages.length - 1) {
      s += `<line x1="${x + cw + 12}" y1="${y + ch / 2}" x2="${x + cw + gap - 14}" y2="${y + ch / 2}" stroke="${BLUE}" stroke-width="6" marker-end="url(#arrow)"/>`;
    }
  });
  // failover strip
  const fy = 630;
  s += card(60, fy, W - 120, 86, { fill: "#FFF8E7", stroke: "#F7D57E" });
  s += text(96, fy + 54, "Never blocked by one model", { size: 22, fill: "#8A6100", weight: "bold" });
  const chain = ["Gemini 3.6 Flash", "Flash Lite", "Antigravity", "OpenRouter free"];
  const widths = [212, 158, 168, 224];
  let cx = 470;
  chain.forEach((m, i) => {
    const bw = widths[i];
    s += pill(cx, fy + 20, bw, 46, m, "#FFFFFF", { size: 17, fill: "#8A6100" });
    s += `<rect x="${cx}" y="${fy + 20}" width="${bw}" height="46" rx="23" fill="none" stroke="#E3B23C" stroke-width="2"/>`;
    if (i < chain.length - 1) {
      s += `<line x1="${cx + bw + 6}" y1="${fy + 43}" x2="${cx + bw + 38}" y2="${fy + 43}" stroke="#E3B23C" stroke-width="5" marker-end="url(#arrow)"/>`;
    }
    cx += bw + 46;
  });
  await render("pipeline", W, H, s);
}

/* ----------------------------------------------------------- FORGETTING */
async function curve() {
  const W = 1500, H = 780;
  const x0 = 130, y0 = 616, x1 = 1400, yTop = 210;
  const sx = (v) => x0 + (x1 - x0) * v;             // 0..1
  const sy = (v) => y0 - (y0 - yTop) * v;           // recall 0..1
  const decay = (start, from, to, k = 5.4) => {
    // exponential decay path sampled from `from` to `to` (in x units)
    const pts = [];
    for (let u = 0; u <= 1.0001; u += 0.02) {
      const xx = from + (to - from) * u;
      const yy = start * Math.exp(-k * (xx - from));
      pts.push(`${sx(xx).toFixed(1)},${sy(yy).toFixed(1)}`);
    }
    return "M " + pts.join(" L ");
  };
  let s = text(130, 92, "Why spacing beats cramming", { size: 36, fill: NAVY, weight: "bold" });
  s += text(130, 134, "Each review lands just before the memory fades, and lifts the curve higher each time", { size: 22, fill: MUTED });

  // axes
  s += `<line x1="${x0}" y1="${yTop - 62}" x2="${x0}" y2="${y0}" stroke="#9DB4DA" stroke-width="3"/>`;
  s += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="#9DB4DA" stroke-width="3"/>`;
  s += text(x0 - 18, yTop - 68, "RECALL", { size: 18, fill: MUTED, anchor: "end", weight: "bold" });
  s += text(x1, y0 + 42, "TIME", { size: 18, fill: MUTED, anchor: "end", weight: "bold" });

  // single-session cram curve (grey)
  s += `<path d="${decay(1, 0.02, 0.98)}" fill="none" stroke="#B9C7E2" stroke-width="5" stroke-dasharray="12 10"/>`;
  s += text(sx(0.74), sy(0.1) + 4, "Forgotten", { size: 20, fill: "#8FA2C2", weight: "bold" });

  // spaced reviews: boosts at 0.30, 0.56, 0.82
  const reviews = [
    { at: 0.30, ceil: 0.86 },
    { at: 0.56, ceil: 0.94 },
    { at: 0.82, ceil: 0.995 },
  ];
  let path = decay(1, 0.02, reviews[0].at);
  reviews.forEach((r, i) => {
    path += ` L ${sx(r.at).toFixed(1)},${sy(r.ceil).toFixed(1)}`;
    const nextAt = i < reviews.length - 1 ? reviews[i + 1].at : 0.99;
    path += " " + decay(r.ceil, r.at, nextAt).replace(/^M/, "L").replace(/^L [^L]*L/, "L");
  });
  // rebuild properly: each segment decays from its own ceiling
  path = decay(1, 0.02, reviews[0].at);
  let prev = reviews[0];
  for (let i = 0; i < reviews.length; i++) {
    path += ` L ${sx(prev.at).toFixed(1)},${sy(prev.ceil).toFixed(1)}`;
    const nextAt = i < reviews.length - 1 ? reviews[i + 1].at : 0.99;
    const seg = decay(prev.ceil, prev.at, nextAt);
    path += " " + seg.replace(/^M\s*/, "L ");
    if (i < reviews.length - 1) prev = reviews[i + 1];
  }
  s += `<path d="${path}" fill="none" stroke="${BLUE}" stroke-width="7" stroke-linejoin="round"/>`;

  reviews.forEach((r, i) => {
    s += `<circle cx="${sx(r.at)}" cy="${sy(r.ceil)}" r="14" fill="#FFFFFF" stroke="${BLUE}" stroke-width="7"/>`;
    s += text(sx(r.at), sy(r.ceil) - 34, ["Review 1", "Review 2", "Review 3"][i], { size: 21, fill: BLUE_DK, weight: "bold", anchor: "middle" });
    s += `<line x1="${sx(r.at)}" y1="${sy(r.ceil)}" x2="${sx(r.at)}" y2="${y0}" stroke="#BFD2F2" stroke-width="2" stroke-dasharray="6 8"/>`;
  });
  s += text(sx(0.05), sy(0.98) - 16, "New card learned", { size: 21, fill: NAVY, weight: "bold" });

  // interval labels
  const gaps = [[0.30, 0.56, "≈ 3 days"], [0.56, 0.82, "≈ 8 days"], [0.82, 0.99, "≈ 20 days"]];
  gaps.forEach(([a, b, label]) => {
    const mx = (sx(a) + sx(b)) / 2;
    s += card(mx - 70, y0 + 52, 140, 44, { fill: "#E4EDFD", stroke: "#C7D7F5", rx: 22, filter: "shs" });
    s += text(mx, y0 + 81, label, { size: 19, fill: BLUE_DK, weight: "bold", anchor: "middle" });
    s += `<line x1="${sx(a)}" y1="${y0 + 22}" x2="${sx(b)}" y2="${y0 + 22}" stroke="${BLUE}" stroke-width="3"/>`;
    s += `<line x1="${sx(a)}" y1="${y0 + 14}" x2="${sx(a)}" y2="${y0 + 30}" stroke="${BLUE}" stroke-width="3"/>`;
    s += `<line x1="${sx(b)}" y1="${y0 + 14}" x2="${sx(b)}" y2="${y0 + 30}" stroke="${BLUE}" stroke-width="3"/>`;
  });
  await render("curve", W, H, s);
}

/* ---------------------------------------------------------- OFFLINE MAP */
async function offline() {
  const W = 1700, H = 900;
  let s = text(60, 92, "Study with no signal", { size: 36, fill: NAVY, weight: "bold" });
  s += text(60, 134, "The device keeps its own copy, queues new answers, and syncs the moment the network returns", { size: 22, fill: MUTED });

  // device
  s += card(60, 200, 800, 620, { fill: "#FFFFFF" });
  s += `<rect x="60" y="200" width="800" height="76" rx="26" fill="${BLUE}"/>`;
  s += `<rect x="60" y="250" width="800" height="26" fill="${BLUE}"/>`;
  s += text(96, 250, "DEVICE  ·  installed web app", { size: 27, fill: "#FFFFFF", weight: "bold" });
  const items = [
    ["App shell", "pages and assets cached by the service worker", BLUE],
    ["Cached session", "you stay signed in with no network", INDIGO],
    ["Snapshot store", "decks, cards, progress and review schedules", VIOLET],
    ["Outbox", "answers and progress queued in order", YELLOW],
  ];
  items.forEach((it, i) => {
    const iy = 320 + i * 128;
    s += card(96, iy, 728, 106, { fill: "#F7FAFF", stroke: "#D7E3F8", rx: 20, filter: "shs" });
    s += `<rect x="96" y="${iy}" width="10" height="106" rx="5" fill="${it[2]}"/>`;
    s += `<circle cx="${150}" cy="${iy + 53}" r="18" fill="${it[2]}" opacity="0.18"/>`;
    s += `<circle cx="${150}" cy="${iy + 53}" r="9" fill="${it[2]}"/>`;
    s += text(190, iy + 46, it[0], { size: 24, fill: NAVY, weight: "bold" });
    s += text(190, iy + 78, it[1], { size: 19, fill: "#3B4E6B" });
  });

  // server
  s += card(940, 200, 700, 430, { fill: "#FFFFFF" });
  s += `<rect x="940" y="200" width="700" height="76" rx="26" fill="${GREEN}"/>`;
  s += `<rect x="940" y="250" width="700" height="26" fill="${GREEN}"/>`;
  s += text(976, 250, "SERVER  ·  source of truth", { size: 27, fill: "#FFFFFF", weight: "bold" });
  const srv = [
    ["API", "decks · cards · review · stats · bundle"],
    ["PostgreSQL", "accounts, results and schedules"],
    ["AI providers", "used only when new material arrives"],
  ];
  srv.forEach((it, i) => {
    const iy = 320 + i * 100;
    s += card(976, iy, 628, 78, { fill: "#F6FFFB", stroke: "#CBEBDC", rx: 18, filter: "shs" });
    s += text(1012, iy + 34, it[0], { size: 23, fill: "#0B7A5B", weight: "bold" });
    s += text(1012, iy + 62, it[1], { size: 18, fill: "#3B4E6B" });
  });

  // sync arrow
  s += `<path d="M 880 300 L 930 300" stroke="${BLUE}" stroke-width="6" marker-end="url(#arrow)"/>`;
  s += `<path d="M 930 560 L 880 560" stroke="${GREEN}" stroke-width="6" marker-end="url(#arrowG)"/>`;
  s += card(940, 660, 700, 160, { fill: "#FFF8E7", stroke: "#F7D57E", rx: 24 });
  s += text(976, 706, "When the network returns", { size: 24, fill: "#8A6100", weight: "bold" });
  s += wrapText(976, 744, "queued answers replay in order and in batches — in the background where the browser allows it, otherwise on next launch, reconnect or focus.", { size: 19, fill: "#5C4708", width: 66, lh: 26 });
  s += text(60, 866, "New material still needs a connection: the AI and the database live on the server. Studying what is already saved does not.", { size: 20, fill: MUTED });
  await render("offline", W, H, s);
}

/* ----------------------------------------------------------- ARCHITECTURE */
async function architecture() {
  const W = 1700, H = 940;
  let s = text(60, 92, "System architecture", { size: 36, fill: NAVY, weight: "bold" });
  s += text(60, 134, "A three-tier web application with an offline tier inside the browser", { size: 22, fill: MUTED });

  const layer = (y, h, label, color, x = 60, w = 1160) => {
    let out = card(x, y, w, h, { fill: "#FFFFFF" });
    out += `<rect x="${x}" y="${y}" width="10" height="${h}" rx="5" fill="${color}"/>`;
    out += text(x + 34, y + 40, label, { size: 25, fill: color, weight: "bold" });
    return out;
  };
  const chip = (x, y, w, h, title, sub, color) =>
    card(x, y, w, h, { fill: "#F7FAFF", stroke: "#D7E3F8", rx: 18, filter: "shs" }) +
    text(x + 22, y + 40, title, { size: 21, fill: NAVY, weight: "bold" }) +
    text(x + 22, y + 68, sub, { size: 17, fill: "#3B4E6B" });

  // presentation
  s += layer(190, 168, "Presentation  ·  React 19 + Next.js 16", BLUE);
  s += chip(96, 250, 340, 92, "Web UI", "Home · Upload · My Sets · Stats", BLUE);
  s += chip(456, 250, 340, 92, "Study engine", "Study · Exam · Identify · Enumerate", INDIGO);
  s += chip(816, 250, 340, 92, "Installed PWA", "installable, responsive, offline shell", VIOLET);

  // application
  s += layer(386, 168, "Application  ·  Next.js route handlers", INDIGO);
  s += chip(96, 446, 262, 92, "Auth", "Google sign-in, sessions", INDIGO);
  s += chip(374, 446, 262, 92, "Generate", "parsing + AI failover", INDIGO);
  s += chip(652, 446, 262, 92, "Manage", "decks, cards, reorder", INDIGO);
  s += chip(930, 446, 226, 92, "Review", "queue + grading", INDIGO);
  s += chip(96, 386 + 168 - 40, 0, 0, "", "", INDIGO); // noop

  // data
  s += layer(582, 120, "Data  ·  PostgreSQL + Drizzle ORM", GREEN);
  s += text(96, 660, "users · study_sessions · flashcards · card_progress · study_results · card_reviews", { size: 19, fill: "#3B4E6B" });

  // external
  s += card(1300, 190, 340, 300, { fill: "#FFF8E7", stroke: "#F7D57E" });
  s += text(1336, 240, "External services", { size: 24, fill: "#8A6100", weight: "bold" });
  [["Google Gemini", "primary generation"], ["OpenRouter", "fallback generation"], ["Google OAuth", "identity"]].forEach((it, i) => {
    const iy = 280 + i * 68;
    s += text(1336, iy + 20, "•  " + it[0], { size: 21, fill: "#6B4E00", weight: "bold" });
    s += text(1356, iy + 46, it[1], { size: 17, fill: "#7A6220" });
  });
  s += `<line x1="1220" y1="340" x2="1296" y2="340" stroke="${BLUE}" stroke-width="5" stroke-dasharray="10 8" marker-end="url(#arrow)"/>`;

  // offline tier
  s += card(1300, 530, 340, 300, { fill: "#EFF6FF", stroke: "#C7D7F5" });
  s += text(1336, 580, "Offline tier", { size: 24, fill: BLUE_DK, weight: "bold" });
  [["Service worker", "shell + background sync"], ["IndexedDB", "deck snapshots"], ["Outbox", "queued writes"]].forEach((it, i) => {
    const iy = 620 + i * 68;
    s += text(1336, iy + 20, "•  " + it[0], { size: 21, fill: NAVY, weight: "bold" });
    s += text(1356, iy + 46, it[1], { size: 17, fill: "#3B4E6B" });
  });

  // safeguards strip
  const sy = 730;
  s += card(60, sy, 1160, 130, { fill: "#F4F7FF", stroke: "#C7D7F5" });
  s += text(96, sy + 40, "Cross-cutting safeguards", { size: 23, fill: NAVY, weight: "bold" });
  const safe = ["Per-user data isolation on every query", "Rate-limited generation endpoint", "Model cooldown + honest fallback notice", "Health check and maintenance mode"];
  safe.forEach((t, i) => {
    const bx = 96 + i * 282;
    s += `<circle cx="${bx + 9}" cy="${sy + 78}" r="7" fill="${GREEN}"/>`;
    s += wrapText(bx + 28, sy + 84, t, { size: 18, fill: "#3B4E6B", width: 24, lh: 22 });
  });
  await render("architecture", W, H, s);
}

/* ------------------------------------------------------------- TIMELINE */
async function timeline() {
  const W = 1700, H = 700;
  let s = text(60, 92, "Work plan — 24 weeks", { size: 36, fill: NAVY, weight: "bold" });
  s += text(60, 134, "Eight phases, in five incremental releases", { size: 22, fill: MUTED });

  const x0 = 520, axisW = W - 520 - 80;
  const wk = (w) => x0 + (axisW * w) / 24;
  // axis
  for (let w = 0; w <= 24; w += 4) {
    s += `<line x1="${wk(w)}" y1="200" x2="${wk(w)}" y2="620" stroke="#D7E3F8" stroke-width="2"/>`;
    s += text(wk(w), 186, `W${w}`, { size: 17, fill: MUTED, anchor: "middle" });
  }
  const phases = [
    ["Planning & analysis", 1, 4, BLUE, "concept paper, requirements"],
    ["Design", 4, 8, SKY, "architecture, ERD, wireframes"],
    ["P1–P2  Core & practice", 6, 12, INDIGO, "upload, generation, Study, Exam, scoring"],
    ["P3  Accounts & security", 10, 14, VIOLET, "sign-in, isolation, rate limits"],
    ["P4  Spaced repetition", 13, 17, CYAN, "scheduler, review queue, badges"],
    ["P5  Offline & resilience", 16, 20, GREEN, "PWA, snapshots, outbox, failover"],
    ["Testing & evaluation", 19, 22, YELLOW, "automated suites, usability, survey"],
    ["Documentation & defense", 22, 24, RED, "manual, technical docs, manuscript"],
  ];
  phases.forEach((p, i) => {
    const y = 212 + i * 52;
    s += text(60, y + 28, p[0], { size: 21, fill: NAVY, weight: "bold" });
    s += text(60, y + 50, p[4], { size: 16, fill: MUTED });
    const bx = wk(p[1]), bw = wk(p[2]) - wk(p[1]);
    s += `<rect x="${bx}" y="${y + 6}" width="${Math.max(bw, 26)}" height="26" rx="13" fill="${p[3]}" filter="url(#shs)"/>`;
  });
  await render("timeline", W, H, s);
}

(async () => {
  console.log("Rendering diagrams →", OUT);
  await ipo();
  await pipeline();
  await curve();
  await offline();
  await architecture();
  await timeline();
  console.log("done");
})();
