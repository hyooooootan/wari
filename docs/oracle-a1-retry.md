# Oracle Cloud A1 Flex 作成再試行

`scripts/oci_create_a1_retry.py` は、Oracle Cloud Infrastructure の A1 作成で在庫不足が返ったときに、指定秒数ごとに作成を試す実行コードです。

Wari の OCR サーバー向けに、次の構成を既定値にしています。

- シェイプ: `VM.Standard.A1.Flex`
- OCPU: `2`
- メモリー: `12 GB`
- 起動ボリューム: `50 GB`
- 地域: OCI のホーム・リージョン
- 区画: `always-free-a1`
- OS: Ubuntu または Oracle Linux の Arm 版
- 表示名: `wari-ocr-a1`
- 公開 IPv4: 有効
- 待機間隔: `60` 秒以上

Pay-As-You-Go への切替は OCI 画面で行います。この実行コードは OCI の課金方式を変更せず、Compute インスタンス作成 API を呼び出します。

## 事前準備

OCI Python SDK と OCI API 鍵設定が必要です。

```powershell
pip install oci
oci setup config
```

`~/.oci/config` には、テナンシ OCID、利用者 OCID、フィンガープリント、秘密鍵ファイルへのパス、リージョンが入ります。`~/.oci/config` と API 秘密鍵の中身は GitHub や公開文書へ載せないでください。

## 設定ファイル

例示設定を複製して、実行用の設定ファイルを作ります。

```powershell
Copy-Item scripts/oci_a1_config.example.json scripts/oci_a1_config.json
```

`scripts/oci_a1_config.json` に入れる値は次の通りです。

- `profile`: `~/.oci/config` のプロファイル名。通常は `DEFAULT`
- `oci_config_file`: OCI 設定ファイルのパス。通常は `~/.oci/config`
- `region`: `home` を指定すると、OCI API からホーム・リージョンを取得して使います
- `compartment_name`: 作成先の区画名。既定値は `always-free-a1`
- `compartment_id`: 区画 OCID。空文字の場合は `compartment_name` で検索します
- `availability_domain`: 作成先の可用性ドメイン
- `subnet_id`: 公開 IPv4 を割り当てられるサブネット OCID
- `image_id`: Ubuntu または Oracle Linux の Arm 版イメージ OCID
- `display_name`: 既定値は `wari-ocr-a1`
- `shape`: `VM.Standard.A1.Flex`
- `ocpus`: `2` 以下
- `memory_gb`: `12` 以下
- `boot_volume_gb`: `50`
- `assign_public_ip`: `true` にすると公開 IPv4 を割り当てます
- `ssh_public_key_path`: `.pub` で終わる SSH 公開鍵のパス
- `ssh_private_key_path`: 成功後に表示する SSH 接続例に使う秘密鍵パス。ファイル内容は読みません
- `cloud_init_script_path`: 作成時に渡す cloud-init 用のシェルファイル
- `ssh_user`: Ubuntu は `ubuntu`、Oracle Linux は `opc`
- `retry_wait_seconds`: 再試行までの待機秒数。`60` 以上
- `require_home_region`: `true` の場合、ホーム・リージョン以外を拒否します
- `allow_unverified_arm_image`: `false` の場合、Arm 版らしい文字列がイメージ名から読めないと停止します
- `image_name`: SSH 利用者名の推測や人間向け表示に使う補助値

## OCID の確認場所

区画は OCI Console の Identity and Security から Compartments を開き、`always-free-a1` を作成または確認します。`compartment_id` を空文字にすると、この実行コードが `always-free-a1` を検索します。

Subnet OCID は、Networking の Virtual Cloud Networks から対象 VCN を開き、Subnets の詳細で確認します。公開 IPv4 を使う場合は、Internet Gateway へ到達できる経路を持つサブネットを選びます。

Image OCID は、Compute のイメージ選択画面で確認します。Ubuntu 24.04 を使う場合は Canonical Ubuntu 24.04 の AArch64 対応イメージ、Oracle Linux を使う場合は Oracle Linux の AArch64 対応イメージを選びます。A1 Flex は Arm なので、x86_64 用イメージは使えません。

可用性ドメインは OCI CLI でも確認できます。

```powershell
oci iam availability-domain list --compartment-id <tenancy-ocid>
```

## 起動前検査

実行前に次を検査します。

- シェイプが `VM.Standard.A1.Flex`
- OCPU が `2` 以下
- メモリーが `12 GB` 以下
- 起動ボリュームが `50 GB`
- リージョンがホーム・リージョン
- 区画名が解決できる
- OS イメージが Ubuntu または Oracle Linux
- OS イメージ名に `aarch64`、`arm64`、`arm` のいずれかが含まれる
- 同じ表示名の稼働中インスタンスがある場合、シェイプ、OCPU、メモリーが設定と一致する

