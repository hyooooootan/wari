#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path


WORKDIR = Path(os.environ.get("WARI_A1_RETRY_DIR", "/opt/wari-a1-retry"))
RESULT_FILE = WORKDIR / "INSTANCE_CREATED.json"
COMMAND = [
    os.environ.get("WARI_A1_RETRY_PYTHON", str(WORKDIR / ".venv/bin/python")),
    str(WORKDIR / "oci_create_a1_retry.py"),
    "--config",
    os.environ.get("WARI_A1_RETRY_CONFIG", str(WORKDIR / "oci_a1_config.json")),
]


def send_discord(content):
    webhook_url = os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook_url:
        print("DISCORD_WEBHOOK_URL is not set", file=sys.stderr, flush=True)
        return

    payload = json.dumps({"content": content}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        webhook_url,
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": "wari-a1-retry"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            response.read()
    except Exception as exc:
        print(f"Discord notification failed: {exc}", file=sys.stderr, flush=True)


def success_message():
    if not RESULT_FILE.exists():
        return "Wari A1 retry command exited successfully, but INSTANCE_CREATED.json was not found."

    try:
        data = json.loads(RESULT_FILE.read_text(encoding="utf-8"))
    except Exception:
        data = {}

    return "\n".join(
        [
            "Wari A1 instance was created.",
            f"Instance: {data.get('instance_id', '(unknown)')}",
            f"Public IP: {data.get('public_ip', '(unknown)')}",
            f"SSH user: {data.get('ssh_user', '(unknown)')}",
        ]
    )


def main():
    last_lines = []
    process = subprocess.Popen(
        COMMAND,
        cwd=str(WORKDIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None
    for line in process.stdout:
        print(line, end="", flush=True)
        last_lines.append(line.rstrip())
        if len(last_lines) > 20:
            last_lines.pop(0)

    return_code = process.wait()
    if return_code == 0:
        send_discord(success_message())
    else:
        tail = "\n".join(last_lines[-8:])
        send_discord(f"Wari A1 retry command stopped. exit={return_code}\n```\n{tail[:1500]}\n```")
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
