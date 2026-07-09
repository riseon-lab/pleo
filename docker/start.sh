#!/usr/bin/env bash
# Pleo boot: sync code from git (with retries — pod networking is often not
# ready in the first seconds), then supervise the backend so a crash or a
# Settings->Restart never kills the container.
set -u

echo "[pleo] boot"

net_ready() {
  curl -fsSI --max-time 8 https://github.com >/dev/null 2>&1
}

sync_code() {
  # Returns 0 when runnable code is present at $PLEO_DIR.
  if [ -f "$PLEO_DIR/backend/main.py" ] && [ ! -d "$PLEO_DIR/.git" ]; then
    echo "[pleo] using mounted code (no .git) at $PLEO_DIR"
    return 0
  fi
  if [ -d "$PLEO_DIR/.git" ]; then
    echo "[pleo] updating existing checkout"
    git -C "$PLEO_DIR" pull --ff-only || echo "[pleo] pull failed; running existing code"
  elif [ -n "${PLEO_REPO:-}" ]; then
    # Clear debris from a previously interrupted clone.
    if [ -d "$PLEO_DIR" ] && [ ! -f "$PLEO_DIR/backend/main.py" ]; then
      rm -rf "$PLEO_DIR"
    fi
    echo "[pleo] cloning $PLEO_REPO ($PLEO_BRANCH) -> $PLEO_DIR"
    git clone --branch "$PLEO_BRANCH" "$PLEO_REPO" "$PLEO_DIR" || return 1
  fi
  [ -f "$PLEO_DIR/backend/main.py" ]
}

attempt=0
delay=3
until sync_code; do
  attempt=$((attempt + 1))
  if ! net_ready; then
    echo "[pleo] network not ready (attempt $attempt) — retrying in ${delay}s"
  else
    echo "[pleo] code sync failed (attempt $attempt) — retrying in ${delay}s"
  fi
  sleep "$delay"
  [ "$delay" -lt 30 ] && delay=$((delay + 3))
done

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
