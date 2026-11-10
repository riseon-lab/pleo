"""CPU-only TAEQI2.1-Tinier previews; the generation VAE stays offloaded.

Decoder architecture adapted from madebyollin/taesd (MIT), commit
fdbae2df989db95761f482efb8977e1182fb68d2. See licenses/taesd.txt.
"""
import torch
from torch import nn

MODEL_ID = "madebyollin/taeqi2_1"
REVISION = "5d62f11fee0068b4df7bd699ddab685e32174010"


def conv(n_in, n_out, **kwargs):
    return nn.Conv2d(n_in, n_out, 3, padding=1, **kwargs)


class Clamp(nn.Module):
    def forward(self, x):
        return torch.tanh(x / 3) * 3


class Block(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.conv = nn.Sequential(conv(channels, channels), nn.ReLU(),
                                  conv(channels, channels), nn.ReLU(), conv(channels, channels))

    def forward(self, x):
        return (self.conv(x) + x).relu()


class SuperBlock(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(channels, channels, 7, padding=3, groups=channels, bias=False),
            nn.Conv2d(channels, channels * 2, 1), nn.ReLU(inplace=True),
            nn.Conv2d(channels * 2, channels, 1, bias=False))

    def forward(self, x):
        return self.conv(x) + x


def load_decoder():
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file

    decoder = nn.Sequential(
        Clamp(), conv(64, 256), nn.ReLU(),
        SuperBlock(256), SuperBlock(256), SuperBlock(256), nn.Upsample(scale_factor=2), conv(256, 128, bias=False),
        SuperBlock(128), SuperBlock(128), SuperBlock(128), nn.Upsample(scale_factor=2), conv(128, 64, bias=False),
        Block(64), Block(64), Block(64), nn.Upsample(scale_factor=2), conv(64, 64, bias=False),
        Block(64), conv(64, 16), nn.PixelShuffle(2))
    path = hf_hub_download(MODEL_ID, "taeqi2_1_tinier.safetensors", revision=REVISION, etag_timeout=5)
    state = {}
    for key, value in load_file(path).items():
        if key.startswith("decoder.layers."):
            _, _, index, suffix = key.split(".", 3)
            state[f"{int(index) + 1}.{suffix}"] = value
    decoder.load_state_dict(state, strict=True)
    return decoder.eval().requires_grad_(False)


@torch.inference_mode()
def decode_preview(decoder, pipeline, latents, params):
    # TAEQI2.1 consumes normalized sampler latents directly, before the full
    # VAE's per-channel mean/std transform. Use the pipeline's actual grid.
    latent = pipeline._unpack_latents(
        latents[:1].detach(), params["height"], params["width"], pipeline.vae_scale_factor)
    latent = latent[:, :, 0].to(device="cpu", dtype=torch.float32)
    height, width = latent.shape[-2:]
    scale = min(1, 24 / max(height, width))
    if scale < 1:
        latent = nn.functional.interpolate(latent, size=(max(1, round(height * scale)),
                                                        max(1, round(width * scale))), mode="area")
    image = decoder(latent).clamp(0, 1)[0].permute(1, 2, 0).mul(255).byte().numpy()
    from PIL import Image
    return Image.fromarray(image, "RGBA")
