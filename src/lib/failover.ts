/**
 * Multi-provider model failover for flashcard generation.
 *
 * Generation goes through an ordered list of "candidates" — each one an AI
 * model on a specific provider (Google Gemini, OpenRouter). Two different
 * things can make a candidate unusable for a request:
 *
 *   1. it can't be used at all right now — the model isn't available for the
 *      API key / has been retired (404, "not a valid model"), the key was
 *      rejected (401/403), or the account can't be billed (402), and
 *   2. it exists, but its rate limit / quota is exhausted (429 — "You
 *      exceeded your current quota", "Resource has been exhausted…",
 *      OpenRouter's "temporarily rate-limited upstream", Google's "model is
 *      overloaded" 503/502).
 *
 * In both cases the next candidate is tried, so hitting the limit of one
 * model never fails an upload: generation simply moves on to a model (or an
 * entirely different provider) that can still serve it. A third, special
 * case is `UnsupportedInputError`: the provider physically can't read the
 * upload (e.g. OpenRouter has no PDF input, or a text-only model gets a
 * photo). That candidate is skipped without a cooldown — the next model may
 * handle the input fine.
 *
 * Rate-limited models are remembered for a cooldown window, so the *next*
 * upload doesn't waste a round trip on a model we already know is exhausted.
 * Once the window passes, the primary model is tried again first — the app
 * switches back on its own as soon as the limit resets. The notes live in
 * module memory (one map per server instance), the same trade-off as
 * `src/lib/rate-limit.ts`: plenty for a single node/serverless instance, not
 * a shared cache across instances.
 *
 * The engine itself is provider-agnostic: it only classifies errors, keeps
 * cooldown state, and walks the candidate list. Knowing *how* to talk to a
 * provider lives in the adapters — `src/lib/gemini.ts` and
 * `src/lib/openrouter.ts` — which throw plain errors the engine can
 * classify.
 */

// ─── Core types ──────────────────────────────────────────────────────────────

export type Provider = "gemini" | "openrouter";

/** One AI model on one provider — a single step in the failover chain. */
export type Candidate = { provider: Provider; model: string };

/** A piece of the prompt: plain text, or an inline file (image/PDF). */
export type AiPart = string | { inlineData: { mimeType: string; data: string } };

/** The slice of a successful generation any provider adapter must return. */
export type Generation = { text: string };

/**
 * Performs one generation against one candidate. The route wires this to the
 * provider adapters; tests wire it to a stub.
 */
export type GenerateFn = (candidate: Candidate, parts: AiPart[]) => Promise<Generation>;

// ─── Model configuration ─────────────────────────────────────────────────────

/**
 * Main model used for every generation request. Set GEMINI_MODEL in the
 * environment to override it without touching this file.
 */
export const PRIMARY_MODEL = "gemini-3.6-flash";

/**
 * Gemini models tried in order after the primary — either because the
 * primary isn't available for the key or because its rate limit is exhausted.
 * `antigravity` is a Gemini *agent*, so it burns more tokens than a plain
 * model; it stays in the default chain for maximum availability. Set
 * GEMINI_FALLBACK_MODELS (comma-separated) to reorder or drop it.
 */
export const FALLBACK_MODELS = [
  "gemini-3.1-flash-lite",
  "antigravity",
  "gemini-3.5-flash-lite",
];

/**
 * OpenRouter models tried after every Gemini model. These are all `:free`
 * variants (or the auto-routing `openrouter/free` router). OpenRouter's free
 * lineup rotates from month to month — Llama and DeepSeek `:free` variants
 * come and go — so OPENROUTER_MODELS (comma-separated) overrides this list,
 * and anything that 404s is skipped instead of failing the upload.
 *
 * Defaults (checked free on OpenRouter in September 2026):
 *   1. openrouter/free — routes to whatever free model can answer
 *   2. nvidia/nemotron-3-super-120b-a12b:free — fastest reliable free model
 *   3. inclusionai/ling-3.0-flash-vl:free — vision model, so photo uploads
 *      still work when the auto-router picks a text-only model
 */
