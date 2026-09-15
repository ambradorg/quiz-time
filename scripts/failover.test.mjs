#!/usr/bin/env node
/**
 * Tests for the multi-provider model failover (src/lib/failover.ts) — the
 * thing that keeps an upload working when a model hits its rate limit, by
 * moving on to the next Gemini model and, once every Gemini model is out,
 * to OpenRouter's free models.
 *
 * No database, no network and no API key: the real `generateWithFallback()`
 * is driven directly with a stub "generate" function that throws the errors
 * the providers really throw (GoogleGenerativeAIFetchError-shaped from
 * `@google/generative-ai`; OpenRouterError-shaped from src/lib/openrouter.ts).
 *
 * Usage:
 *   npm run test:failover
 */
import test, { afterEach, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

const {
  DEFAULT_OPENROUTER_MODELS,
  FALLBACK_MODELS,
  GenerationError,
  PRIMARY_MODEL,
  UnsupportedInputError,
  activeCandidates,
  displayCandidate,
  generateWithFallback,
  isCoolingDown,
  isModelUnavailable,
  isProviderRateLimited,
  isUnsupportedInput,
  noteRateLimit,
  openrouterModels,
  preferredCandidate,
  providerCandidates,
  rateLimitStatus,
  resetFailoverState,
  retryDelayMs,
} = await import("../src/lib/failover.ts");

const GEMINI = "test-gemini-key";
const OPENROUTER = "test-openrouter-key";
const OR_PRIMARY = DEFAULT_OPENROUTER_MODELS[0];
const OR_SECOND = DEFAULT_OPENROUTER_MODELS[1];
const OR_THIRD = DEFAULT_OPENROUTER_MODELS[2];

const GEMINI_CHAIN = [PRIMARY_MODEL, ...FALLBACK_MODELS];
const OPENROUTER_CHAIN = DEFAULT_OPENROUTER_MODELS;

// ─── Error fixtures (shaped like the real provider errors) ──────────────────

function fetchError(status, statusText, apiMessage, errorDetails) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent";
  const err = new Error(
    `Error fetching from ${url}: [${status} ${statusText}] ${apiMessage}${
      errorDetails ? ` ${JSON.stringify(errorDetails)}` : ""
    }`
  );
  err.name = "GoogleGenerativeAIFetchError";
  err.status = status;
  err.statusText = statusText;
  if (errorDetails) err.errorDetails = errorDetails;
  return err;
}

/** "You exceeded your current quota" — daily/minute quota, with RetryInfo. */
function quotaError(retryDelay = "30s") {
  return fetchError(429, "Too Many Requests", "You exceeded your current quota. Please check your plan and billing details. For more information on this error, see: https://ai.google.dev/gemini-api/docs/rate-limits", [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "RATE_LIMIT_EXCEEDED",
      domain: "googleapis.com",
      metadata: { service: "generativelanguage.googleapis.com", retryDelay },
    },
  ]);
}

/** "Resource has been exhausted (e.g. check quota)" — RPM limit, no details. */
function rpmError() {
  return fetchError(429, "Too Many Requests", "Resource has been exhausted (e.g. check quota).");
}

function modelNotFoundError() {
  return fetchError(
    404,
    "Not Found",
    "models/gemini-3.6-flash is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods."
  );
}

function badRequestError() {
  return fetchError(400, "Bad Request", "Invalid JSON payload received. Unknown name \"inline_data\".");
}

/** OpenRouter adapter's error shape (see src/lib/openrouter.ts). */
function openRouterError(message, status, retryDelaySeconds) {
  const err = new Error(message);
  err.name = "OpenRouterError";
  err.status = status;
  if (retryDelaySeconds) err.retryDelaySeconds = retryDelaySeconds;
  return err;
}

const OK_RESULT = { text: '{"title":"t","summary":"s","cards":[{"question":"q"}]}' };

/**
 * Stub client: `behaviour(candidate)` returns a result or throws. Records
 * every model it was asked for, in order (with provider).
 */
