"""Data Studio: datasets of images + caption sidecars (.txt next to each
image — the convention LoRA trainers consume directly).

NOTE ON ENCRYPTION: unlike assets, dataset images are stored in PLAINTEXT on
the pod volume — the trainer needs raw pixels and never holds the user's key.
The UI states this tradeoff explicitly instead of pretending otherwise.
"""
import asyncio
import shutil
import threading
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import captioner_manager, config, events, moderation
from .auth import AUTHED
from .util import atomic_write_json, new_id, path_inside, read_json, safe_filename

router = APIRouter(prefix="/api/datasets", tags=["datasets"], dependencies=[AUTHED])

DATASETS_DIR = config.DATA_DIR / "datasets"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
MAX_IMAGE_BYTES = 32 * 1024 * 1024

_autocaption_tasks: dict[str, dict] = {}  # dataset_id -> {"cancel": bool}


def ds_dir(ds_id: str) -> Path:
    d = DATASETS_DIR / ds_id
    if not path_inside(DATASETS_DIR, d):
        raise HTTPException(400, "Bad dataset id")
    return d


def _meta(ds_id: str) -> dict:
    meta = read_json(ds_dir(ds_id) / "meta.json")
    if not meta:
        raise HTTPException(404, "No such dataset")
    return meta


def _save_meta(meta: dict) -> None:
    atomic_write_json(ds_dir(meta["id"]) / "meta.json", meta)


def images_dir(ds_id: str) -> Path:
    return ds_dir(ds_id) / "images"


def _items(ds_id: str) -> list[dict]:
    out = []
    d = images_dir(ds_id)
    if not d.exists():
        return out
    for f in sorted(d.iterdir()):
        if f.suffix.lower() not in IMAGE_EXTS:
            continue
        cap = f.with_suffix(".txt")
        out.append({
            "file": f.name,
            "size": f.stat().st_size,
            "caption": cap.read_text() if cap.exists() else "",
        })
    return out


def _summary(meta: dict) -> dict:
    items = _items(meta["id"])
    return {**meta, "count": len(items), "captioned": sum(1 for i in items if i["caption"].strip())}


class CreateBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class CaptionBody(BaseModel):
    file: str
    caption: str = Field("", max_length=4000)


class TriggerBody(BaseModel):
    trigger_word: str = Field("", max_length=80)


class AutoCaptionBody(BaseModel):
    overwrite: bool = False


class HFPullBody(BaseModel):
    repo_id: str
    api_key: str | None = None


@router.get("")
def list_datasets():
    DATASETS_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for d in sorted(DATASETS_DIR.iterdir()):
        meta = read_json(d / "meta.json")
        if meta:
            out.append(_summary(meta))
    return {"datasets": out}


@router.post("")
def create_dataset(body: CreateBody):
    ds_id = new_id(8)
    d = DATASETS_DIR / ds_id
    (d / "images").mkdir(parents=True)
    meta = {"id": ds_id, "name": body.name.strip(), "created": time.time(), "trigger_word": ""}
    atomic_write_json(d / "meta.json", meta)
    return _summary(meta)


@router.get("/{ds_id}")
def get_dataset(ds_id: str):
    meta = _meta(ds_id)
    return {**_summary(meta), "items": _items(ds_id),
            "autocaption": _autocaption_tasks.get(ds_id, {}).get("progress")}


@router.delete("/{ds_id}")
def delete_dataset(ds_id: str):
    _meta(ds_id)
    if ds_id in _autocaption_tasks:
        raise HTTPException(409, "Auto-captioning in progress — cancel it first")
    shutil.rmtree(ds_dir(ds_id))
    return {"ok": True}


def _image_path(ds_id: str, filename: str) -> Path:
    p = images_dir(ds_id) / safe_filename(filename)
    if not path_inside(images_dir(ds_id), p):
        raise HTTPException(400, "Bad filename")
    return p


@router.post("/{ds_id}/images")
async def upload_image(ds_id: str, request: Request):
    _meta(ds_id)
    name = safe_filename(request.headers.get("x-pleo-filename", f"{new_id(6)}.png"))
    if Path(name).suffix.lower() not in IMAGE_EXTS:
        raise HTTPException(400, f"Unsupported extension (use {', '.join(sorted(IMAGE_EXTS))})")
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "Image too large")
    if not body:
        raise HTTPException(400, "Empty body")
    if moderation.is_enabled():
        verdict = await asyncio.to_thread(moderation.check_image, body)
        if not verdict["allowed"]:
            raise HTTPException(422, "Image blocked by moderation")
    p = _image_path(ds_id, name)
    if p.exists():  # avoid silent overwrite
        p = p.with_stem(f"{p.stem}-{new_id(4)}")
    p.write_bytes(body)
    return {"file": p.name, "size": len(body)}


@router.get("/{ds_id}/images/{filename}")
def get_image(ds_id: str, filename: str):
    p = _image_path(ds_id, filename)
    if not p.exists():
        raise HTTPException(404, "No such image")
    return FileResponse(p)


@router.delete("/{ds_id}/images/{filename}")
def delete_image(ds_id: str, filename: str):
    p = _image_path(ds_id, filename)
    if not p.exists():
        raise HTTPException(404, "No such image")
    p.unlink()
    p.with_suffix(".txt").unlink(missing_ok=True)
    return {"ok": True}


