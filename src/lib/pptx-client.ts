/**
 * Client-side PowerPoint (.pptx) text extraction (uses JSZip, dynamically imported).
 *
 * Why: serverless hosts (Vercel) cap request bodies at ~4.5 MB, so large .pptx
 * files can't be uploaded as binary. Instead, we extract the text in the browser
 * and send only the text (usually a few hundred KB), exactly like the existing
 * PDF client-side extraction flow.
 *
 * JSZip is already a dependency (used server-side in src/lib/pptx.ts).
 * It works in the browser with ArrayBuffer input.
 */

import JSZip from "jszip";

/** Match MAX_PPTX_CHARS in src/lib/pptx.ts. */
export const PPTX_TEXT_CHAR_LIMIT = 100_000;

/** Decode the small set of XML entities that appear inside <a:t> runs. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-f]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export type PptxExtractProgress = (slide: number, totalSlides: number) => void;

/**
 * Extract readable text from a .pptx file in the browser.
 * Throws when the file has no slides or no text content.
 */
export async function extractPptxTextClient(
  file: File,
  onProgress?: PptxExtractProgress
): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch {
    throw new Error(
      `Couldn't read "${file.name || "that PowerPoint file"}". If it's an old .ppt file, re-save it as .pptx (or export it to PDF) and try again.`
    );
  }

  // ppt/slides/slide1.xml, slide2.xml, ... — numeric sort
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml$/i)?.[1] ?? "0", 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml$/i)?.[1] ?? "0", 10);
      return na - nb;
    });

  if (slidePaths.length === 0) {
    throw new Error(
      `Couldn't find any slides in "${file.name || "that PowerPoint file"}". If it's an old .ppt file, re-save it as .pptx (or export it to PDF) and try again.`
    );
  }

  const slidesText: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < slidePaths.length; i++) {
    const path = slidePaths[i];
    const xml = await zip.file(path)!.async("string");

    // Each <a:t> is a run of text. Join runs with spaces; preserve paragraphs
    // loosely by letting the regex collect all runs in document order.
    const runs: string[] = [];
    const re = /<a:t[^>]*>([^<]*)<\/a:t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const decoded = decodeXmlEntities(m[1]);
      if (decoded.trim()) runs.push(decoded);
    }

    const slideText = runs.join(" ").replace(/\s+/g, " ").trim();
    if (slideText) {
      slidesText.push(`--- Slide ${i + 1} ---\n${slideText}`);
      totalChars += slideText.length;
    }

    onProgress?.(i + 1, slidePaths.length);

    // Stop early if we've already got plenty of study text.
    if (totalChars >= PPTX_TEXT_CHAR_LIMIT) break;
  }

  const text = slidesText
    .join("\n\n")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!text) {
    throw new Error("That PowerPoint file has no readable text in it.");
  }

  return text.length > PPTX_TEXT_CHAR_LIMIT
    ? `${text.slice(0, PPTX_TEXT_CHAR_LIMIT)}\n\n[truncated]`
    : text;
}
