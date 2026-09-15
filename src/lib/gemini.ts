/**
 * Gemini provider adapter for the failover engine (`src/lib/failover.ts`).
 *
 * All the failover policy — candidate order, rate-limit cooldowns, user
 * notices — lives in the engine. This file only knows how to talk to the
 * Google Generative Language API: build the client, run one generation
 * against one model. The SDK's own error objects bubble up untouched; the
 * engine classifies them (404 → unavailable, 429/503 → rate limit, …).
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AiPart, Candidate, Generation } from "./failover";

export type GeminiClient = GoogleGenerativeAI;

/**
 * Builds the SDK client from GEMINI_API_KEY (or GOOGLE_API_KEY). Throws a
 * user-facing message when no key is configured — the route checks for a key
 * first, so this is a safety net.
 */
export function getGeminiClient(): GeminiClient {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured. Please add it to your .env file.");
  }
  return new GoogleGenerativeAI(apiKey);
}

/**
 * Runs one generation against one Gemini model. `candidate.model` is the
 * model id; `parts` are the prompt pieces (text and inline files) built by
 * the scan route.
 */
export async function generateWithGemini(
  client: GeminiClient,
  candidate: Candidate,
  parts: AiPart[]
): Promise<Generation> {
  const result = await client.getGenerativeModel({ model: candidate.model }).generateContent(parts);
  return { text: result.response.text() };
}
