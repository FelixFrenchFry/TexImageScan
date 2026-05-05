import logging
import json
import re
from dataclasses import dataclass
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, File, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError


UPLOAD_DIR = Path("/tank/projects/TexImageScan/jobs/uploads")
OUTPUT_DIR = Path("/tank/projects/TexImageScan/jobs/outputs")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
FORMAT_EXTENSIONS = {
    "PNG": ".png",
    "JPEG": ".jpg",
    "WEBP": ".webp",
    "BMP": ".bmp",
}
FORMAT_ALLOWED_EXTENSIONS = {
    "PNG": {".png"},
    "JPEG": {".jpg", ".jpeg"},
    "WEBP": {".webp"},
    "BMP": {".bmp"},
}
PROJECT_TIMEZONE = ZoneInfo("Europe/Berlin")

router = APIRouter()
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ImageMetadata:
    width: int
    height: int
    format: str
    file_extension: str
    saved_extension: str


@router.post("/api/recognize")
async def recognize(file: UploadFile = File(...)):
    content = await file.read()
    image_metadata = validate_upload(file.filename, content)
    job_time = make_job_time()

    # save the file and keep the upload ID
    upload_id, saved_path = save_uploaded_file(file.filename, content, job_time, image_metadata)
    warnings = make_upload_warnings(image_metadata)
    output_json = save_placeholder_output(
        upload_id=upload_id,
        job_time=job_time,
        original_filename=file.filename or "",
        bytes_received=len(content),
        image_metadata=image_metadata,
        saved_image=saved_path,
        warnings=warnings,
    )

    return {
        "upload_id": upload_id,
        "job_time": format_job_time(job_time),
        "filename": file.filename or "",
        "bytes_received": len(content),
        "image_width": image_metadata.width,
        "image_height": image_metadata.height,
        "image_format": image_metadata.format,
        "file_extension": image_metadata.file_extension,
        "saved_extension": image_metadata.saved_extension,
        "saved_image": str(saved_path),
        "output_json": str(output_json),
        "warnings": warnings,
        "latex": r"\text{model not connected yet}",
    }


