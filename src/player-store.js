import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Pool } from "pg";

export class PlayerStore {
  constructor() {
    this.filePath = process.env.PLAYER_DATA_PATH || join(process.cwd(), "data", "players.json");
    this.pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined }) : null;
    this.localAbuseEvents = [];
  }
  async initialize() {
    if (this.pool) {
      await this.pool.query("CREATE TABLE IF NOT EXISTS blackjack_players (id UUID PRIMARY KEY, username VARCHAR(16) UNIQUE NOT NULL, avatar TEXT NOT NULL DEFAULT '', balance INTEGER NOT NULL, login_streak INTEGER NOT NULL DEFAULT 0, last_login DATE, last_roulette DATE)");
      await this.pool.query("ALTER TABLE blackjack_players ALTER COLUMN balance TYPE INTEGER USING CEIL(balance)::INTEGER");
      await this.pool.query("ALTER TABLE blackjack_players ADD COLUMN IF NOT EXISTS last_roulette DATE");
      await this.pool.query("CREATE TABLE IF NOT EXISTS blackjack_abuse_events (id BIGSERIAL PRIMARY KEY, subject_hash CHAR(64) NOT NULL, action VARCHAR(48) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
      await this.pool.query("CREATE INDEX IF NOT EXISTS blackjack_abuse_events_lookup ON blackjack_abuse_events (subject_hash, action, created_at)");
      await this.pool.query("DELETE FROM blackjack_abuse_events WHERE created_at < NOW() - INTERVAL '8 days'");
      return;
    }
    await mkdir(dirname(this.filePath), { recursive: true });
  }
  async loadAll() {
    if (this.pool) {
      const { rows } = await this.pool.query("SELECT id, username, avatar, balance, login_streak, last_login, last_roulette FROM blackjack_players");
      return rows.map(row => ({ id: row.id, username: row.username, avatar: row.avatar, balance: row.balance, loginStreak: row.login_streak, lastLogin: row.last_login ? row.last_login.toISOString().slice(0, 10) : null, lastRoulette: row.last_roulette ? row.last_roulette.toISOString().slice(0, 10) : null }));
    }
    try { return JSON.parse(await readFile(this.filePath, "utf8")); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  async save(profile, accounts) {
    if (this.pool) {
      await this.pool.query("INSERT INTO blackjack_players (id, username, avatar, balance, login_streak, last_login, last_roulette) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET avatar=EXCLUDED.avatar, balance=EXCLUDED.balance, login_streak=EXCLUDED.login_streak, last_login=EXCLUDED.last_login, last_roulette=EXCLUDED.last_roulette", [profile.id, profile.username, profile.avatar, profile.balance, profile.loginStreak, profile.lastLogin, profile.lastRoulette ?? null]);
      return;
    }
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify([...accounts.values()], null, 2));
    await rename(temporary, this.filePath);
  }

  /**
   * Atomically consumes one persistent quota unit. PostgreSQL advisory locking
   * prevents parallel sockets from passing the limit at the same time.
   */
  async consumeQuota(subjectHash, action, limit, windowMilliseconds) {
    const cutoff = new Date(Date.now() - windowMilliseconds);
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${subjectHash}:${action}`]);
        const { rows } = await client.query(
          "SELECT COUNT(*)::INTEGER AS count FROM blackjack_abuse_events WHERE subject_hash=$1 AND action=$2 AND created_at >= $3",
          [subjectHash, action, cutoff],
        );
        if (rows[0].count >= limit) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query(
          "INSERT INTO blackjack_abuse_events (subject_hash, action) VALUES ($1, $2)",
          [subjectHash, action],
        );
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    const now = Date.now();
    this.localAbuseEvents = this.localAbuseEvents.filter(event => event.createdAt >= cutoff.getTime());
    const count = this.localAbuseEvents.filter(event => event.subjectHash === subjectHash && event.action === action).length;
    if (count >= limit) return false;
    this.localAbuseEvents.push({ subjectHash, action, createdAt: now });
    return true;
  }
}
