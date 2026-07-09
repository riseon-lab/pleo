"""End-to-end API tests against a running Pleo backend (mock mode)."""
import base64
import hashlib
import hmac
import json
import os
import sys
import threading
import time

import httpx

BASE = os.environ.get("PLEO_TEST_BASE", "http://127.0.0.1:3210")
PASSWORD = "correct horse battery staple"
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not cond else ""))


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    out, t, i = b"", b"", 1
    while len(out) < length:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        out += t
        i += 1
    return out[:length]


def derive_auth_key(password: str, salt_b64: str, iterations: int) -> str:
    """Mirror crypto-worker.js: PBKDF2-SHA256 -> HKDF(info='pleo-auth-v1')."""
    bits = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt_b64), iterations, 32)
    auth = hkdf_sha256(bits, b"\x00" * 16, b"pleo-auth-v1", 32)
    return base64.b64encode(auth).decode()


c = httpx.Client(base_url=BASE, timeout=30)

# --- auth ---
meta = c.get("/api/auth/meta").json()
check("meta: no account on fresh boot", meta == {"exists": False}, str(meta))

check("unauthed /api/models rejected", c.get("/api/models").status_code == 401)

salt = base64.b64encode(os.urandom(16)).decode()
iterations = 600000
auth_key = derive_auth_key(PASSWORD, salt, iterations)
r = c.post("/api/auth/signup", json={"salt": salt, "iterations": iterations, "auth_key": auth_key})
check("signup", r.status_code == 200 and "token" in r.json(), r.text)
token = r.json()["token"]

r = c.post("/api/auth/signup", json={"salt": salt, "iterations": iterations, "auth_key": auth_key})
check("second signup blocked (409)", r.status_code == 409, r.text)

bad = derive_auth_key("wrong password", salt, iterations)
r = c.post("/api/auth/login", json={"auth_key": bad})
check("wrong password rejected", r.status_code == 401, r.text)

meta = c.get("/api/auth/meta").json()
r = c.post("/api/auth/login", json={"auth_key": derive_auth_key(PASSWORD, meta["salt"], meta["iterations"])})
check("login with derived key", r.status_code == 200, r.text)
token = r.json()["token"]
H = {"Authorization": f"Bearer {token}"}

# --- CSRF guard ---
r = c.post("/api/models/stop", headers={**H, "Origin": "http://evil.example"})
check("cross-origin POST rejected", r.status_code == 403, r.text)
r = c.post("/api/models/stop", headers={**H, "Origin": BASE.replace("http://", "http://")})
check("same-origin POST allowed", r.status_code == 200, r.text)
# Reverse-proxy (RunPod) case: Origin is the public proxy hostname, Host is
# internal, X-Forwarded-Host carries the public name.
r = c.post("/api/models/stop", headers={**H, "Origin": "https://abc-3000.proxy.runpod.net",
                                        "X-Forwarded-Host": "abc-3000.proxy.runpod.net"})
check("proxied same-origin POST allowed (X-Forwarded-Host)", r.status_code == 200, r.text)
r = c.post("/api/models/stop", headers={**H, "Origin": "https://evil.example",
                                        "X-Forwarded-Host": "abc-3000.proxy.runpod.net"})
check("cross-origin POST still rejected behind proxy", r.status_code == 403, r.text)

# --- models ---
r = c.get("/api/models", headers=H)
models = r.json()
check("models list (4, mock mode)", len(models["models"]) == 4 and models["mock"] is True, r.text[:200])

# --- SSE collector ---
events = []
stop_sse = threading.Event()

def sse_reader():
    try:
        with c.stream("GET", f"/api/events?token={token}", timeout=httpx.Timeout(10, read=90)) as r:
            for line in r.iter_lines():
                if stop_sse.is_set():
                    return
                if line.startswith("data: "):
                    events.append(json.loads(line[6:]))
    except Exception as e:
        print("sse reader ended:", e)

r_bad = c.get("/api/events?token=nope")
check("SSE with bad token rejected", r_bad.status_code == 401)
threading.Thread(target=sse_reader, daemon=True).start()
time.sleep(0.5)

# --- generation (mock) ---
gen = {"model_id": "z-image-turbo", "prompt": "a lighthouse at dusk", "negative_prompt": "",
       "steps": 4, "cfg": 0, "width": 256, "height": 320, "seed": 42, "loras": []}
r = c.post("/api/generate", headers=H, json=gen)
check("submit generation", r.status_code == 200, r.text)
job_id = r.json()["job"]["id"]

