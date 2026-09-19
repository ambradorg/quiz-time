import { NextRequest, NextResponse } from "next/server";
import { handlers } from "@/auth";

/**
 * Auth.js builds every redirect from the request's Host header (its
 * `internalRequest.url.origin`), and the error paths do that *outside* the
 * user-land `redirect` callback. Behind the sandbox preview proxy the Host
 * is an internal address (e.g. `http://0.0.0.0:3000`), so an absolute
 * redirect would send the visitor's browser to a host it cannot reach — the
 * infamous `http://0.0.0.0:3000/login?error=MissingCSRF` dead end.
 *
 * This wrapper rewrites any redirect that points back at the server's OWN
 * origin into a relative path: browsers resolve those against the origin the
 * app was actually loaded from, so the visitor always stays where the app is
 * reachable. External redirects (Google's OAuth consent screen) and
 * already-relative ones are left untouched, so a normal deployment behind a
 * correct host behaves exactly as before.
 */

/** Collapse a self-referential absolute URL to a path; null if external. */
function selfUrlToRelative(url: string, selfOrigin: string): string | null {
  try {
    const parsed = new URL(url, selfOrigin);
    if (parsed.origin !== selfOrigin) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

async function withRelativeAuthRedirects(
  request: NextRequest,
  handle: (req: NextRequest) => Response | Promise<Response>
): Promise<Response> {
  const response = await handle(request);
  const selfOrigin = new URL(request.url).origin;

  // Browser flow: the redirect lives in the Location header. NOTE:
  // Response.redirect() marks its headers immutable — set the corrected
  // Location on a fresh response instead.
  const location = response.headers.get("Location");
  if (location) {
    const relative = selfUrlToRelative(location, selfOrigin);
    if (relative && relative !== location) {
      const headers = new Headers(response.headers);
      headers.set("Location", relative);
      return new NextResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  }

  // Fetch flow (next-auth/react signIn): the response is JSON `{ url }` and
  // the client navigates itself. Rewrite that url the same way — this is the
  // exact path that bounced the preview to the unreachable 0.0.0.0 host.
  // Read via .text() so the body can always be replayed verbatim when no
  // rewrite applies (a consumed stream can never be handed back).
  if (response.headers.get("content-type")?.includes("application/json")) {
    const text = await response.text();
    const headers = new Headers(response.headers);
    // The body size may change — let the runtime set a fresh length.
    headers.delete("content-length");
    let rewritten = text;
    try {
      const body = JSON.parse(text) as { url?: unknown };
      if (body && typeof body.url === "string") {
        const relative = selfUrlToRelative(body.url, selfOrigin);
        if (relative && relative !== body.url) {
          body.url = relative;
          rewritten = JSON.stringify(body);
        }
      }
    } catch {
      /* not JSON — `rewritten` still holds the original text */
    }
    return new NextResponse(rewritten, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
}

export const GET = (request: NextRequest) =>
  withRelativeAuthRedirects(request, handlers.GET);

export const POST = (request: NextRequest) =>
  withRelativeAuthRedirects(request, handlers.POST);
