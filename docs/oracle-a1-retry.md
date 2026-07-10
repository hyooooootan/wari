# Oracle Cloud A1 Flex 作成再試行

`scripts/oci_create_a1_retry.py` は、Oracle Cloud Infrastructure の `VM.Standard.A1.Flex` インスタンス作成時に `Out of capacity for shape VM.Standard.A1.Flex` が返る場合、一定間隔で作成を試行する運用補助です。

Wari の OCR 用サーバーとして、次の構成を想定しています。

- Shape: `VM.Standard.A1.Flex`
- OCPU: `1`
- Memory: `6GB`
- Boot volume: `50GB` から `100GB` 程度
- Display name: `wari-ocr-a1`
- Public IPv4: 有効
- OS: Ubuntu 24.04 または Oracle Linux 9
- Fault domain: 指定しない
- Availability domain: JSON 設定ファイルで指定

## 事前準備

OCI Python SDK と OCI API キー設定が必要です。

```powershell
pip install oci
```

OCI SDK は `~/.oci/config` を読み込みます。OCI CLI を設定済みであれば、同じ設定ファイルを使えます。

```powershell
oci setup config
```

`~/.oci/config` には、テナンシー OCID、ユーザー OCID、フィンガープリント、秘密鍵ファイルへのパス、リージョンが含まれます。このファイルや API 秘密鍵の中身は、ログや共有文書へ貼り付けないでください。

## 設定ファイル

サンプルを複製して、実行用の設定ファイルを作成します。

```powershell
Copy-Item scripts/oci_a1_config.example.json scripts/oci_a1_config.json
```

`scripts/oci_a1_config.json` に記入する値は次のとおりです。

- `profile`: `~/.oci/config` のプロファイル名。通常は `DEFAULT`
- `oci_config_file`: OCI 設定ファイルのパス。通常は `~/.oci/config`
- `compartment_id`: インスタンスを作成する Compartment OCID
- `availability_domain`: 作成先の Availability Domain
- `subnet_id`: Public IPv4 を割り当てる Subnet OCID
- `image_id`: Ubuntu 24.04 または Oracle Linux 9 の Image OCID
- `display_name`: `wari-ocr-a1`
- `shape`: `VM.Standard.A1.Flex`
- `ocpus`: `1`
- `memory_gb`: `6`
- `boot_volume_gb`: `50` から `100` 程度
- `ssh_public_key_path`: `.pub` で終わる SSH 公開鍵のパス
- `ssh_private_key_path`: 接続コマンド表示用の SSH 秘密鍵パス。ファイル内容は読み込みません
- `ssh_user`: Ubuntu は `ubuntu`、Oracle Linux は `opc`
- `retry_wait_seconds`: 再試行までの待機秒数。初期値は `300`
- `image_name`: SSH ユーザー名推定の補助値。明示する場合は `ssh_user` が優先されます

## OCID の調べ方

Compartment OCID は、OCI Console の Identity and Security から Compartments を開き、対象 Compartment の詳細で確認します。

Subnet OCID は、Networking の Virtual Cloud Networks から対象 VCN を開き、Subnets の詳細で確認します。Public IPv4 を割り当てるため、インターネットから到達できる経路を持つサブネットを選びます。

Image OCID は、Compute の Custom Images または Oracle 提供イメージの選択画面で確認します。Ubuntu 24.04 を使う場合は Canonical Ubuntu 24.04 の AArch64 対応イメージ、Oracle Linux 9 を使う場合は Oracle Linux 9 の AArch64 対応イメージを選びます。A1 Flex は Arm なので、x86_64 用イメージは使えません。

Availability Domain は、Compute インスタンス作成画面の配置設定で表示される値、または OCI CLI の次のコマンドで確認します。

```powershell
oci iam availability-domain list --compartment-id <tenancy-ocid>
```

## SSH 公開鍵と秘密鍵

`ssh_public_key_path` には `.pub` の公開鍵を指定します。このスクリプトが読み込む鍵は公開鍵です。

秘密鍵はインスタンス作成 API へ送りません。`ssh_private_key_path` は、成功後に表示する `ssh -i ...` の接続例に使います。秘密鍵ファイルの中身は読み込みません。

## 実行

```powershell
python scripts/oci_create_a1_retry.py --config scripts/oci_a1_config.json
```

同じ Display name のインスタンスが既に存在する場合、新規作成せずにインスタンス OCID、Public IP、SSH 接続例を表示して終了します。

容量不足の例外が返った場合は、時刻、OCI エラー内容、次回試行までの待機秒数を表示し、指定秒数待ってから再試行します。初期値は 300 秒です。短時間に API を連打しない前提の待機値にしています。

認証エラー、設定不足、権限不足、Subnet 不正、Image と Shape の不整合など、容量不足ではないエラーでは再試行せず停止します。

Ctrl+C を押すと停止します。既存インスタンスやネットワークの削除は行いません。

## 成功後の表示と保存

作成に成功すると、次の情報を表示します。

- Instance OCID
- Public IP
- SSH ユーザー名
- SSH 接続コマンド

Ubuntu の接続例:

```powershell
ssh -i C:\Users\89bi4\.ssh\wari_oracle_codex ubuntu@<public-ip>
```

Oracle Linux の接続例:

```powershell
ssh -i C:\Users\89bi4\.ssh\wari_oracle_codex opc@<public-ip>
```

成功結果は、実行した場所の `INSTANCE_CREATED.json` に保存されます。

## 安全上の制限

このスクリプトは `VM.Standard.A1.Flex` 以外の Shape を拒否します。GPU、Load Balancer、NAT Gateway、Database などは作成しません。既存インスタンス、既存ネットワーク、既存ボリュームの削除も行いません。

ログには SSH 秘密鍵、OCI API 秘密鍵、`~/.oci/config` の中身を表示しません。

## Wari OCR 環境を入れる流れ

インスタンス作成後、表示された SSH コマンドでログインします。

Ubuntu の例:

```powershell
ssh -i C:\Users\89bi4\.ssh\wari_oracle_codex ubuntu@<public-ip>
```

ログイン後、Git、実行時に使う言語環境、Wari の OCR サービスに必要な依存関係を入れ、アプリケーションを配置します。Wari 側の OCR サービスは `services/receipt_ocr/` を中心に構成されているため、リポジトリ取得後に対象ディレクトリの README に沿って起動設定を行います。

外部公開する場合は、OCI の Security List または Network Security Group で必要なポートを許可し、不要なポートは開けないでください。
