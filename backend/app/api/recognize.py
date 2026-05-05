from fastapi import APIRouter, File, UploadFile


router = APIRouter()


@router.post("/api/recognize")
async def recognize(file: UploadFile = File(...)):
    content = await file.read()

    return {
        "filename": file.filename or "",
        "bytes_received": len(content),
        "latex": r"\text{model not connected yet}",
    }
