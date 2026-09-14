/**
 * Gemini model selection with automatic failover.
 *
 * Two different things can make the configured model unusable for a request:
 *
 *   1. it isn't enabled for this API key (the API answers 404 / "not a valid
 *      model name"), and
 *   2. it is enabled, but its rate limit / quota is exhausted (the API answers
 *      429 RESOURCE_EXHAUSTED — "You exceeded your current quota",
 *      "Resource has been exhausted (e.g. check quota)", …).
 *
 * For both cases the next model in the list is tried, so hitting the limit of
 * one model never fails an upload: generation simply moves on to a model that
 * still has quota left.
 *
 * Rate-limited models are also remembered for a cooldown window, so the *next*
 * upload doesn't waste a round trip on a model we already know is exhausted.
 * Once the window passes, the primary model is tried again first — the app
 * switches back on its own as soon as the limit resets. The notes live in
 * module memory (one map per server instance), same trade-off as
 * `src/lib/rate-limit.ts`: plenty for a single node/serverless instance, not a
 * shared cache across instances.
 */

/** A piece of the prompt: plain text, or an inline file (image/PDF). */
export type GeminiPart = string | { inlineData: { mimeType: string; data: string } };

/** The slice of a successful generateContent() result this module needs. */
export type GeminiResult = { response: { text(): string } };

/**
 * Runs one generation against one specific model. The route wires this to the
 * real `@google/generative-ai` client; tests wire it to a stub.
 */
export type GenerateFn = (model: string, parts: GeminiPart[]) => Promise<GeminiResult>;

/**
 * Main model used for every generation request. Set GEMINI_MODEL in the
 * environment to override it without touching this file.
 */
export const PRIMARY_MODEL = "gemini-3.6-flash";

/**
 * Tried in order when the primary can't serve the request — either because it
 * isn't available for the key or because its rate limit is exhausted.
 */
export const FALLBACK_MODELS = [
  "gemini-3.1-flash-lite",
  "antigravity",
  "gemini-3.5-flash-lite",
];

/** How long a rate-limited model is skipped before being tried again. */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const MIN_COOLDOWN_MS = 15 * 1000;
const MAX_COOLDOWN_MS = 30 * 60 * 1000;

// ─── Error detection ─────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return String((err as { message?: unknown })?.message ?? err ?? "");
}

/**
 * HTTP status of a Gemini failure. `@google/generative-ai` puts the real
 * status on `GoogleGenerativeAIFetchError.status` and also prefixes the
 * message with "[429 Too Many Requests]", so either source works.
 */
function errorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number" && Number.isFinite(status)) return status;
  const fromMessage = errorMessage(err).match(/\[(\d{3})\b/);
  return fromMessage ? Number(fromMessage[1]) : undefined;
}

/** The model name doesn't exist / isn't enabled for this key. */
export function isModelUnavailable(err: unknown): boolean {
  if (errorStatus(err) === 404) return true;
  return /not found|not supported|not a valid|unsupported|deprecated|no longer available/i.test(
    errorMessage(err)
  );
}

/**
 * The model exists but can't take this request right now: quota / RPM / TPM
 * limits (429), or Google's "model is overloaded" (503) — in both cases
 * another model is the useful answer.
 */
export function isProviderRateLimited(err: unknown): boolean {
  const status = errorStatus(err);
  if (status === 429) return true;
  const message = errorMessage(err);
  return (
    /too many requests|resource[ _-]?exhausted|rate[ _-]?limit|exceeded your current quota|quota (has been )?(exceeded|exhausted)|requests? per (minute|day)|rpm limit|tpm limit/i.test(
      message
    ) || /overloaded|at capacity|temporarily unavailable|service unavailable|try again later/i.test(message)
  );
}

function parseRetrySeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d+(?:\.\d+)?)\s*s$/i);
  return match ? Number(match[1]) : null;
}

