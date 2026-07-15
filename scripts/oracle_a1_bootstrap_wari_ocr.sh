#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="/var/log/wari-ocr-bootstrap.log"
exec > >(tee -a "$LOG_FILE") 2>&1

export DEBIAN_FRONTEND=noninteractive

APP_ROOT="${APP_ROOT:-/opt/wari}"
REPO_URL="${REPO_URL:-https://github.com/hyooooootan/wari.git}"
REPO_BRANCH="${REPO_BRANCH:-codex/mobile-split-prototype}"
OCR_SERVICE_NAME="${OCR_SERVICE_NAME:-wari-receipt-ocr}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:3b}"
APP_USER="${APP_USER:-ubuntu}"

echo "[$(date -Is)] Wari OCR bootstrap started"

if ! id "$APP_USER" >/dev/null 2>&1; then
  APP_USER="opc"
fi
if ! id "$APP_USER" >/dev/null 2>&1; then
  APP_USER="root"
fi

echo "[$(date -Is)] Installing base packages"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y git curl ca-certificates python3 python3-venv python3-pip tesseract-ocr tesseract-ocr-jpn tesseract-ocr-eng
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y git curl ca-certificates python3 python3-pip tesseract tesseract-langpack-jpn tesseract-langpack-eng
else
  echo "Unsupported package manager"
  exit 1
fi

echo "[$(date -Is)] Fetching repository"
if [ -d "$APP_ROOT/.git" ]; then
  git -C "$APP_ROOT" fetch origin "$REPO_BRANCH"
  git -C "$APP_ROOT" checkout "$REPO_BRANCH"
  git -C "$APP_ROOT" reset --hard "origin/$REPO_BRANCH"
else
  rm -rf "$APP_ROOT"
  git clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "$APP_ROOT"
fi
chown -R "$APP_USER:$APP_USER" "$APP_ROOT" || true

echo "[$(date -Is)] Preparing receipt OCR Python environment"
cd "$APP_ROOT/services/receipt_ocr"
python3 -m venv .venv
. .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "[$(date -Is)] Installing Ollama"
if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
systemctl enable --now ollama || true

echo "[$(date -Is)] Pulling Ollama model: $OLLAMA_MODEL"
ollama pull "$OLLAMA_MODEL"

echo "[$(date -Is)] Installing OCR systemd service"
SERVICE_FILE="/etc/systemd/system/${OCR_SERVICE_NAME}.service"
cp "$APP_ROOT/services/receipt_ocr/deploy/wari-receipt-ocr.service" "$SERVICE_FILE"
sed -i "s#WorkingDirectory=/opt/wari#WorkingDirectory=${APP_ROOT}#g" "$SERVICE_FILE"
sed -i "s#ExecStart=/opt/wari/services/receipt_ocr/.venv/bin/python#ExecStart=${APP_ROOT}/services/receipt_ocr/.venv/bin/python#g" "$SERVICE_FILE"
sed -i "s#User=opc#User=${APP_USER}#g" "$SERVICE_FILE"
sed -i "s#Group=opc#Group=${APP_USER}#g" "$SERVICE_FILE"
if ! grep -q "TESSERACT_PSM" "$SERVICE_FILE"; then
  sed -i "/Environment=TESSERACT_TIMEOUT=/a Environment=TESSERACT_PSM=6" "$SERVICE_FILE"
fi
if ! grep -q "TESSERACT_THRESHOLD" "$SERVICE_FILE"; then
  sed -i "/Environment=TESSERACT_MAX_SIDE=/a Environment=TESSERACT_THRESHOLD=auto" "$SERVICE_FILE"
fi

systemctl daemon-reload
systemctl enable --now "$OCR_SERVICE_NAME"

echo "[$(date -Is)] Verifying OCR service"
sleep 5
curl -fsS http://127.0.0.1:4190/health || true
tesseract --list-langs || true
ollama list || true

cat > /opt/wari-ocr-bootstrap-status.txt <<STATUS
completed_at=$(date -Is)
app_root=$APP_ROOT
repo_branch=$REPO_BRANCH
ocr_service=$OCR_SERVICE_NAME
ollama_model=$OLLAMA_MODEL
log=$LOG_FILE
STATUS

echo "[$(date -Is)] Wari OCR bootstrap finished"
