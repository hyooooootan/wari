# Wari

スマートフォン向けの軽量な割り勘管理アプリのプロトタイプです。フレームワークや外部画像を使わず、HTML・CSS・JavaScriptだけで動作します。

## 現在できること

- プロジェクトと参加者の管理
- お店（1回の会計）ごとの合計金額の管理
- 1つのお店に複数の支払者と支払額を登録
- 内容・金額・負担者による内訳入力
- 支払い合計／内訳合計と、お店の合計との差額表示
- 円単位の端数配分と精算結果の計算
- 参加者／お店／精算を横スワイプで移動
- 将来のレシートOCR用に `receipt_image_url` を保持

## 起動

静的HTTPサーバーでプロジェクトを配信します。

```powershell
python -m http.server 4181
```

ブラウザで `http://127.0.0.1:4181` を開いてください。データは現在、ブラウザの `localStorage`（`wari-data-v2`）に保存されます。

## データ構造

```text
projects
└ members
└ expenses（お店での1回の会計）
   ├ expense_payments（実際に払った人と金額）
   └ items（内訳）
      └ item_members（負担者）
```

立替額は `expense_payments`、負担額は `items` と `item_members` から計算します。既存の単一支払者データは読み込み時に `expense_payments` へ自動移行されます。

## 今後の3層化

本番化では次の構成を想定しています。

```text
Vanilla TypeScript（フロントエンド）
        ↓ REST API
Hono（入力検証・精算処理）
        ↓ SQL
Cloudflare D1 / SQLite（データベース）
```

現在の `load` / `save` をAPIクライアントへ置き換え、`calculate` をバックエンドへ移す方針です。
