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

export function handScores(cards) {
  const best = handValue(cards).total;
  const high = cards.reduce((sum, card) => sum + cardValue(card), 0);
  return high <= 21 && high !== best ? [best, high] : [best];
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

export const DAILY_REWARD_AMOUNTS = Object.freeze([50, 75, 100, 150, 225, 350, 500]);

function utcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

export function dailyReward(profile, now = new Date()) {
  const today = utcDateKey(now);
  const yesterday = utcDateKey(new Date(now.getTime() - 86400000));
  const previousLogin = profile.lastLogin ? String(profile.lastLogin).slice(0, 10) : null;
  const previousStreak = Number.isSafeInteger(profile.loginStreak) && profile.loginStreak > 0 ? profile.loginStreak : 0;
  if (previousLogin === today) {
    const streak = Math.max(1, previousStreak);
    return { amount: 0, streak, claimedToday: true, claimedOn: today, nextAmount: DAILY_REWARD_AMOUNTS[Math.min(streak, DAILY_REWARD_AMOUNTS.length - 1)] };
  }
  profile.loginStreak = previousLogin === yesterday ? previousStreak + 1 : 1;
  profile.lastLogin = today;
  const amount = DAILY_REWARD_AMOUNTS[Math.min(profile.loginStreak - 1, DAILY_REWARD_AMOUNTS.length - 1)];
  profile.balance += amount;
  return { amount, streak: profile.loginStreak, claimedToday: false, claimedOn: today, nextAmount: DAILY_REWARD_AMOUNTS[Math.min(profile.loginStreak, DAILY_REWARD_AMOUNTS.length - 1)] };
}
