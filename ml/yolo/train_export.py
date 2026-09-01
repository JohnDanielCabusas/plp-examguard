"""Export COCO or custom TUKLAS YOLO weights as staged browser assets."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
from pathlib import Path

import onnx

from dataset_config import (
    NEGATIVE_CONFIDENCE_THRESHOLDS,
    NEGATIVE_MAPPINGS as TUKLAS_NEGATIVE_MAPPINGS,
    POLICY_MAPPINGS as TUKLAS_POLICY_MAPPINGS,
    TRAINED_CLASS_NAMES,
    YOLO_ROOT,
)

ULTRALYTICS_CONFIG_ROOT = YOLO_ROOT / "artifacts" / "ultralytics-config"
ULTRALYTICS_CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("YOLO_CONFIG_DIR", str(ULTRALYTICS_CONFIG_ROOT))

from ultralytics import YOLO


COCO_POLICY_MAPPINGS = {
    "cell phone": "mobile_phone",
    # COCO commonly labels the back or edge of a handheld phone as a remote.
    # Policy confirmation still requires crop verification and temporal evidence.
    "remote": "mobile_phone",
}
# The stock COCO checkpoint already ships a "mouse" class; reuse it as the
# negative signal there instead of retraining. The custom TUKLAS profile uses
# its own Open-Images-trained "mouse" class via TUKLAS_NEGATIVE_MAPPINGS.
COCO_NEGATIVE_MAPPINGS = {
    "mouse": "mouse",
}
# Required for a checkpoint to be auto-detected and exported as the "tuklas"
# profile -- every class the custom detector was trained on, not just the
# ones currently mapped to a policy violation, so a partially retrained or
# mismatched checkpoint is never silently exported.
TUKLAS_CLASS_NAMES = set(TRAINED_CLASS_NAMES)
LOCAL_HOME_PATTERNS = (
    re.compile(r"(?i)\b[A-Z]:[\\/]+Users[\\/]+[^\\/\s'\";,}\]]+"),
    re.compile(r"(?i)(?<![A-Za-z0-9_.-])/(?:home|Users)/[^/\s'\";,}\]]+"),
)

PROFILES = {
    "coco": {
        "mappings": COCO_POLICY_MAPPINGS,
        "negative_mappings": COCO_NEGATIVE_MAPPINGS,
        "name": "YOLO11n COCO proctoring baseline",
        "version": "yolo11n-coco-v1",
        "model_name": "yolo11n.onnx",
        "manifest_name": "yolo-proctor-coco-v1.json",
    },
    "tuklas": {
        "mappings": TUKLAS_POLICY_MAPPINGS,
        "negative_mappings": TUKLAS_NEGATIVE_MAPPINGS,
        "name": "TUKLAS YOLO11n Open Images V7 detector",
        "version": "tuklas-phone-mouse-yolo11n-v2",
        "model_name": "tuklas-yolo11n-phone-mouse-v2.onnx",
        "manifest_name": "yolo-proctor-tuklas-v2.json",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export YOLO11 weights and a browser proctoring manifest."
    )
    parser.add_argument("--weights", default="yolo11n.pt")
    parser.add_argument("--profile", choices=("auto", "coco", "tuklas"), default="auto")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--version")
    parser.add_argument("--model-name")
    parser.add_argument("--manifest-name")
    parser.add_argument("--output-dir", type=Path, default=Path("public/models"))
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sanitize_onnx_metadata(path: Path) -> bool:
    """Remove workstation user-home paths embedded by training/export tools."""
    model = onnx.load(str(path), load_external_data=False)
    changed = False

    def sanitized(value: str) -> str:
        result = value
        for pattern in LOCAL_HOME_PATTERNS:
            result = pattern.sub("<user-home>", result)
        return result

    for owner in (model, model.graph):
        cleaned = sanitized(owner.doc_string)
        if cleaned != owner.doc_string:
            owner.doc_string = cleaned
            changed = True
    for metadata in model.metadata_props:
        cleaned = sanitized(metadata.value)
        if cleaned != metadata.value:
            metadata.value = cleaned
            changed = True

    if changed:
        onnx.save(model, str(path))
    return changed


def get_class_names(model: YOLO) -> list[str]:
    names = model.names
    if isinstance(names, dict):
        return [str(names[index]) for index in sorted(names)]
    return [str(name) for name in names]


def detect_profile(class_names: list[str], requested_profile: str) -> str:
    if requested_profile != "auto":
        return requested_profile
    available = set(class_names)
    if TUKLAS_CLASS_NAMES.issubset(available):
        return "tuklas"
    if set(COCO_POLICY_MAPPINGS).issubset(available):
        return "coco"
    raise ValueError(
        "Unable to detect a supported class profile. Expected either COCO names "
        f"or {', '.join(sorted(TUKLAS_CLASS_NAMES))}."
    )


def validate_filename(value: str, suffix: str) -> str:
    name = Path(value).name
    if name != value or not name.endswith(suffix) or not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        raise ValueError(f"Unsafe output filename: {value}")
    return name


def build_manifest(
    profile_name: str,
    class_names: list[str],
    model_name: str,
    model_path: Path,
    version: str,
    input_size: int,
) -> dict:
    profile = PROFILES[profile_name]
    mappings = profile["mappings"]
    negative_mappings = profile.get("negative_mappings", {})
    required_classes = TUKLAS_CLASS_NAMES if profile_name == "tuklas" else set(mappings)
    missing_classes = sorted(required_classes - set(class_names))
    if missing_classes:
        raise ValueError(
            f"The {profile_name} model is missing required classes: {', '.join(missing_classes)}"
        )
    if "person" in mappings or "person" in negative_mappings:
        raise ValueError("Person must remain a context class and cannot map to a violation.")
    overlapping_classes = sorted(set(mappings) & set(negative_mappings))
    if overlapping_classes:
        raise ValueError(f"Class cannot be both restricted and negative: {overlapping_classes}")
    missing_negative_sources = sorted(set(negative_mappings) - set(class_names))
    if missing_negative_sources:
        raise ValueError(
            f"The {profile_name} model is missing negative classes: {', '.join(missing_negative_sources)}"
        )
    return {
        "name": profile["name"],
        "version": version,
        "modelProfile": profile_name,
        "modelUrl": f"/models/{model_name}",
        "sha256": sha256(model_path),
        "inputSize": input_size,
        "frameIntervalMs": 250,
        "defaultConfidence": 0.55,
        "nmsThreshold": 0.45,
        "maxDetections": 20,
        "confidenceThresholds": {
            "mobile_phone": 0.12,
        },
        "verificationThresholds": {
            "mobile_phone": 0.24,
        },
        "verificationMargin": 0.03,
        "verificationPadding": 0.18,
        "policyMappings": mappings,
        "negativeMappings": negative_mappings,
        "negativeConfidenceThresholds": {
            negative_class: NEGATIVE_CONFIDENCE_THRESHOLDS.get(negative_class, 0.2)
            for negative_class in sorted(set(negative_mappings.values()))
        },
        "classNames": class_names,
    }


def sync_phone_specialist_manifest(
    output_dir: Path,
    primary_manifest: dict,
) -> Path | None:
    """Point the existing specialist profile at the newly exported TUKLAS model."""
    specialist_path = output_dir / "yolo-phone-specialist-v1.json"
    if not specialist_path.exists():
        return None
    specialist = json.loads(specialist_path.read_text(encoding="utf-8"))
    specialist.update(
        {
            "version": f"{primary_manifest['version']}-specialist",
            "modelProfile": "tuklas",
            "detectorRole": "phone-specialist",
            "modelUrl": primary_manifest["modelUrl"],
            "sha256": primary_manifest["sha256"],
            "inputSize": primary_manifest["inputSize"],
            "policyMappings": TUKLAS_POLICY_MAPPINGS,
            "negativeMappings": TUKLAS_NEGATIVE_MAPPINGS,
            "negativeConfidenceThresholds": primary_manifest[
                "negativeConfidenceThresholds"
            ],
            "classNames": primary_manifest["classNames"],
        }
    )
    specialist_path.write_text(
        json.dumps(specialist, indent=2) + "\n",
        encoding="utf-8",
    )
    return specialist_path


def main() -> None:
    args = parse_args()
    model = YOLO(args.weights)
    class_names = get_class_names(model)
    profile_name = detect_profile(class_names, args.profile)
    profile = PROFILES[profile_name]
    model_name = validate_filename(args.model_name or profile["model_name"], ".onnx")
    manifest_name = validate_filename(
        args.manifest_name or profile["manifest_name"], ".json"
    )
    version = args.version or profile["version"]

    exported_path = Path(
        model.export(
            format="onnx",
            imgsz=args.imgsz,
            simplify=True,
            dynamic=False,
            nms=False,
        )
    ).resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    target_model = output_dir / model_name
    if exported_path != target_model:
        shutil.copy2(exported_path, target_model)
    sanitize_onnx_metadata(target_model)

    manifest = build_manifest(
        profile_name,
        class_names,
        model_name,
        target_model,
        version,
        args.imgsz,
    )
    manifest_path = output_dir / manifest_name
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    specialist_path = (
        sync_phone_specialist_manifest(output_dir, manifest)
        if profile_name == "tuklas"
        else None
    )
    print(f"Exported staged model: {target_model}")
    print(f"Created staged manifest: {manifest_path}")
    if specialist_path:
        print(f"Updated phone specialist manifest: {specialist_path}")
    print("Run promote_model.py after metrics and webcam validation to activate it.")


if __name__ == "__main__":
    main()
