"""Captioner (Qwen2.5-VL class) lifecycle — an isolated runner like the
generation models: own venv, start/stop, deletable weights."""
import asyncio
import base64
import shutil

import httpx
from fastapi import APIRouter, HTTPException

from . import config, events, proc
from .auth import AUTHED
from .envmgr import env_status
from .registry import get_component

router = APIRouter(prefix="/api/captioner", tags=["captioner"], dependencies=[AUTHED])

PORT = int(__import__("os").environ.get("PLEO_CAPTIONER_PORT", "8802"))
_state: dict = {"proc": None, "status": "stopped"}  # stopped|starting|loading|ready|busy
_lock = asyncio.Lock()


def status() -> dict:
    p = _state["proc"]
    if _state["status"] != "stopped" and p is not None and p.poll() is not None:
        _state["status"] = "stopped"
        _state["proc"] = None
    comp = get_component("captioner")
    d = config.HF_CACHE_DIR / "hub" / ("models--" + comp["repo_id"].replace("/", "--"))
    env = {"status": "mock", "detail": ""} if config.MOCK else env_status("captioner")
    weights_bytes = 0
    if (d / "snapshots").exists():
        weights_bytes = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
    return {
        "status": _state["status"],
        "model": comp["repo_id"],
        "env": env["status"],
        "env_detail": env["detail"],
        "weights": "downloaded" if weights_bytes else "none",
        "weights_bytes": weights_bytes,
    }


def _publish() -> None:
    events.publish({"type": "captioner", **status()})


@router.get("")
def get_status():
    return status()


@router.post("/start")
async def start():
    async with _lock:
        if _state["status"] in ("ready", "busy"):
            return status()
        comp = get_component("captioner")
        try:
            python = proc.pick_python("captioner")
        except RuntimeError as e:
            raise HTTPException(409, str(e))
        _state["status"] = "starting"
        _state["proc"] = proc.spawn("captioner.py", {
            "component": comp, "mock": config.MOCK, "hf_home": str(config.HF_CACHE_DIR),
        }, PORT, python)
        _publish()
        try:
            await proc.wait_health(_state["proc"], PORT)
            _state["status"] = "loading"
            _publish()
            async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=None)) as client:
                (await client.post(f"http://127.0.0.1:{PORT}/load")).raise_for_status()
            _state["status"] = "ready"
        except Exception as e:
            await proc.stop(_state["proc"], PORT)
            _state["proc"] = None
            _state["status"] = "stopped"
            _publish()
            raise HTTPException(502, f"Captioner failed to start: {e}")
    _publish()
    return status()


@router.post("/stop")
async def stop():
    async with _lock:
        await proc.stop(_state["proc"], PORT)
        _state["proc"] = None
        _state["status"] = "stopped"
    _publish()
    return status()


@router.delete("/weights")
def delete_weights():
    if _state["status"] not in ("stopped",):
        raise HTTPException(409, "Stop the captioner before deleting its weights")
    comp = get_component("captioner")
    d = config.HF_CACHE_DIR / "hub" / ("models--" + comp["repo_id"].replace("/", "--"))
    removed = d.exists()
    if removed:
        shutil.rmtree(d)
    return {"ok": True, "removed": removed}


async def caption_image(image_bytes: bytes, prompt_hint: str = "") -> str:
    """Used by the dataset auto-caption loop. Captioner must be running."""
    if status()["status"] not in ("ready", "busy"):
        raise RuntimeError("Captioner is not running")
    _state["status"] = "busy"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=300)) as client:
            r = await client.post(f"http://127.0.0.1:{PORT}/caption", json={
                "image_b64": base64.b64encode(image_bytes).decode(),
                "hint": prompt_hint,
            })
            if r.status_code != 200:
                try:
                    msg = r.json().get("error", r.text)
                except Exception:
                    msg = r.text
                raise RuntimeError(f"captioner: {str(msg)[:400]}")
            return r.json()["caption"].strip()
    finally:
        if _state["status"] == "busy":
            _state["status"] = "ready"


async def shutdown() -> None:
    await proc.stop(_state["proc"], PORT)
