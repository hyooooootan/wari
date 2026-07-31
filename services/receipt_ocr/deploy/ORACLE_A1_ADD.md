# Oracle A1 OCR の配備手順

OCR サービスは Oracle A1 上で `127.0.0.1:4190` に待ち受けます。インターネットから 4190 番や Ollama の 11434 番へ直接接続させず、HTTPS の中継を経由します。

```text
Wari 画面
  -> Cloudflare Pages Functions
  -> HTTPS 公開 URL
  -> Oracle の HTTPS 中継
  -> 127.0.0.1:4190 の OCR サービス
```

## Oracle 上の準備

リポジトリを `/opt/wari` へ配置し、OCR の依存関係を導入します。

```bash
cd /opt/wari/services/receipt_ocr
chmod +x deploy/oracle-a1-setup.sh
APP_DIR=/opt/wari/services/receipt_ocr OLLAMA_MODEL=qwen2.5:3b ./deploy/oracle-a1-setup.sh
```

OCR の認証用秘密値を環境ファイルへ記入します。この値は Cloudflare Pages の `RECEIPT_OCR_SHARED_SECRET` と同じ値にします。

```bash
sudo install -o root -g root -m 0600 /dev/null /etc/wari-receipt-ocr.env
sudoedit /etc/wari-receipt-ocr.env
```

```text
RECEIPT_OCR_SHARED_SECRET=<十分な長さのランダム値>
```

サービスを登録して起動します。

```bash
sudo cp /opt/wari/services/receipt_ocr/deploy/wari-receipt-ocr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wari-receipt-ocr
sudo systemctl status wari-receipt-ocr
```

環境ファイルは `root` 所有、権限 `0600` を保ちます。systemd サービスは `OCR_HOST=127.0.0.1`、`PORT=4190`、`OLLAMA_BASE_URL=http://127.0.0.1:11434` で動作します。

## Oracle 上の確認

準備状態を確認します。`ok` と `tesseract_ollama.ready` がともに `true` であることを確認します。

```bash
curl -fsS http://127.0.0.1:4190/health
```

画像送信には Bearer 認証が必要です。Cloudflare 経由の入力画像は JPEG、PNG、WebP で、復号前 5MB 以下です。

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer <RECEIPT_OCR_SHARED_SECRET>" \
  -F "image=@/path/to/receipt.jpg;type=image/jpeg" \
  http://127.0.0.1:4190/ocr
```

`image_path` によるサーバー内の任意パス読込は通常停止しています。保守用の限定環境で使う際は、`OCR_ALLOW_IMAGE_PATH=true` を明示し、外部公開状態では使いません。

## HTTPS 公開

Cloudflare Tunnel、Caddy、nginx のいずれかで、公開 HTTPS URL を `127.0.0.1:4190` へ中継します。4190 番と 11434 番を OCI のセキュリティ・リスト、NSG、OS のファイアウォールで公開しません。

公開 URL から健康確認が成功することを確認します。

```bash
curl -fsS https://<OCR の公開 HTTPS URL>/health
```

## Cloudflare Pages の設定

Pages の本番環境へ次を設定します。`RECEIPT_OCR_API_URL` は `/ocr` や `/api/ocr-receipt` を含めない HTTPS の基点 URL です。

```text
OCR_BACKEND=tesseract_ollama
RECEIPT_OCR_API_URL=https://<OCR の公開 HTTPS URL>
RECEIPT_OCR_SHARED_SECRET=<Oracle の環境ファイルと同じ値>
```

Cloudflare 側のコードを配備した後、次の経路で中継の状態を確認します。接続先 URL や秘密値は応答に含まれません。

```bash
curl -fsS https://<Wari の公開 URL>/api/ocr-health
```

応答の状態は次のとおりです。

| HTTP 状態 | `error` | 状態 |
| --- | --- | --- |
| 200 | なし | Oracle OCR は到達可能で準備済み |
| 503 | `missing_receipt_ocr_api_url` | Pages の接続先 URL が未設定または不正 |
| 502 | `ocr_upstream_unavailable` | Oracle の公開 URL へ接続できない |
| 503 | `remote_ocr_not_ready` | Oracle の OCR 依存関係が未準備 |

画面から画像を送信し、OCR 結果に店名、合計、日付が表示されることまで確認して配備を終えます。
