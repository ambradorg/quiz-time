/**
 * Sanity tests for the Gemini model fallback logic (src/lib/model-fallback.ts).
 * Run with: npx tsx scripts/test-model-fallback.mjs
 *
 * Error shapes mimic what the @google/generative-ai SDK actually throws
 * (see its handleResponseNotOk: GoogleGenerativeAIFetchError with numeric
 * `status` and a message of
 *   "Error fetching from <url>: [429 Too Many Requests] <json.error.message>").
 */
import assert from "node:assert";
import {
  AllModelsRateLimitedError,
  FALLBACK_MODELS,
  PRIMARY_MODEL,
  generateWithFallback,
  isModelRateLimited,
  isModelUnavailable,
  modelCandidates,
} from "../src/lib/model-fallback";

// ── helpers to build realistic SDK errors ──────────────────────────────────
function fetchError(status, statusText, bodyMessage) {
  const err = new Error(
    `Error fetching from https://generativelanguage.googleapis.com/v1beta/models: [${status} ${statusText}] ${bodyMessage}`
  );
  err.name = "GoogleGenerativeAIFetchError";
  err.status = status;
  err.statusText = statusText;
  return err;
}

const QUOTA_MSG =
  "Quota exceeded for quota metric 'Generate Content requests' and limit 'Generate Content requests per minute' for consumer 'projects/123'.";
const DAILY_QUOTA_MSG =
  "You exceeded your current quota, please check your plan and billing details. The free tier daily quota has been exhausted.";
const RESOURCE_EXHAUSTED_MSG =
  'RESOURCE_EXHAUSTED. Quota exceeded for quota metric "Generate Content requests"';
const NOT_FOUND_MSG = "Models not found: gemini-3.6-flash";

/** Fake Gemini client: per-model error (or "OK" to succeed). */
function fakeClient(behavior) {
  const calls = [];
  return {
    calls,
    getGenerativeModel({ model }) {
      return {
        async generateContent() {
          calls.push(model);
          const out = behavior[model];
          if (out instanceof Error) throw out;
          return { response: { text: () => JSON.stringify({ title: "T", cards: [{ question: 1 }] }) } };
        },
      };
    },
  };
}

// ── cases ──────────────────────────────────────────────────────────────────
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("candidate order: main model first, then fallback chain", () =>
  Promise.resolve(
    assert.deepEqual(modelCandidates(), [
      PRIMARY_MODEL,
      ...FALLBACK_MODELS.filter((m) => m !== PRIMARY_MODEL),
    ])
  )
);

test("429 quota error on primary → falls back to next model", async () => {
  const client = fakeClient({
    [PRIMARY_MODEL]: fetchError(429, "Too Many Requests", QUOTA_MSG),
    "gemini-2.5-flash": "OK",
  });
  const { model } = await generateWithFallback(client);
  assert.equal(model, "gemini-2.5-flash");
  assert.deepEqual(client.calls, [PRIMARY_MODEL, "gemini-2.5-flash"]);
});

test("RESOURCE_EXHAUSTED body → detected", async () => {
  const err = fetchError(429, "Too Many Requests", RESOURCE_EXHAUSTED_MSG);
  assert.ok(isModelRateLimited(err));
  const client = fakeClient({ [PRIMARY_MODEL]: err, "gemini-2.5-flash": "OK" });
  const { model } = await generateWithFallback(client);
  assert.equal(model, "gemini-2.5-flash");
});

test("429 with only status set (no message) still detected", async () => {
  const err = new Error("");
  err.name = "GoogleGenerativeAIFetchError";
  err.status = 429;
  assert.ok(isModelRateLimited(err));
  const client = fakeClient({ [PRIMARY_MODEL]: err, "gemini-2.5-flash": "OK" });
  const { model } = await generateWithFallback(client);
  assert.equal(model, "gemini-2.5-flash");
});

test("daily-quota-exhausted on ALL models → AllModelsRateLimitedError", async () => {
  const e = () => fetchError(429, "Too Many Requests", DAILY_QUOTA_MSG);
  const client = fakeClient({
    [PRIMARY_MODEL]: e(),
    "gemini-2.5-flash": e(),
    "gemini-2.0-flash": e(),
    "gemini-1.5-flash": e(),
  });
  await assert.rejects(generateWithFallback(client), (err) => {
    assert.ok(err instanceof AllModelsRateLimitedError, `got ${err}`);
    assert.match(err.message, /wait a few minutes/i);
    return true;
  });
  assert.equal(client.calls.length, 4, "every candidate was tried");
});

test("404 model-not-found on primary still falls back (old behavior)", async () => {
  assert.ok(!isModelRateLimited(fetchError(404, "Not Found", NOT_FOUND_MSG)));
  assert.ok(isModelUnavailable(fetchError(404, "Not Found", NOT_FOUND_MSG)));
  const client = fakeClient({
    [PRIMARY_MODEL]: fetchError(404, "Not Found", NOT_FOUND_MSG),
    "gemini-2.5-flash": "OK",
  });
  const { model } = await generateWithFallback(client);
  assert.equal(model, "gemini-2.5-flash");
});

test("unrelated 500 error is rethrown (no fallback)", async () => {
  const boom = fetchError(500, "Internal Server Error", "Backend error");
  const client = fakeClient({ [PRIMARY_MODEL]: boom });
  await assert.rejects(generateWithFallback(client), (err) => err === boom);
  assert.deepEqual(client.calls, [PRIMARY_MODEL], "must not try other models");
});

test("validation error (400) is rethrown (no fallback)", async () => {
  const bad = fetchError(400, "Bad Request", "Invalid argument: content is too long");
  const client = fakeClient({ [PRIMARY_MODEL]: bad });
  await assert.rejects(generateWithFallback(client), (err) => err === bad);
  assert.deepEqual(client.calls, [PRIMARY_MODEL]);
});

test("primary works → no fallback at all", async () => {
  const client = fakeClient({ [PRIMARY_MODEL]: "OK" });
  const { model } = await generateWithFallback(client);
  assert.equal(model, PRIMARY_MODEL);
  assert.deepEqual(client.calls, [PRIMARY_MODEL]);
});

test("GEMINI_MODEL override becomes first candidate, dedupes fallbacks", async () => {
  process.env.GEMINI_MODEL = "gemini-2.5-flash";
  try {
    const client = fakeClient({
      "gemini-2.5-flash": fetchError(429, "Too Many Requests", QUOTA_MSG),
      "gemini-2.0-flash": "OK",
    });
    const { model } = await generateWithFallback(client);
    assert.equal(model, "gemini-2.0-flash");
    assert.deepEqual(client.calls, ["gemini-2.5-flash", "gemini-2.0-flash"]);
  } finally {
    delete process.env.GEMINI_MODEL;
  }
});

// ── run ────────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}
console.log(failed === 0 ? "\nAll model-fallback tests passed." : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
