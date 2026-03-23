# LibDFBridge

This package wraps the official DeepFilterNet `libDF` runtime for React Native iOS.

What is committed:
- Objective-C bridge source in `ios/`
- Podspec in `LibDFBridge.podspec`
- Build script in `scripts/build_libdf_ios.sh`
- Minimal vendored upstream Rust crate in `vendor/libDF`
- Public header in `ios/include/deep_filter.h`

What is intentionally not committed:
- `build/`
- `ios/LibDF.xcframework/`
- Cargo build outputs under `vendor/libDF/target/`

Build flow:
1. CocoaPods runs `scripts/build_libdf_ios.sh` from the podspec prepare step.
2. The script builds the vendored `libDF` crate for device and simulator.
3. It packages both static libraries into `ios/LibDF.xcframework`.

Notes:
- This keeps the bridge self-contained inside the repo instead of depending on a separate `third_party/DeepFilterNet-main` checkout.
- Publishing as a standalone npm package later should mostly be a matter of moving this folder into its own repo and adding JS package metadata.
