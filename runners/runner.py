"""Pleo model runner. One process per loaded model, spawned by the backend
with the model venv's interpreter.

Protocol (localhost HTTP, NDJSON streaming on /generate):
  GET  /health    -> {"ok": true, "loaded": bool}
  POST /load      -> loads the pipeline (downloads weights on first use)
  POST /generate  -> streams {"type":"step",...} lines, then one terminal
                     {"type":"done"|"error"|"cancelled",...} line
  POST /cancel    -> sets the cancel flag (checked between steps)
  POST /shutdown  -> exits

Mock mode synthesizes images and a tiny MP4 so the whole app can be exercised
without a GPU or any ML dependencies.
"""
import argparse
import base64
import gc
import hashlib
import io
import json
import math
import os
import random
import struct
import sys
import threading
import traceback
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG: dict = {}
VIDEO_KINDS = {"img2video", "motion2video", "video2video"}
STATE = {
    "loaded": False,
    "pipe": None,
    "lock": threading.Lock(),        # single-flight: one generation at a time
    "cancel": threading.Event(),
}


class Cancelled(Exception):
    pass


# Tiny, valid H.264 MP4 used by mock mode. Keeping it embedded lets the full
# encrypted-video UI/API path run without adding an encoder to the backend env.
MOCK_MP4_B64 = (
    "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANhbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAox0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAgAAABAAAAAAIEbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABr21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAW9zdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UQmwEQAAAMABAAAAwAgPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAYEAAAAAAAAAAYc3R0cwAAAAAAAAABAAAABAAAEAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAAChjdHRzAAAAAAAAAAMAAAABAAAgAAAAAAEAAEAAAAAAAgAAEAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAQAAAABAAAAJHN0c3oAAAAAAAAAAAAAAAQAAALcAAAADgAAAAwAAAAMAAAAFHN0Y28AAAAAAAAAAQAAA5EAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYxLjcuMTAwAAAACGZyZWUAAAMKbWRhdAAAAq0GBf//qdxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMiBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj00IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAJ2WIhAAS//7oyfzLKxxP0/uWk6FZpxzCPR0j/rkHZkvIIcFZB4uJwQAAAApBmiNsQQ/+qlfeAAAACEGeQXiCPwHVAAAACAGeYmpBDwLG"
)


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
        stage = ("Planning motion · high noise" if step <= 2 else "Refining detail · low noise") \
            if CONFIG["model"]["kind"] in VIDEO_KINDS else None
        emit({"type": "step", "step": step, "total": steps, "stage": stage,
              "preview_b64": base64.b64encode(preview).decode()})
    if CONFIG["model"]["kind"] in VIDEO_KINDS:
        moderation = _mock_frame(192, 64, seed, params["prompt"], 1.0)
        emit({"type": "step", "step": steps, "total": steps, "stage": "Encoding MP4…"})
        return {"type": "done", "media_b64": MOCK_MP4_B64, "mime": "video/mp4",
                "moderation_b64": base64.b64encode(moderation).decode(), "seed": seed,
                "width": params["width"], "height": params["height"],
                "fps": params.get("fps", 16), "num_frames": params.get("num_frames", 1)}
    rgb = _png_rgb_rerender(w, h, seed, params["prompt"])
    up = _upscale_nearest(rgb, w, h, tw, th) if (w, h) != (tw, th) else rgb
    final = write_png(tw, th, up)
    return {"type": "done", "media_b64": base64.b64encode(final).decode(),
            "mime": "image/png", "seed": seed}


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

def _verified_hf_file(repo_id: str, filename: str, revision: str, expected_sha256: str) -> str:
    from huggingface_hub import hf_hub_download

    cache_dir = os.path.join(CONFIG["hf_home"], "hub")
    path = hf_hub_download(repo_id, filename, revision=revision, cache_dir=cache_dir)
    marker_dir = os.path.join(CONFIG["hf_home"], ".pleo-verified")
    marker = os.path.join(marker_dir, expected_sha256)
    if not os.path.exists(marker):
        def valid(candidate):
            digest = hashlib.sha256()
            with open(candidate, "rb") as weights:
                for block in iter(lambda: weights.read(8 * 1024 * 1024), b""):
                    digest.update(block)
            return digest.hexdigest() == expected_sha256

        verified = valid(path)
        if not verified:
            print(f"[runner] repairing corrupt cached weight: {filename}", flush=True)
            path = hf_hub_download(repo_id, filename, revision=revision,
                                   cache_dir=cache_dir, force_download=True)
            verified = valid(path)
        if not verified:
            raise RuntimeError(f"Checksum mismatch for distilled Wan expert: {filename}")
        os.makedirs(marker_dir, exist_ok=True)
        with open(marker, "w", encoding="ascii") as marker_file:
            marker_file.write(filename)
    return path


