#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="AgentBox"
APP_PATH="$ROOT_DIR/src-tauri/target/release/bundle/macos/$APP_NAME.app"
DMG_DIR="$ROOT_DIR/src-tauri/target/release/bundle/dmg"
VERSION="$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); process.stdout.write(p.version)')"
SIGNED_DMG="$DMG_DIR/${APP_NAME}_${VERSION}_aarch64-signed-notarized.dmg"
RELEASES_DIR="${AGENTBOX_RELEASES_DIR:-$ROOT_DIR/../AgentBox-releases}"
ARCHIVED_SIGNED_DMG="$RELEASES_DIR/$(basename "$SIGNED_DMG")"
ZIP_PATH="$DMG_DIR/${APP_NAME}_${VERSION}_aarch64.app.zip"
CONFIG_PATH="$ROOT_DIR/src-tauri/tauri.signing.conf.json"
IDENTITY="${AGENTBOX_SIGNING_IDENTITY:-}"
NOTARY_PROFILE="${AGENTBOX_NOTARY_PROFILE:-agentbox-notary}"
CHECK_ONLY=0

if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
fi

if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -n 1 || true)"
fi

if [[ -z "$IDENTITY" ]]; then
  cat >&2 <<'EOF'
缺少 Apple Developer ID Application 代码签名证书。

需要先在 Apple Developer 后台创建并安装证书，或者导入 .p12 到钥匙串。
完成后可设置：
  export AGENTBOX_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
EOF
  exit 2
fi

if ! security find-identity -v -p codesigning | grep -Fq "$IDENTITY"; then
  echo "找不到代码签名证书：$IDENTITY" >&2
  exit 2
fi

if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  cat >&2 <<EOF
缺少或无法使用 notarytool 凭据 profile：$NOTARY_PROFILE

请先执行一次：
  xcrun notarytool store-credentials "$NOTARY_PROFILE" --apple-id <AppleID> --team-id <TEAMID> --password <App专用密码>

也可以通过环境变量指定其他 profile：
  export AGENTBOX_NOTARY_PROFILE="你的profile名"
EOF
  exit 2
fi

if [[ "$CHECK_ONLY" == "1" ]]; then
  echo "签名证书和 notarytool 凭据检查通过。"
  echo "Identity: $IDENTITY"
  echo "Notary profile: $NOTARY_PROFILE"
  exit 0
fi

mkdir -p "$DMG_DIR" "$RELEASES_DIR"
cat > "$CONFIG_PATH" <<EOF
{
  "bundle": {
    "targets": ["app"],
    "macOS": {
      "signingIdentity": "$IDENTITY",
      "hardenedRuntime": true,
      "entitlements": "entitlements.plist"
    }
  }
}
EOF
trap 'rm -f "$CONFIG_PATH"' EXIT

npm run tauri -- build --bundles app --config "$CONFIG_PATH" --ci
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=2 "$APP_PATH"

rm -f "$ZIP_PATH" "$SIGNED_DMG"
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"
xcrun notarytool submit "$ZIP_PATH" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"

hdiutil create -volname "$APP_NAME" -srcfolder "$APP_PATH" -ov -format UDZO "$SIGNED_DMG"
codesign --force --sign "$IDENTITY" "$SIGNED_DMG"
xcrun notarytool submit "$SIGNED_DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$SIGNED_DMG"
xcrun stapler validate "$SIGNED_DMG"
hdiutil verify "$SIGNED_DMG"
spctl -a -t open --context context:primary-signature -v "$SIGNED_DMG"
cp "$SIGNED_DMG" "$ARCHIVED_SIGNED_DMG"

echo "可分发安装包：$SIGNED_DMG"
echo "归档安装包：$ARCHIVED_SIGNED_DMG"
