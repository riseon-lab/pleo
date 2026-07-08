"""Authentication.

The browser derives two keys from the password (PBKDF2 -> HKDF):
  - encKey: never leaves the browser; encrypts assets/keys client-side.
  - authKey: sent on login. The server stores only sha256(server_salt || authKey),
    so neither the password, the encryption key, nor a replayable credential
    is recoverable from disk.

Single-account app (one user per pod). There is deliberately no password
reset API: losing the password means the encrypted data is unrecoverable.
Shell access + `python -m backend.reset_account` is the only wipe path.
"""
import asyncio
import base64
import hashlib
import secrets
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from . import config
from .util import atomic_write_json, read_json

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Sessions are persisted HASHED (sha256) so a backend restart/update doesn't
# log the user out, while a disk leak still can't recover usable tokens.
_SESSIONS_FILE = config.DATA_DIR / "sessions.json"
_sessions: dict[str, float] | None = None  # sha256(token) hex -> expiry epoch
_failed_logins: list[float] = []  # timestamps of recent failures
_MAX_FAILS_PER_MIN = 5


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _get_sessions() -> dict[str, float]:
    global _sessions
    if _sessions is None:
        raw = read_json(_SESSIONS_FILE, {})
        now = time.time()
        _sessions = {k: v for k, v in raw.items() if isinstance(v, (int, float)) and v > now}
    return _sessions


def _save_sessions() -> None:
    atomic_write_json(_SESSIONS_FILE, _get_sessions())


def _load_account() -> Optional[dict]:
    acct = read_json(config.ACCOUNT_FILE)
    if acct is not None and not isinstance(acct, dict):
        return None
    return acct


class SignupBody(BaseModel):
    salt: str          # base64, generated in the browser
    iterations: int
    auth_key: str      # base64 (32 bytes)


class LoginBody(BaseModel):
    auth_key: str


def _hash_verifier(server_salt: bytes, auth_key: bytes) -> str:
    return base64.b64encode(hashlib.sha256(server_salt + auth_key).digest()).decode()


@router.get("/meta")
def auth_meta():
    acct = _load_account()
    if not acct:
        return {"exists": False}
    return {"exists": True, "salt": acct["salt"], "iterations": acct["iterations"]}


@router.post("/signup")
def signup(body: SignupBody):
    if _load_account():
        raise HTTPException(409, "Account already exists")
    if body.iterations < 100_000:
        raise HTTPException(400, "Iteration count too low")
    try:
        auth_key = base64.b64decode(body.auth_key)
        base64.b64decode(body.salt)
    except Exception:
        raise HTTPException(400, "Invalid base64")
    if len(auth_key) < 32:
        raise HTTPException(400, "auth_key too short")
    server_salt = secrets.token_bytes(16)
    atomic_write_json(config.ACCOUNT_FILE, {
        "salt": body.salt,
        "iterations": body.iterations,
        "server_salt": base64.b64encode(server_salt).decode(),
        "verifier": _hash_verifier(server_salt, auth_key),
        "created": time.time(),
    })
    return _issue_session()


@router.post("/login")
async def login(body: LoginBody):
    now = time.time()
    recent = [t for t in _failed_logins if now - t < 60]
    _failed_logins[:] = recent
    if len(recent) >= _MAX_FAILS_PER_MIN:
        raise HTTPException(429, "Too many attempts; wait a minute")
    acct = _load_account()
    if not acct:
        raise HTTPException(404, "No account exists")
    try:
        auth_key = base64.b64decode(body.auth_key)
    except Exception:
        raise HTTPException(400, "Invalid base64")
    server_salt = base64.b64decode(acct["server_salt"])
    expected = acct["verifier"]
    given = _hash_verifier(server_salt, auth_key)
    # Small constant delay blunts both timing measurement and brute force.
    await asyncio.sleep(0.3)
    if not secrets.compare_digest(expected, given):
        _failed_logins.append(time.time())
        raise HTTPException(401, "Incorrect password")
    return _issue_session()


def _issue_session() -> dict:
    token = secrets.token_urlsafe(32)
    sessions = _get_sessions()
    now = time.time()
    for k in [k for k, exp in sessions.items() if exp < now]:
        sessions.pop(k)
    sessions[_hash_token(token)] = now + config.SESSION_TTL_SECONDS
    _save_sessions()
    return {"token": token, "expires_in": config.SESSION_TTL_SECONDS}


def _valid_token(token: str) -> bool:
    sessions = _get_sessions()
    key = _hash_token(token)
    exp = sessions.get(key)
    if exp is None:
        return False
    now = time.time()
    if exp < now:
        sessions.pop(key, None)
        _save_sessions()
        return False
    # Sliding renewal, persisted at most every 10 minutes to avoid write churn.
    if exp - now < config.SESSION_TTL_SECONDS - 600:
        sessions[key] = now + config.SESSION_TTL_SECONDS
        _save_sessions()
    return True


def require_auth(request: Request) -> None:
    """FastAPI dependency guarding every non-auth API route."""
    header = request.headers.get("authorization", "")
    token = header.removeprefix("Bearer ").strip()
    if not token or not _valid_token(token):
        raise HTTPException(401, "Not authenticated")


def valid_token_str(token: str) -> bool:
    """For SSE, where EventSource cannot set headers (token via query param)."""
    return _valid_token(token)


@router.post("/logout")
def logout(request: Request):
    header = request.headers.get("authorization", "")
    token = header.removeprefix("Bearer ").strip()
    if _get_sessions().pop(_hash_token(token), None) is not None:
        _save_sessions()
    return {"ok": True}


AUTHED = Depends(require_auth)
