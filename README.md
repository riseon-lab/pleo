# Pleo

Lightweight local model loader & runner for RunPod. FastAPI backend + vanilla
JS frontend on port **3000**, per-model venv isolation, browser-side (E2E)
encryption of assets and API keys. See `plan.md` for the full spec.

## Local development (no GPU needed)

```bash
pip install -r requirements.txt
python -m backend.main          # http://localhost:3000
```

On macOS/Windows the app starts in **mock mode** (`PLEO_MOCK=1` by default off
Linux): the runner synthesizes images so every flow — auth, queue, streaming
previews, encrypted assets, LoRA management — works without CUDA.

## RunPod

The image is **linux/amd64 only** (CUDA). On a Mac, cross-build with buildx —
or build on any linux box / CI and push to a registry:

```bash
docker buildx build --platform linux/amd64 -t <registry>/pleo:latest --push .
```

Run (RunPod template or locally on a linux GPU host):

```bash
docker run --gpus all -p 3000:3000 -v /your/volume:/workspace \
  -e PLEO_REPO=https://github.com/riseon-lab/pleo.git <registry>/pleo:latest
```

- Code is cloned/pulled from git at boot (and via Settings → Pull latest code),
  so image rebuilds are only needed when CUDA/torch change. If the repo is
  private, use `PLEO_REPO=https://<token>@github.com/riseon-lab/pleo.git`.
- All persistent data (weights cache, venvs, encrypted assets, LoRAs,
  datasets, training runs) lives under `/workspace/pleo-data`.
- For real LoRA training, also clone ai-toolkit onto the volume once:
  `git clone https://github.com/ostris/ai-toolkit /workspace/ai-toolkit`
  and install its requirements into the trainer venv (see
  `runners/reqs/trainer.txt`).

## Security model

- Password → PBKDF2 (600k) → HKDF → separate **encryption key** (never leaves
  the browser, non-extractable, kept in IndexedDB) and **auth key** (server
  stores only a salted hash).
- Assets and API keys are encrypted in a Web Worker before upload; the server
  stores ciphertext only. Generated images are handed to the browser through a
  transient in-memory outbox, encrypted client-side, then uploaded.
- No password reset endpoint by design. To wipe: `python -m backend.reset_account`.

## Repo ids

Model repo ids live in `models.json` — edit freely; no code changes needed.

## Data Studio & Training

- **Data Studio**: datasets of images + caption sidecars (`img.png` +
  `img.txt`). Upload, import decrypted assets, or pull from an HF dataset
  repo. Auto-caption with the Qwen2.5-VL captioner (own venv/runner; mock
  captions locally). Trigger words are saved per dataset and auto-prepended.
  ⚠ Dataset images are plaintext on the volume — training needs raw pixels.
- **Training**: LoRA jobs on Z Image Base / Qwen Image 2512 via
  [ostris/ai-toolkit](https://github.com/ostris/ai-toolkit) (mock-simulated
  locally). Checkpoint schedule (default 250/500/750/1000/1500/2000) plus
  manual "save now"; sample images per checkpoint from your prompts; ETA and
  cost from your RunPod $/hr; optional push to HF on completion; checkpoints
  promote straight into the LoRA library.

## Moderation

Settings → Content moderation toggles a local ONNX classifier. Use the
one-click **Install classifier** button (downloads
`AdamCodd/vit-base-nsfw-detector`, ~330 MB, into `data/moderation/`).
Fail-closed: enabled without a working classifier blocks saves rather than
skipping the check.
