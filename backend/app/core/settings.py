from pathlib import Path
from zoneinfo import ZoneInfo

UPLOAD_DIR = Path("/tank/projects/TexImageScan/jobs/uploads")
OUTPUT_DIR = Path("/tank/projects/TexImageScan/jobs/outputs")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
PROJECT_TIMEZONE = ZoneInfo("Europe/Berlin")
