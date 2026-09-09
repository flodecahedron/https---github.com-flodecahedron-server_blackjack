import test from "node:test";
import assert from "node:assert/strict";
import { AMERICAN_WHEEL, RouletteRoom } from "../src/roulette-room.js";

const profile = (id, balance = 1000) => ({ id, username: id, balance });

test("american wheel contains 0, 00 and every number from 1 to 36", () => {
  assert.equal(AMERICAN_WHEEL.length, 38);
  assert.deepEqual(new Set(AMERICAN_WHEEL), new Set(["0", "00", ...Array.from({ length: 36 }, (_, index) => String(index + 1))]));
});

test("straight, red and dozen bets pay the casino multipliers", () => {
  const player = profile("player");
  const room = new RouletteRoom({ code: "ABLE", name: "ABLE", host: player });
  room.placeBet(player.id, { kind: "straight", value: "7" }, 10);
  room.placeBet(player.id, { kind: "red", value: "red" }, 10);
  room.placeBet(player.id, { kind: "dozen", value: "1" }, 10);
  room.phase = "spinning";
  room.winningPocket = "7";
  room.settle();
  assert.equal(player.balance, 1380);
  assert.equal(room.player(player.id).result.net, 380);
});

test("0 and 00 lose every outside bet", () => {
  for (const pocket of ["0", "00"]) {
    const player = profile(`player-${pocket}`);
    const room = new RouletteRoom({ code: "ABLE", name: "ABLE", host: player });
    room.placeBet(player.id, { kind: "red", value: "red" }, 25);
    room.placeBet(player.id, { kind: "even", value: "even" }, 25);
    room.phase = "spinning";
    room.winningPocket = pocket;
    room.settle();
    assert.equal(player.balance, 950);
    assert.equal(room.player(player.id).result.net, -50);
  }
});

test("clearing bets refunds the stake before the spin", () => {
  const player = profile("player", 100);
  const room = new RouletteRoom({ code: "ABLE", name: "ABLE", host: player });
  room.placeBet(player.id, { kind: "black", value: "black" }, 25);
  room.clearBets(player.id);
  assert.equal(player.balance, 100);
  assert.deepEqual(room.player(player.id).bets, []);
});

test("a betting spectator receives every uncommitted chip back", () => {
  const player = profile("player", 100);
  const room = new RouletteRoom({ code: "ABLE", name: "ABLE", host: player });
  room.placeBet(player.id, { kind: "straight", value: "00" }, 20);
  room.becomeSpectator(player.id);
  assert.equal(player.balance, 100);
  assert.equal(room.players.has(player.id), false);
  assert.equal(room.spectators.has(player.id), true);
  assert.equal(room.publicState(player.id).viewerBalance, 100);
});

test("multiplayer clients share one authoritative spin", () => {
  const first = profile("first");
  const second = profile("second");
  const room = new RouletteRoom({ code: "ABLE", name: "ABLE", host: first });
  room.addPlayer(second);
  room.placeBet(first.id, { kind: "odd", value: "odd" }, 10);
  room.placeBet(second.id, { kind: "black", value: "black" }, 10);
  room.readyPlayer(first.id);
  assert.equal(room.phase, "betting");
  room.readyPlayer(second.id);
  assert.equal(room.phase, "spinning");
  assert.equal(room.publicState(first.id).winningPocket, room.publicState(second.id).winningPocket);
  room.clearRoundTimers();
});
