import crypto from "node:crypto";
import { canSplit, createShoe, handScores, handValue, isBlackjack } from "./blackjack.js";
import { RoomEconomy } from "./room-economy.js";

const DECK_COLORS = Object.freeze(["black", "blue", "green", "orange", "purple", "red"]);

function randomDeckColor(previousColor = null) {
  const available = previousColor ? DECK_COLORS.filter(color => color !== previousColor) : DECK_COLORS;
  return available[crypto.randomInt(available.length)];
}

export class GameRoom {
  constructor({ code, name, host, onUpdate = null }) {
    this.game = "blackjack";
    this.code = code; this.name = name; this.hostId = host.id;
    this.players = new Map([[host.id, { profile: host, hands: [], ready: false }]]);
    this.spectators = new Map(); this.onUpdate = onUpdate;
    this.dealer = { type: "bot", name: "Casino", bankroll: Infinity, cards: [] };
    this.dealerQueue = [];
    this.dealerEscrow = 0;
    this.roundId = 0;
    this.economy = new RoomEconomy(code);
    this.shoe = createShoe(); this.deckColor = randomDeckColor(); this.shuffleSerial = 0; this.roundsSinceShuffle = 0;
    this.phase = "lobby"; this.current = null; this.roundResults = new Map();
    this.roundEvents = []; this.nextEventId = 1; this.hasCompletedRound = false;
    this.betTimer = null; this.turnTimer = null; this.dealerTimer = null;
  }
  notify() { if (this.onUpdate) this.onUpdate(this); }
  schedule(callback, milliseconds) { const timer = setTimeout(callback, milliseconds); timer.unref?.(); return timer; }
  player(id) { return this.players.get(id); }
  publicState(viewerId) {
    const revealDealer = ["dealer_turn", "settlement", "lobby"].includes(this.phase);
    const requiredPlayers = [...this.players.values()].filter(player => player.profile.id !== this.dealer.playerId);
    return { game: this.game, code: this.code, name: this.name, phase: this.phase, currentPlayerId: this.current?.playerId ?? null, currentHandIndex: this.current?.handIndex ?? -1, readyCount: requiredPlayers.filter(player => player.ready).length, requiredCount: requiredPlayers.length, hasCompletedRound: this.hasCompletedRound, events: this.roundEvents, timerEndsAt: this.timerEndsAt ?? null, viewerRole: this.players.has(viewerId) ? "player" : "spectator", spectators: [...this.spectators.values()].map(profile => profile.username), deck: { color: this.deckColor, shuffleSerial: this.shuffleSerial }, dealerQueue: this.dealerQueue.map((id, index) => ({ id, name: this.player(id)?.profile.username ?? "Joueur", position: index + 1 })),
      dealer: { ...this.dealer, canLeaveRole: this.phase === "lobby" && this.dealer.type === "player" && this.dealer.hasCompletedRound && this.dealerEscrow === 0, cards: revealDealer ? this.dealer.cards : this.dealer.cards.map((card, i) => i ? { hidden: true } : card), value: revealDealer ? handValue(this.dealer.cards).total : null, scores: revealDealer ? handScores(this.dealer.cards) : [] },
      players: [...this.players.entries()].map(([id, player]) => ({ id, name: player.profile.username, balance: player.profile.balance, ready: player.ready, result: this.roundResults.get(id) ?? null,
        hands: player.hands.map((hand) => ({ ...hand, value: handValue(hand.cards).total, scores: handScores(hand.cards), blackjack: isBlackjack(hand),
          canDouble: hand.status === "playing" && hand.cards.length === 2 && player.profile.balance >= hand.bet && this.canAddStake(player, hand.bet),
          canSplit: hand.status === "playing" && canSplit(hand, player.profile.balance) && this.canAddStake(player, hand.bet),
          canSurrender: hand.status === "playing" && hand.cards.length === 2 && !hand.fromSplit })), self: id === viewerId, dealerQueued: this.dealerQueue.includes(id), dealerQueuePosition: this.dealerQueue.indexOf(id) + 1 })) };
  }
  pendingEconomyEvents() { return this.economy.pendingEvents(); }
  acknowledgeEconomyEvents(eventIds) { this.economy.acknowledge(eventIds); }
  changeBalance(profile, delta, reason) { this.economy.change(profile, delta, reason, this.roundId || null); }
  addPlayer(profile) {
    if (this.phase !== "lobby" || this.players.size >= 7) throw Error("Room unavailable");
    this.spectators.delete(profile.id);
    this.players.set(profile.id, { profile, hands: [], ready: false });
  }
  addSpectator(profile) { this.spectators.set(profile.id, profile); }
  refundLobbyBet(player) {
    const refund = this.playerTotalBet(player);
    this.changeBalance(player.profile, refund, "blackjack_bet_refund");
    this.dealerEscrow -= refund;
    player.hands = [];
    player.ready = false;
  }
  releaseHumanDealer() {
    if (this.dealer.type !== "player") return;
    if (this.dealerEscrow !== 0) throw Error("Dealer role cannot change while bets are held");
    this.dealer = { type: "bot", name: "Casino", bankroll: Infinity, cards: [] };
  }
  becomeSpectator(id) {
    if (this.phase !== "lobby") throw Error("You can only spectate between rounds");
    const player = this.player(id); if (!player) throw Error("Unavailable");
    this.removeDealerRequest(id);
    if (this.dealer.type === "player" && this.dealer.playerId === id) {
      if (!this.dealer.hasCompletedRound) throw Error("Play one round as dealer before changing role");
      if (this.dealerEscrow > 0) throw Error("Wait until all lobby bets are cleared before changing role");
      this.releaseHumanDealer();
      this.promoteNextDealer();
    }
    else this.refundLobbyBet(player);
    this.players.delete(id);
    this.spectators.set(id, player.profile);
  }
  removePlayer(id) {
    this.removeDealerRequest(id);
    this.players.delete(id);
    if (id === this.hostId && this.players.size) this.hostId = this.players.keys().next().value;
  }
  assignHumanDealer(id) {
    const player = this.player(id);
    if (!player) return false;
    this.dealer = { type: "player", playerId: id, name: player.profile.username, bankroll: player.profile.balance, hasCompletedRound: false, cards: [] };
    return true;
  }
  promoteNextDealer() {
    while (this.dealerQueue.length) {
      const candidateId = this.dealerQueue.shift();
      if (this.assignHumanDealer(candidateId)) return true;
    }
    return false;
  }
  removeDealerRequest(id) {
    const previousLength = this.dealerQueue.length;
    this.dealerQueue = this.dealerQueue.filter(candidateId => candidateId !== id);
    return previousLength !== this.dealerQueue.length;
  }
  setDealer(id) {
    const player = this.player(id); if (!player || this.phase !== "lobby") throw Error("Unavailable");
    if ([...this.players.values()].some(p => this.playerTotalBet(p) > 0)) throw Error("Choose the dealer before any bet is placed");
    if (this.dealer.type === "bot") {
      this.removeDealerRequest(id);
      this.assignHumanDealer(id);
      return "dealer";
    }
    if (this.dealer.playerId === id) throw Error("You are already the dealer");
    if (this.dealerQueue.includes(id)) throw Error("You are already waiting to become dealer");
    this.dealerQueue.push(id);
    return "queued";
  }
  cancelDealerRequest(id) {
    if (this.phase !== "lobby" || !this.removeDealerRequest(id)) throw Error("You are not waiting to become dealer");
  }
  removeDealer(id) {
    if (this.phase !== "lobby" || this.dealer.type !== "player" || this.dealer.playerId !== id) throw Error("Unavailable");
    if (!this.dealer.hasCompletedRound) throw Error("Play one round as dealer before becoming a player again");
    if ([...this.players.values()].some(p => this.playerTotalBet(p) > 0)) throw Error("Return to player before bets are placed");
    this.releaseHumanDealer();
    this.promoteNextDealer();
  }
  placeBet(id, amount) {
    if (this.phase !== "lobby") throw Error("Betting closed"); const p = this.player(id);
    if (!p || p.ready || this.dealer.playerId === id || !Number.isInteger(amount) || amount < 1 || amount > p.profile.balance) throw Error("Invalid bet");
    if (!this.canAddStake(p, amount)) throw Error("This bet exceeds the dealer's table limit");
    if (!p.hands.length) p.hands = [{ cards: [], chips: [], bet: 0, status: "playing", fromSplit: false }];
    p.hands[0].bet += amount;
    p.hands[0].chips.push(amount);
    this.changeBalance(p.profile, -amount, "blackjack_bet");
    this.dealerEscrow += amount;
    this.startBetTimer();
  }
  readyPlayer(id) {
    if (this.phase !== "lobby") throw Error("Betting closed");
    const player = this.player(id);
    if (!player || !player.hands.length || player.hands[0].bet <= 0) throw Error("Place a bet first");
    player.ready = true;
    const required = [...this.players.values()].filter(p => p.profile.id !== this.dealer.playerId);
    if (required.length && required.every(p => p.ready)) this.startIfReady();
  }
  unreadyPlayer(id) {
    if (this.phase !== "lobby") throw Error("Betting closed");
    const player = this.player(id);
    if (!player || !player.ready) throw Error("Player is not ready");
    player.ready = false;
  }
  stopTurnTimer() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }
  clearRoundTimers() {
    if (this.betTimer) clearTimeout(this.betTimer);
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.dealerTimer) clearTimeout(this.dealerTimer);
    this.betTimer = null; this.turnTimer = null; this.dealerTimer = null; this.timerEndsAt = null;
  }
  startBetTimer() {
    const required = [...this.players.values()].filter(p => p.profile.id !== this.dealer.playerId);
    if (required.length <= 1 || this.betTimer) return;
    this.timerEndsAt = Date.now() + 60_000;
    this.betTimer = this.schedule(() => {
      this.betTimer = null;
      this.timerEndsAt = null;
      this.expireBetting();
      this.notify();
    }, 60_000);
  }
  expireBetting() {
    for (const [id, player] of this.players) if (id !== this.dealer.playerId && !player.ready) {
      this.refundLobbyBet(player);
      this.players.delete(id);
      this.spectators.set(id, player.profile);
    }
    const active = [...this.players.values()].filter(p => p.profile.id !== this.dealer.playerId && p.ready);
    if (active.length) this.startIfReady();
  }
  startIfReady() {
    const required = [...this.players.values()].filter(p => p.profile.id !== this.dealer.playerId);
    const active = required.filter(p => p.ready);
    if (!required.length || !required.every(p => p.ready && p.hands.length && p.hands[0].bet > 0)) throw Error("Waiting for every player to validate a bet");
    if (this.betTimer) { clearTimeout(this.betTimer); this.betTimer = null; this.timerEndsAt = null; }
    this.roundId += 1;
    this.dealer.cards = []; this.roundResults.clear(); this.roundEvents = [];
    for (let i = 0; i < 2; i++) { for (const p of active) p.hands[0].cards.push(this.draw()); this.dealer.cards.push(this.draw()); }
    for (const player of active) if (isBlackjack(player.hands[0])) {
      player.hands[0].status = "stood";
      this.addRoundEvent(player.profile.id, "blackjack");
    }
    if (isBlackjack(this.dealer)) { this.addDealerEvent("blackjack"); this.phase = "dealer_turn"; this.settle(); return true; }
    // advance() starts after current; begin just before hand 0.
    this.phase = "player_turn"; this.current = { playerId: [...this.players.entries()].find(([,p]) => p.ready)?.[0], handIndex: -1 };
    this.advance(); return true;
  }
  draw() {
    if (!this.shoe.length) this.shuffleDeck();
    return this.shoe.pop();
  }

  shuffleDeck() {
    this.shoe = createShoe();
    this.deckColor = randomDeckColor(this.deckColor);
    this.shuffleSerial += 1;
    this.roundsSinceShuffle = 0;
  }
  assertTurn(id) { if (this.phase !== "player_turn" || this.current.playerId !== id) throw Error("Not your turn"); return this.player(id).hands[this.current.handIndex]; }
  hit(id) { const hand = this.assertTurn(id); hand.cards.push(this.draw()); this.recordTerminalHandEvent(id, hand); if (handValue(hand.cards).total >= 21) { hand.status = "stood"; this.advance(); } }
  stand(id) { const hand = this.assertTurn(id); hand.status = "stood"; this.advance(); }
  double(id) { const hand = this.assertTurn(id); const p = this.player(id); if (hand.cards.length !== 2 || p.profile.balance < hand.bet || !this.canAddStake(p, hand.bet)) throw Error("Cannot double"); this.changeBalance(p.profile, -hand.bet, "blackjack_double"); this.dealerEscrow += hand.bet; hand.chips.push(hand.bet); hand.bet *= 2; hand.cards.push(this.draw()); this.recordTerminalHandEvent(id, hand); hand.status = "stood"; this.advance(); }
  split(id) { const hand = this.assertTurn(id); const p = this.player(id); if (!canSplit(hand, p.profile.balance) || !this.canAddStake(p, hand.bet)) throw Error("Cannot split"); this.changeBalance(p.profile, -hand.bet, "blackjack_split"); this.dealerEscrow += hand.bet; const second = { cards: [hand.cards.pop(), this.draw()], chips: [...hand.chips], bet: hand.bet, status: "playing", fromSplit: true }; hand.fromSplit = true; hand.cards.push(this.draw()); p.hands.splice(this.current.handIndex + 1, 0, second); }
  surrender(id) { const hand = this.assertTurn(id); if (hand.cards.length !== 2 || hand.fromSplit) throw Error("Surrender is only available on the initial hand"); hand.status = "surrendered"; this.advance(); }
  advance() {
    const entries = [...this.players.entries()].filter(([,p]) => p.ready);
    let pos = this.current ? entries.findIndex(([id]) => id === this.current.playerId) : 0;
    let handIndex = this.current ? this.current.handIndex + 1 : 0;
    if (pos < 0) { pos = 0; handIndex = 0; }
    while (pos < entries.length) { const [id, p] = entries[pos]; while (handIndex < p.hands.length) if (p.hands[handIndex].status === "playing") { this.current = { playerId: id, handIndex }; this.startTurnTimer(id, handIndex); return; } else handIndex++; pos++; handIndex = 0; }
    this.stopTurnTimer();
    this.phase = "dealer_wait";
    this.current = null;
    this.timerEndsAt = Date.now() + 2_000;
    this.dealerTimer = this.schedule(() => { this.dealerTimer = null; this.timerEndsAt = null; this.dealerTurn(); this.notify(); }, 2_000);
  }
  startTurnTimer(playerId, handIndex) {
    this.stopTurnTimer();
    this.timerEndsAt = Date.now() + 30_000;
    this.turnTimer = this.schedule(() => {
      this.turnTimer = null;
      this.timerEndsAt = null;
      if (this.phase !== "player_turn" || this.current?.playerId !== playerId || this.current?.handIndex !== handIndex) return;
      const hand = this.player(playerId)?.hands[handIndex];
      if (!hand) return;
      hand.status = "stood";
      this.advance();
      this.notify();
    }, 30_000);
  }
  startDealerTurnTimer(playerId) {
    this.stopTurnTimer();
    this.timerEndsAt = Date.now() + 30_000;
    this.turnTimer = this.schedule(() => {
      this.turnTimer = null;
      this.timerEndsAt = null;
      if (this.phase !== "dealer_turn" || this.dealer.type !== "player" || this.dealer.playerId !== playerId) return;
      this.dealerStand(playerId);
      this.notify();
    }, 30_000);
  }
  dealerTurn() {
    this.phase = "dealer_turn";
    if (this.dealer.type === "player") { this.current = { playerId: this.dealer.playerId, dealer: true }; this.startDealerTurnTimer(this.dealer.playerId); return; }
    this.playBotDealerCard();
  }
  playBotDealerCard() {
    if (handValue(this.dealer.cards).total >= 17) { this.recordDealerTerminalEvent(); this.settle(); this.notify(); return; }
    this.dealer.cards.push(this.draw());
    this.timerEndsAt = Date.now() + 1_000;
    this.notify();
    this.dealerTimer = this.schedule(() => { this.dealerTimer = null; this.timerEndsAt = null; this.playBotDealerCard(); }, 1_000);
  }
  dealerHit(id) {
    if (this.phase !== "dealer_turn" || this.dealer.playerId !== id) throw Error("Not the dealer turn");
    if (handValue(this.dealer.cards).total >= 21) throw Error("Dealer turn is complete");
    this.dealer.cards.push(this.draw());
    if (handValue(this.dealer.cards).total >= 21) {
      this.recordDealerTerminalEvent();
      this.settle();
    } else this.startDealerTurnTimer(id);
  }
  dealerStand(id) {
    if (this.phase !== "dealer_turn" || this.dealer.playerId !== id) throw Error("Not the dealer turn");
    this.stopTurnTimer();
    this.settle();
  }
  dealerProfile() { return this.dealer.type === "player" ? this.player(this.dealer.playerId).profile : null; }
  playerTotalBet(player) { return player.hands.reduce((sum, hand) => sum + hand.bet, 0); }
  dealerBetLimit() {
    if (this.dealer.type !== "player") return Infinity;
    const playerCount = Math.max(1, this.players.size - 1);
    return Math.floor(this.dealer.bankroll / playerCount / 1.5);
  }
  canAddStake(player, amount) { return this.playerTotalBet(player) + amount <= this.dealerBetLimit(); }
  addRoundEvent(playerId, type) { this.roundEvents.push({ id: this.nextEventId++, playerId, type }); }
  addDealerEvent(type) { this.roundEvents.push({ id: this.nextEventId++, dealer: true, type }); }
  recordTerminalHandEvent(playerId, hand) { if (handValue(hand.cards).total > 21) this.addRoundEvent(playerId, "bust"); }
  recordDealerTerminalEvent() { if (handValue(this.dealer.cards).total > 21) this.addDealerEvent("bust"); }
  leavePlayer(id) {
    if (this.spectators.delete(id)) return true;
    const leaving = this.player(id);
    if (!leaving) return false;
    const isHumanDealer = this.dealer.type === "player" && this.dealer.playerId === id;
    if (this.phase === "lobby") {
      if (isHumanDealer) {
        for (const [playerId, player] of this.players) if (playerId !== id) {
          const refund = this.playerTotalBet(player);
          this.changeBalance(player.profile, refund, "blackjack_dealer_departure_refund");
          this.dealerEscrow -= refund;
          player.hands = [];
          player.ready = false;
        }
      } else this.refundLobbyBet(leaving);
    }
    if (isHumanDealer && !["lobby", "settlement"].includes(this.phase)) {
      let dealerDelta = 0;
      for (const [playerId, player] of this.players) if (playerId !== id && player.ready) {
        const handResults = player.hands.map(hand => {
          const payout = hand.bet * 2;
          this.changeBalance(player.profile, payout, "blackjack_dealer_departure_win");
          dealerDelta += hand.bet - payout;
          this.dealerEscrow -= hand.bet;
          return { outcome: "win", net: hand.bet };
        });
        this.roundResults.set(playerId, { outcome: "win", net: handResults.reduce((sum, result) => sum + result.net, 0), hands: handResults });
        player.ready = false;
      }
      this.changeBalance(leaving.profile, dealerDelta, "blackjack_dealer_departure_settlement");
      this.phase = "settlement";
      this.roundsSinceShuffle += 1;
      this.current = null;
      this.clearRoundTimers();
    }
    if (!isHumanDealer && !["lobby", "settlement"].includes(this.phase)) {
      const forfeitedStake = this.playerTotalBet(leaving);
      this.dealerEscrow -= forfeitedStake;
      if (this.dealer.type === "player") this.changeBalance(this.dealerProfile(), forfeitedStake, "blackjack_departure_forfeit");
    }
    const wasCurrent = this.current?.playerId === id;
    this.removePlayer(id);
    if (isHumanDealer) {
      this.dealer = { type: "bot", name: "Casino", bankroll: Infinity, cards: [] };
      if (this.phase === "lobby") this.promoteNextDealer();
    }
    if (wasCurrent && this.phase === "player_turn") {
      this.current = null;
      this.advance();
    }
    return true;
  }
  settle() {
    this.clearRoundTimers();
    const dealerValue = handValue(this.dealer.cards).total, dealerBJ = isBlackjack(this.dealer);
    let dealerDelta = 0;
    for (const [playerId, p] of this.players) if (p.ready) {
      let net = 0, outcome = "push";
      const handResults = [];
      for (const hand of p.hands) { const value = handValue(hand.cards).total; let payout = 0;
        if (hand.status === "surrendered") { payout = Math.ceil(hand.bet / 2); outcome = "surrender"; }
        else if (value > 21) { outcome = "loss"; }
        else if (isBlackjack(hand) && !dealerBJ) { payout = Math.ceil(hand.bet * 2.5); outcome = "blackjack"; }
        else if (dealerValue > 21 || value > dealerValue) { payout = hand.bet * 2; outcome = "win"; }
        else if (value === dealerValue) { payout = hand.bet; outcome = "push"; }
        else { outcome = dealerBJ ? "dealer_blackjack" : "loss"; }
        const handNet = payout - hand.bet;
        net += handNet;
        handResults.push({ outcome, net: handNet });
        this.changeBalance(p.profile, payout, `blackjack_${outcome}_payout`);
        dealerDelta += hand.bet - payout;
        this.dealerEscrow -= hand.bet;
      }
      this.roundResults.set(playerId, { outcome, net, dealerBlackjack: dealerBJ, hands: handResults });
      p.ready = false;
    }
    if (this.dealer.type === "player") {
      this.changeBalance(this.dealerProfile(), dealerDelta, "blackjack_dealer_settlement");
      this.dealer.hasCompletedRound = true;
    }
    if (this.dealerEscrow !== 0) throw Error("Blackjack escrow did not settle to zero");
    this.roundsSinceShuffle += 1;
    this.phase = "settlement"; this.current = null;
  }
  nextRound() {
    if (this.phase !== "settlement") throw Error("Round not complete");
    if (this.roundsSinceShuffle >= 3) this.shuffleDeck();
    this.phase = "lobby"; this.hasCompletedRound = true; this.dealer.cards = []; this.roundResults.clear(); this.roundEvents = [];
    for (const [,p] of this.players) p.hands = [];
    if (this.dealer.type === "player" && this.dealerQueue.length) {
      this.dealer = { type: "bot", name: "Casino", bankroll: Infinity, cards: [] };
      this.promoteNextDealer();
    } else if (this.dealer.type === "bot") this.promoteNextDealer();
    if (this.dealer.type === "player") this.dealer.bankroll = this.dealerProfile().balance;
  }
}
