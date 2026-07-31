#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
icons_dir="$project_root/src-tauri/icons"
source_icon="$icons_dir/app-icon.svg"
preset_dir="$icons_dir/presets"
tray_source="$icons_dir/tray-template.svg"
tray_icon="$icons_dir/tray-template.png"
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

# The menu bar uses a separate 18pt macOS template image. Keep its canvas
# transparent and render at 2x so AppKit can tint the glyph for either menu bar
# appearance without inheriting the full-color application icon background.
sips -s format png -z 36 36 "$tray_source" --out "$tray_icon" >/dev/null
test "$(sips -g pixelWidth "$tray_icon" | awk '/pixelWidth/ {print $2}')" = "36"
test "$(sips -g pixelHeight "$tray_icon" | awk '/pixelHeight/ {print $2}')" = "36"

# Generate the Windows and legacy raster assets directly from the SVG master.
pnpm tauri icon "$source_icon" --output "$icons_dir"

# Rebuild the legacy ICNS explicitly so older macOS releases and the DMG volume
# icon retain a true 1024px Retina slot. actool's layered-icon fallback omits it.
sips -s format png "$source_icon" --out "$master_icon" >/dev/null

# The packaged application always starts with the Plex-yellow icon. The three
# fixed brand PNGs are also compiled into the native binary so AppKit can swap
# the running Dock icon without relying on service logos or external files.
for preset_source in "$preset_dir"/*.svg; do
  preset_name=$(basename "$preset_source" .svg)
  preset_output="$preset_dir/$preset_name.png"
  sips -s format png "$preset_source" --out "$preset_output" >/dev/null
  test "$(sips -g pixelWidth "$preset_output" | awk '/pixelWidth/ {print $2}')" = "1024"
  test "$(sips -g pixelHeight "$preset_output" | awk '/pixelHeight/ {print $2}')" = "1024"
done

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

echo "Cadilume icons generated from SVG, including the macOS template and layered assets."
