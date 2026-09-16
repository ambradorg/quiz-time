/**
 * Builds QuizTime-Concept-Paper.docx from the Markdown source.
 * Usage: node build-docx.js
 */
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  PageBreak, Footer, PageNumber, ExternalHyperlink, TabStopType,
  convertInchesToTwip,
} = require("docx");

const BASE = path.resolve(__dirname, "..");
const MD = path.join(BASE, "QuizTime-Concept-Paper.md");
const OUT = path.join(BASE, "QuizTime-Concept-Paper.docx");

const NAVY = "10233F";
const BLUE = "1D4ED8";
const ACCENT = "3B82F6";
const MUTED = "5B7192";
const BODY_FONT = "Times New Roman";
const HEAD_FONT = "Calibri";

/* ------------------------------------------------------------------ inline */
function inlineRuns(text, base = {}) {
  // Split on **bold**, *italic*, `code` while keeping delimiters.
  const runs = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(new TextRun({ ...base, text: text.slice(last, m.index) }));
    const tok = m[0];
    if (tok.startsWith("**")) {
      runs.push(new TextRun({ ...base, text: tok.slice(2, -2), bold: true }));
    } else if (tok.startsWith("`")) {
      runs.push(new TextRun({ ...base, text: tok.slice(1, -1), font: "Consolas", size: 21, color: "1F2937" }));
    } else {
      runs.push(new TextRun({ ...base, text: tok.slice(1, -1), italics: true }));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) runs.push(new TextRun({ ...base, text: text.slice(last) }));
  return runs.length ? runs : [new TextRun({ ...base, text })];
}

const border = { style: BorderStyle.SINGLE, size: 4, color: "C7D7F5" };
const cellBorders = { top: border, bottom: border, left: border, right: border };

function para(text, opts = {}) {
  const base = {
    font: BODY_FONT, size: 24, color: "1A1A1A",
    ...(opts.runBase || {}),
  };
  return new Paragraph({
    children: inlineRuns(text, base),
    alignment: opts.align || AlignmentType.JUSTIFIED,
    spacing: opts.spacing || { line: 360, before: 40, after: 120 },
    indent: opts.indent || { firstLine: 0 },
    ...(opts.extra || {}),
  });
}

/* ------------------------------------------------------------------ blocks */
function parseTable(lines, startIdx) {
  const rows = [];
  let i = startIdx;
  while (i < lines.length && /^\s*\|/.test(lines[i])) {
    const raw = lines[i].trim();
    const cells = raw.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const isSep = cells.every((c) => /^:?-{2,}:?$/.test(c));
    if (!isSep) rows.push(cells);
    i++;
  }
  return { rows, next: i };
}

function buildTable(rows) {
  const cols = Math.max(...rows.map((r) => r.length));
  const contentWidth = 6.5 * 1440; // 1" margins on Letter
  const firstColW = cols === 2 ? 0.34 : 0.26;

  const mkCell = (text, isHeader, colIdx) => {
    const width = Math.round(contentWidth * (colIdx === 0 ? firstColW : (1 - firstColW) / (cols - 1)));
    return new TableCell({
      width: { size: width, type: WidthType.DXA },
      borders: cellBorders,
      shading: isHeader ? { type: ShadingType.CLEAR, fill: "E4EDFD" } : undefined,
      margins: { top: 70, bottom: 70, left: 110, right: 110 },
      children: [
        new Paragraph({
          children: inlineRuns(text, {
            font: BODY_FONT, size: 21, bold: isHeader, color: isHeader ? NAVY : "1A1A1A",
          }),
          spacing: { line: 260, before: 20, after: 20 },
          alignment: AlignmentType.LEFT,
        }),
      ],
    });
  };

  return new Table({
    width: { size: contentWidth, type: WidthType.DXA },
    rows: rows.map((r, ri) => {
      const padded = [...r];
      while (padded.length < cols) padded.push("");
      return new TableRow({
        tableHeader: ri === 0,
        children: padded.map((c, ci) => mkCell(c, ri === 0, ci)),
      });
    }),
  });
}

