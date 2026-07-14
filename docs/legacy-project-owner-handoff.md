# 既存splitプロジェクトの所有者移管

## 対象

- プロジェクト: `prj_mrbhik3r_b9ku`
- 現在のowner: `owner_unknown`
- 新しいowner: Googleログイン後に作成された実利用者の`users.id`

本番D1は旧初期スキーマで、所有者に相当するGoogle利用者が存在しません。`0003`適用後は`owner_unknown`が削除済み利用者として作成され、既存splitプロジェクトへowner権限が付与されます。実利用者を推測して割り当てません。

## 実行前確認

1. Googleログインを完了し、`users.id`を確認します。
2. `users.id`が`owner_unknown`ではないことを確認します。
3. `deleted_at IS NULL`かつ`deletion_started_at IS NULL`であることを確認します。
4. `prj_mrbhik3r_b9ku`が存在することを確認します。
5. 現在の有効なownerが`owner_unknown`の1行であることを確認します。
6. 新利用者に対象プロジェクトのeditor、viewer、失効済みownerなどの競合行がないことを確認します。
7. 本番D1のバックアップまたはエクスポートが取得済みであることを確認します。

条件に一つでも合わない場合、SQLを実行せず対象IDと状態を報告します。

## SQLテンプレートの使用方法

[assign_legacy_project_owner.example.sql](C:/Users/89bi4/Documents/New%20project/db/assign_legacy_project_owner.example.sql)の`__NEW_USER_ID__`を、確認済みの実利用者IDへ実行時に置き換えます。実際の利用者IDをこのリポジトリのSQLへ固定して保存しません。

置換後のSQLは、承認済みの一時ファイルから、対象を`prj_mrbhik3r_b9ku`に限定して実行します。SQLはトランザクション内で次を確認します。

- 新利用者が存在し、削除中・削除済みでない
- 対象プロジェクトが存在する
- 現在のownerが`owner_unknown`の有効な1行である
- 新利用者に競合権限がない
- 新利用者のowner行を追加または再有効化する
- `owner_unknown`のowner行を`revoked_at`付きで保持する
- 有効なownerが新利用者の1行になる

条件不一致は一時表の`CHECK (ok = 1)`で失敗し、トランザクションを中断します。再実行時は既存の新利用者owner行を再利用し、同じ主キーの重複行を作りません。

## 影響範囲

更新対象は`project_user_roles`の`prj_mrbhik3r_b9ku`に関する権限行です。`projects`、取引、参加者、Gmail関連表、他プロジェクトは更新しません。`owner_unknown`のusers行は削除しません。

所有者移管後、認証済みプロジェクト一覧で対象splitプロジェクトが新利用者に表示されることを確認します。家計簿の作成、Gmail接続、共有設定は別処理であり、この移管SQLには含めません。
