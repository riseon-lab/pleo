"""Stop requests during model loading and final decode must not save results."""
import asyncio
from contextlib import suppress
from pathlib import Path
import sys
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import jobs


async def check_stop(phase):
    entered, release, finished = asyncio.Event(), asyncio.Event(), asyncio.Event()
    job = dict(id="cancel-check", model_id="z-image-base", prompt="test", negative_prompt="",
               steps=4, cfg=1, width=64, height=64, seed=42, loras=[], ref_bytes=None, video_bytes=None)

    async def pause(*_args):
        entered.set()
        await release.wait()
        return {"type": "done", "mime": "image/png", "media_b64": "unused"}

    original_finish = jobs._finish
    def finish(current):
        original_finish(current)
        finished.set()

    start = pause if phase == "starting" else AsyncMock()
    generate = AsyncMock() if phase == "starting" else pause
    with patch.object(jobs, "_queue", [job]), patch.object(jobs, "_history", []), \
         patch.object(jobs, "_current", None), patch.object(jobs, "_finish", side_effect=finish), \
         patch.object(jobs, "_publish_job"), patch.object(jobs, "_wakeup", asyncio.Event()), \
         patch.object(jobs.runner_manager, "start_runner", side_effect=start), \
         patch.object(jobs.runner_manager, "generate", side_effect=generate), \
         patch.object(jobs.runner_manager, "cancel_generation", new_callable=AsyncMock), \
         patch.object(jobs.runner_manager, "outbox_put", new_callable=Mock) as save:
        task = asyncio.create_task(jobs._worker())
        try:
            await asyncio.wait_for(entered.wait(), 2)
            await jobs.cancel_job(job["id"])
            release.set()
            await asyncio.wait_for(finished.wait(), 2)
            assert job["status"] == "cancelled" and jobs._current is None
            assert "cancel_requested" not in job and "progress" not in job
            save.assert_not_called()
            if phase == "starting":
                generate.assert_not_called()
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


async def main():
    await check_stop("starting")
    await check_stop("decoding")


asyncio.run(main())
print("PASS  stop during model loading or final decode cancels without saving a result")
