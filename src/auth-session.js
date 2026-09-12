import crypto from "node:crypto";
import { readIntegerSetting } from "./security.js";

const defaultSessionTtlMilliseconds = readIntegerSetting("SESSION_TTL_DAYS", 90, 1, 365) * 24 * 60 * 60 * 1000;
const defaultRotationGraceMilliseconds = readIntegerSetting("SESSION_ROTATION_GRACE_MINUTES", 5, 1, 60) * 60 * 1000;

export const sessionTokenHash = token => crypto.createHash("sha256").update(token).digest("hex");
export const newSessionToken = () => crypto.randomBytes(32).toString("base64url");

const tokenMatches = (token, expectedHash) => {
  if (!token || !expectedHash) return false;
  const actual = Buffer.from(sessionTokenHash(String(token)), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

export const sessionCredentialHash = (record, token, now = new Date()) => {
  if (!record || record.sessionRevokedAt) return null;
  const nowMilliseconds = now.getTime();
  const expiresAt = new Date(record.sessionExpiresAt ?? 0).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMilliseconds) return null;
  if (tokenMatches(token, record.sessionTokenHash)) return record.sessionTokenHash;
  const previousExpiresAt = new Date(record.previousSessionExpiresAt ?? 0).getTime();
  if (previousExpiresAt > nowMilliseconds && tokenMatches(token, record.previousSessionTokenHash)) return record.previousSessionTokenHash;
  return null;
};

export const rotatedAuthRecord = ({
  playerId,
  googleSub,
  presentedHash = null,
  issuedToken,
  now = new Date(),
  ttlMilliseconds = defaultSessionTtlMilliseconds,
  graceMilliseconds = defaultRotationGraceMilliseconds,
}) => ({
  playerId,
  googleSub: googleSub ?? null,
  sessionTokenHash: sessionTokenHash(issuedToken),
  sessionExpiresAt: new Date(now.getTime() + ttlMilliseconds).toISOString(),
  sessionLastUsedAt: now.toISOString(),
  sessionRevokedAt: null,
  previousSessionTokenHash: presentedHash,
  previousSessionExpiresAt: presentedHash ? new Date(now.getTime() + graceMilliseconds).toISOString() : null,
});

