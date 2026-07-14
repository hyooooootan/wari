import argparse
import json
import os
import platform
import shutil
import sys
import tempfile
from pathlib import Path

try:
    from services.receipt_ocr import tesseract_ollama as backend
except ImportError:
    import tesseract_ollama as backend


def check_environment():
    checks = {}
    errors = []
    warnings = []

    checks["python"] = {
        "version": platform.python_version(),
        "supported": sys.version_info >= (3, 10),
    }
    if not checks["python"]["supported"]:
        errors.append("python_version_unsupported")

    try:
        import PIL

        checks["pillow"] = {"available": True, "version": PIL.__version__}
    except Exception as exc:
        checks["pillow"] = {"available": False, "error": type(exc).__name__}
        errors.append("pillow_unavailable")

    tesseract_available = bool(shutil.which(backend.TESSERACT_CMD) or Path(backend.TESSERACT_CMD).exists())
    langs = backend.list_tesseract_langs() if tesseract_available else []
    checks["tesseract"] = {
        "available": tesseract_available,
        "command": backend.TESSERACT_CMD,
        "configured_languages": backend.TESSERACT_LANG.split("+"),
        "installed_languages": langs,
        "configured_languages_available": backend.configured_tesseract_langs_available(langs),
    }
    if not tesseract_available:
        errors.append("tesseract_unavailable")
    elif not checks["tesseract"]["configured_languages_available"]:
        errors.append("tesseract_languages_missing")

    ollama = backend.ollama_status()
    checks["ollama"] = {
        "base_url": backend.OLLAMA_BASE_URL,
        "model": backend.OLLAMA_MODEL,
        "available": ollama["available"],
        "model_present": ollama["model_present"],
        "timeout_seconds": backend.OLLAMA_TIMEOUT,
    }
    if not ollama["available"]:
        errors.append("ollama_unavailable")
    elif not ollama["model_present"]:
        errors.append("ollama_model_missing")

    configured_backend = os.environ.get("OCR_BACKEND", "gemini").lower()
    try:
        max_body_size = int(os.environ.get("OCR_MAX_BODY_SIZE", "10485760"))
    except ValueError:
        max_body_size = None
        errors.append("ocr_max_body_size_invalid")
    checks["configuration"] = {
        "ocr_backend": configured_backend,
        "max_body_size": max_body_size,
        "host": os.environ.get("OCR_HOST", "0.0.0.0"),
        "port": os.environ.get("OCR_PORT", os.environ.get("PORT", "4190")),
        "tesseract_timeout": backend.TESSERACT_TIMEOUT,
        "ollama_timeout": backend.OLLAMA_TIMEOUT,
    }
    if configured_backend not in {"gemini", "local", "tesseract_ollama", "auto"}:
        errors.append("ocr_backend_invalid")
    if max_body_size is not None and max_body_size < 1:
        errors.append("ocr_max_body_size_invalid")
    if not backend.OLLAMA_BASE_URL.startswith("http://127.0.0.1") and not backend.OLLAMA_BASE_URL.startswith("http://localhost"):
        errors.append("ollama_not_local_only")
    if backend.OLLAMA_TIMEOUT > 25:
        warnings.append("ollama_timeout_exceeds_cloudflare_default")

    temporary = {"created": False, "deleted": False}
    try:
        with tempfile.NamedTemporaryFile(prefix="wari-ocr-check-", delete=False) as handle:
            temporary_path = Path(handle.name)
            temporary["created"] = True
        temporary_path.unlink(missing_ok=True)
        temporary["deleted"] = not temporary_path.exists()
    except Exception as exc:
        temporary["error"] = type(exc).__name__
        errors.append("temporary_file_check_failed")
    if not temporary["deleted"]:
        errors.append("temporary_file_not_deleted")
    checks["temporary_file"] = temporary

    health_payload = backend.health()
    health_shape = all(key in health_payload for key in ("backend", "tesseract", "ollama"))
    checks["health_response"] = {"shape_valid": health_shape}
    if not health_shape:
        errors.append("health_response_inconsistent")

    return {
        "ok": not errors,
        "exit_code": 0 if not errors else 1,
        "checks": checks,
        "health": health_payload,
        "errors": errors,
        "warnings": warnings,
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="JSON形式で出力する")
    args = parser.parse_args(argv)
    try:
        result = check_environment()
    except Exception as exc:
        result = {"ok": False, "exit_code": 2, "checks": {}, "errors": [type(exc).__name__], "warnings": []}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"Receipt OCR environment: {'OK' if result['ok'] else 'NOT READY'}")
        for name, check in result.get("checks", {}).items():
            print(f"- {name}: {json.dumps(check, ensure_ascii=False, sort_keys=True)}")
        if result.get("errors"):
            print(f"errors: {', '.join(result['errors'])}")
        if result.get("warnings"):
            print(f"warnings: {', '.join(result['warnings'])}")
    return result.get("exit_code", 2)


if __name__ == "__main__":
    raise SystemExit(main())
