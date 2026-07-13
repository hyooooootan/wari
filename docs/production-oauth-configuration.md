# 本番OAuth設定

## 確認済みの配備情報

- Pages project: `wari`
- Pages project domain: `https://wari-cud.pages.dev`
- `wrangler.toml`のPages出力先: `public`
- D1 binding: `DB`
- D1 name: `wari-db`
- D1 ID: `413a32b9-7357-4569-b487-a0080bca4e36`
- 観測されたProduction配備枝: `codex/mobile-split-prototype`
- 配備対象コミット: `e131ff8`へ更新が必要
- custom domain: 読取結果から確認できず

`https://wari-cud.pages.dev`はPages project domainとして確認できる。正規の本番URLとして使う場合のcallback候補は次であるが、Google Cloud ConsoleとPagesのproduction配備で到達確認するまで確定扱いにしない。

- `https://wari-cud.pages.dev/api/auth/google/callback`
- `https://wari-cud.pages.dev/api/gmail/oauth/callback`

## 環境変数一覧

| 変数 | 使用箇所 | 用途 | 種別 | 本番 | ローカル | 未設定時 |
|---|---|---|---|---|---|---|
| `APP_ORIGIN` | `csrf.js`, `oauth.js`, `[[path]].js` | 正規origin、ログイン後の戻り先、Origin検査 | 通常変数 | 必要 | 任意 | 要求元URLから導出し、戻り先も要求元URLになる |
| `OAUTH_REDIRECT_URI` | `oauth.js` | Googleログインcallback | 通常変数 | 推奨 | 任意 | `APP_ORIGIN/api/auth/google/callback`を使用 |
| `GOOGLE_CLIENT_ID` | `oauth.js` | Googleログインclient ID | Secret管理対象 | 必要 | 必要 | 開始またはtoken交換が失敗 |
| `GOOGLE_CLIENT_SECRET` | `oauth.js` | Googleログインclient secret | Secret | 必要 | 実認可時に必要 | token交換が失敗 |
| `GMAIL_REDIRECT_URI` | `gmail.js` | Gmail callback | 通常変数 | 推奨 | 任意 | 要求元URLの`/api/gmail/oauth/callback`を使用 |
| `GMAIL_CLIENT_ID` | `gmail.js` | Gmail OAuth client ID | Secret管理対象 | 必要 | 実認可時に必要 | Gmail OAuth開始が失敗 |
| `GMAIL_CLIENT_SECRET` | `gmail.js` | Gmail OAuth client secret | Secret | 必要 | 実認可時に必要 | Gmail OAuth設定エラー |
| `GMAIL_TOKEN_KEY_CURRENT_GENERATION` | `gmail.js` | 現行AES鍵世代 | 通常変数 | 必要 | 必要 | 鍵世代エラー |
| `GMAIL_TOKEN_KEY_V1` | `gmail.js` | AES-256-GCM鍵 | Secret | 必要 | 同期・接続試験に必要 | 鍵不足または形式エラー |
| `GMAIL_REVOCATION_RETRY_SECRET` | `[[path]].js` | 管理用取消再試行API | Secret | 管理API使用時に必要 | 任意 | 管理APIが利用不可 |
| `OAUTH_MOCK_USER_JSON` | `oauth.js` | ローカル模擬Google利用者 | ローカル変数 | 設定禁止 | 試験時のみ | 実Google検証へ進む |
| `CF_PAGES` | `oauth.js` | 本番で模擬利用者を無効化 | Cloudflare提供値 | Pagesが設定 | 自動 | 本番判定は環境依存 |

Cookieの属性は環境変数ではない。`auth.js`で`Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`を設定する。

OCRの`GEMINI_API_KEY`、`GEMINI_OCR_MODEL`、`OCR_BACKEND`などはGoogleログイン・Gmail OAuthとは別系統であり、今回のOAuth判定から分離する。

## ルートと戻り先

ルートは`functions/api/[[path]].js`で次のように定義される。

| 操作 | HTTP | ルート | 成功後 |
|---|---|---|---|
| Googleログイン開始 | POST | `/api/auth/google/start` | Google認可画面へURL遷移 |
| Googleログインcallback | GET | `/api/auth/google/callback` | `APP_ORIGIN`または要求元URLの`/`へ302 |
| Gmail接続開始 | POST | `/api/gmail/oauth/start` | Google認可画面へURL遷移 |
| Gmail callback | GET | `/api/gmail/oauth/callback` | `APP_ORIGIN`または要求元URLの`/`へ302 |

