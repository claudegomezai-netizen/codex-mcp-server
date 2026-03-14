"""
Embodied AI - Local Inference Server
Runs HF models on Apple Silicon (MPS) for face generation, TTS, STT, etc.
"""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from services.face_gen import router as face_gen_router, load_model

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Loading models...")
    await asyncio.to_thread(load_model)
    logger.info("Models loaded.")
    yield
    logger.info("Shutting down.")


app = FastAPI(title="Embodied AI Inference Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8888", "http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(face_gen_router, prefix="/face")


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
