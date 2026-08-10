"""Generation queue: sequential jobs, SSE progress, moderation gate, outbox
hand-off. Prompts and reference images live only in memory for the life of a
job — the server never persists them in plaintext."""
import asyncio
import base64
import io
import math
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

from . import config, events, moderation, runner_manager
from .auth import AUTHED, valid_token_str
from .registry import get_model
from .util import new_id, path_inside

router = APIRouter(prefix="/api", tags=["jobs"])

_queue: list[dict] = []
_history: list[dict] = []
_current: Optional[dict] = None
_worker_task: Optional[asyncio.Task] = None
_wakeup = asyncio.Event()


class LoraRef(BaseModel):
    file: str
    strength: float = Field(1.0, ge=-2.0, le=2.0)
    high_strength: Optional[float] = Field(None, ge=0.0, le=2.0)
    low_strength: Optional[float] = Field(None, ge=0.0, le=2.0)


class GenerateBody(BaseModel):
    model_id: str
    prompt: str = Field(..., max_length=8000)
    negative_prompt: str = Field("", max_length=8000)
    steps: int = Field(..., ge=1, le=200)
    cfg: float = Field(..., ge=0, le=30)
    width: int = Field(..., ge=64, le=2048)
    height: int = Field(..., ge=64, le=2048)
    seed: int = -1
    loras: list[LoraRef] = Field(default_factory=list)
    ref_image_b64: Optional[str] = None  # plaintext, transient, for edit/I2V models
    video_tier: Optional[str] = None
    video_aspect: Optional[str] = None
    num_frames: Optional[int] = Field(None, ge=1, le=81)
    fps: Optional[int] = Field(None, ge=1, le=60)


def _public_job(job: dict) -> dict:
    return {k: job[k] for k in
            ("id", "model_id", "status", "created", "prompt", "steps", "width", "height", "seed",
             "error", "result_id", "asset_id", "mime", "video_tier", "video_aspect", "num_frames", "fps")
            if k in job}


def _publish_job(job: dict) -> None:
    events.publish({"type": "job", "job": _public_job(job)})


