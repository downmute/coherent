const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);
if (!config.resolver.assetExts.includes("safetensors")) {
  config.resolver.assetExts.push("safetensors");
}

module.exports = withNativeWind(config, { input: "./global.css" });
