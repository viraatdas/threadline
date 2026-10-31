#!/bin/sh
# Xvfb gives Chromium a real display (headful is harder for LinkedIn to flag),
# then the worker runs as an unprivileged user so Chromium keeps its sandbox.
set -e
mkdir -p /data && chown -R app:app /data
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/dev/null 2>&1 &

# Tailscale: the browser goes out through tailscaled's SOCKS5 proxy, which
# sends it via the owner's exit node (TS_EXIT_NODE, an always-on machine at
# home), so LinkedIn sees their home IP. Node state lives on the volume (root-only), so
# TS_AUTHKEY is only needed on the first boot. Log upload is off, and nothing
# on the tailnet can connect in.
TS_STATE=/data/.tailscale
if [ -n "${TS_AUTHKEY:-}" ] || [ -f "$TS_STATE/tailscaled.state" ]; then
  mkdir -p "$TS_STATE" /var/run/tailscale
  chown -R root:root "$TS_STATE" && chmod 700 "$TS_STATE"
  tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:1055 --statedir="$TS_STATE" --no-logs-no-support >/dev/null 2>&1 &
  for _ in $(seq 1 40); do [ -S /var/run/tailscale/tailscaled.sock ] && break; sleep 0.25; done
  tailscale up --hostname=threadline-browser --accept-dns=false --shields-up ${TS_AUTHKEY:+--authkey="$TS_AUTHKEY"} >/dev/null 2>&1 \
    || echo "tailscale up failed; LinkedIn runs will wait"
  # Only ever exit through TS_EXIT_NODE: drop whatever node the saved state had.
  tailscale set --exit-node= >/dev/null 2>&1 || true
  if [ -n "${TS_EXIT_NODE:-}" ]; then
    # Keep it set: it may be offline at boot, and `tailscale set` can succeed
    # before the netmap arrives and then not stick.
    ( while true; do
        tailscale status --json 2>/dev/null | grep -q '"ExitNodeStatus"' \
          || tailscale set --exit-node="$TS_EXIT_NODE" --exit-node-allow-lan-access=false >/dev/null 2>&1
        sleep 30
      done ) &
  fi
  BROWSER_PROXY=socks5://127.0.0.1:1055
fi

exec setpriv --reuid=app --regid=app --init-groups --reset-env \
  env PATH="$PATH" HOME=/home/app DISPLAY=:99 DATA_DIR=/data TZ="${TZ:-America/Los_Angeles}" \
  BROWSER_WORKER_TOKEN="$BROWSER_WORKER_TOKEN" OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  BROWSER_MODEL="${BROWSER_MODEL:-anthropic/claude-haiku-5.5}" CHROMIUM_SANDBOX="${CHROMIUM_SANDBOX:-true}" \
  BROWSER_PROXY="${BROWSER_PROXY:-}" \
  uvicorn worker:app --host 0.0.0.0 --port 8080 --no-access-log --app-dir /app
