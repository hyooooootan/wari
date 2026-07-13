# 個人家計簿への移行設計

## 対象と前提

対象枝は `codex/gmail-payment-import` です。割り勘の `split` は複数利用者で共有し、家計簿の `household` は利用者本人の専用領域に変更します。`shared_household` は新しい業務上の種類として廃止します。既存の `0001` から `0008` は編集しません。

本段階では既存のコード、既存のマイグレーション、通常の開発用ローカルD1、本番D1は変更していません。本番D1の複製をリポジトリ外の一時D1へ読み込み、移行再現試験を行いました。

検査SQLは [production_household_inspection.sql](C:/Users/89bi4/Documents/New%20project/db/production_household_inspection.sql) です。`d1_migrations` の存在確認を含めていますが、適用済みマイグレーションの一覧を得る問い合わせはD1の標準管理表を前提にしています。

## 現在の定義から確認できること

現在の `projects` は `split`、`household`、`shared_household` を許可し、`owner_user_id` を持っていません。所有者は `project_user_roles` の有効な `owner` 行で表されています。`project_shares` は `project_id` による共有リンクを持ち、`projects.share_token` には旧形式の共有値が残る設計です。

現在の `gmail_connections` は `user_id` を持ちますが、家計簿への外部キーはありません。したがって、既存接続は所有者の専用 `household` が一意に確定した後に `household_project_id` を設定できます。

## 新しい `projects` 定義

新しい表定義では、次の形を採用します。

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  project_type TEXT NOT NULL CHECK (project_type IN ('split', 'household')),
  owner_user_id TEXT,
  currency TEXT NOT NULL DEFAULT 'JPY' CHECK (length(currency) = 3),
  share_token TEXT,
  share_role TEXT NOT NULL DEFAULT 'editor' CHECK (share_role IN ('editor', 'viewer')),
  share_expires_at TEXT,
  finalized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((project_type = 'household' AND owner_user_id IS NOT NULL)
      OR (project_type = 'split' AND owner_user_id IS NULL)),
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);
```

`owner_user_id` は `household` では必須、`split` ではNULLとします。削除中・削除済みの利用者を新しい所有者にする処理はAPIと移行前検査で拒否します。`owner_user_id` をNULLに戻す更新も拒否します。家計簿の所有者を消去する場合は、別の利用者への明示的な所有者移行を先に完了させます。

次の一意索引で1利用者1家計簿を保証します。

```sql
CREATE UNIQUE INDEX idx_projects_household_owner
ON projects(owner_user_id)
WHERE project_type = 'household' AND owner_user_id IS NOT NULL;
```

## 共有の境界

`project_shares` と `project_user_roles` は `split` に限定します。SQLiteの外部キーだけでは種類を検査できないため、次のトリガーを新しい移行で追加します。

- `project_shares` の追加・更新時に、対象が `household` なら `RAISE(ABORT, 'household_sharing_forbidden')` で停止する。
- `project_user_roles` の追加・更新時に、対象が `household` なら `owner` 以外を拒否する。
- `owner_user_id` が導入された後は、householdの所有者判定を `owner_user_id` に統一し、householdの旧 `owner` 行は移行時に失効扱いへ変更する。行自体は削除しない。
- `projects.share_token` と `share_expires_at` は、移行前検査で値を列挙する。householdの値は有効期限や失効状態にかかわらず、移行を止めて管理者の判断を求める。

新規APIの共有処理は `project_type = 'split'` を先に確認します。トリガーはAPIを経由しない書込みも拒否する最後の防壁です。

## Gmail接続

`gmail_connections` に次の列を追加します。

```sql
household_project_id TEXT NOT NULL,
FOREIGN KEY (household_project_id) REFERENCES projects(id)
  ON UPDATE CASCADE ON DELETE RESTRICT
