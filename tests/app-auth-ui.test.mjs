import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

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