/** Find `retryDelay` anywhere in the SDK's `errorDetails` payload. */
function retrySecondsFromDetails(value: unknown, depth = 0): number | null {
  if (depth > 5 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = retrySecondsFromDetails(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if ("retryDelay" in record) {
    const parsed = parseRetrySeconds(record.retryDelay);
    if (parsed) return parsed;
  }
  for (const nested of Object.values(record)) {
    const found = retrySecondsFromDetails(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Google tells us when to come back (`details[].retryDelay`, also echoed into
 * the error message as `"retryDelay":"30s"` or `[retryDelay: 30s]`). Returns
 * milliseconds, or null when the provider didn't say.
 */
export function retryDelayMs(err: unknown): number | null {
  const fromDetails = retrySecondsFromDetails((err as { errorDetails?: unknown })?.errorDetails);
  const seconds =
    fromDetails ??
    (() => {
      const match = errorMessage(err).match(/retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)\s*s"?/i);
      return match ? Number(match[1]) : null;
    })();
  return seconds ? seconds * 1000 : null;
}

// ─── Cooldown memory ─────────────────────────────────────────────────────────

type RateLimitNote = { until: number; retryInMs: number; fails: number };

const rateLimited = new Map<string, RateLimitNote>();

/** Default skip window; `GEMINI_RATE_LIMIT_COOLDOWN_SECONDS` overrides it. */
function configuredCooldownMs(): number {
  const seconds = Number(process.env.GEMINI_RATE_LIMIT_COOLDOWN_SECONDS);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return DEFAULT_COOLDOWN_MS;
}

function clamp(ms: number): number {
  return Math.min(Math.max(ms, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
}

/**
 * Remember that `model` just ran out of quota. Repeated hits double the
 * window (up to the cap), so a model that's out for the day costs one cheap
 * failed attempt every 30 minutes instead of one per upload.
 */
export function noteRateLimit(model: string, err: unknown, now = Date.now()): RateLimitNote {
  const previous = rateLimited.get(model);
  // Only consecutive failures escalate: a note whose window already elapsed
  // means the model had a chance to recover, so start the ladder again.
  const fails = previous && previous.until > now ? previous.fails + 1 : 1;
  const base = retryDelayMs(err) ?? configuredCooldownMs();
  const retryInMs = clamp(base * 2 ** (fails - 1));
  const note = { until: now + retryInMs, retryInMs, fails };
  rateLimited.set(model, note);
  return note;
}

/** True while `model` is inside its rate-limit cooldown. Pure — no pruning. */
export function isCoolingDown(model: string, now = Date.now()): boolean {
  const note = rateLimited.get(model);
  return Boolean(note && note.until > now);
}

/**
 * Snapshot of the models currently being skipped — for logs and tests. Expired
 * notes are filtered out but kept: the map only ever holds one entry per
 * candidate model, so there is nothing to garbage-collect.
 */
export function rateLimitStatus(
  now = Date.now()
): Array<{ model: string; retryInMs: number; fails: number }> {
  return [...rateLimited.entries()]
    .filter(([, note]) => note.until > now)
    .map(([model, note]) => ({ model, retryInMs: note.until - now, fails: note.fails }));
}

/** Clears the cooldown memory. Used by tests. */
export function resetFailoverState(): void {
  rateLimited.clear();
}

// ─── Model selection ─────────────────────────────────────────────────────────

/** The model we want to be using: GEMINI_MODEL when set, else the primary. */
export function preferredModel(): string {
  return process.env.GEMINI_MODEL?.trim() || PRIMARY_MODEL;
}

/**
 * Models to try, best first: the configured (or default primary) model, then
 * the known-good fallbacks. Models that are still inside their rate-limit
 * cooldown are skipped — unless every model is cooling down, in which case
 * they're all tried anyway so a stale note can never turn into an outage.
 */
export function modelCandidates(
  now = Date.now()
): { models: string[]; coolingDown: string[] } {
  const all = [...new Set([preferredModel(), ...FALLBACK_MODELS])];
  const coolingDown = all.filter((model) => isCoolingDown(model, now));
  if (coolingDown.length === all.length) return { models: all, coolingDown: [] };
  return { models: all.filter((model) => !coolingDown.includes(model)), coolingDown };
}

// ─── Failover ────────────────────────────────────────────────────────────────

/** Thrown when no model could serve the request; `status` feeds the HTTP code. */
export class GeminiApiError extends Error {
  status: number;
  cause?: unknown;

  constructor(message: string, status: number, cause?: unknown) {
    super(message);
    this.name = "GeminiApiError";
    this.status = status;
    this.cause = cause;
  }
}

type Skip = { model: string; reason: "rate limit" | "unavailable" };

export type GenerationOutcome = {
  result: GeminiResult;
  /** The model that actually produced the cards. */
  model: string;
  /** Set when we had to move off the first-choice model (shown to the user). */
  notice?: string;
};

function humanMs(ms: number): string {
  if (ms < 90_000) return "about a minute";
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `about ${minutes} minutes` : `about ${Math.round(minutes / 60)} hour(s)`;
}

function buildNotice(usedModel: string, skipped: Skip[], now = Date.now()): string | undefined {
  if (skipped.length === 0) return undefined;

  const phrases = skipped.map((skip) =>
    skip.reason === "rate limit"
      ? `${skip.model} hit its request limit`
      : `${skip.model} isn't available for this API key`
  );
  const list =
    phrases.length === 1
      ? phrases[0]
      : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;

  const soonest = rateLimitStatus(now)
    .map((note) => note.retryInMs)
    .sort((a, b) => a - b)[0];
  const retryHint = soonest ? ` Trying ${preferredModel()} again in ${humanMs(soonest)}.` : "";

  return `${list} — generated with ${usedModel} instead.${retryHint}`;
}

function busyMessage(tried: string[]): string {
  const soonest = rateLimitStatus()
    .map((note) => note.retryInMs)
    .sort((a, b) => a - b)[0];
  const when = soonest ? ` in ${humanMs(soonest)}` : " in a few minutes";
  return `Every Gemini model is at its request limit right now (${tried.join(", ")}). Please try again${when} — the app switches back to ${preferredModel()} automatically as soon as its limit resets.`;
}

/**
 * Generates with the best available model: tries each candidate in order and
 * moves on when one is unavailable or rate-limited. Errors that another model
 * wouldn't fix (bad request, safety block, network failure, …) are rethrown
 * immediately instead of burning three more calls.
 */
export async function generateWithFallback(
  generate: GenerateFn,
  parts: GeminiPart[]
): Promise<GenerationOutcome> {
  const { models, coolingDown } = modelCandidates();
  const skipped: Skip[] = coolingDown.map((model) => ({ model, reason: "rate limit" as const }));
  let lastError: unknown = null;
  let hitRateLimit = skipped.length > 0;

  for (const model of models) {
    try {
      const result = await generate(model, parts);
      return { result, model, notice: buildNotice(model, skipped) };
    } catch (err) {
      if (isModelUnavailable(err)) {
        skipped.push({ model, reason: "unavailable" });
        lastError = err;
        console.warn(`Gemini model "${model}" is unavailable — trying the next model.`);
        continue;
      }
      if (isProviderRateLimited(err)) {
        const note = noteRateLimit(model, err);
        skipped.push({ model, reason: "rate limit" });
        hitRateLimit = true;
        lastError = err;
        console.warn(
          `Gemini model "${model}" is rate-limited — trying the next model (will retry it in ${humanMs(
            note.retryInMs
          )}).`
        );
        continue;
      }
      throw err;
    }
  }

  const tried = [...coolingDown, ...models];
  if (hitRateLimit) throw new GeminiApiError(busyMessage(tried), 429, lastError ?? undefined);
  throw new GeminiApiError(
    `None of the Gemini models (${tried.join(", ")}) are available for your API key. Set GEMINI_MODEL to a model your key can use.`,
    503,
    lastError ?? undefined
  );
}
