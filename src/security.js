import crypto from "node:crypto";

const cleanAddress = value => {
  const address = String(value ?? "unknown").trim();
  return address.startsWith("::ffff:") ? address.slice(7) : address;
};

export const getClientAddress = request => {
  const forwarded = request.headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : String(forwarded ?? "").split(",")[0];
  return cleanAddress(firstForwarded || request.socket.remoteAddress);
};

export const fingerprintAddress = (address, secret) => crypto
  .createHmac("sha256", secret)
  .update(cleanAddress(address))
  .digest("hex");

export const readIntegerSetting = (name, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

/**
 * Lightweight in-memory protection for high-frequency traffic. Persistent
 * account/reward limits live in PlayerStore so that restarts cannot reset them.
 */
export class FixedWindowRateLimiter {
  constructor(maximumTrackedKeys = 10_000) {
    this.maximumTrackedKeys = maximumTrackedKeys;
    this.windows = new Map();
  }

  allow(key, limit, windowMilliseconds, now = Date.now()) {
    const current = this.windows.get(key);
    if (!current || current.expiresAt <= now) {
      this.windows.set(key, { count: 1, expiresAt: now + windowMilliseconds });
      this.prune(now);
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }

  prune(now = Date.now()) {
    if (this.windows.size <= this.maximumTrackedKeys) return;
    for (const [key, window] of this.windows) {
      if (window.expiresAt <= now) this.windows.delete(key);
    }
    while (this.windows.size > this.maximumTrackedKeys) {
      this.windows.delete(this.windows.keys().next().value);
    }
  }
}
