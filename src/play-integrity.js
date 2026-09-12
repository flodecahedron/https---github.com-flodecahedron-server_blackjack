import crypto from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { readIntegerSetting } from "./security.js";

const PLAY_INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity";
const validModes = new Set(["off", "audit", "enforce"]);
const configuredMode = String(process.env.PLAY_INTEGRITY_MODE ?? "off").trim().toLowerCase();

export const PLAY_INTEGRITY_MODE = validModes.has(configuredMode) ? configuredMode : "off";
export const PLAY_INTEGRITY_PACKAGE = String(process.env.PLAY_INTEGRITY_PACKAGE ?? "com.bedealer.game").trim();
export const PLAY_INTEGRITY_PROJECT_NUMBER = String(process.env.GOOGLE_CLOUD_PROJECT_NUMBER ?? "").trim();
export const PLAY_INTEGRITY_VERIFIED_TTL_MS = readIntegerSetting("PLAY_INTEGRITY_VERIFIED_TTL_MINUTES", 30, 5, 240) * 60 * 1000;
const requireLicensed = String(process.env.PLAY_INTEGRITY_REQUIRE_LICENSED ?? "true").toLowerCase() === "true";
const serviceAccountJson = String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ?? "").trim();

let credentials = null;
if (serviceAccountJson) {
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch {
    throw Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must contain valid JSON");
  }
}

const googleAuth = credentials || process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? new GoogleAuth({ credentials: credentials ?? undefined, scopes: [PLAY_INTEGRITY_SCOPE] })
  : null;

export const isPlayIntegrityConfigured = () => PLAY_INTEGRITY_MODE !== "off" && googleAuth !== null && Boolean(PLAY_INTEGRITY_PROJECT_NUMBER);

export const integrityRequestHash = challenge => crypto
  .createHash("sha256")
  .update(`bedealer-integrity-v1:${challenge}`)
  .digest("base64url");

export const createIntegrityChallenge = () => {
  const challenge = crypto.randomBytes(32).toString("base64url");
  return {
    challenge,
    requestHash: integrityRequestHash(challenge),
    expiresAt: Date.now() + 2 * 60 * 1000,
  };
};

export const assessIntegrityVerdict = (payload, expectedRequestHash, { now = Date.now(), requirePlayLicense = requireLicensed } = {}) => {
  const reasons = [];
  const request = payload?.requestDetails ?? {};
  const app = payload?.appIntegrity ?? {};
  const account = payload?.accountDetails ?? {};
  const deviceLabels = payload?.deviceIntegrity?.deviceRecognitionVerdict ?? [];
  const timestamp = Number(request.timestampMillis ?? 0);

  if (request.requestPackageName !== PLAY_INTEGRITY_PACKAGE) reasons.push("request_package");
  if (request.requestHash !== expectedRequestHash) reasons.push("request_hash");
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 2 * 60 * 1000) reasons.push("request_timestamp");
  if (app.appRecognitionVerdict !== "PLAY_RECOGNIZED") reasons.push("app_not_recognized");
  if (app.packageName && app.packageName !== PLAY_INTEGRITY_PACKAGE) reasons.push("app_package");
  if (!Array.isArray(deviceLabels) || !deviceLabels.includes("MEETS_DEVICE_INTEGRITY")) reasons.push("device_integrity");
  if (requirePlayLicense && account.appLicensingVerdict !== "LICENSED") reasons.push("app_unlicensed");

  return {
    accepted: reasons.length === 0,
    reasons,
    appRecognitionVerdict: app.appRecognitionVerdict ?? "UNEVALUATED",
    appLicensingVerdict: account.appLicensingVerdict ?? "UNEVALUATED",
    deviceRecognitionVerdict: Array.isArray(deviceLabels) ? deviceLabels : [],
  };
};

export async function decodeAndAssessIntegrityToken(integrityToken, expectedRequestHash) {
  if (!googleAuth) throw Error("Play Integrity server credentials are not configured");
  const token = String(integrityToken ?? "").trim();
  if (!token) throw Error("Play Integrity token is missing");
  const client = await googleAuth.getClient();
  const accessTokenResult = await client.getAccessToken();
  const accessToken = typeof accessTokenResult === "string" ? accessTokenResult : accessTokenResult?.token;
  if (!accessToken) throw Error("Could not obtain a Play Integrity access token");
  const response = await fetch(`https://playintegrity.googleapis.com/v1/${encodeURIComponent(PLAY_INTEGRITY_PACKAGE)}:decodeIntegrityToken`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ integrity_token: token }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Error(`Play Integrity decode failed (${response.status})`);
  const decoded = await response.json();
  return assessIntegrityVerdict(decoded.tokenPayloadExternal, expectedRequestHash);
}