@router.put("/{ds_id}/caption")
def set_caption(ds_id: str, body: CaptionBody):
    p = _image_path(ds_id, body.file)
    if not p.exists():
        raise HTTPException(404, "No such image")
    p.with_suffix(".txt").write_text(body.caption.strip())
    return {"ok": True}


@router.put("/{ds_id}/trigger")
def set_trigger(ds_id: str, body: TriggerBody):
    meta = _meta(ds_id)
    meta["trigger_word"] = body.trigger_word.strip()
    _save_meta(meta)
    return _summary(meta)


@router.post("/{ds_id}/trigger/apply")
def apply_trigger(ds_id: str):
    """Prepend the trigger word to every caption that doesn't contain it."""
    meta = _meta(ds_id)
    trigger = meta.get("trigger_word", "").strip()
    if not trigger:
        raise HTTPException(400, "Set a trigger word first")
    changed = 0
    for item in _items(ds_id):
        cap = item["caption"].strip()
        if trigger.lower() in cap.lower():
            continue
        p = _image_path(ds_id, item["file"]).with_suffix(".txt")
        p.write_text(f"{trigger}, {cap}" if cap else trigger)
        changed += 1
    return {"ok": True, "changed": changed}


# ---------------- auto-caption ----------------

@router.post("/{ds_id}/autocaption")
async def autocaption(ds_id: str, body: AutoCaptionBody):
    meta = _meta(ds_id)
    if captioner_manager.status()["status"] not in ("ready", "busy"):
        raise HTTPException(409, "Start the captioner model first")
    if ds_id in _autocaption_tasks:
        raise HTTPException(409, "Auto-captioning already running for this dataset")
    items = [i for i in _items(ds_id) if body.overwrite or not i["caption"].strip()]
    if not items:
        return {"ok": True, "queued": 0}
    task = {"cancel": False, "progress": {"done": 0, "total": len(items)}}
    _autocaption_tasks[ds_id] = task
    asyncio.get_running_loop().create_task(_autocaption_worker(ds_id, meta, items, task))
    return {"ok": True, "queued": len(items)}


async def _autocaption_worker(ds_id: str, meta: dict, items: list[dict], task: dict) -> None:
    trigger = meta.get("trigger_word", "").strip()
    try:
        for i, item in enumerate(items):
            if task["cancel"]:
                break
            p = _image_path(ds_id, item["file"])
            try:
                caption = await captioner_manager.caption_image(p.read_bytes())
            except Exception as e:
                events.publish({"type": "autocaption", "dataset_id": ds_id, "status": "error",
                                "file": item["file"], "detail": str(e)[:300]})
                break
            if trigger and trigger.lower() not in caption.lower():
                caption = f"{trigger}, {caption}"
            p.with_suffix(".txt").write_text(caption)
            task["progress"] = {"done": i + 1, "total": len(items)}
            events.publish({"type": "autocaption", "dataset_id": ds_id, "status": "running",
                            "done": i + 1, "total": len(items), "file": item["file"], "caption": caption})
    finally:
        _autocaption_tasks.pop(ds_id, None)
        events.publish({"type": "autocaption", "dataset_id": ds_id, "status": "done"})


@router.post("/{ds_id}/autocaption/cancel")
def cancel_autocaption(ds_id: str):
    task = _autocaption_tasks.get(ds_id)
    if not task:
        raise HTTPException(404, "No auto-captioning running")
    task["cancel"] = True
    return {"ok": True}


# ---------------- pull from Hugging Face ----------------

@router.post("/{ds_id}/pull-hf")
def pull_hf(ds_id: str, body: HFPullBody):
    _meta(ds_id)
    import re
    repo = body.repo_id.strip().strip("/")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise HTTPException(400, "repo_id must look like org/name")
    threading.Thread(target=_pull_hf_worker, args=(ds_id, repo, body.api_key), daemon=True).start()
    return {"ok": True}


def _pull_hf_worker(ds_id: str, repo: str, token: str | None) -> None:
    try:
        from huggingface_hub import snapshot_download
        events.publish({"type": "dataset_pull", "dataset_id": ds_id, "status": "downloading", "repo": repo})
        snap = snapshot_download(repo, repo_type="dataset", token=token or None,
                                 cache_dir=str(config.HF_CACHE_DIR / "hub"))
        copied = 0
        for f in Path(snap).rglob("*"):
            if f.is_file() and f.suffix.lower() in IMAGE_EXTS:
                dest = images_dir(ds_id) / safe_filename(f.name)
                if dest.exists():
                    dest = dest.with_stem(f"{dest.stem}-{new_id(4)}")
                shutil.copyfile(f, dest)
                # bring matching caption sidecars along when the dataset has them
                cap = f.with_suffix(".txt")
                if cap.exists():
                    dest.with_suffix(".txt").write_text(cap.read_text())
                copied += 1
        events.publish({"type": "dataset_pull", "dataset_id": ds_id, "status": "done", "copied": copied})
    except Exception as e:
        events.publish({"type": "dataset_pull", "dataset_id": ds_id, "status": "error", "detail": str(e)[:300]})
