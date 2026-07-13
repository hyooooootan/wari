# 本人用家計簿・Gmail接続の本番反映手順

## 監査時点

- リポジトリ: `hyooooootan/wari`
- 作業枝: `codex/gmail-payment-import`
- 対象コミット: `e131ff8`
- D1名: `wari-db`
- D1 ID: `413a32b9-7357-4569-b487-a0080bca4e36`
- 監査日: 2026-07-14
- 判定: **本番反映停止**

監査時点では、remote D1への移行、配備、実Google認可、所有者移管、Gmail同期を実施していない。

## 判定理由

1. 本番Pages Secretsとして確認できたものはOCR関連3件で、GoogleログインとGmail接続に必要なSecret名を確認できなかった。
2. Google Cloud Consoleの承認済みredirect URIと本番URLを確認できなかった。ローカル`.dev.vars`は`localhost`を指しており、本番確認には使えない。
3. Pagesの現在のProduction配備は`codex/mobile-split-prototype`枝のコミットで、`e131ff8`と一致していない。
4. `db/production_household_inspection.sql`は旧初期スキーマ用である。0009適用後に実行すると旧表`members`を参照して失敗するため、移行前検査に限定し、移行後は`db/verify_household_ledger.sql`を使う。

## バックアップと移行前検査

対象D1の名前とIDを確認し、Git管理外の保護された一時保存先へエクスポートする。

`npx wrangler d1 export wari-db --remote --output=<保護された一時保存先>\wari-db-production.sql`

`npx wrangler d1 execute wari-db --remote --file=./db/production_household_inspection.sql --json`

エクスポートSQL、メールアドレス、Cookie、OAuth state、PKCE verifier、アクセストークン、refresh token、暗号鍵を文書やGitへ保存しない。移行前検査で所有者不明、共有データ、削除済み利用者、Gmail接続先不明が見つかった場合は停止する。

## D1移行

旧アプリが新スキーマへアクセスしないよう、メンテナンス画面へ切り替えるか、旧アプリからD1への書込みを止める。バックアップと移行後検査が終わるまで旧アプリと新D1を同時に稼働させない。

承認後に`npx wrangler d1 migrations apply wari-db --remote`を実行する。対象は`0001_initial.sql`から`0009_personal_households.sql`まで9件である。途中で失敗した場合は後続を実行せず、適用済み番号とエラーを記録する。

## 移行後検査

`npx wrangler d1 execute wari-db --remote --file=./db/verify_household_ledger.sql --json`

`npx wrangler d1 execute wari-db --remote --command="SELECT id, project_type, owner_user_id FROM projects ORDER BY id; SELECT COUNT(*) AS applied FROM d1_migrations; PRAGMA foreign_key_check;" --json`

期待結果:

| 項目 | 結果 |
|---|---:|
| `d1_migrations` | 9件 |
| `prj_mrbhik3r_b9ku` | `split`、`owner_user_id`はNULL |
| 取引、支払、品目、配分の金額 | すべて1200 |
| 外部キー違反 | 0件 |
| `owner_unknown`のsplit owner行 | 維持 |

空DBへの0001から0009の適用は9件成功し、`PRAGMA foreign_keys=1`を確認した。本番D1の読取エクスポートを複製したローカルDBでも、プロジェクト、取引、金額、`owner_unknown`、外部キー検査の同じ値を確認した。

## 所有者移管

実利用者がGoogleログインして`users.id`を作成した後、`db/assign_legacy_project_owner.example.sql`を使う。利用者IDをSQLへ固定記載せず、実行時の置換手順で指定する。

実行前に、新利用者が存在し、`deleted_at`と`deletion_started_at`がNULLであり、対象が`prj_mrbhik3r_b9ku`で、現在のownerが`owner_unknown`であることを確認する。追加後のownerが一意になることと、他プロジェクトへ影響しないことも確認する。条件不一致時は実行せず、推測による割り当てや削除を行わない。

## OAuth設定

環境変数の用途、型、Secret名、Pages設定コマンドは`docs/production-oauth-configuration.md`に集約している。移行後検査には`db/verify_household_ledger.sql`と`db/verify_personal_households.sql`を使う。

