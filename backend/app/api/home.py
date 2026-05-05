from fastapi import APIRouter


router = APIRouter()



@router.get("/")
def home():
    return {
        "name": "TexImageScan",
        "status": "backend running",
    }
