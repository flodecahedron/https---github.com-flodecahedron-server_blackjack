import test from "node:test";
import assert from "node:assert/strict";
import { applyRoomDelta, createRoomDelta } from "../src/room-delta.js";

test("room delta appends a dealt card without replacing the player list", () => {
  const previous = { phase: "playing", players: [{ id: "p1", hands: [{ cards: [{ rank: "A" }] }] }] };
  const next = { phase: "playing", players: [{ id: "p1", hands: [{ cards: [{ rank: "A" }, { rank: "10" }] }] }] };
  const operations = createRoomDelta(previous, next);
  assert.deepEqual(operations, [{ op: "set", path: ["players", 0, "hands", 0, "cards", 1], value: { rank: "10" } }]);
  assert.deepEqual(applyRoomDelta(previous, operations), next);
});

test("room delta supports scalar changes and removals", () => {
  const previous = { phase: "lobby", timerEndsAt: 12, spectators: ["Ada", "Bob"] };
  const next = { phase: "playing", spectators: ["Ada"] };
  const operations = createRoomDelta(previous, next);
  assert.deepEqual(applyRoomDelta(previous, operations), next);
});
