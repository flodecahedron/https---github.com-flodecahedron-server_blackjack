import test from "node:test";
import assert from "node:assert/strict";
import { applyRoomAction } from "../src/room-actions.js";

test("room action router forwards typed blackjack data", () => {
  const calls = [];
  const room = { game: "blackjack", placeBet: (...args) => calls.push(args) };
  applyRoomAction(room, "p1", "bet", { amount: "25" });
  assert.deepEqual(calls, [["p1", 25]]);
});

test("room action router keeps roulette payloads together", () => {
  const calls = [];
  const room = { game: "roulette", placeBet: (...args) => calls.push(args) };
  const bet = { kind: "red", value: "red" };
  applyRoomAction(room, "p1", "roulette_bet", { bet, amount: "10" });
  assert.deepEqual(calls, [["p1", bet, 10]]);
});

test("room action router rejects actions from the wrong game", () => {
  assert.throws(() => applyRoomAction({ game: "roulette" }, "p1", "hit", {}), /Unknown roulette action/);
});