function stub(behaviour) {
  const calls = [];
  const generate = async (candidate) => {
    calls.push(candidate);
    const outcome = behaviour(candidate);
    if (outcome instanceof Error) throw outcome;
    return outcome ?? OK_RESULT;
  };
  return { generate, calls, models: () => calls.map((c) => c.model) };
}

const PARTS = ["some study text"];

beforeEach(() => {
  resetFailoverState();
  process.env.GEMINI_API_KEY = GEMINI;
  process.env.OPENROUTER_API_KEY = OPENROUTER;
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODELS;
  delete process.env.GEMINI_FALLBACK_MODELS;
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_RATE_LIMIT_COOLDOWN_SECONDS;
});

describe("error detection", () => {
  test("429 quota errors read as rate limits, not as unavailable models", () => {
    for (const err of [quotaError(), rpmError()]) {
      assert.equal(isProviderRateLimited(err), true);
      assert.equal(isModelUnavailable(err), false);
    }
  });

  test("a 404 model error reads as unavailable, not as a rate limit", () => {
    const err = modelNotFoundError();
    assert.equal(isModelUnavailable(err), true);
    assert.equal(isProviderRateLimited(err), false);
  });

  test("a 400 bad request is neither — so it must not trigger a fallback", () => {
    const err = badRequestError();
    assert.equal(isProviderRateLimited(err), false);
    assert.equal(isModelUnavailable(err), false);
    assert.equal(isUnsupportedInput(err), false);
  });

  test("key and billing rejections (401/402/403) read as unavailable", () => {
    for (const status of [401, 402, 403]) {
      const err = openRouterError("No auth credentials found", status);
      assert.equal(isModelUnavailable(err), true);
      assert.equal(isProviderRateLimited(err), false);
    }
  });

  test("502/503 overload errors read as rate limits", () => {
    for (const status of [502, 503]) {
      assert.equal(isProviderRateLimited(openRouterError("provider_unavailable", status)), true);
      assert.equal(isModelUnavailable(openRouterError("provider_unavailable", status)), false);
    }
  });

  test("input-modality 400s read as 'unsupported input', nothing else", () => {
    const image400 = openRouterError("Model does not support image input", 400);
    assert.equal(isUnsupportedInput(image400), true);
    assert.equal(isProviderRateLimited(image400), false);
    assert.equal(isModelUnavailable(image400), false);
    // A plain 400 stays fatal (rethrown by the engine).
    assert.equal(isUnsupportedInput(badRequestError()), false);
  });

  test("reads the provider's retryDelay from errorDetails", () => {
    assert.equal(retryDelayMs(quotaError("30s")), 30_000);
    assert.equal(retryDelayMs(quotaError("3600s")), 3_600_000);
    assert.equal(retryDelayMs(rpmError()), null);
  });

  test("reads retryDelay when it only appears in the message text", () => {
    const err = new Error("[429 Too Many Requests] quota exceeded [retryDelay: 45s]");
    assert.equal(retryDelayMs(err), 45_000);
  });

  test("reads a Retry-After header normalized onto the error", () => {
    assert.equal(retryDelayMs(openRouterError("rate limited", 429, 45)), 45_000);
  });
});

