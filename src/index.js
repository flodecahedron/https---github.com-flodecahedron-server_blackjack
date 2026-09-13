import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { DAILY_ROULETTE_SEGMENTS, claimDailyRoulette, dailyReward, dailyRouletteStatus } from "./blackjack.js";
import { GameRoom } from "./game-room.js";
import { RouletteRoom } from "./roulette-room.js";
import { PlayerStore } from "./player-store.js";
import { TrafficMetrics } from "./traffic-metrics.js";
import { RealtimeTransport } from "./realtime-transport.js";
import { applyRoomAction } from "./room-actions.js";
import { fingerprintAddress, getClientAddress, readIntegerSetting } from "./security.js";
import { RealtimeRateGuard } from "./realtime-rate-guard.js";
import { normalizeCrashReport } from "./crash-reports.js";
import { isGoogleAuthConfigured, verifyGoogleIdToken } from "./google-auth.js";
import { newSessionToken, rotatedAuthRecord, sessionCredentialHash, sessionTokenHash, tokenMatches } from "./auth-session.js";
import {
  PLAY_INTEGRITY_MODE,
  PLAY_INTEGRITY_PROJECT_NUMBER,
  PLAY_INTEGRITY_VERIFIED_TTL_MS,
  createIntegrityChallenge,
  decodeAndAssessIntegrityToken,
  isPlayIntegrityConfigured,
} from "./play-integrity.js";

