const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");

  const appDir = path.join(resources, "app");
  const projectDir = context.packager.projectDir;

  fs.mkdirSync(appDir, { recursive: true });
  fs.copyFileSync(path.join(projectDir, "package.json"), path.join(appDir, "package.json"));

  const electronSrc = path.join(projectDir, "electron");
  const electronDest = path.join(appDir, "electron");
  fs.mkdirSync(electronDest, { recursive: true });
  for (const name of fs.readdirSync(electronSrc)) {
    if (name === "afterPack.cjs") continue;
    const src = path.join(electronSrc, name);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(electronDest, name));
    }
  }

  // electron-builder often skips node_modules in extraResources filters; copy explicitly.
  const rickDir = path.join(resources, "rick-explains");
  const nmSrc = path.join(projectDir, "node_modules");
  const nmDest = path.join(rickDir, "node_modules");
  if (fs.existsSync(nmSrc) && fs.existsSync(rickDir)) {
    console.log("afterPack: copying node_modules into rick-explains (this may take a minute)...");
    fs.mkdirSync(nmDest, { recursive: true });
    const r = spawnSync("rsync", ["-a", "--delete", `${nmSrc}/`, `${nmDest}/`], {
      stdio: "inherit",
    });
    if (r.status !== 0) {
      throw new Error(`afterPack rsync node_modules failed with status ${r.status}`);
    }
    console.log("afterPack: node_modules copy done");
  } else {
    console.warn("afterPack: skip node_modules copy; missing", { nmSrc, rickDir });
  }

  const ollamaCandidates = [
    path.join(resources, "ollama", "ollama"),
    path.join(resources, "bin", "ollama"),
  ];
  for (const ollamaBin of ollamaCandidates) {
    if (!fs.existsSync(ollamaBin)) continue;
    try {
      fs.chmodSync(ollamaBin, 0o755);
      const libDir = path.join(path.dirname(ollamaBin), "lib", "ollama");
      if (fs.existsSync(libDir)) {
        for (const name of fs.readdirSync(libDir)) {
          fs.chmodSync(path.join(libDir, name), 0o755);
        }
      }
      console.log("afterPack: chmod +x", ollamaBin);
    } catch (err) {
      console.warn("afterPack: could not chmod ollama:", err.message);
    }
    break;
  }

  console.log("afterPack: ensured package.json and electron/ in", appDir);
};