def _load_wan(model: dict):
    import torch
    from diffusers import (AutoencoderKLWan, FlowMatchEulerDiscreteScheduler,
                           WanImageToVideoPipeline, WanTransformer3DModel)

    if not torch.cuda.is_available():
        raise RuntimeError("Wan 2.2 A14B requires a CUDA GPU")
    total_gib = torch.cuda.get_device_properties(0).total_memory / 2 ** 30
    if total_gib + 1 < model.get("min_cuda_memory_gb", 80):
        raise RuntimeError(f"Wan 2.2 A14B needs an ~80 GB GPU; detected {total_gib:.1f} GB")

    experts = model["distilled_experts"]
    high_path = _verified_hf_file(experts["repo_id"], experts["high_noise_file"],
                                  experts["revision"], experts["high_noise_sha256"])
    low_path = _verified_hf_file(experts["repo_id"], experts["low_noise_file"],
                                 experts["revision"], experts["low_noise_sha256"])
    high = WanTransformer3DModel.from_single_file(
        high_path, config=model["repo_id"], subfolder="transformer",
        config_revision=model.get("revision"), torch_dtype=torch.bfloat16, low_cpu_mem_usage=True)
    low = WanTransformer3DModel.from_single_file(
        low_path, config=model["repo_id"], subfolder="transformer_2",
        config_revision=model.get("revision"), torch_dtype=torch.bfloat16, low_cpu_mem_usage=True)

    # Keep the VAE in float32 for decode quality. Accelerate moves only the
    # component currently in use to CUDA, so the two 14B experts never overlap.
    vae = AutoencoderKLWan.from_pretrained(
        model["repo_id"], subfolder="vae", revision=model.get("revision"),
        torch_dtype=torch.float32, low_cpu_mem_usage=True)
    pipe = WanImageToVideoPipeline.from_pretrained(
        model["repo_id"], transformer=high, transformer_2=low, vae=vae,
        revision=model.get("revision"), torch_dtype=torch.bfloat16, low_cpu_mem_usage=True)

    # LightX2V selects four indices from the 1000-step grid, then applies its
    # sigma shift. Passing the unshifted sigmas reproduces both its model
    # timesteps and Euler updates when Diffusers resets the scheduler per call.
    schedule = model["video"]
    pipe.scheduler = FlowMatchEulerDiscreteScheduler.from_config(
        pipe.scheduler.config, shift=schedule["sample_shift"])
    set_timesteps = pipe.scheduler.set_timesteps
    raw_sigmas = [t / pipe.scheduler.config.num_train_timesteps
                  for t in schedule["denoising_step_indices"]]

    def distilled_timesteps(num_inference_steps, device=None, **_kwargs):
        if num_inference_steps != 4:
            raise ValueError("The distilled Wan quality profile requires exactly 4 steps")
        return set_timesteps(num_inference_steps, device=device, sigmas=raw_sigmas)

    pipe.scheduler.set_timesteps = distilled_timesteps
    pipe.scheduler.set_timesteps(4, device="cpu")
    actual = pipe.scheduler.timesteps.tolist()
    expected = schedule["timesteps"]
    if any(abs(a - b) > 0.01 for a, b in zip(actual, expected)):
        raise RuntimeError(f"Distilled Wan scheduler mismatch: {actual}")
    high_steps = sum(t >= schedule["boundary"] * pipe.scheduler.config.num_train_timesteps
                     for t in actual)
    if high_steps != schedule["boundary_step_index"]:
        raise RuntimeError(f"Distilled Wan expert split mismatch: {high_steps}+{4 - high_steps}")
    pipe.register_to_config(boundary_ratio=schedule["boundary"])
    pipe.vae.enable_tiling()
    pipe.vae.enable_slicing()
    return pipe


