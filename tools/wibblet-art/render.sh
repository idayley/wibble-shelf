#!/usr/bin/env bash
# Renders a wibblet drawing to body.png and face.png beside it, and prints
# the aspect for the shelf entry.
#   tools/wibblet-art/render.sh items/<agent>/art/<drawing>.html
set -euo pipefail
src="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
out="$(dirname "$src")"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
run() { "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --allow-file-access-from-files "$@" 2>/dev/null; }

# The page crops itself and writes its size into the title.
title=$(run --dump-dom "file://$src?layer=body" | sed -n 's:.*<title>\(.*\)</title>.*:\1:p')
aspect=${title#aspect=}; aspect=${aspect%% *}
width=${title##*width=}
[ -n "$width" ] || { echo "couldn't read the drawing's size: '$title'" >&2; exit 1; }

for layer in body face; do
  run --default-background-color=00000000 --window-size="$width,207" \
    --screenshot="$out/$layer.png" "file://$src?layer=$layer"
done
echo "$out/body.png and face.png, ${width}x207"
echo "\"aspect\": $aspect"
