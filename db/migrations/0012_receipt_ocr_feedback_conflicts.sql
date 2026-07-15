CREATE TABLE receipt_ocr_feedback_submissions (
  import_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  ocr_result_id TEXT NOT NULL CHECK (length(ocr_result_id) BETWEEN 8 AND 128),
  confirmed_json TEXT NOT NULL CHECK (json_valid(confirmed_json) AND json_type(confirmed_json) = 'object'),
  created_at TEXT NOT NULL,
  FOREIGN KEY (import_id) REFERENCES import_records(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX idx_receipt_ocr_feedback_submissions_user
ON receipt_ocr_feedback_submissions(user_id, created_at);

CREATE TRIGGER trg_receipt_ocr_feedback_submission_active_user
BEFORE INSERT ON receipt_ocr_feedback_submissions
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND deleted_at IS NULL AND deletion_started_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'ocr_feedback_pending_user_inactive');
END;

CREATE TRIGGER trg_receipt_ocr_feedback_submission_pending_conflict
BEFORE INSERT ON receipt_ocr_feedback_submissions
WHEN EXISTS (
  SELECT 1
  FROM receipt_ocr_feedback_pending AS pending
  WHERE pending.import_id = NEW.import_id
    AND NOT (
      pending.user_id = NEW.user_id
      AND pending.project_id = NEW.project_id
      AND pending.transaction_id = NEW.transaction_id
      AND pending.ocr_result_id = NEW.ocr_result_id
      AND pending.confirmed_json = NEW.confirmed_json
    )
)
BEGIN
  SELECT RAISE(ABORT, 'ocr_feedback_content_conflict');
END;

CREATE TRIGGER trg_receipt_ocr_feedback_submission_content_conflict
BEFORE INSERT ON receipt_ocr_feedback_submissions
WHEN EXISTS (
  SELECT 1
  FROM receipt_ocr_feedback_submissions AS existing
  WHERE existing.import_id = NEW.import_id
    AND NOT (
      existing.user_id = NEW.user_id
      AND existing.project_id = NEW.project_id
      AND existing.transaction_id = NEW.transaction_id
      AND existing.ocr_result_id = NEW.ocr_result_id
      AND existing.confirmed_json = NEW.confirmed_json
    )
)
BEGIN
  SELECT RAISE(ABORT, 'ocr_feedback_content_conflict');
END;

CREATE TRIGGER trg_receipt_ocr_outcome_content_conflict
BEFORE INSERT ON receipt_ocr_field_outcomes
WHEN EXISTS (
  SELECT 1
  FROM receipt_ocr_field_outcomes AS existing
  WHERE existing.user_id = NEW.user_id
    AND existing.ocr_result_id = NEW.ocr_result_id
    AND existing.field_name = NEW.field_name
    AND existing.source_id = NEW.source_id
    AND NOT (
      existing.transaction_id IS NEW.transaction_id
      AND existing.ocr_model = NEW.ocr_model
      AND existing.preprocessing = NEW.preprocessing
      AND existing.confidence = NEW.confidence
      AND existing.was_corrected = NEW.was_corrected
    )
)
BEGIN
  SELECT RAISE(ABORT, 'ocr_feedback_content_conflict');
END;

CREATE TRIGGER trg_receipt_ocr_correction_content_conflict
BEFORE INSERT ON receipt_ocr_correction_events
WHEN EXISTS (
  SELECT 1
  FROM receipt_ocr_correction_events AS existing
  WHERE existing.user_id = NEW.user_id
    AND existing.ocr_result_id = NEW.ocr_result_id
    AND existing.field_name = NEW.field_name
    AND existing.source_id = NEW.source_id
    AND NOT (
      existing.transaction_id IS NEW.transaction_id
      AND existing.original_value = NEW.original_value
      AND existing.corrected_value = NEW.corrected_value
      AND existing.normalized_original_value = NEW.normalized_original_value
      AND existing.normalized_corrected_value = NEW.normalized_corrected_value
      AND existing.ocr_model = NEW.ocr_model
      AND existing.preprocessing = NEW.preprocessing
      AND existing.confidence = NEW.confidence
      AND existing.bounding_box_json IS NEW.bounding_box_json
      AND existing.source_text IS NEW.source_text
      AND existing.correction_source = NEW.correction_source
    )
)
BEGIN
  SELECT RAISE(ABORT, 'ocr_feedback_content_conflict');
END;
