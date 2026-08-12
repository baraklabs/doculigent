const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  // Universal builds package x64 and arm64 into separate "-temp" app bundles before merging
  // them into one. This hook also fires for those intermediate builds — signing them here
  // makes their CodeResources diverge per arch, which breaks @electron/universal's merge
  // (it requires non-binary files to be byte-identical across both arch trees). Only sign
  // once the merge has produced the final app.
  if (context.appOutDir.endsWith("-temp")) return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
