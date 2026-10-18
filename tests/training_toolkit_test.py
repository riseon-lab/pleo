"""Focused check for the ai-toolkit compatibility pin."""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import training


class _Result:
    returncode = 0
    stderr = ""


class _FailedPip:
    stdout = iter(["dependency install stopped for test\n"])

    def wait(self):
        return 1


calls = []
original_dir = training.AI_TOOLKIT_DIR
original_run = training.subprocess.run
original_popen = training.subprocess.Popen
try:
    with tempfile.TemporaryDirectory() as tmp:
        training.AI_TOOLKIT_DIR = Path(tmp)
        (training.AI_TOOLKIT_DIR / "run.py").touch()
        training.subprocess.run = lambda args, **_kwargs: calls.append(args) or _Result()
        training.subprocess.Popen = lambda *_args, **_kwargs: _FailedPip()
        training._toolkit_worker()
finally:
    training.AI_TOOLKIT_DIR = original_dir
    training.subprocess.run = original_run
    training.subprocess.Popen = original_popen

assert calls[:2] == [
    ["git", "-C", str(Path(tmp)), "fetch", "--depth", "1", "origin", training.AI_TOOLKIT_REF],
    ["git", "-C", str(Path(tmp)), "checkout", "--detach", training.AI_TOOLKIT_REF],
]
print("PASS  ai-toolkit installer checks out the compatible revision")
