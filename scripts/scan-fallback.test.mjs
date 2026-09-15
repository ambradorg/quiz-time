#!/usr/bin/env node
/**
 * Route-level test for automatic model failover across Gemini AND OpenRouter.
 *
 * This drives the *whole* POST /api/scan handler with the real
 * `@google/generative-ai` SDK and the real OpenRouter adapter talking to fake
 * provider endpoints (global fetch is stubbed). So the 429s here are real
 * GoogleGenerativeAIFetchError instances built by the SDK from a real JSON
 * error payload, and the OpenRouter responses are real HTTP bodies — and the
 * assertions cover what a browser actually receives: the HTTP status, the
 * generated cards, the `model`/`provider` that produced them and the
 * `notice` explaining the switch.
 *
 * Only three things are stubbed: the sign-in guard (no database here) and the
 * network. Everything in between is the shipped code.
 *
 * Usage:
 *   npm run test:scan
 */
import test, { afterEach, beforeEach, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { buildPdfBuffer, PNG_1X1_BASE64, base64ToBuffer } from "./test-utils.mjs";

process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/quiztime";
process.env.GEMINI_API_KEY = "test-key";
process.env.OPENROUTER_API_KEY = "test-or-key";

// Stand in for a signed-in user so the handler runs without a database.
mock.module("../src/lib/auth-guard.ts", {
  namedExports: {
    requireUser: async () => ({ user: { id: "user-1", name: "Test", image: null } }),
  },
});

// The app-level rate limiter (10 scans / 10 min per user) would trip after
// the ~17th request in this suite; it isn't what's under test.
mock.module("../src/lib/rate-limit.ts", {
  namedExports: {
    isRateLimited: () => false,
    clientIp: () => "127.0.0.1",
  },
});

// ─── Fake provider endpoints ─────────────────────────────────────────────────

const CARDS_JSON = JSON.stringify({
  title: "Cell Biology",
  summary: "Basics of cells.",
  cards: [{ question: "What is the powerhouse of the cell?", answer: "Mitochondria", difficulty: "easy" }],
});

/** What the real Gemini API sends back when a model is out of quota. */
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

/** What OpenRouter sends back on success / on rate limit. */
function openrouterOkBody() {
  return { id: "gen-1", choices: [{ message: { role: "assistant", content: CARDS_JSON }, finish_reason: "stop" }] };
}

function openrouterRateLimitedBody(model) {
  return {
    error: {
      message: `Provider returned error ${model} is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits`,
      code: 429,
    },
  };
}

/** The shape OpenRouter uses for upstream failures that arrive with HTTP 200. */
function openrouterUpstreamErrorBody() {
  return {
    error: {
      message: "Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (16/16)",
      code: 502,
      metadata: { error_type: "provider_unavailable" },
    },
  };
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    statusText: String(status),
    headers: { "content-type": "application/json" },
  });
}

// Models that should fail for the current test.
let exhausted = new Set();
let missing = new Set();
let requested = [];
// OpenRouter-specific behaviour.
let orExhausted = new Set();
let orUpstreamError = new Set();
let orRequests = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const target = String(url);

  if (target.includes("openrouter.ai")) {
    const body = JSON.parse(options.body);
    orRequests.push({ model: body.model, content: body.messages[0].content });
    if (missing.has(body.model)) {
      return json(404, { error: { message: `No endpoints found for ${body.model}`, code: 404 } });
    }
    if (orUpstreamError.has(body.model)) return json(200, openrouterUpstreamErrorBody());
    if (orExhausted.has(body.model)) return json(429, openrouterRateLimitedBody(body.model));
    return json(200, openrouterOkBody());
  }

  const model = target.match(/\/models\/([^:/?]+):generateContent/)?.[1] ?? target;
  requested.push(model);
  if (missing.has(model)) return json(404, notFoundBody(model));
  if (exhausted.has(model)) return json(429, quotaBody());
  return json(200, okBody());
};

const { POST } = await import("../src/app/api/scan/route.ts");
const {
  DEFAULT_OPENROUTER_MODELS,
  FALLBACK_MODELS,
  PRIMARY_MODEL,
  resetFailoverState,
} = await import("../src/lib/failover.ts");

