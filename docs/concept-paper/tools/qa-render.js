/**
 * QA renderer: reads the generated .pptx and rasterizes each slide from its
 * own XML so layout problems (overflow, overlap, off-slide shapes) are visible.
 * Also runs analytical checks on every text box.
 *
 * Usage: node qa-render.js
 */
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const sharp = require("sharp");

const BASE = path.resolve(__dirname, "..");
const PPTX = path.join(BASE, "QuizTime-Concept-Presentation.pptx");
const OUTDIR = path.join(require("os").tmpdir(), "quiztime-docs-qa");
const EMU = 914400;
const W = 13.333, H = 7.5;
const SCALE = 120; // px per inch
const AVE_CHAR = 0.475; // average glyph width in em (approximation for Calibri)

fs.mkdirSync(OUTDIR, { recursive: true });

const warnings = [];
const unesc = (s) => String(s)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, "&");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function textOfNode(node) {
  // concatenate all a:t runs, tracking paragraph breaks
  const paras = [];
  const pRegex = /<a:p>([\s\S]*?)<\/a:p>/g;
  let m;
  while ((m = pRegex.exec(node)) !== null) {
    const runs = [...m[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((r) => r[1]);
    paras.push(unesc(runs.join("")));
  }
  return paras;
}

function attr(str, name) {
  const m = str.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function estimateLines(text, widthIn, fontSizePt, bold) {
  if (!text) return 0;
  const usable = widthIn * 72 - 8; // cell insets
  const emWidth = fontSizePt * AVE_CHAR * (bold ? 1.04 : 1);
  const perLine = Math.max(1, Math.floor(usable / emWidth));
  return Math.max(1, Math.ceil(text.length / perLine));
}

(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(PPTX));
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));

  const sheets = [];

  for (const [si, sf] of slideFiles.entries()) {
    const xml = await zip.file(sf).async("string");
    const relsXml = await zip.file(sf.replace("slides/", "slides/_rels/") + ".rels").async("string");
    const rels = {};
    [...relsXml.matchAll(/<Relationship Id="([^"]*)"[^>]*Target="([^"]*)"/g)].forEach((m) => { rels[m[1]] = m[2]; });

    const bgMatch = xml.match(/<p:bg>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/);
    const bgColor = bgMatch ? bgMatch[1] : "FFFFFF";
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}">`;
    svg += `<rect width="${W}" height="${H}" fill="#${bgColor}"/>`;

    const shapes = [...xml.matchAll(/<p:(sp|pic)>([\s\S]*?)<\/p:\1>/g)];
    let n = 0;
    for (const [, kind, body] of shapes) {
      const off = body.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
      const ext = body.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
      if (!off || !ext) continue;
      const x = +off[1] / EMU, y = +off[2] / EMU, w = +ext[1] / EMU, h = +ext[2] / EMU;
      const name = attr(body, "name") || `shape${n}`;

      if (x < -0.05 || y < -0.05 || x + w > W + 0.05 || y + h > H + 0.05) {
        // decorative bleeding shapes are intentional only when they are fills
        const isDeco = /<a:solidFill><a:srgbClr val="(DCE9FF|E6F0FF|17325B)"\/>/.test(body);
        if (!isDeco) warnings.push(`slide ${si + 1}: "${name}" extends off-slide (${x.toFixed(2)},${y.toFixed(2)} ${w.toFixed(2)}x${h.toFixed(2)})`);
      }

      if (kind === "pic") {
        const blip = body.match(/r:embed="([^"]*)"/);
        const target = blip ? rels[blip[1]] : null;
        if (target) {
          const mediaPath = "ppt/" + target.replace(/^\.\.\//, "");
          const data = await zip.file(mediaPath).async("base64");
          const ext2 = path.extname(mediaPath).slice(1);
          svg += `<image x="${x}" y="${y}" width="${w}" height="${h}" xlink:href="data:image/${ext2};base64,${data}" preserveAspectRatio="none"/>`;
        }
        continue;
      }

      // geometry — the shape's own properties live in <p:spPr>, never take the
      // first solidFill in the whole shape (that would be the text colour).
      const spPrMatch = body.match(/<p:spPr>([\s\S]*?)<\/p:spPr>/);
      const spPr = spPrMatch ? spPrMatch[1] : "";
      const preset = attr(spPr, "prst");
      const fillMatch = spPr.match(/<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/);
      const alphaMatch = spPr.match(/<a:srgbClr val="([0-9A-Fa-f]{6})"[^>]*>\s*<a:alpha val="(\d+)"/);
      const fill = fillMatch ? fillMatch[1] : null;
      const opacity = alphaMatch ? Number(alphaMatch[2]) / 100000 : 1;
      const lineMatch = spPr.match(/<a:ln[^>]*>([\s\S]*?)<\/a:ln>/);
      const lineColor = lineMatch ? (lineMatch[1].match(/<a:srgbClr val="([0-9A-Fa-f]{6})"/) || [])[1] : null;
      const lineW = lineMatch ? (attr(lineMatch[1], "w") || 12700) / 12700 / 72 * 96 / SCALE : 0;

      if (preset === "ellipse") {
        svg += `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill ? "#" + fill : "none"}" opacity="${opacity}"/>`;
      } else if (preset === "roundRect") {
        const r = Math.min(h / 2, Number(attr(body, "rectRadius") || body.match(/<a:gd name="adj" fmla="val (\d+)"/) ? 0 : 0) || 0.08);
        const rr = Math.min(r, w / 2, h / 2);
        svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rr}" ry="${rr}" fill="${fill ? "#" + fill : "none"}" ${lineColor && lineW > 0 ? `stroke="#${lineColor}" stroke-width="${lineW}"` : ""} opacity="${opacity}"/>`;
      } else {
        svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill ? "#" + fill : "none"}" opacity="${opacity}"/>`;
      }

      // text
      if (body.includes("<a:t>")) {
        const paras = textOfNode(body);
        const bodyPr = body.match(/<a:bodyPr([^>]*)>/);
        const anchor = bodyPr ? attr(bodyPr[1], "anchor") || "t" : "t";
        const sizes = [...body.matchAll(/sz="(\d+)"/g)].map((m) => +m[1] / 100);
        const fontSize = sizes.length ? Math.max(...sizes) : 18;
        const bold = /b="1"/.test(body);
        const body2 = body.replace(/<p:spPr>[\s\S]*?<\/p:spPr>/, "");
        const colorMatch = [...body2.matchAll(/<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/g)].map((m) => [null, m[1]]).pop();
        const color = colorMatch ? colorMatch[1] : "10233F";
        const lineSpacingMatch = body.match(/<a:lnSpc><a:spcPct val="(\d+)"\/>/);
        const lineSpacing = lineSpacingMatch ? Number(lineSpacingMatch[1]) / 100000 : 1;

        // wrap + place
        const lines = [];
        for (const p of paras) {
          const est = estimateLines(p, w, fontSize, bold);
          const perLine = Math.max(1, Math.ceil(p.length / est));
          if (!p) { lines.push(""); continue; }
          for (let i = 0; i < p.length; i += perLine) lines.push(p.slice(i, i + perLine));
        }
        const lh = fontSize * 1.22 * lineSpacing;
        const totalH = lines.length * lh;
        const needed = totalH / 72;
        if (needed > h + 0.06) {
          warnings.push(`slide ${si + 1}: "${name}" text may overflow — needs ~${needed.toFixed(2)}in, box is ${h.toFixed(2)}in (${lines.length} lines @ ${fontSize}pt)`);
        }
        let ty;
        if (anchor === "ctr") ty = y + h / 2 - totalH / 144 + fontSize / 144;
        else if (anchor === "b") ty = y + h - totalH / 72 + fontSize / 144;
        else ty = y + fontSize / 144 + 0.02;

        lines.forEach((ln, li) => {
          svg += `<text x="${x + 0.06}" y="${ty + (li * lh) / 72}" font-family="DejaVu Sans, sans-serif" font-size="${fontSize / 72}" fill="#${color}" font-weight="${bold ? "bold" : "normal"}">${esc(ln)}</text>`;
        });
      }
      n++;
    }

    svg += `</svg>`;
    const png = await sharp(Buffer.from(svg)).png().toFile(path.join(OUTDIR, `slide-${String(si + 1).padStart(2, "0")}.png`));
    sheets.push(path.join(OUTDIR, `slide-${String(si + 1).padStart(2, "0")}.png`));
  }

  // contact sheets
  const perSheet = 4, cols = 2;
  const tileW = Math.round(W * SCALE * 0.5), tileH = Math.round(H * SCALE * 0.5);
  for (let i = 0; i < sheets.length; i += perSheet) {
    const group = sheets.slice(i, i + perSheet);
    const comps = await Promise.all(group.map((g) => sharp(g).resize(tileW, tileH).toBuffer()));
    const svgParts = comps.map((buf, j) => {
      const cx = (j % cols) * (tileW + 12), cy = Math.floor(j / cols) * (tileH + 12);
      return { input: buf, left: cx, top: cy };
    });
    await sharp({
      create: { width: cols * tileW + 12, height: Math.ceil(group.length / cols) * (tileH + 12), channels: 3, background: "#1a2233" },
    }).composite(svgParts).png().toFile(path.join(OUTDIR, `sheet-${Math.floor(i / perSheet) + 1}.png`));
  }

  console.log("slides rendered:", sheets.length);
  if (warnings.length) {
    console.log("\nWARNINGS (" + warnings.length + "):");
    warnings.forEach((w) => console.log(" -", w));
  } else {
    console.log("no layout warnings");
  }
})();
