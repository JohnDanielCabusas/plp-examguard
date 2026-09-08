"""Validated, reusable inference for a trained TUKLAS Random Forest artifact."""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import joblib
import numpy as np
import pandas as pd


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def risk_level(probability: float, monitoring_threshold: float = 0.50, suspicious_threshold: float = 0.80) -> str:
    if probability >= suspicious_threshold:
        return "suspicious"
    if probability >= monitoring_threshold:
        return "needs_monitoring"
    return "normal"


class RandomForestPredictor:
    def __init__(self, model_path: Path, metadata_path: Path):
        self.model_path = Path(model_path)
        self.metadata_path = Path(metadata_path)
        self.metadata = json.loads(self.metadata_path.read_text(encoding="utf-8"))
        expected_hash = str(self.metadata.get("model_sha256") or "")
        if expected_hash and sha256_file(self.model_path) != expected_hash:
            raise ValueError("Random Forest model checksum does not match its metadata.")
        self.model = joblib.load(self.model_path)
        self.feature_columns = list(self.metadata.get("feature_columns") or [])
        if len(self.feature_columns) != 12 or len(set(self.feature_columns)) != 12:
            raise ValueError("Random Forest metadata has an invalid feature schema.")
        model_feature_names = list(getattr(self.model, "feature_names_in_", []))
        if model_feature_names and model_feature_names != self.feature_columns:
            raise ValueError("Runtime feature order does not match the trained model.")
        positive_encoded = self.metadata.get("positive_class_encoded", 1)
        model_classes = list(getattr(self.model, "classes_", []))
        if positive_encoded not in model_classes:
            raise ValueError("Suspicious class is absent from the trained model.")
        self.suspicious_class_index = model_classes.index(positive_encoded)

    def validate_features(self, features: Mapping[str, Any]) -> list[float]:
        if not isinstance(features, Mapping):
            raise ValueError("Prediction features must be an object.")
        missing = [name for name in self.feature_columns if name not in features]
        unknown = [name for name in features if name not in self.feature_columns]
        if missing:
            raise ValueError(f"Missing prediction features: {', '.join(missing)}")
        if unknown:
            raise ValueError(f"Unknown prediction features: {', '.join(unknown)}")
        ordered = []
        for name in self.feature_columns:
            value = features[name]
            if isinstance(value, bool) or not isinstance(value, (int, float, np.number)):
                raise ValueError(f"Feature {name} must be numeric.")
            numeric = float(value)
            if not math.isfinite(numeric):
                raise ValueError(f"Feature {name} must be finite.")
            ordered.append(numeric)
        return ordered

    def predict(self, features: Mapping[str, Any]) -> dict[str, Any]:
        ordered = self.validate_features(features)
        frame = pd.DataFrame([ordered], columns=self.feature_columns)
        probability = float(self.model.predict_proba(frame)[0][self.suspicious_class_index])
        if not math.isfinite(probability) or probability < 0 or probability > 1:
            raise ValueError("Model returned an invalid suspicious probability.")
        thresholds = self.metadata.get("thresholds") or {}
        monitoring_threshold = float(thresholds.get("monitoring", 0.50))
        suspicious_threshold = float(thresholds.get("suspicious", 0.80))
        level = risk_level(probability, monitoring_threshold, suspicious_threshold)
        return {
            "suspiciousProbability": probability,
            "riskLevel": level,
            "requiresProfessorReview": probability >= monitoring_threshold,
            "modelVersion": self.metadata["model_version"],
            "predictedAt": utc_now(),
        }
