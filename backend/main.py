"""Pleo backend entrypoint: FastAPI on :3000 serving the API and the static
frontend. Run with `python -m backend.main`."""
import asyncio
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, events, runner_manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.ensure_dirs()
    events.bind_loop(asyncio.get_running_loop())
    yield
    from . import captioner_manager, training
    await runner_manager.stop_runner()
    await captioner_manager.shutdown()
    await training.shutdown()


app = FastAPI(title="Pleo", lifespan=lifespan)


@app.middleware("http")
async def same_origin_guard(request: Request, call_next):
    """Defense-in-depth CSRF guard: browsers always send Origin on
    cross-origin state-changing requests; reject mismatches. Non-browser
    clients (no Origin header) pass through — auth still applies."""
    if request.method in ("POST", "PUT", "DELETE", "PATCH"):
        origin = request.headers.get("origin")
        host = request.headers.get("host")
        if origin and host:
            from urllib.parse import urlsplit
            if urlsplit(origin).netloc != host:
                return JSONResponse({"detail": "Cross-origin request rejected"}, status_code=403)
    return await call_next(request)


from .auth import router as auth_router          # noqa: E402
from .assets import router as assets_router      # noqa: E402
from .captioner_manager import router as captioner_router  # noqa: E402
from .datasets import router as datasets_router  # noqa: E402
from .envmgr import router as envs_router        # noqa: E402
from .jobs import router as jobs_router          # noqa: E402
from .loras import router as loras_router        # noqa: E402
from .models_api import router as models_router  # noqa: E402
from .settings_api import router as settings_router  # noqa: E402
from .training import router as training_router  # noqa: E402

app.include_router(auth_router)
app.include_router(assets_router)
app.include_router(captioner_router)
app.include_router(datasets_router)
app.include_router(envs_router)
app.include_router(jobs_router)
app.include_router(loras_router)
app.include_router(models_router)
app.include_router(settings_router)
app.include_router(training_router)

app.mount("/", StaticFiles(directory=str(config.ROOT / "frontend"), html=True), name="frontend")


def run() -> None:
    uvicorn.run(app, host="0.0.0.0", port=config.PORT, log_level="info")


if __name__ == "__main__":
    run()
