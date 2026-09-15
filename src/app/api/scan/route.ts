import { NextRequest, NextResponse } from "next/server";
import { extractDocxText, isDocxFile } from "@/lib/docx";
import { getGeminiClient, generateWithGemini, type GeminiClient } from "@/lib/gemini";
import { extractPptxText, isPptxFile } from "@/lib/pptx";
import { generateWithOpenRouter } from "@/lib/openrouter";
import {
  GenerationError,
  generateWithFallback,
  type AiPart,
} from "@/lib/failover";
import { isRateLimited } from "@/lib/rate-limit";
import { requireUser } from "@/lib/auth-guard";

export const maxDuration = 60;

const SYSTEM_PROMPT = `You are a smart study assistant. Analyze the provided content (from a PDF or image) and generate high-quality flashcard quiz questions.

Your task:
1. Extract the key concepts, facts, definitions, formulas, and important information from the content.
2. Generate between 8 and 20 flashcard questions depending on the content length.
3. Make questions clear, educational, and varied (definitions, explanations, comparisons, etc.).
4. Provide concise but complete answers.
5. Add helpful hints where appropriate.
6. Rate each card difficulty as "easy", "medium", or "hard".

IMPORTANT: Respond ONLY with valid JSON in this exact format:
{
  "title": "A descriptive title for this study set (max 60 chars)",
  "summary": "Brief 1-2 sentence summary of what was studied",
  "cards": [
    {
      "question": "Question text here?",
      "answer": "Complete answer here",
      "hint": "Optional hint (or empty string)",
      "difficulty": "easy|medium|hard"
    }
  ]
}

For enumeration cards (rule 5), "answer" is the list of items joined with " ; ". For all other cards it is a single short answer.`;

const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
};
const MAX_UPLOAD_MB = 50;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_TOTAL_MB = 50;
const MAX_TOTAL_BYTES = MAX_TOTAL_MB * 1024 * 1024;
const MAX_FILES = 8;
const MAX_TEXT_CHARS = 100_000;

/**
 * Phone cameras and some browsers hand us files with an empty or unusual
 * `type` (e.g. "" or "image/jpg"), which the Gemini API rejects with a
 * validation error. Fall back to the file extension, then to JPEG, so we
 * always send a well-formed mime type.
 */
function resolveMimeType(file: File): string | null {
  const declared = (file.type || "").toLowerCase().trim();
  if (declared === "application/pdf") return declared;
  if (declared === "image/jpg") return "image/jpeg";
  if (SUPPORTED_IMAGE_TYPES.includes(declared)) return declared;

  const ext = (file.name || "").split(".").pop()?.toLowerCase() ?? "";
  if (MIME_BY_EXTENSION[ext]) return MIME_BY_EXTENSION[ext];

  // Unknown or empty type: treat it as a camera photo (the common case).
  if (!declared || declared.startsWith("image/")) return "image/jpeg";
  return null;
}

