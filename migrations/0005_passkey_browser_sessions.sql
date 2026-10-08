-- Preserve already-applied runtime migrations. A stable browser binding lets
-- logout revoke a newly issued session even when its cookie response is delayed.
-- Existing sessions remain nullable and are revoked by their exact cookie.
ALTER TABLE auth_sessions ADD COLUMN browser_hash TEXT
  CHECK (browser_hash IS NULL OR (length(browser_hash) = 43 AND browser_hash NOT GLOB '*[^A-Za-z0-9_-]*' AND length(CAST(browser_hash AS BLOB)) = 43));
CREATE INDEX auth_sessions_browser ON auth_sessions(browser_hash, revoked_at);
