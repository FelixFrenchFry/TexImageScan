from pathlib import Path
from zoneinfo import ZoneInfo

APPDATA_DIR = Path("/tank/projects/TexImageScan/appdata")
UPLOAD_DIR = Path("/tank/projects/TexImageScan/jobs/uploads")
OUTPUT_DIR = Path("/tank/projects/TexImageScan/jobs/outputs")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
PROJECT_TIMEZONE = ZoneInfo("Europe/Berlin")

# model selection
DEFAULT_RECOGNITION_MODEL = "unimernet_base"

# UniMERNet model configuration
UNIMERNET_MODEL_NAME = "unimernet_base"
UNIMERNET_RUNTIME = "pytorch_xpu"
UNIMERNET_DEVICE = "xpu"
UNIMERNET_MODEL_DIR = Path("/tank/projects/TexImageScan/models/unimernet_base")
UNIMERNET_PRETRAINED_PATH = UNIMERNET_MODEL_DIR / "pytorch_model.pth"
UNIMERNET_TOKENIZER_DIR = UNIMERNET_MODEL_DIR
UNIMERNET_RUNTIME_CONFIG_PATH = APPDATA_DIR / "unimernet" / "unimernet_base_xpu.yaml"
UNIMERNET_PROCESSOR_NAME = "formula_image_eval"
UNIMERNET_IMAGE_SIZE = (192, 672)
UNIMERNET_MAX_SEQ_LEN = 1536
UNIMERNET_WORKER_POLL_SECONDS = 1.0
