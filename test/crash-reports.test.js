import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCrashReport } from "../src/crash-reports.js";

const baseReport = {
  reportId: "1234567890abcdef1234567890abcdef",
  kind: "android_uncaught_exception",
  occurredAt: 1_750_000_000,
  appVersion: "1.2.3",
  versionCode: 12,
  platform: "Android",
  osVersion: "16",
  deviceModel: "Test Phone",
  scene: "res://scenes/game.tscn",
  exceptionType: "java.lang.IllegalStateException",
  nativeStack: "stack",
  logs: [],
};

test("crash reports contain only normalized fields", () => {
  const report = normalizeCrashReport(baseReport, new Date("2025-06-15T16:00:00Z"));
  assert.equal(report.reportId, baseReport.reportId);
  assert.equal(report.versionCode, 12);
  assert.equal(report.diagnostics.exceptionType, "java.lang.IllegalStateException");
  assert.equal(Object.hasOwn(report, "sessionToken"), false);
});

test("crash reports redact emails, bearer credentials and JWT-like values", () => {
  const jwt = `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(16)}`;
  const report = normalizeCrashReport({
    ...baseReport,
    logs: [`contact test@example.com Bearer secret-token ${jwt}`],
  }, new Date("2025-06-15T16:00:00Z"));
  const line = report.diagnostics.logs[0];
  assert.equal(line.includes("test@example.com"), false);
  assert.equal(line.includes("secret-token"), false);
  assert.equal(line.includes(jwt), false);
});

test("crash reports reject unknown kinds and invalid identifiers", () => {
  assert.throws(() => normalizeCrashReport({ ...baseReport, kind: "custom" }), /kind/);
  assert.throws(() => normalizeCrashReport({ ...baseReport, reportId: "short" }), /id/);
});
