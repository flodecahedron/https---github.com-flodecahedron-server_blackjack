import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('bedealer_schema_migrations'))");
    await client.query("CREATE TABLE IF NOT EXISTS blackjack_schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    const files = (await readdir(migrationsDirectory)).filter(name => name.endsWith(".sql")).sort();
    const { rows } = await client.query("SELECT name FROM blackjack_schema_migrations");
    const applied = new Set(rows.map(row => row.name));
    for (const name of files) {
      if (applied.has(name)) continue;
      const sql = await readFile(join(migrationsDirectory, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO blackjack_schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        console.log(`[store] Applied migration ${name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('bedealer_schema_migrations'))").catch(() => {});
    client.release();
  }
}
