import unittest
from pathlib import Path
from unittest import mock

from services.receipt_ocr import benchmark


class BenchmarkTests(unittest.TestCase):
    def test_evaluation_output_contains_metrics_without_receipt_values(self):
        entry = {
            "path": Path("private-receipt.jpg"),
            "expected": {"store_name": "店舗", "total_amount": 5382, "paid_at": "2026-07-11", "paid_time": "13:16"},
            "feedback": {},
        }
        result = {
            **entry["expected"],
            "needs_review": False,
            "processing_time_ms": 1200,
            "fallbacks": {"text_llm_calls": 1, "vision_calls": 0},
        }
        with mock.patch("services.receipt_ocr.benchmark.read_receipt_from_path", return_value=result):
            row = benchmark.evaluate_one(entry)
        self.assertTrue(all(row["correct"].values()))
        self.assertNotIn("store_name", row)
        self.assertNotIn("total_amount", row)
        self.assertEqual(row["text_llm_calls"], 1)

    def test_summary_reports_field_counts_percentiles_and_false_confirmation(self):
        rows = [
            {"correct": {field: True for field in benchmark.FIELDS}, "needs_review": False, "false_auto_confirm": False, "processing_time_ms": 100, "text_llm_calls": 0, "vision_calls": 0, "rss_mb": 100.0},
            {"correct": {field: field != "store_name" for field in benchmark.FIELDS}, "needs_review": False, "false_auto_confirm": True, "processing_time_ms": 300, "text_llm_calls": 1, "vision_calls": 2, "rss_mb": 120.0},
        ]
        report = benchmark.summarize("D", rows, 2)
        self.assertEqual(report["field_correct"]["store_name"], 1)
        self.assertEqual(report["false_auto_confirm_count"], 1)
        self.assertEqual(report["processing_time_ms"]["p95"], 300)
        self.assertEqual(report["max_rss_mb"], 120.0)


if __name__ == "__main__":
    unittest.main()
