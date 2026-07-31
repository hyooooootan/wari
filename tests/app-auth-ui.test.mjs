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
  assert.match(source, /Storage\.clearLegacyState\?\.\(\)/);
  assert.match(source, /state = Storage\.loadGuestState \? Storage\.loadGuestState\(\) : Storage\.loadState\(\)/);
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
  assert.match(source, /const options = \{ batch_size: 40, from_date: gmailUi\.from_date, to_date: gmailUi\.to_date \}/);
  assert.match(source, /options\.page_token = pageToken/);
  assert.match(source, /options\.query_after = queryAfter/);
  assert.match(source, /options\.query_before = queryBefore/);
  assert.match(source, /Gmail同期中: \$\{Math\.min\(totals\.listed_count, 1000\)\} \/ 1000件/);
  assert.match(source, /上限1000件まで確認しました/);
  assert.match(source, /syncGmailImport\(button\.dataset\.gmailSync, days\)/);
  assert.match(source, /if \(syncButton\) syncButton\.disabled = true/);
  assert.doesNotMatch(source, /toast\([^\n]*pageToken/);
});

test("Gmail sync refreshes candidates after every page and shows supported providers", () => {
  assert.match(source, /const gmailSyncProgress = new Map\(\)/);
  assert.match(source, /await refreshGmailImport\(false\);\s*render\(\);\s*renderGmailProgress\(\);/);
  assert.match(source, /Gmail同期中\\n確認済み:/);
  assert.match(source, /新規候補: \$\{progress\.candidate_count\}件/);
  assert.match(source, /除外: \$\{progress\.ignored_count\}件/);
  assert.match(source, /GMAIL_SUPPORTED_PROVIDERS = "三井住友カード、楽天カード、JCB"/);
  assert.match(source, /取込対象: \$\{GMAIL_SUPPORTED_PROVIDERS\}/);
  assert.match(source, /GMAIL_PROVIDER_NAMES\[row\.provider\]/);
  assert.match(source, /同期完了: 検索\$\{totals\.listed_count\}件、新規候補\$\{totals\.candidate_count\}件、重複\$\{totals\.duplicate_count\}件、除外\$\{totals\.ignored_count\}件/);
});

test("Gmail candidates expose date range selection and bulk actions", () => {
  assert.match(source, /data-gmail-from-date/);
  assert.match(source, /data-gmail-to-date/);
  assert.match(source, /取引日時はメール受信時刻を使用します/);
  assert.match(source, /const gmailSelected = new Set\(\)/);
  assert.match(source, /data-gmail-select-all/);
  assert.match(source, /data-gmail-bulk-import/);
  assert.match(source, /data-gmail-bulk-ignore/);
  assert.match(source, /bulkGmailCandidates\("import"\)/);
  assert.match(source, /bulkGmailCandidates\("ignore"\)/);
  assert.match(source, /gmailUi\.from_date/);
  assert.match(source, /gmailUi\.to_date/);
});

test("Gmail candidate edits preserve the entered local date and time", () => {
  assert.match(source, /function gmailDateTimeInputValue\(value\)/);
  assert.match(source, /timeZone: JAPAN_TIME_ZONE/);
  assert.match(source, /function gmailDateTimeToUtc\(value\)/);
  assert.match(source, /new Date\(`\$\{match\[1\]\}T\$\{match\[2\]\}:\$\{match\[3\]\}:00\+09:00`\)/);
  assert.match(source, /occurred_at: gmailDateTimeToUtc\(values\.occurred_at\)/);
  assert.match(source, /gmailDateTimeInputValue\(row\.occurred_at\)/);
});

test("cloud changes are retained per user until each queued operation has completed", () => {
  assert.match(source, /Storage\.loadCloudState\(cloudCacheUserId\)/);
  assert.match(source, /Storage\.loadPendingSyncOperations\(cloudCacheUserId\)/);
  assert.match(source, /const projectIdByTransaction = new Map\(/);
  assert.match(source, /project_id: operationProjectId\(table, row\)/);
  assert.match(source, /function queueSyncOperations\(operations, pendingAction = null\)/);
  assert.match(source, /async function flushPendingSyncOperations\(\)/);
  assert.match(source, /removePendingSyncOperations\(completed\)/);
  assert.match(source, /window\.addEventListener\("online", \(\) => \{/);
  assert.match(source, /async function pendingActionAlreadyApplied\(action\)/);
  assert.match(source, /async function remoteOperationAlreadyApplied\(operation\)/);
  assert.match(source, /if \(operation\.action === "delete"\) return !row;/);
  assert.match(source, /remoteRowMatchesOperation\(row, operation\)/);
  assert.match(source, /Promise\.all\(completed\.map\(\(entry\) => remoteOperationAlreadyApplied\(entry\)\)\)/);
  assert.match(source, /pendingAction: \{ kind: "reconcile_import", project_id: project\.id/);
});

test("shared project links preserve viewer restrictions and owner revocation controls", () => {
  assert.match(source, /Api\.setShareToken\?\.\(graph\.share\.token\)/);
  assert.match(source, /role === "viewer"/);
  assert.match(source, /Api\.listProjectShares\(projectId\)/);
  assert.match(source, /Api\.revokeProjectShare\(projectId, shareId\)/);
  assert.match(source, /Api\.revokeAllProjectShares\(projectId\)/);
});

test("receipt dates use recognized Japan time and retain a correction path when absent", () => {
  assert.match(source, /function receiptOccurredAt\(result\)/);
  assert.match(source, /paid_time/);
  assert.match(source, /if \(!paidAt\) return null;/);
  assert.match(source, /\["received", "parsed", "review", "error"\]\.includes\(row\.source_status\)/);
  assert.match(source, /取引日は確認してください/);
  assert.match(source, /if \(!record\.occurred_at_raw \|\| !normalizedDate\(record\.occurred_at_raw\)\)/);
});

test("OCR接続障害を利用者向けの説明へ変換する", () => {
  assert.match(source, /function receiptOcrErrorMessage\(error\)/);
  assert.match(source, /error\?\.code === "ocr_upstream_unavailable"/);
  assert.match(source, /error\?\.code === "ocr_timeout"/);
  assert.match(source, /error\?\.code === "remote_ocr_unauthorized"/);
  assert.match(source, /receipt\.status = receiptOcrErrorMessage\(error\)/);
});

test("account deletion removes the current user cache after the server succeeds and leaves retry available on failure", () => {
  assert.match(source, /async function deleteAccountFromScreen\(\)/);
  assert.match(source, /await Api\.deleteAccount\(\);[\s\S]*Storage\.clearCloudState\?\.\(userId\)/);
  assert.match(source, /ui\.accountDeletionFailed = true;/);
  assert.match(source, /error\?\.code === "gmail_revocation_failed"/);
  assert.match(source, /Gmail認可の取消に失敗しました。アカウント削除を再試行できます。/);
  assert.match(source, /accountDeletionNotice/);
  assert.match(source, /data-delete-account/);
});
