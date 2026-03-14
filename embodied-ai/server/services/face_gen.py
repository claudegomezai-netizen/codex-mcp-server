"""
Face generation using SDXL-Lightning on Apple Silicon (MPS).
Uses ByteDance's 4-step distilled model for fast generation (~6x faster than base SDXL).
Generates photorealistic faces from text prompts built by the frontend slider UI.
"""
import base64
import io
import logging
import time
from typing import Optional

import torch
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

# Global pipeline reference
_pipeline = None


def get_device():
    """Get the best available device for inference."""
    if torch.backends.mps.is_available():
        return "mps"
    elif torch.cuda.is_available():
        return "cuda"
    return "cpu"


def load_model():
    """Load SDXL-Lightning 4-step pipeline. Called once at startup."""
    global _pipeline
    from diffusers import StableDiffusionXLPipeline, EulerDiscreteScheduler, UNet2DConditionModel
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file

    device = get_device()
    base_model = "stabilityai/stable-diffusion-xl-base-1.0"
    lightning_repo = "ByteDance/SDXL-Lightning"
    lightning_ckpt = "sdxl_lightning_4step_unet.safetensors"

    logger.info(f"Loading SDXL-Lightning (4-step) on {device}...")

    # Download the Lightning UNet checkpoint
    logger.info("Downloading SDXL-Lightning 4-step UNet checkpoint...")
    ckpt_path = hf_hub_download(lightning_repo, lightning_ckpt)
    logger.info(f"Checkpoint downloaded: {ckpt_path}")

    if device == "cuda":
        # CUDA: use float16 for speed
        unet = UNet2DConditionModel.from_config(base_model, subfolder="unet").to("cuda", torch.float16)
        unet.load_state_dict(load_file(ckpt_path, device="cuda"))
        _pipeline = StableDiffusionXLPipeline.from_pretrained(
            base_model, unet=unet, torch_dtype=torch.float16, variant="fp16"
        ).to("cuda")
    else:
        # MPS and CPU: use float32 (MPS produces black images with float16)
        unet = UNet2DConditionModel.from_config(base_model, subfolder="unet").to("cpu", torch.float32)
        unet.load_state_dict(load_file(ckpt_path, device="cpu"))
        _pipeline = StableDiffusionXLPipeline.from_pretrained(
            base_model, unet=unet, torch_dtype=torch.float32, use_safetensors=True
        )
        if device == "mps":
            _pipeline = _pipeline.to("mps")
            _pipeline.enable_attention_slicing()
            _pipeline.enable_vae_slicing()
            logger.info("Loaded in float32 for MPS compatibility")
        else:
            logger.warning("Running on CPU - generation will be slow")

    # SDXL-Lightning requires EulerDiscreteScheduler with trailing timesteps
    _pipeline.scheduler = EulerDiscreteScheduler.from_config(
        _pipeline.scheduler.config, timestep_spacing="trailing"
    )

    logger.info("SDXL-Lightning 4-step loaded successfully.")


class FaceGenerateRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = (
        "blurry, low quality, distorted, deformed, ugly, bad anatomy, "
        "watermark, text, signature, cartoon, anime, illustration, painting, "
        "3d render, cgi, doll, plastic, mannequin"
    )
    width: int = 512
    height: int = 512
    num_inference_steps: int = 4
    guidance_scale: float = 0.0
    seed: Optional[int] = None


class FaceGenerateResponse(BaseModel):
    image_base64: str
    prompt_used: str
    generation_time_ms: int
    seed: int


@router.post("/generate", response_model=FaceGenerateResponse)
async def generate_face(request: FaceGenerateRequest):
    """Generate a photorealistic face from a text prompt."""
    if _pipeline is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    # Cap size at 512 for MPS float32 memory constraints
    if get_device() == "mps":
        request.width = min(request.width, 512)
        request.height = min(request.height, 512)

    # SDXL-Lightning must use exactly 4 steps and guidance_scale=0
    request.num_inference_steps = 4
    request.guidance_scale = 0.0

    # Build the full prompt with face-specific quality boosters
    full_prompt = (
        f"professional portrait photograph, {request.prompt}, "
        "sharp focus, high resolution, studio lighting, 8k uhd, "
        "photorealistic, detailed skin texture, DSLR photo"
    )

    # Set seed for reproducibility
    if request.seed is not None:
        generator = torch.Generator(device=get_device()).manual_seed(request.seed)
        seed_used = request.seed
    else:
        seed_used = torch.randint(0, 2**32 - 1, (1,)).item()
        generator = torch.Generator(device=get_device()).manual_seed(seed_used)

    logger.info(f"Generating face: seed={seed_used}, steps={request.num_inference_steps}")
    start = time.time()

    try:
        result = await _run_pipeline(
            prompt=full_prompt,
            negative_prompt=request.negative_prompt,
            width=request.width,
            height=request.height,
            num_inference_steps=request.num_inference_steps,
            guidance_scale=request.guidance_scale,
            generator=generator,
        )
    except Exception as e:
        logger.error(f"Generation failed: {e}")
        raise HTTPException(status_code=500, detail=f"Generation failed: {str(e)}")

    elapsed_ms = int((time.time() - start) * 1000)
    logger.info(f"Generated in {elapsed_ms}ms")

    # Convert to base64
    image = result.images[0]
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    image_b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")

    return FaceGenerateResponse(
        image_base64=image_b64,
        prompt_used=full_prompt,
        generation_time_ms=elapsed_ms,
        seed=seed_used,
    )


async def _run_pipeline(**kwargs):
    """Run the diffusion pipeline in a thread to avoid blocking the event loop."""
    import asyncio

    def _generate():
        with torch.no_grad():
            return _pipeline(**kwargs)

    return await asyncio.to_thread(_generate)
