import assert from "node:assert/strict";
import test from "node:test";
import { FixedWindowRateLimiter, fingerprintAddress, getClientAddress, readIntegerSetting } from "../src/security.js";

test("fingerprintAddress is stable without exposing the address", () => {
  const fingerprint = fingerprintAddress("::ffff:203.0.113.4", "secret");
  assert.equal(fingerprint, fingerprintAddress("203.0.113.4", "secret"));
  assert.equal(fingerprint.length, 64);
  assert.equal(fingerprint.includes("203.0.113.4"), false);
});

test("getClientAddress uses Render's first forwarded address", () => {
  const request = {
    headers: { "x-forwarded-for": "203.0.113.4, 10.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.equal(getClientAddress(request), "203.0.113.4");
});

test("FixedWindowRateLimiter rejects excess traffic and resets", () => {
  const limiter = new FixedWindowRateLimiter();
  assert.equal(limiter.allow("player", 2, 1_000, 0), true);
  assert.equal(limiter.allow("player", 2, 1_000, 100), true);
  assert.equal(limiter.allow("player", 2, 1_000, 200), false);
  assert.equal(limiter.allow("player", 2, 1_000, 1_001), true);
});

test("readIntegerSetting clamps environment values", () => {
  const previous = process.env.TEST_SECURITY_LIMIT;
  process.env.TEST_SECURITY_LIMIT = "999";
  assert.equal(readIntegerSetting("TEST_SECURITY_LIMIT", 3, 1, 10), 10);
  if (previous === undefined) delete process.env.TEST_SECURITY_LIMIT;
  else process.env.TEST_SECURITY_LIMIT = previous;
});
