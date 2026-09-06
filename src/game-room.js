import { canSplit, createShoe, handScores, handValue, isBlackjack } from "./blackjack.js";

export class GameRoom {
  constructor({ code, name, host, onUpdate = null }) {
    this.code = code; this.name = name; this.hostId = host.id;
    this.players = new Map([[host.id, { profile: host, hands: [], ready: false }]]);
    this.spectators = new Map(); this.onUpdate = onUpdate;
    this.dealer = { type: "bot", name: "Casino", bankroll: Infinity, cards: [] };
    this.shoe = createShoe(); this.phase = "lobby"; this.current = null; this.roundResults = new Map();
    this.roundEvents = []; this.nextEventId = 1; this.hasCompletedRound = false;
    this.betTimer = null; this.turnTimer = null; this.dealerTimer = null;
  }
  notify() { if (this.onUpdate) this.onUpdate(this); }
  schedule(callback, milliseconds) { const timer = setTimeout(callback, milliseconds); timer.unref?.(); return timer; }
  player(id) { return this.players.get(id); }
  publicState(viewerId) {
    const revealDealer = ["dealer_turn", "settlement", "lobby"].includes(this.phase);
    const requiredPlayers = [...this.players.values()].filter(player => player.profile.id !== this.dealer.playerId);
    return { code: this.code, name: this.name, phase: this.phase, currentPlayerId: this.current?.playerId ?? null, currentHandIndex: this.current?.handIndex ?? -1, readyCount: requiredPlayers.filter(player => player.ready).length, requiredCount: requiredPlayers.length, hasCompletedRound: this.hasCompletedRound, events: this.roundEvents, timerEndsAt: this.timerEndsAt ?? null, viewerRole: this.players.has(viewerId) ? "player" : "spectator", spectators: [...this.spectators.values()].map(profile => profile.username),
      dealer: { ...this.dealer, canLeaveRole: this.phase === "lobby" && this.dealer.type === "player" && this.dealer.hasCompletedRound, cards: revealDealer ? this.dealer.cards : this.dealer.cards.map((card, i) => i ? { hidden: true } : card), value: revealDealer ? handValue(this.dealer.cards).total : null, scores: revealDealer ? handScores(this.dealer.cards) : [] },
      players: [...this.players.entries()].map(([id, player]) => ({ id, name: player.profile.username, balance: player.profile.balance, ready: player.ready, result: this.roundResults.get(id) ?? null,
        hands: player.hands.map((hand) => ({ ...hand, value: handValue(hand.cards).total, scores: handScores(hand.cards), blackjack: isBlackjack(hand),
          canDouble: hand.status === "playing" && hand.cards.length === 2 && player.profile.balance >= hand.bet && this.canAddStake(player, hand.bet),
          canSplit: hand.status === "playing" && canSplit(hand, player.profile.balance) && this.canAddStake(player, hand.bet),
          canSurrender: hand.status === "playing" && hand.cards.length === 2 && !hand.fromSplit })), self: id === viewerId })) };
  }
  ensureMinimumBalance(profile) { if (profile.balance <= 0) profile.balance = 100; }
  addPlayer(profile) {
    if (this.phase !== "lobby" || this.players.size >= 5) throw Error("Room unavailable");
    this.ensureMinimumBalance(profile);
    this.spectators.delete(profile.id);
    this.players.set(profile.id, { profile, hands: [], ready: false });
  }
  addSpectator(profile) { this.ensureMinimumBalance(profile); this.spectators.set(profile.id, profile); }
  refundLobbyBet(player) {
    const refund = this.playerTotalBet(player);
    player.profile.balance += refund;
    if (this.dealer.type === "player") this.dealerProfile().balance -= refund;
    player.hands = [];
    player.ready = false;
  }
  releaseHumanDealer() {
    if (this.dealer.type !== "player") return;
    const dealerProfile = this.dealerProfile();
    const tableStakes = [...this.players.values()].filter(player => player.profile.id !== this.dealer.playerId).reduce((sum, player) => sum + this.playerTotalBet(player), 0);
    dealerProfile.balance -= tableStakes;
    this.dealer = { type: "bot", name: "Casino", bankroll: Infinity, cards: [] };
  }
  becomeSpectator(id) {
    if (this.phase !== "lobby") throw Error("You can only spectate between rounds");
    const player = this.player(id); if (!player) throw Error("Unavailable");
    if (this.dealer.type === "player" && this.dealer.playerId === id) {
      if (!this.dealer.hasCompletedRound) throw Error("Play one round as dealer before changing role");
      this.releaseHumanDealer();
    }
    else this.refundLobbyBet(player);
    this.players.delete(id);
    this.spectators.set(id, player.profile);
  }
  removePlayer(id) { this.players.delete(id); if (id === this.hostId && this.players.size) this.hostId = this.players.keys().next().value; }
  setDealer(id) {
    const player = this.player(id); if (!player || this.phase !== "lobby") throw Error("Unavailable");
    if ([...this.players.values()].some(p => this.playerTotalBet(p) > 0)) throw Error("Choose the dealer before any bet is placed");
    this.dealer = { type: "player", playerId: id, name: player.profile.username, bankroll: player.profile.balance, hasCompletedRound: false, cards: [] };
  }
  removeDealer(id) {
    if (this.phase !== "lobby" || this.dealer.type !== "player" || this.dealer.playerId !== id) throw Error("Unavailable");
    if (!this.dealer.hasCompletedRound) throw Error("Play one round as dealer before becoming a player again");
    if ([...this.players.values()].some(p => this.playerTotalBet(p) > 0)) throw Error("Return to player before bets are placed");
    this.releaseHumanDealer();
  }
  placeBet(id, amount) {
    if (this.phase !== "lobby") throw Error("Betting closed"); const p = this.player(id);
    if (!p || p.ready || this.dealer.playerId === id || !Number.isInteger(amount) || amount < 1 || amount > p.profile.balance) throw Error("Invalid bet");
    if (!this.canAddStake(p, amount)) throw Error("This bet exceeds the dealer's table limit");
    if (this.dealer.type === "player") this.dealerProfile().balance += amount;
    if (!p.hands.length) p.hands = [{ cards: [], chips: [], bet: 0, status: "playing", fromSplit: false }];
    p.hands[0].bet += amount;
    p.hands[0].chips.push(amount);
    p.profile.balance -= amount;
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
    if (this.shoe.length < 52) this.shoe = createShoe();
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
  draw() { return this.shoe.pop(); }
  assertTurn(id) { if (this.phase !== "player_turn" || this.current.playerId !== id) throw Error("Not your turn"); return this.player(id).hands[this.current.handIndex]; }
  hit(id) { const hand = this.assertTurn(id); hand.cards.push(this.draw()); this.recordTerminalHandEvent(id, hand); if (handValue(hand.cards).total >= 21) { hand.status = "stood"; this.advance(); } }
  stand(id) { const hand = this.assertTurn(id); hand.status = "stood"; this.advance(); }
  double(id) { const hand = this.assertTurn(id); const p = this.player(id); if (hand.cards.length !== 2 || p.profile.balance < hand.bet || !this.canAddStake(p, hand.bet)) throw Error("Cannot double"); p.profile.balance -= hand.bet; if (this.dealer.type === "player") this.dealerProfile().balance += hand.bet; hand.chips.push(hand.bet); hand.bet *= 2; hand.cards.push(this.draw()); this.recordTerminalHandEvent(id, hand); hand.status = "stood"; this.advance(); }
  split(id) { const hand = this.assertTurn(id); const p = this.player(id); if (!canSplit(hand, p.profile.balance) || !this.canAddStake(p, hand.bet)) throw Error("Cannot split"); p.profile.balance -= hand.bet; if (this.dealer.type === "player") this.dealerProfile().balance += hand.bet; const second = { cards: [hand.cards.pop(), this.draw()], chips: [...hand.chips], bet: hand.bet, status: "playing", fromSplit: true }; hand.fromSplit = true; hand.cards.push(this.draw()); p.hands.splice(this.current.handIndex + 1, 0, second); }
  surrender(id) { const hand = this.assertTurn(id); if (hand.cards.length !== 2 || hand.fromSplit) throw Error("Surrender is only available on the initial hand"); hand.status = "surrendered"; this.advance(); }
  advance() {
    const entries = [...this.players.entries()].filter(([,p]) => p.ready);
    let pos = entries.findIndex(([id]) => id === this.current.playerId), handIndex = this.current.handIndex + 1;
    while (pos < entries.length) { const [id, p] = entries[pos]; while (handIndex < p.hands.length) if (p.hands[handIndex].status === "playing") { this.current = { playerId: id, handIndex }; this.startTurnTimer(id, handIndex); return; } else handIndex++; pos++; handIndex = 0; }
    this.phase = "dealer_wait";
    this.current = null;
    this.timerEndsAt = Date.now() + 2_000;
    this.dealerTimer = this.schedule(() => { this.dealerTimer = null; this.timerEndsAt = null; this.dealerTurn(); this.notify(); }, 2_000);
  }
  startTurnTimer(playerId, handIndex) {
    if (this.turnTimer) clearTimeout(this.turnTimer);
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
  dealerTurn() {
    this.phase = "dealer_turn";
    if (this.dealer.type === "player") { this.current = { playerId: this.dealer.playerId, dealer: true }; return; }
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
    }
  }
  dealerStand(id) {
    if (this.phase !== "dealer_turn" || this.dealer.playerId !== id) throw Error("Not the dealer turn");
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
        for (const [playerId, player] of this.players) if (playerId !== id && player.ready) {
          const refund = this.playerTotalBet(player);
          player.profile.balance += refund;
          leaving.profile.balance -= refund;
          player.hands = [];
          player.ready = false;
        }
      } else if (leaving.ready) {
        const refund = this.playerTotalBet(leaving);
        leaving.profile.balance += refund;
        if (this.dealer.type === "player") this.dealerProfile().balance -= refund;
      }
    }
    if (isHumanDealer && !["lobby", "settlement"].includes(this.phase)) {
      for (const [playerId, player] of this.players) if (playerId !== id && player.ready) {
        const handResults = player.hands.map(hand => {
          const payout = hand.bet * 2;
          player.profile.balance += payout;
          leaving.profile.balance -= payout;
          return { outcome: "win", net: hand.bet };
        });
        this.roundResults.set(playerId, { outcome: "win", net: handResults.reduce((sum, result) => sum + result.net, 0), hands: handResults });
        player.ready = false;
      }
      this.phase = "settlement";
      this.current = null;
    }
    const wasCurrent = this.current?.playerId === id;
    this.removePlayer(id);
    if (isHumanDealer) this.dealer = { type: "bot", name: "Casino", bankroll: Infinity, cards: [] };
    if (wasCurrent && this.phase === "player_turn") {
      this.current = { playerId: id, handIndex: -1 };
      this.advance();
    }
    return true;
  }
  settle() {
    const dealerValue = handValue(this.dealer.cards).total, dealerBJ = isBlackjack(this.dealer);
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
        p.profile.balance += payout;
        if (this.dealer.type === "player") this.dealerProfile().balance -= payout;
      }
      this.roundResults.set(playerId, { outcome, net, dealerBlackjack: dealerBJ, hands: handResults });
      if (p.profile.balance <= 0) {
        p.profile.balance = 100;
        this.addRoundEvent(playerId, "casino_gift");
      }
      p.ready = false;
    }
    if (this.dealer.type === "player") this.dealer.hasCompletedRound = true;
    this.phase = "settlement"; this.current = null;
  }
  nextRound() { if (this.phase !== "settlement") throw Error("Round not complete"); this.phase = "lobby"; this.hasCompletedRound = true; this.dealer.cards = []; this.roundResults.clear(); this.roundEvents = []; for (const [,p] of this.players) p.hands = []; }
}
