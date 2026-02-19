import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const sourceWorkspace = path.join(repoRoot, "test-workspace");
const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "120", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "30", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "20", 10);
const isMac = process.platform === "darwin";
const selectAllShortcut = isMac ? "Meta+A" : "Control+A";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-spacing-commands-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const normalizeLatex = (value) => String(value ?? "").replace(/\s+/g, "");

const cleanupStaleElectron = () => {
  try {
    execSync(
      `pkill -f "${path.join(
        repoRoot,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
      )}"`,
      { stdio: "ignore" }
    );
  } catch {
    // no stale process
  }
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-spacing-commands-")
  );
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const postToBridge = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64Bridge.postMessage(value);
  }, payload);
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 15000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 20000,
  });
};

const openSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 12000,
  });
  await pause(70);
};

const waitForMathFieldReady = async (page) => {
  await page.waitForFunction(
    () => {
      const field = document.getElementById("block-math-input");
      return Boolean(
        field &&
          field.tagName.toLowerCase() === "math-field" &&
          typeof field.getValue === "function" &&
          field.shadowRoot
      );
    },
    undefined,
    { timeout: 20000 }
  );
};

const focusMathField = async (page) => {
  const field = page.locator("#block-math-input");
  await field.waitFor({ state: "visible", timeout: 10000 });
  await field.click({ timeout: 4000 });
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active?.id === "block-math-input" || active?.closest?.("#block-math-input");
  });
  await pause(40);
};

const getMathFieldLatex = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field || typeof field.getValue !== "function") {
      return "";
    }
    try {
      return String(field.getValue("latex") ?? "");
    } catch {
      return "";
    }
  });

const waitForSuggestionVisible = async (page, hint) => {
  const expected = String(hint ?? "").trim().toLowerCase();
  await page.waitForFunction(
    (expectedHint) => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return false;
      if (panel.getAttribute("aria-hidden") !== "false") return false;
      const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item"));
      if (items.length === 0) return false;
      return items.some((item) => {
        const label = (item.querySelector(".math-wysiwyg-label")?.textContent ?? "")
          .trim()
          .toLowerCase();
        return label === expectedHint;
      });
    },
    expected,
    { timeout: 10000 }
  );
};

const applySuggestionByTyping = async (page, token) => {
  await focusMathField(page);
  await page.keyboard.type(token, { delay: typeDelayMs });
  await waitForSuggestionVisible(page, token);
  await page.keyboard.press("Enter");
  await pause(60);
};

const waitForLatexMatches = async (page, regex, label) => {
  await page.waitForFunction(
    (patternSource, patternFlags) => {
      const field = document.getElementById("block-math-input");
      if (!field || typeof field.getValue !== "function") return false;
      try {
        const value = String(field.getValue("latex") ?? "").replace(/\s+/g, "");
        const pattern = new RegExp(patternSource, patternFlags);
        return pattern.test(value);
      } catch {
        return false;
      }
    },
    regex.source,
    regex.flags,
    { timeout: 10000 }
  );
  const actual = normalizeLatex(await getMathFieldLatex(page));
  assert.match(actual, regex, `${label}: latex mismatch\nactual=${actual}`);
};

const runCheck = async (check, index, total) => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;

  try {
    log(`[${index + 1}/${total}] ${check.label}: workspace copy ${workspacePath}`);
    await fs.mkdir(userDataPath, { recursive: true });
    cleanupStaleElectron();
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: {
        ...process.env,
        TEX64_E2E: "1",
        TEX64_E2E_HEADLESS: "1",
        TEX64_E2E_USERDATA: userDataPath,
      },
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await page.waitForFunction(() => Boolean(window.MathLive?.convertLatexToMarkup), undefined, {
      timeout: 20000,
    });
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);
    await applySuggestionByTyping(page, check.token);
    await waitForLatexMatches(page, check.regex, check.label);
    log(`[${index + 1}/${total}] ${check.label}: passed`);
  } finally {
    if (electronApp) {
      try {
        await Promise.race([
          electronApp.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("electronApp.close timeout")), 5000)
          ),
        ]);
      } catch {
        try {
          electronApp.process()?.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    cleanupStaleElectron();
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log(`[${index + 1}/${total}] ${check.label}: workspace copy removed`);
    } else {
      log(`[${index + 1}/${total}] ${check.label}: workspace copy kept ${tempDir}`);
    }
  }
};

const run = async () => {
  const checks = [
    { token: "quad", regex: /^\\quad$/, label: "quad" },
    { token: "qquad", regex: /^\\qquad$/, label: "qquad" },
    { token: "thinspace", regex: /^(\\,|\\thinspace)$/, label: "thinspace" },
    { token: "medspace", regex: /^(\\:|\\>|\\medspace)$/, label: "medspace" },
    { token: "thickspace", regex: /^(\\;|\\thickspace)$/, label: "thickspace" },
    { token: "negspace", regex: /^(\\!|\\negthinspace)$/, label: "negspace" },
  ];
  for (const [index, check] of checks.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await runCheck(check, index, checks.length);
  }
  log("math-wysiwyg spacing commands e2e passed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-spacing-commands-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
