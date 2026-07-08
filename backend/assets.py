"""Encrypted asset store.

The browser encrypts every blob (generated image, reference image) and its
metadata with the user's key before upload. The server only ever sees and
stores opaque ciphertext. The plaintext index holds nothing sensitive:
ids, sizes, timestamps, and a kind tag for filtering.
"""
import os
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import config
from .auth import AUTHED
from .util import atomic_write_json, new_id, path_inside, read_json

router = APIRouter(prefix="/api/assets", tags=["assets"], dependencies=[AUTHED])

MAX_ASSET_BYTES = 64 * 1024 * 1024


def _index() -> list[dict]:
    return read_json(config.ASSET_INDEX_FILE, [])


def _save_index(items: list[dict]) -> None:
    atomic_write_json(config.ASSET_INDEX_FILE, items)


def _blob_path(asset_id: str) -> Path:
    p = config.ASSETS_DIR / f"{asset_id}.bin"
    if not path_inside(config.ASSETS_DIR, p):
        raise HTTPException(400, "Bad asset id")
    return p


@router.get("")
def list_assets():
    return {"assets": sorted(_index(), key=lambda a: a["created"], reverse=True)}


@router.post("")
async def upload_asset(request: Request):
    """Body: raw encrypted bytes. Headers: X-Pleo-Kind, X-Pleo-Meta (encrypted
    metadata, base64) — both opaque except the kind tag used for filtering."""
    kind = request.headers.get("x-pleo-kind", "generated")
    if kind not in ("generated", "reference"):
        raise HTTPException(400, "kind must be 'generated' or 'reference'")
    enc_meta = request.headers.get("x-pleo-meta", "")
    if len(enc_meta) > 256 * 1024:
        raise HTTPException(413, "metadata too large")
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_ASSET_BYTES:
            raise HTTPException(413, "asset too large")
    if not body:
        raise HTTPException(400, "empty body")
    asset_id = new_id()
    path = _blob_path(asset_id)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(body)
    os.replace(tmp, path)
    items = _index()
    entry = {
        "id": asset_id,
        "kind": kind,
        "size": len(body),
        "created": time.time(),
        "enc_meta": enc_meta,
    }
    items.append(entry)
    _save_index(items)
    return entry


@router.get("/{asset_id}/blob")
def get_blob(asset_id: str):
    from fastapi.responses import FileResponse
    path = _blob_path(asset_id)
    if not path.exists():
        raise HTTPException(404, "No such asset")
    return FileResponse(path, media_type="application/octet-stream")


@router.delete("/{asset_id}")
def delete_asset(asset_id: str):
    items = _index()
    remaining = [a for a in items if a["id"] != asset_id]
    if len(remaining) == len(items):
        raise HTTPException(404, "No such asset")
    _save_index(remaining)
    path = _blob_path(asset_id)
    if path.exists():
        path.unlink()
    return {"ok": True}