export const DEFAULT_OPENROUTER_MODELS = [
  "openrouter/free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "inclusionai/ling-3.0-flash-vl:free",
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
 * HTTP status of a provider failure. SDKs put the real status on
 * `err.status` (`@google/generative-ai` prefixes the message with
 * "[429 Too Many Requests]" as well); the OpenRouter adapter normalizes to
 * the same shape in `src/lib/openrouter.ts`. Either source works.
 */
function errorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number" && Number.isFinite(status)) return status;
  const fromMessage = errorMessage(err).match(/\[(\d{3})\b/);
  return fromMessage ? Number(fromMessage[1]) : undefined;
}

/**
 * The candidate can't serve this request at all (and the next upload won't
 * be different): the model doesn't exist / isn't enabled (404), the API key
 * was rejected (401/403), or the account can't be billed — including
 * OpenRouter's 402, which blocks even `:free` models when the balance is
 * negative. Skipped without a cooldown.
 */
export function isModelUnavailable(err: unknown): boolean {
  const status = errorStatus(err);
  if (status === 404 || status === 401 || status === 402 || status === 403) return true;
  return /not found|not supported|not a valid|unsupported|deprecated|no longer available|invalid api key|agent tools only/i.test(
    errorMessage(err)
  );
}

/**
 * The candidate exists but can't take this request *right now*: quota / RPM /
 * TPM limits (429), or the provider is overloaded (502/503 — Google's "model
 * is overloaded", OpenRouter's upstream providers refusing). Another
 * candidate is the useful answer; this one gets a cooldown.
 */
export function isProviderRateLimited(err: unknown): boolean {
  const status = errorStatus(err);
  if (status === 429 || status === 502 || status === 503) return true;
  const message = errorMessage(err);
  return (
    /too many requests|resource[ _-]?exhausted|rate[ _-]?limit|exceeded your current quota|quota (has been )?(exceeded|exhausted)|requests? per (minute|day)|rpm limit|tpm limit/i.test(
      message
    ) || /overloaded|at capacity|temporarily unavailable|service unavailable|try again later/i.test(message)
  );
}

/**
 * The provider physically can't read the upload (OpenRouter has no PDF
 * input; a text-only model gets a photo; a HEIC file nobody converts).
 * Another *candidate* may handle it, so the engine skips just this one — no
 * cooldown, and a 400 that merely looks like this (bad request, safety
 * block) is only matched when the status and message both fit.
 */
export function isUnsupportedInput(err: unknown): boolean {
  const status = errorStatus(err);
  if (status !== 400 && status !== 415) return false;
  return /image|modality|modalit|mime|unsupported (input|content|format|file|media)|file (type|format)|max_tokens/i.test(
    errorMessage(err)
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
 * When should we come back? Google tells us (`details[].retryDelay`, echoed
 * into the message as `"retryDelay":"30s"` / `[retryDelay: 30s]`); OpenRouter
 * sometimes sends a `Retry-After` header, which its adapter copies onto the
 * error as `retryDelaySeconds`. Returns milliseconds, or null when the
 * provider didn't say.
 */
export function retryDelayMs(err: unknown): number | null {
  const fromHeader = (err as { retryDelaySeconds?: unknown })?.retryDelaySeconds;
  if (typeof fromHeader === "number" && Number.isFinite(fromHeader) && fromHeader > 0) {
    return fromHeader * 1000;
  }
  const fromDetails = retrySecondsFromDetails((err as { errorDetails?: unknown })?.errorDetails);
  const seconds =
    fromDetails ??
    (() => {
      const match = errorMessage(err).match(/retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)\s*s"?/i);
      return match ? Number(match[1]) : null;
    })();
  return seconds ? seconds * 1000 : null;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Thrown when no candidate could serve the request; `status` feeds the HTTP code. */
export class GenerationError extends Error {
  status: number;
  cause?: unknown;

  constructor(message: string, status: number, cause?: unknown) {
    super(message);
    this.name = "GenerationError";
    this.status = status;
    this.cause = cause;
  }
}

/**
 * Thrown by a provider adapter when the *upload* can't be read by that
 * candidate (PDF to OpenRouter, photo to a text-only model, HEIC file, …).
 * The engine skips just this candidate — no cooldown.
 */
export class UnsupportedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInputError";
  }
}

// ─── Cooldown memory ─────────────────────────────────────────────────────────

type RateLimitNote = { until: number; retryInMs: number; fails: number; provider: Provider; model: string };

const rateLimited = new Map<string, RateLimitNote>();

/** Candidate note key. `openrouter/nemotron…:free` keeps its colons intact. */
export function candidateKey(candidate: Candidate): string {
  return `${candidate.provider}:${candidate.model}`;
}

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
 * Remember that `candidate` just ran out of quota. Repeated hits double the
 * window (up to the cap), so a model that's out for the day costs one cheap
 * failed attempt every 30 minutes instead of one per upload.
 */
export function noteRateLimit(
  candidate: Candidate,
  err: unknown,
  now = Date.now()
): RateLimitNote {
  const key = candidateKey(candidate);
  const previous = rateLimited.get(key);
  // Only consecutive failures escalate: a note whose window already elapsed
  // means the model had a chance to recover, so start the ladder again.
  const fails = previous && previous.until > now ? previous.fails + 1 : 1;
  const base = retryDelayMs(err) ?? configuredCooldownMs();
  const retryInMs = clamp(base * 2 ** (fails - 1));
  const note = { until: now + retryInMs, retryInMs, fails, provider: candidate.provider, model: candidate.model };
  rateLimited.set(key, note);
  return note;
}

/** True while `candidate` is inside its rate-limit cooldown. Pure — no pruning. */
export function isCoolingDown(candidate: Candidate, now = Date.now()): boolean {
  const note = rateLimited.get(candidateKey(candidate));
  return Boolean(note && note.until > now);
}

/**
 * Snapshot of the candidates currently being skipped — for logs and tests.
 * Expired notes are filtered out but kept: the map only ever holds one entry
 * per candidate, so there is nothing to garbage-collect.
 */
export function rateLimitStatus(
  now = Date.now()
): Array<{ model: string; provider: Provider; retryInMs: number; fails: number }> {
  return [...rateLimited.values()]
    .filter((note) => note.until > now)
    .map((note) => ({ model: note.model, provider: note.provider, retryInMs: note.until - now, fails: note.fails }));
}

/** Clears the cooldown memory. Used by tests. */
export function resetFailoverState(): void {
  rateLimited.clear();
}

// ─── Model selection ─────────────────────────────────────────────────────────

/** The Gemini model we want to be using: GEMINI_MODEL when set, else the primary. */
export function preferredModel(): string {
  return process.env.GEMINI_MODEL?.trim() || PRIMARY_MODEL;
}

/** Gemini fallback order; GEMINI_FALLBACK_MODELS (comma-separated) overrides it. */
export function geminiFallbackModels(): string[] {
  const raw = process.env.GEMINI_FALLBACK_MODELS;
  if (raw !== undefined && raw.trim() !== "") {
    return raw.split(",").map((m) => m.trim()).filter(Boolean);
  }
  return FALLBACK_MODELS;
}

/** OpenRouter candidate list; OPENROUTER_MODELS (comma-separated) overrides it. */
export function openrouterModels(): string[] {
  const raw = process.env.OPENROUTER_MODELS;
  if (raw !== undefined && raw.trim() !== "") {
    return raw.split(",").map((m) => m.trim()).filter(Boolean);
  }
  return DEFAULT_OPENROUTER_MODELS;
}

export function geminiApiKey(): string | undefined {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  return key && key.trim() ? key.trim() : undefined;
}

export function openrouterApiKey(): string | undefined {
  const key = process.env.OPENROUTER_API_KEY;
  return key && key.trim() ? key.trim() : undefined;
}

/**
 * The candidates we'd prefer, best first: the configured (or default) Gemini
 * model, then the Gemini fallbacks, then the OpenRouter models. A provider
 * whose API key isn't configured is omitted entirely — the app works with
 * either key, and with both it simply has a longer safety net.
 */
export function providerCandidates(): Candidate[] {
  const all: Candidate[] = [];
  if (geminiApiKey()) {
    all.push({ provider: "gemini", model: preferredModel() });
    for (const model of geminiFallbackModels()) all.push({ provider: "gemini", model });
  }
  if (openrouterApiKey()) {
    for (const model of openrouterModels()) all.push({ provider: "openrouter", model });
  }
  // Deduplicate (GEMINI_MODEL may duplicate a fallback entry).
  const seen = new Set<string>();
  return all.filter((candidate) => {
    const key = candidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Candidates to try now: the full chain, minus anything inside its rate-limit
 * cooldown — unless *every* candidate is cooling down, in which case they're
 * all tried anyway so a stale note can never turn into an outage.
 */
export function activeCandidates(
  now = Date.now()
): { candidates: Candidate[]; coolingDown: Candidate[] } {
  const all = providerCandidates();
  const coolingDown = all.filter((candidate) => isCoolingDown(candidate, now));
  if (coolingDown.length === all.length) return { candidates: all, coolingDown: [] };
  return { candidates: all.filter((candidate) => !coolingDown.includes(candidate)), coolingDown };
}

/** The candidate we'd be using if everything is healthy. */
export function preferredCandidate(): Candidate | null {
  const all = providerCandidates();
  return all.length > 0 ? all[0] : null;
}

// ─── User-facing wording ─────────────────────────────────────────────────────

/**
 * How a candidate is shown to the user. Gemini model names stand on their
 * own; OpenRouter IDs get a provider tag so "openrouter/free" reads as
 * "the free OpenRouter pool", not some mysterious model.
 */
export function displayCandidate(candidate: Candidate): string {
  return candidate.provider === "openrouter" ? `${candidate.model} (OpenRouter)` : candidate.model;
}

function humanMs(ms: number): string {
  if (ms < 90_000) return "about a minute";
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `about ${minutes} minutes` : `about ${Math.round(minutes / 60)} hour(s)`;
}

type Skip = Candidate & { reason: "rate limit" | "unavailable" | "unsupported input" };

export type GenerationOutcome = {
  /** The raw model output; the route parses the JSON cards out of it. */
  text: string;
  /** The provider that actually produced the cards. */
  provider: Provider;
  /** The model that actually produced the cards. */
  model: string;
  /** Set when we had to move off the first-choice candidate (shown to the user). */
  notice?: string;
};

function buildNotice(used: Candidate, skipped: Skip[], now = Date.now()): string | undefined {
  if (skipped.length === 0) return undefined;

  const phrases = skipped.map((skip) =>
    skip.reason === "rate limit"
      ? `${displayCandidate(skip)} hit its request limit`
      : skip.reason === "unavailable"
        ? `${displayCandidate(skip)} isn't available for this API key`
        : `${displayCandidate(skip)} can't read this upload`
  );
  const list =
    phrases.length === 1
      ? phrases[0]
      : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;

  const soonest = rateLimitStatus(now)
    .map((note) => note.retryInMs)
    .sort((a, b) => a - b)[0];
  const preferred = preferredCandidate();
  const retryHint =
    soonest && preferred ? ` Trying ${displayCandidate(preferred)} again in ${humanMs(soonest)}.` : "";

  return `${list} — generated with ${displayCandidate(used)} instead.${retryHint}`;
}

function busyMessage(tried: Candidate[]): string {
  const soonest = rateLimitStatus()
    .map((note) => note.retryInMs)
    .sort((a, b) => a - b)[0];
  const when = soonest ? ` in ${humanMs(soonest)}` : " in a few minutes";
  return `Every AI model is at its request limit right now (${tried
    .map(displayCandidate)
    .join(", ")}). Please try again${when} — QuizTime switches back to its preferred model automatically as soon as limits reset.`;
}

function unavailableMessage(tried: Candidate[]): string {
  return `No AI model could serve this request (${tried
    .map(displayCandidate)
    .join(", ")}). Check your API keys and model settings: GEMINI_MODEL / GEMINI_FALLBACK_MODELS for Gemini, OPENROUTER_MODELS for OpenRouter.`;
}

// ─── Failover ────────────────────────────────────────────────────────────────

/**
 * Generates with the best available candidate: tries each in order and moves
 * on when one is unavailable, rate-limited, or blind to the upload. Errors
 * that another candidate wouldn't fix (bad request, safety block, network
 * failure, …) are rethrown immediately instead of burning the rest of the
 * chain.
 */
export async function generateWithFallback(
  generate: GenerateFn,
  parts: AiPart[]
): Promise<GenerationOutcome> {
  const { candidates, coolingDown } = activeCandidates();
  if (candidates.length === 0) {
    throw new GenerationError(
      "No AI provider is configured. Set GEMINI_API_KEY and/or OPENROUTER_API_KEY in your .env file.",
      503
    );
  }

  const skipped: Skip[] = coolingDown.map((candidate) => ({ ...candidate, reason: "rate limit" as const }));
  let lastError: unknown = null;
  let hitRateLimit = skipped.length > 0;
  let firstUnsupported: string | undefined;

  for (const candidate of candidates) {
    try {
      const generation = await generate(candidate, parts);
      return {
        text: generation.text,
        provider: candidate.provider,
        model: candidate.model,
        notice: buildNotice(candidate, skipped),
      };
    } catch (err) {
      if (err instanceof UnsupportedInputError) {
        skipped.push({ ...candidate, reason: "unsupported input" });
        firstUnsupported = firstUnsupported ?? err.message;
        lastError = err;
        console.warn(`Model "${displayCandidate(candidate)}" can't read this upload — trying the next model.`);
        continue;
      }
      if (isModelUnavailable(err)) {
        skipped.push({ ...candidate, reason: "unavailable" });
        lastError = err;
        console.warn(`Model "${displayCandidate(candidate)}" is unavailable — trying the next model.`);
        continue;
      }
      if (isProviderRateLimited(err)) {
        const note = noteRateLimit(candidate, err);
        skipped.push({ ...candidate, reason: "rate limit" });
        hitRateLimit = true;
        lastError = err;
        console.warn(
          `Model "${displayCandidate(candidate)}" is rate-limited — trying the next model (will retry it in ${humanMs(
            note.retryInMs
          )}).`
        );
        continue;
      }
      throw err;
    }
  }

  const tried = [...coolingDown, ...candidates];
  // An actionable "convert your file" fix beats "wait for limits to reset".
  if (firstUnsupported) {
    const busy = hitRateLimit ? " Other models that could read it are at their request limit — try again in a bit." : "";
    throw new GenerationError(`${firstUnsupported}.${busy}`, 503, lastError);
  }
  if (hitRateLimit) {
    // Mixed failure reasons (e.g. every Gemini model rate-limited AND the
    // OpenRouter key rejected) deserve a message that says so — "wait for
    // limits to reset" alone would never fix the key problem.
    if (new Set(skipped.map((skip) => skip.reason)).size > 1) {
      const soonest = rateLimitStatus()
        .map((note) => note.retryInMs)
        .sort((a, b) => a - b)[0];
      const when = soonest ? ` in ${humanMs(soonest)}` : " in a few minutes";
      throw new GenerationError(
        `Every AI model failed right now (${tried
          .map(displayCandidate)
          .join(", ")}): some hit their request limit, others aren't available for your API key. Check GEMINI_API_KEY / OPENROUTER_API_KEY and try again${when}.`,
        429,
        lastError ?? undefined
      );
    }
    throw new GenerationError(busyMessage(tried), 429, lastError ?? undefined);
  }
  throw new GenerationError(unavailableMessage(tried), 503, lastError ?? undefined);
}
