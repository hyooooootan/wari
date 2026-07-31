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
sudo install -o root -g root -m 0600 /dev/null /etc/wari-receipt-ocr.env
sudoedit /etc/wari-receipt-ocr.env
sudo cp /opt/wari/services/receipt_ocr/deploy/wari-receipt-ocr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wari-receipt-ocr
sudo systemctl status wari-receipt-ocr
```

Set `RECEIPT_OCR_SHARED_SECRET` in `/etc/wari-receipt-ocr.env`. Keep the file owned by `root` with mode `0600`. The service binds OCR to `127.0.0.1:4190`; publish it through an HTTPS reverse proxy or Cloudflare Tunnel instead of exposing port 4190 directly.

Install the included Caddy configuration when using a public HTTPS host:

```bash
sudo apt-get update
sudo apt-get install -y caddy
sudo install -o root -g root -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
sudo install -d -o root -g root -m 0755 /etc/systemd/system/caddy.service.d
sudo install -o root -g root -m 0644 deploy/caddy-wari-ocr.conf /etc/systemd/system/caddy.service.d/wari-ocr.conf
sudo install -o root -g root -m 0644 /dev/null /etc/caddy/wari-ocr.env
sudoedit /etc/caddy/wari-ocr.env
sudo systemctl daemon-reload
sudo systemctl enable --now caddy
```

Set `OCR_PUBLIC_HOST=ocr.example.com` in `/etc/caddy/wari-ocr.env`. The host must resolve to the Oracle public IP, and OCI must permit inbound TCP 80 and 443 for certificate issuance and HTTPS traffic.

Verify:

```bash
curl http://127.0.0.1:4190/health
curl -X POST -H "Authorization: Bearer <RECEIPT_OCR_SHARED_SECRET>" -F "image=@/path/to/receipt.jpg;type=image/jpeg" http://127.0.0.1:4190/ocr
```

Security:

- Do not expose Ollama. Keep it bound to `127.0.0.1:11434`.
- Publish the Python API only through Caddy, nginx, or Cloudflare Tunnel with HTTPS.
- Restrict inbound ports at the Oracle security list and OS firewall. Do not publish port 4190 directly.
