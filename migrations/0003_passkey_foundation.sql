-- Additive foundation only: no enrollment, member import, runtime cutover or seed data.
-- All auth timestamps use INTEGER Unix seconds. Hashes and user handles are
-- unpadded base64url encodings of 32 bytes. No private keys or identity emails.
CREATE TABLE auth_members (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(CAST(id AS BLOB)) = length(id)),
  name TEXT NOT NULL
    CHECK (length(name) BETWEEN 1 AND 100 AND name = trim(name) AND length(trim(name)) > 0 AND instr(name, char(0)) = 0),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  color TEXT NOT NULL
    CHECK (length(color) = 7 AND substr(color, 1, 1) = '#' AND substr(color, 2) NOT GLOB '*[^0-9A-Fa-f]*' AND length(CAST(color AS BLOB)) = 7),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  user_handle TEXT NOT NULL UNIQUE
    CHECK (length(user_handle) = 43 AND user_handle NOT GLOB '*[^A-Za-z0-9_-]*' AND length(CAST(user_handle AS BLOB)) = 43),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at)
);
CREATE INDEX auth_members_status_role ON auth_members(status, role);

CREATE TABLE auth_credentials (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 1 AND 2048 AND id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(CAST(id AS BLOB)) = length(id)),
  member_id TEXT NOT NULL REFERENCES auth_members(id),
  public_key TEXT NOT NULL
    CHECK (length(public_key) BETWEEN 1 AND 8192 AND public_key NOT GLOB '*[^A-Za-z0-9_-]*' AND length(CAST(public_key AS BLOB)) = length(public_key)),
  counter INTEGER NOT NULL DEFAULT 0 CHECK (typeof(counter) = 'integer' AND counter BETWEEN 0 AND 4294967295),
  transports TEXT NOT NULL DEFAULT '[]'
    CHECK (length(CAST(transports AS BLOB)) <= 512 AND CASE WHEN json_valid(transports) THEN json_type(transports) = 'array' AND json_array_length(transports) <= 8 ELSE 0 END),
  backup_eligible INTEGER NOT NULL CHECK (typeof(backup_eligible) = 'integer' AND backup_eligible IN (0, 1)),
  backed_up INTEGER NOT NULL CHECK (typeof(backed_up) = 'integer' AND backed_up IN (0, 1) AND backed_up <= backup_eligible),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  last_used_at INTEGER CHECK (last_used_at IS NULL OR (typeof(last_used_at) = 'integer' AND last_used_at >= created_at)),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'integer' AND revoked_at >= created_at)),
  UNIQUE (id, member_id)
);
CREATE INDEX auth_credentials_member ON auth_credentials(member_id, revoked_at);

CREATE TABLE auth_enrollment_grants (
  token_hash TEXT PRIMARY KEY NOT NULL
    CHECK (length(token_hash) = 43 AND token_hash NOT GLOB '*[^A-Za-z0-9_-]*' AND length(CAST(token_hash AS BLOB)) = 43),
  member_id TEXT NOT NULL REFERENCES auth_members(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('bootstrap', 'enroll', 'recover')),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  -- One day is an upper bound; issuance may choose a shorter lifetime.
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at AND expires_at - created_at <= 86400),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR (typeof(consumed_at) = 'integer' AND consumed_at >= created_at AND consumed_at < expires_at)),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'integer' AND revoked_at >= created_at)),
  UNIQUE (token_hash, member_id)
);
CREATE INDEX auth_enrollment_grants_member ON auth_enrollment_grants(member_id, consumed_at, revoked_at);
CREATE INDEX auth_enrollment_grants_expiry ON auth_enrollment_grants(expires_at);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(CAST(id AS BLOB)) = length(id)),
  challenge TEXT NOT NULL UNIQUE
    CHECK (length(challenge) BETWEEN 43 AND 128 AND challenge NOT GLOB '*[^A-Za-z0-9_-]*' AND length(CAST(challenge AS BLOB)) = length(challenge)),
  browser_hash TEXT NOT NULL
    CHECK (length(browser_hash) = 43 AND browser_hash NOT GLOB '*[^A-Za-z0-9_-]*' AND length(CAST(browser_hash AS BLOB)) = 43),
  purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication', 'reauthentication')),
  member_id TEXT REFERENCES auth_members(id),
  grant_hash TEXT REFERENCES auth_enrollment_grants(token_hash),
  -- Exact canonical origin/RP validation remains a ceremony-handler obligation.
  origin TEXT NOT NULL CHECK (length(origin) BETWEEN 1 AND 2048 AND origin = trim(origin) AND instr(origin, char(0)) = 0),
  rp_id TEXT NOT NULL CHECK (length(rp_id) BETWEEN 1 AND 253 AND rp_id = trim(rp_id) AND instr(rp_id, char(0)) = 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at AND expires_at - created_at <= 300),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR (typeof(consumed_at) = 'integer' AND consumed_at >= created_at AND consumed_at < expires_at)),
  CHECK (purpose = 'authentication' OR member_id IS NOT NULL),
  CHECK (grant_hash IS NULL OR (purpose = 'registration' AND member_id IS NOT NULL)),
  FOREIGN KEY (grant_hash, member_id) REFERENCES auth_enrollment_grants(token_hash, member_id)
);
CREATE INDEX auth_challenges_browser ON auth_challenges(browser_hash, purpose, expires_at);
CREATE INDEX auth_challenges_member ON auth_challenges(member_id);
CREATE INDEX auth_challenges_grant ON auth_challenges(grant_hash);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL
    CHECK (length(token_hash) = 43 AND token_hash NOT GLOB '*[^A-Za-z0-9_-]*' AND length(CAST(token_hash AS BLOB)) = 43),
  member_id TEXT NOT NULL REFERENCES auth_members(id),
  credential_id TEXT NOT NULL REFERENCES auth_credentials(id),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (typeof(last_seen_at) = 'integer' AND last_seen_at >= created_at AND last_seen_at < expires_at),
  -- Thirty days is an absolute upper bound, not an implemented session policy.
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at AND expires_at - created_at <= 2592000),
  reauthenticated_at INTEGER CHECK (reauthenticated_at IS NULL OR (typeof(reauthenticated_at) = 'integer' AND reauthenticated_at >= created_at AND reauthenticated_at < expires_at)),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'integer' AND revoked_at >= created_at)),
  FOREIGN KEY (credential_id, member_id) REFERENCES auth_credentials(id, member_id)
);
CREATE INDEX auth_sessions_member ON auth_sessions(member_id, revoked_at);
CREATE INDEX auth_sessions_credential ON auth_sessions(credential_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE auth_audit (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(CAST(id AS BLOB)) = length(id)),
  actor_id TEXT REFERENCES auth_members(id),
  target_id TEXT REFERENCES auth_members(id),
  -- Bounded event identifiers only. No free-form detail or private payload column.
  event TEXT NOT NULL
    CHECK (length(event) BETWEEN 1 AND 64 AND event NOT GLOB '*[^a-z0-9_.]*' AND length(CAST(event AS BLOB)) = length(event)),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);
CREATE INDEX auth_audit_actor ON auth_audit(actor_id, created_at);
CREATE INDEX auth_audit_target ON auth_audit(target_id, created_at);
CREATE INDEX auth_audit_created ON auth_audit(created_at);
