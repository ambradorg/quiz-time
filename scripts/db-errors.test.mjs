#!/usr/bin/env node
/**
 * Tests for the failure taxonomy behind the owner's "who's online" panel:
 *
 *   - src/lib/db-errors.ts           Postgres error → a reason the UI can act on
 *   - src/lib/presence-schema-sql.ts the DDL the app is allowed to run itself
 *   - src/lib/use-presence.ts        reason → the panel's error state
 *
 * No database, no network, no server: all three are pure (the schema *runner*
 * is not, and is covered by the E2E suite instead). What the cases encode is
 * the bug this file exists for — the panel used to answer every server-side
 * failure with "usually the database: check DATABASE_URL and that the presence
 * migration has been applied", which is wrong for an unreachable database, for
 * a rejected password and for a missing AUTH_SECRET, and useless to the owner
 * when the real problem was one idempotent CREATE TABLE.
 *
 * Usage:
 *   npm run test:db-errors
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { classifyDbError, tableIn } = await import("../src/lib/db-errors.ts");
const { PRESENCE_SCHEMA_STATEMENTS } = await import("../src/lib/presence-schema-sql.ts");
const { presenceErrorForReason } = await import("../src/lib/use-presence.ts");

/** A `pg` error, the way node-postgres throws it. */
const pgError = (message, code, extra = {}) =>
  Object.assign(new Error(message), { severity: "ERROR", code, ...extra });

/**
 * …wrapped by Drizzle, which is what the route actually catches: its own
 * "Failed query: <sql>" error carrying the `pg` error on `.cause`. Half the
 * cases below are about not being fooled by that wrapper.
 */
const wrapped = (inner, sql = 'select 1 from "user_presence"') =>
  Object.assign(new Error(`Failed query: ${sql}`), { query: sql, params: [], cause: inner });

// ── classifyDbError ──────────────────────────────────────────────────────────
describe("classifyDbError", () => {
  test("a missing user_presence table is recognised through Drizzle's wrapper", () => {
    // The exact shape from the log line this fix started with.
    const failure = classifyDbError(
      wrapped(pgError('relation "user_presence" does not exist', "42P01"))
    );
    assert.equal(failure.kind, "missing_table");
    assert.equal(failure.code, "42P01");
    // Naming the table is what lets the route repair it and nothing else.
    assert.equal(failure.table, "user_presence");
  });

  test("a missing table that isn't ours is named, so it is not 'repaired'", () => {
    const failure = classifyDbError(pgError('relation "users" does not exist', "42P01"));
    assert.equal(failure.kind, "missing_table");
    assert.equal(failure.table, "users");
  });

  test("a missing column is a schema problem with no table to create", () => {
    const failure = classifyDbError(pgError("column user_presence.device does not exist", "42703"));
    assert.equal(failure.kind, "missing_table");
    assert.equal(failure.table, null, "creating the table would not add the column");
  });

  test("a refused CREATE is a permission problem, not a missing table", () => {
    assert.equal(classifyDbError(pgError("permission denied for schema public", "42501")).kind, "permission");
  });

  test("rejected credentials are named, with and without a SQLSTATE", () => {
    assert.equal(
      classifyDbError(pgError('password authentication failed for user "quiz"', "28P01")).kind,
      "credentials"
    );
    // No code at all — only the message, which is what some drivers give.
    assert.equal(classifyDbError(new Error("no password supplied")).kind, "credentials");
  });

  test("a database that cannot be reached is 'unreachable', not a schema problem", () => {
    assert.equal(
      classifyDbError(
        wrapped(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }))
      ).kind,
      "unreachable"
    );
    // The database named in DATABASE_URL doesn't exist.
    assert.equal(
      classifyDbError(pgError('database "quiztime" does not exist', "3D000")).kind,
      "unreachable"
    );
    // Pool timeout — message only, no code.
    assert.equal(classifyDbError(new Error("timeout expired when trying to connect")).kind, "unreachable");
    // Postgres shutting down under us.
    assert.equal(
      classifyDbError(pgError("terminating connection due to administrator command", "57P01")).kind,
      "unreachable"
    );
  });

  test("anything else is 'unknown' rather than a confident guess", () => {
    assert.equal(classifyDbError(pgError("division by zero", "22012")).kind, "unknown");
    assert.equal(classifyDbError(new Error("something odd")).kind, "unknown");
  });

  test("it never throws, however broken the input is", () => {
    for (const value of [null, undefined, 0, "", "just a string", {}, [], Symbol("x")]) {
      assert.equal(classifyDbError(value).kind, "unknown");
    }
    // A cyclic cause chain must terminate rather than hang the request.
    const a = new Error("a");
    const b = Object.assign(new Error("b"), { cause: a });
    a.cause = b;
    assert.equal(classifyDbError(a).kind, "unknown");
  });

  test("the reported message is the specific one, not Drizzle's SQL dump", () => {
    const failure = classifyDbError(wrapped(pgError('relation "user_presence" does not exist', "42P01")));
    assert.equal(failure.message, 'relation "user_presence" does not exist');
  });
});

