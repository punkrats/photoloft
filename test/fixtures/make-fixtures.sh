#!/bin/bash

# Regenerates the JPEG fixtures used by the unit and end-to-end tests.
# Needs ImageMagick 7 and exiftool.

set -euo pipefail

dir=$(dirname "$(realpath "$0")")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

magick -size 16x12 xc:orange -strip "$tmp/thumb.jpg"

exif_args=(
  -overwrite_original
  '-DateTimeOriginal=2024:05:06 07:08:09'
  '-DateTime=2024:05:06 07:08:09'
  -Make=TestCam
  -Model=X1
  -Orientation#=6
  -ExifImageWidth=64
  -ExifImageHeight=48
  -GPSLatitude=41.9
  -GPSLatitudeRef=N
  -GPSLongitude=12.5
  -GPSLongitudeRef=E
  "-ThumbnailImage<=$tmp/thumb.jpg"
)

magick -size 64x48 gradient:red-blue -strip "$dir/exif-mm.jpg"
exiftool -q -ExifByteOrder=MM "${exif_args[@]}" "$dir/exif-mm.jpg"

magick -size 64x48 gradient:red-blue -strip "$dir/exif-ii.jpg"
exiftool -q -ExifByteOrder=II "${exif_args[@]}" "$dir/exif-ii.jpg"

magick -size 40x30 xc:gray50 -strip "$dir/plain.jpg"

# Photos for the end-to-end flow: different colours and dates, one
# with a blue cast and one stored sideways (Orientation 6).
photo() {
  local name=$1 colour=$2 date=$3
  magick -size 320x240 "gradient:$colour" -strip "$dir/$name"
  exiftool -q -overwrite_original "-DateTimeOriginal=$date" "$dir/$name"
}

photo e2e-a.jpg 'gray20-gray90' '2024:01:01 10:00:00'
photo e2e-b.jpg '#2a3a6a-#a0b8f0' '2024:01:02 10:00:00'
photo e2e-c.jpg 'darkgreen-khaki' '2024:01:03 10:00:00'
photo e2e-d.jpg 'maroon-gold' '2024:01:04 10:00:00'

magick -size 240x320 gradient:navy-white -strip "$dir/e2e-portrait.jpg"
exiftool -q -overwrite_original -Orientation#=6 \
  '-DateTimeOriginal=2024:01:05 10:00:00' "$dir/e2e-portrait.jpg"

# A flat colour lets the end-to-end test compare GPU output with the
# reference maths in src/colour.ts without JPEG detail getting in the way.
magick -size 64x48 'xc:rgb(150,120,90)' -quality 100 -strip "$dir/e2e-flat.jpg"
exiftool -q -overwrite_original '-DateTimeOriginal=2024:01:06 10:00:00' \
  "$dir/e2e-flat.jpg"

# Some cameras write a placeholder date when their clock is unset.
magick -size 40x30 xc:gray60 -strip "$dir/zero-date.jpg"
exiftool -q -n -overwrite_original '-DateTimeOriginal=0000:00:00 00:00:00' \
  "$dir/zero-date.jpg"

magick -size 10x10 xc:red "$dir/not-a-jpeg.png"

# Videos: a test pattern with sound and a capture date, a flat colour
# for colour checks, and a phone clip stored sideways with a rotation
# flag and its time in the file name.
bt709=(-colorspace bt709 -color_primaries bt709 -color_trc bt709)
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc=size=320x240:rate=25:duration=2 \
  -f lavfi -i sine=frequency=440:duration=2 \
  -c:v libx264 -pix_fmt yuv420p "${bt709[@]}" -c:a aac -shortest \
  -metadata creation_time=2024-01-07T10:00:00Z "$dir/clip.mp4"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'color=c=0x967860:size=64x48:rate=10:duration=1,format=rgb24' \
  -vf 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p' \
  -c:v libx264 -crf 1 "${bt709[@]}" "$dir/flat.mp4"
ffmpeg -hide_banner -loglevel error -y -display_rotation 90 \
  -i "$dir/clip.mp4" -c copy -t 1 "$dir/VID_20240108_093000.mp4"

# A file named like a video that no browser can play.
{ printf '\x00\x00\x00\x18ftypmp42'; head -c 4000 /dev/urandom; } \
  >"$dir/broken.mp4"
