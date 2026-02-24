#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const args = process.argv.slice(2);

const readOption = (name) => {
  const index = args.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    return null;
  }
  return value;
};

const rootDirInput = readOption("--dir") || "dist";
const outPathInput = readOption("--out") || path.join(rootDirInput, "checksums-sha256.txt");
const versionFilterInput = readOption("--version") || "";

const rootDir = path.resolve(process.cwd(), rootDirInput);
const outPath = path.resolve(process.cwd(), outPathInput);
const normalizeVersion = (value) => String(value || "").trim().replace(/^v/i, "");
const versionFilter = normalizeVersion(versionFilterInput);

const includeFile = (filePath) => {
  const name = path.basename(filePath);
  const lower = name.toLowerCase();
  if (lower.endsWith(".blockmap")) return false;
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return false;
  if (lower.endsWith(".part")) return false;
  if (lower === "builder-debug.yml" || lower === "builder-effective-config.yaml") return false;
  if (lower === "checksums-sha256.txt") return false;
  if (lower.endsWith(".dmg")) return true;
  if (lower.endsWith(".zip")) return true;
  if (lower.endsWith(".exe")) return true;
  if (lower.endsWith(".msi")) return true;
  if (lower.endsWith(".appimage")) return true;
  if (lower.endsWith(".deb")) return true;
  if (lower.endsWith(".rpm")) return true;
  if (lower.endsWith(".tar.gz")) return true;
  return false;
};

const walkFiles = async (dirPath) => {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(fullPath);
  }
  return files;
};

const sha256File = async (filePath) => {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
};

const run = async () => {
  const stats = await fsp.stat(rootDir).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    console.error(`Directory not found: ${rootDir}`);
    process.exit(1);
  }

  const allFiles = await walkFiles(rootDir);
  const targets = allFiles.filter((filePath) => {
    if (!includeFile(filePath)) {
      return false;
    }
    if (!versionFilter) {
      return true;
    }
    const fileName = path.basename(filePath);
    return fileName.includes(`-${versionFilter}-`);
  });
  targets.sort((a, b) => a.localeCompare(b));

  const lines = [];
  for (const filePath of targets) {
    // Use basename so the checksum file remains stable across extract paths.
    const digest = await sha256File(filePath);
    lines.push(`${digest}  ${path.basename(filePath)}`);
  }

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`${outPath}\n`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
