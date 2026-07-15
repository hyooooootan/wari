# Oracle A1 deployment

Assumed layout:

```text
/opt/wari                    # repository root
/opt/wari/services/receipt_ocr
```

Run:

```bash
cd /opt/wari/services/receipt_ocr
chmod +x deploy/oracle-a1-setup.sh
APP_DIR=/opt/wari/services/receipt_ocr OLLAMA_MODEL=qwen2.5:3b ./deploy/oracle-a1-setup.sh
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
curl -X POST -F "image=@/path/to/receipt.jpg;type=image/jpeg" http://127.0.0.1:4190/ocr
```

Security:

- Do not expose Ollama. Keep it bound to `127.0.0.1:11434`.
- Expose only the Python API, preferably behind Caddy, nginx, or Cloudflare Tunnel.
- Restrict inbound ports at the Oracle security list and OS firewall.
