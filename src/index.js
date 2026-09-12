import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { DAILY_ROULETTE_SEGMENTS, claimDailyRoulette, dailyReward, dailyRouletteStatus } from "./blackjack.js";
import { GameRoom } from "./game-room.js";
import { RouletteRoom } from "./roulette-room.js";
import { PlayerStore } from "./player-store.js";
import { FixedWindowRateLimiter, fingerprintAddress, getClientAddress, readIntegerSetting } from "./security.js";
import { isGoogleAuthConfigured, verifyGoogleIdToken } from "./google-auth.js";
import { newSessionToken, rotatedAuthRecord, sessionCredentialHash } from "./auth-session.js";

const accounts = new Map(), rooms = new Map(), sockets = new Map(), store = new PlayerStore();
const authByPlayer = new Map(), playerByGoogleSubject = new Map();
const abuseHashSecret = String(process.env.ABUSE_HASH_SECRET ?? "").trim();
if (process.env.DATABASE_URL && !abuseHashSecret) throw Error("ABUSE_HASH_SECRET is required when DATABASE_URL is configured");
const addressHashSecret = abuseHashSecret || crypto.randomBytes(32).toString("hex");
const registrationIpLimit = readIntegerSetting("REGISTRATION_IP_LIMIT", 3, 1, 100);
const dailyRouletteIpLimit = readIntegerSetting("DAILY_ROULETTE_IP_LIMIT", 3, 1, 100);
const maxConnectionsPerIp = readIntegerSetting("MAX_CONNECTIONS_PER_IP", 5, 1, 100);
const messageLimitPerTenSeconds = readIntegerSetting("MESSAGE_LIMIT_PER_10S", 40, 10, 500);
const stateActionLimitPerTenSeconds = readIntegerSetting("STATE_ACTION_LIMIT_PER_10S", 15, 5, 100);
const connectionCounts = new Map();
const trafficLimiter = new FixedWindowRateLimiter();
const persistentQuotaWindow = 24 * 60 * 60 * 1000;
const allowGuestAuth = String(process.env.ALLOW_GUEST_AUTH ?? "true").toLowerCase() === "true";
const STATE_CHANGING_ACTIONS = new Set([
  "create_room", "join_room", "spectate_room", "resume_room", "leave_room", "take_seat", "become_spectator",
  "roulette_bet", "roulette_clear_bets", "ready", "unready", "bet", "start", "hit", "stand", "dealer_hit",
  "dealer_stand", "double", "split", "surrender", "next_round", "become_dealer", "leave_dealer", "leave_dealer_queue",
  "claim_safety_grant",
  "logout", "delete_account",
]);
const ROOM_CODES = ["ABLE", "BAKE", "BIRD", "BLUE", "BOLD", "CALM", "DARK", "DOVE", "EAST", "FIRE", "GOLD", "HILL", "JUMP", "LIME", "MOON", "ROSE", "SAND", "STAR", "WAVE", "WIND"];
const id = () => crypto.randomUUID();
const send = (ws, type, payload) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type, ...payload }));
const fail = (ws, message) => send(ws, "error", { message });
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
const leaderboardEntries = () => [...accounts.values()]
  .sort((left, right) => right.balance - left.balance || left.username.localeCompare(right.username))
  .map((player, index) => ({ rank: index + 1, username: player.username, balance: player.balance }));
