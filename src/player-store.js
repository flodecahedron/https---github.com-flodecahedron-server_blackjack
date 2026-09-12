import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "./migrations.js";

const SAFETY_GRANT_AMOUNT = 100;
const REWARDED_GRANT_DAILY_LIMIT = Number.parseInt(process.env.REWARDED_GRANT_DAILY_LIMIT ?? "3", 10);
const REWARDED_GRANT_COOLDOWN_MS = Number.parseInt(process.env.REWARDED_GRANT_COOLDOWN_MS ?? "0", 10);
const ALLOW_SIMULATED_REWARDED_GRANT = String(process.env.ALLOW_SIMULATED_REWARDED_GRANT ?? "true").toLowerCase() === "true";
const utcDay = date => date.toISOString().slice(0, 10);
const dateColumn = value => value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null;

export class PlayerStore {
  constructor() {
    this.filePath = process.env.PLAYER_DATA_PATH || join(process.cwd(), "data", "players.json");
    this.authFilePath = process.env.AUTH_DATA_PATH || join(process.cwd(), "data", "auth.json");
    this.pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined }) : null;
    this.localAbuseEvents = [];
    this.localAuthAccounts = new Map();
  }
  async initialize() {
    if (this.pool) {
      await runMigrations(this.pool);
      await this.pool.query("DELETE FROM blackjack_abuse_events WHERE created_at < NOW() - INTERVAL '8 days'");
      return;
    }
    await mkdir(dirname(this.filePath), { recursive: true });
  }
  async loadAll() {
    if (this.pool) {
      const { rows } = await this.pool.query("SELECT id, username, avatar, balance, login_streak, last_login, last_roulette, last_safety_grant, rewarded_grant_date, rewarded_grant_count, last_rewarded_grant_at FROM blackjack_players");
      return rows.map(row => ({ id: row.id, username: row.username, avatar: row.avatar, balance: row.balance, loginStreak: row.login_streak, lastLogin: dateColumn(row.last_login), lastRoulette: dateColumn(row.last_roulette), lastSafetyGrant: dateColumn(row.last_safety_grant), rewardedGrantDate: dateColumn(row.rewarded_grant_date), rewardedGrantCount: row.rewarded_grant_count ?? 0, lastRewardedGrantAt: row.last_rewarded_grant_at?.toISOString() ?? null }));
    }
    try { return JSON.parse(await readFile(this.filePath, "utf8")); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  async save(profile, accounts) {
    if (this.pool) {
      await this.pool.query("INSERT INTO blackjack_players (id, username, avatar, balance, login_streak, last_login, last_roulette, last_safety_grant, rewarded_grant_date, rewarded_grant_count, last_rewarded_grant_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO UPDATE SET avatar=EXCLUDED.avatar, balance=EXCLUDED.balance, login_streak=EXCLUDED.login_streak, last_login=EXCLUDED.last_login, last_roulette=EXCLUDED.last_roulette, last_safety_grant=EXCLUDED.last_safety_grant, rewarded_grant_date=EXCLUDED.rewarded_grant_date, rewarded_grant_count=EXCLUDED.rewarded_grant_count, last_rewarded_grant_at=EXCLUDED.last_rewarded_grant_at", [profile.id, profile.username, profile.avatar, profile.balance, profile.loginStreak, profile.lastLogin, profile.lastRoulette ?? null, profile.lastSafetyGrant ?? null, profile.rewardedGrantDate ?? null, profile.rewardedGrantCount ?? 0, profile.lastRewardedGrantAt ?? null]);
      return;
    }
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify([...accounts.values()], null, 2));
    await rename(temporary, this.filePath);
  }

  async applyEconomyEvents(events, accounts) {
    if (!events.length) return;
    if (!this.pool) {
      const firstProfile = accounts.get(events[0].playerId);
      if (firstProfile) await this.save(firstProfile, accounts);
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const event of events) {
        const inserted = await client.query(
          "INSERT INTO blackjack_chip_ledger (id, player_id, delta, reason, room_code, round_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING RETURNING id",
          [event.id, event.playerId, event.delta, event.reason, event.roomCode ?? null, event.roundId ?? null],
        );
        if (!inserted.rowCount) continue;
        const updated = await client.query(
          "UPDATE blackjack_players SET balance=balance+$2 WHERE id=$1 AND balance+$2>=0 RETURNING balance",
          [event.playerId, event.delta],
        );
        if (!updated.rowCount) throw Error(`Economy event ${event.id} could not be applied`);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async applyProfileEconomy(profile, accounts, { delta, reason, eventId }) {
    if (!Number.isInteger(delta)) throw Error("Profile economy delta must be an integer");
    if (!this.pool) {
      await this.save(profile, accounts);
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (delta !== 0) {
        const inserted = await client.query(
          "INSERT INTO blackjack_chip_ledger (id, player_id, delta, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id",
          [eventId, profile.id, delta, reason],
        );
        if (inserted.rowCount) {
          const updated = await client.query("UPDATE blackjack_players SET balance=balance+$2 WHERE id=$1 AND balance+$2>=0 RETURNING balance", [profile.id, delta]);
          if (!updated.rowCount) throw Error(`Profile economy event ${eventId} could not be applied`);
        }
      }
      await client.query(
        "UPDATE blackjack_players SET avatar=$2, login_streak=$3, last_login=$4, last_roulette=$5 WHERE id=$1",
        [profile.id, profile.avatar, profile.loginStreak, profile.lastLogin, profile.lastRoulette ?? null],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  safetyGrantStatus(profile, now = new Date()) {
    const day = utcDay(now);
    const freeAvailable = profile.lastSafetyGrant !== day;
    const rewardedCount = profile.rewardedGrantDate === day ? Number(profile.rewardedGrantCount ?? 0) : 0;
    const lastRewardedAt = profile.lastRewardedGrantAt ? new Date(profile.lastRewardedGrantAt).getTime() : 0;
    const cooldownSeconds = Math.max(0, Math.ceil((lastRewardedAt + REWARDED_GRANT_COOLDOWN_MS - now.getTime()) / 1000));
    return {
      amount: SAFETY_GRANT_AMOUNT,
      needed: profile.balance <= 0,
      freeAvailable,
      rewardedAvailable: !freeAvailable && ALLOW_SIMULATED_REWARDED_GRANT && rewardedCount < REWARDED_GRANT_DAILY_LIMIT && cooldownSeconds === 0,
      simulatedRewarded: ALLOW_SIMULATED_REWARDED_GRANT,
      rewardedCount,
      rewardedDailyLimit: REWARDED_GRANT_DAILY_LIMIT,
      cooldownSeconds,
      balance: profile.balance,
    };
  }

  async claimSafetyGrant(profile, accounts, { rewarded = false, now = new Date() } = {}) {
    if (!this.pool) return this.claimLocalSafetyGrant(profile, accounts, { rewarded, now });
    const day = utcDay(now);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT balance, last_safety_grant, rewarded_grant_date, rewarded_grant_count, last_rewarded_grant_at FROM blackjack_players WHERE id=$1 FOR UPDATE", [profile.id]);
      if (!rows.length) throw Error("Player account not found");
      const row = rows[0];
      profile.balance = row.balance;
      profile.lastSafetyGrant = dateColumn(row.last_safety_grant);
      profile.rewardedGrantDate = dateColumn(row.rewarded_grant_date);
      profile.rewardedGrantCount = row.rewarded_grant_count ?? 0;
      profile.lastRewardedGrantAt = row.last_rewarded_grant_at?.toISOString() ?? null;
      if (profile.balance > 0) {
        await client.query("ROLLBACK");
        return { granted: false, reason: "not_needed", ...this.safetyGrantStatus(profile, now) };
      }
      const free = profile.lastSafetyGrant !== day;
      if (!free && !rewarded) {
        await client.query("ROLLBACK");
        return { granted: false, reason: "rewarded_required", ...this.safetyGrantStatus(profile, now) };
      }
      const rewardedCount = profile.rewardedGrantDate === day ? profile.rewardedGrantCount : 0;
      const lastRewardedAt = profile.lastRewardedGrantAt ? new Date(profile.lastRewardedGrantAt).getTime() : 0;
      if (!free && (!ALLOW_SIMULATED_REWARDED_GRANT || rewardedCount >= REWARDED_GRANT_DAILY_LIMIT || now.getTime() < lastRewardedAt + REWARDED_GRANT_COOLDOWN_MS)) {
        await client.query("ROLLBACK");
        return { granted: false, reason: "rewarded_unavailable", ...this.safetyGrantStatus(profile, now) };
      }
      const kind = free ? "free" : "rewarded_simulated";
      const nextRewardedCount = free ? rewardedCount : rewardedCount + 1;
      const eventId = free ? `safety:${profile.id}:${day}` : `safety:${profile.id}:${day}:rewarded:${nextRewardedCount}`;
      await client.query("INSERT INTO blackjack_chip_ledger (id, player_id, delta, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING", [eventId, profile.id, SAFETY_GRANT_AMOUNT, `safety_grant_${kind}`]);
      const { rows: updatedRows } = await client.query(
        free
          ? "UPDATE blackjack_players SET balance=balance+$2, last_safety_grant=$3 WHERE id=$1 RETURNING balance, last_safety_grant, rewarded_grant_date, rewarded_grant_count, last_rewarded_grant_at"
          : "UPDATE blackjack_players SET balance=balance+$2, rewarded_grant_date=$3, rewarded_grant_count=$4, last_rewarded_grant_at=$5 WHERE id=$1 RETURNING balance, last_safety_grant, rewarded_grant_date, rewarded_grant_count, last_rewarded_grant_at",
        free ? [profile.id, SAFETY_GRANT_AMOUNT, day] : [profile.id, SAFETY_GRANT_AMOUNT, day, nextRewardedCount, now],
      );
      await client.query("COMMIT");
      const updated = updatedRows[0];
      profile.balance = updated.balance;
      profile.lastSafetyGrant = dateColumn(updated.last_safety_grant);
      profile.rewardedGrantDate = dateColumn(updated.rewarded_grant_date);
      profile.rewardedGrantCount = updated.rewarded_grant_count ?? 0;
      profile.lastRewardedGrantAt = updated.last_rewarded_grant_at?.toISOString() ?? null;
      return { granted: true, kind, ...this.safetyGrantStatus(profile, now) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimLocalSafetyGrant(profile, accounts, { rewarded, now }) {
    const status = this.safetyGrantStatus(profile, now);
    if (!status.needed) return { granted: false, reason: "not_needed", ...status };
    if (!status.freeAvailable && (!rewarded || !status.rewardedAvailable)) return { granted: false, reason: rewarded ? "rewarded_unavailable" : "rewarded_required", ...status };
    const day = utcDay(now);
    const kind = status.freeAvailable ? "free" : "rewarded_simulated";
    profile.balance += SAFETY_GRANT_AMOUNT;
    if (status.freeAvailable) profile.lastSafetyGrant = day;
    else {
      profile.rewardedGrantDate = day;
      profile.rewardedGrantCount = status.rewardedCount + 1;
      profile.lastRewardedGrantAt = now.toISOString();
    }
    await this.save(profile, accounts);
    return { granted: true, kind, ...this.safetyGrantStatus(profile, now) };
  }

  async loadAuthAccounts() {
    if (this.pool) {
      const { rows } = await this.pool.query("SELECT player_id, google_sub, session_token_hash, session_expires_at, session_last_used_at, session_revoked_at, previous_session_token_hash, previous_session_expires_at FROM blackjack_auth_accounts");
      return rows.map(row => ({
        playerId: row.player_id,
        googleSub: row.google_sub,
        sessionTokenHash: row.session_token_hash,
        sessionExpiresAt: row.session_expires_at?.toISOString() ?? null,
        sessionLastUsedAt: row.session_last_used_at?.toISOString() ?? null,
        sessionRevokedAt: row.session_revoked_at?.toISOString() ?? null,
        previousSessionTokenHash: row.previous_session_token_hash,
        previousSessionExpiresAt: row.previous_session_expires_at?.toISOString() ?? null,
      }));
    }
    try {
      const records = JSON.parse(await readFile(this.authFilePath, "utf8"));
      const defaultExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
      const normalizedRecords = records.map(record => ({
        playerId: record.playerId,
        googleSub: record.googleSub ?? null,
        sessionTokenHash: record.sessionTokenHash,
        sessionExpiresAt: record.sessionExpiresAt ?? defaultExpiry,
        sessionLastUsedAt: record.sessionLastUsedAt ?? new Date().toISOString(),
        sessionRevokedAt: record.sessionRevokedAt ?? null,
        previousSessionTokenHash: record.previousSessionTokenHash ?? null,
        previousSessionExpiresAt: record.previousSessionExpiresAt ?? null,
      }));
      this.localAuthAccounts = new Map(normalizedRecords.map(record => [record.playerId, record]));
      if (records.some(record => "email" in record || !record.sessionExpiresAt)) await this.writeLocalAuthAccounts();
      return normalizedRecords;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async saveAuthAccount(record) {
    if (this.pool) {
      await this.pool.query(
        "INSERT INTO blackjack_auth_accounts (player_id, google_sub, session_token_hash, session_expires_at, session_last_used_at, session_revoked_at, previous_session_token_hash, previous_session_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (player_id) DO UPDATE SET google_sub=EXCLUDED.google_sub, session_token_hash=EXCLUDED.session_token_hash, session_expires_at=EXCLUDED.session_expires_at, session_last_used_at=EXCLUDED.session_last_used_at, session_revoked_at=EXCLUDED.session_revoked_at, previous_session_token_hash=EXCLUDED.previous_session_token_hash, previous_session_expires_at=EXCLUDED.previous_session_expires_at, updated_at=NOW()",
        [record.playerId, record.googleSub ?? null, record.sessionTokenHash, record.sessionExpiresAt, record.sessionLastUsedAt, record.sessionRevokedAt ?? null, record.previousSessionTokenHash ?? null, record.previousSessionExpiresAt ?? null],
      );
      return;
    }
    this.localAuthAccounts.set(record.playerId, record);
    await this.writeLocalAuthAccounts();
  }

  async revokeAuthSession(playerId) {
    if (this.pool) {
      await this.pool.query(
        "UPDATE blackjack_auth_accounts SET session_revoked_at=NOW(), previous_session_token_hash=NULL, previous_session_expires_at=NULL, updated_at=NOW() WHERE player_id=$1",
        [playerId],
      );
      return;
    }
    const record = this.localAuthAccounts.get(playerId);
    if (!record) return;
    record.sessionRevokedAt = new Date().toISOString();
    record.previousSessionTokenHash = null;
    record.previousSessionExpiresAt = null;
    await this.writeLocalAuthAccounts();
  }

  async deletePlayer(playerId, accounts) {
    if (this.pool) {
      await this.pool.query("DELETE FROM blackjack_players WHERE id=$1", [playerId]);
      accounts.delete(playerId);
      return;
    }
    accounts.delete(playerId);
    this.localAuthAccounts.delete(playerId);
    const temporaryPlayers = `${this.filePath}.tmp`;
    await writeFile(temporaryPlayers, JSON.stringify([...accounts.values()], null, 2));
    await rename(temporaryPlayers, this.filePath);
    await this.writeLocalAuthAccounts();
  }

  async writeLocalAuthAccounts() {
    const temporary = `${this.authFilePath}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.localAuthAccounts.values()], null, 2));
    await rename(temporary, this.authFilePath);
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
