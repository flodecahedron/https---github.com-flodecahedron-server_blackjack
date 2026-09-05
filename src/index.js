import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { dailyReward } from "./blackjack.js";
import { GameRoom } from "./game-room.js";
import { PlayerStore } from "./player-store.js";

const accounts = new Map(), rooms = new Map(), sockets = new Map(), store = new PlayerStore();
const id = () => crypto.randomUUID();
const send = (ws, type, payload) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type, ...payload }));
const fail = (ws, message) => send(ws, "error", { message });
const roomCode = () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  // Four letters fit the mobile UI while providing 456,976 possible table codes.
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = Array.from(crypto.randomBytes(4), byte => alphabet[byte % alphabet.length]).join("");
    if (!rooms.has(code)) return code;
  }
  throw Error("Impossible de générer un code de table, réessayez");
};
const broadcast = room => { for (const [playerId] of room.players) if (sockets.has(playerId)) send(sockets.get(playerId), "room_state", { room: room.publicState(playerId) }); };
const saveRoomProfiles = room => Promise.all([...room.players.values()].map(player => store.save(player.profile, accounts)));
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
  ws.on("message", async raw => { try {
    const message = JSON.parse(raw); const { type } = message;
    if (type === "register") {
      const username = String(message.username ?? "").trim();
      if (!/^[\w-]{3,16}$/.test(username)) throw Error("Pseudo: 3 à 16 caractères");
      if ([...accounts.values()].some(account => account.username.toLowerCase() === username.toLowerCase())) throw Error("Pseudo déjà utilisé");
      profile = { id: id(), username, avatar: String(message.avatar ?? ""), balance: 1000, loginStreak: 0, lastLogin: null };
      accounts.set(profile.id, profile); replaceActiveSocket(profile.id, ws);
      const reward = dailyReward(profile); await store.save(profile, accounts);
      send(ws, "authenticated", { profile, dailyReward: reward }); return;
    }
    if (type === "login") {
      profile = accounts.get(String(message.accountId)); if (!profile) throw Error("Compte introuvable");
      replaceActiveSocket(profile.id, ws); const reward = dailyReward(profile); await store.save(profile, accounts);
      send(ws, "authenticated", { profile, dailyReward: reward }); return;
    }
    if (!profile) throw Error("Authentication required");
    if (type === "create_room") { const code = roomCode(); const room = new GameRoom({ code, name: code, host: profile }); rooms.set(room.code, room); broadcast(room); return; }
    if (type === "join_room") { const room = rooms.get(String(message.code)); if (!room) throw Error("Room not found"); room.addPlayer(profile); broadcast(room); return; }
    const room = [...rooms.values()].find(candidate => candidate.players.has(profile.id)); if (!room) throw Error("Join a room first");
    if (type === "bet") room.placeBet(profile.id, Number(message.amount));
    else if (type === "start") room.startIfReady(); else if (type === "hit") room.hit(profile.id); else if (type === "stand") room.stand(profile.id); else if (type === "dealer_hit") room.dealerHit(profile.id); else if (type === "dealer_stand") room.dealerStand(profile.id); else if (type === "double") room.double(profile.id); else if (type === "split") room.split(profile.id); else if (type === "surrender") room.surrender(profile.id); else if (type === "next_round") room.nextRound(); else if (type === "become_dealer") room.setDealer(profile.id); else throw Error("Unknown action");
    await saveRoomProfiles(room); broadcast(room);
  } catch (error) { fail(ws, error.message); } });
  ws.on("close", () => {
    // Do not remove a player when an older socket closes after a reconnect.
    if (!profile || sockets.get(profile.id) !== ws) return;
    sockets.delete(profile.id);
    for (const room of rooms.values()) if (room.players.has(profile.id)) {
      room.removePlayer(profile.id);
      broadcast(room);
      if (!room.players.size) rooms.delete(room.code);
    }
  });
});

await store.initialize();
for (const profile of await store.loadAll()) accounts.set(profile.id, profile);
server.listen(process.env.PORT || 3000, () => console.log(`Blackjack server listening with ${process.env.DATABASE_URL ? "PostgreSQL" : "file"} persistence`));
