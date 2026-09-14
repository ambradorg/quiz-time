/**
 * Client-side PDF text extraction (uses pdf.js, dynamically imported).
 *
 * Why: serverless hosts (Vercel) cap request bodies at ~4.5 MB, and the
 * Gemini API's inline-file limit is 20 MB — both far below the 50 MB the
 * UI accepts. Rather than shipping the raw bytes, big PDFs are parsed in
 * the browser and only their text layer (usually a few hundred KB) is
 * uploaded, exactly like the existing "Paste Text" flow.
 *
 * pdfjs-dist is about a megabyte, so it is dynamically imported: the library
 * and its worker are only downloaded when a user actually uploads a large
 * PDF. The "legacy" build is used because it bundles polyfills — the main
 * v6 build needs very recent browsers (2025+).
 */

import type { PDFPageProxy } from "pdfjs-dist";

/** Match MAX_TEXT_CHARS in src/app/api/scan/route.ts. */
export const PDF_TEXT_CHAR_LIMIT = 100_000;

/** Stop after this many pages — enough for any real study set, and a guard
 *  against pathological 2000-page files where page-walking would dominate. */
const PDF_PAGE_LIMIT = 500;

/** Fewer non-whitespace characters than this across the whole file means the
 *  PDF has no real text layer (a scan/photo of pages), not something parsing
 *  can fix — the caller should fall back to vision or tell the user. */
export const PDF_MIN_TEXT_CHARS = 200;

let pdfjsPromise: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;

async function loadPdfjs(): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
      // pdf.js parses in a web worker; point it at the bundled worker copy.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
        import.meta.url
      ).toString();
      return pdfjs;
    });
    // Let a failed load (offline hiccup, blocked worker) be retried.
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

/** True when the error means the PDF is encrypted/password-protected. */
export function isPasswordProtectedPdf(err: unknown): boolean {
  return (
    (err as Error | null)?.name === "PasswordException" ||
    /password/i.test(String((err as Error | null)?.message ?? ""))
  );
}

/** pdf.js text item (TextItem | TextMarkedContent), derived from the public
 *  page type so we don't depend on deep library type paths. */
type PdfTextItem = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>["items"][number];

/** Stitch pdf.js text items back into lines using their EOL markers. */
function itemsToText(items: readonly PdfTextItem[]): string {
  let text = "";
  for (const item of items) {
    if (!("str" in item)) continue; // marked-content markers carry no text
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type PdfExtractProgress = (page: number, totalPages: number) => void;

/**
 * Extract the text of a PDF in the browser.
 * Returns "" when the document has (almost) no text layer.
 * Throws for unreadable/encrypted files — callers should catch and fall
 * back to uploading the file itself when it's small enough.
 */
export async function extractPdfText(
  file: File,
  onProgress?: PdfExtractProgress
): Promise<string> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;
  try {
    const totalPages = Math.min(doc.numPages, PDF_PAGE_LIMIT);
    const chunks: string[] = [];
    let totalChars = 0;

    for (let pageNo = 1; pageNo <= totalPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      let pageText = "";
      try {
        const content = await page.getTextContent();
        pageText = itemsToText(content.items);
      } finally {
        page.cleanup();
      }
      if (pageText) chunks.push(`[Page ${pageNo}]\n${pageText}`);
      totalChars += pageText.length;
      onProgress?.(pageNo, totalPages);
      if (totalChars >= PDF_TEXT_CHAR_LIMIT) break; // plenty of study text
    }

    return chunks.join("\n\n");
  } finally {
    await loadingTask.destroy();
  }
}
