"""Captioner runner: Qwen2.5-VL (or mock) behind the same localhost-HTTP
pattern as the model runner.

  GET  /health   POST /load   POST /caption {image_b64, hint}   POST /shutdown
"""
import argparse
import base64
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG: dict = {}
STATE = {"loaded": False, "model": None, "processor": None, "lock": threading.Lock()}

CAPTION_PROMPT = (
    "Describe this image in one detailed sentence suitable as a training "
    "caption: subject, appearance, clothing, pose, setting, lighting, style. "
    "No preamble, no quotes."
)

# Deterministic-but-varied mock captions so dataset flows are testable offline.
_MOCK_SUBJECTS = ["a person", "a woman", "a man", "a character"]
_MOCK_SETTINGS = ["in a sunlit studio", "on a city street at dusk", "in a forest clearing",
                  "against a plain backdrop", "beside a window with soft light"]
_MOCK_STYLES = ["photorealistic detail", "cinematic lighting", "soft film grain",
                "sharp focus, shallow depth of field"]


def mock_caption(image_bytes: bytes) -> str:
    h = int(hashlib.sha256(image_bytes[:4096]).hexdigest(), 16)
    return (f"{_MOCK_SUBJECTS[h % len(_MOCK_SUBJECTS)]} "
            f"{_MOCK_SETTINGS[(h >> 8) % len(_MOCK_SETTINGS)]}, "
            f"{_MOCK_STYLES[(h >> 16) % len(_MOCK_STYLES)]}")


def real_load():
    import os
    os.environ.setdefault("HF_HOME", CONFIG["hf_home"])
    import torch
    from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration
    repo = CONFIG["component"]["repo_id"]
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    STATE["model"] = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        repo, torch_dtype=dtype, device_map="auto")
    STATE["processor"] = AutoProcessor.from_pretrained(repo)
    STATE["loaded"] = True


def real_caption(image_bytes: bytes, hint: str) -> str:
    import io

    import torch
    from PIL import Image
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    # Bound the vision input so huge dataset images can't blow VRAM.
    image.thumbnail((1280, 1280))
    prompt = CAPTION_PROMPT + (f" Context: {hint}" if hint else "")
    messages = [{"role": "user", "content": [
        {"type": "image", "image": image},
        {"type": "text", "text": prompt}]}]
    processor = STATE["processor"]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = processor(text=[text], images=[image], return_tensors="pt").to(STATE["model"].device)
    with torch.no_grad():
        out = STATE["model"].generate(**inputs, max_new_tokens=120, do_sample=False)
    trimmed = out[0][inputs["input_ids"].shape[1]:]
    return processor.decode(trimmed, skip_special_tokens=True)


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
            self._json(200, {"ok": True, "loaded": STATE["loaded"]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            if self.path == "/load":
                if not STATE["loaded"]:
                    if CONFIG.get("mock"):
                        STATE["loaded"] = True
                    else:
                        real_load()
                self._json(200, {"ok": True})
            elif self.path == "/caption":
                if not STATE["loaded"]:
                    self._json(409, {"error": "not loaded"})
                    return
                image = base64.b64decode(body["image_b64"])
                with STATE["lock"]:  # single-flight
                    if CONFIG.get("mock"):
                        caption = mock_caption(image)
                    else:
                        caption = real_caption(image, body.get("hint", ""))
                self._json(200, {"caption": caption})
            elif self.path == "/shutdown":
                self._json(200, {"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                self._json(404, {"error": "not found"})
        except Exception as e:
            import traceback
            print(f"[captioner] ERROR on {self.path}: {e}\n{traceback.format_exc()}", flush=True)
            try:
                self._json(500, {"error": f"{type(e).__name__}: {str(e)[:400]}"})
            except Exception:
                pass


def main():
    global CONFIG
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--config", required=True)
    args = ap.parse_args()
    with open(args.config) as f:
        CONFIG = json.load(f)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[captioner] on :{args.port} mock={CONFIG.get('mock')}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
