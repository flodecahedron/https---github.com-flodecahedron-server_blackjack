const ALLOWED_KINDS = new Set(["android_uncaught_exception", "unexpected_foreground_exit"]);
const MAX_REPORT_BYTES = 12 * 1024;
const MAX_LOG_LINES = 40;

const redact = value => String(value ?? "")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
  .replace(/\bBearer\s+\S+/gi, "Bearer [token]")
  .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, "[token]");

const text = (value, limit) => redact(value).trim().slice(0, limit);

export function normalizeCrashReport(message, now = new Date()) {
  const reportId = text(message.reportId, 80);
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(reportId)) throw Error("Invalid crash report id");

  const kind = text(message.kind, 40);
  if (!ALLOWED_KINDS.has(kind)) throw Error("Invalid crash report kind");

  const occurredAtSeconds = Number(message.occurredAt);
  const occurredAtDate = Number.isFinite(occurredAtSeconds) ? new Date(occurredAtSeconds * 1000) : now;
  const earliestAllowed = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const latestAllowed = now.getTime() + 24 * 60 * 60 * 1000;
  const occurredAt = occurredAtDate.getTime() >= earliestAllowed && occurredAtDate.getTime() <= latestAllowed
    ? occurredAtDate.toISOString()
    : now.toISOString();

  const logs = Array.isArray(message.logs)
    ? message.logs.slice(-MAX_LOG_LINES).map(line => text(line, 260)).filter(Boolean)
    : [];
  const versionCode = Math.max(0, Math.min(2_100_000_000, Number.parseInt(message.versionCode, 10) || 0));
  const report = {
    reportId,
    kind,
    occurredAt,
    appVersion: text(message.appVersion, 40),
    versionCode,
    platform: text(message.platform, 40),
    osVersion: text(message.osVersion, 120),
    deviceModel: text(message.deviceModel, 120),
    scene: text(message.scene, 200),
    diagnostics: {
      engineVersion: text(message.engineVersion, 80),
      exceptionType: text(message.exceptionType, 160),
      nativeStack: text(message.nativeStack, 8_000),
      logs,
    },
  };
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_REPORT_BYTES) throw Error("Crash report too large");
  return report;
}
