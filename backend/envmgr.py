"""Per-model virtual environments.

Each model gets its own venv under DATA/envs/<model_id>, created with
--system-site-packages so the big shared packages (torch, torchvision) come
from the container while model-specific libs (diffusers, transformers pins)
install per-env from runners/reqs/<file>.
"""
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException

from . import config, events
from .auth import AUTHED
from .registry import get_component

router = APIRouter(prefix="/api/envs", tags=["envs"], dependencies=[AUTHED])

_states: dict[str, dict] = {}  # model_id -> {status, detail}
_lock = threading.Lock()


def env_dir(model_id: str) -> Path:
    return config.ENVS_DIR / model_id


def python_path(model_id: str) -> Path:
    d = env_dir(model_id)
    return d / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def env_status(model_id: str) -> dict:
    with _lock:
        state = _states.get(model_id)
    if state:
        return state
    if python_path(model_id).exists() and (env_dir(model_id) / ".pleo-ready").exists():
        return {"status": "ready", "detail": ""}
    if env_dir(model_id).exists():
        return {"status": "error", "detail": "env exists but install did not finish"}
    return {"status": "none", "detail": ""}


def _set_state(model_id: str, status: str, detail: str = "") -> None:
    with _lock:
        _states[model_id] = {"status": status, "detail": detail}
    events.publish({"type": "env", "model_id": model_id, "status": status, "detail": detail})


def _create_env_worker(model: dict) -> None:
    model_id = model["id"]
    d = env_dir(model_id)
    try:
        _set_state(model_id, "creating")
        subprocess.run(
            [sys.executable, "-m", "venv", "--system-site-packages", str(d)],
            check=True, capture_output=True, timeout=300,
        )
        reqs = config.ROOT / "runners" / "reqs" / model["reqs"]
        if reqs.exists():
            _set_state(model_id, "installing", f"pip install -r {reqs.name}")
            proc = subprocess.Popen(
                [str(python_path(model_id)), "-m", "pip", "install", "-r", str(reqs)],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
            assert proc.stdout is not None
            for line in proc.stdout:
                line = line.strip()
                if line:
                    _set_state(model_id, "installing", line[-200:])
            if proc.wait() != 0:
                raise RuntimeError("pip install failed — see server logs")
        (d / ".pleo-ready").touch()
        with _lock:
            _states.pop(model_id, None)
        events.publish({"type": "env", "model_id": model_id, "status": "ready", "detail": ""})
    except Exception as e:
        _set_state(model_id, "error", str(e)[:300])


@router.get("")
def list_envs():
    from .registry import all_models
    return {m["id"]: env_status(m["id"]) for m in all_models()}


@router.post("/{model_id}/create")
def create_env(model_id: str):
    model = get_component(model_id)
    status = env_status(model_id)["status"]
    if status in ("creating", "installing"):
        raise HTTPException(409, "Environment install already in progress")
    if status == "ready":
        raise HTTPException(409, "Environment already exists")
    if env_dir(model_id).exists():
        shutil.rmtree(env_dir(model_id))
    threading.Thread(target=_create_env_worker, args=(model,), daemon=True).start()
    return {"ok": True}


@router.delete("/{model_id}")
def delete_env(model_id: str):
    get_component(model_id)
    status = env_status(model_id)["status"]
    if status in ("creating", "installing"):
        raise HTTPException(409, "Install in progress")
    if env_dir(model_id).exists():
        shutil.rmtree(env_dir(model_id))
    with _lock:
        _states.pop(model_id, None)
    events.publish({"type": "env", "model_id": model_id, "status": "none", "detail": ""})
    return {"ok": True}
