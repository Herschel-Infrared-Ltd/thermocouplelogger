#!/bin/sh
# Install the kiosk and screen sleep as systemd user services for the desktop user.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
units="$HOME/.config/systemd/user"
mkdir -p "$HOME/.local/bin" "$units"
install -m 755 "$here/kiosk.sh" "$HOME/.local/bin/thermocouple-kiosk"
install -m 755 "$here/screen-sleep.py" "$HOME/.local/bin/screen-sleep"
install -m 644 "$here"/*.service "$here"/*.timer "$units/"
systemctl --user daemon-reload
systemctl --user enable --now thermocouple-kiosk.service screen-sleep.service thermocouple-kiosk-restart.timer
systemctl --user restart thermocouple-kiosk.service screen-sleep.service
