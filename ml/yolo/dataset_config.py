"""Shared Open Images and YOLO dataset definitions for TUKLAS."""

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
YOLO_ROOT = Path(__file__).resolve().parent
DEFAULT_DATASET_DIR = YOLO_ROOT / "data" / "tuklas_openimages"
DEFAULT_DATASET_YAML = DEFAULT_DATASET_DIR / "dataset.yaml"

TARGET_CLASSES = (
    ("Mobile phone", "mobile_phone"),
    # Trained alongside the restricted class so the detector learns
    # what a computer mouse actually looks like, rather than relying on a
    # generic COCO checkpoint's "mouse" class. It is never itself a policy
    # violation -- see NEGATIVE_MAPPINGS below -- it exists purely so a
    # phone-shaped mouse on the desk out-competes a false "mobile_phone" call
    # at the same box instead of being reported as one.
    ("Computer mouse", "mouse"),
)

OPEN_IMAGES_TO_ID = {
    open_images_name: class_id
    for class_id, (open_images_name, _) in enumerate(TARGET_CLASSES)
}
YOLO_CLASS_NAMES = {
    class_id: yolo_name
    for class_id, (_, yolo_name) in enumerate(TARGET_CLASSES)
}
TRAINED_CLASS_NAMES = tuple(yolo_name for _, yolo_name in TARGET_CLASSES)

DEFAULT_SAMPLES_PER_CLASS = {
    "train": 600,
    "val": 50,
    "test": 50,
}

# Open Images V7 has only 19 unique Computer mouse images in its official
# validation split. Keep the phone target at 50 while using every available
# mouse validation image instead of mixing splits or duplicating samples.
OFFICIAL_CLASS_IMAGE_LIMITS = {
    "val": {
        "Computer mouse": 19,
    },
}

OPEN_IMAGES_SPLITS = {
    "train": "train",
    "val": "validation",
    "test": "test",
}

POLICY_MAPPINGS = {
    "mobile_phone": "mobile_phone",
}

# Trained classes that are never a policy violation but exist to suppress a
# restricted class's false positives at the same detector box. Kept distinct
# from POLICY_MAPPINGS so exported manifests never accidentally treat a
# negative class as contraband.
NEGATIVE_MAPPINGS = {
    "mouse": "mouse",
}

NEGATIVE_CONFIDENCE_THRESHOLDS = {
    "mouse": 0.15,
}

REQUIRED_POLICY_CLASSES = {
    "mobile_phone",
}
