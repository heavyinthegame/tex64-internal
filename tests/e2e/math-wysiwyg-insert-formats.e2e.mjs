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
const isMac = process.platform === "darwin";
const selectAllShortcut = isMac ? "Meta+A" : "Control+A";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-insert-formats-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const removePathWithRetries = async (targetPath, attempts = 5) => {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === "object" ? error.code : null;
      const recoverable = code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
      if (!recoverable || attempt === attempts - 1) {
        break;
      }
      await pause(200);
    }
  }
  throw lastError;
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-insert-formats-"));
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
  await pause(60);
};

const openFile = async (page, filePath) => {
  await postToBridge(page, { type: "openFile", path: filePath });
  await page.waitForSelector(`#editor-tabs-list .editor-tab.is-active[data-path="${filePath}"]`, {
    timeout: 20000,
  });
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
  await pause(50);
};

const getMathFieldLatex = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field || typeof field.getValue !== "function") return "";
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
    await pause(40);
    if (!normalizeLatex(await getMathFieldLatex(page))) {
      return;
    }
  }
  assert.equal(normalizeLatex(await getMathFieldLatex(page)), "", "failed to clear math-field");
};

const readActiveEditorValue = async (page) =>
  page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    return String(active?.getModel?.()?.getValue?.() ?? "");
  });

const isTabDirty = async (page, filePath) =>
  page.evaluate((path) => {
    const selectors = [
      `#editor-tabs-list .editor-tab[data-path="${path}"]`,
      `#editor-tabs-list-secondary .editor-tab[data-path="${path}"]`,
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement)) continue;
      return node.classList.contains("is-dirty");
    }
    return false;
  }, filePath);

const waitForTabDirtyState = async (page, filePath, expectedDirty) => {
  await page.waitForFunction(
    ({ path, expected }) => {
      const selectors = [
        `#editor-tabs-list .editor-tab[data-path="${path}"]`,
        `#editor-tabs-list-secondary .editor-tab[data-path="${path}"]`,
      ];
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLElement)) continue;
        return node.classList.contains("is-dirty") === expected;
      }
      return false;
    },
    { path: filePath, expected: expectedDirty },
    { timeout: 10000 }
  );
};

const saveActiveFileViaBridge = async (page, filePath) => {
  const content = await readActiveEditorValue(page);
  await postToBridge(page, {
    type: "saveFile",
    path: filePath,
    content,
    format: false,
    formatSource: "save",
  });
};

const setEditorCursor = async (page, lineNumber, column) => {
  const ok = await page.evaluate(
    ({ targetLine, targetColumn }) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      if (!active) return false;
      active.setPosition?.({ lineNumber: targetLine, column: targetColumn });
      active.revealPositionInCenterIfOutsideViewport?.({ lineNumber: targetLine, column: targetColumn });
      active.focus?.();
      return true;
    },
    { targetLine: lineNumber, targetColumn: column }
  );
  assert.equal(ok, true, `failed to set cursor at ${lineNumber}:${column}`);
  await pause(70);
};

const waitForEditorContains = async (page, needle) => {
  await page.waitForFunction(
    (expected) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      const text = String(active?.getModel?.()?.getValue?.() ?? "");
      return text.includes(expected);
    },
    needle,
    { timeout: 15000 }
  );
};

const waitForDiffModalState = async (page, open) => {
  await page.waitForFunction(
    (shouldOpen) => {
      const modal = document.getElementById("diff-modal");
      if (!(modal instanceof HTMLElement)) return false;
      return modal.classList.contains("is-open") === shouldOpen;
    },
    open,
    { timeout: 10000 }
  );
};

const waitForBlockMode = async (page, mode) => {
  await page.waitForFunction(
    (expectedMode) => {
      const toggle = document.getElementById("block-mode-toggle");
      if (!(toggle instanceof HTMLButtonElement)) return false;
      return toggle.dataset.blockMode === expectedMode;
    },
    mode,
    { timeout: 10000 }
  );
};