deadline = time.time() + 90
done_job = None
while time.time() < deadline:
    q = c.get("/api/queue", headers=H).json()
    done_job = next((j for j in q["history"] if j["id"] == job_id), None)
    if done_job:
        break
    time.sleep(1)
check("job completed", done_job and done_job["status"] == "done", str(done_job))
check("random seed resolved (submitted 42)", done_job and done_job["seed"] == 42, str(done_job and done_job["seed"]))

steps_seen = [e for e in events if e.get("type") == "step" and e.get("job_id") == job_id]
check("SSE step events streamed", len(steps_seen) == 4, f"{len(steps_seen)} step events")
check("step previews are PNGs", steps_seen and base64.b64decode(steps_seen[0]["preview_b64"])[:4] == b"\x89PNG")
job_events = [e["job"]["status"] for e in events if e.get("type") == "job" and e["job"]["id"] == job_id]
check("SSE job lifecycle", "done" in job_events, str(job_events))

# --- result outbox ---
result_id = done_job["result_id"]
r = c.get(f"/api/results/{result_id}", headers=H)
check("fetch result PNG", r.status_code == 200 and r.content[:4] == b"\x89PNG", str(r.status_code))
meta_hdr = json.loads(base64.b64decode(r.headers["x-pleo-meta-plain"]))
check("result meta header", meta_hdr["seed"] == 42 and meta_hdr["prompt"] == gen["prompt"], str(meta_hdr))
png = r.content
w = int.from_bytes(png[16:20], "big"); hgt = int.from_bytes(png[20:24], "big")
check("result matches requested resolution", (w, hgt) == (256, 320), f"{w}x{hgt}")

# --- encrypted asset roundtrip (server sees opaque bytes) ---
blob = os.urandom(50000)
enc_meta = base64.b64encode(os.urandom(64)).decode()
r = c.post("/api/assets", headers={**H, "X-Pleo-Kind": "generated", "X-Pleo-Meta": enc_meta,
                                   "Content-Type": "application/octet-stream"}, content=blob)
check("asset upload", r.status_code == 200, r.text)
asset_id = r.json()["id"]
r = c.get("/api/assets", headers=H)
entry = next((a for a in r.json()["assets"] if a["id"] == asset_id), None)
check("asset listed with enc_meta", entry and entry["enc_meta"] == enc_meta and entry["size"] == len(blob))
r = c.get(f"/api/assets/{asset_id}/blob", headers=H)
check("asset blob roundtrip (byte-exact)", r.content == blob)
r = c.delete(f"/api/results/{result_id}", headers=H)
check("discard outbox result", r.status_code == 200)
check("outbox result gone after discard", c.get(f"/api/results/{result_id}", headers=H).status_code == 404)
r = c.delete(f"/api/assets/{asset_id}", headers=H)
check("asset delete", r.status_code == 200)
check("asset gone from index", not any(a["id"] == asset_id for a in c.get("/api/assets", headers=H).json()["assets"]))

# --- queue: second job queues, cancel queued job ---
long_gen = {**gen, "steps": 30, "seed": -1}
r1 = c.post("/api/generate", headers=H, json=long_gen)
r2 = c.post("/api/generate", headers=H, json={**gen, "prompt": "queued job"})
check("two jobs accepted", r1.status_code == 200 and r2.status_code == 200)
j1, j2 = r1.json()["job"]["id"], r2.json()["job"]["id"]
time.sleep(1)
q = c.get("/api/queue", headers=H).json()
check("second job waits in queue", any(j["id"] == j2 for j in q["queued"]), str(q))
r = c.post(f"/api/jobs/{j2}/cancel", headers=H)
check("cancel queued job", r.status_code == 200)
time.sleep(2)
r = c.post(f"/api/jobs/{j1}/cancel", headers=H)  # cancel mid-run
deadline = time.time() + 30
st1 = st2 = None
while time.time() < deadline:
    q = c.get("/api/queue", headers=H).json()
    st1 = next((j["status"] for j in q["history"] if j["id"] == j1), None)
    st2 = next((j["status"] for j in q["history"] if j["id"] == j2), None)
    if st1 and st2 and not q["current"]:
        break
    time.sleep(1)
check("running job cancelled mid-generation", st1 == "cancelled", str(st1))
check("queued job cancelled", st2 == "cancelled", str(st2))

