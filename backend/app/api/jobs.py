import json
import logging
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.app.core.settings import OUTPUT_DIR

UPLOAD_ID_PATTERN = re.compile(r"^[0-9a-fA-F]{16}$")

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/api/jobs/{upload_id}")
def get_job(upload_id: str):
    normalized_upload_id = normalize_upload_id(upload_id)
    output_path = find_output_json(normalized_upload_id)

    if output_path is None:
        raise_job_error(
            status_code=404,
            error="job_not_found",
            message="Job was not found.",
            upload_id=normalized_upload_id,
        )

    # read the job record JSON that was created by the upload endpoint
    try:
        return json.loads(output_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        logger.error("Job output JSON is invalid: %s.", output_path, exc_info=True)
        raise_job_error(
            status_code=500,
            error="job_record_invalid",
            message="Job record exists but is not valid JSON.",
            upload_id=normalized_upload_id,
        )
    except OSError:
        logger.error("Could not read job output JSON: %s.", output_path, exc_info=True)
        raise_job_error(
            status_code=500,
            error="job_record_unreadable",
            message="Job record exists but could not be read.",
            upload_id=normalized_upload_id,
        )


def normalize_upload_id(upload_id: str) -> str:

    # only accept upload IDs that look like the IDs we generate
    if not UPLOAD_ID_PATTERN.fullmatch(upload_id):
        raise_job_error(
            status_code=400,
            error="invalid_upload_id",
            message="Upload ID must be exactly 16 hex characters.",
            upload_id=upload_id,
        )

    return upload_id.lower()


def find_output_json(upload_id: str) -> Path | None:

    # search year/month/day output folders for this upload ID
    matches = sorted(OUTPUT_DIR.glob(f"*/*/*/{upload_id}.json"))
    if not matches:
        return None

    if len(matches) > 1:
        logger.warning("Found multiple output JSON files for upload ID %s.", upload_id)

    return matches[0]


def raise_job_error(
    status_code: int,
    error: str,
    message: str,
    **details: Any,
) -> None:

    # return consistent job lookup error details to the frontend
    raise HTTPException(
        status_code=status_code,
        detail={
            "error": error,
            "message": message,
            **details,
        },
    )
