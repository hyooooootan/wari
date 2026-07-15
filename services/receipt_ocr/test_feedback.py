import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from services.receipt_ocr.feedback import apply_feedback, normalize_store, preprocessing_order, store_correction_candidates
from services.receipt_ocr.ollama_fallback import (
    apply_text_correction,
    apply_vision_output,
    apply_vision_reread,
    read_region,
    region_box,
    required_regions,
    valid_date,
    valid_time,
    validate_text_output,
)


def base_result(store="たまた 浜見平店", store_confidence=0.64):
    return {
        "store_name": store,
        "total_amount": 5382,
        "paid_at": "2026-07-11",
        "paid_time": "13:16",
        "needs_review": False,
        "warnings": [],
        "validations": {"subtotal_tax_discount_total": True},
        "field_confidence": {"store_name": store_confidence, "total_amount": 0.95, "paid_at": 0.85, "paid_time": 0.85},
        "field_evidence": {"store_name": {"source_id": "store:0", "bounding_box": [0.1, 0.02, 0.8, 0.12], "confidence": store_confidence}},
        "total_candidates": [{"value": 5382}, {"value": 4984}],
    }


class FeedbackTests(unittest.TestCase):
    def test_store_normalization_preserves_long_vowel(self):
        self.assertEqual(normalize_store(" スーパー  A "), "スーパー a")

    def test_exact_repeated_store_correction_is_applied(self):
        feedback = {"store_corrections": [{"original": "たまた 浜見平店", "corrected": "たまや 浜見平店", "count": 3}]}
        with mock.patch.dict(os.environ, {"RECEIPT_OCR_ENABLE_FEEDBACK": "true"}):
            result = apply_feedback(base_result(), feedback)
        self.assertEqual(result["store_name"], "たまや 浜見平店")
        self.assertTrue(result["fallbacks"]["past_feedback_used"])

    def test_single_or_conflicting_store_correction_is_not_applied(self):
        with mock.patch.dict(os.environ, {"RECEIPT_OCR_ENABLE_FEEDBACK": "true"}):
            single = apply_feedback(base_result(), {"store_corrections": [{"original": "たまた 浜見平店", "corrected": "たまや 浜見平店", "count": 1}]})
        self.assertEqual(single["store_name"], "たまた 浜見平店")
        self.assertTrue(single["needs_review"])
        with mock.patch.dict(os.environ, {"RECEIPT_OCR_ENABLE_FEEDBACK": "true"}):
            conflict = apply_feedback(base_result(), {"store_corrections": [
                {"original": "たまた 浜見平店", "corrected": "たまや 浜見平店", "count": 3},
                {"original": "たまた 浜見平店", "corrected": "たまや 茅ヶ崎店", "count": 3},
            ]})
        self.assertEqual(conflict["store_name"], "たまた 浜見平店")
        self.assertTrue(conflict["needs_review"])

    def test_store_correction_cannot_change_digits(self):
        with mock.patch.dict(os.environ, {"RECEIPT_OCR_ENABLE_FEEDBACK": "true"}):
            result = apply_feedback(base_result("第1支店"), {"store_corrections": [{"original": "第1支店", "corrected": "第2支店", "count": 4}]})
        self.assertEqual(result["store_name"], "第1支店")
        self.assertTrue(result["needs_review"])

    def test_low_similarity_is_excluded(self):
        candidates = store_correction_candidates("無関係店", {"store_corrections": [{"original": "たまた 浜見平店", "corrected": "たまや 浜見平店", "count": 3}]})
        self.assertEqual(candidates, [])

    def test_preprocessing_order_requires_five_matching_model_outcomes(self):
        default = ("clahe", "adaptive")
        sparse = {"preprocessing_stats": [{"field_name": "store_name", "ocr_model": "m1", "preprocessing": "adaptive", "confirmed_count": 4, "correct_count": 4}]}
        with mock.patch.dict(os.environ, {"RECEIPT_OCR_ENABLE_FEEDBACK": "true"}):
            self.assertEqual(preprocessing_order(sparse, "store_name", "m1", default), list(default))
        enough = {"preprocessing_stats": [{"field_name": "store_name", "ocr_model": "m1", "preprocessing": "adaptive", "confirmed_count": 10, "correct_count": 9}]}
        with mock.patch.dict(os.environ, {"RECEIPT_OCR_ENABLE_FEEDBACK": "true"}):
            self.assertEqual(preprocessing_order(enough, "store_name", "m1", default), ["adaptive", "clahe"])
            self.assertEqual(preprocessing_order(enough, "store_name", "m2", default), list(default))

    def test_feedback_disabled_preserves_current_result_and_default_preprocessing(self):
        feedback = {"store_corrections": [{"original": "たまた 浜見平店", "corrected": "たまや 浜見平店", "count": 3}]}
        with mock.patch.dict(os.environ, {"RECEIPT_OCR_ENABLE_FEEDBACK": "false"}):
            result = apply_feedback(base_result(), feedback)
            order = preprocessing_order({"preprocessing_stats": []}, "store_name", "m1", ("clahe", "adaptive"))
        self.assertEqual(result["store_name"], "たまた 浜見平店")
        self.assertEqual(order, ["clahe", "adaptive"])

    def test_text_output_preserves_source_original_and_digits(self):
        past = [{"corrected": "たまや 浜見平店"}]
        valid = {"source_id": "store:0", "original": "たまた 浜見平店", "corrected": "たまや 浜見平店"}
        self.assertEqual(validate_text_output(valid, "store:0", "たまた 浜見平店", past), "たまや 浜見平店")
        self.assertIsNone(validate_text_output({**valid, "source_id": "other"}, "store:0", "たまた 浜見平店", past))
        self.assertIsNone(validate_text_output({**valid, "corrected": "たまや2号店"}, "store:0", "たまた1号店", past))
        self.assertIsNone(validate_text_output("broken", "store:0", "店", past))

    def test_text_model_failure_returns_normal_ocr(self):
        feedback = {"store_corrections": [{"original": "たまた 浜見平店", "corrected": "たまや 浜見平店", "count": 1}]}
        with mock.patch.dict(os.environ, {"OCR_TEXT_LLM_ENABLED": "true"}), mock.patch("services.receipt_ocr.ollama_fallback.ollama_generate", side_effect=TimeoutError()):
            result = apply_text_correction(base_result(), feedback)
        self.assertEqual(result["store_name"], "たまた 浜見平店")
        self.assertFalse(result.get("fallbacks", {}).get("text_llm_used", False))

    def test_text_model_correction_never_clears_review(self):
        output = {"source_id": "store:0", "original": "たまた 浜見平店", "corrected": "たまや 浜見平店"}
        feedback = {"store_corrections": [{"original": "たまた 浜見平店", "corrected": "たまや 浜見平店", "count": 1}]}
        with mock.patch.dict(os.environ, {"OCR_TEXT_LLM_ENABLED": "true"}), mock.patch("services.receipt_ocr.ollama_fallback.ollama_generate", return_value=output):
            result = apply_text_correction(base_result(), feedback)
        self.assertEqual(result["store_name"], "たまや 浜見平店")
        self.assertTrue(result["needs_review"])
        self.assertTrue(result["fallbacks"]["text_llm_used"])

    def test_vision_total_requires_existing_candidate(self):
        result = base_result()
        apply_vision_output(result, "total_region", {"read_amount": 5332, "label": "合計", "confidence": 0.9})
        self.assertNotIn("vision_candidates", result)
        apply_vision_output(result, "total_region", {"read_amount": 5382, "label": "合計", "confidence": 0.9})
        self.assertEqual(result["vision_candidates"]["total_amount"], 5382)
        self.assertEqual(result["field_sources"]["total_amount"], "paddleocr_rule_vision_agreement")

    def test_vision_date_and_time_validation(self):
        self.assertIsNone(valid_date("2026-02-30"))
        self.assertIsNone(valid_time("24:00"))
        self.assertEqual(valid_time("23:59"), "23:59")

    def test_high_confidence_result_does_not_request_vision(self):
        result = base_result(store_confidence=0.9)
        self.assertEqual(required_regions(result), [])

    def test_region_crop_is_local_and_temporary_file_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "receipt.jpg"
            Image.new("RGB", (100, 200), "white").save(image_path)
            seen = []
            temporary_paths = []
            named_temporary_file = tempfile.NamedTemporaryFile

            def fake_generate(_model, _prompt, _timeout, images):
                seen.append(images[0])
                return {"store_name": "店", "confidence": 0.8}

            def tracked_temporary_file(*args, **kwargs):
                kwargs["dir"] = directory
                handle = named_temporary_file(*args, **kwargs)
                temporary_paths.append(Path(handle.name))
                return handle

            with mock.patch("services.receipt_ocr.ollama_fallback.tempfile.NamedTemporaryFile", side_effect=tracked_temporary_file), mock.patch("services.receipt_ocr.ollama_fallback.ollama_generate", side_effect=fake_generate):
                output = read_region(image_path, base_result(), "store_region")
            self.assertEqual(output["store_name"], "店")
            self.assertTrue(seen[0])
            self.assertTrue(temporary_paths)
            self.assertTrue(all(not path.exists() for path in temporary_paths))

    def test_vision_disabled_returns_without_model_call(self):
        with mock.patch.dict(os.environ, {"OCR_VISION_ENABLED": "false"}), mock.patch("services.receipt_ocr.ollama_fallback.ollama_generate") as generate:
            result = apply_vision_reread(base_result(), Path("missing.jpg"))
        generate.assert_not_called()
        self.assertFalse(result.get("fallbacks", {}).get("vision_reread_used", False))

    def test_region_box_is_bounded(self):
        box = region_box(base_result(), "store_region")
        self.assertTrue(all(0 <= value <= 1 for value in box))

    def test_total_band_coordinates_are_mapped_back_to_the_original_image(self):
        result = base_result()
        result["field_evidence"]["total_amount"] = {"bounding_box": [0.2, 0.5, 0.8, 0.7], "preprocessing": "total-band"}
        box = region_box(result, "total_region")
        self.assertGreater(box[1], 0.6)
        self.assertLessEqual(box[3], 1.0)

    def test_expired_processing_budget_skips_optional_models(self):
        feedback = {"store_corrections": [{"original": "たまた 浜見平店", "corrected": "たまや 浜見平店", "count": 1}]}
        with mock.patch.dict(os.environ, {"RECEIPT_OCR_ENABLE_TEXT_CORRECTION": "true", "RECEIPT_OCR_ENABLE_VISION_REREAD": "true"}), mock.patch("services.receipt_ocr.ollama_fallback.ollama_generate") as generate:
            text_result = apply_text_correction(base_result(), feedback, remaining_seconds=0)
            vision_result = apply_vision_reread(base_result(store_confidence=0.1), Path("missing.jpg"), remaining_seconds=0)
        generate.assert_not_called()
        self.assertEqual(text_result["store_name"], "たまた 浜見平店")
        self.assertFalse(vision_result.get("fallbacks", {}).get("vision_reread_used", False))


if __name__ == "__main__":
    unittest.main()
