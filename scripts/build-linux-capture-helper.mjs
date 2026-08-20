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
//
// Unlike the mac/windows helper scripts, failures here are NON-fatal (warn + exit 0, not
// throw): this crate is still unverified/experimental (see capture-helper/src/main.rs's
// header comment — hardcoded 0,0 frame dimensions, an unconfirmed pipewire-rs fd-connect
// call, etc.) and the release workflow doesn't provision libpipewire-dev, so failing here
// is the expected steady state for now, not a release blocker. `npm run build` chains this
// script with `&&` ahead of `electron-builder`, so a hard failure would take down the whole
// Linux release over an optional native-capture upgrade that already degrades gracefully at
// runtime — exactly the outcome this graceful-degradation design is meant to avoid.

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const crateDir = path.join(projectRoot, "electron", "native", "linux", "capture-helper");
const binDir = path.join(projectRoot, "electron", "native", "linux", "bin");
const HELPER_NAME = "doculigent-pipewire-helper";

if (process.platform !== "linux") {
  console.log("[build-linux-capture-helper] Skipping: host platform is not Linux.");
  process.exit(0);
}

function skip(message) {
  console.warn(`[build-linux-capture-helper] Skipping: ${message}`);
  console.warn("[build-linux-capture-helper] screenCapture.ts will fall back to getDisplayMedia at runtime.");
  process.exit(0);
}

const cargoCheck = spawnSync("cargo", ["--version"], { encoding: "utf8" });
if (cargoCheck.status !== 0) {
  const details = [cargoCheck.stderr, cargoCheck.stdout].filter(Boolean).join("\n").trim();
  skip(details || "cargo is unavailable — install Rust (https://rustup.rs).");
}

const result = spawnSync("cargo", ["build", "--release"], {
  cwd: crateDir,
  encoding: "utf8",
  stdio: "inherit",
  timeout: 600000,
});
if (result.status !== 0) {
  skip(`Failed to build ${HELPER_NAME} (cargo exited ${result.status}) — see main.rs's header comment, this is expected to need fixes on first real build`);
}

await mkdir(binDir, { recursive: true });
const builtBin = path.join(crateDir, "target", "release", HELPER_NAME);
const destBin = path.join(binDir, HELPER_NAME);
await copyFile(builtBin, destBin);
await chmod(destBin, 0o755);
console.log(`[build-linux-capture-helper] Built ${HELPER_NAME} -> ${destBin}`);
