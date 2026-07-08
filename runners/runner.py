"""Pleo model runner. One process per loaded model, spawned by the backend
with the model venv's interpreter.

Protocol (localhost HTTP, NDJSON streaming on /generate):
  GET  /health    -> {"ok": true, "loaded": bool}
  POST /load      -> loads the pipeline (downloads weights on first use)
  POST /generate  -> streams {"type":"step",...} lines, then one terminal
                     {"type":"done"|"error"|"cancelled",...} line
  POST /cancel    -> sets the cancel flag (checked between steps)
  POST /shutdown  -> exits

Mock mode (PLEO config "mock": true) synthesizes images with a pure-python
PNG writer so the whole app can be exercised without a GPU or any ML deps.
"""
import argparse
import base64
import hashlib
import io
import json
import math
import os
import random
import struct
import sys
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG: dict = {}
STATE = {
    "loaded": False,
    "pipe": None,
    "lock": threading.Lock(),        # single-flight: one generation at a time
    "cancel": threading.Event(),
}


class Cancelled(Exception):
    pass


# ---------------- Pure-python PNG (mock mode) ----------------

def write_png(width: int, height: int, rgb: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + rgb[y * width * 3:(y + 1) * width * 3] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6))
            + chunk(b"IEND", b""))


def _mock_frame(width: int, height: int, seed: int, prompt: str, progress: float) -> bytes:
    """Deterministic gradient + shapes, with noise fading out as steps advance."""
    rng = random.Random(seed)
    h = int(hashlib.sha256(prompt.encode()).hexdigest(), 16)
    hue = (h % 360) / 360.0
    def hsv(hh, s, v):
        i = int(hh * 6) % 6
        f = hh * 6 - int(hh * 6)
        p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
        return [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i]
    c1 = hsv(hue, 0.45, 0.95)
    c2 = hsv((hue + 0.35) % 1.0, 0.55, 0.55)
    cx, cy = rng.uniform(0.25, 0.75), rng.uniform(0.25, 0.75)
    radius = rng.uniform(0.15, 0.35)
    noise_amp = int((1.0 - progress) * 160)
    nrng = random.Random(seed * 7919 + int(progress * 1000))
    noise = nrng.randbytes(width * height) if noise_amp else b"\x00" * (width * height)
    buf = bytearray(width * height * 3)
    i = 0
    for y in range(height):
        fy = y / max(1, height - 1)
        for x in range(width):
            fx = x / max(1, width - 1)
            t = (fx + fy) / 2
            r = c1[0] * (1 - t) + c2[0] * t
            g = c1[1] * (1 - t) + c2[1] * t
            b = c1[2] * (1 - t) + c2[2] * t
            d = math.hypot(fx - cx, fy - cy)
            if d < radius:
                glow = (1 - d / radius) * 0.5 * progress
                r, g, b = r + glow, g + glow, b + glow
            n = (noise[y * width + x] - 128) * noise_amp // 128 if noise_amp else 0
            buf[i] = max(0, min(255, int(r * 255) + n))
            buf[i + 1] = max(0, min(255, int(g * 255) + n))
            buf[i + 2] = max(0, min(255, int(b * 255) + n))
            i += 3
    return write_png(width, height, bytes(buf))


def _upscale_nearest(rgb: bytes, w: int, h: int, tw: int, th: int) -> bytes:
    out = bytearray(tw * th * 3)
    for ty in range(th):
        sy = ty * h // th
        row = memoryview(rgb)[sy * w * 3:(sy + 1) * w * 3]
        orow = bytearray(tw * 3)
        for tx in range(tw):
            sx = tx * w // tw
            orow[tx * 3:tx * 3 + 3] = row[sx * 3:sx * 3 + 3]
        out[ty * tw * 3:(ty + 1) * tw * 3] = orow
    return bytes(out)


