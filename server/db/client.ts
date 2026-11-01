import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { loadEnv } from "../config/env";
import * as schema from "./schema";

/**
 * Postgres pool + Drizzle client.
 *
 * - Reads DATABASE_URL from validated env (Secrets on Replit).
 * - Created lazily so `createApp` can boot without a DB in dev/test; callers
 *   that need the DB use `getDb()` and handle the `null` return honestly
 *   (return a 503 to the client, not a fabricated successful response).
 * - Exposes `closeDb()` so tests and graceful shutdown can drain the pool.
 *
 * Do not import this module from the browser bundle; it uses the `pg` driver.
 */

type DrizzleDb = NodePgDatabase<typeof schema>;

interface DbState {
  pool: Pool;
  db: DrizzleDb;
}

let state: DbState | null = null;
let initialized = false;

function init(): DbState | null {
  if (initialized) return state;
  initialized = true;

  const env = loadEnv();
  if (!env.featureFlags.database || !env.raw.DATABASE_URL) {
    // Not configured. Leave `state` null so getDb() callers can 503 honestly.
    return null;
  }

  const pool = new Pool({
    connectionString: env.raw.DATABASE_URL,
    // Conservative defaults; adjust via env later if needed.
    max: env.raw.NODE_ENV === "production" ? 20 : 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "zipy-esim",
  });

  pool.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[db] idle client error", err.message);
  });

  const db = drizzle(pool, { schema });
  state = { pool, db };
  return state;
}

/** Returns the Drizzle client, or null when DATABASE_URL is not configured. */
export function getDb(): DrizzleDb | null {
  return init()?.db ?? null;
}

/** Throws if the DB is not configured. Use in jobs/tests that require it. */
export function requireDb(): DrizzleDb {
  const db = getDb();
  if (!db) {
    throw new Error(
      "Database is not configured (DATABASE_URL missing). Refusing to fabricate results.",
    );
  }
  return db;
}

/** Raw pg pool (for migrations / health probes that need the underlying client). */
export function getPool(): Pool | null {
  return init()?.pool ?? null;
}

/** Close the pool; safe to call even if not initialized. */
export async function closeDb(): Promise<void> {
  if (!state) return;
  const { pool } = state;
  state = null;
  initialized = false;
  await pool.end();
}

/** Simple liveness probe used by /api/health and admin "supplier/db health". */
export async function pingDb(): Promise<{ ok: boolean; error?: string }> {
  const pool = getPool();
  if (!pool) return { ok: false, error: "DATABASE_URL not set" };
  try {
    await pool.query("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export * as dbSchema from "./schema";
