"""Shared subprocess helpers for auxiliary runners (captioner, trainer).
Mirrors the model runner's spawn/health/stop pattern."""
import asyncio
import json
import subprocess
import sys
import time
from typing import Optional

import httpx

from . import config
from .envmgr import env_status, python_path


def pick_python(component_id: str) -> str:
    """Venv python in real mode; the backend's python in mock mode."""
    if config.MOCK:
        return sys.executable
    if env_status(component_id)["status"] != "ready":
        raise RuntimeError(f"Environment for {component_id} is not ready — create it first")
    return str(python_path(component_id))


def spawn(script_name: str, cfg: dict, port: int, python: str) -> subprocess.Popen:
    cfg_path = config.TMP_DIR / f"{script_name.replace('.py', '')}-{port}.json"
    cfg_path.write_text(json.dumps(cfg))
    return subprocess.Popen(
        [python, str(config.ROOT / "runners" / script_name),
         "--port", str(port), "--config", str(cfg_path)],
        cwd=str(config.ROOT),
    )


async def wait_health(proc: subprocess.Popen, port: int, timeout: float = 60) -> None:
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient(timeout=2) as client:
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError("Process exited during startup")
            try:
                r = await client.get(f"http://127.0.0.1:{port}/health")
                if r.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.3)
    raise RuntimeError("Process did not become healthy in time")


async def stop(proc: Optional[subprocess.Popen], port: int) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            await client.post(f"http://127.0.0.1:{port}/shutdown")
    except httpx.HTTPError:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
