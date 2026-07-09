"""Models page API: weight download (HF snapshot), status, launch/stop,
delete weights."""
import threading

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import config, events, runner_manager
from .auth import AUTHED
from .envmgr import env_status
from .registry import all_models, get_model

router = APIRouter(prefix="/api/models", tags=["models"], dependencies=[AUTHED])

_downloads: dict[str, dict] = {}  # model_id -> {status, progress, detail}
_dl_lock = threading.Lock()


def _weights_status(model: dict) -> str:
    with _dl_lock:
        dl = _downloads.get(model["id"])
    if dl and dl["status"] == "downloading":
        return "downloading"
    d = runner_manager.hub_cache_dir_for(model["repo_id"])
    if (d / "snapshots").exists() and any((d / "snapshots").iterdir()):
        return "downloaded"
    return "none"


@router.get("")
def list_models():
    runner = runner_manager.runner_status()
    out = []
    for m in all_models():
        with _dl_lock:
            dl = _downloads.get(m["id"], {})
        out.append({
            **{k: m.get(k) for k in ("id", "name", "family", "kind", "repo_id", "defaults", "notes", "trainable", "dim_multiple")},
            "weights": _weights_status(m),
            "download": {k: dl.get(k) for k in ("progress", "detail")} if dl else None,
            "env": env_status(m["id"])["status"] if not config.MOCK else "mock",
            "running": runner["model_id"] == m["id"] and runner["status"] in ("starting", "loading", "ready", "busy"),
            "runner_status": runner["status"] if runner["model_id"] == m["id"] else None,
        })
    return {"models": out, "mock": config.MOCK, "runner": runner}


class DownloadBody(BaseModel):
    hf_key: str | None = None  # decrypted client-side, transient


def _download_worker(model: dict, token: str | None) -> None:
    model_id = model["id"]
    try:
        from huggingface_hub import snapshot_download
        events.publish({"type": "model_download", "model_id": model_id, "status": "downloading", "progress": 0})
        snapshot_download(
            model["repo_id"],
            cache_dir=str(config.HF_CACHE_DIR / "hub"),
            token=token or None,
        )
        with _dl_lock:
            _downloads.pop(model_id, None)
        events.publish({"type": "model_download", "model_id": model_id, "status": "done", "progress": 100})
    except Exception as e:
        with _dl_lock:
            _downloads[model_id] = {"status": "error", "progress": 0, "detail": str(e)[:300]}
        events.publish({"type": "model_download", "model_id": model_id, "status": "error", "detail": str(e)[:300]})


def _poll_progress(model: dict) -> None:
    """Rough progress: watch on-disk size vs. total repo size."""
    import time
    model_id = model["id"]
    total = None
    try:
        from huggingface_hub import HfApi
        info = HfApi().model_info(model["repo_id"], files_metadata=True)
        total = sum(f.size or 0 for f in info.siblings) or None
    except Exception:
        pass
    d = runner_manager.hub_cache_dir_for(model["repo_id"])
    while True:
        with _dl_lock:
            dl = _downloads.get(model_id)
            if not dl or dl["status"] != "downloading":
                return
        size = 0
        if d.exists():
            size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
        progress = round(size / total * 100, 1) if total else None
        with _dl_lock:
            if model_id in _downloads:
                _downloads[model_id]["progress"] = progress
        events.publish({"type": "model_download", "model_id": model_id,
                        "status": "downloading", "progress": progress,
                        "bytes": size, "total_bytes": total})
        time.sleep(2)


@router.post("/{model_id}/download")
def download_weights(model_id: str, body: DownloadBody):
    model = get_model(model_id)
    with _dl_lock:
        if _downloads.get(model_id, {}).get("status") == "downloading":
            raise HTTPException(409, "Download already in progress")
        _downloads[model_id] = {"status": "downloading", "progress": 0, "detail": ""}
    threading.Thread(target=_download_worker, args=(model, body.hf_key), daemon=True).start()
    threading.Thread(target=_poll_progress, args=(model,), daemon=True).start()
    return {"ok": True}


@router.post("/{model_id}/launch")
async def launch(model_id: str):
    get_model(model_id)
    try:
        await runner_manager.start_runner(model_id)
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return runner_manager.runner_status()


@router.post("/stop")
async def stop():
    await runner_manager.stop_runner()
    return runner_manager.runner_status()


@router.delete("/{model_id}/weights")
def delete_weights(model_id: str):
    try:
        removed = runner_manager.delete_weights(model_id)
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"ok": True, "removed": removed}
