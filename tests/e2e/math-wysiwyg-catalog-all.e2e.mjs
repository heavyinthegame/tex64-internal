import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const triggerCatalogPath = path.join(repoRoot, "web-src", "app", "math-wysiwyg-triggers.ts");
const singleCatalogScriptPath = path.join(repoRoot, "tests", "e2e", "math-wysiwyg-catalog.e2e.mjs");
const catalogModeRaw = String(process.env.E2E_WYSIWYG_CATALOG_MODE ?? "auto")
  .trim()
  .toLowerCase();
const catalogMode = catalogModeRaw === "explicit" ? "explicit" : "auto";
if (catalogModeRaw && catalogModeRaw !== "auto" && catalogModeRaw !== "explicit") {
  throw new Error(`invalid E2E_WYSIWYG_CATALOG_MODE: ${catalogModeRaw}`);
}

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-catalog-all-e2e ${now()}] ${message}`);
};

const parseTriggerTokens = async () => {
  const source = await fs.readFile(triggerCatalogPath, "utf8");
  const seen = new Set();
  const tokens = [];
  for (const match of source.matchAll(/trigger:\s*"([^"\r\n]+)"/g)) {
    const token = String(match[1] ?? "").trim();
    if (!token) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
};

const runSingleToken = (index, retryLimit) => {
  let attempts = 0;
  let last = null;
  while (attempts <= retryLimit) {
    attempts += 1;
    const result = spawnSync(process.execPath, [singleCatalogScriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TEX64_E2E_HEADLESS: "1",
        E2E_WYSIWYG_CATALOG_MODE: catalogMode,
        E2E_WYSIWYG_TRIGGER_START: String(index),
        E2E_WYSIWYG_TRIGGER_END: String(index + 1),
      },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    last = result;
    if (result.status === 0) {
      return { ok: true, attempts, result };
    }
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (attempts <= retryLimit) {
      if (/Process failed to launch!/i.test(output)) {
        log(`token#${index}: launch failed, retry ${attempts}/${retryLimit}`);
      } else {
        log(`token#${index}: validation failed, retry ${attempts}/${retryLimit}`);
      }
      continue;
    }
    break;
  }
  return { ok: false, attempts, result: last };
};

const run = async () => {
  const tokens = await parseTriggerTokens();
  if (tokens.length === 0) {
    throw new Error("no trigger tokens parsed");
  }
  const from = Math.max(0, Number.parseInt(process.env.E2E_WYSIWYG_CATALOG_FROM ?? "0", 10) || 0);
  const toInput = Number.parseInt(
    process.env.E2E_WYSIWYG_CATALOG_TO ?? String(tokens.length),
    10
  );
  const to = Math.max(from, Math.min(tokens.length, toInput));
  const retryLimit = Math.max(
    0,
    Number.parseInt(process.env.E2E_WYSIWYG_CATALOG_RETRY ?? "2", 10) || 0
  );
  const failures = [];
  const total = to - from;

  log(
    `trigger count=${tokens.length}, range=[${from}, ${to}), retry=${retryLimit}, mode=${catalogMode}`
  );
  for (let index = from; index < to; index += 1) {
    const token = tokens[index];
    const { ok, attempts, result } = runSingleToken(index, retryLimit);
    if (!ok) {
      const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`.trim();
      failures.push({
        index,
        token,
        attempts,
        output,
      });
      log(`FAIL #${index} "${token}" (attempts=${attempts})`);
    } else {
      log(`PASS #${index} "${token}" (attempts=${attempts})`);
    }
    const done = index - from + 1;
    if (done % 10 === 0 || done === total) {
      log(`progress ${done}/${total}, failures=${failures.length}`);
    }
  }

  if (failures.length > 0) {
    const lines = failures.slice(0, 20).map((failure) => {
      const summary = failure.output
        .split("\n")
        .find((line) => line.startsWith("- ") || line.includes("FAILED")) ??
        failure.output.split("\n").slice(-1)[0];
      return `#${failure.index} "${failure.token}" attempts=${failure.attempts}: ${summary}`;
    });
    throw new Error(
      `catalog-all failures: ${failures.length}/${total}\n${lines.join("\n")}`
    );
  }
  log("math-wysiwyg catalog-all e2e passed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-catalog-all-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
