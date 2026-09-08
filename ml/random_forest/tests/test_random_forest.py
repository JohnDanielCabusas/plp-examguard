from __future__ import annotations

import json
import math
import sys
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from predictor import RandomForestPredictor, risk_level  # noqa: E402
from train_random_forest import (  # noqa: E402
    CLASS_NAMES,
    FEATURE_COLUMNS,
    TARGET_COLUMN,
    validate_training_frame,
)


class TrainingValidationTests(unittest.TestCase):
    def valid_frame(self) -> pd.DataFrame:
        row = {column: 1.0 for column in FEATURE_COLUMNS}
        return pd.DataFrame([{**row, TARGET_COLUMN: CLASS_NAMES[0]}])

    def test_missing_column_is_rejected(self):
        frame = self.valid_frame().drop(columns=[FEATURE_COLUMNS[0]])
        with self.assertRaisesRegex(ValueError, "Missing required columns"):
            validate_training_frame(frame)

    def test_unknown_label_is_rejected(self):
        frame = self.valid_frame()
        frame.loc[0, TARGET_COLUMN] = "unknown"
        with self.assertRaisesRegex(ValueError, "Unexpected target values"):
            validate_training_frame(frame)

    def test_nonfinite_value_is_rejected(self):
        frame = self.valid_frame()
        frame.loc[0, FEATURE_COLUMNS[0]] = math.inf
        with self.assertRaisesRegex(ValueError, "infinite"):
            validate_training_frame(frame)


class PredictorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        artifact_dir = ROOT / "artifacts"
        cls.predictor = RandomForestPredictor(
            artifact_dir / "random_forest_model.joblib",
            artifact_dir / "random_forest_metadata.json",
        )
        cls.metadata = json.loads((artifact_dir / "random_forest_metadata.json").read_text(encoding="utf-8"))

    def valid_features(self):
        return {column: 0.0 for column in FEATURE_COLUMNS}

    def test_threshold_boundaries(self):
        self.assertEqual(risk_level(0.49), "normal")
        self.assertEqual(risk_level(0.50), "needs_monitoring")
        self.assertEqual(risk_level(0.79), "needs_monitoring")
        self.assertEqual(risk_level(0.80), "suspicious")

    def test_saved_feature_order_matches(self):
        self.assertEqual(self.metadata["feature_columns"], FEATURE_COLUMNS)
        self.assertEqual(list(self.predictor.model.feature_names_in_), FEATURE_COLUMNS)

    def test_probability_is_valid_and_uses_discovered_class_index(self):
        result = self.predictor.predict(self.valid_features())
        self.assertGreaterEqual(result["suspiciousProbability"], 0)
        self.assertLessEqual(result["suspiciousProbability"], 1)
        self.assertEqual(
            self.predictor.model.classes_[self.predictor.suspicious_class_index],
            self.metadata["positive_class_encoded"],
        )

    def test_invalid_feature_objects_are_rejected(self):
        cases = [
            {},
            {**self.valid_features(), "unexpected": 1},
            {**self.valid_features(), FEATURE_COLUMNS[0]: "1"},
            {**self.valid_features(), FEATURE_COLUMNS[0]: math.nan},
            {**self.valid_features(), FEATURE_COLUMNS[0]: math.inf},
        ]
        for features in cases:
            with self.subTest(features=features):
                with self.assertRaises(ValueError):
                    self.predictor.predict(features)


if __name__ == "__main__":
    unittest.main()

