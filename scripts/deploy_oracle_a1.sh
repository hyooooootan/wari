#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/wari}"
APP_USER="${APP_USER:-ubuntu}"
OCR_SERVICE_NAME="${OCR_SERVICE_NAME:-wari-receipt-ocr}"
OCR_PORT="${OCR_PORT:-4190}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:3b}"
RELEASE_SOURCE="${RELEASE_SOURCE:-/tmp/wari-release}"
ENV_SOURCE="${ENV_SOURCE:-/tmp/wari-ocr.env}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "Application user does not exist: $APP_USER" >&2
  exit 1
fi

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y git curl ca-certificates rsync python3 python3-venv python3-pip \
      tesseract-ocr tesseract-ocr-jpn tesseract-ocr-eng
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y git curl ca-certificates rsync python3 python3-pip \
      tesseract tesseract-langpack-jpn tesseract-langpack-eng
  else
    echo "Unsupported package manager." >&2
    exit 1
  fi
}

install_packages

if [ ! -d "$RELEASE_SOURCE/services/receipt_ocr" ]; then
  echo "Release directory is incomplete: $RELEASE_SOURCE" >&2
  exit 1
fi

mkdir -p "$APP_ROOT"
rsync -a --delete \
  --exclude '.git/' \
  --exclude '.venv/' \
  --exclude 'INSTANCE_CREATED.json' \
  --exclude 'scripts/oci_a1_config.json' \
  "$RELEASE_SOURCE/" "$APP_ROOT/"
chown -R "$APP_USER:$APP_USER" "$APP_ROOT"

python3 -m venv "$APP_ROOT/services/receipt_ocr/.venv"
"$APP_ROOT/services/receipt_ocr/.venv/bin/pip" install --upgrade pip
"$APP_ROOT/services/receipt_ocr/.venv/bin/pip" install -r "$APP_ROOT/services/receipt_ocr/requirements.txt"

if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
systemctl enable --now ollama
ollama pull "$OLLAMA_MODEL"

install -d -m 0750 -o root -g "$APP_USER" /etc/wari
if [ -f "$ENV_SOURCE" ]; then
  install -m 0640 -o root -g "$APP_USER" "$ENV_SOURCE" /etc/wari/receipt-ocr.env
elif [ ! -f /etc/wari/receipt-ocr.env ]; then
  cat > /etc/wari/receipt-ocr.env <<EOF
OCR_BACKEND=tesseract_ollama
OCR_HOST=0.0.0.0
PORT=$OCR_PORT
OCR_CORS_ORIGIN=*
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=$OLLAMA_MODEL
TESSERACT_LANG=jpn+eng
TESSERACT_TIMEOUT=30
TESSERACT_PSM=6
TESSERACT_MAX_SIDE=1800
TESSERACT_THRESHOLD=auto
OMP_THREAD_LIMIT=2
EOF
  chown root:"$APP_USER" /etc/wari/receipt-ocr.env
  chmod 0640 /etc/wari/receipt-ocr.env
fi

cat > "/etc/systemd/system/${OCR_SERVICE_NAME}.service" <<EOF
[Unit]
Description=Wari Receipt OCR API
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_ROOT
EnvironmentFile=/etc/wari/receipt-ocr.env
ExecStart=$APP_ROOT/services/receipt_ocr/.venv/bin/python -m services.receipt_ocr.api
Restart=on-failure
RestartSec=5
User=$APP_USER
Group=$APP_USER
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$APP_ROOT /tmp

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$OCR_SERVICE_NAME"
sleep 5
curl --fail --silent --show-error "http://127.0.0.1:${OCR_PORT}/health"
echo
systemctl --no-pager --full status "$OCR_SERVICE_NAME" | sed -n '1,20p'
