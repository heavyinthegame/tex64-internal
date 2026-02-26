#!/usr/bin/env node
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const requiredDirs = [
  path.join(projectRoot, "web-src", "math", "fork"),
  path.join(projectRoot, "web-src", "math", "wysiwyg"),
];
const forbiddenDirs = [
  path.join(projectRoot, "web-src", "vendor", "mathlive-fork"),
  path.join(projectRoot, "Resources", "web", "mathlive", "sounds"),
];
const mustContainChecks = [
  {
    file: path.join(projectRoot, "web-src", "app", "blocks", "input-ui.ts"),
    pattern: '../../math/wysiwyg/math-wysiwyg.js',
  },
  {
    file: path.join(projectRoot, "web-src", "app", "blocks", "input-ui.ts"),
    pattern: '../../math/wysiwyg/math-wysiwyg-packs.js',
  },
  {
    file: path.join(projectRoot, "web-src", "app", "blocks", "math-wysiwyg-settings.ts"),
    pattern: '../../math/wysiwyg/math-wysiwyg-packs.js',
  },
  {
    file: path.join(projectRoot, "web-src", "tsconfig.json"),
    pattern: '"math/wysiwyg/**/*.ts"',
  },
  {
    file: path.join(projectRoot, "web-src", "tsconfig.json"),
    pattern: '"math/fork/**"',
  },
];

const staleAppMathPattern = /^math-wysiwyg.*\.js$/;

const errors = [];

const requireDir = (dirPath) => {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    errors.push(`required directory missing: ${path.relative(projectRoot, dirPath)}`);
  }
};

const forbidDir = (dirPath) => {
  if (fs.existsSync(dirPath)) {
    errors.push(`forbidden directory exists: ${path.relative(projectRoot, dirPath)}`);
  }
};

const checkFileContains = async (filePath, pattern) => {
  try {
    const content = await fsp.readFile(filePath, "utf8");
    if (!content.includes(pattern)) {
      errors.push(
        `required reference not found in ${path.relative(projectRoot, filePath)}: ${pattern}`
      );
    }
  } catch (error) {
    errors.push(`failed to read ${path.relative(projectRoot, filePath)}: ${String(error)}`);
  }
};

const checkStaleGeneratedMathFiles = async () => {
  const appOutputDir = path.join(projectRoot, "Resources", "web", "app");
  try {
    const entries = await fsp.readdir(appOutputDir, { withFileTypes: true });
    const stale = entries
      .filter((entry) => entry.isFile() && staleAppMathPattern.test(entry.name))
      .map((entry) => entry.name);
    if (stale.length > 0) {
      errors.push(
        `stale generated files present in Resources/web/app: ${stale.join(", ")}`
      );
    }
  } catch (error) {
    errors.push(`failed to read Resources/web/app: ${String(error)}`);
  }
};

const main = async () => {
  requiredDirs.forEach(requireDir);
  forbiddenDirs.forEach(forbidDir);
  await checkStaleGeneratedMathFiles();
  await Promise.all(
    mustContainChecks.map((check) => checkFileContains(check.file, check.pattern))
  );

  if (errors.length > 0) {
    console.error("[math:check] failed");
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }

  console.log("[math:check] ok");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