# --- validation ---
r = c.post("/api/generate", headers=H, json={**gen, "width": 250})
check("non-multiple-of-8 rejected", r.status_code in (400, 422), str(r.status_code))
r = c.post("/api/generate", headers=H, json={**gen, "model_id": "qwen-image-edit-2511"})
check("edit model without ref image rejected", r.status_code == 400, r.text)
r = c.post("/api/generate", headers=H, json={**gen, "loras": [{"file": "../../../etc/passwd", "strength": 1}]})
check("lora path traversal rejected", r.status_code == 400, r.text)

# --- loras: local file lifecycle ---
from pathlib import Path
loras_dir = Path("data/loras")
(loras_dir / "test-lora.safetensors").write_bytes(b"\x00" * 128)
r = c.get("/api/loras", headers=H)
check("local lora listed", any(l["file"] == "test-lora.safetensors" for l in r.json()["loras"]))
gen_l = {**gen, "steps": 2, "loras": [{"file": "test-lora.safetensors", "strength": -0.5}]}
r = c.post("/api/generate", headers=H, json=gen_l)
check("generate with lora stack accepted", r.status_code == 200, r.text)
jl = r.json()["job"]["id"]
deadline = time.time() + 30
stl = None
while time.time() < deadline:
    q = c.get("/api/queue", headers=H).json()
    stl = next((j["status"] for j in q["history"] if j["id"] == jl), None)
    if stl:
        break
    time.sleep(1)
check("lora job completed", stl == "done", str(stl))
r = c.delete("/api/loras/test-lora.safetensors", headers=H)
check("lora delete", r.status_code == 200)
r = c.post("/api/loras/hf/download", headers=H, json={"repo_id": "bad//repo", "filename": "x.safetensors"})
check("bad HF repo id rejected", r.status_code == 400)
r = c.post("/api/loras/civitai/resolve", headers=H, json={"url": "https://example.com/models/123"})
check("non-civitai URL rejected", r.status_code == 400, r.text)

# --- settings ---
kb = base64.b64encode(os.urandom(96)).decode()
r = c.post("/api/settings/keys", headers=H, json={"blob": kb})
check("keys blob save", r.status_code == 200)
check("keys blob roundtrip", c.get("/api/settings/keys", headers=H).json()["blob"] == kb)

r = c.post("/api/moderate", headers=H, json={"image_b64": base64.b64encode(b"notanimage").decode()})
check("moderate no-op when disabled", r.json() == {"enabled": False, "allowed": True}, r.text)

r = c.post("/api/settings/moderation", headers=H, json={"enabled": True})
check("moderation toggle on", r.status_code == 200 and r.json()["enabled"] is True)
# fail-closed: no classifier installed -> generation output must be BLOCKED
r = c.post("/api/generate", headers=H, json={**gen, "steps": 2, "prompt": "fail closed check"})
jb = r.json()["job"]["id"]
deadline = time.time() + 30
stb = None
while time.time() < deadline:
    q = c.get("/api/queue", headers=H).json()
    stb = next((j["status"] for j in q["history"] if j["id"] == jb), None)
    if stb:
        break
    time.sleep(1)
check("moderation fail-closed blocks output", stb == "blocked", str(stb))
c.post("/api/settings/moderation", headers=H, json={"enabled": False})

r = c.post("/api/settings/git-pull", headers=H)
check("git-pull returns structured result", r.status_code == 200 and
      isinstance(r.json().get("ok"), bool) and "stdout" in r.json(), r.text[:200])

r = c.get("/api/settings/status", headers=H)
check("status endpoint", r.status_code == 200 and r.json()["mock"] is True, r.text[:200])

# --- data studio ---
def tiny_png(seed: int = 0) -> bytes:
    import struct, zlib
    w = h_ = 16
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    row = bytes([seed % 256, (seed * 7) % 256, (seed * 13) % 256] * w)
    raw = b"".join(b"\x00" + row for _ in range(h_))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h_, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

r = c.post("/api/datasets", headers=H, json={"name": "test set"})
check("dataset create", r.status_code == 200, r.text)
ds_id = r.json()["id"]
for i in range(3):
    r = c.post(f"/api/datasets/{ds_id}/images", headers={**H, "X-Pleo-Filename": f"img{i}.png",
               "Content-Type": "application/octet-stream"}, content=tiny_png(i))
    check(f"dataset image upload {i}", r.status_code == 200, r.text)
r = c.post(f"/api/datasets/{ds_id}/images", headers={**H, "X-Pleo-Filename": "evil.exe",
           "Content-Type": "application/octet-stream"}, content=b"MZ")
