"""Training jobs: one at a time, driven through the trainer runner. Job
records persist to data/training/jobs.json; artifacts (checkpoints, samples,
logs) live under data/training/<job_id>/."""
import asyncio
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import captioner_manager, config, events, proc, runner_manager
from .auth import AUTHED
from .datasets import _items as dataset_items
from .datasets import _meta as dataset_meta
from .datasets import images_dir
from .registry import get_model
from .util import atomic_write_json, new_id, path_inside, read_json, safe_filename

router = APIRouter(prefix="/api/training", tags=["training"], dependencies=[AUTHED])

TRAINING_DIR = config.DATA_DIR / "training"
JOBS_FILE = TRAINING_DIR / "jobs.json"
PORT = int(os.environ.get("PLEO_TRAINER_PORT", "8803"))

DEFAULT_CHECKPOINTS = [250, 500, 750, 1000, 1500, 2000]

# Names validated against ostris/ai-toolkit (toolkit/optimizer.py, scheduler.py).
OPTIMIZERS = ["adamw8bit", "adamw", "adam8bit", "adafactor", "prodigy", "lion8bit", "automagic"]
LR_SCHEDULERS = ["constant", "cosine", "cosine_with_restarts", "linear", "constant_with_warmup"]
# low: 24GB-class cards, full quantization (the official recipes).
# balanced: 48GB-class. high: 80GB+ — skip quantization for speed.
VRAM_PROFILES = ["low", "balanced", "high"]

_live: dict = {"job_id": None, "proc": None, "poll_task": None, "hf_key": None}
_lock = asyncio.Lock()

# ---------------- ai-toolkit install (button-driven; no pod terminal needed) ----------------

AI_TOOLKIT_DIR = Path(os.environ.get("AI_TOOLKIT_DIR", "/workspace/ai-toolkit"))
AI_TOOLKIT_REPO = "https://github.com/ostris/ai-toolkit"
_toolkit = {"status": "idle", "detail": ""}  # idle|cloning|installing|ready|error
_toolkit_lock = threading.Lock()


def _toolkit_present() -> bool:
    return (AI_TOOLKIT_DIR / "run.py").exists()


@router.get("/toolkit")
def toolkit_status():
    st = dict(_toolkit)
    st["present"] = _toolkit_present()
    st["dir"] = str(AI_TOOLKIT_DIR)
    if st["status"] == "idle" and st["present"]:
        st["status"] = "ready"
    return st


@router.post("/toolkit/install")
def toolkit_install():
    with _toolkit_lock:
        if _toolkit["status"] in ("cloning", "installing"):
            raise HTTPException(409, "ai-toolkit install already in progress")
        if config.MOCK:
            _toolkit.update(status="ready", detail="mock mode — simulated install")
            events.publish({"type": "toolkit", **_toolkit, "present": True})
            return {"ok": True, "mock": True}
        from .envmgr import env_status
        if env_status("trainer")["status"] != "ready":
            raise HTTPException(409, "Create the trainer environment first")
        _toolkit.update(status="cloning", detail="starting…")
    threading.Thread(target=_toolkit_worker, daemon=True).start()
    return {"ok": True}


