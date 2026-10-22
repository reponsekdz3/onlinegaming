import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations.");

const migrationDirectory = resolve(process.cwd(), "../../db/migrations");
const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 5_000,
  ...(process.env.PGSSL === "true" ? { ssl: { rejectUnauthorized: true } } : {})
});

async function migrate(): Promise<void> {
  const client = await pool.connect();
  let lockHeld = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('onlinegaming_schema_migrations'))");
    lockHeld = true;
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (" +
      "version text PRIMARY KEY, sha256 char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"
    );

    const names = (await readdir(migrationDirectory))
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name))
      .sort();

    for (const name of names) {
      const source = await readFile(resolve(migrationDirectory, name), "utf8");
      const checksum = createHash("sha256").update(source).digest("hex");
      const applied = await client.query<{ sha256: string }>(
        "SELECT sha256 FROM schema_migrations WHERE version = $1",
        [name]
      );
      if (applied.rowCount) {
        if (applied.rows[0]?.sha256 !== checksum) throw new Error("Applied migration checksum changed: " + name);
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(source);
        await client.query("INSERT INTO schema_migrations (version, sha256) VALUES ($1, $2)", [name, checksum]);
        await client.query("COMMIT");
        console.info("Applied migration:", name);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
  } finally {
    if (lockHeld) {
      await client.query("SELECT pg_advisory_unlock(hashtext('onlinegaming_schema_migrations'))").catch(() => undefined);
    }
    client.release();
    await pool.end();
  }
}

migrate().catch((error: unknown) => {
  console.error("Database migration failed:", error);
  process.exitCode = 1;
});
