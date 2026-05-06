import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from backend.app.core.settings import OUTPUT_DIR, PROJECT_TIMEZONE

# keep allowed job status values in one place
STATUS_UPLOADED = "uploaded"
STATUS_PROCESSING = "processing"
STATUS_COMPLETE = "complete"
STATUS_FAILED = "failed"
JOB_STATUSES = (
    STATUS_UPLOADED,
    STATUS_PROCESSING,
    STATUS_COMPLETE,
    STATUS_FAILED,
)
UPLOAD_ID_PATTERN = re.compile(r"^[0-9a-fA-F]{16}$")

logger = logging.getLogger(__name__)


def create_job_record(
    upload_id: str,
    created_at: datetime,
    input_data: dict[str, Any],
    model_data: dict[str, Any],
    warnings: list[dict[str, Any]],
) -> tuple[Path, dict[str, Any]]:

    # create the first job record after the upload has been accepted
    normalized_upload_id = normalize_upload_id(upload_id)
    output_path = make_job_record_path(normalized_upload_id, created_at)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        raise FileExistsError(output_path)

    timestamp = format_job_time(created_at)
    job_record = {
        "upload_id": normalized_upload_id,
        "created_at": timestamp,
        "updated_at": timestamp,
        "status": STATUS_UPLOADED,
        "input": input_data,
        "model": model_data,
        "warnings": warnings,
        "events": [
            {
                "time": timestamp,
                "status": STATUS_UPLOADED,
                "message": "Upload accepted and saved.",
            }
        ],
        "result": None,
        "error": None,
    }

    write_job_record(output_path, job_record)
    return output_path, job_record


def read_job_record(upload_id: str) -> dict[str, Any]:
    job_record, _ = read_job_record_with_path(upload_id)
    return job_record


def read_job_record_with_path(upload_id: str) -> tuple[dict[str, Any], Path]:
    normalized_upload_id = normalize_upload_id(upload_id)
    output_path = find_job_record_path(normalized_upload_id)

    if output_path is None:
        raise FileNotFoundError(normalized_upload_id)

    return read_job_record_from_path(output_path), output_path


