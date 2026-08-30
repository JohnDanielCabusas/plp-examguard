# TUKLAS Open Images V7 YOLO pipeline

This directory contains the reproducible dataset, training, evaluation, export,
and promotion pipeline described in `TUKLAS_Open_Images_V7_YOLO_Guide.md`.
The target classes are:

- `mobile_phone`
- `laptop`
- `computer_monitor`
- `book`
- `person`

`person` is retained as model context but is never mapped directly to a
violation. The professor's exam policy still determines whether computers and
books are permitted.

## 1. Set up Python

Install Python 3.10 or 3.11 from <https://www.python.org/downloads/windows/>
and enable **Add Python to PATH**. Then run from the repository root:

```powershell
.\ml\yolo\setup.ps1
```

The script creates `.venv`, installs `requirements.txt`, and reports whether
PyTorch can use CUDA. If an NVIDIA GPU is present, it installs the official
PyTorch CUDA 12.6 wheels; use `-CpuOnly` only when GPU training is not wanted.
All later commands use `.venv\Scripts\python.exe`.

## 2. Trial download

Start with a small subset to verify network access and annotations:

```powershell
.\.venv\Scripts\python.exe ml/yolo/prepare_openimages.py `
  --train-per-class 20 --val-per-class 5 --test-per-class 5 --overwrite

.\.venv\Scripts\python.exe ml/yolo/check_dataset.py
```

Review the generated contact sheets under
`ml/yolo/data/tuklas_openimages/audit/`. Do not train if boxes or labels are
visibly incorrect.

FiftyOne downloads shared Open Images metadata before selecting images. The
first train-split run caches an approximately 4.8 GB image index plus the full
detection annotation table under `%USERPROFILE%\fiftyone`; even a tiny trial
therefore needs several gigabytes of free space. Keep this cache for the full
download so these files are not fetched and parsed again.

## 3. Prepare the full initial dataset

```powershell
.\.venv\Scripts\python.exe ml/yolo/prepare_openimages.py --overwrite
.\.venv\Scripts\python.exe ml/yolo/check_dataset.py
```

The defaults request up to 600 images per class for training and 50 per class
for validation and testing. The 50-image evaluation target reflects the
smallest available official validation class while keeping all splits balanced.
Deduplication means the final total image count can be lower.
Open Images' official train, validation, and test splits remain separate.
Production training refuses datasets with fewer than 400 train images or 50
validation/test images for any class. `--allow-small-dataset` exists only for
pipeline smoke tests and its output must not be promoted.

Generated data, model runs, and weights are ignored by Git. Open Images V7
images are licensed under CC BY 2.0; the generated metadata retains each Open
Images ID for auditing and attribution.

## 4. Train and evaluate

The RTX 4050-safe default is a batch size of 8:

```powershell
.\.venv\Scripts\python.exe ml/yolo/train.py
```

If CUDA runs out of memory, use `--batch 4`. Training starts from `yolo11n.pt`,
runs 50 epochs at 640px, evaluates `best.pt` on the test split, and writes
`tuklas-training-report.json` with overall and per-class metrics. Ultralytics
also writes confusion matrices and plots under `ml/yolo/runs/`.

Before export, compare phone recall and false positives with the COCO baseline.
The custom model must be tested on consent-based webcam scenes containing phone
fronts, backs, cases, partial phones, books, monitors, the known shelf, and
normal no-object scenes. Similar frames from one recording must stay in one
split.

Do not automatically filter Open Images boxes to approximate webcam scenes. A
curation experiment reduced held-book recall, so targeted, consent-based webcam
examples should instead be added and audited as a separate dataset source.

## 5. Test the trained weights with a webcam

```powershell
.\.venv\Scripts\python.exe ml/yolo/webcam_test.py `
  --weights ml/yolo/runs/tuklas-openimages-yolo11n/weights/best.pt
```

Press `Q` in the prediction window to close it.

## 6. Export a staged browser model

