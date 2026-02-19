import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const boundaryScript = path.join(repoRoot, "tests", "e2e", "math-wysiwyg-boundary.e2e.mjs");

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-boundary-suite ${now()}] ${message}`);
};

const runBoundaryCase = async (caseId) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [boundaryScript], {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        E2E_BOUNDARY_CASE: String(caseId),
      },
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (typeof code === "number") {
        resolve({ code, signal: null });
        return;
      }
      resolve({ code: 1, signal: signal ?? "unknown" });
    });
  });

const run = async () => {
  const selected = String(process.env.E2E_BOUNDARY_CASE ?? "").trim();
  const caseIds = selected ? [selected] : ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  for (const caseId of caseIds) {
    let passed = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      log(`case ${caseId}: attempt ${attempt}/3`);
      // eslint-disable-next-line no-await-in-loop
      const result = await runBoundaryCase(caseId);
      if (result.code === 0) {
        passed = true;
        break;
      }
      if (attempt < 3) {
        log(`case ${caseId}: retry after failure (code=${result.code}, signal=${result.signal ?? "-"})`);
      }
    }
    if (!passed) {
      throw new Error(`math-wysiwyg-boundary case ${caseId} failed after 3 attempts`);
    }
  }

  log("all requested boundary cases passed");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
