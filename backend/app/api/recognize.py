import re
from dataclasses import dataclass
from datetime import datetime
from io import BytesIO
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, File, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError


UPLOAD_DIR = Path("/tank/projects/TexImageScan/jobs/uploads")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 25_000_000
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
PROJECT_TIMEZONE = ZoneInfo("Europe/Berlin")

router = APIRouter()


@dataclass(frozen=True)
class ImageMetadata:
    width: int
    height: int
    format: str


@router.post("/api/recognize")
async def recognize(file: UploadFile = File(...)):
    content = await file.read()
    image_metadata = validate_upload(file.filename, content)
    job_time = make_job_time()

    # save the file and keep the random prefix as upload ID
    upload_id, saved_path = save_uploaded_file(file.filename, content, job_time)

    return {
        "upload_id": upload_id,
        "job_time": format_job_time(job_time),
        "filename": file.filename or "",
        "bytes_received": len(content),
        "image_width": image_metadata.width,
        "image_height": image_metadata.height,
        "image_format": image_metadata.format,
        "saved_image": str(saved_path),
        "latex": r"\text{model not connected yet}",
    }


def validate_upload(original_filename: str | None, content: bytes) -> ImageMetadata:

    # reject empty files before saving anything to disk
    if not content:
        raise HTTPException(
            status_code=400,
            detail="Uploaded file is empty.",
        )

    # check for valid file extension 
    suffix = Path(original_filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_EXTENSIONS))
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file extension. Use one of the supported types: {allowed}.",
        )

    # check for file size limit
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Uploaded file is too large. Maximum size of single files is 10 MB.",
        )

    # check that the uploaded file can be opened as an image
    try:
        with Image.open(BytesIO(content)) as image:
            image.verify()
            image_width = image.width
            image_height = image.height
            image_format = image.format or ""
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(
            status_code=400,
            detail="Uploaded file is not a valid image.",
        ) from exc

    # check for image dimension limit
    if image_width * image_height > MAX_IMAGE_PIXELS:
        raise HTTPException(
            status_code=413,
            detail="Uploaded image dimensions are too large. Maximum size is 25 megapixels.",
        )

    return ImageMetadata(
        width=image_width,
        height=image_height,
        format=image_format,
    )


def make_job_time() -> datetime:

    # create Berlin time stamp for this upload job
    return datetime.now(PROJECT_TIMEZONE).replace(microsecond=0)


def format_job_time(job_time: datetime) -> str:

    # return job time with timezone offset and second precision
    return job_time.isoformat(timespec="seconds")


def save_uploaded_file(
    original_filename: str | None,
    content: bytes,
    job_time: datetime,
) -> tuple[str, Path]:

    # save the file with an upload ID of random 64 bits (16 hex chars) as prefix
    upload_dir = make_upload_dir(job_time)
    upload_dir.mkdir(parents=True, exist_ok=True)
    safe_name = make_filename_safe(original_filename)

    # try multiple upload IDs before giving up
    for _ in range(10):
        upload_id = uuid4().hex[:16]
        saved_path = upload_dir / f"{upload_id}_{safe_name}"
        try:
            # create file only if it does not already exist
            with saved_path.open("xb") as upload_file:
                upload_file.write(content)
            return upload_id, saved_path
        except FileExistsError:
            continue

    raise HTTPException(
        status_code=500,
        detail="Could not create a unique upload filename.",
    )


def make_upload_dir(job_time: datetime) -> Path:

    # use Berlin job time stamp to group uploads by year, month, and day
    return UPLOAD_DIR / job_time.strftime("%Y") / job_time.strftime("%m") / job_time.strftime("%d")


def make_filename_safe(original_filename: str | None) -> str:

    # replace unwanted characters with underscores and ensure filename is not empty
    filename = Path(original_filename or "upload").name
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", filename)
    return safe_name or "upload"
