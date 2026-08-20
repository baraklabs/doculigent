import { spawnSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Compiles electron/native/windows/capture-helper (Rust, using the windows-capture crate)
// into the native helper binary electron/main/native/screenCapture.ts spawns for Quick
// Recording's native capture path on Windows (see that file's comments for why
// Windows.Graphics.Capture instead of ffmpeg's gdigrab: gdigrab's -draw_mouse cursor draw
// flickers, a structural GDI/DWM limitation). Only runs on Windows — needs `cargo`/a
// working MSVC linker (Visual Studio Build Tools) — and is a manual/CI step, not part of
// `npm run dev`, since the helper only needs rebuilding when its Rust source changes. If
// it's never run, screenCapture.ts falls back to gdigrab automatically (with gdigrab's
// known cursor-flicker limitation), same graceful-degradation shape as the macOS helper.

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const crateDir = path.join(projectRoot, "electron", "native", "windows", "capture-helper");
const binDir = path.join(projectRoot, "electron", "native", "windows", "bin");
const HELPER_NAME = "doculigent-wgc-helper";

if (process.platform !== "win32") {
  console.log("[build-windows-capture-helper] Skipping: host platform is not Windows.");
  process.exit(0);
}

const cargoCheck = spawnSync("cargo", ["--version"], { encoding: "utf8" });
if (cargoCheck.status !== 0) {
  const details = [cargoCheck.stderr, cargoCheck.stdout].filter(Boolean).join("\n").trim();
  throw new Error(details || "cargo is unavailable — install Rust (https://rustup.rs) and a working MSVC linker.");
}

const result = spawnSync("cargo", ["build", "--release"], {
  cwd: crateDir,
  encoding: "utf8",
  stdio: "inherit",
  timeout: 600000,
});
if (result.status !== 0) {
  throw new Error(`Failed to build ${HELPER_NAME} (cargo exited ${result.status})`);
}

await mkdir(binDir, { recursive: true });
const builtExe = path.join(crateDir, "target", "release", `${HELPER_NAME}.exe`);
const destExe = path.join(binDir, `${HELPER_NAME}.exe`);
await copyFile(builtExe, destExe);
console.log(`[build-windows-capture-helper] Built ${HELPER_NAME}.exe -> ${destExe}`);
