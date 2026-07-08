"""Settings: encrypted API-key blob, moderation toggle, git updater,
backend restart, status."""
import asyncio
import base64
import os
import subprocess
import sys
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import config, moderation, runner_manager
from .auth import AUTHED
from .util import atomic_write_json, read_json

router = APIRouter(prefix="/api/settings", tags=["settings"], dependencies=[AUTHED])

_started_at = time.time()


# ---- Encrypted API keys blob (opaque to the server) ----

class KeysBlob(BaseModel):
    blob: str  # base64 of client-encrypted JSON {hf_key, civitai_key}


@router.get("/keys")
def get_keys():
    if not config.KEYS_BLOB_FILE.exists():
        return {"blob": None}
    return {"blob": config.KEYS_BLOB_FILE.read_text()}


@router.post("/keys")
def set_keys(body: KeysBlob):
    try:
        base64.b64decode(body.blob)
    except Exception:
        raise HTTPException(400, "blob must be base64")
    if len(body.blob) > 64 * 1024:
        raise HTTPException(413, "blob too large")
    tmp = config.KEYS_BLOB_FILE.with_suffix(".tmp")
    tmp.write_text(body.blob)
    os.replace(tmp, config.KEYS_BLOB_FILE)
    return {"ok": True}


# ---- Moderation ----

class ModerationBody(BaseModel):
    enabled: bool


@router.get("/moderation")
def get_moderation():
    return moderation.status()


class ModerationInstallBody(BaseModel):
    hf_key: str | None = None


@router.post("/moderation/install")
async def install_moderation(body: ModerationInstallBody):
    import asyncio as _asyncio
    try:
        return await _asyncio.to_thread(moderation.install_classifier, body.hf_key)
    except Exception as e:
        raise HTTPException(502, f"Classifier install failed: {e}")


@router.post("/moderation")
def set_moderation(body: ModerationBody):
    settings = read_json(config.SETTINGS_FILE, {})
    settings["moderation_enabled"] = body.enabled
    atomic_write_json(config.SETTINGS_FILE, settings)
    return moderation.status()


# ---- Git updater / restart ----

@router.post("/git-pull")
def git_pull():
    try:
        r = subprocess.run(
            ["git", "pull", "--ff-only"],
            cwd=str(config.ROOT), capture_output=True, text=True, timeout=120,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "git pull timed out")
    except FileNotFoundError:
        raise HTTPException(500, "git is not installed")
    return {"ok": r.returncode == 0, "code": r.returncode,
            "stdout": r.stdout[-4000:], "stderr": r.stderr[-4000:]}


@router.post("/restart")
async def restart():
    """Re-exec the backend in place; the Docker container stays up. The
    start.sh supervisor loop also restarts us if the process ever dies."""
    async def _restart():
        await asyncio.sleep(0.5)
        await runner_manager.stop_runner()
        os.execv(sys.executable, [sys.executable, "-m", "backend.main"])
    asyncio.get_running_loop().create_task(_restart())
    return {"ok": True, "message": "Restarting…"}


@router.get("/status")
def status():
    rev = None
    try:
        r = subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                           cwd=str(config.ROOT), capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            rev = r.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return {
        "version": rev,
        "uptime_s": round(time.time() - _started_at),
        "mock": config.MOCK,
        "data_dir": str(config.DATA_DIR),
        "runner": runner_manager.runner_status(),
    }
