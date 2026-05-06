import logging
from time import sleep

from backend.app.services.job_store import (
    STATUS_COMPLETE,
    STATUS_FAILED,
    STATUS_PROCESSING,
    update_job_status,
)

logger = logging.getLogger(__name__)


def process_job(upload_id: str) -> None:

    # run fake recognition so the job status flow can be tested before the model is connected
    try:
        update_job_status(upload_id, STATUS_PROCESSING, "Recognition started.")
        sleep(1) # fake processing time
        update_job_status(
            upload_id,
            STATUS_COMPLETE,
            "Recognition completed.",
            result=make_fake_result(),
        )
    except Exception as exc:
        logger.exception("Recognition failed for upload ID %s.", upload_id)
        mark_job_failed(upload_id, exc)


def make_fake_result() -> dict[str, str]:

    # return stable fake output until real model inference is connected
    return {
        "raw_latex": r"\frac{a}{b}",
        "normalized_latex": r"\frac{a}{b}",
        "plain_text": "a divided by b",
    }


def mark_job_failed(upload_id: str, exc: Exception) -> None:

    # try to store background processing errors in the job record
    try:
        update_job_status(
            upload_id,
            STATUS_FAILED,
            "Recognition failed.",
            error={
                "error": "recognition_failed",
                "message": str(exc),
            },
        )
    except Exception:
        logger.exception("Could not mark upload ID %s as failed.", upload_id)
