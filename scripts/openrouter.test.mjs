#!/usr/bin/env node
/**
 * Tests for the OpenRouter provider adapter (src/lib/openrouter.ts).
 *
 * The network is stubbed (global fetch); everything else is the shipped code:
 * the parts→content conversion (text / images / server-side PDF extraction),
 * the error normalization (including OpenRouter's "HTTP 200 with an error
 * body" upstream failures), and a cross-check that the failover engine
 * classifies every normalized error the way the adapter intends.
 *
 * Usage:
 *   npm run test:openrouter
 */
import test, { afterEach, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPdfBuffer, PNG_1X1_BASE64, base64ToBuffer } from "./test-utils.mjs";

const {
  extractPdfText,
  generateWithOpenRouter,
  OpenRouterError,
  partsToContent,
} = await import("../src/lib/openrouter.ts");
const {
  isModelUnavailable,
  isProviderRateLimited,
  isUnsupportedInput,
  retryDelayMs,
  UnsupportedInputError,
} = await import("../src/lib/failover.ts");

const CARDS_JSON = JSON.stringify({
  title: "Cell Biology",
  summary: "Basics of cells.",
  cards: [{ question: "What is the powerhouse of the cell?", answer: "Mitochondria", difficulty: "easy" }],
});

// ─── Fake OpenRouter endpoint ────────────────────────────────────────────────

let responder;
let requests = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ url: String(url), options, body });
  return responder(body, options);
};

test.after(() => {
  globalThis.fetch = realFetch;
});

const OR_CANDIDATE = { provider: "openrouter", model: "openrouter/free" };

function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    statusText: String(status),
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  requests = [];
  process.env.OPENROUTER_API_KEY = "test-or-key";
  responder = () => json(200, { choices: [{ message: { content: CARDS_JSON }, finish_reason: "stop" }] });
});

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
});

