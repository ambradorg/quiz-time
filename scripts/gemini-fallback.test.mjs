#!/usr/bin/env node
/**
 * Tests for the Gemini model failover (src/lib/gemini.ts) — the thing that
 * keeps an upload working when a model hits its rate limit.
 *
 * No database, no network and no API key: the real `generateWithFallback()`
 * from src/lib/gemini.ts is driven directly with a stub "generate" function
 * that throws the errors `@google/generative-ai` really throws (see
 * handleResponseNotOk() in the SDK — a GoogleGenerativeAIFetchError whose
 * message starts "…: [429 Too Many Requests] <api message> <details json>"
 * and which carries `status` / `statusText` / `errorDetails`).
 *
 * Usage:
 *   npm run test:gemini
 */
import test, { afterEach, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

const {
  FALLBACK_MODELS,
  GeminiApiError,
  PRIMARY_MODEL,
  generateWithFallback,
  isModelUnavailable,
  isProviderRateLimited,
  modelCandidates,
  noteRateLimit,
  rateLimitStatus,
  resetFailoverState,
  retryDelayMs,
} = await import("../src/lib/gemini.ts");

// ─── Error fixtures (shaped like the real SDK errors) ────────────────────────

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

const OK_RESULT = {
  response: { text: () => '{"title":"t","summary":"s","cards":[{"question":"q"}]}' },
};

/**
 * Stub client: `behaviour(model)` returns a result or throws. Records every
 * model it was asked for, in order.
 */
function stub(behaviour) {
  const calls = [];
  const generate = async (model) => {
    calls.push(model);
    const outcome = behaviour(model);
    if (outcome instanceof Error) throw outcome;
    return outcome ?? OK_RESULT;
  };
  return { generate, calls };
}

const PARTS = ["some study text"];

beforeEach(() => resetFailoverState());
afterEach(() => {
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
});

describe("generateWithFallback", () => {
  test("uses the primary model when it is healthy", async () => {
    const { generate, calls } = stub(() => OK_RESULT);
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(calls, [PRIMARY_MODEL]);
    assert.equal(outcome.model, PRIMARY_MODEL);
    assert.equal(outcome.notice, undefined);
    assert.equal(outcome.result, OK_RESULT);
  });

  test("falls back to the next model when the primary hits its rate limit", async () => {
    const { generate, calls } = stub((model) => (model === PRIMARY_MODEL ? quotaError() : OK_RESULT));
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(calls, [PRIMARY_MODEL, FALLBACK_MODELS[0]]);
    assert.equal(outcome.model, FALLBACK_MODELS[0]);
    assert.match(outcome.notice, new RegExp(PRIMARY_MODEL));
    assert.match(outcome.notice, /request limit/);
    assert.match(outcome.notice, new RegExp(`generated with ${FALLBACK_MODELS[0]}`));
  });

  test("the RPM flavour of 429 falls back too", async () => {
    const { generate, calls } = stub((model) => (model === PRIMARY_MODEL ? rpmError() : OK_RESULT));
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(calls, [PRIMARY_MODEL, FALLBACK_MODELS[0]]);
    assert.equal(outcome.model, FALLBACK_MODELS[0]);
  });

  test("walks the whole list when several models are at their limit", async () => {
    const exhausted = new Set([PRIMARY_MODEL, FALLBACK_MODELS[0], FALLBACK_MODELS[1]]);
    const { generate, calls } = stub((model) => (exhausted.has(model) ? quotaError() : OK_RESULT));
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(calls, [PRIMARY_MODEL, ...FALLBACK_MODELS]);
    assert.equal(outcome.model, FALLBACK_MODELS[2]);
    assert.match(outcome.notice, /hit its request limit/);
  });

  test("still falls back when a model isn't available for the key", async () => {
    const { generate, calls } = stub((model) =>
      model === PRIMARY_MODEL ? modelNotFoundError() : OK_RESULT
    );
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(calls, [PRIMARY_MODEL, FALLBACK_MODELS[0]]);
    assert.equal(outcome.model, FALLBACK_MODELS[0]);
    assert.match(outcome.notice, /isn't available for this API key/);
  });

  test("rethrows errors that another model wouldn't fix", async () => {
    const failure = badRequestError();
    const { generate, calls } = stub(() => failure);

    // The very same error object must bubble up, and no other model is tried.
    await assert.rejects(() => generateWithFallback(generate, PARTS), (err) => err === failure);
    assert.deepEqual(calls, [PRIMARY_MODEL]);
  });
});

describe("cooldown memory", () => {
  test("the next request skips the rate-limited model without calling it", async () => {
    const first = stub((model) => (model === PRIMARY_MODEL ? quotaError() : OK_RESULT));
    await generateWithFallback(first.generate, PARTS);

    assert.deepEqual(rateLimitStatus().map((n) => n.model), [PRIMARY_MODEL]);

    const second = stub(() => OK_RESULT);
    const outcome = await generateWithFallback(second.generate, PARTS);

    assert.deepEqual(second.calls, [FALLBACK_MODELS[0]]);
    assert.equal(outcome.model, FALLBACK_MODELS[0]);
    assert.match(outcome.notice, new RegExp(`${PRIMARY_MODEL} hit its request limit`));
  });

  test("uses the provider's retryDelay as the cooldown", () => {
    const note = noteRateLimit(PRIMARY_MODEL, quotaError("30s"));
    assert.equal(note.retryInMs, 30_000);
    assert.equal(rateLimitStatus()[0].retryInMs, 30_000);
  });

  test("doubles the cooldown when the same model keeps failing", () => {
    assert.equal(noteRateLimit(PRIMARY_MODEL, quotaError("30s")).retryInMs, 30_000);
    assert.equal(noteRateLimit(PRIMARY_MODEL, quotaError("30s")).retryInMs, 60_000);
    assert.equal(noteRateLimit(PRIMARY_MODEL, quotaError("30s")).retryInMs, 120_000);
  });

  test("falls back to the configured/default cooldown when the API says nothing", () => {
    assert.equal(noteRateLimit(PRIMARY_MODEL, rpmError()).retryInMs, 5 * 60 * 1000);

    resetFailoverState();
    process.env.GEMINI_RATE_LIMIT_COOLDOWN_SECONDS = "45";
    assert.equal(noteRateLimit(PRIMARY_MODEL, rpmError()).retryInMs, 45_000);
  });

  test("caps a day-long quota hint at 30 minutes", () => {
    assert.equal(noteRateLimit(PRIMARY_MODEL, quotaError("86400s")).retryInMs, 30 * 60 * 1000);
  });

  test("the primary model comes back once its cooldown has passed", async () => {
    const first = stub((model) => (model === PRIMARY_MODEL ? quotaError("30s") : OK_RESULT));
    await generateWithFallback(first.generate, PARTS);
    assert.deepEqual(modelCandidates().models, [FALLBACK_MODELS[0], FALLBACK_MODELS[1], FALLBACK_MODELS[2]]);

    const later = Date.now() + 31_000;
    assert.deepEqual(modelCandidates(later).models, [PRIMARY_MODEL, ...FALLBACK_MODELS]);

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
    for (const model of [PRIMARY_MODEL, ...FALLBACK_MODELS]) noteRateLimit(model, quotaError("30s"));
    assert.deepEqual(modelCandidates().models, [PRIMARY_MODEL, ...FALLBACK_MODELS]);
    assert.deepEqual(modelCandidates().coolingDown, []);

    const { generate, calls } = stub(() => OK_RESULT);
    const outcome = await generateWithFallback(generate, PARTS);
    assert.deepEqual(calls, [PRIMARY_MODEL]);
    assert.equal(outcome.model, PRIMARY_MODEL);
    assert.equal(outcome.notice, undefined);
  });
});

describe("when no model can serve the request", () => {
  test("throws a 429 (so the client shows a retry message, not a crash)", async () => {
    const { generate, calls } = stub(() => quotaError("60s"));

    await assert.rejects(
      () => generateWithFallback(generate, PARTS),
      (err) => {
        assert.ok(err instanceof GeminiApiError);
        assert.equal(err.status, 429);
        assert.match(err.message, /at its request limit/);
        assert.match(err.message, /try again/);
        for (const model of [PRIMARY_MODEL, ...FALLBACK_MODELS]) {
          assert.match(err.message, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        }
        return true;
      }
    );
    assert.deepEqual(calls, [PRIMARY_MODEL, ...FALLBACK_MODELS]);
  });

  test("throws a 503 when none of the models exist for this key", async () => {
    const { generate } = stub(() => modelNotFoundError());

    await assert.rejects(
      () => generateWithFallback(generate, PARTS),
      (err) => {
        assert.ok(err instanceof GeminiApiError);
        assert.equal(err.status, 503);
        assert.match(err.message, /GEMINI_MODEL/);
        return true;
      }
    );
  });
});

describe("GEMINI_MODEL override", () => {
  test("the configured model is tried first", async () => {
    process.env.GEMINI_MODEL = "custom-model";
    const { generate, calls } = stub(() => OK_RESULT);
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(calls, ["custom-model"]);
    assert.equal(outcome.model, "custom-model");
  });

  test("a custom model still fails over to the built-in fallbacks", async () => {
    process.env.GEMINI_MODEL = "gemini-9-preview";
    const { generate, calls } = stub((model) => (model === "gemini-9-preview" ? quotaError() : OK_RESULT));
    const outcome = await generateWithFallback(generate, PARTS);

    assert.deepEqual(calls, ["gemini-9-preview", FALLBACK_MODELS[0]]);
    assert.equal(outcome.model, FALLBACK_MODELS[0]);
    assert.match(outcome.notice, /gemini-9-preview hit its request limit/);
    // …and the "we'll retry it" hint names the configured model, not the
    // built-in primary.
    assert.match(outcome.notice, /Trying gemini-9-preview again in/);
  });
});
