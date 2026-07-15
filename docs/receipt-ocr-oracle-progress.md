# Wari Receipt OCR Oracle A1 Progress

## 2026-07-15 訂正学習版

現在の運用対象は`OCR_BACKEND=local`のPP-OCR経路です。TesseractとOllamaで全文を整形する構成は過去の検討経路として残っています。新しい構成ではPP-OCRと規則処理を通常経路にし、D1の利用者別訂正候補、`qwen2.5:1.5b-instruct`による文字訂正、`qwen3-vl:2b`による局所再読取を停止可能な補助処理として追加しました。

実装済み:

- D1移行`0010_receipt_ocr_feedback.sql`
- D1移行`0011_receipt_ocr_feedback_pending.sql`と未送信訂正の再処理
- D1移行`0012_receipt_ocr_feedback_conflicts.sql`と異なる再送内容の競合拒否
- HMAC署名付き訂正登録、本人件数取得、本人全削除
- 新規取引作成と既存取引紐付けの成功後に訂正を登録
- 店名候補の保守的採用、競合時の確認維持
- 前処理方式とOCRモデルごとの成績集計
- 数字と日時を過去訂正や文字訂正LLMで直接置換しない検査
- ポイント、残高、単価、電話番号、期限日付を優先項目から除外する検査
- Ollama接続先をA1内部のループバックアドレスへ制限する検査
- 最大1回の文字訂正LLM、最大3領域・1並列の局所VLM
- OCRサービス全体55秒の処理予算
- A・B・C・D比較用の個人情報を出力しない評価器

未実施:

- 本番D1への0010から0012適用
- 同時要求数2の測定
- 本番Pagesの機能設定変更

コミット`08836b4`をA1へ反映し、反映前のコード、systemd設定、環境設定を退避しました。A1は2 OCPU、約11 GiBのメモリーです。Ollama 0.32.0を導入し、`qwen2.5:1.5b-instruct`と`qwen3-vl:2b`を取得しました。Python試験55件、構文検査、読込み検査、サービス再起動、`/health`、認証なし401、認証付きOCRを確認済みです。

配備、D1、環境変数、停止、復旧の現行手順は`docs/receipt-ocr-feedback.md`を正とします。

## 目的

Wariのレシート読み取りを、Oracle Cloud A1上で動く `Tesseract + Ollama` 構成へ移す。

この構成では、レシート画像をPython APIが受け取り、Tesseractで文字列を抽出し、OllamaでWari用JSONへ整形する。Wari本体は読み取り結果をDBへ直接保存せず、画面上の候補として表示し、利用者が修正してから保存する。

## 到達点

### OCRサービス

`services/receipt_ocr/api.py` に `OCR_BACKEND=tesseract_ollama` を追加した。

利用できる入口は既存と同じ。

```text
GET  /health
POST /ocr
POST /api/ocr-receipt
```

Cloudflare Pages Functions 側の `/api/ocr-receipt` は `project_id` を受け取り、そのプロジェクトへの編集権限を持つログイン済みセッション、または編集権限の共有トークンを確認してから OCR に転送する。

`services/receipt_ocr/tesseract_ollama.py` を追加し、次の処理を行う。

```text
1. 画像を一時ファイルとして受ける
2. EXIF向き補正
3. グレースケール化
4. コントラスト調整
5. しきい値処理
6. Tesseractで全文OCR
7. TesseractでTSV OCR
8. TSVから行・単語・信頼度を抽出
9. OCR結果をOllamaへ渡す
10. Ollama返答からJSONを抽出
11. Python側で型、金額、日時、品目、警告を検査
12. Wari用の統一形式で返す
```

返却形式は以下。

```json
{
  "store_name": null,
  "purchased_at": null,
  "total_amount": null,
  "items": [
    {
      "name": null,
      "amount": null,
      "quantity": null,
      "confidence": null
    }
  ],
  "warnings": []
}
```

既存画面との互換用に、`paid_at`、`paid_time`、`confidence`、`notes` も返す。

### Ollamaへの指示

Ollamaには、日本のレシートOCR文字列からJSONを作るよう指示している。

入れている制約は次の通り。

```text
存在しない商品を推測で追加しない
読めない項目はnullにする
金額は数値にする
商品名と金額の対応が不明な場合はwarningsへ入れる
合計金額と明細合計が合わない場合はwarningsへ入れる
JSON以外の文章を返さない
```

Ollamaの返答がJSONとして壊れている場合は、Python側でJSON部分の抽出を試す。復元できない場合は、空の品目と警告を返す。

### Oracle A1配備物

Oracle A1用に以下を追加した。

