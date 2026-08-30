"""Shared Open Images and YOLO dataset definitions for TUKLAS."""

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
YOLO_ROOT = Path(__file__).resolve().parent
DEFAULT_DATASET_DIR = YOLO_ROOT / "data" / "tuklas_openimages"
DEFAULT_DATASET_YAML = DEFAULT_DATASET_DIR / "dataset.yaml"

TARGET_CLASSES = (
    ("Mobile phone", "mobile_phone"),
    ("Laptop", "laptop"),
    ("Computer monitor", "computer_monitor"),
    ("Book", "book"),
    ("Person", "person"),
)

OPEN_IMAGES_TO_ID = {
    open_images_name: class_id
    for class_id, (open_images_name, _) in enumerate(TARGET_CLASSES)
}
YOLO_CLASS_NAMES = {
    class_id: yolo_name
    for class_id, (_, yolo_name) in enumerate(TARGET_CLASSES)
}

DEFAULT_SAMPLES_PER_CLASS = {
    "train": 600,
    "val": 50,
    "test": 50,
}

OPEN_IMAGES_SPLITS = {
    "train": "train",
    "val": "validation",
    "test": "test",
}

POLICY_MAPPINGS = {
    "mobile_phone": "mobile_phone",
    "laptop": "laptop_monitor",
    "computer_monitor": "laptop_monitor",
    "book": "book_textbook",
}

REQUIRED_POLICY_CLASSES = {
    "mobile_phone",
    "laptop_monitor",
    "book_textbook",
}
