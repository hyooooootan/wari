# Wari

スマホ向けの軽い割り勘管理アプリです。

現在は、手入力でプロジェクト・参加者・お店・支払いを管理できます。Cloudflare Pages + Pages Functions + D1 へ移行できる土台と、別サーバーで動かすローカルOCR実験用コードを分離してあります。

## できること

- プロジェクト作成
- 参加者追加
- お店ごとの合計金額登録
- お店ごとの複数支払者登録
- 支払い合計、負担額、差額、精算結果の表示
- Cloudflare D1 への保存
- 共有リンク作成
- レシートOCR用に `receipt_image_url` を保持

## ディレクトリ構成

```text
.
├─ public/                    # Cloudflare Pagesで配信するフロント
│  ├─ index.html
│  ├─ app.js
│  └─ styles.css
├─ functions/api/[[path]].js   # Cloudflare Pages Functions API
├─ db/schema.sql               # Cloudflare D1 / SQLite schema
├─ services/receipt_ocr/       # Render等に載せるローカルOCRサーバー候補
│  ├─ api.py                   # HTTP API: /ocr, /api/ocr-receipt
│  ├─ core.py                  # PaddleOCR読み取り・レシート解析
│  ├─ probe.py                 # 画像がレシートっぽいか確認する実験CLI
│  ├─ .python-version
│  └─ requirements.txt
├─ server.py                   # ローカル確認用の静的サーバー + OCRプロキシ
├─ render.yaml                 # Render Free向けOCRサービスBlueprint
├─ wrangler.toml               # Cloudflare Pages / D1 設定
└─ package.json
```

OCR本体は `services/receipt_ocr/` に寄せています。ルート直下には、アプリ本体の設定・ローカル起動・Cloudflare設定を置く方針です。

## ローカル起動

軽い確認には、Pythonのローカルサーバーで起動できます。

```powershell
python server.py
```

ブラウザで `http://127.0.0.1:4181` を開きます。Cloudflare D1 が使えない環境では `localStorage` に保存します。

Cloudflare Pages Functions と D1 をローカル確認する場合は Wrangler を使います。

```powershell
npm install
npm run d1:migrate:local
npm run dev
```

## Cloudflare設定

1. Cloudflare にログインします。

```powershell
npx wrangler login
```

2. D1 database を作成します。

```powershell
npm run d1:create
```

3. 表示された `database_id` を `wrangler.toml` に入れます。

```toml
database_id = "ここにdatabase_id"
```

4. D1 にテーブルを作ります。

```powershell
npm run d1:migrate:remote
```

5. Cloudflare Pages で GitHub リポジトリ `hyooooootan/wari` を接続します。

6. Pages の D1 binding を設定します。

```text
Binding name: DB
D1 database: wari-db
```

## OCRについて

OCRは3系統を切り替えられる構成です。

### 1. Cloudflare上のAI OCR

Cloudflare Pages Functions の `/api/ocr-receipt` は、環境変数で OpenAI API と Gemini API を切り替えられます。

```text
OCR_BACKEND=auto
OPENAI_API_KEY=sk-...
OPENAI_OCR_MODEL=gpt-5.4-mini
GEMINI_API_KEY=...
GEMINI_OCR_MODEL=gemini-2.5-flash
```

`OCR_BACKEND` は `auto`、`openai`、`gemini` を指定できます。`auto` は OpenAI API の鍵があれば OpenAI、なければ Gemini を使います。

### 2. ローカル確認用の切り替え

ルートの `server.py` も `/api/ocr-receipt` を持っています。ローカルでは以下を選べます。

```text
OCR_BACKEND=local
OCR_BACKEND=openai
OCR_BACKEND=gemini
OCR_BACKEND=auto
```

`local` は `services/receipt_ocr/` の PaddleOCR を使います。`openai` は `OPENAI_API_KEY`、`gemini` は `GEMINI_API_KEY` が必要です。

### 3. ローカル/Render向けのPaddleOCR

OpenAI APIを使わない実験用に、PaddleOCR版を `services/receipt_ocr/` に分離しています。

```powershell
python -m venv .venv
.\\.venv\\Scripts\\Activate.ps1
pip install -r services/receipt_ocr/requirements.txt
python -m services.receipt_ocr.api
```

起動後は以下にPOSTできます。

```text
POST http://127.0.0.1:4190/ocr
POST http://127.0.0.1:4190/api/ocr-receipt
```

Render Free に載せる場合は、この `services/receipt_ocr` をサービス単位として扱う想定です。ただし PaddleOCR は重いので、無料枠では起動が遅い・スリープ復帰が遅い・メモリ不足になる可能性があります。

Render Blueprintを使う場合は、ルートの `render.yaml` を選べば `wari-receipt-ocr` というWeb Serviceが作られます。手動作成する場合は以下です。

```text
Root Directory: services/receipt_ocr
Build Command: pip install -r requirements.txt
Start Command: python api.py
Health Check Path: /health
Plan: Free
```

## データ構成

```text
projects
members
expenses          # お店での1回の会計
expense_payments  # 実際に払った人と金額
items             # 将来の内訳/品目用
item_members      # 将来の品目ごとの負担者用
project_shares    # 共有リンク
```

現在の精算は、お店の合計金額を参加者全員で均等割りし、`expense_payments` の立替額との差額から「誰が誰にいくら払うか」を計算します。
