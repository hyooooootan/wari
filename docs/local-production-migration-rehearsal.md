# 本番複製によるローカル移行再現

## 対象

- リポジトリ: `hyooooootan/wari`
- ブランチ: `codex/gmail-payment-import`
- コミット: `a2358a036cd83c68abcd8e1e171b0f063fa63592`
- 本番D1: `wari-db`
- `database_id`: `413a32b9-7357-4569-b487-a0080bca4e36`
- ローカル保存先: `C:\Users\89bi4\AppData\Local\Temp\wari-rehearsal-20260713`

本番エクスポートはリポジトリ外の一時保存先へ取得しました。エクスポートSQLはGitへ追加していません。`.gitignore`には`*.sql`が含まれていないため、リポジトリ内へ移さない運用にしています。

```powershell
npx wrangler d1 export wari-db --remote --output=<一時保存先>\wari-db-production.sql
npx wrangler d1 execute wari-db --local --persist-to=<一時保存先> --file=<一時保存先>\wari-db-production.sql --yes
npx wrangler d1 migrations apply wari-db --local --persist-to=<一時保存先>
npx wrangler d1 execute wari-db --local --persist-to=<一時保存先> --file=./db/verify_household_ledger.sql --json
```

エクスポート以外のD1操作は`--local`を付けています。remote D1への`INSERT`、`UPDATE`、`DELETE`、`ALTER`、`DROP`、`CREATE`は実行していません。

## 移行前

| 表 | 件数 | 金額合計 |
|---|---:|---:|
| projects | 1 | - |
| members | 2 | - |
| expenses | 1 | 1200 |
| expense_payments | 1 | 1200 |
| items | 0 | 0 |
| item_members | 0 | - |
| project_shares | 0 | - |

プロジェクトIDは`prj_mrbhik3r_b9ku`です。参加者IDは`mem_mrbhik3r_86pu`、`mem_mrbhik3r_h7id`、支出IDは`exp_mrbhik3r_v9k7`、支払IDは`pay_mrbhik3r_abb9`です。外部キー違反は0件でした。

## 0001から0008

Wranglerの移行機構で番号順に適用し、8件すべて成功しました。

| 移行 | 結果 | 記録 |
|---|---|---|
| 0001_initial.sql | 成功 | d1_migrations id 1 |
| 0002_household_ledger.sql | 成功 | d1_migrations id 2 |
| 0003_auth_ownership_shares.sql | 成功 | d1_migrations id 3 |
| 0004_gmail_payment_import.sql | 成功 | d1_migrations id 4 |
| 0005_gmail_oauth_project.sql | 成功 | d1_migrations id 5 |
| 0006_account_deletion.sql | 成功 | d1_migrations id 6 |
| 0007_household_sync_jobs.sql | 成功 | d1_migrations id 7 |
| 0008_gmail_revocation_guards.sql | 成功 | d1_migrations id 8 |

## 移行後

| 表 | 件数 | 金額合計 |
|---|---:|---:|
| projects | 1 | - |
| project_members | 2 | - |
| transactions | 1 | 1200 |
| transaction_payments | 1 | 1200 |
| transaction_items | 1 | 1200 |
| item_allocations | 2 | 1200 |
| import_records | 0 | - |
| users | 1 | - |
| project_user_roles | 1 | - |
| gmail_connections | 0 | - |

プロジェクトID、参加者ID、支出に対応する取引IDは維持されました。支出に品目がなかったため、`0002`がsummary品目を1件生成し、2人分の配分を作成しました。`receipt_image_url`に対応する`import_records`は0件で、移行前にレシート画像行がありませんでした。`_legacy_*`表は0件です。

| 移行前 | 移行後 | 対応結果 |
|---|---|---|
| `projects.id = prj_mrbhik3r_b9ku` | `projects.id = prj_mrbhik3r_b9ku` | 維持 |
| `members.id` 2件 | `project_members.id` 2件 | ID維持 |
| `expenses.id = exp_mrbhik3r_v9k7` | `transactions.id = exp_mrbhik3r_v9k7` | ID維持 |
| `expense_payments.id = pay_mrbhik3r_abb9` | `transaction_payments.id = pay_mrbhik3r_abb9` | ID維持 |
| `items` 0件 | `transaction_items` 1件 | summary行を生成 |
| `item_members` 0件 | `item_allocations` 2件 | 2人へ配分を生成 |
| `project_shares` 0件 | `project_shares` 0件 | 維持 |

## owner_unknown

`0003`適用後、`users`に`owner_unknown`が1行作成され、`deleted_at`が設定されました。`prj_mrbhik3r_b9ku`には次のowner行が作成されました。

| user_id | project_id | role | revoked_at |
|---|---|---|---|
| owner_unknown | prj_mrbhik3r_b9ku | owner | NULL |

この状態では、削除済みの`owner_unknown`がsplitプロジェクトのowner行を持ちます。実利用者を推測せず、Googleログイン後の利用者IDを明示して移管します。owner_unknownを恒久所有者として使用しません。

## verify結果

`db/verify_household_ledger.sql`は成功しました。失敗項目はすべて0件でした。

- foreign_keys: 0
- transactions_without_items: 0
- payment_total_mismatches: 0
- item_total_mismatches: 0
- items_without_allocations: 0
- allocation_total_mismatches: 0
- cross_project_payments: 0
- cross_project_allocations: 0
- cross_project_import_links: 0
- invalid_household_links: 0
- incomplete_household_links: 0
- generated_rows_without_origins: 0
- generated_origin_transaction_mismatches: 0
- generated_origin_member_mismatches: 0
- duplicate_generated_rows: 0
- duplicate_source_records: 0

## 判定

ローカル移行試験は、既存splitプロジェクトの保持、金額一致、ID保持、外部キー検査、`0001`から`0008`の適用記録という範囲で成功しました。

本番へ`0001`から`0008`を適用できる見込みはありますが、所有者移管は別工程です。実利用者のGoogleログイン、対象プロジェクトIDの確認、所有者移管SQLの実行前検査を完了するまで、本番適用とアプリケーション公開は停止します。

`0009`設計へは、今回の結果から直ちに進みません。先に、既存splitプロジェクトの明示的な所有者移管手順を運用承認します。`0009`作成、適用、リモート書込み、API変更、画面変更、コミット、push、Pull Request作成は行っていません。
