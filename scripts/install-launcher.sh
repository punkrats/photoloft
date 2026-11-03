#!/bin/bash

# Adds Photoloft to the Omarchy app launcher. A small user service serves
# the built page at http://127.0.0.1:47321, which gives Photoloft its own
# browser origin: Chromium can then remember folder access ("Allow on
# every visit"). Rerun after moving the project.
#
# Remove with:
#   omarchy-webapp-remove Photoloft
#   systemctl --user disable --now photoloft
#   rm ~/.config/systemd/user/photoloft.service

set -euo pipefail

root=$(realpath "$(dirname "$(realpath "$0")")/..")
port=47321
url="http://127.0.0.1:$port"
units="$HOME/.config/systemd/user"
unit="$units/photoloft.service"
old_unit="$units/lightbox.service"
old_launcher="$HOME/.local/share/applications/Lightbox.desktop"
icon=$(mktemp --suffix=.png)
glyph=$(mktemp --suffix=.png)
svg=$(mktemp --suffix=.svg)
trap 'rm -f "$icon" "$glyph" "$svg"' EXIT

if [[ ! -f $root/dist/index.html ]]; then
  echo "Build first: npm run build" >&2
  exit 1
fi

# An install under the app's former name holds the same port, so its
# service stops before the new one starts. Units of other programs
# called Lightbox are left alone.
if grep -qsF "scripts/serve.py $port" "$old_unit"; then
  systemctl --user disable --now lightbox.service
  rm -f "$old_unit"
  systemctl --user reset-failed lightbox.service 2>/dev/null || true
fi

mkdir -p "$units"
cat >"$unit" <<EOF
[Unit]
Description=Photoloft photo editor page on $url

[Service]
ExecStart=/usr/bin/python3 $root/scripts/serve.py $port
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now photoloft.service
systemctl --user restart photoloft.service

sed 's/currentColor/#ffffff/' \
  "$root/node_modules/lucide-static/icons/images.svg" >"$svg"
magick -background none -density 1200 "$svg" -resize 150x150 "$glyph"
magick -size 256x256 xc:none -fill '#3b7be0' \
  -draw 'roundrectangle 16,16 240,240 52,52' \
  "$glyph" -gravity center -composite "$icon"

omarchy-webapp-install Photoloft "$url" "$icon"

# The launcher under the former name goes once the new one is in place,
# and only when it opens this page.
if grep -qsF "$url" "$old_launcher"; then
  OMARCHY_REMOVE_NOTIFY=false omarchy-webapp-remove Lightbox
fi

echo "Photoloft is in the app launcher (Super+Space), served at $url."