## 実行

```powershell
python scripts/oci_create_a1_retry.py --config scripts/oci_a1_config.json
```

在庫不足の例外が返った場合は、時刻、OCI エラー内容、次回試行までの秒数を表示して待機します。認証エラー、設定不足、権限不足、サブネット不整合、イメージとシェイプの不整合など、在庫不足ではないエラーでは停止します。

Ctrl+C を押すと停止します。作成済みのインスタンスやネットワーク資源の削除は行いません。

## 成功後の表示

作成に成功すると、次の情報を表示し、実行した場所の `INSTANCE_CREATED.json` に保存します。

- Instance OCID
- Region
- Compartment OCID
- Shape
- OCPU
- Memory GB
- Boot volume GB
- Public IP
- SSH user
- SSH command

Ubuntu の接続例:

```powershell
ssh -i ~/.ssh/wari_oracle_codex ubuntu@<public-ip>
```

Oracle Linux の接続例:

```powershell
ssh -i ~/.ssh/wari_oracle_codex opc@<public-ip>
```

## OCR 自動導入

`scripts/oci_a1_config.json` の `cloud_init_script_path` に次を指定すると、A1 作成後に OCR サーバー導入を自動実行します。

```json
{
  "cloud_init_script_path": "scripts/oracle_a1_bootstrap_wari_ocr.sh"
}
```

導入後、A1 側で次を確認します。

```bash
sudo cloud-init status --long
sudo tail -n 200 /var/log/wari-ocr-bootstrap.log
cat /opt/wari-ocr-bootstrap-status.txt
systemctl status wari-receipt-ocr
curl http://127.0.0.1:4190/health
```

Ollama は `127.0.0.1:11434` で使います。外部へ公開する対象は Python OCR API 側です。

## 常時再試行サービス

既存の小型インスタンス上で A1 作成を待つ場合は、次の構成で常駐させます。

```text
/opt/wari-a1-retry/
├─ .env
├─ .oci/config
├─ .venv/
├─ oci_a1_config.json
├─ oci_create_a1_retry.py
├─ oracle_a1_bootstrap_wari_ocr.sh
└─ run_a1_retry_with_discord.py
```

GitHub で管理する対応ファイルは次です。

```text
scripts/oci_create_a1_retry.py
scripts/run_a1_retry_with_discord.py
scripts/wari-a1-retry.service.example
scripts/oci_a1_config.example.json
```

配置時はリポジトリから必要なファイルを `/opt/wari-a1-retry` 直下へ置きます。

```bash
sudo mkdir -p /opt/wari-a1-retry
sudo cp scripts/oci_create_a1_retry.py /opt/wari-a1-retry/
sudo cp scripts/run_a1_retry_with_discord.py /opt/wari-a1-retry/
sudo cp scripts/wari-a1-retry.service.example /opt/wari-a1-retry/
sudo cp scripts/oracle_a1_bootstrap_wari_ocr.sh /opt/wari-a1-retry/
sudo cp scripts/oci_a1_config.example.json /opt/wari-a1-retry/oci_a1_config.json
sudo chown -R ubuntu:ubuntu /opt/wari-a1-retry
```

`.env` には Discord 通知先を入れます。Webhook は GitHub へ保存しません。

```bash
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
WARI_A1_RETRY_DIR=/opt/wari-a1-retry
WARI_A1_RETRY_CONFIG=/opt/wari-a1-retry/oci_a1_config.json
```

`/opt/wari-a1-retry/oci_a1_config.json` では、OCI 設定ファイルを次のように指定します。

```json
{
  "oci_config_file": "/opt/wari-a1-retry/.oci/config",
  "cloud_init_script_path": "/opt/wari-a1-retry/oracle_a1_bootstrap_wari_ocr.sh"
}
```

サービス登録例です。

```bash
sudo cp /opt/wari-a1-retry/wari-a1-retry.service.example /etc/systemd/system/wari-a1-retry.service
sudo systemctl daemon-reload
sudo systemctl enable --now wari-a1-retry.service
```

状態確認です。

```bash
systemctl status wari-a1-retry.service
journalctl -u wari-a1-retry.service -n 80 --no-pager
```

## 課金と制限

この実行コードは、Load Balancer、NAT Gateway、Database、File Storage、追加ブロック・ボリュームを作りません。作成する対象は指定した A1 Compute インスタンスと、付属の起動ボリュームです。

Pay-As-You-Go では Always Free 枠を超えた資源に課金が発生します。OCI 側の予算通知や区画の割当て制限は、OCI Console または Terraform などで別途設定してください。
