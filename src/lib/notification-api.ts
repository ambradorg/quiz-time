import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "./auth-guard";

export class NotificationInputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export async function notificationJson(request: NextRequest): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new NotificationInputError("JSON required", 415);
  const text = await request.text();
  if (text.length > 8192) throw new NotificationInputError("Request too large", 413);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new NotificationInputError("Invalid JSON body"); }
}

export function notificationRoute(handler: (request: NextRequest, userId: string) => Promise<unknown>, write = false) {
  return async (request: NextRequest) => {
    try {
      const guard = await requireUser();
      if (guard instanceof NextResponse) return guard;
      if (write) {
        // CSRF-style guard for state-changing calls: a browser always sends
        // Origin, and on same-origin posts its host equals the Host header.
        // (request.url is unusable here — dev servers normalise its host.)
        const origin = request.headers.get("origin");
        const host = request.headers.get("host");
        let sameOrigin = false;
        try {
          sameOrigin = Boolean(origin && host && new URL(origin).host === host);
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) throw new NotificationInputError("Same-origin request required", 403);
      }
      const result = await handler(request, guard.user.id);
      // Handlers may answer with their own Response (409/429/…): pass those
      // through untouched instead of re-serialising them into a 200.
      if (result instanceof Response) return result;
      return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      if (error instanceof NotificationInputError) return NextResponse.json({ error: error.message }, { status: error.status });
      // Never log subscription endpoints, key material, or database query parameters.
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      console.error("Notification request failed:", code);
      return NextResponse.json({ error: code === "42P01" ? "Notification storage isn’t ready yet. The app owner needs to apply the notification migration." : "Couldn’t update notifications. Please try again." }, { status: 503 });
    }
  };
}