export async function POST(request: NextRequest) {
  try {
    // Generation spends the owner's Gemini credits, so it's sign-in only.
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;

    // Protect the billable Gemini endpoint from casual abuse — bucketed
    // per signed-in user (falls back to IP for edge cases).
    if (isRateLimited(`user:${guard.user.id}`)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a few minutes and try again." },
        { status: 429 }
      );
    }

    const formData = await request.formData();
    // One or many files can be sent under the "file" field.
    const files = formData
      .getAll("file")
      .filter((value): value is File => typeof value !== "string");
    const textContent = formData.get("text") as string | null;

    if (files.length === 0 && !textContent) {
      return NextResponse.json({ error: "No file or text provided" }, { status: 400 });
    }
    if (files.length > MAX_FILES) {
      return NextResponse.json(
        { error: `Please upload at most ${MAX_FILES} files at a time.` },
        { status: 400 }
      );
    }

    if (textContent && textContent.trim().length > MAX_TEXT_CHARS) {
      return NextResponse.json(
        {
          error: `That text is ${(textContent.length / 1000).toFixed(0)}k characters — please keep it under ${MAX_TEXT_CHARS / 1000}k characters.`,
        },
        { status: 400 }
      );
    }

    // At least one provider key is needed; with both, QuizTime simply has a
    // longer safety net (Gemini chain first, then OpenRouter).
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!geminiKey && !process.env.OPENROUTER_API_KEY) {
      return NextResponse.json(
        { error: "No AI provider is configured. Set GEMINI_API_KEY and/or OPENROUTER_API_KEY in your .env file." },
        { status: 503 }
      );
    }

    let genAI: GeminiClient | null = null;
    try {
      if (geminiKey) genAI = getGeminiClient();
    } catch (err) {
      return NextResponse.json(
        { error: (err as Error).message },
        { status: 503 }
      );
    }

    let parts: AiPart[];

    if (files.length > 0) {
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      if (totalBytes > MAX_TOTAL_BYTES) {
        return NextResponse.json(
          { error: `Those files total ${(totalBytes / 1024 / 1024).toFixed(1)} MB. Please keep it under ${MAX_TOTAL_MB} MB — remove a few or use screenshots.` },
          { status: 413 }
        );
      }

      parts = [];
      // Text extracted client-side from PDFs that were too large to upload
      // directly (see src/app/page.tsx) arrives alongside the smaller files.
      if (textContent && textContent.trim()) {
        parts.push(textContent.trim());
      }
      for (const file of files) {
        if (file.size === 0) {
          return NextResponse.json(
            { error: `"${file.name || "One of the files"}" came back empty — please add it again.` },
            { status: 400 }
          );
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          return NextResponse.json(
            { error: `"${file.name || "One of the files"}" is ${(file.size / 1024 / 1024).toFixed(1)} MB. Please use files under ${MAX_UPLOAD_MB} MB — a screenshot usually works great.` },
            { status: 413 }
          );
        }

        // Word documents: Gemini can't take .docx inline, so send the text.
        if (isDocxFile(file)) {
          try {
            const docText = await extractDocxText(file);
            parts.push(`--- Word document: ${file.name || "document"} ---\n${docText}`);
          } catch (docError) {
            const reason = docError instanceof Error ? docError.message : "";
            return NextResponse.json(
              {
                error: reason || `Couldn't read "${file.name || "that Word file"}". If it's an old .doc file, re-save it as .docx (or export it to PDF) and try again.`,
              },
              { status: 400 }
            );
          }
          continue;
        }

        // PowerPoint presentations: Gemini can't take .pptx inline either.
        if (isPptxFile(file)) {
          try {
            const pptText = await extractPptxText(file);
            parts.push(`--- PowerPoint presentation: ${file.name || "presentation"} ---\n${pptText}`);
          } catch (pptError) {
            const reason = pptError instanceof Error ? pptError.message : "";
            return NextResponse.json(
              {
                error: reason || `Couldn't read "${file.name || "that PowerPoint file"}". If it's an old .ppt file, re-save it as .pptx (or export it to PDF) and try again.`,
              },
              { status: 400 }
            );
          }
          continue;
        }

        const mimeType = resolveMimeType(file);
        if (!mimeType) {
          return NextResponse.json(
            { error: `Unsupported file type "${file.type || "unknown"}" for "${file.name || "a file"}". Upload a JPEG/PNG/WEBP photo, a screenshot, a PDF, a Word (.docx) file, or a PowerPoint (.pptx) file.` },
            { status: 400 }
          );
        }

        const arrayBuffer = await file.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString("base64");
        parts.push({ inlineData: { mimeType, data: base64 } });
      }

      parts.push(
        files.length > 1 || (textContent && textContent.trim())
          ? `You were given ${files.length + (textContent && textContent.trim() ? 1 : 0)} study sources (in this order). ${SYSTEM_PROMPT} Make sure the flashcards cover ALL of the sources, not just the first one.`
          : SYSTEM_PROMPT
      );
    } else {
      parts = [`Here is the study text content:\n\n${textContent}\n\n${SYSTEM_PROMPT}`];
    }

    // Model selection with automatic failover: if the primary model is at its
    // rate limit (or isn't available for the key), the next model is used —
    // across Gemini's models AND OpenRouter — instead of failing the upload.
    // See src/lib/failover.ts.
    const { text: responseText, model, provider, notice } = await generateWithFallback(
      (candidate, content) =>
        candidate.provider === "gemini"
          ? generateWithGemini(genAI as GeminiClient, candidate, content)
          : generateWithOpenRouter(candidate, content),
      parts
    );
    if (notice) console.warn(notice);

    // Extract JSON from the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("AI did not return valid JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.cards || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
      throw new Error("No flashcards were generated from this content");
    }

    return NextResponse.json({
      success: true,
      title: parsed.title || "Study Set",
      summary: parsed.summary || "",
      cards: parsed.cards,
      model,
      provider,
      // Only set when we had to switch models (rate limit / unavailable).
      notice,
    });
  } catch (error) {
    console.error("Scan error:", error);
    const message = error instanceof Error ? error.message : "Failed to process file";
    // GenerationError carries the status the situation deserves (429 when every
    // model is rate-limited, 503 when none is available); anything else is a
    // server-side failure.
    const status = error instanceof GenerationError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
