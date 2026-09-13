"""Run with python3 tests/journey_test.py. CPU-only framing/audio regression."""
import asyncio
import base64
import io
import json
import math
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image
from backend import jobs
from backend.soundtrack import validate_audio, mix_audio

image = io.BytesIO()
Image.new('RGB', (64, 128), 'blue').save(image, format='PNG')
audio = io.BytesIO()
with wave.open(audio, 'wb') as wav:
    wav.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
    wav.writeframes(b''.join(struct.pack('<h', int(2000 * math.sin(i / 8))) for i in range(16000)))
sound = audio.getvalue()
validate_audio(sound, 0.5)
for data, start in [(b'not audio', 0), (sound, 3)]:
    try:
        validate_audio(data, start)
        raise AssertionError('Invalid audio/start accepted')
    except ValueError:
        pass

async def check_framing():
    with patch.object(jobs, '_ensure_worker'), patch.object(jobs.moderation, 'is_enabled', return_value=False):
        for aspect, width, height in [('16:9', 768, 432), ('9:16', 432, 768)]:
            body = jobs.GenerateBody(model_id='wan-2.2-i2v-a14b-lightning', prompt='dance', steps=4, cfg=1,
                width=512, height=512, ref_image_b64=base64.b64encode(image.getvalue()).decode(),
                video_aspect=aspect, audio_b64=base64.b64encode(sound).decode(), audio_start=0.5)
            result = await jobs.submit(body)
            assert (result['job']['width'], result['job']['height']) == (width, height)
            assert 'audio_bytes' not in result['job']
            assert result['job']['status'] == 'queued'
            job = jobs._queue.pop()
            jobs._finish(job)
            assert 'audio_bytes' not in job and 'ref_bytes' not in job
asyncio.run(check_framing())

with tempfile.TemporaryDirectory() as folder:
    video = Path(folder) / 'input.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x64:d=1', '-c:v', 'libx264', str(video)], check=True)
    mixed = mix_audio(video.read_bytes(), sound, 0.5, 1024 * 1024)
    output = Path(folder) / 'output.mp4'
    output.write_bytes(mixed)
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(output)]))
    assert {s['codec_type'] for s in info['streams']} == {'audio', 'video'}
    assert all(0.9 <= float(s['duration']) <= 1.2 for s in info['streams'])
print('PASS: portrait/landscape sizing, audio validation, job cleanup, playable video + soundtrack')
