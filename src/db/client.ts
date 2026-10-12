import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { config, resolveFromRoot } from "../config.js";
import { log } from "../log.js";
import * as schema from "./schema.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DbHandle = {
  db: Db;
  /** "postgres" for a real server, "pglite" for the embedded dev/test database. */
  driver: "postgres" | "pglite";
  close: () => Promise<void>;
};

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Opens Postgres when DATABASE_URL is set, otherwise an embedded PGlite database
 * (same SQL dialect, pgvector included) so local runs and tests need no Docker.
 */
export async function openDb(opts: { url?: string; pgliteDir?: string | "memory" } = {}): Promise<DbHandle> {
  const url = opts.url ?? (opts.pgliteDir ? undefined : config.DATABASE_URL);
  if (url) {
    const { default: pg } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 });
    // Neon suspends idle compute and drops its connections; without a listener an
    // error on an idle pooled client would crash the process. The pool reconnects on demand.
    pool.on("error", (err) => log.warn("idle database connection dropped", { error: err.message }));
    const db = drizzle(pool, { schema }) as unknown as Db;
    return { db, driver: "postgres", close: () => pool.end() };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const { drizzle } = await import("drizzle-orm/pglite");
  const dir = opts.pgliteDir ?? config.PGLITE_DIR;
  let dataDir: string | undefined;
  if (dir !== "memory") {
    dataDir = resolveFromRoot(dir);
    mkdirSync(dataDir, { recursive: true });
  }
  const client = new PGlite({ dataDir, extensions: { vector } });
  await client.waitReady;
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, driver: "pglite", close: () => client.close() };
}

/** Applies every .sql file in migrations/ once, in filename order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  // node-postgres and PGlite both return `{ rows }` from execute(); the shared base type hides it.
  const done = (await db.execute(sql`SELECT name FROM _migrations`)) as unknown as { rows: { name: string }[] };
  const applied = new Set(done.rows.map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const statements = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean);
    await db.transaction(async (tx) => {
      for (const statement of statements) await tx.execute(sql.raw(statement));
      await tx.execute(sql`INSERT INTO _migrations (name) VALUES (${file})`);
    });
    ran.push(file);
    log.info("migration applied", { file });
  }
  return ran;
}

export async function openMigratedDb(opts: Parameters<typeof openDb>[0] = {}): Promise<DbHandle> {
  const handle = await openDb(opts);
  await migrate(handle.db);
  return handle;
}
