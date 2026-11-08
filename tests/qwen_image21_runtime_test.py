"""Run in the Qwen 2.1 environment: real CPU adapter loading, no model downloads."""
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import torch
from diffusers import QwenImage21Pipeline, QwenImage21Transformer2DModel
from safetensors.torch import save_file

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runners.runner import _qwen21_lora_weights


class Processor:
    tokenizer = SimpleNamespace(encode=lambda _text: [1])

    def apply_chat_template(self, *_args, **_kwargs):
        return [[1, 2]]


torch.manual_seed(42)
transformer = QwenImage21Transformer2DModel(
    in_channels=4, out_channels=4, num_layers=1, num_attention_heads=1,
    attention_head_dim=8, context_in_dim=8, mlp_ratio=2, axes_dims_rope=(2, 2, 4))
vae = torch.nn.Linear(1, 1)
vae.config = SimpleNamespace(z_dim=64)
pipe = QwenImage21Pipeline(scheduler=None, vae=vae, text_encoder=torch.nn.Linear(1, 1),
                           processor=Processor(), transformer=transformer)
down, up = torch.randn(2, 8), torch.randn(32, 2)
prefix = "diffusion_model.transformer_blocks.0."
fused = {prefix + "img_mlp.gate_up.lora_A.weight": down,
         prefix + "img_mlp.gate_up.lora_B.weight": up,
         prefix + "img_mlp.gate_up.alpha": torch.tensor(1.0)}
style = {prefix + "attn.to_q.lora_A.weight": torch.randn(2, 8),
         prefix + "attn.to_q.lora_B.weight": torch.randn(8, 2)}
with tempfile.TemporaryDirectory() as directory:
    for name, weights in (("character", fused), ("style", style)):
        path = str(Path(directory, name + ".safetensors"))
        save_file(weights, path)
        pipe.load_lora_weights(_qwen21_lora_weights(pipe, path), adapter_name=name)
    pipe.set_adapters(["character", "style"], adapter_weights=[0.85, 0.3])
    assert set(pipe.get_active_adapters()) == {"character", "style"}
    inputs = torch.randn(3, 8)
    for name, expected_up in (("gate_layer", up[:16]), ("proj", up[16:])):
        layer = getattr(transformer.transformer_blocks[0].img_mlp, name)
        baseline = torch.nn.functional.linear(inputs, layer.base_layer.weight)
        expected = baseline + 0.85 * 0.5 * (inputs @ down.T @ expected_up.T)
        torch.testing.assert_close(layer(inputs), expected)
    pipe.unload_lora_weights()
    assert not hasattr(transformer.transformer_blocks[0].img_mlp.gate_layer, "lora_A")

print("PASS  real Diffusers/PEFT load trained fused LoRAs, preserve alpha and stack two adapters on CPU")
