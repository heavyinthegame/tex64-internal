#!/usr/bin/env node
const fsp = require("node:fs/promises");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

const dirsToRemove = [
  path.join(projectRoot, "web-src", "math", "fork", "node_modules"),
  path.join(projectRoot, "web-src", "math", "fork", "dist"),
  path.join(projectRoot, "web-src", "math", "fork", "build"),
  path.join(projectRoot, "Resources", "web", "mathlive", "sounds"),
];

const staleAppMathPattern = /^math-wysiwyg.*\.js$/;

const removeStaleGeneratedMathFiles = async () => {
  const appOutputDir = path.join(projectRoot, "Resources", "web", "app");
  const entries = await fsp.readdir(appOutputDir, { withFileTypes: true });
  const stale = entries.filter(
    (entry) => entry.isFile() && staleAppMathPattern.test(entry.name)
  );
  await Promise.all(
    stale.map((entry) => fsp.rm(path.join(appOutputDir, entry.name), { force: true }))
  );
  return stale.map((entry) => path.join("Resources", "web", "app", entry.name));
};

const main = async () => {
  for (const target of dirsToRemove) {
    await fsp.rm(target, { recursive: true, force: true });
  }
  const removedFiles = await removeStaleGeneratedMathFiles();
  console.log("[mathlive:clean] removed:");
  dirsToRemove.forEach((target) =>
    console.log(`- ${path.relative(projectRoot, target)}`)
  );
  if (removedFiles.length > 0) {
    removedFiles.forEach((file) => console.log(`- ${file}`));
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

