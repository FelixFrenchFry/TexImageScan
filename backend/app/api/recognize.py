import re
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError


UPLOAD_DIR = Path("/tank/projects/TexImageScan/jobs/uploads")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

router = APIRouter()


@router.post("/api/recognize")
async def recognize(file: UploadFile = File(...)):
    content = await file.read()
    validate_upload(file.filename, content)

    # save the file and keep the random prefix as upload ID
    upload_id, saved_path = save_uploaded_file(file.filename, content)

    return {
        "upload_id": upload_id,
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

    # check that the uploaded file can be opened as an image
    try:
        Image.open(BytesIO(content)).verify()
    except UnidentifiedImageError as exc:
        raise HTTPException(
            status_code=400,
            detail="Uploaded file is not a valid image.",
        ) from exc


def save_uploaded_file(original_filename: str | None, content: bytes) -> tuple[str, Path]:

    # save the file with an upload ID of random 64 bits (16 hex chars) as prefix
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = make_filename_safe(original_filename)

    # try multiple upload IDs before giving up
    for _ in range(10):
        upload_id = uuid4().hex[:16]
        saved_path = UPLOAD_DIR / f"{upload_id}_{safe_name}"
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


def make_filename_safe(original_filename: str | None) -> str:

    # replace unwanted characters with underscores and ensure filename is not empty
    filename = Path(original_filename or "upload").name
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", filename)
    return safe_name or "upload"