def _load_wan_animate(model: dict):
    import torch
    from diffusers import ModularPipeline

    if not torch.cuda.is_available():
        raise RuntimeError("Wan Animate 2 requires a CUDA GPU")
    total_gib = torch.cuda.get_device_properties(0).total_memory / 2 ** 30
    if total_gib + 1 < model.get("min_cuda_memory_gb", 80):
        raise RuntimeError(f"Wan Animate 2 needs an ~80 GB GPU; detected {total_gib:.1f} GB")
    pipe = ModularPipeline.from_pretrained(model["repo_id"])
    pipe.load_components(dtype=torch.bfloat16)
    # The reference KV cache and transformer do not fit together on an 80 GB
    # card. Diffusers' block streaming is the model's documented inference path.
    pipe.transformer.enable_group_offload(
        onload_device=torch.device("cuda"), offload_device=torch.device("cpu"),
        offload_type="block_level", num_blocks_per_group=1, use_stream=True)
    pipe.text_encoder.to("cuda")
    pipe.image_encoder.to("cuda")
    pipe.vae.to("cuda")
    pipe.transformer.compile_repeated_blocks(fullgraph=False)
    return pipe


def _load_vace(model: dict):
    import torch
    from diffusers import AutoencoderKLWan, WanVACEPipeline

    if not torch.cuda.is_available():
        raise RuntimeError("Wan VACE 14B requires a CUDA GPU")
    total_gib = torch.cuda.get_device_properties(0).total_memory / 2 ** 30
    if total_gib + 1 < model.get("min_cuda_memory_gb", 80):
        raise RuntimeError(f"Wan VACE 14B needs an ~80 GB GPU; detected {total_gib:.1f} GB")
    vae = AutoencoderKLWan.from_pretrained(
        model["repo_id"], subfolder="vae", dtype=torch.float32, low_cpu_mem_usage=True)
    pipe = WanVACEPipeline.from_pretrained(
        model["repo_id"], vae=vae, dtype=torch.bfloat16, low_cpu_mem_usage=True)
    pipe.vae.enable_tiling()
    pipe.vae.enable_slicing()
    pipe.enable_model_cpu_offload()
    return pipe


def real_load():
    os.environ.setdefault("HF_HOME", CONFIG["hf_home"])
    import torch
    from diffusers import DiffusionPipeline

    model = CONFIG["model"]
    if model["kind"] == "img2video":
        pipe = _load_wan(model)
    elif model["kind"] == "motion2video":
        pipe = _load_wan_animate(model)
    elif model["kind"] == "video2video":
        pipe = _load_vace(model)
    else:
        dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
        pipe = DiffusionPipeline.from_pretrained(model["repo_id"], torch_dtype=dtype)
        if torch.cuda.is_available():
            pipe = pipe.to("cuda")
    STATE["pipe"] = pipe
    STATE["loaded"] = True


