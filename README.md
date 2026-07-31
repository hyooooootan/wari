# Wari

スマートフォン向けの割り勘・家計簿アプリです。ホーム画面は個人家計簿の常設カレンダーで、日付ごとの支出と返金を確認・追加できます。割り勘は独立したプロジェクトとして一覧と詳細画面で管理し、Gmailの支払い通知やレシートなどを家計簿へ取り込めます。

家計簿は `household` 型のプロジェクトとして保存され、ログイン利用者が所有する本人専用の一件を使用します。ホームのカレンダーは本人の家計簿を表示し、複数の家計簿を横断して集計しません。割り勘から反映された支出も本人の家計簿へ表示されます。

## 画面構成

- ホーム: 本人の `household` プロジェクト一件の月間カレンダー、日別支出一覧、支出追加
- ホーム下部: `split` 型の割り勘プロジェクト一覧
- 割り勘詳細: 参加者、お店、精算の各画面
- 家計簿詳細: 取引、取込、集計の各画面。ホームの日別明細から取引詳細も開けます

ホームで初めて「支出を追加」すると、ログイン利用者を `projects.owner_user_id` に設定した `household` プロジェクトを作成してから支出を保存します。すでに本人の家計簿がある場合は同じ家計簿を使用し、同時作成による一意制約の衝突が起きた場合も既存の一件を取得します。過去のローカル保存状態に複数の家計簿が残る場合がありますが、自動削除や統合はせず、現行画面では本人の家計簿一件を使用します。家計簿はホームのプロジェクト一覧には表示せず、取引・取込・割り勘参加者との接続を担う内部保存先として扱います。

## プロジェクトと権限

- `split`: 複数利用者で共有できる割り勘。`project_user_roles` と `project_shares` で owner・editor・viewer 権限と共有リンクを管理します。
- `household`: 利用者本人専用の家計簿。所有者は `projects.owner_user_id` で管理し、共有リンク、editor、viewer、共同所有者は扱いません。
- `Gmail`: `gmail_connections.household_project_id` で本人の `household` に固定します。接続時や候補登録時に `project_id` は選択せず、候補を確認・修正してから接続先家計簿へ登録します。

現行の `projects.project_type` は `split` と `household` です。`shared_household` は現行仕様には存在しません。

## 主な機能

- 常設カレンダーでの日別支出表示と支出追加
- 家計簿の月別・費目別・支払方法別集計
- 三井住友カード、楽天カード、JCBのGmail支払い通知について、期間指定、候補確認・修正、複数選択、一括登録・破棄
- レシート、カードCSV、PayPay CSV、銀行CSV、解析済み通知の取込と照合
- 既存のCSV取込記録とCSV APIの互換性を維持
- クレジットカード返金など、負数取引の返金表示と集計
- 割り勘プロジェクトの作成、参加者・支払い・品目・負担額の管理
- 支払い合計、負担額、差額、精算結果の表示
- 割り勘参加者と本人の内部 `household` 保存先の接続
- 割り勘編集中は仮の `split_expense`、確定後は確定した `split_expense` として家計簿へ反映
- Cloudflare D1 と端末内保存
- `wari-data-v2` から `wari-data-v3` への端末データ移行
- `split` の共有リンク作成

## データ構成

```text
projects
├─ users
├─ project_user_roles       # splitの権限
├─ project_shares           # splitの共有リンク
├─ gmail_connections        # household_project_idで本人householdへ固定
├─ project_members
├─ transactions
│  ├─ transaction_payments
│  └─ transaction_items
│     └─ item_allocations
└─ import_records
```

`projects.project_type` は `split` または `household` です。`household` の所有者は `projects.owner_user_id` で管理し、利用者一人につき一件に制限します。`split` は `project_user_roles` と `project_shares` で権限と共有を管理します。割り勘は `split` 型のプロジェクトとして残り、家計簿へ移し替えません。割り勘参加者と家計簿の接続は `project_members.linked_household_project_id`、Gmail接続先は `gmail_connections.household_project_id`、派生取引と元の割り勘の接続は `transactions.origin_*` で表します。