```text
services/receipt_ocr/deploy/oracle-a1-setup.sh
services/receipt_ocr/deploy/wari-receipt-ocr.service
services/receipt_ocr/deploy/README.md
services/receipt_ocr/deploy/ORACLE_A1_ADD.md
services/receipt_ocr/.env.example
services/receipt_ocr/check_env.py
```

`oracle-a1-setup.sh` が扱う内容。

```text
python3
python3-venv
python3-pip
tesseract-ocr
tesseract-ocr-jpn
tesseract-ocr-eng
curl
Ollama
qwen2.5:3b
Python仮想環境
Pillow
```

`wari-receipt-ocr.service` は `systemd` 用の常駐設定。Ollamaは `http://127.0.0.1:11434` を使い、外部公開しない。

### Wari本体との接続

Wari画面は従来通り、相対パスの `/api/ocr-receipt` へ画像を送る。

```text
public/app.js
  -> POST /api/ocr-receipt
functions/api/[[path]].js
  -> Oracle A1上の receipt_ocr API
```

`functions/api/[[path]].js` に、Oracle OCRへ転送する経路を追加した。

Cloudflare Pages側で以下を設定すると、Wari画面からOracle A1上のOCRへ流れる。

```text
OCR_BACKEND=tesseract_ollama
RECEIPT_OCR_API_URL=https://<Oracle OCR APIの公開URL>
RECEIPT_OCR_SHARED_SECRET=<CloudflareとOracleへ同じ秘密値を登録>
OCR_TIMEOUT_MS=60000
```

`RECEIPT_OCR_API_URL` には `/api/ocr-receipt` を含めない。

## Oracle A1で実行する手順

リポジトリを `/opt/wari` に置く。

```bash
cd /opt/wari/services/receipt_ocr
chmod +x deploy/oracle-a1-setup.sh
APP_DIR=/opt/wari/services/receipt_ocr OLLAMA_MODEL=qwen2.5:3b ./deploy/oracle-a1-setup.sh
```

常駐登録。

```bash
sudo cp /opt/wari/services/receipt_ocr/deploy/wari-receipt-ocr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wari-receipt-ocr
sudo systemctl status wari-receipt-ocr
```

健全性確認。

```bash
curl http://127.0.0.1:4190/health
```

期待する状態。

```text
tesseract.available=true
tesseract.configured_langs_available=true
ollama.available=true
```

画像読み取り確認。

```bash
curl -X POST \
  -F "image=@/path/to/receipt.jpg;type=image/jpeg" \
  http://127.0.0.1:4190/ocr
```

## 検査済み

手元環境とOracle A1で以下を確認した。

```text
Python構文検査: 成功
Cloudflare Functions JavaScript構文検査: 成功
JavaScript試験: 138件成功
A1上のPython試験: 55件成功
OCRモジュール読込み: 成功
外部サービス停止、不正JSON、時間切れ、呼出回数、一時画像削除の検査: 成功
合計、日付、時刻をLLM出力単独で確定しない検査: 成功
```

A1上では`/health`が200、認証なしOCRが401、認証付きOCRが200でした。OCRサービスとOllamaはループバックアドレスで稼働し、外部待受、Oracle受信規則、OS防火壁は変更していません。

## 今回の配備前検査

現在の処理経路をコードから確認した。

```text
public/app.js
  -> POST /api/ocr-receipt
functions/api/[[path]].js
  -> project_idの形式、ログイン利用者の編集権限、共有編集権限、CSRF、Origin、POSTを検査
functions/lib/ocr.js
  -> 画像形式、Base64、容量、上流URL、処理時間を検査
  -> RECEIPT_OCR_API_URL/api/ocr-receiptへJSON転送
services/receipt_ocr/api.py
  -> JSON、multipart、画像本体を受信
  -> 一時画像を作成して処理後に削除
services/receipt_ocr/tesseract_ollama.py
  -> Pillow前処理、Tesseract全文・TSV、Ollama JSON整形、型・金額・日時・警告の正規化
```

Cloudflare側の上流エラーは、HTTPエラーを`remote_ocr_error`、壊れたJSONを`invalid_remote_ocr_response`、接続失敗を`ocr_upstream_unavailable`、時間切れを`ocr_timeout`へ変換する。OCR結果はこの経路ではDBへ保存されず、既存画面の確認候補として返される。

`services/receipt_ocr/check_env.py` は次の形式に対応した。

```bash
python -m services.receipt_ocr.check_env
python -m services.receipt_ocr.check_env --json
```

