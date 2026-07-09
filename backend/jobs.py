"""Generation queue: sequential jobs, SSE progress, moderation gate, outbox
hand-off. Prompts and reference images live only in memory for the life of a
job — the server never persists them in plaintext."""
import asyncio
import base64
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
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


class GenerateBody(BaseModel):
    model_id: str
    prompt: str = Field(..., max_length=8000)
    negative_prompt: str = Field("", max_length=8000)
    steps: int = Field(..., ge=1, le=200)
    cfg: float = Field(..., ge=0, le=30)
    width: int = Field(..., ge=64, le=2048)
    height: int = Field(..., ge=64, le=2048)
    seed: int = -1
    loras: list[LoraRef] = []
    ref_image_b64: Optional[str] = None  # plaintext, transient, for edit models


def _public_job(job: dict) -> dict:
    return {k: job[k] for k in
            ("id", "model_id", "status", "created", "prompt", "steps", "width", "height", "seed",
             "error", "result_id", "asset_id")
            if k in job}


def _publish_job(job: dict) -> None:
    events.publish({"type": "job", "job": _public_job(job)})


@router.post("/generate", dependencies=[AUTHED])
async def submit(body: GenerateBody):
    model = get_model(body.model_id)
    # Latent/patch constraints vary per model (Z-Image/Qwen need multiples of
    # 16). Auto-round instead of rejecting — e.g. FHD 1080 becomes 1072.
    mult = int(model.get("dim_multiple", 16))
    def _snap(v: int) -> int:  # nearest multiple, ties toward the smaller (1080 -> 1072)
        return max(64, min(2048, (2 * v + mult - 1) // (2 * mult) * mult))
    width = _snap(body.width)
    height = _snap(body.height)
    if model["kind"] == "edit" and not body.ref_image_b64:
        raise HTTPException(400, "This model requires a reference image")
    lora_files = []
    for lora in body.loras:
        p = config.LORAS_DIR / lora.file
        if not path_inside(config.LORAS_DIR, p) or not p.exists():
            raise HTTPException(400, f"Unknown LoRA: {lora.file}")
        lora_files.append({"path": str(p), "strength": lora.strength})
    ref_bytes = None
    if body.ref_image_b64:
        try:
            ref_bytes = base64.b64decode(body.ref_image_b64)
        except Exception:
            raise HTTPException(400, "Invalid reference image base64")
        if len(ref_bytes) > 32 * 1024 * 1024:
            raise HTTPException(413, "Reference image too large")
        if moderation.is_enabled():
            verdict = await asyncio.to_thread(moderation.check_image, ref_bytes)
            if not verdict["allowed"]:
                raise HTTPException(422, "Reference image blocked by moderation")
    job = {
        "id": new_id(),
        "model_id": body.model_id,
        "status": "queued",
        "created": time.time(),
        "prompt": body.prompt,
        "negative_prompt": body.negative_prompt,
        "steps": body.steps,
        "cfg": body.cfg,
        "width": width,
        "height": height,
        "seed": body.seed,
        "loras": lora_files,
        "ref_bytes": ref_bytes,
    }
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
        try:
            await runner_manager.start_runner(job["model_id"])
            job["status"] = "running"
            _publish_job(job)

            def on_step(ev: dict) -> None:
                events.publish({"type": "step", "job_id": job["id"],
                                "step": ev.get("step"), "total": ev.get("total"),
                                "preview_b64": ev.get("preview_b64")})

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
            final = await runner_manager.generate(params, on_step)

            if final.get("type") == "done":
                image = base64.b64decode(final["image_b64"])
                job["seed"] = final.get("seed", job["seed"])
                if moderation.is_enabled():
                    verdict = await asyncio.to_thread(moderation.check_image, image)
                    if not verdict["allowed"]:
                        job["status"] = "blocked"
                        job["error"] = "Output blocked by moderation filter"
                        _finish(job)
                        continue
                result_id = new_id()
                runner_manager.outbox_put(result_id, image, {
                    "job_id": job["id"], "model_id": job["model_id"],
                    "prompt": job["prompt"], "seed": job["seed"],
                    "steps": job["steps"], "cfg": job["cfg"],
                    "width": job["width"], "height": job["height"],
                })
                job["status"] = "done"
                job["result_id"] = result_id
            elif final.get("type") == "cancelled":
                job["status"] = "cancelled"
            else:
                job["status"] = "error"
                job["error"] = str(final.get("error", "unknown runner error"))[:500]
        except Exception as e:
            job["status"] = "error"
            job["error"] = str(e)[:500]
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
        media_type="image/png",
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
