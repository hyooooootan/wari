# 割り勘・家計簿統合

## 現在の画面構成

ホーム画面は個人家計簿の常設カレンダーです。月を切り替えると、その月の支出を日付ごとに表示し、日付を選ぶと当日の取引一覧を表示します。取引を選ぶと、店名、金額、日付、分類、状態、メモを確認できます。ホームの「支出を追加」はカレンダーで選択した日付を初期値にして新しい家計簿取引を追加します。

ホームには `household` 型の家計簿をプロジェクトとして並べません。画面下部に表示するのは `split` 型の割り勘プロジェクトです。割り勘の詳細画面は「参加者」「お店」「精算」に分かれ、家計簿の詳細画面は「取引」「取込」「集計」に分かれます。家計簿の取引一覧や取込・集計画面は、カレンダーの日別明細から家計簿を開いて利用します。

## 内部の家計簿保存

画面上の一つのカレンダーは、ログイン利用者が所有する一件の `household` プロジェクトを表示します。取得条件は `project_type = household` かつ `owner_user_id` が本人であることです。過去のローカル保存状態に複数の `household` 行が残る場合がありますが、現行画面でそれらを横断して表示・集計しません。対象は `purchase`、`split_expense`、`refund`、`adjustment` です。カレンダーは `provisional` も日別・月間合計へ含めます。`cancelled` と、`entry_type` が `refund` ではない `refunded` は除外します。`entry_type = refund` かつ `status = refunded` の取引は、有効な返金として負数で表示します。

`household` プロジェクトは、取引、取込、割り勘参加者との接続に使う本人専用の内部境界です。所有者は `projects.owner_user_id` で管理し、`project_user_roles`、`project_shares`、共有リンク、editor、viewer は設定しません。各保存先には本人の `project_members` 行を持たせます。本人の家計簿がない場合は、最初の支出追加を開いた時点で `Household.createHouseholdProject` を呼び、名前「家計簿」の `household` プロジェクトを作成してから入力した支出を保存します。家計簿作成用のプロジェクト一覧上の画面はありません。

家計簿の手入力取引は、取引本体、支払い、要約品目、本人への配分を一組で作成します。金額が負数の場合は `entry_type = refund` として保存し、0円は登録しません。端末では七表分の配列を `localStorage` の `wari-data-v3` に保存します。旧 `wari-data-v2` がある場合は読み込み時に七表へ変換して `v3` を保存し、旧キーの内容は削除しません。D1 と端末保存は同じ表構成を使います。

## 七表と関係

```text
projects
├─ project_members
├─ transactions
│  ├─ transaction_payments
│  └─ transaction_items
│     └─ item_allocations
└─ import_records
```

`projects.project_type` は `split` または `household` です。`household` の所有者は `projects.owner_user_id`、`split` の権限と共有は `project_user_roles` と `project_shares` で管理します。Gmail接続先は `gmail_connections.household_project_id` で本人の家計簿に固定します。割り勘参加者と家計簿保存先の関係は `project_members.linked_household_project_id` と `linked_at` で表します。取込元と取引の関係は `import_records.transaction_id`、家計簿へ生成した派生取引と元の割り勘の関係は `transactions.origin_project_id`、`origin_transaction_id`、`origin_member_id` で表します。旧移行前スキーマにあった `shared_household` は現行のプロジェクト種別ではありません。

割り勘は家計簿へ変換せず、`split` 型のプロジェクトとして残ります。割り勘の実支払額と参加者の消費負担は別に保存し、立替額は `transaction_payments`、品目ごとの負担額は `item_allocations` から計算します。端数は参加者順に一円ずつ配分します。

## 割り勘から家計簿への反映

割り勘の参加者画面で、各参加者を内部の `household` 保存先へ接続します。割り勘を編集中でも、接続済み参加者について負担額の派生取引を作成します。元の割り勘を確定すると派生取引は `confirmed`、再開すると `provisional` になります。

元の割り勘を保存した後で家計簿への同期に失敗した場合、応答の `synchronization.status` は `pending`、`sync_pending` は `true` となり、`job_id` が返ります。保存した元データは失敗応答として扱いません。ジョブを作成した利用者は、元の割り勘と接続先家計簿の編集権限を保持した状態で `POST /api/household-sync-jobs/{job_id}/retry` を呼び出せます。この要求には `APP_ORIGIN` と一致する `Origin`、二重照合用の CSRF 値、`application/json` の空オブジェクトが必要です。成功すると `completed`、元または接続先の権限を失っている場合は `blocked`、元プロジェクトが存在しない場合は `rejected` になります。接続先への派生書込みは、同じ D1 batch の先頭で書込み対象となる全家計簿の権限を再検査します。

