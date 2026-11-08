"""Exercise Qwen 2.1 loading and inference arguments without GPU weights."""
import base64
import io
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runners import runner


class Pipeline:
    def __init__(self):
        self.calls = []
        self.adapters = []
        self.offloaded = False
        self.device = None
        self.sources = []

    def enable_model_cpu_offload(self):
        self.offloaded = True

    def to(self, device):
        self.device = device
        return self

    def unload_lora_weights(self):
        self.adapters.clear()

    def load_lora_weights(self, path, adapter_name):
        self.adapters.append((path, adapter_name))

    def lora_state_dict(self, path):
        self.sources.append(path)
        return {"transformer.transformer_blocks.0.attn.to_q.lora_A.weight": np.ones((2, 4)),
                "transformer.transformer_blocks.0.attn.to_q.lora_B.weight": np.ones((4, 2))}

    def set_adapters(self, names, adapter_weights):
        self.weights = (names, adapter_weights)

    # Deliberately no guidance_scale or **kwargs: 2.1 only accepts true_cfg_scale.
    def __call__(self, prompt, num_inference_steps, width, height, generator,
                 callback_on_step_end, true_cfg_scale, negative_prompt=None, image=None):
        self.calls.append({"cfg": true_cfg_scale, "negative": negative_prompt, "image": image})
        callback_on_step_end(self, 0, None, {"latents": None})
        return SimpleNamespace(images=[Image.new("RGBA", (width, height), (1, 2, 3, 64))])


model = next(m for m in json.loads((Path(__file__).resolve().parents[1] / "models.json").read_text())["models"]
             if m["id"] == "qwen-image-2.1")
pipe = Pipeline()
torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True),
                        bfloat16="bf16", float32="fp32",
                        Generator=lambda device: SimpleNamespace(manual_seed=lambda seed: (device, seed)))
loads = []


def from_pretrained(repo_id, **kwargs):
    loads.append((repo_id, kwargs))
    return pipe


previous_config = runner.CONFIG
previous_state = dict(runner.STATE)
try:
    runner.CONFIG = {"model": model, "hf_home": "/tmp/pleo-qwen21-unit-cache"}
    with patch.dict(sys.modules, {"torch": torch, "diffusers": SimpleNamespace(
            DiffusionPipeline=SimpleNamespace(from_pretrained=from_pretrained))}), patch.dict("os.environ"):
        runner.real_load()
        assert pipe.offloaded and pipe.device is None, "2.1 must not move every model to CUDA together"
        assert loads == [("Qwen/Qwen-Image-2.1", {"torch_dtype": "bf16"})]
        params = {"prompt": "A character", "negative_prompt": "blurry", "seed": 42,
                  "steps": 40, "cfg": 1, "width": 64, "height": 64,
                  "loras": [{"path": "character.safetensors", "strength": 0.85},
                            {"path": "style.safetensors", "strength": 0.3}]}
        events = []
        output = runner.real_generate(params, events.append)
        assert pipe.calls[-1] == {"cfg": 1, "negative": "blurry", "image": None}
        assert pipe.sources == ["character.safetensors", "style.safetensors"]
        assert [name for _weights, name in pipe.adapters] == ["lora0", "lora1"]
        assert all("transformer.transformer_blocks.0.attn.to_q.lora_A.weight" in weights
                   for weights, _name in pipe.adapters)
        assert pipe.weights == (["lora0", "lora1"], [0.85, 0.3])
        assert events[0]["type"] == "step" and events[0]["total"] == 40
        assert output["mime"] == "image/png" and output["seed"] == 42
        with Image.open(io.BytesIO(base64.b64decode(output["media_b64"]))) as image:
            assert image.mode == "RGBA" and image.getpixel((0, 0))[3] == 64

        source = io.BytesIO()
        Image.new("RGBA", (64, 64), (10, 20, 30, 128)).save(source, format="PNG")
        runner.real_generate({**params, "cfg": 4, "loras": [],
                              "ref_image_b64": base64.b64encode(source.getvalue()).decode()}, events.append)
        assert not pipe.adapters, "a later request without LoRAs clears the previous stack"
        assert pipe.calls[-1]["cfg"] == 4
        assert pipe.calls[-1]["image"].mode == "RGBA"
        assert pipe.calls[-1]["image"].getpixel((0, 0))[3] == 128

        runner.CONFIG["model"] = {**model, "family": "qwen-image"}
        runner.real_load()
        assert pipe.device == "cuda", "older model loading stays unchanged"
        runner.real_generate({**params, "loras": [],
                              "ref_image_b64": base64.b64encode(source.getvalue()).decode()}, events.append)
        assert pipe.calls[-1]["image"].mode == "RGB", "older image pipelines keep RGB input"
