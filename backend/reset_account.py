"""Deliberately shell-only account wipe (no HTTP endpoint — an unauthenticated
reset API would defeat the point of the login). Run on the pod:

    python -m backend.reset_account [--wipe-assets]

Removes the account record (and optionally all encrypted data, which is
unreadable without the old password anyway).
"""
import shutil
import sys

from . import config


def main() -> None:
    wiped = []
    if config.ACCOUNT_FILE.exists():
        config.ACCOUNT_FILE.unlink()
        wiped.append("account")
    if config.KEYS_BLOB_FILE.exists():
        config.KEYS_BLOB_FILE.unlink()
        wiped.append("api-keys blob")
    if "--wipe-assets" in sys.argv:
        if config.ASSETS_DIR.exists():
            shutil.rmtree(config.ASSETS_DIR)
        if config.ASSET_INDEX_FILE.exists():
            config.ASSET_INDEX_FILE.unlink()
        wiped.append("assets")
    print(f"Wiped: {', '.join(wiped) or 'nothing (already clean)'}")
    print("Restart the server and sign up again from the browser.")


if __name__ == "__main__":
    main()
