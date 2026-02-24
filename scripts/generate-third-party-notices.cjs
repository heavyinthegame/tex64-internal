#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);

const readArg = (name, fallback = "") => {
  const index = args.findIndex((arg) => arg === `--${name}`);
  if (index < 0 || index + 1 >= args.length) {
    return fallback;
  }
  return String(args[index + 1] || "").trim();
};

const lockPath = readArg("lock", "package-lock.json");
const outPath = readArg("out", "NOTICE.md");
const projectName = readArg("project", "Project");

const lockFile = path.resolve(process.cwd(), lockPath);
const outputFile = path.resolve(process.cwd(), outPath);

if (!fs.existsSync(lockFile)) {
  console.error(`lock file not found: ${lockFile}`);
  process.exit(1);
}

const normalizeRepository = (value) => {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (value && typeof value === "object" && typeof value.url === "string") {
    return value.url.trim();
  }
  return "";
};

const normalizeLicense = (value) => {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }
        if (entry && typeof entry === "object" && typeof entry.type === "string") {
          return entry.type.trim();
        }
        return "";
      })
      .filter(Boolean)
      .join(", ");
  }
  if (value && typeof value === "object" && typeof value.type === "string") {
    return value.type.trim();
  }
  return "";
};

const toPackageName = (packagePath) => {
  const normalized = String(packagePath || "").replaceAll("\\", "/");
  const marker = "/node_modules/";
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) {
    return normalized.slice(index + marker.length).trim();
  }
  if (normalized.startsWith("node_modules/")) {
    return normalized.slice("node_modules/".length).trim();
  }
  return normalized.trim();
};

const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
const packages = lock && typeof lock === "object" && lock.packages ? lock.packages : {};

const rows = new Map();
for (const [packagePath, meta] of Object.entries(packages)) {
  if (!packagePath || packagePath === "") {
    continue;
  }
  if (!packagePath.startsWith("node_modules/") && !packagePath.includes("/node_modules/")) {
    continue;
  }
  if (!meta || typeof meta !== "object") {
    continue;
  }
  const name = toPackageName(packagePath);
  const version = typeof meta.version === "string" && meta.version.trim() ? meta.version.trim() : "";
  const license = normalizeLicense(meta.license) || "UNKNOWN";
  const homepage = typeof meta.homepage === "string" ? meta.homepage.trim() : "";
  const repository = normalizeRepository(meta.repository);
  if (!name || !version) {
    continue;
  }
  const key = `${name}@${version}`;
  if (!rows.has(key)) {
    rows.set(key, {
      name,
      version,
      license,
      homepage,
      repository,
    });
  }
}

const sorted = Array.from(rows.values()).sort((a, b) => {
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) {
    return byName;
  }
  return a.version.localeCompare(b.version);
});

const now = new Date().toISOString();
const lines = [
  `# Third-Party Notices (${projectName})`,
  "",
  `Generated: ${now}`,
  `Source: \`${path.basename(lockFile)}\``,
  `Package count: ${sorted.length}`,
  "",
  "This file lists package metadata (name/version/license) collected from the lockfile.",
  "For full license texts, see each package's LICENSE file in node_modules or upstream repository.",
  "",
  "| Package | Version | License | Homepage | Repository |",
  "| --- | --- | --- | --- | --- |",
];

for (const row of sorted) {
  const homepage = row.homepage || "";
  const repository = row.repository || "";
  const escapePipe = (value) => String(value || "").replaceAll("|", "\\|");
  lines.push(
    `| ${escapePipe(row.name)} | ${escapePipe(row.version)} | ${escapePipe(
      row.license
    )} | ${escapePipe(homepage)} | ${escapePipe(repository)} |`
  );
}

fs.writeFileSync(outputFile, `${lines.join("\n")}\n`, "utf8");
console.log(`wrote ${outputFile} (${sorted.length} packages)`);