Googleログインは`openid email profile`、Gmail接続は`https://www.googleapis.com/auth/gmail.readonly`を要求する。Gmail接続は認可コード、S256 PKCE、state、10分の有効期限、単回使用、`access_type=offline`を使用する。

ログインとGmail接続はコード上で別の環境変数名を持つ。技術的には同一OAuth clientを両方へ設定できるが、その場合は両callback URIを同じGoogle Cloud clientへ登録し、同意画面と権限分離を承認する。運用上はGoogleログイン用とGmail接続用のclientを分ける方針とする。

## Google Cloud Console

1. OAuth client typeをWeb applicationにする。
2. Authorized JavaScript originsへ正規のHTTPS本番originを登録する。
3. Googleログイン用に`<本番URL>/api/auth/google/callback`を登録する。
4. Gmail接続用に`<本番URL>/api/gmail/oauth/callback`を登録する。
5. Gmail APIを有効化する。
6. OAuth consent screenの公開範囲、外部向け・内部向け、テストユーザーを確認する。
7. Gmail scopeをログインclientへ追加しない。

末尾の`/`、Preview URL、HTTP、別host、別portを本番callbackとして登録しない。Google Cloud Console側の実値はこの文書へ保存しない。

## Cloudflare設定コマンド

Pages project名は`wari`である。次のコマンドは入力手順であり、この監査では実行しない。

- `npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name=wari`
- `npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name=wari`
- `npx wrangler pages secret put GMAIL_CLIENT_ID --project-name=wari`
- `npx wrangler pages secret put GMAIL_CLIENT_SECRET --project-name=wari`
- `npx wrangler pages secret put GMAIL_TOKEN_KEY_V1 --project-name=wari`
- `npx wrangler pages secret put GMAIL_REVOCATION_RETRY_SECRET --project-name=wari`

通常変数はPages DashboardまたはWorkers/Pagesの本番環境変数として、`APP_ORIGIN`、`OAUTH_REDIRECT_URI`、`GMAIL_REDIRECT_URI`、`GMAIL_TOKEN_KEY_CURRENT_GENERATION`を設定する。Secret値をコマンド引数へ書かず、対話入力する。

## 鍵管理

`GMAIL_TOKEN_KEY_V1`はAES-256-GCMのraw 32バイト鍵をBase64で表現する。PowerShellで値を表示せずに生成する場合は、次のように一時変数へ保持して対話入力へ渡す運用を採用する。

`$bytes = [byte[]]::new(32); [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes); $key = [Convert]::ToBase64String($bytes); npx wrangler pages secret put GMAIL_TOKEN_KEY_V1 --project-name=wari`

暗号論的な乱数生成が必要なため、実際の生成にはOSの暗号論的乱数機能または組織承認済みの鍵生成器を使う。生成値を表示、ファイル保存、履歴保存、Git追加しない。鍵世代を増やす場合は新しい`GMAIL_TOKEN_KEY_V<世代>`を先に登録し、`GMAIL_TOKEN_KEY_CURRENT_GENERATION`を切り替える。旧世代鍵は既存ciphertextの復号と再暗号化が終わるまで保持する。

## 設定後の確認

値を表示せず、Secret名だけを確認する。

`npx wrangler pages secret list --project-name=wari`

設定後は、D1移行、`db/verify_household_ledger.sql`、`db/verify_personal_households.sql`、配備対象コミット、HTTPS callback到達性、Googleログイン、Gmail接続の順に確認する。実認可と実同期は設定完了後の承認工程で実施する。

## 現在の不足

Cloudflare読取結果では、Production Secretsとして`GEMINI_API_KEY`、`GEMINI_OCR_MODEL`、`OCR_BACKEND`だけが確認できた。次のOAuth関連名は本番登録を確認できていない。

`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`、`GMAIL_TOKEN_KEY_V1`、`GMAIL_TOKEN_KEY_CURRENT_GENERATION`、`GMAIL_REVOCATION_RETRY_SECRET`。

`APP_ORIGIN`、`OAUTH_REDIRECT_URI`、`GMAIL_REDIRECT_URI`は本番通常変数としての登録を確認できていない。Google Cloud Consoleのclient、API、同意画面、test user、redirect URIも未確認である。
