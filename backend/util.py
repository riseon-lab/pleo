"""Small shared helpers: atomic JSON persistence, ids, filename safety."""
import json
import os
import re
import secrets
import tempfile
from pathlib import Path
from typing import Any


def atomic_write_json(path: Path, data: Any) -> None:
    """Write JSON via a temp file + rename so a crash never corrupts state."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_json(path: Path, default: Any = None) -> Any:
    """Read JSON; distinguish missing (default) from corrupt (backed up, default)."""
    if not path.exists():
        return default
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        backup = path.with_suffix(path.suffix + ".corrupt")
        try:
            os.replace(path, backup)
        except OSError:
            pass
        return default


def new_id(nbytes: int = 12) -> str:
    return secrets.token_urlsafe(nbytes)


_SAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]+")


def safe_filename(name: str) -> str:
    """Collapse a user/remote-supplied filename to a single safe path segment."""
    name = os.path.basename(name.replace("\\", "/")).strip()
    name = _SAFE_NAME.sub("_", name)
    name = name.lstrip(".")
    return name[:200] or "file"


def path_inside(base: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False
