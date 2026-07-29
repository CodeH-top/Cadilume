#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
app_path="$project_root/src-tauri/target/release/bundle/macos/Cadilume.app"
dmg_dir="$project_root/src-tauri/target/release/bundle/dmg"

cleanup_app() {
  if [ -e "$app_path" ] || [ -L "$app_path" ]; then
    if ! find "$app_path" -depth -delete; then
      echo "清理应用包失败：$app_path" >&2
      return 1
    fi
    if [ -e "$app_path" ] || [ -L "$app_path" ]; then
      echo "应用包清理后仍然存在：$app_path" >&2
      return 1
    fi
    echo "已清理临时应用包：$app_path"
  fi
}

finish() {
  status=$?
  trap - 0
  trap '' HUP INT QUIT TERM

  cleanup_status=0
  cleanup_app || cleanup_status=$?
  if [ "$status" -eq 0 ] && [ "$cleanup_status" -ne 0 ]; then
    status=$cleanup_status
  fi

  exit "$status"
}

trap finish 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM

# Remove a stale bundle before building so Spotlight cannot keep discovering an
# older copy when the new DMG build fails or is interrupted.
cleanup_app

cd "$project_root"
pnpm tauri build --bundles dmg -c '{"bundle":{"macOS":{"signingIdentity":"-"}}}'

echo "DMG 构建完成：$dmg_dir"
