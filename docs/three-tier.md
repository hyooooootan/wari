# Wari 三層構造

公開前の構成は、画面、処理、保存先を分けて扱います。

```text
public/
  ↓ fetch
functions/api/[[path]].js
  ↓ SQL
Cloudflare D1
```

## 1. 画面

配置:

```text
public/index.html
public/app.js
public/styles.css
```

役割:

- プロジェクト一覧と詳細の表示
- 参加者、お店、支払いの入力
- 精算結果の表示
- `/api/...` への保存と読み込み要求

Cloudflare Pages Functions が使える環境では API へ保存します。静的サーバーで確認する場合は、ブラウザー内の `localStorage` を使います。

## 2. 処理

配置:

```text
functions/api/[[path]].js
```

役割:

- プロジェクト一覧取得
- プロジェクト保存
- プロジェクト削除
- 共有リンク作成
- 共有リンク読み込み
- Gemini / OpenAI OCR 中継
- D1 への SQL 実行

API:

```text
GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
PUT    /api/projects/:projectId
DELETE /api/projects/:projectId
POST   /api/projects/:projectId/share
GET    /api/share/:token
POST   /api/ocr-receipt
```

## 3. 保存先

配置:

```text
db/schema.sql
```

Cloudflare D1 に作る表:

```text
projects
members
expenses
expense_payments
items
item_members
project_shares
```

`expenses` はお店での会計、`expense_payments` は実際に支払った人と金額を持ちます。`items` と `item_members` は、将来の品目入力やレシート内訳に備えて残しています。

## 公開前の確認手順

```text
1. D1 をローカルに作る
2. schema.sql を流す
3. Wrangler で Pages Functions を起動する
4. 画面から保存と読み込みを確認する
5. Gemini OCR の環境変数を入れて読み取りを確認する
6. 問題がなければ Cloudflare へ公開する
```

## ローカルで三層構造を確認する

```powershell
npm install
npm run db:local
npm run dev:cloudflare
```

開く先:

```text
http://127.0.0.1:8788
```

この起動では、画面、API、D1 を同じ Cloudflare 開発環境で確認します。

## 画面確認用の軽い起動

```powershell
npm run dev:static
```

開く先:

```text
http://127.0.0.1:4181
```

この起動は画面確認向けです。保存は主にブラウザー内の `localStorage` を使います。
