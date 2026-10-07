-- Bound whole-family bootstrap/export memory, including hidden and disabled records.
-- Byte accounting stays in the same SQLite transaction as each record mutation.
CREATE TABLE family_storage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_bytes INTEGER NOT NULL CHECK (data_bytes >= 0),
  record_count INTEGER NOT NULL CHECK (record_count >= 0)
);
INSERT INTO family_storage (id, data_bytes, record_count)
  SELECT 1, COALESCE(SUM(length(CAST(data AS BLOB))), 0), COUNT(*) FROM records;

CREATE TRIGGER records_budget_before_insert BEFORE INSERT ON records BEGIN
  SELECT CASE WHEN (SELECT record_count FROM family_storage WHERE id = 1) >= 10000
    OR (SELECT data_bytes FROM family_storage WHERE id = 1) + length(CAST(NEW.data AS BLOB)) > 8388608
    THEN RAISE(ABORT, 'FAMILY_STORAGE_LIMIT') END;
END;
CREATE TRIGGER records_budget_before_update BEFORE UPDATE OF data ON records BEGIN
  SELECT CASE WHEN length(CAST(NEW.data AS BLOB)) > length(CAST(OLD.data AS BLOB))
    AND (SELECT data_bytes FROM family_storage WHERE id = 1) - length(CAST(OLD.data AS BLOB)) + length(CAST(NEW.data AS BLOB)) > 8388608
    THEN RAISE(ABORT, 'FAMILY_STORAGE_LIMIT') END;
END;
CREATE TRIGGER records_budget_after_insert AFTER INSERT ON records BEGIN
  UPDATE family_storage SET data_bytes = data_bytes + length(CAST(NEW.data AS BLOB)), record_count = record_count + 1 WHERE id = 1;
END;
CREATE TRIGGER records_budget_after_update AFTER UPDATE OF data ON records BEGIN
  UPDATE family_storage SET data_bytes = data_bytes - length(CAST(OLD.data AS BLOB)) + length(CAST(NEW.data AS BLOB)) WHERE id = 1;
END;
CREATE TRIGGER records_budget_after_delete AFTER DELETE ON records BEGIN
  UPDATE family_storage SET data_bytes = data_bytes - length(CAST(OLD.data AS BLOB)), record_count = record_count - 1 WHERE id = 1;
END;
