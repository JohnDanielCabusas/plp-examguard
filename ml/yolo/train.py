"""Audit, train, and evaluate the TUKLAS YOLO11n detector."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from check_dataset import audit_dataset
from dataset_config import DEFAULT_DATASET_DIR, DEFAULT_DATASET_YAML, YOLO_ROOT

ULTRALYTICS_CONFIG_ROOT = YOLO_ROOT / "artifacts" / "ultralytics-config"
ULTRALYTICS_CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("YOLO_CONFIG_DIR", str(ULTRALYTICS_CONFIG_ROOT))

import torch
from ultralytics import YOLO


MIN_IMAGES_PER_CLASS = {
    "train": {"default": 400, "book": 400},
    "val": {"default": 50, "book": 25},
    "test": {"default": 50, "book": 25},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train YOLO11n on the TUKLAS dataset.")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATASET_YAML)
    parser.add_argument("--model", default="yolo11n.pt")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--name", default="tuklas-openimages-yolo11n")
    parser.add_argument("--project", type=Path, default=YOLO_ROOT / "runs")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--skip-audit", action="store_true")
    parser.add_argument(
        "--allow-small-dataset",
        action="store_true",
        help="Allow smoke training below production dataset minimums.",
    )
    return parser.parse_args()


def serializable_metrics(metrics) -> dict:
    report = {}
    for key, value in getattr(metrics, "results_dict", {}).items():
        try:
            report[key] = float(value)
        except (TypeError, ValueError):
            continue
    names = getattr(metrics, "names", {})
    box = getattr(metrics, "box", None)
    if box is not None and names:
        per_class = {}
        for class_id, class_name in names.items():
            index = int(class_id)
            if index >= len(box.p):
                continue
            per_class[str(class_name)] = {
                "precision": float(box.p[index]),
                "recall": float(box.r[index]),
                "map50": float(box.ap50[index]),
                "map50_95": float(box.ap[index]),
            }
        report["per_class"] = per_class
    return report


def validate_dataset_scale(audit: dict, allow_small_dataset: bool = False) -> None:
    if allow_small_dataset:
        return
    shortages = []
    for split, minimums in MIN_IMAGES_PER_CLASS.items():
        images_by_class = audit.get("splits", {}).get(split, {}).get("images_by_class", {})
        for class_name in ("mobile_phone", "laptop", "computer_monitor", "book", "person"):
            minimum = minimums.get(class_name, minimums["default"])
            actual = int(images_by_class.get(class_name, 0))
            if actual < minimum:
                shortages.append(f"{split}/{class_name}: {actual} < {minimum}")
    if shortages:
        raise ValueError(
            "Dataset is too small for production training. Rebuild the full Open Images "
            f"dataset or pass --allow-small-dataset for smoke tests only: {'; '.join(shortages)}"
        )


def main() -> None:
    args = parse_args()
    data_path = args.data.resolve()
    dataset_dir = data_path.parent if data_path.name == "dataset.yaml" else DEFAULT_DATASET_DIR
    if not data_path.exists():
        raise FileNotFoundError(
            f"Dataset YAML not found: {data_path}. Run prepare_openimages.py first."
        )
    audit_path = dataset_dir / "audit" / "dataset-report.json"
    if args.skip_audit:
        if not audit_path.exists():
            raise FileNotFoundError("No prior dataset audit exists; remove --skip-audit.")
        audit = json.loads(audit_path.read_text(encoding="utf-8"))
    else:
        audit = audit_dataset(dataset_dir, seed=args.seed)
    if not audit["valid"]:
        raise ValueError("Dataset audit failed; fix dataset-report.json before training.")
    validate_dataset_scale(audit, args.allow_small_dataset)

    device = args.device
    if device == "auto":
        device = "0" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        print("WARNING: CUDA is unavailable; training will be significantly slower.")

    model = YOLO(args.model)
    model.train(
        data=str(data_path),
        epochs=max(1, args.epochs),
        imgsz=args.imgsz,
        batch=args.batch,
        workers=max(0, args.workers),
        device=device,
        seed=args.seed,
        deterministic=True,
        project=str(args.project.resolve()),
        name=args.name,
        exist_ok=args.resume,
        resume=args.resume,
        plots=True,
    )
    save_dir = Path(model.trainer.save_dir)
    best_weights = save_dir / "weights" / "best.pt"
    if not best_weights.exists():
        raise FileNotFoundError(f"Training completed without best weights: {best_weights}")

    best_model = YOLO(best_weights)
    test_metrics = best_model.val(
        data=str(data_path),
        split="test",
        imgsz=args.imgsz,
        batch=args.batch,
        device=device,
        plots=True,
        project=str(args.project.resolve()),
        name=f"{args.name}-test",
    )
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "data": str(data_path),
        "base_model": args.model,
        "best_weights": str(best_weights.resolve()),
        "device": str(device),
        "epochs": args.epochs,
        "imgsz": args.imgsz,
        "batch": args.batch,
        "dataset_audit": audit.get("splits", {}),
        "test_metrics": serializable_metrics(test_metrics),
    }
    report_path = save_dir / "tuklas-training-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Training and test evaluation complete: {best_weights}")
    print(f"Metrics report: {report_path}")


if __name__ == "__main__":
    main()
