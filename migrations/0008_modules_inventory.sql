-- Widen the module id CHECK (SQLite cannot alter it in place) and add the inventory
-- module disabled until an administrator enables it. Nothing references modules.
CREATE TABLE modules_next (
  id TEXT PRIMARY KEY NOT NULL CHECK (id IN ('recipes','tasks','notes','streaks','events','moods','questions','profiles','goals','inventory')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
);
INSERT INTO modules_next (id, enabled) SELECT id, enabled FROM modules;
DROP TABLE modules;
ALTER TABLE modules_next RENAME TO modules;
INSERT OR IGNORE INTO modules (id, enabled) VALUES ('inventory', 0);
