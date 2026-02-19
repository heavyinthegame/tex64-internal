#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

const artifactPathInput = readOption("--file");
const artifactUrl = readOption("--url");
const versionInput = readOption("--version");
const notesUrl = readOption("--notes-url");

if (!artifactPathInput || !artifactUrl) {
  console.error(
    "Usage: node scripts/release-artifact-hash.cjs --file <artifact-path> --url <artifact-url> [--version <x.y.z>] [--notes-url <url>]"
  );
  process.exit(1);
}

const artifactPath = path.resolve(process.cwd(), artifactPathInput);
if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
  console.error(`Artifact not found: ${artifactPath}`);
  process.exit(1);
}

let version = typeof versionInput === "string" && versionInput.trim() ? versionInput.trim() : "";
if (!version) {
  let fileName = path.basename(artifactPath).toLowerCase();
  const knownSuffixes = [
    ".blockmap",
    ".appimage",
    ".dmg",
    ".zip",
    ".exe",
    ".deb",
    ".pkg",
    ".msi",
    ".tar",
    ".gz",
    ".yml",
  ];
  let trimmed = true;
  while (trimmed) {
    trimmed = false;
    for (const suffix of knownSuffixes) {
      if (fileName.endsWith(suffix)) {
        fileName = fileName.slice(0, -suffix.length);
        trimmed = true;
      }
    }
  }
  const match = fileName.match(
    /(\d+\.\d+\.\d+(?:-[0-9a-z]+(?:\.[0-9a-z]+)*)?(?:\+[0-9a-z]+(?:\.[0-9a-z]+)*)?)/i
  );
  if (match && match[1]) {
    const suffixPattern = /-(arm64|aarch64|x64|amd64|darwin|mac|win32|windows|linux)$/i;
    let normalized = match[1];
    while (suffixPattern.test(normalized)) {
      normalized = normalized.replace(suffixPattern, "");
    }
    version = normalized;
  }
}

const hash = crypto.createHash("sha256");
hash.update(fs.readFileSync(artifactPath));
const digestHex = hash.digest("hex");

const result = {
  artifactPath,
  artifactUrl,
  artifactSha256: `sha256:${digestHex}`,
  version: version || null,
  notesUrl: notesUrl || (version ? `https://tex64.com/releases/${version}` : null),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.stdout.write("\n# Vercel env values\n");
if (version) {
  process.stdout.write(`TEX64_UPDATE_LATEST_VERSION=${version}\n`);
}
process.stdout.write(`TEX64_UPDATE_ARTIFACT_URL=${artifactUrl}\n`);
process.stdout.write(`TEX64_UPDATE_ARTIFACT_SHA256=sha256:${digestHex}\n`);
if (result.notesUrl) {
  process.stdout.write(`TEX64_UPDATE_NOTES_URL=${result.notesUrl}\n`);
}
