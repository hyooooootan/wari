# 本番D1検査結果

## 実行情報

- 実行日時: 2026-07-13T16:43:18.7462192+09:00
- 対象データベース名: `wari-db`
- 対象`database_id`: `413a32b9-7357-4569-b487-a0080bca4e36`
- 対象環境: Cloudflare D1 remote
- 作業ブランチ: `codex/gmail-payment-import`
- コミットSHA: `a2358a036cd83c68abcd8e1e171b0f063fa63592`
- 設定ファイル: `wrangler.toml`
- 実行した検査コマンド: `npx wrangler d1 execute wari-db --remote --file=./db/production_household_inspection.sql`
- 補助確認コマンド: `npx wrangler d1 execute wari-db --remote --command=<読取クエリ> --json`

## 事前確認

`wrangler.toml`には次が設定されています。

```text
database_name = wari-db
database_id = 413a32b9-7357-4569-b487-a0080bca4e36
```

実行表示は`Resource location: remote`および次の内容でした。

```text
Executing on remote database wari-db (413a32b9-7357-4569-b487-a0080bca4e36)
To execute on your local development database, remove the --remote flag from your wrangler command.
```

検査SQLの命令確認では、`INSERT`、`UPDATE`、`DELETE`、`ALTER`、`DROP`、`CREATE`、`VACUUM`、`REINDEX`に該当する命令は検出されませんでした。`PRAGMA foreign_key_check`は読取検査として使用しています。

バックアップ方法は、Wranglerのヘルプで次を確認しました。今回は実行していません。

```text
npx wrangler d1 export wari-db --remote --output=<backup.sql>
npx wrangler d1 time-travel info wari-db
npx wrangler d1 time-travel restore wari-db
```

`export`は本番データを含むファイルを作成するため、実行時は保存先、アクセス権、保管期間を別途決めます。`restore`は復元操作であり、今回の検査では実行していません。

## 本検査SQLの実行結果

本番D1への接続と遠隔指定は成功しましたが、最初の問い合わせで次のエラーになりました。

```text
no such table: d1_migrations: SQLITE_ERROR
```

そのため、`production_household_inspection.sql`に含まれる後続検査は本番D1上では実行されていません。`d1_migrations`が存在しない状態で後続表を参照すると、さらに失敗することが確認できます。

## 補助的な読取確認

本番D1の現在の表一覧、プロジェクトID、共有行数、外部キー検査を読取クエリで確認しました。Wranglerが返したJSONは次のとおりです。

```json
[
  {
    "results": [
      {"name":"_cf_KV","type":"table"},
      {"name":"expense_payments","type":"table"},
      {"name":"expenses","type":"table"},
      {"name":"item_members","type":"table"},
      {"name":"items","type":"table"},
      {"name":"members","type":"table"},
      {"name":"project_shares","type":"table"},
      {"name":"projects","type":"table"}
    ],
    "success": true,
    "meta": {
      "served_by":"v3-prod",
      "served_by_region":"APAC",
      "served_by_colo":"NRT",
      "served_by_primary":true,
      "timings":{"sql_duration_ms":0.5104},
      "duration":0.5104,
      "changes":0,
      "last_row_id":0,
      "changed_db":false,
      "size_after":114688,
      "rows_read":34,
      "rows_written":0,
      "total_attempts":1
    }
  },
  {
    "results": [{"id":"prj_mrbhik3r_b9ku"}],
    "success": true,
    "meta": {
      "served_by":"v3-prod",
      "served_by_region":"APAC",
      "served_by_colo":"NRT",
      "served_by_primary":true,
      "timings":{"sql_duration_ms":0.1942},
      "duration":0.1942,
      "changes":0,
      "last_row_id":0,
      "changed_db":false,
      "size_after":114688,
      "rows_read":1,
      "rows_written":0,
      "total_attempts":1
    }
  },
  {
    "results": [{"project_share_count":0}],
    "success": true,
    "meta": {
      "served_by":"v3-prod",
      "served_by_region":"APAC",
      "served_by_colo":"NRT",
      "served_by_primary":true,
      "timings":{"sql_duration_ms":0.1792},
      "duration":0.1792,
      "changes":0,
      "last_row_id":0,
      "changed_db":false,
      "size_after":114688,
      "rows_read":0,
      "rows_written":0,
      "total_attempts":1
    }
  },
  {
    "results": [],
    "success": true,
    "meta": {
      "served_by":"v3-prod",
      "served_by_region":"APAC",
      "served_by_colo":"NRT",
      "served_by_primary":true,
      "timings":{"sql_duration_ms":0.2599},
      "duration":0.2599,
      "changes":0,
      "last_row_id":0,
      "size_after":114688,
      "rows_read":2,
      "rows_written":0,
      "total_attempts":1
    }
  },
  {
    "results": [],
    "success": true,
    "meta": {
      "served_by":"v3-prod",
      "served_by_region":"APAC",
      "served_by_colo":"NRT",
      "served_by_primary":true,
      "timings":{"sql_duration_ms":0.2057},
      "duration":0.2057,
      "changes":0,
      "last_row_id":0,
      "size_after":114688,
      "rows_read":7,
      "rows_written":0,
      "total_attempts":1
    }
  }
]
```

