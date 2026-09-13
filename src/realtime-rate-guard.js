import { FixedWindowRateLimiter } from "./security.js";

export const RAPID_BET_ACTIONS = new Set(["bet", "roulette_bet"]);

/**
 * Separates genuine network floods from legitimate bursts of gameplay input.
 * Traffic limits are hard security limits; action limits are soft and only
 * cause the excess command to be ignored by the caller.
 */
export class RealtimeRateGuard {
  constructor({
    limiter = new FixedWindowRateLimiter(),
    windowMilliseconds = 10_000,
    connectionLimit = 150,
    accountLimit = 180,
    ipLimit = 300,
    stateActionLimit = 30,
    betActionLimit = 80,
  } = {}) {
    this.limiter = limiter;
    this.windowMilliseconds = windowMilliseconds;
    this.connectionLimit = connectionLimit;
    this.accountLimit = accountLimit;
    this.ipLimit = ipLimit;
    this.stateActionLimit = stateActionLimit;
    this.betActionLimit = betActionLimit;
  }

  checkTraffic({ connectionId, addressFingerprint, accountId = null, now = Date.now() }) {
    const checks = [
      ["connection", `connection:${connectionId}`, this.connectionLimit],
      ...(accountId ? [["account", `account:${accountId}`, this.accountLimit]] : []),
      ["network", `ip:${addressFingerprint}`, this.ipLimit],
    ];
    for (const [scope, key, limit] of checks) {
      if (!this.limiter.allow(key, limit, this.windowMilliseconds, now)) return { allowed: false, scope };
    }
    return { allowed: true, scope: null };
  }

  checkAction({ accountId, type, isStateChanging, now = Date.now() }) {
    if (!accountId || !isStateChanging) return { allowed: true, category: null };
    const isRapidBet = RAPID_BET_ACTIONS.has(type);
    const category = isRapidBet ? "bet" : "state";
    const limit = isRapidBet ? this.betActionLimit : this.stateActionLimit;
    const allowed = this.limiter.allow(
      `action:${category}:${accountId}`,
      limit,
      this.windowMilliseconds,
      now,
    );
    return { allowed, category };
  }
}