/** POST a text-only study request, exactly like the upload form does. */
async function scan(extraFields = []) {
  const form = new FormData();
  form.append("text", "Chapter 3: cells, mitochondria, ribosomes.");
  for (const field of extraFields) form.append("file", field);
  const response = await POST(
    new Request("http://localhost/api/scan", { method: "POST", body: form })
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  exhausted = new Set();
  missing = new Set();
  requested = [];
  orExhausted = new Set();
  orUpstreamError = new Set();
  orRequests = [];
  resetFailoverState();
  process.env.OPENROUTER_API_KEY = "test-or-key";
  process.env.GEMINI_API_KEY = "test-key";
});

afterEach(() => {
  delete process.env.GEMINI_MODEL;
  delete process.env.OPENROUTER_MODELS;
});

test.after(() => {
  globalThis.fetch = realFetch;
});

describe("POST /api/scan with a rate-limited primary model (Gemini only)", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = ""; // no OpenRouter configured
  });

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
    assert.equal(body.provider, "gemini");
    assert.match(body.notice, /gemini-3\.6-flash hit its request limit/);
    assert.match(body.notice, /generated with gemini-3\.1-flash-lite instead/);
    assert.match(body.notice, /Trying gemini-3\.6-flash again in/);
    // The primary really was attempted first, then the fallback.
    assert.deepEqual(requested, ["gemini-3.6-flash", "gemini-3.1-flash-lite"]);
    assert.deepEqual(orRequests, []);
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
    assert.match(body.error, /Every AI model is at its request limit/);
    assert.match(body.error, /Please try again/);
    assert.match(body.error, /gemini-3\.5-flash-lite/);
  });

  test("healthy primary: cards come back with no notice", async () => {
    const { status, body } = await scan();

    assert.equal(status, 200);
    assert.equal(body.model, PRIMARY_MODEL);
    assert.equal(body.provider, "gemini");
    assert.equal(body.notice, undefined);
    assert.deepEqual(requested, [PRIMARY_MODEL]);
  });
});