const accounts = new Map(), rooms = new Map(), sockets = new Map(), store = new PlayerStore();
const authByPlayer = new Map(), playerByGoogleSubject = new Map();
const abuseHashSecret = String(process.env.ABUSE_HASH_SECRET ?? "").trim();
if (process.env.DATABASE_URL && !abuseHashSecret) throw Error("ABUSE_HASH_SECRET is required when DATABASE_URL is configured");
const addressHashSecret = abuseHashSecret || crypto.randomBytes(32).toString("hex");
const registrationIpLimit = readIntegerSetting("REGISTRATION_IP_LIMIT", 3, 1, 100);
const dailyRouletteIpLimit = readIntegerSetting("DAILY_ROULETTE_IP_LIMIT", 3, 1, 100);
const maxConnectionsPerIp = readIntegerSetting("MAX_CONNECTIONS_PER_IP", 5, 1, 100);
const legacyMessageLimit = readIntegerSetting("MESSAGE_LIMIT_PER_10S", 150, 10, 1_000);
const connectionMessageLimitPerTenSeconds = readIntegerSetting("CONNECTION_MESSAGE_LIMIT_PER_10S", legacyMessageLimit, 20, 1_000);
const accountMessageLimitPerTenSeconds = readIntegerSetting("ACCOUNT_MESSAGE_LIMIT_PER_10S", 180, 20, 1_000);
const ipMessageLimitPerTenSeconds = readIntegerSetting("IP_MESSAGE_LIMIT_PER_10S", 300, 40, 2_000);
const stateActionLimitPerTenSeconds = readIntegerSetting("STATE_ACTION_LIMIT_PER_10S", 30, 5, 200);
const betActionLimitPerTenSeconds = readIntegerSetting("BET_ACTION_LIMIT_PER_10S", 80, 10, 500);
const crashReportsPerAccountPerDay = readIntegerSetting("CRASH_REPORTS_PER_ACCOUNT_PER_DAY", 3, 1, 10);
const crashReportsPerIpPerDay = readIntegerSetting("CRASH_REPORTS_PER_IP_PER_DAY", 20, 1, 100);
const crashReportsEnabled = String(process.env.CRASH_REPORTS_ENABLED ?? "true").toLowerCase() === "true";
const connectionCounts = new Map();
const realtimeRateGuard = new RealtimeRateGuard({
  connectionLimit: connectionMessageLimitPerTenSeconds,
  accountLimit: accountMessageLimitPerTenSeconds,
  ipLimit: ipMessageLimitPerTenSeconds,
  stateActionLimit: stateActionLimitPerTenSeconds,
  betActionLimit: betActionLimitPerTenSeconds,
});
const trafficMetrics = new TrafficMetrics({ intervalSeconds: readIntegerSetting("TRAFFIC_METRICS_INTERVAL_SECONDS", 300, 0, 86_400) });
const realtime = new RealtimeTransport({ metrics: trafficMetrics });
const logWebSocketMessages = String(process.env.LOG_WS_MESSAGES ?? (process.env.NODE_ENV === "production" ? "false" : "true")).toLowerCase() === "true";
const persistentQuotaWindow = 24 * 60 * 60 * 1000;
const allowGuestAuth = String(process.env.ALLOW_GUEST_AUTH ?? "true").toLowerCase() === "true";
const STATE_CHANGING_ACTIONS = new Set([
  "create_room", "join_room", "spectate_room", "resume_room", "leave_room", "take_seat", "become_spectator",
  "roulette_bet", "roulette_clear_bets", "ready", "unready", "bet", "start", "hit", "stand", "dealer_hit",
  "dealer_stand", "double", "split", "surrender", "next_round", "become_dealer", "leave_dealer", "leave_dealer_queue",
  "claim_safety_grant",
  "logout", "delete_account",
]);
const INTEGRITY_BYPASS_ACTIONS = new Set(["leave_room", "become_spectator", "leave_dealer", "leave_dealer_queue", "logout", "delete_account"]);
const ROOM_CODES = ["ABLE", "BAKE", "BIRD", "BLUE", "BOLD", "CALM", "DARK", "DOVE", "EAST", "FIRE", "GOLD", "HILL", "JUMP", "LIME", "MOON", "ROSE", "SAND", "STAR", "WAVE", "WIND"];
const id = () => crypto.randomUUID();
const send = (ws, type, payload = {}) => realtime.send(ws, type, payload);
const fail = (ws, message) => realtime.fail(ws, message);
const roomSummary = room => ({
  game: room.game ?? "blackjack",
  code: room.code,
  name: room.name,
  phase: room.phase,
  players: [...room.players.values()].map(player => player.profile.username),
  playerCount: room.players.size,
  spectatorCount: room.spectators.size,
  dealer: room.dealer.name,
});
const sendRoomList = ws => send(ws, "room_list", { rooms: [...rooms.values()].map(roomSummary).sort((a, b) => a.code.localeCompare(b.code)) });
const broadcastRoomList = () => { for (const ws of sockets.values()) sendRoomList(ws); };
const sendLeaderboardSummary = async (ws, playerId) => {
  const summary = await store.leaderboardSummary(playerId, accounts);
  send(ws, "leaderboard_summary", summary);
};
const sendLeaderboardPage = async (ws, playerId, page) => {
  const result = await store.leaderboardPage(playerId, page, accounts, 25);
  send(ws, "leaderboard_page", result);
};
const roomCode = () => {
  const available = ROOM_CODES.filter(code => !rooms.has(code));
  if (!available.length) throw Error("Toutes les tables sont occupées");
  return available[crypto.randomInt(available.length)];
};
const sendRoomSnapshot = (room, playerId, ws) => realtime.sendRoomSnapshot(room, playerId, ws);
const broadcast = room => realtime.broadcastRoom(room, sockets);
const currentRoomFor = profileId => [...rooms.values()].find(room => room.players.has(profileId) || room.spectators.has(profileId));
const roomPersistence = new WeakMap();
const persistRoomEconomy = room => {
  const events = room.pendingEconomyEvents?.() ?? [];
  if (!events.length) return roomPersistence.get(room) ?? Promise.resolve();
  const eventIds = events.map(event => event.id);
  const previous = roomPersistence.get(room) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    await store.applyEconomyEvents(events, accounts);
    room.acknowledgeEconomyEvents(eventIds);
  });
  roomPersistence.set(room, current);
  return current;
};
const restoreBrokeRoomPlayers = async room => {
  const profiles = [...new Map([
    ...[...room.players.values()].map(player => [player.profile.id, player.profile]),
    ...[...room.spectators.values()].map(profile => [profile.id, profile]),
  ]).values()];
  for (const profile of profiles) {
    if (profile.balance > 0) continue;
    const roomPlayer = room.players.get(profile.id);
    const hasCommittedBet = roomPlayer && (room.game === "roulette" ? room.totalBet(roomPlayer) : room.playerTotalBet(roomPlayer)) > 0;
    const resultIsFinal = room.game === "roulette" ? room.phase === "results" : room.phase === "settlement";
    if (hasCommittedBet && !resultIsFinal) continue;
    const grant = await store.claimSafetyGrant(profile, accounts, { rewarded: false });
    if (grant.granted && room.game === "blackjack") room.addRoundEvent(profile.id, "casino_gift");
    const socket = sockets.get(profile.id);
    if (socket) send(socket, "safety_grant_status", { safetyGrant: grant, profile });
  }
};
const saveRoomProfiles = async room => {
  await persistRoomEconomy(room);
  await restoreBrokeRoomPlayers(room);
};
const removeFromRoom = async (room, profile) => {
  try {
    room.leavePlayer(profile.id);
  } catch (error) {
    console.error(`[room] Forced removal of ${profile.username} from ${room.code}: ${error.message}`);
    room.players.delete(profile.id); room.spectators.delete(profile.id);
    if (room.dealer.type === "player" && room.dealer.playerId === profile.id) room.dealer = { type: "bot", name: "Casino", bankroll: Infinity, cards: [] };
  }
  try { await saveRoomProfiles(room); } catch (error) { console.error(`[store] Could not save room ${room.code} after departure: ${error.message}`); }
  if (room.players.size) broadcast(room);
  else {
    room.clearRoundTimers();
    for (const spectatorId of room.spectators.keys()) if (sockets.has(spectatorId)) send(sockets.get(spectatorId), "left_room", {});
    room.spectators.clear();
    rooms.delete(room.code);
  }
  broadcastRoomList();
};
const replaceActiveSocket = (profileId, ws) => {
  const previous = sockets.get(profileId);
  sockets.set(profileId, ws);
  // A profile has one active session. Its stale connection may still emit "close",
  // but the identity check in that handler prevents it from removing the player.
  if (previous && previous !== ws) previous.close(4001, "Session replaced");
};

