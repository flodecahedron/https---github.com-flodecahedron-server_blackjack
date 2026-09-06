import test from "node:test";
import assert from "node:assert/strict";
import { canSplit, fibonacci, handValue, isBlackjack } from "../src/blackjack.js";
import { GameRoom } from "../src/game-room.js";

const card = (rank) => ({ rank, suit: "spades" });

test("ace is reduced from 11 to 1 to avoid bust", () => {
  assert.deepEqual(handValue([card("A"), card("9"), card("8")]), { total: 18, soft: false });
  assert.equal(handValue([card("A"), card("6")]).total, 17);
});

test("natural blackjack has exactly two cards", () => {
  assert.equal(isBlackjack({ cards: [card("A"), card("K")] }), true);
  assert.equal(isBlackjack({ cards: [card("A"), card("5"), card("5")] }), false);
});

test("split requires matching ranks and available matching stake", () => {
  assert.equal(canSplit({ cards: [card("8"), card("8")], bet: 20 }, 20), true);
  assert.equal(canSplit({ cards: [card("10"), card("K")], bet: 20 }, 20), true);
  assert.equal(canSplit({ cards: [card("8"), card("9")], bet: 20 }, 20), false);
});

test("daily rewards follow Fibonacci", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(fibonacci), [0, 1, 1, 2, 3, 5, 8]);
});

test("first player receives a turn after the initial deal", () => {
  const profile = { id: "player-1", username: "Test", balance: 1000 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: profile });
  room.placeBet(profile.id, 10);
  room.player(profile.id).ready = true;
  // draw() pops: player 10, dealer 10, player 7, dealer 6.
  room.shoe = [...Array.from({ length: 48 }, () => card("2")), card("6"), card("7"), card("10"), card("10")];
  room.startIfReady();
  assert.equal(room.phase, "player_turn");
  assert.deepEqual(room.current, { playerId: profile.id, handIndex: 0 });
});

test("a bet below ten is valid and allows the round to start", () => {
  const profile = { id: "player-1", username: "Test", balance: 1000 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: profile });
  room.placeBet(profile.id, 1);
  room.player(profile.id).ready = true;
  room.shoe = [...Array.from({ length: 48 }, () => card("2")), card("6"), card("7"), card("10"), card("10")];
  room.startIfReady();
  assert.equal(room.phase, "player_turn");
});

test("a bust is published as a round event immediately", () => {
  const profile = { id: "player-1", username: "Test", balance: 1000 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: profile });
  room.placeBet(profile.id, 1);
  room.player(profile.id).ready = true;
  room.shoe = [...Array.from({ length: 47 }, () => card("2")), card("K"), card("6"), card("10"), card("10"), card("8")];
  room.startIfReady();
  room.hit(profile.id);
  assert.deepEqual(room.roundEvents.at(-1), { id: 1, playerId: profile.id, type: "bust" });
});

test("a human dealer receives a losing player's stake", () => {
  const dealer = { id: "dealer", username: "Dealer", balance: 5000 };
  const player = { id: "player", username: "Player", balance: 100 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: dealer });
  room.addPlayer(player);
  room.setDealer(dealer.id);
  room.placeBet(player.id, 10);
  room.player(player.id).ready = true;
  room.player(player.id).hands[0].cards = [card("10"), card("6")];
  room.dealer.cards = [card("10"), card("7")];
  room.settle();
  assert.equal(dealer.balance, 5010);
  assert.equal(player.balance, 90);
  assert.deepEqual(room.roundResults.get(player.id).hands, [{ outcome: "loss", net: -10 }]);
});

test("split hands settle independently against a human dealer", () => {
  const dealer = { id: "dealer", username: "Dealer", balance: 5000 };
  const player = { id: "player", username: "Player", balance: 100 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: dealer });
  room.addPlayer(player);
  room.setDealer(dealer.id);
  room.placeBet(player.id, 10);
  room.player(player.id).ready = true;
  const playerState = room.player(player.id);
  playerState.hands = [
    { cards: [card("10"), card("10"), card("5")], chips: [10], bet: 10, status: "stood", fromSplit: true },
    { cards: [card("10"), card("9")], chips: [10], bet: 10, status: "stood", fromSplit: true },
  ];
  player.balance -= 10;
  dealer.balance += 10;
  room.dealer.cards = [card("10"), card("7")];
  room.settle();
  assert.equal(dealer.balance, 5000);
  assert.equal(player.balance, 100);
  assert.deepEqual(room.roundResults.get(player.id).hands, [
    { outcome: "loss", net: -10 },
    { outcome: "win", net: 10 },
  ]);
});

