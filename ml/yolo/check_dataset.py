"""Audit a generated TUKLAS YOLO dataset and produce visual contact sheets."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from dataset_config import DEFAULT_DATASET_DIR, YOLO_CLASS_NAMES


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit the generated YOLO dataset.")
    parser.add_argument("--dataset-dir", type=Path, default=DEFAULT_DATASET_DIR)
    parser.add_argument("--samples-per-class", type=int, default=6)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_label_file(
    path: Path,
    errors: list[str],
    allow_empty: bool = False,
) -> list[tuple[int, float, float, float, float]]:
    boxes = []
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 5:
            errors.append(f"{path}:{line_number}: expected 5 values, found {len(parts)}")
            continue
        try:
            class_id = int(parts[0])
            center_x, center_y, width, height = (float(value) for value in parts[1:])
        except ValueError:
            errors.append(f"{path}:{line_number}: contains a non-numeric value")
            continue
        values = (center_x, center_y, width, height)
        if class_id not in YOLO_CLASS_NAMES:
            errors.append(f"{path}:{line_number}: unknown class ID {class_id}")
            continue
        if not all(math.isfinite(value) for value in values):
            errors.append(f"{path}:{line_number}: contains a non-finite coordinate")
            continue
        if not (0 <= center_x <= 1 and 0 <= center_y <= 1):
            errors.append(f"{path}:{line_number}: center lies outside the image")
            continue
        if not (0 < width <= 1 and 0 < height <= 1):
            errors.append(f"{path}:{line_number}: width/height must be in (0, 1]")
            continue
        if center_x - width / 2 < -1e-6 or center_x + width / 2 > 1 + 1e-6:
            errors.append(f"{path}:{line_number}: horizontal box lies outside the image")
            continue
        if center_y - height / 2 < -1e-6 or center_y + height / 2 > 1 + 1e-6:
            errors.append(f"{path}:{line_number}: vertical box lies outside the image")
            continue
        boxes.append((class_id, center_x, center_y, width, height))
    if not boxes and not allow_empty:
        errors.append(f"{path}: has no valid annotations")
    return boxes


def read_open_images_ids(dataset_dir: Path, split: str, errors: list[str]) -> set[str]:
    metadata_path = dataset_dir / "metadata" / f"{split}.jsonl"
    if not metadata_path.exists():
        errors.append(f"Missing metadata file: {metadata_path}")
        return set()
    image_ids = set()
    for line_number, raw_line in enumerate(metadata_path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw_line.strip():
            continue
        try:
            record = json.loads(raw_line)
            image_id = str(record["open_images_id"])
        except (json.JSONDecodeError, KeyError):
            errors.append(f"{metadata_path}:{line_number}: invalid metadata record")
            continue
        if image_id in image_ids:
            errors.append(f"{metadata_path}:{line_number}: duplicate Open Images ID {image_id}")
        image_ids.add(image_id)
    return image_ids


def render_contact_sheet(
    split: str,
    samples: list[tuple[Path, list[tuple[int, float, float, float, float]]]],
    output_path: Path,
) -> None:
    if not samples:
        return
    cell_width, cell_height = 320, 240
    columns = 3
    rows = math.ceil(len(samples) / columns)
    sheet = Image.new("RGB", (columns * cell_width, rows * cell_height), "#101820")
    colors = ("#ff4d4f", "#00c2ff", "#ffd43b", "#41d37e", "#f783ff")

    for index, (image_path, boxes) in enumerate(samples):
        with Image.open(image_path) as source:
            image = ImageOps.contain(source.convert("RGB"), (cell_width, cell_height - 24))
        draw = ImageDraw.Draw(image)
        for class_id, center_x, center_y, width, height in boxes:
            left = (center_x - width / 2) * image.width
            top = (center_y - height / 2) * image.height
            right = (center_x + width / 2) * image.width
            bottom = (center_y + height / 2) * image.height
            color = colors[class_id % len(colors)]
            draw.rectangle((left, top, right, bottom), outline=color, width=3)
            draw.text((max(2, left + 2), max(2, top + 2)), YOLO_CLASS_NAMES[class_id], fill=color)
        x = (index % columns) * cell_width
        y = (index // columns) * cell_height
        sheet.paste(image, (x, y + 24))
        ImageDraw.Draw(sheet).text((x + 6, y + 6), f"{split}: {image_path.name}", fill="white")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path, quality=88)


def audit_dataset(dataset_dir: Path, samples_per_class: int = 6, seed: int = 42) -> dict:
    dataset_dir = dataset_dir.resolve()
    errors: list[str] = []
    warnings: list[str] = []
    report = {"dataset_dir": str(dataset_dir), "splits": {}, "errors": errors, "warnings": warnings}
    hashes_by_split: dict[str, dict[str, str]] = {}
    ids_by_split: dict[str, set[str]] = {}
    randomizer = random.Random(seed)

    for split in ("train", "val", "test"):
        images_dir = dataset_dir / "images" / split
        labels_dir = dataset_dir / "labels" / split
        image_paths = sorted(
            path for path in images_dir.glob("*") if path.suffix.lower() in IMAGE_SUFFIXES
        ) if images_dir.exists() else []
        label_paths = sorted(labels_dir.glob("*.txt")) if labels_dir.exists() else []
        images_by_stem = {path.stem: path for path in image_paths}
        labels_by_stem = {path.stem: path for path in label_paths}

        for stem in sorted(images_by_stem.keys() - labels_by_stem.keys()):
            errors.append(f"{split}: image has no label file: {images_by_stem[stem]}")
        for stem in sorted(labels_by_stem.keys() - images_by_stem.keys()):
            errors.append(f"{split}: label has no image file: {labels_by_stem[stem]}")

        class_objects = Counter()
        class_images = Counter()
        annotations_by_image = {}
        hashes = {}
        candidates_by_class = defaultdict(list)
        for stem in sorted(images_by_stem.keys() & labels_by_stem.keys()):
            image_path = images_by_stem[stem]
            try:
                with Image.open(image_path) as image:
                    image.verify()
            except (OSError, ValueError):
                errors.append(f"{split}: unreadable image: {image_path}")
                continue
            boxes = parse_label_file(labels_by_stem[stem], errors, allow_empty=True)
            annotations_by_image[image_path] = boxes
            hashes[file_digest(image_path)] = image_path.name
            present_classes = set()
            for class_id, *_ in boxes:
                class_objects[YOLO_CLASS_NAMES[class_id]] += 1
                present_classes.add(class_id)
                candidates_by_class[class_id].append((image_path, boxes))
            for class_id in present_classes:
                class_images[YOLO_CLASS_NAMES[class_id]] += 1

        ids_by_split[split] = read_open_images_ids(dataset_dir, split, errors)
        hashes_by_split[split] = hashes
        counts = [class_objects[name] for name in YOLO_CLASS_NAMES.values()]
        if any(count == 0 for count in counts):
            missing = [name for name in YOLO_CLASS_NAMES.values() if class_objects[name] == 0]
            errors.append(f"{split}: classes with no objects: {', '.join(missing)}")
        elif max(counts) / min(counts) > 5:
            warnings.append(f"{split}: object-count imbalance exceeds 5:1")

        selected = []
        selected_paths = set()
        for class_id in YOLO_CLASS_NAMES:
            candidates = list(candidates_by_class[class_id])
            randomizer.shuffle(candidates)
            added_for_class = 0
            for candidate in candidates:
                if candidate[0] in selected_paths:
                    continue
                selected.append(candidate)
                selected_paths.add(candidate[0])
                added_for_class += 1
                if added_for_class >= samples_per_class:
                    break
        render_contact_sheet(split, selected, dataset_dir / "audit" / f"contact-sheet-{split}.jpg")
        report["splits"][split] = {
            "images": len(image_paths),
            "labels": len(label_paths),
            "objects_by_class": dict(class_objects),
            "images_by_class": dict(class_images),
        }

    split_names = ("train", "val", "test")
    for left_index, left_split in enumerate(split_names):
        for right_split in split_names[left_index + 1:]:
            duplicate_ids = ids_by_split[left_split] & ids_by_split[right_split]
            if duplicate_ids:
                errors.append(
                    f"Open Images ID leakage between {left_split} and {right_split}: "
                    f"{len(duplicate_ids)} images"
                )
            duplicate_hashes = hashes_by_split[left_split].keys() & hashes_by_split[right_split].keys()
            if duplicate_hashes:
                errors.append(
                    f"Image-content leakage between {left_split} and {right_split}: "
                    f"{len(duplicate_hashes)} images"
                )

    report["valid"] = not errors
    report_path = dataset_dir / "audit" / "dataset-report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    args = parse_args()
    report = audit_dataset(args.dataset_dir, args.samples_per_class, args.seed)
    for split, summary in report["splits"].items():
        print(f"{split}: {summary['images']} images, {summary['objects_by_class']}")
    for warning in report["warnings"]:
        print(f"WARNING: {warning}")
    if report["errors"]:
        for error in report["errors"]:
            print(f"ERROR: {error}")
        raise SystemExit(1)
    print("Dataset audit passed. Review the contact sheets before training.")


if __name__ == "__main__":
    main()
