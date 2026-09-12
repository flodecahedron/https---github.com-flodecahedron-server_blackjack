import test from "node:test";
import assert from "node:assert/strict";
import { DAILY_ROULETTE_SEGMENTS, canSplit, claimDailyRoulette, dailyReward, dailyRouletteStatus, handValue, isBlackjack } from "../src/blackjack.js";
import { GameRoom } from "../src/game-room.js";
import { PlayerStore } from "../src/player-store.js";

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
  assert.equal(dealer.balance, 5000);
  assert.equal(room.dealerEscrow, 10);
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
  room.changeBalance(player, -10, "blackjack_split");
  room.dealerEscrow += 10;
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

test("daily gift is awarded once per UTC day and tracks the streak", () => {
  const profile = { balance: 1000, loginStreak: 0, lastLogin: null };
  const first = dailyReward(profile, new Date("2026-09-01T12:00:00Z"));
  const duplicate = dailyReward(profile, new Date("2026-09-01T22:00:00Z"));
  const second = dailyReward(profile, new Date("2026-09-02T08:00:00Z"));
  assert.deepEqual([first.amount, duplicate.amount, second.amount], [50, 0, 75]);
  assert.equal(profile.balance, 1125);
  assert.equal(profile.loginStreak, 2);
  assert.equal(profile.lastLogin, "2026-09-02");
});

test("daily gift streak restarts after a missed day", () => {
  const profile = { balance: 1000, loginStreak: 5, lastLogin: "2026-09-01" };
  const gift = dailyReward(profile, new Date("2026-09-03T08:00:00Z"));
  assert.equal(gift.amount, 50);
  assert.equal(gift.streak, 1);
});

test("daily roulette can be claimed only once per UTC day", () => {
  const profile = { balance: 1000, lastRoulette: null };
  const claimed = claimDailyRoulette(profile, 11, new Date("2026-09-01T12:00:00Z"));
  assert.equal(claimed.amount, 1000);
  assert.equal(profile.balance, 2000);
  assert.equal(dailyRouletteStatus(profile, new Date("2026-09-01T22:00:00Z")).available, false);
  assert.throws(() => claimDailyRoulette(profile, 0, new Date("2026-09-01T22:00:00Z")), /déjà été jouée/);
  assert.equal(dailyRouletteStatus(profile, new Date("2026-09-02T00:00:00Z")).available, true);
});

test("daily roulette prize frequency decreases as values rise", () => {
  const frequencies = new Map();
  for (const amount of DAILY_ROULETTE_SEGMENTS) frequencies.set(amount, (frequencies.get(amount) ?? 0) + 1);
  const orderedPrizes = [10, 20, 50, 100, 500, 1000];
  for (let index = 1; index < orderedPrizes.length; index++) {
    assert.ok(frequencies.get(orderedPrizes[index - 1]) > frequencies.get(orderedPrizes[index]));
  }
});

test("settlement leaves a broke player eligible for the separate safety grant", async () => {
  const profile = { id: "player-1", username: "Test", balance: 1 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: profile });
  room.placeBet(profile.id, 1);
  room.player(profile.id).ready = true;
  room.player(profile.id).hands[0].cards = [card("10"), card("8"), card("K")];
  room.dealer.cards = [card("10"), card("7")];
  room.settle();
  assert.equal(profile.balance, 0);
  const store = new PlayerStore();
  store.save = async () => {};
  const grant = await store.claimSafetyGrant(profile, new Map([[profile.id, profile]]), { now: new Date("2026-09-01T12:00:00Z") });
  assert.equal(grant.granted, true);
  assert.equal(grant.kind, "free");
  assert.equal(profile.balance, 100);
});

test("the safety net grants once freely, then uses capped simulated rewarded grants", async () => {
  const profile = { id: "broke", username: "Broke", balance: 0 };
  const accounts = new Map([[profile.id, profile]]);
  const store = new PlayerStore();
  store.save = async () => {};
  const now = new Date("2026-09-01T12:00:00Z");
  const free = await store.claimSafetyGrant(profile, accounts, { now });
  assert.equal(free.kind, "free");
  for (let index = 0; index < 3; index++) {
    profile.balance = 0;
    const rewarded = await store.claimSafetyGrant(profile, accounts, { rewarded: true, now });
    assert.equal(rewarded.kind, "rewarded_simulated");
  }
  profile.balance = 0;
  const capped = await store.claimSafetyGrant(profile, accounts, { rewarded: true, now });
  assert.equal(capped.granted, false);
  assert.equal(capped.reason, "rewarded_unavailable");
});

test("joining a room does not silently mint chips outside the economy service", () => {
  const host = { id: "host", username: "Host", balance: 1000 };
  const brokePlayer = { id: "broke", username: "Broke", balance: 0 };
  const room = new GameRoom({ code: "1234", name: "TEST", host });
  room.addPlayer(brokePlayer);
  assert.equal(brokePlayer.balance, 0);
});

