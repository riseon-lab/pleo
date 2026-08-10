"""Models page API: weight download (HF snapshot), status, launch/stop,
delete weights."""
import fnmatch
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


def _sources(model: dict) -> list[dict]:
    sources = [{"repo_id": model["repo_id"], "revision": model.get("revision")}]
    if experts := model.get("distilled_experts"):
        # The distilled files replace both base DiTs; do not download another
        # ~114 GB of transformer weights, but retain their Diffusers configs.
        sources[0].update({
            "ignore": [
                "transformer/diffusion_pytorch_model*.safetensors",
                "transformer_2/diffusion_pytorch_model*.safetensors",
            ],
            "required": [
                "model_index.json", "scheduler/scheduler_config.json",
                "text_encoder/config.json", "text_encoder/model-00001-of-00003.safetensors",
                "text_encoder/model-00002-of-00003.safetensors",
                "text_encoder/model-00003-of-00003.safetensors",
                "text_encoder/model.safetensors.index.json",
                "tokenizer/spiece.model", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json",
                "transformer/config.json", "transformer_2/config.json",
                "vae/config.json", "vae/diffusion_pytorch_model.safetensors",
            ],
        })
        sources.append({
            "repo_id": experts["repo_id"],
            "revision": experts.get("revision"),
            "files": [experts["high_noise_file"], experts["low_noise_file"]],
        })
    return sources


def _source_ready(source: dict) -> bool:
    snapshots = runner_manager.hub_cache_dir_for(source["repo_id"]) / "snapshots"
    if not snapshots.exists():
        return False
    revision = source.get("revision")
    dirs = [snapshots / revision] if revision else [p for p in snapshots.iterdir() if p.is_dir()]
    files = source.get("required", source.get("files", []))
    return any(all((d / f).is_file() for f in files) for d in dirs)


def _wanted(source: dict, filename: str) -> bool:
    files = source.get("files")
    return ((not files or any(fnmatch.fnmatch(filename, pattern) for pattern in files))
            and not any(fnmatch.fnmatch(filename, pattern) for pattern in source.get("ignore", [])))


def _weights_status(model: dict) -> str:
    with _dl_lock:
        dl = _downloads.get(model["id"])
    if dl and dl["status"] == "downloading":
        return "downloading"
    if all(_source_ready(source) for source in _sources(model)):
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
            **{k: m.get(k) for k in ("id", "name", "family", "kind", "repo_id", "defaults", "notes", "trainable", "dim_multiple", "video", "distilled_experts", "lora_defaults", "output_mime")},
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
        for source in _sources(model):
            snapshot_download(
                source["repo_id"],
                revision=source.get("revision"),
                allow_patterns=source.get("files"),
                ignore_patterns=source.get("ignore"),
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
        total = 0
        for source in _sources(model):
            info = HfApi().model_info(source["repo_id"], revision=source.get("revision"), files_metadata=True)
            total += sum(f.size or 0 for f in info.siblings if _wanted(source, f.rfilename))
        total = total or None
    except Exception:
        pass
    while True:
        with _dl_lock:
            dl = _downloads.get(model_id)
            if not dl or dl["status"] != "downloading":
                return
        size = 0
        for source in _sources(model):
            snapshots = runner_manager.hub_cache_dir_for(source["repo_id"]) / "snapshots"
            if snapshots.exists():
                revision = source.get("revision")
                dirs = [snapshots / revision] if revision else [p for p in snapshots.iterdir() if p.is_dir()]
                for directory in dirs:
                    if directory.is_dir():
                        size += sum(f.stat().st_size for f in directory.rglob("*")
                                    if f.is_file() and _wanted(source, f.relative_to(directory).as_posix()))
        progress = min(100, round(size / total * 100, 1)) if total else None
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
async def delete_weights(model_id: str):
    get_model(model_id)
    with _dl_lock:
        if _downloads.get(model_id, {}).get("status") == "downloading":
            raise HTTPException(409, "Stop the download before deleting its weights")
        try:
            removed = await runner_manager.delete_weights(model_id)
        except RuntimeError as e:
            raise HTTPException(409, str(e))
    return {"ok": True, "removed": removed}
