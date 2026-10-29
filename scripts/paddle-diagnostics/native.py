#!/usr/bin/env python3
"""run the pinned Paddle FP16 model locally and record raw output tokens

use --download once after setup and --export-prompts for CPU tokenization
use --manifest or --image for CUDA inference with downloads disabled
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import platform
import re
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache/paddle-accuracy"
MODEL_ID = "PaddlePaddle/PaddleOCR-VL-1.6"
REVISION = "66317acc4c9fc17bd154591ce650735cd2855f3e"
MODEL = CACHE / f"native-model-{REVISION}"
BROWSER_MODEL = ROOT / ".model-cache/glebkudr/PaddleOCR-VL-1.6-WebGPU/resolve/5219606297d00bbd23b2ec193271af0c0b427dfc"
TOKENIZER_SHA256 = "c8a215a59183d0d0781adc33bacd3ce6162716f7fd568fb30234a74d69803a7d"
MODEL_SHA256 = "85a479d506a11e724e7285d395c551be69f41dbc16b6342d3cacfb189aed71db"
PROFILES = {
    "nativeFormula": "Formula Recognition:",
    "faithfulFormula": "Formula Recognition:\nTranscribe exactly. Preserve bold symbols, accents, subscripts, and superscripts. Output only LaTeX.",
    "conciseFormula": "Formula Recognition:\nOutput only LaTeX.",
    "nativeOCR": "OCR:",
    "faithfulOCR": "OCR:\nTranscribe exactly. Preserve prose and LaTeX math delimiters. Preserve bold symbols, accents, subscripts, and superscripts.",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def render_chat(prompt: str) -> str:
    return ("<|begin_of_sentence|>User: <|IMAGE_START|>"
            f"<|IMAGE_PLACEHOLDER|><|IMAGE_END|>{prompt}\nAssistant:\n")


def stop_reason(tokens: list[int], eos_ids: list[int], limit: int) -> str:
    if tokens and tokens[-1] in eos_ids:
        return "eos"
    return "max_tokens" if len(tokens) >= limit else "other"


def case_task(case: dict, fallback: str) -> str:
    return case.get("task", {"equation": "formula", "mixed": "ocr", "text": "ocr"}.get(case.get("kind"), fallback))


def recognition_request(case: dict, fallback: str, profile: str | None = None,
                        prompt: str | None = None) -> tuple[str, str]:
    task = ("ocr" if profile.endswith("OCR") else "formula") if profile else case_task(case, fallback)
    instruction = prompt if prompt is not None else PROFILES[profile] if profile else case.get(
        "prompt", "OCR:" if task == "ocr" else "Formula Recognition:")
    return task, instruction


def load_image(path: Path):
    from PIL import Image
    with Image.open(path) as source:
        source_mode = source.mode
        has_alpha = "A" in source.getbands() or "transparency" in source.info
        if has_alpha:
            rgba = source.convert("RGBA")
            white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            image = Image.alpha_composite(white, rgba).convert("RGB")
        else:
            image = source.convert("RGB")
    return image, {"sourceMode": source_mode, "alphaCompositedOnWhite": has_alpha}


def load_cases(manifest: Path) -> list[dict]:
    value = json.loads(manifest.read_text(encoding="utf-8-sig"))
    items = value if isinstance(value, list) else value["cases"]
    cases = []
    for item in items:
        image_value = item.get("image", item.get("imagePath"))
        expected_sha = image_value.get("sha256") if isinstance(image_value, dict) else None
        if isinstance(image_value, dict):
            image_value = image_value["file"]
        image = Path(image_value)
        if not image.is_absolute():
            relative = manifest.parent / image
            image = relative if relative.exists() else ROOT / image
        image = image.resolve(strict=True)
        if expected_sha and sha256(image) != expected_sha:
            raise ValueError(f"Manifest input SHA256 mismatch: {image}")
        cases.append({**item, "id": item.get("id", item.get("case", image.stem)),
                      "image": image.resolve(strict=True)})
    return cases


def download_model() -> None:
    """verify small files by Hub git-object SHA1 and LFS files by published SHA256"""
    CACHE.mkdir(parents=True, exist_ok=True)
    url = f"https://huggingface.co/api/models/{MODEL_ID}/revision/{REVISION}?blobs=true"
    with urllib.request.urlopen(url, timeout=120) as response:
        metadata = json.load(response)
    if metadata["sha"] != REVISION:
        raise ValueError("Hub resolved a different revision")
    write_json(CACHE / "native-hub-metadata.json", metadata)
    MODEL.mkdir(parents=True, exist_ok=True)
    names = {"LICENSE", "README.md", "config.json", "generation_config.json",
             "preprocessor_config.json", "processor_config.json", "tokenizer.json",
             "tokenizer.model", "tokenizer_config.json", "special_tokens_map.json",
             "added_tokens.json", "chat_template.jinja", "model.safetensors"}

    def fetch(entry):
        name = entry["rfilename"]
        path = MODEL / name
        lfs = entry.get("lfs")

        def valid(candidate):
            if not candidate.exists():
                return False
            if lfs:
                return candidate.stat().st_size == lfs["size"] and sha256(candidate) == lfs["sha256"]
            data = candidate.read_bytes()
            return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest() == entry["blobId"]

        if not valid(path):
            temporary = path.with_name(path.name + ".download")
            source_url = f"https://huggingface.co/{MODEL_ID}/resolve/{REVISION}/{name}"
            with urllib.request.urlopen(source_url, timeout=180) as source, temporary.open("wb") as target:
                while block := source.read(8 * 1024 * 1024):
                    target.write(block)
            if not valid(temporary):
                raise ValueError(f"Published hash mismatch: {name}")
            temporary.replace(path)
        print(f"verified {name} ({path.stat().st_size} bytes)", flush=True)
        return {"file": name, "sha256": sha256(path), "bytes": path.stat().st_size,
                "publishedLfsSha256": lfs["sha256"] if lfs else None,
                "publishedGitBlobSha1": entry["blobId"]}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(fetch, [entry for entry in metadata["siblings"] if entry["rfilename"] in names]))
    write_json(MODEL / "verified-files.json", {"model": MODEL_ID, "revision": REVISION, "files": results})


def load_tokenizer():
    from transformers import AutoTokenizer
    tokenizer_path = MODEL / "tokenizer.json"
    if sha256(tokenizer_path) != TOKENIZER_SHA256:
        raise ValueError("Original tokenizer SHA256 mismatch")
    if sha256(BROWSER_MODEL / "m6e9-tokenizer.json") != TOKENIZER_SHA256:
        raise ValueError("Browser tokenizer differs from original tokenizer")
    return AutoTokenizer.from_pretrained(str(MODEL), trust_remote_code=False, local_files_only=True)


def browser_task_ids(task: str) -> list[int]:
    source = (ROOT / "public/paddle/paddleocr_vl_tasks.mjs").read_text(encoding="utf-8")
    match = re.search(rf"\b{task}:\s*Object\.freeze\(\{{.*?promptSuffixIds:\s*Object\.freeze\(\[(.*?)\]", source, re.S)
    if not match:
        raise ValueError(f"Browser task definition not found: {task}")
    return [int(value) for value in re.findall(r"\d+", match.group(1))]


def export_prompts(path: Path) -> None:
    tokenizer = load_tokenizer()
    profiles = {}
    for name, prompt in PROFILES.items():
        suffix = f"<|IMAGE_END|>{prompt}\nAssistant:\n"
        profiles[name] = {
            "task": "ocr" if name.endswith("OCR") else "formula",
            "text": prompt,
            "promptSuffixIds": tokenizer.encode(suffix, add_special_tokens=False),
            "textTokenIds": tokenizer.encode(prompt, add_special_tokens=False),
            "renderedChat": render_chat(prompt),
            "unexpandedChatTokenIds": tokenizer.encode(render_chat(prompt), add_special_tokens=False),
        }
    expected = {
        "nativeFormula": [101306, 59352, 93514, 93963, 23, 92267, 93963, 23],
        "nativeOCR": [101306, 93972, 2497, 93963, 23, 92267, 93963, 23],
    }
    for name, ids in expected.items():
        if profiles[name]["promptSuffixIds"] != ids:
            raise ValueError(f"Native {name} suffix differs from browser task IDs")
        if profiles[name]["promptSuffixIds"] != browser_task_ids(profiles[name]["task"]):
            raise ValueError(f"Native {name} suffix differs from actual public runtime source")
    write_json(path, {"version": 1, "modelRevision": REVISION, "tokenizerSha256": TOKENIZER_SHA256,
                      "browserTokenizerSha256": sha256(BROWSER_MODEL / "m6e9-tokenizer.json"),
                      "browserTaskDefinitionSha256": sha256(ROOT / "public/paddle/paddleocr_vl_tasks.mjs"),
                      "framing": {"prefix": "<|begin_of_sentence|>User: <|IMAGE_START|>",
                                  "prefixIds": tokenizer.encode("<|begin_of_sentence|>User: <|IMAGE_START|>", add_special_tokens=False),
                                  "imagePlaceholder": "<|IMAGE_PLACEHOLDER|>"},
                      "profiles": profiles})
    print(f"exported {len(profiles)} verified profiles: {path}", flush=True)


def package_versions() -> dict:
    return {name: importlib.metadata.version(name) for name in
            ("torch", "transformers", "tokenizers", "safetensors", "pillow", "numpy")}


def verify_report(path: Path) -> None:
    report = json.loads(path.read_text(encoding="utf-8"))
    if report["modelRevision"] != REVISION or report["tokenizerSha256"] != TOKENIZER_SHA256:
        raise ValueError("Native report uses an unexpected model/tokenizer")
    for case in report["cases"]:
        image = Path(case["image"])
        pixel = Path(case["pixels"]["file"])
        if sha256(image) != case["inputSha256"]:
            raise ValueError(f"Input changed after inference: {case['id']}")
        if sha256(pixel) != case["pixels"]["sha256"]:
            raise ValueError(f"Processor buffer changed: {case['id']}")
        if pixel.stat().st_size != 4 * math.prod(case["pixels"]["shape"]):
            raise ValueError(f"Processor buffer byte count disagrees with shape: {case['id']}")
        if case["stopReason"] != stop_reason(case["generatedTokenIds"], case["eosTokenIds"], report["maxGeneratedTokens"]):
            raise ValueError(f"Stop reason disagrees with raw output tokens: {case['id']}")
        if len(case["inputIds"]) != case["inputShapes"]["input_ids"][-1]:
            raise ValueError(f"Input token count disagrees with input shape: {case['id']}")
    print(json.dumps({"verifiedCases": len(report["cases"]), "reportSha256": sha256(path)}), flush=True)


def run(args) -> None:
    import torch
    from transformers import AutoModelForImageTextToText, AutoProcessor

    if not torch.cuda.is_available():
        raise RuntimeError("A CUDA GPU is required for native FP16 parity")
    if sha256(MODEL / "model.safetensors") != MODEL_SHA256:
        raise ValueError("Published checkpoint SHA256 mismatch")
    tokenizer = load_tokenizer()
    processor = AutoProcessor.from_pretrained(str(MODEL), trust_remote_code=False,
                                             local_files_only=True, backend="pil")
    if args.manifest:
        cases = load_cases(args.manifest.resolve(strict=True))
    else:
        cases = [{"id": args.image.stem, "image": args.image.resolve(strict=True), "task": args.task}]
    if args.cases:
        requested = set(args.cases.split(","))
        cases = [case for case in cases if case["id"] in requested]
        if {case["id"] for case in cases} != requested:
            raise ValueError("Unknown case in --cases")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    buffer_directory = args.out.parent / (args.out.stem + "-pixels")
    buffer_directory.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    model = AutoModelForImageTextToText.from_pretrained(
        str(MODEL), dtype=torch.float16, trust_remote_code=False,
        attn_implementation="sdpa", local_files_only=True).to("cuda").eval()
    torch.cuda.synchronize()
    load_seconds = time.perf_counter() - started
    eos = model.generation_config.eos_token_id
    eos_ids = eos if isinstance(eos, list) else [eos]
    report = {"version": 1, "model": MODEL_ID, "modelRevision": REVISION,
              "checkpointSha256": MODEL_SHA256, "tokenizerSha256": TOKENIZER_SHA256,
              "dtype": "float16", "attention": "sdpa", "decoding": "greedy",
              "imageProcessor": type(processor.image_processor).__name__,
              "packages": package_versions(), "python": platform.python_version(),
              "cudaVersion": torch.version.cuda, "gpu": torch.cuda.get_device_name(),
              "gpuCapability": list(torch.cuda.get_device_capability()),
              "loadSeconds": load_seconds, "maxGeneratedTokens": args.max_tokens,
              "cases": []}
    for case in cases:
        task, prompt = recognition_request(case, args.task, args.profile, args.prompt)
        image, image_decode = load_image(case["image"])
        t0 = time.perf_counter()
        processor_options = {"size": {"shortest_edge": args.min_pixels, "longest_edge": args.max_pixels}}
        inputs = processor(text=render_chat(prompt), images=image, return_tensors="pt", **processor_options)
        preprocessing_seconds = time.perf_counter() - t0
        ids = inputs["input_ids"][0].tolist()
        pixel = inputs["pixel_values"].detach().cpu().float().numpy().astype("<f4")
        pixel_path = buffer_directory / (case["id"].replace("/", "_").replace("\\", "_") + ".f32.bin")
        pixel.tofile(pixel_path)
        grid = {key: inputs[key].tolist() for key in ("image_grid_thw", "image_grid_hws", "image_sizes") if key in inputs}
        input_shapes = {key: list(value.shape) for key, value in inputs.items() if hasattr(value, "shape")}
        gpu_inputs = {key: value.to("cuda", dtype=torch.float16) if value.is_floating_point() else value.to("cuda")
                      for key, value in inputs.items()}
        torch.cuda.reset_peak_memory_stats()
        torch.cuda.synchronize()
        t0 = time.perf_counter()
        with torch.inference_mode():
            output = model.generate(**gpu_inputs, do_sample=False, num_beams=1,
                                    max_new_tokens=args.max_tokens, use_cache=True)
        torch.cuda.synchronize()
        generation_seconds = time.perf_counter() - t0
        generated = output[0, len(ids):].cpu().tolist()
        result = {"id": case["id"], "image": str(case["image"]), "inputSha256": sha256(case["image"]),
                  "imageSize": list(image.size), "imageDecode": image_decode,
                  "task": task,
                  "prompt": prompt, "profile": args.profile,
                  "minPixels": args.min_pixels, "maxPixels": args.max_pixels,
                  "inputIds": ids, "imageGrid": grid, "inputShapes": input_shapes,
                  "pixels": {"file": str(pixel_path.resolve()), "dtype": "float32-little-endian",
                             "shape": list(pixel.shape), "sha256": sha256(pixel_path),
                             "sample": pixel.reshape(-1)[:32].tolist()},
                  "generatedTokenIds": generated,
                  "rawDecoded": tokenizer.decode(generated, skip_special_tokens=False),
                  "text": tokenizer.decode(generated, skip_special_tokens=True),
                  "eosTokenIds": eos_ids, "stopReason": stop_reason(generated, eos_ids, args.max_tokens),
                  "preprocessingMs": preprocessing_seconds * 1000, "generationMs": generation_seconds * 1000,
                  "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
                  "peakReservedBytes": torch.cuda.max_memory_reserved()}
        report["cases"].append(result)
        write_json(args.out, report)
        print(json.dumps({"id": case["id"], "tokens": len(generated), "ms": round(generation_seconds*1000),
                          "stop": result["stopReason"], "text": result["text"]}, ensure_ascii=True), flush=True)
        del gpu_inputs, inputs, output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--export-prompts", type=Path)
    parser.add_argument("--verify-report", type=Path, help="Recheck input/buffer hashes, shapes and stop reasons without GPU use")
    parser.add_argument("--image", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--cases", help="Comma-separated manifest case IDs")
    parser.add_argument("--task", choices=("formula", "ocr"), default="formula")
    parser.add_argument("--profile", choices=tuple(PROFILES))
    parser.add_argument("--prompt")
    parser.add_argument("--min-pixels", type=int, default=112896)
    parser.add_argument("--max-pixels", type=int, default=1003520)
    parser.add_argument("--max-tokens", type=int, default=2048)
    parser.add_argument("--out", type=Path, default=ROOT / "artifacts/paddle-diagnostics/native.json")
    args = parser.parse_args()
    if args.min_pixels <= 0 or args.max_pixels < args.min_pixels:
        parser.error("Pixel bounds must satisfy 0 < min <= max")
    if not 1 <= args.max_tokens <= 2048:
        parser.error("--max-tokens must be between 1 and 2048")
    if args.image and args.manifest:
        parser.error("Choose --image or --manifest")
    if args.profile and args.prompt is not None:
        parser.error("Choose --profile or --prompt")
    if args.download:
        download_model()
    if args.export_prompts:
        export_prompts(args.export_prompts)
    if args.verify_report:
        verify_report(args.verify_report)
    if args.image or args.manifest:
        run(args)
    elif not args.download and not args.export_prompts and not args.verify_report:
        parser.error("Choose --download, --export-prompts, --verify-report, --image or --manifest")


if __name__ == "__main__":
    main()
