#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
icons_dir="$project_root/src-tauri/icons"
source_icon="$icons_dir/app-icon.svg"
layered_icon="$icons_dir/Cadilume.icon"
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/cadilume-icons.XXXXXX")
iconset_dir="$work_dir/Cadilume.iconset"
master_icon="$work_dir/Cadilume-1024.png"
compiled_dir="$work_dir/compiled"
verification_iconset="$work_dir/verification.iconset"
partial_plist="$work_dir/partial.plist"
preview_icon="$work_dir/Cadilume-preview.png"

cleanup() {
  find "$work_dir" -depth -delete
}
trap cleanup EXIT HUP INT TERM

if ! developer_dir=$(xcode-select -p 2>/dev/null); then
  developer_dir=""
fi
icon_composer_tool="${developer_dir%/Developer}/Applications/Icon Composer.app/Contents/Executables/ictool"

if [ ! -x "$icon_composer_tool" ]; then
  echo "Icon Composer CLI not found. Install Xcode 26 or later." >&2
  exit 1
fi

mkdir -p "$iconset_dir" "$compiled_dir"
cd "$project_root"

# Generate the Windows and legacy raster assets directly from the SVG master.
pnpm tauri icon "$source_icon" --output "$icons_dir"

# Rebuild the legacy ICNS explicitly so older macOS releases and the DMG volume
# icon retain a true 1024px Retina slot. actool's layered-icon fallback omits it.
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
iconutil -c iconset "$icons_dir/icon.icns" -o "$verification_iconset"
test -s "$verification_iconset/icon_512x512@2x.png"
test "$(sips -g pixelWidth "$verification_iconset/icon_512x512@2x.png" | awk '/pixelWidth/ {print $2}')" = "1024"

# Compile the native macOS 26 layered SVG icon. Assets.car controls the final
# Liquid Glass rendering; the generated ICNS remains the older-macOS fallback.
"$icon_composer_tool" "$layered_icon" \
  --export-preview macOS Light 512 512 1 "$preview_icon" >/dev/null

xcrun actool \
  --compile "$compiled_dir" \
  --platform macosx \
  --minimum-deployment-target 10.13 \
  --target-device mac \
  --app-icon Cadilume \
  --output-partial-info-plist "$partial_plist" \
  --output-format human-readable-text \
  --warnings \
  --errors \
  --notices \
  "$layered_icon" >/dev/null

test -s "$preview_icon"
test -s "$compiled_dir/Assets.car"
test "$(plutil -extract CFBundleIconName raw "$partial_plist")" = "Cadilume"

cp "$compiled_dir/Assets.car" "$icons_dir/Assets.car"

echo "Cadilume icons generated from SVG, including the native macOS layered asset."
