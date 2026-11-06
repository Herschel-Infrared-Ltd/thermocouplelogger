#!/bin/sh
# Wait for the compositor and the web dashboard, then show it full screen in Chromium.
URL="${KIOSK_URL:-http://localhost:3000/}"
until [ -S "$XDG_RUNTIME_DIR/${WAYLAND_DISPLAY:-wayland-0}" ]; do sleep 2; done
until curl -sf -o /dev/null "${URL%/}/index.html"; do sleep 5; done
exec /usr/lib/chromium/chromium \
  --kiosk --ozone-platform=wayland --use-angle=gles \
  --user-data-dir="$HOME/.config/chromium-kiosk" \
  --password-store=basic --noerrdialogs --disable-session-crashed-bubble --no-first-run --no-default-browser-check \
  --disable-dev-shm-usage --enable-gpu-rasterization --disable-pings --media-router=0 \
  "$URL"
