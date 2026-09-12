import test from "node:test";
import assert from "node:assert/strict";
import { assessIntegrityVerdict, integrityRequestHash } from "../src/play-integrity.js";

const validPayload = (requestHash, now) => ({
  requestDetails: { requestPackageName: "com.bedealer.game", requestHash, timestampMillis: String(now) },
  appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.bedealer.game" },
  deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
  accountDetails: { appLicensingVerdict: "LICENSED" },
});

test("accepts a fresh verdict bound to the expected request", () => {
  const now = Date.parse("2026-09-12T12:00:00.000Z");
  const requestHash = integrityRequestHash("challenge");
  assert.deepEqual(assessIntegrityVerdict(validPayload(requestHash, now), requestHash, { now }), {
    accepted: true,
    reasons: [],
    appRecognitionVerdict: "PLAY_RECOGNIZED",
    appLicensingVerdict: "LICENSED",
    deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"],
  });
});

test("rejects tampered, stale, unlicensed, or untrusted verdicts", () => {
  const now = Date.parse("2026-09-12T12:00:00.000Z");
  const payload = validPayload("wrong", now - 180_000);
  payload.appIntegrity.appRecognitionVerdict = "UNRECOGNIZED_VERSION";
  payload.deviceIntegrity.deviceRecognitionVerdict = [];
  payload.accountDetails.appLicensingVerdict = "UNLICENSED";
  const result = assessIntegrityVerdict(payload, "expected", { now });
  assert.equal(result.accepted, false);
  assert.deepEqual(result.reasons, ["request_hash", "request_timestamp", "app_not_recognized", "device_integrity", "app_unlicensed"]);
});

