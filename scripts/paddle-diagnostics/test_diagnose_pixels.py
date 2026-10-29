"""check pixel diagnostics against local reports without inference"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image


class PixelDiagnosticTests(unittest.TestCase):
    def test_reports_supplied_pixels_without_historical_conclusions(self):
        script = Path(__file__).with_name("diagnose_pixels.py").resolve()
        with tempfile.TemporaryDirectory(dir=script.parents[2] / ".cache/paddle-accuracy") as directory:
            root = Path(directory)
            Image.new("RGB", (14, 14), "white").save(root / "source.png")
            (root / "source.rgb").write_bytes(bytes([255]) * 588)
            pixels = np.ones(588, dtype="<f4")
            pixels.tofile(root / "native.f32")
            pixels.tofile(root / "cpu.f32")
            pixels[0] = -1
            pixels.tofile(root / "browser.f32")
            (root / "decoded.json").write_text(json.dumps({"cases": [{
                "id": "fixture", "sourceFile": str(root / "source.png"),
                "file": "source.rgb", "pixelFile": "cpu.f32", "grid": [1, 1, 1],
            }]}))
            (root / "native.json").write_text(json.dumps({"cases": [{
                "id": "fixture", "pixels": {"file": str(root / "native.f32")},
            }]}))
            (root / "browser.json").write_text(json.dumps({"cases": [{
                "id": "fixture", "preprocessing": {"file": "browser.f32"},
            }]}))
            output = root / "report.json"
            completed = subprocess.run([sys.executable, str(script),
                "--decode", str(root / "decoded.json"), "--native", str(root / "native.json"),
                "--browser", str(root / "browser.json"), "--out", str(output)],
                cwd=root, capture_output=True, text=True)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            report = json.loads(output.read_text())
            self.assertEqual(report["summary"]["cases"], 1)
            self.assertEqual(report["summary"]["exactSourceRgb"], 1)
            self.assertEqual(report["summary"]["exactNodeCpuBrowserPixels"], 0)
            self.assertEqual(report["summary"]["resizedRgbDifferentValues"], 1)
            self.assertEqual(report["summary"]["resizedRgbMaxAbs"], 255)
            self.assertNotIn("explanation", report)
            self.assertTrue((root / "fixture.difference-x8.png").is_file())


if __name__ == "__main__":
    unittest.main()
