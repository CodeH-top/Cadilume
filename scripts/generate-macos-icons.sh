#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
icons_dir="$project_root/src-tauri/icons"
source_icon="$icons_dir/app-icon.svg"
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/cadilume-icons.XXXXXX")
iconset_dir="$work_dir/Cadilume.iconset"
master_icon="$work_dir/Cadilume-1024.png"

cleanup() {
  find "$work_dir" -depth -delete
}
trap cleanup EXIT HUP INT TERM

cd "$project_root"
pnpm tauri icon "$source_icon" --output "$icons_dir"

mkdir -p "$iconset_dir"
sips -s format png "$source_icon" --out "$master_icon" >/dev/null

resize_icon() {
  size=$1
  filename=$2
  sips -z "$size" "$size" "$master_icon" --out "$iconset_dir/$filename" >/dev/null
}

resize_icon 16 icon_16x16.png
resize_icon 32 icon_16x16@2x.png
cp "$iconset_dir/icon_16x16@2x.png" "$iconset_dir/icon_32x32.png"
resize_icon 64 icon_32x32@2x.png
resize_icon 128 icon_128x128.png
resize_icon 256 icon_128x128@2x.png
cp "$iconset_dir/icon_128x128@2x.png" "$iconset_dir/icon_256x256.png"
resize_icon 512 icon_256x256@2x.png
cp "$iconset_dir/icon_256x256@2x.png" "$iconset_dir/icon_512x512.png"
cp "$master_icon" "$iconset_dir/icon_512x512@2x.png"

iconutil -c icns "$iconset_dir" -o "$icons_dir/icon.icns"
cp "$iconset_dir/icon_32x32.png" "$icons_dir/32x32.png"
cp "$iconset_dir/icon_32x32@2x.png" "$icons_dir/64x64.png"
cp "$iconset_dir/icon_128x128.png" "$icons_dir/128x128.png"
cp "$iconset_dir/icon_128x128@2x.png" "$icons_dir/128x128@2x.png"
cp "$iconset_dir/icon_256x256@2x.png" "$icons_dir/icon.png"

echo "Cadilume macOS icons generated from the 1024px SVG master."