通常の家計簿表示に含める取引種別は `purchase`、`split_expense`、`refund`、`adjustment` です。カレンダーは仮取引も日別・月間合計へ含めます。確定分の集計は `confirmed` と `corrected` に加え、`entry_type = refund` かつ `status = refunded` の有効な返金を負数で含めます。取消済み取引と、返金された元の購入は除外します。負数で登録した購入は `refund` として扱い、クレジットカードなどの支払方法別集計からも差し引きます。

割り勘を編集中でも、接続された参加者ごとに家計簿へ仮の `split_expense` を作成または更新します。割り勘を確定すると派生取引を確定し、再開すると仮へ戻します。負数の割り勘は返金として配分し、元取引の支払方法を派生取引へ引き継ぎます。再同期しても同じ派生取引が増えないよう、元プロジェクト・元取引・参加者・保存先を識別して管理します。

端末では七表分の配列を `localStorage` の `wari-data-v3` に保存します。旧 `wari-data-v2` がある場合は読み込み時に変換して `v3` を作成し、旧保存内容も残します。D1 でも同じ七表を使います。

## ディレクトリ構成

```text
.
├─ public/                    # Cloudflare Pages で配信するフロントエンド
│  ├─ index.html
│  ├─ app.js
│  ├─ styles.css
│  └─ modules/                # 端末保存、計算、取込、API 通信
├─ functions/api/[[path]].js  # Cloudflare Pages Functions API
├─ functions/lib/             # 取引、照合、CSV、同期、OCR 共通処理
├─ db/
│  ├─ schema.sql              # 空の D1 向け七表定義
│  ├─ migrations/             # 番号付き D1 移行
│  └─ verify_household_ledger.sql
├─ tests/                     # Node 標準試験
├─ services/receipt_ocr/      # OCR 中継・ローカル実験
├─ server.py                  # 静的画面確認用サーバーと OCR プロキシ
├─ render.yaml
├─ wrangler.toml
└─ package.json
```

## ローカル確認

画面の配置と端末内保存を確認する場合は次を実行します。

```powershell
python server.py
```

ブラウザで `http://127.0.0.1:4181` を開きます。D1 が使えない場合も、データは `localStorage` に保存されます。

レシートOCRも確認する場合は、Python 3.10以上、Tesseract、Ollamaを用意してから依存関係を導入します。

```powershell
python -m pip install -r services/receipt_ocr/requirements.txt
python -m services.receipt_ocr.check_env
python server.py
```

`http://127.0.0.1:4181/api/ocr-health` が `ok: true` を返すことを確認してから、画面の「取込」で画像を選びます。ローカルOCRの入力はJPEG、PNG、WebPで、復号前の画像は5MB以下です。依存関係が不足している場合、OCR要求は設定不足として503を返します。画面表示の確認とOCRの確認は別に行えます。

自動試験と、Pages Functions・D1 を含む確認には次を実行します。

```powershell
npm install
npm run db:migrate:local
npm test
npm run dev:cloudflare
```

`npm run db:migrate:local` はローカル D1 に番号付き移行を適用します。`npm run db:local` は `db/schema.sql` から新しい七表を直接作る命令です。同じローカル D1 保存先へ両方を続けて実行しないでください。`npm run dev:cloudflare` の確認先は通常 `http://localhost:8788` です。ポートが使用中の場合は Wrangler の表示を確認してください。

D1 移行後の確認には次を使います。

```powershell
npx wrangler d1 execute wari-db --local --file=./db/verify_household_ledger.sql
```

## Cloudflare 設定

```powershell
npx wrangler login
npm run d1:create
```

`npm run d1:create` の出力にある `database_id` を `wrangler.toml` に設定し、空の D1 には `npm run d1:migrate:remote`、既存の旧七表を移行する D1 には書出しを取得したうえで `npm run db:migrate:remote` を実行します。移行後は `db/verify_household_ledger.sql` を実行し、失敗件数が0であること、移行前後の件数と金額を確認します。Pages の D1 binding は `DB`、接続先は `wari-db` です。

OCR の構成と D1 移行の詳細は [docs/household-ledger.md](docs/household-ledger.md) を参照してください。
