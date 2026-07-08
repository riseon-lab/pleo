"""LoRA management: Civitai resolve/download, Hugging Face download, local
list/delete. API keys arrive per-request (decrypted in the browser, used
transiently) — they are never stored plaintext server-side."""
import re
import threading
import time

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import config, events
from .auth import AUTHED
from .util import atomic_write_json, new_id, path_inside, read_json, safe_filename

router = APIRouter(prefix="/api/loras", tags=["loras"], dependencies=[AUTHED])

_downloads: dict[str, dict] = {}  # download_id -> {status, progress, ...}
_dl_lock = threading.Lock()

CIVITAI_API = "https://civitai.com/api/v1"


def _sidecar(path):
    return path.with_suffix(path.suffix + ".json")


@router.get("")
def list_loras():
    items = []
    for f in sorted(config.LORAS_DIR.glob("*.safetensors")):
        meta = read_json(_sidecar(f), {})
        items.append({
            "file": f.name,
            "size": f.stat().st_size,
            "mtime": f.stat().st_mtime,
            "source": meta.get("source"),
            "label": meta.get("label", f.stem),
        })
    return {"loras": items}


@router.delete("/{filename}")
def delete_lora(filename: str):
    p = config.LORAS_DIR / safe_filename(filename)
    if not path_inside(config.LORAS_DIR, p) or not p.exists():
        raise HTTPException(404, "No such LoRA")
    p.unlink()
    sc = _sidecar(p)
    if sc.exists():
        sc.unlink()
    return {"ok": True}


# ---------------- Civitai ----------------

class CivitaiResolveBody(BaseModel):
    url: str
    api_key: str | None = None


def _civitai_headers(key: str | None) -> dict:
    return {"Authorization": f"Bearer {key}"} if key else {}


def _parse_civitai_url(url: str) -> dict:
    """Accept any host containing 'civitai' (not just .com): model pages,
    version links, and direct download URLs."""
    try:
        host = httpx.URL(url).host or ""
    except Exception:
        raise HTTPException(400, "Not a valid URL")
    if "civitai" not in host.lower():
        raise HTTPException(400, "Not a Civitai URL")
    m = re.search(r"/models/(\d+)", url)
    version = re.search(r"modelVersionId=(\d+)", url)
    dl = re.search(r"/api/download/models/(\d+)", url)
    mv = re.search(r"/model-versions/(\d+)", url)
    return {
        "model_id": m.group(1) if m else None,
        "version_id": (version or dl or mv) and (version or dl or mv).group(1),
    }


@router.post("/civitai/resolve")
async def civitai_resolve(body: CivitaiResolveBody):
    parsed = _parse_civitai_url(body.url)
    headers = _civitai_headers(body.api_key)
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        try:
            if parsed["model_id"]:
                r = await client.get(f"{CIVITAI_API}/models/{parsed['model_id']}", headers=headers)
            elif parsed["version_id"]:
                r = await client.get(f"{CIVITAI_API}/model-versions/{parsed['version_id']}", headers=headers)
            else:
                raise HTTPException(400, "Could not find a model or version id in that URL")
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise HTTPException(502, f"Civitai API error: {e.response.status_code}")
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Civitai unreachable: {e}")
    data = r.json()
    # Normalize to a flat list of downloadable files for the picker modal.
    versions = data.get("modelVersions") or [data]
    items = []
    for v in versions:
        for f in v.get("files", []):
            items.append({
                "model_name": data.get("name") or v.get("model", {}).get("name"),
                "version_id": v.get("id"),
                "version_name": v.get("name"),
                "file_name": f.get("name"),
                "size_kb": f.get("sizeKB"),
                "type": f.get("type"),
                "download_url": f.get("downloadUrl"),
                "preview": (v.get("images") or [{}])[0].get("url"),
            })
    if not items:
        raise HTTPException(404, "No downloadable files found for that link")
    return {"items": items}


class CivitaiDownloadBody(BaseModel):
    download_url: str
    file_name: str
    api_key: str | None = None
    label: str | None = None


class HFDownloadBody(BaseModel):
    repo_id: str
    filename: str
    api_key: str | None = None
    label: str | None = None


def _download_file_worker(dl_id: str, url: str, dest_name: str, headers: dict, source: dict) -> None:
    dest = config.LORAS_DIR / dest_name
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with httpx.stream("GET", url, headers=headers, follow_redirects=True, timeout=60) as r:
            if r.status_code == 401 or r.status_code == 403:
                raise RuntimeError("Unauthorized — check your API key")
            r.raise_for_status()
            total = int(r.headers.get("content-length") or 0) or None
            done = 0
            last_pub = 0.0
            with open(tmp, "wb") as f:
                for chunk in r.iter_bytes(chunk_size=1 << 20):
                    f.write(chunk)
                    done += len(chunk)
                    now = time.time()
                    if now - last_pub > 0.5:
                        last_pub = now
                        progress = round(done / total * 100, 1) if total else None
                        with _dl_lock:
                            _downloads[dl_id].update(progress=progress, bytes=done, total=total)
                        events.publish({"type": "lora_download", "id": dl_id, "file": dest_name,
                                        "status": "downloading", "progress": progress,
                                        "bytes": done, "total": total})
        tmp.replace(dest)
        atomic_write_json(_sidecar(dest), {"source": source, "label": source.get("label") or dest.stem,
                                           "downloaded": time.time()})
        with _dl_lock:
            _downloads[dl_id].update(status="done", progress=100)
        events.publish({"type": "lora_download", "id": dl_id, "file": dest_name, "status": "done"})
    except Exception as e:
        tmp.unlink(missing_ok=True)
        with _dl_lock:
            _downloads[dl_id].update(status="error", detail=str(e)[:300])
        events.publish({"type": "lora_download", "id": dl_id, "file": dest_name,
                        "status": "error", "detail": str(e)[:300]})


def _start_download(url: str, file_name: str, headers: dict, source: dict) -> dict:
    name = safe_filename(file_name)
    if not name.endswith(".safetensors"):
        name += ".safetensors"
    dl_id = new_id(8)
    with _dl_lock:
        _downloads[dl_id] = {"id": dl_id, "file": name, "status": "downloading", "progress": 0}
    threading.Thread(target=_download_file_worker, args=(dl_id, url, name, headers, source), daemon=True).start()
    return {"id": dl_id, "file": name}


@router.post("/civitai/download")
def civitai_download(body: CivitaiDownloadBody):
    if "civitai" not in (httpx.URL(body.download_url).host or "").lower():
        raise HTTPException(400, "Download URL must be a Civitai host")
    return _start_download(
        body.download_url, body.file_name, _civitai_headers(body.api_key),
        {"kind": "civitai", "url": body.download_url, "label": body.label},
    )


@router.post("/hf/download")
def hf_download(body: HFDownloadBody):
    repo = body.repo_id.strip().strip("/")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise HTTPException(400, "repo_id must look like org/name")
    filename = body.filename.strip().lstrip("/")
    if ".." in filename:
        raise HTTPException(400, "Bad filename")
    url = f"https://huggingface.co/{repo}/resolve/main/{filename}"
    headers = {"Authorization": f"Bearer {body.api_key}"} if body.api_key else {}
    return _start_download(url, filename.split("/")[-1], headers,
                           {"kind": "huggingface", "repo": repo, "file": filename, "label": body.label})


@router.get("/downloads")
def list_downloads():
    with _dl_lock:
        return {"downloads": list(_downloads.values())}
