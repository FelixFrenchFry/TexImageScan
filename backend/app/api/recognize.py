import re
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, UploadFile

UPLOAD_DIR = Path("/tank/projects/TexImageScan/jobs/uploads")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

router = APIRouter()



@router.post("/api/recognize")
async def recognize(file: UploadFile = File(...)):
    content = await file.read()
    validate_upload(file.filename, content)

    saved_path = save_uploaded_file(file.filename, content)

    return {
        "filename": file.filename or "",
        "bytes_received": len(content),
        "saved_image": str(saved_path),
        "latex": r"\text{model not connected yet}",
    }


def validate_upload(original_filename: str | None, content: bytes) -> None:

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


def save_uploaded_file(original_filename: str | None, content: bytes) -> Path:

    # save the file with a prefix of random 64 bits (16 hex chars) to avoid name collisions
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    saved_path = make_unique_upload_path(original_filename)
    saved_path.write_bytes(content)
    return saved_path


def make_unique_upload_path(original_filename: str | None) -> Path:

    # try multiple random prefixes to avoid overwriting an existing upload
    safe_name = make_filename_safe(original_filename)
    for _ in range(10):
        random_prefix = uuid4().hex[:16]
        saved_path = UPLOAD_DIR / f"{random_prefix}_{safe_name}"
        if not saved_path.exists():
            return saved_path

    raise HTTPException(
        status_code=500,
        detail="Could not create a unique upload filename.",
    )


def make_filename_safe(original_filename: str | None) -> str:

    # replace unwanted characters with underscores and ensure filename is not empty
    filename = Path(original_filename or "upload").name
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", filename)
    return safe_name or "upload"
