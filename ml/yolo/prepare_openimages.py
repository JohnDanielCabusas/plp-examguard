"""Download balanced Open Images V7 subsets and convert them to YOLO format."""

from __future__ import annotations

import argparse
import csv
import json
import random
import shutil
from collections import Counter
from pathlib import Path

import fiftyone as fo
import fiftyone.zoo as foz
from PIL import Image

from dataset_config import (
    DEFAULT_DATASET_DIR,
    DEFAULT_SAMPLES_PER_CLASS,
    OFFICIAL_CLASS_IMAGE_LIMITS,
    OPEN_IMAGES_SPLITS,
    OPEN_IMAGES_TO_ID,
    TARGET_CLASSES,
    YOLO_CLASS_NAMES,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare a balanced phone/mouse Open Images V7 YOLO dataset."
    )
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_DATASET_DIR)
    parser.add_argument("--train-per-class", type=int, default=DEFAULT_SAMPLES_PER_CLASS["train"])
    parser.add_argument("--val-per-class", type=int, default=DEFAULT_SAMPLES_PER_CLASS["val"])
    parser.add_argument("--test-per-class", type=int, default=DEFAULT_SAMPLES_PER_CLASS["test"])
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Remove an existing generated dataset before downloading.",
    )
    return parser.parse_args()


def safe_reset_output(output_dir: Path, overwrite: bool) -> None:
    output_dir = output_dir.resolve()
    if not output_dir.exists():
        return
    if not overwrite:
        raise FileExistsError(
            f"Dataset already exists at {output_dir}. Use --overwrite to rebuild it."
        )
    if output_dir == Path(output_dir.anchor) or len(output_dir.parts) < 4:
        raise ValueError(f"Refusing to remove unsafe output path: {output_dir}")
    shutil.rmtree(output_dir)


def clipped_yolo_box(bounding_box: list[float]) -> tuple[float, float, float, float] | None:
    x, y, width, height = (float(value) for value in bounding_box)
    left = min(1.0, max(0.0, x))
    top = min(1.0, max(0.0, y))
    right = min(1.0, max(0.0, x + width))
    bottom = min(1.0, max(0.0, y + height))
    clipped_width = right - left
    clipped_height = bottom - top
    if clipped_width <= 0 or clipped_height <= 0:
        return None
    return (
        left + clipped_width / 2,
        top + clipped_height / 2,
        clipped_width,
        clipped_height,
    )


def valid_target_detections(sample) -> list:
    try:
        ground_truth = sample["ground_truth"]
    except (AttributeError, KeyError):
        return []
    if ground_truth is None:
        return []
    return [
        detection
        for detection in ground_truth.detections
        if detection.label in OPEN_IMAGES_TO_ID
        and clipped_yolo_box(detection.bounding_box) is not None
    ]


def verify_image(path: Path) -> bool:
    try:
        with Image.open(path) as image:
            image.verify()
        return True
    except (OSError, ValueError):
        return False


def write_sample(
    sample,
    split: str,
    output_dir: Path,
    seen_image_ids: set[str],
) -> dict | None:
    source_path = Path(sample.filepath)
    image_id = source_path.stem.lower()
    if image_id in seen_image_ids or not source_path.exists() or not verify_image(source_path):
        return None

    detections = valid_target_detections(sample)
    if not detections:
        return None

    suffix = source_path.suffix.lower() or ".jpg"
    image_name = f"{split}_{image_id}{suffix}"
    image_path = output_dir / "images" / split / image_name
    label_path = output_dir / "labels" / split / f"{Path(image_name).stem}.txt"

    label_lines = []
    object_counts = Counter()
    for detection in detections:
        converted = clipped_yolo_box(detection.bounding_box)
        if converted is None:
            continue
        class_id = OPEN_IMAGES_TO_ID[detection.label]
        center_x, center_y, width, height = converted
        label_lines.append(
            f"{class_id} {center_x:.6f} {center_y:.6f} {width:.6f} {height:.6f}"
        )
        object_counts[YOLO_CLASS_NAMES[class_id]] += 1

    if not label_lines:
        return None

    shutil.copy2(source_path, image_path)
    label_path.write_text("\n".join(label_lines) + "\n", encoding="utf-8")
    seen_image_ids.add(image_id)
    return {
        "open_images_id": image_id,
        "image": image_name,
        "objects": dict(object_counts),
    }