describe("candidate list", () => {
  test("defaults: Gemini chain first, then the default OpenRouter free models", () => {
    const candidates = providerCandidates();
    assert.deepEqual(
      candidates.map((c) => c.model),
      [...GEMINI_CHAIN, ...OPENROUTER_CHAIN]
    );
    assert.equal(candidates.every((c, i) => c.provider === (i < GEMINI_CHAIN.length ? "gemini" : "openrouter")), true);
    assert.equal(preferredCandidate().model, PRIMARY_MODEL);
  });

  test("without an OpenRouter key the chain is Gemini-only", () => {
    process.env.OPENROUTER_API_KEY = "";
    const candidates = providerCandidates();
    assert.deepEqual(candidates.map((c) => [c.provider, c.model]), GEMINI_CHAIN.map((m) => ["gemini", m]));
  });

  test("without a Gemini key the chain is OpenRouter-only", () => {
    process.env.GEMINI_API_KEY = "";
    delete process.env.GOOGLE_API_KEY;
    const candidates = providerCandidates();
    assert.deepEqual(candidates.map((c) => [c.provider, c.model]), OPENROUTER_CHAIN.map((m) => ["openrouter", m]));
    assert.equal(preferredCandidate().provider, "openrouter");
  });

  test("with neither key there is no chain", () => {
    process.env.GEMINI_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "";
    delete process.env.GOOGLE_API_KEY;
    assert.deepEqual(providerCandidates(), []);
  });

  test("GEMINI_FALLBACK_MODELS reorders the Gemini chain (e.g. drops antigravity)", () => {
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.5-flash-lite";
    assert.deepEqual(
      providerCandidates()
        .filter((c) => c.provider === "gemini")
        .map((c) => c.model),
      [PRIMARY_MODEL, "gemini-3.5-flash-lite"]
    );
  });

  test("OPENROUTER_MODELS overrides the OpenRouter chain", () => {
    process.env.OPENROUTER_MODELS = "meta-llama/llama-3.3-70b-instruct:free,deepseek/deepseek-chat-v3.1:free";
    assert.deepEqual(
      providerCandidates()
        .filter((c) => c.provider === "openrouter")
        .map((c) => c.model),
      ["meta-llama/llama-3.3-70b-instruct:free", "deepseek/deepseek-chat-v3.1:free"]
    );
    assert.deepEqual(openrouterModels(), ["meta-llama/llama-3.3-70b-instruct:free", "deepseek/deepseek-chat-v3.1:free"]);
  });

  test("the user-visible name tags OpenRouter models only", () => {
    assert.equal(displayCandidate({ provider: "gemini", model: PRIMARY_MODEL }), PRIMARY_MODEL);
    assert.equal(
      displayCandidate({ provider: "openrouter", model: "openrouter/free" }),
      "openrouter/free (OpenRouter)"
    );
  });
});

describe("generateWithFallback (Gemini chain)", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = ""; // gemini-only chain
  });

  test("uses the primary model when it is healthy", async () => {
    const { generate, models } = stub(() => OK_RESULT);
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(models(), [PRIMARY_MODEL]);
    assert.equal(outcome.model, PRIMARY_MODEL);
    assert.equal(outcome.provider, "gemini");
    assert.equal(outcome.notice, undefined);
    assert.equal(outcome.text, OK_RESULT.text);
  });

  test("falls back to the next model when the primary hits its rate limit", async () => {
    const { generate, models } = stub((c) => (c.model === PRIMARY_MODEL ? quotaError() : OK_RESULT));
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(models(), [PRIMARY_MODEL, FALLBACK_MODELS[0]]);
    assert.equal(outcome.model, FALLBACK_MODELS[0]);
    assert.match(outcome.notice, new RegExp(PRIMARY_MODEL));
    assert.match(outcome.notice, /request limit/);
    assert.match(outcome.notice, new RegExp(`generated with ${FALLBACK_MODELS[0]}`));
  });

  test("the RPM flavour of 429 falls back too", async () => {
    const { generate, models } = stub((c) => (c.model === PRIMARY_MODEL ? rpmError() : OK_RESULT));
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(models(), [PRIMARY_MODEL, FALLBACK_MODELS[0]]);
    assert.equal(outcome.model, FALLBACK_MODELS[0]);
  });

  test("walks the whole list when several models are at their limit", async () => {
    const exhausted = new Set([PRIMARY_MODEL, FALLBACK_MODELS[0], FALLBACK_MODELS[1]]);
    const { generate, models } = stub((c) => (exhausted.has(c.model) ? quotaError() : OK_RESULT));
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(models(), [PRIMARY_MODEL, ...FALLBACK_MODELS]);
    assert.equal(outcome.model, FALLBACK_MODELS[2]);
    assert.match(outcome.notice, /hit its request limit/);
  });

  test("still falls back when a model isn't available for the key", async () => {
    const { generate, models } = stub((c) => (c.model === PRIMARY_MODEL ? modelNotFoundError() : OK_RESULT));
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(models(), [PRIMARY_MODEL, FALLBACK_MODELS[0]]);
    assert.equal(outcome.model, FALLBACK_MODELS[0]);
    assert.match(outcome.notice, /isn't available for this API key/);
  });

  test("rethrows errors that another model wouldn't fix", async () => {
    const failure = badRequestError();
    const { generate, models } = stub(() => failure);

    // The very same error object must bubble up, and no other model is tried.
    await assert.rejects(() => generateWithFallback(generate, PARTS), (err) => err === failure);
    assert.deepEqual(models(), [PRIMARY_MODEL]);
  });
});

