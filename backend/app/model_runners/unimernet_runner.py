import argparse
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

os.environ.setdefault("NO_ALBUMENTATIONS_UPDATE", "1")

import torch
from PIL import Image

from unimernet.common.config import Config
from unimernet.processors import load_processor
import unimernet.tasks as tasks

from backend.app.core.settings import (
    UNIMERNET_DEVICE,
    UNIMERNET_IMAGE_SIZE,
    UNIMERNET_MAX_SEQ_LEN,
    UNIMERNET_MODEL_DIR,
    UNIMERNET_MODEL_NAME,
    UNIMERNET_PRETRAINED_PATH,
    UNIMERNET_PROCESSOR_NAME,
    UNIMERNET_RUNTIME,
    UNIMERNET_RUNTIME_CONFIG_PATH,
    UNIMERNET_TOKENIZER_DIR,
)


@dataclass(frozen=True)
class UniMERNetPrediction:
    raw_latex: str
    elapsed_ms: float
    device: str
    model_dir: str
    model_name: str = UNIMERNET_MODEL_NAME
    runtime: str = UNIMERNET_RUNTIME

    def to_result(self) -> dict[str, Any]:
        return {
            "raw_latex": self.raw_latex,
            "normalized_latex": self.raw_latex,
            "plain_text": None,
        }

    def to_model_data(self, requested_model: str) -> dict[str, Any]:
        return {
            "requested": requested_model,
            "used": self.model_name,
            "runtime": self.runtime,
            "device": self.device,
            "elapsed_ms": self.elapsed_ms,
            "model_dir": self.model_dir,
        }


class UniMERNetRunner:
    def __init__(self) -> None:

        # load UniMERNet once and reuse it for every prediction
        self.config_path = write_unimernet_runtime_config()
        self.cfg, self.model, self.vis_processor, self.device = build_model(self.config_path)

    def predict_image(self, image_path: str | Path) -> UniMERNetPrediction:

        # run one image through the loaded model
        image_tensor = preprocess_image(self.vis_processor, self.device, image_path)
        synchronize_device(self.device)

        start = time.perf_counter()
        with torch.inference_mode():
            output = self.model.generate({"image": image_tensor})
        synchronize_device(self.device)

        elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
        raw_latex = output["pred_str"][0]

        return UniMERNetPrediction(
            raw_latex=raw_latex,
            elapsed_ms=elapsed_ms,
            device=str(self.device),
            model_dir=str(self.cfg.config.model.model_config.model_name),
        )


def build_model(config_path: Path):

    # build the model, processor, and device from the generated UniMERNet config
    args = argparse.Namespace(cfg_path=str(config_path), options=None)
    cfg = Config(args)
    device = choose_device()

    task = tasks.setup_task(cfg)
    model = task.build_model(cfg).to(device)
    model.eval()

    vis_processor = load_processor(
        UNIMERNET_PROCESSOR_NAME,
        cfg.config.datasets.formula_rec_eval.vis_processor.eval,
    )

    return cfg, model, vis_processor, device


def choose_device() -> torch.device:

    # use Intel XPU when available, otherwise fall back to CPU
    if UNIMERNET_DEVICE == "xpu" and hasattr(torch, "xpu") and torch.xpu.is_available():
        return torch.device("xpu")

    return torch.device("cpu")


def preprocess_image(vis_processor, device: torch.device, image_path: str | Path):

    # load and preprocess one saved upload image
    with Image.open(image_path) as raw_image:
        image = vis_processor(raw_image.convert("RGB")).unsqueeze(0).to(device)

    return image


def synchronize_device(device: torch.device) -> None:

    # make timing more accurate on asynchronous accelerator devices
    if device.type == "xpu":
        torch.xpu.synchronize()


def write_unimernet_runtime_config() -> Path:

    # write the UniMERNet library config from project settings
    validate_unimernet_files()
    config_path = UNIMERNET_RUNTIME_CONFIG_PATH
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(make_unimernet_config_text(), encoding="utf-8")
    return config_path


def validate_unimernet_files() -> None:

    # fail early if model files are missing
    if not UNIMERNET_MODEL_DIR.exists():
        raise FileNotFoundError(f"UniMERNet model directory not found: {UNIMERNET_MODEL_DIR}")

    if not UNIMERNET_PRETRAINED_PATH.exists():
        raise FileNotFoundError(f"UniMERNet weights not found: {UNIMERNET_PRETRAINED_PATH}")


def make_unimernet_config_text() -> str:

    # create the YAML text expected by the UniMERNet package
    image_height, image_width = UNIMERNET_IMAGE_SIZE
    return f"""model:
  arch: unimernet
  model_type: unimernet

  model_config:
    model_name: {UNIMERNET_MODEL_DIR}
    max_seq_len: {UNIMERNET_MAX_SEQ_LEN}

  load_pretrained: True
  pretrained: {UNIMERNET_PRETRAINED_PATH}

  tokenizer_config:
    path: {UNIMERNET_TOKENIZER_DIR}

datasets:
  formula_rec_eval:
    vis_processor:
      eval:
        name: "{UNIMERNET_PROCESSOR_NAME}"
        image_size: [{image_height}, {image_width}]

run:
  runner: runner_iter
  task: unimernet_train
  batch_size_train: 1
  batch_size_eval: 1
  num_workers: 1
  iters_per_inner_epoch: 1
  max_iters: 1
  seed: 42
  output_dir: "/tank/projects/TexImageScan/appdata/unimernet-test-output"
  evaluate: True
  test_splits: ["eval"]
  device: "{UNIMERNET_DEVICE}"
  world_size: 1
  dist_url: "env://"
  distributed: False
  distributed_type: ddp
  generate_cfg:
    temperature: 0.0
"""
