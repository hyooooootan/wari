import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMerchantName, sanitizeImportPayload } from "../functions/lib/normalization.js";
import {
  classifyMatchCandidates,
  getCandidateWindowMs,
  resolveTransactionFields,
  scoreMatch,
} from "../functions/lib/matching.js";
import { makeSourceRecordId, mapCsvRows, parseCsv } from "../functions/lib/csv.js";

test("店舗名を表示名と分けて比較用に正規化する", () => {
  assert.equal(normalizeMerchantName("株式会社 セブン－イレブン 東京駅店"), "セブンイレブン");
  assert.equal(normalizeMerchantName("ＡＭＡＺＯＮ．ＣＯ．ＪＰ"), "amazon");
});

test("強い条件が複数あり候補が一件なら接続する", () => {
  const incoming = { source_type: "receipt", merchant_raw: "ローソン", paid_amount_raw: 800, occurred_at_raw: "2026-07-10T12:00:00+09:00", payment_method_raw: "カード" };
  const candidate = { source_type: "card_csv", merchant_name: "LAWSON", paid_amount: 800, occurred_at: "2026-07-10T12:20:00+09:00", payment_method: "credit_card" };
  const scored = { candidate, ...scoreMatch(incoming, candidate) };
  assert.ok(scored.score >= 85);
  assert.equal(classifyMatchCandidates([scored]).action, "link");
});

test("同じ店と金額の近接候補が複数ある場合は確認へ送る", () => {
  const incoming = { source_type: "receipt", merchant_raw: "コンビニ", paid_amount_raw: 500, occurred_at_raw: "2026-07-10T12:00:00+09:00" };
  const first = { id: "a", source_type: "card_csv", merchant_name: "コンビニ", paid_amount: 500, occurred_at: "2026-07-10T12:10:00+09:00" };
  const second = { id: "b", source_type: "card_csv", merchant_name: "コンビニ", paid_amount: 500, occurred_at: "2026-07-10T12:20:00+09:00" };
  assert.equal(classifyMatchCandidates([{ candidate: first, ...scoreMatch(incoming, first) }, { candidate: second, ...scoreMatch(incoming, second) }]).action, "review");
});

test("取消と通常購入を自動接続しない", () => {
  const incoming = { source_type: "card_csv", merchant_raw: "ホテル", paid_amount_raw: -12000, occurred_at_raw: "2026-07-01", status: "refunded" };
  const candidate = { source_type: "receipt", merchant_name: "ホテル", paid_amount: 12000, occurred_at: "2026-07-01", status: "confirmed" };
  assert.ok(scoreMatch(incoming, candidate).score < 55);
});

test("情報源の採用順位を項目ごとに適用する", () => {
  const result = resolveTransactionFields([
    { source_type: "gmail_notification", merchant_raw: "短縮店名", paid_amount_raw: 1000, occurred_at_raw: "2026-07-01T10:00:00+09:00" },
    { source_type: "card_csv", merchant_raw: "カード店名", paid_amount_raw: 1200, settled_at_raw: "2026-07-03", occurred_at_raw: "2026-07-01" },
    { source_type: "receipt", merchant_raw: "正式店名", paid_amount_raw: 1100, occurred_at_raw: "2026-07-01T09:55:00+09:00" },
  ]);
  assert.equal(result.fields.paid_amount, 1200);
  assert.equal(result.fields.merchant_name, "正式店名");
  assert.equal(result.fields.occurred_at, "2026-07-01T09:55:00+09:00");
  assert.equal(result.fields.status, "confirmed");
});

test("CSVの引用符、改行、日本語見出しを解析する", () => {
  const parsed = parseCsv('利用日,利用店名,利用金額\r\n2026/07/01,"店, 一号",1,200\r\n2026/07/02,"複数\n行",500');
  assert.equal(parsed.rows.length, 2);
  const rows = mapCsvRows(parsed, "card");
  assert.equal(rows[1].merchant_raw, "複数\n行");
  assert.equal(rows[1].paid_amount_raw, 500);
});

test("同じCSV行は同じ再取込識別子になる", async () => {
  const row = { merchant_raw: "店", paid_amount_raw: 980, occurred_at_raw: "2026-07-01", external_transaction_id: null };
  assert.equal(await makeSourceRecordId("card_csv", row), await makeSourceRecordId("card_csv", { ...row }));
  assert.notEqual(await makeSourceRecordId("card_csv", row), await makeSourceRecordId("paypay_csv", row));
});

test("秘密情報を取込情報から伏字化する", () => {
  const value = sanitizeImportPayload({ api_key: "secret", card_number: "4111111111111111", memo: "ok" });
  assert.equal(value.api_key, "[REDACTED]");
  assert.equal(value.card_number.endsWith("1111"), true);
  assert.equal(value.memo, "ok");
});

test("情報源ごとの候補時間幅を返す", () => {
  assert.equal(getCandidateWindowMs("receipt", "gmail_notification"), 6 * 60 * 60 * 1000);
  assert.equal(getCandidateWindowMs("gmail_notification", "card_csv"), 7 * 24 * 60 * 60 * 1000);
});
