ALTER TABLE blackjack_players ADD COLUMN IF NOT EXISTS last_safety_grant DATE;
ALTER TABLE blackjack_players ADD COLUMN IF NOT EXISTS rewarded_grant_date DATE;
ALTER TABLE blackjack_players ADD COLUMN IF NOT EXISTS rewarded_grant_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blackjack_players ADD COLUMN IF NOT EXISTS last_rewarded_grant_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blackjack_players_nonnegative_balance') THEN
    ALTER TABLE blackjack_players ADD CONSTRAINT blackjack_players_nonnegative_balance CHECK (balance >= 0) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS blackjack_chip_ledger (
  id TEXT PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES blackjack_players(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL CHECK (delta <> 0),
  reason VARCHAR(64) NOT NULL,
  room_code VARCHAR(4),
  round_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS blackjack_chip_ledger_player_created
  ON blackjack_chip_ledger (player_id, created_at DESC);