test("the shoe and card-back color change after every third completed round", () => {
  const profile = { id: "player-1", username: "Test", balance: 1000 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: profile });
  const previousColor = room.deckColor;
  const previousSerial = room.shuffleSerial;
  room.roundsSinceShuffle = 3;
  room.phase = "settlement";
  room.nextRound();
  assert.equal(room.shuffleSerial, previousSerial + 1);
  assert.notEqual(room.deckColor, previousColor);
  assert.equal(room.shoe.length, 312);
  assert.deepEqual(room.publicState(profile.id).deck, { color: room.deckColor, shuffleSerial: room.shuffleSerial });
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
  room.dealer.hasCompletedRound = true;
  assert.throws(() => room.becomeSpectator(dealer.id), /bets are cleared/);
  room.becomeSpectator(player.id);
  room.becomeSpectator(dealer.id);
  assert.equal(room.dealer.type, "bot");
  assert.equal(dealer.balance, 1000);
  assert.equal(room.spectators.has(dealer.id), true);
});

test("dealer volunteers wait in FIFO order and rotate after one completed round", () => {
  const first = { id: "first", username: "First", balance: 1000 };
  const second = { id: "second", username: "Second", balance: 1000 };
  const third = { id: "third", username: "Third", balance: 1000 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: first });
  room.addPlayer(second);
  room.addPlayer(third);
  room.setDealer(first.id);
  assert.equal(room.setDealer(second.id), "queued");
  assert.equal(room.setDealer(third.id), "queued");
  assert.equal(room.dealer.playerId, first.id);
  room.dealer.hasCompletedRound = true;
  room.phase = "settlement";
  room.nextRound();
  assert.equal(room.dealer.playerId, second.id);
  assert.deepEqual(room.dealerQueue, [third.id]);
});

test("a queued dealer volunteer can cancel without changing the active dealer", () => {
  const first = { id: "first", username: "First", balance: 1000 };
  const second = { id: "second", username: "Second", balance: 1000 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: first });
  room.addPlayer(second);
  room.setDealer(first.id);
  room.setDealer(second.id);
  room.cancelDealerRequest(second.id);
  assert.equal(room.dealer.playerId, first.id);
  assert.deepEqual(room.dealerQueue, []);
});

test("a human dealer's table limit is not inflated by held stakes", () => {
  const dealer = { id: "dealer", username: "Dealer", balance: 150 };
  const player = { id: "player", username: "Player", balance: 1000 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: dealer });
  room.addPlayer(player);
  room.setDealer(dealer.id);
  room.placeBet(player.id, 100);
  assert.equal(dealer.balance, 150);
  assert.equal(room.dealer.bankroll, 150);
  assert.throws(() => room.placeBet(player.id, 1), /table limit/);
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

test("leaving during the lobby refunds a bet even before ready", () => {
  const profile = { id: "player-1", username: "Test", balance: 100 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: profile });
  room.placeBet(profile.id, 25);
  room.leavePlayer(profile.id);
  assert.equal(profile.balance, 100);
  assert.equal(room.players.has(profile.id), false);
});

test("the current player can leave without breaking turn progression", () => {
  const first = { id: "first", username: "First", balance: 100 };
  const second = { id: "second", username: "Second", balance: 100 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: first });
  room.addPlayer(second);
  room.placeBet(first.id, 10); room.placeBet(second.id, 10);
  room.player(first.id).ready = true; room.player(second.id).ready = true;
  room.player(first.id).hands[0].status = "playing";
  room.player(second.id).hands[0].status = "playing";
  room.phase = "player_turn"; room.current = { playerId: first.id, handIndex: 0 };
  room.leavePlayer(first.id);
  assert.equal(room.players.has(first.id), false);
  assert.deepEqual(room.current, { playerId: second.id, handIndex: 0 });
});

test("a human dealer automatically stands when their timer expires", () => {
  const dealer = { id: "dealer", username: "Dealer", balance: 1000 };
  const player = { id: "player", username: "Player", balance: 100 };
  const room = new GameRoom({ code: "1234", name: "TEST", host: dealer });
  room.addPlayer(player); room.setDealer(dealer.id); room.placeBet(player.id, 10);
  room.player(player.id).ready = true;
  room.player(player.id).hands[0].cards = [card("10"), card("8")];
  room.dealer.cards = [card("10"), card("7")];
  let expireDealerTurn = null;
  room.schedule = callback => { expireDealerTurn = callback; return null; };
  room.dealerTurn();
  assert.equal(room.phase, "dealer_turn");
  assert.ok(room.timerEndsAt > Date.now());
  expireDealerTurn();
  assert.equal(room.phase, "settlement");
  assert.equal(room.timerEndsAt, null);
});
