from dataclasses import dataclass
import unittest

from services.receipt_ocr.receipt_rules import parse_receipt


@dataclass
class Line:
    text: str
    confidence: float = 0.95
    x: float = 10
    y: float = 10
    w: float = 100
    h: float = 12


def lines(*texts):
    return [Line(text, y=index * 20) for index, text in enumerate(texts)]


class ReceiptRulesTest(unittest.TestCase):
    def test_labeled_total_wins_over_large_unlabeled_value(self):
        result = parse_receipt(lines("商品A 380", "会員番号 999999", "合計 1,280"))
        self.assertEqual(result["total_amount"], 1280)

    def test_deposit_change_matches_total(self):
        result = parse_receipt(lines("合計 1,280", "お預り 2,000", "お釣り 720"))
        self.assertTrue(result["validations"]["deposit_change_total"])

    def test_invalid_arithmetic_requests_review(self):
        result = parse_receipt(lines("小計 1,000", "消費税 100", "合計 1,500"))
        self.assertTrue(result["needs_review"])
        self.assertFalse(result["validations"]["subtotal_tax_discount_total"])

    def test_reiwa_date_is_converted(self):
        result = parse_receipt(lines("令和6年 5月 2日", "合計 300"))
        self.assertEqual(result["paid_at"], "2024-05-02")

    def test_invalid_date_is_not_returned(self):
        result = parse_receipt(lines("2025年 2月 30日", "合計 300"))
        self.assertIsNone(result["paid_at"])
        self.assertTrue(result["needs_review"])

    def test_ocr_amount_character_correction_is_limited_to_amount(self):
        result = parse_receipt(lines("合計 1,28O"))
        self.assertEqual(result["total_amount"], 1280)

    def test_duplicate_item_names_are_preserved_when_source_rows_differ(self):
        result = parse_receipt(lines("牛乳 180", "牛乳 180", "合計 360"))
        self.assertEqual(result["items"], [{"name": "牛乳", "amount": 180}, {"name": "牛乳", "amount": 180}])

    def test_unlabeled_number_is_lower_confidence_than_total_label(self):
        result = parse_receipt(lines("品番 12345", "合計 450"))
        self.assertEqual(result["total_amount"], 450)
        self.assertGreaterEqual(result["field_confidence"]["total_amount"], 0.7)


if __name__ == "__main__":
    unittest.main()