const finishAuthentication = async (ws, profile, sessionToken = null) => {
  replaceActiveSocket(profile.id, ws);
  const safetyGrant = await store.claimSafetyGrant(profile, accounts, { rewarded: false });
  const balanceBeforeDailyGift = profile.balance;
  const dailyGift = dailyReward(profile);
  await store.applyProfileEconomy(profile, accounts, {
    delta: profile.balance - balanceBeforeDailyGift,
    reason: "daily_login_reward",
    eventId: `daily-login:${profile.id}:${profile.lastLogin ?? "none"}`,
  });
  const payload = { profile, dailyReward: dailyGift.amount, dailyGift, dailyRoulette: dailyRouletteStatus(profile), safetyGrant };
  if (sessionToken) payload.sessionToken = sessionToken;
  send(ws, "authenticated", payload);
  sendRoomList(ws);
  await sendLeaderboardSummary(ws, profile.id);
  return dailyGift;
};

const roomUpdateHandler = () => {
  let lastPublishedPhase = null;
  return updatedRoom => {
    const phaseChanged = updatedRoom.phase !== lastPublishedPhase;
    lastPublishedPhase = updatedRoom.phase;
    void saveRoomProfiles(updatedRoom)
      .then(() => {
        broadcast(updatedRoom);
        if (phaseChanged) broadcastRoomList();
      })
      .catch(error => console.error(`[store] Could not save room ${updatedRoom.code}: ${error.message}`));
  };
};

