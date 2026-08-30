# TUKLAS Open Images V7 Dataset Guide

## Purpose

This guide explains how to download selected object classes from Open Images V7, convert their bounding-box annotations into YOLO format, train a YOLO model, and test it for the TUKLAS webcam-monitoring module.

The initial object classes are:

- `mobile_phone`
- `laptop`
- `computer_monitor`
- `book`
- `person`

> Do not download the complete Open Images V7 dataset. It is extremely large. FiftyOne can download only the images and annotations needed for these classes.

## What You Need to Download or Install

### Install manually

1. **Python 3.10 or 3.11**
   - Download: <https://www.python.org/downloads/>
   - During installation, enable **Add Python to PATH**.
   - Python 3.10 or 3.11 is recommended because some computer-vision packages may not immediately support the newest Python release.

2. **Visual Studio Code** or another code editor
   - Download: <https://code.visualstudio.com/>

3. **Python packages**
   - `fiftyone` downloads the selected Open Images data.
   - `ultralytics` trains and runs YOLO.
   - `pillow` checks and processes images.

### Downloaded automatically by the commands

- Selected Open Images V7 photos
- Bounding-box annotations
- Pretrained YOLO weights, such as `yolo11n.pt`

You do not need to manually download the entire Open Images archive, annotation CSV files, or pretrained YOLO weights.

## Step 1: Create the Project

Open PowerShell in the desired location:

```powershell
mkdir tuklas-yolo-dataset
cd tuklas-yolo-dataset

py -m venv .venv
.\.venv\Scripts\Activate.ps1

python -m pip install --upgrade pip
pip install fiftyone ultralytics pillow
```

If PowerShell blocks activation:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

## Step 2: Create the Preparation Script

Create `prepare_openimages.py`:

```python
from pathlib import Path
import shutil

import fiftyone.zoo as foz
from PIL import Image


TARGET_CLASSES = [
    "Mobile phone",       # YOLO ID 0
    "Laptop",            # YOLO ID 1
    "Computer monitor",  # YOLO ID 2
    "Book",              # YOLO ID 3
    "Person",            # YOLO ID 4
]

CLASS_TO_ID = {
    class_name: index
    for index, class_name in enumerate(TARGET_CLASSES)
}

SPLITS = {
    "train": {
        "openimages_split": "train",
        "max_samples": 3000,
    },
    "val": {
        "openimages_split": "validation",
        "max_samples": 500,
    },
    "test": {
        "openimages_split": "test",
        "max_samples": 500,
    },
}

OUTPUT_DIR = Path("tuklas_openimages")


def convert_to_yolo(bounding_box):
    # FiftyOne: top-left x, top-left y, width, height
    x, y, width, height = bounding_box

    # YOLO: center x, center y, width, height
    center_x = x + width / 2
    center_y = y + height / 2

    return center_x, center_y, width, height


def prepare_split(yolo_split, settings):
    images_dir = OUTPUT_DIR / "images" / yolo_split
    labels_dir = OUTPUT_DIR / "labels" / yolo_split

    images_dir.mkdir(parents=True, exist_ok=True)
    labels_dir.mkdir(parents=True, exist_ok=True)

    print(f"Downloading {yolo_split} split...")

    dataset = foz.load_zoo_dataset(
        "open-images-v7",
        split=settings["openimages_split"],
        label_types=["detections"],
        classes=TARGET_CLASSES,
        only_matching=True,
        max_samples=settings["max_samples"],
        shuffle=True,
        seed=42,
    )

    image_count = 0
    object_count = 0

    for sample_number, sample in enumerate(dataset):
        source_path = Path(sample.filepath)

        if not source_path.exists():
            continue

        ground_truth = sample.get("ground_truth")

        if ground_truth is None:
            continue

        valid_detections = [
            detection
            for detection in ground_truth.detections
            if detection.label in CLASS_TO_ID
        ]

        if not valid_detections:
            continue

        try:
            with Image.open(source_path) as image:
                image.verify()
        except Exception:
            print(f"Skipping unreadable image: {source_path}")
            continue

        image_name = (
            f"{yolo_split}_{sample_number:06d}"
            f"{source_path.suffix.lower()}"
        )

        destination_image = images_dir / image_name
        destination_label = labels_dir / f"{Path(image_name).stem}.txt"

        shutil.copy2(source_path, destination_image)

        label_lines = []

        for detection in valid_detections:
            class_id = CLASS_TO_ID[detection.label]
            center_x, center_y, width, height = convert_to_yolo(
                detection.bounding_box
            )

            center_x = min(max(center_x, 0.0), 1.0)
            center_y = min(max(center_y, 0.0), 1.0)
            width = min(max(width, 0.0), 1.0)
            height = min(max(height, 0.0), 1.0)

            label_lines.append(
                f"{class_id} {center_x:.6f} {center_y:.6f} "
                f"{width:.6f} {height:.6f}"
            )
            object_count += 1

        destination_label.write_text(
            "\n".join(label_lines),
            encoding="utf-8",
        )
        image_count += 1

    print(
        f"Finished {yolo_split}: "
        f"{image_count} images and {object_count} objects"
    )


def create_yaml():
    yaml_content = """path: tuklas_openimages
train: images/train
val: images/val
test: images/test

names:
  0: mobile_phone
  1: laptop
  2: computer_monitor
  3: book
  4: person
"""

    Path("tuklas_openimages.yaml").write_text(
        yaml_content,
        encoding="utf-8",
    )


def main():
    for split_name, split_settings in SPLITS.items():
        prepare_split(split_name, split_settings)

    create_yaml()
    print("Dataset preparation finished.")


if __name__ == "__main__":
    main()
```