describe("partsToContent", () => {
  test("text parts pass through as text blocks", async () => {
    const content = await partsToContent(["Hello study world"]);
    assert.deepEqual(content, [{ type: "text", text: "Hello study world" }]);
  });

  test("images become base64 data URLs", async () => {
    const content = await partsToContent([
      "context",
      { inlineData: { mimeType: "image/jpeg", data: "abc123" } },
    ]);
    assert.deepEqual(content, [
      { type: "text", text: "context" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc123" } },
    ]);
  });

  test("PDFs are converted to text on the server", async () => {
    const pdf = buildPdfBuffer("Mitochondria are the powerhouse of the cell.");
    const content = await partsToContent([
      { inlineData: { mimeType: "application/pdf", data: pdf.toString("base64") } },
    ]);
    assert.equal(content.length, 1);
    assert.equal(content[0].type, "text");
    assert.match(content[0].text, /PDF \(pages converted to text\)/);
    assert.match(content[0].text, /Mitochondria are the powerhouse of the cell/);
  });

  test("scanned PDFs (no text layer) reject with an actionable message", async () => {
    const blankPdf = buildPdfBuffer("");
    await assert.rejects(
      () => partsToContent([{ inlineData: { mimeType: "application/pdf", data: blankPdf.toString("base64") } }]),
      (err) => {
        assert.ok(err instanceof UnsupportedInputError);
        assert.match(err.message, /no selectable text/);
        assert.match(err.message, /photos/);
        return true;
      }
    );
  });

  test("HEIC images reject with a conversion hint (not a crash)", async () => {
    await assert.rejects(
      () => partsToContent([{ inlineData: { mimeType: "image/heic", data: "abc" } }]),
      (err) => {
        assert.ok(err instanceof UnsupportedInputError);
        assert.match(err.message, /image\/heic/);
        assert.match(err.message, /JPEG or PNG/);
        return true;
      }
    );
  });

  test("an empty part list rejects", async () => {
    await assert.rejects(() => partsToContent([]), UnsupportedInputError);
  });
});

describe("extractPdfText", () => {
  test("extracts text from a real PDF buffer", async () => {
    const pdf = buildPdfBuffer("powerhouse of the cell MITOCHONDRIA");
    const text = await extractPdfText(pdf.toString("base64"));
    assert.match(text, /powerhouse of the cell MITOCHONDRIA/);
  });
});

describe("generateWithOpenRouter", () => {
  test("sends the model, content and an attributed key, and returns the text", async () => {
    const outcome = await generateWithOpenRouter(
      OR_CANDIDATE,
      ["some study text"]
    );
    assert.equal(outcome.text, CARDS_JSON);

    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /openrouter\.ai\/api\/v1\/chat\/completions/);
    assert.equal(requests[0].body.model, "openrouter/free");
    assert.deepEqual(requests[0].body.messages, [{ role: "user", content: [{ type: "text", text: "some study text" }] }]);
    assert.equal(requests[0].body.max_tokens, 8192);
    assert.equal(requests[0].options.headers.authorization, "Bearer test-or-key");
    assert.equal(requests[0].options.headers["x-title"], "QuizTime");
  });

  test("joins array-shaped message content", async () => {
    responder = () =>
      json(200, {
        choices: [{ message: { content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }] }, finish_reason: "stop" }],
      });
    const outcome = await generateWithOpenRouter(OR_CANDIDATE, ["x"]);
    assert.equal(outcome.text, "part one part two");
  });

  test("an empty completion is a retryable provider error", async () => {
    responder = () => json(200, { choices: [{ message: { content: "" }, finish_reason: "length" }] });
    await assert.rejects(
      () => generateWithOpenRouter(OR_CANDIDATE, ["x"]),
      (err) => {
        assert.ok(err instanceof OpenRouterError);
        assert.equal(err.status, 502);
        assert.match(err.message, /empty response/);
        return true;
      }
    );
  });

  test("a 429 keeps its status and Retry-After delay", async () => {
    responder = () => json(429, { error: { message: "You have exceeded your rate limit", code: 429 } }, { "retry-after": "45" });
    await assert.rejects(
      () => generateWithOpenRouter(OR_CANDIDATE, ["x"]),
      (err) => {
        assert.ok(err instanceof OpenRouterError);
        assert.equal(err.status, 429);
        assert.equal(err.retryDelaySeconds, 45);
        return true;
      }
    );
    assert.equal(retryDelayMs(new OpenRouterError("r", 429, 45)), 45_000);
  });

  test("a 404 (retired free model) passes through for the engine to skip", async () => {
    responder = () =>
      json(404, { error: { message: "No endpoints found for deepseek/deepseek-r1:free", code: 404 } });
    await assert.rejects(
      () => generateWithOpenRouter({ provider: "openrouter", model: "deepseek/deepseek-r1:free" }, ["x"]),
      (err) => {
        assert.ok(err instanceof OpenRouterError);
        assert.equal(err.status, 404);
        return true;
      }
    );
  });

  test("a 401 gets an actionable hint", async () => {
    responder = () => json(401, { error: { message: "No auth credentials found", code: 401 } });
    await assert.rejects(
      () => generateWithOpenRouter(OR_CANDIDATE, ["x"]),
      (err) => {
        assert.equal(err.status, 401);
        assert.match(err.message, /Check OPENROUTER_API_KEY/);
        return true;
      }
    );
  });

  test("a 402 (negative balance blocks :free too) explains the fix", async () => {
    responder = () => json(402, { error: { message: "Insufficient credits", code: 402 } });
    await assert.rejects(
      () => generateWithOpenRouter(OR_CANDIDATE, ["x"]),
      (err) => {
        assert.equal(err.status, 402);
        assert.match(err.message, /negative OpenRouter balance/);
        assert.match(err.message, /1,000 requests/);
        return true;
      }
    );
  });

  test("an upstream failure that arrives as HTTP 200 keeps its real status", async () => {
    // The shape klymentiev.com's daily checks (Sept 2026) captured from
    // nvidia/nemotron-3-nano-omni:free — 200 OK, error in the body.
    responder = () =>
      json(200, {
        error: {
          message: "Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (16/16)",
          code: 502,
          metadata: { error_type: "provider_unavailable" },
        },
      });
    await assert.rejects(
      () => generateWithOpenRouter(OR_CANDIDATE, ["x"]),
      (err) => {
        assert.ok(err instanceof OpenRouterError);
        assert.equal(err.status, 502);
        assert.match(err.message, /ResourceExhausted/);
        return true;
      }
    );
  });

  test("an upstream rate limit (fresh account, saturated provider) is a 429", async () => {
    responder = () =>
      json(429, {
        error: {
          message: "Provider returned error nvidia/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly.",
          code: 429,
        },
      });
    await assert.rejects(
      () => generateWithOpenRouter(OR_CANDIDATE, ["x"]),
      (err) => {
        assert.ok(err instanceof OpenRouterError);
        assert.equal(err.status, 429);
        return true;
      }
    );
  });

  test("without a key it fails fast before touching the network", async () => {
    delete process.env.OPENROUTER_API_KEY;
    await assert.rejects(
      () => generateWithOpenRouter(OR_CANDIDATE, ["x"]),
      (err) => {
        assert.ok(err instanceof OpenRouterError);
        assert.equal(err.status, 503);
        assert.match(err.message, /not configured/);
        return true;
      }
    );
    assert.equal(requests.length, 0);
  });

  test("a PDF upload is converted before anything is sent", async () => {
    const pdf = buildPdfBuffer("powerhouse of the cell MITOCHONDRIA");
    const outcome = await generateWithOpenRouter(
      OR_CANDIDATE,
      [
        { inlineData: { mimeType: "application/pdf", data: pdf.toString("base64") } },
        "Now make flashcards.",
      ]
    );
    assert.equal(outcome.text, CARDS_JSON);
    const content = requests[0].body.messages[0].content;
    assert.deepEqual(
      content.map((b) => b.type),
      ["text", "text"]
    );
    assert.match(content[0].text, /powerhouse of the cell MITOCHONDRIA/);
  });

  test("a photo upload sends a data URL", async () => {
    await generateWithOpenRouter(
      OR_CANDIDATE,
      [{ inlineData: { mimeType: "image/png", data: PNG_1X1_BASE64 } }]
    );
    const content = requests[0].body.messages[0].content;
    assert.deepEqual(content, [
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1_BASE64}` } },
    ]);
  });
});

describe("engine classification of normalized errors", () => {
  test("every normalized error lands in the right bucket", () => {
    // rate limited → cooldown + next candidate
    for (const err of [
      new OpenRouterError("You have exceeded your rate limit", 429),
      new OpenRouterError("temporarily rate-limited upstream", 429),
      new OpenRouterError("provider_unavailable", 502),
      new OpenRouterError("provider_unavailable", 503),
    ]) {
      assert.equal(isProviderRateLimited(err), true, err.message);
      assert.equal(isModelUnavailable(err), false, err.message);
    }
    // unavailable → skip, no cooldown
    for (const err of [
      new OpenRouterError("No endpoints found", 404),
      new OpenRouterError("No auth credentials found. Check OPENROUTER_API_KEY.", 401),
      new OpenRouterError("Insufficient credits", 402),
      new OpenRouterError("Model is only available on agentic harnesses", 403),
    ]) {
      assert.equal(isModelUnavailable(err), true, err.message);
      assert.equal(isProviderRateLimited(err), false, err.message);
    }
    // unsupported input → skip, no cooldown
    const heic = new OpenRouterError("Model does not support image input", 400);
    assert.equal(isUnsupportedInput(heic), true);
    // plain bad request → fatal (rethrown)
    const bad = new OpenRouterError("Invalid request: max_tokens above provider cap", 400);
    assert.equal(isUnsupportedInput(bad), true); // max_tokens rejections skip the candidate
    const other = new OpenRouterError("Internal provider error", 500);
    assert.equal(isProviderRateLimited(other), false);
    assert.equal(isModelUnavailable(other), false);
    assert.equal(isUnsupportedInput(other), false);
  });
});
