"""Central paths and runtime flags for Pleo."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def _default_data_dir() -> Path:
    env = os.environ.get("PLEO_DATA")
    if env:
        return Path(env)
    # On RunPod the persistent volume is mounted at /workspace.
    ws = Path("/workspace")
    if ws.is_dir() and os.access(ws, os.W_OK):
        return ws / "pleo-data"
    return ROOT / "data"

DATA_DIR = _default_data_dir()
ASSETS_DIR = DATA_DIR / "assets"
LORAS_DIR = DATA_DIR / "loras"
ENVS_DIR = DATA_DIR / "envs"
HF_CACHE_DIR = DATA_DIR / "hf-cache"
MODERATION_DIR = DATA_DIR / "moderation"
TMP_DIR = DATA_DIR / "tmp"

ACCOUNT_FILE = DATA_DIR / "account.json"
KEYS_BLOB_FILE = DATA_DIR / "keys.enc"
SETTINGS_FILE = DATA_DIR / "settings.json"
ASSET_INDEX_FILE = DATA_DIR / "assets-index.json"

PORT = int(os.environ.get("PLEO_PORT", "3000"))
RUNNER_PORT = int(os.environ.get("PLEO_RUNNER_PORT", "8801"))

# Mock mode: no GPU work, the runner synthesizes images. Defaults to on
# when not running on Linux (i.e. local development on macOS/Windows).
MOCK = os.environ.get("PLEO_MOCK", "1" if sys.platform != "linux" else "0") == "1"

SESSION_TTL_SECONDS = 24 * 3600
OUTBOX_TTL_SECONDS = 15 * 60

def ensure_dirs() -> None:
    for d in (DATA_DIR, ASSETS_DIR, LORAS_DIR, ENVS_DIR, HF_CACHE_DIR, MODERATION_DIR, TMP_DIR):
        d.mkdir(parents=True, exist_ok=True)
    # Model weights are cached under the persistent data dir so they survive
    # pod restarts and can be deleted per-model from the UI.
    os.environ.setdefault("HF_HOME", str(HF_CACHE_DIR))
