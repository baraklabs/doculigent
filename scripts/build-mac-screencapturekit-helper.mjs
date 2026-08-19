import { spawnSync } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
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
//
// Ships as a single lipo-merged universal binary rather than two arch-specific files.
// electron-builder.yml packages separate x64 and arm64 DMGs (mac.target.arch), so this
// isn't required for either build to run — a fat binary just means one artifact serves
// both instead of maintaining/copying two, and it costs nothing since it's a small helper.

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

const tmpDir = path.join(binRoot, ".arch-tmp");
// Clean up any leftover from a previous failed run first — a stray per-arch slice left
// behind under bin/ would get picked up by electron-builder.yml's extraResources filter
// and reintroduce the exact "same file in both x64/arm64 builds" merge error this script
// exists to avoid.
await rm(tmpDir, { recursive: true, force: true });
await mkdir(tmpDir, { recursive: true });

const archBinaries = [];
for (const target of targets) {
  const outputPath = path.join(tmpDir, `${HELPER_NAME}-${target.archTag}`);

  const result = spawnSync("swiftc", ["-O", "-target", target.swiftTarget, swiftSource, "-o", outputPath], {
    encoding: "utf8",
    timeout: 120000,
  });

  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(details || `Failed to compile ScreenCaptureKitRecorder.swift for ${target.archTag}`);
  }

  archBinaries.push(outputPath);
  console.log(`[build-mac-screencapturekit-helper] Compiled ${target.archTag} slice -> ${outputPath}`);
}

const universalPath = path.join(binRoot, HELPER_NAME);
const lipoResult = spawnSync("lipo", ["-create", "-output", universalPath, ...archBinaries], { encoding: "utf8" });
if (lipoResult.status !== 0) {
  const details = [lipoResult.stderr, lipoResult.stdout].filter(Boolean).join("\n").trim();
  throw new Error(details || "lipo failed to merge arch slices into a universal binary");
}
await chmod(universalPath, 0o755);
await rm(tmpDir, { recursive: true, force: true });
console.log(`[build-mac-screencapturekit-helper] Built universal ${HELPER_NAME} -> ${universalPath}`);
