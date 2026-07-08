"""Content moderation pipeline.

Lazy-loaded local image classifier (ONNX). Drop a classifier at
DATA/moderation/model.onnx with a labels.json like:
  {"input_size": 224, "labels": ["safe", "nsfw"], "blocked": ["nsfw"], "threshold": 0.7}

Fail-closed policy: if moderation is enabled but the classifier cannot load,
image saves are BLOCKED (never silently allowed). The toggle lives in
settings.json and defaults to off.
"""
import io
import json
import threading

from . import config
from .util import read_json

_lock = threading.Lock()
_classifier = None  # (session, cfg) tuple once loaded
_load_error: str | None = None


def is_enabled() -> bool:
    settings = read_json(config.SETTINGS_FILE, {})
    return bool(settings.get("moderation_enabled", False))


def status() -> dict:
    model_file = config.MODERATION_DIR / "model.onnx"
    return {
        "enabled": is_enabled(),
        "model_present": model_file.exists(),
        "loaded": _classifier is not None,
        "load_error": _load_error,
    }


def _load():
    global _classifier, _load_error
    with _lock:
        if _classifier is not None:
            return _classifier
        try:
            import numpy as np  # noqa: F401
            import onnxruntime as ort
            from PIL import Image  # noqa: F401
        except ImportError as e:
            _load_error = f"missing dependency: {e.name} (pip install onnxruntime pillow numpy)"
            raise ModerationUnavailable(_load_error)
        model_file = config.MODERATION_DIR / "model.onnx"
        cfg = read_json(config.MODERATION_DIR / "labels.json", None)
        if not model_file.exists() or not cfg:
            _load_error = "no classifier installed (need model.onnx + labels.json in data/moderation)"
            raise ModerationUnavailable(_load_error)
        session = ort.InferenceSession(str(model_file), providers=["CPUExecutionProvider"])
        _classifier = (session, cfg)
        _load_error = None
        return _classifier


class ModerationUnavailable(Exception):
    pass


def check_image(image_bytes: bytes) -> dict:
    """Classify an image. Raises nothing: unavailable => blocked (fail closed)."""
    try:
        session, cfg = _load()
    except ModerationUnavailable as e:
        return {"allowed": False, "reason": f"moderation enabled but unavailable: {e}"}
    try:
        import numpy as np
        from PIL import Image
        size = int(cfg.get("input_size", 224))
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB").resize((size, size))
        arr = np.asarray(img, dtype=np.float32) / 255.0
        mean = np.asarray(cfg.get("mean", [0.5, 0.5, 0.5]), dtype=np.float32)
        std = np.asarray(cfg.get("std", [0.5, 0.5, 0.5]), dtype=np.float32)
        arr = (arr - mean) / std
        arr = arr.transpose(2, 0, 1)[None, ...]
        input_name = session.get_inputs()[0].name
        out = session.run(None, {input_name: arr})[0][0]
        exp = np.exp(out - out.max())
        probs = exp / exp.sum()
        labels = cfg["labels"]
        blocked = set(cfg.get("blocked", []))
        threshold = float(cfg.get("threshold", 0.7))
        scores = {labels[i]: float(probs[i]) for i in range(min(len(labels), len(probs)))}
        flagged = any(scores.get(lbl, 0.0) >= threshold for lbl in blocked)
        return {"allowed": not flagged, "scores": scores}
    except Exception as e:
        return {"allowed": False, "reason": f"moderation error: {e}"}


def install_classifier(hf_key: str | None = None) -> dict:
    """Download the reference ONNX classifier (see models.json
    moderation_source) into data/moderation/. ~300MB, blocking — call from a
    thread. Resets the lazy-loaded session so the new model takes effect."""
    global _classifier, _load_error
    import httpx

    from .registry import moderation_source
    from .util import atomic_write_json
    src = moderation_source()
    if not src.get("repo_id"):
        raise RuntimeError("No moderation_source configured in models.json")
    url = f"https://huggingface.co/{src['repo_id']}/resolve/main/{src['onnx_file']}"
    dest = config.MODERATION_DIR / "model.onnx"
    tmp = dest.with_suffix(".part")
    headers = {"Authorization": f"Bearer {hf_key}"} if hf_key else {}
    with httpx.stream("GET", url, headers=headers, follow_redirects=True, timeout=60) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_bytes(chunk_size=1 << 20):
                f.write(chunk)
    tmp.replace(dest)
    atomic_write_json(config.MODERATION_DIR / "labels.json", src["labels"])
    with _lock:
        _classifier = None
        _load_error = None
    return status()


def check_config() -> str:
    return json.dumps(status())
