import argparse
import logging
from pathlib import Path
from time import sleep
from typing import Any

from backend.app.core.settings import (
    UNIMERNET_MODEL_NAME,
    UNIMERNET_WORKER_POLL_SECONDS,
)
from backend.app.model_runners.unimernet_runner import UniMERNetRunner
from backend.app.services.job_store import (
    STATUS_COMPLETE,
    STATUS_FAILED,
    STATUS_PROCESSING,
    STATUS_UPLOADED,
    find_job_records_by_status,
    update_job_status,
)

logger = logging.getLogger(__name__)


def run_worker(poll_seconds: float, once: bool) -> None:

    # load the model once, then keep polling for uploaded jobs
    runner = UniMERNetRunner()
    logger.info("UniMERNet worker started.")

    while True:
        processed_count = process_uploaded_jobs(runner)

        if once:
            logger.info("One-shot worker run finished after %s job(s).", processed_count)
            return

        if processed_count == 0:
            sleep(poll_seconds)


def process_uploaded_jobs(runner: UniMERNetRunner) -> int:

    # process all uploaded jobs requested for UniMERNet
    processed_count = 0
    for job_record in find_job_records_by_status(STATUS_UPLOADED):
        if not should_process_job(job_record):
            continue

        process_job(job_record, runner)
        processed_count += 1

    return processed_count


def should_process_job(job_record: dict[str, Any]) -> bool:

    # only process jobs that requested this model
    model_data = job_record.get("model", {})
    requested_model = model_data.get("requested", UNIMERNET_MODEL_NAME)
    return requested_model == UNIMERNET_MODEL_NAME


def process_job(job_record: dict[str, Any], runner: UniMERNetRunner) -> None:
    upload_id = job_record["upload_id"]
    requested_model = job_record.get("model", {}).get("requested", UNIMERNET_MODEL_NAME)

    try:
        saved_image = get_saved_image(job_record)
        logger.info("Processing upload ID %s with UniMERNet.", upload_id)
        update_job_status(upload_id, STATUS_PROCESSING, "Recognition started.")

        prediction = runner.predict_image(saved_image)
        update_job_status(
            upload_id,
            STATUS_COMPLETE,
            "Recognition completed.",
            result=prediction.to_result(),
            error=None,
            model=prediction.to_model_data(requested_model),
        )
        logger.info("Completed upload ID %s in %s ms.", upload_id, prediction.elapsed_ms)
    except Exception as exc:
        logger.exception("Recognition failed for upload ID %s.", upload_id)
        mark_job_failed(upload_id, requested_model, exc)


def get_saved_image(job_record: dict[str, Any]) -> Path:

    # get the image path saved by the upload endpoint
    saved_image = job_record.get("input", {}).get("saved_image")
    if not saved_image:
        raise ValueError("Job record does not contain a saved image path.")

    return Path(saved_image)


def mark_job_failed(upload_id: str, requested_model: str, exc: Exception) -> None:

    # store recognition errors in the job record
    update_job_status(
        upload_id,
        STATUS_FAILED,
        "Recognition failed.",
        error={
            "error": "recognition_failed",
            "message": str(exc),
        },
        model={
            "requested": requested_model,
            "used": UNIMERNET_MODEL_NAME,
            "runtime": None,
            "device": None,
            "elapsed_ms": None,
            "model_dir": None,
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=UNIMERNET_WORKER_POLL_SECONDS,
        help="Seconds to wait before checking for uploaded jobs again",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Process currently uploaded jobs once, then exit",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Python logging level",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    run_worker(poll_seconds=args.poll_seconds, once=args.once)


if __name__ == "__main__":
    main()
