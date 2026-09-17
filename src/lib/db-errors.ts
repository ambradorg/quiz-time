/**
 * Turning a raw Postgres/`pg` failure into something a human can act on.
 *
 * The "who's online" panel used to collapse every server-side failure into one
 * sentence — "Usually the database: check DATABASE_URL and that the presence
 * migration has been applied" — which is a *guess*, and a wrong guess in at
 * least three common cases:
 *
 *   - the `user_presence` table really is missing (migration not applied),
 *   - the database is unreachable or the credentials are wrong,
 *   - the database user is not allowed to create the table it needs.
 *
 * Those have different fixes, so the API now classifies the failure and sends
 * the *kind* back as `reason`, and the panel turns that into the right advice
 * (see src/lib/use-presence.ts). The raw error still goes to the server log —
 * nothing here is sent to the client except the short `reason` string.
 *
 * Pure and dependency-free (no `pg` import, no `process.env`) so it can be
 * unit-tested without a database: scripts/db-errors.test.mjs.
 */

/** The handful of failure kinds the UI has different advice for. */
export type DbFailureKind =
  /** A table this feature needs isn't in the database yet (SQLSTATE 42P01). */
  | "missing_table"
  /** The server can't talk to the database at all (host, TLS, refused, down). */
  | "unreachable"
  /** It connected, but the credentials were rejected (28000 / 28P01). */
  | "credentials"
  /** It connected, but this role may not do what we asked (42501). */
  | "permission"
  /** Anything else — the log has the detail. */
  | "unknown";

/** SQLSTATEs worth naming. Everything else is `unknown` (the log has it). */
const SQLSTATE = {
  undefinedTable: "42P01",
  undefinedColumn: "42703",
  insufficientPrivilege: "42501",
  invalidPassword: "28P01",
  invalidAuthorization: "28000",
  invalidCatalogName: "3D000", // database in DATABASE_URL doesn't exist
  connectionFailure: "08006",
  adminShutdown: "57P01",
  crashShutdown: "57P02",
  cannotConnectNow: "57P03",
} as const;

/** `pg`/Node-level errors that mean "no connection was ever established". */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "ERR_STREAM_WRITE_AFTER_END",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export interface DbFailure {
  kind: DbFailureKind;
  /** SQLSTATE or Node error code, when there was one — for the log line. */
  code: string | null;
  /**
   * The table named by a 42P01, when Postgres told us (`user_presence`). Lets
   * the caller self-heal only for the table it owns instead of swallowing an
   * unrelated missing relation.
   */
  table: string | null;
  /** Short, log-safe message — never rendered to the client. */
  message: string;
}

/**
 * Walk a thrown value's cause chain and collect every link on the way. Drizzle
 * wraps `pg` errors in its own "Failed query: …" error, and Node's network
 * errors nest too, so the interesting code and message are often one or two
 * links *down* from what was thrown.
 */
function chainOf(error: unknown): Array<{ code?: unknown; errno?: unknown; message?: unknown }> {
  const seen = new Set<unknown>();
  const links: Array<{ code?: unknown; errno?: unknown; message?: unknown }> = [];
  let current: unknown = error;
  // Bounded: a cyclic cause chain must not hang a request.
  while (current && typeof current === "object" && !seen.has(current) && links.length < 10) {
    seen.add(current);
    links.push(current as { code?: unknown; errno?: unknown; message?: unknown });
    current = (current as { cause?: unknown }).cause;
  }
  return links;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";

/**
 * Classify a failure thrown by a database call.
 *
 * Never throws: a broken error object classifies as `unknown`, because the
 * caller is already in a catch block and needs an answer, not another throw.
 */
export function classifyDbError(error: unknown): DbFailure {
  const links = chainOf(error);
  const codes = links
    .map((link) => text(link.code) || text(link.errno))
    .filter((code): code is string => code.length > 0);

  // Every message in the chain, outermost first. Matching only the outermost
  // one misses the diagnosis: for a wrapped query that is Drizzle's SQL text,
  // while "relation \"user_presence\" does not exist" and "connect
  // ECONNREFUSED 127.0.0.1:5432" live on the cause.
  const messages = links
    .map((link) => text(link.message))
    .filter((candidate) => candidate.trim().length > 0);
  const says = (pattern: RegExp): boolean =>
    messages.some((candidate) => pattern.test(candidate));
  // For logging: the innermost message is the specific one.
  const message = messages[messages.length - 1] ?? (typeof error === "string" ? error : "");

  const code = codes[0] ?? null;

  if (codes.includes(SQLSTATE.undefinedTable)) {
    return {
      kind: "missing_table",
      code: SQLSTATE.undefinedTable,
      table: tableIn(messages),
      message,
    };
  }
  // A missing column is the same story one level down: the schema is older
  // than the code. Reported separately so the copy doesn't promise a fix that
  // "create the table" wouldn't deliver.
  if (codes.includes(SQLSTATE.undefinedColumn)) {
    return { kind: "missing_table", code: SQLSTATE.undefinedColumn, table: null, message };
  }
  if (codes.includes(SQLSTATE.insufficientPrivilege)) {
    return { kind: "permission", code: SQLSTATE.insufficientPrivilege, table: null, message };
  }
  if (
    codes.includes(SQLSTATE.invalidPassword) ||
    codes.includes(SQLSTATE.invalidAuthorization) ||
    says(/password authentication failed|no password supplied/i)
  ) {
    return { kind: "credentials", code, table: null, message };
  }
  if (
    codes.some((candidate) => NETWORK_CODES.has(candidate)) ||
    codes.includes(SQLSTATE.invalidCatalogName) ||
    codes.includes(SQLSTATE.connectionFailure) ||
    codes.includes(SQLSTATE.adminShutdown) ||
    codes.includes(SQLSTATE.crashShutdown) ||
    codes.includes(SQLSTATE.cannotConnectNow) ||
    /^08\d{3}$/.test(codes[0] ?? "") ||
    says(
      /timeout expired|connect timeout|terminating connection|server closed the connection|database system is (starting|shutting down)/i
    )
  ) {
    return { kind: "unreachable", code, table: null, message };
  }

  return { kind: "unknown", code, table: null, message };
}

/**
 * Pull the relation name out of Postgres' `relation "user_presence" does not
 * exist`, searching every message in the chain — the wrapper won't have it.
 * Used to make sure a self-heal only fires for the table it owns.
 */
export function tableIn(messages: readonly string[] | string | null | undefined): string | null {
  const candidates = Array.isArray(messages)
    ? messages
    : typeof messages === "string"
      ? [messages]
      : [];
  for (const candidate of candidates) {
    const match = /relation\s+"([^"]+)"\s+does not exist/i.exec(candidate);
    if (match) return match[1];
  }
  return null;
}


