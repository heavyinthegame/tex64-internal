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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "130", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "35", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "25", 10);
const explicitSuggestShortcut = "Control+.";
const isMac = process.platform === "darwin";
const selectAllShortcut = isMac ? "Meta+A" : "Control+A";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-discoverability-e2e ${now()}] ${message}`);
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-discoverability-"));
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
  const selector = `button.tab[data-tab="${key}"]`;
  const tab = page.locator(selector);
  await tab.waitFor({ state: "visible", timeout: 12000 });
  try {
    await tab.click({ timeout: 5000 });
  } catch {
    await page.evaluate((query) => {
      const node = document.querySelector(query);
      if (node instanceof HTMLButtonElement) {
        node.click();
      }
    }, selector);
  }
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 12000,
  });
  await pause(60);
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

const clearMathField = async (page) => {
  await focusMathField(page);
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press(selectAllShortcut);
    await page.keyboard.press("Backspace");
    await pause(50);
    if (!normalizeLatex(await getMathFieldLatex(page))) {
      return;
    }
  }
  assert.equal(normalizeLatex(await getMathFieldLatex(page)), "", "failed to clear math-field");
};

const isSuggestionPanelVisible = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    return Boolean(
      panel instanceof HTMLElement &&
        panel.getAttribute("aria-hidden") === "false" &&
        panel.querySelectorAll(".math-wysiwyg-item").length > 0
    );
  });

const getSuggestionHints = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement)) {
      return [];
    }
    if (panel.getAttribute("aria-hidden") !== "false") {
      return [];
    }
    return Array.from(panel.querySelectorAll(".math-wysiwyg-item .math-wysiwyg-label"))
      .map((node) => (node.textContent ?? "").trim().toLowerCase())
      .filter(Boolean);
  });

const waitForSuggestionVisible = async (page, hint) => {
  const expected = String(hint ?? "").trim().toLowerCase();
  await page.waitForFunction(
    (needle) => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return false;
      if (panel.getAttribute("aria-hidden") !== "false") return false;
      const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item"));
      if (items.length === 0) return false;
      return items.some((item) => {
        const label = (item.querySelector(".math-wysiwyg-label")?.textContent ?? "")
          .trim()
          .toLowerCase();
        return label === needle;
      });
    },
    expected,
    { timeout: 10000 }
  );
};

const waitForLatexIncludes = async (page, expectedPart, label) => {
  const expected = normalizeLatex(expectedPart);
  try {
    await page.waitForFunction(
      (needle) => {
        const field = document.getElementById("block-math-input");
        if (!field || typeof field.getValue !== "function") {
          return false;
        }
        try {
          const latex = String(field.getValue("latex") ?? "").replace(/\s+/g, "");
          return latex.includes(needle);
        } catch {
          return false;
        }
      },
      expected,
      { timeout: 10000 }
    );
  } catch (error) {
    const actualLatex = await getMathFieldLatex(page);
    throw new Error(
      `${label}: timed out waiting latex include\nexpected include: ${expectedPart}\nactual: ${actualLatex}`,
      { cause: error }
    );
  }
  const actual = normalizeLatex(await getMathFieldLatex(page));
  assert.ok(actual.includes(expected), `${label}: latex mismatch\nexpected include ${expected}\nactual ${actual}`);
};

const typeToken = async (page, token) => {
  await focusMathField(page);
  await page.keyboard.type(token, { delay: typeDelayMs });
};

const openSuggestionsSettings = async (page) => {
  await page.click("#block-settings-button");
  await page.waitForFunction(() => {
    const modal = document.getElementById("block-settings-modal");
    return Boolean(modal?.classList.contains("is-open") && modal?.getAttribute("aria-hidden") === "false");
  });
  await page.click('[data-block-settings-target="suggestions"]');
  await page.waitForSelector('.block-settings-page.is-active[data-block-settings-page="suggestions"]', {
    timeout: 5000,
  });
};

const closeSettingsModal = async (page) => {
  await page.click("#block-settings-close");
  await page.waitForFunction(() => {
    const modal = document.getElementById("block-settings-modal");
    return Boolean(!modal?.classList.contains("is-open") && modal?.getAttribute("aria-hidden") === "true");
  });
};

const setPackEnabled = async (page, packId, enabled) => {
  const selector = `[data-wysiwyg-pack="${packId}"]`;
  const isActive = await page.evaluate((query) => {
    const node = document.querySelector(query);
    return Boolean(node instanceof HTMLElement && node.classList.contains("is-active"));
  }, selector);
  if (isActive !== enabled) {
    await page.click(selector);
  }
  await page.waitForFunction(
    ({ query, expected }) => {
      const node = document.querySelector(query);
      return Boolean(
        node instanceof HTMLElement &&
          node.classList.contains("is-active") === expected &&
          node.getAttribute("aria-pressed") === (expected ? "true" : "false")
      );
    },
    { query: selector, expected: enabled },
    { timeout: 3000 }
  );
};

const expectAutoSuggestionHintAbsent = async (page, token, hint, label) => {
  await clearMathField(page);
  await typeToken(page, token);
  await pause(350);
  const hints = await getSuggestionHints(page);
  assert.equal(
    hints.includes(String(hint).toLowerCase()),
    false,
    `${label}: unexpected hint "${hint}" in auto suggestions: [${hints.join(", ")}]`
  );
};

const applyExplicitSuggestion = async (page, token, hint) => {
  await clearMathField(page);
  await typeToken(page, token);
  await page.keyboard.press(explicitSuggestShortcut);
  await waitForSuggestionVisible(page, hint);
  await page.keyboard.press("Enter");
};

const runCase = async (label, test) => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;

  try {
    log(`${label}: workspace copy ${workspacePath}`);
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
    page.on("dialog", async (dialog) => {
      log(`${label}: dialog intercepted: ${dialog.type()} ${dialog.message()}`);
      try {
        await dialog.dismiss();
      } catch {
        // ignore protocol races
      }
    });
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await page.waitForFunction(() => Boolean(window.MathLive?.convertLatexToMarkup), undefined, {
      timeout: 20000,
    });
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);
    await test(page);
    log(`${label}: passed`);
  } finally {
    if (electronApp) {
      try {
        await Promise.race([
          electronApp.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("electronApp.close timeout")), 5000)
          ),
        ]);
      } catch (closeError) {
        log(
          `${label}: close fallback: ${closeError instanceof Error ? closeError.message : String(closeError)}`
        );
        try {
          electronApp.process()?.kill("SIGKILL");
        } catch {
          // ignore force kill failure
        }
      }
    }
    cleanupStaleElectron();
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log(`${label}: workspace copy removed`);
    } else {
      log(`${label}: workspace copy kept ${tempDir}`);
    }
  }
};

const run = async () => {
  await runCase("[1/9] personal pack OFF hides auto ds", async (page) => {
    await openSuggestionsSettings(page);
    await setPackEnabled(page, "personal", false);
    await closeSettingsModal(page);
    await expectAutoSuggestionHintAbsent(page, "ds", "ds", "personal OFF");
  });

  await runCase("[2/9] personal pack OFF still allows explicit ds", async (page) => {
    await openSuggestionsSettings(page);
    await setPackEnabled(page, "personal", false);
    await closeSettingsModal(page);
    await applyExplicitSuggestion(page, "ds", "ds");
    await waitForLatexIncludes(page, "\\mathds", "explicit ds");
  });

  await runCase("[3/9] personal pack ON enables auto ds", async (page) => {
    await openSuggestionsSettings(page);
    await setPackEnabled(page, "personal", true);
    await closeSettingsModal(page);
    await clearMathField(page);
    await typeToken(page, "ds");
    await waitForSuggestionVisible(page, "ds");
  });

  await runCase("[4/9] jp pack OFF hides auto sekibun", async (page) => {
    await openSuggestionsSettings(page);
    await setPackEnabled(page, "jp", false);
    await closeSettingsModal(page);
    await expectAutoSuggestionHintAbsent(page, "sekibun", "sekibun", "jp OFF");
  });

  await runCase("[5/9] jp pack OFF still allows explicit sekibun", async (page) => {
    await openSuggestionsSettings(page);
    await setPackEnabled(page, "jp", false);
    await closeSettingsModal(page);
    await applyExplicitSuggestion(page, "sekibun", "sekibun");
    await waitForLatexIncludes(page, "\\int", "explicit sekibun");
  });

  await runCase("[6/9] jp pack ON enables auto sekibun", async (page) => {
    await openSuggestionsSettings(page);
    await setPackEnabled(page, "jp", true);
    await closeSettingsModal(page);
    await clearMathField(page);
    await typeToken(page, "sekibun");
    await waitForSuggestionVisible(page, "sekibun");
  });

  await runCase("[7/9] math pack OFF hides auto min", async (page) => {
    await openSuggestionsSettings(page);
    await setPackEnabled(page, "math", false);
    await closeSettingsModal(page);
    await expectAutoSuggestionHintAbsent(page, "min", "min", "math OFF");
  });

  await runCase("[8/9] math pack OFF still allows explicit min", async (page) => {
    await openSuggestionsSettings(page);
    await setPackEnabled(page, "math", false);
    await closeSettingsModal(page);
    await applyExplicitSuggestion(page, "min", "min");
    await waitForLatexIncludes(page, "\\min", "explicit min");
  });

  await runCase("[9/9] explicit suffix rescue finds argmax", async (page) => {
    await applyExplicitSuggestion(page, "zzargmax", "argmax");
    await waitForLatexIncludes(page, "\\operatorname*", "suffix rescue argmax");
    await waitForLatexIncludes(page, "arg\\,max", "suffix rescue argmax");
  });

  log("math-wysiwyg discoverability e2e passed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-discoverability-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
