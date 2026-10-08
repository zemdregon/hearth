-- Runtime state is additive; permanent member and record ownership is unchanged.
ALTER TABLE auth_credentials ADD COLUMN name TEXT NOT NULL DEFAULT 'Passkey'
  CHECK (length(name) BETWEEN 1 AND 64 AND name = trim(name) AND instr(name, char(0)) = 0);
ALTER TABLE auth_challenges ADD COLUMN session_hash TEXT REFERENCES auth_sessions(token_hash);
CREATE INDEX auth_challenges_session ON auth_challenges(session_hash);

CREATE TABLE auth_rate_windows (
  key TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 80),
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0)
);
CREATE INDEX auth_rate_windows_time ON auth_rate_windows(window_start);

-- A failed CHECK aborts the enclosing D1 batch. Each successful operation removes
-- its own guard before commit; this makes authorization checks transactional.
CREATE TABLE auth_transaction_guards (
  id TEXT PRIMARY KEY NOT NULL,
  allowed INTEGER NOT NULL CHECK (allowed = 1)
);

-- Operator bootstrap is one-time even after expired grants and audits are pruned.
CREATE TABLE auth_operator_state (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'bootstrap'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);
