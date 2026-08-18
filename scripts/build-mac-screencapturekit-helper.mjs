import { spawnSync } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Compiles electron/native/mac/ScreenCaptureKitRecorder.swift into the native helper
// binary electron/main/native/screenCapture.ts spawns for macOS's native capture path
// (see that file's comments for why ScreenCaptureKit instead of ffmpeg's avfoundation
// input). Only runs on macOS — needs Xcode Command Line Tools' `swiftc` — and is a
// manual/CI step, not part of `npm run dev`, since the helper only needs rebuilding when
// the Swift source itself changes. If it's never run, native/screenCapture.ts falls back
// to the avfoundation-based capture automatically (with the known content-protection
// limitation that motivated building this in the first place).

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const swiftSource = path.join(projectRoot, "electron", "native", "mac", "ScreenCaptureKitRecorder.swift");
const binRoot = path.join(projectRoot, "electron", "native", "mac", "bin");
const HELPER_NAME = "doculigent-screencapturekit-helper";

if (process.platform !== "darwin") {
  console.log("[build-mac-screencapturekit-helper] Skipping: host platform is not macOS.");
  process.exit(0);
}

const swiftcCheck = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
if (swiftcCheck.status !== 0) {
  const details = [swiftcCheck.stderr, swiftcCheck.stdout].filter(Boolean).join("\n").trim();
  throw new Error(details || "swiftc is unavailable — install Xcode Command Line Tools (xcode-select --install).");
}

const targets = [
  { archTag: "darwin-arm64", swiftTarget: "arm64-apple-macos13.0" },
  { archTag: "darwin-x64", swiftTarget: "x86_64-apple-macos13.0" },
];

for (const target of targets) {
  const outputDir = path.join(binRoot, target.archTag);
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, HELPER_NAME);

  const result = spawnSync("swiftc", ["-O", "-target", target.swiftTarget, swiftSource, "-o", outputPath], {
    encoding: "utf8",
    timeout: 120000,
  });

  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(details || `Failed to compile ScreenCaptureKitRecorder.swift for ${target.archTag}`);
  }

  await chmod(outputPath, 0o755);
  console.log(`[build-mac-screencapturekit-helper] Built ${HELPER_NAME} (${target.archTag}) -> ${outputPath}`);
}