def validate_upload(original_filename: str | None, content: bytes) -> ImageMetadata:

    # reject empty files before saving anything to disk
    if not content:
        raise_upload_error(
            status_code=400,
            error="empty_file",
            message="Uploaded file is empty.",
            actual_bytes=len(content),
        )

    # check for valid file extension 
    suffix = Path(original_filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise_upload_error(
            status_code=400,
            error="unsupported_file_extension",
            message="Unsupported file extension.",
            file_extension=suffix,
            allowed_extensions=sorted(ALLOWED_EXTENSIONS),
        )

    # check for file size limit
    if len(content) > MAX_UPLOAD_BYTES:
        raise_upload_error(
            status_code=413,
            error="file_too_large",
            message="Uploaded file is too large.",
            actual_bytes=len(content),
            max_bytes=MAX_UPLOAD_BYTES,
        )

    # check that the uploaded file can be opened as an image
    # TODO: later create a separate normalized image with EXIF orientation applied, while keeping the original upload
    try:
        with Image.open(BytesIO(content)) as image:
            image.verify()
            image_width = image.width
            image_height = image.height
            image_format = image.format or ""
    except (UnidentifiedImageError, OSError):
        logger.warning("Pillow could not validate uploaded image.", exc_info=True)
        raise_upload_error(
            status_code=400,
            error="invalid_image",
            message="Uploaded file is not a valid image.",
            actual_bytes=len(content),
        )

    # check for image dimension limit
    if image_width * image_height > MAX_IMAGE_PIXELS:
        raise_upload_error(
            status_code=413,
            error="image_dimensions_too_large",
            message="Uploaded image dimensions are too large.",
            image_width=image_width,
            image_height=image_height,
            actual_pixels=image_width * image_height,
            max_pixels=MAX_IMAGE_PIXELS,
        )

    # check that detected image format can be mapped to a saved file extension
    saved_extension = FORMAT_EXTENSIONS.get(image_format)
    if saved_extension is None:
        raise_upload_error(
            status_code=400,
            error="unsupported_image_format",
            message="Unsupported detected image format.",
            image_format=image_format,
            supported_image_formats=sorted(FORMAT_EXTENSIONS),
        )

    return ImageMetadata(
        width=image_width,
        height=image_height,
        format=image_format,
        file_extension=suffix,
        saved_extension=saved_extension,
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
    image_metadata: ImageMetadata,
) -> tuple[str, Path]:

    # save the file with an upload ID of random 64 bits (16 hex chars) as prefix
    upload_dir = make_upload_dir(job_time)
    upload_dir.mkdir(parents=True, exist_ok=True)
    safe_stem = make_filename_safe_stem(original_filename)

    # try multiple upload IDs before giving up
    for _ in range(10):
        upload_id = uuid4().hex[:16]
        saved_path = upload_dir / f"{upload_id}_{safe_stem}{image_metadata.saved_extension}"
        try:
            # create file only if it does not already exist
            with saved_path.open("xb") as upload_file:
                upload_file.write(content)
            return upload_id, saved_path
        except FileExistsError:
            logger.warning("Upload filename collision for %s.", saved_path)
            continue

    logger.error("Could not create a unique upload filename after 10 attempts.")
    raise_upload_error(
        status_code=500,
        error="upload_filename_unavailable",
        message="Could not create a unique upload filename.",
    )


def make_upload_dir(job_time: datetime) -> Path:

    # use Berlin job time stamp to group uploads by year, month, and day
    return UPLOAD_DIR / job_time.strftime("%Y") / job_time.strftime("%m") / job_time.strftime("%d")


def make_output_dir(job_time: datetime) -> Path:

    # use Berlin job time stamp to group outputs by year, month, and day
    return OUTPUT_DIR / job_time.strftime("%Y") / job_time.strftime("%m") / job_time.strftime("%d")


def save_placeholder_output(
    upload_id: str,
    job_time: datetime,
    original_filename: str,
    bytes_received: int,
    image_metadata: ImageMetadata,
    saved_image: Path,
    warnings: list[dict[str, Any]],
) -> Path:

    # save placeholder output JSON using the same upload ID and job time
    output_dir = make_output_dir(job_time)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{upload_id}.json"

    payload = {
        "upload_id": upload_id,
        "job_time": format_job_time(job_time),
        "status": "uploaded",
        "input": {
            "original_filename": original_filename,
            "saved_image": str(saved_image),
            "bytes_received": bytes_received,
            "image_width": image_metadata.width,
            "image_height": image_metadata.height,
            "image_format": image_metadata.format,
            "file_extension": image_metadata.file_extension,
            "saved_extension": image_metadata.saved_extension,
        },
        "warnings": warnings,
        "result": {
            "latex": r"\text{model not connected yet}",
        },
    }

    output_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return output_path


def make_filename_safe_stem(original_filename: str | None) -> str:

    # replace unwanted characters with underscores and ensure filename stem is not empty
    filename_stem = Path(original_filename or "upload").stem
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", filename_stem)
    return safe_stem or "upload"


def make_upload_warnings(image_metadata: ImageMetadata) -> list[dict[str, Any]]:

    # return upload warnings without interrupting the operation
    allowed_extensions = FORMAT_ALLOWED_EXTENSIONS.get(image_metadata.format, set())
    if image_metadata.file_extension in allowed_extensions:
        return []

    return [
        {
            "warning": "image_format_extension_mismatch",
            "message": "File extension did not match detected image format. Saved using detected image format extension.",
            "file_extension": image_metadata.file_extension,
            "image_format": image_metadata.format,
            "saved_extension": image_metadata.saved_extension,
        }
    ]


def raise_upload_error(
    status_code: int,
    error: str,
    message: str,
    **details: Any,
) -> None:

    # return consistent upload error details to the frontend
    raise HTTPException(
        status_code=status_code,
        detail={
            "error": error,
            "message": message,
            **details,
        },
    )
