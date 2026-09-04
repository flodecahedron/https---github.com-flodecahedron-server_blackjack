import { canSplit, createShoe, handValue, isBlackjack } from "./blackjack.js";

const MIN_BET = 10;

export class GameRoom {
  constructor({ code, name, host }) {
    this.code = code; this.name = name; this.hostId = host.id;
    this.players = new Map([[host.id, { profile: host, hands: [], ready: false }]]);
    this.dealer = { type: "bot", name: "Casino", bankroll: Infinity, cards: [] };
    this.shoe = createShoe(); this.phase = "lobby"; this.current = null;
  }
  player(id) { return this.players.get(id); }
  publicState(viewerId) {
    const revealDealer = ["dealer_turn", "settlement", "lobby"].includes(this.phase);
    return { code: this.code, name: this.name, phase: this.phase, currentPlayerId: this.current?.playerId ?? null,
      dealer: { ...this.dealer, cards: revealDealer ? this.dealer.cards : this.dealer.cards.map((card, i) => i ? { hidden: true } : card), value: revealDealer ? handValue(this.dealer.cards).total : null },
      players: [...this.players.entries()].map(([id, player]) => ({ id, name: player.profile.username, balance: player.profile.balance, ready: player.ready,
        hands: player.hands.map((hand) => ({ ...hand, value: handValue(hand.cards).total, blackjack: isBlackjack(hand) })), self: id === viewerId })) };
  }
  addPlayer(profile) { if (this.phase !== "lobby" || this.players.size >= 5) throw Error("Room unavailable"); this.players.set(profile.id, { profile, hands: [], ready: false }); }
  removePlayer(id) { this.players.delete(id); if (id === this.hostId && this.players.size) this.hostId = this.players.keys().next().value; }
  setDealer(id) {
    const player = this.player(id); if (!player || this.phase !== "lobby") throw Error("Unavailable");
    // Human dealer needs a bankroll sufficient for every player blackjack payout (3:2).
    const exposure = [...this.players.values()].filter(p => p.profile.id !== id).reduce((sum, p) => sum + p.profile.balance * 1.5, 0);
    if (player.profile.balance < exposure) throw Error("Insufficient bankroll to cover the table");
    this.dealer = { type: "player", playerId: id, name: player.profile.username, cards: [] };
  }
  placeBet(id, amount) {
    if (this.phase !== "lobby") throw Error("Betting closed"); const p = this.player(id);
    if (!p || this.dealer.playerId === id || !Number.isInteger(amount) || amount < MIN_BET || amount > p.profile.balance) throw Error("Invalid bet");
    // A human dealer must be able to cover the simultaneous worst case: every hand is blackjack (2.5× stake).
    if (this.dealer.type === "player") {
      const existing = [...this.players.values()].flatMap(player => player.hands).reduce((sum, hand) => sum + hand.bet, 0);
      if (p.profile.balance /* balance before debit */ && this.dealerProfile().balance + existing + amount < (existing + amount) * 2.5) throw Error("Dealer bankroll cannot cover this bet");
      this.dealerProfile().balance += amount;
    }
    p.hands = [{ cards: [], bet: amount, status: "playing" }]; p.profile.balance -= amount; p.ready = true;
  }
  startIfReady() {
    const active = [...this.players.values()].filter(p => p.ready && p.profile.id !== this.dealer.playerId);
    if (!active.length || !active.every(p => p.hands.length)) return false;
    if (this.shoe.length < 52) this.shoe = createShoe();
    this.dealer.cards = [];
    for (let i = 0; i < 2; i++) { for (const p of active) p.hands[0].cards.push(this.draw()); this.dealer.cards.push(this.draw()); }
    for (const player of active) if (isBlackjack(player.hands[0])) player.hands[0].status = "stood";
    if (isBlackjack(this.dealer)) { this.phase = "dealer_turn"; this.settle(); return true; }
    this.phase = "player_turn"; this.current = { playerId: [...this.players.entries()].find(([,p]) => p.ready)?.[0], handIndex: 0 };
    this.advance(); return true;
  }
  draw() { return this.shoe.pop(); }
  assertTurn(id) { if (this.phase !== "player_turn" || this.current.playerId !== id) throw Error("Not your turn"); return this.player(id).hands[this.current.handIndex]; }
  hit(id) { const hand = this.assertTurn(id); hand.cards.push(this.draw()); if (handValue(hand.cards).total >= 21) { hand.status = "stood"; this.advance(); } }
  stand(id) { const hand = this.assertTurn(id); hand.status = "stood"; this.advance(); }
  double(id) { const hand = this.assertTurn(id); const p = this.player(id); if (hand.cards.length !== 2 || p.profile.balance < hand.bet) throw Error("Cannot double"); p.profile.balance -= hand.bet; hand.bet *= 2; hand.cards.push(this.draw()); hand.status = "stood"; this.advance(); }
  split(id) { const hand = this.assertTurn(id); const p = this.player(id); if (!canSplit(hand, p.profile.balance)) throw Error("Cannot split"); p.profile.balance -= hand.bet; const second = { cards: [hand.cards.pop(), this.draw()], bet: hand.bet, status: "playing" }; hand.cards.push(this.draw()); p.hands.splice(this.current.handIndex + 1, 0, second); }
  advance() {
    const entries = [...this.players.entries()].filter(([,p]) => p.ready);
    let pos = entries.findIndex(([id]) => id === this.current.playerId), handIndex = this.current.handIndex + 1;
    while (pos < entries.length) { const [id, p] = entries[pos]; while (handIndex < p.hands.length) if (p.hands[handIndex].status === "playing") { this.current = { playerId: id, handIndex }; return; } else handIndex++; pos++; handIndex = 0; }
    this.dealerTurn();
  }
  dealerTurn() {
    this.phase = "dealer_turn";
    if (this.dealer.type === "player") { this.current = { playerId: this.dealer.playerId, dealer: true }; return; }
    while (handValue(this.dealer.cards).total < 17) this.dealer.cards.push(this.draw());
    this.settle();
  }
  dealerHit(id) {
    if (this.phase !== "dealer_turn" || this.dealer.playerId !== id) throw Error("Not the dealer turn");
    if (handValue(this.dealer.cards).total >= 17) throw Error("Dealer must stand on 17");
    this.dealer.cards.push(this.draw());
  }
  dealerStand(id) {
    if (this.phase !== "dealer_turn" || this.dealer.playerId !== id) throw Error("Not the dealer turn");
    if (handValue(this.dealer.cards).total < 17) throw Error("Dealer must draw until 17");
    this.settle();
  }
  dealerProfile() { return this.dealer.type === "player" ? this.player(this.dealer.playerId).profile : null; }
  settle() {
    const dealerValue = handValue(this.dealer.cards).total, dealerBJ = isBlackjack(this.dealer);
    for (const [, p] of this.players) if (p.ready) {
      for (const hand of p.hands) { const value = handValue(hand.cards).total; let payout = 0;
        if (value > 21) payout = 0;
        else if (isBlackjack(hand) && !dealerBJ) payout = hand.bet * 2.5;
        else if (dealerValue > 21 || value > dealerValue) payout = hand.bet * 2;
        else if (value === dealerValue) payout = hand.bet;
        p.profile.balance += payout;
        if (this.dealer.type === "player") this.dealerProfile().balance -= payout;
      }
      if (p.profile.balance <= 0) p.profile.balance = 100;
      p.ready = false;
    }
    this.phase = "settlement"; this.current = null;
  }
  nextRound() { if (this.phase !== "settlement") throw Error("Round not complete"); this.phase = "lobby"; for (const [,p] of this.players) p.hands = []; }
}
