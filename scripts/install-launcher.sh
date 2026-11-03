#!/bin/bash

# Adds Lightbox to the Omarchy app launcher. A small user service serves
# the built page at http://127.0.0.1:47321, which gives Lightbox its own
# browser origin: Chromium can then remember folder access ("Allow on
# every visit"). Rerun after moving the project.
#
# Remove with:
#   omarchy-webapp-remove Lightbox
#   systemctl --user disable --now lightbox
#   rm ~/.config/systemd/user/lightbox.service

set -euo pipefail

root=$(realpath "$(dirname "$(realpath "$0")")/..")
port=47321
url="http://127.0.0.1:$port"
unit="$HOME/.config/systemd/user/lightbox.service"
icon=$(mktemp --suffix=.png)
glyph=$(mktemp --suffix=.png)
svg=$(mktemp --suffix=.svg)
trap 'rm -f "$icon" "$glyph" "$svg"' EXIT

if [[ ! -f $root/dist/index.html ]]; then
  echo "Build first: npm run build" >&2
  exit 1
fi

mkdir -p "$(dirname "$unit")"
cat >"$unit" <<EOF
[Unit]
Description=Lightbox photo editor page on $url

[Service]
ExecStart=/usr/bin/python3 $root/scripts/serve.py $port
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now lightbox.service
systemctl --user restart lightbox.service

sed 's/currentColor/#ffffff/' \
  "$root/node_modules/lucide-static/icons/images.svg" >"$svg"
magick -background none -density 1200 "$svg" -resize 150x150 "$glyph"
magick -size 256x256 xc:none -fill '#3b7be0' \
  -draw 'roundrectangle 16,16 240,240 52,52' \
  "$glyph" -gravity center -composite "$icon"

omarchy-webapp-install Lightbox "$url" "$icon"

echo "Lightbox is in the app launcher (Super+Space), served at $url."
