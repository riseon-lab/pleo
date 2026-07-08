# Pleo tests

Start a FRESH mock server first (tests sign up their own account):

    rm -rf data && PLEO_MOCK=1 PLEO_PORT=3210 python -m backend.main

Then, each against its own fresh server:

    python tests/api_test.py          # 49 API checks (needs httpx)
    node tests/crypto_test.mjs        # WebCrypto derivation/AES-GCM checks
    npm i playwright && npx playwright install chromium
    node tests/ui_test.mjs            # 26 browser checks + screenshots
