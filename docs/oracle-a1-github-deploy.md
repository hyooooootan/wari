# Oracle A1へのGitHub Actions配置

この構成は、GitHub Actionsの手動実行からOracle Cloud A1へ接続し、リポジトリの内容を転送してレシートOCRサービスを再起動する。

Pay-As-You-Goへの変更、A1インスタンスの作成、OCI側の課金防止設定は自動では行わない。既存インスタンスへのアプリケーション配置を扱う。

## 前提

- A1インスタンスが起動している
- SSH接続できる
- 接続利用者がパスワードなしで`sudo`を実行できる
- 4190番への受信をOCIのセキュリティ・リストまたはネットワーク・セキュリティ・グループで許可している
- GitHubリポジトリのEnvironmentとして`oracle-a1`を作成している

公開範囲を狭める場合は、4190番の接続元CIDRをCloudflare側や管理端末のアドレスへ制限する。OCR APIをインターネットへ直接公開する構成では、認証や逆代理を追加する。

## GitHub EnvironmentとSecrets

GitHubのリポジトリ設定で、`Settings`、`Environments`、`New environment`の順に進み、`oracle-a1`を作成する。

登録するSecrets:

| 名前 | 内容 |
|---|---|
| `OCI_HOST` | A1の公開IPまたはホスト名 |
| `OCI_USER` | SSH利用者。Ubuntuなら通常`ubuntu` |
| `OCI_SSH_PRIVATE_KEY` | A1へ接続できる秘密鍵の全文 |
| `OCR_ENV_FILE` | `/etc/wari/receipt-ocr.env`として配置する環境設定。省略可能 |

`OCI_SSH_PRIVATE_KEY`と`OCR_ENV_FILE`をリポジトリ内へ保存しない。

Environmentには承認者を設定できる。配置前の確認を入れる場合は、`oracle-a1`のProtection rulesでRequired reviewersを設定する。

## OCR_ENV_FILEの例

```dotenv
OCR_BACKEND=tesseract_ollama
OCR_HOST=0.0.0.0
PORT=4190
OCR_CORS_ORIGIN=https://あなたのCloudflare-Pagesのドメイン
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:3b
TESSERACT_LANG=jpn+eng
TESSERACT_TIMEOUT=30
TESSERACT_PSM=6
TESSERACT_MAX_SIDE=1800
TESSERACT_THRESHOLD=auto
OMP_THREAD_LIMIT=2
```

`OCR_CORS_ORIGIN=*`は動作確認には使えるが、公開運用ではCloudflare Pagesのドメインへ変更する。

## 実行方法

1. GitHubの`Actions`を開く。
2. `Deploy OCR to Oracle A1`を選ぶ。
3. `Run workflow`を開く。
4. 確認欄へ`DEPLOY`と入力する。
5. 実行するブランチを選び、開始する。

通常のpushではOCIへの配置は行われない。同じEnvironmentへの実行は並列化されず、先行する配置の終了後に続行する。

## 配置処理

1. GitHub Actionsがリポジトリを取得する。
2. `.git`、`.github`、仮想環境、ローカルOCI設定を除外して圧縮する。
3. SSHでA1の`/tmp`へ転送する。
4. A1側で`/opt/wari`へ同期する。
5. Python仮想環境と依存関係を更新する。
6. Tesseract、Ollama、`qwen2.5:3b`を準備する。
7. `/etc/wari/receipt-ocr.env`を設定する。
8. `wari-receipt-ocr.service`を再作成して起動する。
9. A1内部と公開4190番の`/health`を確認する。

非公開リポジトリをA1側から取得しないため、A1へGitHubの個人アクセストークンや配置鍵を置く必要はない。

## A1上での確認

```bash
sudo systemctl status wari-receipt-ocr
sudo journalctl -u wari-receipt-ocr -n 200 --no-pager
curl http://127.0.0.1:4190/health
sudo cat /etc/wari/receipt-ocr.env
```

秘密情報を環境設定へ含めた場合、`cat`の実行結果を共有しない。

## 更新に失敗した場合

GitHub ActionsのSSH工程が失敗する場合は、公開IP、利用者名、秘密鍵、22番の受信規則を確認する。

A1内部の正常性確認が失敗する場合:

```bash
sudo systemctl status ollama
sudo systemctl status wari-receipt-ocr
sudo journalctl -u ollama -n 100 --no-pager
sudo journalctl -u wari-receipt-ocr -n 200 --no-pager
ollama list
```

公開正常性確認が失敗し、A1内部では成功する場合は、OCIの受信規則またはUbuntuの防火壁を確認する。

## 課金との関係

この配置処理は、新しいOCIインスタンス、保存領域、負荷分散装置、データベースを作成しない。既存A1へファイルを転送する。

Pay-As-You-Goでは、Always Freeの対象外資源や無料量を超えた利用に料金が発生する。OCI側でA1のOCPU、メモリー、ブロック・ボリュームの割当て上限と予算通知を別途設定する。