const setBlockMode = async (page, mode) => {
  const current = await page.evaluate(() => {
    const toggle = document.getElementById("block-mode-toggle");
    if (!(toggle instanceof HTMLButtonElement)) return null;
    return toggle.dataset.blockMode ?? null;
  });
  if (current !== mode) {
    await page.click("#block-mode-toggle");
  }
  await waitForBlockMode(page, mode);
};

const setInsertMode = async (page, mode) => {
  await page.click("#block-format-button");
  await page.waitForFunction(() => {
    const menu = document.getElementById("block-format-menu");
    return Boolean(menu instanceof HTMLElement && menu.classList.contains("is-open"));
  });
  await page.click(`.block-format-option[data-format="${mode}"]`);
  await page.waitForFunction(
    (expected) => {
      const option = document.querySelector(`.block-format-option[data-format="${expected}"]`);
      return Boolean(option instanceof HTMLElement && option.classList.contains("is-active"));
    },
    mode,
    { timeout: 3000 }
  );
};

const openInsertFormatSettings = async (page) => {
  await page.click("#block-settings-button");
  await page.waitForFunction(() => {
    const modal = document.getElementById("block-settings-modal");
    return Boolean(modal?.classList.contains("is-open") && modal?.getAttribute("aria-hidden") === "false");
  });
  await page.click('[data-block-settings-target="insert-format"]');
  await page.waitForSelector('.block-settings-page.is-active[data-block-settings-page="insert-format"]', {
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

const setInlineWrap = async (page, value) => {
  await openInsertFormatSettings(page);
  await page.click(`[data-inline-format="${value}"]`);
  await page.waitForFunction(
    (selector) => {
      const node = document.querySelector(selector);
      return Boolean(node instanceof HTMLElement && node.classList.contains("is-active"));
    },
    `[data-inline-format="${value}"]`,
    { timeout: 3000 }
  );
  await closeSettingsModal(page);
};

const setDisplayWrap = async (page, value) => {
  await openInsertFormatSettings(page);
  await page.click(`[data-display-format="${value}"]`);
  await page.waitForFunction(
    (selector) => {
      const node = document.querySelector(selector);
      return Boolean(node instanceof HTMLElement && node.classList.contains("is-active"));
    },
    `[data-display-format="${value}"]`,
    { timeout: 3000 }
  );
  await closeSettingsModal(page);
};

const applyInsert = async (page, formula, lineNumber = 34, column = 1) => {
  await setEditorCursor(page, lineNumber, column);
  await clearMathField(page);
  await focusMathField(page);
  await page.keyboard.type(formula, { delay: typeDelayMs });
  await page.click("#block-insert-button");
  await waitForDiffModalState(page, true);
  await page.click("#diff-modal-submit");
  await waitForDiffModalState(page, false);
  await waitForEditorContains(page, formula);
  return readActiveEditorValue(page);
};

const replaceDetected = async (page, { cursorLine, cursorColumn, replacement }) => {
  await setEditorCursor(page, cursorLine, cursorColumn);
  await setBlockMode(page, "edit");
  await clearMathField(page);
  await page.keyboard.type(replacement, { delay: typeDelayMs });
  await page.click("#block-insert-button");
  await waitForDiffModalState(page, true);
  await page.click("#diff-modal-submit");
  await waitForDiffModalState(page, false);
  await waitForEditorContains(page, replacement);
  return readActiveEditorValue(page);
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
    await openFile(page, "sections/blocks.tex");
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);
    await setBlockMode(page, "insert");
    await test(page);
    if (await isTabDirty(page, "sections/blocks.tex")) {
      await saveActiveFileViaBridge(page, "sections/blocks.tex");
      await waitForTabDirtyState(page, "sections/blocks.tex", false);
    }
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
          // ignore force-kill failure
        }
      }
    }
    cleanupStaleElectron();
    if (!keepWorkspace) {
      await removePathWithRetries(tempDir);
      log(`${label}: workspace copy removed`);
    } else {
      log(`${label}: workspace copy kept ${tempDir}`);
    }
  }
};