const server = http.createServer((req, res) => { res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "ok", persistence: process.env.DATABASE_URL ? "postgres" : "file" })); });
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, perMessageDeflate: false });
wss.on("connection", (ws, request) => {
  const connectionId = id();
  const clientAddress = getClientAddress(request);
  const addressFingerprint = fingerprintAddress(clientAddress, addressHashSecret);
  const openConnections = connectionCounts.get(addressFingerprint) ?? 0;
  if (openConnections >= maxConnectionsPerIp) {
    console.warn(`[security] Connection refused for ${addressFingerprint.slice(0, 12)}: concurrent connection limit`);
    fail(ws, "Trop de connexions simultanées depuis ce réseau");
    ws.close(1008, "Connection limit");
    return;
  }
  connectionCounts.set(addressFingerprint, openConnections + 1);
  let profile = null;
  let messageType = "unknown";
  let connectionReleased = false;
  let googleNonce = null;
  let googleNonceExpiresAt = 0;
  let pendingGoogleConfirmation = null;
  let pendingIntegrityChallenge = null;
  let integrityVerifiedUntil = 0;
  let nextIntegrityRequestAt = 0;
  let lastSoftRateLimitNoticeAt = 0;
  const requestIntegrityVerdict = () => {
    if (!isPlayIntegrityConfigured()) {
      integrityVerifiedUntil = Number.POSITIVE_INFINITY;
      send(ws, "integrity_status", { status: "not_configured", mode: PLAY_INTEGRITY_MODE });
      return;
    }
    pendingIntegrityChallenge = createIntegrityChallenge();
    nextIntegrityRequestAt = Date.now() + 60_000;
    send(ws, "integrity_challenge", {
      challenge: pendingIntegrityChallenge.challenge,
      requestHash: pendingIntegrityChallenge.requestHash,
      cloudProjectNumber: PLAY_INTEGRITY_PROJECT_NUMBER,
      mode: PLAY_INTEGRITY_MODE,
    });
  };
  const completeAuthentication = async (authenticatedProfile, sessionToken) => {
    const dailyGift = await finishAuthentication(ws, authenticatedProfile, sessionToken);
    integrityVerifiedUntil = 0;
    nextIntegrityRequestAt = 0;
    pendingIntegrityChallenge = null;
    if (PLAY_INTEGRITY_MODE !== "off") requestIntegrityVerdict();
    return dailyGift;
  };
  console.log(`[socket] Client connected (${addressFingerprint.slice(0, 12)})`);
  ws.on("message", async raw => {
    let inboundMeasured = false;
    try {
    const trafficVerdict = realtimeRateGuard.checkTraffic({
      connectionId,
      addressFingerprint,
      accountId: profile?.id ?? null,
    });
    if (!trafficVerdict.allowed) {
      trafficMetrics.recordInbound("rate_limited", raw);
      inboundMeasured = true;
      console.warn(`[security] Hard traffic limit reached (${trafficVerdict.scope}) for ${addressFingerprint.slice(0, 12)}`);
      fail(ws, "Activité réseau anormalement élevée. Reconnexion nécessaire.");
      ws.close(1008, "Rate limit");
      return;
    }
    const message = JSON.parse(raw.toString()); const { type } = message;
    messageType = String(type ?? "unknown");
    trafficMetrics.recordInbound(messageType, raw);
    inboundMeasured = true;
    if (logWebSocketMessages) console.log(`[message] ${profile?.username ?? "anonymous"} → ${messageType}`);
    const actionVerdict = realtimeRateGuard.checkAction({
      accountId: profile?.id ?? null,
      type,
      isStateChanging: STATE_CHANGING_ACTIONS.has(type),
    });
    if (!actionVerdict.allowed) {
      const now = Date.now();
      if (now - lastSoftRateLimitNoticeAt >= 2_000) {
        lastSoftRateLimitNoticeAt = now;
        const notice = actionVerdict.category === "bet"
          ? "Mises trop rapides : certaines pressions ont été ignorées."
          : "Action trop rapide, veuillez réessayer.";
        console.warn(`[security] Soft ${actionVerdict.category} limit reached for account ${profile.id}`);
        fail(ws, notice);
      }
      return;
    }
    // The Android Google account picker temporarily backgrounds the app. Its
    // resume health check can arrive while the ID token is still being verified.
    if (type === "client_hello") {
      return;
    }
    if (type === "ping") { send(ws, "pong", {}); return; }
    if (type === "request_google_auth") {
      if (!isGoogleAuthConfigured()) throw Error("Connexion Google non configurée sur le serveur");
      pendingGoogleConfirmation = null;
      googleNonce = crypto.randomBytes(32).toString("base64url");
      googleNonceExpiresAt = Date.now() + 2 * 60 * 1000;
      send(ws, "google_auth_nonce", { nonce: googleNonce });
      return;
    }
    if (type === "google_login") {
      if (!googleNonce || Date.now() > googleNonceExpiresAt) throw Error("Demandez une nouvelle connexion Google");
      const identity = await verifyGoogleIdToken(message.idToken, googleNonce);
      googleNonce = null;
      googleNonceExpiresAt = 0;
      const authIntent = message.intent === "signup" ? "signup" : "login";

      const linkedPlayerId = playerByGoogleSubject.get(identity.sub);
      let googleProfile = linkedPlayerId ? accounts.get(linkedPlayerId) : null;
      if (profile && googleProfile && googleProfile.id !== profile.id) throw Error("Ce compte Google est déjà associé à un autre joueur");
      if (profile && !googleProfile) {
        const existingAuth = authByPlayer.get(profile.id);
        if (existingAuth?.googleSub && existingAuth.googleSub !== identity.sub) throw Error("Ce joueur est déjà associé à un autre compte Google");
        googleProfile = profile;
      }
      if (authIntent === "signup" && googleProfile) {
        const confirmationToken = newSessionToken();
        pendingGoogleConfirmation = {
          playerId: googleProfile.id,
          googleSub: identity.sub,
          tokenHash: sessionTokenHash(confirmationToken),
          expiresAt: Date.now() + 2 * 60 * 1000,
        };
        send(ws, "google_account_exists", { username: googleProfile.username, confirmationToken });
        return;
      }
      if (!googleProfile) {
        const username = String(message.username ?? "").trim();
        if (authIntent !== "signup") throw Error("Aucun compte lié à ce compte Google. Créez un compte et choisissez un pseudo.");
        if (!/^[\w-]{3,16}$/.test(username)) throw Error("Choisissez un pseudo de 3 à 16 caractères");
        if ([...accounts.values()].some(account => account.username.toLowerCase() === username.toLowerCase())) throw Error("Pseudo déjà utilisé");
        if (!await store.consumeQuota(addressFingerprint, "register", registrationIpLimit, persistentQuotaWindow)) throw Error("Trop de comptes ont été créés depuis ce réseau aujourd'hui");
        googleProfile = { id: id(), username, avatar: "", balance: 1000, loginStreak: 0, lastLogin: null, lastRoulette: null };
        accounts.set(googleProfile.id, googleProfile);
        await store.save(googleProfile, accounts);
      }

      pendingGoogleConfirmation = null;
      const issuedToken = newSessionToken();
      const authRecord = rotatedAuthRecord({
        playerId: googleProfile.id,
        googleSub: identity.sub,
        issuedToken,
      });
      await store.saveAuthAccount(authRecord);
      authByPlayer.set(googleProfile.id, authRecord);
      playerByGoogleSubject.set(identity.sub, googleProfile.id);
      profile = googleProfile;
      const dailyGift = await completeAuthentication(profile, issuedToken);
      console.log(`[player] ${profile.username} authenticated with Google`);
      if (dailyGift.amount > 0) console.log(`[reward] ${profile.username} received ${dailyGift.amount} daily chips`);
      return;
    }
    if (type === "confirm_google_login") {
      const confirmationToken = String(message.confirmationToken ?? "");
      const pending = pendingGoogleConfirmation;
      if (!pending || Date.now() > pending.expiresAt || !tokenMatches(confirmationToken, pending.tokenHash)) {
        pendingGoogleConfirmation = null;
        throw Error("Cette confirmation Google a expiré. Recommencez la connexion.");
      }
      const googleProfile = accounts.get(pending.playerId);
      if (!googleProfile || playerByGoogleSubject.get(pending.googleSub) !== googleProfile.id) {
        pendingGoogleConfirmation = null;
        throw Error("Le compte Google associé n'est plus disponible");
      }
      pendingGoogleConfirmation = null;
      const issuedToken = newSessionToken();
      const authRecord = rotatedAuthRecord({ playerId: googleProfile.id, googleSub: pending.googleSub, issuedToken });
      await store.saveAuthAccount(authRecord);
      authByPlayer.set(googleProfile.id, authRecord);
      profile = googleProfile;
      const dailyGift = await completeAuthentication(profile, issuedToken);
      console.log(`[player] ${profile.username} confirmed loading their existing Google account`);
      if (dailyGift.amount > 0) console.log(`[reward] ${profile.username} received ${dailyGift.amount} daily chips`);
      return;
    }
    if (type === "register") {
      if (!allowGuestAuth) throw Error("Utilisez Connexion avec Google pour créer votre compte");
      const username = String(message.username ?? "").trim();
      if (!/^[\w-]{3,16}$/.test(username)) throw Error("Pseudo: 3 à 16 caractères");
      if ([...accounts.values()].some(account => account.username.toLowerCase() === username.toLowerCase())) throw Error("Pseudo déjà utilisé");
      if (!await store.consumeQuota(addressFingerprint, "register", registrationIpLimit, persistentQuotaWindow)) {
        console.warn(`[security] Registration quota reached for ${addressFingerprint.slice(0, 12)}`);
        throw Error("Trop de comptes ont été créés depuis ce réseau aujourd'hui");
      }
      profile = { id: id(), username, avatar: String(message.avatar ?? ""), balance: 1000, loginStreak: 0, lastLogin: null, lastRoulette: null };
      accounts.set(profile.id, profile);
      const issuedToken = newSessionToken();
      const authRecord = rotatedAuthRecord({ playerId: profile.id, googleSub: null, issuedToken });
      await store.save(profile, accounts);
      await store.saveAuthAccount(authRecord);
      authByPlayer.set(profile.id, authRecord);
      const dailyGift = await completeAuthentication(profile, issuedToken);
      console.log(`[player] ${profile.username} created an account and connected`);
      return;
    }
    if (type === "login") {
      const loginProfile = accounts.get(String(message.accountId));
      if (!loginProfile) throw Error("Compte introuvable");
      let authRecord = authByPlayer.get(loginProfile.id);
      if (authRecord) {
        const presentedHash = sessionCredentialHash(authRecord, message.sessionToken);
        if (!presentedHash) throw Error("Session expirée : reconnectez-vous avec Google");
        const issuedToken = newSessionToken();
        authRecord = rotatedAuthRecord({
          playerId: loginProfile.id,
          googleSub: authRecord.googleSub,
          presentedHash,
          issuedToken,
        });
        await store.saveAuthAccount(authRecord);
        authByPlayer.set(loginProfile.id, authRecord);
        profile = loginProfile;
        await completeAuthentication(profile, issuedToken);
        console.log(`[player] ${profile.username} connected with a rotated session`);
        return;
      } else {
        if (!allowGuestAuth) throw Error("Reconnectez-vous avec Google");
        const issuedToken = newSessionToken();
        authRecord = rotatedAuthRecord({ playerId: loginProfile.id, googleSub: null, issuedToken });
        await store.saveAuthAccount(authRecord);
        authByPlayer.set(loginProfile.id, authRecord);
        profile = loginProfile;
        const dailyGift = await completeAuthentication(profile, issuedToken);
        console.log(`[player] ${profile.username} upgraded to a secured local session`);
        return;
      }
    }
    if (!profile) throw Error("Authentication required");
    if (type === "list_rooms") { sendRoomList(ws); return; }
    if (type === "get_leaderboard") { await sendLeaderboardSummary(ws, profile.id); return; }
    if (type === "get_leaderboard_page") { await sendLeaderboardPage(ws, profile.id, message.page); return; }
    if (type === "request_room_snapshot") {
      const activeRoom = currentRoomFor(profile.id);
      if (!activeRoom) throw Error("Join a room first");
      sendRoomSnapshot(activeRoom, profile.id, ws);
      return;
    }
    if (type === "get_daily_roulette") { send(ws, "daily_roulette_status", { roulette: dailyRouletteStatus(profile) }); return; }
    if (type === "get_safety_grant") { send(ws, "safety_grant_status", { safetyGrant: store.safetyGrantStatus(profile), profile }); return; }
    if (type === "report_crash") {
      const reportId = String(message.reportId ?? "").slice(0, 80);
      if (!crashReportsEnabled) {
        send(ws, "crash_report_received", { reportId, accepted: false });
        return;
      }
      try {
        const report = normalizeCrashReport(message);
        const ipAllowed = await store.consumeQuota(addressFingerprint, "crash_report", crashReportsPerIpPerDay, persistentQuotaWindow);
        const result = ipAllowed
          ? await store.saveCrashReport(profile.id, report, crashReportsPerAccountPerDay)
          : { accepted: false, reason: "ip_quota" };
        send(ws, "crash_report_received", { reportId: report.reportId, accepted: result.accepted });
        if (result.accepted) console.warn(`[crash] Report ${report.reportId} stored for ${profile.username} (${report.kind}, ${report.appVersion})`);
      } catch (error) {
        console.warn(`[crash] Rejected report for ${profile.username}: ${error.message}`);
        send(ws, "crash_report_received", { reportId, accepted: false });
      }
      return;
    }
    if (type === "submit_integrity") {
      const challenge = String(message.challenge ?? "");
      const pending = pendingIntegrityChallenge;
      if (!pending || challenge !== pending.challenge || Date.now() > pending.expiresAt) {
        pendingIntegrityChallenge = null;
        send(ws, "integrity_status", { status: "expired", mode: PLAY_INTEGRITY_MODE });
        return;
      }
      pendingIntegrityChallenge = null;
      try {
        const verdict = await decodeAndAssessIntegrityToken(message.integrityToken, pending.requestHash);
        if (verdict.accepted) {
          integrityVerifiedUntil = Date.now() + PLAY_INTEGRITY_VERIFIED_TTL_MS;
          send(ws, "integrity_status", { status: "verified", mode: PLAY_INTEGRITY_MODE });
          console.log(`[integrity] ${profile.username} verified`);
        } else {
          send(ws, "integrity_status", { status: "rejected", mode: PLAY_INTEGRITY_MODE });
          console.warn(`[integrity] ${profile.username} rejected: ${verdict.reasons.join(",")}`);
        }
      } catch (error) {
        send(ws, "integrity_status", { status: "error", mode: PLAY_INTEGRITY_MODE });
        console.warn(`[integrity] ${profile.username} verification error: ${error.message}`);
      }
      return;
    }
    if (type === "integrity_client_error") {
      console.warn(`[integrity] ${profile.username} client error: ${String(message.message ?? "unknown").slice(0, 180)}`);
      return;
    }
    if (type === "logout") {
      const departingProfile = profile;
      const activeRoom = currentRoomFor(departingProfile.id);
      if (activeRoom) await removeFromRoom(activeRoom, departingProfile);
      await store.revokeAuthSession(departingProfile.id);
      const authRecord = authByPlayer.get(departingProfile.id);
      if (authRecord) {
        authRecord.sessionRevokedAt = new Date().toISOString();
        authRecord.previousSessionTokenHash = null;
        authRecord.previousSessionExpiresAt = null;
      }
      sockets.delete(departingProfile.id);
      realtime.forget(ws);
      profile = null;
      send(ws, "logged_out", {});
      console.log(`[player] ${departingProfile.username} logged out`);
      return;
    }
    if (type === "delete_account") {
      const deletedProfile = profile;
      const activeRoom = currentRoomFor(deletedProfile.id);
      if (activeRoom) await removeFromRoom(activeRoom, deletedProfile);
      const authRecord = authByPlayer.get(deletedProfile.id);
      await store.deletePlayer(deletedProfile.id, accounts);
      authByPlayer.delete(deletedProfile.id);
      if (authRecord?.googleSub && playerByGoogleSubject.get(authRecord.googleSub) === deletedProfile.id) playerByGoogleSubject.delete(authRecord.googleSub);
      sockets.delete(deletedProfile.id);
      realtime.forget(ws);
      profile = null;
      send(ws, "account_deleted", {});
      broadcastRoomList();
      console.log(`[player] ${deletedProfile.username} deleted their account`);
      return;
    }
    if (STATE_CHANGING_ACTIONS.has(type) && !INTEGRITY_BYPASS_ACTIONS.has(type) && integrityVerifiedUntil <= Date.now()) {
      if (!pendingIntegrityChallenge && Date.now() >= nextIntegrityRequestAt) requestIntegrityVerdict();
      if (PLAY_INTEGRITY_MODE === "enforce") throw Error("Vérification de l'intégrité de l'application requise");
    }
    if (type === "claim_safety_grant") {
      const grantRoom = currentRoomFor(profile.id);
      const grantPlayer = grantRoom?.players.get(profile.id);
      const committedBet = grantPlayer ? (grantRoom.game === "roulette" ? grantRoom.totalBet(grantPlayer) : grantRoom.playerTotalBet(grantPlayer)) : 0;
      const resultIsFinal = grantRoom ? (grantRoom.game === "roulette" ? grantRoom.phase === "results" : grantRoom.phase === "settlement") : true;
      if (committedBet > 0 && !resultIsFinal) throw Error("Votre mise doit être réglée avant de demander des jetons de secours");
      const safetyGrant = await store.claimSafetyGrant(profile, accounts, { rewarded: true });
      send(ws, "safety_grant_status", { safetyGrant, profile });
      if (grantRoom) broadcast(grantRoom);
      await sendLeaderboardSummary(ws, profile.id);
      return;
    }
    if (type === "claim_daily_roulette") {
      if (!dailyRouletteStatus(profile).available) throw Error("La roulette quotidienne a déjà été jouée aujourd'hui");
      if (!await store.consumeQuota(addressFingerprint, "daily_roulette", dailyRouletteIpLimit, persistentQuotaWindow)) {
        console.warn(`[security] Daily roulette quota reached for ${addressFingerprint.slice(0, 12)}`);
        throw Error("La limite quotidienne de roulettes pour ce réseau est atteinte");
      }
      const balanceBeforeRoulette = profile.balance;
      const rouletteResult = claimDailyRoulette(profile, crypto.randomInt(DAILY_ROULETTE_SEGMENTS.length));
      await store.applyProfileEconomy(profile, accounts, {
        delta: profile.balance - balanceBeforeRoulette,
        reason: "daily_roulette_reward",
        eventId: `daily-roulette:${profile.id}:${profile.lastRoulette}`,
      });
      send(ws, "daily_roulette_result", rouletteResult);
      await sendLeaderboardSummary(ws, profile.id);
      return;
    }
    if (type === "create_room") {
      if (currentRoomFor(profile.id)) throw Error("Quittez votre table actuelle avant d'en créer une autre");
      const code = roomCode();
      const game = String(message.game ?? "blackjack");
      const RoomClass = game === "roulette" ? RouletteRoom : GameRoom;
      const room = new RoomClass({ code, name: code, host: profile, onUpdate: roomUpdateHandler() });
      rooms.set(room.code, room); console.log(`[room] ${profile.username} created ${room.game} table ${code}`); broadcast(room); broadcastRoomList(); return;
    }
    if (type === "join_room") { const room = rooms.get(String(message.code ?? "").trim().toUpperCase()); if (!room) throw Error("Room not found"); const currentRoom = currentRoomFor(profile.id); if (currentRoom && currentRoom !== room) throw Error("Quittez votre table actuelle avant d'en rejoindre une autre"); if (currentRoom === room) { broadcast(room); return; } const seatsOpen = room.game === "roulette" ? room.phase === "betting" : room.phase === "lobby"; if (seatsOpen) room.addPlayer(profile); else room.addSpectator(profile); console.log(`[room] ${profile.username} joined ${room.game} table ${room.code} as ${seatsOpen ? "player" : "spectator"}`); broadcast(room); broadcastRoomList(); return; }
    if (type === "spectate_room") { const room = rooms.get(String(message.code ?? "").trim().toUpperCase()); if (!room) throw Error("Room not found"); const currentRoom = [...rooms.values()].find(candidate => candidate.players.has(profile.id) || candidate.spectators.has(profile.id)); if (currentRoom && currentRoom !== room) throw Error("Leave your current room first"); if (!currentRoom) room.addSpectator(profile); console.log(`[room] ${profile.username} joined table ${room.code} as spectator`); broadcast(room); broadcastRoomList(); return; }
    if (type === "resume_room") {
      const room = rooms.get(String(message.code ?? "").trim().toUpperCase());
      if (!room) { send(ws, "room_resume_failed", { message: "La table n'existe plus" }); return; }
      try {
        if (!room.players.has(profile.id) && !room.spectators.has(profile.id)) {
          const requestedRole = String(message.role ?? "player");
          const seatsOpen = room.game === "roulette" ? room.phase === "betting" : room.phase === "lobby";
          if (seatsOpen && requestedRole !== "spectator") room.addPlayer(profile);
          else room.addSpectator(profile);
        }
        console.log(`[room] ${profile.username} resumed table ${room.code}`);
        broadcast(room); broadcastRoomList();
      } catch (error) {
        send(ws, "room_resume_failed", { message: error.message });
      }
      return;
    }
    const room = currentRoomFor(profile.id); if (!room) throw Error("Join a room first");
    const phaseBeforeAction = room.phase;
    if (type === "leave_room") {
      await removeFromRoom(room, profile);
      realtime.forget(ws);
      send(ws, "left_room", { profile });
      return;
    }
    if (type === "take_seat") { room.addPlayer(profile); broadcast(room); return; }
    if (type === "become_spectator") { room.becomeSpectator(profile.id); await saveRoomProfiles(room); broadcast(room); return; }
    if (!room.players.has(profile.id)) throw Error("You are spectating this round");
    applyRoomAction(room, profile.id, type, message);
    await saveRoomProfiles(room); broadcast(room);
    if (room.phase !== phaseBeforeAction) broadcastRoomList();
  } catch (error) {
    if (!inboundMeasured) trafficMetrics.recordInbound("invalid", raw);
    console.warn(`[error] ${profile?.username ?? "anonymous"} → ${messageType}: ${error.message}`);
    fail(ws, error.message);
  } });
  ws.on("close", () => {
    if (!connectionReleased) {
      connectionReleased = true;
      const remainingConnections = Math.max(0, (connectionCounts.get(addressFingerprint) ?? 1) - 1);
      if (remainingConnections) connectionCounts.set(addressFingerprint, remainingConnections);
      else connectionCounts.delete(addressFingerprint);
    }
    // Do not remove a player when an older socket closes after a reconnect.
    if (!profile || sockets.get(profile.id) !== ws) return;
    console.log(`[player] ${profile.username} disconnected`);
    sockets.delete(profile.id);
    realtime.forget(ws);
    for (const room of rooms.values()) if (room.players.has(profile.id) || room.spectators.has(profile.id)) void removeFromRoom(room, profile);
  });
});

await store.initialize();
if (PLAY_INTEGRITY_MODE === "enforce" && !isPlayIntegrityConfigured()) throw Error("Play Integrity enforce mode requires GOOGLE_CLOUD_PROJECT_NUMBER and Google service account credentials");
for (const profile of await store.loadAll()) accounts.set(profile.id, profile);
for (const authRecord of await store.loadAuthAccounts()) {
  authByPlayer.set(authRecord.playerId, authRecord);
  if (authRecord.googleSub) playerByGoogleSubject.set(authRecord.googleSub, authRecord.playerId);
}
server.listen(process.env.PORT || 3000, () => {
  console.log(`BeDealer server listening with ${process.env.DATABASE_URL ? "PostgreSQL" : "file"} persistence; Google auth ${isGoogleAuthConfigured() ? "enabled" : "disabled"}; Play Integrity ${PLAY_INTEGRITY_MODE}${isPlayIntegrityConfigured() ? "" : " (not configured)"}`);
  if (PLAY_INTEGRITY_MODE === "audit" && !isPlayIntegrityConfigured()) console.warn("[integrity] Audit is enabled but server credentials or GOOGLE_CLOUD_PROJECT_NUMBER are missing");
});