describe("POST /api/scan with both providers configured", () => {
  const ALL_GEMINI = ["gemini-3.6-flash", "gemini-3.1-flash-lite", "antigravity", "gemini-3.5-flash-lite"];

  test("crosses over to OpenRouter when every Gemini model is exhausted", async () => {
    for (const model of ALL_GEMINI) exhausted.add(model);

    const { status, body } = await scan();

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.model, "openrouter/free");
    assert.equal(body.provider, "openrouter");
    assert.match(body.notice, /gemini-3\.6-flash hit its request limit/);
    assert.match(body.notice, /antigravity hit its request limit/);
    assert.match(body.notice, /generated with openrouter\/free \(OpenRouter\) instead/);
    assert.match(body.notice, /Trying gemini-3\.6-flash again in/);
    // The whole Gemini chain was tried, in order, before OpenRouter.
    assert.deepEqual(requested, ALL_GEMINI);
    assert.deepEqual(orRequests.map((r) => r.model), ["openrouter/free"]);
  });

  test("walks the OpenRouter list when the first free model is rate-limited", async () => {
    for (const model of ALL_GEMINI) exhausted.add(model);
    orExhausted.add("openrouter/free");

    const { status, body } = await scan();

    assert.equal(status, 200);
    assert.equal(body.model, DEFAULT_OPENROUTER_MODELS[1]);
    assert.equal(body.provider, "openrouter");
    assert.deepEqual(orRequests.map((r) => r.model), [
      "openrouter/free",
      DEFAULT_OPENROUTER_MODELS[1],
    ]);
  });

  test("an OpenRouter upstream failure in a 200 body skips to the next model", async () => {
    for (const model of ALL_GEMINI) exhausted.add(model);
    orUpstreamError.add("openrouter/free");

    const { status, body } = await scan();

    assert.equal(status, 200);
    assert.equal(body.model, DEFAULT_OPENROUTER_MODELS[1]);
    assert.match(body.notice, /openrouter\/free \(OpenRouter\) hit its request limit/);
  });

  test("a retired free model (404) is skipped without a cooldown", async () => {
    for (const model of ALL_GEMINI) exhausted.add(model);
    missing.add("openrouter/free");

    const { status, body } = await scan();

    assert.equal(status, 200);
    assert.equal(body.model, DEFAULT_OPENROUTER_MODELS[1]);
    assert.match(body.notice, /openrouter\/free \(OpenRouter\) isn't available for this API key/);

    // Next upload: the 404 model is tried again (no cooldown), the rate-limited
    // Gemini models are still skipped.
    requested = [];
    orRequests = [];
    const again = await scan();
    assert.equal(again.status, 200);
    assert.deepEqual(requested, []);
    assert.deepEqual(orRequests.map((r) => r.model), ["openrouter/free", DEFAULT_OPENROUTER_MODELS[1]]);
  });

  test("PDFs reach OpenRouter as server-extracted text", async () => {
    for (const model of ALL_GEMINI) exhausted.add(model);
    const pdf = buildPdfBuffer("Mitochondria are the powerhouse of the cell.");
    const form = new FormData();
    form.append("file", new File([pdf], "notes.pdf", { type: "application/pdf" }));
    form.append("text", "Make flashcards from this.");

    const response = await POST(
      new Request("http://localhost/api/scan", { method: "POST", body: form })
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.provider, "openrouter");
    // The PDF binary never crossed the wire — only extracted text.
    // (user text, extracted PDF, system prompt — all text blocks)
    const content = orRequests[0].content;
    assert.deepEqual(content.map((b) => b.type), ["text", "text", "text"]);
    assert.equal(content[0].text, "Make flashcards from this.");
    assert.match(content[1].text, /PDF \(pages converted to text\)/);
    assert.match(content[1].text, /Mitochondria are the powerhouse of the cell/);
    assert.match(content[2].text, /Respond ONLY with valid JSON/);
  });

  test("photos reach OpenRouter as base64 data URLs", async () => {
    for (const model of ALL_GEMINI) exhausted.add(model);
    const png = base64ToBuffer(PNG_1X1_BASE64);
    const form = new FormData();
    form.append("file", new File([png], "photo.png", { type: "image/png" }));

    const response = await POST(
      new Request("http://localhost/api/scan", { method: "POST", body: form })
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    const [block] = orRequests[0].content;
    assert.equal(block.type, "image_url");
    assert.equal(block.image_url.url, `data:image/png;base64,${PNG_1X1_BASE64}`);
  });

  test("HEIC uploads get a conversion hint when only OpenRouter can serve", async () => {
    process.env.GEMINI_API_KEY = ""; // force the OpenRouter path
    const heic = new Uint8Array([0xff, 0x00, 0x10, 0x12]);
    const form = new FormData();
    form.append("file", new File([heic], "photo.heic", { type: "image/heic" }));

    const response = await POST(
      new Request("http://localhost/api/scan", { method: "POST", body: form })
    );
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.match(body.error, /image\/heic/);
    assert.match(body.error, /JPEG or PNG/);
    // The adapter rejects the parts BEFORE any request leaves the server —
    // no free OpenRouter quota is burned on a file it can't read.
    assert.deepEqual(orRequests, []);
  });

  test("answers 429 naming both providers when everything is exhausted", async () => {
    for (const model of ALL_GEMINI) exhausted.add(model);
    for (const model of DEFAULT_OPENROUTER_MODELS) orExhausted.add(model);

    const { status, body } = await scan();

    assert.equal(status, 429);
    assert.match(body.error, /Every AI model is at its request limit/);
    assert.match(body.error, /gemini-3\.5-flash-lite/);
    assert.match(body.error, /openrouter\/free \(OpenRouter\)/);
    assert.equal(orRequests.length, DEFAULT_OPENROUTER_MODELS.length);
  });
});

describe("POST /api/scan provider configuration", () => {
  test("uses OpenRouter directly when only OPENROUTER_API_KEY is set", async () => {
    process.env.GEMINI_API_KEY = "";

    const { status, body } = await scan();

    assert.equal(status, 200);
    assert.equal(body.model, "openrouter/free");
    assert.equal(body.provider, "openrouter");
    assert.equal(body.notice, undefined);
    assert.deepEqual(requested, []);
    assert.deepEqual(orRequests.map((r) => r.model), ["openrouter/free"]);
  });

  test("answers 503 when no provider key is configured", async () => {
    process.env.GEMINI_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "";

    const { status, body } = await scan();

    assert.equal(status, 503);
    assert.match(body.error, /No AI provider is configured/);
    assert.match(body.error, /OPENROUTER_API_KEY/);
    assert.deepEqual(requested, []);
    assert.deepEqual(orRequests, []);
  });
});