describe("generateWithFallback (cross-provider)", () => {
  test("crosses over to OpenRouter when every Gemini model is exhausted", async () => {
    const { generate, models, calls } = stub((c) =>
      c.provider === "gemini" ? quotaError() : OK_RESULT
    );
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(models(), [...GEMINI_CHAIN, OR_PRIMARY]);
    assert.equal(outcome.model, OR_PRIMARY);
    assert.equal(outcome.provider, "openrouter");
    assert.match(outcome.notice, new RegExp(`${PRIMARY_MODEL} hit its request limit`));
    assert.match(outcome.notice, new RegExp(`generated with ${OR_PRIMARY} \\(OpenRouter\\) instead`));
    assert.match(outcome.notice, new RegExp(`Trying ${PRIMARY_MODEL} again in`));
    assert.equal(calls.every((c) => c.provider === "gemini" || c.provider === "openrouter"), true);
  });

  test("walks the OpenRouter list too", async () => {
    const exhausted = new Set([
      OR_PRIMARY,
      OR_SECOND,
      ...GEMINI_CHAIN,
    ]);
    const { generate, models } = stub((c) => (exhausted.has(c.model) ? openRouterError("Rate limit reached", 429, 60) : OK_RESULT));
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(models(), [...GEMINI_CHAIN, ...OPENROUTER_CHAIN]);
    assert.equal(outcome.model, OR_THIRD);
    assert.equal(outcome.provider, "openrouter");
  });

  test("a rejected OpenRouter key (401) is skipped without a cooldown", async () => {
    const { generate, models } = stub((c) =>
      c.provider === "openrouter"
        ? openRouterError("No auth credentials found", 401)
        : quotaError()
    );

    await assert.rejects(
      () => generateWithFallback(generate, PARTS),
      (err) => {
        assert.ok(err instanceof GenerationError);
        // Mixed reasons get a message that says so (retry AND check keys)…
        assert.equal(err.status, 429);
        assert.match(err.message, /some hit their request limit, others aren't available for your API key/);
        assert.match(err.message, /OPENROUTER_API_KEY/);
        return true;
      }
    );
    // …and the OpenRouter models WERE tried (in order) but got no cooldown
    // notes — next request will try them again immediately.
    assert.deepEqual(models(), [...GEMINI_CHAIN, ...OPENROUTER_CHAIN]);
    assert.equal(rateLimitStatus().every((n) => n.provider === "gemini"), true);
    assert.equal(rateLimitStatus().length, GEMINI_CHAIN.length);
  });

  test("an unsupported-input skip has no cooldown: the next model is tried immediately", async () => {
    const { generate, models } = stub((c) => {
      if (c.provider === "gemini") return quotaError();
      if (c.model === OR_PRIMARY) return new UnsupportedInputError("OpenRouter can't read image/heic files directly.");
      return OK_RESULT;
    });
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(models(), [...GEMINI_CHAIN, OR_PRIMARY, OR_SECOND]);
    assert.equal(outcome.model, OR_SECOND);
    // Only the Gemini models got cooldown notes, not the skipped OpenRouter model.
    assert.equal(rateLimitStatus().filter((n) => n.provider === "openrouter").length, 0);
    assert.match(outcome.notice, /can't read this upload/);
  });

  test("when every candidate is blind to the upload, the actionable fix wins", async () => {
    const { generate } = stub((c) =>
      c.provider === "gemini"
        ? quotaError()
        : new UnsupportedInputError("OpenRouter can't read image/heic files directly. Please convert it to JPEG or PNG and upload again.")
    );

    await assert.rejects(
      () => generateWithFallback(generate, PARTS),
      (err) => {
        assert.ok(err instanceof GenerationError);
        assert.equal(err.status, 503);
        assert.match(err.message, /convert it to JPEG or PNG/);
        assert.match(err.message, /at their request limit/);
        return true;
      }
    );
  });

  test("cooldowns are keyed per provider (same model name, different memory)", () => {
    noteRateLimit({ provider: "gemini", model: "some-model" }, quotaError("30s"));
    assert.equal(isCoolingDown({ provider: "gemini", model: "some-model" }), true);
    assert.equal(isCoolingDown({ provider: "openrouter", model: "some-model" }), false);
    assert.equal(rateLimitStatus().length, 1);
  });
});

describe("cooldown memory", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = ""; // gemini-only chain
  });

  test("the next request skips the rate-limited model without calling it", async () => {
    const first = stub((c) => (c.model === PRIMARY_MODEL ? quotaError() : OK_RESULT));
    await generateWithFallback(first.generate, PARTS);

    assert.deepEqual(rateLimitStatus().map((n) => n.model), [PRIMARY_MODEL]);

    const second = stub(() => OK_RESULT);
    const outcome = await generateWithFallback(second.generate, PARTS);

    assert.deepEqual(second.models(), [FALLBACK_MODELS[0]]);
    assert.equal(outcome.model, FALLBACK_MODELS[0]);
    assert.match(outcome.notice, new RegExp(`${PRIMARY_MODEL} hit its request limit`));
  });

  test("uses the provider's retryDelay as the cooldown", () => {
    const note = noteRateLimit({ provider: "gemini", model: PRIMARY_MODEL }, quotaError("30s"));
    assert.equal(note.retryInMs, 30_000);
    assert.equal(rateLimitStatus()[0].retryInMs, 30_000);
  });

  test("doubles the cooldown when the same model keeps failing", () => {
    const candidate = { provider: "gemini", model: PRIMARY_MODEL };
    assert.equal(noteRateLimit(candidate, quotaError("30s")).retryInMs, 30_000);
    assert.equal(noteRateLimit(candidate, quotaError("30s")).retryInMs, 60_000);
    assert.equal(noteRateLimit(candidate, quotaError("30s")).retryInMs, 120_000);
  });

  test("falls back to the configured/default cooldown when the API says nothing", () => {
    const candidate = { provider: "gemini", model: PRIMARY_MODEL };
    assert.equal(noteRateLimit(candidate, rpmError()).retryInMs, 5 * 60 * 1000);

    resetFailoverState();
    process.env.GEMINI_RATE_LIMIT_COOLDOWN_SECONDS = "45";
    assert.equal(noteRateLimit(candidate, rpmError()).retryInMs, 45_000);
  });

  test("caps a day-long quota hint at 30 minutes", () => {
    const candidate = { provider: "gemini", model: PRIMARY_MODEL };
    assert.equal(noteRateLimit(candidate, quotaError("86400s")).retryInMs, 30 * 60 * 1000);
  });

  test("the primary model comes back once its cooldown has passed", async () => {
    const first = stub((c) => (c.model === PRIMARY_MODEL ? quotaError("30s") : OK_RESULT));
    await generateWithFallback(first.generate, PARTS);
    assert.deepEqual(
      activeCandidates().candidates.map((c) => c.model),
      FALLBACK_MODELS
    );

    const later = Date.now() + 31_000;
    assert.deepEqual(
      activeCandidates(later).candidates.map((c) => c.model),
      [PRIMARY_MODEL, ...FALLBACK_MODELS]
    );

    const second = stub(() => OK_RESULT);
    const outcome = await generateWithFallback(second.generate, PARTS);
    // In real time the window hasn't elapsed, so it is still skipped…
    assert.equal(outcome.model, FALLBACK_MODELS[0]);
    // …and querying with a future timestamp reports the model as ready again
    // without disturbing the live note.
    assert.equal(rateLimitStatus(later).length, 0);
    assert.deepEqual(rateLimitStatus().map((n) => n.model), [PRIMARY_MODEL]);
  });

  test("when every model is cooling down, they are all tried anyway", async () => {
    for (const model of [PRIMARY_MODEL, ...FALLBACK_MODELS]) {
      noteRateLimit({ provider: "gemini", model }, quotaError("30s"));
    }
    assert.deepEqual(
      activeCandidates().candidates.map((c) => c.model),
      [PRIMARY_MODEL, ...FALLBACK_MODELS]
    );
    assert.deepEqual(activeCandidates().coolingDown, []);

    const { generate, models } = stub(() => OK_RESULT);
    const outcome = await generateWithFallback(generate, PARTS);
    assert.deepEqual(models(), [PRIMARY_MODEL]);
    assert.equal(outcome.model, PRIMARY_MODEL);
    assert.equal(outcome.notice, undefined);
  });
});

