#!/usr/bin/env bash
# Pleo boot: sync code from git, then supervise the backend so a crash or a
# Settings->Restart never kills the container.
set -u

echo "[pleo] boot"

if [ -n "${PLEO_REPO:-}" ]; then
  if [ ! -d "$PLEO_DIR/.git" ]; then
    echo "[pleo] cloning $PLEO_REPO ($PLEO_BRANCH) -> $PLEO_DIR"
    git clone --branch "$PLEO_BRANCH" "$PLEO_REPO" "$PLEO_DIR" || echo "[pleo] clone failed"
  else
    echo "[pleo] updating existing checkout"
    git -C "$PLEO_DIR" pull --ff-only || echo "[pleo] pull failed; running existing code"
  fi
fi

if [ ! -f "$PLEO_DIR/backend/main.py" ]; then
  echo "[pleo] FATAL: no app code at $PLEO_DIR (set PLEO_REPO or mount the code)"
  sleep infinity
fi

cd "$PLEO_DIR"

# Supervisor loop: os.execv restarts replace the process in place; if the
# process ever exits (crash), relaunch it after a short pause.
while true; do
  echo "[pleo] starting backend on :${PLEO_PORT:-3000}"
  python3 -m backend.main
  code=$?
  echo "[pleo] backend exited with code $code — restarting in 3s"
  sleep 3
done