```

接続時、同期開始時、候補取込時に、次の条件を同一の所有者判定として使用します。

- `gmail_connections.user_id = projects.owner_user_id`
- `projects.project_type = 'household'`
- 利用者が削除中・削除済みでない
- 接続先が他の共有権限を持たない

同期と候補取込の要求本文から`project_id`を受け取らず、接続行の`household_project_id`を読みます。既存の`gmail_oauth_states.project_id`は今回変更対象外として残し、Gmail処理で値を信用しない設計へ寄せます。別の移行で列を廃止する場合は、今回の移行とは分けます。

接続先の決定は、利用者に有効な専用家計簿が一つ存在する場合に限ります。0件または2件以上なら接続・同期・候補取込を停止し、接続IDと利用者IDを管理者へ報告します。

## 既存データの移行方針

### household

検査SQLで、利用者ごとの件数、所有者なし、所有者複数、削除中・削除済み所有者、共有設定、孤立行を確認します。条件を満たす家計簿は、既存の有効な単一owner行から`owner_user_id`を設定します。複数候補がある場合に作成日時やIDで自動選択しません。

所有者が確定した後、家計簿の旧owner権限行は`revoked_at`を設定して履歴として保持します。データ行と利用者行の削除は行いません。移行後に必要な所有権確認は`projects.owner_user_id`で行います。

### shared_household

実データを確認するまで変換先を決定しません。検査SQLが返すIDごとに、管理者が次のいずれかを指定します。

| 選択肢 | 扱い | 条件 |
|---|---|---|
| A | `split`へ変換し、割り勘の共有プロジェクトとして維持 | 複数利用者、共有リンク、取引履歴を割り勘として維持する場合 |
| B | 特定利用者の`household`へ移す | 所有者を一人に確定でき、共有設定を解除する場合 |
| C | 移行対象外として保全し、アプリから隠す | 判断が終わらず、削除せずに保全する場合 |

複数利用者が参加しているデータを、利用者の選択なしに一人の`household`へ変換しません。共有リンクが有効なデータも同様です。Cを採用する場合は、`project_type`を新定義へ直ちに変換できないため、移行の停止条件または保全用の状態設計を別途確定します。

### Gmail接続

接続ごとに候補家計簿が一つあることを検査します。一意に決まる接続は`household_project_id`へ設定します。候補がない、複数ある、所有者が削除中・削除済み、接続先が旧共有家計簿である場合は、接続IDと利用者IDを出力して停止します。接続情報、暗号化済みトークン、同期履歴、候補を自動削除しません。

## 移行を停止する条件

次のいずれかが検査結果に存在する場合、新しい制約を追加する移行を実行しません。

- 1利用者が複数の`household`を持つ
- ownerが存在しない、または複数存在する`household`がある
- ownerが削除中または削除済みである
- `shared_household`に複数利用者が参加している
- `household`に有効な共有リンクがある
- `household`に`editor`または`viewer`の有効な権限がある
- `household`に旧`share_token`が設定されている
- Gmail接続先を一意に決定できない
- `project_members.linked_household_project_id`が存在しない、または`household`でない
- `PRAGMA foreign_key_check`または手動孤立行検査が0件でない
- 適用済みマイグレーションが想定する`0008`に達していない

検査結果が不明、またはD1のスキーマが想定と異なる場合も停止します。停止時は対象IDを一覧化し、上表のshared_householdの選択肢や所有者の割当を人が決めてから再検査します。

## 追加するマイグレーション案

実装時の新しい番号は `0009_personal_households.sql` とします。既存の番号は変更しません。実行順は次のとおりです。

1. `d1_migrations`、表定義、検査SQLの結果を確認する。
2. SQLiteの表再作成を使い、`projects`へ`owner_user_id`を追加し、種類を`split`と`household`へ限定する。コピー前に停止条件をトリガーで再確認する。
3. 一意のownerを`owner_user_id`へ移す。householdの旧owner行は失効扱いへ変更し、行は残す。
4. `project_shares`と`project_user_roles`の種類検査トリガーを作る。
5. `gmail_connections`を表再作成し、確定済みの`household_project_id`を設定する。接続先の不確定行があれば制約追加前に停止する。
6. 新しい索引と外部キーを作成し、`PRAGMA foreign_key_check`を再実行する。

SQLiteの再作成中に一部の表だけが置き換わることを避けるため、各表の退避、作成、コピー、索引、旧表の扱いは一つのD1移行単位で実施します。移行SQLへ自動削除を記述せず、変換対象外のデータは保全表または旧定義を維持した別段階へ送ります。

## 影響するコード

実装時に確認・修正するファイルは次のとおりです。今回の段階では変更していません。

- `db/schema.sql`: 新しい定義の空データベース用スキーマ
- `db/migrations/0009_personal_households.sql`: 新規移行
- `functions/api/[[path]].js`: プロジェクト作成、一覧、更新、共有、権限、Gmail同期と候補取込の要求処理
- `functions/lib/permissions.js`: split限定の共有権限判定
- `functions/lib/gmail.js`: 接続先の取得、同期、候補取込からの`project_id`排除
- `functions/lib/household.js`: 本人専用家計簿の取得と割り勘からの派生処理
- `functions/lib/api-data.js`: 利用者ごとの家計簿一覧と所有者条件
- `functions/lib/imports.js`: 家計簿登録の共通処理へ渡す対象IDの検証
- `public/app.js`: 家計簿を複数選択しない表示、Gmail候補登録先の固定
- `public/modules/api.js`: Gmail同期・候補登録要求の本文から対象プロジェクトを除く処理
- `tests/schema-migration.test.js`: 新定義、索引、トリガー、停止条件
- `tests/api-routes.test.mjs`: 家計簿共有拒否、所有者制約、Gmail対象固定
- `tests/gmail-import.test.mjs`: 接続先不一致、候補取込対象の固定
- `tests/household-sync.test.mjs`: split共有から本人家計簿への派生処理の退行

## テスト計画

- 空のD1へ`0001`から`0009`を順に適用する。
- 現行スキーマへ検査用の異常データを投入した模擬D1で、各停止条件が対象IDを返すことを確認する。
- ownerなし、owner複数、利用者の家計簿複数、削除中所有者、複数参加shared_household、共有リンク、旧share_token、Gmail接続先複数を個別に検査する。
- `project_shares`のhousehold追加、`project_user_roles`のhousehold editor/viewer追加、householdの所有者変更を拒否する。
- splitの共有リンク、editor、viewer、複数利用者権限が維持されることを確認する。
- Gmailの接続、同期、候補編集、候補無視、家計簿登録が接続行の`household_project_id`へ固定され、要求本文の`project_id`を無視することを確認する。
- `project_members.linked_household_project_id`、OCR、手入力、割り勘からの家計簿派生処理が維持されることを確認する。
- `PRAGMA foreign_key_check`、手動孤立行検査、移行後の件数照合を確認する。

## ロールバック方針

本番適用前にD1のバックアップまたはエクスポートを取得します。移行途中の失敗はD1移行単位のロールバックに任せ、アプリケーションコードは新定義を前提にするまで本番へ出しません。適用後に判明したデータ不整合は、旧表の復元を直接行わず、バックアップから検証用D1へ復元して差分を確認します。

`owner_user_id`を旧owner行へ戻す逆移行SQLは、所有者の対応表と実行前の検査結果を要求する別作業として作成します。自動的に任意のownerを選ぶ逆移行は行いません。

## 本番D1と再現試験後の確定事項

本番D1は`0001_initial.sql`相当の旧初期スキーマでした。`projects`の列は`id`、`name`、`created_at`で、`users`、`project_user_roles`、`gmail_connections`、`d1_migrations`は存在しません。既存プロジェクトは`prj_mrbhik3r_b9ku`の1件で、`project_shares`は0件でした。`shared_household`、Gmail接続、既存householdの移行はありません。

本番データの所有者は推測しません。`0003`適用後に作成される`owner_unknown`は一時的な移行上の識別子であり、恒久的な所有者として使用しません。実利用者がGoogleログインした後、対象プロジェクトを明示的に移管します。移管SQLは [assign_legacy_project_owner.example.sql](C:/Users/89bi4/Documents/New%20project/db/assign_legacy_project_owner.example.sql) に雛形を置き、利用者IDは実行時に置換します。

ローカル複製では`0001`から`0008`を順番に適用できました。既存splitプロジェクトは維持され、移行後の取引、支払、品目、配分の金額はそれぞれ`1200`で一致し、`verify_household_ledger.sql`の失敗値はすべて0でした。詳細は [local-production-migration-rehearsal.md](C:/Users/89bi4/Documents/New%20project/docs/local-production-migration-rehearsal.md) に記録しています。

リモート適用は、エクスポート取得、ローカル再現、移行前後の件数・金額・ID照合、検証SQL、所有者移管の承認を順番に完了してから行います。いずれかの結果が不一致、所有者不明、既存Gmail接続あり、既存householdあり、外部キー違反ありとなった場合は停止します。

`0009_personal_households.sql`は今回作成しません。`0001`から`0008`のリモート適用、実利用者への所有者移管、運用承認が完了するまで、`0009`の作成へ進みません。