## Step 3: Download and Convert the Dataset

Run:

```powershell
python prepare_openimages.py
```

The script will automatically:

1. Connect to Open Images V7.
2. Find images containing the selected classes.
3. Download the images and bounding boxes.
4. Convert bounding boxes into YOLO format.
5. Create training, validation, and testing folders.

Keep the terminal open until the script reports that dataset preparation is finished.

## Step 4: Check the Output

Expected structure:

```text
tuklas-yolo-dataset/
├── tuklas_openimages/
│   ├── images/
│   │   ├── train/
│   │   ├── val/
│   │   └── test/
│   └── labels/
│       ├── train/
│       ├── val/
│       └── test/
├── tuklas_openimages.yaml
└── prepare_openimages.py
```

Each image must have a corresponding `.txt` annotation:

```text
images/train/train_000001.jpg
labels/train/train_000001.txt
```

A YOLO annotation uses:

```text
class_id center_x center_y width height
```

Example:

```text
0 0.534200 0.621100 0.182000 0.290000
```

## Step 5: Count the Objects

Create `check_dataset.py`:

```python
from collections import Counter
from pathlib import Path


CLASS_NAMES = {
    0: "mobile_phone",
    1: "laptop",
    2: "computer_monitor",
    3: "book",
    4: "person",
}

for split in ["train", "val", "test"]:
    counts = Counter()
    labels_directory = Path("tuklas_openimages/labels") / split

    for label_file in labels_directory.glob("*.txt"):
        for line in label_file.read_text().splitlines():
            if line.strip():
                class_id = int(line.split()[0])
                counts[class_id] += 1

    print(f"\n{split.upper()}")

    for class_id, class_name in CLASS_NAMES.items():
        print(f"{class_name}: {counts[class_id]}")
```

Run:

```powershell
python check_dataset.py
```

Review the result because Open Images may contain many `person` objects but fewer laptops or monitors.

## Step 6: Train YOLO

Start with the lightweight YOLO11 Nano model:

```powershell
yolo detect train data=tuklas_openimages.yaml model=yolo11n.pt epochs=50 imgsz=640 batch=16
```

If the computer runs out of memory, reduce the batch size:

```powershell
yolo detect train data=tuklas_openimages.yaml model=yolo11n.pt epochs=50 imgsz=640 batch=8
```

Ultralytics automatically downloads `yolo11n.pt` the first time it is needed. The best trained model is normally saved at:

```text
runs/detect/train/weights/best.pt
```

## Step 7: Evaluate the Model

```powershell
yolo detect val model=runs/detect/train/weights/best.pt data=tuklas_openimages.yaml split=test
```

Record the following metrics:

- Precision
- Recall
- mAP@50
- mAP@50-95
- Per-class results
- False-positive and false-negative examples

## Step 8: Test the Webcam

```powershell
yolo predict model=runs/detect/train/weights/best.pt source=0 show=True conf=0.40
```

- `source=0` selects the primary webcam.
- `conf=0.40` requires at least 40% model confidence.
- Press `Q` to close the window.

## Important TUKLAS Considerations

### Do not treat all detections as violations

- The student is expected to use a primary laptop.
- A book may be allowed in an open-book examination.
- `person` is supporting evidence for detecting another person, not proof of cheating.
- The professor's exam policy should determine which detected classes are restricted.

### Avoid counting one object repeatedly

A phone detected in 60 consecutive video frames should not automatically produce 60 violations. Merge continuous detections into one incident with:

- Start time
- End time
- Duration
- Highest or average confidence
- Evidence snapshot

### Add custom webcam data

Open Images contains general photographs rather than actual TUKLAS examination sessions. After initial training, add consent-based webcam images representing:

- Phones held beside or below the face
- Partially hidden phones
- Open and closed books
- Secondary laptops and monitors
- A second person entering the room
- Different rooms, lighting conditions, webcams, and object distances
- Normal scenes without prohibited objects

Negative or normal scenes are important because they help reduce false detections.

### Split custom data carefully

Do not randomly place nearly identical frames from one video into training and testing. Divide custom data by participant, room, or recording session so the test set measures performance on genuinely unseen conditions.

## Recommended Development Order

1. Download a small Open Images subset.
2. Verify images and bounding boxes manually.
3. Train the initial YOLO model.
4. Test the model through a webcam.
5. Collect consent-based TUKLAS webcam images.
6. Correctly annotate the custom images.
7. Fine-tune the model again.
8. Evaluate it on unseen participants and environments.
9. Integrate `best.pt` into the TUKLAS monitoring service.
10. Treat detections as behavioral indicators requiring professor review.
