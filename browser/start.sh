#!/bin/sh
# Xvfb gives Chromium a real display (headful is harder for LinkedIn to flag),
# then the worker runs as an unprivileged user so Chromium keeps its sandbox.
set -e
mkdir -p /data && chown -R app:app /data
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/dev/null 2>&1 &
exec setpriv --reuid=app --regid=app --init-groups --reset-env \
  env PATH="$PATH" HOME=/home/app DISPLAY=:99 DATA_DIR=/data \
  BROWSER_WORKER_TOKEN="$BROWSER_WORKER_TOKEN" OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  BROWSER_MODEL="${BROWSER_MODEL:-anthropic/claude-haiku-5.5}" CHROMIUM_SANDBOX="${CHROMIUM_SANDBOX:-true}" \
  uvicorn worker:app --host 0.0.0.0 --port 8080 --no-access-log --app-dir /app
