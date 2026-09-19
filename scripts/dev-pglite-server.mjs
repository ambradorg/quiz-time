/**
 * Dev-only: an embedded Postgres (PGlite) exposed over the PG wire protocol,
 * so the app can run end-to-end in sandboxes without a Postgres install.
 *
 * Usage: node scripts/dev-pglite-server.mjs [port]   (default 5433)
 * Then point DATABASE_URL at postgresql://postgres@127.0.0.1:5433/postgres
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = parseInt(process.argv[2] ?? "5433", 10);
const db = new PGlite();
// Several app queries run concurrently (Promise.all) — allow the pool to
// open more than one wire connection.
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 10 });

await server.start();
console.log(`PGlite wire server listening on ${server.getServerConn()}`);
