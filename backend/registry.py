"""Model registry, loaded from models.json at the repo root (user-editable)."""
from functools import lru_cache

from fastapi import HTTPException

from . import config
from .util import read_json


@lru_cache(maxsize=1)
def _registry() -> dict:
    data = read_json(config.ROOT / "models.json", {"models": []})
    return {m["id"]: m for m in data.get("models", [])}


def all_models() -> list[dict]:
    return list(_registry().values())


def get_model(model_id: str) -> dict:
    model = _registry().get(model_id)
    if not model:
        raise HTTPException(404, f"Unknown model: {model_id}")
    return model


def _raw() -> dict:
    return read_json(config.ROOT / "models.json", {})


def get_component(comp_id: str) -> dict:
    """A model OR a non-generation component (captioner/trainer) — anything
    that owns a venv."""
    if comp_id in _registry():
        return _registry()[comp_id]
    comp = _raw().get("components", {}).get(comp_id)
    if not comp:
        raise HTTPException(404, f"Unknown component: {comp_id}")
    return comp


def all_components() -> list[dict]:
    return list(_raw().get("components", {}).values())


def moderation_source() -> dict:
    return _raw().get("moderation_source", {})


def reload_registry() -> None:
    _registry.cache_clear()