check("non-image extension rejected", r.status_code == 400, r.text)
ds = c.get(f"/api/datasets/{ds_id}", headers=H).json()
check("dataset lists 3 images", ds["count"] == 3, str(ds["count"]))
r = c.put(f"/api/datasets/{ds_id}/caption", headers=H, json={"file": "img0.png", "caption": "a manual caption"})
check("manual caption save", r.status_code == 200)
r = c.put(f"/api/datasets/{ds_id}/trigger", headers=H, json={"trigger_word": "zxq99"})
check("trigger word save", r.status_code == 200)
r = c.post(f"/api/datasets/{ds_id}/trigger/apply", headers=H)
check("trigger applied to captions", r.json().get("changed") == 3, r.text)
ds = c.get(f"/api/datasets/{ds_id}", headers=H).json()
cap0 = next(i["caption"] for i in ds["items"] if i["file"] == "img0.png")
check("trigger prepended to existing caption", cap0.startswith("zxq99, a manual caption"), cap0)

# captioner + autocaption
r = c.post(f"/api/datasets/{ds_id}/autocaption", headers=H, json={"overwrite": True})
check("autocaption without captioner rejected", r.status_code == 409, r.text)
envs = c.get("/api/envs", headers=H).json()
check("envs list includes captioner + trainer components",
      "captioner" in envs and "trainer" in envs and "z-image-base" in envs, str(envs.keys()))
r = c.get("/api/captioner", headers=H)
check("captioner status exposes weights info", "weights" in r.json() and "weights_bytes" in r.json(), r.text)
r = c.delete("/api/captioner/weights", headers=H)
check("captioner weights delete (no-op ok)", r.status_code == 200, r.text)
r = c.post("/api/captioner/start", headers=H)
check("captioner starts (mock)", r.status_code == 200 and r.json()["status"] == "ready", r.text)
r = c.delete("/api/captioner/weights", headers=H)
check("weights delete blocked while running", r.status_code == 409, r.text)
r = c.post(f"/api/datasets/{ds_id}/autocaption", headers=H, json={"overwrite": True})
check("autocaption queued", r.status_code == 200 and r.json()["queued"] == 3, r.text)
deadline = time.time() + 30
while time.time() < deadline:
    ds = c.get(f"/api/datasets/{ds_id}", headers=H).json()
    if ds["captioned"] == 3 and not ds.get("autocaption"):
        break
    time.sleep(0.5)
check("autocaption completed all 3", ds["captioned"] == 3, str(ds))
check("autocaption includes trigger word", all("zxq99" in i["caption"] for i in ds["items"]),
      str([i["caption"] for i in ds["items"]]))
r = c.post("/api/captioner/stop", headers=H)
check("captioner stops", r.status_code == 200 and r.json()["status"] == "stopped")
r = c.delete(f"/api/datasets/{ds_id}/images/img2.png", headers=H)
check("dataset image delete", r.status_code == 200)

# --- training ---
r = c.get("/api/training/toolkit", headers=H)
check("toolkit status endpoint", r.status_code == 200 and "present" in r.json() and "dir" in r.json(), r.text)
r = c.post("/api/training/toolkit/install", headers=H)
check("toolkit install (mock short-circuit)", r.status_code == 200, r.text)
r = c.get("/api/training/toolkit", headers=H)
check("toolkit ready after mock install", r.json()["status"] == "ready", r.text)

base_job = {"name": "cancel me", "dataset_id": ds_id, "base_model": "z-image-base",
            "trigger_word": "zxq99", "steps": 3000, "checkpoint_steps": [250],
            "sample_prompts": ["zxq99 portrait"], "rank": 16, "lr": 0.0001,
            "resolution": 512, "batch_size": 1}
r = c.post("/api/training/jobs", headers=H, json={**base_job, "base_model": "qwen-image-edit-2511"})
check("non-trainable base rejected", r.status_code == 400, r.text)
r = c.post("/api/training/jobs", headers=H, json={**base_job, "optimizer": "sgd-turbo"})
check("unknown optimizer rejected", r.status_code == 400, r.text)
r = c.post("/api/training/jobs", headers=H, json={**base_job, "lr_scheduler": "wavy"})
check("unknown lr scheduler rejected", r.status_code == 400, r.text)
r = c.post("/api/training/jobs", headers=H, json={**base_job, "vram_profile": "gigantic"})
check("unknown vram profile rejected", r.status_code == 400, r.text)
meta_t = c.get("/api/training/jobs", headers=H).json()
check("optimizer/scheduler option lists exposed",
      "adamw8bit" in meta_t["optimizers"] and "cosine" in meta_t["lr_schedulers"], str(meta_t.keys()))
