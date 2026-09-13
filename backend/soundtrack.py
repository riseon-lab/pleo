"""CPU-only soundtrack assembly. Private temporary files are removed after use."""
import json
import shutil
import subprocess
import tempfile
from pathlib import Path


def _run(args):
    try:
        result = subprocess.run(args, capture_output=True, timeout=60, check=True)
        return result.stdout
    except (subprocess.SubprocessError, OSError) as exc:
        raise ValueError("Could not read or mix this soundtrack. Choose a valid MP3 or WAV.") from exc


def validate_audio(audio: bytes, start: float) -> None:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("Soundtrack mixing needs FFmpeg on the server. Install it or render without audio.")
    if not audio or len(audio) > 32 * 1024 * 1024:
        raise ValueError("Choose a soundtrack smaller than 32 MB")
    if not (audio.startswith(b"ID3") or audio[:4] == b"RIFF" or (len(audio) > 1 and audio[0] == 255 and audio[1] & 224 == 224)):
        raise ValueError("Choose an MP3 or WAV soundtrack")
    with tempfile.TemporaryDirectory(prefix="soundtrack-") as folder:
        path = Path(folder) / "audio"
        path.write_bytes(audio)
        info = json.loads(_run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_format", "-show_streams", "-of", "json", str(path)]))
        if not any(s.get("codec_type") == "audio" for s in info.get("streams", [])):
            raise ValueError("The file has no audio track")
        duration = float(info.get("format", {}).get("duration", 0))
        if not duration > start:
            raise ValueError("The track must extend beyond the selected start time")


def mix_audio(video: bytes, audio: bytes, start: float, max_bytes: int) -> bytes:
    with tempfile.TemporaryDirectory(prefix="soundtrack-") as folder:
        root = Path(folder)
        (root / "video.mp4").write_bytes(video)
        (root / "audio").write_bytes(audio)
        output = root / "output.mp4"
        info = json.loads(_run(["ffprobe", "-v", "error", "-show_format", "-of", "json", str(root / "video.mp4")]))
        duration = float(info.get("format", {}).get("duration", 0))
        if not 0 < duration <= 10:
            raise ValueError("Expected a video clip of up to 10 seconds")
        _run(["ffmpeg", "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
              "-i", str(root / "video.mp4"), "-ss", str(start), "-protocol_whitelist", "file,pipe",
              "-i", str(root / "audio"), "-map", "0:v:0", "-map", "1:a:0",
              "-c:v", "copy", "-c:a", "aac", "-af", "apad", "-t", str(duration),
              "-movflags", "+faststart", str(output)])
        if output.stat().st_size > max_bytes:
            raise ValueError("Mixed video exceeds the asset size limit")
        return output.read_bytes()