派生取引は、元プロジェクト、元取引、元参加者、家計簿保存先を組み合わせた識別子で作成します。同じ同期を繰り返しても増えず、既存行を更新します。派生取引の品目には対象参加者の負担額と分類を引き継ぎ、家計簿側では本人を全額負担者として登録します。支払方法は元取引の有効な支払いから引き継ぎます。負数の返金では支払い、品目、配分も負数のまま反映します。自動生成された取引を元に、さらに派生取引は作りません。

元取引が削除された場合、または対象参加者の負担額が0になった場合、対応する派生取引は `cancelled` になり、金額も0になります。割り勘の立替、精算送金、精算受取は通常の家計簿支出へ加えません。

## 取込と照合

レシート、カードCSV、PayPay CSV、銀行CSV、解析済み通知は、取引を直接上書きせず `import_records` に保存します。取込元の情報、解析結果、接続、確認、除外、失敗の状態を保持します。

Gmailの支払い通知は、接続された本人の家計簿に対する候補として保存します。画面では90日以内の開始日と終了日を指定し、候補の店名、金額、日時を確認・修正できます。表示中の候補は複数選択でき、登録可能な候補の一括登録と、選択候補の一括破棄に対応します。0円や情報不足の候補は登録せず、確認対象として残します。負数のクレジットカード通知は `entry_type = refund`、`status = refunded`、負数の支払いとして家計簿へ登録し、カレンダーと確定分の集計へ反映します。

候補はプロジェクト、金額、日時、状態の索引で絞り、最大50件を対象に外部識別子、支払額、総額、正規化店舗名、時刻差、決済方法、口座表示、情報源の組合せから点数を計算します。同じ情報源、取消と通常購入の組合せ、同時間帯の複数候補には減点します。

- 85点以上: 強い条件が複数あり、候補が一件に絞れた場合に接続
- 55点以上85点未満: 利用者確認
- 55点未満: 別取引の作成候補

同点または近い点数の候補がある場合は自動接続しません。利用者が確認した値を項目ごとに優先し、確定CSVやレシートの確定値を通知で上書きしません。

## D1 移行

`db/schema.sql` は空の D1 に現在の表を作成します。`db/migrations/0001_initial.sql` は初期七表、`db/migrations/0002_household_ledger.sql` は旧七表が存在する D1 を家計簿構造へ移行し、後続の番号付き移行が認証、Gmail、アカウント削除、家計簿同期再試行を追加します。番号付き移行は Wrangler の移行履歴で管理します。

移行では旧会計を `transactions`、旧支払いを `transaction_payments`、旧品目を `transaction_items` へ移します。品目がない取引には要約行を作り、品目合計と実支払額に差がある場合は調整行を作ります。旧負担者がいる品目は一円単位で配分し、負担者がない品目は有効参加者へ配分します。

ローカル確認は次の順序で行います。

```powershell
npm install
npm run db:migrate:local
npm test
npm run dev:cloudflare
```

静的画面だけを確認する場合は `python server.py` を実行し、`http://127.0.0.1:4181` を開きます。D1 を使わない場合は `localStorage` に保存されます。`npm run db:local` は `db/schema.sql` から新しい七表を直接作る命令で、移行経路を確認する `npm run db:migrate:local` と同じ保存先へ続けて実行しません。

移行後は次を実行して、表件数、金額、支払い、品目、負担、外部キーの不整合を確認します。

```powershell
npx wrangler d1 execute wari-db --local --file=./db/verify_household_ledger.sql
```

既存の遠隔 D1 は、移行前に書出しを取得してから `npm run db:migrate:remote` を実行します。移行後は同じ検査SQLを遠隔 D1 に実行し、失敗件数が0であることと移行前後の件数・金額を確認します。

## OCR

Cloudflare Pages Functions の `/api/ocr-receipt` は、`OCR_BACKEND=auto`、`openai`、`gemini` で接続先を切り替えます。ルートの `server.py` はローカル確認用に `local`、`openai`、`gemini`、`auto` を使えます。Render Free では `services/receipt_ocr` を Gemini 中継として起動し、PaddleOCR のローカル実験は `requirements-local.txt` を使います。

## 復元

本番 D1 を移行する前に書出しを保存し、移行後の検査結果を記録します。コードを戻す場合は退避用ブランチを参照します。D1 を戻す場合は移行前の書出しから別の D1 を作成して確認し、Pages の D1 接続先を切り替えます。現在の家計簿取引や取込履歴を旧形式で表現できないため、新七表から旧七表への逆移行は使用しません。
