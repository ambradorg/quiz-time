/**
 * OpenRouter provider adapter for the failover engine (src/lib/failover.ts).
 *
 * OpenRouter is an OpenAI-compatible gateway with a rotating pool of `:free`
 * models — the ones used as QuizTime's last-resort fallback. The pool turns
 * over from month to month (Llama and DeepSeek `:free` variants come and
 * go), which is why the candidate list is env-configurable
 * (OPENROUTER_MODELS, see src/lib/failover.ts) and why a retired model
 * simply 404s and gets skipped by the engine.
 *
 * Differences from Gemini that matter here:
 *
 *   - No PDF input: pages are converted to text on the server (pdf.js,
 *     already a dependency) before anything is sent.
 *   - No HEIC/HEIF: such uploads get UnsupportedInputError so the engine
 *     tries the next candidate instead of failing the whole request.
 *   - Errors can arrive as HTTP 200 with an `error` object in the body (an
 *     upstream provider failure, e.g. "code: 502, provider_unavailable").
 *     The real status is lifted out of the body so the engine classifies it
 *     correctly.
 *   - Rate limits are per-UPSTREAM-provider as well: a free model can 429
 *     with "temporarily rate-limited upstream" even on a fresh account — the
 *     engine treats that like any other 429 (cooldown, next model).
 */
import type { AiPart, Candidate, Generation } from "./failover";
import { UnsupportedInputError } from "./failover";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Rough output budget for the cards JSON (20 cards of question/answer/hint). */
const MAX_OUTPUT_TOKENS = 8192;

/**
 * Normalized OpenRouter failure. `status` is what the failover engine uses
 * for classification (429/502/503 → rate limit, 401-404 → unavailable);
 * `retryDelaySeconds` (e.g. from a Retry-After header) feeds the cooldown.
 */
export class OpenRouterError extends Error {
  status: number;
  retryDelaySeconds?: number;

  constructor(message: string, status: number, retryDelaySeconds?: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.retryDelaySeconds = retryDelaySeconds;
  }
}

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image_url"; image_url: { url: string } };
type ContentBlock = TextBlock | ImageBlock;

function retryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** Images OpenRouter models accept as base64 data URLs. */
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Server-side PDF text extraction for the OpenRouter path (OpenRouter has no
 * PDF input, Gemini does). pdf.js is dynamically imported so the ~1MB
 * library is only loaded when an upload actually needs this path. Returns ""
 * for PDFs without a text layer (scans) — the caller decides what that means.
 */
export async function extractPdfText(base64: string): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(Buffer.from(base64, "base64")),
    // Node has no DOM worker: the legacy build runs single-threaded, which
    // is plenty for text extraction.
    useSystemFonts: true,
    useWorkerFetch: false,
  });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
          .join(" ")
      );
    }
    return pages.join("\n").replace(/\s+/g, " ").trim();
  } finally {
    await task.destroy().catch(() => {});
  }
}

/**
 * Converts upload parts into OpenRouter chat content:
 *
 *   - text parts pass through as text blocks,
 *   - JPEG/PNG/WEBP images become base64 data URLs (vision models),
 *   - PDFs are extracted to text on the server,
 *   - anything else (HEIC/HEIF, …) throws UnsupportedInputError so the
 *     engine skips this candidate instead of failing the whole upload.
 */
export async function partsToContent(parts: AiPart[]): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      content.push({ type: "text", text: part });
      continue;
    }
    const { mimeType, data } = part.inlineData;
    if (IMAGE_MIMES.has(mimeType)) {
      content.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } });
      continue;
    }
    if (mimeType === "application/pdf") {
      let text: string;
      try {
        text = await extractPdfText(data);
      } catch (err) {
        throw new UnsupportedInputError(
          `That PDF couldn't be read (${err instanceof Error ? err.message : "unknown error"}), and OpenRouter can't take PDFs directly. Try again when Gemini is available, or export the pages as images.`
        );
      }
      if (!text) {
        throw new UnsupportedInputError(
          "That PDF has no selectable text (it looks like a scan), and OpenRouter can't read page images. Try again when Gemini is available, or upload the pages as photos."
        );
      }
      content.push({ type: "text", text: `--- PDF (pages converted to text) ---\n${text}` });
      continue;
    }
    throw new UnsupportedInputError(
      `OpenRouter can't read ${mimeType} files directly. Please convert it to JPEG or PNG and upload again.`
    );
  }
  if (content.length === 0) {
    throw new UnsupportedInputError("Nothing to send to OpenRouter.");
  }
  return content;
}

/**
 * Runs one generation against one OpenRouter model. Throws OpenRouterError
 * (normalized status + optional retry delay) or UnsupportedInputError so the
 * failover engine can classify the failure.
 */
export async function generateWithOpenRouter(candidate: Candidate, parts: AiPart[]): Promise<Generation> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new OpenRouterError("OPENROUTER_API_KEY is not configured. Please add it to your .env file.", 503);
  }

  const content = await partsToContent(parts);

  let res: Response;
  try {
    res = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey.trim()}`,
        "content-type": "application/json",
        // Optional OpenRouter attribution headers (they show the app name in
        // the dashboard's app rankings).
        "x-title": "QuizTime",
      },
      body: JSON.stringify({
        model: candidate.model,
        messages: [{ role: "user", content }],
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
    });
  } catch (err) {
    // Network-level failure (DNS, offline): not a rate limit or a bad model,
    // so let the engine rethrow instead of burning the rest of the chain.
    throw err;
  }

  const body = (await res.json().catch(() => null)) as {
    error?: { message?: unknown; code?: unknown };
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  const retry = retryAfterSeconds(res);

  // OpenRouter reports some upstream provider failures with HTTP 200 and an
  // `error` object in the body (e.g. { code: 502, metadata: { error_type:
  // "provider_unavailable" } }) — lift the real status out of it.
  if (body?.error) {
    const status =
      typeof body.error.code === "number" && Number.isFinite(body.error.code) ? body.error.code : res.status;
    const message =
      typeof body.error.message === "string" && body.error.message
        ? body.error.message
        : `OpenRouter error (HTTP ${res.status})`;
    throw new OpenRouterError(augment(message, status), status, retry);
  }
  if (!res.ok) {
    const message =
      typeof body?.error?.message === "string" && body.error.message
        ? body.error.message
        : `OpenRouter error (HTTP ${res.status})`;
    throw new OpenRouterError(augment(message, res.status), res.status, retry);
  }

  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
  const raw = choice?.message?.content;
  const text = Array.isArray(raw)
    ? raw
        .filter((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text")
        .map((block) => (block as { text?: unknown }).text)
        .filter((chunk): chunk is string => typeof chunk === "string")
        .join("")
    : typeof raw === "string"
      ? raw
      : "";
  if (!text.trim()) {
    throw new OpenRouterError("OpenRouter returned an empty response.", 502, retry);
  }
  return { text };
}

/** Makes account-level rejections (bad key, negative balance) actionable. */
function augment(message: string, status: number): string {
  if (status === 401) return `${message} Check OPENROUTER_API_KEY.`;
  if (status === 402) {
    return `${message} A negative OpenRouter balance blocks even :free models — topping up any $10 (one-time) also raises the free daily limit from 50 to 1,000 requests.`;
  }
  return message;
}
