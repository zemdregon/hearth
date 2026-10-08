-- Recoveries compact full credential records while permanently preventing a
-- retired credential ID from being registered again, including by another member.
-- Hashes are SHA-256 of the exact credential ID's UTF-8 base64url text.
CREATE TABLE auth_credential_tombstones (
  id_hash TEXT PRIMARY KEY NOT NULL
    CHECK (length(id_hash) = 43 AND id_hash NOT GLOB '*[^A-Za-z0-9_-]*' AND length(CAST(id_hash AS BLOB)) = 43),
  member_id TEXT NOT NULL REFERENCES auth_members(id),
  retired_at INTEGER NOT NULL CHECK (typeof(retired_at) = 'integer' AND retired_at >= 0)
);
CREATE INDEX auth_credential_tombstones_member ON auth_credential_tombstones(member_id);
