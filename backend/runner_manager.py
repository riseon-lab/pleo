"""Lifecycle of the single active model-runner subprocess, plus the result
outbox.

Generated images are NOT written to disk by the server. The final image goes
into an in-memory outbox; the browser fetches it, encrypts it with the user's
key, and uploads it as an encrypted asset. Outbox entries expire after
OUTBOX_TTL_SECONDS if never collected.
"""
import asyncio
import json
import shutil
import subprocess
import sys
import time
from typing import Callable, Optional

import httpx

from . import config, events
from .envmgr import env_status, python_path
from .proc import runner_env
from .registry import get_model

_state: dict = {
    "model_id": None,
    "proc": None,
    "port": config.RUNNER_PORT,
    "status": "stopped",  # stopped|starting|loading|ready|busy
}
_outbox: dict[str, dict] = {}
_lock = asyncio.Lock()


def runner_status() -> dict:
    # Only a process that existed and exited counts as dead — during the
    # "starting" window proc is momentarily None and must not be treated
    # as a crash.
    proc: Optional[subprocess.Popen] = _state["proc"]
    if _state["status"] != "stopped" and proc is not None and proc.poll() is not None:
        _state["status"] = "stopped"
        _state["model_id"] = None
        _state["proc"] = None
    return {"model_id": _state["model_id"], "status": _state["status"]}


def _publish_status() -> None:
    events.publish({"type": "runner", **runner_status()})


def _base_url() -> str:
    return f"http://127.0.0.1:{_state['port']}"


async def start_runner(model_id: str) -> None:
    """Spawn (if needed) and load the model. Serialized behind _lock."""
    async with _lock:
        model = get_model(model_id)
        if _state["model_id"] == model_id and _state["status"] in ("ready", "busy"):
            return
        await _stop_locked()

        if config.MOCK:
            python = sys.executable
        else:
            if env_status(model_id)["status"] != "ready":
                raise RuntimeError(f"Environment for {model_id} is not ready — create it from the Models page")
            python = str(python_path(model_id))

        runner_cfg = config.TMP_DIR / f"runner-{model_id}.json"
        runner_cfg.write_text(json.dumps({
            "model": model,
            "mock": config.MOCK,
            "hf_home": str(config.HF_CACHE_DIR),
            "loras_dir": str(config.LORAS_DIR),
        }))
        _state["status"] = "starting"
        _state["model_id"] = model_id
        _state["proc"] = subprocess.Popen(
            [python, str(config.ROOT / "runners" / "runner.py"),
             "--port", str(_state["port"]), "--config", str(runner_cfg)],
            cwd=str(config.ROOT), env=runner_env(),
        )
        _publish_status()
        try:
            await _wait_health(timeout=60)
            _state["status"] = "loading"
            _publish_status()
            async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=None)) as client:
                r = await client.post(f"{_base_url()}/load")
                r.raise_for_status()
            _state["status"] = "ready"
            _publish_status()
        except Exception:
            await _stop_locked()
            _publish_status()
            raise


async def _wait_health(timeout: float) -> None:
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient(timeout=2) as client:
        while time.monotonic() < deadline:
            proc = _state["proc"]
            if proc is None or proc.poll() is not None:
                raise RuntimeError("Runner process exited during startup")
            try:
                r = await client.get(f"{_base_url()}/health")
                if r.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.3)
    raise RuntimeError("Runner did not become healthy in time")


async def _stop_locked() -> None:
    proc: Optional[subprocess.Popen] = _state["proc"]
    if proc is not None and proc.poll() is None:
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                await client.post(f"{_base_url()}/shutdown")
        except httpx.HTTPError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
    _state["proc"] = None
    _state["model_id"] = None
    _state["status"] = "stopped"


async def stop_runner() -> None:
    async with _lock:
        await _stop_locked()
    _publish_status()


async def cancel_generation() -> None:
    if runner_status()["status"] == "busy":
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(f"{_base_url()}/cancel")
        except httpx.HTTPError:
            pass


async def generate(params: dict, on_step: Callable[[dict], None]) -> dict:
    """Stream a generation from the runner. Returns the final NDJSON event
    ({type: done, image_b64, seed} or {type: error|cancelled, ...})."""
    _state["status"] = "busy"
    _publish_status()
    final: dict = {"type": "error", "error": "runner stream ended unexpectedly"}
    try:
        timeout = httpx.Timeout(30, read=None)
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", f"{_base_url()}/generate", json=params) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if event.get("type") == "step":
                        on_step(event)
                    else:
                        final = event
    finally:
        if _state["status"] == "busy":
            _state["status"] = "ready"
        _publish_status()
    return final


# ---------------- Outbox ----------------

def outbox_put(result_id: str, image: bytes, meta: dict) -> None:
    _gc_outbox()
    _outbox[result_id] = {"bytes": image, "meta": meta, "created": time.time()}


def outbox_get(result_id: str) -> Optional[dict]:
    _gc_outbox()
    return _outbox.get(result_id)


def outbox_discard(result_id: str) -> None:
    _outbox.pop(result_id, None)


def _gc_outbox() -> None:
    cutoff = time.time() - config.OUTBOX_TTL_SECONDS
    for k in [k for k, v in _outbox.items() if v["created"] < cutoff]:
        _outbox.pop(k, None)


# ---------------- Weights ----------------

def hub_cache_dir_for(repo_id: str):
    return config.HF_CACHE_DIR / "hub" / ("models--" + repo_id.replace("/", "--"))


def delete_weights(model_id: str) -> bool:
    model = get_model(model_id)
    if _state["model_id"] == model_id and _state["status"] in ("loading", "ready", "busy"):
        raise RuntimeError("Stop the runner before deleting its weights")
    d = hub_cache_dir_for(model["repo_id"])
    if d.exists():
        shutil.rmtree(d)
        return True
    return False
