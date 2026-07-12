# Wari

スマートフォン向けの割り勘・家計簿アプリです。ホーム画面は個人家計簿の常設カレンダーで、日付ごとの支出を確認・追加できます。割り勘は独立したプロジェクトとして一覧と詳細画面で管理します。

家計簿は画面上では一つのカレンダーに見えますが、内部では `household` 型のプロジェクトとして保存されます。複数の家計簿がある場合も、ホームのカレンダーはそれらの取引を横断して表示します。割り勘から反映された支出も同じカレンダーに表示されます。

## 画面構成

- ホーム: 複数の `household` プロジェクトを横断する月間カレンダー、日別支出一覧、支出追加
- ホーム下部: `split` 型の割り勘プロジェクト一覧
- 割り勘詳細: 参加者、お店、精算の各画面
- 家計簿詳細: 取引、取込、集計の各画面。ホームの日別明細から取引詳細も開けます

ホームで初めて「支出を追加」すると、内部に `household` プロジェクトと本人の `project_members` 行を作成してから支出を保存します。既存の家計簿がある場合は、作成日時が早い家計簿をカレンダーからの新規支出の保存先として使用します。家計簿はホームのプロジェクト一覧には表示せず、取引・取込・共有・割り勘参加者との接続を担う内部保存先として扱います。

## 主な機能

- 常設カレンダーでの日別支出表示と支出追加
- 家計簿の月別・費目別・支払方法別集計
- レシート、カードCSV、PayPay CSV、銀行CSV、解析済み通知の取込と照合
- 割り勘プロジェクトの作成、参加者・支払い・品目・負担額の管理
- 支払い合計、負担額、差額、精算結果の表示
- 割り勘参加者と内部 `household` 保存先の接続
- 割り勘確定時の `split_expense` の家計簿への反映
- Cloudflare D1 と端末内保存
- `wari-data-v2` から `wari-data-v3` への端末データ移行
- 共有リンク作成

## データ構成

```text
projects
├─ project_members
├─ transactions
│  ├─ transaction_payments
│  └─ transaction_items
│     └─ item_allocations
└─ import_records
```

`projects.project_type` は `split`、`household`、`shared_household` を取ります。割り勘は `split` 型のプロジェクトとして残り、家計簿へ移し替えません。割り勘参加者と家計簿の接続は `project_members.linked_household_project_id`、派生取引と元の割り勘の接続は `transactions.origin_*` で表します。

通常の家計簿表示に含める取引種別は `purchase`、`split_expense`、`refund`、`adjustment` です。取消・返金済みの取引、割り勘の立替額・精算送金・精算受取は通常支出の集計から除外します。割り勘を確定すると、接続された参加者ごとに家計簿へ `split_expense` を作成または更新します。再同期しても同じ派生取引が増えないよう、元プロジェクト・元取引・参加者・保存先を識別して管理します。

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

静的画面を確認する場合は次を実行します。

```powershell
python server.py
```

ブラウザで `http://127.0.0.1:4181` を開きます。D1 が使えない場合も、データは `localStorage` に保存されます。

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
