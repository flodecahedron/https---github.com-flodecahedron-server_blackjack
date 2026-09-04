export const DEALER_MIN_BANKROLL = 0;

export function cardValue(card) {
  if (card.rank === "A") return 11;
  if (["K", "Q", "J"].includes(card.rank)) return 10;
  return Number(card.rank);
}

export function handValue(cards) {
  let total = cards.reduce((sum, card) => sum + cardValue(card), 0);
  let aces = cards.filter((card) => card.rank === "A").length;
  while (total > 21 && aces-- > 0) total -= 10;
  return { total, soft: aces > 0 };
}

export function isBlackjack(hand) {
  return hand.cards.length === 2 && handValue(hand.cards).total === 21;
}

export function canSplit(hand, balance) {
  return hand.cards.length === 2 && cardValue(hand.cards[0]) === cardValue(hand.cards[1]) && balance >= hand.bet;
}

export function createShoe(decks = 6) {
  const cards = [];
  for (let deck = 0; deck < decks; deck++) {
    for (const suit of ["spades", "hearts", "diamonds", "clubs"])
      for (const rank of ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"])
        cards.push({ rank, suit });
  }
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function fibonacci(index) {
  let a = 0, b = 1;
  for (let i = 0; i < index; i++) [a, b] = [b, a + b];
  return a;
}

export function dailyReward(profile, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  if (profile.lastLogin === today) return 0;
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  profile.loginStreak = profile.lastLogin === yesterday ? profile.loginStreak + 1 : 1;
  profile.lastLogin = today;
  const reward = fibonacci(profile.loginStreak - 1);
  profile.balance += reward;
  return reward;
}
