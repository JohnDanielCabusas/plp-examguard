"""Fast unit tests for dataset conversion and model profile selection."""

import unittest
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from dataset_config import TRAINED_CLASS_NAMES
from prepare_openimages import (
    clipped_yolo_box,
    select_balanced_image_ids,
    valid_target_detections,
)
from train_export import (
    COCO_POLICY_MAPPINGS,
    TUKLAS_CLASS_NAMES,
    detect_profile,
    sanitize_onnx_metadata,
    sync_phone_specialist_manifest,
)
from train import validate_dataset_scale
from promote_model import resolve_model_path, validate_training_report


class DatasetConversionTests(unittest.TestCase):
    def test_clips_box_to_image_bounds(self):
        actual = clipped_yolo_box([-0.1, 0.2, 0.5, 0.4])
        self.assertIsNotNone(actual)
        for actual_value, expected_value in zip(actual, (0.2, 0.4, 0.4, 0.4)):
            self.assertAlmostEqual(actual_value, expected_value)

    def test_rejects_box_outside_image(self):
        self.assertIsNone(clipped_yolo_box([1.2, 0.2, 0.2, 0.2]))

    def test_reads_fiftyone_sample_field_by_index(self):
        class FakeSample:
            def __getitem__(self, field_name):
                self.asserted_field = field_name
                return SimpleNamespace(
                    detections=[
                        SimpleNamespace(label="Mobile phone", bounding_box=[0.1, 0.2, 0.3, 0.4])
                    ]
                )

        sample = FakeSample()
        self.assertEqual(len(valid_target_detections(sample)), 1)
        self.assertEqual(sample.asserted_field, "ground_truth")

    def test_selects_unique_image_for_each_target_class(self):
        with TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            classes_path = root / "classes.csv"
            detections_path = root / "detections.csv"
            classes_path.write_text(
                "phone_id,Mobile phone\n"
                "mouse_id,Computer mouse\n",
                encoding="utf-8",
            )
            detections_path.write_text(
                "ImageID,LabelName\n"
                "phone_image,phone_id\n"
                "mouse_image,mouse_id\n",
                encoding="utf-8",
            )
            image_ids, counts = select_balanced_image_ids(
                classes_path, detections_path, per_class_limit=1, seed=42
            )
        self.assertEqual(len(image_ids), 2)
        self.assertTrue(all(count == 1 for count in counts.values()))

    def test_multilabel_image_counts_toward_each_class_quota(self):
        with TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            classes_path = root / "classes.csv"
            detections_path = root / "detections.csv"
            classes_path.write_text(
                "phone_id,Mobile phone\n"
                "mouse_id,Computer mouse\n",
                encoding="utf-8",
            )
            detections_path.write_text(
                "ImageID,LabelName\n"
                "shared,phone_id\n"
                "shared,mouse_id\n",
                encoding="utf-8",
            )
            image_ids, counts = select_balanced_image_ids(
                classes_path, detections_path, per_class_limit=1, seed=42
            )
        self.assertEqual(image_ids, ["shared"])
        self.assertTrue(all(count == 1 for count in counts.values()))