@router.post("/generate", dependencies=[AUTHED])
async def submit(body: GenerateBody):
    model = get_model(body.model_id)
    is_video = model["kind"] == "img2video"
    # Latent/patch constraints vary per model (Z-Image/Qwen need multiples of
    # 16). Auto-round instead of rejecting — e.g. FHD 1080 becomes 1072.
    mult = int(model.get("dim_multiple", 16))
    def _snap(v: int) -> int:  # nearest multiple, ties toward the smaller (1080 -> 1072)
        return max(64, min(2048, (2 * v + mult - 1) // (2 * mult) * mult))
    width, height = _snap(body.width), _snap(body.height)
    if model["kind"] in ("edit", "img2video") and not body.ref_image_b64:
        raise HTTPException(400, "This model requires a reference image")
    lora_defaults = model.get("lora_defaults", {})
    if is_video and len(body.loras) > lora_defaults.get("max_stack", 4):
        raise HTTPException(400, f"Wan supports at most {lora_defaults.get('max_stack', 4)} stacked LoRAs")
    lora_files = []
    for lora in body.loras:
        p = config.LORAS_DIR / lora.file
        if not path_inside(config.LORAS_DIR, p) or not p.exists():
            raise HTTPException(400, f"Unknown LoRA: {lora.file}")
        if is_video:
            lora_files.append({
                "path": str(p),
                "high_strength": lora.high_strength if lora.high_strength is not None else lora_defaults.get("high_strength", 0.7),
                "low_strength": lora.low_strength if lora.low_strength is not None else lora_defaults.get("low_strength", 0.5),
            })
        else:
            lora_files.append({"path": str(p), "strength": lora.strength})
    ref_bytes = None
    if body.ref_image_b64:
        try:
            ref_bytes = base64.b64decode(body.ref_image_b64, validate=True)
        except (ValueError, TypeError):
            raise HTTPException(400, "Invalid reference image base64")
        if len(ref_bytes) > 32 * 1024 * 1024:
            raise HTTPException(413, "Reference image too large")
        if is_video:
            try:
                with Image.open(io.BytesIO(ref_bytes)) as image:
                    if image.format not in {"PNG", "JPEG", "WEBP"}:
                        raise HTTPException(400, "Reference image must be a valid PNG, JPEG, or WebP")
                    source_width, source_height = image.size
                    if source_width * source_height > 64_000_000:
                        raise HTTPException(413, "Reference image has too many pixels")
                    image.verify()
            except HTTPException:
                raise
            except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError):
                raise HTTPException(400, "Reference image must be a valid PNG, JPEG, or WebP")

            tiers = model["video"]["tiers"]
            video_tier = body.video_tier or model["defaults"]["video_tier"]
            if video_tier not in tiers:
                raise HTTPException(400, f"video_tier must be one of: {', '.join(tiers)}")
            video_aspect = body.video_aspect or model["defaults"].get("video_aspect", "source")
            if video_aspect not in ("source", "9:16"):
                raise HTTPException(400, "video_aspect must be source or 9:16")
            area = tiers[video_tier]
            if video_aspect == "9:16":
                unit = int(math.sqrt(area / (9 * 16))) // mult * mult
                width, height = 9 * unit, 16 * unit
            else:
                aspect = source_height / source_width
                height = round(math.sqrt(area * aspect)) // mult * mult
                width = round(math.sqrt(area / aspect)) // mult * mult
            if min(width, height) < 64 or max(width, height) > 2048:
                raise HTTPException(400, "Reference image aspect ratio is too extreme for Wan video")
        if moderation.is_enabled():
            verdict = await asyncio.to_thread(moderation.check_image, ref_bytes)
            if not verdict["allowed"]:
                raise HTTPException(422, "Reference image blocked by moderation")
    defaults = model["defaults"]
    job = {
        "id": new_id(),
        "model_id": body.model_id,
        "status": "queued",
        "created": time.time(),
        "prompt": body.prompt,
        "negative_prompt": body.negative_prompt,
        "steps": defaults["steps"] if is_video else body.steps,
        "cfg": defaults["cfg"] if is_video else body.cfg,
        "width": width,
        "height": height,
        "seed": body.seed,
        "loras": lora_files,
        "ref_bytes": ref_bytes,
    }
    if is_video:
        job.update({
            "video_tier": video_tier,
            "video_aspect": video_aspect,
            "num_frames": defaults["num_frames"],
            "fps": defaults["fps"],
            "mime": model["output_mime"],
        })
    _queue.append(job)
    _publish_job(job)
    _ensure_worker()
    _wakeup.set()
    return {"job": _public_job(job), "position": len(_queue)}


def _ensure_worker() -> None:
    global _worker_task
    if _worker_task is None or _worker_task.done():
        _worker_task = asyncio.get_running_loop().create_task(_worker())


async def _worker() -> None:
    global _current
    while True:
        if not _queue:
            _wakeup.clear()
            try:
                await asyncio.wait_for(_wakeup.wait(), timeout=300)
            except asyncio.TimeoutError:
                return  # idle; a new submit re-creates the worker
            continue
        job = _queue.pop(0)
        _current = job
        job["status"] = "starting"
        _publish_job(job)
        model = get_model(job["model_id"])
        try:
            await runner_manager.start_runner(job["model_id"])
            job["status"] = "running"
            _publish_job(job)

            def on_step(ev: dict) -> None:
                events.publish({"type": "step", "job_id": job["id"],
                                "step": ev.get("step"), "total": ev.get("total"),
                                "preview_b64": ev.get("preview_b64"), "stage": ev.get("stage")})

            params = {
                "prompt": job["prompt"],
                "negative_prompt": job["negative_prompt"],
                "steps": job["steps"],
                "cfg": job["cfg"],
                "width": job["width"],
                "height": job["height"],
                "seed": job["seed"],
                "loras": job["loras"],
            }
            if job["ref_bytes"]:
                params["ref_image_b64"] = base64.b64encode(job["ref_bytes"]).decode()
            if model["kind"] == "img2video":
                params.update({"num_frames": job["num_frames"], "fps": job["fps"],
                               "video_tier": job["video_tier"], "video_aspect": job["video_aspect"]})
            final = await runner_manager.generate(params, on_step)

            if final.get("type") == "done":
                mime = final.get("mime", "image/png")
                if mime not in ("image/png", "video/mp4"):
                    raise RuntimeError(f"Runner returned unsupported media type: {mime}")
                media = base64.b64decode(final.get("media_b64") or final["image_b64"], validate=True)
                job["seed"] = final.get("seed", job["seed"])
                if moderation.is_enabled():
                    moderation_bytes = media
                    if mime == "video/mp4":
                        preview = final.get("moderation_b64")
                        if not preview:
                            raise RuntimeError("Video runner did not provide frames for moderation")
                        moderation_bytes = base64.b64decode(preview, validate=True)
                    verdict = await asyncio.to_thread(moderation.check_image, moderation_bytes)
                    if not verdict["allowed"]:
                        job["status"] = "blocked"
                        job["error"] = "Output blocked by moderation filter"
                        _finish(job)
                        continue
                result_id = new_id()
                meta = {
                    "job_id": job["id"], "model_id": job["model_id"],
                    "prompt": job["prompt"], "seed": job["seed"],
                    "steps": job["steps"], "cfg": job["cfg"],
                    "width": job["width"], "height": job["height"], "mime": mime,
                }
                if mime == "video/mp4":
                    meta.update({"fps": job["fps"], "num_frames": job["num_frames"],
                                 "video_tier": job["video_tier"],
                                 "video_aspect": job["video_aspect"],
                                 "distilled_profile": model["distilled_experts"]["name"],
                                 "lora_strengths": [
                                     {"high": lora["high_strength"], "low": lora["low_strength"]}
                                     for lora in job["loras"]
                                 ]})
                runner_manager.outbox_put(result_id, media, meta, mime)
                job["status"] = "done"
                job["result_id"] = result_id
                job["mime"] = mime
            elif final.get("type") == "cancelled":
                job["status"] = "cancelled"
            else:
                job["status"] = "error"
                error = str(final.get("error", "unknown runner error"))
                if final.get("error_code") == "cuda_oom":
                    error = f"CUDA out of memory. The Wan runner was reset; close other GPU workloads or use 480p. {error}"
                job["error"] = error[:500]
        except Exception as e:
            job["status"] = "error"
            job["error"] = str(e)[:500]
        finally:
            if model.get("release_vram_after_generate"):
                try:
                    await runner_manager.stop_runner()
                except Exception:
                    pass  # the job result must still settle if teardown has already killed the process
        _finish(job)


def _finish(job: dict) -> None:
    global _current
    job.pop("ref_bytes", None)
    if _current is job:
        _current = None
    _history.insert(0, job)
    del _history[50:]
    _publish_job(job)


class AttachAssetBody(BaseModel):
    asset_id: str


@router.post("/jobs/{job_id}/asset", dependencies=[AUTHED])
def attach_asset(job_id: str, body: AttachAssetBody):
    """Client calls this after encrypting+saving a result, linking the job's
    history entry to the stored asset so the queue can show it."""
    for j in _history:
        if j["id"] == job_id:
            j["asset_id"] = body.asset_id
            _publish_job(j)
            return {"ok": True}
    raise HTTPException(404, "Job not in history")


@router.delete("/jobs/{job_id}/history", dependencies=[AUTHED])
def delete_history_entry(job_id: str):
    before = len(_history)
    _history[:] = [j for j in _history if j["id"] != job_id]
    if len(_history) == before:
        raise HTTPException(404, "Job not in history")
    return {"ok": True}


@router.post("/queue/clear", dependencies=[AUTHED])
def clear_history():
    """Clears finished/errored history records. Saved assets are untouched."""
    removed = len(_history)
    _history.clear()
    return {"ok": True, "removed": removed}


@router.get("/queue", dependencies=[AUTHED])
def get_queue():
    return {
        "current": _public_job(_current) if _current else None,
        "queued": [_public_job(j) for j in _queue],
        "history": [_public_job(j) for j in _history[:20]],
    }


@router.post("/jobs/{job_id}/cancel", dependencies=[AUTHED])
async def cancel_job(job_id: str):
    for job in list(_queue):
        if job["id"] == job_id:
            _queue.remove(job)
            job["status"] = "cancelled"
            _finish(job)
            return {"ok": True}
    if _current and _current["id"] == job_id:
        await runner_manager.cancel_generation()
        return {"ok": True}
    raise HTTPException(404, "Job not queued or running")


@router.get("/results/{result_id}", dependencies=[AUTHED])
def fetch_result(result_id: str):
    entry = runner_manager.outbox_get(result_id)
    if not entry:
        raise HTTPException(404, "Result expired or already collected")
    import json as _json
    return Response(
        content=entry["bytes"],
        media_type=entry.get("mime", "image/png"),
        headers={"X-Pleo-Meta-Plain": base64.b64encode(_json.dumps(entry["meta"]).encode()).decode()},
    )


@router.delete("/results/{result_id}", dependencies=[AUTHED])
def discard_result(result_id: str):
    runner_manager.outbox_discard(result_id)
    return {"ok": True}


class ModerateBody(BaseModel):
    image_b64: str


@router.post("/moderate", dependencies=[AUTHED])
async def moderate_image(body: ModerateBody):
    """Transient pre-encryption check for reference images. Nothing persisted."""
    if not moderation.is_enabled():
        return {"enabled": False, "allowed": True}
    try:
        image = base64.b64decode(body.image_b64)
    except Exception:
        raise HTTPException(400, "Invalid base64")
    verdict = await asyncio.to_thread(moderation.check_image, image)
    return {"enabled": True, **verdict}


@router.get("/events")
async def sse(token: str = Query(...)):
    # EventSource cannot set an Authorization header, so the session token
    # arrives as a query parameter and is checked the same way.
    if not valid_token_str(token):
        raise HTTPException(401, "Not authenticated")
    return StreamingResponse(events.subscribe(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
