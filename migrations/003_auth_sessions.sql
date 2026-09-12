ALTER TABLE blackjack_auth_accounts
  ADD COLUMN IF NOT EXISTS session_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS session_last_used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS session_revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS previous_session_token_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS previous_session_expires_at TIMESTAMPTZ;

-- Preserve installed sessions during the migration instead of disconnecting every
-- existing player at once. They will be rotated at their next successful login.
UPDATE blackjack_auth_accounts
SET session_expires_at = COALESCE(session_expires_at, NOW() + INTERVAL '90 days'),
    session_last_used_at = COALESCE(session_last_used_at, NOW())
WHERE session_expires_at IS NULL OR session_last_used_at IS NULL;

ALTER TABLE blackjack_auth_accounts
  ALTER COLUMN session_expires_at SET NOT NULL,
  ALTER COLUMN session_last_used_at SET NOT NULL;

-- Google `sub` is the stable identity. Purge the unnecessary email data now, but
-- retain the empty legacy column for one release so a Render rollback remains
-- compatible with the previous server binary.
UPDATE blackjack_auth_accounts SET email = NULL WHERE email IS NOT NULL;
