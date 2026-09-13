const BLACKJACK_ACTIONS = Object.freeze({
  bet: (room, id, message) => room.placeBet(id, Number(message.amount)),
  ready: (room, id) => room.readyPlayer(id),
  unready: (room, id) => room.unreadyPlayer(id),
  start: room => room.startIfReady(),
  hit: (room, id) => room.hit(id),
  stand: (room, id) => room.stand(id),
  dealer_hit: (room, id) => room.dealerHit(id),
  dealer_stand: (room, id) => room.dealerStand(id),
  double: (room, id) => room.double(id),
  split: (room, id) => room.split(id),
  surrender: (room, id) => room.surrender(id),
  next_round: room => room.nextRound(),
  become_dealer: (room, id) => room.setDealer(id),
  leave_dealer: (room, id) => room.removeDealer(id),
  leave_dealer_queue: (room, id) => room.cancelDealerRequest(id),
});

const ROULETTE_ACTIONS = Object.freeze({
  roulette_bet: (room, id, message) => room.placeBet(id, message.bet, Number(message.amount)),
  roulette_clear_bets: (room, id) => room.clearBets(id),
  ready: (room, id) => room.readyPlayer(id),
  unready: (room, id) => room.unreadyPlayer(id),
});

export function applyRoomAction(room, profileId, type, message) {
  const actions = room.game === "roulette" ? ROULETTE_ACTIONS : BLACKJACK_ACTIONS;
  if (!Object.hasOwn(actions, type)) throw Error(room.game === "roulette" ? "Unknown roulette action" : "Unknown action");
  const action = actions[type];
  return action(room, profileId, message);
}