describe("when no candidate can serve the request", () => {
  test("throws a 429 (so the client shows a retry message, not a crash)", async () => {
    process.env.OPENROUTER_API_KEY = "";
    const { generate, models } = stub(() => quotaError("60s"));

    await assert.rejects(
      () => generateWithFallback(generate, PARTS),
      (err) => {
        assert.ok(err instanceof GenerationError);
        assert.equal(err.status, 429);
        assert.match(err.message, /Every AI model is at its request limit/);
        assert.match(err.message, /try again/);
        for (const model of [PRIMARY_MODEL, ...FALLBACK_MODELS]) {
          assert.match(err.message, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        }
        return true;
      }
    );
    assert.deepEqual(models(), [PRIMARY_MODEL, ...FALLBACK_MODELS]);
  });

  test("the 429 message covers OpenRouter models when both providers are out", async () => {
    const { generate } = stub(() => openRouterError("Rate limit reached", 429, 60));

    await assert.rejects(
      () => generateWithFallback(generate, PARTS),
      (err) => {
        assert.ok(err instanceof GenerationError);
        assert.equal(err.status, 429);
        assert.match(err.message, /Every AI model is at its request limit/);
        assert.match(err.message, new RegExp(OR_PRIMARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(err.message, /OpenRouter/);
        assert.match(err.message, new RegExp(PRIMARY_MODEL));
        return true;
      }
    );
  });

  test("throws a 503 when none of the models exist for this key", async () => {
    process.env.OPENROUTER_API_KEY = "";
    const { generate } = stub(() => modelNotFoundError());

    await assert.rejects(
      () => generateWithFallback(generate, PARTS),
      (err) => {
        assert.ok(err instanceof GenerationError);
        assert.equal(err.status, 503);
        assert.match(err.message, /GEMINI_MODEL/);
        return true;
      }
    );
  });

  test("throws a 503 configuration error when no provider key is set", async () => {
    process.env.GEMINI_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "";
    delete process.env.GOOGLE_API_KEY;

    await assert.rejects(
      () => generateWithFallback(stub(() => OK_RESULT).generate, PARTS),
      (err) => {
        assert.ok(err instanceof GenerationError);
        assert.equal(err.status, 503);
        assert.match(err.message, /No AI provider is configured/);
        assert.match(err.message, /OPENROUTER_API_KEY/);
        return true;
      }
    );
  });
});

describe("GEMINI_MODEL override", () => {
  test("the configured model is tried first", async () => {
    process.env.GEMINI_MODEL = "custom-model";
    const { generate, models } = stub(() => OK_RESULT);
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(models(), ["custom-model"]);
    assert.equal(outcome.model, "custom-model");
  });

  test("a custom model still fails over to the built-in fallbacks", async () => {
    process.env.GEMINI_MODEL = "gemini-9-preview";
    const { generate, models } = stub((c) => (c.model === "gemini-9-preview" ? quotaError() : OK_RESULT));
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(models(), ["gemini-9-preview", FALLBACK_MODELS[0]]);
    assert.equal(outcome.model, FALLBACK_MODELS[0]);
    assert.match(outcome.notice, /gemini-9-preview hit its request limit/);
    // …and the "we'll retry it" hint names the configured model, not the
    // built-in primary.
    assert.match(outcome.notice, /Trying gemini-9-preview again in/);
  });
});
