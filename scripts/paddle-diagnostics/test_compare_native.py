"""check numeric, text and token differences in the CPU parity comparator"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("compare_native", Path(__file__).with_name("compare_native.py"))
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)


class ParityComparatorTests(unittest.TestCase):
    def setUp(self):
        import numpy as np
        temporary = tempfile.TemporaryDirectory(dir=compare.ROOT / ".cache")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        source = self.root / "source.bin"
        source.write_bytes(b"local source fixture")
        self.pixels = self.root / "pixels.f32"
        np.zeros(588, dtype="<f4").tofile(self.pixels)
        image_hash, pixel_hash = compare.sha256(source), compare.sha256(self.pixels)
        case_id = "new-math-crop"
        manifest = self.root / "manifest.json"
        manifest.write_text(json.dumps({"cases": [{"id": case_id, "kind": "equation",
            "image": {"file": source.name, "sha256": image_hash}}]}))
        self.native_case = {
            "id": case_id, "inputSha256": image_hash,
            "pixels": {"file": str(self.pixels), "sha256": pixel_hash, "shape": [1, 3, 14, 14]},
            "imageGrid": {"image_grid_thw": [[1, 1, 1]]}, "inputIds": [1, 7],
            "generatedTokenIds": [21, 2], "text": "x=1", "stopReason": "eos",
        }
        self.browser_case = {"id": case_id, "preprocessing": {"file": self.pixels.name,
            "pixelSha256": pixel_hash, "pixelValuesShape": [1, 588],
            "imageGridThw": [1, 1, 1], "inputIds": [1, 7]},
            "outcome": {"status": "success", "tokenIds": [21, 2],
                "rawText": "x=1", "output": r"\[x=1\]", "stopReason": "eos"}}
        self.manifest = manifest

    def run_comparison(self):
        native, browser = self.root / "native.json", self.root / "browser.json"
        native.write_text(json.dumps({"modelRevision": "native-fixture", "cases": [self.native_case]}))
        browser.write_text(json.dumps({"modelRevision": "browser-fixture",
            "manifestPath": self.manifest.name, "manifestSha256": compare.sha256(self.manifest),
            "cases": [self.browser_case]}))
        with patch.object(compare, "ROOT", self.root):
            return compare.compare_reports(native, browser, 1e-6, 1)

    def test_new_case_parity_is_independent_of_historical_migration_reports(self):
        historical = self.root / "artifacts/paddle-migration/paddle-equation.json"
        historical.parent.mkdir(parents=True)
        historical.write_text(json.dumps({"summary": {"cases": [{"id": "old-crop",
            "outcome": {"output": "y=2"}}]}}))
        report = self.run_comparison()
        historical.write_text("invalid historical JSON")
        self.assertEqual(self.run_comparison(), report)
        historical.unlink()
        self.assertEqual(self.run_comparison(), report)
        self.assertEqual(report["summary"]["exactOutputTokens"], 1)
        self.assertEqual(report["summary"]["byteExactPixelBuffers"], 1)
        self.assertNotIn("migrationSourceHashes", report)
        self.pixels.write_bytes(b"corrupted pixels")
        with self.assertRaisesRegex(ValueError, "buffer SHA256 mismatch"):
            self.run_comparison()

    def test_compares_raw_text_without_display_wrappers_or_whitespace_normalization(self):
        for native_text, raw_text, equal in [
            ("x=1", "x=1", True),
            ("x=1", "y=2", False),
            ("x=1", " x=1 ", False),
            ("x=1", r"\[x=1\]", False),
            ("", "", True),
        ]:
            with self.subTest(native_text=native_text, raw_text=raw_text):
                self.native_case["text"] = native_text
                self.browser_case["outcome"]["rawText"] = raw_text
                report = self.run_comparison()
                row = report["cases"][0]
                self.assertEqual(row["outputTextEqual"], equal)
                self.assertEqual(row["nativeText"], native_text)
                self.assertEqual(row["browserText"], raw_text)
                self.assertEqual(report["summary"]["exactOutputTexts"], int(equal))

    def test_requires_raw_text_instead_of_falling_back_to_display_output(self):
        for value in [None, 21, ["x=1"]]:
            with self.subTest(raw_text=value):
                self.browser_case["outcome"]["rawText"] = value
                with self.assertRaisesRegex(ValueError, "rawText.*new-math-crop"):
                    self.run_comparison()
        del self.browser_case["outcome"]["rawText"]
        with self.assertRaisesRegex(ValueError, "rawText.*new-math-crop"):
            self.run_comparison()

    def test_only_token_limit_stop_reason_aliases_are_equivalent(self):
        for native_reason, browser_reason, equal in [
            ("max_tokens", "max_steps", True),
            ("eos", "eos", True),
            ("other", "other", True),
            ("eos", "max_steps", False),
            ("max_tokens", "eos", False),
            ("max_tokens", "capacity_exhausted", False),
            ("other", "capacity_exhausted", False),
        ]:
            with self.subTest(native_reason=native_reason, browser_reason=browser_reason):
                self.native_case["stopReason"] = native_reason
                self.browser_case["outcome"]["stopReason"] = browser_reason
                report = self.run_comparison()
                row = report["cases"][0]
                self.assertEqual(row["stopReasonEqual"], equal)
                self.assertEqual(row.get("nativeStopReason"), native_reason)
                self.assertEqual(row.get("browserStopReason"), browser_reason)
                self.assertEqual(report["summary"]["equalStopReasons"], int(equal))

    def test_numeric_difference_counts_and_rms(self):
        import numpy as np
        result = compare.tensor_difference(np.array([0, 1, -1], dtype="<f4"),
                                           np.array([0, 1.25, -0.5], dtype="<f4"), 0.3)
        self.assertEqual(result["nonidenticalValues"], 2)
        self.assertEqual(result["valuesAboveTolerance"], 1)
        self.assertEqual(result["maxAbs"], 0.5)
        self.assertAlmostEqual(result["rms"], (0.3125 / 3) ** 0.5)

    def test_token_first_difference_reports_eos_length_mismatch(self):
        result = compare.sequence_difference([1, 2, 3], [1, 2])
        self.assertFalse(result["equal"])
        self.assertEqual(result["firstDifferentIndex"], 2)
        self.assertEqual(result["nativeLength"], 3)
        self.assertEqual(result["browserLength"], 2)


if __name__ == "__main__":
    unittest.main()
