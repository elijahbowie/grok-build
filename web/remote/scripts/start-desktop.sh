#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:1
export HOME=/home/sandbox
export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
mkdir -p "$HOME/.vnc" /workspace/playwright-evidence

cleanup() {
  jobs -pr | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT INT TERM

Xvnc :1 -geometry "${DESKTOP_GEOMETRY:-1440x900}" -depth 24 -SecurityTypes None -DisableBasicAuth -interface 0.0.0.0 -websocketPort 6901 -httpd /usr/share/kasmvnc/www -AlwaysShared &
for _ in $(seq 1 60); do
  if test -S /tmp/.X11-unix/X1; then break; fi
  sleep 0.25
done

openbox-session &
CHROMIUM="$(find /ms-playwright -type f \( -path '*/chrome-linux/chrome' -o -path '*/chrome-linux64/chrome' \) | head -1)"
if test -z "$CHROMIUM"; then
  echo "Playwright Chromium executable was not found" >&2
  exit 1
fi

"$CHROMIUM" --no-sandbox --disable-dev-shm-usage --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 --user-data-dir=/home/sandbox/chromium-profile about:blank &

playwright-mcp --cdp-endpoint http://127.0.0.1:9222 --host 127.0.0.1 --port 8931 --output-dir /workspace/playwright-evidence --save-session &
wait $!
