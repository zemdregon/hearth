-- Confirmed consumption and undo. Additive: a consumption is an ordinary 'adjust' transaction
-- (one negative ledger row per lot) plus an immutable header recording what was cooked. An undo
-- is a second transaction whose header points back with reverses_txn_id (UNIQUE: undone once,
-- and an undo cannot itself be undone because only non-reversal headers are eligible).
CREATE TABLE inv_consumptions (
  txn_id TEXT PRIMARY KEY NOT NULL REFERENCES inv_txns(id),
  recipe_id TEXT CHECK (recipe_id IS NULL OR length(recipe_id) BETWEEN 1 AND 100),
  recipe_title TEXT NOT NULL CHECK (length(recipe_title) BETWEEN 1 AND 200),
  servings INTEGER NOT NULL CHECK (typeof(servings) = 'integer' AND servings BETWEEN 1 AND 1000),
  -- Amounts the cook says were used beyond recorded stock; never applied to any lot.
  shortfalls TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(shortfalls) AND length(shortfalls) <= 8000),
  reverses_txn_id TEXT UNIQUE REFERENCES inv_txns(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX inv_consumptions_created ON inv_consumptions(created_at);
CREATE TRIGGER inv_consumptions_no_update BEFORE UPDATE ON inv_consumptions BEGIN SELECT RAISE(ABORT, 'INVENTORY_LEDGER_IMMUTABLE'); END;
CREATE TRIGGER inv_consumptions_no_delete BEFORE DELETE ON inv_consumptions BEGIN SELECT RAISE(ABORT, 'INVENTORY_LEDGER_IMMUTABLE'); END;
