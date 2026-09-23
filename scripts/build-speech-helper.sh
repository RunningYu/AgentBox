#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCE_DIR="$ROOT_DIR/src-tauri/resources/AgentBoxSpeechHelper.app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

rm -rf "$RESOURCE_DIR"
mkdir -p "$RESOURCE_DIR/Contents/MacOS"

swiftc \
  -O \
  -target arm64-apple-macosx13.0 \
  -framework AVFoundation \
  -framework Speech \
  -framework Foundation \
  "$ROOT_DIR/src-tauri/macos/SpeechHelper.swift" \
  -o "$RESOURCE_DIR/Contents/MacOS/AgentBoxSpeechHelper"

cp "$ROOT_DIR/src-tauri/macos/SpeechHelper-Info.plist" "$RESOURCE_DIR/Contents/Info.plist"
codesign --force --deep --sign - \
  --identifier com.zz.toolbox \
  --entitlements "$ROOT_DIR/src-tauri/entitlements.plist" \
  "$RESOURCE_DIR"
