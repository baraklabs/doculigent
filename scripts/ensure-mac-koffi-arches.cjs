
const { execFileSync } = require("node:child_process");
const path = require("node:path");

if (process.platform !== "darwin") process.exit(0);

const koffiVersion = require(path.join(__dirname, "../node_modules/koffi/package.json")).version;
const arches = ["x64", "arm64"];

for (const arch of arches) {
  const pkg = `@koromix/koffi-darwin-${arch}`;
  try {
    require.resolve(`${pkg}/package.json`);
    continue;
  } catch {
    // not installed for this arch yet — fetch it below
  }
  console.log(`[ensure-mac-koffi-arches] installing ${pkg}@${koffiVersion} (missing, needed for the ${arch} DMG)`);
  execFileSync(
    "npm",
    ["install", "--no-save", "--no-audit", "--no-fund", "--os=darwin", `--cpu=${arch}`, `${pkg}@${koffiVersion}`],
    { stdio: "inherit", shell: process.platform === "win32" }
  );
}