def read_job_record_from_path(output_path: Path) -> dict[str, Any]:

    # read the job record JSON from disk
    try:
        return json.loads(output_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        logger.error("Job output JSON is invalid: %s.", output_path, exc_info=True)
        raise
    except OSError:
        logger.error("Could not read job output JSON: %s.", output_path, exc_info=True)
        raise


def update_job_status(
    upload_id: str,
    status: str,
    message: str,
    result: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
    model: dict[str, Any] | None = None,
    updated_at: datetime | None = None,
) -> dict[str, Any]:
    job_record, output_path = read_job_record_with_path(upload_id)
    validated_status = validate_job_status(status)
    timestamp = format_job_time(updated_at or datetime.now(PROJECT_TIMEZONE).replace(microsecond=0))

    # update the job record and append a status event
    job_record["updated_at"] = timestamp
    job_record["status"] = validated_status
    job_record.setdefault("events", []).append(
        {
            "time": timestamp,
            "status": validated_status,
            "message": message,
        }
    )

    if result is not None:
        job_record["result"] = result

    if error is not None:
        job_record["error"] = error

    if model is not None:
        job_record["model"] = model

    write_job_record(output_path, job_record)
    return job_record


def write_job_record(output_path: Path, job_record: dict[str, Any]) -> None:

    # write to a temporary file first, then replace the real JSON file
    temp_path = output_path.with_name(f".{output_path.name}.{uuid4().hex}.tmp")
    try:
        temp_path.write_text(
            json.dumps(job_record, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        temp_path.replace(output_path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def normalize_upload_id(upload_id: str) -> str:

    # only accept upload IDs that look like the IDs we generate
    if not UPLOAD_ID_PATTERN.fullmatch(upload_id):
        raise ValueError("Upload ID must be exactly 16 hex characters.")

    return upload_id.lower()


def validate_job_status(status: str) -> str:

    # only accept known job status values
    if status not in JOB_STATUSES:
        raise ValueError("Unknown job status.")

    return status


def job_record_exists(upload_id: str) -> bool:
    return find_job_record_path(upload_id) is not None


def find_recent_job_records(limit: int, status: str | None = None) -> list[dict[str, Any]]:

    # find recent job records, optionally limited to one status
    if status is not None:
        status = validate_job_status(status)

    job_records = []
    for output_path in find_job_record_paths():
        try:
            job_record = read_job_record_from_path(output_path)
        except (json.JSONDecodeError, OSError):
            continue

        if status is not None and job_record.get("status") != status:
            continue

        job_records.append(job_record)

    return sort_job_records_newest_first(job_records)[:limit]


def find_job_records_by_status(status: str) -> list[dict[str, Any]]:

    # find job records with a specific status
    validated_status = validate_job_status(status)
    job_records = []

    for output_path in find_job_record_paths():
        try:
            job_record = read_job_record_from_path(output_path)
        except (json.JSONDecodeError, OSError):
            continue

        if job_record.get("status") == validated_status:
            job_records.append(job_record)

    return sort_job_records_oldest_first(job_records)


def make_queue_metadata(
    job_record: dict[str, Any] | None = None,
    uploaded_jobs: list[dict[str, Any]] | None = None,
    processing_jobs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:

    # describe the current file-based recognition queue
    if uploaded_jobs is None:
        uploaded_jobs = find_job_records_by_status(STATUS_UPLOADED)

    if processing_jobs is None:
        processing_jobs = find_job_records_by_status(STATUS_PROCESSING)

    queue_position = None
    waiting_jobs_before = None

    if job_record is not None and job_record.get("status") == STATUS_UPLOADED:
        upload_id = job_record.get("upload_id")
        for index, uploaded_job in enumerate(uploaded_jobs, start=1):
            if uploaded_job.get("upload_id") == upload_id:
                queue_position = index
                waiting_jobs_before = index - 1
                break

    return {
        "pending_jobs": len(uploaded_jobs) + len(processing_jobs),
        "uploaded_jobs": len(uploaded_jobs),
        "processing_jobs": len(processing_jobs),
        "queue_position": queue_position,
        "waiting_jobs_before": waiting_jobs_before,
    }


def sort_job_records_oldest_first(job_records: list[dict[str, Any]]) -> list[dict[str, Any]]:

    # process older uploads before newer uploads
    return sorted(job_records, key=make_oldest_first_sort_key)


def sort_job_records_newest_first(job_records: list[dict[str, Any]]) -> list[dict[str, Any]]:

    # show newer jobs first in API lists
    return sorted(job_records, key=make_newest_first_sort_key, reverse=True)


def make_oldest_first_sort_key(job_record: dict[str, Any]) -> tuple[datetime, str]:

    # use upload time first and upload ID as a stable tie breaker
    created_at = parse_job_time(
        job_record.get("created_at"),
        fallback=datetime.max.replace(tzinfo=PROJECT_TIMEZONE),
    )
    upload_id = str(job_record.get("upload_id", ""))
    return created_at, upload_id


def make_newest_first_sort_key(job_record: dict[str, Any]) -> tuple[datetime, str]:

    # use upload time first and upload ID as a stable tie breaker
    created_at = parse_job_time(
        job_record.get("created_at"),
        fallback=datetime.min.replace(tzinfo=PROJECT_TIMEZONE),
    )
    upload_id = str(job_record.get("upload_id", ""))
    return created_at, upload_id


def parse_job_time(value: Any, fallback: datetime) -> datetime:

    # parse job timestamps stored in JSON records
    if not isinstance(value, str):
        return fallback

    try:
        parsed_time = datetime.fromisoformat(value)
    except ValueError:
        return fallback

    if parsed_time.tzinfo is None:
        return parsed_time.replace(tzinfo=PROJECT_TIMEZONE)

    return parsed_time


def find_job_record_paths() -> list[Path]:

    # search year/month/day output folders for job records
    return sorted(OUTPUT_DIR.glob("*/*/*/*.json"))


def make_job_record_path(upload_id: str, created_at: datetime) -> Path:
    return make_output_dir(created_at) / f"{upload_id}.json"


def find_job_record_path(upload_id: str) -> Path | None:

    # search year/month/day output folders for this upload ID
    matches = sorted(OUTPUT_DIR.glob(f"*/*/*/{upload_id}.json"))
    if not matches:
        return None

    if len(matches) > 1:
        logger.warning("Found multiple output JSON files for upload ID %s.", upload_id)

    return matches[0]


def make_output_dir(created_at: datetime) -> Path:

    # use Berlin job time stamp to group outputs by year/month/day
    return OUTPUT_DIR / created_at.strftime("%Y") / created_at.strftime("%m") / created_at.strftime("%d")


def format_job_time(job_time: datetime) -> str:

    # return job time with timezone offset and second precision
    return job_time.isoformat(timespec="seconds")