def ensure_open_images_metadata(
    split: str,
    open_images_split: str,
    seed: int,
    workers: int,
) -> tuple[Path, Path]:
    split_dir = Path(fo.config.dataset_zoo_dir) / "open-images-v7" / open_images_split
    classes_path = split_dir / "metadata" / "classes.csv"
    detections_path = split_dir / "labels" / "detections.csv"
    if classes_path.exists() and detections_path.exists():
        return classes_path, detections_path

    dataset_name = f"tuklas-oiv7-{split}-metadata-bootstrap"
    if fo.dataset_exists(dataset_name):
        fo.delete_dataset(dataset_name)
    dataset = foz.load_zoo_dataset(
        "open-images-v7",
        split=open_images_split,
        label_types=["detections"],
        classes=[class_name for class_name, _ in TARGET_CLASSES],
        only_matching=True,
        max_samples=1,
        shuffle=True,
        seed=seed,
        num_workers=max(1, workers),
        dataset_name=dataset_name,
    )
    if fo.dataset_exists(dataset.name):
        fo.delete_dataset(dataset.name)
    if not classes_path.exists() or not detections_path.exists():
        raise FileNotFoundError(f"FiftyOne did not create Open Images metadata under {split_dir}")
    return classes_path, detections_path


def select_balanced_image_ids(
    classes_path: Path,
    detections_path: Path,
    per_class_limit: int,
    seed: int,
    per_class_limits: dict[str, int] | None = None,
) -> tuple[list[str], Counter]:
    per_class_limits = per_class_limits or {}
    target_names = {class_name for class_name, _ in TARGET_CLASSES}
    label_to_class = {}
    with classes_path.open("r", encoding="utf-8", newline="") as file_handle:
        for label_name, display_name in csv.reader(file_handle):
            if display_name in target_names:
                label_to_class[label_name] = display_name
    missing_names = target_names - set(label_to_class.values())
    if missing_names:
        raise ValueError(f"Open Images metadata is missing classes: {sorted(missing_names)}")

    largest_limit = max([per_class_limit, *per_class_limits.values()])
    reservoir_size = max(100, largest_limit * 4)
    reservoirs = {class_name: [] for class_name in target_names}
    observed = Counter()
    last_image_id = {}
    randomizers = {
        class_name: random.Random(seed + class_index)
        for class_index, (class_name, _) in enumerate(TARGET_CLASSES)
    }
    with detections_path.open("r", encoding="utf-8", newline="") as file_handle:
        for row in csv.DictReader(file_handle):
            class_name = label_to_class.get(row["LabelName"])
            if not class_name:
                continue
            image_id = row["ImageID"].lower()
            if last_image_id.get(class_name) == image_id:
                continue
            last_image_id[class_name] = image_id
            observed[class_name] += 1
            reservoir = reservoirs[class_name]
            if len(reservoir) < reservoir_size:
                reservoir.append(image_id)
                continue
            replacement_index = randomizers[class_name].randrange(observed[class_name])
            if replacement_index < reservoir_size:
                reservoir[replacement_index] = image_id

    selected_ids = set()
    selected_class_counts = Counter()
    for class_name, _ in TARGET_CLASSES:
        target_limit = min(per_class_limit, per_class_limits.get(class_name, per_class_limit))
        candidates = reservoirs[class_name]
        randomizers[class_name].shuffle(candidates)
        for image_id in candidates:
            # Multi-label images count toward every class they contain. Requiring
            # a different image for each quota would waste storage when both
            # target classes appear in the same image.
            selected_ids.add(image_id)
            selected_class_counts[class_name] += 1
            if selected_class_counts[class_name] >= target_limit:
                break
        if selected_class_counts[class_name] < target_limit:
            raise ValueError(
                f"Only selected {selected_class_counts[class_name]} unique {class_name} images; "
                f"requested {target_limit}."
            )
    return sorted(selected_ids), selected_class_counts