Python版、Pillow、Tesseract実行ファイル、`jpn`・`eng`言語、Ollama接続、指定モデル、一時ファイルの作成・削除、`/health`応答の構造を検査する。終了符号は、0が使用可能、1が未使用可能な実行要件あり、2が検査自体の異常を表す。Ollamaの既定時間は20秒で、Cloudflare側の既定25秒を超えない設定にした。

今回の模擬試験では、正常・壊れたBase64・未対応形式・空OCR・Tesseract異常終了と時間切れ・Ollama接続失敗と壊れたJSON・JSON前後の文章・明細合計不一致・一時ファイル削除・返却項目を確認した。

## Oracle A1で残る実機確認

Oracle A1上の配備、稼働、認証確認、AからDの実画像集計は完了しました。AからDは非公開画像12枚を各3回処理し、全条件で誤った自動確定0件、`needs_review`36/36でした。Bは店名正答を3/36から9/36へ改善しました。CとDは正答数を増やさず、Dの平均処理時間は54.4秒でした。残る確認は同時要求測定です。

```bash
python --version
python -m services.receipt_ocr.check_env --json
curl -fsS http://127.0.0.1:4190/health
systemctl is-active wari-receipt-ocr
curl -fsS -X POST -F "image=@/path/to/receipt.jpg;type=image/jpeg" http://127.0.0.1:4190/ocr
```

`check_env.py`でTesseractの`jpn`・`eng`、Ollamaの指定モデル、作業用一時領域、`/health`の各状態が使用可能になることを確認する。実レシートでは店名、購入日、合計、品目、明細合計不一致時の警告を確認する。

## Cloudflare側に残る設定

本番Pagesには次を設定し、値は記録や文書へ保存しない。

```text
OCR_BACKEND=tesseract_ollama
RECEIPT_OCR_API_URL=https://<Oracle OCR APIの公開URL>
RECEIPT_OCR_SHARED_SECRET=<Cloudflareと同じ秘密値>
OCR_TIMEOUT_MS=60000
OCR_MAX_IMAGE_BYTES=実機とCloudflareの許容量に合わせた値
```

Cloudflare Pagesでは`RECEIPT_OCR_SHARED_SECRET`をSecretとして登録し、Oracleではサービスの環境ファイルまたはsystemdの環境設定へ同じ値を登録する。値はログ、Git、文書へ保存しない。Oracle側は`POST /ocr`と`POST /api/ocr-receipt`のBearer認証を検査し、秘密値未設定は503、不正な要求は401で拒否する。Ollamaは引き続き`127.0.0.1:11434`へ限定し、公開しない。

Cloudflareの設定例:

```bash
npx wrangler pages secret put RECEIPT_OCR_SHARED_SECRET --project-name wari
```

Oracle側では秘密値を対話入力または保護された環境ファイルから設定し、`systemctl restart wari-receipt-ocr`後に認証付き`POST`を確認する。秘密値をコマンド引数へ直接書かない。

時間制限は、Tesseract 20秒、Ollama 25秒、CloudflareからOracleまでの総時間60秒を初期値とする。実機で画像前処理・Tesseract・Ollama・通信を測定し、60秒以内に収まらない場合は配備を止めて値を再調整する。

## 残作業

```text
A1で同時要求数2の測定
Oracle OCR APIのHTTPS公開
Cloudflare Pages環境変数の設定
Wari画面から読み取り確認
本番D1移行の実施判断
```

## A1作成後の自動導入

`scripts/oracle_a1_bootstrap_wari_ocr.sh` を追加した。このファイルはA1インスタンス作成時のcloud-init `user_data` として渡す。

実行内容は次の通り。

```text
git
curl
Python
Tesseract日本語・英語
Ollama
qwen2.5:3b
Wari repository
services/receipt_ocr Python environment
wari-receipt-ocr systemd service
```

作成スクリプト側では `scripts/oci_create_a1_retry.py` が `cloud_init_script_path` を読み、Base64化してOCIの `user_data` へ渡す。

設定例。

```json
{
  "cloud_init_script_path": "scripts/oracle_a1_bootstrap_wari_ocr.sh"
}
```

A1作成に成功した後、A1側で確認するコマンド。

```bash
sudo cloud-init status --long
sudo tail -n 200 /var/log/wari-ocr-bootstrap.log
cat /opt/wari-ocr-bootstrap-status.txt
systemctl status wari-receipt-ocr
curl http://127.0.0.1:4190/health
```

## 判断

Oracle A1への反映、Python試験、サービス疎通、認証確認、補助モデルの導入、実画像評価まで完了した。本番統合と本番D1移行は行っていない。実画像評価ではBが店名精度を改善し、CとDは精度を増やさなかったため、現在はCとDを無効の状態で維持する。
