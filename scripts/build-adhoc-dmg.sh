#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="AgentBox"
APP_PATH="$ROOT_DIR/src-tauri/target/release/bundle/macos/$APP_NAME.app"
DMG_DIR="$ROOT_DIR/src-tauri/target/release/bundle/dmg"
VERSION="$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); process.stdout.write(p.version)')"
DMG_PATH="$DMG_DIR/${APP_NAME}_${VERSION}_aarch64.dmg"
RELEASES_DIR="${AGENTBOX_RELEASES_DIR:-$ROOT_DIR/../AgentBox-releases}"
ARCHIVED_DMG_PATH="$RELEASES_DIR/$(basename "$DMG_PATH")"
ENTITLEMENTS_PATH="$ROOT_DIR/src-tauri/entitlements.plist"
DESIGNATED_REQUIREMENT='=designated => identifier "com.zz.toolbox"'
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentbox-dmg.XXXXXX")"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"
npm run tauri -- build --bundles app --ci

# Tauri's ad-hoc signature defaults to a cdhash requirement, which changes on
# every build and invalidates an existing macOS Accessibility permission.
codesign --force --deep --sign - \
  --identifier com.zz.toolbox \
  --requirements "$DESIGNATED_REQUIREMENT" \
  --options runtime \
  --entitlements "$ENTITLEMENTS_PATH" \
  "$APP_PATH"

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
DESIGNATED_OUTPUT="$(codesign -dr - "$APP_PATH" 2>&1)"
if [[ "$DESIGNATED_OUTPUT" != *'designated => identifier "com.zz.toolbox"'* ]]; then
  echo "应用的 designated requirement 不稳定：$DESIGNATED_OUTPUT" >&2
  exit 1
fi

mkdir -p "$DMG_DIR" "$RELEASES_DIR" "$STAGING_DIR"
ditto --rsrc "$APP_PATH" "$STAGING_DIR/$APP_NAME.app"
ln -s /Applications "$STAGING_DIR/Applications"
rm -f "$DMG_PATH"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"
hdiutil verify "$DMG_PATH"
cp "$DMG_PATH" "$ARCHIVED_DMG_PATH"

echo "可安装包：$DMG_PATH"
echo "归档安装包：$ARCHIVED_DMG_PATH"
