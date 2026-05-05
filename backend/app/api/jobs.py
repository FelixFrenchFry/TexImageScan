import json
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.app.services.job_store import read_job_record

router = APIRouter()


@router.get("/api/jobs/{upload_id}")
def get_job(upload_id: str):
    try:
        return read_job_record(upload_id)
    except ValueError:
        raise_job_error(
            status_code=400,
            error="invalid_upload_id",
            message="Upload ID must be exactly 16 hex characters.",
            upload_id=upload_id,
        )
    except FileNotFoundError:
        raise_job_error(
            status_code=404,
            error="job_not_found",
            message="Job was not found.",
            upload_id=upload_id,
        )
    except json.JSONDecodeError:
        raise_job_error(
            status_code=500,
            error="job_record_invalid",
            message="Job record exists but is not valid JSON.",
            upload_id=upload_id,
        )
    except OSError:
        raise_job_error(
            status_code=500,
            error="job_record_unreadable",
            message="Job record exists but could not be read.",
            upload_id=upload_id,
        )


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
