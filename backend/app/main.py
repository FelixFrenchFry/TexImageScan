from fastapi import FastAPI

from backend.app.api.health import router as health_router
from backend.app.api.recognize import router as recognize_router


app = FastAPI(title="TexImageScan")
app.include_router(health_router)
app.include_router(recognize_router)
