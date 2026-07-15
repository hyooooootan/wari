CREATE TABLE receipt_ocr_correction_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT,
  ocr_result_id TEXT NOT NULL CHECK (length(ocr_result_id) BETWEEN 8 AND 128),
  field_name TEXT NOT NULL CHECK (field_name IN ('store_name', 'total_amount', 'paid_at', 'paid_time', 'item_name', 'item_amount')),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 64),
  original_value TEXT NOT NULL CHECK (length(original_value) BETWEEN 0 AND 200),
  corrected_value TEXT NOT NULL CHECK (length(corrected_value) BETWEEN 1 AND 200),
  normalized_original_value TEXT NOT NULL CHECK (length(normalized_original_value) BETWEEN 0 AND 200),
  normalized_corrected_value TEXT NOT NULL CHECK (length(normalized_corrected_value) BETWEEN 1 AND 200),
  ocr_model TEXT NOT NULL CHECK (length(ocr_model) BETWEEN 1 AND 100),
  preprocessing TEXT NOT NULL CHECK (length(preprocessing) BETWEEN 1 AND 100),
  confidence REAL NOT NULL CHECK (typeof(confidence) IN ('integer', 'real') AND confidence BETWEEN 0 AND 1),
  bounding_box_json TEXT CHECK (bounding_box_json IS NULL OR (json_valid(bounding_box_json) AND json_type(bounding_box_json) = 'array' AND json_array_length(bounding_box_json) = 4)),
  source_text TEXT CHECK (source_text IS NULL OR length(source_text) <= 500),
  correction_source TEXT NOT NULL DEFAULT 'user_confirmed' CHECK (correction_source = 'user_confirmed'),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, ocr_result_id, field_name, source_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX idx_receipt_ocr_corrections_user_created
ON receipt_ocr_correction_events(user_id, created_at DESC);

CREATE INDEX idx_receipt_ocr_corrections_lookup
ON receipt_ocr_correction_events(user_id, field_name, normalized_original_value, normalized_corrected_value);

CREATE TABLE receipt_ocr_field_outcomes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT,
  ocr_result_id TEXT NOT NULL CHECK (length(ocr_result_id) BETWEEN 8 AND 128),
  field_name TEXT NOT NULL CHECK (field_name IN ('store_name', 'total_amount', 'paid_at', 'paid_time', 'item_name', 'item_amount')),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 64),
  ocr_model TEXT NOT NULL CHECK (length(ocr_model) BETWEEN 1 AND 100),
  preprocessing TEXT NOT NULL CHECK (length(preprocessing) BETWEEN 1 AND 100),
  confidence REAL NOT NULL CHECK (typeof(confidence) IN ('integer', 'real') AND confidence BETWEEN 0 AND 1),
  was_corrected INTEGER NOT NULL CHECK (was_corrected IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, ocr_result_id, field_name, source_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX idx_receipt_ocr_outcomes_stats
ON receipt_ocr_field_outcomes(user_id, field_name, ocr_model, preprocessing, was_corrected);

CREATE TRIGGER trg_receipt_ocr_correction_active_user
BEFORE INSERT ON receipt_ocr_correction_events
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND deleted_at IS NULL AND deletion_started_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'ocr_correction_user_inactive');
END;

CREATE TRIGGER trg_receipt_ocr_outcome_active_user
BEFORE INSERT ON receipt_ocr_field_outcomes
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND deleted_at IS NULL AND deletion_started_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'ocr_correction_user_inactive');
END;
