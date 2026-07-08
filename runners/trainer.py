"""LoRA trainer runner.

Mock mode simulates a full training run (steps, loss curve, checkpoints at
the configured schedule, sample images per checkpoint) so the entire
Training UI/API is exercisable without a GPU.

Real mode drives ostris/ai-toolkit: it writes a config YAML and runs
`python run.py <config>` from AI_TOOLKIT_DIR (default /workspace/ai-toolkit,
cloned at pod setup), parsing stdout for step progress and scanning the
output folder for checkpoints/samples.

  GET  /health   POST /start   GET /status   POST /checkpoint
  POST /cancel   POST /shutdown
"""
import argparse
import json
import math
import os
import random
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from runner import _mock_frame  # pure-python PNG synthesis, stdlib only

CONFIG: dict = {}
STATE = {
    "state": "idle",  # idle|running|done|error|cancelled
    "step": 0, "total": 0, "loss": None, "sec_per_step": None,
    "checkpoints": [],  # [{step, file, samples: [names]}]
    "error": None,
    "cancel": False, "manual_save": False,
    "thread": None,
}


def job_dir() -> Path:
    return Path(CONFIG["job_dir"])


def _save_checkpoint(step: int, job: dict) -> None:
    ckpt_dir = job_dir() / "checkpoints"
    samples_dir = job_dir() / "samples"
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    samples_dir.mkdir(parents=True, exist_ok=True)
    fname = f"lora_step_{step:06d}.safetensors"
    if CONFIG.get("mock"):
        # Minimal valid-looking dummy payload
        (ckpt_dir / fname).write_bytes(b"PLEO-MOCK-LORA" + os.urandom(4096))
    samples = []
    for i, prompt in enumerate(job.get("sample_prompts", [])[:4]):
        name = f"step_{step:06d}_{i}.png"
        if CONFIG.get("mock"):
            png = _mock_frame(256, 256, hash((step, i)) & 0x7FFFFFFF, prompt,
                              min(1.0, step / max(1, STATE["total"])))
            (samples_dir / name).write_bytes(png)
        samples.append(name)
    STATE["checkpoints"].append({"step": step, "file": fname, "samples": samples})


def mock_train(job: dict) -> None:
    total = STATE["total"]
    schedule = set(job.get("checkpoint_steps", []))
    pace = float(CONFIG.get("mock_sec_per_step", 0.03))
    rng = random.Random(1234)
    t_prev = time.monotonic()
    avg = None
    for step in range(1, total + 1):
        if STATE["cancel"]:
            STATE["state"] = "cancelled"
            return
        time.sleep(pace)
        now = time.monotonic()
        dt = now - t_prev
        t_prev = now
        avg = dt if avg is None else avg * 0.9 + dt * 0.1
        STATE["step"] = step
        STATE["sec_per_step"] = round(avg, 4)
        STATE["loss"] = round(0.35 * math.exp(-3 * step / total) + 0.02 + rng.uniform(-0.008, 0.008), 5)
        if step in schedule or STATE["manual_save"]:
            STATE["manual_save"] = False
            _save_checkpoint(step, job)
    if not any(c["step"] == total for c in STATE["checkpoints"]):
        _save_checkpoint(total, job)  # always save the final state
    STATE["state"] = "done"


# ---------------- real mode (ai-toolkit) ----------------

AI_TOOLKIT_DIR = os.environ.get("AI_TOOLKIT_DIR", "/workspace/ai-toolkit")

# ai-toolkit model arch names per Pleo model family — verify against the
# installed ai-toolkit version on the pod.
ARCH_BY_FAMILY = {"zimage": "z_image", "qwen-image": "qwen_image"}


def build_toolkit_config(job: dict) -> Path:
    base = CONFIG["base_model"]
    arch = ARCH_BY_FAMILY.get(base["family"])
    if not arch:
        raise RuntimeError(f"Family {base['family']} is not trainable")
    save_every = 250
    cfg = {
        "job": "extension",
        "config": {
            "name": job["id"],
            "process": [{
                "type": "sd_trainer",
                "training_folder": str(job_dir() / "output"),
                "device": "cuda:0",
                "trigger_word": job.get("trigger_word") or None,
                "network": {"type": "lora", "linear": job.get("rank", 16),
                            "linear_alpha": job.get("rank", 16)},
                "save": {"dtype": "float16", "save_every": save_every,
                         "max_step_saves_to_keep": 1000},
                "datasets": [{"folder_path": CONFIG["dataset_dir"],
                              "caption_ext": "txt", "caption_dropout_rate": 0.05,
                              "resolution": [job.get("resolution", 1024)]}],
                "train": {"batch_size": job.get("batch_size", 1),
                          "steps": job["steps"], "gradient_accumulation_steps": 1,
                          "train_unet": True, "train_text_encoder": False,
                          "lr": job.get("lr", 1e-4), "optimizer": "adamw8bit",
                          "dtype": "bf16", "gradient_checkpointing": True,
                          "noise_scheduler": "flowmatch"},
                "model": {"name_or_path": base["repo_id"], "arch": arch,
                          "quantize": True},
                "sample": {"sampler": "flowmatch", "sample_every": save_every,
                           "width": 1024, "height": 1024,
                           "prompts": job.get("sample_prompts", []),
                           "seed": 42, "walk_seed": True,
                           "guidance_scale": 3.5, "sample_steps": 25},
            }],
        },
    }
    path = job_dir() / "aitk-config.json"
    path.write_text(json.dumps(cfg, indent=2))
    return path