def mock_generate(params: dict, emit) -> dict:
    import time
    seed = params["seed"]
    if seed < 0:
        seed = random.SystemRandom().randrange(2 ** 31)
    steps = params["steps"]
    tw, th = params["width"], params["height"]
    # Render small, upscale at the end — keeps pure-python mock fast.
    scale = max(1, max(tw, th) // 384)
    w, h = max(64, tw // scale // 8 * 8), max(64, th // scale // 8 * 8)
    pw, ph = max(32, w // 2), max(32, h // 2)
    for step in range(1, steps + 1):
        if STATE["cancel"].is_set():
            raise Cancelled()
        time.sleep(0.35)
        preview = _mock_frame(pw, ph, seed, params["prompt"], step / steps)
        emit({"type": "step", "step": step, "total": steps,
              "preview_b64": base64.b64encode(preview).decode()})
    rgb = _png_rgb_rerender(w, h, seed, params["prompt"])
    up = _upscale_nearest(rgb, w, h, tw, th) if (w, h) != (tw, th) else rgb
    final = write_png(tw, th, up)
    return {"type": "done", "image_b64": base64.b64encode(final).decode(), "seed": seed}


def _png_rgb_rerender(w, h, seed, prompt):
    # Same pixels as _mock_frame(progress=1) but returning raw RGB.
    png = _mock_frame(w, h, seed, prompt, 1.0)  # noise_amp == 0 at progress 1
    # Extract IDAT and unfilter (all filters are 0 as written above).
    data = png[8:]
    idat = b""
    while data:
        length = struct.unpack(">I", data[:4])[0]
        tag = data[4:8]
        if tag == b"IDAT":
            idat += data[8:8 + length]
        data = data[12 + length:]
    raw = zlib.decompress(idat)
    stride = w * 3 + 1
    return b"".join(raw[y * stride + 1:(y + 1) * stride] for y in range(h))


# ---------------- Real mode (GPU, inside the model venv) ----------------

def real_load():
    os.environ.setdefault("HF_HOME", CONFIG["hf_home"])
    import torch
    from diffusers import DiffusionPipeline
    model = CONFIG["model"]
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    pipe = DiffusionPipeline.from_pretrained(model["repo_id"], torch_dtype=dtype)
    if torch.cuda.is_available():
        pipe = pipe.to("cuda")
    STATE["pipe"] = pipe
    STATE["loaded"] = True


def real_generate(params: dict, emit) -> dict:
    import torch
    pipe = STATE["pipe"]
    model = CONFIG["model"]
    family = model["family"]
    seed = params["seed"]
    if seed < 0:
        seed = random.SystemRandom().randrange(2 ** 31)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    generator = torch.Generator(device).manual_seed(seed)

    # LoRA stacking
    try:
        pipe.unload_lora_weights()
    except Exception:
        pass
    if params.get("loras"):
        names, weights = [], []
        for i, lora in enumerate(params["loras"]):
            name = f"lora{i}"
            pipe.load_lora_weights(lora["path"], adapter_name=name)
            names.append(name)
            weights.append(lora["strength"])
        pipe.set_adapters(names, adapter_weights=weights)

    total = params["steps"]

    def on_step(pipeline, step, timestep, callback_kwargs):
        if STATE["cancel"].is_set():
            raise Cancelled()
        preview_b64 = None
        latents = callback_kwargs.get("latents")
        try:
            if latents is not None and latents.dim() == 4:
                # Cheap latent-space "noise" preview: 3 channels normalized.
                lat = latents[0, :3].float()
                lat = (lat - lat.amin()) / (lat.amax() - lat.amin() + 1e-6)
                img = (lat.clamp(0, 1) * 255).byte().permute(1, 2, 0).cpu().numpy()
                from PIL import Image
                buf = io.BytesIO()
                Image.fromarray(img).resize((params["width"] // 4, params["height"] // 4),
                                            Image.NEAREST).save(buf, format="PNG")
                preview_b64 = base64.b64encode(buf.getvalue()).decode()
        except Exception:
            pass
        emit({"type": "step", "step": step + 1, "total": total, "preview_b64": preview_b64})
        return callback_kwargs

    kwargs = dict(
        prompt=params["prompt"],
        num_inference_steps=total,
        width=params["width"],
        height=params["height"],
        generator=generator,
        callback_on_step_end=on_step,
    )
    if params.get("negative_prompt"):
        kwargs["negative_prompt"] = params["negative_prompt"]
    if family in ("qwen-image", "qwen-image-edit"):
        kwargs["true_cfg_scale"] = params["cfg"]
    else:
        kwargs["guidance_scale"] = params["cfg"]
    if params.get("ref_image_b64"):
        from PIL import Image
        kwargs["image"] = Image.open(io.BytesIO(base64.b64decode(params["ref_image_b64"]))).convert("RGB")

    image = pipe(**kwargs).images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return {"type": "done", "image_b64": base64.b64encode(buf.getvalue()).decode(), "seed": seed}


# ---------------- HTTP server ----------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep runner logs quiet
        pass

    def _json(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "loaded": STATE["loaded"], "mock": CONFIG.get("mock", False)})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        try:
            if self.path == "/load":
                if not STATE["loaded"]:
                    if CONFIG.get("mock"):
                        STATE["loaded"] = True
                    else:
                        real_load()
                self._json(200, {"ok": True})
            elif self.path == "/cancel":
                STATE["cancel"].set()
                self._json(200, {"ok": True})
            elif self.path == "/shutdown":
                self._json(200, {"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            elif self.path == "/generate":
                self._generate()
            else:
                self._json(404, {"error": "not found"})
        except Exception as e:
            try:
                self._json(500, {"error": str(e)[:500]})
            except Exception:
                pass

    def _generate(self):
        params = self._read_body()
        if not STATE["lock"].acquire(blocking=False):
            self._json(409, {"error": "a generation is already running"})
            return
        try:
            if not STATE["loaded"]:
                self._json(409, {"error": "model not loaded"})
                return
            STATE["cancel"].clear()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Connection", "close")
            self.end_headers()

            def emit(event: dict):
                self.wfile.write((json.dumps(event) + "\n").encode())
                self.wfile.flush()

            try:
                gen = mock_generate if CONFIG.get("mock") else real_generate
                final = gen(params, emit)
            except Cancelled:
                final = {"type": "cancelled"}
            except Exception as e:
                final = {"type": "error", "error": str(e)[:500]}
            emit(final)
        finally:
            STATE["lock"].release()


def main():
    global CONFIG
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--config", required=True)
    args = ap.parse_args()
    with open(args.config) as f:
        CONFIG = json.load(f)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[runner] {CONFIG['model']['id']} on :{args.port} mock={CONFIG.get('mock')}", flush=True)
    server.serve_forever()
    sys.exit(0)


if __name__ == "__main__":
    main()
