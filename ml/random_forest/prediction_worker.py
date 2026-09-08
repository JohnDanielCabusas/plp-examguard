"""Long-lived JSON-lines worker that loads the Random Forest exactly once."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from predictor import RandomForestPredictor


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=root / "artifacts" / "random_forest_model.joblib")
    parser.add_argument("--metadata", type=Path, default=root / "artifacts" / "random_forest_metadata.json")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    predictor = RandomForestPredictor(args.model.resolve(), args.metadata.resolve())
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            result = predictor.predict(request.get("features"))
            response = {"id": request_id, "success": True, "prediction": result}
        except Exception as error:  # Worker errors are returned, never printed with feature data.
            response = {"id": request_id, "success": False, "message": str(error)}
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