STEP_RE = re.compile(r"(\d+)/(\d+)")


def real_train(job: dict) -> None:
    if not Path(AI_TOOLKIT_DIR, "run.py").exists():
        STATE["state"] = "error"
        STATE["error"] = (f"ai-toolkit not found at {AI_TOOLKIT_DIR} — "
                          "git clone https://github.com/ostris/ai-toolkit there")
        return
    cfg_path = build_toolkit_config(job)
    env = dict(os.environ, HF_HOME=CONFIG["hf_home"])
    proc = subprocess.Popen(
        ["python", "run.py", str(cfg_path)], cwd=AI_TOOLKIT_DIR, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    STATE["proc"] = proc
    t_prev, avg = time.monotonic(), None
    last_step = 0
    log = open(job_dir() / "train.log", "w")
    for line in proc.stdout:
        log.write(line)
        log.flush()
        if STATE["cancel"]:
            proc.terminate()
            STATE["state"] = "cancelled"
            log.close()
            return
        m = STEP_RE.search(line)
        if m and int(m.group(2)) == STATE["total"]:
            step = int(m.group(1))
            if step > last_step:
                now = time.monotonic()
                dt = (now - t_prev) / max(1, step - last_step)
                t_prev, last_step = now, step
                avg = dt if avg is None else avg * 0.9 + dt * 0.1
                STATE["step"] = step
                STATE["sec_per_step"] = round(avg, 4)
            lm = re.search(r"loss[:=]\s*([0-9.]+)", line)
            if lm:
                STATE["loss"] = float(lm.group(1))
            _scan_toolkit_outputs(job)
    proc.wait()
    log.close()
    _scan_toolkit_outputs(job)
    STATE["state"] = "done" if proc.returncode == 0 else "error"
    if proc.returncode != 0:
        STATE["error"] = f"ai-toolkit exited {proc.returncode} — see train.log"


def _scan_toolkit_outputs(job: dict) -> None:
    out = job_dir() / "output" / job["id"]
    if not out.exists():
        return
    seen = {c["file"] for c in STATE["checkpoints"]}
    for f in sorted(out.glob("*.safetensors")):
        if f.name in seen:
            continue
        m = re.search(r"(\d+)", f.stem)
        step = int(m.group(1)) if m else STATE["step"]
        samples = [s.name for s in sorted((out / "samples").glob(f"*{step}*.png"))] \
            if (out / "samples").exists() else []
        STATE["checkpoints"].append({"step": step, "file": str(f.relative_to(job_dir())),
                                     "samples": samples})


# ---------------- HTTP ----------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True})
        elif self.path == "/status":
            self._json(200, {k: STATE[k] for k in
                             ("state", "step", "total", "loss", "sec_per_step", "checkpoints", "error")})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        try:
            if self.path == "/start":
                if STATE["state"] == "running":
                    self._json(409, {"error": "already running"})
                    return
                job = CONFIG["training_job"]
                STATE.update(state="running", step=0, total=job["steps"], loss=None,
                             sec_per_step=None, checkpoints=[], error=None,
                             cancel=False, manual_save=False)
                target = mock_train if CONFIG.get("mock") else real_train
                STATE["thread"] = threading.Thread(target=self._run, args=(target, job), daemon=True)
                STATE["thread"].start()
                self._json(200, {"ok": True})
            elif self.path == "/checkpoint":
                STATE["manual_save"] = True
                self._json(200, {"ok": True})
            elif self.path == "/cancel":
                STATE["cancel"] = True
                self._json(200, {"ok": True})
            elif self.path == "/shutdown":
                STATE["cancel"] = True
                self._json(200, {"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                self._json(404, {"error": "not found"})
        except Exception as e:
            try:
                self._json(500, {"error": str(e)[:500]})
            except Exception:
                pass

    @staticmethod
    def _run(target, job):
        try:
            target(job)
        except Exception as e:
            STATE["state"] = "error"
            STATE["error"] = str(e)[:500]


def main():
    global CONFIG
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--config", required=True)
    args = ap.parse_args()
    with open(args.config) as f:
        CONFIG = json.load(f)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[trainer] on :{args.port} mock={CONFIG.get('mock')}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
