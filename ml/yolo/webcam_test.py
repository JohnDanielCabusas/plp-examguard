"""Run a trained TUKLAS detector against the primary webcam."""

import argparse
import os

from dataset_config import YOLO_ROOT

ULTRALYTICS_CONFIG_ROOT = YOLO_ROOT / "artifacts" / "ultralytics-config"
ULTRALYTICS_CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("YOLO_CONFIG_DIR", str(ULTRALYTICS_CONFIG_ROOT))

from ultralytics import YOLO

def main() -> None:
    parser = argparse.ArgumentParser(description="Test TUKLAS YOLO weights with a webcam.")
    parser.add_argument("--weights", required=True)
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--confidence", type=float, default=0.3)
    parser.add_argument("--imgsz", type=int, default=640)
    args = parser.parse_args()
    model = YOLO(args.weights)
    for _ in model.predict(
        source=args.camera,
        show=True,
        stream=True,
        conf=max(0.01, min(1.0, args.confidence)),
        imgsz=args.imgsz,
    ):
        pass


if __name__ == "__main__":
    main()
