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

from dataset_config import POLICY_MAPPINGS as TUKLAS_POLICY_MAPPINGS, YOLO_ROOT

ULTRALYTICS_CONFIG_ROOT = YOLO_ROOT / "artifacts" / "ultralytics-config"
ULTRALYTICS_CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("YOLO_CONFIG_DIR", str(ULTRALYTICS_CONFIG_ROOT))

from ultralytics import YOLO


COCO_POLICY_MAPPINGS = {
    "cell phone": "mobile_phone",
    # COCO commonly labels the back or edge of a handheld phone as a remote.
    # Policy confirmation still requires crop verification and temporal evidence.
    "remote": "mobile_phone",
    "laptop": "laptop_monitor",
    "tv": "laptop_monitor",
    "book": "book_textbook",
}
TUKLAS_CLASS_NAMES = set(TUKLAS_POLICY_MAPPINGS) | {"person"}
LOCAL_HOME_PATTERNS = (
    re.compile(r"(?i)\b[A-Z]:[\\/]+Users[\\/]+[^\\/\s'\";,}\]]+"),
    re.compile(r"(?i)(?<![A-Za-z0-9_.-])/(?:home|Users)/[^/\s'\";,}\]]+"),
)

PROFILES = {
    "coco": {
        "mappings": COCO_POLICY_MAPPINGS,
        "name": "YOLO11n COCO proctoring baseline",
        "version": "yolo11n-coco-v1",
        "model_name": "yolo11n.onnx",
        "manifest_name": "yolo-proctor-coco-v1.json",
    },
    "tuklas": {
        "mappings": TUKLAS_POLICY_MAPPINGS,
        "name": "TUKLAS YOLO11n Open Images V7 detector",
        "version": "tuklas-openimages-yolo11n-v1",
        "model_name": "tuklas-yolo11n-openimages-v1.onnx",
        "manifest_name": "yolo-proctor-tuklas-v1.json",
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
        "or mobile_phone/laptop/computer_monitor/book/person."
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
    required_classes = TUKLAS_CLASS_NAMES if profile_name == "tuklas" else set(mappings)
    missing_classes = sorted(required_classes - set(class_names))
    if missing_classes:
        raise ValueError(
            f"The {profile_name} model is missing required classes: {', '.join(missing_classes)}"
        )
    if "person" in mappings:
        raise ValueError("Person must remain a context class and cannot map to a violation.")
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
            "laptop_monitor": 0.6,
            "book_textbook": 0.16,
        },
        "verificationThresholds": {
            "mobile_phone": 0.24,
            "laptop_monitor": 0.5,
            "book_textbook": 0.26,
        },
        "verificationMargin": 0.03,
        "verificationPadding": 0.18,
        "policyMappings": mappings,
        "classNames": class_names,
    }


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
    print(f"Exported staged model: {target_model}")
    print(f"Created staged manifest: {manifest_path}")
    print("Run promote_model.py after metrics and webcam validation to activate it.")


if __name__ == "__main__":
    main()