describe("tableIn", () => {
  test("finds the relation named anywhere in the chain's messages", () => {
    assert.equal(
      tableIn(["Failed query: select 1", 'ERROR: relation "user_presence" does not exist']),
      "user_presence"
    );
    assert.equal(tableIn('relation "users" does not exist'), "users");
    assert.equal(tableIn(["nothing useful here"]), null);
    assert.equal(tableIn(null), null);
    assert.equal(tableIn(undefined), null);
  });
});

// ── the DDL the app may run itself ───────────────────────────────────────────
describe("PRESENCE_SCHEMA_STATEMENTS", () => {
  /** Collapse whitespace so formatting differences don't fail the comparison. */
  const normalise = (sql) => sql.replace(/\s+/g, " ").trim();

  /** drizzle/0005_presence.sql as statements: comments and breakpoints removed. */
  const migrationStatements = () =>
    readFileSync(join(root, "drizzle", "0005_presence.sql"), "utf8")
      .split("--> statement-breakpoint")
      .map((chunk) =>
        chunk
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("--"))
          .join("\n")
          .trim()
          .replace(/;\s*$/, "")
      )
      .filter((chunk) => chunk.length > 0)
      .map(normalise);

  test("every statement is identical to the committed migration", () => {
    // A hand-pasted migration and a self-healed one must produce the same
    // table, or the roster would behave differently per database.
    assert.deepEqual(
      PRESENCE_SCHEMA_STATEMENTS.map(normalise),
      migrationStatements(),
      "src/lib/presence-schema-sql.ts has drifted from drizzle/0005_presence.sql"
    );
  });

  test("every statement is safe to re-run", () => {
    // This is the whole licence for running DDL from a request path: on a
    // database that already has the table, each statement must be a no-op.
    for (const statement of PRESENCE_SCHEMA_STATEMENTS) {
      assert.ok(
        /IF NOT EXISTS/i.test(statement) || /duplicate_object/i.test(statement),
        `not idempotent: ${statement.slice(0, 60)}…`
      );
    }
  });

  test("it only ever creates its own table", () => {
    const allowedTargets = new Set(["user_presence", "user_presence_last_seen_idx"]);
    const targetPattern = /(?:CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX)(?:\s+IF\s+NOT\s+EXISTS)?\s+"([^"]+)"/gi;
    const referencePattern = /REFERENCES\s+"([^"]+)"\."([^"]+)"/gi;

    for (const statement of PRESENCE_SCHEMA_STATEMENTS) {
      // Nothing destructive — with one legitimate exception: the FK's own
      // "ON DELETE cascade ON UPDATE cascade" referential actions.
      const withoutFkActions = statement.replace(
        /ON (?:DELETE|UPDATE) (?:cascade|no action|set null|set default|restrict)/gi,
        ""
      );
      assert.doesNotMatch(withoutFkActions, /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/i);
      assert.match(statement.trim(), /^(CREATE|ALTER|DO)\b/i);

      // Every relation this DDL creates or alters must be ours.
      const targets = [...statement.matchAll(targetPattern)].map((match) => match[1]);
      assert.ok(targets.length > 0, `no relation in statement: ${statement.slice(0, 60)}…`);
      for (const target of targets) {
        assert.ok(allowedTargets.has(target), `self-heal DDL touches "${target}"`);
      }

      // The only other table mentioned is the FK's target, which we just read.
      for (const match of statement.matchAll(referencePattern)) {
        assert.equal(match[2], "users");
      }
    }
  });
});

// ── reason → what the panel says ─────────────────────────────────────────────
describe("presenceErrorForReason", () => {
  test("every reason the server can send has its own answer", () => {
    assert.equal(presenceErrorForReason("missing_table"), "missing_table");
    assert.equal(presenceErrorForReason("permission"), "permission");
    assert.equal(presenceErrorForReason("auth"), "auth");
    // Both "can't reach the database" flavours read the same to the owner.
    assert.equal(presenceErrorForReason("unreachable"), "database");
    assert.equal(presenceErrorForReason("credentials"), "database");
    assert.equal(presenceErrorForReason("unknown"), "server");
  });

  test("an unrecognised reason degrades to a vague error, never to a wrong diagnosis", () => {
    assert.equal(presenceErrorForReason("something_new"), "server");
    assert.equal(presenceErrorForReason(undefined), "server");
    assert.equal(presenceErrorForReason(null), "server");
    assert.equal(presenceErrorForReason(42), "server");
  });

  test("a server failure is never reported as the owner being signed out", () => {
    // "forbidden" hides the panel entirely — a database problem must not.
    for (const reason of [
      "missing_table",
      "permission",
      "auth",
      "unreachable",
      "credentials",
      "unknown",
      "nope",
    ]) {
      assert.notEqual(presenceErrorForReason(reason), "forbidden");
    }
  });
});
