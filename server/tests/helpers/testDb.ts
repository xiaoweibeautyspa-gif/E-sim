/**
 * Test database helper for the end-to-end flow.
 *
 * Goals
 * -----
 *   - Provide a deterministic, isolated schema per test file so parallel
 *     `node --test` workers can't stomp on each other.
 *   - Never require any network/secrets/credentials beyond DATABASE_URL, and
 *     never invent a working DB when one isn't configured (callers get an
 *     explicit skip reason, not a fabricated pass).
 *   - Apply the REAL migrations from server/db/migrations so the end-to-end
 *     test measures actual production SQL, not a mock.
 *   - Tear down cleanly, including after a failing test.
 *
 * What this helper does NOT do
 * ----------------------------
 *   - It does not seed fixture data. Each test file plants its own rows so
 *     the tests stay readable and independent.
 *   - It does not manage application-level env (Stripe keys etc.). Those
 *     live in the individual tests via the injection seams the services
 *     already expose (see refund.test.ts / topup.test.ts).
 *
 * Usage
 * -----
 *   import { createTestDb, skipIfNoDatabase } from "./helpers/testDb";
 *
 *   const skip = skipIfNoDatabase();           // returns null or a reason
 *   test("...", { skip }, async (t) => {
 *     const ctx = await createTestDb();
 *     t.after(() => ctx.drop());
 *     // ctx.pool, ctx.db, ctx.schemaName
 *   });
 *
 * The dedicated schema for this run makes the helper safe to run against a
 * shared Postgres in CI or a developer's local database. `DROP SCHEMA … CASCADE`
 * only ever touches what we created.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

/** Environment-based skip sentinel. Returns `null` when a DB is configured. */
export function skipIfNoDatabase(): string | null {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === "") {
    return "DATABASE_URL not set — skipping end-to-end DB test";
  }
  return null;
}

export interface TestDbContext {
  /** Underlying node-postgres pool. */
  pool: pg.Pool;
  /** Dedicated schema name for this test file, safe to drop. */
  schemaName: string;
  /** Ordered list of migration files applied. Useful for logging. */
  appliedMigrations: string[];
  /** Drop the schema (and everything in it) and end the pool. */
  drop: () => Promise<void>;
}

/**
 * Create an isolated schema, apply every `.sql` migration in numeric order,
 * and return a pool scoped to that schema.
 *
 * Migration filenames must sort lexicographically in the order they were
 * authored (`0001_…`, `0002_…`, …). That is the convention this project
 * already follows (see server/db/migrations/*.sql).
 *
 * IMPORTANT: this helper runs migration DDL VERBATIM. It does not attempt to
 * rewrite `CREATE TABLE foo` into `CREATE TABLE <schema>.foo`, because the
 * migrations already rely on `search_path`. Instead, we set the connection's
 * `search_path` to the isolated schema, and let `CREATE TABLE foo` resolve
 * there. That's the same trick `pg` users commonly use for parallel tests.
 */
export async function createTestDb(): Promise<TestDbContext> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "createTestDb() called without DATABASE_URL — use skipIfNoDatabase() to guard.",
    );
  }

  // Unique schema name per test file & process: `t_<pid>_<rand>`.
  const rand = Math.random().toString(36).slice(2, 10);
  const schemaName = `t_${process.pid}_${rand}`;

  const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    // Create the schema and configure search_path so subsequent DDL lives there.
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  } catch (e) {
    await adminPool.end().catch(() => {});
    throw e;
  }
  await adminPool.end().catch(() => {});

  // Pool used for migrations and tests. `options=-csearch_path=<schema>` makes
  // every connection start there without needing a SET.
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    options: `-csearch_path=${schemaName},public`,
  });

  const applied: string[] = [];
  try {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      // Extensions (pgcrypto, citext, …) must be installed in a stable schema so
      // migrations that reference `gen_random_uuid()` work regardless of the
      // per-test search_path. `CREATE EXTENSION IF NOT EXISTS` is idempotent.
      await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      await pool.query(sql);
      applied.push(file);
    }
  } catch (e) {
    // Drop the half-applied schema so the leaked name doesn't accumulate.
    await dropSchema(pool, schemaName).catch(() => {});
    await pool.end().catch(() => {});
    throw e;
  }

  return {
    pool,
    schemaName,
    appliedMigrations: applied,
    async drop() {
      await dropSchema(pool, schemaName);
      await pool.end();
    },
  };
}

async function dropSchema(pool: pg.Pool, schemaName: string): Promise<void> {
  // Guard against accidentally dropping the public schema if a caller
  // mistypes the helper's return value upstream.
  if (!schemaName.startsWith("t_")) {
    throw new Error(`refusing to drop schema "${schemaName}" (not a test schema)`);
  }
  await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
}

/**
 * Truncate every user table except migrations-related system tables.
 * Callers use this between tests that share one fixture schema.
 *
 * Returns the list of tables it truncated so callers can log what ran. The
 * list is derived from `information_schema.columns` (portable) rather than
 * pg_class catalog poking, so it works across Postgres hosts.
 */
export async function truncateAllTables(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_type = 'BASE TABLE'
         AND table_name NOT LIKE '%.%'
         AND table_name NOT LIKE '__drizzle%'`,
  );
  const names = rows.map((r) => r.table_name).filter((n) => n.length > 0);
  if (names.length === 0) return [];
  // Two-pass truncate (CASCADE) restarts identities in one statement.
  const identList = names.map((n) => `"${n.replace(/"/g, '""')}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${identList} RESTART IDENTITY CASCADE`);
  return names;
}
