import crypto from "node:crypto";
import { RoomEconomy } from "./room-economy.js";

export const AMERICAN_WHEEL = Object.freeze([
  "0", "28", "9", "26", "30", "11", "7", "20", "32", "17", "5", "22", "34", "15", "3", "24", "36", "13", "1",
  "00", "27", "10", "25", "29", "12", "8", "19", "31", "18", "6", "21", "33", "16", "4", "23", "35", "14", "2",
]);

export const RED_NUMBERS = Object.freeze(new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]));
const BETTING_DURATION_MS = 45_000;
const SPIN_DURATION_MS = 7_000;
const RESULTS_DURATION_MS = 6_000;

function normalizeBet(rawBet) {
  const kind = String(rawBet?.kind ?? "");
  const value = String(rawBet?.value ?? "");
  if (kind === "straight" && (value === "0" || value === "00" || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 36))) return { kind, value };
  if (["red", "black", "even", "odd", "low", "high"].includes(kind)) return { kind, value: kind };
  if (kind === "dozen" && ["1", "2", "3"].includes(value)) return { kind, value };
  if (kind === "column" && ["1", "2", "3"].includes(value)) return { kind, value };
  throw Error("Mise de roulette invalide");
}

function betWins(bet, pocket) {
  const number = pocket === "00" ? -1 : Number(pocket);
  if (bet.kind === "straight") return bet.value === pocket;
  if (number <= 0) return false;
  if (bet.kind === "red") return RED_NUMBERS.has(number);
  if (bet.kind === "black") return !RED_NUMBERS.has(number);
  if (bet.kind === "even") return number % 2 === 0;
  if (bet.kind === "odd") return number % 2 === 1;
  if (bet.kind === "low") return number <= 18;
  if (bet.kind === "high") return number >= 19;
  if (bet.kind === "dozen") return Math.ceil(number / 12) === Number(bet.value);
  if (bet.kind === "column") return ((number - 1) % 3) + 1 === Number(bet.value);
  return false;
}

function profitMultiplier(kind) {
  if (kind === "straight") return 35;
  if (kind === "dozen" || kind === "column") return 2;
  return 1;
}

export class RouletteRoom {
  constructor({ code, name, host, onUpdate = null }) {
    this.game = "roulette";
    this.code = code;
    this.name = name;
    this.hostId = host.id;
    this.players = new Map([[host.id, { profile: host, bets: [], ready: false, result: null }]]);
    this.spectators = new Map();
    this.onUpdate = onUpdate;
    this.dealer = { type: "bot", name: "Croupier roulette" };
    this.phase = "betting";
    this.timerEndsAt = null;
    this.winningPocket = null;
    this.roundId = 0;
    this.roundTimer = null;
    this.economy = new RoomEconomy(code);
  }

  notify() { if (this.onUpdate) this.onUpdate(this); }
  schedule(callback, milliseconds) { const timer = setTimeout(callback, milliseconds); timer.unref?.(); return timer; }
  player(id) { return this.players.get(id); }
  pendingEconomyEvents() { return this.economy.pendingEvents(); }
  acknowledgeEconomyEvents(eventIds) { this.economy.acknowledge(eventIds); }
  changeBalance(profile, delta, reason) { this.economy.change(profile, delta, reason, this.roundId || null); }
  totalBet(player) { return player.bets.reduce((sum, bet) => sum + bet.amount, 0); }

  publicState(viewerId) {
    const viewerProfile = this.players.get(viewerId)?.profile ?? this.spectators.get(viewerId) ?? null;
    return {
      game: this.game,
      code: this.code,
      name: this.name,
      phase: this.phase,
      timerEndsAt: this.timerEndsAt,
      viewerRole: this.players.has(viewerId) ? "player" : "spectator",
      viewerBalance: viewerProfile?.balance ?? null,
      spectators: [...this.spectators.values()].map(profile => profile.username),
      readyCount: [...this.players.values()].filter(player => player.ready).length,
      requiredCount: this.players.size,
      winningPocket: this.winningPocket,
      roundId: this.roundId,
      players: [...this.players.entries()].map(([id, player]) => ({
        id,
        name: player.profile.username,
        balance: player.profile.balance,
        ready: player.ready,
        totalBet: this.totalBet(player),
        bets: player.bets.map(bet => ({ ...bet })),
        result: player.result,
        self: id === viewerId,
      })),
    };
  }

  addPlayer(profile) {
    if (this.phase !== "betting" || this.players.size >= 7) throw Error("Table de roulette indisponible");
    this.spectators.delete(profile.id);
    if (!this.players.has(profile.id)) this.players.set(profile.id, { profile, bets: [], ready: false, result: null });
  }

  addSpectator(profile) {
    this.spectators.set(profile.id, profile);
  }

