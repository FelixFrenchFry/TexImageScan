#!/usr/bin/env python3
"""CPU-only comparison of native and browser reports with verified float32 buffers

the default absolute tolerance is 1e-6 for normalized pixels in [-1, 1]
this allows float32 rounding and is smaller than one normalized RGB step of 2/255
it does not guarantee matching recognition output
grids, image IDs, prompt IDs and output token IDs require exact equality
native [patch, channel, 14, 14] and browser [patch, 588] tensors use the same
channel-major patch order with the channel and spatial dimensions flattened
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def sequence_difference(native, browser) -> dict:
    first = next((index for index, pair in enumerate(zip(native, browser)) if pair[0] != pair[1]), None)
    if first is None and len(native) != len(browser):
        first = min(len(native), len(browser))
    return {"equal": first is None, "nativeLength": len(native), "browserLength": len(browser),
            "firstDifferentIndex": first,
            "nativeAtDifference": native[first] if first is not None and first < len(native) else None,
            "browserAtDifference": browser[first] if first is not None and first < len(browser) else None}


def tensor_difference(native, browser, tolerance: float) -> dict:
    if native.shape != browser.shape:
        raise ValueError(f"Cannot compare different flattened tensor shapes: {native.shape} / {browser.shape}")
    if not np.isfinite(native).all() or not np.isfinite(browser).all():
        raise ValueError("Processor buffer has nonfinite values")
    difference = native.astype(np.float64) - browser.astype(np.float64)
    absolute = np.abs(difference)
    return {"values": int(native.size), "nonidenticalValues": int(np.count_nonzero(native != browser)),
            "valuesAboveTolerance": int(np.count_nonzero(absolute > tolerance)),
            "maxAbs": float(np.max(absolute, initial=0)),
            "rms": float(np.sqrt(np.mean(difference * difference))) if difference.size else 0.0,
            "meanAbs": float(np.mean(absolute)) if difference.size else 0.0,
            "maxEquivalentRgb8Steps": float(np.max(absolute, initial=0) * 255 / 2)}


def load_buffer(path: Path, expected_hash: str, shape: list[int]):
    if sha256(path) != expected_hash:
        raise ValueError(f"Processor buffer SHA256 mismatch: {path}")
    if path.stat().st_size != math.prod(shape) * 4:
        raise ValueError(f"Processor byte count disagrees with shape: {path}")
    return np.fromfile(path, dtype="<f4")


def compare_reports(native_path: Path, browser_path: Path, tolerance: float, expected_cases: int) -> dict:
    native = json.loads(native_path.read_text(encoding="utf-8"))
    browser = json.loads(browser_path.read_text(encoding="utf-8"))
    native_cases = {case["id"]: case for case in native["cases"]}
    browser_cases = {case["id"]: case for case in browser["cases"]}
    if len(native_cases) != len(native["cases"]) or len(browser_cases) != len(browser["cases"]):
        raise ValueError("Duplicate case ID in a parity report")
    if native_cases.keys() != browser_cases.keys() or len(native_cases) != expected_cases:
        raise ValueError(f"Expected {expected_cases} matching cases; native={len(native_cases)} browser={len(browser_cases)}")
    manifest_path = ROOT / browser["manifestPath"]
    if sha256(manifest_path) != browser["manifestSha256"]:
        raise ValueError("Browser input manifest SHA256 mismatch")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_cases = {case["id"]: case for case in manifest["cases"]}
    rows = []
    for case_id, ncase in native_cases.items():
        bcase = browser_cases[case_id]
        if bcase["outcome"]["status"] != "success":
            raise ValueError(f"Browser inference failed: {case_id}")
        browser_text = bcase["outcome"].get("rawText")
        if not isinstance(browser_text, str):
            raise ValueError(f"Browser rawText missing or invalid: {case_id}")
        native_stop_reason = ncase["stopReason"]
        browser_stop_reason = bcase["outcome"]["stopReason"]
        manifest_image = manifest_cases[case_id]["image"]
        image = ROOT / manifest_image["file"]
        if sha256(image) != manifest_image["sha256"] or manifest_image["sha256"] != ncase["inputSha256"]:
            raise ValueError(f"Native/browser source image SHA256 mismatch: {case_id}")
        npixels = ncase["pixels"]
        bpixels = bcase["preprocessing"]
        nshape = npixels["shape"]
        bshape = bpixels["pixelValuesShape"]
        # the browser flattens the channel and spatial dimensions within each patch
        shape_equal = nshape[0] == bshape[0] and math.prod(nshape[1:]) == math.prod(bshape[1:])
        if not shape_equal:
            raise ValueError(f"Native/browser patch shape mismatch: {case_id}: {nshape} / {bshape}")
        npixel_path = Path(npixels["file"])
        bpixel_path = browser_path.parent / bpixels["file"]
        nvalues = load_buffer(npixel_path, npixels["sha256"], nshape)
        bvalues = load_buffer(bpixel_path, bpixels["pixelSha256"], bshape)
        row = {"id": case_id, "inputSha256": ncase["inputSha256"],
               "gridEqual": ncase["imageGrid"]["image_grid_thw"][0] == bpixels["imageGridThw"],
               "nativeGrid": ncase["imageGrid"]["image_grid_thw"][0], "browserGrid": bpixels["imageGridThw"],
               "nativeShape": nshape, "browserShape": bshape,
               "patchShapeEquivalent": shape_equal,
               "inputIds": sequence_difference(ncase["inputIds"], bpixels["inputIds"]),
               "pixelBytesEqual": npixels["sha256"] == bpixels["pixelSha256"],
               "pixels": tensor_difference(nvalues, bvalues, tolerance),
               "outputTokens": sequence_difference(ncase["generatedTokenIds"], bcase["outcome"]["tokenIds"]),
               "outputTextEqual": ncase["text"] == browser_text,
               "nativeText": ncase["text"], "browserText": browser_text,
               "nativeStopReason": native_stop_reason, "browserStopReason": browser_stop_reason,
               "stopReasonEqual": (native_stop_reason == browser_stop_reason or
                                   {native_stop_reason, browser_stop_reason} == {"max_tokens", "max_steps"})}
        rows.append(row)
    total_values = sum(row["pixels"]["values"] for row in rows)
    summary = {"cases": len(rows), "exactGrids": sum(row["gridEqual"] for row in rows),
               "exactInputIds": sum(row["inputIds"]["equal"] for row in rows),
               "byteExactPixelBuffers": sum(row["pixelBytesEqual"] for row in rows),
               "pixelBuffersWithinTolerance": sum(row["pixels"]["valuesAboveTolerance"] == 0 for row in rows),
               "pixelValues": total_values,
               "nonidenticalPixelValues": sum(row["pixels"]["nonidenticalValues"] for row in rows),
               "pixelValuesAboveTolerance": sum(row["pixels"]["valuesAboveTolerance"] for row in rows),
               "pixelMaxAbs": max(row["pixels"]["maxAbs"] for row in rows),
               "pixelRms": math.sqrt(sum(row["pixels"]["rms"] ** 2 * row["pixels"]["values"] for row in rows) / total_values),
               "exactOutputTokens": sum(row["outputTokens"]["equal"] for row in rows),
               "exactOutputTexts": sum(row["outputTextEqual"] for row in rows),
               "equalStopReasons": sum(row["stopReasonEqual"] for row in rows)}
    return {"version": 1, "nativeReport": str(native_path.resolve()), "nativeReportSha256": sha256(native_path),
            "browserReport": str(browser_path.resolve()), "browserReportSha256": sha256(browser_path),
            "nativeModelRevision": native["modelRevision"], "browserModelRevision": browser["modelRevision"],
            "pixelTolerance": {"absolute": tolerance, "relative": 0,
                               "units": "normalized float32 RGB [-1,1]",
                               "explanation": "1e-6 permits float32 arithmetic rounding and is much less than 2/255, one normalized 8-bit RGB step. This is not a recognition-equivalence guarantee."},
            "summary": summary, "cases": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native", type=Path, default=ROOT / "artifacts/paddle-diagnostics/native.json")
    parser.add_argument("--browser", type=Path, default=ROOT / "artifacts/paddle-diagnostics/browser/baseline.json")
    parser.add_argument("--out", type=Path, default=ROOT / "artifacts/paddle-diagnostics/comparison.json")
    parser.add_argument("--abs-tolerance", type=float, default=1e-6)
    parser.add_argument("--expected-cases", type=int, default=16)
    args = parser.parse_args()
    if args.abs_tolerance < 0 or not math.isfinite(args.abs_tolerance):
        parser.error("Tolerance must be a finite nonnegative number")
    report = compare_reports(args.native, args.browser, args.abs_tolerance, args.expected_cases)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(report["summary"]), flush=True)


if __name__ == "__main__":
    main()
