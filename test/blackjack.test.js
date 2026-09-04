import test from "node:test";
import assert from "node:assert/strict";
import { canSplit, fibonacci, handValue, isBlackjack } from "../src/blackjack.js";

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
  assert.equal(canSplit({ cards: [card("8"), card("9")], bet: 20 }, 20), false);
});

test("daily rewards follow Fibonacci", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(fibonacci), [0, 1, 1, 2, 3, 5, 8]);
});
