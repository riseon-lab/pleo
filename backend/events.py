"""Server-Sent Events hub. Everything the UI watches live flows through here:
job status, step previews, runner state, downloads, env installs."""
import asyncio
import json
from typing import Any

_subscribers: set[asyncio.Queue] = set()
_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def publish(event: dict[str, Any]) -> None:
    """Thread-safe publish (download/env workers run in threads)."""
    if _loop is None:
        return
    def _put():
        dead = []
        for q in _subscribers:
            if q.qsize() > 500:
                dead.append(q)  # slow consumer; drop it rather than balloon memory
                continue
            q.put_nowait(event)
        for q in dead:
            _subscribers.discard(q)
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is _loop:
        _put()
    else:
        _loop.call_soon_threadsafe(_put)


async def subscribe():
    """Async generator yielding SSE-formatted strings, with heartbeats."""
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.add(q)
    try:
        yield "retry: 2000\n\n"
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=15)
                yield f"data: {json.dumps(event)}\n\n"
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
    finally:
        _subscribers.discard(q)