test("dealer bankroll sets a per-player bet cap that covers blackjack", () => {
  const dealer = { id: "dealer", username: "Dealer", balance: 150 };
  const player = { id: "player", username: "Player", balance: 1000 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: dealer });
  room.addPlayer(player);
  room.setDealer(dealer.id);
  room.placeBet(player.id, 100);
  assert.throws(() => room.placeBet(player.id, 1), /table limit/);
});

test("leaving human dealer pays every active player as a winner", () => {
  const dealer = { id: "dealer", username: "Dealer", balance: 5000 };
  const player = { id: "player", username: "Player", balance: 100 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: dealer });
  room.addPlayer(player);
  room.setDealer(dealer.id);
  room.placeBet(player.id, 10);
  room.player(player.id).ready = true;
  room.phase = "player_turn";
  room.current = { playerId: player.id, handIndex: 0 };
  room.leavePlayer(dealer.id);
  assert.equal(room.phase, "settlement");
  assert.equal(player.balance, 110);
  assert.equal(dealer.balance, 4990);
  assert.deepEqual(room.roundResults.get(player.id).hands, [{ outcome: "win", net: 10 }]);
});

test("a player with no chips after settlement receives the casino safety grant", () => {
  const profile = { id: "player-1", username: "Test", balance: 1 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: profile });
  room.placeBet(profile.id, 1);
  room.player(profile.id).ready = true;
  room.player(profile.id).hands[0].cards = [card("10"), card("8"), card("K")];
  room.dealer.cards = [card("10"), card("7")];
  room.settle();
  assert.equal(profile.balance, 100);
  assert.equal(room.roundEvents.at(-1).type, "casino_gift");
});

test("a player is restored to 100 chips when joining a room with no balance", () => {
  const host = { id: "host", username: "Host", balance: 1000 };
  const brokePlayer = { id: "broke", username: "Broke", balance: 0 };
  const room = new GameRoom({ code: "1234", name: "TEST", host });
  room.addPlayer(brokePlayer);
  assert.equal(brokePlayer.balance, 100);
});

test("spectating during betting refunds the player's stake", () => {
  const host = { id: "host", username: "Host", balance: 1000 };
  const player = { id: "player", username: "Player", balance: 100 };
  const room = new GameRoom({ code: "1234", name: "TEST", host });
  room.addPlayer(player);
  room.placeBet(player.id, 25);
  room.becomeSpectator(player.id);
  assert.equal(player.balance, 100);
  assert.equal(room.players.has(player.id), false);
  assert.equal(room.spectators.has(player.id), true);
});

test("a human dealer becoming spectator returns the dealer role to the casino", () => {
  const dealer = { id: "dealer", username: "Dealer", balance: 1000 };
  const player = { id: "player", username: "Player", balance: 100 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: dealer });
  room.addPlayer(player);
  room.setDealer(dealer.id);
  room.placeBet(player.id, 20);
  room.becomeSpectator(dealer.id);
  assert.equal(room.dealer.type, "bot");
  assert.equal(dealer.balance, 1000);
  assert.equal(room.spectators.has(dealer.id), true);
});

test("a player cannot become dealer after a bet is placed", () => {
  const host = { id: "host", username: "Host", balance: 1000 };
  const player = { id: "player", username: "Player", balance: 100 };
  const room = new GameRoom({ code: "1234", name: "TEST", host });
  room.addPlayer(player);
  room.placeBet(player.id, 10);
  assert.throws(() => room.setDealer(host.id), /before any bet/);
});

test("a human dealer must complete a round before leaving the role", () => {
  const dealer = { id: "dealer", username: "Dealer", balance: 1000 };
  const player = { id: "player", username: "Player", balance: 100 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: dealer });
  room.addPlayer(player);
  room.setDealer(dealer.id);
  assert.throws(() => room.removeDealer(dealer.id), /Play one round/);
  room.dealer.hasCompletedRound = true;
  room.removeDealer(dealer.id);
  assert.equal(room.dealer.type, "bot");
});

test("betting timeout refunds an unready player before spectating", () => {
  const host = { id: "host", username: "Host", balance: 1000 };
  const player = { id: "player", username: "Player", balance: 100 };
  const room = new GameRoom({ code: "1234", name: "TEST", host });
  room.addPlayer(player);
  room.placeBet(player.id, 25);
  room.expireBetting();
  assert.equal(player.balance, 100);
  assert.equal(room.players.has(player.id), false);
  assert.equal(room.spectators.has(player.id), true);
});

test("a ready player can cancel readiness during betting", () => {
  const host = { id: "host", username: "Host", balance: 100 };
  const player = { id: "player", username: "Player", balance: 100 };
  const room = new GameRoom({ code: "1234", name: "TEST", host });
  room.addPlayer(player);
  room.placeBet(host.id, 10);
  room.placeBet(player.id, 10);
  room.readyPlayer(host.id);
  room.unreadyPlayer(host.id);
  assert.equal(room.player(host.id).ready, false);
});
