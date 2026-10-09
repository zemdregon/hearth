-- Recipe integration: household measuring convention, reviewed ingredient-name mappings and
-- accepted ingredient calibrations (e.g. "1 cup = 120 g"). Additive; guards avoid CASE.
CREATE TABLE inv_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  measure_profile TEXT CHECK (measure_profile IN ('us-customary','us-label','metric-250')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
INSERT INTO inv_settings (id, measure_profile) VALUES (1, NULL);

CREATE TABLE inv_aliases (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  name_key TEXT NOT NULL CHECK (length(name_key) BETWEEN 1 AND 800),
  item_id TEXT NOT NULL REFERENCES inv_items(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_by TEXT NOT NULL REFERENCES auth_members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX inv_aliases_name ON inv_aliases(name_key) WHERE archived_at IS NULL;
CREATE INDEX inv_aliases_item ON inv_aliases(item_id) WHERE archived_at IS NULL;

-- Stored as the typed text so it is reviewable and exactly re-parsed; the server validates
-- amounts and units and that the two sides are different dimensions before inserting.
CREATE TABLE inv_calibrations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 100),
  item_id TEXT NOT NULL REFERENCES inv_items(id),
  from_amount TEXT NOT NULL CHECK (length(from_amount) BETWEEN 1 AND 64),
  from_unit TEXT NOT NULL CHECK (length(from_unit) BETWEEN 1 AND 50),
  from_profile TEXT CHECK (from_profile IN ('us-customary','us-label','metric-250')),
  to_amount TEXT NOT NULL CHECK (length(to_amount) BETWEEN 1 AND 64),
  to_unit TEXT NOT NULL CHECK (length(to_unit) BETWEEN 1 AND 50),
  to_profile TEXT CHECK (to_profile IN ('us-customary','us-label','metric-250')),
  -- The two dimensions, sorted and joined; at most one active calibration per item and pair, so
  -- the engine never sees conflicting ratios.
  dims TEXT NOT NULL CHECK (length(dims) BETWEEN 3 AND 60),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  accepted_by TEXT NOT NULL REFERENCES auth_members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX inv_calibrations_pair ON inv_calibrations(item_id, dims) WHERE archived_at IS NULL;

CREATE TRIGGER inv_aliases_cap BEFORE INSERT ON inv_aliases BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_LIMIT') WHERE (SELECT COUNT(*) FROM inv_aliases WHERE archived_at IS NULL) >= 5000;
END;
CREATE TRIGGER inv_calibrations_cap BEFORE INSERT ON inv_calibrations BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_LIMIT') WHERE (SELECT COUNT(*) FROM inv_calibrations WHERE archived_at IS NULL) >= 200;
END;
-- Mappings and calibrations may only point at an active item, and an item that still has
-- either cannot be archived out from under them.
CREATE TRIGGER inv_aliases_active_item BEFORE INSERT ON inv_aliases BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_REFERENCE') WHERE NOT EXISTS (SELECT 1 FROM inv_items WHERE id = NEW.item_id AND archived_at IS NULL);
END;
CREATE TRIGGER inv_calibrations_active_item BEFORE INSERT ON inv_calibrations BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_REFERENCE') WHERE NOT EXISTS (SELECT 1 FROM inv_items WHERE id = NEW.item_id AND archived_at IS NULL);
END;
CREATE TRIGGER inv_items_mapping_guard BEFORE UPDATE OF archived_at ON inv_items
  WHEN NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_IN_USE') WHERE EXISTS (SELECT 1 FROM inv_aliases WHERE item_id = OLD.id AND archived_at IS NULL)
    OR EXISTS (SELECT 1 FROM inv_calibrations WHERE item_id = OLD.id AND archived_at IS NULL);
END;
