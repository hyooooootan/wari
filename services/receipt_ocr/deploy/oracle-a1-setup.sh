#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/wari/services/receipt_ocr}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:3b}"

echo "[1/6] Installing OS packages"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y python3 python3-venv python3-pip tesseract-ocr tesseract-ocr-jpn tesseract-ocr-eng curl
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y python3 python3-pip tesseract tesseract-langpack-jpn tesseract-langpack-eng curl
else
  echo "Unsupported package manager. Install python3, tesseract, jpn/eng traineddata, and curl manually." >&2
  exit 1
fi

echo "[2/6] Creating Python venv"
cd "$APP_DIR"
"$PYTHON_BIN" -m venv .venv
. .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "[3/6] Installing Ollama if missing"
if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
fi

echo "[4/6] Ensuring Ollama service is running"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl enable --now ollama || true
fi

echo "[5/6] Pulling model: ${OLLAMA_MODEL}"
ollama pull "$OLLAMA_MODEL"

echo "[6/6] Verifying dependencies"
tesseract --version
tesseract --list-langs
ollama list

echo "Done. Copy deploy/wari-receipt-ocr.service to /etc/systemd/system/ after adjusting paths."
