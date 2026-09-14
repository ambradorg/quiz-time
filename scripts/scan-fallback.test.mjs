#!/usr/bin/env node
/**
 * Route-level test for automatic Gemini model failover.
 *
 * Where scripts/gemini-fallback.test.mjs unit-tests src/lib/gemini.ts with
 * hand-built errors, this one drives the *whole* POST /api/scan handler with
 * the real `@google/generative-ai` SDK talking to a fake Google endpoint
 * (global fetch is stubbed). So the 429s here are real
 * GoogleGenerativeAIFetchError instances built by the SDK from a real JSON
 * error payload, and the assertions cover what a browser actually receives:
 * the HTTP status, the generated cards, the `model` that produced them and the
 * `notice` explaining the switch.
 *
 * Only two things are stubbed: the sign-in guard (no database here) and the
 * network. Everything in between is the shipped code.
 *
 * Usage:
 *   npm run test:scan
 */
import test, { afterEach, beforeEach, describe, mock } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/quiztime";
process.env.GEMINI_API_KEY = "test-key";

// Stand in for a signed-in user so the handler runs without a database.
mock.module("../src/lib/auth-guard.ts", {
  namedExports: {
    requireUser: async () => ({ user: { id: "user-1", name: "Test", image: null } }),
  },
});

// ─── Fake Google endpoint ────────────────────────────────────────────────────

const CARDS_JSON = JSON.stringify({
  title: "Cell Biology",
  summary: "Basics of cells.",
  cards: [{ question: "What is the powerhouse of the cell?", answer: "Mitochondria", difficulty: "easy" }],
});

/** What the real API sends back when a model is out of quota. */
function quotaBody() {
  return {
    error: {
      code: 429,
      message:
        "You exceeded your current quota. Please check your plan and billing details. For more information on this error, see: https://ai.google.dev/gemini-api/docs/rate-limits",
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "RATE_LIMIT_EXCEEDED",
          domain: "googleapis.com",
          metadata: { service: "generativelanguage.googleapis.com", retryDelay: "30s" },
        },
      ],
    },
  };
}

function notFoundBody(model) {
  return {
    error: {
      code: 404,
      message: `models/${model} is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.`,
      status: "NOT_FOUND",
    },
  };
}

function okBody() {
  return {
    candidates: [
      {
        content: { parts: [{ text: CARDS_JSON }], role: "model" },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
  };
}

/** Models that should answer 429 for the current test. */
let exhausted = new Set();
let missing = new Set();
let requested = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const target = String(url);
  const model = target.match(/\/models\/([^:/?]+):generateContent/)?.[1] ?? target;
  requested.push(model);
  if (missing.has(model)) {
    return new Response(JSON.stringify(notFoundBody(model)), {
      status: 404,
      statusText: "Not Found",
      headers: { "content-type": "application/json" },
    });
  }
  if (exhausted.has(model)) {
    return new Response(JSON.stringify(quotaBody()), {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(okBody()), {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
  });
};

const { POST } = await import("../src/app/api/scan/route.ts");
const { FALLBACK_MODELS, PRIMARY_MODEL, resetFailoverState } = await import("../src/lib/gemini.ts");

/** POST a text-only study request, exactly like the upload form does. */
async function scan() {
  const form = new FormData();
  form.append("text", "Chapter 3: cells, mitochondria, ribosomes.");
  const response = await POST(
    new Request("http://localhost/api/scan", { method: "POST", body: form })
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  exhausted = new Set();
  missing = new Set();
  requested = [];
  resetFailoverState();
});

afterEach(() => {
  delete process.env.GEMINI_MODEL;
});

test.after(() => {
  globalThis.fetch = realFetch;
});

describe("POST /api/scan with a rate-limited primary model", () => {
  test("uses the available AI Studio fallback model IDs in priority order", () => {
    assert.deepEqual(FALLBACK_MODELS, [
      "gemini-3.1-flash-lite",
      "antigravity",
      "gemini-3.5-flash-lite",
    ]);
  });

  test("generates anyway, with the next available model", async () => {
    exhausted.add(PRIMARY_MODEL);

    const { status, body } = await scan();

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.title, "Cell Biology");
    assert.equal(body.cards.length, 1);
    assert.equal(body.model, "gemini-3.1-flash-lite");
    assert.match(body.notice, /gemini-3\.6-flash hit its request limit/);
    assert.match(body.notice, /generated with gemini-3\.1-flash-lite instead/);
    assert.match(body.notice, /Trying gemini-3\.6-flash again in/);
    // The primary really was attempted first, then the fallback.
    assert.deepEqual(requested, ["gemini-3.6-flash", "gemini-3.1-flash-lite"]);
  });

  test("the next upload skips the exhausted model entirely", async () => {
    exhausted.add("gemini-3.6-flash");
    await scan();
    requested = [];

    const { status, body } = await scan();

    assert.equal(status, 200);
    assert.equal(body.model, "gemini-3.1-flash-lite");
    assert.deepEqual(requested, ["gemini-3.1-flash-lite"]);
  });

  test("walks down the list when several models are exhausted", async () => {
    exhausted.add("gemini-3.6-flash");
    exhausted.add("gemini-3.1-flash-lite");
    exhausted.add("antigravity");

    const { status, body } = await scan();

    assert.equal(status, 200);
    assert.equal(body.model, "gemini-3.5-flash-lite");
    assert.deepEqual(requested, [
      "gemini-3.6-flash",
      "gemini-3.1-flash-lite",
      "antigravity",
      "gemini-3.5-flash-lite",
    ]);
  });

  test("switches models when the primary isn't available for the key", async () => {
    missing.add("gemini-3.6-flash");

    const { status, body } = await scan();

    assert.equal(status, 200);
    assert.equal(body.model, "gemini-3.1-flash-lite");
    assert.match(body.notice, /isn't available for this API key/);
  });

  test("answers 429 with a retry message when every model is exhausted", async () => {
    for (const model of ["gemini-3.6-flash", "gemini-3.1-flash-lite", "antigravity", "gemini-3.5-flash-lite"]) {
      exhausted.add(model);
    }

    const { status, body } = await scan();

    assert.equal(status, 429);
    assert.match(body.error, /Every Gemini model is at its request limit/);
    assert.match(body.error, /Please try again/);
    assert.match(body.error, /gemini-3\.5-flash-lite/);
  });

  test("healthy primary: cards come back with no notice", async () => {
    const { status, body } = await scan();

    assert.equal(status, 200);
    assert.equal(body.model, PRIMARY_MODEL);
    assert.equal(body.notice, undefined);
    assert.deepEqual(requested, [PRIMARY_MODEL]);
  });
});
