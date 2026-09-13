import { createRoomDelta } from "./room-delta.js";

/**
 * Owns WebSocket serialization and per-client room delivery state. Game and
 * authentication code only deal with domain payloads through this boundary.
 */
export class RealtimeTransport {
  constructor({ metrics }) {
    this.metrics = metrics;
    this.deliveredRoomStates = new WeakMap();
  }

  send(ws, type, payload = {}) {
    if (ws.readyState !== ws.OPEN) return false;
    const serialized = JSON.stringify({ type, ...payload });
    this.metrics.recordOutbound(type, serialized);
    ws.send(serialized);
    return true;
  }

  fail(ws, message) { return this.send(ws, "error", { message }); }
  forget(ws) { this.deliveredRoomStates.delete(ws); }

  sendRoomSnapshot(room, playerId, ws) {
    const state = structuredClone(room.publicState(playerId));
    const version = (this.deliveredRoomStates.get(ws)?.version ?? 0) + 1;
    this.deliveredRoomStates.set(ws, { code: room.code, version, state });
    this.send(ws, "room_snapshot", { room: state, version });
  }

  sendRoomUpdate(room, playerId, ws) {
    const previous = this.deliveredRoomStates.get(ws);
    if (!previous || previous.code !== room.code) {
      this.sendRoomSnapshot(room, playerId, ws);
      return;
    }
    const state = structuredClone(room.publicState(playerId));
    const operations = createRoomDelta(previous.state, state);
    if (!operations.length) return;
    const version = previous.version + 1;
    this.deliveredRoomStates.set(ws, { code: room.code, version, state });
    this.send(ws, "room_delta", { code: room.code, baseVersion: previous.version, version, operations });
  }

  broadcastRoom(room, sockets) {
    for (const playerId of [...room.players.keys(), ...room.spectators.keys()]) {
      const ws = sockets.get(playerId);
      if (ws) this.sendRoomUpdate(room, playerId, ws);
    }
  }
}