def load_selected_images(
    split: str,
    open_images_split: str,
    image_ids: list[str],
    workers: int,
):
    dataset_name = f"tuklas-oiv7-{split}-selected-{len(image_ids)}"
    if fo.dataset_exists(dataset_name):
        fo.delete_dataset(dataset_name)
    return foz.load_zoo_dataset(
        "open-images-v7",
        split=open_images_split,
        label_types=["detections"],
        classes=[class_name for class_name, _ in TARGET_CLASSES],
        only_matching=True,
        image_ids=image_ids,
        num_workers=max(1, workers),
        dataset_name=dataset_name,
    )


def prepare_split(
    split: str,
    per_class_limit: int,
    output_dir: Path,
    seed: int,
    workers: int,
) -> dict:
    for kind in ("images", "labels"):
        (output_dir / kind / split).mkdir(parents=True, exist_ok=True)
    (output_dir / "metadata").mkdir(parents=True, exist_ok=True)

    classes_path, detections_path = ensure_open_images_metadata(
        split,
        OPEN_IMAGES_SPLITS[split],
        seed,
        workers,
    )
    class_limits = OFFICIAL_CLASS_IMAGE_LIMITS.get(split, {})
    image_ids, selected_class_counts = select_balanced_image_ids(
        classes_path,
        detections_path,
        per_class_limit,
        seed,
        class_limits,
    )
    print(f"[{split}] loading {len(image_ids)} class-balanced images...")
    dataset = load_selected_images(
        split,
        OPEN_IMAGES_SPLITS[split],
        image_ids,
        workers,
    )
    dataset_name = dataset.name
    records = []
    try:
        seen_image_ids: set[str] = set()
        for sample in dataset:
            record = write_sample(sample, split, output_dir, seen_image_ids)
            if record:
                records.append(record)
    finally:
        if fo.dataset_exists(dataset_name):
            fo.delete_dataset(dataset_name)

    metadata_path = output_dir / "metadata" / f"{split}.jsonl"
    metadata_path.write_text(
        "".join(json.dumps(record, sort_keys=True) + "\n" for record in records),
        encoding="utf-8",
    )
    object_counts = Counter()
    for record in records:
        object_counts.update(record["objects"])
    summary = {
        "images": len(records),
        "objects": dict(sorted(object_counts.items())),
        "selected_images_by_open_images_class": dict(sorted(selected_class_counts.items())),
        "requested_images_per_class": {
            class_name: min(per_class_limit, class_limits.get(class_name, per_class_limit))
            for class_name, _ in TARGET_CLASSES
        },
    }
    print(f"[{split}] prepared {summary['images']} unique images: {summary['objects']}")
    return summary


def write_dataset_yaml(output_dir: Path) -> Path:
    names = "\n".join(
        f"  {class_id}: {class_name}"
        for class_id, class_name in YOLO_CLASS_NAMES.items()
    )
    yaml_path = output_dir / "dataset.yaml"
    yaml_path.write_text(
        f"path: {output_dir.resolve().as_posix()}\n"
        "train: images/train\n"
        "val: images/val\n"
        "test: images/test\n\n"
        f"names:\n{names}\n",
        encoding="utf-8",
    )
    return yaml_path


def main() -> None:
    args = parse_args()
    output_dir = args.output_dir.resolve()
    safe_reset_output(output_dir, args.overwrite)
    output_dir.mkdir(parents=True, exist_ok=True)

    limits = {
        "train": max(1, args.train_per_class),
        "val": max(1, args.val_per_class),
        "test": max(1, args.test_per_class),
    }
    summary = {
        "dataset": "Open Images V7",
        "license": "CC BY 2.0",
        "seed": args.seed,
        "classes": list(YOLO_CLASS_NAMES.values()),
        "splits": {},
    }
    for split, limit in limits.items():
        summary["splits"][split] = prepare_split(
            split,
            limit,
            output_dir,
            args.seed,
            args.workers,
        )

    yaml_path = write_dataset_yaml(output_dir)
    (output_dir / "preparation-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Dataset preparation complete: {yaml_path}")


if __name__ == "__main__":
    main()