def _step_callback(params: dict, emit, total: int):
    def on_step(pipeline, step, timestep, callback_kwargs):
        if STATE["cancel"].is_set():
            raise Cancelled()
        preview_b64 = None
        latents = callback_kwargs.get("latents")
        try:
            lat = None
            if latents is not None and latents.dim() == 5:
                # Video latents: preview the first temporal slice without a
                # costly VAE decode.
                lat = latents[0, :3, 0].float()
            elif latents is not None and latents.dim() == 4:
                lat = latents[0, :3].float()
            elif latents is not None and latents.dim() == 3:
                _, seq, ch = latents.shape
                h_lat, w_lat = params["height"] // 16, params["width"] // 16
                if seq == h_lat * w_lat:
                    lat = latents[0].view(h_lat, w_lat, ch).permute(2, 0, 1)[:3].float()
            if lat is not None:
                lat = (lat - lat.amin()) / (lat.amax() - lat.amin() + 1e-6)
                img = (lat.clamp(0, 1) * 255).byte().permute(1, 2, 0).cpu().numpy()
                from PIL import Image
                buf = io.BytesIO()
                Image.fromarray(img).resize((params["width"] // 4, params["height"] // 4),
                                            Image.Resampling.NEAREST).save(buf, format="PNG")
                preview_b64 = base64.b64encode(buf.getvalue()).decode()
        except Exception:
            pass
        stage = None
        if CONFIG["model"]["kind"] in VIDEO_KINDS:
            stage = "Planning motion · high noise" if step < 2 else "Refining detail · low noise"
            if step + 1 == total:
                stage = "Decoding video…"
        emit({"type": "step", "step": step + 1, "total": total,
              "preview_b64": preview_b64, "stage": stage})
        return callback_kwargs
    return on_step


def _encode_mp4(frames, fps: int, max_bytes: int | None = None) -> bytes:
    import av
    import numpy as np

    first = np.asarray(frames[0].convert("RGB") if hasattr(frames[0], "convert") else frames[0])
    for crf in (18, 24, 30, 36, 42, 48):
        buf = io.BytesIO()
        container = av.open(buf, mode="w", format="mp4")
        try:
            stream = container.add_stream("libx264", rate=fps)
            stream.width, stream.height = first.shape[1], first.shape[0]
            stream.pix_fmt = "yuv420p"
            stream.options = {"crf": str(crf), "preset": "medium"}
            for frame in frames:
                arr = np.asarray(frame.convert("RGB") if hasattr(frame, "convert") else frame)
                if arr.dtype != np.uint8:
                    scale = 255 if arr.max() <= 1.0 else 1
                    arr = np.clip(arr * scale, 0, 255).astype(np.uint8)
                for packet in stream.encode(av.VideoFrame.from_ndarray(arr, format="rgb24")):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        finally:
            container.close()
        video = buf.getvalue()
        if max_bytes is None or len(video) <= max_bytes:
            return video
    raise RuntimeError("Encoded video is too large for encrypted asset storage")


def _moderation_sheet(frames) -> bytes:
    import numpy as np
    from PIL import Image

    def as_image(frame):
        if hasattr(frame, "convert"):
            return frame.convert("RGB")
        arr = np.asarray(frame)
        if arr.dtype != np.uint8:
            arr = np.clip(arr * (255 if arr.max() <= 1.0 else 1), 0, 255).astype(np.uint8)
        return Image.fromarray(arr).convert("RGB")

    picks = [frames[0], frames[len(frames) // 2], frames[-1]]
    sheet = Image.new("RGB", (768, 256), "black")
    for i, frame in enumerate(picks):
        image = as_image(frame)
        image.thumbnail((256, 256))
        sheet.paste(image, (i * 256 + (256 - image.width) // 2, (256 - image.height) // 2))
    buf = io.BytesIO()
    sheet.save(buf, format="JPEG", quality=88)
    return buf.getvalue()


def _wan_required_vram_gib(video_tier: str, num_frames: int, adapter_gib: float) -> float:
    base = 78 if video_tier == "720p" else 70
    # ponytail: 60 GiB is the fixed model floor; tune it if measured long-clip peaks disagree.
    return 60 + (base - 60) * max(1, num_frames / 81) + adapter_gib


def _decode_video(data: bytes, max_seconds: float, target_fps: int,
                  target_frames: int | None = None, max_frames: int | None = None):
    """Decode and uniformly resample a transient MP4 without writing plaintext."""
    import av

    container = None
    try:
        container = av.open(io.BytesIO(data), mode="r")
        stream = container.streams.video[0]
        source_fps = float(stream.average_rate or target_fps)
        if not math.isfinite(source_fps) or source_fps <= 0 or source_fps > 240:
            source_fps = float(target_fps)
        decoded = []
        for frame in container.decode(stream):
            timestamp = float(frame.pts * frame.time_base) if frame.pts is not None else len(decoded) / source_fps
            if timestamp > max_seconds:
                break
            image = frame.to_image().convert("RGB")
            if image.width * image.height > 16_777_216 or max(image.size) > 4096:
                raise RuntimeError("Driving video resolution is too large")
            decoded.append(image)
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError("Driving video must be a readable H.264/H.265 MP4") from exc
    finally:
        if container is not None:
            try:
                container.close()
            except Exception:
                pass
    if len(decoded) < 2:
        raise RuntimeError("Driving video must contain at least two frames")

    if target_frames is None:
        duration = min(max_seconds, (len(decoded) - 1) / source_fps)
        target_frames = max(2, round(duration * target_fps) + 1)
    if max_frames is not None:
        target_frames = min(target_frames, max_frames)
    indices = [round(i * (len(decoded) - 1) / max(1, target_frames - 1))
               for i in range(target_frames)]
    return [decoded[i] for i in indices], target_fps


def _output_size(frames) -> tuple[int, int]:
    first = frames[0]
    if hasattr(first, "size") and isinstance(first.size, tuple):
        return first.size
    shape = first.shape
    return int(shape[1]), int(shape[0])


def _wan_generate(params: dict, emit, seed: int, generator) -> dict:
    import torch
    from PIL import Image, ImageOps

    pipe = STATE["pipe"]
    active_loras = [lora for lora in params.get("loras", [])
                    if lora["high_strength"] > 0 or lora["low_strength"] > 0]
    free_gib = torch.cuda.mem_get_info()[0] / 2 ** 30
    adapter_gib = sum(os.path.getsize(lora["path"]) for lora in active_loras) / 2 ** 30
    required = _wan_required_vram_gib(params["video_tier"], params["num_frames"], adapter_gib)
    if free_gib < required:
        raise RuntimeError(f"Wan {params['video_tier']} with this LoRA stack needs about "
                           f"{required:.1f} GB free VRAM; {free_gib:.1f} GB is free")

    names, weights = [], []
    for i, lora in enumerate(active_loras):
        high_name, low_name = f"user_{i}_high", f"user_{i}_low"
        try:
            if lora["high_strength"] > 0:
                pipe.load_lora_weights(lora["path"], adapter_name=high_name, low_cpu_mem_usage=True)
                names.append(high_name)
                weights.append(lora["high_strength"])
            if lora["low_strength"] > 0:
                pipe.load_lora_weights(lora["path"], adapter_name=low_name,
                                       load_into_transformer_2=True, low_cpu_mem_usage=True)
                names.append(low_name)
                weights.append(lora["low_strength"])
        except Exception as e:
            raise RuntimeError(f"{os.path.basename(lora['path'])} is not compatible with Wan 2.2 I2V: {e}") from e
    if names:
        pipe.set_adapters(names, adapter_weights=weights)

    torch.cuda.reset_peak_memory_stats()
    pipe.enable_model_cpu_offload()
    source = Image.open(io.BytesIO(base64.b64decode(params["ref_image_b64"]))).convert("RGB")
    if params.get("video_aspect") == "9:16":
        source = ImageOps.fit(source, (params["width"], params["height"]), Image.Resampling.LANCZOS)
    try:
        frames = pipe(
            image=source,
            prompt=params["prompt"],
            width=params["width"],
            height=params["height"],
            num_frames=params["num_frames"],
            num_inference_steps=4,
            guidance_scale=1.0,
            guidance_scale_2=1.0,
            generator=generator,
            output_type="pil",
            callback_on_step_end=_step_callback(params, emit, 4),
        ).frames[0]
        if STATE["cancel"].is_set():
            raise Cancelled()
        moderation = _moderation_sheet(frames)
        emit({"type": "step", "step": 4, "total": 4, "stage": "Encoding MP4…"})
        video = _encode_mp4(frames, params["fps"], CONFIG.get("max_output_bytes"))
        return {"type": "done", "media_b64": base64.b64encode(video).decode(), "mime": "video/mp4",
                "moderation_b64": base64.b64encode(moderation).decode(), "seed": seed}
    finally:
        try:
            if names:
                pipe.unload_lora_weights()
        finally:
            try:
                pipe.maybe_free_model_hooks()
            except Exception:
                pass
            source.close()
            gc.collect()
            torch.cuda.empty_cache()


def _wan_animate_generate(params: dict, emit, seed: int, generator) -> dict:
    import torch
    from PIL import Image

    model = CONFIG["model"]
    video_cfg = model["video"]
    source = Image.open(io.BytesIO(base64.b64decode(params["ref_image_b64"]))).convert("RGB")
    driving = []
    try:
        emit({"type": "step", "step": 1, "total": 3, "stage": "Preparing driving motion…"})
        driving, driving_fps = _decode_video(
            base64.b64decode(params["ref_video_b64"]), video_cfg["max_source_seconds"],
            video_cfg["output_fps"], target_frames=params["num_frames"],
            max_frames=video_cfg["max_frames"])
        if STATE["cancel"].is_set():
            raise Cancelled()
        emit({"type": "step", "step": 2, "total": 3,
              "stage": "Compiling on first run, then transferring performance…"})
        videos = STATE["pipe"](
            image=source, driving_video=driving, driving_video_fps=driving_fps,
            prompt=params["prompt"], width=params["width"], height=params["height"],
            generator=generator, output="videos")
        frames = videos[0]
        if STATE["cancel"].is_set():
            raise Cancelled()
        emit({"type": "step", "step": 3, "total": 3, "stage": "Encoding MP4…"})
        width, height = _output_size(frames)
        fps = video_cfg["output_fps"]
        video = _encode_mp4(frames, fps, CONFIG.get("max_output_bytes"))
        moderation = _moderation_sheet(frames)
        return {"type": "done", "media_b64": base64.b64encode(video).decode(), "mime": "video/mp4",
                "moderation_b64": base64.b64encode(moderation).decode(), "seed": seed,
                "width": width, "height": height, "fps": fps, "num_frames": len(frames)}
    finally:
        source.close()
        for frame in driving:
            frame.close()
        gc.collect()
        torch.cuda.empty_cache()


def _vace_generate(params: dict, emit, seed: int, generator) -> dict:
    import torch
    from PIL import Image

    model = CONFIG["model"]
    video_cfg = model["video"]
    source = Image.open(io.BytesIO(base64.b64decode(params["ref_image_b64"]))).convert("RGB")
    frames = []
    try:
        frames, fps = _decode_video(
            base64.b64decode(params["ref_video_b64"]), video_cfg["max_source_seconds"],
            video_cfg["output_fps"], target_frames=params["num_frames"], max_frames=video_cfg["max_frames"])
        kwargs = dict(
            prompt=params["prompt"], video=frames, reference_images=[source],
            width=params["width"], height=params["height"], num_frames=len(frames),
            num_inference_steps=params["steps"], guidance_scale=params["cfg"],
            generator=generator, output_type="np",
            callback_on_step_end=_step_callback(params, emit, params["steps"]),
        )
        if params.get("negative_prompt"):
            kwargs["negative_prompt"] = params["negative_prompt"]
        output = STATE["pipe"](**kwargs).frames[0]
        if STATE["cancel"].is_set():
            raise Cancelled()
        emit({"type": "step", "step": params["steps"], "total": params["steps"], "stage": "Encoding MP4…"})
        width, height = _output_size(output)
        video = _encode_mp4(output, fps, CONFIG.get("max_output_bytes"))
        moderation = _moderation_sheet(output)
        return {"type": "done", "media_b64": base64.b64encode(video).decode(), "mime": "video/mp4",
                "moderation_b64": base64.b64encode(moderation).decode(), "seed": seed,
                "width": width, "height": height, "fps": fps, "num_frames": len(output)}
    finally:
        source.close()
        for frame in frames:
            frame.close()
        try:
            STATE["pipe"].maybe_free_model_hooks()
        except Exception:
            pass
        gc.collect()
        torch.cuda.empty_cache()


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
    if model["kind"] == "img2video":
        return _wan_generate(params, emit, seed, generator)
    if model["kind"] == "motion2video":
        return _wan_animate_generate(params, emit, seed, generator)
    if model["kind"] == "video2video":
        return _vace_generate(params, emit, seed, generator)

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
    kwargs = dict(
        prompt=params["prompt"], num_inference_steps=total,
        width=params["width"], height=params["height"], generator=generator,
        callback_on_step_end=_step_callback(params, emit, total),
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
    return {"type": "done", "media_b64": base64.b64encode(buf.getvalue()).decode(),
            "mime": "image/png", "seed": seed}


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
            traceback.print_exc()
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
                message = str(e)
                final = {"type": "error", "error": message[:500]}
                if "out of memory" in message.lower() and "cuda" in message.lower():
                    final["error_code"] = "cuda_oom"
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
