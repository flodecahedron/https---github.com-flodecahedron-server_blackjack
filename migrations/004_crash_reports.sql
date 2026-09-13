CREATE TABLE IF NOT EXISTS bedealer_crash_reports (
  report_id VARCHAR(80) PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES blackjack_players(id) ON DELETE CASCADE,
  kind VARCHAR(40) NOT NULL,
  app_version VARCHAR(40) NOT NULL DEFAULT '',
  version_code INTEGER NOT NULL DEFAULT 0,
  platform VARCHAR(40) NOT NULL DEFAULT '',
  os_version VARCHAR(120) NOT NULL DEFAULT '',
  device_model VARCHAR(120) NOT NULL DEFAULT '',
  scene VARCHAR(200) NOT NULL DEFAULT '',
  diagnostics JSONB NOT NULL DEFAULT '{}'::JSONB,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bedealer_crash_reports_received
  ON bedealer_crash_reports (received_at DESC);

CREATE INDEX IF NOT EXISTS bedealer_crash_reports_player_received
  ON bedealer_crash_reports (player_id, received_at DESC);
