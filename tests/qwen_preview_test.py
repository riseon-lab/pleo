"""Preview geometry, cadence, failure isolation and cancellation, without GPU weights.

Run in a torch environment. Set PLEO_PREVIEW_WEIGHTS to the pinned TAEQI2.1
Tinier safetensors file to additionally exercise the real decoder checkpoint.
"""
import base64
import io
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runners import runner, qwen_preview


class Pipeline:
    vae_scale_factor = 16

    @staticmethod
    def _unpack_latents(latents, height, width, vae_scale_factor):
        return latents.transpose(1, 2).reshape(latents.shape[0], 64, 1,
                                              2 * (height // 32), 2 * (width // 32))


seen = []
def decoder(latent):
    seen.append(latent.clone())
    return torch.nn.functional.interpolate(latent[:, :4].sigmoid(), scale_factor=16)

params = {"height": 1072, "width": 1920}
latents = torch.full((1, 66 * 120, 64), .5)
before = latents.clone()
image = qwen_preview.decode_preview(decoder, Pipeline(), latents, params)
assert image.size == (384, 208) and image.mode == "RGBA"
assert seen[-1].device.type == "cpu" and seen[-1].dtype == torch.float32
torch.testing.assert_close(seen[-1], torch.full_like(seen[-1], .5))
torch.testing.assert_close(latents, before)

old_config, old_state = runner.CONFIG, dict(runner.STATE)
try:
    runner.CONFIG = {"model": {"kind": "txt2img", "family": "qwen-image-2.1"}}
    runner.STATE["preview_decoder"] = object()
    runner.STATE["cancel"].clear()
    events = []
    tiny = SimpleNamespace(decode_preview=lambda *_args: Image.new("RGBA", (24, 32), (20, 40, 80, 128)))
    with patch.object(runner, "_qwen_preview_module", return_value=tiny):
        callback = runner._step_callback(params, events.append, 10)
        for step in range(10):
            callback(Pipeline(), step, None, {"latents": latents})
    assert [e["step"] for e in events if e["preview_b64"]] == [1, 4, 8, 10]
    assert [e["step"] for e in events] == list(range(1, 11)), "progress still streams every step"
    with Image.open(io.BytesIO(base64.b64decode(events[0]["preview_b64"]))) as preview:
        assert preview.mode == "RGBA" and preview.getpixel((0, 0))[3] == 128
    with patch.object(runner, "_qwen_preview_module", side_effect=RuntimeError("preview failed")):
        callback(Pipeline(), 0, None, {"latents": latents})
    assert events[-1]["preview_kind"] == "unavailable" and events[-1]["preview_b64"] is None
    assert runner.STATE["preview_decoder"] is None
    runner.STATE["cancel"].set()
    try:
        callback(Pipeline(), 1, None, {"latents": latents})
        raise AssertionError("cancel did not interrupt before preview work")
    except runner.Cancelled:
        pass
finally:
    runner.STATE["cancel"].clear()
    runner.STATE.clear()
    runner.STATE.update(old_state)
    runner.CONFIG = old_config

if path := os.environ.get("PLEO_PREVIEW_WEIGHTS"):
    with patch("huggingface_hub.hf_hub_download", return_value=path):
        actual = qwen_preview.load_decoder()
    result = qwen_preview.decode_preview(actual, Pipeline(), torch.randn(1, 16, 64), {"height": 64, "width": 64})
    assert result.size == (64, 64) and result.mode == "RGBA"
    assert all(p.device.type == "cpu" and not p.requires_grad for p in actual.parameters())
    print("PASS  real pinned TAEQI2.1-Tinier checkpoint loads and decodes on CPU")

print("PASS  Qwen live preview geometry, normalized latents, alpha, cadence, failure isolation and cancellation")
