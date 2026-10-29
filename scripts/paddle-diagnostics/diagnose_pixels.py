#!/usr/bin/env python3
"""compare native and browser pixels after running the RGB decode probe

check source RGB, preprocessing and resized pixels separately from normalization
this command uses no model or GPU
"""
import argparse
import json
from pathlib import Path
import numpy as np
from PIL import Image
from native import ROOT, sha256, write_json
from compare_native import tensor_difference

def unpatch(values, grid):
    _, gh, gw = grid
    return values.reshape(gh, gw, 3, 14, 14).transpose(0, 3, 1, 4, 2).reshape(gh * 14, gw * 14, 3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--decode", type=Path, required=True, help="Report from decode-rgb.ts")
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--browser", type=Path, required=True, help="Browser run with --parity buffers")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    decode = json.loads(args.decode.read_text(encoding="utf-8"))
    native = json.loads(args.native.read_text(encoding="utf-8"))
    browser_path = args.browser
    browser = json.loads(browser_path.read_text(encoding="utf-8"))
    nc = {c["id"]: c for c in native["cases"]}
    bc = {c["id"]: c for c in browser["cases"]}
    rows = []
    for decoded in decode["cases"]:
        case_id = decoded["id"]
        ncase, bcase = nc[case_id], bc[case_id]
        image = Image.open(ROOT / decoded["sourceFile"]).convert("RGB")
        pillow_source = np.asarray(image).reshape(-1)
        chrome_source = np.fromfile(args.decode.parent / decoded["file"], dtype=np.uint8)
        source_diff = np.abs(pillow_source.astype(np.int16) - chrome_source.astype(np.int16))
        nvalues = np.fromfile(ncase["pixels"]["file"], dtype="<f4")
        bvalues = np.fromfile(browser_path.parent / bcase["preprocessing"]["file"], dtype="<f4")
        cpu_values = np.fromfile(args.decode.parent / decoded["pixelFile"], dtype="<f4")
        grid = decoded["grid"]
        n_rgb = np.rint((unpatch(nvalues, grid).astype(np.float64) + 1) * 255 / 2).astype(np.uint8)
        b_rgb = np.rint((unpatch(bvalues, grid).astype(np.float64) + 1) * 255 / 2).astype(np.uint8)
        rgb_diff = np.abs(n_rgb.astype(np.int16) - b_rgb.astype(np.int16))
        direct_pil = np.asarray(image.resize((grid[2] * 14, grid[1] * 14), Image.Resampling.BICUBIC))
        vertical_first = np.asarray(image.resize((image.width, grid[1] * 14), Image.Resampling.BICUBIC)
                                   .resize((grid[2] * 14, grid[1] * 14), Image.Resampling.BICUBIC))
        horizontal_first = np.asarray(image.resize((grid[2] * 14, image.height), Image.Resampling.BICUBIC)
                                     .resize((grid[2] * 14, grid[1] * 14), Image.Resampling.BICUBIC))
        # save large pixel differences for inspection without changing inference inputs
        if int(rgb_diff.max()) > 1:
            Image.fromarray(n_rgb).save(args.decode.parent / f"{case_id}.native-resized.png")
            Image.fromarray(b_rgb).save(args.decode.parent / f"{case_id}.browser-resized.png")
            Image.fromarray(np.clip(rgb_diff * 8, 0, 255).astype(np.uint8)).save(args.decode.parent / f"{case_id}.difference-x8.png")
        rows.append({"id": case_id, "sourceRgbEqual": bool(np.array_equal(pillow_source, chrome_source)),
                     "sourceRgbDifferentValues": int(np.count_nonzero(source_diff)),
                     "sourceRgbMaxAbs": int(source_diff.max()),
                     "nodeCpuVersusBrowserPixels": tensor_difference(cpu_values, bvalues, 0),
                     "resizedRgbDifferentValues": int(np.count_nonzero(rgb_diff)),
                     "resizedRgbValues": int(rgb_diff.size), "resizedRgbMaxAbs": int(rgb_diff.max()),
                     "nativeMatchesDirectPillow": bool(np.array_equal(n_rgb, direct_pil)),
                     "nativeDifferentFromHorizontalFirstValues": int(np.count_nonzero(n_rgb != horizontal_first)),
                     "nativeDifferentFromVerticalFirstValues": int(np.count_nonzero(n_rgb != vertical_first)),
                     "pillowPassOrder": "vertical-first" if image.height > grid[1] * 14 and
                        image.height - grid[1] * 14 > (image.width - grid[2] * 14) * 2 else "horizontal-first",
                     "browserDifferentFromHorizontalFirstValues": int(np.count_nonzero(b_rgb != horizontal_first)),
                     "browserDifferentFromVerticalFirstValues": int(np.count_nonzero(b_rgb != vertical_first)),
                     "pillowAxisOrderDifferentValues": int(np.count_nonzero(horizontal_first != vertical_first))})
    summary = {"cases": len(rows), "exactSourceRgb": sum(row["sourceRgbEqual"] for row in rows),
               "exactNodeCpuBrowserPixels": sum(row["nodeCpuVersusBrowserPixels"]["nonidenticalValues"] == 0 for row in rows),
               "nativeMatchesDirectPillow": sum(row["nativeMatchesDirectPillow"] for row in rows),
               "resizedRgbDifferentValues": sum(row["resizedRgbDifferentValues"] for row in rows),
               "resizedRgbValues": sum(row["resizedRgbValues"] for row in rows),
               "resizedRgbMaxAbs": max(row["resizedRgbMaxAbs"] for row in rows),
               "resizedRgbDifferentFraction": sum(row["resizedRgbDifferentValues"] for row in rows) /
                   sum(row["resizedRgbValues"] for row in rows)}
    write_json(args.out, {"version": 1, "summary": summary,
               "decodeReportSha256": sha256(args.decode),
               "nativeReportSha256": sha256(args.native),
               "browserReportSha256": sha256(browser_path),
               "cases": rows})
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
