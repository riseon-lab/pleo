# Pleo tests

Prompt-builder and compatibility checks (no running server needed):

    node tests/prompt_builder_test.mjs
    python3 tests/envmgr_test.py
    python3 tests/training_toolkit_test.py
    python3 tests/runner_test.py
    python3 tests/qwen_image21_test.py
    python3 tests/job_cancel_test.py

Live-preview checks in a torch environment (no GPU required):

    python3 tests/qwen_preview_test.py

To additionally check the real preview checkpoint, set `PLEO_PREVIEW_WEIGHTS`
to the pinned `taeqi2_1_tinier.safetensors` file before running that test.

Qwen 2.1's model environment can additionally verify real Diffusers/PEFT
adapter loading with a tiny CPU transformer (no weights or GPU required):

    /path/to/pleo-data/envs/qwen-image-2.1/bin/python tests/qwen_image21_runtime_test.py

Start a FRESH mock server first (tests sign up their own account):

    rm -rf data && PLEO_MOCK=1 PLEO_PORT=3210 python -m backend.main

Then, each against its own fresh server:

    python tests/api_test.py          # API and mock pipeline checks (needs httpx)
    node tests/crypto_test.mjs        # WebCrypto derivation/AES-GCM checks
    npm i playwright && npx playwright install chromium
    node tests/ui_test.mjs            # Browser checks + responsive screenshots
