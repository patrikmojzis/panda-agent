#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PACKAGE_DIR="$ROOT_DIR/apps/panda-receiver-macos"
ASSETS_DIR="$PACKAGE_DIR/Assets"
APP_NAME="Panda Telepathy.app"
APP_IDENTIFIER="dev.panda.receiver.macos"
APP_ICON_NAME="PandaTelepathy"
OUTPUT_DIR="${1:-$ROOT_DIR/dist/panda-telepathy-macos}"
BUILD_CONFIGURATION="${BUILD_CONFIGURATION:-release}"
SOURCE_ICON="$ASSETS_DIR/panda-icon.png"

if [[ -z "${CODESIGN_IDENTITY:-}" ]]; then
  DETECTED_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' | head -n 1)
  if [[ -z "$DETECTED_IDENTITY" ]]; then
    DETECTED_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\([^"]\+\)"/\1/p' | head -n 1)
  fi
  CODESIGN_IDENTITY="${DETECTED_IDENTITY:--}"
fi

echo "[telepathy] building Swift package ($BUILD_CONFIGURATION)"
swift build --package-path "$PACKAGE_DIR" -c "$BUILD_CONFIGURATION"

EXECUTABLE_PATH=$(find "$PACKAGE_DIR/.build" -type f -name "panda-receiver-macos" -perm -111 | rg "/$BUILD_CONFIGURATION/" | head -n 1)
if [[ -z "$EXECUTABLE_PATH" ]]; then
  echo "[telepathy] could not find built panda-receiver-macos executable" >&2
  exit 1
fi

APP_BUNDLE="$OUTPUT_DIR/$APP_NAME"
CONTENTS_DIR="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp "$EXECUTABLE_PATH" "$MACOS_DIR/panda-receiver-macos"
chmod +x "$MACOS_DIR/panda-receiver-macos"

if [[ -f "$SOURCE_ICON" ]]; then
  ICON_WORK_DIR=$(mktemp -d)
  ICONSET_DIR="$ICON_WORK_DIR/$APP_ICON_NAME.iconset"
  MASTER_ICON="$ICON_WORK_DIR/master-square.png"
  mkdir -p "$ICONSET_DIR"

  sips -Z 1024 "$SOURCE_ICON" --out "$ICON_WORK_DIR/master-resized.png" >/dev/null
  sips --padToHeightWidth 1024 1024 "$ICON_WORK_DIR/master-resized.png" --out "$MASTER_ICON" >/dev/null

  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$MASTER_ICON" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
    retina_size=$((size * 2))
    sips -z "$retina_size" "$retina_size" "$MASTER_ICON" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
  done

  iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/$APP_ICON_NAME.icns"
  rm -rf "$ICON_WORK_DIR"
fi

cat > "$CONTENTS_DIR/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>panda-receiver-macos</string>
  <key>CFBundleIconFile</key>
  <string>$APP_ICON_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$APP_IDENTIFIER</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Panda Telepathy</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Panda Telepathy records short push-to-talk voice notes that you explicitly trigger with a keyboard shortcut.</string>
</dict>
</plist>
EOF

printf 'APPL????' > "$CONTENTS_DIR/PkgInfo"

echo "[telepathy] signing app bundle with identity: $CODESIGN_IDENTITY"
/usr/bin/codesign --force --deep --sign "$CODESIGN_IDENTITY" "$APP_BUNDLE"

echo "[telepathy] built app bundle: $APP_BUNDLE"
