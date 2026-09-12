import test from "node:test";
import assert from "node:assert/strict";
import { PlayerStore } from "../src/player-store.js";

test("leaderboard sends a top three, a viewer rank and pages of at most 25", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const store = new PlayerStore();
  const accounts = new Map();
  for (let index = 0; index < 62; index += 1) {
    const player = { id: `p${index}`, username: `Player${String(index).padStart(2, "0")}`, balance: 1000 - index };
    accounts.set(player.id, player);
  }
  const summary = await store.leaderboardSummary("p40", accounts);
  const page = await store.leaderboardPage("p40", 1, accounts);
  assert.equal(summary.top.length, 3);
  assert.equal(summary.viewer.rank, 41);
  assert.equal(summary.total, 62);
  assert.equal(page.players.length, 25);
  assert.equal(page.players[0].rank, 26);
  assert.equal(page.totalPages, 3);
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});
