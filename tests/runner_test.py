"""Small runner checks that do not need a GPU or model weights."""
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runners.runner import _encode_mp4


class _Stream:
    def encode(self, frame=None):
        return []


class _Container:
    def __init__(self, output, options):
        assert not options or "faststart" not in options.get("movflags", "")
        self.output = output

    def add_stream(self, *_args, **_kwargs):
        return _Stream()

    def mux(self, _packet):
        pass

    def close(self):
        self.output.write(b"mock-mp4")


sys.modules["av"] = SimpleNamespace(
    open=lambda output, **kwargs: _Container(output, kwargs.get("options")),
    VideoFrame=SimpleNamespace(from_ndarray=lambda *_args, **_kwargs: object()),
)

assert _encode_mp4([np.zeros((2, 2, 3), dtype=np.uint8)], 16) == b"mock-mp4"
print("PASS  MP4 encoding uses an in-memory-safe muxer")