def _toolkit_worker() -> None:
    from .envmgr import python_path

    def pub():
        events.publish({"type": "toolkit", **_toolkit, "present": _toolkit_present()})

    try:
        if not _toolkit_present():
            _toolkit.update(status="cloning", detail=f"git clone → {AI_TOOLKIT_DIR}")
            pub()
            AI_TOOLKIT_DIR.parent.mkdir(parents=True, exist_ok=True)
            if AI_TOOLKIT_DIR.exists():
                shutil.rmtree(AI_TOOLKIT_DIR)  # debris from an interrupted clone
            r = subprocess.run(["git", "clone", "--depth", "1", AI_TOOLKIT_REPO, str(AI_TOOLKIT_DIR)],
                               capture_output=True, text=True, timeout=900)
            if r.returncode != 0:
                raise RuntimeError(f"git clone failed: {r.stderr[-300:]}")
        else:
            _toolkit.update(status="cloning", detail="updating existing clone (git pull)")
            pub()
            subprocess.run(["git", "-C", str(AI_TOOLKIT_DIR), "pull", "--ff-only"],
                           capture_output=True, text=True, timeout=300)

        py = str(python_path("trainer"))
        _toolkit.update(status="installing", detail="pip install -r requirements.txt (this takes a few minutes)")
        pub()
        proc = subprocess.Popen([py, "-m", "pip", "install", "-r",
                                 str(AI_TOOLKIT_DIR / "requirements.txt")],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if line:
                _toolkit["detail"] = line[-200:]
                pub()
        if proc.wait() != 0:
            raise RuntimeError(f"pip install failed: {_toolkit['detail']}")

        # opencv-python needs libGL.so.1, which slim CUDA images don't have;
        # the headless build is API-identical and dependency-free.
        _toolkit.update(detail="swapping opencv for headless build (no libGL needed)")
        pub()
        # Remove EVERY opencv variant first — mixed installs share the cv2/
        # directory, so a partial uninstall leaves a package that pip thinks
        # is installed but whose files are gone.
        subprocess.run([py, "-m", "pip", "uninstall", "-y",
                        "opencv-python", "opencv-contrib-python",
                        "opencv-python-headless", "opencv-contrib-python-headless"],
                       capture_output=True, text=True, timeout=300)
        r = subprocess.run([py, "-m", "pip", "install", "--force-reinstall",
                            "--no-deps", "opencv-python-headless"],
                           capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise RuntimeError(f"opencv-headless install failed: {r.stderr[-250:]}")
        chk_cv = subprocess.run([py, "-c", "import cv2; print(cv2.__version__)"],
                                capture_output=True, text=True, timeout=120)
        if chk_cv.returncode != 0:
            raise RuntimeError(f"cv2 still not importable: {chk_cv.stderr[-250:]}")

        # ai-toolkit assumes the full torch trio; the image ships only
        # torch+torchvision. Install torchaudio matched EXACTLY to the venv's
        # torch build so pip can't swap torch out from under us.
        chk_ta = subprocess.run([py, "-c", "import torchaudio"],
                                capture_output=True, text=True, timeout=120)
        if chk_ta.returncode != 0:
            ver = subprocess.run([py, "-c", "import torch; print(torch.__version__)"],
                                 capture_output=True, text=True, timeout=120).stdout.strip()
            base_ver, _, cuda_tag = ver.partition("+")  # e.g. 2.9.1 + cu128
            _toolkit.update(detail=f"installing torchaudio=={ver} to match torch")
            pub()
            cmd = [py, "-m", "pip", "install", f"torchaudio=={ver}" if cuda_tag else f"torchaudio=={base_ver}"]
            if cuda_tag:
                cmd += ["--index-url", f"https://download.pytorch.org/whl/{cuda_tag}"]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
            if r.returncode != 0:
                raise RuntimeError(f"torchaudio install failed: {r.stderr[-250:]}")
            chk_ta = subprocess.run([py, "-c", "import torchaudio"],
                                    capture_output=True, text=True, timeout=120)
            if chk_ta.returncode != 0:
                raise RuntimeError(f"torchaudio still not importable: {chk_ta.stderr[-250:]}")

        # Sanity: torch must import inside the trainer venv and see the GPU
        # (ai-toolkit's requirements may have replaced the shared torch).
        chk = subprocess.run([py, "-c", "import torch; print(torch.__version__, torch.cuda.is_available())"],
                             capture_output=True, text=True, timeout=180)
        if chk.returncode == 0:
            version, cuda_ok = (chk.stdout.strip().rsplit(" ", 1) + ["False"])[:2]
            detail = f"ready — venv torch {version}, CUDA {'OK' if cuda_ok == 'True' else 'NOT AVAILABLE'}"
            if cuda_ok != "True":
                raise RuntimeError(detail + " — the pip install may have replaced torch with an incompatible build")
        else:
            raise RuntimeError(f"torch check failed in trainer venv: {chk.stderr[-250:]}")
        _toolkit.update(status="ready", detail=detail)
        pub()
    except Exception as e:
        _toolkit.update(status="error", detail=str(e)[:350])
        pub()


def _jobs() -> list[dict]:
    return read_json(JOBS_FILE, [])


def _save_jobs(jobs: list[dict]) -> None:
    atomic_write_json(JOBS_FILE, jobs)


def _job(job_id: str) -> dict:
    for j in _jobs():
        if j["id"] == job_id:
            return j
    raise HTTPException(404, "No such training job")


def _update_job(job_id: str, patch: dict) -> dict:
    jobs = _jobs()
    for j in jobs:
        if j["id"] == job_id:
            j.update(patch)
            _save_jobs(jobs)
            return j
    raise HTTPException(404, "No such training job")


def job_dir(job_id: str) -> Path:
    d = TRAINING_DIR / job_id
    if not path_inside(TRAINING_DIR, d):
        raise HTTPException(400, "Bad job id")
    return d


class HFPush(BaseModel):
    repo_id: str
    private: bool = True


class CreateJobBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    dataset_id: str
    base_model: str
    trigger_word: str = Field("", max_length=80)
    steps: int = Field(..., ge=50, le=20000)
    checkpoint_steps: list[int] = []
    sample_prompts: list[str] = Field([], max_length=8)
    rank: int = Field(16, ge=1, le=128)
    alpha: Optional[int] = Field(None, ge=1, le=256)  # defaults to rank
    lr: float = Field(1e-4, gt=0, le=1)
    lr_scheduler: str = "constant"
    optimizer: str = "adamw8bit"
    resolution: int = Field(1024, ge=256, le=2048)
    batch_size: int = Field(1, ge=1, le=8)
    vram_profile: str = "low"
    gradient_checkpointing: bool = True
    hf_push: Optional[HFPush] = None
    hf_key: Optional[str] = None  # transient; never persisted


def _public(job: dict) -> dict:
    return {k: v for k, v in job.items() if k != "hf_key"}


@router.get("/jobs")
def list_jobs():
    return {"jobs": sorted((_public(j) for j in _jobs()),
                           key=lambda j: j["created"], reverse=True),
            "active": _live["job_id"], "mock": config.MOCK,
            "default_checkpoints": DEFAULT_CHECKPOINTS,
            "optimizers": OPTIMIZERS, "lr_schedulers": LR_SCHEDULERS,
            "vram_profiles": VRAM_PROFILES}


@router.post("/jobs")
async def create_job(body: CreateJobBody):
    if _live["job_id"]:
        raise HTTPException(409, "A training job is already running")
    model = get_model(body.base_model)
    if not model.get("trainable"):
        raise HTTPException(400, f"{model['name']} is not a trainable base (use Z Image Base or Qwen Image)")
    if body.optimizer not in OPTIMIZERS:
        raise HTTPException(400, f"optimizer must be one of {', '.join(OPTIMIZERS)}")
    if body.lr_scheduler not in LR_SCHEDULERS:
        raise HTTPException(400, f"lr_scheduler must be one of {', '.join(LR_SCHEDULERS)}")
    if body.vram_profile not in VRAM_PROFILES:
        raise HTTPException(400, f"vram_profile must be one of {', '.join(VRAM_PROFILES)}")
    meta = dataset_meta(body.dataset_id)
    items = dataset_items(body.dataset_id)
    if not items:
        raise HTTPException(400, "Dataset has no images")
    uncaptioned = sum(1 for i in items if not i["caption"].strip())
    if body.hf_push and not body.hf_key and not config.MOCK:
        raise HTTPException(400, "Hugging Face push requires your HF key (sent transiently)")
    checkpoints = sorted({s for s in (body.checkpoint_steps or DEFAULT_CHECKPOINTS)
                          if 0 < s <= body.steps})
    job = {
        "id": new_id(8),
        "name": body.name.strip(),
        "dataset_id": body.dataset_id,
        "dataset_name": meta["name"],
        "base_model": body.base_model,
        "trigger_word": body.trigger_word.strip(),
        "steps": body.steps,
        "checkpoint_steps": checkpoints,
        "sample_prompts": [p.strip() for p in body.sample_prompts if p.strip()],
        "rank": body.rank, "alpha": body.alpha or body.rank, "lr": body.lr,
        "lr_scheduler": body.lr_scheduler, "optimizer": body.optimizer,
        "resolution": body.resolution, "batch_size": body.batch_size,
        "vram_profile": body.vram_profile,
        "gradient_checkpointing": body.gradient_checkpointing,
        "hf_push": body.hf_push.model_dump() if body.hf_push else None,
        "status": "created", "step": 0, "loss": None, "sec_per_step": None,
        "checkpoints": [], "error": None,
        "created": time.time(), "started": None, "finished": None,
        "dataset_stats": {"images": len(items), "uncaptioned": uncaptioned},
    }
    _save_jobs(_jobs() + [job])
    await _start_job(job, body.hf_key)
    return _public(_job(job["id"]))


async def _start_job(job: dict, hf_key: Optional[str]) -> None:
    async with _lock:
        if _live["job_id"]:
            raise HTTPException(409, "A training job is already running")
        model = get_model(job["base_model"])
        try:
            python = proc.pick_python("trainer")
        except RuntimeError as e:
            raise HTTPException(409, str(e))
        if not config.MOCK and not _toolkit_present():
            raise HTTPException(409, "ai-toolkit is not installed — use Install ai-toolkit on the Training page")
        # Free the GPU: generation and captioning runners are stopped.
        await runner_manager.stop_runner()
        await captioner_manager.shutdown()

        d = job_dir(job["id"])
        d.mkdir(parents=True, exist_ok=True)
        cfg = {
            "training_job": job,
            "mock": config.MOCK,
            "mock_sec_per_step": float(os.environ.get("PLEO_MOCK_TRAIN_PACE", "0.03")),
            "hf_home": str(config.HF_CACHE_DIR),
            "job_dir": str(d),
            "dataset_dir": str(images_dir(job["dataset_id"])),
            "base_model": model,
        }
        p = proc.spawn("trainer.py", cfg, PORT, python)
        try:
            await proc.wait_health(p, PORT)
            async with httpx.AsyncClient(timeout=30) as client:
                (await client.post(f"http://127.0.0.1:{PORT}/start")).raise_for_status()
        except Exception as e:
            await proc.stop(p, PORT)
            _update_job(job["id"], {"status": "error", "error": f"trainer failed to start: {e}"})
            raise HTTPException(502, f"Trainer failed to start: {e}")
        _live.update(job_id=job["id"], proc=p, hf_key=hf_key)
        _update_job(job["id"], {"status": "running", "started": time.time()})
        _live["poll_task"] = asyncio.get_running_loop().create_task(_poll_loop(job["id"]))


async def _poll_loop(job_id: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            while True:
                await asyncio.sleep(1)
                p = _live["proc"]
                if p is None:
                    return
                if p.poll() is not None:
                    _update_job(job_id, {"status": "error", "finished": time.time(),
                                         "error": "trainer process died — check server logs"})
                    break
                try:
                    st = (await client.get(f"http://127.0.0.1:{PORT}/status")).json()
                except httpx.HTTPError:
                    continue
                patch = {"step": st["step"], "loss": st["loss"],
                         "sec_per_step": st["sec_per_step"], "checkpoints": st["checkpoints"],
                         "loss_history": st.get("loss_history", []),
                         "samples": st.get("samples", [])}
                # log_tail rides the event stream only — no point persisting it
                log_tail = st.get("log_tail", [])
                if st["state"] in ("done", "error", "cancelled"):
                    patch["status"] = st["state"]
                    patch["finished"] = time.time()
                    patch["error"] = st.get("error")
                    job = _update_job(job_id, patch)
                    events.publish({"type": "training", "job": _public(job), "log_tail": log_tail})
                    if st["state"] == "done" and job.get("hf_push"):
                        await _push_to_hf(job)
                    break
                job = _update_job(job_id, patch)
                events.publish({"type": "training", "job": _public(job), "log_tail": log_tail})
    finally:
        await proc.stop(_live["proc"], PORT)
        _live.update(job_id=None, proc=None, poll_task=None, hf_key=None)
        events.publish({"type": "training", "job": _public(_job(job_id))})


async def _push_to_hf(job: dict) -> None:
    push = job["hf_push"]
    if config.MOCK:
        events.publish({"type": "training_push", "job_id": job["id"], "status": "skipped",
                        "detail": "mock mode — no real upload"})
        return
    key = _live["hf_key"]
    if not key:
        events.publish({"type": "training_push", "job_id": job["id"], "status": "error",
                        "detail": "HF key no longer in memory (backend restarted?) — push manually"})
        return
    def _do():
        from huggingface_hub import HfApi
        api = HfApi(token=key)
        api.create_repo(push["repo_id"], private=push["private"], exist_ok=True, repo_type="model")
        api.upload_folder(folder_path=str(job_dir(job["id"]) / "checkpoints"),
                          repo_id=push["repo_id"], repo_type="model")
    try:
        await asyncio.to_thread(_do)
        events.publish({"type": "training_push", "job_id": job["id"], "status": "done",
                        "repo": push["repo_id"]})
    except Exception as e:
        events.publish({"type": "training_push", "job_id": job["id"], "status": "error",
                        "detail": str(e)[:300]})


@router.post("/jobs/{job_id}/checkpoint")
async def manual_checkpoint(job_id: str):
    if _live["job_id"] != job_id:
        raise HTTPException(409, "Job is not running")
    async with httpx.AsyncClient(timeout=10) as client:
        (await client.post(f"http://127.0.0.1:{PORT}/checkpoint")).raise_for_status()
    return {"ok": True, "detail": "Checkpoint will be saved at the next step"}


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    if _live["job_id"] != job_id:
        raise HTTPException(409, "Job is not running")
    async with httpx.AsyncClient(timeout=10) as client:
        (await client.post(f"http://127.0.0.1:{PORT}/cancel")).raise_for_status()
    return {"ok": True}


@router.delete("/jobs/{job_id}")
def delete_job(job_id: str):
    _job(job_id)
    if _live["job_id"] == job_id:
        raise HTTPException(409, "Cancel the job before deleting it")
    d = job_dir(job_id)
    if d.exists():
        shutil.rmtree(d)
    _save_jobs([j for j in _jobs() if j["id"] != job_id])
    return {"ok": True}


@router.get("/jobs/{job_id}/files/{path:path}")
def get_file(job_id: str, path: str):
    _job(job_id)
    p = job_dir(job_id) / path
    if not path_inside(job_dir(job_id), p) or not p.is_file():
        raise HTTPException(404, "No such file")
    if p.suffix not in (".safetensors", ".png", ".jpg", ".log", ".json"):
        raise HTTPException(403, "File type not served")
    return FileResponse(p)


class ToLorasBody(BaseModel):
    checkpoint_file: str


@router.post("/jobs/{job_id}/to-loras")
def checkpoint_to_loras(job_id: str, body: ToLorasBody):
    """Copy a checkpoint into the LoRA library so it's usable in generation."""
    job = _job(job_id)
    ckpt = next((c for c in job["checkpoints"] if c["file"] == body.checkpoint_file), None)
    if not ckpt:
        raise HTTPException(404, "No such checkpoint")
    src = job_dir(job_id) / ("checkpoints" if "/" not in ckpt["file"] else "") / ckpt["file"]
    if not path_inside(job_dir(job_id), src) or not src.exists():
        raise HTTPException(404, "Checkpoint file missing on disk")
    slug = re.sub(r"[^A-Za-z0-9-]+", "-", job["name"].lower()).strip("-") or job_id
    dest = config.LORAS_DIR / safe_filename(f"{slug}-step{ckpt['step']}.safetensors")
    shutil.copyfile(src, dest)
    atomic_write_json(dest.with_suffix(dest.suffix + ".json"), {
        "source": {"kind": "training", "job_id": job_id, "step": ckpt["step"]},
        "label": f"{job['name']} @ {ckpt['step']}",
        "downloaded": time.time(),
    })
    return {"ok": True, "file": dest.name}


async def shutdown() -> None:
    if _live["poll_task"]:
        _live["poll_task"].cancel()
    await proc.stop(_live["proc"], PORT)
