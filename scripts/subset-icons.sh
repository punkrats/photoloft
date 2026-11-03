#!/bin/bash

# Rebuilds src/assets/icons.woff2 from the Lucide font with only the
# glyphs listed in src/styles/icons.scss. Needs fonttools with brotli.

set -euo pipefail

root=$(dirname "$(realpath "$0")")/..
codes=$(grep -oE "'\\\\e[0-9a-f]{3}'" "$root/src/styles/icons.scss" |
  tr -d "'\\\\" | paste -sd, -)

fonttools subset "$root/node_modules/lucide-static/font/lucide.ttf" \
  --unicodes="$codes" \
  --flavor=woff2 \
  --output-file="$root/src/assets/icons.woff2"
