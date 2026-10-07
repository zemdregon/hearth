CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recipe','task','note','habit','habitLog','event','mood','answer','profile','goal')),
  owner_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX records_kind_updated ON records(kind, updated_at);
CREATE INDEX records_owner ON records(owner_id);
CREATE UNIQUE INDEX one_profile_per_member ON records(owner_id) WHERE kind = 'profile';
CREATE UNIQUE INDEX one_mood_per_day ON records(owner_id, json_extract(data, '$.date')) WHERE kind = 'mood';
CREATE UNIQUE INDEX one_answer_per_day ON records(owner_id, json_extract(data, '$.date')) WHERE kind = 'answer';
CREATE UNIQUE INDEX one_habit_log_per_day ON records(owner_id, json_extract(data, '$.habitId'), json_extract(data, '$.date')) WHERE kind = 'habitLog';

CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY NOT NULL CHECK (id IN ('recipes','tasks','notes','streaks','events','moods','questions','profiles','goals')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0)
);
