"""check native experiment inputs and provenance without loading model dependencies"""
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("native", Path(__file__).with_name("native.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeContractTests(unittest.TestCase):
    def test_chat_template_preserves_exact_prompt(self):
        self.assertEqual(native.render_chat("Formula Recognition:\nOutput only LaTeX."),
                         "<|begin_of_sentence|>User: <|IMAGE_START|><|IMAGE_PLACEHOLDER|><|IMAGE_END|>Formula Recognition:\nOutput only LaTeX.\nAssistant:\n")

    def test_native_profiles_and_faithful_prompts_are_explicit(self):
        self.assertEqual(native.PROFILES["nativeFormula"], "Formula Recognition:")
        self.assertEqual(native.PROFILES["nativeOCR"], "OCR:")
        self.assertIn("bold symbols, accents, subscripts, and superscripts", native.PROFILES["faithfulFormula"])
        self.assertIn("delimiters", native.PROFILES["faithfulOCR"])

    def test_manifest_resolves_image_relative_to_manifest_not_cwd(self):
        native.CACHE.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=native.CACHE) as directory:
            base = Path(directory)
            (base / "images").mkdir()
            image = base / "images/case.png"
            image.write_bytes(b"pixels")
            manifest = base / "cases.json"
            manifest.write_text('{"cases":[{"id":"case","image":"images/case.png","task":"formula"}]}')
            cases = native.load_cases(manifest)
            self.assertEqual(cases[0]["image"], image.resolve())
            self.assertEqual(cases[0]["id"], "case")

    def test_stop_reason_distinguishes_eos_and_token_limit(self):
        self.assertEqual(native.stop_reason([3, 4], [4], 2), "eos")
        self.assertEqual(native.stop_reason([3, 4], [5], 2), "max_tokens")
        self.assertEqual(native.stop_reason([3], [5], 2), "other")

    def test_manifest_kind_selects_native_task(self):
        self.assertEqual(native.case_task({"kind": "equation"}, "ocr"), "formula")
        self.assertEqual(native.case_task({"kind": "mixed"}, "formula"), "ocr")
        self.assertEqual(native.case_task({"kind": "text"}, "formula"), "ocr")
        self.assertEqual(native.case_task({"task": "ocr", "kind": "equation"}, "formula"), "ocr")

    def test_profile_selects_actual_task_and_overrides_manifest_prompt(self):
        self.assertEqual(native.recognition_request({"kind": "equation", "prompt": "stale"}, "formula", "nativeOCR"),
                         ("ocr", "OCR:"))
        self.assertEqual(native.recognition_request({"kind": "text"}, "ocr", "conciseFormula"),
                         ("formula", native.PROFILES["conciseFormula"]))

    def test_transparent_input_is_composited_over_white(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow is available in the native venv")
        native.CACHE.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=native.CACHE) as directory:
            image = Path(directory) / "transparent.png"
            Image.new("RGBA", (1, 1), (0, 0, 0, 0)).save(image)
            rgb, metadata = native.load_image(image)
            self.assertEqual(rgb.getpixel((0, 0)), (255, 255, 255))
            self.assertTrue(metadata["alphaCompositedOnWhite"])


if __name__ == "__main__":
    unittest.main()
