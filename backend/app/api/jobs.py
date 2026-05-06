import json
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from backend.app.services.job_store import (
    STATUS_PROCESSING,
    STATUS_UPLOADED,
    find_recent_job_records,
    find_job_records_by_status,
    make_queue_metadata,
    read_job_record,
)

router = APIRouter()


@router.get("/api/jobs")
def list_jobs(
    status: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
):
    try:
        job_records = find_recent_job_records(limit=limit, status=status)
    except ValueError:
        raise_job_error(
            status_code=400,
            error="invalid_job_status",
            message="Job status is not supported.",
            status=status,
        )

    # also include queue metadata for each job summary
    uploaded_jobs = find_job_records_by_status(STATUS_UPLOADED)
    processing_jobs = find_job_records_by_status(STATUS_PROCESSING)
    queue = make_queue_metadata(uploaded_jobs=uploaded_jobs, processing_jobs=processing_jobs)
    return {
        "jobs": [
            make_job_summary(
                job_record,
                uploaded_jobs=uploaded_jobs,
                processing_jobs=processing_jobs,
            )
            for job_record in job_records
        ],
        "count": len(job_records),
        "queue": queue,
    }


@router.get("/api/jobs/{upload_id}")
def get_job(upload_id: str):
    try:
        job_record = read_job_record(upload_id)
        return {
            **job_record,
            "queue": make_queue_metadata(job_record),
        }
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


def make_job_summary(
    job_record: dict[str, Any],
    uploaded_jobs: list[dict[str, Any]],
    processing_jobs: list[dict[str, Any]],
) -> dict[str, Any]:

    # return compact job data for list views
    job_input = job_record.get("input", {})
    return {
        "upload_id": job_record.get("upload_id"),
        "created_at": job_record.get("created_at"),
        "updated_at": job_record.get("updated_at"),
        "status": job_record.get("status"),
        "original_filename": job_input.get("original_filename"),
        "image_width": job_input.get("image_width"),
        "image_height": job_input.get("image_height"),
        "image_format": job_input.get("image_format"),
        "model": job_record.get("model"),
        "has_result": job_record.get("result") is not None,
        "error": job_record.get("error"),
        "queue": make_queue_metadata(
            job_record,
            uploaded_jobs=uploaded_jobs,
            processing_jobs=processing_jobs,
        ),
    }


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