r = c.post("/api/training/jobs", headers=H, json=base_job)
check("training job starts", r.status_code == 200 and r.json()["status"] == "running", r.text[:200])
tj1 = r.json()["id"]
r = c.post("/api/training/jobs", headers=H, json={**base_job, "name": "second"})
check("second concurrent training rejected", r.status_code == 409, r.text)
time.sleep(2.5)
r = c.post(f"/api/training/jobs/{tj1}/checkpoint", headers=H)
check("manual checkpoint accepted", r.status_code == 200, r.text)
r = c.delete(f"/api/training/jobs/{tj1}", headers=H)
check("delete running job rejected", r.status_code == 409, r.text)
time.sleep(1.5)
r = c.post(f"/api/training/jobs/{tj1}/cancel", headers=H)
check("training cancel accepted", r.status_code == 200, r.text)
deadline = time.time() + 30
j1 = None
while time.time() < deadline:
    j1 = next(j for j in c.get("/api/training/jobs", headers=H).json()["jobs"] if j["id"] == tj1)
    if j1["status"] == "cancelled":
        break
    time.sleep(0.5)
check("training cancelled mid-run", j1["status"] == "cancelled", str(j1["status"]))
check("manual checkpoint was saved before cancel", len(j1["checkpoints"]) >= 1, str(j1["checkpoints"]))
check("sec_per_step measured", j1["sec_per_step"] is not None and j1["sec_per_step"] > 0, str(j1["sec_per_step"]))

r = c.post("/api/training/jobs", headers=H, json={**base_job, "name": "tiny run", "steps": 300,
                                                  "checkpoint_steps": [100, 200],
                                                  "optimizer": "prodigy", "lr_scheduler": "cosine",
                                                  "alpha": 32, "vram_profile": "high",
                                                  "gradient_checkpointing": False})
check("short training job starts", r.status_code == 200, r.text[:200])
tj2 = r.json()["id"]
check("optimizer/scheduler/alpha recorded", r.json()["optimizer"] == "prodigy"
      and r.json()["lr_scheduler"] == "cosine" and r.json()["alpha"] == 32, r.text[:300])
check("vram profile + grad ckpt recorded", r.json()["vram_profile"] == "high"
      and r.json()["gradient_checkpointing"] is False, r.text[:300])
deadline = time.time() + 60
j2 = None
while time.time() < deadline:
    j2 = next(j for j in c.get("/api/training/jobs", headers=H).json()["jobs"] if j["id"] == tj2)
    if j2["status"] in ("done", "error"):
        break
    time.sleep(0.5)
check("training completes", j2["status"] == "done", str(j2["status"]) + str(j2.get("error")))
steps_saved = [ck["step"] for ck in j2["checkpoints"]]
check("checkpoints at schedule + final", steps_saved == [100, 200, 300], str(steps_saved))
check("samples per checkpoint", all(len(ck["samples"]) == 1 for ck in j2["checkpoints"]), str(j2["checkpoints"]))
sample = j2["checkpoints"][0]["samples"][0]
r = c.get(f"/api/training/jobs/{tj2}/files/samples/{sample}", headers=H)
check("checkpoint sample is a PNG", r.status_code == 200 and r.content[:4] == b"\x89PNG", str(r.status_code))
r = c.get(f"/api/training/jobs/{tj2}/files/checkpoints/../../../../account.json", headers=H)
check("training file traversal rejected", r.status_code in (403, 404), str(r.status_code))
r = c.post(f"/api/training/jobs/{tj2}/to-loras", headers=H, json={"checkpoint_file": j2["checkpoints"][-1]["file"]})
check("checkpoint promoted to LoRA library", r.status_code == 200, r.text)
lora_name = r.json()["file"]
check("promoted LoRA listed", any(l["file"] == lora_name for l in c.get("/api/loras", headers=H).json()["loras"]))
r = c.delete(f"/api/training/jobs/{tj1}", headers=H)
check("cancelled job deletable", r.status_code == 200, r.text)
c.delete(f"/api/loras/{lora_name}", headers=H)

r = c.get("/api/settings/moderation", headers=H)
check("moderation status shows model_present flag", "model_present" in r.json(), r.text)

# --- logout ---
r = c.post("/api/auth/logout", headers=H)
check("logout", r.status_code == 200)
check("token dead after logout", c.get("/api/models", headers=H).status_code == 401)

stop_sse.set()
fails = [r for r in results if not r[1]]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
