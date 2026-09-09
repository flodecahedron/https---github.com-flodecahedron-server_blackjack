import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Pool } from "pg";

export class PlayerStore {
  constructor() {
    this.filePath = process.env.PLAYER_DATA_PATH || join(process.cwd(), "data", "players.json");
    this.pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined }) : null;
  }
  async initialize() {
    if (this.pool) {
      await this.pool.query("CREATE TABLE IF NOT EXISTS blackjack_players (id UUID PRIMARY KEY, username VARCHAR(16) UNIQUE NOT NULL, avatar TEXT NOT NULL DEFAULT '', balance INTEGER NOT NULL, login_streak INTEGER NOT NULL DEFAULT 0, last_login DATE, last_roulette DATE)");
      await this.pool.query("ALTER TABLE blackjack_players ALTER COLUMN balance TYPE INTEGER USING CEIL(balance)::INTEGER");
      await this.pool.query("ALTER TABLE blackjack_players ADD COLUMN IF NOT EXISTS last_roulette DATE");
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
}