function parseMarkdown(md) {
  const lines = md.split("\n");
  const children = [];
  let i = 0;

  // Skip the cover block (# title, A Concept Paper, Proposed by ...) — built manually.
  while (i < lines.length && lines[i].trim() !== "<!-- pagebreak -->") i++;
  i++; // skip past the cover page break

  let firstBlock = true;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { i++; continue; }

    if (t === "<!-- pagebreak -->") {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      firstBlock = true;
      i++;
      continue;
    }

    if (/^###\s+/.test(t)) {
      children.push(new Paragraph({
        children: inlineRuns(t.replace(/^###\s+/, ""), { font: HEAD_FONT, size: 25, bold: true, color: BLUE }),
        heading: HeadingLevel.HEADING_3,
        spacing: { before: firstBlock ? 0 : 260, after: 110 },
        keepNext: true,
      }));
      firstBlock = false; i++; continue;
    }

    if (/^##\s+/.test(t)) {
      const text = t.replace(/^##\s+/, "");
      children.push(new Paragraph({
        children: inlineRuns(text, { font: HEAD_FONT, size: 32, bold: true, color: NAVY }),
        heading: HeadingLevel.HEADING_1,
        spacing: { before: firstBlock ? 0 : 320, after: 160 },
        keepNext: true,
        border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: ACCENT, space: 6 } },
      }));
      firstBlock = false; i++; continue;
    }

    if (/^#\s+/.test(t)) {
      children.push(new Paragraph({
        children: inlineRuns(t.replace(/^#\s+/, ""), { font: HEAD_FONT, size: 30, bold: true, color: NAVY }),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 140 }, keepNext: true,
      }));
      i++; continue;
    }

    if (/^\s*\|/.test(line)) {
      const { rows, next } = parseTable(lines, i);
      children.push(buildTable(rows));
      children.push(new Paragraph({ children: [], spacing: { after: 120 } }));
      i = next; firstBlock = false; continue;
    }

    // Ordered list (numbers written literally so each list restarts at 1)
    if (/^\d+\.\s+/.test(t)) {
      const m = t.match(/^(\d+)\.\s+(.*)$/);
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${m[1]}.\t`, font: BODY_FONT, size: 24, color: "1A1A1A" }),
          ...inlineRuns(m[2], { font: BODY_FONT, size: 24, color: "1A1A1A" }),
        ],
        indent: { left: 720, hanging: 360 },
        tabStops: [{ type: TabStopType.LEFT, position: 720 }],
        spacing: { line: 340, before: 30, after: 90 },
        alignment: AlignmentType.JUSTIFIED,
        keepLines: true,
      }));
      i++; firstBlock = false; continue;
    }

    // Bullets
    if (/^[-*]\s+/.test(t)) {
      children.push(new Paragraph({
        children: inlineRuns(t.replace(/^[-*]\s+/, ""), { font: BODY_FONT, size: 24, color: "1A1A1A" }),
        bullet: { level: 0 },
        spacing: { line: 340, before: 30, after: 90 },
        alignment: AlignmentType.JUSTIFIED,
      }));
      i++; firstBlock = false; continue;
    }

    // Paragraph (merge wrapped lines)
    let buf = [t];
    i++;
    while (i < lines.length) {
      const nx = lines[i].trim();
      if (!nx || /^(#{1,3}\s|\||\d+\.\s|[-*]\s|<!--)/.test(nx)) break;
      buf.push(nx); i++;
    }
    children.push(para(buf.join(" ")));
    firstBlock = false;
  }
  return children;
}

/* ------------------------------------------------------------------- cover */
function coverPage() {
  return [
    new Paragraph({ children: [], spacing: { before: 2600 } }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 0 },
      children: [new TextRun({ text: "QUIZTIME", font: HEAD_FONT, size: 72, bold: true, color: BLUE, characterSpacing: 60 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 60, after: 480 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 12 } },
      children: [new TextRun({ text: "Flashcard Quiz Maker", font: HEAD_FONT, size: 30, color: MUTED })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 900, after: 200 },
      children: [new TextRun({
        text: "An AI-Assisted Flashcard and Quiz Generator for Active Recall and Spaced Repetition Study",
        font: HEAD_FONT, size: 34, bold: true, color: NAVY,
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 240, after: 0 },
      children: [new TextRun({ text: "A Concept Paper", font: BODY_FONT, size: 28, italics: true, color: MUTED })],
    }),
  ];
}

/* ---------------------------------------------------------------- document */
const md = fs.readFileSync(MD, "utf8");
const body = parseMarkdown(md);

function contentsPage() {
  const rows = [
    "Abstract",
    "Chapter 1 — Introduction and Rationale",
    "Chapter 2 — Objectives of the Study",
    "Chapter 3 — Scope and Delimitation",
    "Chapter 4 — Significance of the Study",
    "Chapter 5 — Review of Related Literature",
    "Chapter 6 — Conceptual Framework",
    "Chapter 7 — Methodology",
    "Chapter 8 — Proposed System: Features and Functionality",
    "Chapter 9 — Work Plan and Timeline",
    "Chapter 10 — Budgetary Requirements",
    "Chapter 11 — Expected Outcomes and Conclusion",
    "References",
    "Appendices A–D",
  ];
  return [
    new Paragraph({
      children: [new TextRun({ text: "Contents", font: HEAD_FONT, size: 32, bold: true, color: NAVY })],
      spacing: { after: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: ACCENT, space: 6 } },
      heading: HeadingLevel.HEADING_1,
    }),
    ...rows.map((r) => new Paragraph({
      children: [new TextRun({ text: r, font: BODY_FONT, size: 24, color: "1A1A1A" })],
      spacing: { before: 60, after: 60, line: 300 },
      indent: { left: 200 },
    })),
    new Paragraph({
      children: [new TextRun({
        text: "Figures referenced in this paper are supplied as separate image files alongside this document (docs/concept-paper/figures).",
        font: HEAD_FONT, size: 18, italics: true, color: MUTED,
      })],
      spacing: { before: 420 },
    }),
  ];
}

const doc = new Document({
  creator: "QuizTime Project",
  title: "QuizTime: An AI-Assisted Flashcard and Quiz Generator for Active Recall and Spaced Repetition Study",
  description: "Concept Paper",
  numbering: {
    config: [{
      reference: "ordered-list",
      levels: [{
        level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } },
      }],
    }],
  },
  styles: {
    default: {
      document: { run: { font: BODY_FONT, size: 24 }, paragraph: { spacing: { line: 360 } } },
    },
  },
  sections: [{
    properties: {
      page: {
        size: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: "QuizTime Concept Paper  |  Page ", font: HEAD_FONT, size: 17, color: MUTED }),
            new TextRun({ children: [PageNumber.CURRENT], font: HEAD_FONT, size: 17, color: MUTED }),
          ],
        })],
      }),
    },
    children: [
      ...coverPage(),
      new Paragraph({ children: [new PageBreak()] }),
      ...contentsPage(),
      new Paragraph({ children: [new PageBreak()] }),
      ...body,
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUT, buf);
  console.log("Wrote", OUT, (buf.length / 1024).toFixed(1) + " KB");
});