class ExportProfileTests(unittest.TestCase):
    def test_syncs_phone_specialist_to_new_tuklas_artifact(self):
        with TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            specialist_path = root / "yolo-phone-specialist-v1.json"
            specialist_path.write_text(
                json.dumps({"detectorRole": "phone-specialist", "scanRegions": []}),
                encoding="utf-8",
            )
            primary = {
                "version": "tuklas-phone-mouse-yolo11n-v2",
                "modelUrl": "/models/tuklas-yolo11n-phone-mouse-v2.onnx",
                "sha256": "abc123",
                "inputSize": 640,
                "negativeConfidenceThresholds": {"mouse": 0.15},
                "classNames": ["mobile_phone", "mouse"],
            }
            self.assertEqual(sync_phone_specialist_manifest(root, primary), specialist_path)
            specialist = json.loads(specialist_path.read_text(encoding="utf-8"))
            self.assertEqual(specialist["sha256"], "abc123")
            self.assertEqual(specialist["classNames"], ["mobile_phone", "mouse"])
            self.assertEqual(specialist["negativeMappings"], {"mouse": "mouse"})

    def test_sanitizes_local_user_paths_from_onnx_metadata(self):
        import onnx
        from onnx import TensorProto, helper

        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "model.onnx"
            graph = helper.make_graph(
                [],
                "test",
                [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1])],
                [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1])],
            )
            model = helper.make_model(graph)
            metadata = model.metadata_props.add()
            metadata.key = "description"
            metadata.value = r"trained at C:\Users\Example\models\best.pt"
            onnx.save(model, path)

            self.assertTrue(sanitize_onnx_metadata(path))
            saved = onnx.load(path, load_external_data=False)
            self.assertNotIn(r"C:\Users\Example", saved.metadata_props[0].value)
            self.assertIn("<user-home>", saved.metadata_props[0].value)

    def test_resolves_versioned_model_url(self):
        models_dir = Path("public/models")
        actual = resolve_model_path(
            {"modelUrl": "/models/yolo11n.onnx?version=yolo11n-coco-v1"},
            models_dir,
        )
        self.assertEqual(actual, models_dir / "yolo11n.onnx")

    def test_detects_tuklas_profile(self):
        self.assertEqual(detect_profile(sorted(TUKLAS_CLASS_NAMES), "auto"), "tuklas")

    def test_detects_coco_profile(self):
        classes = sorted(set(COCO_POLICY_MAPPINGS) | {"person", "chair"})
        self.assertEqual(detect_profile(classes, "auto"), "coco")

    def test_rejects_incomplete_custom_profile(self):
        with self.assertRaises(ValueError):
            detect_profile(["mobile_phone"], "auto")


class ProductionDatasetTests(unittest.TestCase):
    def test_rejects_smoke_dataset_for_production_training(self):
        audit = {
            "splits": {
                split: {
                    "images_by_class": {name: 5 for name in TRAINED_CLASS_NAMES}
                }
                for split in ("train", "val", "test")
            }
        }
        with self.assertRaises(ValueError):
            validate_dataset_scale(audit)

    def test_allows_explicit_smoke_training_override(self):
        validate_dataset_scale({"splits": {}}, allow_small_dataset=True)

    def test_rejects_weak_open_images_metrics(self):
        report = self._production_report()
        report["test_metrics"]["per_class"]["mobile_phone"]["recall"] = 0.2
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "report.json"
            path.write_text(json.dumps(report), encoding="utf-8")
            with self.assertRaises(ValueError):
                validate_training_report(path)

    def test_rejects_phone_model_below_strict_recall_gate(self):
        report = self._production_report()
        report["test_metrics"]["per_class"]["mobile_phone"]["recall"] = 0.84
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "report.json"
            path.write_text(json.dumps(report), encoding="utf-8")
            with self.assertRaises(ValueError):
                validate_training_report(path)

    def test_accepts_production_scale_and_metrics(self):
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "report.json"
            path.write_text(json.dumps(self._production_report()), encoding="utf-8")
            validate_training_report(path)

    @staticmethod
    def _production_report():
        class_names = TRAINED_CLASS_NAMES
        return {
            "dataset_audit": {
                split: {
                    "images_by_class": {
                        name: 500 if split == "train" else 75
                        for name in class_names
                    }
                }
                for split in ("train", "val", "test")
            },
            "test_metrics": {
                "per_class": {
                    name: {
                        "precision": 0.85 if name == "mobile_phone" else 0.8,
                        "recall": 0.9 if name == "mobile_phone" else 0.8,
                    }
                    for name in class_names
                }
            },
        }


if __name__ == "__main__":
    unittest.main()
