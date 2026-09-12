CREATE TABLE IF NOT EXISTS blackjack_players (
  id UUID PRIMARY KEY,
  username VARCHAR(16) UNIQUE NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  balance INTEGER NOT NULL,
  login_streak INTEGER NOT NULL DEFAULT 0,
  last_login DATE,
  last_roulette DATE
);

ALTER TABLE blackjack_players ALTER COLUMN balance TYPE INTEGER USING CEIL(balance)::INTEGER;
ALTER TABLE blackjack_players ADD COLUMN IF NOT EXISTS last_roulette DATE;

CREATE TABLE IF NOT EXISTS blackjack_abuse_events (
  id BIGSERIAL PRIMARY KEY,
  subject_hash CHAR(64) NOT NULL,
  action VARCHAR(48) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS blackjack_abuse_events_lookup
  ON blackjack_abuse_events (subject_hash, action, created_at);

CREATE TABLE IF NOT EXISTS blackjack_auth_accounts (
  player_id UUID PRIMARY KEY REFERENCES blackjack_players(id) ON DELETE CASCADE,
  google_sub TEXT UNIQUE,
  email TEXT,
  session_token_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
