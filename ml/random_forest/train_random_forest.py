"""Train and evaluate the TUKLAS suspicious-behavior Random Forest offline."""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import StratifiedKFold, cross_validate, train_test_split

FEATURE_COLUMNS = [
    "browser_start_count",
    "browser_end_count",
    "browser_tab_switched_count",
    "browser_screenshot_count",
    "browser_exam_duration_minutes",
    "webcam_face_present",
    "webcam_no_of_face",
    "webcam_face_conf",
    "webcam_hand_count",
    "webcam_head_pitch",
    "webcam_head_yaw",
    "webcam_head_roll",
]
TARGET_COLUMN = "suspicion_label"
CLASS_NAMES = ["non_suspicious", "suspicious"]
LABEL_ENCODING = {"non_suspicious": 0, "suspicious": 1}
RANDOM_SEED = 42
DEFAULT_MODEL_VERSION = "1.0.0"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_value(value: Any) -> Any:
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    return value


def validate_training_frame(frame: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    expected = FEATURE_COLUMNS + [TARGET_COLUMN]
    missing = [column for column in expected if column not in frame.columns]
    unexpected = [column for column in frame.columns if column not in expected]
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")
    if unexpected:
        raise ValueError(f"Unexpected columns: {', '.join(unexpected)}")

    labels = set(frame[TARGET_COLUMN].dropna().unique().tolist())
    unknown_labels = sorted(labels - set(CLASS_NAMES))
    if unknown_labels or frame[TARGET_COLUMN].isna().any():
        detail = ", ".join(map(str, unknown_labels)) or "missing label"
        raise ValueError(f"Unexpected target values: {detail}")

    numeric = frame[FEATURE_COLUMNS].apply(pd.to_numeric, errors="coerce")
    if numeric.isna().any().any():
        bad = numeric.columns[numeric.isna().any()].tolist()
        raise ValueError(f"Missing or nonnumeric feature values in: {', '.join(bad)}")
    if not np.isfinite(numeric.to_numpy(dtype=float)).all():
        raise ValueError("Training features contain infinite values.")

    normalized = frame.copy()
    normalized[FEATURE_COLUMNS] = numeric
    before = len(normalized)
    normalized = normalized.drop_duplicates().reset_index(drop=True)
    return normalized, before - len(normalized)


def train(dataset_path: Path, artifact_dir: Path, model_version: str) -> dict[str, Any]:
    if not dataset_path.is_file():
        raise FileNotFoundError(f"Training dataset not found: {dataset_path}")

    frame, duplicates_removed = validate_training_frame(pd.read_csv(dataset_path))
    features = frame[FEATURE_COLUMNS]
    labels = frame[TARGET_COLUMN].map(LABEL_ENCODING).astype(int)
    x_train, x_test, y_train, y_test = train_test_split(
        features,
        labels,
        test_size=0.20,
        random_state=RANDOM_SEED,
        stratify=labels,
    )

    parameters = {
        "n_estimators": 500,
        "random_state": RANDOM_SEED,
        "class_weight": "balanced",
        "min_samples_leaf": 2,
        "n_jobs": -1,
    }
    model = RandomForestClassifier(**parameters)
    cross_validation = cross_validate(
        model,
        x_train,
        y_train,
        cv=StratifiedKFold(n_splits=5, shuffle=True, random_state=RANDOM_SEED),
        scoring=["accuracy", "balanced_accuracy", "precision", "recall", "f1", "roc_auc"],
        n_jobs=-1,
    )
    model.fit(x_train, y_train)
    suspicious_index = list(model.classes_).index(LABEL_ENCODING["suspicious"])
    probabilities = model.predict_proba(x_test)[:, suspicious_index]
    predictions = (probabilities >= 0.50).astype(int)

    cv_metrics = {}
    for name, values in cross_validation.items():
        if not name.startswith("test_"):
            continue
        metric_name = name.removeprefix("test_")
        cv_metrics[metric_name] = {
            "folds": [float(value) for value in values],
            "mean": float(np.mean(values)),
            "std": float(np.std(values)),
        }

    trained_at = utc_now()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    model_path = artifact_dir / "random_forest_model.joblib"
    joblib.dump(model, model_path, compress=3)

    class_distribution = frame[TARGET_COLUMN].value_counts().to_dict()
    metrics = {
        "model_name": "tuklas_random_forest",
        "model_version": model_version,
        "evaluated_at": trained_at,
        "test": {
            "accuracy": float(accuracy_score(y_test, predictions)),
            "balanced_accuracy": float(balanced_accuracy_score(y_test, predictions)),
            "suspicious_precision": float(precision_score(y_test, predictions, zero_division=0)),
            "suspicious_recall": float(recall_score(y_test, predictions, zero_division=0)),
            "suspicious_f1": float(f1_score(y_test, predictions, zero_division=0)),
            "roc_auc": float(roc_auc_score(y_test, probabilities)),
            "confusion_matrix": confusion_matrix(y_test, predictions).tolist(),
        },
        "cross_validation_training_only": cv_metrics,
        "training_record_count": int(len(x_train)),
        "test_record_count": int(len(x_test)),
        "total_record_count": int(len(frame)),
        "duplicates_removed": int(duplicates_removed),
        "class_distribution": class_distribution,
        "feature_importances": {
            column: float(importance)
            for column, importance in zip(FEATURE_COLUMNS, model.feature_importances_)
        },
    }

    metadata = {
        "model_name": "tuklas_random_forest",
        "model_version": model_version,
        "feature_contract_version": "rf-session-summary-v1",
        "target": TARGET_COLUMN,
        "positive_class": "suspicious",
        "positive_class_encoded": 1,
        "feature_columns": FEATURE_COLUMNS,
        "class_names": CLASS_NAMES,
        "model_classes": json_value(model.classes_),
        "thresholds": {"monitoring": 0.50, "suspicious": 0.80},
        "random_seed": RANDOM_SEED,
        "model_parameters": parameters,
        "trained_at": trained_at,
        "python_version": platform.python_version(),
        "numpy_version": np.__version__,
        "pandas_version": pd.__version__,
        "joblib_version": joblib.__version__,
        "scikit_learn_version": sklearn.__version__,
        "dataset_sha256": sha256_file(dataset_path),
        "model_sha256": sha256_file(model_path),
        "feature_ranges": {
            column: {
                "min": float(frame[column].min()),
                "max": float(frame[column].max()),
            }
            for column in FEATURE_COLUMNS
        },
        "limitations": [
            "The source dataset has no anonymized student or session grouping identifier.",
            "This baseline uses a stratified row-level split and requires grouped validation on consent-based TUKLAS pilot data.",
            "Predictions are review support and do not establish academic dishonesty."
        ],
    }

    (artifact_dir / "random_forest_metrics.json").write_text(
        json.dumps(json_value(metrics), indent=2) + "\n", encoding="utf-8"
    )
    (artifact_dir / "random_forest_metadata.json").write_text(
        json.dumps(json_value(metadata), indent=2) + "\n", encoding="utf-8"
    )
    return {"metrics": metrics, "metadata": metadata, "model_path": str(model_path)}


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset",
        type=Path,
        default=root / "data" / "tuklas_random_forest_training_ready.csv",
    )
    parser.add_argument("--artifacts", type=Path, default=root / "artifacts")
    parser.add_argument("--model-version", default=DEFAULT_MODEL_VERSION)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    result = train(arguments.dataset.resolve(), arguments.artifacts.resolve(), arguments.model_version)
    print(json.dumps(json_value(result["metrics"]), indent=2))
