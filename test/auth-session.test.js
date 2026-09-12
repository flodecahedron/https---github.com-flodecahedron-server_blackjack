import test from "node:test";
import assert from "node:assert/strict";
import { rotatedAuthRecord, sessionCredentialHash, sessionTokenHash } from "../src/auth-session.js";

test("a current session expires and can be revoked", () => {
  const now = new Date("2026-09-12T12:00:00.000Z");
  const record = rotatedAuthRecord({ playerId: "player", googleSub: "google-sub", issuedToken: "current", now, ttlMilliseconds: 1_000 });
  assert.equal(sessionCredentialHash(record, "current", now), sessionTokenHash("current"));
  assert.equal(sessionCredentialHash(record, "current", new Date(now.getTime() + 1_001)), null);
  record.sessionRevokedAt = now.toISOString();
  assert.equal(sessionCredentialHash(record, "current", now), null);
});

test("rotation accepts only the presented predecessor during the grace window", () => {
  const now = new Date("2026-09-12T12:00:00.000Z");
  const record = rotatedAuthRecord({
    playerId: "player",
    googleSub: "google-sub",
    presentedHash: sessionTokenHash("previous"),
    issuedToken: "current",
    now,
    ttlMilliseconds: 10_000,
    graceMilliseconds: 500,
  });
  assert.equal(sessionCredentialHash(record, "current", now), sessionTokenHash("current"));
  assert.equal(sessionCredentialHash(record, "previous", new Date(now.getTime() + 499)), sessionTokenHash("previous"));
  assert.equal(sessionCredentialHash(record, "previous", new Date(now.getTime() + 501)), null);
  assert.equal(sessionCredentialHash(record, "unrelated", now), null);
});

