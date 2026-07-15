import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("public app script passes the JavaScript syntax check", () => {
  execFileSync(process.execPath, ["--check", fileURLToPath(new URL("../public/app.js", import.meta.url))], { stdio: "pipe" });
});

test("public app click handler keeps the Gmail branch and other actions reachable", () => {
  assert.match(source, /if \(button\.dataset\.gmailSync\) \{[\s\S]*?await syncGmailImport\(button\.dataset\.gmailSync, days\);[\s\S]*?return;/);
  assert.doesNotMatch(source, /if \(false\)/);
  assert.doesNotMatch(source, /Api\.syncGmail\(button\.dataset\.gmailSync, days, 100\)/);
  assert.match(source, /if \(button\.dataset\.gmailDisconnect\)/);
  assert.match(source, /if \(button\.dataset\.gmailImport\)/);
});

test("OCR confirmation preserves originals, supports item edits, and handles reconciled feedback status", () => {
  assert.match(source, /function receiptOcrMetadata\(result\)[\s\S]*original:[\s\S]*confirmed_items:/);
  assert.match(source, /const ocrFeedbackTokens = new Map\(\)/);
  assert.doesNotMatch(source, /feedback_token: String\(result\.feedback_token/);
  assert.match(source, /const editable = record\.source_type === "receipt"[\s\S]*ocrFeedbackTokens\.has\(ocr\.ocr_result_id\)/);
  assert.match(source, /data-import-ocr-field="item_name:\$\{index\}"/);
  assert.match(source, /data-import-ocr-field="item_amount:\$\{index\}"/);
  assert.match(source, /function createFromImport[\s\S]*await Api\.reconcileImport[\s\S]*reconciliation\.ocr_feedback/);
  assert.match(source, /function linkImport[\s\S]*await Api\.reconcileImport[\s\S]*reconciliation\.ocr_feedback/);
  assert.match(source, /Api\.reconcileImport\(record\.id,[\s\S]*feedback_token: feedback\.feedback_token, confirmed: feedback\.confirmed/);
  assert.match(source, /async function finishOcrFeedback[\s\S]*Api\.retryOcrCorrections\(importId\)/);
  assert.match(source, /status === "saved" \|\| status === "disabled"[\s\S]*ocrFeedbackTokens\.delete\(resultId\)/);
  assert.match(source, /取引は保存されましたが、OCR修正履歴の保存に失敗しました/);
});

test("認証状態に応じたGoogleログイン操作を表示する", () => {
  assert.match(source, /cloudSession\.status === "authenticated"/);
  assert.match(source, /data-google-login>Googleでログイン<\/button>/);
  assert.match(source, /data-google-logout>ログアウト<\/button>/);
  assert.match(source, /cloudSession\.user\?\.name \|\| cloudSession\.user\?\.email/);
});

test("認可先への遷移とログアウト後の端末状態を処理する", () => {
  assert.match(source, /await Api\.startGoogleLogin\(\)/);
  assert.match(source, /location\.assign\(result\.url\)/);
  assert.match(source, /await Api\.logout\(\)/);
  assert.match(source, /cloudSession = \{ status: "unauthenticated", user: null \}/);
  assert.match(source, /state = Storage\.loadState\(\)/);
});

test("起動時はセッションを先に調べ、401と他の障害を分ける", () => {
  const sessionIndex = source.indexOf("await Api.getSession()");
  const projectsIndex = source.indexOf("await Api.listProjects()", sessionIndex);
  assert.ok(sessionIndex > 0);
  assert.ok(projectsIndex > sessionIndex);
  assert.match(source, /error\?\.status === 401[\s\S]*status: "unauthenticated"[\s\S]*status: "error"/);
});

test("Gmail接続開始は本人家計簿をサーバー側で決めて認可先へ遷移する", () => {
  assert.match(source, /Api\.startGmailConnection\(\)/);
  assert.doesNotMatch(source, /startGmailConnectionForProject/);
  assert.match(source, /Gmailの認可先を取得できませんでした/);
  assert.match(source, /location\.assign\(result\.url\)/);
});

test("Gmail候補の登録先を画面から指定しない", () => {
  assert.match(source, /data-gmail-import="\$\{esc\(row\.id\)\}"/);
  assert.doesNotMatch(source, /data-gmail-import="\$\{esc\(row\.id\)\}" data-project-id/);
  assert.match(source, /Api\.importGmailCandidate\(button\.dataset\.gmailImport\)/);
});

test("Gmail state refreshes on startup and import tab selection", () => {
  assert.match(source, /async function refreshGmailImport\(shouldRender = true\)/);
  assert.match(source, /if \(shouldRender\) render\(\);/);
  assert.match(source, /catch \(error\) \{\s*toast\(`Gmail[^`]+/);
  assert.match(source, /await bootCloud\(\);\s*if \(isCloud\) await refreshGmailImport\(false\);/);
  assert.match(source, /button\.dataset\.projectTab === "imports"\) \{\s*await refreshGmailImport\(false\);/);
});

test("Gmail parse errors stay hidden and incomplete candidates cannot be imported", () => {
  assert.match(source, /\["ignored", "imported", "parse_error"\]\.includes\(row\.status\)/);
  assert.match(source, /金額と店名を入力してください/);
  assert.match(source, /data-gmail-import="\$\{esc\(row\.id\)\}" \$\{complete \? "" : "disabled"\}/);
});

test("Gmail sync displays internal run status without exposing provider data", () => {
  assert.match(source, /function gmailSyncMessage\(run, totals = null\)/);
  assert.match(source, /同期完了: 新規候補\$\{candidates\}件、処理\$\{processed\}件、重複\$\{duplicates\}件/);
  assert.match(source, /同期完了: 新しい候補はありません/);
  assert.match(source, /reauthorization_required: /);
  assert.match(source, /rate_limited: /);
  assert.match(source, /finally \{[\s\S]*await refreshGmailImport\(\);/);
});

test("Gmail sync paginates sequentially to 1000 items without exposing page tokens", () => {
  assert.match(source, /const gmailSyncing = new Set\(\)/);
  assert.match(source, /for \(let page = 0; page < 25 && totals\.listed_count < 1000; page \+= 1\)/);
  assert.match(source, /const options = \{ batch_size: 40 \}/);
  assert.match(source, /options\.page_token = pageToken/);
  assert.match(source, /options\.query_after = queryAfter/);
  assert.match(source, /Gmail同期中: \$\{Math\.min\(totals\.listed_count, 1000\)\} \/ 1000件/);
  assert.match(source, /上限1000件まで確認しました/);
  assert.match(source, /syncGmailImport\(button\.dataset\.gmailSync, days\)/);
  assert.match(source, /if \(syncButton\) syncButton\.disabled = true/);
  assert.doesNotMatch(source, /toast\([^\n]*pageToken/);
});

test("Gmail sync refreshes candidates after every page and shows SMBC progress", () => {
  assert.match(source, /const gmailSyncProgress = new Map\(\)/);
  assert.match(source, /await refreshGmailImport\(false\);\s*render\(\);\s*renderGmailProgress\(\);/);
  assert.match(source, /Gmail同期中\\n確認済み:/);
  assert.match(source, /新規候補: \$\{progress\.candidate_count\}件/);
  assert.match(source, /除外: \$\{progress\.ignored_count\}件/);
  assert.match(source, /取込対象: 三井住友カード/);
  assert.match(source, /同期完了: 検索\$\{totals\.listed_count\}件、新規候補\$\{totals\.candidate_count\}件、重複\$\{totals\.duplicate_count\}件、除外\$\{totals\.ignored_count\}件/);
});
