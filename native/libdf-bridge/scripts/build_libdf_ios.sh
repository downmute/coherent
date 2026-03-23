#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODULE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIBDF_DIR="$MODULE_DIR/vendor/libDF"
TARGET_DIR="$MODULE_DIR/build/rust"
HEADER_DIR="$MODULE_DIR/ios/include"
XCFRAMEWORK_DIR="$MODULE_DIR/ios/LibDF.xcframework"

if [ ! -d "$LIBDF_DIR" ]; then
  echo "libDF sources not found at $LIBDF_DIR" >&2
  exit 1
fi

if [ -f "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi

DEVICE_TARGET="aarch64-apple-ios"
SIM_TARGET="aarch64-apple-ios-sim"

mkdir -p "$HEADER_DIR"
rm -rf "$XCFRAMEWORK_DIR"

cargo build \
  --manifest-path "$LIBDF_DIR/Cargo.toml" \
  --release \
  --target "$DEVICE_TARGET" \
  --target-dir "$TARGET_DIR" \
  --no-default-features \
  --features capi

cargo build \
  --manifest-path "$LIBDF_DIR/Cargo.toml" \
  --release \
  --target "$SIM_TARGET" \
  --target-dir "$TARGET_DIR" \
  --no-default-features \
  --features capi

xcodebuild -create-xcframework \
  -library "$TARGET_DIR/$DEVICE_TARGET/release/libdf.a" \
  -headers "$HEADER_DIR" \
  -library "$TARGET_DIR/$SIM_TARGET/release/libdf.a" \
  -headers "$HEADER_DIR" \
  -output "$XCFRAMEWORK_DIR"