追加の`PRAGMA table_info(projects)`の生出力では、`projects`の列は`id`、`name`、`created_at`でした。`foreign_key_violation_count`は`0`でした。

## 検査項目別の結果

| 項目 | 結果 | 対象ID・理由 |
|---|---|---|
| 1. 適用済みマイグレーション | 判定不能 | `d1_migrations`が存在しない |
| 2. `shared_household` | 判定不能 | `projects.project_type`が存在しない。プロジェクトIDは`prj_mrbhik3r_b9ku` |
| 3. 利用者ごとのhousehold件数 | 未実行 | `users`、`project_user_roles`が存在しない |
| 4. householdのowner権限行 | 未実行 | `project_user_roles`が存在しない |
| 5. ownerなしhousehold | 未実行 | `project_type`とowner表が存在しない |
| 6. owner複数household | 未実行 | `project_type`とowner表が存在しない |
| 7. householdの`project_shares` | 未実行 | `project_shares`は存在するが、household種別列がない。共有行数は0 |
| 8. householdのeditor/viewer | 未実行 | `project_user_roles`が存在しない |
| 9. 旧`share_token` | 未実行 | `projects`に`share_token`がない |
| 10. Gmail接続利用者のhousehold件数 | 未実行 | `gmail_connections`が存在しない |
| 11. Gmail接続先不定 | 未実行 | `gmail_connections`が存在しない |
| 12. 削除中・削除済み所有者 | 未実行 | `users`、削除状態列、owner表が存在しない |
| 13. 割り勘参加者からhouseholdへのリンク切れ | 未実行 | `project_members`が存在しない |
| 14. 外部キー違反・孤立行 | 外部キー違反0件 | 補助読取確認の`foreign_key_violation_count=0`。対象表は初期構成のみ |

## 判定

判定は「移行停止」です。

理由は、対象D1が認証・権限・Gmail移行前の初期スキーマであり、`0003`から`0008`に対応する表と列が存在しないためです。現行データから、利用者、owner、Gmail接続先、`shared_household`の参加関係を一意に判定できません。

### 問題のあるID

- プロジェクトID: `prj_mrbhik3r_b9ku`
- 利用者ID: 判定対象表が存在しないため取得不可
- Gmail接続ID: `gmail_connections`が存在しないため取得不可

### 自動移行できる行

ありません。現行D1の初期スキーマには、`owner_user_id`の割当元となる利用者・owner関係がありません。

### 人による判断が必要な行

- `prj_mrbhik3r_b9ku`をどのGoogle利用者へ割り当てるか
- 初期スキーマの既存データを、認証・権限基盤の移行計画へどう対応付けるか
- D1が想定した遠隔環境であるか、別のD1を対象にすべきか

## 設計書への修正事項

[personal-household-migration-design.md](C:/Users/89bi4/Documents/New%20project/docs/personal-household-migration-design.md)には次の修正が必要です。

- 本番D1が`0008`適用済みであることを前提とせず、初期スキーマを検出した場合に検査を停止する事前確認を追加する。
- `d1_migrations`が存在しない場合にSQL全体が失敗するため、移行履歴表の存在確認と後続検査を分離する。
- 初期スキーマから認証利用者へ所有者を割り当てる手順を、対象IDごとの人手確認として明記する。
- `0001`から`0008`の適用状態を確認できない場合の停止条件を追加する。

## 次の段階

`0009`マイグレーションの作成へは進みません。

先に、対象D1が正しいデータベースであること、初期スキーマのデータをどの利用者へ割り当てるか、認証・権限基盤の既存移行をどの環境で完了させるかを人が決定する必要があります。今回の作業では、DB変更、マイグレーション適用、API変更、画面変更、コミット、push、Pull Request作成を行っていません。

## DB変更が行われていないことの確認

Wranglerの読取結果に次が含まれています。

```json
"changes": 0,
"changed_db": false,
"rows_written": 0
```

本検査SQLおよび補助確認クエリは、いずれも読取処理として実行されました。`INSERT`、`UPDATE`、`DELETE`、`ALTER`、`DROP`、`CREATE`は実行していません。

## ローカル再現試験への反映

本番D1のSQLエクスポートをリポジトリ外の一時D1へ読み込み、`0001`から`0008`をローカルで順番に適用しました。再現試験の結果は [local-production-migration-rehearsal.md](C:/Users/89bi4/Documents/New%20project/docs/local-production-migration-rehearsal.md) に記録しています。

試験では既存splitプロジェクト`prj_mrbhik3r_b9ku`が保持され、移行後の金額が一致し、`owner_unknown`が作成されることを確認しました。owner_unknownの恒久利用や実利用者の推測は行いません。所有者移管の雛形は [assign_legacy_project_owner.example.sql](C:/Users/89bi4/Documents/New%20project/db/assign_legacy_project_owner.example.sql) と [legacy-project-owner-handoff.md](C:/Users/89bi4/Documents/New%20project/docs/legacy-project-owner-handoff.md) に分けて記載しています。

`production_household_inspection.sql`は、最初に`legacy_initial`、`household_ledger`、`auth_without_gmail`、`gmail_schema`、`personal_household_schema`、`unknown_schema`を判定する構造へ修正しました。旧初期スキーマでは、存在しない認証・Gmail表を直接参照せず、旧表の件数、金額、ID、外部キー状態を確認します。
