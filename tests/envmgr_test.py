"""Focused checks for environment-install error reporting."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import envmgr


class _FailedPip:
    stdout = iter(["Collecting packages\n", "AssertionError\n"])

    def wait(self):
        return 1


states = []
original_popen = envmgr.subprocess.Popen
original_set_state = envmgr._set_state
envmgr.subprocess.Popen = lambda *_args, **_kwargs: _FailedPip()
envmgr._set_state = lambda *args: states.append(args)
try:
    try:
        envmgr._run_pip("captioner", "install", "-r", "captioner.txt")
        raise AssertionError("failed pip process did not raise")
    except RuntimeError as exc:
        assert str(exc) == "pip failed: AssertionError"
        assert states[-1] == ("captioner", "installing", "AssertionError")
finally:
    envmgr.subprocess.Popen = original_popen
    envmgr._set_state = original_set_state

print("PASS  environment install surfaces pip's final error")
