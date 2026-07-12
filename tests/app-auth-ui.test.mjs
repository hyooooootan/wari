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
