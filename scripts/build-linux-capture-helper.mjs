import { spawnSync } from "node:child_process";
import { copyFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Compiles electron/native/linux/capture-helper (Rust, using ashpd + pipewire-rs) into the
// native helper binary electron/main/native/screenCapture.ts spawns for Quick Recording's
// native capture path on Linux. UNVERIFIED — written without a Linux environment available
// (see capture-helper/src/main.rs's header comment); this script itself is straightforward
// and mirrors the other two platforms' build scripts, but `cargo build` here will very
// likely need source fixes the first time it's actually run on Linux (missing libpipewire-
// dev/pkg-config setup, API corrections flagged inline in main.rs, etc.) — treat failures
// here as expected until someone works through those on a real machine, not as a bug in
// this script. Only runs on Linux, and is a manual/CI step, not part of `npm run dev`. If
// it's never run, screenCapture.ts falls back to the existing getDisplayMedia pipeline
// automatically (Linux's only capture path today), same graceful-degradation shape as the
// other two helpers.

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const crateDir = path.join(projectRoot, "electron", "native", "linux", "capture-helper");
const binDir = path.join(projectRoot, "electron", "native", "linux", "bin");
const HELPER_NAME = "doculigent-pipewire-helper";

if (process.platform !== "linux") {
  console.log("[build-linux-capture-helper] Skipping: host platform is not Linux.");
  process.exit(0);
}

const cargoCheck = spawnSync("cargo", ["--version"], { encoding: "utf8" });
if (cargoCheck.status !== 0) {
  const details = [cargoCheck.stderr, cargoCheck.stdout].filter(Boolean).join("\n").trim();
  throw new Error(details || "cargo is unavailable — install Rust (https://rustup.rs).");
}

const result = spawnSync("cargo", ["build", "--release"], {
  cwd: crateDir,
  encoding: "utf8",
  stdio: "inherit",
  timeout: 600000,
});
if (result.status !== 0) {
  throw new Error(`Failed to build ${HELPER_NAME} (cargo exited ${result.status}) — see main.rs's header comment, this is expected to need fixes on first real build`);
}

await mkdir(binDir, { recursive: true });
const builtBin = path.join(crateDir, "target", "release", HELPER_NAME);
const destBin = path.join(binDir, HELPER_NAME);
await copyFile(builtBin, destBin);
await chmod(destBin, 0o755);
console.log(`[build-linux-capture-helper] Built ${HELPER_NAME} -> ${destBin}`);
