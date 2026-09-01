"""Validate and atomically promote or roll back a browser YOLO manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
import onnxruntime as ort

from dataset_config import REQUIRED_POLICY_CLASSES, TRAINED_CLASS_NAMES


MIN_IMAGES_PER_CLASS = {
    "train": {"default": 400},
    "val": {"default": 50, "mouse": 19},
    "test": {"default": 50},
}
MIN_CLASS_METRICS = {
    # Phones are the highest-priority small object in the webcam deployment
    # domain, so do not promote a custom model that merely clears the generic
    # detector floor.
    "mobile_phone": {"precision": 0.80, "recall": 0.85},
    # Mouse exists to suppress false phone positives, so precision matters
    # more than recall here: a mouse the model mistakes for something else
    # just misses one suppression opportunity, but a real phone the model
    # mistakes for a mouse would hide an actual violation.
    "mouse": {"precision": 0.65, "recall": 0.55},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Promote a staged TUKLAS YOLO model.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--manifest", type=Path, help="Staged manifest to promote.")
    source.add_argument(
        "--rollback-coco",
        action="store_true",
        help="Restore public/models/yolo-proctor-coco-v1.json.",
    )
    parser.add_argument(
        "--active-manifest",
        type=Path,
        default=Path("public/models/yolo-proctor-v1.json"),
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--report",
        type=Path,
        help="Training report required when promoting an Open Images model.",
    )
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_model_path(manifest: dict, models_dir: Path) -> Path:
    model_url = str(manifest.get("modelUrl", ""))
    prefix = "/models/"
    model_path = urlsplit(model_url).path
    if not model_path.startswith(prefix):
        raise ValueError("Manifest modelUrl must start with /models/.")
    model_name = model_path[len(prefix):]
    if Path(model_name).name != model_name:
        raise ValueError("Manifest modelUrl must reference a file directly under public/models.")
    return models_dir / model_name


def validate_manifest(manifest_path: Path, models_dir: Path) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    class_names = manifest.get("classNames")
    mappings = manifest.get("policyMappings")
    negative_mappings = manifest.get("negativeMappings", {})
    if not isinstance(class_names, list) or not class_names:
        raise ValueError("Manifest classNames must be a non-empty list.")
    if not isinstance(mappings, dict):
        raise ValueError("Manifest policyMappings must be an object.")
    if not isinstance(negative_mappings, dict):
        raise ValueError("Manifest negativeMappings must be an object.")
    if "person" in mappings or "person" in negative_mappings:
        raise ValueError("Person cannot be mapped to a violation policy.")
    missing_policies = REQUIRED_POLICY_CLASSES - set(mappings.values())
    if missing_policies:
        raise ValueError(f"Manifest is missing policy targets: {sorted(missing_policies)}")
    missing_sources = set(mappings) - set(class_names)
    if missing_sources:
        raise ValueError(f"Manifest maps classes absent from the model: {sorted(missing_sources)}")
    overlapping_classes = set(mappings) & set(negative_mappings)
    if overlapping_classes:
        raise ValueError(f"Class cannot be both restricted and negative: {sorted(overlapping_classes)}")
    missing_negative_sources = set(negative_mappings) - set(class_names)
    if missing_negative_sources:
        raise ValueError(
            f"Manifest maps negative classes absent from the model: {sorted(missing_negative_sources)}"
        )

    model_path = resolve_model_path(manifest, models_dir)
    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")
    if sha256(model_path) != str(manifest.get("sha256", "")).lower():
        raise ValueError("Model checksum does not match the manifest.")

    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    input_meta = session.get_inputs()[0]
    input_size = int(manifest.get("inputSize", 640))
    output = session.run(
        None,
        {input_meta.name: np.zeros((1, 3, input_size, input_size), dtype=np.float32)},
    )[0]
    if output.ndim != 3 or output.shape[0] != 1:
        raise ValueError(f"Unsupported model output shape: {output.shape}")
    channel_first = output.shape[1] == len(class_names) + 4
    end_to_end = output.shape[2] == 6
    if not channel_first and not end_to_end:
        raise ValueError(
            f"Output shape {output.shape} does not match {len(class_names)} manifest classes."
        )
    return manifest


def validate_training_report(report_path: Path) -> dict:
    report = json.loads(report_path.read_text(encoding="utf-8"))
    audit = report.get("dataset_audit", {})
    failures = []
    for split, minimums in MIN_IMAGES_PER_CLASS.items():
        class_images = audit.get(split, {}).get("images_by_class", {})
        for class_name in TRAINED_CLASS_NAMES:
            minimum = minimums.get(class_name, minimums["default"])
            actual = int(class_images.get(class_name, 0))
            if actual < minimum:
                failures.append(f"{split}/{class_name} images {actual} < {minimum}")

    metrics = report.get("test_metrics", {}).get("per_class", {})
    for class_name, minimums in MIN_CLASS_METRICS.items():
        class_metrics = metrics.get(class_name, {})
        for metric_name, minimum in minimums.items():
            actual = float(class_metrics.get(metric_name, 0))
            if actual < minimum:
                failures.append(
                    f"{class_name} {metric_name} {actual:.3f} < {minimum:.3f}"
                )
    if failures:
        raise ValueError("Open Images promotion quality gate failed: " + "; ".join(failures))
    return report


def atomic_write_json(path: Path, value: dict) -> None:
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary_path, path)


def main() -> None:
    args = parse_args()
    active_path = args.active_manifest.resolve()
    models_dir = active_path.parent
    source_path = (
        models_dir / "yolo-proctor-coco-v1.json"
        if args.rollback_coco
        else args.manifest.resolve()
    )
    manifest = validate_manifest(source_path, models_dir)
    if manifest.get("modelProfile") == "tuklas":
        if not args.report:
            raise ValueError("--report is required to promote an Open Images model.")
        validate_training_report(args.report.resolve())
    print(f"Validated {manifest['version']} from {source_path}")
    if args.dry_run:
        print("Dry run complete; active manifest was not changed.")
        return
    if active_path.exists():
        previous = json.loads(active_path.read_text(encoding="utf-8"))
        atomic_write_json(models_dir / "yolo-proctor-previous.json", previous)
    atomic_write_json(active_path, manifest)
    print(f"Activated {manifest['version']} at {active_path}")


if __name__ == "__main__":
    main()