値そのものを本書へ記録せず、CloudflareとGoogle Cloud Consoleで人が確認する。

### Googleログイン

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `APP_ORIGIN`
- `OAUTH_REDIRECT_URI`
- scopeは`openid email profile`
- 承認済みredirect URIは`<本番URL>/api/auth/google/callback`

### Gmail接続

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REDIRECT_URI`
- `GMAIL_TOKEN_KEY_V1`
- `GMAIL_TOKEN_KEY_CURRENT_GENERATION`
- 必要に応じて`GMAIL_REVOCATION_RETRY_SECRET`
- scopeは`https://www.googleapis.com/auth/gmail.readonly`
- 承認済みredirect URIは`<本番URL>/api/gmail/oauth/callback`
- Gmail API、OAuth同意画面、テストユーザー制限、公開状態を確認する

`GMAIL_TOKEN_KEY_V1`は復号後32バイトの鍵とし、Cloudflare Secretで管理する。鍵、認可コード、access token、refresh tokenをログ、D1、URL、文書へ出力しない。

コードのcallback生成規則は、Googleログインが`OAUTH_REDIRECT_URI`または`APP_ORIGIN + /api/auth/google/callback`、Gmail接続が`GMAIL_REDIRECT_URI`または受信要求origin + `/api/gmail/oauth/callback`である。Google Cloud側と文字列を一致させる。

## 配備

配備対象を`e131ff8`へ固定し、D1移行後に配備する。`git switch codex/gmail-payment-import`、`git rev-parse HEAD`で枝とコミットを確認した後、`npx wrangler pages deploy public --project-name=wari`を実行する。

`wrangler.toml`のD1名とID、Pages Functions、静的ファイル、サービスワーカーが同じリリースへ含まれることを確認する。`public/service-worker.js`のキャッシュ名は新しい版に更新し、activate時に旧キャッシュを削除できることを確認する。

## 動作確認

1. ヘルスチェックとGoogleログイン画面を確認する。
2. Googleログイン後、Googleの`sub`に対応する`users.id`を確認する。
3. 本人用householdが一件として取得されることを確認する。
4. `prj_mrbhik3r_b9ku`の表示後、承認済みSQLで所有者を移管する。
5. splitの参加者、共有リンク、owner・editor・viewer判定が維持されることを確認する。
6. household画面に共有操作が表示されないことを確認する。
7. Gmail接続開始と候補登録の要求に`project_id`がないことを確認する。
8. Gmailを接続し、7日、30日、90日の手動同期を一度行う。
9. 候補を確認・編集して一件を家計簿へ登録する。
10. 同じGmail Message IDを再同期しても二重登録されないことを確認する。
11. Gmail接続解除で認可取消しと暗号化refresh tokenの消去を確認する。

実Google OAuth、実Gmail同期、remote D1書込みは監査時点では実施していない。

## 停止条件

- D1 ID、バックアップ、移行結果のいずれかを確認できない。
- 0001から0009の適用途中で失敗する。
- 外部キー違反、金額不一致、ID欠落がある。
- owner_unknown以外の所有者を推測する必要がある。
- 本番Cloudflare Secretsが不足している。
- Google Cloudの承認済みredirect URIを確認できない。
- 本番URLとcallback URIが一致しない。
- 配備対象コミットが`e131ff8`と一致しない。
- 古いサービスワーカーを無効化できない。
- split共有が失われる、またはhousehold共有が可能になる。

## ロールバック

0001から0009にはdown migrationを用意していない。移行途中の失敗時は後続適用と配備を止め、適用番号とエラーを保存する。移行後に不整合が見つかった場合は、バックアップSQLとCloudflare D1の承認済み復元手順で復旧する。復元作業は本監査では実行しない。

## 監査結果

- `npm test`: 105件成功、0件失敗。
- `git diff --check`: 成功。
- 空DB: 0001から0009の9件適用成功、外部キー有効。
- 本番複製: 0001から0009の9件適用成功、各金額1200、外部キー違反0件。
- Google OAuth実認可、Gmail実同期、remote D1移行、本番配備: 未実施。
- 判定: **本番反映停止**。