```powershell
.\.venv\Scripts\python.exe ml/yolo/train_export.py `
  --weights ml/yolo/runs/tuklas-openimages-yolo11n/weights/best.pt `
  --profile tuklas
```

This creates versioned staged assets without changing the active exam model:

- `public/models/tuklas-yolo11n-openimages-v1.onnx`
- `public/models/yolo-proctor-tuklas-v1.json`

The browser runtime automatically consumes the five custom class names through
the manifest. The existing object confirmation, crop verification, warning,
and professor-notification policies remain unchanged.

### Browser startup behavior

YOLO is intentionally outside the exam page's critical loading path. The
browser imports the proctoring runtime only for camera-enabled exams, schedules
model warm-up after the dashboard or waiting room has rendered, and initializes
inference in a Web Worker. Browsers without WebGPU load the smaller WASM runtime
directly instead of downloading the WebGPU runtime before falling back. Keep
the active manifest URL stable and its versioned ONNX URL immutable so repeat
visits use the browser cache.

When the active detector is the COCO baseline, the browser also starts the
staged TUKLAS model as a slower phone-only specialist after primary monitoring
is ready. Only its `mobile_phone` output is consumed. This improves coverage of
phone backs, cases, dark screens, and partial views while COCO continues to
handle laptops, monitors, and books. Specialist candidates still require crop
verification and temporal confirmation. Small or ambiguous candidates require
actual object movement, while a clearly sized stationary phone requires an extra
confirmed frame before a violation is issued. Objects pinned to a frame edge
cannot use the stationary-phone shortcut and must move substantially into the
scene, preventing shelves and wall fixtures from confirming as phones. Square
candidates are rejected, and phone-shaped candidates away from the detected
student require four observations plus substantial movement. The worker keeps
person detections as validation context only; they never become violations.
The specialist has its own short
calibration window for stable shelf and furniture regions, and can verify up to
three phone candidates so a false shelf candidate does not hide a real phone
elsewhere in the frame. It alternates a full-frame scan with four overlapping
close-up regions and retries verification with wider context, improving recall
when only a phone edge, corner, camera cluster, or part of its case is visible.
The model still cannot learn every
occlusion from configuration alone: consent-based training and test images must
include phones partly covered by hands, sleeves, desks, bags, and the frame edge.

## 7. Validate and promote

First run a dry validation and the JavaScript regression suite:

```powershell
.\.venv\Scripts\python.exe ml/yolo/promote_model.py `
  --manifest public/models/yolo-proctor-tuklas-v1.json `
  --report ml/yolo/runs/tuklas-openimages-yolo11n/tuklas-training-report.json `
  --dry-run

npm run test:yolo
npm run build
```

After metrics, contact sheets, webcam tests, and browser tests are accepted:

```powershell
.\.venv\Scripts\python.exe ml/yolo/promote_model.py `
  --manifest public/models/yolo-proctor-tuklas-v1.json `
  --report ml/yolo/runs/tuklas-openimages-yolo11n/tuklas-training-report.json
```

Promotion verifies mappings, checksum, ONNX inference, and output shape before
atomically replacing `yolo-proctor-v1.json`. Hard-refresh active exam tabs after
promotion so they load the new manifest and model.
For Open Images models it also rejects undersized datasets and held-out test
metrics below the configured per-class precision/recall floors. Mobile-phone
promotion is held to the stricter floor of 0.80 precision and 0.85 recall. A webcam test
with phone fronts, backs, edges, books, and the known shelf is still required
because public-image metrics cannot measure the deployment camera domain.
If any restricted class fails its gate, leave the staged manifest in place and
keep COCO active until targeted webcam data and another training run improve the
failing class. Never promote only because one class, such as mobile phone,
performs well.

## 8. Roll back to COCO

```powershell
.\.venv\Scripts\python.exe ml/yolo/promote_model.py --rollback-coco
```

The committed `yolo11n.onnx` and `yolo-proctor-coco-v1.json` remain available
as the known-good rollback baseline.

Ultralytics models are AGPL-3.0 by default. Confirm that deployment complies
with those terms or uses an appropriate Ultralytics commercial license.
