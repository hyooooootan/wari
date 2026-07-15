import argparse
import json
import os
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    import resource
except ImportError:
    resource = None

MODES = {
    "A": (False, False, False),
    "B": (True, False, False),
    "C": (True, True, False),
    "D": (True, True, True),
}
FIELDS = ("store_name", "total_amount", "paid_at", "paid_time")


def read_receipt_from_path(path, feedback=None):
    from services.receipt_ocr.core import read_receipt_from_path as reader
    return reader(path, feedback=feedback)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--modes", default="A,B,C,D")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--output")
    return parser.parse_args()


def load_manifest(path):
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    images = value.get("images") if isinstance(value, dict) else None
    if not isinstance(images, list) or not images:
        raise ValueError("manifest images must be a non-empty array")
    result = []
    for entry in images:
        image_path = Path(entry.get("path", "")).expanduser()
        expected = entry.get("expected")
        if not image_path.is_file() or not isinstance(expected, dict):
            raise ValueError("each image requires an existing path and expected object")
        if any(field not in expected for field in FIELDS):
            raise ValueError("expected requires store_name, total_amount, paid_at, and paid_time")
        result.append({"path": image_path, "expected": expected, "feedback": entry.get("feedback") or {}})
    return result


def set_mode(mode):
    feedback, text_model, vision_model = MODES[mode]
    os.environ["RECEIPT_OCR_ENABLE_FEEDBACK"] = str(feedback).lower()
    os.environ["RECEIPT_OCR_ENABLE_TEXT_CORRECTION"] = str(text_model).lower()
    os.environ["RECEIPT_OCR_ENABLE_VISION_REREAD"] = str(vision_model).lower()


def rss_mb():
    if resource is None:
        return None
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(value / 1024, 1)


def evaluate_one(entry):
    started = time.monotonic()
    result = read_receipt_from_path(entry["path"], feedback=entry["feedback"])
    elapsed_ms = round((time.monotonic() - started) * 1000)
    correct = {field: result.get(field) == entry["expected"].get(field) for field in FIELDS}
    fallbacks = result.get("fallbacks") if isinstance(result.get("fallbacks"), dict) else {}
    return {
        "correct": correct,
        "needs_review": bool(result.get("needs_review", True)),
        "false_auto_confirm": not result.get("needs_review", True) and not all(correct.values()),
        "processing_time_ms": elapsed_ms,
        "service_processing_time_ms": result.get("processing_time_ms"),
        "text_llm_calls": int(fallbacks.get("text_llm_calls", 0) or 0),
        "vision_calls": int(fallbacks.get("vision_calls", 0) or 0),
        "rss_mb": rss_mb(),
    }


def percentile(values, fraction):
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int((len(ordered) * fraction + 0.999999)) - 1))
    return ordered[index]


def summarize(mode, rows, image_count):
    times = [row["processing_time_ms"] for row in rows]
    return {
        "mode": mode,
        "images": image_count,
        "runs": len(rows),
        "field_correct": {field: sum(1 for row in rows if row["correct"][field]) for field in FIELDS},
        "needs_review_count": sum(1 for row in rows if row["needs_review"]),
        "false_auto_confirm_count": sum(1 for row in rows if row["false_auto_confirm"]),
        "processing_time_ms": {
            "mean": round(statistics.fmean(times), 1),
            "p50": percentile(times, 0.50),
            "p95": percentile(times, 0.95),
            "maximum": max(times),
        },
        "text_llm_calls": sum(row["text_llm_calls"] for row in rows),
        "vision_calls": sum(row["vision_calls"] for row in rows),
        "max_rss_mb": max((row["rss_mb"] for row in rows if row["rss_mb"] is not None), default=None),
    }


def main():
    args = parse_args()
    images = load_manifest(args.manifest)
    modes = [value.strip().upper() for value in args.modes.split(",") if value.strip()]
    if not modes or any(mode not in MODES for mode in modes):
        raise ValueError("modes must contain A, B, C, or D")
    if not 1 <= args.repeat <= 20 or not 1 <= args.concurrency <= 2:
        raise ValueError("repeat must be 1-20 and concurrency must be 1-2")
    report = {"schema_version": 1, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "results": []}
    for mode in modes:
        set_mode(mode)
        work = [entry for entry in images for _ in range(args.repeat)]
        if args.concurrency == 1:
            rows = [evaluate_one(entry) for entry in work]
        else:
            with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
                rows = list(executor.map(evaluate_one, work))
        report["results"].append(summarize(mode, rows, len(images)))
    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(encoded + "\n", encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
