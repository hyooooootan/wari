# Oracle A1 deployment

Assumed layout:

```text
/opt/wari                    # repository root
/opt/wari/services/receipt_ocr
```

The Wari production path uses `OCR_BACKEND=local` with PP-OCR. Install the Python environment first:

```bash
cd /opt/wari/services/receipt_ocr
chmod +x deploy/oracle-a1-setup.sh
APP_DIR=/opt/wari/services/receipt_ocr ./deploy/oracle-a1-setup.sh
```

Install the API service:

```bash
sudo cp /opt/wari/services/receipt_ocr/deploy/wari-receipt-ocr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wari-receipt-ocr
sudo systemctl status wari-receipt-ocr
```

Verify:

```bash
curl http://127.0.0.1:4190/health
curl -i -X POST -F "image=@/path/to/receipt.jpg;type=image/jpeg" http://127.0.0.1:4190/ocr
```

The unauthenticated OCR request must return `401`. Use the protected shared secret through an environment variable for the authenticated check and do not place the value in shell history.

Before replacing code or `/etc/wari/receipt-ocr.env`, create an access-restricted timestamped backup. Keep the three optional features disabled for the first restart:

```text
RECEIPT_OCR_ENABLE_FEEDBACK=false
RECEIPT_OCR_ENABLE_TEXT_CORRECTION=false
RECEIPT_OCR_ENABLE_VISION_REREAD=false
```

Enable feedback, text correction, and local vision rereading separately after the normal OCR path and resource measurements pass. See `docs/receipt-ocr-feedback.md` for the D1 order, official model tags, benchmark command, rollback, and settings.

Security:

- Do not expose Ollama. Keep it bound to `127.0.0.1:11434`.
- Expose only the Python API, preferably behind Caddy, nginx, or Cloudflare Tunnel.
- Do not change the existing Oracle security list or OS firewall for this rollout.