const run = async () => {
  await runCase("[1/10] inline + dollar wrap insert", async (page) => {
    const token = "fmtinlinedollar";
    await setInsertMode(page, "inline");
    await setInlineWrap(page, "inline-dollar");
    const after = await applyInsert(page, token);
    assert.ok(after.includes(`$${token}$`), "inline-dollar snippet was not inserted");
  });

  await runCase("[2/10] inline + paren wrap insert", async (page) => {
    const token = "fmtinlineparen";
    await setInsertMode(page, "inline");
    await setInlineWrap(page, "inline-paren");
    const after = await applyInsert(page, token);
    assert.ok(after.includes(`\\(${token}\\)`), "inline-paren snippet was not inserted");
  });

  await runCase("[3/10] display + bracket wrap insert", async (page) => {
    const token = "fmtdisplaybracket";
    await setInsertMode(page, "display");
    await setDisplayWrap(page, "display-bracket");
    const after = await applyInsert(page, token);
    assert.ok(after.includes(`\\[${token}\\]`), "display-bracket snippet was not inserted");
  });

  await runCase("[4/10] display + dollar wrap insert", async (page) => {
    const token = "fmtdisplaydollar";
    await setInsertMode(page, "display");
    await setDisplayWrap(page, "display-dollar");
    const after = await applyInsert(page, token);
    assert.ok(after.includes(`$$${token}$$`), "display-dollar snippet was not inserted");
  });

  await runCase("[5/10] align mode insert", async (page) => {
    const token = "fmtalignmode";
    await setInsertMode(page, "align");
    const after = await applyInsert(page, token);
    assert.match(
      after,
      new RegExp(String.raw`\\begin\{align\*\}\n\s*${token}\n\\end\{align\*\}`),
      "align mode wrapper was not inserted"
    );
  });

  await runCase("[6/10] gather mode insert", async (page) => {
    const token = "fmtgathermode";
    await setInsertMode(page, "gather");
    const after = await applyInsert(page, token);
    assert.match(
      after,
      new RegExp(String.raw`\\begin\{gather\*\}\n\s*${token}\n\\end\{gather\*\}`),
      "gather mode wrapper was not inserted"
    );
  });

  await runCase("[7/10] raw mode insert (no wrapper)", async (page) => {
    const token = "fmtrawmode";
    await setInsertMode(page, "none");
    const after = await applyInsert(page, token);
    assert.ok(after.includes(token), "raw formula was not inserted");
    assert.ok(!after.includes(`$${token}$`), "raw formula was wrapped by dollar unexpectedly");
    assert.ok(!after.includes(`\\(${token}\\)`), "raw formula was wrapped by paren unexpectedly");
    assert.ok(!after.includes(`\\[${token}\\]`), "raw formula was wrapped by bracket unexpectedly");
  });

  await runCase("[8/10] edit preserves inline paren wrapper", async (page) => {
    const token = "fmteditparen";
    const after = await replaceDetected(page, {
      cursorLine: 2,
      cursorColumn: 42,
      replacement: token,
    });
    assert.match(
      after,
      new RegExp(String.raw`\\\(\s*${token}\s*\\\)`),
      "inline paren wrapper was not preserved in edit mode"
    );
    assert.ok(!after.includes(`$${token}$`), "edit replacement unexpectedly switched to dollar wrap");
  });

  await runCase("[9/10] edit preserves display dollar wrapper", async (page) => {
    const token = "fmteditdollar";
    const after = await replaceDetected(page, {
      cursorLine: 8,
      cursorColumn: 5,
      replacement: token,
    });
    assert.match(
      after,
      new RegExp(String.raw`\$\$[\s\S]*${token}[\s\S]*\$\$`),
      "display dollar wrapper was not preserved in edit mode"
    );
  });

  await runCase("[10/10] edit preserves align environment", async (page) => {
    const token = "fmteditalign";
    const after = await replaceDetected(page, {
      cursorLine: 17,
      cursorColumn: 8,
      replacement: token,
    });
    assert.match(
      after,
      new RegExp(String.raw`\\begin\{align\}[\s\S]*${token}[\s\S]*\\end\{align\}`),
      "align environment wrapper was not preserved in edit mode"
    );
    assert.ok(!after.includes("\\begin{align*}"), "edit replacement unexpectedly changed align -> align*");
  });

  log("math-wysiwyg insert-format e2e passed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-insert-formats-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
