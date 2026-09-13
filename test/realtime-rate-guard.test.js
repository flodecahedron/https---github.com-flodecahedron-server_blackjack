import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeRateGuard } from "../src/realtime-rate-guard.js";

test("rapid chip bets use a larger independent soft budget", () => {
  const guard = new RealtimeRateGuard({ betActionLimit: 80, stateActionLimit: 30 });
  for (let index = 0; index < 80; index += 1) {
    assert.equal(guard.checkAction({ accountId: "player-1", type: "bet", isStateChanging: true, now: 1 }).allowed, true);
  }
  assert.deepEqual(
    guard.checkAction({ accountId: "player-1", type: "bet", isStateChanging: true, now: 1 }),
    { allowed: false, category: "bet" },
  );
  assert.equal(
    guard.checkAction({ accountId: "player-1", type: "hit", isStateChanging: true, now: 1 }).allowed,
    true,
  );
});

test("hard traffic protection has separate connection, account and network ceilings", () => {
  const guard = new RealtimeRateGuard({ connectionLimit: 3, accountLimit: 4, ipLimit: 5 });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(guard.checkTraffic({ connectionId: "socket-a", accountId: "player-1", addressFingerprint: "network-a", now: 1 }).allowed, true);
  }
  assert.deepEqual(
    guard.checkTraffic({ connectionId: "socket-a", accountId: "player-1", addressFingerprint: "network-a", now: 1 }),
    { allowed: false, scope: "connection" },
  );
});

test("a new fixed window restores the action budget", () => {
  const guard = new RealtimeRateGuard({ windowMilliseconds: 10_000, betActionLimit: 1 });
  assert.equal(guard.checkAction({ accountId: "player-1", type: "roulette_bet", isStateChanging: true, now: 1 }).allowed, true);
  assert.equal(guard.checkAction({ accountId: "player-1", type: "roulette_bet", isStateChanging: true, now: 2 }).allowed, false);
  assert.equal(guard.checkAction({ accountId: "player-1", type: "roulette_bet", isStateChanging: true, now: 10_001 }).allowed, true);
});
