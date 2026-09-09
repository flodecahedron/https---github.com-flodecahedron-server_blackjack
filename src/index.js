import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { DAILY_ROULETTE_SEGMENTS, claimDailyRoulette, dailyReward, dailyRouletteStatus } from "./blackjack.js";
import { GameRoom } from "./game-room.js";
import { RouletteRoom } from "./roulette-room.js";
import { PlayerStore } from "./player-store.js";

const accounts = new Map(), rooms = new Map(), sockets = new Map(), store = new PlayerStore();
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
const saveRoomProfiles = room => Promise.all([
  ...[...room.players.values()].map(player => player.profile),
  ...room.spectators.values(),
].map(profile => store.save(profile, accounts)));
const removeFromRoom = async (room, profile) => {
  try {
    room.leavePlayer(profile.id);
  } catch (error) {
    console.error(`[room] Forced removal of ${profile.username} from ${room.code}: ${error.message}`);
    room.players.delete(profile.id); room.spectators.delete(profile.id);
    if (room.dealer.type === "player" && room.dealer.playerId === profile.id) room.dealer = { type: "bot", name: "Casino", bankroll: Infinity, cards: [] };
  }
  try { await store.save(profile, accounts); } catch (error) { console.error(`[store] Could not save ${profile.username} after leaving: ${error.message}`); }
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

const server = http.createServer((req, res) => { res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "ok", persistence: process.env.DATABASE_URL ? "postgres" : "file" })); });
const wss = new WebSocketServer({ server });
wss.on("connection", ws => {
  let profile = null;
  let messageType = "unknown";
  console.log("[socket] Client connected");
  ws.on("message", async raw => { try {
    const message = JSON.parse(raw); const { type } = message;
    messageType = String(type ?? "unknown");
    console.log(`[message] ${profile?.username ?? "anonymous"} → ${messageType}`);
    if (type === "register") {
      const username = String(message.username ?? "").trim();
      if (!/^[\w-]{3,16}$/.test(username)) throw Error("Pseudo: 3 à 16 caractères");
      if ([...accounts.values()].some(account => account.username.toLowerCase() === username.toLowerCase())) throw Error("Pseudo déjà utilisé");
      profile = { id: id(), username, avatar: String(message.avatar ?? ""), balance: 1000, loginStreak: 0, lastLogin: null, lastRoulette: null };
      accounts.set(profile.id, profile); replaceActiveSocket(profile.id, ws);
      const dailyGift = dailyReward(profile); await store.save(profile, accounts);
      console.log(`[player] ${profile.username} created an account and connected`);
      send(ws, "authenticated", { profile, dailyReward: dailyGift.amount, dailyGift, dailyRoulette: dailyRouletteStatus(profile) }); sendRoomList(ws); sendLeaderboard(ws); return;
    }
    if (type === "login") {
      profile = accounts.get(String(message.accountId)); if (!profile) throw Error("Compte introuvable");
      replaceActiveSocket(profile.id, ws); const dailyGift = dailyReward(profile); await store.save(profile, accounts);
      console.log(`[player] ${profile.username} connected`);
      send(ws, "authenticated", { profile, dailyReward: dailyGift.amount, dailyGift, dailyRoulette: dailyRouletteStatus(profile) }); sendRoomList(ws); sendLeaderboard(ws); return;
    }
    if (!profile) throw Error("Authentication required");
    if (type === "ping") { send(ws, "pong", {}); return; }
    if (type === "list_rooms") { sendRoomList(ws); return; }
    if (type === "get_leaderboard") { sendLeaderboard(ws); return; }
    if (type === "get_daily_roulette") { send(ws, "daily_roulette_status", { roulette: dailyRouletteStatus(profile) }); return; }
    if (type === "claim_daily_roulette") {
      const rouletteResult = claimDailyRoulette(profile, crypto.randomInt(DAILY_ROULETTE_SEGMENTS.length));
      await store.save(profile, accounts);
      send(ws, "daily_roulette_result", rouletteResult);
      sendLeaderboard(ws);
      return;
    }
    if (type === "create_room") {
      const code = roomCode();
      const game = String(message.game ?? "blackjack");
      const RoomClass = game === "roulette" ? RouletteRoom : GameRoom;
      const room = new RoomClass({ code, name: code, host: profile, onUpdate: updatedRoom => void saveRoomProfiles(updatedRoom).then(() => { broadcast(updatedRoom); broadcastRoomList(); }) });
      rooms.set(room.code, room); console.log(`[room] ${profile.username} created ${room.game} table ${code}`); broadcast(room); broadcastRoomList(); return;
    }
    if (type === "join_room") { const room = rooms.get(String(message.code ?? "").trim().toUpperCase()); if (!room) throw Error("Room not found"); const seatsOpen = room.game === "roulette" ? room.phase === "betting" : room.phase === "lobby"; if (seatsOpen) room.addPlayer(profile); else room.addSpectator(profile); await store.save(profile, accounts); console.log(`[room] ${profile.username} joined ${room.game} table ${room.code} as ${seatsOpen ? "player" : "spectator"}`); broadcast(room); broadcastRoomList(); return; }
    if (type === "spectate_room") { const room = rooms.get(String(message.code ?? "").trim().toUpperCase()); if (!room) throw Error("Room not found"); const currentRoom = [...rooms.values()].find(candidate => candidate.players.has(profile.id) || candidate.spectators.has(profile.id)); if (currentRoom && currentRoom !== room) throw Error("Leave your current room first"); if (!currentRoom) room.addSpectator(profile); await store.save(profile, accounts); console.log(`[room] ${profile.username} joined table ${room.code} as spectator`); broadcast(room); broadcastRoomList(); return; }
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
        await store.save(profile, accounts);
        console.log(`[room] ${profile.username} resumed table ${room.code}`);
        broadcast(room); broadcastRoomList();
      } catch (error) {
        send(ws, "room_resume_failed", { message: error.message });
      }
      return;
    }
    const room = [...rooms.values()].find(candidate => candidate.players.has(profile.id) || candidate.spectators.has(profile.id)); if (!room) throw Error("Join a room first");
    if (type === "leave_room") {
      await removeFromRoom(room, profile);
      send(ws, "left_room", { profile });
      return;
    }
    if (type === "take_seat") { room.addPlayer(profile); await store.save(profile, accounts); broadcast(room); return; }
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
    else if (type === "start") room.startIfReady(); else if (type === "hit") room.hit(profile.id); else if (type === "stand") room.stand(profile.id); else if (type === "dealer_hit") room.dealerHit(profile.id); else if (type === "dealer_stand") room.dealerStand(profile.id); else if (type === "double") room.double(profile.id); else if (type === "split") room.split(profile.id); else if (type === "surrender") room.surrender(profile.id); else if (type === "next_round") room.nextRound(); else if (type === "become_dealer") room.setDealer(profile.id); else if (type === "leave_dealer") room.removeDealer(profile.id); else throw Error("Unknown action");
    await saveRoomProfiles(room); broadcast(room); broadcastRoomList();
  } catch (error) {
    console.warn(`[error] ${profile?.username ?? "anonymous"} → ${messageType}: ${error.message}`);
    fail(ws, error.message);
  } });
  ws.on("close", () => {
    // Do not remove a player when an older socket closes after a reconnect.
    if (!profile || sockets.get(profile.id) !== ws) return;
    console.log(`[player] ${profile.username} disconnected`);
    sockets.delete(profile.id);
    for (const room of rooms.values()) if (room.players.has(profile.id) || room.spectators.has(profile.id)) void removeFromRoom(room, profile);
  });
});

await store.initialize();
for (const profile of await store.loadAll()) accounts.set(profile.id, profile);
server.listen(process.env.PORT || 3000, () => console.log(`Blackjack server listening with ${process.env.DATABASE_URL ? "PostgreSQL" : "file"} persistence`));
