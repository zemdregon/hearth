-- Household inventory foundation. Additive: existing tables and records are untouched.
-- Quantities are integers in base units: ng (mass), nL (volume) or whole counts, so that
-- pounds, ounces, grams, millilitres and US cups are exact. Cap 9e15 < 2^53 (JS-safe).
-- Guards use SELECT ... WHERE shapes, never CASE (migration 0002 failed remotely on CASE).
CREATE TABLE inv_storage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ledger_count INTEGER NOT NULL CHECK (ledger_count >= 0)
);
INSERT INTO inv_storage (id, ledger_count) VALUES (1, 0);

CREATE TABLE inv_assert (ok INTEGER NOT NULL CHECK (ok = 1));

CREATE TABLE inv_locations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  name_key TEXT NOT NULL CHECK (length(name_key) BETWEEN 1 AND 400),
  kind TEXT NOT NULL CHECK (kind IN ('pantry','fridge','freezer','other')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX inv_locations_name ON inv_locations(name_key) WHERE archived_at IS NULL;

CREATE TABLE inv_items (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  name_key TEXT NOT NULL CHECK (length(name_key) BETWEEN 1 AND 800),
  dim TEXT NOT NULL CHECK (dim IN ('mass','volume','count:piece','count:egg','count:clove','count:head','count:bunch','count:slice','count:sprig')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX inv_items_name ON inv_items(name_key) WHERE archived_at IS NULL;

CREATE TABLE inv_lots (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 100),
  item_id TEXT NOT NULL REFERENCES inv_items(id),
  location_id TEXT REFERENCES inv_locations(id),
  qty INTEGER NOT NULL CHECK (typeof(qty) = 'integer' AND qty >= 0 AND qty <= 9000000000000000),
  precision TEXT NOT NULL CHECK (precision IN ('exact','estimated')),
  est_bp INTEGER NOT NULL DEFAULT 0 CHECK (typeof(est_bp) = 'integer' AND est_bp BETWEEN 0 AND 10000 AND (precision = 'estimated' OR est_bp = 0)),
  entered_text TEXT NOT NULL CHECK (length(entered_text) <= 60),
  date_kind TEXT CHECK (date_kind IN ('best_by','use_by')),
  date TEXT CHECK (date IS NULL OR date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((date_kind IS NULL) = (date IS NULL))
);
CREATE INDEX inv_lots_item ON inv_lots(item_id) WHERE archived_at IS NULL;
CREATE INDEX inv_lots_active ON inv_lots(id) WHERE archived_at IS NULL;

-- Append-only audit: the transaction header (idempotency key bound to actor, operation
-- and canonical request hash) and one ledger row per applied lot change.
CREATE TABLE inv_txns (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 8 AND 100),
  kind TEXT NOT NULL CHECK (kind IN ('add','adjust','count','archive')),
  member_id TEXT NOT NULL REFERENCES auth_members(id),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_at INTEGER NOT NULL
);
CREATE TABLE inv_ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id TEXT NOT NULL REFERENCES inv_txns(id),
  lot_id TEXT NOT NULL REFERENCES inv_lots(id),
  item_id TEXT NOT NULL REFERENCES inv_items(id),
  delta INTEGER NOT NULL CHECK (typeof(delta) = 'integer' AND delta BETWEEN -9000000000000000 AND 9000000000000000),
  qty_after INTEGER NOT NULL CHECK (typeof(qty_after) = 'integer' AND qty_after BETWEEN 0 AND 9000000000000000),
  reason TEXT NOT NULL CHECK (length(reason) <= 200),
  created_at INTEGER NOT NULL,
  UNIQUE (txn_id, lot_id)
);
CREATE INDEX inv_ledger_lot ON inv_ledger(lot_id);

CREATE TRIGGER inv_txns_no_update BEFORE UPDATE ON inv_txns BEGIN SELECT RAISE(ABORT, 'INVENTORY_LEDGER_IMMUTABLE'); END;
CREATE TRIGGER inv_txns_no_delete BEFORE DELETE ON inv_txns BEGIN SELECT RAISE(ABORT, 'INVENTORY_LEDGER_IMMUTABLE'); END;
CREATE TRIGGER inv_ledger_no_update BEFORE UPDATE ON inv_ledger BEGIN SELECT RAISE(ABORT, 'INVENTORY_LEDGER_IMMUTABLE'); END;
CREATE TRIGGER inv_ledger_no_delete BEFORE DELETE ON inv_ledger BEGIN SELECT RAISE(ABORT, 'INVENTORY_LEDGER_IMMUTABLE'); END;

-- Caps protect Worker memory and payloads, not D1. Active-row counts use partial indexes;
-- the ledger uses a counter so inserts never scan it.
CREATE TRIGGER inv_locations_cap BEFORE INSERT ON inv_locations BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_LIMIT') WHERE (SELECT COUNT(*) FROM inv_locations WHERE archived_at IS NULL) >= 50;
END;
CREATE TRIGGER inv_items_cap BEFORE INSERT ON inv_items BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_LIMIT') WHERE (SELECT COUNT(*) FROM inv_items WHERE archived_at IS NULL) >= 1000;
END;
CREATE TRIGGER inv_lots_cap BEFORE INSERT ON inv_lots BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_LIMIT') WHERE (SELECT COUNT(*) FROM inv_lots WHERE archived_at IS NULL) >= 2000;
END;
-- Archiving must stay possible at the cap (it is how stock is retired), so it gets headroom.
CREATE TRIGGER inv_ledger_cap BEFORE INSERT ON inv_ledger BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_LEDGER_FULL')
    WHERE (SELECT ledger_count FROM inv_storage WHERE id = 1) >= 100000
      AND ((SELECT ledger_count FROM inv_storage WHERE id = 1) >= 101000
        OR (SELECT kind FROM inv_txns WHERE id = NEW.txn_id) IS NOT 'archive');
END;
CREATE TRIGGER inv_ledger_count AFTER INSERT ON inv_ledger BEGIN
  UPDATE inv_storage SET ledger_count = ledger_count + 1 WHERE id = 1;
END;

-- An item or location with live stock cannot be archived out from under its lots, and a
-- lot can only reference an active item (and an active location when it has one).
CREATE TRIGGER inv_items_archive_guard BEFORE UPDATE OF archived_at ON inv_items
  WHEN NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_IN_USE') WHERE EXISTS (SELECT 1 FROM inv_lots WHERE item_id = OLD.id AND archived_at IS NULL);
END;
CREATE TRIGGER inv_locations_archive_guard BEFORE UPDATE OF archived_at ON inv_locations
  WHEN NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_IN_USE') WHERE EXISTS (SELECT 1 FROM inv_lots WHERE location_id = OLD.id AND archived_at IS NULL);
END;
CREATE TRIGGER inv_lots_active_refs BEFORE INSERT ON inv_lots BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_REFERENCE')
    WHERE NOT EXISTS (SELECT 1 FROM inv_items WHERE id = NEW.item_id AND archived_at IS NULL)
      OR (NEW.location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inv_locations WHERE id = NEW.location_id AND archived_at IS NULL));
END;