  placeBet(id, rawBet, amount) {
    if (this.phase !== "betting") throw Error("Les mises sont fermées");
    const player = this.player(id);
    if (!player || player.ready || !Number.isInteger(amount) || amount < 1 || amount > player.profile.balance) throw Error("Mise invalide");
    const bet = normalizeBet(rawBet);
    const existing = player.bets.find(candidate => candidate.kind === bet.kind && candidate.value === bet.value);
    if (existing) existing.amount += amount;
    else player.bets.push({ ...bet, amount });
    this.changeBalance(player.profile, -amount, "roulette_bet");
    player.result = null;
    this.startBettingTimer();
  }

  clearBets(id) {
    if (this.phase !== "betting") throw Error("Les mises sont fermées");
    const player = this.player(id);
    if (!player || player.ready) throw Error("Mises indisponibles");
    this.changeBalance(player.profile, this.totalBet(player), "roulette_bet_refund");
    player.bets = [];
  }

  readyPlayer(id) {
    if (this.phase !== "betting") throw Error("Les mises sont fermées");
    const player = this.player(id);
    if (!player || !player.bets.length) throw Error("Placez une mise d’abord");
    player.ready = true;
    if ([...this.players.values()].every(candidate => candidate.ready && candidate.bets.length)) this.spin();
  }

  unreadyPlayer(id) {
    if (this.phase !== "betting") throw Error("Les mises sont fermées");
    const player = this.player(id);
    if (!player || !player.ready) throw Error("Le joueur n’est pas prêt");
    player.ready = false;
  }

  startBettingTimer() {
    if (this.roundTimer || this.players.size <= 1) return;
    this.timerEndsAt = Date.now() + BETTING_DURATION_MS;
    this.roundTimer = this.schedule(() => {
      this.roundTimer = null;
      this.timerEndsAt = null;
      this.expireBetting();
      this.notify();
    }, BETTING_DURATION_MS);
  }

  expireBetting() {
    for (const [id, player] of this.players) if (!player.ready) {
      this.changeBalance(player.profile, this.totalBet(player), "roulette_timeout_refund");
      player.bets = [];
      this.players.delete(id);
      this.spectators.set(id, player.profile);
    }
    if (this.players.size) this.spin();
  }

  spin() {
    if (this.phase !== "betting" || !this.players.size) throw Error("Aucune mise validée");
    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.roundTimer = null;
    this.roundId += 1;
    this.winningPocket = AMERICAN_WHEEL[crypto.randomInt(AMERICAN_WHEEL.length)];
    this.phase = "spinning";
    this.timerEndsAt = Date.now() + SPIN_DURATION_MS;
    this.roundTimer = this.schedule(() => {
      this.roundTimer = null;
      this.settle();
      this.notify();
    }, SPIN_DURATION_MS);
    this.notify();
  }

  settle() {
    if (this.phase !== "spinning") return;
    for (const player of this.players.values()) {
      let payout = 0;
      const winningBets = [];
      for (const bet of player.bets) if (betWins(bet, this.winningPocket)) {
        const returned = bet.amount * (profitMultiplier(bet.kind) + 1);
        payout += returned;
        winningBets.push({ kind: bet.kind, value: bet.value, amount: bet.amount, payout: returned });
      }
      const stake = this.totalBet(player);
      this.changeBalance(player.profile, payout, "roulette_payout");
      player.result = { outcome: payout > stake ? "win" : payout === stake ? "push" : "loss", net: payout - stake, payout, winningBets };
      player.ready = false;
    }
    this.phase = "results";
    this.timerEndsAt = Date.now() + RESULTS_DURATION_MS;
    this.roundTimer = this.schedule(() => {
      this.roundTimer = null;
      this.nextRound();
      this.notify();
    }, RESULTS_DURATION_MS);
  }

  nextRound() {
    this.phase = "betting";
    this.timerEndsAt = null;
    this.winningPocket = null;
    for (const player of this.players.values()) {
      player.bets = [];
      player.ready = false;
      player.result = null;
    }
  }

  becomeSpectator(id) {
    if (this.phase !== "betting") throw Error("Vous pourrez devenir spectateur après le tirage");
    const player = this.player(id);
    if (!player) throw Error("Joueur indisponible");
    this.changeBalance(player.profile, this.totalBet(player), "roulette_spectator_refund");
    this.players.delete(id);
    this.spectators.set(id, player.profile);
  }

  leavePlayer(id) {
    if (this.spectators.delete(id)) return true;
    const player = this.player(id);
    if (!player) return false;
    if (this.phase === "betting") this.changeBalance(player.profile, this.totalBet(player), "roulette_departure_refund");
    this.players.delete(id);
    if (id === this.hostId && this.players.size) this.hostId = this.players.keys().next().value;
    return true;
  }

  clearRoundTimers() {
    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.roundTimer = null;
    this.timerEndsAt = null;
  }
}