const sendLeaderboard = ws => send(ws, "leaderboard", { players: leaderboardEntries() });
const roomCode = () => {
  const available = ROOM_CODES.filter(code => !rooms.has(code));
  if (!available.length) throw Error("Toutes les tables sont occupées");
  return available[crypto.randomInt(available.length)];
};
const broadcast = room => { for (const playerId of [...room.players.keys(), ...room.spectators.keys()]) if (sockets.has(playerId)) send(sockets.get(playerId), "room_state", { room: room.publicState(playerId) }); };
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
  sendLeaderboard(ws);
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
  console.log(`[socket] Client connected (${addressFingerprint.slice(0, 12)})`);
  ws.on("message", async raw => { try {
    const ipTrafficKey = `ip:${addressFingerprint}`;
    if (!trafficLimiter.allow(ipTrafficKey, messageLimitPerTenSeconds, 10_000)) {
      console.warn(`[security] Traffic limit reached for ${addressFingerprint.slice(0, 12)}`);
      fail(ws, "Trop de requêtes. Reconnexion nécessaire.");
      ws.close(1008, "Rate limit");
      return;
    }
    if (profile && !trafficLimiter.allow(`account:${profile.id}`, messageLimitPerTenSeconds, 10_000)) {
      console.warn(`[security] Traffic limit reached for account ${profile.id}`);
      fail(ws, "Trop de requêtes. Reconnexion nécessaire.");
      ws.close(1008, "Rate limit");
      return;
    }
    const message = JSON.parse(raw.toString()); const { type } = message;
    messageType = String(type ?? "unknown");
    console.log(`[message] ${profile?.username ?? "anonymous"} → ${messageType}`);
    if (profile && STATE_CHANGING_ACTIONS.has(type) && !trafficLimiter.allow(`action:${profile.id}`, stateActionLimitPerTenSeconds, 10_000)) {
      console.warn(`[security] Action limit reached for account ${profile.id}`);
      fail(ws, "Trop d'actions envoyées. Reconnexion nécessaire.");
      ws.close(1008, "Action rate limit");
      return;
    }
    if (type === "request_google_auth") {
      if (!isGoogleAuthConfigured()) throw Error("Connexion Google non configurée sur le serveur");
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

      const linkedPlayerId = playerByGoogleSubject.get(identity.sub);
      let googleProfile = linkedPlayerId ? accounts.get(linkedPlayerId) : null;
      if (profile && googleProfile && googleProfile.id !== profile.id) throw Error("Ce compte Google est déjà associé à un autre joueur");
      if (profile && !googleProfile) {
        const existingAuth = authByPlayer.get(profile.id);
        if (existingAuth?.googleSub && existingAuth.googleSub !== identity.sub) throw Error("Ce joueur est déjà associé à un autre compte Google");
        googleProfile = profile;
      }
      if (!googleProfile) {
        const username = String(message.username ?? "").trim();
        if (!/^[\w-]{3,16}$/.test(username)) throw Error("Choisissez un pseudo de 3 à 16 caractères");
        if ([...accounts.values()].some(account => account.username.toLowerCase() === username.toLowerCase())) throw Error("Pseudo déjà utilisé");
        if (!await store.consumeQuota(addressFingerprint, "register", registrationIpLimit, persistentQuotaWindow)) throw Error("Trop de comptes ont été créés depuis ce réseau aujourd'hui");
        googleProfile = { id: id(), username, avatar: "", balance: 1000, loginStreak: 0, lastLogin: null, lastRoulette: null };
        accounts.set(googleProfile.id, googleProfile);
        await store.save(googleProfile, accounts);
      }

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
      const dailyGift = await finishAuthentication(ws, profile, issuedToken);
      console.log(`[player] ${profile.username} authenticated with Google`);
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
      const dailyGift = await finishAuthentication(ws, profile, issuedToken);
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
        await finishAuthentication(ws, profile, issuedToken);
        console.log(`[player] ${profile.username} connected with a rotated session`);
        return;
      } else {
        if (!allowGuestAuth) throw Error("Reconnectez-vous avec Google");
        const issuedToken = newSessionToken();
        authRecord = rotatedAuthRecord({ playerId: loginProfile.id, googleSub: null, issuedToken });
        await store.saveAuthAccount(authRecord);
        authByPlayer.set(loginProfile.id, authRecord);
        profile = loginProfile;
        const dailyGift = await finishAuthentication(ws, profile, issuedToken);
        console.log(`[player] ${profile.username} upgraded to a secured local session`);
        return;
      }
    }
    if (!profile) throw Error("Authentication required");
    if (type === "ping") { send(ws, "pong", {}); return; }
    if (type === "list_rooms") { sendRoomList(ws); return; }
    if (type === "get_leaderboard") { sendLeaderboard(ws); return; }
    if (type === "get_daily_roulette") { send(ws, "daily_roulette_status", { roulette: dailyRouletteStatus(profile) }); return; }
    if (type === "get_safety_grant") { send(ws, "safety_grant_status", { safetyGrant: store.safetyGrantStatus(profile), profile }); return; }
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
      profile = null;
      send(ws, "account_deleted", {});
      broadcastRoomList();
      for (const clientSocket of sockets.values()) sendLeaderboard(clientSocket);
      console.log(`[player] ${deletedProfile.username} deleted their account`);
      return;
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
      sendLeaderboard(ws);
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
      sendLeaderboard(ws);
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
      send(ws, "left_room", { profile });
      return;
    }
    if (type === "take_seat") { room.addPlayer(profile); broadcast(room); return; }
    if (type === "become_spectator") { room.becomeSpectator(profile.id); await saveRoomProfiles(room); broadcast(room); return; }
    if (!room.players.has(profile.id)) throw Error("You are spectating this round");
    if (room.game === "roulette") {
      if (type === "roulette_bet") room.placeBet(profile.id, message.bet, Number(message.amount));
      else if (type === "roulette_clear_bets") room.clearBets(profile.id);
      else if (type === "ready") room.readyPlayer(profile.id);
      else if (type === "unready") room.unreadyPlayer(profile.id);
      else throw Error("Unknown roulette action");
    }
    else if (type === "bet") room.placeBet(profile.id, Number(message.amount));
    else if (type === "ready") room.readyPlayer(profile.id);
    else if (type === "unready") room.unreadyPlayer(profile.id);
    else if (type === "start") room.startIfReady(); else if (type === "hit") room.hit(profile.id); else if (type === "stand") room.stand(profile.id); else if (type === "dealer_hit") room.dealerHit(profile.id); else if (type === "dealer_stand") room.dealerStand(profile.id); else if (type === "double") room.double(profile.id); else if (type === "split") room.split(profile.id); else if (type === "surrender") room.surrender(profile.id); else if (type === "next_round") room.nextRound(); else if (type === "become_dealer") room.setDealer(profile.id); else if (type === "leave_dealer") room.removeDealer(profile.id); else if (type === "leave_dealer_queue") room.cancelDealerRequest(profile.id); else throw Error("Unknown action");
    await saveRoomProfiles(room); broadcast(room);
    if (room.phase !== phaseBeforeAction) broadcastRoomList();
  } catch (error) {
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
    for (const room of rooms.values()) if (room.players.has(profile.id) || room.spectators.has(profile.id)) void removeFromRoom(room, profile);
  });
});

await store.initialize();
for (const profile of await store.loadAll()) accounts.set(profile.id, profile);
for (const authRecord of await store.loadAuthAccounts()) {
  authByPlayer.set(authRecord.playerId, authRecord);
  if (authRecord.googleSub) playerByGoogleSubject.set(authRecord.googleSub, authRecord.playerId);
}
server.listen(process.env.PORT || 3000, () => console.log(`Blackjack server listening with ${process.env.DATABASE_URL ? "PostgreSQL" : "file"} persistence; Google auth ${isGoogleAuthConfigured() ? "enabled" : "disabled"}`));