finally:
    runner.CONFIG = previous_config
    runner.STATE.clear()
    runner.STATE.update(previous_state)

# Check that a trained fused adapter preserves both low-rank matrix products.
prefix = "transformer.transformer_blocks.0.img_mlp."
down, up = np.arange(8).reshape(2, 4), np.arange(12).reshape(6, 2)
fused = {prefix + "gate_up.lora_A.weight": down, prefix + "gate_up.lora_B.weight": up}
converted = runner._qwen21_lora_weights(SimpleNamespace(lora_state_dict=lambda _: dict(fused)), "trained.safetensors")
np.testing.assert_array_equal(converted[prefix + "gate_layer.lora_B.weight"] @ converted[prefix + "gate_layer.lora_A.weight"], (up @ down)[:3])
np.testing.assert_array_equal(converted[prefix + "proj.lora_B.weight"] @ converted[prefix + "proj.lora_A.weight"], (up @ down)[3:])
assert not any("gate_up" in key for key in converted)
assert len(fused) == 2, "conversion must not mutate the loader's source dictionary"
try:
    malformed = {**fused, prefix + "gate_up.lora_B.weight": up[:5]}
    runner._qwen21_lora_weights(SimpleNamespace(lora_state_dict=lambda _: dict(malformed)), "bad.safetensors")
    raise AssertionError("invalid fused adapter was accepted")
except ValueError as error:
    assert "Invalid fused" in str(error)

# Verify the real training config selects the architecture already in the pin.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runners"))
from runners import trainer

previous_config = trainer.CONFIG
catalog = json.loads((Path(__file__).resolve().parents[1] / "models.json").read_text())["models"]
try:
    with tempfile.TemporaryDirectory() as directory:
        trainer.CONFIG = {"base_model": model, "job_dir": directory, "dataset_dir": directory}
        job = {"id": "qwen21-check", "steps": 1000, "checkpoint_steps": [250, 500],
               "sample_prompts": ["character portrait"], "rank": 32, "alpha": 16}
        for profile in ("low", "balanced", "high"):
            cfg = json.loads(trainer.build_toolkit_config({**job, "vram_profile": profile}).read_text())["config"]["process"][0]
            assert cfg["model"]["arch"] == "qwen_image_2"
            assert cfg["model"]["name_or_path"] == "Comfy-Org/Qwen-Image-2.1"
            assert cfg["model"]["quantize"] == (profile != "high")
            assert cfg["model"]["quantize_te"] == (profile != "high")
            assert cfg["model"]["qtype"] == cfg["model"]["qtype_te"] == "convrot8"
            assert cfg["model"]["low_vram"] == (profile == "low")
            assert cfg["train"]["cache_text_embeddings"] and cfg["train"]["timestep_type"] == "shift"
            assert cfg["sample"]["guidance_scale"] == 1 and cfg["sample"]["sample_steps"] == 40
            assert cfg["save"]["save_every"] == 250 and cfg["network"]["linear_alpha"] == 16
        for base_id, arch in (("qwen-image-2512", "qwen_image"), ("z-image-base", "zimage")):
            trainer.CONFIG["base_model"] = next(m for m in catalog if m["id"] == base_id)
            cfg = json.loads(trainer.build_toolkit_config(job).read_text())["config"]["process"][0]
            assert cfg["model"]["arch"] == arch
            assert cfg["sample"]["guidance_scale"] == 3 and cfg["sample"]["sample_steps"] == 25
finally:
    trainer.CONFIG = previous_config

print("PASS  Qwen 2.1 inference, alpha, stacked/fused LoRAs, training profiles and legacy compatibility")
