/**
 * Client-side Word (.docx) text extraction (uses mammoth, dynamically imported).
 *
 * Why: serverless hosts (Vercel) cap request bodies at ~4.5 MB, so large .docx
 * files can't be uploaded as binary. Instead, we extract the text layer in the
 * browser and send only the text (usually a few hundred KB), exactly like the
 * existing PDF client-side extraction flow.
 *
 * mammoth is already a dependency (used server-side in src/lib/docx.ts).
 * It works in the browser with ArrayBuffer input.
 */

import mammoth from "mammoth";

/** Match MAX_DOCX_CHARS in src/lib/docx.ts. */
export const DOCX_TEXT_CHAR_LIMIT = 100_000;

/**
 * Extract readable text from a .docx file in the browser.
 * Throws when the file has no text content.
 */
export async function extractDocxTextClient(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const { value } = await mammoth.extractRawText({ arrayBuffer });

  const text = (value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!text) {
    throw new Error("That Word file has no readable text in it.");
  }

  return text.length > DOCX_TEXT_CHAR_LIMIT
    ? `${text.slice(0, DOCX_TEXT_CHAR_LIMIT)}\n\n[truncated]`
    : text;
}
