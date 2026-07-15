CREATE TABLE receipt_ocr_feedback_pending (
  import_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  ocr_result_id TEXT NOT NULL CHECK (length(ocr_result_id) BETWEEN 8 AND 128),
  claims_json TEXT NOT NULL CHECK (json_valid(claims_json) AND json_type(claims_json) = 'object'),
  confirmed_json TEXT NOT NULL CHECK (json_valid(confirmed_json) AND json_type(confirmed_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (import_id) REFERENCES import_records(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX idx_receipt_ocr_feedback_pending_user
ON receipt_ocr_feedback_pending(user_id, created_at);

CREATE TRIGGER trg_receipt_ocr_feedback_pending_active_user
BEFORE INSERT ON receipt_ocr_feedback_pending
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND deleted_at IS NULL AND deletion_started_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'ocr_feedback_pending_user_inactive');
END;
