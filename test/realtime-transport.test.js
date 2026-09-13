import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeTransport } from "../src/realtime-transport.js";
import { TrafficMetrics } from "../src/traffic-metrics.js";

const socket = () => ({ OPEN: 1, readyState: 1, messages: [], send(message) { this.messages.push(JSON.parse(message)); } });

test("transport sends one snapshot then only meaningful versioned room deltas", () => {
  const metrics = new TrafficMetrics({ intervalSeconds: 0, logger: () => {} });
  const transport = new RealtimeTransport({ metrics });
  const ws = socket();
  const state = { code: "ABLE", phase: "lobby", players: [{ id: "p1", cards: [] }] };
  const room = {
    code: "ABLE",
    players: new Map([["p1", {}]]),
    spectators: new Map(),
    publicState: () => state,
  };
  transport.broadcastRoom(room, new Map([["p1", ws]]));
  transport.broadcastRoom(room, new Map([["p1", ws]]));
  state.players[0].cards.push({ rank: "A" });
  transport.broadcastRoom(room, new Map([["p1", ws]]));
  assert.equal(ws.messages.length, 2);
  assert.equal(ws.messages[0].type, "room_snapshot");
  assert.equal(ws.messages[1].type, "room_delta");
  assert.equal(ws.messages[1].baseVersion, 1);
  assert.equal(ws.messages[1].version, 2);
});

test("forget forces a fresh snapshot for a later room session", () => {
  const transport = new RealtimeTransport({ metrics: new TrafficMetrics({ intervalSeconds: 0, logger: () => {} }) });
  const ws = socket();
  const room = { code: "ABLE", publicState: () => ({ code: "ABLE" }) };
  transport.sendRoomUpdate(room, "p1", ws);
  transport.forget(ws);
  transport.sendRoomUpdate(room, "p1", ws);
  assert.deepEqual(ws.messages.map(message => message.type), ["room_snapshot", "room_snapshot"]);
});
