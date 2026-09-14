/**
 * Gemini model selection with automatic fallback.
 *
 * The app's main model (gemini-3.6-flash by default, overridable via
 * GEMINI_MODEL) is tried first for every generation request. Two kinds of
 * failures move on to the next model in the chain:
 *
 *  - the model is unknown to the API for this key (404 / deprecated /
 *    not enabled), and
 *  - the model hit its usage limit (HTTP 429 / "RESOURCE_EXHAUSTED" /
 *    "Quota exceeded ..."). Each Gemini model has its own per-minute
 *    quota bucket, so a rate-limited main model can usually still be
 *    served by an older one.
 *
 * Any other error (bad request, 500, ...) is rethrown as-is. If every
 * candidate is rate limited — e.g. the shared free-tier daily quota is
 * exhausted — AllModelsRateLimitedError is thrown so the caller can send
 * the user a "wait a few minutes" 429 instead of a generic 500.
 *
 * Kept free of Next/db imports so it is easy to unit test.
 */
import type { GenerateContentResult, Part } from "@google/generative-ai";

/**
 * Main model used for every generation request. Set GEMINI_MODEL in the
 * environment to override it without touching this file.
 */
export const PRIMARY_MODEL = "gemini-3.6-flash";

/**
 * Models tried after the main model fails (unavailable or rate limited).
 */
export const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

/** The models to try, in order: the configured/main model, then the chain. */
export function modelCandidates(): string[] {
  const configured = process.env.GEMINI_MODEL?.trim();
  return [...new Set([configured || PRIMARY_MODEL, ...FALLBACK_MODELS])];
}

/** True for "model doesn't exist / isn't enabled for this key" errors. */
export function isModelUnavailable(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /404|not found|not supported|not a valid|unsupported|deprecated|no longer available/i.test(msg);
}

/**
 * True when the Gemini API rejected the request because this model's usage
 * limit was hit (per-minute RPM/TPM or the free-tier daily quota). The API
 * reports these as HTTP 429 / "RESOURCE_EXHAUSTED" with messages like
 * "Quota exceeded for quota metric 'Generate Content requests'..." — a
 * different model (its own quota bucket) can still serve the request.
 *
 * The SDK surfaces them as GoogleGenerativeAIFetchError, whose `status` is
 * the numeric HTTP status and whose message embeds both "[429 Too Many
 * Requests]" and the API's error body, so all three signals are checked.
 */
export function isModelRateLimited(err: unknown): boolean {
  const status = String((err as { status?: unknown })?.status ?? "");
  if (status === "429") return true;
  const msg = String((err as Error)?.message ?? err);
  return (
    /resource_exhausted|too many requests|rate[- ]?limit|\b429\b/i.test(msg) ||
    /quota.{0,40}exceeded|exceeded.{0,40}(quota|limit)/i.test(msg)
  );
}

/**
 * Thrown when every candidate model is rate limited — the account's quota
 * (e.g. the shared free-tier daily limit) is exhausted, so retrying sooner
 * than a short wait won't help.
 */
export class AllModelsRateLimitedError extends Error {
  constructor() {
    super(
      "Gemini's usage limit has been reached on every available model. Please wait a few minutes and try again."
    );
    this.name = "AllModelsRateLimitedError";
  }
}

/**
 * The slice of the Gemini SDK client used below — the real
 * GoogleGenerativeAI instance satisfies this structurally.
 */
export interface ModelGenerativeClient {
  getGenerativeModel(options: { model: string }): {
    generateContent(parts: Array<string | Part>): Promise<GenerateContentResult>;
  };
}

/**
 * Try the main model first, then the fallback chain. A model that is
 * unknown to the API *or* over its rate limit moves on to the next
 * candidate; any other error (bad request, server error, ...) is rethrown
 * as-is. Returns which model actually served the request so the client can
 * tell the user a fallback kicked in.
 */
export async function generateWithFallback(
  genAI: ModelGenerativeClient,
  parts: Array<string | Part>
): Promise<{ result: GenerateContentResult; model: string }> {
  let lastError: unknown;
  let lastWasRateLimited = false;
  for (const name of modelCandidates()) {
    try {
      const result = await genAI.getGenerativeModel({ model: name }).generateContent(parts);
      return { result, model: name };
    } catch (err) {
      const rateLimited = isModelRateLimited(err);
      const unavailable = !rateLimited && isModelUnavailable(err);
      if (!rateLimited && !unavailable) throw err;
      lastError = err;
      lastWasRateLimited = rateLimited;
      console.warn(
        `Gemini model "${name}" ${rateLimited ? "hit its usage limit" : "is unavailable"} — trying the next option.`
      );
    }
  }
  if (lastWasRateLimited) throw new AllModelsRateLimitedError();
  throw lastError;
}
